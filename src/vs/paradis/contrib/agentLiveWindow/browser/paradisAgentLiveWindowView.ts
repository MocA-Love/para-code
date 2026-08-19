/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-PATCH/PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import { $, addDisposableListener, append, clearNode, EventType, getWindow, isHTMLElement } from '../../../../base/browser/dom.js';
import { IManagedHover } from '../../../../base/browser/ui/hover/hover.js';
import { getDefaultHoverDelegate } from '../../../../base/browser/ui/hover/hoverDelegateFactory.js';
import { IntervalTimer } from '../../../../base/common/async.js';
import { onUnexpectedError } from '../../../../base/common/errors.js';
import { Emitter } from '../../../../base/common/event.js';
import { Disposable, DisposableMap, DisposableStore, MutableDisposable } from '../../../../base/common/lifecycle.js';
import { localize } from '../../../../nls.js';
import { IHoverService } from '../../../../platform/hover/browser/hover.js';
import { IInstantiationService } from '../../../../platform/instantiation/common/instantiation.js';
import { ITerminalInstance } from '../../../../workbench/contrib/terminal/browser/terminal.js';
import { getParadisPaneIndicatorHost, onDidChangeParadisPaneIndicatorHost } from '../../agentBrowser/browser/paradisPaneIndicator.js';
import { ParadisAgentLiveMirror } from './paradisAgentLiveMirror.js';
import { ParadisAgentLiveModel } from './paradisAgentLiveModel.js';
import { ParadisAgentLiveSettingsPopover } from './paradisAgentLiveSettingsPopover.js';
import {
	IParadisAgentLiveEntry,
	IParadisAgentLiveViewState,
	PARADIS_AGENT_LIVE_DEFAULT_FONT_SIZE,
	PARADIS_AGENT_LIVE_DEFAULT_ROW_HEIGHT,
	PARADIS_AGENT_LIVE_STATUS_ORDER,
	ParadisAgentLiveStatus,
	paradisAgentLiveSpaceLabel,
	paradisApplyAgentLiveManualDrop,
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
	/** 切り詰められた見出しの全文。名前が変わるたび差し替える */
	readonly titleHover: IManagedHover;
	readonly clock: HTMLElement;
	readonly readonlyMark: HTMLElement;
	readonly badge: HTMLElement;
	readonly spaceBar: HTMLElement;
	readonly pinButton: HTMLElement;
	readonly browserButton: HTMLElement;
	/** 共有ページのツールチップ。共有先が変わるたび差し替える */
	readonly browserHover: IManagedHover;
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

/** 経過時間表示の更新間隔。秒単位の表示なので1秒で足りる。 */
const CLOCK_INTERVAL = 1000;

/**
 * deltaMode が「行」のときの1行ぶん (px)。ピクセル以外を返すのは一部の環境だけ (Electron は
 * 常にピクセル)。値は Blink の既定ステップ (PixelsPerLineStep) に合わせてある。
 */
const WHEEL_LINE_HEIGHT = 40;

/**
 * ホイールの移動量をピクセルへ直す。壁 (`.paradis-agent-live-scroll`) は素の `overflow: auto`
 * なので、ブラウザ既定のスクロールと同じ量にしないと、タイルの上と外 (見出しの上など、
 * 横取りしない場所) とで速さが変わってしまう。正規化して係数を掛ける monaco の
 * ScrollableElement とは別物である点に注意。
 */
function wheelScrollPixels(event: WheelEvent, pageHeight: number): number {
	// 定数はインスタンス側から読む。ここは補助ウィンドウで動くので、コンストラクタを直に
	// 参照するとメインウィンドウ側のレルムを見ることになる (値は同じだが、経路を作らない)。
	switch (event.deltaMode) {
		case event.DOM_DELTA_LINE:
			return event.deltaY * WHEEL_LINE_HEIGHT;
		case event.DOM_DELTA_PAGE:
			return event.deltaY * pageHeight;
		default:
			return event.deltaY;
	}
}

/** 見出しを1本の文字列にしたもの (ツールチップと読み上げ用)。 */
function tileTitleText(entry: IParadisAgentLiveEntry): string {
	const parts = [paradisAgentLiveSpaceLabel(entry.spaceName, entry.detail)];
	if (entry.title) {
		parts.push(entry.title);
	}
	return parts.join(' · ');
}

/** 「端に着いている」とみなす許容差 (px)。 */
const SCROLL_EDGE_TOLERANCE = 1;

/** その要素がその向きへまだスクロールできるか (端に着いていたら false)。 */
function canScrollElement(element: HTMLElement, deltaY: number): boolean {
	const max = element.scrollHeight - element.clientHeight;
	if (max <= 0) {
		return false;
	}
	// 端の判定には遊びを持たせる。scrollTop は HiDPI や慣性スクロールで小数になり、
	// 厳密比較だと端に着いた後も1イベントぶん余計に吸われる。
	return deltaY < 0 ? element.scrollTop > SCROLL_EDGE_TOLERANCE : element.scrollTop < max - SCROLL_EDGE_TOLERANCE;
}

/**
 * ライブウィンドウの中身 (ツールバー + タイルのグリッド)。
 *
 * 常に見せるのは「状態の内訳」と「絞り込み中かどうか」だけにして、並び替え・スペース・
 * 表示の設定はまとめて歯車のポップオーバーへ畳んでいる。タイルの面積を最優先するため。
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
	private readonly root: HTMLElement;
	/** タイルの壁を縦に送るスクロール領域。タイル上のホイールをここへ流し直すために持つ */
	private readonly scroll: HTMLElement;
	private readonly wall: HTMLElement;
	/** 手動並び替え中、挿入先を示す縦線。壁の直下に1本だけ置き、dragover のたびに位置を書き換える */
	private readonly insertLine: HTMLElement;
	/**
	 * setDragImage 用のゴースト要素。コンストラクタで先に作って画面外に置いておく
	 * (ドラッグ開始のたびに生成すると、レイアウトが一度も走っていない状態のまま
	 * setDragImage に渡ることになり、初回だけゴーストが空に見えることがある)。
	 */
	private readonly dragGhostElement: HTMLElement;
	/** dragover で判定した現在の挿入先 (どのタイルの前/後か) */
	private dropTarget: { readonly token: string; readonly after: boolean } | undefined;
	private readonly filterBar: HTMLElement;
	private readonly filterBarText: HTMLElement;
	private readonly countText: HTMLElement;
	private readonly attentionChip: HTMLElement;
	private readonly settingsButton: HTMLElement;

	/** 開いている間だけ生きる歯車ポップオーバー */
	private readonly popover = this._register(new MutableDisposable<ParadisAgentLiveSettingsPopover>());
	/** ペインインジケータホストの購読。ホストが差し替わるたび張り直す */
	private readonly indicatorHostListener = this._register(new MutableDisposable());

	private intersectionObserver: IntersectionObserver | undefined;
	private draggedToken: string | undefined;
	/** 現在描画されている順序 (手動並び替えの土台に使う) */
	private visibleOrder: string[] = [];

	constructor(
		container: HTMLElement,
		private readonly model: ParadisAgentLiveModel,
		private readonly viewState: IParadisAgentLiveViewState,
		/**
		 * この aux window を透過で開けたか (Windows では常に false)。auxiliary window の
		 * コンテナ要素はメインウィンドウの class (`paradis-transparent` を含む) を自動でミラーし
		 * 続けるため (applyHTML の trackAttributes)、そこへ独自クラスを付けても次の同期で消される。
		 * 代わりに、このビューが自分で握っている {@link root} へクラスを立てることで、透過対応
		 * するのを Windows では確実に避ける。
		 */
		transparencyActive: boolean,
		@IInstantiationService private readonly instantiationService: IInstantiationService,
		@IHoverService private readonly hoverService: IHoverService,
	) {
		super();

		const root = append(container, $('.paradis-agent-live-window'));
		root.classList.toggle('paradis-agent-live-transparent', transparencyActive);
		this.root = root;

		const dragGhost = $('.paradis-agent-live-drag-ghost');
		// 画面外に置く。setDragImage は呼び出し時点のスナップショットを使うため、要素が
		// このタイミングで DOM に存在してさえいれば見た目に出す必要はない。
		dragGhost.style.position = 'fixed';
		dragGhost.style.top = '-9999px';
		dragGhost.style.left = '-9999px';
		getWindow(container).document.body.appendChild(dragGhost);
		this._register({ dispose: () => dragGhost.remove() });
		this.dragGhostElement = dragGhost;

		// --- ツールバー (1段) -------------------------------------------------------------
		const toolbar = append(root, $('.paradis-agent-live-toolbar'));
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
		this.countText = append(toolbar, $('span.paradis-agent-live-tool-label'));
		this.settingsButton = this.createIconButton(toolbar, 'settings-gear', localize('paradis.agentLive.settings', "表示と並び"));
		this.settingsButton.setAttribute('aria-haspopup', 'true');
		this._register(addDisposableListener(this.settingsButton, EventType.CLICK, () => this.toggleSettings()));

		// --- 絞り込み状況 ----------------------------------------------------------------
		this.filterBar = append(root, $('.paradis-agent-live-filterbar'));
		this.filterBarText = append(this.filterBar, $('span.paradis-agent-live-grow'));
		const clearButton = append(this.filterBar, $('button.paradis-agent-live-link'));
		clearButton.textContent = localize('paradis.agentLive.clearFilters', "絞り込みを解除");
		this._register(addDisposableListener(clearButton, EventType.CLICK, () => this.clearFilters()));

		// --- グリッド --------------------------------------------------------------------
		const scroll = append(root, $('.paradis-agent-live-scroll'));
		this.scroll = scroll;
		this.wall = append(scroll, $('.paradis-agent-live-wall'));
		// 壁 (wall) の子要素として置く。render() の place() はタイルの root しか動かさないため、
		// insertLine は「place() が触れない余り物」として毎回タイルの後ろへ押し出され続ける
		// (place() は wall.childNodes.item(cursor) と比較して不一致なら insertBefore するので、
		// タイルではない insertLine は必ず不一致になり前へ押し出される)。壁の外に置いて座標系を
		// 分けるより単純なため、この暗黙の押し出しに乗っている。
		this.insertLine = append(this.wall, $('.paradis-agent-live-insert-line'));
		// dragover/drop は壁側で一括して受ける。個々のタイルに付けていた頃は、ドロップ先の
		// カード全体を枠でハイライトしていたが、掴んでいないカードまで光って見えて紛らわしかった
		// ため、挿入位置を示す縦線 (insertLine) 方式に変えている。
		this._register(addDisposableListener(this.wall, EventType.DRAG_OVER, event => this.onWallDragOver(event)));
		this._register(addDisposableListener(this.wall, EventType.DROP, event => this.onWallDrop(event)));
		// 壁の外 (ツールバーや絞り込みバーの上) へポインタが出たら線を消す。dragleave は子要素間の
		// 出入りでも飛んでくるため、relatedTarget が壁の中に留まっている間は無視する。
		this._register(addDisposableListener(this.wall, EventType.DRAG_LEAVE, event => {
			const related = event.relatedTarget;
			if (!isHTMLElement(related) || !this.wall.contains(related)) {
				this.hideInsertLine();
			}
		}));

		this.observeIntersections(scroll);

		this._register(this.model.onDidChangeEntries(() => this.render()));
		// 共有ブラウザのボタンはバインディングの増減で変わる。ホスト自体が後から登録される
		// (デスクトップ workbench の contribution が復元後に登録する) ので、その差し替えも追う。
		this._register(onDidChangeParadisPaneIndicatorHost(() => this.bindIndicatorHost()));
		this.bindIndicatorHost();
		const clock = this._register(new IntervalTimer());
		clock.cancelAndSet(() => this.updateClocks(), CLOCK_INTERVAL, getWindow(container));

		this.render();
	}

	/** ウィンドウのサイズが変わったとき。各ミラーの縮小率を計算し直す。 */
	layout(): void {
		for (const tile of this.tiles.values()) {
			tile.mirror?.layout();
		}
		// ツールバーは折り返すので、幅が変わると歯車の位置も動く。開いたままなら追従させる。
		this.popover.value?.layout();
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
		if (this.viewState.fillRows && this.viewState.group === 'none' && sorted.length > 0) {
			classes.push('fill');
		}
		this.wall.className = classes.join(' ');
		this.wall.style.setProperty('--paradis-agent-live-row-height', `${this.viewState.rowHeight}px`);

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
		const movedTiles: ITile[] = [];
		let cursor = 0;
		const activeDocument = this.wall.ownerDocument;
		// 動かしたタイルは呼び出し側が覚えておき、ループの外でまとめて後始末する
		// (中で scrollHeight を読むと、DOM 変更と交互になって強制レイアウトがタイル数ぶん走る)。
		const place = (element: HTMLElement): boolean => {
			const current: Node | null = this.wall.childNodes.item(cursor);
			const moved = current !== element;
			if (moved) {
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
			return moved;
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
					if (place(tile.root)) {
						movedTiles.push(tile);
					}
				}
			}
		}

		// 動かしたタイルの端末領域は scrollTop が 0 に戻っている (DOM から一度外れるため)。
		// 追従が生きているものは最新行へ戻す —— 戻さないと、並べ替えの拍子に下部が見えなく
		// なったまま固まる。scroll は非同期に届くので、ここで同期に戻しておくことが
		// ミラー側の判定 (paradisAgentLiveMirror.onScroll) の前提にもなっている。
		for (const tile of movedTiles) {
			tile.mirror?.pinToBottom();
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
		root.tabIndex = 0;

		// 見出しは1行だけ。名前・経過時間・状態を横に並べ、タイルの面積を端末へ回す。
		const head = append(root, $('.paradis-agent-live-tile-head'));
		// スペース色の帯はヘッダーの高さだけに収める (head 自身を position: relative の基準に
		// している)。以前はタイル全体に伸ばしていたが、端末領域の不透明な背景でほぼ隠れて見えず、
		// ウィンドウ透過を有効にしたときだけ帯が下まで見えてしまっていた。
		const spaceBar = append(head, $('.paradis-agent-live-spacebar'));
		const dragHandle = append(head, $('span.paradis-agent-live-drag-handle.codicon.codicon-gripper'));
		// 掴めるのはハンドルだけ。タイル全体を draggable にすると、見出しのボタンや端末の
		// テキスト選択からもドラッグが始まってしまい、既定のブラウザゴースト (xterm の中身
		// ごとの要素スナップショット) が隣のタイルへ重なって見える不具合の原因になっていた。
		dragHandle.draggable = true;
		disposables.add(this.hoverService.setupManagedHover(getDefaultHoverDelegate('element'), dragHandle, localize('paradis.agentLive.dragHandle', "ドラッグして並べ替え")));
		const title = append(head, $('.paradis-agent-live-tile-title.paradis-agent-live-grow'));
		// 見出しは幅次第で切り詰められる。全文を読む手段を残す。
		const titleHover = disposables.add(this.hoverService.setupManagedHover(getDefaultHoverDelegate('element'), title, ''));
		const browserButton = append(head, $('button.paradis-agent-live-browser-button.codicon.codicon-plug'));
		const browserHover = disposables.add(this.hoverService.setupManagedHover(getDefaultHoverDelegate('element'), browserButton, ''));
		disposables.add(addDisposableListener(browserButton, EventType.CLICK, event => {
			event.stopPropagation();
			getParadisPaneIndicatorHost()?.revealBoundPage(entry.instanceId);
		}));
		const readonlyMark = append(head, $('span.paradis-agent-live-tile-readonly'));
		const clock = append(head, $('span.paradis-agent-live-tile-clock'));
		const badge = append(head, $('span.paradis-agent-live-badge'));
		const actions = append(head, $('.paradis-agent-live-tile-actions'));

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

		const termContainer = append(root, $('.paradis-agent-live-term'));

		// ホイールの主従。既定では壁 (ウィンドウ全体) を送り、端末そのものをクリックして
		// 掴んでいるタイルの中だけ端末のスクロールにする。
		//
		// 判定はタイル全体ではなく端末領域のフォーカスで行う。タイルは tabIndex を持つので、
		// 見出しやピン/非表示のボタンを押しただけでもタイル側にはフォーカスが載ってしまい、
		// 「端末を触っていないのに端末スクロール」になってしまうため。
		//
		// capture で受けるのは、xterm 側のリスナへ届く前に決める必要があるため。xterm の
		// viewport は「自分がスクロールできたときだけ」イベントを止めるので、素通しにすると
		// タイルの上ではホイールが必ず端末に吸われ、壁が動かせない。さらにスクロールバックを
		// 持たないバッファ (alt 画面の TUI) では、xterm がホイールを上下キーへ変換して
		// ユーザー入力として発火するため、ミラーの転送を通って**本物の端末へ矢印キーが入る**。
		// 触っていないタイルの上を通り過ぎただけでエージェントの選択が動くのは避けたい。
		disposables.add(addDisposableListener(termContainer, EventType.MOUSE_WHEEL, (event: WheelEvent) => {
			// 横だけの操作 (トラックパッドの横スワイプ) はタイルへ渡す。切れている右端を見るのに
			// 使えるうえ、上下キーへの変換は縦の動きにしか起きない。判定は xterm 側の早期 return
			// (MouseService) と同じ生の値で行う —— 正規化した値で見ると、丸めで 0 になった微小な
			// 縦成分を「横のみ」と取り違え、xterm 側の累積だけが進んでしまう。
			if (event.deltaY === 0) {
				return;
			}
			if (termContainer.matches(':focus-within')) {
				// 掴んでいるタイルでは、まず端末自身へ送る (マウス報告中の TUI か、送れる
				// スクロールバックがある場合)。
				const mirror = this.tiles.get(entry.token)?.mirror;
				if (mirror?.shouldForwardWheel(event.deltaY)) {
					return;
				}
				// 端末が受け取れない場合 (マウス報告なしの alt 画面、または端まで来たとき) に
				// そのまま渡すと、xterm がホイールを矢印キーへ変換して**本物の端末へ**入力して
				// しまう。掴んだ途端に何も動かせなくなるのも避けたいので、切れている上部を
				// 見るためのタイル自身のスクロールへ落とす。
				if (canScrollElement(termContainer, event.deltaY)) {
					event.preventDefault();
					event.stopPropagation();
					termContainer.scrollTop += wheelScrollPixels(event, termContainer.clientHeight);
					return;
				}
			}
			event.preventDefault();
			event.stopPropagation();
			this.scroll.scrollTop += wheelScrollPixels(event, this.scroll.clientHeight);
		}, { capture: true, passive: false }));

		// ドラッグ＆ドロップによる手動並び替え。dragover/drop は壁 (wall) 側で一括して受ける
		// (onWallDragOver/onWallDrop)。ここではドラッグの開始と終了、ゴーストの差し替えだけを扱う。
		disposables.add(addDisposableListener(dragHandle, EventType.DRAG_START, event => {
			this.draggedToken = entry.token;
			root.classList.add('dragging');
			event.dataTransfer?.setData('text/plain', entry.token);
			// setDragImage を指定しないと、ブラウザ既定のゴースト (タイル全体、xterm の中身
			// ごとの要素スナップショット) が使われ、隣のタイルへ重なって「掴んでいないタイルまで
			// プレビューされている」ように見えてしまう。タイトルだけの軽量なチップに差し替える。
			// entry はタイル生成時点のクロージャなので、名前が変わった端末では古いラベルになる
			// ことがある。this.tiles から今の entry を引き直す (ホイール処理と同じ理由)。
			const current = this.tiles.get(entry.token)?.entry ?? entry;
			event.dataTransfer?.setDragImage(this.dragGhost(tileTitleText(current)), 14, 14);
		}));
		disposables.add(addDisposableListener(dragHandle, EventType.DRAG_END, () => {
			this.draggedToken = undefined;
			root.classList.remove('dragging');
			this.hideInsertLine();
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

		const tile: ITile = { root, title, titleHover, clock, readonlyMark, badge, spaceBar, pinButton, browserButton, browserHover, mirror, entry };
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
		mirror.setFontSize(this.mirrorFontSize());
		mirror.start().catch(onUnexpectedError);
		return mirror;
	}

	/** ミラーへ渡す文字サイズ。undefined ならタイル幅に全体を収める従来動作。 */
	private mirrorFontSize(): number | undefined {
		return this.viewState.fitFontToTile ? undefined : this.viewState.fontSize;
	}

	private updateTile(tile: ITile, entry: IParadisAgentLiveEntry, now: number): void {
		tile.entry = entry;
		this.updateTileTitle(tile, entry);
		this.updateTileBrowser(tile, entry);
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
		// 入力の転送ができないミラーは、打っても無反応に見えるので明示する。
		tile.readonlyMark.textContent = tile.mirror?.isReadonly
			? localize('paradis.agentLive.readonlyTile', "表示のみ")
			: '';
		tile.mirror?.setFontSize(this.mirrorFontSize());
		tile.root.setAttribute('aria-label', localize(
			'paradis.agentLive.tileLabel', "{0}（{1}）", tileTitleText(entry), STATUS_LABELS[entry.status]));
		this.updateTileClock(tile, now);
	}

	/**
	 * 見出しの名前を組み立てる。
	 *
	 * 主役は worktree 名。リポジトリ名は同じリポジトリの worktree 全てで同じ文字列になるため、
	 * それだけでは「どのエージェントか」が判別できない。所属を示すために前に薄く添え、
	 * 端末タイトル (エージェント名やセッションID) は最後に薄く回す。
	 *
	 * スペース部分の区切りは {@link paradisAgentLiveSpaceLabel} と同じ '/' に揃える
	 * (あちらはグループ見出しと絞り込みの選択肢を作る。書式を変えるときは両方直す)。
	 */
	private updateTileTitle(tile: ITile, entry: IParadisAgentLiveEntry): void {
		clearNode(tile.title);
		append(tile.title, $('span.paradis-agent-live-tile-space')).textContent = entry.spaceName;
		if (entry.detail) {
			append(tile.title, $('span.paradis-agent-live-tile-slash')).textContent = '/';
			append(tile.title, $('span.paradis-agent-live-tile-worktree')).textContent = entry.detail;
		}
		if (entry.title) {
			append(tile.title, $('span.paradis-agent-live-tile-slash')).textContent = '·';
			append(tile.title, $('span.paradis-agent-live-tile-term')).textContent = entry.title;
		}
		tile.titleHover.update(tileTitleText(entry));
	}

	/**
	 * 共有ブラウザのボタン。para browser MCP で共有中の端末にだけ出し、押すとメインウィンドウが
	 * そのページのスペースへ切り替わる。バインディングモデルは electron-browser レイヤーに
	 * あるため、ペインインジケータのホスト経由で参照する (Web ビルドではホストが未登録＝非表示)。
	 */
	private updateTileBrowser(tile: ITile, entry: IParadisAgentLiveEntry): void {
		const page = getParadisPaneIndicatorHost()?.getBoundPage(entry.instanceId);
		tile.browserButton.classList.toggle('hidden', !page);
		if (!page) {
			// 共有が解除された後もツールチップに前のページ名が残らないようにする。
			tile.browserHover.update('');
			return;
		}
		const label = localize('paradis.agentLive.revealBrowser', "「{0}」を共有中 — このスペースへ切り替えてブラウザを開く", page.title || page.url);
		tile.browserButton.setAttribute('aria-label', label);
		tile.browserHover.update(label);
	}

	private bindIndicatorHost(): void {
		this.indicatorHostListener.value = getParadisPaneIndicatorHost()?.onDidChangeState(() => this.updateBrowserButtons());
		this.updateBrowserButtons();
	}

	/** 共有状態だけが変わったとき。名前や状態は動かさずボタンの出し入れだけを行う。 */
	private updateBrowserButtons(): void {
		for (const tile of this.tiles.values()) {
			this.updateTileBrowser(tile, tile.entry);
		}
	}

	private updateTileClock(tile: ITile, now: number): void {
		const elapsed = paradisFormatAgentLiveDuration(now - tile.entry.since);
		tile.clock.textContent = paradisIsAttentionStatus(tile.entry.status)
			? localize('paradis.agentLive.waiting', "{0} 待機中", elapsed)
			: tile.entry.status === 'review'
				? localize('paradis.agentLive.completed', "{0}前に完了", elapsed)
				: elapsed;
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

		const spaceNames = this.spaceOptions(entries);
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

		this.countText.textContent = localize('paradis.agentLive.shownCount', "{0} / {1} 件", shown, entries.length);
		this.settingsButton.classList.toggle('checked', !!this.popover.value);

		this.popover.value?.update();
	}

	private spaceOptions(entries: readonly IParadisAgentLiveEntry[]): Map<string, string> {
		const names = new Map<string, string>();
		for (const entry of entries) {
			const key = entry.stateKey ?? '';
			if (!names.has(key)) {
				names.set(key, paradisAgentLiveSpaceLabel(entry.spaceName, entry.detail));
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

	// ------------------------------------------------------------------ ドラッグ&ドロップ

	/**
	 * dragover を壁全体で受け、ポインタの下にあるタイルの左右どちら側へ挿すかを判定して
	 * 挿入線 (insertLine) をその境目へ動かす。実際の並べ替えは drop 時にまとめて行う。
	 */
	private onWallDragOver(event: DragEvent): void {
		if (!this.draggedToken) {
			return;
		}
		const targetElement = isHTMLElement(event.target) ? event.target.closest<HTMLElement>('.paradis-agent-live-tile') : null;
		const token = targetElement && this.tokensByElement.get(targetElement);
		if (!targetElement || !token || token === this.draggedToken) {
			this.hideInsertLine();
			return;
		}
		event.preventDefault();
		const rect = targetElement.getBoundingClientRect();
		const wallRect = this.wall.getBoundingClientRect();
		const after = event.clientX > rect.left + rect.width / 2;
		this.dropTarget = { token, after };
		this.insertLine.style.display = 'block';
		this.insertLine.style.top = `${rect.top - wallRect.top}px`;
		this.insertLine.style.height = `${rect.height}px`;
		this.insertLine.style.width = '3px';
		this.insertLine.style.left = `${(after ? rect.right : rect.left) - wallRect.left - 1.5}px`;
	}

	private onWallDrop(event: DragEvent): void {
		event.preventDefault();
		const dragged = this.draggedToken;
		const target = this.dropTarget;
		this.draggedToken = undefined;
		this.hideInsertLine();
		if (!dragged || !target || dragged === target.token) {
			return;
		}
		this.viewState.manualOrder = paradisApplyAgentLiveManualDrop(this.viewState.manualOrder, this.visibleOrder, dragged, target.token, target.after);
		// 自動ソート中にドラッグされたら、見えている並びを保ったまま手動へ移す。
		this.viewState.sort = 'manual';
		this.commit();
	}

	private hideInsertLine(): void {
		this.insertLine.style.display = 'none';
		this.dropTarget = undefined;
	}

	/** setDragImage 用の軽量ゴースト ({@link dragGhostElement}、コンストラクタで生成済み) のラベルを差し替えて返す。 */
	private dragGhost(label: string): HTMLElement {
		this.dragGhostElement.textContent = label;
		return this.dragGhostElement;
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

	private toggleSettings(): void {
		if (this.popover.value) {
			this.closeSettings(false);
			return;
		}
		this.popover.value = this.instantiationService.createInstance(
			ParadisAgentLiveSettingsPopover,
			this.root,
			this.viewState,
			{
				anchor: this.settingsButton,
				spaces: () => this.spaceOptions(this.model.entries),
				visibleCells: () => this.visibleCells(),
				commit: () => this.commit(),
				close: restoreFocus => this.closeSettings(restoreFocus),
				reset: () => this.reset(),
			},
		);
		this.settingsButton.classList.add('checked');
		this.settingsButton.setAttribute('aria-expanded', 'true');
	}

	private closeSettings(restoreFocus: boolean): void {
		this.popover.clear();
		this.settingsButton.classList.remove('checked');
		this.settingsButton.setAttribute('aria-expanded', 'false');
		if (restoreFocus) {
			// Escape で閉じたときだけ戻す。外側をクリックして閉じた場合に奪うと、そのクリックで
			// 掴んだはずの端末からフォーカスを取り上げてしまう。
			this.settingsButton.focus();
		}
	}

	/**
	 * 設定のヒントに出す「いま何桁見えているか」。画面に出ているタイルから測る —— 絞り込みで
	 * 外れたタイルは DOM から抜いてあるだけで台帳には残っており、そこから測ると寸法が 0 になって
	 * ヒントが丸ごと消える。
	 */
	private visibleCells(): { readonly cols: number; readonly rows: number; readonly totalCols: number; readonly totalRows: number } | undefined {
		for (const tile of this.tiles.values()) {
			if (tile.root.isConnected) {
				const cells = tile.mirror?.getVisibleCells();
				if (cells) {
					return cells;
				}
			}
		}
		return undefined;
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
		this.viewState.fillRows = true;
		this.viewState.rowHeight = PARADIS_AGENT_LIVE_DEFAULT_ROW_HEIGHT;
		this.viewState.fontSize = PARADIS_AGENT_LIVE_DEFAULT_FONT_SIZE;
		this.viewState.fitFontToTile = false;
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
