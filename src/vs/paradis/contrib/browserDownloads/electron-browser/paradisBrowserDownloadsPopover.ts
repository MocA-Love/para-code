/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

// URL バー右のダウンロードボタンから開く一覧（「ダウンロード / フォルダを開く」と各ファイルの行）。
//
// 自前の DOM なので、内蔵ブラウザのネイティブビューの上に出すには overlayManager.ts の
// OVERLAY_DEFINITIONS に `paradis-browser-downloads-popover` を載せてある（載せないとページの裏に
// 隠れて何も見えない）。プロファイルのドロップダウン（paradisBrowserProfileDropdown.ts）と同じ作りで、
// 外側クリック・Esc・リサイズ・ウィンドウのフォーカス喪失で閉じ、閉じたらボタンへフォーカスを戻す。
//
// 「開く」を出すのは、開いても表示されるだけの種類（許可リスト、paradisIsOpenableDownload）で、しかも
// エージェントのタブ（Agent スコープ・エージェントが作ったプロファイル）から落ちてきたものでないときだけ。
// それ以外は「フォルダで表示」だけにする。main 側も同じ判定で開くのを断る（paradisBrowserDownloadsTracker.ts）。
//
// 行は id ごとに作っておき、進み具合の通知（250ms ごと）では進捗バーと文言だけを書き換える。作り直すと
// 押している途中の「取り消す」がクリックを取りこぼし、キーボードのフォーカスも失われるため。

import * as dom from '../../../../base/browser/dom.js';
import { StandardKeyboardEvent } from '../../../../base/browser/keyboardEvent.js';
import { getDefaultHoverDelegate } from '../../../../base/browser/ui/hover/hoverDelegateFactory.js';
import { onUnexpectedError } from '../../../../base/common/errors.js';
import { Codicon } from '../../../../base/common/codicons.js';
import { KeyCode } from '../../../../base/common/keyCodes.js';
import { Disposable, DisposableStore } from '../../../../base/common/lifecycle.js';
import { ThemeIcon } from '../../../../base/common/themables.js';
import { localize } from '../../../../nls.js';
import { ByteSize } from '../../../../platform/files/common/files.js';
import { IHoverService } from '../../../../platform/hover/browser/hover.js';
import { ILayoutService } from '../../../../platform/layout/browser/layoutService.js';
import { paradisSanitizeDisplayText } from '../../agentBrowser/common/paradisAgentBrowserTabs.js';
import { IParadisBrowserProfilesService } from '../../browserProfiles/electron-browser/paradisBrowserProfilesService.js';
import { IParadisBrowserDownloadItem } from '../common/paradisBrowserDownloads.js';
import { IParadisBrowserDownloadsService } from './paradisBrowserDownloadsService.js';

const $ = dom.$;

/** 一覧の幅。狭いウィンドウでは左右をクランプして内側に収める。 */
const POPOVER_WIDTH = 340;
/** ボタンとの縦の隙間。 */
const ANCHOR_GAP = 4;
/** コンテナ端との最小マージン。 */
const EDGE_MARGIN = 8;
/** ファイル名の表示上の最大文字数（長いものは CSS で省略するが、ホバーの文言もこれで抑える）。 */
const FILENAME_MAX_LENGTH = 200;

/** 行の見た目を決める値。これが変わったときだけ行を作り直す（進み具合だけの変化では作り直さない）。 */
function rowShape(item: IParadisBrowserDownloadItem, canOpen: boolean): string {
	return `${item.state}|${canOpen}|${item.filename}|${item.totalBytes > 0}`;
}

interface IRenderedRow {
	readonly element: HTMLElement;
	readonly shape: string;
	readonly store: DisposableStore;
	/** 進行中の行だけにある、書き換える部分。 */
	readonly barFill?: HTMLElement;
	readonly status: HTMLElement;
	/** 行の中のボタン（Tab の巡回とフォーカスの復元に使う）。キーは操作の種類。 */
	readonly buttons: Map<string, HTMLButtonElement>;
}

export class ParadisBrowserDownloadsPopover extends Disposable {

	private readonly _element: HTMLElement;
	private readonly _list: HTMLElement;
	private readonly _message: HTMLElement;
	private readonly _clearButton: HTMLButtonElement;
	private readonly _container: HTMLElement;
	/** Tab で巡回するヘッダーのボタン。 */
	private readonly _headerButtons: HTMLButtonElement[] = [];
	/** id → 描いている行。一覧と同じ順に並べる。 */
	private readonly _rows = new Map<string, IRenderedRow>();
	private _emptyElement: HTMLElement | undefined;
	private _disposed = false;

	constructor(
		private readonly _anchor: HTMLElement | undefined,
		private readonly _onDidClose: () => void,
		@IParadisBrowserDownloadsService private readonly _downloads: IParadisBrowserDownloadsService,
		@IParadisBrowserProfilesService private readonly _profiles: IParadisBrowserProfilesService,
		@IHoverService private readonly _hoverService: IHoverService,
		@ILayoutService layoutService: ILayoutService,
	) {
		super();

		this._container = _anchor ? layoutService.getContainer(dom.getWindow(_anchor)) : layoutService.activeContainer;
		this._element = $('.paradis-browser-downloads-popover');
		this._element.tabIndex = -1;
		this._element.setAttribute('role', 'dialog');
		this._element.setAttribute('aria-label', localize('paradis.browserDownloads.popover.label', "ダウンロード"));

		const header = dom.append(this._element, $('.pbd-header'));
		dom.append(header, $('.pbd-title')).textContent = localize('paradis.browserDownloads.popover.title', "ダウンロード");
		const openFolder = dom.append(header, $<HTMLButtonElement>('button.pbd-link'));
		openFolder.textContent = localize('paradis.browserDownloads.openFolder', "フォルダを開く");
		this._headerButtons.push(openFolder);
		this._register(dom.addDisposableListener(openFolder, dom.EventType.CLICK, () => this._run(
			() => this._downloads.openDownloadsFolder(),
			localize('paradis.browserDownloads.openFolderFailed', "保存先のフォルダが見つかりませんでした。自動保存をオフにしている場合は、各ファイルの「フォルダで表示」を使ってください。"),
		)));
		this._clearButton = this._iconButton(header, Codicon.clearAll, localize('paradis.browserDownloads.clearFinished', "終わったものを一覧から消す"), () => this._downloads.clearFinished(), this._store);
		this._headerButtons.push(this._clearButton);

		// 操作が効かなかったときの知らせ（通知のトーストは内蔵ブラウザの裏に隠れるので、一覧の中に出す）。
		this._message = dom.append(this._element, $('.pbd-message'));
		this._message.setAttribute('role', 'status');
		this._message.hidden = true;

		this._list = dom.append(this._element, $('.pbd-list'));
		this._list.setAttribute('role', 'list');

		this._render();
		this._register(this._downloads.onDidChange(() => this._render()));
		this._register(this._profiles.onDidChangeProfiles(() => this._render()));

		this._container.appendChild(this._element);
		this._anchor?.setAttribute('aria-expanded', 'true');
		this._layout();
		this._registerListeners();
		this._element.focus();
	}

	/** この一覧を出しているウィンドウ。 */
	get targetWindow(): Window {
		return dom.getWindow(this._container);
	}

	/**
	 * 「開く」を出してよいか。開いても表示されるだけの種類で、エージェントのタブから落ちてきたもの
	 * （Agent スコープ、エージェントが作りユーザーがまだ使っていないプロファイル）でないこと。
	 */
	private _canOpen(item: IParadisBrowserDownloadItem): boolean {
		if (!item.openable || item.fromAgentSession) {
			return false;
		}
		if (item.profileId) {
			return !this._profiles.list().find(profile => profile.id === item.profileId)?.createdByAgent;
		}
		return true;
	}

	private _render(): void {
		if (this._disposed) {
			return;
		}
		const items = this._downloads.items;
		this._clearButton.disabled = !items.some(item => item.state !== 'progressing');

		if (items.length === 0) {
			for (const row of this._rows.values()) {
				row.store.dispose();
				row.element.remove();
			}
			this._rows.clear();
			if (!this._emptyElement) {
				this._emptyElement = dom.append(this._list, $('.pbd-empty'));
				this._emptyElement.textContent = localize('paradis.browserDownloads.empty', "内蔵ブラウザでダウンロードしたファイルはまだありません。");
			}
			return;
		}
		this._emptyElement?.remove();
		this._emptyElement = undefined;

		// 作り直す行のボタンにフォーカスがあったら、作り直した後に同じ操作のボタンへ戻す。
		const focused = this._focusedRowButton();

		const seen = new Set<string>();
		let previous: HTMLElement | undefined;
		for (const item of items) {
			seen.add(item.id);
			const canOpen = this._canOpen(item);
			const shape = rowShape(item, canOpen);
			let row = this._rows.get(item.id);
			if (row && row.shape !== shape) {
				row.store.dispose();
				row.element.remove();
				row = undefined;
			}
			if (!row) {
				row = this._createRow(item, canOpen, shape);
				this._rows.set(item.id, row);
			}
			this._updateRow(row, item, canOpen);
			// 並びを一覧の順に合わせる（新しいものが先頭）。既に正しい位置なら動かさない。
			const expectedNext = previous ? previous.nextSibling : this._list.firstChild;
			if (expectedNext !== row.element) {
				this._list.insertBefore(row.element, expectedNext);
			}
			previous = row.element;
		}
		for (const [id, row] of [...this._rows]) {
			if (!seen.has(id)) {
				row.store.dispose();
				row.element.remove();
				this._rows.delete(id);
			}
		}

		if (focused && !dom.isAncestorOfActiveElement(this._element)) {
			const button = this._rows.get(focused.id)?.buttons.get(focused.action) ?? this._rows.get(focused.id)?.buttons.values().next().value;
			(button ?? this._element).focus();
		}
		// 開いている間に届いた完了も、見えているので「未確認」にしない。
		this._downloads.markSeen();
	}

	private _focusedRowButton(): { readonly id: string; readonly action: string } | undefined {
		for (const [id, row] of this._rows) {
			for (const [action, button] of row.buttons) {
				if (dom.isActiveElement(button)) {
					return { id, action };
				}
			}
		}
		return undefined;
	}

	private _createRow(item: IParadisBrowserDownloadItem, canOpen: boolean, shape: string): IRenderedRow {
		const store = new DisposableStore();
		const buttons = new Map<string, HTMLButtonElement>();
		const element = $('.pbd-row');
		element.setAttribute('role', 'listitem');
		element.classList.add(`is-${item.state}`);

		const icon = item.state === 'interrupted'
			? Codicon.error
			: canOpen ? Codicon.file : Codicon.fileBinary;
		dom.append(element, $(`span.pbd-icon${ThemeIcon.asCSSSelector(icon)}`));

		const main = dom.append(element, $('.pbd-main'));
		const name = dom.append(main, $('.pbd-name'));
		// ファイル名はサイトが決める。双方向制御文字（U+202E など）で拡張子を偽装できないよう、表示前に落とす。
		name.textContent = paradisSanitizeDisplayText(item.filename, FILENAME_MAX_LENGTH) ?? item.filename;
		const tooltip = paradisSanitizeDisplayText(item.savePath || item.url, 1000);
		if (tooltip) {
			store.add(this._hoverService.setupManagedHover(getDefaultHoverDelegate('element'), name, tooltip));
		}
		let barFill: HTMLElement | undefined;
		if (item.state === 'progressing') {
			const bar = dom.append(main, $('.pbd-bar'));
			barFill = dom.append(bar, $('.pbd-bar-fill'));
			bar.classList.toggle('is-indeterminate', item.totalBytes <= 0);
		}
		const status = dom.append(main, $('.pbd-status'));

		const actions = dom.append(element, $('.pbd-actions'));
		const addIcon = (action: string, codicon: ThemeIcon, label: string, run: () => Promise<unknown>, failure?: string) => {
			buttons.set(action, this._iconButton(actions, codicon, label, run, store, failure));
		};
		switch (item.state) {
			case 'progressing':
				addIcon('cancel', Codicon.close, localize('paradis.browserDownloads.cancel', "取り消す"), () => this._downloads.cancel(item.id));
				break;
			case 'completed':
				addIcon('reveal', Codicon.folderOpened, localize('paradis.browserDownloads.showInFolder', "フォルダで表示"), () => this._downloads.showInFolder(item.id), localize('paradis.browserDownloads.missing', "ファイルが見つかりませんでした。移動または削除された可能性があります。"));
				if (canOpen) {
					const open = dom.append(actions, $<HTMLButtonElement>('button.pbd-open'));
					open.textContent = localize('paradis.browserDownloads.open', "開く");
					buttons.set('open', open);
					store.add(dom.addDisposableListener(open, dom.EventType.CLICK, () => this._run(
						() => this._downloads.open(item.id),
						localize('paradis.browserDownloads.missing', "ファイルが見つかりませんでした。移動または削除された可能性があります。"),
					)));
				}
				addIcon('remove', Codicon.close, localize('paradis.browserDownloads.remove', "一覧から消す"), () => this._downloads.remove(item.id));
				break;
			default:
				addIcon('remove', Codicon.close, localize('paradis.browserDownloads.remove', "一覧から消す"), () => this._downloads.remove(item.id));
				break;
		}
		return { element, shape, store, barFill, status, buttons };
	}

	/** 進み具合と文言だけを書き換える（通知のたびに呼ばれる）。 */
	private _updateRow(row: IRenderedRow, item: IParadisBrowserDownloadItem, canOpen: boolean): void {
		if (row.barFill && item.totalBytes > 0) {
			row.barFill.style.width = `${Math.min(100, Math.round(item.receivedBytes / item.totalBytes * 100))}%`;
		}
		const text = paradisDescribeDownload(item, canOpen);
		if (row.status.textContent !== text) {
			row.status.textContent = text;
		}
	}

	private _iconButton(parent: HTMLElement, icon: ThemeIcon, label: string, run: () => Promise<unknown>, store: DisposableStore, failure?: string): HTMLButtonElement {
		const button = dom.append(parent, $<HTMLButtonElement>(`button.pbd-icon-button${ThemeIcon.asCSSSelector(icon)}`));
		button.setAttribute('aria-label', label);
		store.add(this._hoverService.setupManagedHover(getDefaultHoverDelegate('element'), button, label));
		store.add(dom.addDisposableListener(button, dom.EventType.CLICK, () => this._run(run, failure)));
		return button;
	}

	/** 操作を main へ頼む。false が返ったら（ファイルが無いなど）一覧の中に理由を出す。 */
	private _run(run: () => Promise<unknown>, failure?: string): void {
		this._message.hidden = true;
		run().then(result => {
			if (result === false && failure && !this._disposed) {
				this._message.textContent = failure;
				this._message.hidden = false;
			}
		}, onUnexpectedError);
	}

	private _layout(): void {
		const containerPosition = dom.getDomNodePagePosition(this._container);
		const width = Math.min(POPOVER_WIDTH, Math.max(200, containerPosition.width - EDGE_MARGIN * 2));
		this._element.style.width = `${width}px`;

		if (!this._anchor) {
			// コマンドパレットから開いたときなど、ボタンが見えていない場合はウィンドウの右上に出す。
			this._element.style.top = `${EDGE_MARGIN * 5}px`;
			this._element.style.left = `${Math.max(EDGE_MARGIN, containerPosition.width - width - EDGE_MARGIN)}px`;
			return;
		}

		const anchorPosition = dom.getDomNodePagePosition(this._anchor);
		const anchorBottom = anchorPosition.top - containerPosition.top + anchorPosition.height;
		this._element.style.maxHeight = `${Math.max(120, containerPosition.height - anchorBottom - ANCHOR_GAP - EDGE_MARGIN)}px`;
		// ボタンの右端に一覧の右端を揃える（Chrome と同じ）。
		const anchorRight = anchorPosition.left - containerPosition.left + anchorPosition.width;
		const left = Math.min(
			Math.max(EDGE_MARGIN, anchorRight - width),
			Math.max(EDGE_MARGIN, containerPosition.width - width - EDGE_MARGIN),
		);
		this._element.style.top = `${Math.round(anchorBottom + ANCHOR_GAP)}px`;
		this._element.style.left = `${Math.round(left)}px`;
	}

	private _registerListeners(): void {
		const targetWindow = dom.getWindow(this._container);

		this._register(dom.addDisposableListener(this._element, dom.EventType.KEY_DOWN, event => {
			const keyboardEvent = new StandardKeyboardEvent(event);
			if (keyboardEvent.keyCode === KeyCode.Escape) {
				keyboardEvent.preventDefault();
				keyboardEvent.stopPropagation();
				this.close();
			} else if (keyboardEvent.keyCode === KeyCode.Tab) {
				// フォーカストラップ。外へ逃がすと開いたまま別の場所へフォーカスが移り、閉じ方が分からなくなる。
				this._trapTab(keyboardEvent.shiftKey, event);
			}
		}));

		// フォーカスが一覧の外へ出たら閉じる（キー操作でコマンドパレットやスペース切替へ移ったとき）。
		// ボタンへ戻るのは開き直しの操作なので閉じない。
		this._register(dom.addDisposableListener(this._element, dom.EventType.FOCUS_OUT, event => {
			const next = event.relatedTarget as Node | null;
			if (next && !this._element.contains(next) && !this._anchor?.contains(next)) {
				this.close();
			}
		}));

		// 外側クリック。capture で拾い、ページ側の要素が伝播を止めても閉じられるようにする。
		// `instanceof Node` は補助ウィンドウで realm が違って false になり得るので contains() だけで見る。
		this._register(dom.addDisposableListener(targetWindow, dom.EventType.MOUSE_DOWN, event => {
			const target = event.target as Node | null;
			if (target && (this._element.contains(target) || this._anchor?.contains(target))) {
				return;
			}
			this.close();
		}, true));
		this._register(dom.addDisposableListener(targetWindow, dom.EventType.RESIZE, () => this.close()));
		this._register(dom.addDisposableListener(targetWindow, dom.EventType.BLUR, () => this.close()));
	}

	private _trapTab(backwards: boolean, event: KeyboardEvent): void {
		const focusable = [...this._headerButtons, ...[...this._rows.values()].flatMap(row => [...row.buttons.values()])].filter(button => !button.disabled);
		if (focusable.length === 0) {
			event.preventDefault();
			return;
		}
		const index = focusable.findIndex(element => dom.isActiveElement(element));
		const next = backwards
			? (index <= 0 ? focusable.length - 1 : index - 1)
			: (index < 0 || index === focusable.length - 1 ? 0 : index + 1);
		event.preventDefault();
		focusable[next].focus();
	}

	close(): void {
		this.dispose();
	}

	override dispose(): void {
		if (this._disposed) {
			return;
		}
		this._disposed = true;
		for (const row of this._rows.values()) {
			row.store.dispose();
		}
		this._rows.clear();
		this._anchor?.setAttribute('aria-expanded', 'false');
		if (this._anchor?.isConnected && dom.isAncestorOfActiveElement(this._element)) {
			this._anchor.focus();
		}
		this._element.remove();
		super.dispose();
		this._onDidClose();
	}
}

/** 行の2行目（大きさ・状態）。 */
export function paradisDescribeDownload(item: IParadisBrowserDownloadItem, canOpen: boolean): string {
	switch (item.state) {
		case 'progressing':
			return item.totalBytes > 0
				? localize('paradis.browserDownloads.progress', "{0} / {1}", ByteSize.formatSize(item.receivedBytes), ByteSize.formatSize(item.totalBytes))
				: ByteSize.formatSize(item.receivedBytes);
		case 'completed':
			if (item.fromAgentSession) {
				return localize('paradis.browserDownloads.completedFromAgent', "完了 · エージェントのタブから · {0}", ByteSize.formatSize(item.receivedBytes));
			}
			return canOpen
				? localize('paradis.browserDownloads.completed', "完了 · {0}", ByteSize.formatSize(item.receivedBytes))
				: localize('paradis.browserDownloads.completedFolderOnly', "完了 · フォルダから開く種類 · {0}", ByteSize.formatSize(item.receivedBytes));
		case 'cancelled':
			return localize('paradis.browserDownloads.cancelled', "取り消しました");
		case 'interrupted':
			return localize('paradis.browserDownloads.interrupted', "失敗しました");
	}
}
