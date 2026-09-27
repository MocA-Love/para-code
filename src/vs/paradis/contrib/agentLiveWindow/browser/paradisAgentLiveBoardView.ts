/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import { $, addDisposableListener, append, clearNode, EventType } from '../../../../base/browser/dom.js';
import { StandardKeyboardEvent } from '../../../../base/browser/keyboardEvent.js';
import { getDefaultHoverDelegate } from '../../../../base/browser/ui/hover/hoverDelegateFactory.js';
import { KeyCode } from '../../../../base/common/keyCodes.js';
import { Disposable, DisposableMap, DisposableStore } from '../../../../base/common/lifecycle.js';
import { localize } from '../../../../nls.js';
import { IHoverService } from '../../../../platform/hover/browser/hover.js';
import { IParadisAgentInsightsService } from '../../agentInsights/common/paradisAgentInsights.js';
import {
	IParadisAgentLiveEntry,
	IParadisAgentLiveGroupResult,
	ParadisAgentLiveBoardColumnId,
	ParadisAgentLiveStatus,
	paradisAgentLiveBoardColumns,
	paradisAgentLiveSpaceLabel,
	paradisAgentLiveSummary,
	paradisIsAttentionStatus,
} from '../common/paradisAgentLiveWindow.js';
import './media/paradisAgentLiveBoard.css';

/** ボード・リストが本体（タイル表示）から借りるもの。文言と時計の書き方をタイルと揃えるため。 */
export interface IParadisAgentLiveSummaryHost {
	statusLabel(status: ParadisAgentLiveStatus): string;
	clockText(entry: IParadisAgentLiveEntry, now: number): string;
	/** カード・行を押したとき。タイル表示のその端末へ移る。 */
	reveal(token: string): void;
}

interface IItem {
	readonly root: HTMLElement;
	readonly name: HTMLElement;
	readonly meta: HTMLElement;
	readonly clock: HTMLElement;
	readonly badge: HTMLElement | undefined;
	readonly text: HTMLElement;
	readonly spaceBar: HTMLElement;
	entry: IParadisAgentLiveEntry;
}

function boardColumnLabel(id: ParadisAgentLiveBoardColumnId): string {
	switch (id) {
		case 'attention': return localize('paradis.agentLive.board.attention', "要対応");
		case 'working': return localize('paradis.agentLive.board.working', "作業中");
		case 'review': return localize('paradis.agentLive.board.review', "完了");
		case 'idle': return localize('paradis.agentLive.board.idle', "待機");
	}
}

/** 列見出しのドットに使う状態（要対応は許可待ち・質問中と同じ赤）。 */
function boardColumnDot(id: ParadisAgentLiveBoardColumnId): ParadisAgentLiveStatus {
	return id === 'attention' ? 'permission' : id;
}

/**
 * エージェント一覧の「ボード」と「リスト」。端末の画面を読まなくても「何を聞かれているか」
 * 「最後に何を言ったか」が分かるよう、仕分けて見る表示と文章で流し読みする表示を足している。
 *
 * どちらも端末を描かず、会話から読んだ要約（待っている内容・最後の発言）を文章で並べる。
 * 並びと絞り込みは本体（タイル表示）が決めたものをそのまま受け取る。カードや行は
 * ペイントークンをキーに使い回し、時計の更新では文字だけを書き換える（作り直すと、
 * マウスを乗せている間のツールチップやキーボードのフォーカスが飛ぶため）。
 */
export class ParadisAgentLiveSummaryView extends Disposable {

	readonly element: HTMLElement;
	private readonly boardItems = new Map<string, IItem>();
	private readonly listItems = new Map<string, IItem>();
	private readonly itemDisposables = this._register(new DisposableMap<string>());
	private layout: 'board' | 'list' | undefined;
	/** ボードの土台と列。列の位置は件数に関係なく固定なので、一度作ったら使い回す */
	private board: { readonly root: HTMLElement; readonly columns: readonly { readonly count: HTMLElement; readonly cards: HTMLElement; readonly root: HTMLElement }[] } | undefined;
	private list: { readonly root: HTMLElement; readonly head: HTMLElement } | undefined;
	private last: { readonly groups: readonly IParadisAgentLiveGroupResult[]; readonly grouped: boolean; readonly total: number } | undefined;

	constructor(
		parent: HTMLElement,
		private readonly host: IParadisAgentLiveSummaryHost,
		@IParadisAgentInsightsService private readonly insightsService: IParadisAgentInsightsService,
		@IHoverService private readonly hoverService: IHoverService,
	) {
		super();
		this.element = append(parent, $('.paradis-agent-live-summary.hidden'));
		// 要約の中身（待っている内容・最後の発言）だけが変わったときも描き直す。
		this._register(this.insightsService.onDidChange(() => {
			if (this.layout !== undefined && this.last !== undefined) {
				this.render(this.layout, this.last.groups, this.last.grouped, this.last.total, Date.now());
			}
		}));
	}

	hide(): void {
		if (this.layout === undefined) {
			return;
		}
		this.layout = undefined;
		this.last = undefined;
		this.element.classList.add('hidden');
		this.clearItems(this.boardItems);
		this.clearItems(this.listItems);
		this.board = undefined;
		this.list = undefined;
		clearNode(this.element);
	}

	/**
	 * @param groups 並び替え・絞り込み・グループ化まで済んだもの（本体のタイル表示と同じ入力）
	 * @param grouped グループ見出しを出すか（リストだけが使う。ボードの列はそれ自体が状態の分類）
	 * @param total 絞り込む前の件数（空表示の文言を分けるため）
	 */
	render(layout: 'board' | 'list', groups: readonly IParadisAgentLiveGroupResult[], grouped: boolean, total: number, now: number): void {
		if (this.layout !== layout) {
			this.clearItems(layout === 'board' ? this.listItems : this.boardItems);
			this.board = undefined;
			this.list = undefined;
			clearNode(this.element);
		}
		this.layout = layout;
		this.last = { groups, grouped, total };
		this.element.classList.remove('hidden');
		this.element.classList.toggle('board', layout === 'board');
		this.element.classList.toggle('list', layout === 'list');
		const entries = groups.flatMap(group => group.entries);
		if (layout === 'board') {
			this.renderBoard(entries, now);
		} else {
			this.renderList(groups, grouped, entries, total, now);
		}
	}

	updateClocks(now: number): void {
		for (const item of (this.layout === 'board' ? this.boardItems : this.listItems).values()) {
			item.clock.textContent = this.host.clockText(item.entry, now);
		}
	}

	// ------------------------------------------------------------------ ボード

	private renderBoard(entries: readonly IParadisAgentLiveEntry[], now: number): void {
		this.pruneItems(this.boardItems, entries);
		const columns = paradisAgentLiveBoardColumns(entries);
		if (!this.board) {
			const root = append(this.element, $('.paradis-agent-live-board'));
			this.board = {
				root,
				columns: columns.map(column => {
					const columnRoot = append(root, $('.paradis-agent-live-board-column'));
					const head = append(columnRoot, $('.paradis-agent-live-board-head'));
					append(head, $(`span.paradis-agent-live-dot.${boardColumnDot(column.id)}`));
					append(head, $('span.paradis-agent-live-board-title')).textContent = boardColumnLabel(column.id);
					const count = append(head, $('span.paradis-agent-live-board-count'));
					const cards = append(columnRoot, $('.paradis-agent-live-board-cards'));
					return { root: columnRoot, count, cards };
				}),
			};
		}
		const board = this.board;
		columns.forEach((column, index) => {
			const target = board.columns[index];
			target.root.classList.toggle('empty', column.entries.length === 0);
			target.count.textContent = String(column.entries.length);
			const items = column.entries.map(entry => this.ensureItem(this.boardItems, entry, 'card', now));
			this.placeChildren(target.cards, items.map(item => item.root));
		});
	}

	// ------------------------------------------------------------------ リスト

	private renderList(groups: readonly IParadisAgentLiveGroupResult[], grouped: boolean, entries: readonly IParadisAgentLiveEntry[], total: number, now: number): void {
		this.pruneItems(this.listItems, entries);
		if (!this.list) {
			const root = append(this.element, $('.paradis-agent-live-list'));
			root.setAttribute('role', 'list');
			this.list = { root, head: this.createListHead() };
		}
		const table = this.list.root;
		const children: HTMLElement[] = [this.list.head];
		if (entries.length === 0) {
			const empty = $('.paradis-agent-live-list-empty');
			empty.textContent = total === 0
				? localize('paradis.agentLive.list.emptyNoAgents', "動いているエージェントはありません。")
				: localize('paradis.agentLive.list.emptyFiltered', "条件に合うエージェントがいません。");
			children.push(empty);
		}
		for (const group of groups) {
			if (grouped && group.entries.length > 0) {
				const groupHead = $('.paradis-agent-live-list-group');
				if (group.color) {
					append(groupHead, $('span.paradis-agent-live-swatch')).style.backgroundColor = group.color;
				}
				if (group.status) {
					append(groupHead, $(`span.paradis-agent-live-dot.${group.status}`));
				}
				append(groupHead, $('span')).textContent = group.label;
				append(groupHead, $('span.paradis-agent-live-list-group-count')).textContent = localize('paradis.agentLive.list.groupCount', "{0} 件", group.entries.length);
				children.push(groupHead);
			}
			for (const entry of group.entries) {
				children.push(this.ensureItem(this.listItems, entry, 'row', now).root);
			}
		}
		this.placeChildren(table, children);
	}

	private createListHead(): HTMLElement {
		const head = $('.paradis-agent-live-list-head');
		append(head, $('span')).textContent = localize('paradis.agentLive.list.status', "状態");
		append(head, $('span')).textContent = localize('paradis.agentLive.list.space', "スペース");
		append(head, $('span')).textContent = localize('paradis.agentLive.list.summary', "最後の発言 / 未回答の質問");
		append(head, $('span.paradis-agent-live-list-clock')).textContent = localize('paradis.agentLive.list.elapsed', "経過");
		return head;
	}

	// ------------------------------------------------------------------ カード・行

	private ensureItem(items: Map<string, IItem>, entry: IParadisAgentLiveEntry, kind: 'card' | 'row', now: number): IItem {
		let item = items.get(entry.token);
		if (!item) {
			item = kind === 'card' ? this.createCard(entry) : this.createRow(entry);
			items.set(entry.token, item);
		}
		this.updateItem(item, entry, now);
		return item;
	}

	private createCard(entry: IParadisAgentLiveEntry): IItem {
		const disposables = new DisposableStore();
		const root = $('.paradis-agent-live-card');
		const spaceBar = append(root, $('.paradis-agent-live-card-spacebar'));
		const head = append(root, $('.paradis-agent-live-card-head'));
		const name = append(head, $('span.paradis-agent-live-card-name'));
		const clock = append(head, $('span.paradis-agent-live-card-clock'));
		const meta = append(root, $('.paradis-agent-live-card-meta'));
		const text = append(root, $('.paradis-agent-live-card-text'));
		this.wireActivation(root, entry.token, disposables);
		this.itemDisposables.set(`card:${entry.token}`, disposables);
		return { root, name, meta, clock, badge: undefined, text, spaceBar, entry };
	}

	private createRow(entry: IParadisAgentLiveEntry): IItem {
		const disposables = new DisposableStore();
		const root = $('.paradis-agent-live-list-row');
		root.setAttribute('role', 'listitem');
		const badgeCell = append(root, $('.paradis-agent-live-list-status'));
		const badge = append(badgeCell, $('span.paradis-agent-live-badge'));
		const spaceCell = append(root, $('.paradis-agent-live-list-space'));
		const spaceBar = append(spaceCell, $('span.paradis-agent-live-swatch'));
		const nameBox = append(spaceCell, $('.paradis-agent-live-list-names'));
		const name = append(nameBox, $('span.paradis-agent-live-card-name'));
		const meta = append(nameBox, $('span.paradis-agent-live-card-meta'));
		const text = append(root, $('.paradis-agent-live-list-text'));
		const clock = append(root, $('.paradis-agent-live-list-clock'));
		this.wireActivation(root, entry.token, disposables);
		this.itemDisposables.set(`row:${entry.token}`, disposables);
		return { root, name, meta, clock, badge, text, spaceBar, entry };
	}

	/** 押す・Enter/Space でタイル表示のその端末へ移る。本文は長いのでツールチップで全文を出す。 */
	private wireActivation(root: HTMLElement, token: string, disposables: DisposableStore): void {
		root.tabIndex = 0;
		disposables.add(addDisposableListener(root, EventType.CLICK, () => this.host.reveal(token)));
		disposables.add(addDisposableListener(root, EventType.KEY_DOWN, event => {
			const keyboard = new StandardKeyboardEvent(event);
			if (keyboard.equals(KeyCode.Enter) || keyboard.equals(KeyCode.Space)) {
				keyboard.preventDefault();
				this.host.reveal(token);
			}
		}));
		disposables.add(this.hoverService.setupManagedHover(getDefaultHoverDelegate('element'), root, () => {
			const item = this.boardItems.get(token) ?? this.listItems.get(token);
			return item ? this.tooltipFor(item.entry) : '';
		}));
	}

	private updateItem(item: IItem, entry: IParadisAgentLiveEntry, now: number): void {
		item.entry = entry;
		const insight = this.insightsService.getForToken(entry.token);
		item.name.textContent = entry.detail || entry.spaceName;
		const metaParts = [entry.spaceName];
		if (insight) {
			metaParts.push(insight.agent);
		}
		item.meta.textContent = metaParts.join(' · ');
		item.clock.textContent = this.host.clockText(entry, now);
		item.spaceBar.style.backgroundColor = entry.spaceColor ?? 'transparent';
		item.root.classList.toggle('attention', paradisIsAttentionStatus(entry.status));
		if (item.badge) {
			item.badge.className = `paradis-agent-live-badge ${entry.status}`;
			clearNode(item.badge);
			append(item.badge, $(`span.paradis-agent-live-dot.${entry.status}`));
			append(item.badge, $('span')).textContent = this.host.statusLabel(entry.status);
		}
		clearNode(item.text);
		const summary = paradisAgentLiveSummary(entry.status, insight);
		if (summary) {
			if (summary.kind !== 'message') {
				append(item.text, $(`span.paradis-agent-live-summary-kind.${summary.kind}`)).textContent = summary.kind === 'permission'
					? localize('paradis.agentLive.summary.permission', "許可")
					: localize('paradis.agentLive.summary.question', "質問");
			}
			append(item.text, $('span.paradis-agent-live-summary-text')).textContent = summary.text;
		} else {
			append(item.text, $('span.paradis-agent-live-summary-none')).textContent = localize('paradis.agentLive.summary.none', "まだ発言はありません");
		}
		item.root.setAttribute('aria-label', this.tooltipFor(entry));
	}

	private tooltipFor(entry: IParadisAgentLiveEntry): string {
		const summary = paradisAgentLiveSummary(entry.status, this.insightsService.getForToken(entry.token));
		const lines = [
			localize('paradis.agentLive.summary.tooltipHead', "{0}（{1}）", paradisAgentLiveSpaceLabel(entry.spaceName, entry.detail), this.host.statusLabel(entry.status)),
		];
		if (summary) {
			lines.push(summary.kind === 'permission'
				? localize('paradis.agentLive.summary.tooltipPermission', "許可: {0}", summary.text)
				: summary.kind === 'question'
					? localize('paradis.agentLive.summary.tooltipQuestion', "質問: {0}", summary.text)
					: summary.text);
		}
		lines.push(localize('paradis.agentLive.summary.tooltipReveal', "クリックでタイル表示のこの端末へ移ります"));
		return lines.join('\n');
	}

	// ------------------------------------------------------------------ 後始末

	/** 期待する並びへ「位置がずれている要素だけ」動かす（フォーカスを抱えた要素を外さないため）。 */
	private placeChildren(parent: HTMLElement, children: readonly HTMLElement[]): void {
		const wanted = new Set<Node>(children);
		for (const child of [...parent.childNodes]) {
			if (!wanted.has(child)) {
				child.parentNode?.removeChild(child);
			}
		}
		children.forEach((child, index) => {
			const current = parent.childNodes.item(index);
			if (current !== child) {
				parent.insertBefore(child, current);
			}
		});
	}

	private pruneItems(items: Map<string, IItem>, entries: readonly IParadisAgentLiveEntry[]): void {
		const known = new Set(entries.map(entry => entry.token));
		for (const [token, item] of [...items]) {
			if (!known.has(token)) {
				item.root.remove();
				items.delete(token);
				this.itemDisposables.deleteAndDispose(`${items === this.boardItems ? 'card' : 'row'}:${token}`);
			}
		}
	}

	private clearItems(items: Map<string, IItem>): void {
		for (const [token, item] of items) {
			item.root.remove();
			this.itemDisposables.deleteAndDispose(`${items === this.boardItems ? 'card' : 'row'}:${token}`);
		}
		items.clear();
	}
}
