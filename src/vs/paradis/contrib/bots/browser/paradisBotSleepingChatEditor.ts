/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

// 眠った Bot の会話（報告書の D1・D2）。エージェントを起こさずに、前の会話を会話の記録のファイルから読むだけの吹き出しで
// 見せる（ペインが無いので、ターミナルに重ねる Bot のページではなく、このエディタに出す）。吹き出しはチャット表示と同じ部品
// （ParadisAgentChatView）で描く。入力欄から話しかけたときだけ、その文を最初の指示にして同じ会話を続けて起こし
// （`--resume`）、起きた Bot のページ（同じ会話の吹き出しの続き）に替えてこのタブを閉じる。

import * as dom from '../../../../base/browser/dom.js';
import { CancellationToken } from '../../../../base/common/cancellation.js';
import { Codicon } from '../../../../base/common/codicons.js';
import { Emitter, Event } from '../../../../base/common/event.js';
import { DisposableStore, MutableDisposable } from '../../../../base/common/lifecycle.js';
import { ThemeIcon } from '../../../../base/common/themables.js';
import { URI } from '../../../../base/common/uri.js';
import { localize } from '../../../../nls.js';
import { ICommandService } from '../../../../platform/commands/common/commands.js';
import { IEditorOptions } from '../../../../platform/editor/common/editor.js';
import { IInstantiationService } from '../../../../platform/instantiation/common/instantiation.js';
import { ILogService } from '../../../../platform/log/common/log.js';
import { IStorageService } from '../../../../platform/storage/common/storage.js';
import { ITelemetryService } from '../../../../platform/telemetry/common/telemetry.js';
import { IThemeService } from '../../../../platform/theme/common/themeService.js';
import { EditorPane } from '../../../../workbench/browser/parts/editor/editorPane.js';
import { IEditorOpenContext, IUntypedEditorInput } from '../../../../workbench/common/editor.js';
import { EditorInput } from '../../../../workbench/common/editor/editorInput.js';
import { IEditorGroup } from '../../../../workbench/services/editor/common/editorGroupsService.js';
import { IParadisAgentChatGuide, IParadisAgentChatImageData, IParadisAgentChatSource, IParadisAgentChatView } from '../../agentChat/common/paradisAgentChat.js';
import { ParadisAgentChatSendKey } from '../../agentChat/browser/paradisAgentChatComposer.js';
import { ParadisAgentChatSession } from '../../agentChat/browser/paradisAgentChatSession.js';
import { IParadisAgentChatCardStates, IParadisAgentChatViewHost, ParadisAgentChatView } from '../../agentChat/browser/paradisAgentChatView.js';
import { IParadisBotSleepingChat, IParadisBotsService } from '../common/paradisBotsApi.js';
import { PARADIS_BOTS_OPEN_COMMAND, paradisBotFace } from '../common/paradisBotsBandModel.js';
import { renderParadisBotFace } from './paradisBotFace.js';
import './media/paradisBotPage.css';

export const PARADIS_BOT_SLEEPING_CHAT_EDITOR_ID = 'paradis.editor.botSleepingChat';
export const PARADIS_BOT_SLEEPING_CHAT_INPUT_TYPE_ID = 'paradis.input.botSleepingChat';

/** 吹き出しの部品に渡すペインの番号の代わり（生きたペインが無いので、ターミナルの番号と重ならない負の値）。 */
const NO_PANE = -1;

/**
 * 眠った会話を、読むだけの会話の写しとして吹き出しの部品へ渡す（中継の代わり）。会話は 1 回だけ読み、取り直しには同じものを
 * 返す（眠っている間は会話が進まない）。読めなければ undefined（案内を出す）。
 */
export function paradisSleepingChatView(token: string, chat: IParadisBotSleepingChat | undefined): IParadisAgentChatView | undefined {
	if (chat === undefined || chat.unreadable === true) {
		return undefined;
	}
	return { token, agent: chat.agent, epoch: 'sleeping', rev: chat.messages.length, reset: true, messages: chat.messages, ...(chat.truncated ? { truncated: true } : {}), live: null, interaction: null, busy: false };
}

/** 眠った会話の案内（読めないときだけ。話しかければ起きるので、入力欄は止めない）。 */
export function paradisSleepingChatGuide(chat: IParadisBotSleepingChat | undefined): IParadisAgentChatGuide | undefined {
	return chat === undefined || chat.unreadable === true
		? { notice: localize('paradis.botSleeping.unreadable', "前の会話を読めません。話しかけると続きから起きます"), sendable: true }
		: undefined;
}

export class ParadisBotSleepingChatEditorInput extends EditorInput {

	static readonly ID = PARADIS_BOT_SLEEPING_CHAT_INPUT_TYPE_ID;

	private static readonly inputs = new Map<string, ParadisBotSleepingChatEditorInput>();

	/** Bot ごとに 1 つ。 */
	static getOrCreate(instantiationService: IInstantiationService, botId: string): ParadisBotSleepingChatEditorInput {
		let input = ParadisBotSleepingChatEditorInput.inputs.get(botId);
		if (input === undefined || input.isDisposed()) {
			input = instantiationService.createInstance(ParadisBotSleepingChatEditorInput, botId);
			ParadisBotSleepingChatEditorInput.inputs.set(botId, input);
		}
		return input;
	}

	readonly resource: URI;

	constructor(
		readonly botId: string,
		@IParadisBotsService private readonly botsService: IParadisBotsService,
	) {
		super();
		this.resource = URI.from({ scheme: 'paradis-bot-sleeping', path: `/${botId}` });
		this._register(this.botsService.onDidChange(() => this._onDidChangeLabel.fire()));
	}

	override get typeId(): string {
		return ParadisBotSleepingChatEditorInput.ID;
	}

	override get editorId(): string {
		return PARADIS_BOT_SLEEPING_CHAT_EDITOR_ID;
	}

	override getName(): string {
		return this.botsService.snapshot.bots.find(bot => bot.id === this.botId)?.name ?? 'Bot';
	}

	override getIcon(): ThemeIcon {
		return Codicon.commentDiscussion;
	}

	override matches(other: EditorInput | IUntypedEditorInput): boolean {
		return super.matches(other) || (other instanceof ParadisBotSleepingChatEditorInput && other.botId === this.botId);
	}

	override dispose(): void {
		if (ParadisBotSleepingChatEditorInput.inputs.get(this.botId) === this) {
			ParadisBotSleepingChatEditorInput.inputs.delete(this.botId);
		}
		super.dispose();
	}
}

export class ParadisBotSleepingChatEditor extends EditorPane implements IParadisAgentChatViewHost {

	static readonly ID = PARADIS_BOT_SLEEPING_CHAT_EDITOR_ID;

	private root!: HTMLElement;
	private face!: HTMLElement;
	private name!: HTMLElement;
	private status!: HTMLElement;
	private chatContainer!: HTMLElement;
	private readonly view = this._register(new MutableDisposable<ParadisAgentChatView>());
	private readonly inputStore = this._register(new DisposableStore());
	private chatSession: ParadisAgentChatSession | undefined;
	private chat: IParadisBotSleepingChat | undefined;
	private readonly drafts = new Map<string, string>();
	private readonly cards = new Map<string, IParadisAgentChatCardStates>();
	private readonly _onDidChangeSettings = this._register(new Emitter<void>());
	readonly onDidChangeSettings = this._onDidChangeSettings.event;
	private readonly _onDidChangeGuide = this._register(new Emitter<number>());
	readonly onDidChangeGuide = this._onDidChangeGuide.event;
	readonly readOnly = true;
	/** 起こしている最中（二重に送らない）。 */
	private waking = false;

	constructor(
		group: IEditorGroup,
		@ITelemetryService telemetryService: ITelemetryService,
		@IThemeService themeService: IThemeService,
		@IStorageService storageService: IStorageService,
		@IParadisBotsService private readonly botsService: IParadisBotsService,
		@ICommandService private readonly commandService: ICommandService,
		@IInstantiationService private readonly instantiationService: IInstantiationService,
		@ILogService private readonly logService: ILogService,
	) {
		super(PARADIS_BOT_SLEEPING_CHAT_EDITOR_ID, group, telemetryService, themeService, storageService);
	}

	private get botId(): string | undefined {
		return this.input instanceof ParadisBotSleepingChatEditorInput ? this.input.botId : undefined;
	}

	private get token(): string | undefined {
		const botId = this.botId;
		return botId !== undefined ? `sleeping:${botId}` : undefined;
	}

	protected override createEditor(parent: HTMLElement): void {
		// チャット表示の CSS（エディタのターミナルの入れ物の下に効く）と Bot のページの帯の CSS をそのまま使う
		this.root = dom.append(parent, dom.$('.terminal-overflow-guard.terminal-editor.paradis-bot-page-active.paradis-bot-sleeping-chat'));
		const strip = dom.append(this.root, dom.$('.paradis-bot-page-strip'));
		this.face = dom.append(strip, dom.$('.paradis-bot-page-face'));
		const title = dom.append(strip, dom.$('.paradis-bot-page-title'));
		this.name = dom.append(title, dom.$('span.paradis-bot-page-name'));
		this.status = dom.append(title, dom.$('span.paradis-bot-page-status'));
		this.chatContainer = this.root;
		this._register(this.botsService.onDidChange(() => this.renderStrip()));
	}

	override async setInput(input: EditorInput, options: IEditorOptions | undefined, context: IEditorOpenContext, token: CancellationToken): Promise<void> {
		await super.setInput(input, options, context, token);
		this.inputStore.clear();
		this.waking = false;
		this.chat = undefined;
		this.renderStrip();
		const botId = this.botId;
		const chatToken = this.token;
		if (botId === undefined || chatToken === undefined) {
			return;
		}
		this.chat = await this.botsService.sleepingChat(botId).catch(() => undefined);
		if (token.isCancellationRequested || this.botId !== botId) {
			return;
		}
		const source: IParadisAgentChatSource = {
			onDidChangeAgentChat: Event.None,
			watchAgentChat: async () => { },
			getAgentChat: async () => paradisSleepingChatView(chatToken, this.chat),
			getAgentChatFullText: async () => undefined,
			getAgentChatImage: async () => undefined,
			getAgentChatCommands: async () => [],
			answerAgentChatApproval: async () => false,
			claimAgentChatInteraction: async () => false,
			releaseAgentChatInteraction: async () => { },
		};
		this.chatSession = this.inputStore.add(new ParadisAgentChatSession(chatToken, source, this.logService));
		if (this.view.value === undefined) {
			this.view.value = this.instantiationService.createInstance(ParadisAgentChatView, this.chatContainer, this);
		}
		this.view.value.setHeaderHidden(true);
		this.view.value.setTarget(NO_PANE, chatToken);
		await this.chatSession.refresh();
		this._onDidChangeGuide.fire(NO_PANE);
	}

	override clearInput(): void {
		this.view.value?.setTarget(undefined, undefined);
		this.inputStore.clear();
		this.chatSession = undefined;
		super.clearInput();
	}

	override focus(): void {
		super.focus();
		this.view.value?.focusInput();
	}

	override layout(): void {
		// 中身は CSS の flex で収まる
	}

	private renderStrip(): void {
		const bot = this.botsService.snapshot.bots.find(candidate => candidate.id === this.botId);
		if (!this.root || bot === undefined) {
			return;
		}
		dom.clearNode(this.face);
		renderParadisBotFace(this.face, paradisBotFace(bot));
		this.name.textContent = bot.name;
		this.status.textContent = this.waking
			? localize('paradis.botSleeping.waking', "起こしています…")
			: localize('paradis.botSleeping.status', "眠っています。話しかけると続きから起きます");
		// 別の経路（スマホ・エージェントの道具・別のウィンドウ）で会話が起きた・続けられなくなったら、このタブは役目を終える。
		// 見回りのペインが動いても会話は眠ったままなので閉じない。書きかけがあるときも閉じない（消さない）
		const token = this.token;
		const draft = token !== undefined ? (this.drafts.get(token) ?? '') : '';
		if (!this.waking && bot.sleeping !== true && draft.trim().length === 0 && this.input !== undefined) {
			void this.group.closeEditor(this.input);
		}
	}

	// ---- IParadisAgentChatViewHost ---------------------------------------------------------------

	session(): ParadisAgentChatSession {
		return this.chatSession!;
	}

	/** 話しかけたら、その文を最初の指示にして同じ会話を続けて起こし、起きた Bot のページへ替える。 */
	async sendMessage(_instanceId: number, _token: string, text: string): Promise<string | undefined> {
		const botId = this.botId;
		const input = this.input;
		if (botId === undefined || input === undefined || this.waking) {
			return localize('paradis.botSleeping.busy', "起こしているところです");
		}
		this.waking = true;
		this.renderStrip();
		const ok = await this.commandService.executeCommand<boolean>(PARADIS_BOTS_OPEN_COMMAND, botId, { prompt: text });
		if (ok !== true) {
			this.waking = false;
			this.renderStrip();
			return localize('paradis.botSleeping.failed', "起こせませんでした。もう一度送ってください");
		}
		await this.group.closeEditor(input);
		return undefined;
	}

	chatGuide(): IParadisAgentChatGuide | undefined {
		return this.chatSession?.loaded === true ? paradisSleepingChatGuide(this.chat) : undefined;
	}

	async answerQuestions(): Promise<string | undefined> { return localize('paradis.botSleeping.readOnly', "眠っている会話には答えられません。話しかけると起きます"); }
	async answerApproval(): Promise<string | undefined> { return localize('paradis.botSleeping.readOnly', "眠っている会話には答えられません。話しかけると起きます"); }
	showTerminal(): void { }
	async getFullText(): Promise<string | undefined> { return undefined; }
	async getImage(): Promise<IParadisAgentChatImageData | undefined> { return undefined; }
	getToggleKeybindingLabel(): string | undefined { return undefined; }
	cardStates(token: string): IParadisAgentChatCardStates {
		let states = this.cards.get(token);
		if (states === undefined) {
			states = { questions: new Map(), approvals: new Map(), composer: { sending: false }, openGroups: new Set() };
			this.cards.set(token, states);
		}
		return states;
	}
	getSendKey(): ParadisAgentChatSendKey { return 'enter'; }
	getDraft(token: string): string { return this.drafts.get(token) ?? ''; }
	setDraft(token: string, text: string): void { this.drafts.set(token, text); }
	getHistory(): readonly string[] { return []; }
	async getCommands() { return []; }
}
