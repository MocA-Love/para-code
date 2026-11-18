/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

// Markdown / HTML のプレビューのコメント（ワークベンチ側）。ビューアのペインごとに 1 つ。
//
//  - ツールバーの「コメント N」と、プレビューの右に置く列（コメントを書く欄とカード）をワークベンチの DOM に作る。
//    列を出している間は webview の置き場を列の幅だけ狭める（webview は置き場に重なって描かれる）。
//  - ページ側の層（paradisDocCommentLayer.ts）から届く「ここにコメントを書きたい」で書く欄を開き、本文は
//    この欄で打ったものだけを保存する。ページからのメッセージは印（token）が合うものだけ受け、本文を運ぶものは無い。
//  - 保存と読み込みは shared process の保存係へ頼む（paradisDocCommentsBackend.ts）。
//  - カードには、届け方の状態（Q663-3: カードの中に出す）とエージェントの回答を並べ、解決・開き直し・返信（追記）を置く。
//    回答は文字のまま（textContent）出し、HTML・Markdown として描かない。操作はワークベンチの DOM とチャネルだけで行い、
//    ページ（webview）からのメッセージでは受けない。
//  - エージェントが書き換えようとしている所の「編集中」の印（Q663-5）を、shared process の控え（paradisDocEditingSource.ts）から
//    受けてページへ渡す。描き直しで変わったブロックの差分の色と、下に足された節の知らせはページの層だけで出す。

import * as dom from '../../../../base/browser/dom.js';
import { StandardKeyboardEvent } from '../../../../base/browser/keyboardEvent.js';
import { renderIcon } from '../../../../base/browser/ui/iconLabel/iconLabels.js';
import { Codicon } from '../../../../base/common/codicons.js';
import { onUnexpectedError } from '../../../../base/common/errors.js';
import { KeyCode, KeyMod } from '../../../../base/common/keyCodes.js';
import { Disposable, DisposableStore, MutableDisposable } from '../../../../base/common/lifecycle.js';
import { URI } from '../../../../base/common/uri.js';
import { generateUuid } from '../../../../base/common/uuid.js';
import { localize } from '../../../../nls.js';
import { IOverlayWebview } from '../../../../workbench/contrib/webview/browser/webview.js';
import { createParadisChip, createParadisStatusDot, ParadisChipTone, ParadisStatusTone } from '../../../browser/paradisBadges.js';
import { ParadisButton } from '../../../browser/paradisButton.js';
import { appendParadisViewerToolbarGroup, appendParadisViewerToolbarPanelToggle, appendParadisViewerToolbarSeparator, setParadisViewerToolbarOptionChecked } from '../../fileViewers/browser/paradisViewerToolbar.js';
import { IParadisDocAnchor } from '../common/paradisDocCommentAnchor.js';
import { IParadisDocLayerKey, IParadisDocLayerLabels, IParadisDocLayerState, ParadisDocLayerMessage, paradisDocLayerRevealMessage, paradisDocLayerStateMessage, paradisReadDocLayerMessage } from '../common/paradisDocCommentLayer.js';
import { IParadisDocCommentThread, IParadisDocCommentsChange, PARADIS_DOC_COMMENT_TEXT_MAX, ParadisDocCommentPlace, ParadisDocCommentUserAction } from '../common/paradisDocComments.js';
import { IParadisDocCommentsBackend, paradisDocCommentTargetOf } from './paradisDocCommentsBackend.js';
import { IParadisDocEditingMark } from '../common/paradisDocEditing.js';
import { IParadisDocEditingSource, paradisDocEditingSource } from './paradisDocEditingSource.js';
import './media/paradisDocComments.css';

/** ビューアがコントローラーへ渡すもの。 */
export interface IParadisDocCommentsHost {
	/** いまの webview。 */
	webview(): IOverlayWebview | undefined;
	/** 外枠（HTML）から届いたリンクのクリック。Markdown では呼ばれない。 */
	openLink(href: string): void;
	/** 外枠（HTML）から届いたスクロール位置。Markdown では呼ばれない。 */
	recordScroll(progress: number): void;
}

/** 列を出している間に webview の置き場へ付けるクラス（列の幅だけ狭める）。 */
const OPEN_CLASS = 'paradis-doc-comments-open';

/** 位置の当たり方ごとの札（見つかったときは出さない）。 */
function placeChip(place: ParadisDocCommentPlace | undefined): { readonly label: string; readonly tone: ParadisChipTone } | undefined {
	switch (place) {
		case 'changed':
			return { label: localize('paradis.docComments.placeChanged', "本文が変わりました"), tone: 'warning' };
		case 'ambiguous':
			return { label: localize('paradis.docComments.placeAmbiguous', "同じ文が複数あります"), tone: 'warning' };
		case 'lost':
			return { label: localize('paradis.docComments.placeLost', "位置が分かりません"), tone: 'danger' };
		default:
			return undefined;
	}
}

/** カードに出す届け方の状態。`label` は点の横の短い語、`note` はその下の説明。 */
export interface IParadisDocCommentStatus {
	readonly label: string;
	readonly tone: ParadisStatusTone;
	readonly note?: string;
}

/** スレッドの状態を、カードに出す語にする（Q663-3）。 */
export function paradisDocCommentStatus(thread: IParadisDocCommentThread): IParadisDocCommentStatus {
	const delivery = thread.delivery;
	switch (thread.state) {
		case 'resolved':
			return { label: localize('paradis.docComments.status.resolved', "解決済み"), tone: 'success' };
		case 'answered':
			return { label: localize('paradis.docComments.status.answered', "回答あり"), tone: 'success' };
		case 'delivered':
			return { label: localize('paradis.docComments.status.delivered', "届きました"), tone: 'running', note: localize('paradis.docComments.status.deliveredNote', "回答を待っています。") };
		case 'undeliverable': {
			const label = localize('paradis.docComments.status.undeliverable', "届けられません");
			switch (delivery?.blockedBy) {
				case 'ended':
					return { label, tone: 'neutral', note: localize('paradis.docComments.status.ended', "作成元のセッションは終了しています。") };
				case 'unknown':
					return { label, tone: 'warning', note: localize('paradis.docComments.status.unknown', "作成元のセッションが動いているか分かりません。そのターミナルで 1 回メッセージを送ると届けます。") };
				case 'noHooks':
					return { label, tone: 'warning', note: localize('paradis.docComments.status.noHooks', "作成元のターミナルからエージェントの状態が届いていないため、届けられません。") };
				default:
					return { label, tone: 'warning', note: localize('paradis.docComments.status.noOwner', "作成元のセッションが分かりません。「資料」ビューで「このセッションの資料にする」を選ぶと届けます。") };
			}
		}
	}
	if (delivery?.typedAt !== undefined) {
		return delivery.entered
			? { label: localize('paradis.docComments.status.sent', "送信しました"), tone: 'running', note: localize('paradis.docComments.status.sentNote', "エージェントが受け取るのを待っています。") }
			: { label: localize('paradis.docComments.status.typed', "入力欄に入れました"), tone: 'warning', note: localize('paradis.docComments.status.typedNote', "ターミナルで内容を確かめて Enter で送ってください。") };
	}
	const label = localize('paradis.docComments.status.queued', "届け待ち");
	switch (delivery?.blockedBy) {
		case 'working':
			return { label, tone: 'neutral', note: localize('paradis.docComments.status.working', "エージェントが動作中です。終わったら届けます。") };
		case 'permission':
			return { label, tone: 'warning', note: localize('paradis.docComments.status.permission', "エージェントが許可待ちです。答えた後に届けます。") };
		case 'question':
			return { label, tone: 'warning', note: localize('paradis.docComments.status.question', "エージェントが質問しています。答えた後に届けます。") };
		case 'draft':
			return { label, tone: 'warning', note: localize('paradis.docComments.status.draft', "ターミナルの入力欄に書きかけがあります。空いたら届けます。") };
		case 'draftUnknown':
			return { label, tone: 'neutral', note: localize('paradis.docComments.status.draftUnknown', "入力欄の中身を確かめられないため、エージェントの次の応答の後に届けます。") };
		case 'sending':
			return { label, tone: 'neutral', note: localize('paradis.docComments.status.sending', "同じターミナルへ前のコメントを届けています。続けて届けます。") };
		case 'screen':
			return { label, tone: 'warning', note: localize('paradis.docComments.status.screen', "ターミナルに確認の画面が出ています。閉じた後に届けます。") };
		case 'notRunning':
			return { label, tone: 'warning', note: localize('paradis.docComments.status.notRunning', "作成元のターミナルでエージェントが動いていません。動き出したら届けます。") };
		default:
			return { label, tone: 'neutral' };
	}
}

/** 引用を 1 行に均す。 */
function quoteLine(anchor: IParadisDocAnchor): string {
	return localize('paradis.docComments.quote', "「{0}」", anchor.quote.replace(/\s+/g, ' ').trim());
}

export class ParadisDocCommentsController extends Disposable {

	private _target: IParadisDocCommentsChange | undefined;
	private _threads: readonly IParadisDocCommentThread[] = [];
	/** ページが知らせた当て直しの結果（保存した値より新しい）。 */
	private readonly _places = new Map<string, ParadisDocCommentPlace>();
	private _activeId: string | undefined;
	private _draft: { readonly anchor: IParadisDocAnchor; text: string } | undefined;
	/** 返信（追記）を書いているカード。 */
	private _reply: { readonly id: string; text: string } | undefined;
	/** 返信の欄（作り直さないよう覚えておく）。 */
	private _replyBox: { readonly id: string; readonly element: HTMLElement; readonly textarea: HTMLTextAreaElement } | undefined;
	private _saving = false;
	/** ユーザーが列を畳んだ。 */
	private _collapsed = false;
	/** コメントが無くても列を出す（ツールバーで開いた）。 */
	private _pinned = false;
	private _rendered = true;
	/** いまの webview の文書に渡した印。webview を作るたびに作り直す。 */
	private _token: string | undefined;
	private _loadGeneration = 0;
	/** いまの資料の「編集中」の印。 */
	private _editing: IParadisDocEditingMark | undefined;
	private _editingGeneration = 0;

	private _toggle: HTMLButtonElement | undefined;
	private _content: HTMLElement | undefined;
	private _column: HTMLElement | undefined;
	private _header: HTMLElement | undefined;
	private _list: HTMLElement | undefined;
	private _toggleLabel: HTMLElement | undefined;
	/** 開いている書く欄（作り直さないよう覚えておく）。 */
	private _composer: { readonly card: HTMLElement; readonly textarea: HTMLTextAreaElement; readonly save: ParadisButton } | undefined;
	/** いま並べているカード（ID → 要素）。 */
	private readonly _cards = new Map<string, HTMLElement>();
	private readonly _listStore = this._register(new DisposableStore());
	/** 返信の欄の購読（欄を捨てるまで持つ。カードを描き直しても欄は使い回す）。 */
	private readonly _replyStore = this._register(new DisposableStore());
	private readonly _changeListener = this._register(new MutableDisposable());

	constructor(
		private readonly _host: IParadisDocCommentsHost,
		private readonly _backend: IParadisDocCommentsBackend | undefined,
		private readonly _editingSource: IParadisDocEditingSource | undefined = paradisDocEditingSource(),
	) {
		super();
		if (this._editingSource) {
			this._register(this._editingSource.onDidChange(change => {
				if (this._target && change.hostId === this._target.hostId && change.path === this._target.path) {
					// 読みに行った結果より新しい知らせを優先する
					this._editingGeneration++;
					this._setEditing(change.mark);
				}
			}));
		}
		if (this._backend) {
			this._changeListener.value = this._backend.onDidChange(change => {
				if (this._target && change.hostId === this._target.hostId && change.path === this._target.path) {
					this._load();
				}
			});
		}
	}

	/** コメント層を出すか（保存先があり、資料のファイルを開いているとき）。 */
	get enabled(): boolean {
		return this._backend !== undefined && this._target !== undefined;
	}

	/** 保存先があるか（デスクトップ）。 */
	get available(): boolean {
		return this._backend !== undefined;
	}

	/** そのファイルにコメントを書けるか。描画は入力の切り替えと重なりうるので、描いているファイルで決める。 */
	enabledFor(resource: URI): boolean {
		return this._backend !== undefined && paradisDocCommentTargetOf(resource) !== undefined;
	}

	/** ページへ渡す文言。 */
	get labels(): IParadisDocLayerLabels {
		return {
			comment: localize('paradis.docComments.commentButton', "コメント"),
			newSection: localize('paradis.docComments.newSection', "下に新しい節が入りました"),
		};
	}

	/** ページへ渡す、いまの表示。 */
	get layerState(): IParadisDocLayerState {
		return {
			comments: this._threads.map(thread => ({ id: thread.id, anchor: thread.anchor })),
			...(this._activeId !== undefined ? { activeId: this._activeId } : {}),
			...(this._draft !== undefined ? { draft: this._draft.anchor } : {}),
			...(this._editing !== undefined ? {
				editing: {
					id: this._editing.id,
					label: this._editing.tool === 'write'
						? localize('paradis.docComments.rewriting', "Claude Code が書き直し中")
						: localize('paradis.docComments.editing', "Claude Code が編集中"),
					...(this._editing.source !== undefined ? { source: this._editing.source } : {}),
				},
			} : {}),
		};
	}

	/** いまの webview の文書に渡す印。webview がまだ無ければ作る。 */
	get token(): string {
		this._token ??= generateUuid();
		return this._token;
	}

	/** ツールバーに「コメント N」を置く。 */
	createToolbarToggle(toolbar: HTMLElement): void {
		if (!this._backend) {
			return;
		}
		const group = appendParadisViewerToolbarGroup(toolbar, 'paradis-doc-comments-toolbar');
		this._toggle = appendParadisViewerToolbarPanelToggle(group, '', Codicon.commentDiscussion);
		this._toggleLabel = dom.isHTMLElement(this._toggle.lastElementChild) ? this._toggle.lastElementChild : undefined;
		appendParadisViewerToolbarSeparator(toolbar);
		this._register(dom.addDisposableListener(this._toggle, dom.EventType.CLICK, () => {
			if (this._columnVisible) {
				this._collapsed = true;
				this._pinned = false;
			} else {
				this._collapsed = false;
				this._pinned = true;
			}
			this._update();
		}));
		this._update();
	}

	/** プレビューの置き場（`.paradis-file-viewer-content`）の右に列を作る。 */
	createColumn(content: HTMLElement): void {
		if (!this._backend) {
			return;
		}
		this._content = content;
		this._column = dom.append(content, dom.$('.paradis-doc-comments'));
		this._column.setAttribute('role', 'complementary');
		this._column.setAttribute('aria-label', localize('paradis.docComments.columnLabel', "コメント"));
		this._header = dom.append(this._column, dom.$('.paradis-doc-comments-header'));
		this._list = dom.append(this._column, dom.$('.paradis-doc-comments-list'));
		this._update();
	}

	/** 開いたファイルが替わった。 */
	setResource(resource: URI | undefined): void {
		const target = resource ? paradisDocCommentTargetOf(resource) : undefined;
		if (this._target && target && this._target.hostId === target.hostId && this._target.path === target.path) {
			return;
		}
		this._target = target;
		this._threads = [];
		this._places.clear();
		this._activeId = undefined;
		this._draft = undefined;
		this._reply = undefined;
		this._replyBox = undefined;
		this._replyStore.clear();
		this._pinned = false;
		this._editing = undefined;
		this._update();
		this._load();
		this._loadEditing();
	}

	/** 開いた資料にいま出ている「編集中」の印を読む（書いている途中で開いたとき）。 */
	private async _loadEditing(): Promise<void> {
		const target = this._target;
		const generation = ++this._editingGeneration;
		if (!target || !this._editingSource) {
			return;
		}
		try {
			const mark = await this._editingSource.get(target.hostId, target.path);
			if (generation === this._editingGeneration && this._target === target) {
				this._setEditing(mark);
			}
		} catch (error) {
			onUnexpectedError(error);
		}
	}

	private _setEditing(mark: IParadisDocEditingMark | undefined): void {
		if (this._editing?.id === mark?.id) {
			return;
		}
		this._editing = mark;
		this._push();
	}

	/** プレビュー（true）とソース（false）の切り替え。ソースの間は列を出さない。 */
	setRendered(rendered: boolean): void {
		this._rendered = rendered;
		this._update();
	}

	/** webview を作るたびに呼ぶ（購読は `store` に入れる）。印も作り直す。 */
	attach(webview: IOverlayWebview, store: DisposableStore): void {
		this._token = generateUuid();
		if (!this._backend) {
			return;
		}
		store.add(webview.onMessage(({ message }) => {
			const parsed = paradisReadDocLayerMessage(message, this._token);
			if (parsed) {
				this._onLayerMessage(parsed, webview);
			}
		}));
	}

	private _onLayerMessage(message: ParadisDocLayerMessage, webview: IOverlayWebview): void {
		switch (message.type) {
			case 'ready':
				this._push();
				return;
			case 'compose':
				this._compose(message.anchor);
				return;
			case 'places':
				this._onPlaces(message.places);
				return;
			case 'focus':
				this._activeId = message.id;
				this._update();
				this._push();
				this._cards.get(message.id)?.scrollIntoView({ block: 'nearest' });
				return;
			case 'link':
				this._host.openLink(message.href);
				return;
			case 'scroll':
				this._host.recordScroll(message.progress);
				return;
			case 'key':
				this._forwardKey(message.event, webview);
				return;
		}
	}

	/**
	 * 外枠（HTML）の中のページで押したキーを、webview の基盤と同じ形でワークベンチへ渡す（webviewElement.ts の
	 * handleKeyEvent）。基盤は入れ子の iframe のキーを拾わないので、渡さないとページを押した後にショートカットが効かない。
	 */
	private _forwardKey(event: IParadisDocLayerKey, webview: IOverlayWebview): void {
		if (!webview.isFocused) {
			return;
		}
		const targetWindow = dom.getWindow(webview.container);
		const emulated = new KeyboardEvent(event.type, event);
		Object.defineProperty(emulated, 'target', { get: () => webview.container });
		targetWindow.dispatchEvent(emulated);
	}

	private _compose(anchor: IParadisDocAnchor): void {
		if (!this.enabled) {
			return;
		}
		// 書きかけの文があるときは引用を差し替えない（ページから届く知らせで書きかけを消さない）
		if (this._draft && this._draft.text.trim().length > 0) {
			this._focusComposer();
			return;
		}
		this._draft = { anchor, text: '' };
		// 空の欄が開いていれば、新しい引用で作り直す
		this._composer = undefined;
		this._collapsed = false;
		this._update();
		this._push();
		this._focusComposer();
	}

	private _focusComposer(): void {
		this._composer?.textarea.focus();
	}

	private _onPlaces(places: ReadonlyMap<string, ParadisDocCommentPlace>): void {
		let changed = false;
		const toSave = new Map<string, ParadisDocCommentPlace>();
		for (const [id, place] of places) {
			const thread = this._threads.find(candidate => candidate.id === id);
			if (!thread) {
				continue;
			}
			if (this._places.get(id) !== place) {
				this._places.set(id, place);
				changed = true;
			}
			if (thread.anchor.place !== place) {
				toSave.set(id, place);
			}
		}
		if (changed) {
			this._update();
		}
		const target = this._target;
		if (target && toSave.size > 0 && this._backend) {
			this._backend.setPlaces(target.hostId, target.path, toSave).catch(onUnexpectedError);
		}
	}

	private async _save(): Promise<void> {
		const target = this._target;
		const draft = this._draft;
		const text = draft?.text.trim() ?? '';
		if (!target || !draft || !text || this._saving || !this._backend) {
			return;
		}
		this._saving = true;
		this._update();
		try {
			const thread = await this._backend.add(target.hostId, target.path, { anchor: draft.anchor, text: text.slice(0, PARADIS_DOC_COMMENT_TEXT_MAX) });
			if (thread && this._target === target) {
				this._draft = undefined;
				this._activeId = thread.id;
				this._threads = [...this._threads.filter(candidate => candidate.id !== thread.id), thread];
			}
		} catch (error) {
			onUnexpectedError(error);
		} finally {
			this._saving = false;
			this._update();
			this._push();
		}
	}

	private _cancel(): void {
		this._draft = undefined;
		this._update();
		this._push();
	}

	private async _load(): Promise<void> {
		const target = this._target;
		const generation = ++this._loadGeneration;
		if (!target || !this._backend) {
			return;
		}
		try {
			const sidecar = await this._backend.get(target.hostId, target.path);
			if (generation !== this._loadGeneration || this._target !== target) {
				return;
			}
			this._threads = sidecar.threads;
			if (this._activeId !== undefined && !this._threads.some(thread => thread.id === this._activeId)) {
				this._activeId = undefined;
			}
			this._update();
			this._push();
		} catch (error) {
			onUnexpectedError(error);
		}
	}

	/** ページへいまの表示を送る。 */
	private _push(): void {
		if (this.enabled) {
			void this._host.webview()?.postMessage(paradisDocLayerStateMessage(this.layerState));
		}
	}

	private get _columnVisible(): boolean {
		return this.enabled && this._rendered && !this._collapsed && (this._threads.length > 0 || this._draft !== undefined || this._pinned);
	}

	private _update(): void {
		const visible = this._columnVisible;
		if (this._toggle) {
			this._toggle.style.display = this.enabled ? '' : 'none';
			if (this._toggleLabel) {
				this._toggleLabel.textContent = localize('paradis.docComments.toggle', "コメント {0}", this._threads.length);
			}
			setParadisViewerToolbarOptionChecked(this._toggle, visible);
		}
		this._content?.classList.toggle(OPEN_CLASS, visible);
		if (!this._column || !this._header || !this._list) {
			return;
		}
		this._column.style.display = visible ? '' : 'none';
		if (!visible) {
			this._listStore.clear();
			dom.clearNode(this._list);
			this._composer = undefined;
			this._replyBox = undefined;
			this._replyStore.clear();
			this._cards.clear();
			return;
		}
		dom.reset(this._header,
			renderIcon(Codicon.commentDiscussion),
			dom.$('span.paradis-doc-comments-count', undefined, localize('paradis.docComments.count', "コメント {0} 件", this._threads.length)));
		this._renderList();
	}

	private _renderList(): void {
		const list = this._list!;
		// 書きかけの欄は作り直さない（打っている文字と IME の変換を消さないため）
		const composer = this._draft !== undefined && this._composer?.card.isConnected ? this._composer : undefined;
		if (!composer) {
			this._listStore.clear();
			this._composer = undefined;
		}
		this._cards.clear();
		// 返信の欄は新しいカードへ移す。移すとフォーカスが外れるので戻す
		const replyFocused = this._replyBox !== undefined && dom.getActiveElement() === this._replyBox.textarea;
		if (this._reply === undefined && this._replyBox !== undefined) {
			this._replyBox = undefined;
			this._replyStore.clear();
		}
		for (const child of [...list.children]) {
			if (child !== composer?.card) {
				child.remove();
			}
		}
		if (this._draft && !composer) {
			list.appendChild(this._renderComposer(this._draft));
		} else if (composer) {
			composer.save.enabled = !this._saving && this._draft!.text.trim().length > 0;
		}
		// 新しいものを上に
		const threads = [...this._threads].sort((a, b) => b.createdAt - a.createdAt);
		for (const thread of threads) {
			list.appendChild(this._renderCard(thread));
		}
		if (threads.length === 0 && !this._draft) {
			dom.append(list, dom.$('.paradis-doc-comments-empty', undefined, localize('paradis.docComments.empty', "本文の文字を選ぶと、コメントを書けます。")));
		}
		if (replyFocused && this._replyBox?.textarea.isConnected) {
			this._replyBox.textarea.focus();
		}
	}

	private _renderComposer(draft: { readonly anchor: IParadisDocAnchor; text: string }): HTMLElement {
		const store = this._listStore;
		const card = dom.$('.paradis-doc-comment-card.active');
		dom.append(card, dom.$('.paradis-doc-comment-quote', undefined, quoteLine(draft.anchor)));
		const textarea = dom.append(card, dom.$<HTMLTextAreaElement>('textarea.paradis-doc-comment-input.paradis-text-focus'));
		textarea.setAttribute('aria-label', localize('paradis.docComments.inputLabel', "コメント"));
		textarea.placeholder = localize('paradis.docComments.placeholder', "コメントを書く");
		textarea.maxLength = PARADIS_DOC_COMMENT_TEXT_MAX;
		textarea.value = draft.text;
		const footer = dom.append(card, dom.$('.paradis-doc-comment-footer'));
		const cancel = store.add(new ParadisButton(footer, { kind: 'ghost', small: true, label: localize('paradis.docComments.cancel', "やめる") }));
		dom.append(footer, dom.$('span.paradis-doc-comment-grow'));
		const save = store.add(new ParadisButton(footer, { kind: 'primary', small: true, label: localize('paradis.docComments.save', "保存") }));
		this._composer = { card, textarea, save };
		save.enabled = draft.text.trim().length > 0 && !this._saving;
		store.add(dom.addDisposableListener(textarea, dom.EventType.INPUT, () => {
			draft.text = textarea.value;
			save.enabled = draft.text.trim().length > 0 && !this._saving;
		}));
		store.add(dom.addDisposableListener(textarea, dom.EventType.KEY_DOWN, e => {
			const event = new StandardKeyboardEvent(e);
			if (event.equals(KeyMod.CtrlCmd | KeyCode.Enter)) {
				dom.EventHelper.stop(e, true);
				void this._save();
			} else if (event.equals(KeyCode.Escape)) {
				dom.EventHelper.stop(e, true);
				this._cancel();
			}
		}));
		store.add(cancel.onDidClick(() => this._cancel()));
		store.add(save.onDidClick(() => void this._save()));
		return card;
	}

	private _renderCard(thread: IParadisDocCommentThread): HTMLElement {
		const card = dom.$('.paradis-doc-comment-card.paradis-focus-ring');
		this._cards.set(thread.id, card);
		card.tabIndex = 0;
		card.setAttribute('role', 'button');
		card.classList.toggle('active', thread.id === this._activeId);
		const place = this._places.get(thread.id) ?? thread.anchor.place;
		const chip = placeChip(place);
		if (chip) {
			createParadisChip(dom.append(card, dom.$('.paradis-doc-comment-place')), chip.label, chip.tone);
		}
		const quote = dom.append(card, dom.$('.paradis-doc-comment-quote', undefined, quoteLine(thread.anchor)));
		quote.classList.toggle('lost', place === 'lost');
		for (const message of thread.messages) {
			if (message.by === 'user') {
				dom.append(card, dom.$('.paradis-doc-comment-text', undefined, message.text));
				continue;
			}
			// 回答は文字のまま出す（HTML・Markdown として描かない）
			const answer = dom.append(card, dom.$('.paradis-doc-comment-answer'));
			dom.append(answer, dom.$('.paradis-doc-comment-answer-by', undefined, localize('paradis.docComments.answerBy', "回答")));
			dom.append(answer, dom.$('.paradis-doc-comment-text', undefined, message.text));
			if (message.edits !== undefined && message.edits.length > 0) {
				dom.append(answer, dom.$('.paradis-doc-comment-note', undefined, localize('paradis.docComments.edits', "本文の変更 {0} 件", message.edits.length)));
			}
		}
		const status = paradisDocCommentStatus(thread);
		createParadisStatusDot(dom.append(card, dom.$('.paradis-doc-comment-status')), status.label, status.tone);
		if (status.note !== undefined) {
			dom.append(card, dom.$('.paradis-doc-comment-note', undefined, status.note));
		}
		const replying = this._reply?.id === thread.id;
		if (replying) {
			card.appendChild(this._replyBoxFor(thread.id));
		} else {
			this._renderCardActions(card, thread);
		}
		const reveal = () => {
			this._activeId = thread.id;
			for (const [id, other] of this._cards) {
				other.classList.toggle('active', id === thread.id);
			}
			this._push();
			void this._host.webview()?.postMessage(paradisDocLayerRevealMessage(thread.id));
		};
		this._listStore.add(dom.addDisposableListener(card, dom.EventType.CLICK, e => {
			// カードの中のボタン・返信の欄を押したときは位置へ移らない
			if (dom.isHTMLElement(e.target) && e.target.closest('button, textarea')) {
				return;
			}
			reveal();
		}));
		this._listStore.add(dom.addDisposableListener(card, dom.EventType.KEY_DOWN, e => {
			if (e.target !== card) {
				return;
			}
			const event = new StandardKeyboardEvent(e);
			if (event.equals(KeyCode.Enter) || event.equals(KeyCode.Space)) {
				dom.EventHelper.stop(e, true);
				reveal();
			}
		}));
		return card;
	}

	/** カードの下のボタン（今すぐ届ける・返信・解決にする／開き直す）。 */
	private _renderCardActions(card: HTMLElement, thread: IParadisDocCommentThread): void {
		const footer = dom.append(card, dom.$('.paradis-doc-comment-footer'));
		const button = (label: string, run: () => void) => {
			const created = this._listStore.add(new ParadisButton(footer, { kind: 'ghost', small: true, label }));
			this._listStore.add(created.onDidClick(run));
		};
		if (thread.delivery?.blockedBy === 'draftUnknown' && thread.state === 'queued' && thread.delivery.typedAt === undefined) {
			button(localize('paradis.docComments.deliverNow', "今すぐ届ける"), () => this._act(thread.id, 'deliverNow'));
		}
		button(localize('paradis.docComments.reply', "返信"), () => {
			this._reply = { id: thread.id, text: '' };
			this._update();
			this._replyBox?.textarea.focus();
		});
		dom.append(footer, dom.$('span.paradis-doc-comment-grow'));
		if (thread.state === 'resolved') {
			button(localize('paradis.docComments.reopen', "開き直す"), () => this._act(thread.id, 'reopen'));
		} else {
			button(localize('paradis.docComments.resolve', "解決にする"), () => this._act(thread.id, 'resolve'));
		}
	}

	/** 返信の欄。同じカードの返信の間は使い回す（描き直しで打っている文字を消さないため）。 */
	private _replyBoxFor(id: string): HTMLElement {
		if (this._replyBox?.id === id) {
			return this._replyBox.element;
		}
		this._replyStore.clear();
		const store = this._replyStore;
		const element = dom.$('.paradis-doc-comment-reply');
		const textarea = dom.append(element, dom.$<HTMLTextAreaElement>('textarea.paradis-doc-comment-input.paradis-text-focus'));
		textarea.setAttribute('aria-label', localize('paradis.docComments.replyLabel', "返信"));
		textarea.placeholder = localize('paradis.docComments.replyPlaceholder', "返信を書く");
		textarea.maxLength = PARADIS_DOC_COMMENT_TEXT_MAX;
		const footer = dom.append(element, dom.$('.paradis-doc-comment-footer'));
		const cancel = store.add(new ParadisButton(footer, { kind: 'ghost', small: true, label: localize('paradis.docComments.cancel', "やめる") }));
		dom.append(footer, dom.$('span.paradis-doc-comment-grow'));
		const send = store.add(new ParadisButton(footer, { kind: 'primary', small: true, label: localize('paradis.docComments.send', "送る") }));
		send.enabled = false;
		const close = () => {
			this._reply = undefined;
			this._replyStore.clear();
			this._replyBox = undefined;
			this._update();
		};
		const submit = () => {
			const text = textarea.value.trim();
			if (text.length === 0) {
				return;
			}
			close();
			this._act(id, 'append', text);
		};
		store.add(dom.addDisposableListener(textarea, dom.EventType.INPUT, () => {
			if (this._reply?.id === id) {
				this._reply.text = textarea.value;
			}
			send.enabled = textarea.value.trim().length > 0;
		}));
		store.add(dom.addDisposableListener(textarea, dom.EventType.KEY_DOWN, e => {
			const event = new StandardKeyboardEvent(e);
			if (event.equals(KeyMod.CtrlCmd | KeyCode.Enter)) {
				dom.EventHelper.stop(e, true);
				submit();
			} else if (event.equals(KeyCode.Escape)) {
				dom.EventHelper.stop(e, true);
				close();
			}
		}));
		store.add(cancel.onDidClick(close));
		store.add(send.onDidClick(submit));
		this._replyBox = { id, element, textarea };
		return element;
	}

	/** カードの操作を保存係へ頼む。結果は保存係の知らせで読み直す。 */
	private _act(id: string, action: ParadisDocCommentUserAction, text?: string): void {
		const target = this._target;
		if (target && this._backend) {
			this._backend.act(target.hostId, target.path, id, action, text).catch(onUnexpectedError);
		}
	}
}
