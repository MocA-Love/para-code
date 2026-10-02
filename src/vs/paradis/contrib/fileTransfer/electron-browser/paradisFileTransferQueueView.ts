/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-PATCH/PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

// 2 画面のファイル転送の下の「転送」の待ち行列（案C）。項目ごとに進み具合・速度・残り時間・取り消し・
// 再試行を出す。畳むと見出しの 1 行（28px）だけになり、狭いときは進行中の 1 件の要約を見出しに出す。
//
// 進み具合の通知は約 100ms ごとに来る。行の DOM は項目の id ごとに使い回し、数字と幅だけを書き換える
// （作り直すと、押そうとした「取り消し」「再試行」のボタンが押す前に消えてしまう）。

import * as dom from '../../../../base/browser/dom.js';
import { Codicon } from '../../../../base/common/codicons.js';
import { Emitter } from '../../../../base/common/event.js';
import { Disposable, DisposableMap, DisposableStore } from '../../../../base/common/lifecycle.js';
import { ThemeIcon } from '../../../../base/common/themables.js';
import { localize } from '../../../../nls.js';
import { IStorageService, StorageScope, StorageTarget } from '../../../../platform/storage/common/storage.js';
import { IParadisTransferItem, ParadisTransferQueue, ParadisTransferState } from '../common/paradisFileTransferQueue.js';
import { paradisFormatRemaining, paradisFormatSize, paradisFormatSpeed } from '../common/paradisFileTransferListing.js';

const $ = dom.$;

/** 畳んでいるかの保存キー（プロファイルごと）。 */
const COLLAPSED_STORAGE_KEY = 'paradis.fileTransfer.queueCollapsed';
const HEADER_HEIGHT = 28;
const ROW_HEIGHT = 26;
/** 開いているときに見せる行の上限（超えたら中でスクロール）。 */
const MAX_VISIBLE_ROWS = 5;

/** 見出しの要約（全体の進み具合）。 */
export function paradisQueueSummaryText(queue: ParadisTransferQueue): string {
	const summary = queue.getSummary();
	const preparing = summary.preparing > 0 ? [localize('paradis.fileTransfer.queue.preparing', "準備中…")] : [];
	if (summary.active === 0) {
		const rest = summary.failed > 0
			? localize('paradis.fileTransfer.queue.failedOnly', "{0} 件失敗", summary.failed)
			: preparing.length ? undefined : localize('paradis.fileTransfer.queue.none', "なし");
		return [...preparing, ...(rest ? [rest] : [])].join(' · ');
	}
	const parts = [...preparing, localize('paradis.fileTransfer.queue.active', "{0} 件進行中", summary.active)];
	if (summary.percent !== undefined) {
		parts.push(localize('paradis.fileTransfer.queue.percent', "全体 {0}%", summary.percent));
	}
	if (summary.remainingSeconds !== undefined) {
		parts.push(paradisFormatRemaining(summary.remainingSeconds));
	}
	if (summary.failed > 0) {
		parts.push(localize('paradis.fileTransfer.queue.failed', "{0} 件失敗", summary.failed));
	}
	return parts.join(' · ');
}

/** 行の「済んだ量」の文（状態ごと）。 */
export function paradisQueueDoneText(item: IParadisTransferItem): string {
	const skipped = (item.skipped > 0 ? ' · ' + localize('paradis.fileTransfer.queue.skipped', "{0} 件を飛ばしました", item.skipped) : '')
		// 古い接続先などで一時ファイルを使えず、送り先を直接書き換えている（書いている間と失敗したときに出す）
		+ (item.writesInPlace && item.state !== 'done' ? ' · ' + localize('paradis.fileTransfer.queue.inPlace', "送り先を直接書き換えます（途中で失敗すると元に戻りません）") : '');
	switch (item.state) {
		case 'waiting':
			return localize('paradis.fileTransfer.queue.waiting', "待機中");
		case 'running':
			if (item.totalBytes === undefined) {
				return localize('paradis.fileTransfer.queue.scanning', "中身を数えています…");
			}
			return (item.isDirectory
				? localize('paradis.fileTransfer.queue.files', "{0} / {1} ファイル", item.doneFiles, item.totalFiles ?? 0)
				: `${paradisFormatSize(item.doneBytes)} / ${paradisFormatSize(item.totalBytes)}`) + skipped;
		case 'done':
			return (item.isDirectory
				? localize('paradis.fileTransfer.queue.doneFiles', "{0} ファイル", item.doneFiles)
				: paradisFormatSize(item.totalBytes ?? item.doneBytes)) + skipped;
		case 'error':
			return (item.error?.message ?? '') + skipped;
		case 'cancelled':
			return localize('paradis.fileTransfer.queue.cancelled', "取り消しました");
	}
}

interface IQueueRowCallbacks {
	cancel(item: IParadisTransferItem): void;
	retry(item: IParadisTransferItem): void;
	dismiss(item: IParadisTransferItem): void;
}

/** 待ち行列の 1 行。状態が変わったときだけボタンを作り直し、進み具合は文字と幅だけ書き換える。 */
class ParadisQueueRow extends Disposable {

	readonly element: HTMLElement;
	private readonly icon: HTMLElement;
	private readonly name: HTMLElement;
	private readonly where: HTMLElement;
	private readonly bar: HTMLElement;
	private readonly fill: HTMLElement;
	private readonly done: HTMLElement;
	private readonly speed: HTMLElement;
	private readonly eta: HTMLElement;
	private readonly actions: HTMLElement;
	private readonly actionStore = this._register(new DisposableStore());
	private renderedState: ParadisTransferState | undefined;
	private item: IParadisTransferItem;

	constructor(item: IParadisTransferItem, private readonly callbacks: IQueueRowCallbacks) {
		super();
		this.item = item;
		this.element = $('.para-ft-qr');
		this.element.setAttribute('role', 'listitem');
		this.icon = dom.append(this.element, $('span.para-ft-qicon'));
		this.name = dom.append(this.element, $('.para-ft-qname'));
		this.where = $('span.para-ft-qwhere');
		this.bar = dom.append(this.element, $('.para-ft-qbar'));
		this.bar.setAttribute('role', 'progressbar');
		this.bar.setAttribute('aria-valuemin', '0');
		this.bar.setAttribute('aria-valuemax', '100');
		this.fill = dom.append(this.bar, $('i'));
		this.done = dom.append(this.element, $('.para-ft-qm.para-ft-qdone'));
		this.speed = dom.append(this.element, $('.para-ft-qm'));
		this.eta = dom.append(this.element, $('.para-ft-qm'));
		this.actions = dom.append(this.element, $('.para-ft-qactions'));
	}

	update(item: IParadisTransferItem): void {
		this.item = item;
		if (this.renderedState !== item.state) {
			this.renderedState = item.state;
			this.element.className = `para-ft-qr ${item.state}`;
			this.icon.className = `para-ft-qicon ${ThemeIcon.asClassName(this.iconFor(item))}`;
			this.renderActions(item.state);
		}
		const arrow = item.direction === 'toRemote' ? '→' : '←';
		const targetFolder = item.target.path.slice(0, item.target.path.lastIndexOf('/') + 1);
		this.name.textContent = item.name + (item.isDirectory ? '/' : '');
		this.where.textContent = ` ${arrow} ${item.targetLabel}:${targetFolder}`;
		this.name.appendChild(this.where);
		this.name.title = `${item.source.path} ${arrow} ${item.targetLabel}:${item.target.path}`;

		const percent = item.state === 'done' || item.state === 'error' ? 100
			: item.totalBytes ? Math.floor(item.doneBytes / item.totalBytes * 100)
				: item.totalFiles ? Math.floor(item.doneFiles / item.totalFiles * 100) : 0;
		this.fill.style.width = `${percent}%`;
		this.bar.setAttribute('aria-valuenow', String(percent));

		this.done.textContent = paradisQueueDoneText(item);
		this.done.title = item.state === 'error' ? this.done.textContent : '';
		this.done.classList.toggle('error', item.state === 'error');
		this.speed.textContent = item.state === 'running' && item.bytesPerSecond !== undefined ? paradisFormatSpeed(item.bytesPerSecond) : '';
		this.eta.textContent = item.state === 'running' && item.remainingSeconds !== undefined
			? paradisFormatRemaining(item.remainingSeconds)
			: item.state === 'done' ? localize('paradis.fileTransfer.queue.done', "完了") : '';
	}

	private iconFor(item: IParadisTransferItem): ThemeIcon {
		switch (item.state) {
			case 'done': return Codicon.check;
			case 'error': return item.error?.kind === 'disconnected' ? Codicon.debugDisconnect : Codicon.error;
			case 'cancelled': return Codicon.circleSlash;
			case 'waiting': return Codicon.ellipsis;
			default: return item.direction === 'toRemote' ? Codicon.cloudUpload : Codicon.cloudDownload;
		}
	}

	private renderActions(state: ParadisTransferState): void {
		this.actionStore.clear();
		dom.clearNode(this.actions);
		const action = (icon: ThemeIcon, label: string, run: () => void) => {
			const button = dom.append(this.actions, $<HTMLButtonElement>('button.para-ft-qbutton'));
			button.type = 'button';
			button.title = label;
			button.setAttribute('aria-label', `${label}: ${this.item.name}`);
			dom.append(button, $(`span${ThemeIcon.asCSSSelector(icon)}`));
			// 押したときの項目は今の状態で引く（行は使い回すので、作ったときの項目を掴まない）
			this.actionStore.add(dom.addDisposableListener(button, 'click', () => run()));
		};
		if (state === 'error' || state === 'cancelled') {
			action(Codicon.debugRestart, localize('paradis.fileTransfer.queue.retry', "再試行"), () => this.callbacks.retry(this.item));
			action(Codicon.close, localize('paradis.fileTransfer.queue.dismiss', "消す"), () => this.callbacks.dismiss(this.item));
		} else if (state === 'waiting' || state === 'running') {
			action(Codicon.close, localize('paradis.fileTransfer.queue.cancel', "取り消し"), () => this.callbacks.cancel(this.item));
		}
	}
}

export class ParadisFileTransferQueueView extends Disposable {

	readonly element: HTMLElement;

	private readonly _onDidChangeHeight = this._register(new Emitter<void>());
	readonly onDidChangeHeight = this._onDidChangeHeight.event;

	private readonly summary: HTMLElement;
	private readonly toggleButton: HTMLButtonElement;
	private readonly rows: HTMLElement;
	private readonly empty: HTMLElement;
	private readonly rowViews = this._register(new DisposableMap<number, ParadisQueueRow>());
	private collapsed: boolean;
	private narrow = false;
	private lastHeight = -1;
	private renderScheduled = false;
	private lastActive = 0;

	constructor(
		private readonly queue: ParadisTransferQueue,
		private readonly retry: (item: IParadisTransferItem) => void,
		@IStorageService private readonly storageService: IStorageService,
	) {
		super();
		this.collapsed = storageService.getBoolean(COLLAPSED_STORAGE_KEY, StorageScope.PROFILE, true);

		this.element = $('.para-ft-queue');
		this.element.setAttribute('role', 'region');
		this.element.setAttribute('aria-label', localize('paradis.fileTransfer.queue.aria', "転送の待ち行列"));
		const header = dom.append(this.element, $('.para-ft-qh'));
		dom.append(header, $(`span${ThemeIcon.asCSSSelector(Codicon.arrowSwap)}`));
		dom.append(header, $('span.para-ft-qh-title')).textContent = localize('paradis.fileTransfer.queue.title', "転送");
		this.summary = dom.append(header, $('span.para-ft-qh-summary'));
		this.summary.setAttribute('aria-live', 'polite');
		const tools = dom.append(header, $('.para-ft-qh-tools'));
		this.toolButton(tools, Codicon.debugStop, localize('paradis.fileTransfer.queue.cancelAll', "すべて取り消す"), () => this.queue.cancelAll());
		this.toolButton(tools, Codicon.clearAll, localize('paradis.fileTransfer.queue.clear', "完了したものを消す"), () => this.queue.clearFinished());
		this.toggleButton = this.toolButton(tools, Codicon.chevronUp, '', () => this.setCollapsed(!this.collapsed));
		this._register(dom.addDisposableListener(header, 'dblclick', e => {
			if (!dom.isAncestor(e.target as Node, tools)) {
				this.setCollapsed(!this.collapsed);
			}
		}));
		this.rows = dom.append(this.element, $('.para-ft-qrows'));
		this.rows.setAttribute('role', 'list');
		this.rows.style.maxHeight = `${MAX_VISIBLE_ROWS * ROW_HEIGHT + 4}px`;
		this.empty = $('.para-ft-qempty');
		this.empty.textContent = localize('paradis.fileTransfer.queue.empty', "左右の間でドラッグするか、「操作」の「反対側へコピー」で転送を始めます。");

		this._register(queue.onDidChange(() => {
			// 転送が始まったら広げる（何も流れていない間は畳んでおき、一覧の縦を広く使う）
			const active = queue.getSummary().active;
			if (active > 0 && this.lastActive === 0 && this.collapsed) {
				this.collapsed = false;
			}
			this.lastActive = active;
			this.scheduleRender();
		}));
		this.render();
	}

	/** 今の高さ（エディタが表の高さを決めるのに使う）。 */
	get height(): number {
		if (this.collapsed || this.narrow) {
			return HEADER_HEIGHT + 1;
		}
		const rows = Math.min(MAX_VISIBLE_ROWS, Math.max(1, this.queue.items.length));
		return HEADER_HEIGHT + 1 + rows * ROW_HEIGHT + 4;
	}

	setNarrow(narrow: boolean): void {
		if (this.narrow !== narrow) {
			this.narrow = narrow;
			this.render();
		}
	}

	private setCollapsed(collapsed: boolean): void {
		this.collapsed = collapsed;
		this.storageService.store(COLLAPSED_STORAGE_KEY, collapsed, StorageScope.PROFILE, StorageTarget.USER);
		this.render();
	}

	private toolButton(parent: HTMLElement, icon: ThemeIcon, label: string, run: () => void): HTMLButtonElement {
		const button = dom.append(parent, $<HTMLButtonElement>('button.para-ft-qbutton'));
		button.type = 'button';
		if (label) {
			button.title = label;
			button.setAttribute('aria-label', label);
		}
		dom.append(button, $(`span${ThemeIcon.asCSSSelector(icon)}`));
		this._register(dom.addDisposableListener(button, 'click', e => {
			e.stopPropagation();
			run();
		}));
		return button;
	}

	private scheduleRender(): void {
		if (this.renderScheduled) {
			return;
		}
		this.renderScheduled = true;
		dom.getWindow(this.element).requestAnimationFrame(() => {
			this.renderScheduled = false;
			if (!this._store.isDisposed) {
				this.render();
			}
		});
	}

	private render(): void {
		const items = this.queue.items;
		const showRows = !this.collapsed && !this.narrow;
		this.element.classList.toggle('collapsed', !showRows);
		this.renderToggle();
		this.summary.textContent = this.summaryText(items, showRows);
		if (showRows) {
			this.renderRows(items);
		}
		const height = this.height;
		if (height !== this.lastHeight) {
			this.lastHeight = height;
			this._onDidChangeHeight.fire();
		}
	}

	private renderToggle(): void {
		const toggleIcon = this.toggleButton.firstElementChild as HTMLElement;
		toggleIcon.className = ThemeIcon.asClassName(this.collapsed ? Codicon.chevronUp : Codicon.chevronDown);
		const toggleLabel = this.collapsed ? localize('paradis.fileTransfer.queue.expand', "広げる") : localize('paradis.fileTransfer.queue.collapse', "畳む");
		this.toggleButton.title = toggleLabel;
		this.toggleButton.setAttribute('aria-label', toggleLabel);
		this.toggleButton.setAttribute('aria-expanded', String(!this.collapsed));
		dom.setVisibility(!this.narrow, this.toggleButton);
	}

	private summaryText(items: readonly IParadisTransferItem[], showRows: boolean): string {
		let summary = paradisQueueSummaryText(this.queue);
		// 狭いときと畳んでいるときは、進行中の 1 件を見出しに添える
		if (!showRows) {
			const running = items.find(item => item.state === 'running' && item.totalBytes);
			if (running && running.totalBytes) {
				summary += ` · ${running.name} ${Math.floor(running.doneBytes / running.totalBytes * 100)}%`;
			}
		}
		return summary;
	}

	/** 行を id で使い回す。消えた項目の行だけ外し、新しい項目の行だけ足す。 */
	private renderRows(items: readonly IParadisTransferItem[]): void {
		const ids = new Set(items.map(item => item.id));
		for (const id of [...this.rowViews.keys()]) {
			if (!ids.has(id)) {
				this.rowViews.get(id)?.element.remove();
				this.rowViews.deleteAndDispose(id);
			}
		}
		if (!items.length) {
			if (!this.empty.parentElement) {
				this.rows.appendChild(this.empty);
			}
			return;
		}
		this.empty.remove();
		let previous: HTMLElement | undefined;
		for (const item of items) {
			let row = this.rowViews.get(item.id);
			if (!row) {
				row = new ParadisQueueRow(item, {
					cancel: current => this.queue.cancel(current.id),
					retry: current => this.retry(current),
					dismiss: current => this.queue.dismiss(current.id),
				});
				this.rowViews.set(item.id, row);
			}
			row.update(item);
			// 並びは待ち行列の順に保つ（既にその位置にあれば DOM を動かさない）
			const expectedNext = previous ? previous.nextSibling : this.rows.firstChild;
			if (expectedNext !== row.element) {
				this.rows.insertBefore(row.element, expectedNext);
			}
			previous = row.element;
		}
	}
}
