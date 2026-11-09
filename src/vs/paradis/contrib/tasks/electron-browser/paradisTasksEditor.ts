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
import { IAction, Separator, toAction } from '../../../../base/common/actions.js';
import { Codicon } from '../../../../base/common/codicons.js';
import { fromNow } from '../../../../base/common/date.js';
import { ThemeIcon } from '../../../../base/common/themables.js';
import { DisposableStore } from '../../../../base/common/lifecycle.js';
import { URI } from '../../../../base/common/uri.js';
import { ProxyChannel } from '../../../../base/parts/ipc/common/ipc.js';
import { localize } from '../../../../nls.js';
import { ICommandService } from '../../../../platform/commands/common/commands.js';
import { INotificationService, Severity } from '../../../../platform/notification/common/notification.js';
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
import { IParadisTaskBoardHostService } from '../../taskBoard/common/paradisTaskBoardHost.js';
import { IParadisWorkspaceSwitchService } from '../../workspaceSwitch/common/paradisWorkspaceSwitch.js';
import { IParadisTasksRepository, ParadisTasksOriginReader, paradisTasksResolveRepositories } from '../browser/paradisTasksRepositories.js';
import { IParadisWorktreeGitCommandResult, PARADIS_WORKTREE_GIT_CHANNEL } from '../../workspaceSwitch/common/paradisWorktreeCreate.js';
import { paradisChannelHostResolver } from '../../workspaceSwitch/electron-browser/paradisWorktreeGitChannelClient.js';
import { IInstantiationService } from '../../../../platform/instantiation/common/instantiation.js';
import { raceTimeout } from '../../../../base/common/async.js';
import {
	IParadisTasksError,
	IParadisTasksItem,
	PARADIS_TASKS_GITHUB_CHANNEL,
	PARADIS_TASKS_MAX_REPOSITORIES,
	PARADIS_TASKS_PRESETS,
	paradisTasksHasQualifier,
	paradisTasksToggleQualifier,
	ParadisTasksMode,
} from '../common/paradisTasks.js';
import { IParadisTasksGithubService, IParadisTasksProject, IParadisTasksProjectItem, IParadisTasksProjectItemsResult, IParadisTasksProjectView } from '../common/paradisTasksProjects.js';
import { PARADIS_TASKS_EDITOR_ID } from './paradisTasksEditorInput.js';

/** git に origin を解かせるのを待つ上限。過ぎたら `.git/config` の読みに戻す。 */
const ORIGIN_READ_TIMEOUT_MS = 5_000;
import { paradisTasksRenderProjectBoard, paradisTasksRenderProjectRoadmap, paradisTasksRenderProjectTable } from './paradisTasksProjectView.js';

const $ = dom.$;

/** タスクボードの窓を開くコマンド（taskBoard/electron-browser/paradisTaskBoardEntry.contribution.ts）。 */
const PARADIS_TASK_BOARD_OPEN_COMMAND_ID = 'paradis.taskBoard.open';

/** 画面の切り替え（Issue・PR は検索、プロジェクトは GitHub Projects v2）。 */
type ParadisTasksTab = ParadisTasksMode | 'project';

const STORAGE_MODE = 'paradis.tasks.mode';
/** 選んだプロジェクトとビュー（`{ owner, number, view }`）。 */
const STORAGE_PROJECT = 'paradis.tasks.project';
const STORAGE_SELECTED = 'paradis.tasks.selectedRepositories';
const STORAGE_QUERY = (mode: ParadisTasksTab) => `paradis.tasks.query.${mode}`;

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
	/** フォルダのあるマシン（SSH なら接続先）の git に origin を解かせる（{@link ParadisTasksOriginReader}）。 */
	private readonly readOrigin: ParadisTasksOriginReader;

	private root!: HTMLElement;
	private sourceChip!: HTMLElement;
	private modeButtons = new Map<ParadisTasksTab, HTMLButtonElement>();
	private repoButton!: HTMLButtonElement;
	private externalButton!: HTMLButtonElement;
	private presetBar!: HTMLElement;
	private filterButton!: HTMLButtonElement;
	private searchInput!: HTMLInputElement;
	private statusLine!: HTMLElement;
	private searchTable!: HTMLElement;
	private tableBody!: HTMLElement;
	private projectRow!: HTMLElement;
	private projectButton!: HTMLButtonElement;
	private projectHost!: HTMLElement;
	private newButton!: HTMLButtonElement;
	private emptyState!: HTMLElement;
	private moreButton!: HTMLButtonElement;

	private mode: ParadisTasksTab;
	private readonly queries = new Map<ParadisTasksTab, string>();
	/** 選べるプロジェクト（リポジトリにつながったもの・持ち主のもの・自分のもの）。読むまで undefined。 */
	private projects: readonly IParadisTasksProject[] | undefined;
	private projectsError: IParadisTasksError | undefined;
	private projectsLoading = false;
	private projectsGeneration = 0;
	/** 選んでいるプロジェクトとビュー。 */
	private projectChoice: { readonly owner: string; readonly number: number; readonly view: number } | undefined;
	/** 選んでいるビューの項目（続きを読んだ分も足したもの）。 */
	private projectResult: IParadisTasksProjectItemsResult | undefined;
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
		@IParadisTaskBoardHostService private readonly taskBoardHost: IParadisTaskBoardHostService,
		@INotificationService private readonly notificationService: INotificationService,
		@IInstantiationService instantiationService: IInstantiationService,
	) {
		super(PARADIS_TASKS_EDITOR_ID, group, telemetryService, themeService, tasksStorage);
		this.github = ProxyChannel.toService<IParadisTasksGithubService>(sharedProcessService.getChannel(PARADIS_TASKS_GITHUB_CHANNEL));
		const resolveGitHost = instantiationService.invokeFunction(accessor => paradisChannelHostResolver(accessor, PARADIS_WORKTREE_GIT_CHANNEL, 'reject'));
		this.readOrigin = async folder => {
			const host = resolveGitHost(folder);
			if (!host) {
				return undefined;
			}
			// 返事が来ない（つながらない接続先）ときは、.git/config の読みに戻す
			const result = await raceTimeout(host.channel.call<IParadisWorktreeGitCommandResult>('runGit', [host.path(folder), ['remote', 'get-url', 'origin']]), ORIGIN_READ_TIMEOUT_MS);
			return result?.code === 0 ? result.stdout.trim() || undefined : undefined;
		};
		const storedMode = tasksStorage.get(STORAGE_MODE, StorageScope.WORKSPACE);
		this.mode = storedMode === 'pr' || storedMode === 'project' ? storedMode : 'issue';
		for (const mode of ['issue', 'pr'] as const) {
			this.queries.set(mode, tasksStorage.get(STORAGE_QUERY(mode), StorageScope.WORKSPACE) ?? PARADIS_TASKS_PRESETS[mode][0].query);
		}
		this.queries.set('project', tasksStorage.get(STORAGE_QUERY('project'), StorageScope.WORKSPACE) ?? '');
		try {
			const raw: unknown = JSON.parse(tasksStorage.get(STORAGE_PROJECT, StorageScope.WORKSPACE) ?? 'null');
			const choice = raw as { owner?: unknown; number?: unknown; view?: unknown } | null;
			if (choice && typeof choice.owner === 'string' && typeof choice.number === 'number' && typeof choice.view === 'number') {
				this.projectChoice = { owner: choice.owner, number: choice.number, view: choice.view };
			}
		} catch {
			this.projectChoice = undefined;
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
		this.root = dom.append(parent, $('.paradis-tasks.paradis-focus-none'));
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
		for (const mode of ['issue', 'pr', 'project'] as const) {
			const label = mode === 'issue' ? 'Issue' : mode === 'pr' ? 'PR' : localize('paradis.tasks.mode.project', "プロジェクト");
			const button = this.button(modeRow, label, () => this.setMode(mode), 'paradis-tasks-pill');
			this.modeButtons.set(mode, button);
		}
		this.repoButton = this.button(modeRow, '', () => void this.pickRepositories(), 'paradis-tasks-combo');
		this.externalButton = this.iconButton(modeRow, Codicon.linkExternal, localize('paradis.tasks.openRepository', "GitHub で開く"), () => this.openRepositoryOnGithub());

		const panel = dom.append(this.root, $('.paradis-tasks-panel'));
		this.presetBar = dom.append(panel, $('.paradis-tasks-row.paradis-tasks-presets'));
		this.projectRow = dom.append(panel, $('.paradis-tasks-row'));
		this.projectButton = this.button(this.projectRow, '', () => void this.pickProject(), 'paradis-tasks-combo');
		const searchRow = dom.append(panel, $('.paradis-tasks-row'));
		this.filterButton = this.button(searchRow, localize('paradis.tasks.filter', "フィルター"), () => this.showFilterMenu(), 'paradis-tasks-pill', Codicon.filter);
		const search = dom.append(searchRow, $('.paradis-tasks-search.paradis-focus-subtle-within'));
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
		this.newButton = this.iconButton(searchRow, Codicon.add, localize('paradis.tasks.newItem', "GitHub で新しく作る"), () => void this.openNewOnGithub());
		this.iconButton(searchRow, Codicon.refresh, localize('paradis.tasks.refresh', "更新"), () => void this.load(true));

		this.statusLine = dom.append(panel, $('.paradis-tasks-status'));
		const table = this.searchTable = dom.append(panel, $('table.paradis-tasks-table'));
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
		this.projectHost = dom.append(panel, $('.paradis-tasks-project'));
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
		const repositories = await paradisTasksResolveRepositories(this.fileService, sources, this.readOrigin);
		if (generation !== this.repositoryGeneration) {
			return;
		}
		const before = this.activeRepositories.join(',');
		this.repositories = repositories;
		if (before !== this.activeRepositories.join(',')) {
			// 読むリポジトリが変わったら、プロジェクトの一覧も読み直す
			this.projects = undefined;
		}
		this.render();
		if (before !== this.activeRepositories.join(',') || this.items.length === 0) {
			void this.load(false);
		}
	}

	private setMode(mode: ParadisTasksTab): void {
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
		this.projectResult = undefined;
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
		if (this.mode === 'project') {
			await this.loadProject(force, more);
			return;
		}
		const mode = this.mode;
		if (more && (!this.hasNextPage || this.loading)) {
			return;
		}
		const generation = more ? this.generation : ++this.generation;
		this.loading = true;
		this.render();
		const response = await this.github.search({ mode, repositories, query: this.query, after: more ? this.endCursor : undefined, force });
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

		dom.clearNode(this.presetBar);
		this.presetDisposables.clear();
		const project = this.mode === 'project';
		if (this.mode !== 'project') {
			const mode = this.mode;
			for (const preset of PARADIS_TASKS_PRESETS[mode]) {
				const button = this.button(this.presetBar, presetLabel(mode, preset.id), () => this.setQuery(preset.query), 'paradis-tasks-pill', undefined, this.presetDisposables);
				button.classList.toggle('on', preset.query === this.query);
			}
		}
		this.presetBar.style.display = project ? 'none' : '';
		this.projectRow.style.display = project ? '' : 'none';
		this.filterButton.style.display = project ? 'none' : '';
		this.newButton.style.display = project ? 'none' : '';
		this.searchTable.style.display = project ? 'none' : '';
		this.projectHost.style.display = project ? '' : 'none';
		this.externalButton.disabled = project ? !this.selectedProject : active.length !== 1;
		const view = this.selectedView;
		this.setButtonLabel(this.projectButton, this.selectedProject
			? `${this.selectedProject.title}${view ? ` / ${view.name}` : ''}`
			: localize('paradis.tasks.chooseProject', "プロジェクトを選ぶ"), Codicon.chevronDown);
		this.projectButton.disabled = this.projectsLoading && !this.projects;
		if (this.searchInput && dom.getActiveElement() !== this.searchInput) {
			this.searchInput.value = this.query;
		}
		this.searchInput.placeholder = project
			? (view?.filter ? view.filter : localize('paradis.tasks.projectFilterPlaceholder', "絞り込み（例: status:Todo assignee:@me）"))
			: this.mode === 'pr' ? 'is:pr is:open' : 'is:issue is:open';

		this.renderStatus();
		this.renderRows();
	}

	private renderStatus(): void {
		const parts: string[] = [];
		if (this.loading) {
			parts.push(localize('paradis.tasks.loading', "読み込んでいます"));
		} else if (this.mode === 'project' && this.projectResult && !this.error) {
			parts.push(localize('paradis.tasks.count', "{0} 件", this.projectResult.total));
			parts.push(this.layoutLabel(this.projectResult.view));
			parts.push(localize('paradis.tasks.fetchedAt', "取得 {0}", new Date(this.projectResult.fetchedAt).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' })));
		} else if (this.mode !== 'project' && this.fetchedAt !== undefined && !this.error) {
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
		dom.clearNode(this.projectHost);
		dom.clearNode(this.emptyState);
		this.rowDisposables.clear();
		const empty = this.mode === 'project' ? this.projectEmptyMessage() : this.emptyMessage();
		this.emptyState.style.display = empty ? '' : 'none';
		const hasNextPage = this.mode === 'project' ? this.projectResult?.hasNextPage === true : this.hasNextPage;
		this.moreButton.style.display = !empty && hasNextPage ? '' : 'none';
		this.moreButton.disabled = this.loading;
		if (empty) {
			dom.append(this.emptyState, $('.paradis-tasks-empty-title')).textContent = empty.title;
			dom.append(this.emptyState, $('.paradis-tasks-empty-body')).textContent = empty.body;
			return;
		}
		if (this.mode === 'project' && this.projectResult) {
			const host = { openItem: (item: IParadisTasksProjectItem) => this.openProjectItem(item), showItemMenu: (item: IParadisTasksProjectItem, anchor: HTMLElement) => this.showProjectItemMenu(item, anchor) };
			if (this.projectResult.view.layout === 'BOARD_LAYOUT') {
				paradisTasksRenderProjectBoard(this.projectHost, this.projectResult, this.rowDisposables, host);
			} else {
				const today = new Date();
				const todayIso = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}-${String(today.getDate()).padStart(2, '0')}`;
				if (this.projectResult.view.layout === 'ROADMAP_LAYOUT' && paradisTasksRenderProjectRoadmap(this.projectHost, this.projectResult, this.rowDisposables, host, todayIso)) {
					return;
				}
				if (this.projectResult.view.layout === 'ROADMAP_LAYOUT') {
					dom.append(this.projectHost, $('.paradis-tasks-note')).textContent = localize('paradis.tasks.roadmapNoDates', "このビューには日付・繰り返しの欄が無いので、表で出しています。");
				}
				paradisTasksRenderProjectTable(this.projectHost, this.projectResult, this.rowDisposables, host);
			}
			return;
		}
		for (const item of this.items) {
			this.renderRow(item);
		}
	}

	private emptyMessage(): { readonly title: string; readonly body: string } | undefined {
		const noSource = this.noSourceMessage();
		if (noSource) {
			return noSource;
		}
		if (this.error) {
			return this.errorMessage(this.error);
		}
		if (!this.repositories || (this.loading && this.items.length === 0)) {
			return { title: localize('paradis.tasks.loadingTitle', "読み込んでいます"), body: '' };
		}
		return this.items.length === 0 && this.fetchedAt !== undefined ? this.noResultMessage() : undefined;
	}

	private projectEmptyMessage(): { readonly title: string; readonly body: string } | undefined {
		const noSource = this.noSourceMessage();
		if (noSource) {
			return noSource;
		}
		if (this.projectsError && !this.projects) {
			return this.errorMessage(this.projectsError);
		}
		if (!this.repositories || (this.projectsLoading && !this.projects)) {
			return { title: localize('paradis.tasks.loadingTitle', "読み込んでいます"), body: '' };
		}
		if (this.projects && this.projects.length === 0) {
			return {
				title: localize('paradis.tasks.empty.noProjects', "プロジェクトがありません"),
				body: localize('paradis.tasks.empty.noProjectsBody', "選んだリポジトリにつながったプロジェクト、その持ち主のプロジェクト、自分のプロジェクトのどれもありませんでした。"),
			};
		}
		if (!this.selectedProject || !this.selectedView) {
			return { title: localize('paradis.tasks.empty.chooseProject', "プロジェクトを選んでください"), body: localize('paradis.tasks.empty.chooseProjectBody', "上の「プロジェクトを選ぶ」から、プロジェクトとビューを選びます。") };
		}
		if (this.error) {
			return this.errorMessage(this.error);
		}
		if (!this.projectResult) {
			return { title: localize('paradis.tasks.loadingTitle', "読み込んでいます"), body: '' };
		}
		return this.projectResult.items.length === 0 ? this.noResultMessage() : undefined;
	}

	private noSourceMessage(): { readonly title: string; readonly body: string } | undefined {
		if (this.repositories && this.activeRepositories.length === 0) {
			return {
				title: localize('paradis.tasks.empty.noSource', "リポジトリのソースが選択されていません"),
				body: this.repositories.length === 0
					? localize('paradis.tasks.empty.noSourceBody', "タスクは、このウィンドウで開いているリポジトリのうち、GitHub（github.com）の origin を持つものから読みます。そのようなリポジトリを開いてください。")
					: localize('paradis.tasks.empty.noneSelectedBody', "上のリポジトリの選択から、1 つ以上を選んでください。"),
			};
		}
		return undefined;
	}

	private errorMessage(error: IParadisTasksError): { readonly title: string; readonly body: string } {
		switch (error.kind) {
			case 'no-gh':
				return { title: localize('paradis.tasks.error.noGh', "GitHub CLI（gh）が見つかりません"), body: localize('paradis.tasks.error.noGhBody', "gh を入れて、ターミナルで `gh auth login` を実行してください。") };
			case 'auth':
				return { title: localize('paradis.tasks.error.auth', "gh が GitHub にログインしていません"), body: localize('paradis.tasks.error.authBody', "ターミナルで `gh auth login` を実行してから、更新を押してください。") };
			case 'scope':
				return { title: localize('paradis.tasks.error.scope', "gh に GitHub のプロジェクトを読む権限がありません"), body: localize('paradis.tasks.error.scopeBody', "ターミナルで `gh auth refresh -s read:project` を実行してから、更新を押してください。") };
			case 'rate-limited':
				return {
					title: localize('paradis.tasks.error.rateLimited', "GitHub の API の上限に達しました"),
					body: error.retryAt
						? localize('paradis.tasks.error.rateLimitedAt', "{0} ごろに読み直せます。", new Date(error.retryAt).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' }))
						: localize('paradis.tasks.error.rateLimitedLater', "しばらくしてから更新を押してください。"),
				};
			case 'timeout':
				return { title: localize('paradis.tasks.error.timeout', "GitHub からの応答が時間内に返りませんでした"), body: localize('paradis.tasks.error.timeoutBody', "gh が 30 秒たっても答えなかったので止めました。ネットワークを確かめて、更新を押してください。") };
			default:
				return { title: localize('paradis.tasks.error.failed', "読み込めませんでした"), body: error.message };
		}
	}

	private noResultMessage(): { readonly title: string; readonly body: string } {
		return {
			title: localize('paradis.tasks.empty.noResult', "当てはまるものはありません"),
			// SSH の窓では、リポジトリは接続先のものでも GitHub は手元の gh のアカウントで読むので、読めない非公開リポジトリは 0 件に見える
			body: this.environmentService.remoteAuthority !== undefined
				? localize('paradis.tasks.empty.noResultRemoteBody', "検索の文字列やフィルターを変えてみてください。この PC の gh のアカウントで読める範囲だけを出しています。")
				: localize('paradis.tasks.empty.noResultBody', "検索の文字列やフィルターを変えてみてください。"),
		};
	}

	private get selectedProject(): IParadisTasksProject | undefined {
		const choice = this.projectChoice;
		return choice ? this.projects?.find(project => project.owner.toLowerCase() === choice.owner.toLowerCase() && project.number === choice.number) : undefined;
	}

	private get selectedView(): IParadisTasksProjectView | undefined {
		const choice = this.projectChoice;
		return choice ? this.selectedProject?.views.find(view => view.number === choice.view) : undefined;
	}

	private layoutLabel(view: IParadisTasksProjectView): string {
		switch (view.layout) {
			case 'BOARD_LAYOUT': return localize('paradis.tasks.layout.board', "ボード");
			case 'ROADMAP_LAYOUT': return localize('paradis.tasks.layout.roadmap', "ロードマップ");
			default: return localize('paradis.tasks.layout.table', "テーブル");
		}
	}

	/** プロジェクトの一覧を読む（5 分は shared process のキャッシュが答える）。 */
	private async loadProjects(force: boolean): Promise<void> {
		const repositories = this.activeRepositories;
		const generation = ++this.projectsGeneration;
		this.projectsLoading = true;
		this.render();
		const response = await this.github.listProjects({ repositories, force });
		if (generation !== this.projectsGeneration) {
			return;
		}
		this.projectsLoading = false;
		if (response.ok) {
			this.projects = response.result.projects;
			this.projectsError = undefined;
			this.remaining = response.result.rateLimit ?? this.remaining;
		} else {
			this.projectsError = response.error;
		}
	}

	/** 選んだビューの項目を読む。プロジェクトの一覧がまだなら先に読む。 */
	private async loadProject(force: boolean, more: boolean): Promise<void> {
		if (!this.projects || force) {
			await this.loadProjects(force);
		}
		const project = this.selectedProject;
		const view = this.selectedView;
		if (!project || !view) {
			this.render();
			return;
		}
		if (more && (!this.projectResult?.hasNextPage || this.loading)) {
			return;
		}
		const generation = more ? this.generation : ++this.generation;
		this.loading = true;
		this.render();
		const response = await this.github.projectItems({
			owner: project.owner, number: project.number, view: view.number, viewFilter: view.filter, query: this.query,
			after: more ? this.projectResult?.endCursor : undefined, force,
		});
		if (generation !== this.generation) {
			return;
		}
		this.loading = false;
		if (response.ok) {
			this.projectResult = more && this.projectResult
				? { ...response.result, items: [...this.projectResult.items, ...response.result.items] }
				: response.result;
			this.remaining = response.result.rateLimit ?? this.remaining;
			this.error = undefined;
		} else {
			this.error = response.error;
		}
		this.render();
	}

	/** プロジェクト → ビューの順に選ぶ。ビューの選択から戻るとプロジェクトの選択に戻る。 */
	private async pickProject(): Promise<void> {
		if (!this.projects) {
			await this.loadProjects(false);
			this.render();
		}
		const projects = this.projects ?? [];
		while (true) {
			const projectItems: (IQuickPickItem & { readonly project: IParadisTasksProject })[] = projects.map(project => ({
				label: project.title,
				description: `${project.owner} #${project.number}${project.closed ? ` · ${localize('paradis.tasks.projectClosed', "クローズ")}` : ''}`,
				project,
			}));
			const picked = await this.quickInputService.pick(projectItems, { placeHolder: localize('paradis.tasks.pickProject', "プロジェクトを選んでください") });
			if (!picked) {
				return;
			}
			const back = { label: `$(arrow-left) ${localize('paradis.tasks.back', "戻る")}`, back: true as const };
			const viewItems: (IQuickPickItem & { readonly view?: IParadisTasksProjectView; readonly back?: true })[] = [
				back,
				...picked.project.views.map(view => ({ label: view.name, description: this.layoutLabel(view), detail: view.filter, view })),
			];
			const view = await this.quickInputService.pick(viewItems, { placeHolder: localize('paradis.tasks.pickView', "ビューを選んでください（{0}）", picked.project.title) });
			if (!view) {
				return;
			}
			if (view.view) {
				this.projectChoice = { owner: picked.project.owner, number: picked.project.number, view: view.view.number };
				this.tasksStorage.store(STORAGE_PROJECT, JSON.stringify(this.projectChoice), StorageScope.WORKSPACE, StorageTarget.USER);
				this.resetItems();
				this.render();
				void this.load(false);
				return;
			}
		}
	}

	/** 開いている Issue の行に出す「タスクボードへ」の操作（PR・下書き・閉じた Issue には出さない）。 */
	private boardActions(repository: string | undefined, number: number | undefined): IAction[] {
		if (!repository || !number) {
			return [];
		}
		return [
			toAction({ id: 'paradis.tasks.addToBoard', label: localize('paradis.tasks.addToBoard', "タスクボードの未着手に載せる"), run: () => this.addToBoard(repository, number, false) }),
			toAction({ id: 'paradis.tasks.addToBoardAndStart', label: localize('paradis.tasks.addToBoardAndStart', "タスクボードに載せて着手する..."), run: () => this.addToBoard(repository, number, true) }),
			new Separator(),
		];
	}

	/**
	 * Issue をタスクボードの未着手に載せる。ボードが動いていなければ、この窓のスペースでボードを開いて（接続口の確認を含む）
	 * から載せる。`start` なら載せたタスクをボードの窓で開く（エージェントと最初の指示はボードの着手の画面で選ぶ）。
	 */
	private async addToBoard(repository: string, number: number, start: boolean): Promise<void> {
		const [owner, repo] = repository.split('/');
		const request = { issues: [{ owner, repo, number }] };
		let result = await this.taskBoardHost.addIssues(request, start);
		if (!result.ok && result.reason === 'not-running') {
			await this.commandService.executeCommand(PARADIS_TASK_BOARD_OPEN_COMMAND_ID);
			result = await this.taskBoardHost.addIssues(request, start);
		}
		if (result.ok) {
			if (result.taskIds.length === 0 || result.missing > 0) {
				this.notificationService.warn(localize('paradis.tasks.addToBoard.missing', "#{0} は載せられませんでした（閉じているか、読めませんでした）。ボードはこの PC の gh のアカウントで読める範囲の Issue だけを載せられます。", number));
				return;
			}
			if (!start) {
				this.notificationService.prompt(Severity.Info, localize('paradis.tasks.addToBoard.done', "#{0} をタスクボードの未着手に載せました。", number), [{
					label: localize('paradis.tasks.openTaskBoard', "タスクボードを開く"),
					run: () => void this.commandService.executeCommand(PARADIS_TASK_BOARD_OPEN_COMMAND_ID),
				}]);
			}
			return;
		}
		switch (result.reason) {
			case 'not-running':
				// ボードを開かなかった（接続口の確認をやめた・フォルダが無い等）。開く処理が理由を出している
				return;
			case 'other-repo':
				this.notificationService.warn(localize('paradis.tasks.addToBoard.otherRepo', "タスクボードは {0} の台帳で動いています。{1} の Issue を載せるには、ボードの上のメニューで {1} に切り替えてください。", result.repo ?? '', repository));
				return;
			case 'no-github':
				this.notificationService.warn(localize('paradis.tasks.addToBoard.noGithub', "タスクボードが GitHub につながっていないので、Issue を載せられません。"));
				return;
			default:
				this.notificationService.error(localize('paradis.tasks.addToBoard.failed', "タスクボードに載せられませんでした: {0}", result.message ?? ''));
		}
	}

	private openProjectItem(item: IParadisTasksProjectItem): void {
		if (item.url) {
			void this.openerService.open(URI.parse(item.url), { openExternal: true });
		}
	}

	private showProjectItemMenu(item: IParadisTasksProjectItem, anchor: HTMLElement): void {
		const url = item.url;
		this.contextMenuService.showContextMenu({
			getAnchor: () => anchor,
			getActions: () => url ? [
				...this.boardActions(item.kind === 'issue' && item.state === 'OPEN' ? item.repository : undefined, item.number),
				toAction({ id: 'paradis.tasks.openOnGithub', label: localize('paradis.tasks.openOnGithub', "GitHub で開く"), run: () => this.openProjectItem(item) }),
				toAction({ id: 'paradis.tasks.copyUrl', label: localize('paradis.tasks.copyUrl', "URL をコピー"), run: () => this.clipboardService.writeText(url) }),
			] : [
				toAction({ id: 'paradis.tasks.openProject', label: localize('paradis.tasks.openProjectOnGithub', "プロジェクトを GitHub で開く"), run: () => this.openRepositoryOnGithub() }),
			],
		});
	}

	private renderRow(item: IParadisTasksItem): void {
		const row = dom.append(this.tableBody, $('tr.paradis-tasks-item.paradis-focus-subtle'));
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
			// ラベルの色は 16 進 6 桁に揃えてある（取得の口で確かめる）。枠だけ 55% の濃さで塗る
			chip.style.borderColor = `#${label.color}8c`;
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
		if (item.kind === 'issue' && item.state === 'OPEN') {
			this.iconButton(actions, Codicon.add, localize('paradis.tasks.addToBoard', "タスクボードの未着手に載せる"), () => void this.addToBoard(item.repository, item.number, false), '', this.rowDisposables);
		}
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
				...this.boardActions(item.kind === 'issue' && item.state === 'OPEN' ? item.repository : undefined, item.number),
				toAction({ id: 'paradis.tasks.openOnGithub', label: localize('paradis.tasks.openOnGithub', "GitHub で開く"), run: () => this.openItem(item) }),
				toAction({ id: 'paradis.tasks.copyUrl', label: localize('paradis.tasks.copyUrl', "URL をコピー"), run: () => this.clipboardService.writeText(item.url) }),
			],
		});
	}

	private showFilterMenu(): void {
		this.contextMenuService.showContextMenu({
			getAnchor: () => this.filterButton,
			getActions: () => filterEntries().filter(entry => this.mode !== 'project' && entry.modes.includes(this.mode)).map(entry => toAction({
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
		this.projects = undefined;
		this.tasksStorage.store(STORAGE_SELECTED, JSON.stringify(this.selected), StorageScope.WORKSPACE, StorageTarget.USER);
		this.resetItems();
		this.render();
		void this.load(false);
	}

	private openRepositoryOnGithub(): void {
		const project = this.selectedProject;
		if (this.mode === 'project') {
			if (project?.url.startsWith('https://github.com/')) {
				const view = this.selectedView;
				void this.openerService.open(URI.parse(view ? `${project.url}/views/${view.number}` : project.url), { openExternal: true });
			}
			return;
		}
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
