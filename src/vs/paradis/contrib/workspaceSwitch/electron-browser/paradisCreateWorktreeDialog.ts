/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-PATCH/PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

// 「新しいスペース（worktree）を作成」ダイアログ（Superset の New Workspace モーダル相当）。
// 自然言語プロンプト＋エージェント選択＋ベースブランチ選択から、
//   1. git worktree add -b <branch>（shared process の paradisWorktreeGitChannel 経由）
//   2. ブランチ名の自動命名（手入力 > Copilot 小型モデル > 決定的フォールバック）
//   3. 新スペースへの切り替え（IParadisWorkspaceSwitchService.switchToWorktree）
//   4. エージェントCLI をエディタ領域ターミナルで起動（プロンプトを初期引数として渡す）
// までを一括で行う。プロンプト未入力・エージェント「なし」なら純粋な worktree 作成として動く。

import './media/paradisCreateWorktreeDialog.css';
import * as dom from '../../../../base/browser/dom.js';
import { raceTimeout } from '../../../../base/common/async.js';
import { CancellationTokenSource } from '../../../../base/common/cancellation.js';
import { toErrorMessage } from '../../../../base/common/errorMessage.js';
import { Disposable } from '../../../../base/common/lifecycle.js';
import { basename, dirname, joinPath } from '../../../../base/common/resources.js';
import { URI } from '../../../../base/common/uri.js';
import { localize } from '../../../../nls.js';
import { IConfigurationService } from '../../../../platform/configuration/common/configuration.js';
import { IInstantiationService, ServicesAccessor } from '../../../../platform/instantiation/common/instantiation.js';
import { ISharedProcessService } from '../../../../platform/ipc/electron-browser/services.js';
import { ILayoutService } from '../../../../platform/layout/browser/layoutService.js';
import { ILogService } from '../../../../platform/log/common/log.js';
import { INotificationService } from '../../../../platform/notification/common/notification.js';
import { IStorageService, StorageScope, StorageTarget } from '../../../../platform/storage/common/storage.js';
import { TerminalLocation } from '../../../../platform/terminal/common/terminal.js';
import { ChatMessageRole, getTextResponseFromStream, ILanguageModelsService } from '../../../../workbench/contrib/chat/common/languageModels.js';
import { paradisRunAutoRunPresets } from '../../terminalPresets/browser/paradisTerminalPresets.contribution.js';
import { paradisRunWorkspaceLifecycleScript } from './paradisWorkspaceLifecycleService.js';
import { ITerminalService } from '../../../../workbench/contrib/terminal/browser/terminal.js';
import { editorGroupToColumn } from '../../../../workbench/services/editor/common/editorGroupColumn.js';
import { IEditorGroupsService } from '../../../../workbench/services/editor/common/editorGroupsService.js';
import { IParadisTerminalScopeService, IParadisWorkspaceRepository, IParadisWorkspaceSwitchService, IParadisWorktreeService, paradisWorktreeStateKey } from '../common/paradisWorkspaceSwitch.js';
import {
	IParadisAgentCommandTemplate,
	IParadisGitBranches,
	PARADIS_DEFAULT_AGENT_COMMANDS,
	PARADIS_WORKTREE_GIT_CHANNEL,
	paradisBuildAgentCommand,
	paradisBuildWorktreeNames,
	paradisDeduplicateBranchName,
	paradisDeduplicateWorktreeDirName,
	paradisSanitizeBranchName,
	paradisShouldCreateDefaultTerminal,
} from '../common/paradisWorktreeCreate.js';

const $ = dom.$;

/** worktree 作成後に行う一連のアクション（順序・失敗時の打ち切りをテストしやすいよう分離）。 */
export interface IParadisCreatedWorktreeActions {
	/** リポジトリ定義の setupScript を実行する。失敗したら後続を一切実行しない。 */
	runSetup(): Promise<void>;
	/** 自動実行プリセットを起動する。何か起動したら true を返す。 */
	runAutoRun(): Promise<boolean>;
	/** runAutoRun が何も起動しなかった場合のみ呼ばれる。 */
	openDefaultTerminal(): Promise<void>;
	/** エージェント CLI を起動する。 */
	launchAgent(): Promise<void>;
}

/** setup → 自動実行プリセット（無ければ既定ターミナル） → エージェント起動、の順で実行する。 */
export async function paradisCompleteCreatedWorktree(actions: IParadisCreatedWorktreeActions): Promise<void> {
	await actions.runSetup();
	const autoRunExecuted = await actions.runAutoRun();
	if (!autoRunExecuted) {
		await actions.openDefaultTerminal();
	}
	await actions.launchAgent();
}

// allow-any-unicode-next-line
const STR_TITLE = localize('paradis.createWorktree.title', "新しいスペース（worktree）を作成");
// allow-any-unicode-next-line
const STR_NAME_PLACEHOLDER = localize('paradis.createWorktree.namePlaceholder', "スペース名（表示名・任意）");
// allow-any-unicode-next-line
const STR_BRANCH_PLACEHOLDER = localize('paradis.createWorktree.branchPlaceholder', "ブランチ名（任意）");
// allow-any-unicode-next-line
const STR_PROMPT_PLACEHOLDER = localize('paradis.createWorktree.promptPlaceholder', "何をしますか？（任意 — エージェントへの指示。ブランチ名の自動生成にも使われます）");
// allow-any-unicode-next-line
const STR_AGENT_LABEL = localize('paradis.createWorktree.agentLabel', "エージェント");
// allow-any-unicode-next-line
const STR_AGENT_NONE = localize('paradis.createWorktree.agentNone', "実行しない");
// allow-any-unicode-next-line
const STR_BASE_REPO_LABEL = localize('paradis.createWorktree.baseRepoLabel', "リポジトリ");
// allow-any-unicode-next-line
const STR_BASE_BRANCH_LABEL = localize('paradis.createWorktree.baseBranchLabel', "ベースブランチ");
// allow-any-unicode-next-line
const STR_BRANCHES_LOADING = localize('paradis.createWorktree.branchesLoading', "読み込み中…");
// allow-any-unicode-next-line
const STR_CANCEL = localize('paradis.createWorktree.cancel', "キャンセル");
// allow-any-unicode-next-line
const STR_CREATE = localize('paradis.createWorktree.create', "作成 (⌘⏎)");
// allow-any-unicode-next-line
const STR_CREATING = localize('paradis.createWorktree.creating', "作成中…");
// allow-any-unicode-next-line
const STR_NAMING = localize('paradis.createWorktree.naming', "ブランチ名を生成中…");
// allow-any-unicode-next-line
const STR_NO_BRANCHES = localize('paradis.createWorktree.noBranches', "ブランチを取得できませんでした");
// allow-any-unicode-next-line
const STR_AUTO = localize('paradis.createWorktree.autoName', "(自動生成)");
/** LLM 命名の待ち時間上限。Superset の 5 秒に合わせつつ余裕を持たせる。 */
const NAMING_TIMEOUT_MS = 8000;
/** 前回選択したエージェント id の保存キー（StorageScope.PROFILE）。 */
const STORAGE_KEY_LAST_AGENT = 'paradis.workspaceSwitch.lastSelectedAgent';

export function openParadisCreateWorktreeDialog(accessor: ServicesAccessor, preselectedRepositoryId?: string): void {
	const dialog = new ParadisCreateWorktreeDialog(
		accessor.get(ILayoutService),
		accessor.get(ISharedProcessService),
		accessor.get(IParadisWorkspaceSwitchService),
		accessor.get(IParadisWorktreeService),
		accessor.get(IConfigurationService),
		accessor.get(ITerminalService),
		accessor.get(IEditorGroupsService),
		accessor.get(ILanguageModelsService),
		accessor.get(ILogService),
		accessor.get(INotificationService),
		accessor.get(IInstantiationService),
		accessor.get(IParadisTerminalScopeService),
		accessor.get(IStorageService),
		preselectedRepositoryId,
	);
	// ダイアログは自身の close で自己 dispose する
	void dialog;
}

class ParadisCreateWorktreeDialog extends Disposable {

	private readonly _backdrop: HTMLElement;
	private readonly _dialog: HTMLElement;

	private _nameInput!: HTMLInputElement;
	private _branchInput!: HTMLInputElement;
	private _promptInput!: HTMLTextAreaElement;
	private _agentSelect!: HTMLSelectElement;
	private _repoSelect!: HTMLSelectElement;
	private _branchSelect!: HTMLSelectElement;
	private _pathPreview!: HTMLElement;
	private _errorEl!: HTMLElement;
	private _createBtn!: HTMLButtonElement;
	private _cancelBtn!: HTMLButtonElement;

	private _branches: IParadisGitBranches | undefined;
	private _busy = false;

	constructor(
		layoutService: ILayoutService,
		private readonly sharedProcessService: ISharedProcessService,
		private readonly switchService: IParadisWorkspaceSwitchService,
		private readonly worktreeService: IParadisWorktreeService,
		private readonly configurationService: IConfigurationService,
		private readonly terminalService: ITerminalService,
		private readonly editorGroupsService: IEditorGroupsService,
		private readonly languageModelsService: ILanguageModelsService,
		private readonly logService: ILogService,
		private readonly notificationService: INotificationService,
		private readonly instantiationService: IInstantiationService,
		private readonly terminalScopeService: IParadisTerminalScopeService,
		private readonly storageService: IStorageService,
		preselectedRepositoryId: string | undefined,
	) {
		super();

		this._backdrop = $('.paradis-create-worktree-backdrop');
		this._dialog = $('.paradis-create-worktree-dialog');
		this._backdrop.appendChild(this._dialog);

		this._register(dom.addDisposableListener(this._backdrop, 'mousedown', e => {
			if (e.target === this._backdrop && !this._busy) {
				this.dispose();
			}
		}));
		this._register(dom.addDisposableListener(this._backdrop, 'keydown', e => {
			if (e.key === 'Escape' && !this._busy) {
				e.preventDefault();
				this.dispose();
			} else if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
				e.preventDefault();
				void this._doCreate();
			}
		}));

		layoutService.activeContainer.appendChild(this._backdrop);
		this._renderForm(preselectedRepositoryId);
	}

	override dispose(): void {
		this._backdrop.remove();
		super.dispose();
	}

	private get _agents(): readonly IParadisAgentCommandTemplate[] {
		const configured = this.configurationService.getValue<IParadisAgentCommandTemplate[]>('paradis.workspaceSwitch.agents');
		if (Array.isArray(configured) && configured.length > 0) {
			// 'none' は「実行しない」を表す予約識別子（_agentSelect の固定オプション）のため、
			// 設定で誤って同じ id が指定されても既定端末とエージェント端末の二重起動を避けるため除外する
			return configured.filter(agent => agent && typeof agent.id === 'string' && agent.id !== 'none' && typeof agent.command === 'string');
		}
		return PARADIS_DEFAULT_AGENT_COMMANDS;
	}

	private get _selectedRepository(): IParadisWorkspaceRepository | undefined {
		return this.switchService.repositories.find(repository => repository.id === this._repoSelect.value);
	}

	private _renderForm(preselectedRepositoryId: string | undefined): void {
		dom.clearNode(this._dialog);

		dom.append(this._dialog, $('h3.pcw-title')).textContent = STR_TITLE;

		// スペース名 + ブランチ名
		const nameRow = dom.append(this._dialog, $('.pcw-row'));
		this._nameInput = dom.append(nameRow, $('input.pcw-input.pcw-name')) as HTMLInputElement;
		this._nameInput.type = 'text';
		this._nameInput.placeholder = STR_NAME_PLACEHOLDER;
		this._branchInput = dom.append(nameRow, $('input.pcw-input.pcw-branch')) as HTMLInputElement;
		this._branchInput.type = 'text';
		this._branchInput.placeholder = STR_BRANCH_PLACEHOLDER;
		this._branchInput.spellcheck = false;

		// 自然言語プロンプト
		this._promptInput = dom.append(this._dialog, $('textarea.pcw-prompt')) as HTMLTextAreaElement;
		this._promptInput.rows = 3;
		this._promptInput.placeholder = STR_PROMPT_PLACEHOLDER;

		// エージェント選択
		const agentRow = dom.append(this._dialog, $('.pcw-row.pcw-field-row'));
		dom.append(agentRow, $('label.pcw-label')).textContent = STR_AGENT_LABEL;
		this._agentSelect = dom.append(agentRow, $('select.pcw-select')) as HTMLSelectElement;
		const noneOption = dom.append(this._agentSelect, $('option')) as HTMLOptionElement;
		noneOption.value = 'none';
		noneOption.textContent = STR_AGENT_NONE;
		for (const agent of this._agents) {
			const option = dom.append(this._agentSelect, $('option')) as HTMLOptionElement;
			option.value = agent.id;
			option.textContent = agent.label ?? agent.id;
		}
		// 前回選択したエージェントを復元する。保存値が現在の選択肢に無い場合
		// （設定から削除された等）は既定の「実行しない」のままにする
		const lastAgentId = this.storageService.get(STORAGE_KEY_LAST_AGENT, StorageScope.PROFILE);
		if (lastAgentId && (lastAgentId === 'none' || this._agents.some(agent => agent.id === lastAgentId))) {
			this._agentSelect.value = lastAgentId;
		}

		// ベースリポジトリ + ベースブランチ
		const baseRow = dom.append(this._dialog, $('.pcw-row.pcw-field-row'));
		dom.append(baseRow, $('label.pcw-label')).textContent = STR_BASE_REPO_LABEL;
		this._repoSelect = dom.append(baseRow, $('select.pcw-select')) as HTMLSelectElement;
		for (const repository of this.switchService.repositories) {
			const option = dom.append(this._repoSelect, $('option')) as HTMLOptionElement;
			option.value = repository.id;
			option.textContent = repository.name;
		}
		const initialRepoId = preselectedRepositoryId ?? this.switchService.activeRepository?.id;
		if (initialRepoId && this.switchService.repositories.some(repository => repository.id === initialRepoId)) {
			this._repoSelect.value = initialRepoId;
		}
		dom.append(baseRow, $('label.pcw-label')).textContent = STR_BASE_BRANCH_LABEL;
		this._branchSelect = dom.append(baseRow, $('select.pcw-select.pcw-branch-select')) as HTMLSelectElement;

		// 作成先パスのプレビュー
		this._pathPreview = dom.append(this._dialog, $('.pcw-path-preview'));

		this._errorEl = dom.append(this._dialog, $('.pcw-error'));

		const footer = dom.append(this._dialog, $('.pcw-footer'));
		this._cancelBtn = dom.append(footer, $('button.pcw-btn')) as HTMLButtonElement;
		this._cancelBtn.textContent = STR_CANCEL;
		this._register(dom.addDisposableListener(this._cancelBtn, 'click', () => this.dispose()));
		this._createBtn = dom.append(footer, $('button.pcw-btn.pcw-btn-primary')) as HTMLButtonElement;
		this._createBtn.textContent = STR_CREATE;
		this._register(dom.addDisposableListener(this._createBtn, 'click', () => void this._doCreate()));

		this._register(dom.addDisposableListener(this._repoSelect, 'change', () => void this._loadBranches()));
		this._register(dom.addDisposableListener(this._branchInput, 'input', () => this._updatePathPreview()));

		void this._loadBranches();
		this._updatePathPreview();
		this._promptInput.focus();
	}

	private async _loadBranches(): Promise<void> {
		const repository = this._selectedRepository;
		dom.clearNode(this._branchSelect);
		this._branches = undefined;
		if (!repository) {
			return;
		}
		const loadingOption = dom.append(this._branchSelect, $('option')) as HTMLOptionElement;
		loadingOption.value = '';
		loadingOption.textContent = STR_BRANCHES_LOADING;
		try {
			const branches = await this.sharedProcessService.getChannel(PARADIS_WORKTREE_GIT_CHANNEL)
				.call<IParadisGitBranches>('listBranches', [repository.uri.fsPath]);
			if (this._store.isDisposed || this._selectedRepository?.id !== repository.id) {
				return;
			}
			this._branches = branches;
			dom.clearNode(this._branchSelect);
			for (const branch of branches.branches) {
				const option = dom.append(this._branchSelect, $('option')) as HTMLOptionElement;
				option.value = branch;
				option.textContent = branch;
			}
			if (branches.head && branches.branches.includes(branches.head)) {
				this._branchSelect.value = branches.head;
			}
			if (branches.branches.length === 0) {
				const emptyOption = dom.append(this._branchSelect, $('option')) as HTMLOptionElement;
				emptyOption.value = '';
				emptyOption.textContent = STR_NO_BRANCHES;
			}
		} catch (error) {
			if (this._store.isDisposed) {
				return;
			}
			dom.clearNode(this._branchSelect);
			const errorOption = dom.append(this._branchSelect, $('option')) as HTMLOptionElement;
			errorOption.value = '';
			errorOption.textContent = STR_NO_BRANCHES;
			this._showError(error);
		}
		this._updatePathPreview();
	}

	/** worktree の作成先ディレクトリを決める。設定 paradis.workspaceSwitch.worktreeRoot があればその配下。 */
	private _computeWorktreeUri(repository: IParadisWorkspaceRepository, dirName: string): URI {
		const configuredRoot = (this.configurationService.getValue<string>('paradis.workspaceSwitch.worktreeRoot') ?? '').trim();
		if (configuredRoot.length > 0) {
			return joinPath(URI.file(configuredRoot), basename(repository.uri), dirName);
		}
		return joinPath(dirname(repository.uri), `${basename(repository.uri)}-worktrees`, dirName);
	}

	private _updatePathPreview(): void {
		const repository = this._selectedRepository;
		if (!repository) {
			this._pathPreview.textContent = '';
			return;
		}
		const branch = paradisSanitizeBranchName(this._branchInput.value);
		const existingDirNames = this.worktreeService.getDetectedWorktrees(repository.id).map(worktree => basename(worktree.uri));
		const dirName = branch
			? paradisDeduplicateWorktreeDirName(branch, this._branches?.branches ?? [], existingDirNames)
			: STR_AUTO;
		this._pathPreview.textContent = this._computeWorktreeUri(repository, dirName).fsPath;
	}

	private _showError(error: unknown): void {
		this._errorEl.textContent = error instanceof Error ? error.message : String(error);
	}

	private _setBusy(busy: boolean, label?: string): void {
		this._busy = busy;
		for (const el of [this._nameInput, this._branchInput, this._promptInput, this._agentSelect, this._repoSelect, this._branchSelect, this._createBtn, this._cancelBtn]) {
			(el as HTMLInputElement | HTMLButtonElement).disabled = busy;
		}
		this._createBtn.textContent = busy ? (label ?? STR_CREATING) : STR_CREATE;
	}

	/** Copilot の小型モデルでプロンプトからブランチ名を生成する。使えなければ undefined。 */
	private async _generateBranchName(prompt: string): Promise<string | undefined> {
		try {
			const modelIds = await this.languageModelsService.selectLanguageModels({ vendor: 'copilot', id: 'copilot-utility-small' });
			if (modelIds.length === 0) {
				return undefined;
			}
			const cts = new CancellationTokenSource();
			try {
				const request = (async () => {
					const response = await this.languageModelsService.sendChatRequest(modelIds[0], undefined, [{
						role: ChatMessageRole.User,
						content: [{
							type: 'text',
							value: `Generate a git branch name for the following development task. Output ONLY the branch name: kebab-case, lowercase ascii letters/digits/hyphens, at most 30 characters, no quotes, no slashes.\n\nTask: ${prompt}`,
						}],
					}], {}, cts.token);
					return getTextResponseFromStream(response);
				})();
				const text = await raceTimeout(request, NAMING_TIMEOUT_MS, () => cts.cancel());
				const candidate = text?.trim().split('\n')[0].replace(/^["'`]+|["'`]+$/g, '').toLowerCase();
				// 40文字カットで末尾に - や . が残ると git が拒否するため、カット後にもう一度トリムする
				const sliced = candidate ? paradisSanitizeBranchName(candidate)?.slice(0, 40).replace(/[-./]+$/, '') : undefined;
				return sliced ? sliced : undefined;
			} finally {
				cts.dispose();
			}
		} catch (error) {
			this.logService.info('[ParadisCreateWorktree] LLM naming unavailable, falling back', error);
			return undefined;
		}
	}

	/** LLM が使えない場合の決定的なフォールバック名。 */
	private _fallbackBranchName(): string {
		const now = new Date();
		const pad = (value: number) => String(value).padStart(2, '0');
		return `para-${pad(now.getMonth() + 1)}${pad(now.getDate())}-${pad(now.getHours())}${pad(now.getMinutes())}`;
	}

	private async _doCreate(): Promise<void> {
		if (this._busy) {
			return;
		}
		const repository = this._selectedRepository;
		const baseRef = this._branchSelect.value;
		if (!repository || !baseRef) {
			return;
		}
		this._errorEl.textContent = '';

		const prompt = this._promptInput.value.trim();
		const agentId = this._agentSelect.value;
		// 次回ダイアログを開いたときに同じエージェントを既定選択にするため記憶する
		this.storageService.store(STORAGE_KEY_LAST_AGENT, agentId, StorageScope.PROFILE, StorageTarget.MACHINE);
		let worktreeCreated = false;

		try {
			// 1. ブランチ名の決定（手入力 > LLM > フォールバック）
			let branch = paradisSanitizeBranchName(this._branchInput.value);
			if (!branch) {
				if (prompt.length > 0) {
					this._setBusy(true, STR_NAMING);
					branch = await this._generateBranchName(prompt);
				}
				branch = branch ?? this._fallbackBranchName();
			}
			branch = paradisDeduplicateBranchName(branch, this._branches?.branches ?? []);

			// 2. worktree 作成
			this._setBusy(true, STR_CREATING);
			const existingDirNames = this.worktreeService.getDetectedWorktrees(repository.id).map(worktree => basename(worktree.uri));
			const { displayName, dirName } = paradisBuildWorktreeNames(this._nameInput.value, branch, this._branches?.branches ?? [], existingDirNames);
			const worktreeUri = this._computeWorktreeUri(repository, dirName);
			// このworktreeの状態キー。setup スクリプト～自動実行プリセットの実行中にユーザーが
			// PC側で別スペースへ切り替えても、これから作るターミナルを常にこの worktree へ
			// 明示的に紐付けるために使う（既定の暗黙タグ付けは「生成時点でアクティブなスコープ」
			// になってしまい、別スペース表示中に紐付け漏れが起きる）。
			const targetStateKey = paradisWorktreeStateKey(worktreeUri);
			await this.sharedProcessService.getChannel(PARADIS_WORKTREE_GIT_CHANNEL).call('addWorktree', [{
				repoPath: repository.uri.fsPath,
				worktreePath: worktreeUri.fsPath,
				newBranch: branch,
				baseRef,
			}]);
			worktreeCreated = true;

			this.worktreeService.addKnownWorktree({
				repositoryId: repository.id,
				name: displayName,
				branch,
				uri: worktreeUri,
			});

			// 3. 新スペースへ切り替え（worktree サービスの自動検出を待たず、その場で対象を組み立てて切り替える）
			await this.switchService.switchToWorktree({
				repositoryId: repository.id,
				name: displayName,
				branch,
				uri: worktreeUri,
			});

			// 4. setup スクリプト → 自動実行プリセット → （なければ既定ターミナル） → エージェント起動、の順に実行する。
			//    setup の失敗はここで例外として伝播し、後続はすべて打ち切る（下の catch で処理される）。
			await paradisCompleteCreatedWorktree({
				runSetup: async () => {
					await this.instantiationService.invokeFunction(paradisRunWorkspaceLifecycleScript, 'setup', repository, worktreeUri);
				},
				runAutoRun: async () => {
					// .paracode.json / ユーザー設定の autoRun（dev サーバー等の下準備）。失敗しても作成自体は成功扱い
					try {
						return await this.instantiationService.invokeFunction(paradisRunAutoRunPresets, worktreeUri, repository.uri.fsPath, targetStateKey);
					} catch (error) {
						this.logService.warn('[ParadisCreateWorktree] auto-run presets failed', error);
						return false;
					}
				},
				openDefaultTerminal: async () => {
					// エージェントも自動実行プリセットも何も起動しない場合のみ、既定のターミナルを開く
					if (!paradisShouldCreateDefaultTerminal(agentId, prompt)) {
						return;
					}
					const instance = await this.terminalService.createTerminal({
						cwd: worktreeUri,
						location: TerminalLocation.Panel,
					});
					this.terminalScopeService.assignInstanceScope(instance.instanceId, targetStateKey);
					instance.focus(true);
				},
				launchAgent: async () => {
					// エディタ領域ターミナル。pane トークンが自動注入されるため Workspaces ビューの稼働状態表示もそのまま効く
					const agent = this._agents.find(candidate => candidate.id === agentId);
					if (!agent || prompt.length === 0) {
						return;
					}
					const instance = await this.terminalService.createTerminal({
						cwd: worktreeUri,
						location: { viewColumn: editorGroupToColumn(this.editorGroupsService, this.editorGroupsService.activeGroup) },
					});
					this.terminalScopeService.assignInstanceScope(instance.instanceId, targetStateKey);
					instance.focus(true);
					await instance.processReady;
					const command = paradisBuildAgentCommand(agent, prompt, instance.shellType);
					await instance.sendText(command, true);
				},
			});

			this.dispose();
		} catch (error) {
			this.logService.error('[ParadisCreateWorktree] failed', error);
			if (worktreeCreated) {
				// allow-any-unicode-next-line
				this.notificationService.error(localize('paradis.createWorktree.createdWithError', "worktree は作成されましたが、その後のセットアップに失敗しました: {0}", toErrorMessage(error)));
				this.dispose();
				return;
			}
			this._setBusy(false);
			this._showError(error);
		}
	}
}
