/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-PATCH/PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import { $, addDisposableListener, append, clearNode, EventType, getWindow, isHTMLElement } from '../../../../base/browser/dom.js';
import { getDefaultHoverDelegate } from '../../../../base/browser/ui/hover/hoverDelegateFactory.js';
import { IntervalTimer } from '../../../../base/common/async.js';
import { onUnexpectedError } from '../../../../base/common/errors.js';
import { Emitter } from '../../../../base/common/event.js';
import { Disposable, DisposableMap, DisposableStore } from '../../../../base/common/lifecycle.js';
import { localize } from '../../../../nls.js';
import { IAction, Separator, toAction } from '../../../../base/common/actions.js';
import { IContextMenuService } from '../../../../platform/contextview/browser/contextView.js';
import { IHoverService } from '../../../../platform/hover/browser/hover.js';
import { IInstantiationService } from '../../../../platform/instantiation/common/instantiation.js';
import { ITerminalInstance } from '../../../../workbench/contrib/terminal/browser/terminal.js';
import { ParadisAgentLiveMirror } from './paradisAgentLiveMirror.js';
import { ParadisAgentLiveModel } from './paradisAgentLiveModel.js';
import {
	IParadisAgentLiveEntry,
	IParadisAgentLiveViewState,
	PARADIS_AGENT_LIVE_DEFAULT_ROW_HEIGHT,
	PARADIS_AGENT_LIVE_MAX_COLUMNS,
	PARADIS_AGENT_LIVE_MAX_ROW_HEIGHT,
	PARADIS_AGENT_LIVE_MIN_COLUMNS,
	PARADIS_AGENT_LIVE_MIN_ROW_HEIGHT,
	PARADIS_AGENT_LIVE_STATUS_ORDER,
	ParadisAgentLiveGroup,
	ParadisAgentLiveSort,
	ParadisAgentLiveStatus,
	paradisApplyAgentLiveManualDrop,
	paradisClampAgentLiveRowHeight,
	paradisFilterAgentLiveEntries,
	paradisFormatAgentLiveDuration,
	paradisGroupAgentLiveEntries,
	paradisHasAgentLiveFilter,
	paradisIsAttentionStatus,
	paradisSortAgentLiveEntries,
} from '../common/paradisAgentLiveWindow.js';

interface ITile {
	readonly root: HTMLElement;
	readonly title: HTMLElement;
	readonly detail: HTMLElement;
	readonly badge: HTMLElement;
	readonly spaceBar: HTMLElement;
	readonly footText: HTMLElement;
	readonly pinButton: HTMLElement;
	readonly mirror: ParadisAgentLiveMirror | undefined;
	entry: IParadisAgentLiveEntry;
}

const STATUS_LABELS: Record<ParadisAgentLiveStatus, string> = {
	permission: localize('paradis.agentLive.status.permission', "許可待ち"),
	question: localize('paradis.agentLive.status.question', "質問中"),
	working: localize('paradis.agentLive.status.working', "実行中"),
	review: localize('paradis.agentLive.status.review', "完了"),
	idle: localize('paradis.agentLive.status.idle', "待機"),
};

const SORT_LABELS: Record<ParadisAgentLiveSort, string> = {
	attention: localize('paradis.agentLive.sort.attention', "要対応 → 経過時間の長い順"),
	status: localize('paradis.agentLive.sort.status', "状態順"),
	elapsed: localize('paradis.agentLive.sort.elapsed', "経過時間が長い順"),
	updated: localize('paradis.agentLive.sort.updated', "最後に動いた順"),
	space: localize('paradis.agentLive.sort.space', "スペース名順"),
	manual: localize('paradis.agentLive.sort.manual', "手動（ドラッグで並べ替え）"),
};

const GROUP_LABELS: Record<ParadisAgentLiveGroup, string> = {
	none: localize('paradis.agentLive.group.none', "なし"),
	space: localize('paradis.agentLive.group.space', "スペース"),
	status: localize('paradis.agentLive.group.status', "状態"),
};

/** 経過時間表示の更新間隔。秒単位の表示なので1秒で足りる。 */
const CLOCK_INTERVAL = 1000;

/**
 * ライブウィンドウの中身 (ツールバー + タイルのグリッド)。
 *
 * タイルは再描画のたびに作り直さず、ペイントークンをキーに使い回す。タイルを捨てると
 * その端末のミラー (detached xterm) も一緒に捨てることになり、状態が変わるたびに
 * 端末が真っ白から再同期されてしまうため。並べ替えも、位置がずれているタイルだけを
 * 動かす (DOM から外れた要素はフォーカスを失うので、入力中の端末が使えなくなる)。
 */
export class ParadisAgentLiveWindowView extends Disposable {

	private readonly _onDidChangeViewState = this._register(new Emitter<void>());
	readonly onDidChangeViewState = this._onDidChangeViewState.event;

	private readonly tiles = new Map<string, ITile>();
	private readonly tileDisposables = this._register(new DisposableMap<string>());
	/** IntersectionObserver の対象要素からトークンを引くための逆引き */
	private readonly tokensByElement = new Map<Element, string>();

	private readonly statusChips = new Map<ParadisAgentLiveStatus, HTMLElement>();
	private readonly statusChipCounts = new Map<ParadisAgentLiveStatus, HTMLElement>();
	/** グループ見出しと空表示。タイルと違って毎回作り直すので、参照を持って消す */
	private readonly chromeElements: HTMLElement[] = [];
	private readonly wall: HTMLElement;
	private readonly filterBar: HTMLElement;
	private readonly filterBarText: HTMLElement;
	private readonly statusBarText: HTMLElement;
	private readonly statusBarSort: HTMLElement;
	private readonly spacesButton: HTMLElement;
	private readonly sortButton: HTMLElement;
	private readonly groupButtons = new Map<ParadisAgentLiveGroup, HTMLElement>();
	private readonly columnButtons = new Map<number, HTMLElement>();
	private readonly fitButton: HTMLElement;
	private readonly rowHeightInput: HTMLInputElement;
	private readonly attentionChip: HTMLElement;
	private readonly pinTopButton: HTMLElement;

	private intersectionObserver: IntersectionObserver | undefined;
	private draggedToken: string | undefined;
	/** 現在描画されている順序 (手動並び替えの土台に使う) */
	private visibleOrder: string[] = [];
	/** 「収める」を切った直後に戻す高さ。入力欄の表示値でもある */
	private lastRowHeight = PARADIS_AGENT_LIVE_DEFAULT_ROW_HEIGHT;

	constructor(
		container: HTMLElement,
		private readonly model: ParadisAgentLiveModel,
		private readonly viewState: IParadisAgentLiveViewState,
		@IInstantiationService private readonly instantiationService: IInstantiationService,
		@IContextMenuService private readonly contextMenuService: IContextMenuService,
		@IHoverService private readonly hoverService: IHoverService,
	) {
		super();

		const root = append(container, $('.paradis-agent-live-window'));

		// --- 1段目: 状態フィルタ ---------------------------------------------------------
		const toolbar = append(root, $('.paradis-agent-live-toolbar'));
		append(toolbar, $('span.paradis-agent-live-tool-label')).textContent = localize('paradis.agentLive.filterLabel', "状態");
		for (const status of PARADIS_AGENT_LIVE_STATUS_ORDER) {
			const chip = append(toolbar, $(`button.paradis-agent-live-chip.status-${status}`));
			append(chip, $(`span.paradis-agent-live-dot.${status}`));
			append(chip, $('span.label')).textContent = STATUS_LABELS[status];
			this.statusChipCounts.set(status, append(chip, $('span.count')));
			this._register(addDisposableListener(chip, EventType.CLICK, () => this.toggleStatus(status)));
			this.statusChips.set(status, chip);
		}
		append(toolbar, $('span.paradis-agent-live-sep'));
		this.attentionChip = append(toolbar, $('button.paradis-agent-live-chip'));
		this.attentionChip.textContent = localize('paradis.agentLive.attentionOnly', "要対応のみ");
		this.registerHover(this.attentionChip, localize('paradis.agentLive.attentionOnlyHint', "許可待ち・質問中だけに絞り込む"));
		this._register(addDisposableListener(this.attentionChip, EventType.CLICK, () => this.toggleAttentionOnly()));

		append(toolbar, $('span.paradis-agent-live-grow'));
		this.spacesButton = append(toolbar, $('button.paradis-agent-live-chip'));
		this.spacesButton.setAttribute('aria-haspopup', 'true');
		this._register(addDisposableListener(this.spacesButton, EventType.CLICK, () => this.showSpacesMenu()));

		// --- 2段目: 並び替え・表示 -------------------------------------------------------
		const toolbar2 = append(root, $('.paradis-agent-live-toolbar2'));
		append(toolbar2, $('span.paradis-agent-live-tool-label')).textContent = localize('paradis.agentLive.sortLabel', "並び替え");
		this.sortButton = append(toolbar2, $('button.paradis-agent-live-chip'));
		this.sortButton.setAttribute('aria-haspopup', 'true');
		this._register(addDisposableListener(this.sortButton, EventType.CLICK, () => this.showSortMenu()));

		const sortDirButton = this.createIconButton(toolbar2, 'arrow-swap', localize('paradis.agentLive.sortDirection', "昇順・降順を反転"));
		this._register(addDisposableListener(sortDirButton, EventType.CLICK, () => {
			this.viewState.sortDesc = !this.viewState.sortDesc;
			this.commit();
		}));

		append(toolbar2, $('span.paradis-agent-live-sep'));
		append(toolbar2, $('span.paradis-agent-live-tool-label')).textContent = localize('paradis.agentLive.groupLabel', "グループ");
		const groupSeg = append(toolbar2, $('.paradis-agent-live-seg'));
		for (const group of ['none', 'space', 'status'] as const) {
			const button = append(groupSeg, $('button'));
			button.textContent = GROUP_LABELS[group];
			this._register(addDisposableListener(button, EventType.CLICK, () => {
				this.viewState.group = group;
				this.commit();
			}));
			this.groupButtons.set(group, button);
		}

		append(toolbar2, $('span.paradis-agent-live-sep'));
		append(toolbar2, $('span.paradis-agent-live-tool-label')).textContent = localize('paradis.agentLive.columnsLabel', "列");
		const colsSeg = append(toolbar2, $('.paradis-agent-live-seg'));
		for (let columns = PARADIS_AGENT_LIVE_MIN_COLUMNS; columns <= PARADIS_AGENT_LIVE_MAX_COLUMNS; columns++) {
			const button = append(colsSeg, $('button'));
			button.textContent = String(columns);
			const value = columns;
			this.registerHover(button, localize('paradis.agentLive.columnsHint', "{0} 列で並べる", columns));
			this._register(addDisposableListener(button, EventType.CLICK, () => {
				this.viewState.columns = value;
				this.commit();
			}));
			this.columnButtons.set(columns, button);
		}

		append(toolbar2, $('span.paradis-agent-live-sep'));
		append(toolbar2, $('span.paradis-agent-live-tool-label')).textContent = localize('paradis.agentLive.rowHeightLabel', "高さ");
		this.fitButton = append(toolbar2, $('button.paradis-agent-live-chip'));
		this.fitButton.textContent = localize('paradis.agentLive.fitToWindow', "収める");
		this.registerHover(this.fitButton, localize('paradis.agentLive.fitToWindowHint', "何件あっても1画面に収める（多いと1枚が小さくなる）"));
		this._register(addDisposableListener(this.fitButton, EventType.CLICK, () => {
			this.viewState.minRowHeight = this.viewState.minRowHeight === undefined ? this.lastRowHeight : undefined;
			this.commit();
		}));

		// 画面の大きさで「読める高さ」はまるで違うので、px を直接打てるようにする。
		this.rowHeightInput = append(toolbar2, $('input.paradis-agent-live-number')) as HTMLInputElement;
		this.rowHeightInput.type = 'number';
		this.rowHeightInput.min = String(PARADIS_AGENT_LIVE_MIN_ROW_HEIGHT);
		this.rowHeightInput.max = String(PARADIS_AGENT_LIVE_MAX_ROW_HEIGHT);
		this.rowHeightInput.step = '10';
		this.rowHeightInput.setAttribute('aria-label', localize('paradis.agentLive.rowHeightAria', "タイル1枚の最低の高さ（ピクセル）"));
		this.registerHover(this.rowHeightInput, localize('paradis.agentLive.rowHeightHint', "タイル1枚の最低の高さ。これを下回るところからは縦スクロールになる"));
		// change は Enter でもフォーカスが外れたときでも発火する。keydown を別に見ると
		// Enter のときだけ二重に走る。
		this._register(addDisposableListener(this.rowHeightInput, EventType.CHANGE, () => this.applyRowHeightInput()));
		append(toolbar2, $('span.paradis-agent-live-tool-label')).textContent = localize('paradis.agentLive.rowHeightUnit', "px");

		append(toolbar2, $('span.paradis-agent-live-grow'));
		this.pinTopButton = this.createIconButton(toolbar2, 'pin', localize('paradis.agentLive.pinTop', "ピン留めを常に先頭にする"));
		this._register(addDisposableListener(this.pinTopButton, EventType.CLICK, () => {
			this.viewState.pinTop = !this.viewState.pinTop;
			this.commit();
		}));

		const resetButton = this.createIconButton(toolbar2, 'discard', localize('paradis.agentLive.reset', "絞り込みと並び替えを初期化"));
		this._register(addDisposableListener(resetButton, EventType.CLICK, () => this.reset()));

		// --- 絞り込み状況 ----------------------------------------------------------------
		this.filterBar = append(root, $('.paradis-agent-live-filterbar'));
		this.filterBarText = append(this.filterBar, $('span.paradis-agent-live-grow'));
		const clearButton = append(this.filterBar, $('button.paradis-agent-live-link'));
		clearButton.textContent = localize('paradis.agentLive.clearFilters', "絞り込みを解除");
		this._register(addDisposableListener(clearButton, EventType.CLICK, () => this.clearFilters()));

		// --- グリッド --------------------------------------------------------------------
		const scroll = append(root, $('.paradis-agent-live-scroll'));
		this.wall = append(scroll, $('.paradis-agent-live-wall'));

		// --- ステータスバー --------------------------------------------------------------
		const statusBar = append(root, $('.paradis-agent-live-statusbar'));
		this.statusBarText = append(statusBar, $('span.paradis-agent-live-grow'));
		this.statusBarSort = append(statusBar, $('span'));

		this.observeIntersections(scroll);

		this._register(this.model.onDidChangeEntries(() => this.render()));
		const clock = this._register(new IntervalTimer());
		clock.cancelAndSet(() => this.updateClocks(), CLOCK_INTERVAL, getWindow(container));

		this.render();
	}

	/** ウィンドウのサイズが変わったとき。各ミラーの縮小率を計算し直す。 */
	layout(): void {
		for (const tile of this.tiles.values()) {
			tile.mirror?.layout();
		}
	}

	// ------------------------------------------------------------------ 描画

	private render(): void {
		const now = Date.now();
		const entries = this.liveEntries();
		this.pruneHiddenTokens(entries);

		const filtered = paradisFilterAgentLiveEntries(entries, this.viewState);
		const sorted = paradisSortAgentLiveEntries(filtered, this.viewState, now);
		const groups = paradisGroupAgentLiveEntries(sorted, this.viewState, status => STATUS_LABELS[status]);

		// 手動並び替えの土台は「画面に出ている順」。グループ表示ではグルーピング後の順序になる。
		this.visibleOrder = groups.flatMap(group => group.entries.map(entry => entry.token));
		// グループ見出しもグリッドの行を1つ使うため、見出しが出る間は行の等分 (fill) を掛けない。
		const classes = ['paradis-agent-live-wall', `columns-${this.viewState.columns}`];
		// 等分できるのは「見出しの無い並び」かつ「並べるものがある」ときだけ。
		if (this.viewState.group === 'none' && sorted.length > 0) {
			classes.push('fill');
		}
		this.wall.className = classes.join(' ');
		this.wall.style.setProperty('--paradis-agent-live-min-row', `${this.viewState.minRowHeight ?? 0}px`);

		// 端末そのものが無くなったタイルだけを破棄する。絞り込みで消えたタイルは DOM から
		// 外すだけにして、チップを押すたびに端末を作り直さない。
		const known = new Set(entries.map(entry => entry.token));
		for (const [token, tile] of [...this.tiles]) {
			if (!known.has(token)) {
				this.disposeTile(token, tile);
			}
		}
		const shown = new Set(this.visibleOrder);
		for (const [token, tile] of this.tiles) {
			if (!shown.has(token) && tile.root.parentElement) {
				tile.root.remove();
				tile.mirror?.setVisible(false);
			}
		}

		for (const chrome of this.chromeElements) {
			chrome.remove();
		}
		this.chromeElements.length = 0;

		// 期待する並びへ「位置がずれている要素だけ」動かす。appendChild で総入れ替えすると
		// 入力中のタイルが一度 DOM から外れ、フォーカス (と IME の変換) が飛ぶ。
		let cursor = 0;
		const activeDocument = this.wall.ownerDocument;
		const place = (element: HTMLElement): void => {
			const current: Node | null = this.wall.childNodes.item(cursor);
			if (current !== element) {
				// insertBefore は移動する要素自身をいったん DOM から外すため、その中に
				// フォーカスがあると body へ落ちる (打鍵の途中で入力が消える)。移動対象が
				// フォーカスを抱えている場合だけ、動かした後に戻す。
				// 復元してもIMEの未確定文字までは戻らない。スクロールは抑える
				// (壁が飛ぶと可視判定が動き、他のタイルが一斉に再同期してしまう)。
				const active = activeDocument.activeElement;
				const restore = isHTMLElement(active) && element.contains(active) ? active : undefined;
				this.wall.insertBefore(element, current);
				restore?.focus({ preventScroll: true });
			}
			cursor++;
		};

		if (sorted.length === 0) {
			const empty = $('.paradis-agent-live-empty');
			empty.textContent = entries.length === 0
				? localize('paradis.agentLive.emptyNoAgents', "動いているエージェントはありません。")
				: localize('paradis.agentLive.emptyFiltered', "条件に合うエージェントがいません。");
			this.chromeElements.push(empty);
			place(empty);
		} else {
			for (const group of groups) {
				if (this.viewState.group !== 'none') {
					const head = $('.paradis-agent-live-group-head');
					if (group.color) {
						append(head, $('span.paradis-agent-live-swatch')).style.backgroundColor = group.color;
					}
					if (group.status) {
						append(head, $(`span.paradis-agent-live-dot.${group.status}`));
					}
					append(head, $('span')).textContent = group.label;
					append(head, $('span.paradis-agent-live-grow'));
					append(head, $('span')).textContent = localize('paradis.agentLive.groupCount', "{0} 件", group.entries.length);
					this.chromeElements.push(head);
					place(head);
				}
				for (const entry of group.entries) {
					const tile = this.ensureTile(entry);
					this.updateTile(tile, entry, now);
					if (!this.intersectionObserver) {
						// 可視判定が使えない環境では、絞り込みで戻したタイルを自力で起こす。
						tile.mirror?.setVisible(true);
					}
					place(tile.root);
				}
			}
		}

		this.updateChrome(entries, sorted.length);
	}

	/**
	 * 並べ替えに使うエントリ。「最後に動いた順」のときだけ、出力の時刻を引き直した写しを返す
	 * (モデルは出力では再計算しないので、entries に入っている値は前回の再計算時点のもの)。
	 */
	private liveEntries(): readonly IParadisAgentLiveEntry[] {
		const entries = this.model.entries;
		if (this.viewState.sort !== 'updated') {
			return entries;
		}
		return entries.map(entry => ({ ...entry, lastOutputAt: this.model.getLastOutputAt(entry.token) }));
	}

	private ensureTile(entry: IParadisAgentLiveEntry): ITile {
		const existing = this.tiles.get(entry.token);
		if (existing) {
			if (existing.entry.instanceId === entry.instanceId) {
				return existing;
			}
			// 同じトークンが別のインスタンスへ張り替わった (park からの復帰、パネル↔エディタ移動)。
			// ミラーは古いインスタンスを掴んだままなので、タイルごと作り直す。
			this.disposeTile(entry.token, existing);
		}

		const disposables = new DisposableStore();
		const root = $('.paradis-agent-live-tile');
		root.draggable = true;
		root.tabIndex = 0;

		const spaceBar = append(root, $('.paradis-agent-live-spacebar'));
		const head = append(root, $('.paradis-agent-live-tile-head'));
		append(head, $('span.paradis-agent-live-drag-handle.codicon.codicon-gripper'));
		const titleBox = append(head, $('.paradis-agent-live-grow'));
		const title = append(titleBox, $('.paradis-agent-live-tile-title'));
		const detail = append(titleBox, $('.paradis-agent-live-tile-detail'));
		const badge = append(head, $('span.paradis-agent-live-badge'));

		const termContainer = append(root, $('.paradis-agent-live-term'));

		const foot = append(root, $('.paradis-agent-live-tile-foot'));
		const footText = append(foot, $('span.paradis-agent-live-grow'));
		const actions = append(foot, $('.paradis-agent-live-tile-actions'));

		const pinButton = this.createMiniButton(actions, 'pin', localize('paradis.agentLive.pin', "先頭に固定"), disposables);
		disposables.add(addDisposableListener(pinButton, EventType.CLICK, event => {
			event.stopPropagation();
			this.togglePinned(entry.token);
		}));

		const hideButton = this.createMiniButton(actions, 'eye-closed', localize('paradis.agentLive.hide', "このウィンドウから隠す"), disposables);
		disposables.add(addDisposableListener(hideButton, EventType.CLICK, event => {
			event.stopPropagation();
			if (!this.viewState.hidden.includes(entry.token)) {
				this.viewState.hidden.push(entry.token);
			}
			this.commit();
		}));

		// ドラッグ＆ドロップによる手動並び替え。
		disposables.add(addDisposableListener(root, EventType.DRAG_START, event => {
			this.draggedToken = entry.token;
			root.classList.add('dragging');
			event.dataTransfer?.setData('text/plain', entry.token);
		}));
		disposables.add(addDisposableListener(root, EventType.DRAG_END, () => {
			this.draggedToken = undefined;
			root.classList.remove('dragging');
		}));
		disposables.add(addDisposableListener(root, EventType.DRAG_OVER, event => {
			if (this.draggedToken && this.draggedToken !== entry.token) {
				event.preventDefault();
				root.classList.add('drop-target');
			}
		}));
		disposables.add(addDisposableListener(root, EventType.DRAG_LEAVE, () => root.classList.remove('drop-target')));
		disposables.add(addDisposableListener(root, EventType.DROP, event => {
			event.preventDefault();
			root.classList.remove('drop-target');
			const dragged = this.draggedToken;
			this.draggedToken = undefined;
			if (!dragged || dragged === entry.token) {
				return;
			}
			this.viewState.manualOrder = paradisApplyAgentLiveManualDrop(this.viewState.manualOrder, this.visibleOrder, dragged, entry.token);
			// 自動ソート中にドラッグされたら、見えている並びを保ったまま手動へ移す。
			this.viewState.sort = 'manual';
			this.commit();
		}));

		let mirror: ParadisAgentLiveMirror | undefined;
		const instance = this.model.getInstance(entry.token);
		if (instance) {
			mirror = disposables.add(this.createMirror(instance, termContainer));
		} else {
			// モデルは端末の実体と一緒にエントリを組み立てるので通常は起きない。念のための保険。
			append(termContainer, $('.paradis-agent-live-term-missing')).textContent =
				localize('paradis.agentLive.terminalUnavailable', "この端末はまだ復元されていません。");
		}

		this.tokensByElement.set(root, entry.token);
		this.intersectionObserver?.observe(root);

		const tile: ITile = { root, title, detail, badge, spaceBar, footText, pinButton, mirror, entry };
		this.tiles.set(entry.token, tile);
		this.tileDisposables.set(entry.token, disposables);
		return tile;
	}

	private disposeTile(token: string, tile: ITile): void {
		this.intersectionObserver?.unobserve(tile.root);
		this.tokensByElement.delete(tile.root);
		tile.root.remove();
		this.tiles.delete(token);
		this.tileDisposables.deleteAndDispose(token);
	}

	private createMirror(instance: ITerminalInstance, container: HTMLElement): ParadisAgentLiveMirror {
		const mirror = this.instantiationService.createInstance(ParadisAgentLiveMirror, instance, container, undefined);
		mirror.start().catch(onUnexpectedError);
		return mirror;
	}

	private updateTile(tile: ITile, entry: IParadisAgentLiveEntry, now: number): void {
		tile.entry = entry;
		tile.title.textContent = entry.title ? `${entry.spaceName} · ${entry.title}` : entry.spaceName;
		tile.detail.textContent = entry.detail;
		tile.badge.className = `paradis-agent-live-badge ${entry.status}`;
		clearNode(tile.badge);
		append(tile.badge, $(`span.paradis-agent-live-dot.${entry.status}`));
		append(tile.badge, $('span')).textContent = STATUS_LABELS[entry.status];
		tile.spaceBar.style.backgroundColor = entry.spaceColor ?? 'transparent';
		tile.root.classList.toggle('attention', paradisIsAttentionStatus(entry.status));
		const pinned = this.viewState.pinned.includes(entry.token);
		tile.root.classList.toggle('pinned', pinned);
		tile.pinButton.classList.toggle('checked', pinned);
		tile.pinButton.setAttribute('aria-pressed', String(pinned));
		tile.root.setAttribute('aria-label', localize(
			'paradis.agentLive.tileLabel', "{0}（{1}）", tile.title.textContent ?? entry.spaceName, STATUS_LABELS[entry.status]));
		this.updateTileClock(tile, now);
	}

	private updateTileClock(tile: ITile, now: number): void {
		const elapsed = paradisFormatAgentLiveDuration(now - tile.entry.since);
		const text = paradisIsAttentionStatus(tile.entry.status)
			? localize('paradis.agentLive.waiting', "{0} 待機中", elapsed)
			: tile.entry.status === 'review'
				? localize('paradis.agentLive.completed', "{0}前に完了", elapsed)
				: elapsed;
		// 入力の転送ができないミラーは、打っても無反応に見えるので明示する。
		tile.footText.textContent = tile.mirror?.isReadonly
			? localize('paradis.agentLive.readonlyTile', "{0} · 表示のみ（入力できません）", text)
			: text;
	}

	private updateClocks(): void {
		const now = Date.now();
		// 「最後に動いた順」は出力のたびに並びが変わるが、出力そのものは再描画の契機に
		// できない (毎フレーム飛んでくる)。この並びのときだけ時計の更新に合わせて順序を
		// 計算し直し、実際に変わったときだけ描き直す。
		if (this.viewState.sort === 'updated') {
			const sorted = paradisSortAgentLiveEntries(paradisFilterAgentLiveEntries(this.liveEntries(), this.viewState), this.viewState, now);
			const changed = sorted.length !== this.visibleOrder.length
				|| sorted.some((entry, index) => entry.token !== this.visibleOrder[index]);
			if (changed) {
				this.render();
				return;
			}
		}
		for (const tile of this.tiles.values()) {
			this.updateTileClock(tile, now);
		}
	}

	private updateChrome(entries: readonly IParadisAgentLiveEntry[], shown: number): void {
		const counts = this.model.countByStatus();
		for (const [status, chip] of this.statusChips) {
			const checked = this.viewState.statuses.includes(status);
			chip.classList.toggle('checked', checked);
			chip.setAttribute('aria-pressed', String(checked));
			const count = this.statusChipCounts.get(status);
			if (count) {
				count.textContent = String(counts.get(status) ?? 0);
			}
		}
		this.attentionChip.classList.toggle('checked', this.viewState.attentionOnly);
		this.attentionChip.setAttribute('aria-pressed', String(this.viewState.attentionOnly));
		this.pinTopButton.classList.toggle('checked', this.viewState.pinTop);
		this.pinTopButton.setAttribute('aria-pressed', String(this.viewState.pinTop));

		for (const [group, button] of this.groupButtons) {
			const checked = this.viewState.group === group;
			button.classList.toggle('checked', checked);
			button.setAttribute('aria-pressed', String(checked));
		}
		for (const [columns, button] of this.columnButtons) {
			const checked = this.viewState.columns === columns;
			button.classList.toggle('checked', checked);
			button.setAttribute('aria-pressed', String(checked));
		}
		const fitting = this.viewState.minRowHeight === undefined;
		this.fitButton.classList.toggle('checked', fitting);
		this.fitButton.setAttribute('aria-pressed', String(fitting));
		this.rowHeightInput.disabled = fitting;
		if (!fitting) {
			this.lastRowHeight = this.viewState.minRowHeight!;
		}
		// 入力中の値は上書きしない (打っている途中で桁が飛ぶため)。
		if (this.wall.ownerDocument.activeElement !== this.rowHeightInput) {
			this.rowHeightInput.value = String(this.lastRowHeight);
		}

		const spaceNames = this.spaceOptions(entries);
		this.spacesButton.textContent = this.viewState.spaces === undefined
			? localize('paradis.agentLive.allSpaces', "すべてのスペース")
			: this.viewState.spaces.length === 1
				? (spaceNames.get(this.viewState.spaces[0]) ?? localize('paradis.agentLive.oneSpace', "スペース 1 件"))
				: localize('paradis.agentLive.someSpaces', "スペース {0} 件", this.viewState.spaces.length);
		this.spacesButton.classList.toggle('checked', this.viewState.spaces !== undefined);

		this.sortButton.textContent = SORT_LABELS[this.viewState.sort];

		const parts: string[] = [];
		if (this.viewState.attentionOnly) {
			parts.push(localize('paradis.agentLive.filterAttention', "要対応のみ"));
		}
		if (this.viewState.statuses.length > 0) {
			parts.push(localize('paradis.agentLive.filterStatuses', "状態: {0}", this.viewState.statuses.map(status => STATUS_LABELS[status]).join('・')));
		}
		if (this.viewState.spaces !== undefined) {
			parts.push(localize('paradis.agentLive.filterSpaces', "スペース: {0}", this.viewState.spaces.map(space => spaceNames.get(space) ?? space).join('・')));
		}
		if (this.viewState.hidden.length > 0) {
			parts.push(localize('paradis.agentLive.filterHidden', "非表示 {0} 件", this.viewState.hidden.length));
		}
		this.filterBar.classList.toggle('hidden', !paradisHasAgentLiveFilter(this.viewState));
		this.filterBarText.textContent = parts.join(' / ');

		this.statusBarText.textContent = localize('paradis.agentLive.shownCount', "{0} / {1} 件を表示", shown, entries.length);
		this.statusBarSort.textContent = SORT_LABELS[this.viewState.sort];
	}

	private applyRowHeightInput(): void {
		const parsed = Number.parseInt(this.rowHeightInput.value, 10);
		if (!Number.isFinite(parsed)) {
			// 空欄や記号だけの入力は直前の値へ戻す。
			this.rowHeightInput.value = String(this.lastRowHeight);
			return;
		}
		this.lastRowHeight = paradisClampAgentLiveRowHeight(parsed);
		// 丸めた結果を必ず書き戻す。Enter 確定では入力欄がフォーカスを持ったままなので、
		// 描画側の「入力中は上書きしない」ガードに阻まれて表示だけ元の値が残る。
		this.rowHeightInput.value = String(this.lastRowHeight);
		this.viewState.minRowHeight = this.lastRowHeight;
		this.commit();
	}

	private spaceOptions(entries: readonly IParadisAgentLiveEntry[]): Map<string, string> {
		const names = new Map<string, string>();
		for (const entry of entries) {
			const key = entry.stateKey ?? '';
			if (!names.has(key)) {
				names.set(key, entry.detail ? `${entry.spaceName} (${entry.detail})` : entry.spaceName);
			}
		}
		return names;
	}

	/**
	 * 実体の消えた端末を「非表示」台帳から外す。トークンは再利用されないため、放っておくと
	 * 存在しない端末の件数が絞り込みバーに出続ける。エントリがまだ一件も揃っていない
	 * 起動直後には触らない (意図した非表示を消してしまうため)。
	 */
	private pruneHiddenTokens(entries: readonly IParadisAgentLiveEntry[]): void {
		if (entries.length === 0 || this.viewState.hidden.length === 0) {
			return;
		}
		const known = new Set(entries.map(entry => entry.token));
		const kept = this.viewState.hidden.filter(token => known.has(token));
		if (kept.length !== this.viewState.hidden.length) {
			this.viewState.hidden = kept;
			this._onDidChangeViewState.fire();
		}
	}

	// ------------------------------------------------------------------ 部品

	private createIconButton(parent: HTMLElement, codicon: string, label: string): HTMLElement {
		const button = append(parent, $(`button.paradis-agent-live-icon-button.codicon.codicon-${codicon}`));
		button.setAttribute('aria-label', label);
		this.registerHover(button, label);
		return button;
	}

	private createMiniButton(parent: HTMLElement, codicon: string, label: string, disposables: DisposableStore): HTMLElement {
		const button = append(parent, $(`button.paradis-agent-live-mini-button.codicon.codicon-${codicon}`));
		button.setAttribute('aria-label', label);
		disposables.add(this.hoverService.setupManagedHover(getDefaultHoverDelegate('element'), button, label));
		return button;
	}

	private registerHover(element: HTMLElement, text: string): void {
		this._register(this.hoverService.setupManagedHover(getDefaultHoverDelegate('element'), element, text));
	}

	// ------------------------------------------------------------------ 可視性

	private observeIntersections(scroll: HTMLElement): void {
		const window = getWindow(scroll);
		if (!window.IntersectionObserver) {
			return;
		}
		// 画面外のタイルはミラーの購読を止める (復帰時にスナップショットから取り直す)。
		this.intersectionObserver = new window.IntersectionObserver(records => {
			for (const record of records) {
				const token = this.tokensByElement.get(record.target);
				if (token) {
					this.tiles.get(token)?.mirror?.setVisible(record.isIntersecting);
				}
			}
		}, { root: scroll, rootMargin: '150px' });
		this._register({ dispose: () => this.intersectionObserver?.disconnect() });
	}

	// ------------------------------------------------------------------ 操作

	private toggleStatus(status: ParadisAgentLiveStatus): void {
		const index = this.viewState.statuses.indexOf(status);
		if (index >= 0) {
			this.viewState.statuses.splice(index, 1);
		} else {
			this.viewState.statuses.push(status);
			this.viewState.attentionOnly = false;
		}
		this.commit();
	}

	private toggleAttentionOnly(): void {
		this.viewState.attentionOnly = !this.viewState.attentionOnly;
		if (this.viewState.attentionOnly) {
			this.viewState.statuses = [];
		}
		this.commit();
	}

	private togglePinned(token: string): void {
		const index = this.viewState.pinned.indexOf(token);
		if (index >= 0) {
			this.viewState.pinned.splice(index, 1);
		} else {
			this.viewState.pinned.push(token);
		}
		this.commit();
	}

	private showSpacesMenu(): void {
		const options = this.spaceOptions(this.model.entries);
		const selected = this.viewState.spaces;
		const actions: IAction[] = [...options].map(([key, label]) => toAction({
			id: `paradis.agentLive.space.${key}`,
			label,
			checked: selected === undefined || selected.includes(key),
			run: () => {
				const current = selected === undefined ? [...options.keys()] : [...selected];
				const index = current.indexOf(key);
				if (index >= 0) {
					current.splice(index, 1);
				} else {
					current.push(key);
				}
				// 全部外した / 全部入れた場合は「すべて」に戻す (空の一覧を見せない)。
				this.viewState.spaces = current.length === 0 || current.length === options.size ? undefined : current;
				this.commit();
			},
		}));
		actions.push(new Separator());
		actions.push(toAction({
			id: 'paradis.agentLive.space.all',
			label: localize('paradis.agentLive.selectAllSpaces', "すべてのスペース"),
			run: () => {
				this.viewState.spaces = undefined;
				this.commit();
			},
		}));
		this.contextMenuService.showContextMenu({ getAnchor: () => this.spacesButton, getActions: () => actions });
	}

	private showSortMenu(): void {
		const actions: IAction[] = (Object.keys(SORT_LABELS) as ParadisAgentLiveSort[]).map(sort => toAction({
			id: `paradis.agentLive.sort.${sort}`,
			label: SORT_LABELS[sort],
			checked: this.viewState.sort === sort,
			run: () => {
				this.viewState.sort = sort;
				this.commit();
			},
		}));
		this.contextMenuService.showContextMenu({ getAnchor: () => this.sortButton, getActions: () => actions });
	}

	private clearFilters(): void {
		this.viewState.statuses = [];
		this.viewState.spaces = undefined;
		this.viewState.attentionOnly = false;
		this.viewState.hidden = [];
		this.commit();
	}

	private reset(): void {
		this.viewState.sort = 'attention';
		this.viewState.sortDesc = true;
		this.viewState.group = 'none';
		this.viewState.columns = 3;
		this.viewState.minRowHeight = PARADIS_AGENT_LIVE_DEFAULT_ROW_HEIGHT;
		this.viewState.pinTop = true;
		this.viewState.pinned = [];
		this.viewState.manualOrder = [];
		this.clearFilters();
	}

	private commit(): void {
		this.render();
		this._onDidChangeViewState.fire();
	}

	override dispose(): void {
		this.intersectionObserver?.disconnect();
		super.dispose();
	}
}
