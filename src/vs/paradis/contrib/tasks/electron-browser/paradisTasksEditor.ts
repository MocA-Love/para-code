/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

// 「タスク」の画面。Orca のタスクの画面と同じ並び（取得元の札、Issue／PR の切り替えとリポジトリの選択、
// プリセット・フィルター・検索・＋・更新、ID・タイトル/コンテキスト・担当者・状態・更新済みの表、空の表示）。
// 取得は shared process のチャネル（paradisTasksGithub）に頼み、ここは描くだけ。検索は Enter・プリセット・
// フィルター・更新のときだけ投げる（打鍵ごとには投げない）。GitHub への書き込みはしない（＋も「GitHub で開く」）。

import './media/paradisTasks.css';
import * as dom from '../../../../base/browser/dom.js';
import { toAction } from '../../../../base/common/actions.js';
import { Codicon } from '../../../../base/common/codicons.js';
import { fromNow } from '../../../../base/common/date.js';
import { ThemeIcon } from '../../../../base/common/themables.js';
import { DisposableStore } from '../../../../base/common/lifecycle.js';
import { URI } from '../../../../base/common/uri.js';
import { ProxyChannel } from '../../../../base/parts/ipc/common/ipc.js';
import { localize } from '../../../../nls.js';
import { ICommandService } from '../../../../platform/commands/common/commands.js';
import { IClipboardService } from '../../../../platform/clipboard/common/clipboardService.js';
import { IContextMenuService } from '../../../../platform/contextview/browser/contextView.js';
import { IFileService } from '../../../../platform/files/common/files.js';
import { ISharedProcessService } from '../../../../platform/ipc/electron-browser/services.js';
import { IOpenerService } from '../../../../platform/opener/common/opener.js';
import { IQuickInputService, IQuickPickItem } from '../../../../platform/quickinput/common/quickInput.js';
import { IStorageService, StorageScope, StorageTarget } from '../../../../platform/storage/common/storage.js';
import { ITelemetryService } from '../../../../platform/telemetry/common/telemetry.js';
import { IThemeService } from '../../../../platform/theme/common/themeService.js';
import { IWorkspaceContextService } from '../../../../platform/workspace/common/workspace.js';
import { EditorPane } from '../../../../workbench/browser/parts/editor/editorPane.js';
import { IEditorGroup } from '../../../../workbench/services/editor/common/editorGroupsService.js';
import { IWorkbenchEnvironmentService } from '../../../../workbench/services/environment/common/environmentService.js';
import { IParadisWorkspaceSwitchService } from '../../workspaceSwitch/common/paradisWorkspaceSwitch.js';
import { IParadisTasksRepository, paradisTasksResolveRepositories } from '../browser/paradisTasksRepositories.js';
import {
	IParadisTasksError,
	IParadisTasksGithubService,
	IParadisTasksItem,
	PARADIS_TASKS_GITHUB_CHANNEL,
	PARADIS_TASKS_MAX_REPOSITORIES,
	PARADIS_TASKS_PRESETS,
	paradisTasksHasQualifier,
	paradisTasksToggleQualifier,
	ParadisTasksMode,
} from '../common/paradisTasks.js';
import { PARADIS_TASKS_EDITOR_ID } from './paradisTasksEditorInput.js';

const $ = dom.$;

/** タスクボードの窓を開くコマンド（taskBoard/electron-browser/paradisTaskBoardEntry.contribution.ts）。 */
const PARADIS_TASK_BOARD_OPEN_COMMAND_ID = 'paradis.taskBoard.open';

const STORAGE_MODE = 'paradis.tasks.mode';
const STORAGE_SELECTED = 'paradis.tasks.selectedRepositories';
const STORAGE_QUERY = (mode: ParadisTasksMode) => `paradis.tasks.query.${mode}`;

/** フィルターのメニューの 1 行。`exclusive` は同時に成り立たない修飾子（足すときに外す）。 */
interface IFilterEntry {
	readonly label: string;
	readonly qualifier: string;
	readonly exclusive?: readonly string[];
	readonly modes: readonly ParadisTasksMode[];
}

function filterEntries(): readonly IFilterEntry[] {
	return [
		{ label: localize('paradis.tasks.filter.open', "状態: オープン"), qualifier: 'is:open', exclusive: ['is:closed', 'is:merged'], modes: ['issue', 'pr'] },
		{ label: localize('paradis.tasks.filter.closed', "状態: クローズ"), qualifier: 'is:closed', exclusive: ['is:open', 'is:merged'], modes: ['issue', 'pr'] },
		{ label: localize('paradis.tasks.filter.merged', "状態: マージ済み"), qualifier: 'is:merged', exclusive: ['is:open', 'is:closed'], modes: ['pr'] },
		{ label: localize('paradis.tasks.filter.draft', "ドラフト"), qualifier: 'draft:true', modes: ['pr'] },
		{ label: localize('paradis.tasks.filter.assignedToMe', "担当者: 自分"), qualifier: 'assignee:@me', exclusive: ['no:assignee'], modes: ['issue', 'pr'] },
		{ label: localize('paradis.tasks.filter.noAssignee', "担当者: なし"), qualifier: 'no:assignee', exclusive: ['assignee:@me'], modes: ['issue', 'pr'] },
		{ label: localize('paradis.tasks.filter.author', "作成者: 自分"), qualifier: 'author:@me', modes: ['issue', 'pr'] },
		{ label: localize('paradis.tasks.filter.reviewRequested', "レビュー: 自分に依頼"), qualifier: 'review-requested:@me', modes: ['pr'] },
		{ label: localize('paradis.tasks.filter.noLabel', "ラベル: なし"), qualifier: 'no:label', modes: ['issue', 'pr'] },
	];
}

function presetLabel(mode: ParadisTasksMode, id: string): string {
	switch (`${mode}:${id}`) {
		case 'issue:open': return localize('paradis.tasks.preset.issueOpen', "オープン");
		case 'issue:assigned': return localize('paradis.tasks.preset.issueAssigned', "私に割り当てられた Issue");
		case 'pr:open': return localize('paradis.tasks.preset.prOpen', "オープン");
		case 'pr:mine': return localize('paradis.tasks.preset.prMine', "自分の PR");
		case 'pr:review': return localize('paradis.tasks.preset.prReview', "レビューを頼まれた PR");
		default: return id;
	}
}

/** 状態の列の文字と色の種類。 */
function stateOf(item: IParadisTasksItem): { readonly label: string; readonly tone: 'open' | 'done' | 'closed' | 'draft' } {
	if (item.kind === 'pr') {
		if (item.state === 'MERGED') {
			return { label: localize('paradis.tasks.state.merged', "マージ済み"), tone: 'done' };
		}
		if (item.state === 'CLOSED') {
			return { label: localize('paradis.tasks.state.prClosed', "クローズ"), tone: 'closed' };
		}
		return item.isDraft ? { label: localize('paradis.tasks.state.draft', "ドラフト"), tone: 'draft' } : { label: localize('paradis.tasks.state.prOpen', "オープン"), tone: 'open' };
	}
	if (item.state === 'CLOSED') {
		return item.stateReason === 'NOT_PLANNED' || item.stateReason === 'DUPLICATE'
			? { label: localize('paradis.tasks.state.notPlanned', "予定なし"), tone: 'closed' }
			: { label: localize('paradis.tasks.state.completed', "完了"), tone: 'done' };
	}
	return { label: localize('paradis.tasks.state.issueOpen', "オープン"), tone: 'open' };
}

export class ParadisTasksEditor extends EditorPane {

	static readonly ID = PARADIS_TASKS_EDITOR_ID;

	private readonly github: IParadisTasksGithubService;

	private root!: HTMLElement;
	private sourceChip!: HTMLElement;
	private modeButtons = new Map<ParadisTasksMode, HTMLButtonElement>();
	private repoButton!: HTMLButtonElement;
	private externalButton!: HTMLButtonElement;
	private presetBar!: HTMLElement;
	private filterButton!: HTMLButtonElement;
	private searchInput!: HTMLInputElement;
	private statusLine!: HTMLElement;
	private tableBody!: HTMLElement;
	private emptyState!: HTMLElement;
	private moreButton!: HTMLButtonElement;

	private mode: ParadisTasksMode;
	private readonly queries = new Map<ParadisTasksMode, string>();
	/** 選べるリポジトリ（この窓のスペースから読んだもの）。読み終わるまで undefined。 */
	private repositories: readonly IParadisTasksRepository[] | undefined;
	/** 人が選んだリポジトリ（`owner/name`）。undefined なら先頭から上限まで全部。 */
	private selected: readonly string[] | undefined;
	private items: IParadisTasksItem[] = [];
	private endCursor: string | undefined;
	private hasNextPage = false;
	private loading = false;
	private generation = 0;
	private repositoryGeneration = 0;
	private error: IParadisTasksError | undefined;
	private fetchedAt: number | undefined;
	private total = 0;
	private remaining: { readonly remaining: number; readonly limit: number } | undefined;
	/** 描き直すたびに作り直す部品（プリセットのボタン・表の行）の listener。 */
	private readonly presetDisposables = this._register(new DisposableStore());
	private readonly rowDisposables = this._register(new DisposableStore());

	constructor(
		group: IEditorGroup,
		@ITelemetryService telemetryService: ITelemetryService,
		@IThemeService themeService: IThemeService,
		@IStorageService private readonly tasksStorage: IStorageService,
		@ISharedProcessService sharedProcessService: ISharedProcessService,
		@IFileService private readonly fileService: IFileService,
		@IParadisWorkspaceSwitchService private readonly switchService: IParadisWorkspaceSwitchService,
		@IWorkspaceContextService private readonly contextService: IWorkspaceContextService,
		@IWorkbenchEnvironmentService private readonly environmentService: IWorkbenchEnvironmentService,
		@IOpenerService private readonly openerService: IOpenerService,
		@IQuickInputService private readonly quickInputService: IQuickInputService,
		@IContextMenuService private readonly contextMenuService: IContextMenuService,
		@IClipboardService private readonly clipboardService: IClipboardService,
		@ICommandService private readonly commandService: ICommandService,
	) {
		super(PARADIS_TASKS_EDITOR_ID, group, telemetryService, themeService, tasksStorage);
		this.github = ProxyChannel.toService<IParadisTasksGithubService>(sharedProcessService.getChannel(PARADIS_TASKS_GITHUB_CHANNEL));
		this.mode = tasksStorage.get(STORAGE_MODE, StorageScope.WORKSPACE) === 'pr' ? 'pr' : 'issue';
		for (const mode of ['issue', 'pr'] as const) {
			this.queries.set(mode, tasksStorage.get(STORAGE_QUERY(mode), StorageScope.WORKSPACE) ?? PARADIS_TASKS_PRESETS[mode][0].query);
		}
		const selected = tasksStorage.get(STORAGE_SELECTED, StorageScope.WORKSPACE);
		try {
			const parsed: unknown = selected ? JSON.parse(selected) : undefined;
			this.selected = Array.isArray(parsed) ? parsed.filter((value): value is string => typeof value === 'string') : undefined;
		} catch {
			this.selected = undefined;
		}
		this._register(this.switchService.onDidChangeRepositories(() => void this.loadRepositories()));
		this._register(this.contextService.onDidChangeWorkspaceFolders(() => void this.loadRepositories()));
	}

	protected override createEditor(parent: HTMLElement): void {
		this.root = dom.append(parent, $('.paradis-tasks'));
		this.root.tabIndex = -1;

		const sourceRow = dom.append(this.root, $('.paradis-tasks-row'));
		const githubIcon = dom.append(sourceRow, $('span.paradis-tasks-source-icon'));
		githubIcon.append(...this.icon(Codicon.github));
		githubIcon.title = 'GitHub';
		this.sourceChip = dom.append(sourceRow, $('span.paradis-tasks-chip'));
		dom.append(sourceRow, $('span.paradis-tasks-grow'));
		// タスクボード（工程のフローでエージェントを回す窓）へは、この画面から行く
		this.button(sourceRow, localize('paradis.tasks.openTaskBoard', "タスクボードを開く"), () => void this.commandService.executeCommand(PARADIS_TASK_BOARD_OPEN_COMMAND_ID), 'paradis-tasks-pill', Codicon.tasklist);

		const modeRow = dom.append(this.root, $('.paradis-tasks-row'));
		for (const mode of ['issue', 'pr'] as const) {
			const button = this.button(modeRow, mode === 'issue' ? 'Issue' : 'PR', () => this.setMode(mode), 'paradis-tasks-pill');
			this.modeButtons.set(mode, button);
		}
		this.repoButton = this.button(modeRow, '', () => void this.pickRepositories(), 'paradis-tasks-combo');
		this.externalButton = this.iconButton(modeRow, Codicon.linkExternal, localize('paradis.tasks.openRepository', "GitHub で開く"), () => this.openRepositoryOnGithub());

		const panel = dom.append(this.root, $('.paradis-tasks-panel'));
		this.presetBar = dom.append(panel, $('.paradis-tasks-row.paradis-tasks-presets'));
		const searchRow = dom.append(panel, $('.paradis-tasks-row'));
		this.filterButton = this.button(searchRow, localize('paradis.tasks.filter', "フィルター"), () => this.showFilterMenu(), 'paradis-tasks-pill', Codicon.filter);
		const search = dom.append(searchRow, $('.paradis-tasks-search'));
		search.append(...this.icon(Codicon.search));
		this.searchInput = dom.append(search, $<HTMLInputElement>('input'));
		this.searchInput.type = 'text';
		this.searchInput.spellcheck = false;
		this.searchInput.setAttribute('aria-label', localize('paradis.tasks.searchAria', "検索（GitHub の検索の書き方。Enter で検索）"));
		this._register(dom.addDisposableListener(this.searchInput, 'keydown', event => {
			if (event.key === 'Enter' && !event.isComposing) {
				event.preventDefault();
				this.setQuery(this.searchInput.value);
			} else if (event.key === 'Escape') {
				this.searchInput.value = this.query;
			}
		}));
		this.iconButton(search, Codicon.close, localize('paradis.tasks.clearSearch', "検索を消す"), () => this.setQuery(''), 'paradis-tasks-clear');
		this.iconButton(searchRow, Codicon.add, localize('paradis.tasks.newItem', "GitHub で新しく作る"), () => void this.openNewOnGithub());
		this.iconButton(searchRow, Codicon.refresh, localize('paradis.tasks.refresh', "更新"), () => void this.load(true));

		this.statusLine = dom.append(panel, $('.paradis-tasks-status'));
		const table = dom.append(panel, $('table.paradis-tasks-table'));
		const head = dom.append(dom.append(table, $('thead')), $('tr'));
		for (const [label, className] of [
			['ID', 'id'],
			[localize('paradis.tasks.column.title', "タイトル/コンテキスト"), 'title'],
			[localize('paradis.tasks.column.assignees', "担当者"), 'assignees'],
			[localize('paradis.tasks.column.state', "状態"), 'state'],
			[localize('paradis.tasks.column.updated', "更新済み"), 'updated'],
			['', 'actions'],
		] as const) {
			dom.append(head, $(`th.${className}`)).textContent = label;
		}
		this.tableBody = dom.append(table, $('tbody'));
		this.emptyState = dom.append(panel, $('.paradis-tasks-empty'));
		this.moreButton = this.button(panel, localize('paradis.tasks.more', "続きを読む"), () => void this.load(false, true), 'paradis-tasks-more');

		this.render();
		void this.loadRepositories();
	}

	protected override setEditorVisible(visible: boolean): void {
		super.setEditorVisible(visible);
		if (visible && this.repositories) {
			// 60 秒以内なら shared process のキャッシュが答えるので、見えるたびに頼んでも GitHub への要求は増えない
			void this.load(false);
		}
	}

	override layout(_dimension: dom.Dimension): void {
		// 表は CSS で幅に合わせる
	}

	override focus(): void {
		super.focus();
		this.searchInput?.focus();
	}

	private get query(): string {
		return this.queries.get(this.mode) ?? '';
	}

	/** 検索に載せるリポジトリ。人が選んでいなければ、先頭から上限まで。 */
	private get activeRepositories(): readonly string[] {
		const all = (this.repositories ?? []).map(repo => repo.name);
		if (!this.selected) {
			return all.slice(0, PARADIS_TASKS_MAX_REPOSITORIES);
		}
		const lower = new Set(this.selected.map(name => name.toLowerCase()));
		return all.filter(name => lower.has(name.toLowerCase())).slice(0, PARADIS_TASKS_MAX_REPOSITORIES);
	}

	private async loadRepositories(): Promise<void> {
		const generation = ++this.repositoryGeneration;
		const sources = [
			...this.switchService.repositories.map(repo => ({ name: repo.name, uri: repo.uri })),
			...this.contextService.getWorkspace().folders.map(folder => ({ name: folder.name, uri: folder.uri })),
		];
		const repositories = await paradisTasksResolveRepositories(this.fileService, sources);
		if (generation !== this.repositoryGeneration) {
			return;
		}
		const before = this.activeRepositories.join(',');
		this.repositories = repositories;
		this.render();
		if (before !== this.activeRepositories.join(',') || this.items.length === 0) {
			void this.load(false);
		}
	}

	private setMode(mode: ParadisTasksMode): void {
		if (mode === this.mode) {
			return;
		}
		this.mode = mode;
		this.tasksStorage.store(STORAGE_MODE, mode, StorageScope.WORKSPACE, StorageTarget.USER);
		this.resetItems();
		this.searchInput.value = this.query;
		this.render();
		void this.load(false);
	}

	private setQuery(query: string): void {
		const trimmed = query.trim();
		this.queries.set(this.mode, trimmed);
		this.tasksStorage.store(STORAGE_QUERY(this.mode), trimmed, StorageScope.WORKSPACE, StorageTarget.USER);
		this.resetItems();
		this.searchInput.value = trimmed;
		this.render();
		void this.load(false);
	}

	private resetItems(): void {
		this.generation++;
		this.items = [];
		this.endCursor = undefined;
		this.hasNextPage = false;
		this.error = undefined;
		this.fetchedAt = undefined;
		this.loading = false;
	}

	/**
	 * 一覧を読む。`force` は更新ボタン（キャッシュを使わない）、`more` は続きのページ。
	 * 途中でモード・検索・リポジトリが変わったら、古い応答は描かない。
	 */
	private async load(force: boolean, more = false): Promise<void> {
		const repositories = this.activeRepositories;
		if (!this.repositories || repositories.length === 0) {
			this.resetItems();
			this.render();
			return;
		}
		if (more && (!this.hasNextPage || this.loading)) {
			return;
		}
		const generation = more ? this.generation : ++this.generation;
		this.loading = true;
		this.render();
		const response = await this.github.search({ mode: this.mode, repositories, query: this.query, after: more ? this.endCursor : undefined, force });
		if (generation !== this.generation) {
			return;
		}
		this.loading = false;
		if (response.ok) {
			this.items = more ? [...this.items, ...response.result.items] : [...response.result.items];
			this.endCursor = response.result.endCursor;
			this.hasNextPage = response.result.hasNextPage;
			this.total = response.result.total;
			this.fetchedAt = response.result.fetchedAt;
			this.remaining = response.result.rateLimit;
			this.error = undefined;
		} else {
			this.error = response.error;
		}
		this.render();
	}

	private render(): void {
		if (!this.root) {
			return;
		}
		const remote = this.environmentService.remoteAuthority !== undefined;
		const count = this.repositories?.length ?? 0;
		this.sourceChip.textContent = [
			'GitHub',
			remote ? localize('paradis.tasks.source.localGhRemote', "この PC の gh（リポジトリは接続先）") : localize('paradis.tasks.source.localGh', "この PC の gh"),
			count === 0 ? localize('paradis.tasks.source.noRepository', "選択したリポジトリ") : localize('paradis.tasks.source.repositories', "{0} 個のリポジトリ", count),
		].join(' · ');

		for (const [mode, button] of this.modeButtons) {
			button.classList.toggle('on', mode === this.mode);
		}
		const active = this.activeRepositories;
		this.setButtonLabel(this.repoButton, active.length === 0
			? localize('paradis.tasks.noRepositories', "リポジトリがありません")
			: active.join(', '), Codicon.chevronDown);
		this.repoButton.disabled = count === 0;
		this.externalButton.disabled = active.length !== 1;

		dom.clearNode(this.presetBar);
		this.presetDisposables.clear();
		for (const preset of PARADIS_TASKS_PRESETS[this.mode]) {
			const button = this.button(this.presetBar, presetLabel(this.mode, preset.id), () => this.setQuery(preset.query), 'paradis-tasks-pill', undefined, this.presetDisposables);
			button.classList.toggle('on', preset.query === this.query);
		}
		if (this.searchInput && dom.getActiveElement() !== this.searchInput) {
			this.searchInput.value = this.query;
		}
		this.searchInput.placeholder = this.mode === 'pr' ? 'is:pr is:open' : 'is:issue is:open';

		this.renderStatus();
		this.renderRows();
	}

	private renderStatus(): void {
		const parts: string[] = [];
		if (this.loading) {
			parts.push(localize('paradis.tasks.loading', "読み込んでいます"));
		} else if (this.fetchedAt !== undefined && !this.error) {
			parts.push(localize('paradis.tasks.count', "{0} 件", this.total));
			parts.push(localize('paradis.tasks.fetchedAt', "取得 {0}", new Date(this.fetchedAt).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' })));
		}
		if (this.remaining) {
			parts.push(localize('paradis.tasks.remaining', "API 残り {0} / {1}", this.remaining.remaining.toLocaleString(), this.remaining.limit.toLocaleString()));
		}
		const selected = this.selected ? this.selected.length : this.repositories?.length ?? 0;
		if (selected > PARADIS_TASKS_MAX_REPOSITORIES) {
			parts.push(localize('paradis.tasks.repositoryLimit', "一度に検索するのは {0} 個のリポジトリまでです", PARADIS_TASKS_MAX_REPOSITORIES));
		}
		this.statusLine.textContent = parts.join(' · ');
	}

	private renderRows(): void {
		dom.clearNode(this.tableBody);
		dom.clearNode(this.emptyState);
		this.rowDisposables.clear();
		const empty = this.emptyMessage();
		this.emptyState.style.display = empty ? '' : 'none';
		this.moreButton.style.display = !empty && this.hasNextPage ? '' : 'none';
		this.moreButton.disabled = this.loading;
		if (empty) {
			dom.append(this.emptyState, $('.paradis-tasks-empty-title')).textContent = empty.title;
			dom.append(this.emptyState, $('.paradis-tasks-empty-body')).textContent = empty.body;
			return;
		}
		for (const item of this.items) {
			this.renderRow(item);
		}
	}

	private emptyMessage(): { readonly title: string; readonly body: string } | undefined {
		if (this.repositories && this.activeRepositories.length === 0) {
			return {
				title: localize('paradis.tasks.empty.noSource', "リポジトリのソースが選択されていません"),
				body: this.repositories.length === 0
					? localize('paradis.tasks.empty.noSourceBody', "タスクは、このウィンドウで開いているリポジトリのうち、GitHub（github.com）の origin を持つものから読みます。そのようなリポジトリを開いてください。")
					: localize('paradis.tasks.empty.noneSelectedBody', "上のリポジトリの選択から、1 つ以上を選んでください。"),
			};
		}
		if (this.error) {
			switch (this.error.kind) {
				case 'no-gh':
					return { title: localize('paradis.tasks.error.noGh', "GitHub CLI（gh）が見つかりません"), body: localize('paradis.tasks.error.noGhBody', "gh を入れて、ターミナルで `gh auth login` を実行してください。") };
				case 'auth':
					return { title: localize('paradis.tasks.error.auth', "gh が GitHub にログインしていません"), body: localize('paradis.tasks.error.authBody', "ターミナルで `gh auth login` を実行してから、更新を押してください。") };
				case 'rate-limited':
					return {
						title: localize('paradis.tasks.error.rateLimited', "GitHub の API の上限に達しました"),
						body: this.error.retryAt
							? localize('paradis.tasks.error.rateLimitedAt', "{0} ごろに読み直せます。", new Date(this.error.retryAt).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' }))
							: localize('paradis.tasks.error.rateLimitedLater', "しばらくしてから更新を押してください。"),
					};
				default:
					return { title: localize('paradis.tasks.error.failed', "読み込めませんでした"), body: this.error.message };
			}
		}
		if (!this.repositories || (this.loading && this.items.length === 0)) {
			return { title: localize('paradis.tasks.loadingTitle', "読み込んでいます"), body: '' };
		}
		if (this.items.length === 0 && this.fetchedAt !== undefined) {
			return { title: localize('paradis.tasks.empty.noResult', "当てはまるものはありません"), body: localize('paradis.tasks.empty.noResultBody', "検索の文字列やフィルターを変えてみてください。") };
		}
		return undefined;
	}

	private renderRow(item: IParadisTasksItem): void {
		const row = dom.append(this.tableBody, $('tr.paradis-tasks-item'));
		row.tabIndex = 0;
		dom.append(row, $('td.id')).textContent = `#${item.number}`;

		const title = dom.append(row, $('td.title'));
		dom.append(title, $('.paradis-tasks-item-title')).textContent = item.title;
		const context = dom.append(title, $('.paradis-tasks-item-context'));
		dom.append(context, $('span.repo')).textContent = item.repository;
		if (item.author) {
			dom.append(context, $('span')).textContent = localize('paradis.tasks.author', "作成 {0}", item.author);
		}
		if (item.kind === 'pr' && item.reviewDecision) {
			dom.append(context, $('span')).textContent = item.reviewDecision === 'APPROVED'
				? localize('paradis.tasks.review.approved', "承認済み")
				: item.reviewDecision === 'CHANGES_REQUESTED'
					? localize('paradis.tasks.review.changes', "変更を依頼")
					: localize('paradis.tasks.review.required', "レビュー待ち");
		}
		for (const label of item.labels) {
			const chip = dom.append(context, $('span.paradis-tasks-label'));
			chip.textContent = label.name;
			chip.style.setProperty('--paradis-tasks-label-color', `#${label.color}`);
		}

		const assignees = dom.append(row, $('td.assignees'));
		if (item.assignees.length === 0) {
			dom.append(assignees, $('span.paradis-tasks-faint')).textContent = '-';
		}
		for (const user of item.assignees) {
			const avatar = dom.append(assignees, $('span.paradis-tasks-avatar'));
			avatar.title = user.login;
			if (user.avatarUrl?.startsWith('https://')) {
				const image = dom.append(avatar, $<HTMLImageElement>('img'));
				image.src = user.avatarUrl;
				image.alt = user.login;
			} else {
				avatar.textContent = user.login.slice(0, 2).toUpperCase();
			}
		}

		const state = stateOf(item);
		const stateCell = dom.append(dom.append(row, $('td.state')), $(`span.paradis-tasks-state.${state.tone}`));
		stateCell.textContent = state.label;

		const updated = dom.append(row, $('td.updated'));
		const time = Date.parse(item.updatedAt);
		updated.textContent = isNaN(time) ? '' : fromNow(time, true);
		updated.title = isNaN(time) ? '' : new Date(time).toLocaleString();

		const actions = dom.append(row, $('td.actions'));
		this.iconButton(actions, Codicon.ellipsis, localize('paradis.tasks.rowActions', "操作"), event => this.showRowMenu(item, event), '', this.rowDisposables);

		this.rowDisposables.add(dom.addDisposableListener(row, 'click', event => {
			if (!(event.target as HTMLElement).closest('button')) {
				this.openItem(item);
			}
		}));
		this.rowDisposables.add(dom.addDisposableListener(row, 'keydown', event => {
			if (event.key === 'Enter') {
				this.openItem(item);
			}
		}));
	}

	private openItem(item: IParadisTasksItem): void {
		void this.openerService.open(URI.parse(item.url), { openExternal: true });
	}

	private showRowMenu(item: IParadisTasksItem, event: MouseEvent): void {
		this.contextMenuService.showContextMenu({
			getAnchor: () => event.target as HTMLElement,
			getActions: () => [
				toAction({ id: 'paradis.tasks.openOnGithub', label: localize('paradis.tasks.openOnGithub', "GitHub で開く"), run: () => this.openItem(item) }),
				toAction({ id: 'paradis.tasks.copyUrl', label: localize('paradis.tasks.copyUrl', "URL をコピー"), run: () => this.clipboardService.writeText(item.url) }),
			],
		});
	}

	private showFilterMenu(): void {
		this.contextMenuService.showContextMenu({
			getAnchor: () => this.filterButton,
			getActions: () => filterEntries().filter(entry => entry.modes.includes(this.mode)).map(entry => toAction({
				id: `paradis.tasks.filter.${entry.qualifier}`,
				label: entry.label,
				checked: paradisTasksHasQualifier(this.query, entry.qualifier),
				run: () => this.setQuery(paradisTasksToggleQualifier(this.query, entry.qualifier, entry.exclusive)),
			})),
		});
	}

	private async pickRepositories(): Promise<void> {
		const repositories = this.repositories ?? [];
		const active = new Set(this.activeRepositories.map(name => name.toLowerCase()));
		const items: (IQuickPickItem & { readonly name: string })[] = repositories.map(repo => ({
			label: repo.name,
			description: repo.spaceName,
			name: repo.name,
			picked: active.has(repo.name.toLowerCase()),
		}));
		const picked = await this.quickInputService.pick(items, {
			canPickMany: true,
			placeHolder: localize('paradis.tasks.pickRepositories', "タスクを読むリポジトリを選んでください（{0} 個まで）", PARADIS_TASKS_MAX_REPOSITORIES),
		});
		if (!picked) {
			return;
		}
		this.selected = picked.map(item => item.name);
		this.tasksStorage.store(STORAGE_SELECTED, JSON.stringify(this.selected), StorageScope.WORKSPACE, StorageTarget.USER);
		this.resetItems();
		this.render();
		void this.load(false);
	}

	private openRepositoryOnGithub(): void {
		const [repository] = this.activeRepositories;
		if (repository) {
			void this.openerService.open(URI.parse(`https://github.com/${repository}/${this.mode === 'pr' ? 'pulls' : 'issues'}`), { openExternal: true });
		}
	}

	/** ＋: GitHub への書き込みはせず、新しい Issue（PR は比較）の GitHub の画面を開く。 */
	private async openNewOnGithub(): Promise<void> {
		const active = this.activeRepositories;
		let repository = active.length === 1 ? active[0] : undefined;
		if (!repository && active.length > 1) {
			const picked = await this.quickInputService.pick(active.map(name => ({ label: name })), {
				placeHolder: localize('paradis.tasks.pickNewRepository', "どのリポジトリに作りますか"),
			});
			repository = picked?.label;
		}
		if (repository) {
			void this.openerService.open(URI.parse(`https://github.com/${repository}/${this.mode === 'pr' ? 'compare' : 'issues/new'}`), { openExternal: true });
		}
	}

	private icon(icon: ThemeIcon): HTMLElement[] {
		return [$(`span${ThemeIcon.asCSSSelector(icon)}`)];
	}

	private setButtonLabel(button: HTMLButtonElement, label: string, trailing?: ThemeIcon): void {
		dom.clearNode(button);
		dom.append(button, $('span.paradis-tasks-button-label')).textContent = label;
		if (trailing) {
			button.append(...this.icon(trailing));
		}
		button.title = label;
	}

	private button(parent: HTMLElement, label: string, run: (event: MouseEvent) => void, className: string, leading?: ThemeIcon, store?: DisposableStore): HTMLButtonElement {
		const button = dom.append(parent, $<HTMLButtonElement>(`button.${className}`));
		button.type = 'button';
		if (leading) {
			button.append(...this.icon(leading));
		}
		dom.append(button, $('span.paradis-tasks-button-label')).textContent = label;
		const listener = dom.addDisposableListener(button, 'click', event => run(event));
		if (store) {
			store.add(listener);
		} else {
			this._register(listener);
		}
		return button;
	}

	private iconButton(parent: HTMLElement, icon: ThemeIcon, label: string, run: (event: MouseEvent) => void, extraClass = '', store?: DisposableStore): HTMLButtonElement {
		const button = dom.append(parent, $<HTMLButtonElement>(`button.paradis-tasks-icon-button${extraClass ? `.${extraClass}` : ''}`));
		button.type = 'button';
		button.title = label;
		button.setAttribute('aria-label', label);
		button.append(...this.icon(icon));
		const listener = dom.addDisposableListener(button, 'click', event => run(event));
		if (store) {
			store.add(listener);
		} else {
			this._register(listener);
		}
		return button;
	}
}
