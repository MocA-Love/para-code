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
import { createParadisChip, ParadisChipTone } from '../../../browser/paradisBadges.js';
import { ParadisButton } from '../../../browser/paradisButton.js';
import { appendParadisViewerToolbarGroup, appendParadisViewerToolbarPanelToggle, appendParadisViewerToolbarSeparator, setParadisViewerToolbarOptionChecked } from '../../fileViewers/browser/paradisViewerToolbar.js';
import { IParadisDocAnchor } from '../common/paradisDocCommentAnchor.js';
import { IParadisDocLayerKey, IParadisDocLayerLabels, IParadisDocLayerState, ParadisDocLayerMessage, paradisDocLayerRevealMessage, paradisDocLayerStateMessage, paradisReadDocLayerMessage } from '../common/paradisDocCommentLayer.js';
import { IParadisDocCommentThread, IParadisDocCommentsChange, PARADIS_DOC_COMMENT_TEXT_MAX, ParadisDocCommentPlace } from '../common/paradisDocComments.js';
import { IParadisDocCommentsBackend, paradisDocCommentTargetOf } from './paradisDocCommentsBackend.js';
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
	private _saving = false;
	/** ユーザーが列を畳んだ。 */
	private _collapsed = false;
	/** コメントが無くても列を出す（ツールバーで開いた）。 */
	private _pinned = false;
	private _rendered = true;
	/** いまの webview の文書に渡した印。webview を作るたびに作り直す。 */
	private _token: string | undefined;
	private _loadGeneration = 0;

	private _toggle: HTMLButtonElement | undefined;
	private _content: HTMLElement | undefined;
	private _column: HTMLElement | undefined;
	private _header: HTMLElement | undefined;
	private _list: HTMLElement | undefined;
	private _textarea: HTMLTextAreaElement | undefined;
	private readonly _listStore = this._register(new DisposableStore());
	private readonly _changeListener = this._register(new MutableDisposable());

	constructor(
		private readonly _host: IParadisDocCommentsHost,
		private readonly _backend: IParadisDocCommentsBackend | undefined,
	) {
		super();
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

	/** ページへ渡す文言。 */
	get labels(): IParadisDocLayerLabels {
		return { comment: localize('paradis.docComments.commentButton', "コメント") };
	}

	/** ページへ渡す、いまの表示。 */
	get layerState(): IParadisDocLayerState {
		return {
			comments: this._threads.map(thread => ({ id: thread.id, anchor: thread.anchor })),
			...(this._activeId !== undefined ? { activeId: this._activeId } : {}),
			...(this._draft !== undefined ? { draft: this._draft.anchor } : {}),
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
		this._pinned = false;
		this._update();
		this._load();
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
				this._list?.querySelector<HTMLElement>(`[data-id="${message.id}"]`)?.scrollIntoView({ block: 'nearest' });
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
			this._textarea?.focus();
			return;
		}
		this._draft = { anchor, text: '' };
		this._collapsed = false;
		this._update();
		this._push();
		this._textarea?.focus();
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
			const label = this._toggle.querySelector('.paradis-viewer-toolbar-option-label');
			if (label) {
				label.textContent = localize('paradis.docComments.toggle', "コメント {0}", this._threads.length);
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
			this._textarea = undefined;
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
		const keepComposer = this._textarea !== undefined && this._draft !== undefined && this._textarea.isConnected;
		const composer = keepComposer ? this._textarea!.closest<HTMLElement>('.paradis-doc-comment-card') : undefined;
		if (!keepComposer) {
			this._listStore.clear();
			this._textarea = undefined;
		}
		for (const child of [...list.children]) {
			if (child !== composer) {
				child.remove();
			}
		}
		if (this._draft && !keepComposer) {
			list.appendChild(this._renderComposer(this._draft));
		} else if (composer) {
			const save = composer.querySelector<HTMLButtonElement>('.paradis-doc-comment-save');
			if (save) {
				save.disabled = this._saving || this._draft!.text.trim().length === 0;
			}
		}
		// 新しいものを上に
		const threads = [...this._threads].sort((a, b) => b.createdAt - a.createdAt);
		for (const thread of threads) {
			list.appendChild(this._renderCard(thread));
		}
		if (threads.length === 0 && !this._draft) {
			dom.append(list, dom.$('.paradis-doc-comments-empty', undefined, localize('paradis.docComments.empty', "本文の文字を選ぶと、コメントを書けます。")));
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
		this._textarea = textarea;
		const footer = dom.append(card, dom.$('.paradis-doc-comment-footer'));
		const cancel = store.add(new ParadisButton(footer, { kind: 'ghost', small: true, label: localize('paradis.docComments.cancel', "やめる") }));
		dom.append(footer, dom.$('span.paradis-doc-comment-grow'));
		const save = store.add(new ParadisButton(footer, { kind: 'primary', small: true, label: localize('paradis.docComments.save', "保存") }));
		save.element.classList.add('paradis-doc-comment-save');
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
		card.dataset.id = thread.id;
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
		const first = thread.messages.find(message => message.by === 'user') ?? thread.messages[0];
		dom.append(card, dom.$('.paradis-doc-comment-text', undefined, first?.text ?? ''));
		const reveal = () => {
			this._activeId = thread.id;
			for (const other of this._list?.querySelectorAll('.paradis-doc-comment-card[data-id]') ?? []) {
				other.classList.toggle('active', (other as HTMLElement).dataset.id === thread.id);
			}
			this._push();
			void this._host.webview()?.postMessage(paradisDocLayerRevealMessage(thread.id));
		};
		this._listStore.add(dom.addDisposableListener(card, dom.EventType.CLICK, reveal));
		this._listStore.add(dom.addDisposableListener(card, dom.EventType.KEY_DOWN, e => {
			const event = new StandardKeyboardEvent(e);
			if (event.equals(KeyCode.Enter) || event.equals(KeyCode.Space)) {
				dom.EventHelper.stop(e, true);
				reveal();
			}
		}));
		return card;
	}
}
