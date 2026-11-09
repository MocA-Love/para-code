/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import * as DOM from '../../../../base/browser/dom.js';
import { StandardKeyboardEvent } from '../../../../base/browser/keyboardEvent.js';
import { StandardMouseEvent } from '../../../../base/browser/mouseEvent.js';
import { getDefaultHoverDelegate } from '../../../../base/browser/ui/hover/hoverDelegateFactory.js';
import { IAction, toAction } from '../../../../base/common/actions.js';
import { Codicon } from '../../../../base/common/codicons.js';
import { Event } from '../../../../base/common/event.js';
import { KeyCode } from '../../../../base/common/keyCodes.js';
import { Disposable, DisposableStore } from '../../../../base/common/lifecycle.js';
import { ThemeIcon } from '../../../../base/common/themables.js';
import { localize } from '../../../../nls.js';
import { CommandsRegistry, ICommandService } from '../../../../platform/commands/common/commands.js';
import { IContextMenuService } from '../../../../platform/contextview/browser/contextView.js';
import { IHoverService } from '../../../../platform/hover/browser/hover.js';
import { IStorageService, StorageScope, StorageTarget } from '../../../../platform/storage/common/storage.js';

/** 隠したナビの行の id を覚えるキー（プロファイル単位） */
const HIDDEN_NAV_ITEMS_STORAGE_KEY = 'paradis.workspaceSwitch.hiddenNavItems';

/** スペースの一覧の上に並べる行（Orca の左のサイドバーの並び）。 */
interface IParadisWorkspacesNavItem {
	readonly id: string;
	readonly icon: ThemeIcon;
	readonly label: string;
	readonly tooltip: string;
	/** 押したときに動かすコマンド。無ければ検索の行（{@link ParadisWorkspacesNav.openSearch}） */
	readonly command?: string;
}

const NAV_ITEMS: readonly IParadisWorkspacesNavItem[] = [
	{ id: 'search', icon: Codicon.search, label: localize('paradis.workspacesNav.search', "検索"), tooltip: localize('paradis.workspacesNav.searchTooltip', "エージェント・タブ・スペースを探して移動する") },
	{ id: 'taskBoard', icon: Codicon.tasklist, label: localize('paradis.workspacesNav.taskBoard', "タスク"), tooltip: localize('paradis.workspacesNav.taskBoardTooltip', "タスク（GitHub の Issue・PR）を開く"), command: 'paradis.tasks.open' },
	{ id: 'scheduledRuns', icon: Codicon.watch, label: localize('paradis.workspacesNav.scheduledRuns', "定期実行"), tooltip: localize('paradis.workspacesNav.scheduledRunsTooltip', "定期実行を開く"), command: 'paradis.openScheduledRuns' },
	{ id: 'mobile', icon: Codicon.deviceMobile, label: localize('paradis.workspacesNav.mobile', "モバイル"), tooltip: localize('paradis.workspacesNav.mobileTooltip', "Para Code Mobile の接続とデバイスの管理"), command: 'paradis.mobile.open' },
];

const ADD_REPOSITORY_COMMAND = 'paradis.workspaceSwitch.addRepository';
const CREATE_WORKTREE_COMMAND = 'paradis.workspaceSwitch.createWorktree';
const OPEN_AGENT_LIST_COMMAND = 'paradis.agentLiveWindow.open';
/** 検索の行で開く、エージェント・今のスペースのタブ・スペースをまとめて探すパレット（Q593。デスクトップだけにある） */
const CROSS_JUMP_COMMAND = 'paradis.crossJump.open';

/** ナビと見出しが一覧のビューから受け取るもの。 */
export interface IParadisWorkspacesNavDelegate {
	/** 検索の行を押したとき、エージェント・タブ・スペースをまとめて探すパレットが無い環境（Web）で代わりに開くもの */
	openSearch(): void;
	/** 見出しのベルに出す数。attention は許可待ち・質問、working は作業中の数 */
	agentCounts(): { readonly attention: number; readonly working: number };
	readonly onDidChangeAgentCounts: Event<void>;
	/** 見出しの「表示のオプション」で出すメニュー */
	optionsActions(): IAction[];
}

/**
 * スペースの一覧（Workspaces ビュー）の上に置く、Orca 風のナビ（検索・タスク・定期実行・モバイル）と
 * 「プロジェクト」の見出し（ベル・表示のオプション・リポジトリを追加・新しいワークツリースペース）。
 * ナビの各行は元の場所（タイトルバー・歯車のメニュー・ステータスバー）にも残したまま、右クリックで隠せる。
 */
export class ParadisWorkspacesNav extends Disposable {

	readonly element: HTMLElement;
	private readonly navContainer: HTMLElement;
	private readonly rowDisposables = this._register(new DisposableStore());
	private readonly bellCount: HTMLElement;
	private readonly bellButton: HTMLElement;
	private readonly bellIcon: HTMLElement;
	private onDidChangeHeight: (() => void) | undefined;

	constructor(
		container: HTMLElement,
		private readonly delegate: IParadisWorkspacesNavDelegate,
		@ICommandService private readonly commandService: ICommandService,
		@IContextMenuService private readonly contextMenuService: IContextMenuService,
		@IStorageService private readonly storageService: IStorageService,
		@IHoverService private readonly hoverService: IHoverService,
	) {
		super();
		this.element = DOM.append(container, DOM.$('.paradis-workspaces-nav'));
		this.navContainer = DOM.append(this.element, DOM.$('.paradis-workspaces-nav-items'));

		const heading = DOM.append(this.element, DOM.$('.paradis-workspaces-heading'));
		DOM.append(heading, DOM.$('span.paradis-workspaces-heading-label')).textContent = localize('paradis.workspacesNav.projects', "プロジェクト");
		this._register(DOM.addDisposableListener(heading, DOM.EventType.CONTEXT_MENU, e => this.showNavMenu(e)));
		const actions = DOM.append(heading, DOM.$('.paradis-workspaces-heading-actions'));

		this.bellButton = this.headingButton(actions, Codicon.bell, localize('paradis.workspacesNav.agents', "エージェントの一覧を開く"), () => this.runIfRegistered(OPEN_AGENT_LIST_COMMAND));
		this.bellButton.classList.add('paradis-workspaces-heading-bell');
		this.bellIcon = this.bellButton.firstElementChild as HTMLElement;
		this.bellCount = DOM.append(this.bellButton, DOM.$('span.paradis-workspaces-heading-bell-count'));
		this.bellButton.style.display = CommandsRegistry.getCommand(OPEN_AGENT_LIST_COMMAND) ? '' : 'none';
		this.headingButton(actions, Codicon.settings, localize('paradis.workspacesNav.options', "表示のオプション"), anchor => this.contextMenuService.showContextMenu({
			getAnchor: () => anchor,
			getActions: () => this.delegate.optionsActions(),
		}));
		this.headingButton(actions, Codicon.newFolder, localize('paradis.workspacesNav.addRepository', "リポジトリを追加..."), () => this.runIfRegistered(ADD_REPOSITORY_COMMAND));
		const create = this.headingButton(actions, Codicon.add, localize('paradis.workspacesNav.createWorktree', "新しいワークツリースペース..."), () => this.runIfRegistered(CREATE_WORKTREE_COMMAND));
		create.style.display = CommandsRegistry.getCommand(CREATE_WORKTREE_COMMAND) ? '' : 'none';

		this.renderItems();
		this.updateAgentCounts();
		this._register(this.delegate.onDidChangeAgentCounts(() => this.updateAgentCounts()));
		this._register(this.storageService.onDidChangeValue(StorageScope.PROFILE, HIDDEN_NAV_ITEMS_STORAGE_KEY, this._store)(() => this.renderItems()));
	}

	/** 行を隠した・戻したときに呼ぶ（ビューが控えた高さを捨て、ツリーを配分し直す）。 */
	setHeightChangeListener(listener: () => void): void {
		this.onDidChangeHeight = listener;
	}

	private hiddenItems(): Set<string> {
		const raw = this.storageService.get(HIDDEN_NAV_ITEMS_STORAGE_KEY, StorageScope.PROFILE);
		if (!raw) {
			return new Set();
		}
		try {
			const parsed: unknown = JSON.parse(raw);
			return new Set(Array.isArray(parsed) ? parsed.filter((id): id is string => typeof id === 'string') : []);
		} catch {
			return new Set();
		}
	}

	private setHidden(id: string, hidden: boolean): void {
		const items = this.hiddenItems();
		if (hidden) {
			items.add(id);
		} else {
			items.delete(id);
		}
		if (items.size === 0) {
			this.storageService.remove(HIDDEN_NAV_ITEMS_STORAGE_KEY, StorageScope.PROFILE);
		} else {
			this.storageService.store(HIDDEN_NAV_ITEMS_STORAGE_KEY, JSON.stringify([...items]), StorageScope.PROFILE, StorageTarget.USER);
		}
	}

	/** このウィンドウで使える行だけを返す（コマンドが無い環境では出さない。Web など）。 */
	private availableItems(): IParadisWorkspacesNavItem[] {
		return NAV_ITEMS.filter(item => !item.command || !!CommandsRegistry.getCommand(item.command));
	}

	private renderItems(): void {
		this.rowDisposables.clear();
		DOM.clearNode(this.navContainer);
		const hidden = this.hiddenItems();
		// 行のまとまりは Tab の止まりを 1 つにし、中は上下の矢印で動く（ツールバーと同じ）
		const rows: HTMLElement[] = [];
		for (const item of this.availableItems()) {
			if (hidden.has(item.id)) {
				continue;
			}
			const row = DOM.append(this.navContainer, DOM.$(`.paradis-workspaces-nav-row.paradis-focus-ring-inset.paradis-workspaces-nav-${item.id}`));
			row.tabIndex = rows.length === 0 ? 0 : -1;
			rows.push(row);
			row.setAttribute('role', 'button');
			row.setAttribute('aria-label', item.tooltip);
			DOM.append(row, DOM.$(ThemeIcon.asCSSSelector(item.icon)));
			DOM.append(row, DOM.$('span.paradis-workspaces-nav-label')).textContent = item.label;
			this.rowDisposables.add(this.hoverService.setupManagedHover(getDefaultHoverDelegate('mouse'), row, item.tooltip));
			const run = () => item.command ? this.runIfRegistered(item.command) : this.openSearch();
			this.rowDisposables.add(DOM.addDisposableListener(row, DOM.EventType.CLICK, run));
			this.rowDisposables.add(DOM.addDisposableListener(row, DOM.EventType.KEY_DOWN, e => {
				const event = new StandardKeyboardEvent(e);
				if (event.equals(KeyCode.Enter) || event.equals(KeyCode.Space)) {
					event.preventDefault();
					run();
					return;
				}
				const index = rows.indexOf(row);
				const next = event.equals(KeyCode.DownArrow) ? Math.min(rows.length - 1, index + 1)
					: event.equals(KeyCode.UpArrow) ? Math.max(0, index - 1)
						: event.equals(KeyCode.Home) ? 0
							: event.equals(KeyCode.End) ? rows.length - 1
								: -1;
				if (next >= 0) {
					event.preventDefault();
					rows[index].tabIndex = -1;
					rows[next].tabIndex = 0;
					rows[next].focus();
				}
			}));
			this.rowDisposables.add(DOM.addDisposableListener(row, DOM.EventType.CONTEXT_MENU, e => this.showNavMenu(e)));
		}
		this.onDidChangeHeight?.();
	}

	/** 右クリック: 各行を出す・隠す（全部隠しても「プロジェクト」の見出しの右クリックから戻せる）。 */
	private showNavMenu(e: MouseEvent): void {
		DOM.EventHelper.stop(e, true);
		const hidden = this.hiddenItems();
		const actions: IAction[] = this.availableItems().map(item => toAction({
			id: `paradis.workspacesNav.toggle.${item.id}`,
			label: localize('paradis.workspacesNav.show', "「{0}」を表示", item.label),
			checked: !hidden.has(item.id),
			run: () => this.setHidden(item.id, !hidden.has(item.id)),
		}));
		const event = new StandardMouseEvent(DOM.getWindow(this.element), e);
		this.contextMenuService.showContextMenu({ getAnchor: () => event, getActions: () => actions });
	}

	private headingButton(container: HTMLElement, icon: ThemeIcon, label: string, run: (anchor: HTMLElement) => void): HTMLElement {
		const button = DOM.append(container, DOM.$('.paradis-workspaces-heading-button.paradis-focus-ring-inset'));
		button.tabIndex = 0;
		button.setAttribute('role', 'button');
		button.setAttribute('aria-label', label);
		DOM.append(button, DOM.$(ThemeIcon.asCSSSelector(icon)));
		this._register(this.hoverService.setupManagedHover(getDefaultHoverDelegate('mouse'), button, label));
		this._register(DOM.addDisposableListener(button, DOM.EventType.CLICK, e => {
			DOM.EventHelper.stop(e, true);
			run(button);
		}));
		this._register(DOM.addDisposableListener(button, DOM.EventType.KEY_DOWN, e => {
			const event = new StandardKeyboardEvent(e);
			if (event.equals(KeyCode.Enter) || event.equals(KeyCode.Space)) {
				event.preventDefault();
				run(button);
			}
		}));
		return button;
	}

	private updateAgentCounts(): void {
		const { attention, working } = this.delegate.agentCounts();
		const count = attention || working;
		this.bellCount.textContent = count > 99 ? '99+' : count > 0 ? String(count) : '';
		this.bellButton.classList.toggle('attention', attention > 0);
		this.bellIcon.className = ThemeIcon.asClassName(attention > 0 ? Codicon.bellDot : Codicon.bell);
	}

	/** 検索の行: 画面の中央寄りに出るパレット（エージェント・タブ・スペースへ移動...）の入口。無い環境ではスペースだけを探す */
	private openSearch(): void {
		if (CommandsRegistry.getCommand(CROSS_JUMP_COMMAND)) {
			void this.commandService.executeCommand(CROSS_JUMP_COMMAND);
		} else {
			this.delegate.openSearch();
		}
	}

	private runIfRegistered(command: string): void {
		if (CommandsRegistry.getCommand(command)) {
			void this.commandService.executeCommand(command);
		}
	}
}
