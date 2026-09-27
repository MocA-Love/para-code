/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

// エディタエリアのターミナルタブの中身を覆って出す、チャット表示（Q31 案A）。
//
// 描くのは中継から写した会話（ParadisAgentChatSession）だけで、ターミナルは裏で動き続ける。
// 画面の部品は Para Code 側で作る（Q30 案A）。VS Code のチャット部品は借りない。

import { $, addDisposableListener, append, clearNode, EventType } from '../../../../base/browser/dom.js';
import { renderIcon } from '../../../../base/browser/ui/iconLabel/iconLabels.js';
import { IntervalTimer, RunOnceScheduler } from '../../../../base/common/async.js';
import { Codicon } from '../../../../base/common/codicons.js';
import { Emitter, Event } from '../../../../base/common/event.js';
import { MarkdownString } from '../../../../base/common/htmlContent.js';
import { Disposable, DisposableStore, IDisposable, MutableDisposable, toDisposable } from '../../../../base/common/lifecycle.js';
import { ThemeIcon } from '../../../../base/common/themables.js';
import { localize } from '../../../../nls.js';
import { IMarkdownRendererService } from '../../../../platform/markdown/browser/markdownRenderer.js';
import { ParadisAgentQuestionAnswer } from '../../mobileRelay/common/paradisAgentQuestionKeys.js';
import { IParadisAgentChatImage, IParadisAgentChatImageData, IParadisAgentChatMessage, IParadisAgentInteraction, IParadisAgentLiveState, paradisIsCodexDaemonApprovalInteraction } from '../common/paradisAgentChat.js';
import { IParadisAgentChatState } from '../common/paradisAgentChatState.js';
import { IParadisAgentChatEditDiff, paradisAgentChatEditDiff, paradisBuildAgentChatItems, paradisDescribeAgentChatTool, paradisIsPendingApprovalItem, paradisIsPendingQuestionItem, ParadisAgentChatItem } from '../common/paradisAgentChatTimeline.js';
import { IParadisAgentChatComposerHost, ParadisAgentChatComposer } from './paradisAgentChatComposer.js';
import { ParadisAgentChatSession } from './paradisAgentChatSession.js';

/** チャット表示が呼び出し側（electron-browser の contribution）へ求めるもの。 */
export interface IParadisAgentChatViewHost extends IParadisAgentChatComposerHost {
	/** ペインの会話の写し。ペインにトークンが無ければ undefined。 */
	session(token: string): ParadisAgentChatSession;
	sendMessage(instanceId: number, token: string, text: string): Promise<string | undefined>;
	answerQuestions(instanceId: number, token: string, group: string, answers: readonly ParadisAgentQuestionAnswer[]): Promise<string | undefined>;
	answerApproval(instanceId: number, token: string, interactionId: string, choiceId: string): Promise<string | undefined>;
	showTerminal(instanceId: number): void;
	getFullText(token: string, epoch: string, rev: number): Promise<string | undefined>;
	getImage(token: string, epoch: string, rev: number, index: number): Promise<IParadisAgentChatImageData | undefined>;
	/** ⌘⇧J の表示名（キー割り当てを変えていればその表示）。 */
	getToggleKeybindingLabel(): string | undefined;
	readonly onDidChangeSettings: Event<void>;
}

/** 差分カードで最初から見せる行数。超えた分は「すべて表示」で開く。 */
const DIFF_PREVIEW_ROWS = 14;
/** ツールの出力を展開したときに見せる上限（文字数）。長い出力は全文の取り寄せで読む。 */
const TOOL_DETAIL_PREVIEW_CHARS = 4000;
/** 最下部にいるとみなす余白。この範囲にいれば、新しい発言で最下部へ追従する。 */
const STICK_TO_BOTTOM_THRESHOLD = 48;
/** 取り寄せた画像を覚えておく数（同じ画像を描き直すたびに取りに行かない）。 */
const IMAGE_CACHE_LIMIT = 40;

interface IRenderedItem {
	readonly element: HTMLElement;
	readonly signature: string;
	readonly store: DisposableStore;
}

/** 質問カードの入力途中の状態（描き直しても失わないよう、カードの外に持つ）。 */
interface IQuestionDraft {
	step: number;
	readonly answers: (ParadisAgentQuestionAnswer | undefined)[];
	readonly multi: Map<number, Set<number>>;
	readonly other: Map<number, string>;
	sending: boolean;
	/** 送り終えた。TUI が消費して質問が消えるまで、もう一度は送らせない。 */
	sent: boolean;
	error?: string;
}

export class ParadisAgentChatView extends Disposable {

	private readonly _onDidRequestTerminal = this._register(new Emitter<void>());
	readonly onDidRequestTerminal = this._onDidRequestTerminal.event;

	readonly element: HTMLElement;
	private readonly headerAgent: HTMLElement;
	private readonly headerModel: HTMLElement;
	private readonly headerStatus: HTMLElement;
	private readonly backButton: HTMLButtonElement;
	private readonly scroller: HTMLElement;
	private readonly list: HTMLElement;
	private readonly notice: HTMLElement;
	private readonly liveElement: HTMLElement;
	private readonly fallbackCard: HTMLElement;
	private readonly jumpButton: HTMLButtonElement;
	private readonly composer: ParadisAgentChatComposer;

	private instanceId: number | undefined;
	private token: string | undefined;
	private session: ParadisAgentChatSession | undefined;
	private readonly sessionListener = this._register(new MutableDisposable());
	private readonly rendered = new Map<string, IRenderedItem>();
	private readonly expanded = new Set<string>();
	private readonly fullTexts = new Map<string, string>();
	private readonly pendingFullTexts = new Set<string>();
	private readonly images = new Map<string, string>();
	private readonly pendingImages = new Set<string>();
	private readonly questionDrafts = new Map<string, IQuestionDraft>();
	/** 承認の回答を送っている・送れなかった状態（interaction id ごと）。 */
	private readonly approvalStates = new Map<string, { readonly sending: boolean; readonly sent?: boolean; readonly error?: string }>();
	private liveClock: HTMLElement | undefined;
	private readonly liveMarkdown = this._register(new MutableDisposable<IDisposable>());
	private readonly fallbackStore = this._register(new DisposableStore());
	private lastLiveSignature = '';
	private stickToBottom = true;
	private visible = false;
	private readonly renderScheduler = this._register(new RunOnceScheduler(() => this.render(), 0));
	private readonly ticker = this._register(new IntervalTimer());

	constructor(
		container: HTMLElement,
		private readonly host: IParadisAgentChatViewHost,
		@IMarkdownRendererService private readonly markdownRenderer: IMarkdownRendererService,
	) {
		super();
		this.element = append(container, $('.paradis-agent-chat'));
		this.element.style.display = 'none';
		this._register(toDisposable(() => this.element.remove()));
		this._register(toDisposable(() => {
			for (const item of this.rendered.values()) {
				item.store.dispose();
			}
			this.rendered.clear();
		}));
		// 下のターミナルのエディタは、エディタ全体の mousedown / contextmenu でターミナルのクリック動作
		// （右クリックでの貼り付け・ターミナルのメニュー）を行う。チャットの上の操作をそこへ流さない。
		for (const type of [EventType.MOUSE_DOWN, EventType.MOUSE_UP, EventType.CONTEXT_MENU]) {
			this._register(addDisposableListener(this.element, type, e => e.stopPropagation()));
		}

		const header = append(this.element, $('.paradis-agent-chat-header'));
		this.headerAgent = append(header, $('span.paradis-agent-chat-header-agent'));
		this.headerModel = append(header, $('span.paradis-agent-chat-header-model'));
		this.headerStatus = append(header, $('span.paradis-agent-chat-header-status'));
		append(header, $('span.paradis-agent-chat-header-spacer'));
		this.backButton = append(header, $('button.paradis-agent-chat-back')) as HTMLButtonElement;
		this.backButton.type = 'button';
		this._register(addDisposableListener(this.backButton, EventType.CLICK, () => this._onDidRequestTerminal.fire()));

		const body = append(this.element, $('.paradis-agent-chat-body'));
		this.scroller = append(body, $('.paradis-agent-chat-scroll'));
		this.list = append(this.scroller, $('.paradis-agent-chat-list'));
		this.list.setAttribute('role', 'log');
		this.list.setAttribute('aria-live', 'polite');
		this.notice = append(this.list, $('.paradis-agent-chat-notice'));
		this.fallbackCard = append(this.scroller, $('.paradis-agent-chat-list.paradis-agent-chat-fallback'));
		this.liveElement = append(this.scroller, $('.paradis-agent-chat-list.paradis-agent-chat-live-holder'));
		this.jumpButton = append(body, $('button.paradis-agent-chat-jump')) as HTMLButtonElement;
		this.jumpButton.type = 'button';
		this.jumpButton.append(renderIcon(Codicon.arrowDown), $('span', undefined, localize('paradisAgentChat.jumpToLatest', "最新へ")));
		this._register(addDisposableListener(this.jumpButton, EventType.CLICK, () => this.scrollToBottom()));
		this._register(addDisposableListener(this.scroller, EventType.SCROLL, () => {
			this.stickToBottom = this.isAtBottom();
			this.jumpButton.classList.toggle('visible', !this.stickToBottom);
		}));

		this.composer = this._register(new ParadisAgentChatComposer(this.element, host));
		this._register(this.composer.onDidSubmit(text => this.submit(text)));
		this._register(host.onDidChangeSettings(() => {
			this.composer.refreshSettings();
			this.updateBackLabel();
		}));
		this.updateBackLabel();
	}

	/** 表示する対象のペインを差し替える。undefined なら隠す（ターミナルが見える）。 */
	setTarget(instanceId: number | undefined, token: string | undefined): void {
		const visible = instanceId !== undefined && token !== undefined;
		if (this.token !== token) {
			this.resetRendered();
			this.token = token;
			this.session = token !== undefined ? this.host.session(token) : undefined;
			this.sessionListener.value = this.session?.onDidChange(() => this.renderScheduler.schedule());
			this.stickToBottom = true;
		}
		this.instanceId = instanceId;
		this.composer.setToken(visible ? token : undefined);
		if (this.visible !== visible) {
			this.visible = visible;
			this.element.style.display = visible ? '' : 'none';
			if (visible) {
				this.ticker.cancelAndSet(() => this.updateLiveClock(), 1000);
			} else {
				this.ticker.cancel();
			}
		}
		if (visible) {
			void this.session?.refresh();
			this.render();
		}
	}

	focusInput(): void {
		this.composer.focus();
	}

	private updateBackLabel(): void {
		const keybinding = this.host.getToggleKeybindingLabel();
		clearNode(this.backButton);
		this.backButton.append(renderIcon(Codicon.terminal), $('span', undefined, keybinding !== undefined
			? localize('paradisAgentChat.backWithKey', "{0} でターミナルに戻る", keybinding)
			: localize('paradisAgentChat.back', "ターミナルに戻る")));
	}

	private resetRendered(): void {
		for (const item of this.rendered.values()) {
			item.store.dispose();
			item.element.remove();
		}
		this.rendered.clear();
		this.expanded.clear();
		this.questionDrafts.clear();
		this.approvalStates.clear();
		this.fullTexts.clear();
		this.images.clear();
		this.liveMarkdown.clear();
		this.lastLiveSignature = '';
		this.liveClock = undefined;
		clearNode(this.liveElement);
		this.fallbackStore.clear();
		clearNode(this.fallbackCard);
	}

	private isAtBottom(): boolean {
		return this.scroller.scrollHeight - this.scroller.scrollTop - this.scroller.clientHeight <= STICK_TO_BOTTOM_THRESHOLD;
	}

	private scrollToBottom(): void {
		this.scroller.scrollTop = this.scroller.scrollHeight;
		this.stickToBottom = true;
		this.jumpButton.classList.remove('visible');
	}

	// ---- 描画 ----------------------------------------------------------------------------------

	private render(): void {
		if (!this.visible || this.session === undefined) {
			return;
		}
		const follow = this.stickToBottom;
		const state = this.session.state;
		this.renderHeader(state);
		if (state === undefined) {
			this.renderEmpty(this.session.loaded);
		} else {
			this.renderItems(state);
		}
		this.renderLive(state);
		this.renderFallbackApproval(state);
		this.composer.setBusy(state?.busy === true);
		// この画面から答え終えた質問・承認は、中継が消すのを待たずに送れるようにする
		// （tool_use_id の無い承認は、ターンが終わるまで中継に残るため）。
		const interaction = state?.interaction;
		const answeredHere = interaction?.kind === 'question'
			? this.questionDrafts.get(interaction.id)?.sent === true
			: interaction?.kind === 'approval' && this.approvalStates.get(interaction.id)?.sent === true;
		this.composer.setBlockedReason(state === undefined
			? localize('paradisAgentChat.blockedNoSession', "エージェントの会話が見つかりません")
			: answeredHere
				? undefined
				: state.interaction?.kind === 'question'
					? localize('paradisAgentChat.blockedQuestion', "質問に答えてから送ってください")
					: state.interaction?.kind === 'approval'
						? localize('paradisAgentChat.blockedApproval', "許可の確認に答えてから送ってください")
						: undefined);
		if (follow) {
			this.scrollToBottom();
		}
	}

	private renderHeader(state: IParadisAgentChatState | undefined): void {
		this.headerAgent.textContent = state === undefined ? '' : state.agent === 'codex' ? 'Codex' : 'Claude Code';
		const model = [state?.info?.model, state?.info?.effort].filter((part): part is string => part !== undefined && part.length > 0).join(' · ');
		this.headerModel.textContent = model;
		this.headerModel.style.display = model.length > 0 ? '' : 'none';
		let status = '';
		if (state?.interaction?.kind === 'question') {
			status = localize('paradisAgentChat.statusQuestion', "質問に答えるのを待っています");
		} else if (state?.interaction?.kind === 'approval') {
			status = localize('paradisAgentChat.statusApproval', "許可を待っています");
		} else if (state?.busy) {
			status = localize('paradisAgentChat.statusBusy', "作業中");
		}
		this.headerStatus.textContent = status;
		this.headerStatus.classList.toggle('attention', state?.interaction !== null && state?.interaction !== undefined);
		this.headerStatus.classList.toggle('busy', state?.busy === true && (state.interaction === null || state.interaction === undefined));
	}

	private renderEmpty(loaded: boolean): void {
		for (const item of this.rendered.values()) {
			item.store.dispose();
			item.element.remove();
		}
		this.rendered.clear();
		this.notice.textContent = loaded
			? localize('paradisAgentChat.empty', "このターミナルのエージェントの会話が見つかりません。エージェントが会話を始めると、ここに表示されます。")
			: localize('paradisAgentChat.loading', "会話を読み込んでいます…");
		this.notice.style.display = '';
	}

	private renderItems(state: IParadisAgentChatState): void {
		this.notice.textContent = state.truncated ? localize('paradisAgentChat.truncated', "これより前の会話は省略しています。すべて読むにはターミナルに戻ってください。") : '';
		this.notice.style.display = state.truncated ? '' : 'none';
		const items = paradisBuildAgentChatItems(state.messages);
		const seen = new Set<string>();
		let previous: HTMLElement = this.notice;
		for (const item of items) {
			seen.add(item.key);
			const signature = this.itemSignature(item, state.interaction);
			let rendered = this.rendered.get(item.key);
			if (rendered === undefined || rendered.signature !== signature) {
				const store = new DisposableStore();
				const element = this.renderItem(item, state, store);
				if (rendered !== undefined) {
					rendered.element.replaceWith(element);
					rendered.store.dispose();
				}
				rendered = { element, signature, store };
				this.rendered.set(item.key, rendered);
			}
			if (previous.nextSibling !== rendered.element) {
				previous.after(rendered.element);
			}
			previous = rendered.element;
		}
		for (const [key, rendered] of [...this.rendered]) {
			if (!seen.has(key)) {
				rendered.store.dispose();
				rendered.element.remove();
				this.rendered.delete(key);
			}
		}
	}

	/** 描き直しが要るかを決める指紋。 */
	private itemSignature(item: ParadisAgentChatItem, interaction: IParadisAgentInteraction | null): string {
		const expanded = this.expanded.has(item.key);
		switch (item.kind) {
			case 'tool': {
				const key = item.use !== undefined ? this.fullTextKey(item.use.rev) : '';
				return JSON.stringify([item.kind, item.use?.rev, item.result?.rev, expanded, this.expanded.has(`${item.key}:diff`), this.fullTexts.has(key), this.imageSignature(item.result)]);
			}
			case 'questions': {
				// 自由入力の文字は指紋に入れない（打つたびにカードを作り直すと、入力欄のフォーカスが外れる）。
				const draft = this.questionDrafts.get(item.group);
				const draftSignature = draft === undefined ? undefined : [draft.step, draft.sending, draft.sent, draft.error, draft.answers.map(answer => answer === undefined ? '' : answer.kind === 'option' ? `o${answer.index}` : answer.kind === 'multi' ? `m${answer.indices.join(',')}` : 't')];
				return JSON.stringify([item.kind, item.questions.map(question => question.rev), item.answered, item.answer, paradisIsPendingQuestionItem(item, interaction), draftSignature]);
			}
			case 'approval':
				return JSON.stringify([item.kind, item.message.rev, paradisIsPendingApprovalItem(item, interaction), interaction?.kind === 'approval' ? interaction.choices : undefined, this.approvalStates.get(item.message.toolUseId ?? '')]);
			default:
				return JSON.stringify([item.kind, item.message.rev, expanded, this.imageSignature(item.message)]);
		}
	}

	private renderItem(item: ParadisAgentChatItem, state: IParadisAgentChatState, store: DisposableStore): HTMLElement {
		switch (item.kind) {
			case 'user': {
				const element = $('.paradis-agent-chat-message.user');
				const bubble = append(element, $('.paradis-agent-chat-bubble'));
				if (item.message.text.length > 0) {
					append(bubble, $('.paradis-agent-chat-plain')).textContent = item.message.text;
				}
				this.appendImages(bubble, item.message, state, store);
				return element;
			}
			case 'assistant': {
				const element = $('.paradis-agent-chat-message.assistant');
				const body = append(element, $('.paradis-agent-chat-markdown'));
				const rendered = store.add(this.markdownRenderer.render(new MarkdownString(item.message.text, { isTrusted: false, supportThemeIcons: false, supportHtml: false })));
				body.appendChild(rendered.element);
				this.appendImages(element, item.message, state, store);
				return element;
			}
			case 'thinking':
				return this.renderCollapsible(item.key, Codicon.lightbulb, localize('paradisAgentChat.thinking', "考えた内容"), item.message.text, 'thinking', store);
			case 'peer': {
				const element = $('.paradis-agent-chat-message.peer');
				append(element, $('.paradis-agent-chat-peer-name')).textContent = item.message.peerName !== undefined
					? localize('paradisAgentChat.peerFrom', "{0} からのメッセージ", item.message.peerName)
					: localize('paradisAgentChat.peer', "別のエージェントからのメッセージ");
				append(element, $('.paradis-agent-chat-plain')).textContent = item.message.peerSummary ?? item.message.text;
				return element;
			}
			case 'tool':
				return this.renderTool(item, state, store);
			case 'questions':
				return this.renderQuestions(item, state, store);
			case 'approval':
				return this.renderApproval(item.message, state, store);
		}
	}

	private renderCollapsible(key: string, icon: ThemeIcon, label: string, text: string, className: string, store: DisposableStore): HTMLElement {
		const element = $(`.paradis-agent-chat-step.${className}`);
		const row = append(element, $('button.paradis-agent-chat-step-row')) as HTMLButtonElement;
		row.type = 'button';
		const expanded = this.expanded.has(key);
		row.setAttribute('aria-expanded', String(expanded));
		row.append(renderIcon(expanded ? Codicon.chevronDown : Codicon.chevronRight), renderIcon(icon), $('span.paradis-agent-chat-step-label', undefined, label));
		if (!expanded) {
			append(row, $('span.paradis-agent-chat-step-arg')).textContent = text.replace(/\s+/g, ' ').trim();
		}
		store.add(addDisposableListener(row, EventType.CLICK, () => this.toggleExpanded(key)));
		if (expanded) {
			append(element, $('pre.paradis-agent-chat-step-detail')).textContent = text;
		}
		return element;
	}

	private toggleExpanded(key: string): void {
		if (this.expanded.has(key)) {
			this.expanded.delete(key);
		} else {
			this.expanded.add(key);
		}
		// 展開で下へ伸びても、読んでいる位置から飛ばさない。
		this.stickToBottom = false;
		this.render();
	}

	private fullTextKey(rev: number): string {
		return `${this.session?.state?.epoch ?? ''}:${rev}`;
	}

	/** 切り詰められたメッセージの全文を取り寄せる（取り寄せ済みならそれを返す）。 */
	private fullTextOf(message: IParadisAgentChatMessage): string | undefined {
		if (!message.truncated) {
			return message.text;
		}
		const key = this.fullTextKey(message.rev);
		const known = this.fullTexts.get(key);
		if (known !== undefined) {
			return known;
		}
		const token = this.token;
		const epoch = this.session?.state?.epoch;
		if (token !== undefined && epoch !== undefined && !this.pendingFullTexts.has(key)) {
			this.pendingFullTexts.add(key);
			this.host.getFullText(token, epoch, message.rev).then(text => {
				this.pendingFullTexts.delete(key);
				if (text !== undefined && this.token === token) {
					this.fullTexts.set(key, text);
					this.renderScheduler.schedule();
				}
			}, () => this.pendingFullTexts.delete(key));
		}
		return undefined;
	}

	private renderTool(item: Extract<ParadisAgentChatItem, { kind: 'tool' }>, state: IParadisAgentChatState, store: DisposableStore): HTMLElement {
		const summary = paradisDescribeAgentChatTool(item.use, item.result);
		const element = $('.paradis-agent-chat-step.tool');
		element.classList.add(summary.state);
		const row = append(element, $('button.paradis-agent-chat-step-row')) as HTMLButtonElement;
		row.type = 'button';
		const expanded = this.expanded.has(item.key);
		row.setAttribute('aria-expanded', String(expanded));
		const stateIcon = summary.state === 'running' ? ThemeIcon.modify(Codicon.loading, 'spin') : summary.state === 'failed' ? Codicon.error : Codicon.check;
		const statusIcon = renderIcon(stateIcon);
		statusIcon.classList.add('paradis-agent-chat-step-status');
		row.append(statusIcon);
		append(row, $('span.paradis-agent-chat-step-label')).textContent = summary.label;
		if (summary.namespace !== undefined) {
			append(row, $('span.paradis-agent-chat-step-namespace')).textContent = summary.namespace;
		}
		if (summary.arg !== undefined && summary.arg.length > 0) {
			append(row, $('span.paradis-agent-chat-step-arg')).textContent = summary.arg;
		}
		const imageCount = item.result?.images?.length ?? 0;
		if (imageCount > 0) {
			append(row, $('span.paradis-agent-chat-step-meta')).textContent = localize('paradisAgentChat.imageCount', "画像 {0} 枚", imageCount);
		}
		if (summary.meta !== undefined) {
			append(row, $('span.paradis-agent-chat-step-meta')).textContent = summary.meta;
		}
		store.add(addDisposableListener(row, EventType.CLICK, () => this.toggleExpanded(item.key)));

		// 差分カードは畳まずに見せる（何を変えたかがチャットで一番知りたいことなので）。
		if (item.use !== undefined) {
			const diffSource = this.fullTextOfForDiff(item.use);
			if (diffSource !== undefined) {
				const diff = paradisAgentChatEditDiff(item.use.tool, diffSource);
				if (diff !== undefined) {
					element.appendChild(this.renderDiff(item.key, diff, store));
				}
			}
		}
		if (expanded) {
			const detail = append(element, $('.paradis-agent-chat-step-body'));
			if (item.use !== undefined) {
				append(detail, $('.paradis-agent-chat-step-caption')).textContent = localize('paradisAgentChat.input', "入力");
				this.appendLongText(detail, item.use, store);
			}
			if (item.result !== undefined) {
				append(detail, $('.paradis-agent-chat-step-caption')).textContent = localize('paradisAgentChat.output', "結果");
				this.appendLongText(detail, item.result, store);
				this.appendImages(detail, item.result, state, store);
			}
		}
		return element;
	}

	/** 差分を作るための入力の全文。ファイルを書き換えるツールで切り詰められていれば取り寄せる。 */
	private fullTextOfForDiff(use: IParadisAgentChatMessage): string | undefined {
		const tool = use.tool ?? '';
		const writes = tool === 'Edit' || tool === 'MultiEdit' || tool === 'Write' || tool === 'apply_patch' || use.text.includes('*** Begin Patch');
		if (!writes) {
			return undefined;
		}
		return this.fullTextOf(use);
	}

	private appendLongText(parent: HTMLElement, message: IParadisAgentChatMessage, store: DisposableStore): void {
		const full = message.truncated ? this.fullTexts.get(this.fullTextKey(message.rev)) : message.text;
		const text = full ?? message.text;
		const pre = append(parent, $('pre.paradis-agent-chat-step-detail'));
		pre.textContent = text.length > TOOL_DETAIL_PREVIEW_CHARS && full === undefined ? text.slice(0, TOOL_DETAIL_PREVIEW_CHARS) : text;
		if (message.truncated && full === undefined) {
			const more = append(parent, $('button.paradis-agent-chat-link')) as HTMLButtonElement;
			more.type = 'button';
			more.textContent = localize('paradisAgentChat.loadFull', "全文を読み込む");
			store.add(addDisposableListener(more, EventType.CLICK, () => {
				more.disabled = true;
				this.fullTextOf(message);
			}));
		}
	}

	private renderDiff(key: string, diff: IParadisAgentChatEditDiff, store: DisposableStore): HTMLElement {
		const card = $('.paradis-agent-chat-diff');
		const diffKey = `${key}:diff`;
		const showAll = this.expanded.has(diffKey);
		let shown = 0;
		let hidden = 0;
		for (const file of diff.files) {
			const header = append(card, $('.paradis-agent-chat-diff-header'));
			append(header, $('span.paradis-agent-chat-diff-path')).textContent = file.path;
			const added = file.rows.filter(row => row.kind === 'add').length;
			const removed = file.rows.filter(row => row.kind === 'del').length;
			append(header, $('span.paradis-agent-chat-diff-added')).textContent = `+${added}`;
			append(header, $('span.paradis-agent-chat-diff-removed')).textContent = `−${removed}`;
			const body = append(card, $('.paradis-agent-chat-diff-body'));
			for (const row of file.rows) {
				if (!showAll && shown >= DIFF_PREVIEW_ROWS) {
					hidden++;
					continue;
				}
				shown++;
				const line = append(body, $(`.paradis-agent-chat-diff-row.${row.kind}`));
				append(line, $('span.paradis-agent-chat-diff-sign')).textContent = row.kind === 'add' ? '+' : row.kind === 'del' ? '−' : row.kind === 'hunk' ? '' : ' ';
				append(line, $('span.paradis-agent-chat-diff-text')).textContent = row.text;
			}
		}
		if (hidden > 0 || showAll) {
			const toggle = append(card, $('button.paradis-agent-chat-link.paradis-agent-chat-diff-toggle')) as HTMLButtonElement;
			toggle.type = 'button';
			toggle.textContent = showAll ? localize('paradisAgentChat.diffCollapse', "たたむ") : localize('paradisAgentChat.diffMore', "残り {0} 行を表示", hidden);
			store.add(addDisposableListener(toggle, EventType.CLICK, () => this.toggleExpanded(diffKey)));
		}
		return card;
	}

	// ---- 画像 ----------------------------------------------------------------------------------

	private imageSignature(message: IParadisAgentChatMessage | undefined): string {
		if (message?.images === undefined) {
			return '';
		}
		return message.images.map(image => this.images.has(this.imageKey(message.rev, image.index)) ? '1' : '0').join('');
	}

	private imageKey(rev: number, index: number): string {
		return `${this.session?.state?.epoch ?? ''}:${rev}:${index}`;
	}

	private appendImages(parent: HTMLElement, message: IParadisAgentChatMessage, state: IParadisAgentChatState, store: DisposableStore): void {
		if (message.images === undefined || message.images.length === 0) {
			return;
		}
		const strip = append(parent, $('.paradis-agent-chat-images'));
		for (const image of message.images) {
			strip.appendChild(this.renderImage(message.rev, image, state, store));
		}
	}

	private renderImage(rev: number, image: IParadisAgentChatImage, state: IParadisAgentChatState, store: DisposableStore): HTMLElement {
		const frame = $('.paradis-agent-chat-image');
		if (image.oversize) {
			frame.textContent = localize('paradisAgentChat.imageTooLarge', "画像が大きすぎるため表示できません");
			return frame;
		}
		const key = this.imageKey(rev, image.index);
		const src = this.images.get(key);
		if (src === undefined) {
			frame.textContent = localize('paradisAgentChat.imageLoading', "画像を読み込んでいます…");
			const token = this.token;
			if (token !== undefined && !this.pendingImages.has(key)) {
				this.pendingImages.add(key);
				this.host.getImage(token, state.epoch, rev, image.index).then(data => {
					this.pendingImages.delete(key);
					if (this.token !== token) {
						return;
					}
					if (data === undefined) {
						frame.textContent = localize('paradisAgentChat.imageExpired', "この画像は保持期限を過ぎています");
						return;
					}
					if (this.images.size >= IMAGE_CACHE_LIMIT) {
						const oldest = this.images.keys().next().value;
						if (oldest !== undefined) {
							this.images.delete(oldest);
						}
					}
					this.images.set(key, `data:${data.mediaType};base64,${data.data}`);
					this.renderScheduler.schedule();
				}, () => this.pendingImages.delete(key));
			}
			return frame;
		}
		const img = append(frame, $('img')) as HTMLImageElement;
		img.src = src;
		img.alt = localize('paradisAgentChat.imageAlt', "エージェントの会話の画像");
		store.add(addDisposableListener(img, EventType.CLICK, () => frame.classList.toggle('zoomed')));
		return frame;
	}

	// ---- 質問のカード --------------------------------------------------------------------------

	private renderQuestions(item: Extract<ParadisAgentChatItem, { kind: 'questions' }>, state: IParadisAgentChatState, store: DisposableStore): HTMLElement {
		const card = $('.paradis-agent-chat-card.question');
		const pending = paradisIsPendingQuestionItem(item, state.interaction);
		// 回答に使う質問は、中継が「いま待っている」と返したもの（TUI の質問順）を正にする。
		const questions = pending && state.pendingQuestions !== undefined && state.pendingQuestions.length > 0 ? state.pendingQuestions : item.questions;
		const title = append(card, $('.paradis-agent-chat-card-title'));
		title.append(renderIcon(Codicon.question), $('span', undefined, pending
			? localize('paradisAgentChat.questionPending', "エージェントが質問しています")
			: item.answered
				? localize('paradisAgentChat.questionAnswered', "質問（回答済み）")
				: localize('paradisAgentChat.question', "質問")));
		if (!pending) {
			for (const question of questions) {
				const block = append(card, $('.paradis-agent-chat-question'));
				if (question.header !== undefined) {
					append(block, $('span.paradis-agent-chat-question-header')).textContent = question.header;
				}
				append(block, $('.paradis-agent-chat-question-text')).textContent = question.text;
				if (question.options !== undefined) {
					const options = append(block, $('.paradis-agent-chat-question-options.readonly'));
					for (const option of question.options) {
						append(options, $('span.paradis-agent-chat-chip')).textContent = option.label;
					}
				}
			}
			if (item.answer !== undefined) {
				append(card, $('.paradis-agent-chat-card-answer')).textContent = item.answer;
			}
			return card;
		}
		let draft = this.questionDrafts.get(item.group);
		if (draft === undefined || draft.answers.length !== questions.length) {
			draft = { step: 0, answers: questions.map(() => undefined), multi: new Map(), other: new Map(), sending: false, sent: false };
			this.questionDrafts.set(item.group, draft);
		}
		const currentDraft = draft;
		if (questions.length > 1) {
			const steps = append(card, $('.paradis-agent-chat-question-steps'));
			questions.forEach((question, index) => {
				const step = append(steps, $('button.paradis-agent-chat-question-step')) as HTMLButtonElement;
				step.type = 'button';
				step.classList.toggle('active', index === currentDraft.step);
				step.classList.toggle('done', currentDraft.answers[index] !== undefined);
				step.textContent = question.header ?? String(index + 1);
				store.add(addDisposableListener(step, EventType.CLICK, () => {
					currentDraft.step = index;
					this.rerenderQuestionCard();
				}));
			});
		}
		const index = Math.min(currentDraft.step, questions.length - 1);
		const question = questions[index];
		const block = append(card, $('.paradis-agent-chat-question'));
		if (question.header !== undefined && questions.length === 1) {
			append(block, $('span.paradis-agent-chat-question-header')).textContent = question.header;
		}
		append(block, $('.paradis-agent-chat-question-text')).textContent = question.text;
		const optionCount = question.options?.length ?? 0;
		const options = append(block, $('.paradis-agent-chat-question-options'));
		const multiSelect = question.multiSelect === true;
		const selected = currentDraft.multi.get(index) ?? new Set<number>();
		(question.options ?? []).forEach((option, optionIndex) => {
			const button = append(options, $('button.paradis-agent-chat-option')) as HTMLButtonElement;
			button.type = 'button';
			button.disabled = currentDraft.sending || currentDraft.sent;
			const chosen = multiSelect ? selected.has(optionIndex) : (currentDraft.answers[index]?.kind === 'option' && (currentDraft.answers[index] as { index: number }).index === optionIndex);
			button.classList.toggle('selected', chosen);
			if (multiSelect) {
				button.append(renderIcon(chosen ? Codicon.check : Codicon.circleLargeOutline));
			}
			append(button, $('span.paradis-agent-chat-option-label')).textContent = `${optionIndex + 1}. ${option.label}`;
			if (option.description !== undefined) {
				append(button, $('span.paradis-agent-chat-option-description')).textContent = option.description;
			}
			store.add(addDisposableListener(button, EventType.CLICK, () => {
				if (multiSelect) {
					const next = new Set(selected);
					if (next.has(optionIndex)) {
						next.delete(optionIndex);
					} else {
						next.add(optionIndex);
					}
					currentDraft.multi.set(index, next);
					currentDraft.answers[index] = next.size > 0 ? { kind: 'multi', indices: [...next] } : undefined;
					this.rerenderQuestionCard();
					return;
				}
				currentDraft.answers[index] = { kind: 'option', index: optionIndex };
				// 1問だけで単一選択なら、TUI と同じく選んだ時点で送る。
				if (questions.length === 1) {
					this.submitQuestions(item.group, questions.length, currentDraft);
					return;
				}
				currentDraft.step = Math.min(index + 1, questions.length - 1);
				this.rerenderQuestionCard();
			}));
		});
		// 自由入力（TUI の「Other」）。
		const otherRow = append(block, $('.paradis-agent-chat-question-other'));
		const otherInput = append(otherRow, $('input.paradis-agent-chat-other-input')) as HTMLInputElement;
		otherInput.type = 'text';
		otherInput.placeholder = localize('paradisAgentChat.otherPlaceholder', "その他（自由に入力）");
		otherInput.value = currentDraft.other.get(index) ?? '';
		otherInput.disabled = currentDraft.sending || currentDraft.sent;
		const otherComposing = { value: false };
		store.add(addDisposableListener(otherInput, 'compositionstart', () => { otherComposing.value = true; }));
		store.add(addDisposableListener(otherInput, 'compositionend', () => { otherComposing.value = false; }));
		const submit: { button?: HTMLButtonElement } = {};
		const isReady = () => currentDraft.answers.every(answer => answer !== undefined);
		const applyOther = () => {
			const text = otherInput.value;
			currentDraft.other.set(index, text);
			if (text.trim().length > 0) {
				currentDraft.answers[index] = { kind: 'text', optionCount, text };
			} else if (currentDraft.answers[index]?.kind === 'text') {
				currentDraft.answers[index] = undefined;
			}
			// 打つたびにカードを作り直さず、送るボタンの押せる状態だけを合わせる。
			if (submit.button !== undefined) {
				submit.button.disabled = !isReady() || currentDraft.sending || currentDraft.sent;
			}
		};
		store.add(addDisposableListener(otherInput, EventType.INPUT, applyOther));
		store.add(addDisposableListener(otherInput, EventType.KEY_DOWN, (e: KeyboardEvent) => {
			if (e.key === 'Enter' && !otherComposing.value && !e.isComposing && e.keyCode !== 229) {
				e.preventDefault();
				e.stopPropagation();
				applyOther();
				if (currentDraft.answers[index] !== undefined) {
					if (index < questions.length - 1) {
						currentDraft.step = index + 1;
						this.rerenderQuestionCard();
					} else {
						this.submitQuestions(item.group, questions.length, currentDraft);
					}
				}
			}
		}));

		const footer = append(card, $('.paradis-agent-chat-card-footer'));
		const submitButton = submit.button = append(footer, $('button.paradis-agent-chat-primary')) as HTMLButtonElement;
		submitButton.type = 'button';
		submitButton.disabled = !isReady() || currentDraft.sending || currentDraft.sent;
		submitButton.textContent = currentDraft.sending
			? localize('paradisAgentChat.sending', "送っています…")
			: currentDraft.sent
				? localize('paradisAgentChat.sent', "送りました")
				: localize('paradisAgentChat.submitAnswers', "回答を送る");
		store.add(addDisposableListener(submitButton, EventType.CLICK, () => this.submitQuestions(item.group, questions.length, currentDraft)));
		append(footer, $('span.paradis-agent-chat-card-note')).textContent = currentDraft.error ?? (currentDraft.sent
			? localize('paradisAgentChat.sentNote', "ターミナルに反映されるのを待っています")
			: localize('paradisAgentChat.answerInTerminalNote', "ターミナル側で答えた場合も自動的に閉じます"));
		footer.classList.toggle('error', currentDraft.error !== undefined);
		return card;
	}

	private rerenderQuestionCard(): void {
		this.stickToBottom = this.isAtBottom();
		this.render();
	}

	private submitQuestions(group: string, questionCount: number, draft: IQuestionDraft): void {
		const instanceId = this.instanceId;
		const token = this.token;
		if (instanceId === undefined || token === undefined || draft.sending || draft.sent || draft.answers.length !== questionCount) {
			return;
		}
		const answers = draft.answers.filter((answer): answer is ParadisAgentQuestionAnswer => answer !== undefined);
		if (answers.length !== questionCount) {
			return;
		}
		draft.sending = true;
		draft.error = undefined;
		this.rerenderQuestionCard();
		this.host.answerQuestions(instanceId, token, group, answers).then(error => {
			draft.sending = false;
			draft.sent = error === undefined;
			draft.error = error;
			this.rerenderQuestionCard();
			void this.session?.refresh();
		});
	}

	// ---- 許可の確認のカード ----------------------------------------------------------------------

	private renderApproval(message: IParadisAgentChatMessage, state: IParadisAgentChatState, store: DisposableStore): HTMLElement {
		const interaction = state.interaction;
		const pending = interaction?.kind === 'approval' && interaction.id === message.toolUseId;
		if (!pending) {
			const element = $('.paradis-agent-chat-step.approval-done');
			const row = append(element, $('.paradis-agent-chat-step-row.static'));
			row.append(renderIcon(Codicon.shield), $('span.paradis-agent-chat-step-label', undefined, localize('paradisAgentChat.approvalAsked', "許可の確認")));
			append(row, $('span.paradis-agent-chat-step-arg')).textContent = message.text.replace(/\s+/g, ' ');
			return element;
		}
		return this.renderApprovalCard(interaction, message.text, store);
	}

	private renderApprovalCard(interaction: Extract<IParadisAgentInteraction, { kind: 'approval' }>, detail: string | undefined, store: DisposableStore): HTMLElement {
		const card = $('.paradis-agent-chat-card.approval');
		const title = append(card, $('.paradis-agent-chat-card-title'));
		const tool = detail !== undefined ? /^([A-Za-z_][\w.-]*): /.exec(detail)?.[1] : undefined;
		title.append(renderIcon(Codicon.shield), $('span', undefined, tool !== undefined
			? localize('paradisAgentChat.approvalTitleTool', "{0} の実行を許可しますか", tool)
			: interaction.title ?? localize('paradisAgentChat.approvalTitle', "操作を許可しますか")));
		const body = tool !== undefined && detail !== undefined ? detail.slice(tool.length + 2) : detail ?? interaction.detail;
		if (body !== undefined && body.length > 0) {
			append(card, $('pre.paradis-agent-chat-card-detail')).textContent = body;
		}
		const approvalState = this.approvalStates.get(interaction.id);
		const footer = append(card, $('.paradis-agent-chat-card-footer'));
		const choices = interaction.choices ?? [];
		if (choices.length === 0) {
			// 中身を同期できなかった Codex の承認。ここからは答えられないので、ターミナルへ案内する。
			const back = append(footer, $('button.paradis-agent-chat-primary')) as HTMLButtonElement;
			back.type = 'button';
			back.textContent = localize('paradisAgentChat.answerInTerminal', "ターミナルで答える");
			store.add(addDisposableListener(back, EventType.CLICK, () => this._onDidRequestTerminal.fire()));
			return card;
		}
		for (const choice of choices) {
			const button = append(footer, $(choice.tone === 'approve' ? 'button.paradis-agent-chat-primary' : 'button.paradis-agent-chat-secondary')) as HTMLButtonElement;
			button.type = 'button';
			button.textContent = choice.label;
			button.disabled = approvalState?.sending === true || approvalState?.sent === true;
			store.add(addDisposableListener(button, EventType.CLICK, () => this.submitApproval(interaction.id, choice.id)));
		}
		const note = append(footer, $('span.paradis-agent-chat-card-note'));
		note.textContent = approvalState?.error ?? (approvalState?.sending
			? localize('paradisAgentChat.sending', "送っています…")
			: approvalState?.sent
				? localize('paradisAgentChat.sentNote', "ターミナルに反映されるのを待っています")
				: localize('paradisAgentChat.answerInTerminalNote', "ターミナル側で答えた場合も自動的に閉じます"));
		footer.classList.toggle('error', approvalState?.error !== undefined);
		return card;
	}

	private submitApproval(interactionId: string, choiceId: string): void {
		const instanceId = this.instanceId;
		const token = this.token;
		if (instanceId === undefined || token === undefined) {
			return;
		}
		const previous = this.approvalStates.get(interactionId);
		if (previous?.sending || previous?.sent) {
			return;
		}
		this.approvalStates.set(interactionId, { sending: true });
		this.rerenderQuestionCard();
		this.host.answerApproval(instanceId, token, interactionId, choiceId).then(error => {
			// 送れたら、TUI が消費して承認が消えるまで押せないままにする（押し直した `1`+Enter が入力欄へ流れるため）。
			this.approvalStates.set(interactionId, error !== undefined ? { sending: false, error } : { sending: false, sent: true });
			this.rerenderQuestionCard();
			void this.session?.refresh();
		});
	}

	/** 会話の中にカードが無い承認（中身を同期できなかった Codex の承認）を最下部に出す。 */
	private renderFallbackApproval(state: IParadisAgentChatState | undefined): void {
		const interaction = state?.interaction;
		const hasCard = interaction?.kind === 'approval' && state!.messages.some(message => message.tool === 'approval_request' && message.toolUseId === interaction.id);
		const signature = interaction?.kind === 'approval' && !hasCard ? JSON.stringify([interaction, this.approvalStates.get(interaction.id)]) : '';
		if (this.fallbackCard.dataset.signature === signature) {
			return;
		}
		this.fallbackCard.dataset.signature = signature;
		this.fallbackStore.clear();
		clearNode(this.fallbackCard);
		if (interaction?.kind === 'approval' && !hasCard) {
			this.fallbackCard.appendChild(this.renderApprovalCard(interaction, paradisIsCodexDaemonApprovalInteraction(interaction.id) ? interaction.detail : undefined, this.fallbackStore));
		}
	}

	// ---- 生成中・実行中の様子 ----------------------------------------------------------------------

	private renderLive(state: IParadisAgentChatState | undefined): void {
		const live = state?.live ?? null;
		const signature = live === null ? '' : JSON.stringify([live.phase, live.tool, live.detail, live.text, live.startedAt]);
		if (signature === this.lastLiveSignature) {
			this.updateLiveClock();
			return;
		}
		this.lastLiveSignature = signature;
		this.liveMarkdown.clear();
		this.liveClock = undefined;
		clearNode(this.liveElement);
		if (live === null) {
			return;
		}
		const bubble = append(this.liveElement, $('.paradis-agent-chat-live'));
		bubble.dataset.phase = live.phase;
		if (live.phase === 'message' && live.text !== undefined && live.text.length > 0) {
			const body = append(bubble, $('.paradis-agent-chat-markdown'));
			const rendered = this.markdownRenderer.render(new MarkdownString(live.text, { isTrusted: false, supportThemeIcons: false, supportHtml: false }), { fillInIncompleteTokens: true });
			this.liveMarkdown.value = rendered;
			body.appendChild(rendered.element);
			return;
		}
		const line = append(bubble, $('.paradis-agent-chat-live-line'));
		const spinner = renderIcon(ThemeIcon.modify(Codicon.loading, 'spin'));
		line.append(spinner, $('span.paradis-agent-chat-live-label', undefined, this.liveLabel(live)));
		this.liveClock = append(line, $('span.paradis-agent-chat-live-clock'));
		if (live.detail !== undefined && live.phase !== 'permission') {
			append(bubble, $('.paradis-agent-chat-live-detail')).textContent = live.detail;
		}
		this.updateLiveClock();
	}

	private liveLabel(live: IParadisAgentLiveState): string {
		switch (live.phase) {
			case 'tool':
				return live.tool !== undefined
					? localize('paradisAgentChat.liveTool', "{0} を実行しています", live.tool)
					: localize('paradisAgentChat.liveToolUnknown', "ツールを実行しています");
			case 'permission':
				return localize('paradisAgentChat.livePermission', "許可を待っています");
			case 'message':
				return localize('paradisAgentChat.liveMessage', "返答を書いています");
			default:
				return localize('paradisAgentChat.liveThinking', "考えています");
		}
	}

	private updateLiveClock(): void {
		const live = this.session?.state?.live;
		const clock = this.liveClock;
		if (clock === undefined || live === null || live === undefined) {
			return;
		}
		const seconds = live.elapsedSeconds !== undefined && live.source !== 'hook'
			? live.elapsedSeconds + Math.max(0, Math.round((Date.now() - live.updatedAt) / 1000))
			: Math.max(0, Math.round((Date.now() - live.startedAt) / 1000));
		clock.textContent = seconds < 60
			? localize('paradisAgentChat.clockSeconds', "{0}秒", seconds)
			: localize('paradisAgentChat.clockMinutes', "{0}分{1}秒", Math.floor(seconds / 60), String(seconds % 60).padStart(2, '0'));
	}

	// ---- 送信 ----------------------------------------------------------------------------------

	private submit(text: string): void {
		const instanceId = this.instanceId;
		const token = this.token;
		if (instanceId === undefined || token === undefined) {
			return;
		}
		this.composer.showNotice(undefined);
		this.composer.setSending(true);
		this.host.sendMessage(instanceId, token, text).then(error => {
			this.composer.setSending(false);
			if (error !== undefined) {
				this.composer.showNotice(error);
				return;
			}
			if (this.token === token) {
				this.composer.clearAfterSend();
			}
			this.stickToBottom = true;
			void this.session?.refresh();
		});
	}
}
