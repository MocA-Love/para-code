/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

// 復元したターミナルタブから前の会話を続ける。
//
// 1. エージェントの hook が報告する会話（shared process の状態スナップショットの `paneSessions`）と、
//    Codex が起動時にタイトルへ出すスレッド ID を、ペイントークンごとに台帳へ控える
// 2. 起動時に、復元したエディタのターミナルのうち「シェルを作り直した（= 中のエージェントが
//    終わった）」ものについて、台帳に前の会話があればバナーを出す
// 3. バナーから、このタブで続ける／CLI の fork で分岐する／会話 ID をコピーする

import { raceTimeout, RunOnceScheduler } from '../../../../base/common/async.js';
import { Emitter, Event } from '../../../../base/common/event.js';
import { Disposable, DisposableMap } from '../../../../base/common/lifecycle.js';
import { Schemas } from '../../../../base/common/network.js';
import { URI } from '../../../../base/common/uri.js';
import { localize } from '../../../../nls.js';
import { IClipboardService } from '../../../../platform/clipboard/common/clipboardService.js';
import { IFileService } from '../../../../platform/files/common/files.js';
import { ILogService } from '../../../../platform/log/common/log.js';
import { INotificationService } from '../../../../platform/notification/common/notification.js';
import { IStorageService, StorageScope, StorageTarget } from '../../../../platform/storage/common/storage.js';
import { ICommandDetectionCapability, TerminalCapability } from '../../../../platform/terminal/common/capabilities/capabilities.js';
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
import { paradisWasTerminalShellRestarted } from '../../workspaceSwitch/common/paradisTerminalLaunchPreparers.js';
import { paradisChangeDirectoryCommand } from '../../workspaceSwitch/common/paradisTerminalSpaceFolder.js';
import { paradisIsAtEmptyPrompt } from '../../terminalPromptInput/browser/paradisPromptInputEmpty.js';
import { createParadisTerminalResumeBanner, IParadisResumeBannerHost } from '../browser/paradisTerminalResumeBannerView.js';
import { IParadisResumeLedgerEntry, paradisCodexThreadIdFromTitle, paradisResumeLedgerKey, paradisParseResumeLedger, paradisRestoredShellWasRestarted, paradisResumeCommandLine, paradisResumeNeedsFolderChange, paradisChangeDirectoryBeforeResume, ParadisChangeDirectoryOutcome, paradisResumeTitleFromTab, paradisSerializeResumeLedger, paradisTrimResumeLedger } from '../common/paradisTerminalResumeBanner.js';

const LEDGER_STORAGE_KEY = 'paradis.terminal.resumeSessions';
/** 台帳の書き出しをまとめる間隔。hook はツールを使うたびに届くので、毎回は書かない。 */
const PERSIST_DELAY_MS = 2_000;
/** 今のフォルダを尋ねる上限。答えなければ「分からない」として扱う。 */
const CWD_QUERY_TIMEOUT_MS = 2_000;

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
	/** 会話のフォルダへ移っている最中のタブ。ボタンの連打で `cd` と再開を二重に送らない。 */
	private readonly _resuming = new Set<number>();

	constructor(
		@IStorageService private readonly storageService: IStorageService,
		@IParadisAgentStatusSnapshotService snapshotService: IParadisAgentStatusSnapshotService,
		@IParadisPaneTokenService private readonly paneTokenService: IParadisPaneTokenService,
		@ITerminalService private readonly terminalService: ITerminalService,
		@ITerminalEditorService private readonly terminalEditorService: ITerminalEditorService,
		@IClipboardService private readonly clipboardService: IClipboardService,
		@IFileService private readonly fileService: IFileService,
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
			const key = paradisResumeLedgerKey(session.token);
			const previous = this._ledger.get(key);
			const title = (instance === undefined ? undefined : paradisResumeTitleFromTab(instance.title))
				?? (previous?.sessionId === session.sessionId ? previous.title : undefined);
			this.upsert(key, {
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
		const token = this.ledgerKeyForInstance(instance.instanceId);
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

	/**
	 * 台帳のキー。ペイントークンはペインの app-server や MCP の Bearer を兼ねるので、そのままでは
	 * ディスクへ書かない（ハッシュにする）。
	 */
	private ledgerKeyForInstance(instanceId: number): string | undefined {
		const token = this.paneTokenService.getTokenForInstance(instanceId);
		return token === undefined ? undefined : paradisResumeLedgerKey(token);
	}

	private forgetInstance(instance: ITerminalInstance): void {
		const token = this.ledgerKeyForInstance(instance.instanceId);
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
		// 起動時に繋ぎ直しに失敗したタブは、ここより先に upstream が新しいシェルを起こし、その時点で
		// `attachPersistentProcess` を消している（`terminalProcessManager.ts` の attach 失敗の分岐）。
		// この contribution は AfterRestored なので、起動時からあるタブではもう消えた後を見ることがある。
		// 起こし直した記録（`paradisWasTerminalShellRestarted`）で拾う。シェルは作り直されている。
		const restartedAfterFailedAttach = attach === undefined && paradisWasTerminalShellRestarted(instance.instanceId);
		if (attach === undefined && !restartedAfterFailedAttach) {
			return;
		}
		this._restoredAt.set(instance.instanceId, Date.now());
		const previousPid = attach?.pid;
		const adopted = attach?.paradisAdopted === true;
		void instance.processReady.then(() => {
			if (instance.isDisposed || !(restartedAfterFailedAttach || paradisRestoredShellWasRestarted(previousPid, instance.processId, adopted))) {
				return;
			}
			const token = this.ledgerKeyForInstance(instance.instanceId);
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
		if (this._resuming.has(instanceId)) {
			return;
		}
		this._resuming.add(instanceId);
		void this.resumeInConversationFolder(instanceId).catch(error => {
			this.logService.error('[paradisTerminalResumeBanner] could not resume the conversation', error);
		}).finally(() => this._resuming.delete(instanceId));
	}

	/**
	 * このタブで前の会話を続ける。タブのシェルが会話を始めたフォルダと違う場所に居るなら、先に
	 * そこへ移り、移れたことを確かめてから再開する。
	 *
	 * 違うフォルダのまま再開すると、Claude Code は会話をそのフォルダのプロジェクトへ複製して続ける。
	 * 繋ぎ直しに失敗して別のスペースのフォルダで起き直したタブでこれが実際に起きたので、確かめられ
	 * ない（フォルダが無い、`cd` が失敗・時間切れ）ときは再開せずに知らせる。新しいタブを開いて
	 * 再開する方法（分岐と同じ）は取らない。元のタブが空のシェルとして残り、同じ会話のタブが2つに
	 * 見えるため。
	 */
	private async resumeInConversationFolder(instanceId: number): Promise<void> {
		const offer = this._offers.get(instanceId);
		const instance = this.terminalService.instances.find(candidate => candidate.instanceId === instanceId);
		const command = offer === undefined ? undefined : paradisResumeCommandLine(offer.entry.agent, offer.entry.sessionId, 'resume');
		if (offer === undefined || instance === undefined || command === undefined) {
			return;
		}
		// コマンドと Enter を送るので、シェルが入力を待っていて入力欄が空のときだけにする。別の
		// プログラム（ssh 先のシェル、vim など）が前面に居ると、そちらへ入ってしまう。
		const commandDetection = instance.capabilities.get(TerminalCapability.CommandDetection);
		if (commandDetection === undefined) {
			// シェル統合が無いと、前面で何が動いているかも入力欄の中身も分からない。自動では送らず、
			// 自分で打つコマンドを案内する（ID のコピーはバナーから行える）。
			this.notificationService.info(localize('paradis.resumeBanner.noShellIntegration', "このターミナルではシェルの状態が分からないため、自動では再開しません。シェルのプロンプトで次のコマンドを実行してください: {0}", command));
			return;
		}
		if (!this.isAtEmptyPrompt(commandDetection)) {
			this.notificationService.info(localize('paradis.resumeBanner.notAtPrompt', "シェルが入力を待っていて入力欄が空のときに押してください。いま動いているプログラムを終えるか、入力欄を空にしてからもう一度押します。"));
			return;
		}
		const recordedCwd = offer.entry.cwd;
		const currentCwd = await raceTimeout(instance.getSpeculativeCwd().catch(() => undefined), CWD_QUERY_TIMEOUT_MS);
		if (recordedCwd !== undefined && paradisResumeNeedsFolderChange(recordedCwd, currentCwd)) {
			const exists = await this.fileService.stat(this.toCwdUri(recordedCwd)).then(stat => stat.isDirectory, () => false);
			if (!exists) {
				this.notificationService.warn(localize('paradis.resumeBanner.folderMissing', "会話を始めたフォルダ {0} が見つからないため、再開しません。別のフォルダで再開すると、会話がそのフォルダのプロジェクトへ複製されます。", recordedCwd));
				return;
			}
			const changeDirectory = paradisChangeDirectoryCommand(instance.shellType, recordedCwd);
			if (changeDirectory === undefined) {
				// 引用の仕方が分からないシェルへ自動で `cd` を送ると、パスの一部が別の意味に取られうる。
				this.notificationService.warn(localize('paradis.resumeBanner.unknownShell', "このシェルでは会話を始めたフォルダ {0} へ自動で移れないため、再開しません。そのフォルダへ移ってから、もう一度押してください。", recordedCwd));
				return;
			}
			const outcome = instance.isDisposed || !this.isAtEmptyPrompt(commandDetection)
				? 'failed'
				: await this.changeDirectory(instance, commandDetection, changeDirectory, recordedCwd);
			if (outcome === 'typed') {
				// `cd` の最中に打たれた文字に再開コマンドをつなげると、Enter を押していないのに実行される。
				this.notificationService.info(localize('paradis.resumeBanner.typedDuringMove', "会話を始めたフォルダへ移りましたが、その間に入力された文字があるため再開していません。入力欄を空にしてから、もう一度押してください。"));
				return;
			}
			if (outcome !== 'moved') {
				this.notificationService.warn(localize('paradis.resumeBanner.folderChangeFailed', "会話を始めたフォルダ {0} へ移れなかったため、再開を取りやめました。そのフォルダへ移ってから、もう一度押してください。", recordedCwd));
				return;
			}
		}
		if (instance.isDisposed || this._offers.get(instanceId) !== offer) {
			return;
		}
		// `cd` を待っている間に打ち始めた文字や、動き出したプログラムがあれば、そこへ混ぜない。
		if (!this.isAtEmptyPrompt(commandDetection)) {
			this.notificationService.info(localize('paradis.resumeBanner.notAtPromptAfterMove', "会話を始めたフォルダへ移りましたが、入力欄が空でないため再開していません。入力欄を空にしてから、もう一度押してください。"));
			return;
		}
		this.withdrawOffer(instanceId);
		void instance.sendText(command, true);
		instance.focus();
	}

	private isAtEmptyPrompt(commandDetection: ICommandDetectionCapability): boolean {
		// 右プロンプト（zsh の RPROMPT）だけが出ている入力欄も空と読む（`paradisIsAtEmptyPrompt`）。
		return paradisIsAtEmptyPrompt(commandDetection);
	}

	/**
	 * `cd` を送り、次のプロンプトが入力を待つまで見届ける（`paradisChangeDirectoryBeforeResume`）。
	 *
	 * フォルダの確認: シェル統合はコマンドの終了を知らせた後にフォルダの変化を知らせる（zsh / bash の
	 * precmd の順）。終了の時点ではまだ古いフォルダが見えることがあるので、フォルダの知らせも少し待つ。
	 */
	private async changeDirectory(instance: ITerminalInstance, commandDetection: ICommandDetectionCapability, changeDirectory: string, path: string): Promise<ParadisChangeDirectoryOutcome> {
		const cwdDetection = instance.capabilities.get(TerminalCapability.CwdDetection);
		const arrived = cwdDetection === undefined ? undefined : Event.toPromise(Event.filter(cwdDetection.onDidChangeCwd, cwd => !paradisResumeNeedsFolderChange(path, cwd)));
		try {
			return await paradisChangeDirectoryBeforeResume({
				onCommandFinished: commandDetection.onCommandFinished,
				onPromptInputStarted: commandDetection.promptInputModel.onDidStartInput,
				onInput: instance.onDidInputData,
				send: text => instance.sendText(text, true),
				isAtEmptyPrompt: () => this.isAtEmptyPrompt(commandDetection),
				confirmFolder: async () => {
					const currentCwd = await raceTimeout(instance.getSpeculativeCwd().catch(() => undefined), CWD_QUERY_TIMEOUT_MS);
					if (currentCwd !== undefined && !paradisResumeNeedsFolderChange(path, currentCwd)) {
						return true;
					}
					return arrived !== undefined && await raceTimeout(arrived, CWD_QUERY_TIMEOUT_MS) !== undefined;
				},
			}, changeDirectory);
		} finally {
			arrived?.cancel();
		}
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
