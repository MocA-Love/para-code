/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

// 常駐ターミナルの画面のディスク保存と、PC 再起動後の復元（TM14）。
// 何を・なぜは `../common/paradisTerminalScreens.ts` の冒頭。ここは実際の読み書き。
//
// - 保存: **常駐が端末を抱えている間だけ**、5分ごとに（出力があったときだけ。無くても30分に1回）、
//   ターミナルを閉じたとき、アプリを閉じるときに、pty ホストの `serializeTerminalState` を
//   main プロセス経由（`terminalPrivateFiles`、0600）で `<ユーザーデータ>/paradisTerminalScreens/`
//   へ書く。保存時の常駐（pid と起動時刻）も一緒に書く。ターミナルが1本も無くなったらファイルを
//   消す（閉じたターミナルの画面は、次の保存で消える）。間隔が長めなのは、直列化が端末ごとに
//   cwd の取得（macOS では lsof）とバッファ全体の書き出しを伴うため
// - 復元: upstream の `getTerminalLayoutInfo` から（PARA-PATCH 1行）`take` が呼ばれる。
//   保存したときの常駐がもうどこにも居なければ中身を渡し（常駐がまだ動いていなければ数秒待ち、
//   それでも動いていなければ、アプリが保存より後に起動したかで決める）。ファイルは消さずに
//   「今の常駐が抱えている」と書き直す（2回使うと起こし直したシェルを次の起動でまた起こすが、
//   先に消すと、戻す途中の失敗や次の保存より前の強制終了で画面がすべて失われる）。今の常駐が
//   分からなければ消す。渡す前に、落としておいたペイン用の環境変数を付け直す
// - 期限: 30日より古い保存物は使わずに消す。開かれなくなったワークスペースの分も、
//   起動してしばらくしてから一度だけ見回って消す
//
// Windows では常駐を使っていない（`paradisPtyHostStarterFactory.ts`）ので、upstream の保存・復元が
// そのまま働く。ここは何もしない。

import { IntervalTimer, raceTimeout, timeout } from '../../../../base/common/async.js';
import { Disposable, toDisposable } from '../../../../base/common/lifecycle.js';
import { isWindows } from '../../../../base/common/platform.js';
import { ProxyChannel } from '../../../../base/parts/ipc/common/ipc.js';
import { IConfigurationService } from '../../../../platform/configuration/common/configuration.js';
import { IMainProcessService } from '../../../../platform/ipc/common/mainProcessService.js';
import { ILogService } from '../../../../platform/log/common/log.js';
import { ILocalPtyService, IShellLaunchConfig } from '../../../../platform/terminal/common/terminal.js';
import { IWorkspaceContextService } from '../../../../platform/workspace/common/workspace.js';
import { IWorkbenchContribution, registerWorkbenchContribution2, WorkbenchPhase } from '../../../../workbench/common/contributions.js';
import { ITerminalGroupService, ITerminalInstance, ITerminalService } from '../../../../workbench/contrib/terminal/browser/terminal.js';
import { INativeWorkbenchEnvironmentService } from '../../../../workbench/services/environment/electron-browser/environmentService.js';
import { ILifecycleService } from '../../../../workbench/services/lifecycle/common/lifecycle.js';
import { IParadisPaneTokenService } from '../../agentBrowser/browser/paradisPaneTokenService.js';
import { paradisTimeBoundedTeardownStep } from '../../sentry/common/paradisTeardownTiming.js';
import { IParadisTerminalPrivateFiles, PARADIS_TERMINAL_PRIVATE_FILES_CHANNEL } from '../../terminalPrivateFiles/common/paradisTerminalPrivateFiles.js';
import { paradisListParkedTerminalEditorInstances } from '../../workspaceSwitch/browser/paradisTerminalEditorPark.js';
import { IParadisPtyDaemonStatus, IParadisPtyDaemonStatusService, PARADIS_PTY_DAEMON_CHANNEL } from '../common/paradisPtyDaemonStatus.js';
import { PARADIS_PTY_DAEMON_ENABLED, PARADIS_PTY_DAEMON_SAVE_SCREENS, PARADIS_PTY_HOST_DAEMON_ENABLED } from '../common/paradisPtyDaemonSettingKey.js';
import {
	IParadisDaemonStatusLike,
	IParadisSavedTerminalScreens,
	paradisDaemonIdentityForSaving,
	paradisDecideSavedScreens,
	paradisDecodeTerminalScreens,
	ParadisSavedScreensDecision,
	paradisSavedScreensAfterRevive,
	PARADIS_TERMINAL_SCREENS_MAX_AGE,
} from '../common/paradisTerminalScreens.js';
import { paradisSetTerminalScreenSource } from './paradisTerminalScreenRestore.js';

/** 出力があったときの保存間隔。 */
const SAVE_INTERVAL = 5 * 60_000;
/** 出力が無くても保存する間隔（非表示のスペースに置いた端末の出力は数えられないため）。 */
const SAVE_FALLBACK_INTERVAL = 30 * 60_000;
/** ターミナルを閉じてから保存するまでの待ち（続けて閉じたときに1回へまとめる）。 */
const SAVE_AFTER_CLOSE_DELAY = 2_000;
/** 閉じるときの保存にかけてよい時間（upstream の persistTerminalState と同じ上限）。 */
const SAVE_ON_SHUTDOWN_TIMEOUT = 2_000;
/** 常駐の状態を聞くのにかけてよい時間。越えたら「分からない」として保存も復元もしない。 */
const DAEMON_STATUS_TIMEOUT = 3_000;
/**
 * 復元（`take`）が一度も呼ばれないときに、保存を始めてよいとみなすまでの時間。
 * 復元の前に保存すると、戻すはずの画面を今の（空の）状態で上書きしてしまう。
 */
const RESTORE_SETTLE_FALLBACK = 2 * 60_000;
/** 古い保存物の見回りを始めるまでの時間。 */
const SWEEP_DELAY = 5 * 60_000;

/** 設定の上で保存・復元を働かせるか（実際に常駐へ繋がっているかは、使う直前に状態で確かめる）。 */
function paradisScreensEnabled(configurationService: IConfigurationService): boolean {
	if (isWindows || configurationService.getValue<boolean>(PARADIS_PTY_DAEMON_SAVE_SCREENS) === false) {
		return false;
	}
	return configurationService.getValue<boolean>(PARADIS_PTY_DAEMON_ENABLED) === true
		|| configurationService.getValue<boolean>(PARADIS_PTY_HOST_DAEMON_ENABLED) === true;
}

function toStatusLike(status: IParadisPtyDaemonStatus | undefined): IParadisDaemonStatusLike | undefined {
	return status ? { running: status.running, pid: status.pid, startedAt: status.startedAt, foreign: status.foreign, terminalCount: status.terminalCount } : undefined;
}

/** 復元の判断で、常駐の起動を待つ間隔と上限。PC を再起動した直後は常駐の起動が pty ホストより遅れる。 */
const DAEMON_START_POLL_INTERVAL = 1_000;
const DAEMON_START_POLL_LIMIT = 6_000;

/**
 * main プロセスが起動した時刻（main の性能計測の印から取る）。取れなければ undefined。
 * 保存物より後にアプリが起動していれば、保存物のプロセスを抱えうるアプリの中の pty ホストは居ない。
 */
function mainProcessStartedAt(environmentService: INativeWorkbenchEnvironmentService): number | undefined {
	const marks = environmentService.window.perfMarks ?? [];
	const mark = marks.find(entry => entry.name === 'code/didStartMain') ?? marks.find(entry => entry.name === 'code/timeOrigin');
	// エポックからのミリ秒でない値（相対時刻）は使わない
	return mark && mark.startTime > 1_500_000_000_000 ? mark.startTime : undefined;
}

async function readDaemonStatus(service: IParadisPtyDaemonStatusService): Promise<IParadisDaemonStatusLike | undefined> {
	return toStatusLike(await raceTimeout(service.getStatus().catch(() => undefined), DAEMON_STATUS_TIMEOUT));
}

/** 復元が済んだ（または復元の出番が無いと分かった）か。保存はそれまで始めない。 */
let restoreSettled = false;

/**
 * 復元の判断が「分からない」で終わったワークスペース。保存物はそのまま残してあるので、判断が
 * 付くまで保存側は上書きしない（上書きすると、戻すはずだった画面が消える）。
 */
let undecidedWorkspaceId: string | undefined;

/**
 * 起動時に戻した保存物を「今の常駐が抱えている」と書き直したワークスペース。常駐がこちらの端末を
 * 抱えていない（pty ホストがアプリの中に落ちた）と分かったら、その主張は外れているので消す。
 */
let restampedWorkspaceId: string | undefined;

/**
 * 保存画面を upstream の復元へ渡す役。ターミナルが繋ぎ直しを始めるより前に居る必要があるので、
 * 起動の最初（BlockStartup）に差し込む。依存は軽いものだけにしてある（ここで ITerminalService を
 * 取ると、ターミナルのサービスを起動の最初に作らせてしまう。ペイントークンのサービスは遅延生成）。
 */
class ParadisTerminalScreenSourceContribution extends Disposable implements IWorkbenchContribution {

	static readonly ID = 'workbench.contrib.paradisTerminalScreenSource';

	private readonly _status: IParadisPtyDaemonStatusService;
	private readonly _files: IParadisTerminalPrivateFiles;

	constructor(
		@IConfigurationService private readonly _configurationService: IConfigurationService,
		@IMainProcessService mainProcessService: IMainProcessService,
		@IParadisPaneTokenService private readonly _paneTokenService: IParadisPaneTokenService,
		@INativeWorkbenchEnvironmentService private readonly _environmentService: INativeWorkbenchEnvironmentService,
		@ILogService private readonly _logService: ILogService,
	) {
		super();
		this._status = ProxyChannel.toService<IParadisPtyDaemonStatusService>(mainProcessService.getChannel(PARADIS_PTY_DAEMON_CHANNEL));
		this._files = ProxyChannel.toService<IParadisTerminalPrivateFiles>(mainProcessService.getChannel(PARADIS_TERMINAL_PRIVATE_FILES_CHANNEL));
		this._register(paradisSetTerminalScreenSource({ take: workspaceId => this._take(workspaceId) }));
		const fallback = setTimeout(() => restoreSettled = true, RESTORE_SETTLE_FALLBACK);
		this._register(toDisposable(() => clearTimeout(fallback)));
	}

	private async _take(workspaceId: string): Promise<string | undefined> {
		try {
			if (!paradisScreensEnabled(this._configurationService)) {
				return undefined;
			}
			const content = await this._files.readScreens(workspaceId);
			if (content === undefined) {
				return undefined;
			}
			const saved = paradisDecodeTerminalScreens(content);
			if (!saved) {
				await this._files.deleteScreens(workspaceId);
				return undefined;
			}
			const status = await this._settledDaemonStatus();
			const decision = paradisDecideSavedScreens(saved, Date.now(), status, mainProcessStartedAt(this._environmentService));
			this._logService.info(`[ParadisTerminalScreens] saved screens from ${new Date(saved.savedAt).toISOString()}: ${decision}`);
			switch (decision) {
				case ParadisSavedScreensDecision.Revive:
					await this._keepAfterRevive(workspaceId, saved, status);
					return this._restorePaneEnvironment(saved.state);
				case ParadisSavedScreensDecision.Expired:
					await this._files.deleteScreens(workspaceId);
					return undefined;
				case ParadisSavedScreensDecision.Unknown:
					undecidedWorkspaceId = workspaceId;
					return undefined;
				default:
					// 保存したときの常駐がまだ抱えている。ファイルは残し、次の保存で今の状態に
					// 書き換わるのに任せる。
					return undefined;
			}
		} catch (error) {
			this._logService.warn('[ParadisTerminalScreens] could not read the saved screens', error);
			return undefined;
		} finally {
			restoreSettled = true;
		}
	}

	/**
	 * 戻す保存物を、今の常駐が抱えていると書き直して残す（`paradisSavedScreensAfterRevive`）。書き直せ
	 * なければ消す。消せなければ投げて、戻すのをやめる（残ったまま戻すと、次の起動でまた起こす）。
	 */
	private async _keepAfterRevive(workspaceId: string, saved: IParadisSavedTerminalScreens, status: IParadisDaemonStatusLike | undefined): Promise<void> {
		const kept = paradisSavedScreensAfterRevive(saved, status);
		if (kept) {
			try {
				await this._files.writeScreens(workspaceId, kept.savedAt, kept.daemon, kept.state);
				restampedWorkspaceId = workspaceId;
				return;
			} catch (error) {
				this._logService.warn('[ParadisTerminalScreens] could not keep the revived screens; deleting them instead', error);
			}
		}
		await this._files.deleteScreens(workspaceId);
	}

	/**
	 * 常駐の状態を、常駐が動き出すまで少し待ってから読む。PC を再起動した直後は、常駐の起動が
	 * この判断より遅れることがある（常駐は pty ホストが起きるときに非同期で立ち上がる）。
	 */
	private async _settledDaemonStatus(): Promise<IParadisDaemonStatusLike | undefined> {
		const deadline = Date.now() + DAEMON_START_POLL_LIMIT;
		let status = await readDaemonStatus(this._status);
		while ((!status || !status.running) && Date.now() < deadline) {
			await timeout(DAEMON_START_POLL_INTERVAL);
			status = await readDaemonStatus(this._status);
		}
		return status;
	}

	/**
	 * 保存するときに落としたペイン用の環境変数（ペイントークンなど）を、起こし直す前に付け直す。
	 * トークンはシェル統合の nonce から決まるので、新しく作るターミナルと同じ値になる。
	 * 付け直さないと、起こし直したシェルで起動したエージェントが内蔵ブラウザと結び付かない。
	 */
	private _restorePaneEnvironment(serialized: string): string {
		try {
			const value = JSON.parse(serialized) as { state?: { shellLaunchConfig?: IShellLaunchConfig }[] };
			for (const entry of value.state ?? []) {
				if (entry.shellLaunchConfig && !entry.shellLaunchConfig.attachPersistentProcess) {
					this._paneTokenService.prepareShellLaunchConfig(entry.shellLaunchConfig);
				}
			}
			return JSON.stringify(value);
		} catch {
			return serialized;
		}
	}
}

/** 常駐へ繋がっている間、画面を定期的に保存する役。 */
class ParadisTerminalScreenSaverContribution extends Disposable implements IWorkbenchContribution {

	static readonly ID = 'workbench.contrib.paradisTerminalScreenSaver';

	private _dirty = true;
	private _lastSavedAt = 0;
	private _saving: Promise<void> | undefined;
	private _closeTimer: ReturnType<typeof setTimeout> | undefined;
	private readonly _status: IParadisPtyDaemonStatusService;
	private readonly _files: IParadisTerminalPrivateFiles;

	constructor(
		@ITerminalService private readonly _terminalService: ITerminalService,
		@ITerminalGroupService private readonly _terminalGroupService: ITerminalGroupService,
		@ILocalPtyService private readonly _localPtyService: ILocalPtyService,
		@IMainProcessService mainProcessService: IMainProcessService,
		@IWorkspaceContextService private readonly _workspaceContextService: IWorkspaceContextService,
		@IConfigurationService private readonly _configurationService: IConfigurationService,
		@ILifecycleService private readonly _lifecycleService: ILifecycleService,
		@INativeWorkbenchEnvironmentService private readonly _environmentService: INativeWorkbenchEnvironmentService,
		@ILogService private readonly _logService: ILogService,
	) {
		super();
		this._status = ProxyChannel.toService<IParadisPtyDaemonStatusService>(mainProcessService.getChannel(PARADIS_PTY_DAEMON_CHANNEL));
		this._files = ProxyChannel.toService<IParadisTerminalPrivateFiles>(mainProcessService.getChannel(PARADIS_TERMINAL_PRIVATE_FILES_CHANNEL));
		if (isWindows) {
			return;
		}
		this._register(this._terminalService.onAnyInstanceData(() => this._dirty = true));
		this._register(this._terminalService.onDidCreateInstance(() => this._dirty = true));
		this._register(this._terminalService.onDidDisposeInstance(() => this._scheduleSaveAfterClose()));
		this._register(new IntervalTimer()).cancelAndSet(() => this._tick(), SAVE_INTERVAL);
		const sweep = setTimeout(() => void this._files.sweepScreens(PARADIS_TERMINAL_SCREENS_MAX_AGE).catch(() => { }), SWEEP_DELAY);
		this._register(toDisposable(() => {
			clearTimeout(sweep);
			if (this._closeTimer !== undefined) {
				clearTimeout(this._closeTimer);
			}
		}));
		// 設定で止めたら、今のワークスペースの保存物もすぐ消す（残しておく理由が無い）
		this._register(this._configurationService.onDidChangeConfiguration(e => {
			if ((e.affectsConfiguration(PARADIS_PTY_DAEMON_SAVE_SCREENS) || e.affectsConfiguration(PARADIS_PTY_DAEMON_ENABLED) || e.affectsConfiguration(PARADIS_PTY_HOST_DAEMON_ENABLED))
				&& !paradisScreensEnabled(this._configurationService)) {
				void this._files.deleteScreens(this._workspaceId()).catch(() => { });
			}
		}));
		this._register(this._lifecycleService.onBeforeShutdown(e => {
			if (restoreSettled && paradisScreensEnabled(this._configurationService)) {
				// 所要時間を測る（W2-26）。上限は元からある SAVE_ON_SHUTDOWN_TIMEOUT。
				e.veto(paradisTimeBoundedTeardownStep('pty-daemon.save-terminal-screens', this._save(), SAVE_ON_SHUTDOWN_TIMEOUT, { log: this._logService }).then(() => false), 'paradis.saveTerminalScreens');
			}
		}));
	}

	private _workspaceId(): string {
		return this._workspaceContextService.getWorkspace().id;
	}

	private _tick(): void {
		if (this._lifecycleService.willShutdown || !restoreSettled || !paradisScreensEnabled(this._configurationService)) {
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
		const workspaceId = this._workspaceId();
		this._dirty = false;
		try {
			const ids = this._instances().map(instance => instance.persistentProcessId!);
			const status = await readDaemonStatus(this._status);
			if (undecidedWorkspaceId === workspaceId && !(await this._isUndecidedResolved(workspaceId, status))) {
				return;
			}
			// **常駐が端末を抱えているときだけ書く。** 常駐が生きていて、保存する本数以上を抱えて
			// いると答えたときに限る。アプリの中の pty ホストが端末を持っているときに書くと、
			// ウィンドウの再読み込みで生きているシェルを起こし直してしまう
			const daemon = paradisDaemonIdentityForSaving(status, ids.length);
			if (!daemon) {
				// 起動時に「今の常駐が抱えている」と書き直した保存物なのに、常駐はこちらの端末を抱えて
				// いない。残すと、次に PC を再起動したときに古い画面を起こすので消す
				if (restampedWorkspaceId === workspaceId && ids.length > 0 && status?.running && status.terminalCount !== undefined) {
					restampedWorkspaceId = undefined;
					await this._files.deleteScreens(workspaceId);
				}
				return;
			}
			if (ids.length === 0) {
				await this._files.deleteScreens(workspaceId);
			} else {
				const state = await this._localPtyService.serializeTerminalState(ids);
				await this._files.writeScreens(workspaceId, Date.now(), daemon, state);
			}
			if (restampedWorkspaceId === workspaceId) {
				restampedWorkspaceId = undefined;
			}
			this._lastSavedAt = Date.now();
		} catch (error) {
			this._dirty = true;
			this._logService.warn('[ParadisTerminalScreens] could not save the terminal screens', error);
		}
	}

	/** 起動時に「分からない」で残した保存物の判断が、今なら付くか。付かない間は上書きしない。 */
	private async _isUndecidedResolved(workspaceId: string, status: IParadisDaemonStatusLike | undefined): Promise<boolean> {
		const content = await this._files.readScreens(workspaceId);
		const saved = content === undefined ? undefined : paradisDecodeTerminalScreens(content);
		const decision = saved ? paradisDecideSavedScreens(saved, Date.now(), status, mainProcessStartedAt(this._environmentService)) : undefined;
		if (decision === ParadisSavedScreensDecision.Unknown) {
			return false;
		}
		if (decision === ParadisSavedScreensDecision.Revive) {
			// 起動のときには分からなかったが、保存したときの常駐はもう居なかった。今からは戻せない
			this._logService.warn('[ParadisTerminalScreens] the saved screens could not be revived at startup and are replaced now');
		}
		undecidedWorkspaceId = undefined;
		return true;
	}
}

registerWorkbenchContribution2(ParadisTerminalScreenSourceContribution.ID, ParadisTerminalScreenSourceContribution, WorkbenchPhase.BlockStartup);
registerWorkbenchContribution2(ParadisTerminalScreenSaverContribution.ID, ParadisTerminalScreenSaverContribution, WorkbenchPhase.Eventually);
