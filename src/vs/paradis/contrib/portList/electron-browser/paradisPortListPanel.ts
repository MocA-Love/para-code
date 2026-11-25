/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-PATCH/PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

// ポート一覧のクリックで開く検索/killパネル。paradisLimitsMonitorPanel.ts と同じ自前DOM
// (絶対配置)方式で、ポーリングは行わずウィジェットから updateSnapshot() を受け取るだけの
// 受け身のビュー。
//
// 全公開(0.0.0.0等にバインドされたポート)の行は、文字の札「全公開」1 つで示す（以前は色の点・アドレスの札「*」・
// 行の塗りの 3 つで示していて、意味が読めなかった）。札の無い行は、全公開ではない（ローカルだけ、または
// 特定のアドレスだけ）。並び替えは列の見出しを押す（メニューにすると、パネルの外を押した扱いで閉じてしまう）。
// 並びと「プロセスでまとめる」は IStorageService に覚える。純関数は common/paradisPortListView.ts。
//
// フィルタは「All / 全公開のみ(0.0.0.0等にバインドされたポート)」の2値にとどめている。UDPは
// データ源(lsof/proc直読み)がTCPのみを収集しているため今回は対象外、「自分のプロセスのみ」は
// OSごとに所有ユーザーの取得方法が割れる(Windowsはtasklistの追加オプションが必要)ため見送った。

import './media/paradisPortList.css';
import * as dom from '../../../../base/browser/dom.js';
import { getDefaultHoverDelegate } from '../../../../base/browser/ui/hover/hoverDelegateFactory.js';
import { Codicon } from '../../../../base/common/codicons.js';
import { ThemeIcon } from '../../../../base/common/themables.js';
import { Disposable, DisposableStore, MutableDisposable } from '../../../../base/common/lifecycle.js';
import { disposableTimeout } from '../../../../base/common/async.js';
import { paradisCloseWhenModalOpens } from '../../../browser/paradisAnchoredPopover.js';
import { createParadisChip } from '../../../browser/paradisBadges.js';
import { paradisButtonClasses } from '../../../browser/paradisButton.js';
import { localize } from '../../../../nls.js';
import { IHoverService } from '../../../../platform/hover/browser/hover.js';
import { ILayoutService } from '../../../../platform/layout/browser/layoutService.js';
import { IStorageService, StorageScope, StorageTarget } from '../../../../platform/storage/common/storage.js';
import { IParadisPortEntry, IParadisPortListSnapshot } from '../common/paradisPortList.js';
import { paradisPortListPanelGeometry } from '../common/paradisPortListLayout.js';
import { IParadisPortGroup, IParadisPortListView, ParadisPortSortKey, paradisGroupPortEntries, paradisNextPortSort, paradisParsePortListView, paradisSortPortEntries } from '../common/paradisPortListView.js';

const $ = dom.$;

type ParadisPortListFilter = 'all' | 'risky';

/** 行の終了の確認を出したまま放っておいたとき、元の終了ボタンへ戻すまでの時間。 */
const KILL_CONFIRM_TIMEOUT_MS = 5000;

/** 選んだ並びと「プロセスでまとめる」の保存先（どの窓・どのスペースでも同じ並びにする）。 */
const VIEW_STORAGE_KEY = 'paradis.portList.view';

/** 列の見出しの順（行の並びと同じ）。 */
const SORT_COLUMNS: readonly ParadisPortSortKey[] = ['port', 'process', 'scope', 'pid'];

/** 一覧に描く 1 行。まとめた見出しか、ポートの行。 */
type ParadisPortListItem =
	| { readonly group: IParadisPortGroup; readonly expanded: boolean; readonly entry?: undefined }
	| { readonly entry: IParadisPortEntry; readonly child: boolean; readonly group?: undefined };

/** パネルの見出しの id（パネルの aria-labelledby が指す）。パネルは 1 つの窓に 1 つしか開かない。 */
const PANEL_TITLE_ID = 'paradis-port-list-title';

export interface IParadisPortListPanelOptions {
	readonly initialSnapshot: IParadisPortListSnapshot | undefined;
	/** パネルを開いた時点の接続状態。タイトル表示と確認ダイアログの文言に使う。 */
	readonly viaRemote: boolean;
	readonly onManualRefresh: () => void;
	/** `restoreFocus` は Esc と閉じるボタンで閉じたとき true（トリガーへフォーカスを戻す）。外側のクリックなどでは false。 */
	readonly onClose: (restoreFocus: boolean) => void;
	readonly onKill: (entry: IParadisPortEntry) => void;
	readonly onKillAll: (entries: readonly IParadisPortEntry[]) => void;
}

export class ParadisPortListPanel extends Disposable {

	private readonly element: HTMLElement;
	private readonly listElement: HTMLElement;
	private readonly countElement: HTMLElement;
	private readonly refreshButton: HTMLButtonElement;
	private readonly killAllButton: HTMLButtonElement;
	private readonly searchInput: HTMLInputElement;
	private readonly groupChip: HTMLButtonElement;
	private readonly sortButtons = new Map<ParadisPortSortKey, { readonly button: HTMLButtonElement; readonly arrow: HTMLElement }>();
	private readonly hoverDelegate = getDefaultHoverDelegate('mouse');

	/** renderList() は毎回DOMを作り直すため、行リスナーはここへ登録し再描画のたびにclearする。 */
	private readonly _listListeners = this._register(new DisposableStore());
	/**
	 * 今描いている行のボタン（`kill|cancel|confirm` と port:pid の組ごと。まとめた見出しは `group` とプロセス名）。
	 * 描き直しの前後でフォーカスを引き継ぐのに使う。
	 */
	private readonly rowButtons = new Map<string, HTMLButtonElement>();
	/** 終了の確認を出している行（port:pid）。行は毎回作り直すので、確認中かどうかはここに持つ。 */
	private confirmingKey: string | undefined;
	private readonly confirmTimer = this._register(new MutableDisposable());

	private latestSnapshot: IParadisPortListSnapshot | undefined;
	private searchQuery = '';
	private filter: ParadisPortListFilter = 'all';
	private view: IParadisPortListView;
	/** 開いているまとまり（プロセス名）。まとまりは畳んだ状態から始め、開閉はパネルを開いている間だけ覚える。 */
	private readonly expandedGroups = new Set<string>();

	constructor(
		private readonly anchor: HTMLElement,
		private readonly options: IParadisPortListPanelOptions,
		@ILayoutService layoutService: ILayoutService,
		@IHoverService private readonly hoverService: IHoverService,
		@IStorageService private readonly storageService: IStorageService,
	) {
		super();
		this.view = paradisParsePortListView(this.storageService.get(VIEW_STORAGE_KEY, StorageScope.APPLICATION));

		this.element = $('.paradis-port-list-panel.paradis-overlay-popover.paradis-focus-none');
		this.element.tabIndex = -1;
		this.element.setAttribute('role', 'dialog');
		this.element.setAttribute('aria-labelledby', PANEL_TITLE_ID);

		const head = dom.append(this.element, $('.ppl-head'));
		const title = dom.append(head, $('.ppl-title'));
		// 読み上げの名前は見出しの文字だけにする（件数の「2 / 12」は名前に入れない）
		const titleText = dom.append(title, $('span'));
		titleText.id = PANEL_TITLE_ID;
		titleText.textContent = options.viaRemote
			? localize('paradis.portList.titleRemote', "接続先のポート")
			: localize('paradis.portList.title', "ローカルのポート");
		this.countElement = dom.append(title, $('span.ppl-count'));
		const closeButton = dom.append(head, $('button.ppl-fbtn.paradis-focus-ring')) as HTMLButtonElement;
		closeButton.type = 'button';
		closeButton.setAttribute('aria-label', localize('paradis.portList.closeAria', "閉じる"));
		closeButton.appendChild($(`span${ThemeIcon.asCSSSelector(Codicon.close)}`));
		this._register(dom.addDisposableListener(closeButton, 'click', () => this.options.onClose(true)));

		const search = dom.append(this.element, $('.ppl-search'));
		const searchBox = dom.append(search, $('.ppl-search-box.paradis-focus-subtle-within'));
		dom.append(searchBox, $(`span${ThemeIcon.asCSSSelector(Codicon.search)}`));
		this.searchInput = dom.append(searchBox, $('input')) as HTMLInputElement;
		this.searchInput.type = 'text';
		this.searchInput.placeholder = localize('paradis.portList.searchPlaceholder', "ポート・プロセス名・PIDで検索…");
		this._register(dom.addDisposableListener(this.searchInput, 'input', () => {
			this.searchQuery = this.searchInput.value;
			this.renderList();
		}));

		const filters = dom.append(this.element, $('.ppl-filters'));
		const allChip = dom.append(filters, $('button.ppl-chip.on.paradis-focus-ring')) as HTMLButtonElement;
		allChip.type = 'button';
		allChip.textContent = localize('paradis.portList.filterAll', "すべて");
		allChip.setAttribute('aria-pressed', 'true');
		const riskyChip = dom.append(filters, $('button.ppl-chip.paradis-focus-ring')) as HTMLButtonElement;
		riskyChip.type = 'button';
		riskyChip.textContent = localize('paradis.portList.filterRisky', "全公開のみ");
		riskyChip.setAttribute('aria-pressed', 'false');
		this._register(dom.addDisposableListener(allChip, 'click', () => this.setFilter('all', allChip, riskyChip)));
		this._register(dom.addDisposableListener(riskyChip, 'click', () => this.setFilter('risky', allChip, riskyChip)));
		this.groupChip = dom.append(filters, $('button.ppl-chip.ppl-group-toggle.paradis-focus-ring')) as HTMLButtonElement;
		this.groupChip.type = 'button';
		this.groupChip.textContent = localize('paradis.portList.groupByProcess', "プロセスでまとめる");
		this._register(dom.addDisposableListener(this.groupChip, 'click', () => this.setView({ ...this.view, grouped: !this.view.grouped })));

		// 列の見出し（押すと並び替え）は一覧と同じスクロールの中に置いて上に留める。スクロールバーが幅を取る OS でも列が揃う
		const scroll = dom.append(this.element, $('.ppl-scroll'));
		const columns = dom.append(scroll, $('.ppl-cols'));
		for (const key of SORT_COLUMNS) {
			const button = dom.append(columns, $(`button.ppl-col.ppl-col-${key}.paradis-focus-ring-inset`)) as HTMLButtonElement;
			button.type = 'button';
			dom.append(button, $('span.ppl-col-label')).textContent = sortColumnLabel(key);
			const arrow = dom.append(button, $('span.ppl-col-arrow'));
			arrow.setAttribute('aria-hidden', 'true');
			this.sortButtons.set(key, { button, arrow });
			this._register(dom.addDisposableListener(button, 'click', () => this.setView(paradisNextPortSort(this.view, key))));
		}
		dom.append(columns, $('.ppl-kill-space'));
		this.updateViewControls();

		this.listElement = dom.append(scroll, $('.ppl-list'));
		// 確認を出している行の外（別の行など）を押したら確認をやめる。別の行の終了ボタンは、そのボタンの click で確認を移す。
		// まとまりの見出しも、その click で確認をやめる（ここで描き直すと、押した見出しが作り直されて click が届かない）
		this._register(dom.addDisposableListener(this.listElement, 'mousedown', e => {
			if (this.confirmingKey === undefined || !dom.isHTMLElement(e.target)) {
				return;
			}
			if (e.target.closest('.ppl-confirm, .ppl-kill-btn, .ppl-group')) {
				return;
			}
			this.cancelConfirm(false);
		}));

		const footer = dom.append(this.element, $('.ppl-footer'));
		this.refreshButton = dom.append(footer, $('button.ppl-fbtn.paradis-focus-ring')) as HTMLButtonElement;
		this.refreshButton.type = 'button';
		this.refreshButton.appendChild($(`span${ThemeIcon.asCSSSelector(Codicon.refresh)}`));
		dom.append(this.refreshButton, $('span')).textContent = localize('paradis.portList.refresh', "更新");
		this._register(dom.addDisposableListener(this.refreshButton, 'click', () => this.options.onManualRefresh()));

		this.killAllButton = dom.append(footer, $('button.ppl-fbtn.danger.paradis-focus-ring')) as HTMLButtonElement;
		this.killAllButton.type = 'button';
		this.killAllButton.appendChild($(`span${ThemeIcon.asCSSSelector(Codicon.trash)}`));
		dom.append(this.killAllButton, $('span')).textContent = localize('paradis.portList.killAll', "すべて終了");
		this._register(dom.addDisposableListener(this.killAllButton, 'click', () => {
			const entries = this.visibleEntries();
			if (entries.length > 0) {
				this.options.onKillAll(entries);
			}
		}));

		layoutService.activeContainer.appendChild(this.element);
		// 小窓はモーダルより上の段にあるので、モーダルが開いたら閉じる（幕の上に浮かせない）
		this._register(paradisCloseWhenModalOpens(this.element, () => this.options.onClose(false)));
		this.reposition();

		this._register(dom.addDisposableListener(dom.getActiveWindow(), 'resize', () => this.reposition()));
		this._register(dom.addDisposableListener(dom.getActiveWindow(), 'mousedown', e => this.onWindowMouseDown(e), true));
		this._register(dom.addDisposableListener(this.element, 'keydown', e => {
			if (e.key !== 'Escape') {
				return;
			}
			e.preventDefault();
			// 行の終了の確認を出しているときの Esc は、確認だけをやめる（パネルは閉じない）
			if (this.confirmingKey !== undefined) {
				e.stopPropagation();
				this.cancelConfirm(true);
				return;
			}
			this.options.onClose(true);
		}));

		if (options.initialSnapshot) {
			this.updateSnapshot(options.initialSnapshot);
		} else {
			this.renderEmpty(localize('paradis.portList.loading', "読み込み中…"));
		}
		this.searchInput.focus();
	}

	override dispose(): void {
		this.element.remove();
		super.dispose();
	}

	updateSnapshot(snapshot: IParadisPortListSnapshot): void {
		this.latestSnapshot = snapshot;
		this.renderList();
	}

	setFetching(isFetching: boolean): void {
		this.refreshButton.classList.toggle('spinning', isFetching);
	}

	private setFilter(filter: ParadisPortListFilter, allChip: HTMLElement, riskyChip: HTMLElement): void {
		this.filter = filter;
		allChip.classList.toggle('on', filter === 'all');
		allChip.setAttribute('aria-pressed', String(filter === 'all'));
		riskyChip.classList.toggle('on', filter === 'risky');
		riskyChip.setAttribute('aria-pressed', String(filter === 'risky'));
		this.renderList();
	}

	/** 並び・まとめ方を替えて覚える。 */
	private setView(view: IParadisPortListView): void {
		this.view = view;
		this.storageService.store(VIEW_STORAGE_KEY, JSON.stringify(view), StorageScope.APPLICATION, StorageTarget.USER);
		this.updateViewControls();
		this.renderList();
	}

	/** 列の見出しの矢印と読み上げ、「プロセスでまとめる」の押された状態を、今の並びに合わせる。 */
	private updateViewControls(): void {
		for (const [key, { button, arrow }] of this.sortButtons) {
			const active = this.view.sortKey === key;
			const ascending = this.view.sortDirection === 'asc';
			button.classList.toggle('on', active);
			button.setAttribute('aria-label', sortColumnAriaLabel(key, active ? this.view.sortDirection : undefined));
			// 選んでいない列も矢印の幅は取っておく（選び替えたときに見出しの文字が動かない）。CSS が隠す
			arrow.className = `ppl-col-arrow ${ThemeIcon.asClassName(active && !ascending ? Codicon.arrowDown : Codicon.arrowUp)}`;
		}
		this.groupChip.classList.toggle('on', this.view.grouped);
		this.groupChip.setAttribute('aria-pressed', String(this.view.grouped));
	}

	private onWindowMouseDown(e: MouseEvent): void {
		const target = e.target as Node | null;
		if (!target) {
			return;
		}
		if (dom.isAncestor(target, this.element) || dom.isAncestor(target, this.anchor)) {
			return;
		}
		this.options.onClose(false);
	}

	private reposition(): void {
		const rect = this.anchor.getBoundingClientRect();
		const win = dom.getActiveWindow();
		const geometry = paradisPortListPanelGeometry(win.innerWidth, rect.right);
		const maxTop = win.innerHeight - 40;
		this.element.style.width = `${geometry.width}px`;
		this.element.style.top = `${Math.min(rect.bottom + 6, maxTop)}px`;
		this.element.style.left = `${geometry.left}px`;
	}

	private visibleEntries(): IParadisPortEntry[] {
		if (!this.latestSnapshot) {
			return [];
		}
		const query = this.searchQuery.trim().toLowerCase();
		const matching = this.latestSnapshot.entries.filter(entry => {
			if (this.filter === 'risky' && !entry.risky) {
				return false;
			}
			if (!query) {
				return true;
			}
			return String(entry.port).includes(query)
				|| entry.processName.toLowerCase().includes(query)
				|| String(entry.pid).includes(query);
		});
		return paradisSortPortEntries(matching, this.view.sortKey, this.view.sortDirection);
	}

	/**
	 * 一覧に描く行。まとめるときは、同じプロセス名の行が 2 つ以上あるものだけ見出しを置き、畳んでいる間は中の行を描かない。
	 * 検索中は一致した行を隠さないよう、まとまりを開いたままにする。
	 */
	private listItems(entries: readonly IParadisPortEntry[]): ParadisPortListItem[] {
		if (!this.view.grouped) {
			return entries.map(entry => ({ entry, child: false }));
		}
		const searching = this.searchQuery.trim().length > 0;
		const items: ParadisPortListItem[] = [];
		for (const group of paradisGroupPortEntries(entries)) {
			if (group.entries.length === 1) {
				items.push({ entry: group.entries[0], child: false });
				continue;
			}
			const expanded = searching || this.expandedGroups.has(group.processName);
			items.push({ group, expanded });
			if (expanded) {
				items.push(...group.entries.map(entry => ({ entry, child: true })));
			}
		}
		return items;
	}

	private renderEmpty(message: string): void {
		dom.clearNode(this.listElement);
		dom.append(this.listElement, $('.ppl-empty')).textContent = message;
	}

	private renderList(focusKey?: string): void {
		// 行は毎回作り直すので、行のボタンにあったフォーカスを覚えて、描き直した後に同じ行の同じボタンへ戻す
		// （戻さないと body へ落ち、パネルの Esc も届かなくなる）。確認の出し入れでは、移す先のボタンを focusKey で渡す。
		const focused = dom.getActiveElement();
		const focusedKey = focusKey ?? [...this.rowButtons].find(([, button]) => button === focused)?.[0];
		this.renderListRows();
		if (focusedKey !== undefined) {
			// 見出し（`group|プロセス名`）は名前に `|` が入りうるので、行のボタンの戻り先（`kill|port:pid`）は行のキーのときだけ探す
			const [kind, entryKey] = focusedKey.split('|');
			(this.rowButtons.get(focusedKey) ?? (kind === 'group' ? undefined : this.rowButtons.get(`kill|${entryKey}`)) ?? this.element).focus();
		}
	}

	private renderListRows(): void {
		this._listListeners.clear();
		this.rowButtons.clear();
		dom.clearNode(this.listElement);

		const entries = this.visibleEntries();
		const items = this.listItems(entries);
		const total = this.latestSnapshot?.entries.length ?? 0;
		// 絞り込み中は「見えている数 / 全体」。「すべて終了」が止めるのは絞り込みに残った行だけなので、見出しの数と揃える
		// （畳んだまとまりの中の行も数に入り、「すべて終了」の対象にもなる。確認のダイアログが対象を並べる）
		const filtering = this.filter !== 'all' || this.searchQuery.trim().length > 0;
		this.countElement.textContent = filtering
			? localize('paradis.portList.countFiltered', "{0} / {1}", entries.length, total)
			: String(total);
		// 確認を出していた行が一覧から消えたら（畳んだまとまりの中へ入ったときも）、確認もやめる
		if (this.confirmingKey !== undefined && !items.some(item => item.entry !== undefined && entryKey(item.entry) === this.confirmingKey)) {
			this.confirmingKey = undefined;
			this.confirmTimer.clear();
		}
		// Kill All は「今見えている行」を対象に実行するため、活性条件も可視件数に揃える
		// (フィルタ/検索で0件になっているのにボタンだけ押せる状態を避ける)。
		this.killAllButton.disabled = entries.length === 0;

		if (entries.length === 0) {
			this.renderEmpty(this.latestSnapshot
				? localize('paradis.portList.noMatch', "一致するポートがありません")
				: localize('paradis.portList.loading', "読み込み中…"));
			return;
		}
		for (const item of items) {
			if (item.group) {
				this.renderGroup(item.group, item.expanded);
			} else {
				this.renderRow(item.entry, item.child);
			}
		}
	}

	/** 同じプロセス名の行をまとめた見出し。押すと中の行を開閉する（検索中は開いたまま）。 */
	private renderGroup(group: IParadisPortGroup, expanded: boolean): void {
		const name = group.processName;
		const header = dom.append(this.listElement, $('button.ppl-group.paradis-focus-ring-inset')) as HTMLButtonElement;
		header.type = 'button';
		header.setAttribute('aria-expanded', String(expanded));
		header.appendChild($(`span.ppl-group-chevron${ThemeIcon.asCSSSelector(expanded ? Codicon.chevronDown : Codicon.chevronRight)}`));
		dom.append(header, $('span.ppl-proc')).textContent = name;
		const scope = dom.append(header, $('span.ppl-scope'));
		if (group.risky) {
			createParadisChip(scope, localize('paradis.portList.scopeAll', "全公開"), 'warning');
		}
		dom.append(header, $('span.ppl-pid')).textContent = localize('paradis.portList.groupCount', "{0} 件", group.entries.length);
		dom.append(header, $('span.ppl-kill-space'));
		this.rowButtons.set(`group|${name}`, header);
		this._listListeners.add(dom.addDisposableListener(header, 'click', () => {
			this.confirmingKey = undefined;
			this.confirmTimer.clear();
			if (this.searchQuery.trim().length === 0 && !this.expandedGroups.delete(name)) {
				this.expandedGroups.add(name);
			}
			this.renderList(`group|${name}`);
		}));
	}

	private renderRow(entry: IParadisPortEntry, child: boolean): void {
		const key = entryKey(entry);
		const confirming = this.confirmingKey === key;
		const row = dom.append(this.listElement, $(`.ppl-row${child ? '.child' : ''}`));
		dom.append(row, $('.ppl-port')).textContent = `:${entry.port}`;
		dom.append(row, $('.ppl-proc')).textContent = entry.processName;
		if (confirming) {
			this.renderConfirm(row, entry, key);
			return;
		}
		// 公開の範囲の列。全公開の行だけ文字の札を出す（色の点や行の塗りでは示さない）。札の無い行は全公開ではない
		const scope = dom.append(row, $('.ppl-scope'));
		if (entry.risky) {
			const badge = createParadisChip(scope, localize('paradis.portList.scopeAll', "全公開"), 'warning');
			const address = entry.address === '*' ? localize('paradis.portList.anyAddress', "すべてのアドレス（*）") : entry.address;
			this._listListeners.add(this.hoverService.setupManagedHover(this.hoverDelegate, badge, localize('paradis.portList.scopeAllTooltip', "同じネットワークのほかの機器からも接続できます（待ち受けのアドレス: {0}）", address)));
		}
		dom.append(row, $('.ppl-pid')).textContent = String(entry.pid);
		// 行の中のボタンは、隣の行に枠を切られないよう内側の枠
		const killButton = dom.append(row, $('button.ppl-kill-btn.paradis-focus-ring-inset')) as HTMLButtonElement;
		killButton.type = 'button';
		this.rowButtons.set(`kill|${key}`, killButton);
		const killLabel = localize('paradis.portList.killAria', "PID {0} を終了", entry.pid);
		killButton.setAttribute('aria-label', killLabel);
		killButton.appendChild($(`span${ThemeIcon.asCSSSelector(Codicon.debugStop)}`));
		this._listListeners.add(this.hoverService.setupManagedHover(this.hoverDelegate, killButton, killLabel));
		this._listListeners.add(dom.addDisposableListener(killButton, 'click', e => {
			e.preventDefault();
			e.stopPropagation();
			this.startConfirm(key);
		}));
	}

	/** 行の右側を「PID … を終了しますか？ やめる / 終了」に替える。 */
	private renderConfirm(row: HTMLElement, entry: IParadisPortEntry, key: string): void {
		const confirm = dom.append(row, $('.ppl-confirm'));
		const text = dom.append(confirm, $('span.ppl-confirm-text'));
		text.textContent = localize('paradis.portList.killConfirm', "PID {0} を終了しますか？", entry.pid);
		const cancel = dom.append(confirm, $<HTMLButtonElement>('button'));
		cancel.type = 'button';
		cancel.classList.add(...paradisButtonClasses('ghost', true));
		cancel.textContent = localize('paradis.portList.killConfirmCancel', "やめる");
		const kill = dom.append(confirm, $<HTMLButtonElement>('button'));
		kill.type = 'button';
		kill.classList.add(...paradisButtonClasses('danger', true));
		kill.textContent = localize('paradis.portList.killConfirmPrimary', "終了");
		kill.setAttribute('aria-label', localize('paradis.portList.killAria', "PID {0} を終了", entry.pid));
		// 行の中のボタンは、一覧の端の行でも枠を切られないよう内側の枠にする
		for (const button of [cancel, kill]) {
			button.classList.replace('paradis-focus-ring', 'paradis-focus-ring-inset');
		}
		this.rowButtons.set(`cancel|${key}`, cancel);
		this.rowButtons.set(`confirm|${key}`, kill);
		this._listListeners.add(dom.addDisposableListener(cancel, 'click', e => {
			e.preventDefault();
			e.stopPropagation();
			this.cancelConfirm(true);
		}));
		this._listListeners.add(dom.addDisposableListener(kill, 'click', e => {
			e.preventDefault();
			e.stopPropagation();
			this.confirmingKey = undefined;
			this.confirmTimer.clear();
			this.renderList();
			this.options.onKill(entry);
		}));
	}

	/** 行の終了の確認を出す（別の行で出していたものはやめる）。最初のフォーカスは「やめる」。 */
	private startConfirm(key: string): void {
		this.confirmingKey = key;
		this.confirmTimer.value = disposableTimeout(() => this.cancelConfirm(this.rowHasFocus()), KILL_CONFIRM_TIMEOUT_MS);
		this.renderList(`cancel|${key}`);
	}

	/** 確認をやめて元の終了ボタンに戻す。`restoreFocus` ならその行の終了ボタンへフォーカスを移す。 */
	private cancelConfirm(restoreFocus: boolean): void {
		const key = this.confirmingKey;
		if (key === undefined) {
			return;
		}
		this.confirmingKey = undefined;
		this.confirmTimer.clear();
		this.renderList(restoreFocus ? `kill|${key}` : undefined);
	}

	/** フォーカスが確認のボタンにあるか（放っておいて戻すときに、フォーカスを終了ボタンへ移すかを決める）。 */
	private rowHasFocus(): boolean {
		const focused = dom.getActiveElement();
		return [...this.rowButtons.values()].some(button => button === focused);
	}
}

function sortColumnLabel(key: ParadisPortSortKey): string {
	switch (key) {
		case 'port': return localize('paradis.portList.columnPort', "ポート");
		case 'process': return localize('paradis.portList.columnProcess', "プロセス");
		case 'scope': return localize('paradis.portList.columnScope', "公開");
		case 'pid': return localize('paradis.portList.columnPid', "PID");
	}
}

/** 列の見出しの読み上げ。`direction` は今その列で並んでいるときだけ渡す。 */
function sortColumnAriaLabel(key: ParadisPortSortKey, direction: 'asc' | 'desc' | undefined): string {
	if (key === 'scope') {
		switch (direction) {
			case 'asc': return localize('paradis.portList.sortScopeAsc', "全公開のポートを上に並べています。押すと下に並べます");
			case 'desc': return localize('paradis.portList.sortScopeDesc', "全公開のポートを下に並べています。押すと上に並べます");
			default: return localize('paradis.portList.sortScope', "公開の範囲で並べ替え");
		}
	}
	const label = sortColumnLabel(key);
	switch (direction) {
		case 'asc': return localize('paradis.portList.sortAsc', "{0}の昇順で並べています。押すと降順にします", label);
		case 'desc': return localize('paradis.portList.sortDesc', "{0}の降順で並べています。押すと昇順にします", label);
		default: return localize('paradis.portList.sortBy', "{0}で並べ替え", label);
	}
}

function entryKey(entry: IParadisPortEntry): string {
	return `${entry.port}:${entry.pid}`;
}
