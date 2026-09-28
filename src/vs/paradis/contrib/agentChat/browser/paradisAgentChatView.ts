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

import { $, addDisposableListener, append, clearNode, EventType, getWindow, isHTMLInputElement, isHTMLTextAreaElement } from '../../../../base/browser/dom.js';
import { StandardMouseEvent } from '../../../../base/browser/mouseEvent.js';
import { DataTransfers } from '../../../../base/browser/dnd.js';
import { renderIcon } from '../../../../base/browser/ui/iconLabel/iconLabels.js';
import { IntervalTimer, RunOnceScheduler } from '../../../../base/common/async.js';
import { Codicon } from '../../../../base/common/codicons.js';
import { Emitter, Event } from '../../../../base/common/event.js';
import { IAction, toAction } from '../../../../base/common/actions.js';
import { MarkdownString } from '../../../../base/common/htmlContent.js';
import { Schemas } from '../../../../base/common/network.js';
import { URI } from '../../../../base/common/uri.js';
import { Disposable, DisposableStore, IDisposable, MutableDisposable, toDisposable } from '../../../../base/common/lifecycle.js';
import { ThemeIcon } from '../../../../base/common/themables.js';
import { localize } from '../../../../nls.js';
import { IClipboardService } from '../../../../platform/clipboard/common/clipboardService.js';
import { IContextMenuService } from '../../../../platform/contextview/browser/contextView.js';
import { CodeDataTransfers, containsDragType, getPathForFile, LocalSelectionTransfer } from '../../../../platform/dnd/browser/dnd.js';
import { IMarkdownRendererService } from '../../../../platform/markdown/browser/markdownRenderer.js';
import { DraggedEditorGroupIdentifier, DraggedEditorIdentifier } from '../../../../workbench/browser/dnd.js';
import { ParadisAgentQuestionAnswer } from '../../mobileRelay/common/paradisAgentQuestionKeys.js';
import { IParadisAgentChatImage, IParadisAgentChatImageData, IParadisAgentChatMessage, IParadisAgentInteraction, IParadisAgentLiveState, paradisIsCodexDaemonApprovalInteraction } from '../common/paradisAgentChat.js';
import { paradisAgentChatImagesToLinks } from '../common/paradisAgentChatMarkdown.js';
import { IParadisAgentChatState } from '../common/paradisAgentChatState.js';
import { IParadisAgentChatEditDiff, paradisAgentChatEditDiff, paradisBuildAgentChatItems, paradisPendingCodexQuestion, paradisDescribeAgentChatTool, paradisGroupAgentChatItems, paradisIsFileWriteTool, paradisIsPendingApprovalItem, paradisIsPendingQuestionItem, paradisSummarizeAgentChatGroup, ParadisAgentChatEntry, ParadisAgentChatItem } from '../common/paradisAgentChatTimeline.js';
import { IParadisAgentChatComposerHost, ParadisAgentChatComposer } from './paradisAgentChatComposer.js';
import { ParadisAgentChatSession } from './paradisAgentChatSession.js';

/** チャット表示が呼び出し側（electron-browser の contribution）へ求めるもの。 */
export interface IParadisAgentChatViewHost extends IParadisAgentChatComposerHost {
	/** ペインの会話の写し（同じトークンなら同じものを返す）。 */
	session(token: string): ParadisAgentChatSession;
	sendMessage(instanceId: number, token: string, text: string): Promise<string | undefined>;
	answerQuestions(instanceId: number, token: string, group: string, answers: readonly ParadisAgentQuestionAnswer[]): Promise<string | undefined>;
	answerApproval(instanceId: number, token: string, interactionId: string, choiceId: string): Promise<string | undefined>;
	showTerminal(instanceId: number): void;
	getFullText(token: string, epoch: string, rev: number): Promise<string | undefined>;
	getImage(token: string, epoch: string, rev: number, index: number): Promise<IParadisAgentChatImageData | undefined>;
	/** ⌘⇧J の表示名（キー割り当てを変えていればその表示）。 */
	getToggleKeybindingLabel(): string | undefined;
	/** ペインごとのカードの状態（同じペインなら同じものを返す）。 */
	cardStates(token: string): IParadisAgentChatCardStates;
	readonly onDidChangeSettings: Event<void>;
}

/** 差分カードで最初から見せる行数。超えた分は「すべて表示」で開く。 */
const DIFF_PREVIEW_ROWS = 14;
/** ツールの出力を展開したときに見せる上限（文字数）。長い出力は全文の取り寄せで読む。 */
const TOOL_DETAIL_PREVIEW_CHARS = 4000;
/** 最下部にいるとみなす余白。この範囲にいれば、新しい発言で最下部へ追従する。 */
const STICK_TO_BOTTOM_THRESHOLD = 48;
/** 取り寄せた画像を覚えておく上限（base64 の文字数の合計。同じ画像を描き直すたびに取りに行かない）。 */
const IMAGE_CACHE_CHARS = 24 * 1024 * 1024;
/** 取り寄せた全文を覚えておく上限（中継の保持と同じ件数・大きさ）。 */
const FULL_TEXT_CACHE_ENTRIES = 40;
const FULL_TEXT_CACHE_CHARS = 2 * 1024 * 1024;
/** 差分の全文を自動で取り寄せるのは、最後からこの数の行まで。 */
const RECENT_ITEM_COUNT = 20;

interface IRenderedItem {
	readonly element: HTMLElement;
	readonly signature: string;
	readonly store: DisposableStore;
}

/** 質問カードの入力途中の状態（描き直しても、表示を切り替えても失わないよう、呼び出し側に持たせる）。 */
export interface IParadisAgentChatQuestionDraft {
	step: number;
	readonly answers: (ParadisAgentQuestionAnswer | undefined)[];
	readonly multi: Map<number, Set<number>>;
	readonly other: Map<number, string>;
	sending: boolean;
	/** 送り終えた。TUI が消費して質問が消えるまで、もう一度は送らせない。 */
	sent: boolean;
	error?: string;
}

/** 許可の確認カードの、送っている・送った・送れなかった状態。 */
export interface IParadisAgentChatApprovalCardState {
	readonly sending: boolean;
	readonly sent?: boolean;
	readonly error?: string;
}

/** ペインごとのカードの状態。表示の切り替え・タブの切り替えで消えないよう、呼び出し側が持つ。 */
export interface IParadisAgentChatCardStates {
	readonly questions: Map<string, IParadisAgentChatQuestionDraft>;
	readonly approvals: Map<string, IParadisAgentChatApprovalCardState>;
	/** 入力欄から送っている最中か。 */
	readonly composer: { sending: boolean };
	/** 読んでいた位置（別のペインへ切り替えて戻ったときに戻す）。 */
	scroll?: { readonly top: number; readonly stick: boolean };
	/** 開いているツールのまとまり（`<epoch>:<まとまりの鍵>`）。既定は畳む。 */
	readonly openGroups: Set<string>;
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
	/** 描いた単位の、開閉の行（作り直したときにフォーカスを移す先）。 */
	private readonly toggleRows = new WeakMap<HTMLElement, HTMLButtonElement>();
	private readonly expanded = new Set<string>();
	private readonly fullTexts = new Map<string, string>();
	private fullTextChars = 0;
	private readonly pendingFullTexts = new Set<string>();
	/** 取り寄せたが保持期限を過ぎていた全文。 */
	private readonly missingFullTexts = new Set<string>();
	/** 画面の最後の方の行（差分の全文を自動で取り寄せる範囲）。 */
	private recentKeys = new Set<string>();
	/** 取り寄せた画像（data URI）。合計の文字数に上限を置き、古いものから捨てる。 */
	private readonly images = new Map<string, string>();
	private imageChars = 0;
	/** 一度取り寄せ終えた画像（捨てた後に自動で取り直して、取り直すたびに別の画像を捨て続けないため）。 */
	private readonly settledImages = new Set<string>();
	private readonly pendingImages = new Set<string>();
	private readonly emptyCardStates: IParadisAgentChatCardStates = { questions: new Map(), approvals: new Map(), composer: { sending: false }, openGroups: new Set() };
	private liveClock: HTMLElement | undefined;
	private readonly liveMarkdown = this._register(new MutableDisposable<IDisposable>());
	private readonly fallbackStore = this._register(new DisposableStore());
	private lastLiveSignature = '';
	private renderedEpoch: string | undefined;
	/** 送れなかった理由を出したときの会話の状態。状態が変わったら理由を消す。 */
	private errorStateSignature: string | undefined;
	private stickToBottom = true;
	private lastScrollTop = 0;
	private visible = false;
	private readonly renderScheduler = this._register(new RunOnceScheduler(() => this.render(), 0));
	private readonly ticker = this._register(new IntervalTimer());

	constructor(
		container: HTMLElement,
		private readonly host: IParadisAgentChatViewHost,
		@IMarkdownRendererService private readonly markdownRenderer: IMarkdownRendererService,
		@IContextMenuService private readonly contextMenuService: IContextMenuService,
		@IClipboardService private readonly clipboardService: IClipboardService,
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
		// 本文をクリックしたときもエディタグループへフォーカスが移るよう、フォーカスを受けられるようにする
		// （受けられないと、分割した隣のグループのシェルにフォーカスが残り、打った文字がそちらへ入る）。
		this.element.tabIndex = -1;
		// 下のターミナルのエディタは、エディタ全体の mousedown / contextmenu でターミナルのクリック動作
		// （右クリックでの貼り付け・ターミナルのメニュー）を行う。チャットの上の操作をそこへ流さない。
		for (const type of [EventType.MOUSE_DOWN, EventType.MOUSE_UP]) {
			this._register(addDisposableListener(this.element, type, e => e.stopPropagation()));
		}
		this._register(addDisposableListener(this.element, EventType.CONTEXT_MENU, e => this.showContextMenu(e)));
		// ターミナルはドロップされたファイルのパスを TUI へ入れる。見えていない TUI に入らないよう
		// 止めて、チャットの入力欄へ入れる。
		// ファイルのドラッグだけを受ける。エディタのタブ・グループ・ターミナルのタブのドラッグは親へ流し、
		// エディタの分割や移動をそのまま使えるようにする。
		for (const type of [EventType.DRAG_ENTER, EventType.DRAG_OVER, EventType.DRAG_LEAVE]) {
			this._register(addDisposableListener(this.element, type, (e: DragEvent) => {
				if (!paradisIsFileDrag(e)) {
					return;
				}
				e.stopPropagation();
				e.preventDefault();
				if (e.dataTransfer) {
					e.dataTransfer.dropEffect = 'copy';
				}
			}));
		}
		this._register(addDisposableListener(this.element, EventType.DROP, (e: DragEvent) => this.onDrop(e)));

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
			// 隠れている間（display: none）に起きるスクロール位置の巻き戻しは、読んでいる位置の変化ではない。
			if (!this.visible || this.scroller.clientHeight === 0) {
				return;
			}
			this.stickToBottom = this.isAtBottom();
			this.lastScrollTop = this.scroller.scrollTop;
			this.jumpButton.classList.toggle('visible', !this.stickToBottom);
		}));
		// 分割やタブの切り替えで高さが変わっても、読んでいた位置に留まる（最下部なら最下部、途中ならその位置。
		// 隠れている間にスクロール位置が 0 へ巻き戻るので、そのままだと先頭へ飛ぶ）。
		const resizeObserver = new (getWindow(this.element).ResizeObserver)(() => {
			if (!this.visible || this.scroller.clientHeight === 0) {
				return;
			}
			if (this.stickToBottom) {
				this.scrollToBottom();
			} else if (this.scroller.scrollTop === 0 && this.lastScrollTop > 0) {
				this.scroller.scrollTop = this.lastScrollTop;
			}
		});
		resizeObserver.observe(this.scroller);
		this._register(toDisposable(() => resizeObserver.disconnect()));

		this.composer = this._register(new ParadisAgentChatComposer(this.element, host));
		this._register(this.composer.onDidSubmit(text => this.submit(text)));
		this._register(host.onDidChangeSettings(() => {
			this.composer.refreshSettings();
			this.updateBackLabel();
		}));
		this.updateBackLabel();
	}

	private get questionDrafts(): Map<string, IParadisAgentChatQuestionDraft> {
		return this.token !== undefined ? this.host.cardStates(this.token).questions : this.emptyCardStates.questions;
	}

	private get approvalStates(): Map<string, IParadisAgentChatApprovalCardState> {
		return this.token !== undefined ? this.host.cardStates(this.token).approvals : this.emptyCardStates.approvals;
	}

	private get openGroups(): Set<string> {
		return this.token !== undefined ? this.host.cardStates(this.token).openGroups : this.emptyCardStates.openGroups;
	}

	/**
	 * 右クリックのメニュー。ターミナルのメニューへは流さず、入力欄なら切り取り・コピー・貼り付け、
	 * 本文を選んでいればコピーを出す。
	 */
	private showContextMenu(e: MouseEvent): void {
		e.stopPropagation();
		e.preventDefault();
		const target = e.target;
		const input = isHTMLTextAreaElement(target) || (isHTMLInputElement(target) && target.type === 'text') ? target : undefined;
		const selection = this.element.ownerDocument.getSelection()?.toString() ?? '';
		const actions: IAction[] = [];
		if (input !== undefined) {
			const selected = input.value.slice(input.selectionStart ?? 0, input.selectionEnd ?? 0);
			const replaceSelection = (text: string) => {
				input.setRangeText(text, input.selectionStart ?? 0, input.selectionEnd ?? 0, 'end');
				input.dispatchEvent(new InputEvent('input'));
			};
			actions.push(
				toAction({ id: 'paradisAgentChat.cut', label: localize('paradisAgentChat.cut', "切り取り"), enabled: selected.length > 0 && !input.disabled, run: async () => { await this.clipboardService.writeText(selected); replaceSelection(''); } }),
				toAction({ id: 'paradisAgentChat.copy', label: localize('paradisAgentChat.copy', "コピー"), enabled: selected.length > 0, run: () => this.clipboardService.writeText(selected) }),
				toAction({ id: 'paradisAgentChat.paste', label: localize('paradisAgentChat.paste', "貼り付け"), enabled: !input.disabled, run: async () => { replaceSelection(await this.clipboardService.readText()); input.focus(); } }),
			);
		} else if (selection.length > 0) {
			actions.push(toAction({ id: 'paradisAgentChat.copy', label: localize('paradisAgentChat.copy', "コピー"), run: () => this.clipboardService.writeText(selection) }));
		}
		if (actions.length === 0) {
			return;
		}
		const anchor = new StandardMouseEvent(getWindow(this.element), e);
		this.contextMenuService.showContextMenu({ getAnchor: () => anchor, getActions: () => actions });
	}

	/** ドロップされたファイルのパスを入力欄へ入れる（空白を含むものは引用符で囲む）。 */
	private onDrop(e: DragEvent): void {
		if (!paradisIsFileDrag(e)) {
			return;
		}
		e.stopPropagation();
		e.preventDefault();
		const data = e.dataTransfer;
		if (!data || !this.visible) {
			return;
		}
		const paths: string[] = [];
		try {
			const resources = data.getData(DataTransfers.RESOURCES);
			if (resources) {
				for (const value of JSON.parse(resources) as string[]) {
					const uri = URI.parse(value);
					paths.push(uri.scheme === Schemas.file ? uri.fsPath : uri.toString());
				}
			}
			const codeFiles = paths.length === 0 ? data.getData(CodeDataTransfers.FILES) : '';
			if (codeFiles) {
				paths.push(...(JSON.parse(codeFiles) as string[]));
			}
		} catch {
			// 形の違うデータは無視する
		}
		if (paths.length === 0) {
			for (const file of data.files) {
				const path = getPathForFile(file);
				if (path) {
					paths.push(path);
				}
			}
		}
		if (paths.length > 0) {
			this.composer.insertText(paths.map(path => /\s/.test(path) ? `"${path}"` : path).join(' '));
		}
	}

	/** 表示する対象のペインを差し替える。undefined なら隠す（ターミナルが見える）。 */
	setTarget(instanceId: number | undefined, token: string | undefined): void {
		const visible = instanceId !== undefined && token !== undefined;
		let restoreScrollTop: number | undefined;
		if (this.token !== token) {
			// 読んでいた位置をペインごとに覚え、戻ってきたら同じ位置から見せる（最下部へ飛ばさない）。
			if (this.token !== undefined) {
				this.host.cardStates(this.token).scroll = { top: this.visible && this.scroller.clientHeight > 0 ? this.scroller.scrollTop : this.lastScrollTop, stick: this.stickToBottom };
			}
			this.resetRendered();
			this.token = token;
			this.session = token !== undefined ? this.host.session(token) : undefined;
			this.sessionListener.value = this.session?.onDidChange(() => this.renderScheduler.schedule());
			const saved = token !== undefined ? this.host.cardStates(token).scroll : undefined;
			this.stickToBottom = saved?.stick ?? true;
			this.lastScrollTop = saved?.top ?? 0;
			restoreScrollTop = saved !== undefined && !saved.stick ? saved.top : undefined;
		}
		this.instanceId = instanceId;
		this.composer.setToken(visible ? token : undefined);
		// 送っている途中のペインへ戻ったら、送り終わるまで送れないままにする（二重に送らないため）。
		this.composer.setSending(visible && token !== undefined && this.host.cardStates(token).composer.sending);
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
			if (restoreScrollTop !== undefined) {
				this.scroller.scrollTop = restoreScrollTop;
				this.jumpButton.classList.toggle('visible', !this.isAtBottom());
			}
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
		this.renderedEpoch = undefined;
		this.expanded.clear();
		this.fullTexts.clear();
		this.fullTextChars = 0;
		this.missingFullTexts.clear();
		this.images.clear();
		this.imageChars = 0;
		this.settledImages.clear();
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
		if (!this.visible || this.session === undefined || this._store.isDisposed) {
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
		// 質問は PostToolUse ですぐ消えるので対象にしない（先頭の打鍵が取りこぼされて質問が残っているときに、
		// 送った文の Enter が選択肢を確定するため）。承認も、送る直前に画面を確かめる（ParadisAgentChatInput）。
		const answeredHere = interaction?.kind === 'approval' && this.approvalStates.get(interaction.id)?.sent === true;
		const codexQuestion = state?.agent === 'codex' && paradisPendingCodexQuestion(state.messages) !== undefined;
		this.composer.setBlockedReason(state === undefined
			? localize('paradisAgentChat.blockedNoSession', "エージェントの会話が見つかりません")
			: state.agentExited
				? localize('paradisAgentChat.blockedExited', "エージェントは終了しました。ターミナルに戻って確かめてください")
				: codexQuestion
					? localize('paradisAgentChat.blockedCodexQuestion', "Codex が質問しています。ターミナルで答えてください")
					: answeredHere
						? undefined
						: state.interaction?.kind === 'question'
							? localize('paradisAgentChat.blockedQuestion', "質問に答えてから送ってください")
							: state.interaction?.kind === 'approval'
								? localize('paradisAgentChat.blockedApproval', "許可の確認に答えてから送ってください")
								: undefined);
		// 送れなかった理由は、会話の状態が変わったら消す（次に送るまで残ると、今も送れないように読める）。
		const stateSignature = state === undefined ? '' : `${state.epoch}:${state.rev}:${state.interaction?.id ?? ''}:${state.busy}`;
		if (this.errorStateSignature !== undefined && this.errorStateSignature !== stateSignature) {
			this.errorStateSignature = undefined;
			this.composer.clearError();
		}
		if (follow) {
			this.scrollToBottom();
		} else {
			// 展開などで伸びても scroll イベントは起きないので、「最新へ」の表示をここで合わせる。
			this.stickToBottom = this.isAtBottom();
			this.jumpButton.classList.toggle('visible', !this.stickToBottom);
		}
	}

	private renderHeader(state: IParadisAgentChatState | undefined): void {
		this.headerAgent.textContent = state === undefined ? '' : state.agent === 'codex' ? 'Codex' : 'Claude Code';
		const model = [state?.info?.model, state?.info?.effort].filter((part): part is string => part !== undefined && part.length > 0).join(' · ');
		this.headerModel.textContent = model;
		this.headerModel.style.display = model.length > 0 ? '' : 'none';
		let status = '';
		if (state?.interaction?.kind === 'question' || (state?.agent === 'codex' && paradisPendingCodexQuestion(state.messages) !== undefined)) {
			status = localize('paradisAgentChat.statusQuestion', "質問に答えるのを待っています");
		} else if (state?.interaction?.kind === 'approval') {
			status = localize('paradisAgentChat.statusApproval', "許可を待っています");
		} else if (state?.agentExited) {
			status = localize('paradisAgentChat.statusExited', "終了しました");
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
		// 読み取りが始め直された（同じタブで別の会話が始まった等）なら、前の会話の行を使い回さない
		// （行の鍵は rev なので、epoch をまたぐと別の会話の行と取り違える）。
		if (this.renderedEpoch !== state.epoch) {
			for (const rendered of this.rendered.values()) {
				rendered.store.dispose();
				rendered.element.remove();
			}
			this.rendered.clear();
			this.renderedEpoch = state.epoch;
		}
		const items = paradisBuildAgentChatItems(state.messages, state.interaction);
		this.recentKeys = new Set(items.slice(-RECENT_ITEM_COUNT).map(item => item.key));
		const seen = new Set<string>();
		let previous: HTMLElement = this.notice;
		const place = (key: string, signature: string, create: (store: DisposableStore) => HTMLElement) => {
			seen.add(key);
			let rendered = this.rendered.get(key);
			if (rendered === undefined || rendered.signature !== signature) {
				const store = new DisposableStore();
				const element = create(store);
				if (rendered !== undefined) {
					// 開閉の行にキーボードのフォーカスがあったら、作り直した行へ移す（Enter で開閉を続けられるように）。
					const previousRow = this.toggleRows.get(rendered.element);
					const refocus = previousRow !== undefined && previousRow === rendered.element.ownerDocument.activeElement;
					rendered.element.replaceWith(element);
					rendered.store.dispose();
					if (refocus) {
						this.toggleRows.get(element)?.focus();
					}
				}
				rendered = { element, signature, store };
				this.rendered.set(key, rendered);
			}
			if (previous.nextSibling !== rendered.element) {
				previous.after(rendered.element);
			}
			previous = rendered.element;
		};
		for (const entry of paradisGroupAgentChatItems(items, state.interaction, state.busy)) {
			if (entry.kind === 'item') {
				place(entry.item.key, this.itemSignature(entry.item, state.interaction, false), store => this.renderItem(entry.item, state, store));
				continue;
			}
			// 畳んだまとまりは見出しの1行だけを出す。作業中の会話の実行中のツールは、畳んでいても見出しの下に出す。
			const open = this.openGroups.has(this.groupStateKey(entry.key));
			place(entry.key, this.groupSignature(entry, open), store => this.renderGroup(entry, open, store));
			for (const item of entry.items) {
				if (open || entry.pinned.has(item.key)) {
					place(item.key, this.itemSignature(item, state.interaction, true), store => {
						const element = this.renderItem(item, state, store);
						element.classList.add('paradis-agent-chat-grouped');
						return element;
					});
				}
			}
		}
		for (const [key, rendered] of [...this.rendered]) {
			if (!seen.has(key)) {
				rendered.store.dispose();
				rendered.element.remove();
				this.rendered.delete(key);
			}
		}
	}

	/** 描き直しが要るかを決める指紋。`grouped` はまとまりの中に描くか（字下げが変わる）。 */
	private itemSignature(item: ParadisAgentChatItem, interaction: IParadisAgentInteraction | null, grouped: boolean): string {
		const signature = this.itemContentSignature(item, interaction);
		return grouped ? `g${signature}` : signature;
	}

	private itemContentSignature(item: ParadisAgentChatItem, interaction: IParadisAgentInteraction | null): string {
		const expanded = this.expanded.has(item.key);
		switch (item.kind) {
			case 'tool': {
				const key = item.use !== undefined ? this.fullTextKey(item.use.rev) : '';
				return JSON.stringify([item.kind, item.use?.rev, item.result?.rev, expanded, this.expanded.has(`${item.key}:diff`), this.expanded.has(`${item.key}:load`), this.recentKeys.has(item.key), this.fullTexts.has(key), this.missingFullTexts.has(key), this.pendingFullTexts.has(key), this.imageSignature(item.result)]);
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
				const rendered = store.add(this.renderMarkdown(item.message.text, false));
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

	/**
	 * エージェントの発言を Markdown として描く。外部の画像は読み込まない（プロンプトインジェクションで
	 * `![](https://.../?d=<秘密>)` を出力させると、チャットを開いただけで外へ送られるため）。upstream の
	 * チャットと同じく読み込みを禁じ、画像の書き方はリンクに書き換えて、押したときだけ開く。
	 */
	private renderMarkdown(text: string, streaming: boolean) {
		return this.markdownRenderer.render(new MarkdownString(paradisAgentChatImagesToLinks(text), { isTrusted: false, supportThemeIcons: false, supportHtml: false }), {
			...(streaming ? { fillInIncompleteTokens: true } : {}),
			sanitizerConfig: { replaceWithPlaintext: true, remoteImageIsAllowed: () => false },
		});
	}

	private renderCollapsible(key: string, icon: ThemeIcon, label: string, text: string, className: string, store: DisposableStore): HTMLElement {
		const element = $(`.paradis-agent-chat-step.${className}`);
		const row = append(element, $('button.paradis-agent-chat-step-row')) as HTMLButtonElement;
		row.type = 'button';
		const expanded = this.expanded.has(key);
		row.setAttribute('aria-expanded', String(expanded));
		this.toggleRows.set(element, row);
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

	// ---- ツールのまとまり ----------------------------------------------------------------------------

	/** 開いた状態を覚える鍵。まとまりの鍵は rev から作るので、会話が始め直されたら別のものとして扱う。 */
	private groupStateKey(key: string): string {
		return `${this.session?.state?.epoch ?? ''}:${key}`;
	}

	private groupSignature(entry: Extract<ParadisAgentChatEntry, { kind: 'group' }>, open: boolean): string {
		return JSON.stringify(['group', open, entry.items.map(item => item.kind === 'tool' ? `${item.key}:${item.result?.rev ?? ''}` : item.key)]);
	}

	/** まとまりの見出しの1行（押すと開閉する）。 */
	private renderGroup(entry: Extract<ParadisAgentChatEntry, { kind: 'group' }>, open: boolean, store: DisposableStore): HTMLElement {
		const summary = paradisSummarizeAgentChatGroup(entry.items);
		const element = $('.paradis-agent-chat-group');
		const row = append(element, $('button.paradis-agent-chat-step-row.paradis-agent-chat-group-row')) as HTMLButtonElement;
		row.type = 'button';
		row.setAttribute('aria-expanded', String(open));
		this.toggleRows.set(element, row);
		row.setAttribute('aria-label', localize('paradisAgentChat.groupAria', "ツールの実行 {0} 件（{1}）", summary.count, summary.names.join(', ')));
		row.append(renderIcon(open ? Codicon.chevronDown : Codicon.chevronRight));
		append(row, $('span.paradis-agent-chat-group-count')).textContent = localize('paradisAgentChat.groupCount', "{0}×", summary.count);
		append(row, $('span.paradis-agent-chat-group-names')).textContent = summary.names.join(', ');
		if (summary.fileChanges > 0) {
			const files = append(row, $('span.paradis-agent-chat-group-meta'));
			files.append(renderIcon(Codicon.edit), $('span', undefined, localize('paradisAgentChat.groupFileChanges', "ファイル変更 {0} 件", summary.fileChanges)));
		}
		if (summary.failed > 0) {
			const failed = append(row, $('span.paradis-agent-chat-group-meta.paradis-agent-chat-group-failed'));
			failed.append(renderIcon(Codicon.error), $('span', undefined, localize('paradisAgentChat.groupFailed', "失敗 {0} 件", summary.failed)));
		}
		store.add(addDisposableListener(row, EventType.CLICK, () => this.toggleGroup(entry.key)));
		// ツリーと同じく、→ で開き ← で畳む（Enter / Space はボタンとして開閉する）。
		store.add(addDisposableListener(row, EventType.KEY_DOWN, (e: KeyboardEvent) => {
			if ((e.key === 'ArrowRight' && !open) || (e.key === 'ArrowLeft' && open)) {
				e.preventDefault();
				e.stopPropagation();
				this.toggleGroup(entry.key);
			}
		}));
		return element;
	}

	private toggleGroup(key: string): void {
		const stateKey = this.groupStateKey(key);
		if (this.openGroups.has(stateKey)) {
			this.openGroups.delete(stateKey);
		} else {
			this.openGroups.add(stateKey);
		}
		// 開いて下へ伸びても、読んでいる位置から飛ばさない。
		this.stickToBottom = false;
		this.render();
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
	/** 取り寄せた全文を覚える。件数と合計の文字数に上限を置き、古いものから捨てる。 */
	private rememberFullText(key: string, text: string): void {
		this.fullTexts.delete(key);
		this.fullTexts.set(key, text);
		this.fullTextChars += text.length;
		while (this.fullTexts.size > FULL_TEXT_CACHE_ENTRIES || (this.fullTextChars > FULL_TEXT_CACHE_CHARS && this.fullTexts.size > 1)) {
			const [oldestKey, oldest] = this.fullTexts.entries().next().value!;
			this.fullTexts.delete(oldestKey);
			this.fullTextChars -= oldest.length;
		}
	}

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
		if (token !== undefined && epoch !== undefined && !this.pendingFullTexts.has(key) && !this.missingFullTexts.has(key)) {
			this.pendingFullTexts.add(key);
			this.host.getFullText(token, epoch, message.rev).then(text => {
				this.pendingFullTexts.delete(key);
				if (this.token !== token || this._store.isDisposed) {
					return;
				}
				if (text === undefined) {
					this.missingFullTexts.add(key);
				} else {
					this.rememberFullText(key, text);
				}
				this.renderScheduler.schedule();
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
		this.toggleRows.set(element, row);
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

		// 差分カードは、ツールの行の中では畳まずに見せる（何を変えたかがチャットで一番知りたいことなので）。
		// 行がまとまりに入っていれば、まとまりを開いたときに見える（見出しに「ファイル変更 N 件」と出す）。
		if (item.use !== undefined) {
			const use = item.use;
			if (paradisIsFileWriteTool(use)) {
				// 切り詰められた入力の全文は、最近の行か「差分を読み込む」を押した行だけ取り寄せる
				// （古い行まで一度に取りに行くと、長い会話を開いたときに IPC とメモリが膨らむ）。
				const diffSource = !use.truncated || this.recentKeys.has(item.key) || this.expanded.has(`${item.key}:load`) || this.fullTexts.has(this.fullTextKey(use.rev)) ? this.fullTextOf(use) : undefined;
				const diff = diffSource !== undefined ? paradisAgentChatEditDiff(use.tool, diffSource) : undefined;
				if (diff !== undefined) {
					element.appendChild(this.renderDiff(item.key, diff, store));
				} else if (use.truncated && diffSource === undefined) {
					const key = this.fullTextKey(use.rev);
					const more = append(element, $('button.paradis-agent-chat-link.paradis-agent-chat-diff-load')) as HTMLButtonElement;
					more.type = 'button';
					more.textContent = this.missingFullTexts.has(key)
						? localize('paradisAgentChat.fullTextExpired', "変更の全文は保持期限を過ぎています")
						: this.pendingFullTexts.has(key) ? localize('paradisAgentChat.diffLoading', "差分を読み込んでいます…") : localize('paradisAgentChat.diffLoad', "差分を読み込む");
					more.disabled = this.missingFullTexts.has(key) || this.pendingFullTexts.has(key);
					store.add(addDisposableListener(more, EventType.CLICK, () => {
						this.expanded.add(`${item.key}:load`);
						this.fullTextOf(use);
						this.rerenderQuestionCard();
					}));
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

	private appendLongText(parent: HTMLElement, message: IParadisAgentChatMessage, store: DisposableStore): void {
		const full = message.truncated ? this.fullTexts.get(this.fullTextKey(message.rev)) : message.text;
		const text = full ?? message.text;
		const pre = append(parent, $('pre.paradis-agent-chat-step-detail'));
		pre.textContent = text.length > TOOL_DETAIL_PREVIEW_CHARS && full === undefined ? text.slice(0, TOOL_DETAIL_PREVIEW_CHARS) : text;
		if (message.truncated && full === undefined) {
			const key = this.fullTextKey(message.rev);
			const more = append(parent, $('button.paradis-agent-chat-link')) as HTMLButtonElement;
			more.type = 'button';
			more.disabled = this.missingFullTexts.has(key);
			more.textContent = this.missingFullTexts.has(key)
				? localize('paradisAgentChat.fullTextExpiredOutput', "この出力の全文は保持期限を過ぎています")
				: localize('paradisAgentChat.loadFull', "全文を読み込む");
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
			// 末尾（ファイル名）が見えるよう右から省略する（direction: rtl）。LRM で挟んで、`/` などの記号が
			// 右から左の並びに引きずられて前後が入れ替わらないようにする。
			append(header, $('span.paradis-agent-chat-diff-path')).textContent = `\u200E${file.path}\u200E`;
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
		// 手元のキャッシュにあるかではなく「取り寄せ終えたか」で見る。キャッシュから捨てたときに描き直して
		// 取り直し、それがまた別の画像を捨てる、の繰り返しにしないため。
		return message.images.map(image => this.settledImages.has(this.imageKey(message.rev, image.index)) ? '1' : '0').join('');
	}

	private rememberImage(key: string, src: string): void {
		this.images.delete(key);
		this.images.set(key, src);
		this.imageChars += src.length;
		while (this.imageChars > IMAGE_CACHE_CHARS && this.images.size > 1) {
			const [oldestKey, oldest] = this.images.entries().next().value!;
			this.images.delete(oldestKey);
			this.imageChars -= oldest.length;
		}
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
			const token = this.token;
			const load = () => {
				if (token === undefined || this.pendingImages.has(key)) {
					return;
				}
				this.pendingImages.add(key);
				this.host.getImage(token, state.epoch, rev, image.index).then(data => {
					this.pendingImages.delete(key);
					if (this.token !== token || this._store.isDisposed) {
						return;
					}
					if (data === undefined) {
						frame.textContent = localize('paradisAgentChat.imageExpired', "この画像は保持期限を過ぎています");
						return;
					}
					this.rememberImage(key, `data:${data.mediaType};base64,${data.data}`);
					this.settledImages.add(key);
					this.renderScheduler.schedule();
				}, () => this.pendingImages.delete(key));
			};
			if (this.settledImages.has(key)) {
				// 一度読み込んだが、手元の上限で捨てた。押したときだけ読み込み直す。
				const reload = append(frame, $('button.paradis-agent-chat-link')) as HTMLButtonElement;
				reload.type = 'button';
				reload.textContent = localize('paradisAgentChat.imageReload', "画像を表示する");
				store.add(addDisposableListener(reload, EventType.CLICK, () => {
					this.settledImages.delete(key);
					reload.disabled = true;
					load();
				}));
				return frame;
			}
			frame.textContent = localize('paradisAgentChat.imageLoading', "画像を読み込んでいます…");
			load();
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
		// 選択肢と「その他」は同時には使えない（1問の回答は1種類しか TUI へ送れない）。「その他」に打つと
		// 選択を外し、選択肢を選ぶと「その他」を空にする。見た目と送る内容を食い違わせないため。
		const optionButtons: { readonly button: HTMLButtonElement; icon: HTMLElement | undefined }[] = [];
		(question.options ?? []).forEach((option, optionIndex) => {
			const button = append(options, $('button.paradis-agent-chat-option')) as HTMLButtonElement;
			button.type = 'button';
			button.disabled = currentDraft.sending || currentDraft.sent;
			const chosen = multiSelect ? selected.has(optionIndex) : (currentDraft.answers[index]?.kind === 'option' && (currentDraft.answers[index] as { index: number }).index === optionIndex);
			button.classList.toggle('selected', chosen);
			let icon: HTMLElement | undefined;
			if (multiSelect) {
				icon = renderIcon(chosen ? Codicon.check : Codicon.circleLargeOutline);
				button.append(icon);
			}
			optionButtons.push({ button, icon });
			append(button, $('span.paradis-agent-chat-option-label')).textContent = `${optionIndex + 1}. ${option.label}`;
			if (option.description !== undefined) {
				append(button, $('span.paradis-agent-chat-option-description')).textContent = option.description;
			}
			store.add(addDisposableListener(button, EventType.CLICK, () => {
				currentDraft.other.delete(index);
				if (multiSelect) {
					// 描いた時点の集合ではなく今の集合から作る（「その他」に打って選択を外した後にも正しく動く）。
					const next = new Set(currentDraft.multi.get(index) ?? []);
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
				// 選んでいた選択肢を外す（打鍵のたびに作り直すと入力欄のフォーカスが外れるので、表示だけ直す）。
				currentDraft.multi.delete(index);
				for (const entry of optionButtons) {
					entry.button.classList.remove('selected');
					if (entry.icon !== undefined) {
						const unchecked = renderIcon(Codicon.circleLargeOutline);
						entry.icon.replaceWith(unchecked);
						entry.icon = unchecked;
					}
				}
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

	private submitQuestions(group: string, questionCount: number, draft: IParadisAgentChatQuestionDraft): void {
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
		// 結果は、送っている間に表示やタブを切り替えても元のペインへ書く（今の this.token ではなく）。
		const states = this.host.cardStates(token).approvals;
		const previous = states.get(interactionId);
		if (previous?.sending || previous?.sent) {
			return;
		}
		states.set(interactionId, { sending: true });
		this.rerenderQuestionCard();
		this.host.answerApproval(instanceId, token, interactionId, choiceId).then(error => {
			// 送れたら、TUI が消費して承認が消えるまで押せないままにする（押し直した `1`+Enter が入力欄へ流れるため）。
			states.set(interactionId, error !== undefined ? { sending: false, error } : { sending: false, sent: true });
			if (this.token === token && !this._store.isDisposed) {
				this.rerenderQuestionCard();
				void this.session?.refresh();
			}
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
			const rendered = this.renderMarkdown(live.text, true);
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
				// AskUserQuestion も中継では permission の段階になる。
				return live.tool === 'AskUserQuestion'
					? localize('paradisAgentChat.liveQuestion', "質問への回答を待っています")
					: localize('paradisAgentChat.livePermission', "許可を待っています");
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
		const states = this.host.cardStates(token);
		states.composer.sending = true;
		this.composer.setSending(true);
		this.host.sendMessage(instanceId, token, text).then(error => {
			states.composer.sending = false;
			// 送っている間に別のペインへ切り替えた・閉じたなら、今の入力欄には何もしない。
			if (this._store.isDisposed || this.token !== token) {
				return;
			}
			this.composer.setSending(false);
			if (error !== undefined) {
				this.composer.showNotice(error);
				const current = this.session?.state;
				this.errorStateSignature = current === undefined ? '' : `${current.epoch}:${current.rev}:${current.interaction?.id ?? ''}:${current.busy}`;
				return;
			}
			this.composer.clearAfterSend(text);
			this.stickToBottom = true;
			void this.session?.refresh();
		});
	}
}

/**
 * ファイルのドラッグか（エクスプローラーや OS のファイル）。エディタのタブ・グループ（LocalSelectionTransfer）と
 * ターミナルのタブ（`Terminals`）のドラッグは含めない。
 */
function paradisIsFileDrag(e: DragEvent): boolean {
	if (LocalSelectionTransfer.getInstance<DraggedEditorIdentifier>().hasData(DraggedEditorIdentifier.prototype)
		|| LocalSelectionTransfer.getInstance<DraggedEditorGroupIdentifier>().hasData(DraggedEditorGroupIdentifier.prototype)
		|| containsDragType(e, 'Terminals')) {
		return false;
	}
	return containsDragType(e, DataTransfers.FILES, DataTransfers.RESOURCES, CodeDataTransfers.FILES);
}
