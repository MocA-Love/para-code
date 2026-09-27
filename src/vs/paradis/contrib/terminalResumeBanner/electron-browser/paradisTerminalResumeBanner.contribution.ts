/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

// 復元したターミナルタブから前の会話を続ける（Q53 案B・Q54 案A）。
//
// 1. エージェントの hook が報告する会話（shared process の状態スナップショットの `paneSessions`）と、
//    Codex が起動時にタイトルへ出すスレッド ID を、ペイントークンごとに台帳へ控える
// 2. 起動時に、復元したエディタのターミナルのうち「シェルを作り直した（= 中のエージェントが
//    終わった）」ものについて、台帳に前の会話があればバナーを出す
// 3. バナーから、このタブで続ける／CLI の fork で分岐する／会話 ID をコピーする

import { RunOnceScheduler } from '../../../../base/common/async.js';
import { Emitter } from '../../../../base/common/event.js';
import { Disposable, DisposableMap } from '../../../../base/common/lifecycle.js';
import { Schemas } from '../../../../base/common/network.js';
import { URI } from '../../../../base/common/uri.js';
import { localize } from '../../../../nls.js';
import { IClipboardService } from '../../../../platform/clipboard/common/clipboardService.js';
import { ILogService } from '../../../../platform/log/common/log.js';
import { INotificationService } from '../../../../platform/notification/common/notification.js';
import { IStorageService, StorageScope, StorageTarget } from '../../../../platform/storage/common/storage.js';
import { TerminalCapability } from '../../../../platform/terminal/common/capabilities/capabilities.js';
import { TerminalExitReason, TerminalLocation } from '../../../../platform/terminal/common/terminal.js';
import { IWorkbenchContribution, registerWorkbenchContribution2, WorkbenchPhase } from '../../../../workbench/common/contributions.js';
import { ITerminalEditorService, ITerminalInstance, ITerminalService } from '../../../../workbench/contrib/terminal/browser/terminal.js';
import { IWorkbenchEnvironmentService } from '../../../../workbench/services/environment/common/environmentService.js';
import { ILifecycleService } from '../../../../workbench/services/lifecycle/common/lifecycle.js';
import { paradisRegisterEditorTerminalOverlay } from '../../agentBrowser/browser/paradisPaneIndicator.js';
import { IParadisPaneTokenService } from '../../agentBrowser/browser/paradisPaneTokenService.js';
import { IParadisAgentStatusSnapshot } from '../../agentBrowser/common/paradisAgentBrowser.js';
import { IParadisAgentStatusSnapshotService } from '../../agentBrowser/electron-browser/paradisAgentStatusSnapshotService.js';
import { paradisInteractiveAgentCommand } from '../../mobileRelay/common/paradisAgentCliCommand.js';
import { createParadisTerminalResumeBanner, IParadisResumeBannerHost } from '../browser/paradisTerminalResumeBannerView.js';
import { IParadisResumeLedgerEntry, paradisCodexThreadIdFromTitle, paradisParseResumeLedger, paradisRestoredShellWasRestarted, paradisResumeCommandLine, paradisResumeTitleFromTab, paradisSerializeResumeLedger, paradisTrimResumeLedger } from '../common/paradisTerminalResumeBanner.js';

const LEDGER_STORAGE_KEY = 'paradis.terminal.resumeSessions';
/** 台帳の書き出しをまとめる間隔。hook はツールを使うたびに届くので、毎回は書かない。 */
const PERSIST_DELAY_MS = 2_000;

class ParadisTerminalResumeBannerContribution extends Disposable implements IWorkbenchContribution, IParadisResumeBannerHost {
	static readonly ID = 'workbench.contrib.paradisTerminalResumeBanner';

	/** 書き側。今動いている会話で更新し続ける。 */
	private readonly _ledger: Map<string, IParadisResumeLedgerEntry>;
	/** 読み側。起動時点の台帳で、バナーを出すかの判断にだけ使う（今の会話で上書きされない）。 */
	private readonly _restoredLedger: ReadonlyMap<string, IParadisResumeLedgerEntry>;
	/** instanceId → バナーに出している前の会話。 */
	private readonly _offers = new Map<number, { readonly token: string; readonly entry: IParadisResumeLedgerEntry }>();
	/** instanceId → 復元したターミナルを見た時刻。これより前に始まったコマンドの終了は数えない。 */
	private readonly _restoredAt = new Map<number, number>();
	private readonly _instanceListeners = this._register(new DisposableMap<number>());
	/** このウィンドウが書き換えた台帳のキー。保存時はこれだけを上書きする（他のウィンドウの分を消さない）。 */
	private readonly _dirtyTokens = new Set<string>();
	private readonly _onDidChange = this._register(new Emitter<number>());
	readonly onDidChange = this._onDidChange.event;
	private readonly _persistScheduler = this._register(new RunOnceScheduler(() => this.persist(), PERSIST_DELAY_MS));
	private _shuttingDown = false;

	constructor(
		@IStorageService private readonly storageService: IStorageService,
		@IParadisAgentStatusSnapshotService snapshotService: IParadisAgentStatusSnapshotService,
		@IParadisPaneTokenService private readonly paneTokenService: IParadisPaneTokenService,
		@ITerminalService private readonly terminalService: ITerminalService,
		@ITerminalEditorService private readonly terminalEditorService: ITerminalEditorService,
		@IClipboardService private readonly clipboardService: IClipboardService,
		@INotificationService private readonly notificationService: INotificationService,
		@IWorkbenchEnvironmentService private readonly environmentService: IWorkbenchEnvironmentService,
		@ILifecycleService lifecycleService: ILifecycleService,
		@ILogService private readonly logService: ILogService,
	) {
		super();
		const now = Date.now();
		this._ledger = paradisParseResumeLedger(this.storageService.get(LEDGER_STORAGE_KEY, StorageScope.WORKSPACE), now);
		this._restoredLedger = new Map(this._ledger);

		this._register(paradisRegisterEditorTerminalOverlay(container => createParadisTerminalResumeBanner(container, this)));
		this._register(snapshotService.subscribe(outcome => {
			if (outcome.snapshot !== undefined) {
				this.onSnapshot(outcome.snapshot);
			}
		}));
		this._register(this.terminalService.onAnyInstanceTitleChange(instance => this.onTitleChanged(instance)));
		// ユーザーがエージェントを終えてシェルへ戻ったら、その会話はもう「途中」ではない。
		const finished = this._register(this.terminalService.createOnInstanceCapabilityEvent(TerminalCapability.CommandDetection, capability => capability.onCommandFinished));
		this._register(finished.event(({ instance, data }) => {
			// 復元したシェルが最初のプロンプトを出すと、終了時に動いていたエージェントのコマンドが
			// 「終わった」扱いで閉じられる。それは会話を終えたのではないので数えない。
			const restoredAt = this._restoredAt.get(instance.instanceId);
			if (restoredAt !== undefined && data.timestamp < restoredAt) {
				return;
			}
			if (!this._shuttingDown && paradisInteractiveAgentCommand(data.command) !== undefined) {
				this.forgetInstance(instance);
			}
		}));
		this._register(this.terminalService.onDidCreateInstance(instance => this.considerRestoredInstance(instance)));
		this._register(lifecycleService.onWillShutdown(() => {
			this._shuttingDown = true;
			this.persist();
		}));
		for (const instance of this.terminalService.instances) {
			this.considerRestoredInstance(instance);
		}
	}

	// --- 台帳 ------------------------------------------------------------------

	private onSnapshot(snapshot: IParadisAgentStatusSnapshot): void {
		for (const session of snapshot.paneSessions ?? []) {
			const instance = this.findInstanceByToken(session.token);
			const previous = this._ledger.get(session.token);
			const title = (instance === undefined ? undefined : paradisResumeTitleFromTab(instance.title))
				?? (previous?.sessionId === session.sessionId ? previous.title : undefined);
			this.upsert(session.token, {
				agent: session.agent,
				sessionId: session.sessionId,
				at: session.at,
				...(session.cwd !== undefined ? { cwd: session.cwd } : previous?.cwd !== undefined && previous.sessionId === session.sessionId ? { cwd: previous.cwd } : {}),
				...(title !== undefined ? { title } : {}),
			});
			// そのタブでまた会話が動き出した（このタブで再開した、手で起動した）ら、案内はもう要らない。
			if (instance !== undefined) {
				this.withdrawOffer(instance.instanceId);
			}
		}
	}

	private onTitleChanged(instance: ITerminalInstance): void {
		const token = this.paneTokenService.getTokenForInstance(instance.instanceId);
		if (token === undefined) {
			return;
		}
		// Codex は hook を送らない構成でも、起動した直後にスレッド ID をタイトルへ出す。
		const codexThreadId = paradisCodexThreadIdFromTitle(instance.title);
		if (codexThreadId !== undefined) {
			const previous = this._ledger.get(token);
			this.upsert(token, {
				agent: 'codex',
				sessionId: codexThreadId,
				at: Date.now(),
				...(previous?.sessionId === codexThreadId && previous.cwd !== undefined ? { cwd: previous.cwd } : {}),
				...(previous?.sessionId === codexThreadId && previous.title !== undefined ? { title: previous.title } : {}),
			});
			this.withdrawOffer(instance.instanceId);
			return;
		}
		// 会話の名前はタブの見出しから取る（Claude Code は作業の要約を、Codex は Para Code が
		// 最初の依頼から付けた名前を出す）。会話が控えてあるタブだけ更新する。
		const previous = this._ledger.get(token);
		const title = paradisResumeTitleFromTab(instance.title);
		if (previous !== undefined && title !== undefined && title !== previous.title && !this._offers.has(instance.instanceId)) {
			this.upsert(token, { ...previous, title });
		}
	}

	private upsert(token: string, entry: IParadisResumeLedgerEntry): void {
		const previous = this._ledger.get(token);
		if (previous !== undefined
			&& previous.agent === entry.agent && previous.sessionId === entry.sessionId
			&& previous.cwd === entry.cwd && previous.title === entry.title
			&& entry.at - previous.at < 60_000) {
			return;
		}
		this._ledger.set(token, entry);
		this._dirtyTokens.add(token);
		this._persistScheduler.schedule();
	}

	private forgetInstance(instance: ITerminalInstance): void {
		const token = this.paneTokenService.getTokenForInstance(instance.instanceId);
		if (token !== undefined && this._ledger.delete(token)) {
			this._dirtyTokens.add(token);
			this._persistScheduler.schedule();
		}
		this.withdrawOffer(instance.instanceId);
	}

	/**
	 * 保存する直前に読み直し、このウィンドウが書き換えたキーだけを重ねる。同じワークスペースを
	 * 別のウィンドウでも開いていると、起動時に読んだ古い写しで相手の分を上書きしてしまうため。
	 */
	private persist(): void {
		this._persistScheduler.cancel();
		if (this._dirtyTokens.size === 0) {
			return;
		}
		const now = Date.now();
		const stored = paradisParseResumeLedger(this.storageService.get(LEDGER_STORAGE_KEY, StorageScope.WORKSPACE), now);
		for (const token of this._dirtyTokens) {
			const entry = this._ledger.get(token);
			if (entry === undefined) {
				stored.delete(token);
			} else {
				stored.set(token, entry);
			}
		}
		this._dirtyTokens.clear();
		this.storageService.store(LEDGER_STORAGE_KEY, paradisSerializeResumeLedger(paradisTrimResumeLedger(stored, now)), StorageScope.WORKSPACE, StorageTarget.MACHINE);
	}

	private findInstanceByToken(token: string): ITerminalInstance | undefined {
		const instanceId = this.paneTokenService.getInstanceForToken(token);
		return instanceId === undefined ? undefined : this.terminalService.instances.find(instance => instance.instanceId === instanceId);
	}

	// --- バナーを出すか ------------------------------------------------------------

	/**
	 * 復元したターミナルで、前に動いていたエージェントがもう居ないなら、前の会話を案内する。
	 * 判定はシェルのプロセス ID で行う（`paradisRestoredShellWasRestarted`）。子プロセスの有無は
	 * 使えない。エディタのタブの直列化が終了時点の値（エージェントが居た = true）を持ち越すため。
	 */
	private considerRestoredInstance(instance: ITerminalInstance): void {
		if (this._instanceListeners.has(instance.instanceId)) {
			return;
		}
		this._instanceListeners.set(instance.instanceId, instance.onDisposed(() => {
			// ユーザーがタブを閉じたら、その会話の案内は二度と出さない。
			if (!this._shuttingDown && instance.exitReason === TerminalExitReason.User) {
				this.forgetInstance(instance);
			}
			this._offers.delete(instance.instanceId);
			this._restoredAt.delete(instance.instanceId);
			this._instanceListeners.deleteAndDispose(instance.instanceId);
		}));
		const attach = instance.shellLaunchConfig.attachPersistentProcess;
		if (attach === undefined) {
			return;
		}
		this._restoredAt.set(instance.instanceId, Date.now());
		const previousPid = attach.pid;
		const adopted = attach.paradisAdopted === true;
		void instance.processReady.then(() => {
			if (instance.isDisposed || !paradisRestoredShellWasRestarted(previousPid, instance.processId, adopted)) {
				return;
			}
			const token = this.paneTokenService.getTokenForInstance(instance.instanceId);
			const entry = token === undefined ? undefined : this._restoredLedger.get(token);
			if (token === undefined || entry === undefined || this._ledger.get(token)?.sessionId !== entry.sessionId) {
				return;
			}
			this._offers.set(instance.instanceId, { token, entry });
			this._onDidChange.fire(instance.instanceId);
		}, error => this.logService.trace('[paradisTerminalResumeBanner] a restored terminal never became ready', error));
	}

	private withdrawOffer(instanceId: number): void {
		if (this._offers.delete(instanceId)) {
			this._onDidChange.fire(instanceId);
		}
	}

	// --- バナーのホスト ------------------------------------------------------------

	getOffer(instanceId: number): IParadisResumeLedgerEntry | undefined {
		return this._offers.get(instanceId)?.entry;
	}

	resume(instanceId: number): void {
		const offer = this._offers.get(instanceId);
		const instance = this.terminalService.instances.find(candidate => candidate.instanceId === instanceId);
		const command = offer === undefined ? undefined : paradisResumeCommandLine(offer.entry.agent, offer.entry.sessionId, 'resume');
		if (instance === undefined || command === undefined) {
			return;
		}
		this.withdrawOffer(instanceId);
		void instance.sendText(command, true);
		instance.focus();
	}

	fork(instanceId: number): void {
		const offer = this._offers.get(instanceId);
		const command = offer === undefined ? undefined : paradisResumeCommandLine(offer.entry.agent, offer.entry.sessionId, 'fork');
		if (offer === undefined || command === undefined) {
			return;
		}
		void this.openForkTerminal(instanceId, offer.entry, command).catch(error => {
			this.logService.error('[paradisTerminalResumeBanner] could not open a terminal for the fork', error);
			this.notificationService.error(localize('paradis.resumeBanner.forkFailed', "分岐用のターミナルを開けませんでした。"));
		});
	}

	/**
	 * 分岐は新しいタブで行う（元のタブではあとから同じ会話を続けられるよう、元のタブの案内は残す）。
	 * フォルダは会話を始めた場所。分からなければ元のタブの開始フォルダ。
	 */
	private async openForkTerminal(instanceId: number, entry: IParadisResumeLedgerEntry, command: string): Promise<void> {
		const source = this.terminalService.instances.find(candidate => candidate.instanceId === instanceId);
		const cwd = entry.cwd !== undefined ? this.toCwdUri(entry.cwd) : (source === undefined ? undefined : await source.getInitialCwd());
		const instance = await this.terminalService.createTerminal({ cwd, location: TerminalLocation.Editor });
		await instance.processReady;
		await this.terminalEditorService.openEditor(instance);
		this.terminalService.setActiveInstance(instance);
		await instance.sendText(command, true);
	}

	private toCwdUri(path: string): URI {
		const remoteAuthority = this.environmentService.remoteAuthority;
		return remoteAuthority === undefined ? URI.file(path) : URI.from({ scheme: Schemas.vscodeRemote, authority: remoteAuthority, path });
	}

	copySessionId(instanceId: number): void {
		const offer = this._offers.get(instanceId);
		if (offer !== undefined) {
			void this.clipboardService.writeText(offer.entry.sessionId);
		}
	}

	dismiss(instanceId: number): void {
		const offer = this._offers.get(instanceId);
		if (offer === undefined) {
			return;
		}
		// × で閉じたら、このタブでは再び出さない（台帳から消すので次の起動でも出ない）。
		if (this._ledger.get(offer.token)?.sessionId === offer.entry.sessionId) {
			this._ledger.delete(offer.token);
			this._dirtyTokens.add(offer.token);
			this._persistScheduler.schedule();
		}
		this.withdrawOffer(instanceId);
	}
}

registerWorkbenchContribution2(ParadisTerminalResumeBannerContribution.ID, ParadisTerminalResumeBannerContribution, WorkbenchPhase.AfterRestored);
