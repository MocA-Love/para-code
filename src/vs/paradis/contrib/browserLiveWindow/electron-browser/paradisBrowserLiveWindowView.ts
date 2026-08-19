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
import { Disposable, DisposableStore, MutableDisposable } from '../../../../base/common/lifecycle.js';
import { localize } from '../../../../nls.js';
import { IHoverService } from '../../../../platform/hover/browser/hover.js';
import { ILogService } from '../../../../platform/log/common/log.js';
import { ParadisBrowserLiveModel } from './paradisBrowserLiveModel.js';
import { ParadisBrowserLiveSettingsPopover } from './paradisBrowserLiveSettingsPopover.js';
import { ParadisBrowserLiveThumbnail } from './paradisBrowserLiveThumbnail.js';
import {
	IParadisBrowserLiveEntry,
	IParadisBrowserLiveViewState,
	paradisBrowserLiveDisplayTitle,
	paradisBrowserLiveDisplayUrl,
	paradisFilterBrowserLiveEntries,
	paradisGroupBrowserLiveEntries,
	paradisSortBrowserLiveEntries,
	paradisSummarizeBrowserLiveEntries,
} from '../common/paradisBrowserLiveWindow.js';

interface ITile {
	readonly root: HTMLElement;
	/** サムネイルであり、「このタブを開く」ボタンでもある領域。 */
	readonly shot: HTMLElement;
	/** 更新が止まっていることを示す印。 */
	readonly pausedMark: HTMLElement;
	/** スペース色の帯。どのスペースのページかを見出し以外でも分かるようにする。 */
	readonly spaceBar: HTMLElement;
	readonly faviconImage: HTMLImageElement;
	readonly faviconFallback: HTMLElement;
	readonly title: HTMLElement;
	readonly titleHover: IManagedHover;
	readonly reloadButton: HTMLElement;
	readonly closeButton: HTMLElement;
	readonly url: HTMLElement;
	readonly tags: HTMLElement;
	readonly thumbnail: ParadisBrowserLiveThumbnail;
	/** このタイルが握っている購読すべて (サムネイルもここに入る)。 */
	readonly disposables: DisposableStore;
	/** 一覧の中でこのタイルが見えているか (画面外ではサムネの取得を止める)。 */
	inViewport: boolean;
	entry: IParadisBrowserLiveEntry;
}

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
 * 常に見せるのは絞り込みと件数だけにして、並び替え・まとめ方・表示の設定は歯車の
 * ポップオーバーへ畳んでいる (エージェント一覧と同じ作法)。タイルの面積を最優先するため。
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

	private readonly root: HTMLElement;
	private readonly scroll: HTMLElement;
	private readonly wall: HTMLElement;
	private readonly allChip: HTMLElement;
	private readonly allChipCount: HTMLElement;
	private readonly sharedChip: HTMLElement;
	private readonly sharedChipCount: HTMLElement;
	private readonly activeSpaceChip: HTMLElement;
	private readonly countText: HTMLElement;
	private readonly settingsButton: HTMLElement;
	/** グループ見出しと空表示。タイルと違って毎回作り直すので、参照を持って消す。 */
	private readonly chromeElements: HTMLElement[] = [];

	/** 開いている間だけ生きる歯車ポップオーバー。 */
	private readonly popover = this._register(new MutableDisposable<ParadisBrowserLiveSettingsPopover>());

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
		this.root = root;

		// --- ツールバー -------------------------------------------------------------------
		const toolbar = append(root, $('.paradis-browser-live-toolbar'));
		this.allChip = append(toolbar, $('button.paradis-browser-live-chip'));
		append(this.allChip, $('span')).textContent = localize('paradis.browserLive.filter.all', "すべて");
		this.allChipCount = append(this.allChip, $('span.count'));
		this._register(addDisposableListener(this.allChip, EventType.CLICK, () => this.clearFilters()));

		this.sharedChip = append(toolbar, $('button.paradis-browser-live-chip'));
		append(this.sharedChip, $('span.paradis-browser-live-dot.shared'));
		append(this.sharedChip, $('span')).textContent = localize('paradis.browserLive.filter.shared', "共有中");
		this.sharedChipCount = append(this.sharedChip, $('span.count'));
		this._register(addDisposableListener(this.sharedChip, EventType.CLICK, () => this.toggleSharedOnly()));

		this.activeSpaceChip = append(toolbar, $('button.paradis-browser-live-chip'));
		append(this.activeSpaceChip, $('span')).textContent = localize('paradis.browserLive.filter.activeSpace', "このスペースのみ");
		this._register(this.hoverService.setupManagedHover(getDefaultHoverDelegate('element'), this.activeSpaceChip,
			localize('paradis.browserLive.filter.activeSpaceHint', "いま開いているスペースのページだけに絞り込む")));
		this._register(addDisposableListener(this.activeSpaceChip, EventType.CLICK, () => this.toggleActiveSpaceOnly()));

		append(toolbar, $('span.paradis-browser-live-grow'));
		this.countText = append(toolbar, $('span.paradis-browser-live-tool-label'));
		this.settingsButton = append(toolbar, $('button.paradis-browser-live-icon-button.codicon.codicon-settings-gear'));
		this.settingsButton.setAttribute('aria-label', localize('paradis.browserLive.settings', "表示と並び"));
		this.settingsButton.setAttribute('aria-haspopup', 'true');
		this.settingsButton.setAttribute('aria-expanded', 'false');
		this._register(this.hoverService.setupManagedHover(getDefaultHoverDelegate('element'), this.settingsButton, localize('paradis.browserLive.settings', "表示と並び")));
		this._register(addDisposableListener(this.settingsButton, EventType.CLICK, () => this.toggleSettings()));

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

	/** ウィンドウのサイズが変わったとき。開いたままのポップオーバーを歯車へ追従させる。 */
	layout(): void {
		this.popover.value?.layout();
	}

	// ------------------------------------------------------------------ 描画

	private render(): void {
		const entries = this.model.entries;
		const filtered = paradisFilterBrowserLiveEntries(entries, this.viewState);
		const sorted = paradisSortBrowserLiveEntries(filtered, this.viewState);
		const groups = paradisGroupBrowserLiveEntries(sorted, this.viewState, localize('paradis.browserLive.unknownSpace', "スペース未確定"));

		// 無くなったタブのタイルだけ捨てる。絞り込みで消えたものは DOM から外すだけにして、
		// チップを押すたびにサムネを撮り直さない。
		const known = new Set(entries.map(entry => entry.viewId));
		for (const [viewId, tile] of [...this.tiles]) {
			if (!known.has(viewId)) {
				this.disposeTile(viewId, tile);
			}
		}
		const shown = new Set(sorted.map(entry => entry.viewId));
		for (const [viewId, tile] of this.tiles) {
			if (!shown.has(viewId) && tile.root.parentElement) {
				tile.root.remove();
				tile.inViewport = false;
				this.updateThumbnailActivity(tile);
			}
		}

		for (const chrome of this.chromeElements) {
			chrome.remove();
		}
		this.chromeElements.length = 0;

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

		if (sorted.length === 0) {
			const empty = $('.paradis-browser-live-empty');
			empty.textContent = entries.length === 0
				? localize('paradis.browserLive.emptyNoTabs', "開いている内蔵ブラウザはありません。")
				: localize('paradis.browserLive.emptyFiltered', "条件に合うページがありません。");
			this.chromeElements.push(empty);
			place(empty);
		} else {
			let index = 0;
			// スペースを使っていないウィンドウでは全ページが1つの束になる。その1本だけの
			// 見出しは何も区別しないので出さない。
			const showHeadings = this.viewState.group !== 'none' && !(groups.length === 1 && groups[0].key === '');
			for (const group of groups) {
				if (showHeadings) {
					const head = $('.paradis-browser-live-group-head');
					if (group.color) {
						append(head, $('span.paradis-browser-live-swatch')).style.backgroundColor = group.color;
					}
					append(head, $('span')).textContent = group.label;
					append(head, $('span.paradis-browser-live-grow'));
					append(head, $('span')).textContent = localize('paradis.browserLive.groupCount', "{0} 件", group.entries.length);
					this.chromeElements.push(head);
					place(head);
				}
				for (const entry of group.entries) {
					const tile = this.ensureTile(entry, index++);
					this.updateTile(tile, entry);
					place(tile.root);
					if (!this.intersectionObserver) {
						// 可視判定が使えない環境では、絞り込みから戻したタイルを自力で起こす。
						tile.inViewport = true;
					}
					this.updateThumbnailActivity(tile);
				}
			}
		}

		this.updateChrome(entries, sorted.length);
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
		const spaceBar = append(head, $('.paradis-browser-live-spacebar'));
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
			root, shot, pausedMark, spaceBar, faviconImage, faviconFallback, title, titleHover, reloadButton, closeButton, url, tags, thumbnail, disposables,
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
		const hoverText = [title, displayUrl, entry.inActiveSpace ? '' : entry.spaceName].filter(Boolean).join('\n');
		tile.titleHover.update(hoverText);
		const paused = this.viewState.cadence === 'off';
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

		tile.spaceBar.style.backgroundColor = entry.spaceColor ?? '';
		tile.spaceBar.classList.toggle('hidden', !entry.spaceColor);

		tile.root.classList.toggle('shared', entry.agents.length > 0);
		tile.root.classList.toggle('visible-tab', entry.visible);
		tile.root.classList.toggle('errored', !!entry.errorText);
		// 別スペースのタブは閉じない (そのスペースの復元とスコープ台帳に触れることになる)。
		tile.closeButton.classList.toggle('hidden', !entry.inActiveSpace);
		tile.reloadButton.classList.toggle('hidden', !entry.inActiveSpace);

		// サムネ側の間引き判断。押し込まないと、休眠したタイルが自分から起きられない。
		tile.thumbnail.setVisible(entry.visible);
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
		// まとめ方が「なし」のときは見出しが出ないので、別スペースのページはここで名乗らせる。
		if (!entry.inActiveSpace && this.viewState.group === 'none' && entry.spaceName) {
			parts.push({ kind: 'space', text: entry.spaceName });
		}
		const signature = parts.map(part => `${part.kind}:${part.text}`).join('|');
		if (tile.tags.getAttribute('data-signature') === signature) {
			return;
		}
		tile.tags.setAttribute('data-signature', signature);
		tile.tags.textContent = '';
		for (const part of parts) {
			const tag = append(tile.tags, $(`span.paradis-browser-live-tag.${part.kind}`));
			if (part.kind !== 'space') {
				append(tag, $('span.paradis-browser-live-dot'));
			}
			append(tag, $('span')).textContent = part.text;
		}
	}

	private updateChrome(entries: readonly IParadisBrowserLiveEntry[], shownCount: number): void {
		// チップは一覧の中身 (全スペース) が基準。タイトルバーのバッジだけが手元のスペース基準。
		const summary = paradisSummarizeBrowserLiveEntries(entries);
		this.allChipCount.textContent = String(summary.totalAll);
		this.sharedChipCount.textContent = String(summary.sharedAll);
		const filtering = this.viewState.sharedOnly || this.viewState.activeSpaceOnly;
		this.allChip.classList.toggle('checked', !filtering);
		this.sharedChip.classList.toggle('checked', this.viewState.sharedOnly);
		this.activeSpaceChip.classList.toggle('checked', this.viewState.activeSpaceOnly);
		this.countText.textContent = filtering
			? localize('paradis.browserLive.countFiltered', "{0} / {1} 件", shownCount, entries.length)
			: localize('paradis.browserLive.count', "{0} 件", entries.length);
	}

	// ------------------------------------------------------------------ 操作

	private clearFilters(): void {
		if (!this.viewState.sharedOnly && !this.viewState.activeSpaceOnly) {
			return;
		}
		this.viewState.sharedOnly = false;
		this.viewState.activeSpaceOnly = false;
		this.commitViewState();
	}

	private toggleSharedOnly(): void {
		this.viewState.sharedOnly = !this.viewState.sharedOnly;
		this.commitViewState();
	}

	private toggleActiveSpaceOnly(): void {
		this.viewState.activeSpaceOnly = !this.viewState.activeSpaceOnly;
		this.commitViewState();
	}

	private toggleSettings(): void {
		if (this.popover.value) {
			this.closeSettings(true);
			return;
		}
		this.settingsButton.classList.add('checked');
		this.settingsButton.setAttribute('aria-expanded', 'true');
		this.popover.value = new ParadisBrowserLiveSettingsPopover(
			this.root,
			this.viewState,
			{
				anchor: this.settingsButton,
				commit: () => this.commitViewState(),
				close: (restoreFocus: boolean) => this.closeSettings(restoreFocus),
			},
		);
	}

	private closeSettings(restoreFocus: boolean): void {
		if (!this.popover.value) {
			return;
		}
		this.popover.clear();
		this.settingsButton.classList.remove('checked');
		this.settingsButton.setAttribute('aria-expanded', 'false');
		if (restoreFocus) {
			this.settingsButton.focus();
		}
	}

	/** 設定が変わった。描画し直し、開いているポップオーバーの表示も合わせ、保存を予約する。 */
	private commitViewState(): void {
		for (const tile of this.tiles.values()) {
			tile.thumbnail.setCadence(this.viewState.cadence);
		}
		this.render();
		this.popover.value?.update();
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
