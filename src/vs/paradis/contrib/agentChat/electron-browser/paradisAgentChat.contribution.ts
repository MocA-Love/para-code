/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

// デスクトップのチャット（C1、フェーズ6）。
//
// エディタエリアのターミナルタブで動いている Claude Code / Codex を、同じタブの中でチャット表示に
// 切り替える（Q31 案A、⌘⇧J）。会話はターミナルと同じ会話ログを shared process のモバイル中継が
// 読んだものを引いて描き（Q29 案A）、送った文と回答はそのターミナルの TUI へ入力する。
//
// 重ねる先は共有ドットと同じ `paradisRegisterEditorTerminalOverlay`（fork 所有の SessionTerminalEditor
// が持つ口）で、upstream のファイルには触れない。

import { RunOnceScheduler, IntervalTimer } from '../../../../base/common/async.js';
import { Codicon } from '../../../../base/common/codicons.js';
import { Emitter } from '../../../../base/common/event.js';
import { KeyCode, KeyMod } from '../../../../base/common/keyCodes.js';
import { Disposable, DisposableMap, DisposableStore, IDisposable, toDisposable } from '../../../../base/common/lifecycle.js';
import { generateUuid } from '../../../../base/common/uuid.js';
import { ProxyChannel } from '../../../../base/parts/ipc/common/ipc.js';
import { localize, localize2 } from '../../../../nls.js';
import { Action2, MenuId, registerAction2 } from '../../../../platform/actions/common/actions.js';
import { IConfigurationService } from '../../../../platform/configuration/common/configuration.js';
import { ContextKeyExpr, IContextKey, RawContextKey } from '../../../../platform/contextkey/common/contextkey.js';
import { IInstantiationService, ServicesAccessor } from '../../../../platform/instantiation/common/instantiation.js';
import { ISharedProcessService } from '../../../../platform/ipc/electron-browser/services.js';
import { IKeybindingService } from '../../../../platform/keybinding/common/keybinding.js';
import { KeybindingWeight } from '../../../../platform/keybinding/common/keybindingsRegistry.js';
import { ILogService } from '../../../../platform/log/common/log.js';
import { IWorkbenchContribution, registerWorkbenchContribution2, WorkbenchPhase } from '../../../../workbench/common/contributions.js';
import { ActiveEditorContext } from '../../../../workbench/common/contextkeys.js';
import { IEditorCommandsContext } from '../../../../workbench/common/editor.js';
import { ITerminalInstance, ITerminalService, terminalEditorId } from '../../../../workbench/contrib/terminal/browser/terminal.js';
import { TerminalEditorInput } from '../../../../workbench/contrib/terminal/browser/terminalEditorInput.js';
import { DEFAULT_COMMANDS_TO_SKIP_SHELL } from '../../../../workbench/contrib/terminal/common/terminal.js';
import { TerminalContextKeys } from '../../../../workbench/contrib/terminal/common/terminalContextKey.js';
import { IEditorGroup, IEditorGroupsService } from '../../../../workbench/services/editor/common/editorGroupsService.js';
import { IParadisPaneTokenService } from '../../agentBrowser/browser/paradisPaneTokenService.js';
import { IParadisEditorTerminalOverlay, paradisRegisterEditorTerminalOverlay } from '../../agentBrowser/browser/paradisPaneIndicator.js';
import { IParadisAgentInsightsService } from '../../agentInsights/common/paradisAgentInsights.js';
import { paradisSendAgentMessageToTui } from '../../mobileRelay/common/paradisAgentMessageSender.js';
import { ParadisAgentQuestionAnswer, paradisAgentApprovalKeySequence, paradisAgentQuestionKeySequence } from '../../mobileRelay/common/paradisAgentQuestionKeys.js';
import { PARADIS_MOBILE_RELAY_CHANNEL } from '../../mobileRelay/common/paradisMobileRelay.js';
import { paradisSendAgentInteractionKeys } from '../browser/paradisAgentTuiInput.js';
import { ParadisAgentChatSendKey, PARADIS_AGENT_CHAT_HISTORY_LIMIT } from '../browser/paradisAgentChatComposer.js';
import { ParadisAgentChatSession } from '../browser/paradisAgentChatSession.js';
import { IParadisAgentChatViewHost, ParadisAgentChatView } from '../browser/paradisAgentChatView.js';
import { IParadisAgentChatCommand, IParadisAgentChatImageData, IParadisAgentChatSource, IParadisAgentInteraction, PARADIS_AGENT_CHAT_ENABLED_SETTING, PARADIS_AGENT_CHAT_SEND_KEY_SETTING, paradisIsCodexDaemonApprovalInteraction } from '../common/paradisAgentChat.js';
import { paradisPushAgentChatHistory } from '../common/paradisAgentChatComposerLogic.js';
import { paradisQuestionReadyMarker } from '../common/paradisAgentTranscriptParser.js';
import '../browser/media/paradisAgentChat.css';

const PARADIS_AGENT_CHAT_TOGGLE_COMMAND = 'paradis.agentChat.toggle';

/** そのグループで選んでいるターミナルタブで、エージェントの会話が確定している（チャットに切り替えられる）。 */
const PARADIS_AGENT_CHAT_AVAILABLE = new RawContextKey<boolean>('paradisAgentChatAvailable', false, localize('paradisAgentChat.contextAvailable', "選んでいるターミナルタブをチャット表示に切り替えられるか"));
/** そのグループで選んでいるターミナルタブが、チャット表示になっている。 */
const PARADIS_AGENT_CHAT_ACTIVE = new RawContextKey<boolean>('paradisAgentChatActive', false, localize('paradisAgentChat.contextActive', "選んでいるターミナルタブがチャット表示か"));

/** 見ているペインを shared process へ送り直す間隔。中継側の期限（30秒）より十分短くする。 */
const WATCH_RENEW_INTERVAL = 10_000;
/** 変化の知らせを取りこぼしたときの保険。見えているチャットだけを取り直す。 */
const VISIBLE_SAFETY_REFRESH_INTERVAL = 5_000;
/** スラッシュコマンドの一覧を使い回す時間。 */
const COMMAND_CACHE_TTL = 60_000;
/** 質問・承認の打鍵の間隔（モバイルと同じ）。 */
const INTERACTION_KEY_DELAY = 300;

// ターミナルにフォーカスがあるときも ⌘⇧J をシェルへ流さず、このコマンドで受ける。
// upstream の既定リストへ起動時に追記するだけで、terminal.ts は変更しない（terminalFontZoom と同じ）。
if (!DEFAULT_COMMANDS_TO_SKIP_SHELL.includes(PARADIS_AGENT_CHAT_TOGGLE_COMMAND)) {
	DEFAULT_COMMANDS_TO_SKIP_SHELL.push(PARADIS_AGENT_CHAT_TOGGLE_COMMAND);
}

/** エディタのターミナルの上に重ねる、チャット表示の置き場所（タブの切り替えで対象ペインが替わる）。 */
class ParadisAgentChatOverlay extends Disposable implements IParadisEditorTerminalOverlay {

	private instanceId: number | undefined;
	private view: ParadisAgentChatView | undefined;

	constructor(
		private readonly container: HTMLElement,
		private readonly controller: ParadisAgentChatController,
	) {
		super();
	}

	get currentInstanceId(): number | undefined {
		return this.instanceId;
	}

	setInstance(instanceId: number | undefined): void {
		this.instanceId = instanceId;
		this.update();
	}

	/** 対象のペインがチャット表示なら重ね、そうでなければ外す。 */
	update(): void {
		const instanceId = this.instanceId;
		const token = instanceId !== undefined && this.controller.isChatMode(instanceId) ? this.controller.tokenFor(instanceId) : undefined;
		const show = instanceId !== undefined && token !== undefined;
		if (show && this.view === undefined) {
			this.view = this.controller.createView(this.container);
			this._register(this.view.onDidRequestTerminal(() => {
				if (this.instanceId !== undefined) {
					this.controller.setChatMode(this.instanceId, false, true);
				}
			}));
			this._register(this.view);
		}
		this.view?.setTarget(show ? instanceId : undefined, show ? token : undefined);
		// ターミナルの画面は裏で描き続けるが、見えないようにする（ウィンドウの透過で下の文字が透けないように）。
		this.container.classList.toggle('paradis-agent-chat-active', show);
	}

	focusInput(): boolean {
		if (this.view === undefined || this.instanceId === undefined || !this.controller.isChatMode(this.instanceId)) {
			return false;
		}
		this.view.focusInput();
		return true;
	}

	override dispose(): void {
		this.container.classList.remove('paradis-agent-chat-active');
		this.controller.forgetOverlay(this);
		super.dispose();
	}
}

class ParadisAgentChatController extends Disposable implements IWorkbenchContribution, IParadisAgentChatViewHost {

	static readonly ID = 'workbench.contrib.paradisAgentChat';
	private static _instance: ParadisAgentChatController | undefined;

	/** コマンドから引くための現在のインスタンス（ウィンドウに1つ）。 */
	static get instance(): ParadisAgentChatController | undefined {
		return ParadisAgentChatController._instance;
	}

	private readonly source: IParadisAgentChatSource;
	private readonly watcherId = generateUuid();
	private readonly sessions = this._register(new DisposableMap<string, ParadisAgentChatSession>());
	private readonly chatModeInstances = new Set<number>();
	private readonly overlays = new Set<ParadisAgentChatOverlay>();
	private readonly drafts = new Map<string, string>();
	private readonly histories = new Map<string, string[]>();
	/** この画面から打鍵で答え終えた interaction（`token\0kind\0id`）。中継が消すまでの間も文を送れるようにする。 */
	private readonly answeredInteractions = new Set<string>();
	private readonly commandCache = new Map<string, { readonly at: number; readonly promise: Promise<readonly IParadisAgentChatCommand[]> }>();
	private readonly groupListeners = this._register(new DisposableMap<IEditorGroup, IDisposable>());
	private readonly instanceListeners = this._register(new DisposableMap<number, IDisposable>());
	private readonly _onDidChangeSettings = this._register(new Emitter<void>());
	readonly onDidChangeSettings = this._onDidChangeSettings.event;
	private readonly watchScheduler = this._register(new RunOnceScheduler(() => this.renewWatch(), 200));
	private enabled: boolean;

	constructor(
		@ISharedProcessService sharedProcessService: ISharedProcessService,
		@IInstantiationService private readonly instantiationService: IInstantiationService,
		@IParadisPaneTokenService private readonly paneTokenService: IParadisPaneTokenService,
		@IParadisAgentInsightsService private readonly insightsService: IParadisAgentInsightsService,
		@ITerminalService private readonly terminalService: ITerminalService,
		@IConfigurationService private readonly configurationService: IConfigurationService,
		@IKeybindingService private readonly keybindingService: IKeybindingService,
		@IEditorGroupsService private readonly editorGroupsService: IEditorGroupsService,
		@ILogService private readonly logService: ILogService,
	) {
		super();
		ParadisAgentChatController._instance = this;
		this._register(toDisposable(() => {
			if (ParadisAgentChatController._instance === this) {
				ParadisAgentChatController._instance = undefined;
			}
		}));
		this.source = ProxyChannel.toService<IParadisAgentChatSource>(sharedProcessService.getChannel(PARADIS_MOBILE_RELAY_CHANNEL));
		this.enabled = this.configurationService.getValue<boolean>(PARADIS_AGENT_CHAT_ENABLED_SETTING) !== false;

		this._register(paradisRegisterEditorTerminalOverlay(container => {
			const overlay = new ParadisAgentChatOverlay(container, this);
			this.overlays.add(overlay);
			return overlay;
		}));
		this._register(this.source.onDidChangeAgentChat(tokens => {
			// 取り直すのはチャット表示になっているペインだけ（生成中は知らせが頻繁に来るため）。
			// 閉じているペインは、次に開いたときに差分で追いつく。
			const visible = this.visibleTokens();
			for (const token of tokens) {
				if (visible.has(token)) {
					void this.sessions.get(token)?.refresh();
				}
			}
		}));
		this._register(this.paneTokenService.onDidChange(() => {
			this.pruneSessions();
			this.watchScheduler.schedule();
			this.updateAll();
		}));
		this._register(this.insightsService.onDidChange(() => this.updateContextKeys()));
		this._register(this.terminalService.onDidDisposeInstance(instance => this.forgetInstance(instance.instanceId)));
		this._register(this.configurationService.onDidChangeConfiguration(e => {
			if (e.affectsConfiguration(PARADIS_AGENT_CHAT_ENABLED_SETTING)) {
				this.enabled = this.configurationService.getValue<boolean>(PARADIS_AGENT_CHAT_ENABLED_SETTING) !== false;
				if (!this.enabled) {
					for (const instanceId of [...this.chatModeInstances]) {
						this.setChatMode(instanceId, false, false);
					}
				}
				this.watchScheduler.schedule();
				this.updateAll();
			}
			if (e.affectsConfiguration(PARADIS_AGENT_CHAT_SEND_KEY_SETTING)) {
				this._onDidChangeSettings.fire();
			}
		}));
		this._register(this.keybindingService.onDidUpdateKeybindings(() => this._onDidChangeSettings.fire()));

		for (const group of this.editorGroupsService.groups) {
			this.watchGroup(group);
		}
		this._register(this.editorGroupsService.onDidAddGroup(group => this.watchGroup(group)));
		this._register(this.editorGroupsService.onDidRemoveGroup(group => this.groupListeners.deleteAndDispose(group)));

		const renew = this._register(new IntervalTimer());
		renew.cancelAndSet(() => this.renewWatch(), WATCH_RENEW_INTERVAL);
		const safety = this._register(new IntervalTimer());
		safety.cancelAndSet(() => this.refreshVisibleSessions(), VISIBLE_SAFETY_REFRESH_INTERVAL);
		this._register(toDisposable(() => { void this.source.watchAgentChat(this.watcherId, []).catch(() => undefined); }));
		this.watchScheduler.schedule();
	}

	// ---- チャット表示の状態 --------------------------------------------------------------------

	isChatMode(instanceId: number): boolean {
		return this.enabled && this.chatModeInstances.has(instanceId);
	}

	tokenFor(instanceId: number): string | undefined {
		return this.paneTokenService.getTokenForInstance(instanceId);
	}

	/** そのペインでエージェントの会話が確定していて、チャットに切り替えられるか。 */
	isAvailable(instanceId: number): boolean {
		return this.enabled && this.insightsService.getForInstance(instanceId) !== undefined;
	}

	setChatMode(instanceId: number, chat: boolean, moveFocus: boolean): void {
		if (chat === this.chatModeInstances.has(instanceId)) {
			return;
		}
		const instance = this.terminalService.getInstanceFromId(instanceId);
		if (chat) {
			this.chatModeInstances.add(instanceId);
			if (instance !== undefined && !this.instanceListeners.has(instanceId)) {
				// タブを選び直すと TerminalEditor がターミナルへフォーカスを戻す。チャット表示の間に
				// 打った文字がシェルへ流れないよう、入力欄へ移し直す。
				this.instanceListeners.set(instanceId, instance.onDidFocus(() => {
					if (this.isChatMode(instanceId)) {
						this.focusChatInput(instanceId);
					}
				}));
			}
		} else {
			this.chatModeInstances.delete(instanceId);
			this.instanceListeners.deleteAndDispose(instanceId);
		}
		this.updateAll();
		if (!moveFocus) {
			return;
		}
		if (chat) {
			this.focusChatInput(instanceId);
		} else {
			instance?.focus(true);
		}
	}

	toggle(instanceId: number): void {
		if (!this.enabled) {
			return;
		}
		const chat = !this.chatModeInstances.has(instanceId);
		if (chat && !this.isAvailable(instanceId)) {
			return;
		}
		this.setChatMode(instanceId, chat, true);
	}

	private focusChatInput(instanceId: number): void {
		for (const overlay of this.overlays) {
			if (overlay.currentInstanceId === instanceId && overlay.focusInput()) {
				return;
			}
		}
	}

	createView(container: HTMLElement): ParadisAgentChatView {
		return this.instantiationService.createInstance(ParadisAgentChatView, container, this);
	}

	forgetOverlay(overlay: ParadisAgentChatOverlay): void {
		this.overlays.delete(overlay);
	}

	private forgetInstance(instanceId: number): void {
		this.chatModeInstances.delete(instanceId);
		this.instanceListeners.deleteAndDispose(instanceId);
	}

	private updateAll(): void {
		for (const overlay of this.overlays) {
			overlay.update();
		}
		this.updateContextKeys();
	}

	// ---- グループごとのコンテキストキー（ボタンの出し分けと押下状態） ------------------------------------

	private watchGroup(group: IEditorGroup): void {
		if (this.groupListeners.has(group)) {
			return;
		}
		const store = new DisposableStore();
		const available: IContextKey<boolean> = PARADIS_AGENT_CHAT_AVAILABLE.bindTo(group.scopedContextKeyService);
		const active: IContextKey<boolean> = PARADIS_AGENT_CHAT_ACTIVE.bindTo(group.scopedContextKeyService);
		const update = () => {
			const instanceId = this.instanceIdOfGroup(group);
			available.set(instanceId !== undefined && this.isAvailable(instanceId));
			active.set(instanceId !== undefined && this.isChatMode(instanceId));
		};
		store.add(group.onDidActiveEditorChange(update));
		store.add(this.onDidRequestContextUpdate(update));
		store.add(group.onWillDispose(() => this.groupListeners.deleteAndDispose(group)));
		update();
		this.groupListeners.set(group, store);
	}

	private readonly _onDidRequestContextUpdate = this._register(new Emitter<void>());
	private readonly onDidRequestContextUpdate = this._onDidRequestContextUpdate.event;

	private updateContextKeys(): void {
		this._onDidRequestContextUpdate.fire();
	}

	private instanceIdOfGroup(group: IEditorGroup): number | undefined {
		const editor = group.activeEditor;
		return editor instanceof TerminalEditorInput ? editor.terminalInstance?.instanceId : undefined;
	}

	/** コマンドの対象。グループのボタンから押されたらそのグループ、そうでなければアクティブなグループ。 */
	targetInstanceId(context: unknown): number | undefined {
		const groupId = typeof context === 'object' && context !== null && typeof (context as IEditorCommandsContext).groupId === 'number' ? (context as IEditorCommandsContext).groupId : undefined;
		const group = groupId !== undefined ? this.editorGroupsService.getGroup(groupId) : this.editorGroupsService.activeGroup;
		return group !== undefined ? this.instanceIdOfGroup(group) : undefined;
	}

	// ---- 会話の取り寄せ ----------------------------------------------------------------------

	session(token: string): ParadisAgentChatSession {
		let session = this.sessions.get(token);
		if (session === undefined) {
			session = new ParadisAgentChatSession(token, this.source, this.logService);
			this.sessions.set(token, session);
		}
		return session;
	}

	private pruneSessions(): void {
		const live = new Set(this.paneTokenService.listPaneTokens().map(entry => entry.token));
		for (const token of [...this.sessions.keys()]) {
			if (!live.has(token)) {
				this.sessions.deleteAndDispose(token);
				this.drafts.delete(token);
				this.histories.delete(token);
				this.commandCache.delete(token);
				for (const key of [...this.answeredInteractions]) {
					if (key.startsWith(`${token}\0`)) {
						this.answeredInteractions.delete(key);
					}
				}
			}
		}
	}

	/**
	 * このウィンドウのペインを「見ている」と中継へ知らせる。チャット表示を開いていないペインも含める
	 * （開く前に出た質問のカードも、開いたときに出せるように。中継はセッションの確定したペインだけを扱う）。
	 */
	private renewWatch(): void {
		const tokens = this.enabled ? this.paneTokenService.listPaneTokens().map(entry => entry.token) : [];
		this.source.watchAgentChat(this.watcherId, tokens).catch(error => this.logService.trace('[paradisAgentChat] watch failed', String(error)));
	}

	private visibleTokens(): Set<string> {
		const tokens = new Set<string>();
		for (const instanceId of this.chatModeInstances) {
			const token = this.tokenFor(instanceId);
			if (token !== undefined) {
				tokens.add(token);
			}
		}
		return tokens;
	}

	private refreshVisibleSessions(): void {
		for (const token of this.visibleTokens()) {
			void this.sessions.get(token)?.refresh();
		}
	}

	getFullText(token: string, epoch: string, rev: number): Promise<string | undefined> {
		return this.source.getAgentChatFullText(token, epoch, rev);
	}

	getImage(token: string, epoch: string, rev: number, index: number): Promise<IParadisAgentChatImageData | undefined> {
		return this.source.getAgentChatImage(token, epoch, rev, index);
	}

	getCommands(token: string): Promise<readonly IParadisAgentChatCommand[]> {
		const cached = this.commandCache.get(token);
		if (cached !== undefined && Date.now() - cached.at < COMMAND_CACHE_TTL) {
			return cached.promise;
		}
		const promise = this.source.getAgentChatCommands(token).catch(() => []);
		this.commandCache.set(token, { at: Date.now(), promise });
		return promise;
	}

	// ---- 入力欄 ------------------------------------------------------------------------------

	getSendKey(): ParadisAgentChatSendKey {
		return this.configurationService.getValue<string>(PARADIS_AGENT_CHAT_SEND_KEY_SETTING) === 'modEnter' ? 'modEnter' : 'enter';
	}

	getDraft(token: string): string {
		return this.drafts.get(token) ?? '';
	}

	setDraft(token: string, text: string): void {
		if (text.length > 0) {
			this.drafts.set(token, text);
		} else {
			this.drafts.delete(token);
		}
	}

	getHistory(token: string): readonly string[] {
		return this.histories.get(token) ?? [];
	}

	getToggleKeybindingLabel(): string | undefined {
		return this.keybindingService.lookupKeybinding(PARADIS_AGENT_CHAT_TOGGLE_COMMAND)?.getLabel() ?? undefined;
	}

	showTerminal(instanceId: number): void {
		this.setChatMode(instanceId, false, true);
	}

	// ---- ターミナルへの入力 --------------------------------------------------------------------

	/** 入力先のターミナル。タブが閉じた・ペインが別の会話に替わったなら undefined。 */
	private liveInstance(instanceId: number, token: string): ITerminalInstance | undefined {
		const instance = this.terminalService.getInstanceFromId(instanceId);
		return instance !== undefined && !instance.isDisposed && this.tokenFor(instanceId) === token ? instance : undefined;
	}

	async sendMessage(instanceId: number, token: string, text: string): Promise<string | undefined> {
		const instance = this.liveInstance(instanceId, token);
		if (instance === undefined) {
			return localize('paradisAgentChat.errorNoTerminal', "送り先のターミナルが見つかりません");
		}
		const session = this.session(token);
		await session.refresh();
		if (session.state === undefined) {
			return localize('paradisAgentChat.errorNoSession', "エージェントの会話が見つかりません");
		}
		// 質問・承認の画面に文字を流すと、先頭の文字が選択肢の操作として食われる（TM23 と同じ理由）。
		if (!this.isAnsweredOrNone(token, session.state.interaction)) {
			return localize('paradisAgentChat.errorInteraction', "エージェントが回答を待っています。先に質問・許可の確認に答えてください");
		}
		try {
			const outcome = await paradisSendAgentMessageToTui(
				text,
				(value, execute, bracketedPasteMode) => instance.sendText(value, execute ?? false, bracketedPasteMode),
				async () => {
					if (this.liveInstance(instanceId, token) !== instance) {
						return false;
					}
					await session.refresh();
					return session.state !== undefined && this.isAnsweredOrNone(token, session.state.interaction);
				},
			);
			if (!outcome.executed) {
				return outcome.consumed
					? localize('paradisAgentChat.errorPastedNotSent', "貼り付けた後に状態が変わったため、Enter を送りませんでした。ターミナルで確かめてください")
					: localize('paradisAgentChat.errorChanged', "送る前にターミナルの状態が変わりました");
			}
		} catch (error) {
			this.logService.warn('[paradisAgentChat] send failed', error);
			return localize('paradisAgentChat.errorSend', "ターミナルへ送れませんでした");
		}
		this.histories.set(token, paradisPushAgentChatHistory(this.getHistory(token), text, PARADIS_AGENT_CHAT_HISTORY_LIMIT));
		return undefined;
	}

	private isAnsweredOrNone(token: string, interaction: IParadisAgentInteraction | null): boolean {
		return interaction === null || this.answeredInteractions.has(`${token}\0${interaction.kind}\0${interaction.id}`);
	}

	/** 待っている interaction がまだ同じか（中継から取り直して確かめる）。 */
	private async interactionStillPending(token: string, kind: 'question' | 'approval', id: string): Promise<boolean> {
		const session = this.sessions.get(token);
		if (session === undefined) {
			return false;
		}
		await session.refresh();
		const interaction = session.state?.interaction;
		return interaction?.kind === kind && interaction.id === id;
	}

	async answerQuestions(instanceId: number, token: string, group: string, answers: readonly ParadisAgentQuestionAnswer[]): Promise<string | undefined> {
		const instance = this.liveInstance(instanceId, token);
		if (instance === undefined) {
			return localize('paradisAgentChat.errorNoTerminal', "送り先のターミナルが見つかりません");
		}
		if (!(await this.interactionStillPending(token, 'question', group))) {
			return localize('paradisAgentChat.errorQuestionGone', "この質問はもう回答を待っていません");
		}
		const questions = this.sessions.get(token)?.state?.pendingQuestions ?? [];
		// 選択肢の数が変わっていないか（中継がモバイルの回答に対して行う確認と同じ）。
		const matches = questions.length === answers.length && answers.every((answer, index) => {
			const question = questions[index];
			const optionCount = question?.options?.length ?? 0;
			if (answer.kind === 'option') {
				return question?.multiSelect !== true && answer.index < optionCount;
			}
			if (answer.kind === 'multi') {
				return question?.multiSelect === true && answer.indices.every(value => value < optionCount);
			}
			return answer.optionCount === optionCount;
		});
		if (!matches) {
			return localize('paradisAgentChat.errorQuestionChanged', "質問の選択肢が変わりました。もう一度選んでください");
		}
		const parts = paradisAgentQuestionKeySequence(questions.map(question => ({ optionCount: question.options?.length ?? 0, multiSelect: question.multiSelect === true })), answers);
		return this.sendInteractionKeys(instanceId, token, instance, 'question', group, parts, paradisQuestionReadyMarker(questions[0]));
	}

	async answerApproval(instanceId: number, token: string, interactionId: string, choiceId: string): Promise<string | undefined> {
		const instance = this.liveInstance(instanceId, token);
		if (instance === undefined) {
			return localize('paradisAgentChat.errorNoTerminal', "送り先のターミナルが見つかりません");
		}
		if (!(await this.interactionStillPending(token, 'approval', interactionId))) {
			return localize('paradisAgentChat.errorApprovalGone', "この確認はもう回答を待っていません");
		}
		if (paradisIsCodexDaemonApprovalInteraction(interactionId)) {
			// Codex の app-server 経由の承認は、キーではなく構造化された回答で返す（モバイルと同じ経路）。
			const answered = await this.source.answerAgentChatApproval(token, interactionId, choiceId).catch(() => false);
			void this.sessions.get(token)?.refresh();
			return answered ? undefined : localize('paradisAgentChat.errorApprovalSend', "Codex へ回答を送れませんでした。ターミナルで答えてください");
		}
		if (choiceId !== 'yes' && choiceId !== 'no') {
			return localize('paradisAgentChat.errorApprovalChoice', "この選択肢はここからは選べません。ターミナルで答えてください");
		}
		const agent = this.sessions.get(token)?.state?.agent ?? 'claude';
		return this.sendInteractionKeys(instanceId, token, instance, 'approval', interactionId, paradisAgentApprovalKeySequence(agent, choiceId), undefined);
	}

	private async sendInteractionKeys(instanceId: number, token: string, instance: ITerminalInstance, kind: 'question' | 'approval', id: string, parts: readonly string[], readyMarker: string | undefined): Promise<string | undefined> {
		if (parts.length === 0) {
			return localize('paradisAgentChat.errorNoKeys', "送る内容がありません");
		}
		// モバイルと同じ claim を取る。取れなければ、別の場所（スマホ・この画面）から送った回答が反映待ち。
		if (!(await this.source.claimAgentChatInteraction(token, kind, id).catch(() => false))) {
			return localize('paradisAgentChat.errorLocked', "送った回答がターミナルに反映されるのを待っています。変わらない場合はターミナルで確かめてください");
		}
		let stopReason: string | undefined;
		let keysSent = 0;
		try {
			const sent = await paradisSendAgentInteractionKeys(instance, parts, INTERACTION_KEY_DELAY, readyMarker, async () => {
				if (this.liveInstance(instanceId, token) !== instance) {
					stopReason = localize('paradisAgentChat.errorTerminalChanged', "送り先のターミナルが変わりました");
					return false;
				}
				if (!(await this.interactionStillPending(token, kind, id))) {
					// ターミナル側で先に答えた・別の質問に変わった。消えた質問の跡地へ打鍵しない。
					stopReason = localize('paradisAgentChat.errorInteractionChanged', "途中で回答待ちが終わったため、残りのキーを送りませんでした");
					return false;
				}
				keysSent++;
				return true;
			});
			if (sent) {
				this.answeredInteractions.add(`${token}\0${kind}\0${id}`);
			}
			return sent ? undefined : stopReason;
		} catch (error) {
			this.logService.warn('[paradisAgentChat] interaction keys failed', error);
			return localize('paradisAgentChat.errorSend', "ターミナルへ送れませんでした");
		} finally {
			// 1つでも打鍵したら、TUI が消費するまで同じ interaction へ打ち直させない（二重の打鍵が入力欄へ流れるため）。
			void this.source.releaseAgentChatInteraction(token, kind, id, keysSent > 0).catch(() => undefined);
			void this.sessions.get(token)?.refresh();
		}
	}
}

registerWorkbenchContribution2(ParadisAgentChatController.ID, ParadisAgentChatController, WorkbenchPhase.AfterRestored);

const chatToggleWhen = ContextKeyExpr.and(
	ActiveEditorContext.isEqualTo(terminalEditorId),
	ContextKeyExpr.or(PARADIS_AGENT_CHAT_AVAILABLE, PARADIS_AGENT_CHAT_ACTIVE),
);

registerAction2(class ParadisToggleAgentChatAction extends Action2 {
	constructor() {
		super({
			id: PARADIS_AGENT_CHAT_TOGGLE_COMMAND,
			title: localize2('paradisAgentChat.toggle', "チャット表示の切り替え"),
			icon: Codicon.commentDiscussion,
			f1: true,
			precondition: chatToggleWhen,
			toggled: PARADIS_AGENT_CHAT_ACTIVE,
			keybinding: {
				primary: KeyMod.CtrlCmd | KeyMod.Shift | KeyCode.KeyJ,
				// 下部パネルのターミナルにフォーカスがあるときは受けない（アクティブなエディタのタブを切り替えてしまうため）。
				when: ContextKeyExpr.and(chatToggleWhen, ContextKeyExpr.or(TerminalContextKeys.focus.negate(), TerminalContextKeys.editorFocus)),
				// 検索ビューの「クエリ詳細の切り替え」と同じキー。あちらは検索にフォーカスがあるときだけ効くので、
				// ターミナルタブを選んでいる間だけこちらが受ける。
				weight: KeybindingWeight.WorkbenchContrib + 1,
			},
			menu: [MenuId.EditorTitle, MenuId.CompactWindowEditorTitle].map(id => ({
				id,
				group: 'navigation',
				order: -20,
				when: chatToggleWhen,
			})),
		});
	}

	run(_accessor: ServicesAccessor, context?: unknown): void {
		const controller = ParadisAgentChatController.instance;
		const instanceId = controller?.targetInstanceId(context);
		if (controller !== undefined && instanceId !== undefined) {
			controller.toggle(instanceId);
		}
	}
});
