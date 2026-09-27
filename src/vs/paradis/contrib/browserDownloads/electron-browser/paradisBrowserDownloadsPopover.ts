/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

// URL バー右のダウンロードボタンから開く一覧（q.html Q73 案B のモック「ダウンロード / フォルダを開く」）。
//
// 自前の DOM なので、内蔵ブラウザのネイティブビューの上に出すには overlayManager.ts の
// OVERLAY_DEFINITIONS に `paradis-browser-downloads-popover` を載せてある（載せないとページの裏に
// 隠れて何も見えない）。プロファイルのドロップダウン（paradisBrowserProfileDropdown.ts）と同じ作りで、
// 外側クリック・Esc・リサイズ・ウィンドウのフォーカス喪失で閉じ、閉じたらボタンへフォーカスを戻す。
//
// 実行ファイル（.app / .exe / .dmg / .pkg / .sh など）は「開く」を出さず「フォルダで表示」だけにする。
// main 側も同じ判定で開くのを断る（paradisBrowserDownloadsTracker.ts）。

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
import { IParadisBrowserDownloadItem } from '../common/paradisBrowserDownloads.js';
import { IParadisBrowserDownloadsService } from './paradisBrowserDownloadsService.js';

const $ = dom.$;

/** 一覧の幅。狭いウィンドウでは左右をクランプして内側に収める。 */
const POPOVER_WIDTH = 340;
/** ボタンとの縦の隙間。 */
const ANCHOR_GAP = 4;
/** コンテナ端との最小マージン。 */
const EDGE_MARGIN = 8;

export class ParadisBrowserDownloadsPopover extends Disposable {

	private readonly _element: HTMLElement;
	private readonly _list: HTMLElement;
	private readonly _clearButton: HTMLButtonElement;
	private readonly _container: HTMLElement;
	/** 行の描き直しのたびに作り直すホバーとリスナー。 */
	private readonly _rowStore = this._register(new DisposableStore());
	/** Tab で巡回するボタン。ヘッダーのものは固定、行のものは描き直しのたびに入れ替える。 */
	private readonly _headerButtons: HTMLButtonElement[] = [];
	private _rowButtons: HTMLButtonElement[] = [];
	private _disposed = false;

	constructor(
		private readonly _anchor: HTMLElement | undefined,
		private readonly _onDidClose: () => void,
		@IParadisBrowserDownloadsService private readonly _downloads: IParadisBrowserDownloadsService,
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
		this._register(dom.addDisposableListener(openFolder, dom.EventType.CLICK, () => this._run(() => this._downloads.openDownloadsFolder())));
		this._clearButton = this._iconButton(header, Codicon.clearAll, localize('paradis.browserDownloads.clearFinished', "終わったものを一覧から消す"), () => this._downloads.clearFinished(), this._store);
		this._headerButtons.push(this._clearButton);

		this._list = dom.append(this._element, $('.pbd-list'));
		this._list.setAttribute('role', 'list');

		this._render();
		this._register(this._downloads.onDidChange(() => this._render()));
		this._downloads.markSeen();

		this._container.appendChild(this._element);
		this._anchor?.setAttribute('aria-expanded', 'true');
		this._layout();
		this._registerListeners();
		this._element.focus();
	}

	private _render(): void {
		this._rowStore.clear();
		this._rowButtons = [];
		dom.clearNode(this._list);
		const items = this._downloads.items;
		this._clearButton.disabled = !items.some(item => item.state !== 'progressing');
		if (items.length === 0) {
			dom.append(this._list, $('.pbd-empty')).textContent = localize('paradis.browserDownloads.empty', "内蔵ブラウザでダウンロードしたファイルはまだありません。");
			return;
		}
		for (const item of items) {
			this._renderRow(item);
		}
		// 開いている間に届いた完了も、見えているので「未確認」にしない。
		this._downloads.markSeen();
	}

	private _renderRow(item: IParadisBrowserDownloadItem): void {
		const row = dom.append(this._list, $('.pbd-row'));
		row.setAttribute('role', 'listitem');
		row.classList.add(`is-${item.state}`);

		const icon = item.state === 'interrupted'
			? Codicon.error
			: item.executable ? Codicon.fileBinary : Codicon.file;
		dom.append(row, $(`span.pbd-icon${ThemeIcon.asCSSSelector(icon)}`));

		const main = dom.append(row, $('.pbd-main'));
		const name = dom.append(main, $('.pbd-name'));
		name.textContent = item.filename;
		const tooltip = item.savePath || item.url;
		if (tooltip) {
			this._rowStore.add(this._hoverService.setupManagedHover(getDefaultHoverDelegate('element'), name, tooltip));
		}
		if (item.state === 'progressing') {
			const bar = dom.append(main, $('.pbd-bar'));
			const fill = dom.append(bar, $('.pbd-bar-fill'));
			if (item.totalBytes > 0) {
				fill.style.width = `${Math.min(100, Math.round(item.receivedBytes / item.totalBytes * 100))}%`;
			} else {
				bar.classList.add('is-indeterminate');
			}
		}
		dom.append(main, $('.pbd-status')).textContent = paradisDescribeDownload(item);

		const actions = dom.append(row, $('.pbd-actions'));
		switch (item.state) {
			case 'progressing':
				this._iconButton(actions, Codicon.close, localize('paradis.browserDownloads.cancel', "取り消す"), () => this._downloads.cancel(item.id), this._rowStore);
				break;
			case 'completed':
				this._iconButton(actions, Codicon.folderOpened, localize('paradis.browserDownloads.showInFolder', "フォルダで表示"), () => this._downloads.showInFolder(item.id), this._rowStore);
				if (!item.executable) {
					const open = dom.append(actions, $<HTMLButtonElement>('button.pbd-open'));
					open.textContent = localize('paradis.browserDownloads.open', "開く");
					this._rowButtons.push(open);
					this._rowStore.add(dom.addDisposableListener(open, dom.EventType.CLICK, () => this._run(() => this._downloads.open(item.id))));
				}
				this._iconButton(actions, Codicon.close, localize('paradis.browserDownloads.remove', "一覧から消す"), () => this._downloads.remove(item.id), this._rowStore);
				break;
			default:
				this._iconButton(actions, Codicon.close, localize('paradis.browserDownloads.remove', "一覧から消す"), () => this._downloads.remove(item.id), this._rowStore);
				break;
		}
	}

	private _iconButton(parent: HTMLElement, icon: ThemeIcon, label: string, run: () => Promise<unknown>, store: DisposableStore): HTMLButtonElement {
		const button = dom.append(parent, $<HTMLButtonElement>(`button.pbd-icon-button${ThemeIcon.asCSSSelector(icon)}`));
		button.setAttribute('aria-label', label);
		store.add(this._hoverService.setupManagedHover(getDefaultHoverDelegate('element'), button, label));
		store.add(dom.addDisposableListener(button, dom.EventType.CLICK, () => this._run(run)));
		if (store === this._rowStore) {
			this._rowButtons.push(button);
		}
		return button;
	}

	private _run(run: () => Promise<unknown>): void {
		run().catch(onUnexpectedError);
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
		const focusable = [...this._headerButtons, ...this._rowButtons].filter(button => !button.disabled);
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
export function paradisDescribeDownload(item: IParadisBrowserDownloadItem): string {
	switch (item.state) {
		case 'progressing':
			return item.totalBytes > 0
				? localize('paradis.browserDownloads.progress', "{0} / {1}", ByteSize.formatSize(item.receivedBytes), ByteSize.formatSize(item.totalBytes))
				: ByteSize.formatSize(item.receivedBytes);
		case 'completed':
			return item.executable
				? localize('paradis.browserDownloads.completedExecutable', "完了 · 実行ファイル · {0}", ByteSize.formatSize(item.receivedBytes))
				: localize('paradis.browserDownloads.completed', "完了 · {0}", ByteSize.formatSize(item.receivedBytes));
		case 'cancelled':
			return localize('paradis.browserDownloads.cancelled', "取り消しました");
		case 'interrupted':
			return localize('paradis.browserDownloads.interrupted', "失敗しました");
	}
}
