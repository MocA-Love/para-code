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
// フィルタは「All / 全公開のみ(0.0.0.0等にバインドされたポート)」の2値にとどめている。UDPは
// データ源(lsof/proc直読み)がTCPのみを収集しているため今回は対象外、「自分のプロセスのみ」は
// OSごとに所有ユーザーの取得方法が割れる(Windowsはtasklistの追加オプションが必要)ため見送った。

import './media/paradisPortList.css';
import * as dom from '../../../../base/browser/dom.js';
import { getDefaultHoverDelegate } from '../../../../base/browser/ui/hover/hoverDelegateFactory.js';
import { Codicon } from '../../../../base/common/codicons.js';
import { ThemeIcon } from '../../../../base/common/themables.js';
import { Disposable, DisposableStore } from '../../../../base/common/lifecycle.js';
import { localize } from '../../../../nls.js';
import { IHoverService } from '../../../../platform/hover/browser/hover.js';
import { ILayoutService } from '../../../../platform/layout/browser/layoutService.js';
import { IParadisPortEntry, IParadisPortListSnapshot } from '../common/paradisPortList.js';

const $ = dom.$;

const PANEL_WIDTH = 440;

type ParadisPortListFilter = 'all' | 'risky';

export interface IParadisPortListPanelOptions {
	readonly initialSnapshot: IParadisPortListSnapshot | undefined;
	/** パネルを開いた時点の接続状態。タイトル表示と確認ダイアログの文言に使う。 */
	readonly viaRemote: boolean;
	readonly onManualRefresh: () => void;
	readonly onClose: () => void;
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
	private readonly hoverDelegate = getDefaultHoverDelegate('mouse');

	/** renderList() は毎回DOMを作り直すため、行リスナーはここへ登録し再描画のたびにclearする。 */
	private readonly _listListeners = this._register(new DisposableStore());

	private latestSnapshot: IParadisPortListSnapshot | undefined;
	private searchQuery = '';
	private filter: ParadisPortListFilter = 'all';

	constructor(
		private readonly anchor: HTMLElement,
		private readonly options: IParadisPortListPanelOptions,
		@ILayoutService layoutService: ILayoutService,
		@IHoverService private readonly hoverService: IHoverService,
	) {
		super();

		this.element = $('.paradis-port-list-panel');
		this.element.tabIndex = -1;
		this.element.style.width = `${PANEL_WIDTH}px`;

		const head = dom.append(this.element, $('.ppl-head'));
		const title = dom.append(head, $('.ppl-title'));
		dom.append(title, $('span')).textContent = options.viaRemote
			? localize('paradis.portList.titleRemote', "接続先のポート")
			: localize('paradis.portList.title', "ローカルのポート");
		this.countElement = dom.append(title, $('span.ppl-count'));
		const closeButton = dom.append(head, $('button.ppl-fbtn')) as HTMLButtonElement;
		closeButton.type = 'button';
		closeButton.setAttribute('aria-label', localize('paradis.portList.closeAria', "閉じる"));
		closeButton.appendChild($(`span${ThemeIcon.asCSSSelector(Codicon.close)}`));
		this._register(dom.addDisposableListener(closeButton, 'click', () => this.options.onClose()));

		const search = dom.append(this.element, $('.ppl-search'));
		const searchBox = dom.append(search, $('.ppl-search-box'));
		dom.append(searchBox, $(`span${ThemeIcon.asCSSSelector(Codicon.search)}`));
		this.searchInput = dom.append(searchBox, $('input')) as HTMLInputElement;
		this.searchInput.type = 'text';
		this.searchInput.placeholder = localize('paradis.portList.searchPlaceholder', "ポート・プロセス名・PIDで検索…");
		this._register(dom.addDisposableListener(this.searchInput, 'input', () => {
			this.searchQuery = this.searchInput.value;
			this.renderList();
		}));

		const filters = dom.append(this.element, $('.ppl-filters'));
		const allChip = dom.append(filters, $('button.ppl-chip.on')) as HTMLButtonElement;
		allChip.type = 'button';
		allChip.textContent = localize('paradis.portList.filterAll', "すべて");
		allChip.setAttribute('aria-pressed', 'true');
		const riskyChip = dom.append(filters, $('button.ppl-chip')) as HTMLButtonElement;
		riskyChip.type = 'button';
		riskyChip.textContent = localize('paradis.portList.filterRisky', "全公開のみ");
		riskyChip.setAttribute('aria-pressed', 'false');
		this._register(dom.addDisposableListener(allChip, 'click', () => this.setFilter('all', allChip, riskyChip)));
		this._register(dom.addDisposableListener(riskyChip, 'click', () => this.setFilter('risky', allChip, riskyChip)));

		this.listElement = dom.append(this.element, $('.ppl-list'));

		const footer = dom.append(this.element, $('.ppl-footer'));
		this.refreshButton = dom.append(footer, $('button.ppl-fbtn')) as HTMLButtonElement;
		this.refreshButton.type = 'button';
		this.refreshButton.appendChild($(`span${ThemeIcon.asCSSSelector(Codicon.refresh)}`));
		dom.append(this.refreshButton, $('span')).textContent = localize('paradis.portList.refresh', "更新");
		this._register(dom.addDisposableListener(this.refreshButton, 'click', () => this.options.onManualRefresh()));

		this.killAllButton = dom.append(footer, $('button.ppl-fbtn.danger')) as HTMLButtonElement;
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
		this.reposition();

		this._register(dom.addDisposableListener(dom.getActiveWindow(), 'resize', () => this.reposition()));
		this._register(dom.addDisposableListener(dom.getActiveWindow(), 'mousedown', e => this.onWindowMouseDown(e), true));
		this._register(dom.addDisposableListener(this.element, 'keydown', e => {
			if (e.key === 'Escape') {
				e.preventDefault();
				this.options.onClose();
			}
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

	private onWindowMouseDown(e: MouseEvent): void {
		const target = e.target as Node | null;
		if (!target) {
			return;
		}
		if (dom.isAncestor(target, this.element) || dom.isAncestor(target, this.anchor)) {
			return;
		}
		this.options.onClose();
	}

	private reposition(): void {
		const rect = this.anchor.getBoundingClientRect();
		const win = dom.getActiveWindow();
		const left = Math.max(8, Math.min(rect.right - PANEL_WIDTH, win.innerWidth - PANEL_WIDTH - 8));
		const maxTop = win.innerHeight - 40;
		this.element.style.top = `${Math.min(rect.bottom + 6, maxTop)}px`;
		this.element.style.left = `${left}px`;
	}

	private visibleEntries(): IParadisPortEntry[] {
		if (!this.latestSnapshot) {
			return [];
		}
		const query = this.searchQuery.trim().toLowerCase();
		return this.latestSnapshot.entries.filter(entry => {
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
	}

	private renderEmpty(message: string): void {
		dom.clearNode(this.listElement);
		dom.append(this.listElement, $('.ppl-empty')).textContent = message;
	}

	private renderList(): void {
		this._listListeners.clear();
		dom.clearNode(this.listElement);

		const total = this.latestSnapshot?.entries.length ?? 0;
		this.countElement.textContent = String(total);

		const entries = this.visibleEntries();
		// Kill All は「今見えている行」を対象に実行するため、活性条件も可視件数に揃える
		// (フィルタ/検索で0件になっているのにボタンだけ押せる状態を避ける)。
		this.killAllButton.disabled = entries.length === 0;

		if (entries.length === 0) {
			this.renderEmpty(this.latestSnapshot
				? localize('paradis.portList.noMatch', "一致するポートがありません")
				: localize('paradis.portList.loading', "読み込み中…"));
			return;
		}
		for (const entry of entries) {
			this.renderRow(entry);
		}
	}

	private renderRow(entry: IParadisPortEntry): void {
		const row = dom.append(this.listElement, $(`.ppl-row${entry.risky ? '.risky' : ''}`));
		dom.append(row, $(`.ppl-dot${entry.risky ? '.risky' : ''}`));
		dom.append(row, $('.ppl-port')).textContent = `:${entry.port}`;
		dom.append(row, $('.ppl-proc')).textContent = entry.processName;
		if (entry.risky) {
			const badge = dom.append(row, $('.ppl-risk-badge'));
			badge.textContent = entry.address;
			this._listListeners.add(this.hoverService.setupManagedHover(this.hoverDelegate, badge, localize('paradis.portList.riskyTooltip', "全インターフェースへ公開されています")));
		}
		dom.append(row, $('.ppl-pid')).textContent = String(entry.pid);
		const killButton = dom.append(row, $('button.ppl-kill-btn')) as HTMLButtonElement;
		killButton.type = 'button';
		const killLabel = localize('paradis.portList.killAria', "PID {0} を終了", entry.pid);
		killButton.setAttribute('aria-label', killLabel);
		killButton.appendChild($(`span${ThemeIcon.asCSSSelector(Codicon.close)}`));
		this._listListeners.add(this.hoverService.setupManagedHover(this.hoverDelegate, killButton, killLabel));
		this._listListeners.add(dom.addDisposableListener(killButton, 'click', e => {
			e.preventDefault();
			e.stopPropagation();
			this.options.onKill(entry);
		}));
	}
}
