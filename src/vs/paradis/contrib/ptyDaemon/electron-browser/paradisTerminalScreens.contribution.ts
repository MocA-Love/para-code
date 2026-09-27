/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

// 常駐ターミナルの画面のディスク保存と、PC 再起動後の復元（Q49 A / TM14）。
// 何を・なぜは `../common/paradisTerminalScreens.ts` の冒頭。ここは実際の読み書き。
//
// - 保存: 常駐を使っている間、1分ごとに（出力があったときだけ。無くても10分に1回）、ターミナルを
//   閉じたとき、アプリを閉じるときに、pty ホストの `serializeTerminalState` を
//   `workspaceStorage/<ワークスペース>/paradisTerminalScreens.json` へ書く。ターミナルが
//   1本も無くなったらファイルを消す（閉じたターミナルの画面は、次の保存で消える）
// - 復元: upstream の `getTerminalLayoutInfo` から（PARA-PATCH 1行）`take` が呼ばれる。
//   保存したときの常駐がもう居なければ中身を渡し、ファイルは消す（upstream がストレージの
//   保存物を使ったあと消すのと同じ。2回使うと、起こし直したシェルを次の起動でまた起こす）
// - 期限: 30日より古い保存物は使わずに消す。開かれなくなったワークスペースの分も、
//   起動してしばらくしてから一度だけ見回って消す
//
// Windows では常駐を使っていない（`paradisPtyHostStarterFactory.ts`）ので、upstream の保存・復元が
// そのまま働く。ここは何もしない。

import { IntervalTimer, raceTimeout } from '../../../../base/common/async.js';
import { Disposable, toDisposable } from '../../../../base/common/lifecycle.js';
import { isWindows } from '../../../../base/common/platform.js';
import { joinPath } from '../../../../base/common/resources.js';
import { URI } from '../../../../base/common/uri.js';
import { VSBuffer } from '../../../../base/common/buffer.js';
import { ProxyChannel } from '../../../../base/parts/ipc/common/ipc.js';
import { IConfigurationService } from '../../../../platform/configuration/common/configuration.js';
import { IEnvironmentService } from '../../../../platform/environment/common/environment.js';
import { FileOperationError, FileOperationResult, IFileService } from '../../../../platform/files/common/files.js';
import { IMainProcessService } from '../../../../platform/ipc/common/mainProcessService.js';
import { ILogService } from '../../../../platform/log/common/log.js';
import { ILocalPtyService } from '../../../../platform/terminal/common/terminal.js';
import { IWorkspaceContextService } from '../../../../platform/workspace/common/workspace.js';
import { IWorkbenchContribution, registerWorkbenchContribution2, WorkbenchPhase } from '../../../../workbench/common/contributions.js';
import { ITerminalGroupService, ITerminalInstance, ITerminalService } from '../../../../workbench/contrib/terminal/browser/terminal.js';
import { ILifecycleService } from '../../../../workbench/services/lifecycle/common/lifecycle.js';
import { paradisListParkedTerminalEditorInstances } from '../../workspaceSwitch/browser/paradisTerminalEditorPark.js';
import { IParadisPtyDaemonStatusService, PARADIS_PTY_DAEMON_CHANNEL } from '../common/paradisPtyDaemonStatus.js';
import { PARADIS_PTY_DAEMON_ENABLED, PARADIS_PTY_DAEMON_SAVE_SCREENS, PARADIS_PTY_HOST_DAEMON_ENABLED } from '../common/paradisPtyDaemonSettingKey.js';
import {
	paradisDecideSavedScreens,
	paradisDecodeTerminalScreens,
	paradisEncodeTerminalScreens,
	ParadisSavedScreensDecision,
	PARADIS_TERMINAL_SCREENS_FILE,
	PARADIS_TERMINAL_SCREENS_MAX_AGE,
} from '../common/paradisTerminalScreens.js';
import { paradisSetTerminalScreenSource } from './paradisTerminalScreenRestore.js';

/** 出力があったときの保存間隔。 */
const SAVE_INTERVAL = 60_000;
/** 出力が無くても保存する間隔（非表示のスペースに置いた端末の出力は数えられないため）。 */
const SAVE_FALLBACK_INTERVAL = 10 * 60_000;
/** ターミナルを閉じてから保存するまでの待ち（続けて閉じたときに1回へまとめる）。 */
const SAVE_AFTER_CLOSE_DELAY = 2_000;
/** 閉じるときの保存にかけてよい時間（upstream の persistTerminalState と同じ上限）。 */
const SAVE_ON_SHUTDOWN_TIMEOUT = 2_000;
/** 常駐の状態を聞くのにかけてよい時間。越えたら「分からない」として戻さない。 */
const DAEMON_STATUS_TIMEOUT = 3_000;
/**
 * 復元（`take`）が一度も呼ばれないときに、保存を始めてよいとみなすまでの時間。
 * 復元の前に保存すると、戻すはずの画面を今の（空の）状態で上書きしてしまう。
 */
const RESTORE_SETTLE_FALLBACK = 2 * 60_000;
/** 古い保存物の見回りを始めるまでの時間。 */
const SWEEP_DELAY = 5 * 60_000;

/** 保存・復元を働かせるか。 */
function paradisScreensActive(configurationService: IConfigurationService): boolean {
	if (isWindows || configurationService.getValue<boolean>(PARADIS_PTY_DAEMON_SAVE_SCREENS) === false) {
		return false;
	}
	return configurationService.getValue<boolean>(PARADIS_PTY_DAEMON_ENABLED) === true
		|| configurationService.getValue<boolean>(PARADIS_PTY_HOST_DAEMON_ENABLED) === true;
}

function screensFile(environmentService: IEnvironmentService, workspaceId: string): URI {
	return joinPath(environmentService.workspaceStorageHome, workspaceId, PARADIS_TERMINAL_SCREENS_FILE);
}

/** 復元が済んだ（または復元の出番が無いと分かった）か。保存はそれまで始めない。 */
let restoreSettled = false;

/**
 * 保存画面を upstream の復元へ渡す役。ターミナルが繋ぎ直しを始めるより前に居る必要があるので、
 * 起動の最初（BlockStartup）に差し込む。依存は軽いものだけにしてある（ここで ITerminalService を
 * 取ると、ターミナルのサービスを起動の最初に作らせてしまう）。
 */
class ParadisTerminalScreenSourceContribution extends Disposable implements IWorkbenchContribution {

	static readonly ID = 'workbench.contrib.paradisTerminalScreenSource';

	private readonly _status: IParadisPtyDaemonStatusService;

	constructor(
		@IFileService private readonly _fileService: IFileService,
		@IEnvironmentService private readonly _environmentService: IEnvironmentService,
		@IConfigurationService private readonly _configurationService: IConfigurationService,
		@IMainProcessService mainProcessService: IMainProcessService,
		@ILogService private readonly _logService: ILogService,
	) {
		super();
		this._status = ProxyChannel.toService<IParadisPtyDaemonStatusService>(mainProcessService.getChannel(PARADIS_PTY_DAEMON_CHANNEL));
		this._register(paradisSetTerminalScreenSource({ take: workspaceId => this._take(workspaceId) }));
		const fallback = setTimeout(() => restoreSettled = true, RESTORE_SETTLE_FALLBACK);
		this._register(toDisposable(() => clearTimeout(fallback)));
	}

	private async _take(workspaceId: string): Promise<string | undefined> {
		try {
			if (!paradisScreensActive(this._configurationService)) {
				return undefined;
			}
			const file = screensFile(this._environmentService, workspaceId);
			let content: string;
			try {
				content = (await this._fileService.readFile(file)).value.toString();
			} catch (error) {
				if (!(error instanceof FileOperationError && error.fileOperationResult === FileOperationResult.FILE_NOT_FOUND)) {
					this._logService.warn('[ParadisTerminalScreens] could not read the saved screens', error);
				}
				return undefined;
			}
			const saved = paradisDecodeTerminalScreens(content);
			if (!saved) {
				await this._delete(file);
				return undefined;
			}
			const status = await raceTimeout(this._status.getStatus().catch(() => undefined), DAEMON_STATUS_TIMEOUT);
			const decision = paradisDecideSavedScreens(saved, Date.now(), status ? { running: status.running, startedAt: status.startedAt } : undefined);
			this._logService.info(`[ParadisTerminalScreens] saved screens from ${new Date(saved.savedAt).toISOString()}: ${decision}`);
			switch (decision) {
				case ParadisSavedScreensDecision.Revive:
					await this._delete(file);
					return saved.state;
				case ParadisSavedScreensDecision.Expired:
					await this._delete(file);
					return undefined;
				default:
					// 保存したときの常駐がまだ抱えている（または分からない）。ファイルは残し、
					// 次の保存で今の状態に書き換わるのに任せる。
					return undefined;
			}
		} finally {
			restoreSettled = true;
		}
	}

	private async _delete(file: URI): Promise<void> {
		try {
			await this._fileService.del(file);
		} catch {
			// 既に無い
		}
	}
}

/** 常駐を使っている間、画面を定期的に保存する役。 */
class ParadisTerminalScreenSaverContribution extends Disposable implements IWorkbenchContribution {

	static readonly ID = 'workbench.contrib.paradisTerminalScreenSaver';

	private _dirty = true;
	private _lastSavedAt = 0;
	private _saving: Promise<void> | undefined;
	private _closeTimer: ReturnType<typeof setTimeout> | undefined;

	constructor(
		@ITerminalService private readonly _terminalService: ITerminalService,
		@ITerminalGroupService private readonly _terminalGroupService: ITerminalGroupService,
		@ILocalPtyService private readonly _localPtyService: ILocalPtyService,
		@IFileService private readonly _fileService: IFileService,
		@IEnvironmentService private readonly _environmentService: IEnvironmentService,
		@IWorkspaceContextService private readonly _workspaceContextService: IWorkspaceContextService,
		@IConfigurationService private readonly _configurationService: IConfigurationService,
		@ILifecycleService private readonly _lifecycleService: ILifecycleService,
		@ILogService private readonly _logService: ILogService,
	) {
		super();
		if (isWindows) {
			return;
		}
		this._register(this._terminalService.onAnyInstanceData(() => this._dirty = true));
		this._register(this._terminalService.onDidCreateInstance(() => this._dirty = true));
		this._register(this._terminalService.onDidDisposeInstance(() => this._scheduleSaveAfterClose()));
		this._register(new IntervalTimer()).cancelAndSet(() => this._tick(), SAVE_INTERVAL);
		const sweep = setTimeout(() => void this._sweepExpired(), SWEEP_DELAY);
		this._register(toDisposable(() => {
			clearTimeout(sweep);
			if (this._closeTimer !== undefined) {
				clearTimeout(this._closeTimer);
			}
		}));
		// 設定で止めたら、今のワークスペースの保存物もすぐ消す（残しておく理由が無い）
		this._register(this._configurationService.onDidChangeConfiguration(e => {
			if ((e.affectsConfiguration(PARADIS_PTY_DAEMON_SAVE_SCREENS) || e.affectsConfiguration(PARADIS_PTY_DAEMON_ENABLED) || e.affectsConfiguration(PARADIS_PTY_HOST_DAEMON_ENABLED))
				&& !paradisScreensActive(this._configurationService)) {
				void this._fileService.del(screensFile(this._environmentService, this._workspaceContextService.getWorkspace().id)).catch(() => { });
			}
		}));
		this._register(this._lifecycleService.onBeforeShutdown(e => {
			if (restoreSettled && paradisScreensActive(this._configurationService)) {
				e.veto(raceTimeout(this._save(), SAVE_ON_SHUTDOWN_TIMEOUT).then(() => false), 'paradis.saveTerminalScreens');
			}
		}));
	}

	private _tick(): void {
		if (this._lifecycleService.willShutdown || !restoreSettled || !paradisScreensActive(this._configurationService)) {
			return;
		}
		if (this._dirty || Date.now() - this._lastSavedAt >= SAVE_FALLBACK_INTERVAL) {
			void this._save();
		}
	}

	private _scheduleSaveAfterClose(): void {
		// 閉じるときに畳まれる分（アプリの終了）は数えない。閉じる前の保存が最後の状態。
		if (this._lifecycleService.willShutdown) {
			return;
		}
		if (this._closeTimer !== undefined) {
			clearTimeout(this._closeTimer);
		}
		this._closeTimer = setTimeout(() => {
			this._closeTimer = undefined;
			this._dirty = true;
			this._tick();
		}, SAVE_AFTER_CLOSE_DELAY);
	}

	/** 保存の対象。upstream が閉じるときに畳む範囲（`terminalService.ts` の onWillShutdown）と揃える。 */
	private _instances(): ITerminalInstance[] {
		const all = new Set<ITerminalInstance>([
			...this._terminalService.instances,
			...(this._terminalGroupService.paradisParkedGroups ?? []).flatMap(group => group.terminalInstances),
			...paradisListParkedTerminalEditorInstances(),
		]);
		return [...all].filter(instance => !instance.isDisposed && instance.remoteAuthority === undefined && instance.shouldPersist && instance.persistentProcessId !== undefined);
	}

	private _save(): Promise<void> {
		// 重ねて走らせない（書き込みの順が入れ替わると古い状態が勝つ）
		this._saving ??= this._doSave().finally(() => this._saving = undefined);
		return this._saving;
	}

	private async _doSave(): Promise<void> {
		const file = screensFile(this._environmentService, this._workspaceContextService.getWorkspace().id);
		this._dirty = false;
		try {
			const ids = this._instances().map(instance => instance.persistentProcessId!);
			if (ids.length === 0) {
				if (await this._fileService.exists(file)) {
					await this._fileService.del(file);
				}
			} else {
				const state = await this._localPtyService.serializeTerminalState(ids);
				await this._fileService.writeFile(file, VSBuffer.fromString(paradisEncodeTerminalScreens(Date.now(), state)));
			}
			this._lastSavedAt = Date.now();
		} catch (error) {
			this._dirty = true;
			this._logService.warn('[ParadisTerminalScreens] could not save the terminal screens', error);
		}
	}

	/** 30日より古い保存物を、全ワークスペースぶん消す（開かれなくなったワークスペースの分を残さない）。 */
	private async _sweepExpired(): Promise<void> {
		try {
			const root = await this._fileService.resolve(this._environmentService.workspaceStorageHome);
			const now = Date.now();
			for (const child of root.children ?? []) {
				if (!child.isDirectory || this._store.isDisposed) {
					continue;
				}
				const file = joinPath(child.resource, PARADIS_TERMINAL_SCREENS_FILE);
				try {
					const stat = await this._fileService.stat(file);
					if (now - stat.mtime > PARADIS_TERMINAL_SCREENS_MAX_AGE) {
						await this._fileService.del(file);
					}
				} catch {
					// 無い
				}
			}
		} catch (error) {
			this._logService.trace('[ParadisTerminalScreens] sweep skipped', error);
		}
	}
}

registerWorkbenchContribution2(ParadisTerminalScreenSourceContribution.ID, ParadisTerminalScreenSourceContribution, WorkbenchPhase.BlockStartup);
registerWorkbenchContribution2(ParadisTerminalScreenSaverContribution.ID, ParadisTerminalScreenSaverContribution, WorkbenchPhase.Eventually);
