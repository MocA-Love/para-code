/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-PATCH/PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import { $, addDisposableListener, append, EventType, getWindow, isHTMLElement } from '../../../../base/browser/dom.js';
import { IManagedHover } from '../../../../base/browser/ui/hover/hover.js';
import { getDefaultHoverDelegate } from '../../../../base/browser/ui/hover/hoverDelegateFactory.js';
import { onUnexpectedError } from '../../../../base/common/errors.js';
import { Emitter } from '../../../../base/common/event.js';
import { Disposable, DisposableStore } from '../../../../base/common/lifecycle.js';
import { localize } from '../../../../nls.js';
import { IHoverService } from '../../../../platform/hover/browser/hover.js';
import { ILogService } from '../../../../platform/log/common/log.js';
import { ParadisBrowserLiveModel } from './paradisBrowserLiveModel.js';
import { ParadisBrowserLiveThumbnail } from './paradisBrowserLiveThumbnail.js';
import {
	IParadisBrowserLiveEntry,
	IParadisBrowserLiveViewState,
	PARADIS_BROWSER_LIVE_MAX_COLUMNS,
	PARADIS_BROWSER_LIVE_MIN_COLUMNS,
	ParadisBrowserLiveCadence,
	ParadisBrowserLiveSort,
	paradisBrowserLiveDisplayTitle,
	paradisBrowserLiveDisplayUrl,
	paradisFilterBrowserLiveEntries,
	paradisSortBrowserLiveEntries,
} from '../common/paradisBrowserLiveWindow.js';

interface ITile {
	readonly root: HTMLElement;
	/** サムネイルであり、「このタブを開く」ボタンでもある領域。 */
	readonly shot: HTMLElement;
	/** 更新が止まっていることを示す印。 */
	readonly pausedMark: HTMLElement;
	readonly faviconImage: HTMLImageElement;
	readonly faviconFallback: HTMLElement;
	readonly title: HTMLElement;
	readonly titleHover: IManagedHover;
	readonly url: HTMLElement;
	readonly tags: HTMLElement;
	readonly thumbnail: ParadisBrowserLiveThumbnail;
	/** このタイルが握っている購読すべて (サムネイルもここに入る)。 */
	readonly disposables: DisposableStore;
	/** 一覧の中でこのタイルが見えているか (画面外ではサムネの取得を止める)。 */
	inViewport: boolean;
	entry: IParadisBrowserLiveEntry;
}

/** 「並び: タブの並び」のように現在値をラベルへ出すボタン。押すたび次の値へ回る。 */
interface IValueButton {
	readonly root: HTMLElement;
	readonly key: HTMLElement;
	readonly value: HTMLElement;
}

const SORT_LABELS: Record<ParadisBrowserLiveSort, string> = {
	editor: localize('paradis.browserLive.sort.editor', "タブの並び"),
	title: localize('paradis.browserLive.sort.title', "タイトル順"),
	shared: localize('paradis.browserLive.sort.shared', "共有中を先頭"),
};

const CADENCE_LABELS: Record<ParadisBrowserLiveCadence, string> = {
	off: localize('paradis.browserLive.cadence.off', "止める"),
	normal: localize('paradis.browserLive.cadence.normal', "ふつう"),
	smooth: localize('paradis.browserLive.cadence.smooth', "なめらか"),
};

const SORT_ORDER: readonly ParadisBrowserLiveSort[] = ['editor', 'title', 'shared'];
const CADENCE_ORDER: readonly ParadisBrowserLiveCadence[] = ['off', 'normal', 'smooth'];

/**
 * 最初の撮影をタイルごとにずらす幅 (ms) と、その合計の上限。
 *
 * ウィンドウを開いた瞬間に全タイルが一斉に撮りに行くと、撮影がビューごとに直列化されている
 * ぶん最後のタイルほど待たされ、エージェント自身のスクリーンショットまで巻き添えになる。
 */
const FIRST_CAPTURE_STAGGER = 120;
const FIRST_CAPTURE_STAGGER_MAX = 2000;

/**
 * ブラウザ一覧ウィンドウの中身 (ツールバー + タイルの壁)。
 *
 * タイルは再描画のたびに作り直さず、ビューIDをキーに使い回す。タイルを捨てると
 * サムネイル (と直前のフレーム) も一緒に捨てることになり、状態が変わるたびに
 * 灰色の箱へ戻ってしまうため。
 */
export class ParadisBrowserLiveWindowView extends Disposable {

	private readonly _onDidChangeViewState = this._register(new Emitter<void>());
	readonly onDidChangeViewState = this._onDidChangeViewState.event;

	private readonly tiles = new Map<string, ITile>();
	/** IntersectionObserver の対象要素からビューIDを引くための逆引き。 */
	private readonly viewIdsByElement = new Map<Element, string>();

	private readonly scroll: HTMLElement;
	private readonly wall: HTMLElement;
	private readonly allChip: HTMLElement;
	private readonly sharedChip: HTMLElement;
	private readonly sharedChipCount: HTMLElement;
	private readonly allChipCount: HTMLElement;
	private readonly sortButton: IValueButton;
	private readonly cadenceButton: IValueButton;
	private readonly columnsButton: IValueButton;
	/** 空表示。タイルと違って毎回作り直すので参照を持って消す。 */
	private emptyElement: HTMLElement | undefined;

	private intersectionObserver: IntersectionObserver | undefined;
	/** 最初の描画が済んだか。最初の一斉撮影だけ時間をずらすために見る。 */
	private renderedOnce = false;
	/** ウィンドウ自体が見えているか。隠れている間はサムネを撮らない。 */
	private windowVisible = true;

	constructor(
		container: HTMLElement,
		private readonly model: ParadisBrowserLiveModel,
		private readonly viewState: IParadisBrowserLiveViewState,
		/**
		 * この aux window を透過で開けたか (Windows では常に false)。auxiliary window の
		 * コンテナ要素はメインウィンドウの class を自動でミラーし続けるため、そこへ独自
		 * クラスを付けても次の同期で消される。代わりに自分が握る root へ立てる。
		 */
		transparencyActive: boolean,
		@IHoverService private readonly hoverService: IHoverService,
		@ILogService private readonly logService: ILogService,
	) {
		super();

		const root = append(container, $('.paradis-browser-live-window'));
		root.classList.toggle('paradis-browser-live-transparent', transparencyActive);

		// --- ツールバー -------------------------------------------------------------------
		const toolbar = append(root, $('.paradis-browser-live-toolbar'));
		this.allChip = append(toolbar, $('button.paradis-browser-live-chip'));
		append(this.allChip, $('span.label')).textContent = localize('paradis.browserLive.filter.all', "すべて");
		this.allChipCount = append(this.allChip, $('span.count'));
		this._register(addDisposableListener(this.allChip, EventType.CLICK, () => this.setSharedOnly(false)));

		this.sharedChip = append(toolbar, $('button.paradis-browser-live-chip'));
		append(this.sharedChip, $('span.paradis-browser-live-dot.shared'));
		append(this.sharedChip, $('span.label')).textContent = localize('paradis.browserLive.filter.shared', "共有中");
		this.sharedChipCount = append(this.sharedChip, $('span.count'));
		this._register(addDisposableListener(this.sharedChip, EventType.CLICK, () => this.setSharedOnly(true)));

		append(toolbar, $('span.paradis-browser-live-grow'));

		this.sortButton = this.createValueButton(toolbar, localize('paradis.browserLive.sortHint', "並び順を切り替える"));
		this._register(addDisposableListener(this.sortButton.root, EventType.CLICK, () => this.cycleSort()));
		this.cadenceButton = this.createValueButton(toolbar, localize('paradis.browserLive.cadenceHint', "サムネイルの更新頻度を切り替える（上げるほど負荷も上がります）"));
		this._register(addDisposableListener(this.cadenceButton.root, EventType.CLICK, () => this.cycleCadence()));
		this.columnsButton = this.createValueButton(toolbar, localize('paradis.browserLive.columnsHint', "列数を切り替える"));
		this._register(addDisposableListener(this.columnsButton.root, EventType.CLICK, () => this.cycleColumns()));

		// --- 壁 ---------------------------------------------------------------------------
		this.scroll = append(root, $('.paradis-browser-live-scroll'));
		this.wall = append(this.scroll, $('.paradis-browser-live-wall'));

		this.observeIntersections();
		const targetWindow = getWindow(container);
		this._register(addDisposableListener(targetWindow.document, 'visibilitychange', () => {
			this.windowVisible = targetWindow.document.visibilityState !== 'hidden';
			for (const tile of this.tiles.values()) {
				this.updateThumbnailActivity(tile);
			}
		}));

		this._register(this.model.onDidChangeEntries(() => this.render()));
		this._register({ dispose: () => this.disposeAllTiles() });

		this.render();
	}

	// ------------------------------------------------------------------ 描画

	private render(): void {
		const entries = this.model.entries;
		const shown = paradisSortBrowserLiveEntries(paradisFilterBrowserLiveEntries(entries, this.viewState), this.viewState);

		// 無くなったタブのタイルだけ捨てる。絞り込みで消えたものは DOM から外すだけにして、
		// チップを押すたびにサムネを撮り直さない。
		const known = new Set(entries.map(entry => entry.viewId));
		for (const [viewId, tile] of [...this.tiles]) {
			if (!known.has(viewId)) {
				this.disposeTile(viewId, tile);
			}
		}
		const visible = new Set(shown.map(entry => entry.viewId));
		for (const [viewId, tile] of this.tiles) {
			if (!visible.has(viewId) && tile.root.parentElement) {
				tile.root.remove();
				tile.inViewport = false;
				this.updateThumbnailActivity(tile);
			}
		}

		this.emptyElement?.remove();
		this.emptyElement = undefined;

		this.wall.className = `paradis-browser-live-wall columns-${this.viewState.columns}`;

		// 期待する並びへ「位置がずれている要素だけ」動かす。総入れ替えするとフォーカスが飛ぶ。
		let cursor = 0;
		const activeDocument = this.wall.ownerDocument;
		const place = (element: HTMLElement): void => {
			const current: Node | null = this.wall.childNodes.item(cursor);
			if (current !== element) {
				const active = activeDocument.activeElement;
				const restore = isHTMLElement(active) && element.contains(active) ? active : undefined;
				this.wall.insertBefore(element, current);
				restore?.focus({ preventScroll: true });
			}
			cursor++;
		};

		if (shown.length === 0) {
			const empty = $('.paradis-browser-live-empty');
			empty.textContent = entries.length === 0
				? localize('paradis.browserLive.emptyNoTabs', "開いている内蔵ブラウザはありません。")
				: localize('paradis.browserLive.emptyFiltered', "共有中のページはありません。");
			this.emptyElement = empty;
			place(empty);
		} else {
			for (let index = 0; index < shown.length; index++) {
				const entry = shown[index];
				const tile = this.ensureTile(entry, index);
				this.updateTile(tile, entry);
				place(tile.root);
				if (!this.intersectionObserver) {
					// 可視判定が使えない環境では、絞り込みから戻したタイルを自力で起こす
					// (起こさないと、いちど外れたタイルが二度と更新されなくなる)。
					tile.inViewport = true;
				}
				this.updateThumbnailActivity(tile);
			}
		}

		this.updateChrome(entries.length);
		this.renderedOnce = true;
	}

	private ensureTile(entry: IParadisBrowserLiveEntry, index: number): ITile {
		const existing = this.tiles.get(entry.viewId);
		if (existing) {
			return existing;
		}

		const disposables = new DisposableStore();
		// タイル自体はただの入れ物にする。開く操作はサムネイル (下の shot) が持つ本物のボタンが
		// 担い、再読み込み・閉じるはその兄弟に置く。タイル全体をボタンにすると、その中に
		// さらにボタンを入れることになり、支援技術からは名前も役割も辿れなくなる。
		const root = $('.paradis-browser-live-tile');

		const head = append(root, $('.paradis-browser-live-tile-head'));
		const faviconBox = append(head, $('.paradis-browser-live-favicon'));
		const faviconImage = append(faviconBox, $('img')) as HTMLImageElement;
		faviconImage.setAttribute('alt', '');
		faviconImage.setAttribute('aria-hidden', 'true');
		faviconImage.draggable = false;
		const faviconFallback = append(faviconBox, $('span.paradis-browser-live-favicon-fallback.codicon.codicon-globe'));
		// favicon は http のページでは読めないことがある (workbench の CSP が https/data/blob のみ)。
		// 読めなかったときは既定のアイコンへ落として、壊れた画像アイコンを見せない。
		disposables.add(addDisposableListener(faviconImage, 'error', () => {
			faviconImage.classList.add('failed');
			faviconFallback.classList.remove('hidden');
		}));

		const title = append(head, $('.paradis-browser-live-tile-title'));
		const titleHover = disposables.add(this.hoverService.setupManagedHover(getDefaultHoverDelegate('element'), title, ''));

		const actions = append(head, $('.paradis-browser-live-tile-actions'));
		const reloadButton = this.createMiniButton(actions, 'refresh', localize('paradis.browserLive.reload', "再読み込み"), disposables);
		disposables.add(addDisposableListener(reloadButton, EventType.CLICK, event => {
			event.stopPropagation();
			this.model.reload(entry.viewId).catch(onUnexpectedError);
		}));
		const closeButton = this.createMiniButton(actions, 'close', localize('paradis.browserLive.close', "タブを閉じる"), disposables);
		disposables.add(addDisposableListener(closeButton, EventType.CLICK, event => {
			event.stopPropagation();
			this.model.close(entry.viewId).catch(onUnexpectedError);
		}));

		const shot = append(root, $('button.paradis-browser-live-shot'));
		const thumbnail = disposables.add(new ParadisBrowserLiveThumbnail(
			shot,
			() => this.model.getViewModel(entry.viewId),
			// 一斉撮影を散らすのは一覧を開いた最初の1回だけ。あとから開かれたタブまで
			// 末尾の待ち時間を背負うと、新しいタブほど絵が出るのが遅くなる。
			this.renderedOnce ? 0 : Math.min(FIRST_CAPTURE_STAGGER_MAX, index * FIRST_CAPTURE_STAGGER),
			this.logService,
		));
		const pausedMark = append(shot, $('span.paradis-browser-live-paused.codicon.codicon-debug-pause.hidden'));
		pausedMark.setAttribute('aria-hidden', 'true');
		disposables.add(this.hoverService.setupManagedHover(
			getDefaultHoverDelegate('element'),
			pausedMark,
			localize('paradis.browserLive.pausedHint', "更新を止めています（最後の画面のままです）"),
		));
		disposables.add(addDisposableListener(shot, EventType.CLICK, () => {
			this.model.reveal(entry.viewId).catch(onUnexpectedError);
		}));

		const foot = append(root, $('.paradis-browser-live-tile-foot'));
		const url = append(foot, $('.paradis-browser-live-url'));
		const tags = append(foot, $('.paradis-browser-live-tags'));

		const tile: ITile = {
			root, shot, pausedMark, faviconImage, faviconFallback, title, titleHover, url, tags, thumbnail, disposables,
			// 可視判定がある環境では、最初の通知が来るまで止めておく (開いた瞬間に全タイルが
			// 撮りに行かないように)。判定が使えない環境では最初から動かす。
			inViewport: !this.intersectionObserver,
			entry,
		};
		this.tiles.set(entry.viewId, tile);
		this.viewIdsByElement.set(root, entry.viewId);
		this.intersectionObserver?.observe(root);
		thumbnail.setCadence(this.viewState.cadence);
		return tile;
	}

	private updateTile(tile: ITile, entry: IParadisBrowserLiveEntry): void {
		const previous = tile.entry;
		tile.entry = entry;

		const title = paradisBrowserLiveDisplayTitle(entry);
		if (tile.title.textContent !== title) {
			tile.title.textContent = title;
		}
		const displayUrl = paradisBrowserLiveDisplayUrl(entry.url);
		if (tile.url.textContent !== displayUrl) {
			tile.url.textContent = displayUrl;
		}
		const hoverText = displayUrl ? `${title}\n${displayUrl}` : title;
		tile.titleHover.update(hoverText);
		const shared = entry.agents.length > 0;
		// 絵が更新されない条件。判断はサムネ側の間引きと同じ (paradisBrowserLiveCaptureDelayMs)。
		const paused = this.viewState.cadence === 'off' || (!entry.visible && !shared);
		tile.shot.setAttribute('aria-label', paused
			? localize('paradis.browserLive.tileLabelPaused', "{0}（更新を止めています）— このタブを開く", title)
			: localize('paradis.browserLive.tileLabel', "{0} — このタブを開く", title));

		if (entry.favicon !== previous.favicon || !tile.faviconImage.getAttribute('src')) {
			if (entry.favicon) {
				tile.faviconImage.classList.remove('failed');
				tile.faviconFallback.classList.add('hidden');
				tile.faviconImage.src = entry.favicon;
			} else {
				tile.faviconImage.removeAttribute('src');
				tile.faviconImage.classList.add('failed');
				tile.faviconFallback.classList.remove('hidden');
			}
		}

		tile.root.classList.toggle('shared', shared);
		tile.root.classList.toggle('visible-tab', entry.visible);
		tile.root.classList.toggle('errored', !!entry.errorText);
		// サムネ側の間引き判断はこの2つで決まる。どちらも変化を押し込まないと、
		// 休眠したタイルが自分から起きられない。
		tile.thumbnail.setShared(shared);
		tile.thumbnail.setVisible(entry.visible);
		// 動かないことが分かっていれば「壊れている」と読まれない (文言は aria-label にも入れてある)。
		tile.pausedMark.classList.toggle('hidden', !paused);

		this.renderTags(tile, entry);

		// 共有相手が変わった直後は絵を早めに合わせる (共有を始めた瞬間にカーソルが出るため)。
		if (entry.agents.join(',') !== previous.agents.join(',')) {
			tile.thumbnail.refreshNow();
		}
	}

	private renderTags(tile: ITile, entry: IParadisBrowserLiveEntry): void {
		const parts: { readonly kind: string; readonly text: string }[] = [];
		if (entry.errorText) {
			parts.push({ kind: 'error', text: localize('paradis.browserLive.tag.error', "読み込み失敗") });
		} else if (entry.loading) {
			parts.push({ kind: 'loading', text: localize('paradis.browserLive.tag.loading', "読み込み中") });
		}
		for (const agent of entry.agents) {
			parts.push({ kind: 'shared', text: localize('paradis.browserLive.tag.shared', "{0} と共有中", agent) });
		}
		const signature = parts.map(part => `${part.kind}:${part.text}`).join('|');
		if (tile.tags.getAttribute('data-signature') === signature) {
			return;
		}
		tile.tags.setAttribute('data-signature', signature);
		tile.tags.textContent = '';
		for (const part of parts) {
			const tag = append(tile.tags, $(`span.paradis-browser-live-tag.${part.kind}`));
			append(tag, $('span.paradis-browser-live-dot'));
			append(tag, $('span')).textContent = part.text;
		}
	}

	private updateChrome(total: number): void {
		const shared = this.model.summary.shared;
		this.allChipCount.textContent = String(total);
		this.sharedChipCount.textContent = String(shared);
		this.allChip.classList.toggle('checked', !this.viewState.sharedOnly);
		this.sharedChip.classList.toggle('checked', this.viewState.sharedOnly);

		this.setValueButton(this.sortButton, localize('paradis.browserLive.sortLabel', "並び"), SORT_LABELS[this.viewState.sort]);
		this.setValueButton(this.cadenceButton, localize('paradis.browserLive.cadenceLabel', "更新"), CADENCE_LABELS[this.viewState.cadence]);
		this.setValueButton(this.columnsButton, localize('paradis.browserLive.columnsLabel', "列"), String(this.viewState.columns));
	}

	// ------------------------------------------------------------------ 操作

	private setSharedOnly(sharedOnly: boolean): void {
		if (this.viewState.sharedOnly === sharedOnly) {
			return;
		}
		this.viewState.sharedOnly = sharedOnly;
		this.render();
		this._onDidChangeViewState.fire();
	}

	private cycleSort(): void {
		const index = SORT_ORDER.indexOf(this.viewState.sort);
		this.viewState.sort = SORT_ORDER[(index + 1) % SORT_ORDER.length];
		this.render();
		this._onDidChangeViewState.fire();
	}

	private cycleCadence(): void {
		const index = CADENCE_ORDER.indexOf(this.viewState.cadence);
		this.viewState.cadence = CADENCE_ORDER[(index + 1) % CADENCE_ORDER.length];
		for (const tile of this.tiles.values()) {
			tile.thumbnail.setCadence(this.viewState.cadence);
		}
		this.render();
		this._onDidChangeViewState.fire();
	}

	private cycleColumns(): void {
		const next = this.viewState.columns + 1;
		this.viewState.columns = next > PARADIS_BROWSER_LIVE_MAX_COLUMNS ? PARADIS_BROWSER_LIVE_MIN_COLUMNS : next;
		this.render();
		this._onDidChangeViewState.fire();
	}

	// ------------------------------------------------------------------ 可視性

	private observeIntersections(): void {
		const targetWindow = getWindow(this.scroll);
		if (!targetWindow.IntersectionObserver) {
			return;
		}
		// 画面外のタイルはサムネの取得を止める (戻ってきたら最後のフレームから再開する)。
		this.intersectionObserver = new targetWindow.IntersectionObserver(records => {
			for (const record of records) {
				const viewId = this.viewIdsByElement.get(record.target);
				const tile = viewId ? this.tiles.get(viewId) : undefined;
				if (tile) {
					tile.inViewport = record.isIntersecting;
					this.updateThumbnailActivity(tile);
				}
			}
		}, { root: this.scroll, rootMargin: '150px' });
		this._register({ dispose: () => this.intersectionObserver?.disconnect() });
	}

	private updateThumbnailActivity(tile: ITile): void {
		tile.thumbnail.setActive(this.windowVisible && tile.inViewport && !!tile.root.parentElement);
	}

	// ------------------------------------------------------------------ 部品

	private createValueButton(parent: HTMLElement, hover: string): IValueButton {
		const root = append(parent, $('button.paradis-browser-live-value-button'));
		const key = append(root, $('span.key'));
		const value = append(root, $('span.value'));
		this._register(this.hoverService.setupManagedHover(getDefaultHoverDelegate('element'), root, hover));
		return { root, key, value };
	}

	private setValueButton(button: IValueButton, key: string, value: string): void {
		button.key.textContent = key;
		button.value.textContent = value;
		button.root.setAttribute('aria-label', `${key}: ${value}`);
	}

	private createMiniButton(parent: HTMLElement, codicon: string, label: string, disposables: DisposableStore): HTMLElement {
		const button = append(parent, $(`button.paradis-browser-live-mini-button.codicon.codicon-${codicon}`));
		button.setAttribute('aria-label', label);
		disposables.add(this.hoverService.setupManagedHover(getDefaultHoverDelegate('element'), button, label));
		return button;
	}

	private disposeTile(viewId: string, tile: ITile): void {
		this.viewIdsByElement.delete(tile.root);
		this.intersectionObserver?.unobserve(tile.root);
		tile.root.remove();
		this.tiles.delete(viewId);
		tile.disposables.dispose();
	}

	private disposeAllTiles(): void {
		for (const [viewId, tile] of [...this.tiles]) {
			this.disposeTile(viewId, tile);
		}
	}
}
