/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

// 履歴の一覧（Q372、デザイン D1）の見た目。プロンプトの真下（入らなければ真上）に重ねて出し、
// 最新をプロンプトに接する側に置く。キーの処理と中身の決定は contribution 側で行い、ここは描くだけ。

import { $, addDisposableListener, append, clearNode, EventType } from '../../../../base/browser/dom.js';
import { getDefaultHoverDelegate } from '../../../../base/browser/ui/hover/hoverDelegateFactory.js';
import { renderIcon } from '../../../../base/browser/ui/iconLabel/iconLabels.js';
import { Codicon } from '../../../../base/common/codicons.js';
import { fromNow } from '../../../../base/common/date.js';
import { Emitter } from '../../../../base/common/event.js';
import { Disposable, DisposableStore } from '../../../../base/common/lifecycle.js';
import { localize } from '../../../../nls.js';
import { IHoverService } from '../../../../platform/hover/browser/hover.js';
import { IParadisHistoryPanelItem, IParadisHistoryPanelPlacement, paradisShortenCwd } from '../common/paradisTerminalHistoryPanelModel.js';
import './media/paradisTerminalHistoryPanel.css';

/** 一覧の範囲。スペース別履歴を使っていないターミナルでは切り替えを出さない（undefined）。 */
export type ParadisHistoryPanelScope = 'space' | 'all';

export interface IParadisHistoryPanelView {
	/** 新しい順（0 が最新）。 */
	readonly items: readonly IParadisHistoryPanelItem[];
	readonly selectedIndex: number;
	readonly scope: ParadisHistoryPanelScope | undefined;
	/** 範囲ごとの件数（読み込み中は undefined）。 */
	readonly counts: { readonly space: number | undefined; readonly all: number | undefined };
	/** 打った文字（絞り込み）。 */
	readonly typed: string;
	readonly loading: boolean;
	readonly placement: IParadisHistoryPanelPlacement;
	/** cwd を `~` で縮めるためのホーム。 */
	readonly home: string | undefined;
}

/** 行の高さ（px）。contribution が入る行数を数えるのに使う。 */
export const PARADIS_HISTORY_PANEL_ROW_HEIGHT = 22;
/** 見出しとキーの帯を合わせた高さ（px）の見込み。描いた後は測った値を使う。 */
export const PARADIS_HISTORY_PANEL_CHROME_HEIGHT = 56;

export class ParadisTerminalHistoryPanelWidget extends Disposable {
	readonly element: HTMLElement;
	private readonly _header: HTMLElement;
	private readonly _rows: HTMLElement;
	private readonly _footer: HTMLElement;
	private readonly _renderDisposables = this._register(new DisposableStore());

	private readonly _onDidSelectItem = this._register(new Emitter<number>());
	/** 行をクリックした（新しい順の位置）。 */
	readonly onDidSelectItem = this._onDidSelectItem.event;
	private readonly _onDidRunItem = this._register(new Emitter<number>());
	/** 行をダブルクリックした。 */
	readonly onDidRunItem = this._onDidRunItem.event;
	private readonly _onDidChangeScope = this._register(new Emitter<ParadisHistoryPanelScope>());
	/** 見出しのタブを押した。 */
	readonly onDidChangeScope = this._onDidChangeScope.event;

	constructor(
		container: HTMLElement,
		@IHoverService private readonly _hoverService: IHoverService,
	) {
		super();
		this.element = append(container, $('.paradis-history-panel'));
		this.element.setAttribute('role', 'listbox');
		this.element.setAttribute('aria-label', localize('paradis.historyPanel.aria', "コマンドの履歴"));
		this._header = append(this.element, $('.paradis-history-panel-header'));
		this._rows = append(this.element, $('.paradis-history-panel-rows'));
		this._footer = append(this.element, $('.paradis-history-panel-footer'));
		// 一覧を押してもターミナルからフォーカスを奪わない（キーは引き続きターミナルで受ける）。
		this._register(addDisposableListener(this.element, EventType.MOUSE_DOWN, e => e.preventDefault()));
		this._register({ dispose: () => this.element.remove() });
	}

	setWidth(width: number): void {
		this.element.style.width = `${Math.round(width)}px`;
	}

	setPosition(top: number, left: number): void {
		this.element.style.top = `${Math.round(top)}px`;
		this.element.style.left = `${Math.round(left)}px`;
	}

	/** 見出しとキーの帯と枠を合わせた高さ（px）。描いた後に測る。 */
	chromeHeight(): number {
		return this.element.offsetHeight - this._rows.offsetHeight;
	}

	render(view: IParadisHistoryPanelView): void {
		this._renderDisposables.clear();
		this._renderHeader(view);
		this._renderRows(view);
		this._renderFooter(view);
	}

	private _renderHeader(view: IParadisHistoryPanelView): void {
		clearNode(this._header);
		const title = append(this._header, $('span.paradis-history-panel-title'));
		append(title, renderIcon(Codicon.history));
		append(title, $('span', undefined, localize('paradis.historyPanel.title', "履歴")));
		if (view.scope !== undefined) {
			const tabs = append(this._header, $('span.paradis-history-panel-tabs'));
			this._renderTab(tabs, 'space', view, localize('paradis.historyPanel.scopeSpace', "このスペース"), localize('paradis.historyPanel.scopeSpaceHover', "このスペースのターミナルで実行した履歴"));
			this._renderTab(tabs, 'all', view, localize('paradis.historyPanel.scopeAll', "全スペース"), localize('paradis.historyPanel.scopeAllHover', "すべてのスペースと、共通の履歴"));
			append(tabs, $('span.paradis-history-panel-key', undefined, 'Ctrl+S'));
		}
		append(this._header, $('span', undefined, localize('paradis.historyPanel.prefixMatch', "前方一致:")));
		const query = append(this._header, $('span.paradis-history-panel-query'));
		query.textContent = view.typed.trim();
		const position = append(this._header, $('span.paradis-history-panel-position'));
		const order = view.placement.newestOnTop
			? localize('paradis.historyPanel.newestOnTop', "上ほど新しい")
			: localize('paradis.historyPanel.newestAtBottom', "下ほど新しい");
		position.textContent = view.loading && view.items.length === 0
			? localize('paradis.historyPanel.loading', "読み込み中")
			: view.items.length === 0 ? '' : localize('paradis.historyPanel.position', "{0} / {1}・{2}", view.selectedIndex + 1, view.items.length, order);
	}

	private _renderTab(parent: HTMLElement, scope: ParadisHistoryPanelScope, view: IParadisHistoryPanelView, label: string, hover: string): void {
		const tab = append(parent, $('span.paradis-history-panel-tab'));
		tab.classList.toggle('active', view.scope === scope);
		tab.setAttribute('role', 'tab');
		tab.setAttribute('aria-selected', String(view.scope === scope));
		append(tab, $('span', undefined, label));
		const count = view.counts[scope];
		append(tab, $('span.paradis-history-panel-count', undefined, count === undefined ? '…' : String(count)));
		this._renderDisposables.add(this._hoverService.setupManagedHover(getDefaultHoverDelegate('mouse'), tab, hover));
		this._renderDisposables.add(addDisposableListener(tab, EventType.CLICK, () => {
			if (view.scope !== scope) {
				this._onDidChangeScope.fire(scope);
			}
		}));
	}

	private _renderRows(view: IParadisHistoryPanelView): void {
		clearNode(this._rows);
		const { placement } = view;
		this.element.classList.toggle('above', placement.place === 'above');
		if (view.items.length === 0) {
			const empty = append(this._rows, $('.paradis-history-panel-empty'));
			empty.textContent = view.loading
				? localize('paradis.historyPanel.loadingRows', "履歴を読み込んでいます")
				: view.scope === 'space'
					? localize('paradis.historyPanel.emptySpace', "このスペースには一致する履歴がありません。Ctrl+S で全スペースを探せます")
					: localize('paradis.historyPanel.empty', "一致する履歴はありません。Esc で閉じます");
			return;
		}
		// 選んだ行が見える範囲を、最新の側から数えて決める。
		const visible = Math.max(1, Math.min(placement.rows, view.items.length));
		const start = Math.max(0, Math.min(view.selectedIndex - visible + 1, view.items.length - visible));
		const indices: number[] = [];
		for (let i = start; i < start + visible; i++) {
			indices.push(i);
		}
		if (!placement.newestOnTop) {
			indices.reverse();
		}
		for (const index of indices) {
			this._renderRow(view, index);
		}
	}

	private _renderRow(view: IParadisHistoryPanelView, index: number): void {
		const item = view.items[index];
		const row = append(this._rows, $('.paradis-history-panel-row'));
		row.setAttribute('role', 'option');
		row.setAttribute('aria-selected', String(index === view.selectedIndex));
		row.classList.toggle('selected', index === view.selectedIndex);

		const exit = append(row, $('span.paradis-history-panel-exit'));
		const exitCode = item.last?.exitCode;
		exit.classList.add(exitCode === undefined ? 'unknown' : exitCode === 0 ? 'success' : 'failure');
		this._renderDisposables.add(this._hoverService.setupManagedHover(getDefaultHoverDelegate('mouse'), exit,
			item.last === undefined
				? localize('paradis.historyPanel.noRecord', "Para Code で実行した記録はありません")
				: exitCode === undefined
					? localize('paradis.historyPanel.exitUnknown', "終了コードは分かりません")
					: localize('paradis.historyPanel.exitCode', "終了コード {0}", exitCode)));

		const command = append(row, $('span.paradis-history-panel-command'));
		const prefix = view.typed.trimStart();
		if (prefix.length > 0 && item.command.startsWith(prefix)) {
			append(command, $('span.paradis-history-panel-match', undefined, prefix));
			append(command, $('span', undefined, item.command.substring(prefix.length)));
		} else {
			command.textContent = item.command;
		}

		const cwd = append(row, $('span.paradis-history-panel-cwd'));
		cwd.textContent = paradisShortenCwd(item.last?.cwd, view.home) ?? '';
		const time = append(row, $('span.paradis-history-panel-time'));
		time.textContent = item.last === undefined ? '' : fromNow(item.last.timestamp, true);
		const count = append(row, $('span.paradis-history-panel-times'));
		count.textContent = item.count > 0 ? localize('paradis.historyPanel.count', "×{0}", item.count) : '';

		this._renderDisposables.add(addDisposableListener(row, EventType.CLICK, () => this._onDidSelectItem.fire(index)));
		this._renderDisposables.add(addDisposableListener(row, EventType.DBLCLICK, () => this._onDidRunItem.fire(index)));
	}

	private _renderFooter(view: IParadisHistoryPanelView): void {
		clearNode(this._footer);
		const hint = (keys: string[], label: string) => {
			const group = append(this._footer, $('span.paradis-history-panel-hint'));
			for (const key of keys) {
				append(group, $('span.paradis-history-panel-key', undefined, key));
			}
			append(group, $('span', undefined, label));
		};
		hint(['↓'], localize('paradis.historyPanel.hintOlder', "古い方へ"));
		hint(['↑'], localize('paradis.historyPanel.hintNewer', "新しい方へ（最新でもう一度押すと閉じる）"));
		hint(['Enter'], localize('paradis.historyPanel.hintRun', "実行"));
		hint(['Tab', '→'], localize('paradis.historyPanel.hintInsert', "入力行へ"));
		if (view.scope !== undefined) {
			hint(['Ctrl+S'], localize('paradis.historyPanel.hintScope', "このスペース / 全スペース"));
		}
		hint(['Esc'], localize('paradis.historyPanel.hintClose', "閉じる"));
	}
}
