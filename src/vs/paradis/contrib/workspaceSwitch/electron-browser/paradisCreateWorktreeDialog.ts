/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-PATCH/PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

// 「新しいスペース（worktree）を作成」ダイアログ（Superset の New Workspace モーダル相当）。
// 自然言語プロンプト＋エージェント選択（モデル/エフォート/権限モード付き）＋ベースブランチ選択＋
// setup スクリプト実行有無を入力し、作成要求をバックグラウンドキュー
// (paradisWorktreeCreateQueue.ts) へ投入して即座に閉じる。実際の作成
// （ブランチ命名 → git worktree add → setup → エージェント起動）はキュー側が実行し、
// 進行状況は通知トースト・ステータスバー・Workspaces ビューの「作成中」行に表示される。

import './media/paradisCreateWorktreeDialog.css';
import * as dom from '../../../../base/browser/dom.js';
import { Disposable, DisposableStore } from '../../../../base/common/lifecycle.js';
import { basename, dirname, joinPath } from '../../../../base/common/resources.js';
import { URI } from '../../../../base/common/uri.js';
import { paradisResolveExternalPath } from '../../../common/paradisPathUri.js';
import { localize } from '../../../../nls.js';
import { IConfigurationService } from '../../../../platform/configuration/common/configuration.js';
import { ServicesAccessor } from '../../../../platform/instantiation/common/instantiation.js';
import { IFileService } from '../../../../platform/files/common/files.js';
import { ILayoutService } from '../../../../platform/layout/browser/layoutService.js';
import { ILogService } from '../../../../platform/log/common/log.js';
import { IStorageService, StorageScope, StorageTarget } from '../../../../platform/storage/common/storage.js';
import { IParadisWorkspaceRepository, IParadisWorkspaceSwitchService, IParadisWorktreeService } from '../common/paradisWorkspaceSwitch.js';
import {
	IParadisAgentCommandTemplate,
	IParadisAgentLaunchOptions,
	IParadisGitBranches,
	PARADIS_DEFAULT_AGENT_COMMANDS,
	paradisBuildAgentCommand,
	paradisDeduplicateWorktreeDirName,
	paradisSanitizeBranchName,
} from '../common/paradisWorktreeCreate.js';
import { appendParadisAgentLogoSvg } from '../../limitsMonitor/electron-browser/paradisLimitsLogos.js';
import { paradisReadWorkspaceLifecycleConfig } from './paradisWorkspaceLifecycleService.js';
import { IParadisWorktreeGitHost, paradisWorktreeGitHostResolver } from './paradisWorktreeGitChannelClient.js';
import { IParadisWorktreeCreateQueueService } from './paradisWorktreeCreateQueue.js';
import { IParadisHeadlessWorktreeRequest } from './paradisWorktreeHeadlessCreate.js';

const $ = dom.$;

/** worktree 作成後に行う一連のアクション（順序・失敗時の打ち切りをテストしやすいよう分離）。 */
export interface IParadisCreatedWorktreeActions {
	/** リポジトリ定義の setupScript を実行する。完了を待つのは自動実行プリセットだけ。 */
	runSetup(): Promise<void>;
	/** 自動実行プリセットを起動する。何か起動したら true を返す。 */
	runAutoRun(): Promise<boolean>;
	/** runAutoRun が何も起動しなかった場合のみ呼ばれる。 */
	openDefaultTerminal(): Promise<void>;
	/** エージェント CLI を起動する。setup の完了・成否には左右されない。 */
	launchAgent(): Promise<void>;
}

/**
 * setup を開始 →（待たずに）エージェント起動 → setup 完了を待って自動実行プリセット
 * （無ければ既定ターミナル）、の順で実行する。
 *
 * エージェントの起動を setup に待たせない: setup は shared process で完走まで最長10分かかり、
 * さらに初回はスクリプト内容ごとの承認ダイアログを挟む。ここを直列にすると、依存インストールが
 * 長い・非ゼロ終了する・承認が放置される・対話プロンプトで固まる、のいずれでもエージェントが
 * 一切起動しなくなっていた（setup 中でも作成済みの worktree 行から新しいスペースは開けるので、
 * エージェントの様子はそのスペースのターミナルで見られる）。
 *
 * 自動実行プリセット（`npm run dev` 等）は依存が入っている前提を置けるため、従来どおり setup の
 * 完了を待ち、setup が失敗した場合は起動しない。
 */
export async function paradisCompleteCreatedWorktree(actions: IParadisCreatedWorktreeActions): Promise<void> {
	const setup = actions.runSetup();
	// setup の失敗は下の await で呼び出し元へ投げる。それまでの間 unhandled rejection に
	// させないため、待ち始める前にハンドラを付けておく
	setup.catch(() => { });
	await actions.launchAgent();
	await setup;
	const autoRunExecuted = await actions.runAutoRun();
	if (!autoRunExecuted) {
		await actions.openDefaultTerminal();
	}
}

// allow-any-unicode-next-line
const STR_TITLE = localize('paradis.createWorktree.title', "新しいスペース");
/** タイトル右に添える小さな補足（何を作るのかの技術名）。 */
const STR_TITLE_SUB = 'worktree';
// allow-any-unicode-next-line
const STR_CLOSE = localize('paradis.createWorktree.close', "閉じる");
// allow-any-unicode-next-line
const STR_ADVANCED = localize('paradis.createWorktree.advanced', "詳細オプション");
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
const STR_MODEL_LABEL = localize('paradis.createWorktree.modelLabel', "モデル");
// allow-any-unicode-next-line
const STR_EFFORT_LABEL = localize('paradis.createWorktree.effortLabel', "エフォート");
// allow-any-unicode-next-line
const STR_PERMISSION_ARIA = localize('paradis.createWorktree.permissionAria', "権限モード");
// allow-any-unicode-next-line
const STR_OPTION_DEFAULT = localize('paradis.createWorktree.optionDefault', "既定");
// allow-any-unicode-next-line
const STR_EFFORT_UNSUPPORTED = localize('paradis.createWorktree.effortUnsupported', "対応なし");
// allow-any-unicode-next-line
const STR_RUN_SETUP = localize('paradis.createWorktree.runSetup', "setup スクリプトを実行");
// allow-any-unicode-next-line
const STR_BASE_REPO_LABEL = localize('paradis.createWorktree.baseRepoLabel', "リポジトリ");
// allow-any-unicode-next-line
const STR_BASE_BRANCH_LABEL = localize('paradis.createWorktree.baseBranchLabel', "ベースブランチ");
// allow-any-unicode-next-line
const STR_BRANCHES_LOADING = localize('paradis.createWorktree.branchesLoading', "読み込み中…");
// allow-any-unicode-next-line
const STR_CANCEL = localize('paradis.createWorktree.cancel', "キャンセル");
// allow-any-unicode-next-line
const STR_CREATE = localize('paradis.createWorktree.create', "作成");
/** 作成ボタンに添えるキーボードショートカット表記。 */
const STR_CREATE_KBD = '⌘⏎';
// allow-any-unicode-next-line
const STR_SETUP_LABEL = localize('paradis.createWorktree.setupLabel', "setup スクリプト");
// allow-any-unicode-next-line
const STR_NO_BRANCHES = localize('paradis.createWorktree.noBranches', "ブランチを取得できませんでした");
// allow-any-unicode-next-line
const STR_AUTO = localize('paradis.createWorktree.autoName', "(自動生成)");
/** 前回選択したエージェント id の保存キー（StorageScope.PROFILE）。 */
const STORAGE_KEY_LAST_AGENT = 'paradis.workspaceSwitch.lastSelectedAgent';
/** エージェントごとのモデル/エフォート/権限の前回選択の保存キー（StorageScope.PROFILE）。 */
const STORAGE_KEY_AGENT_OPTIONS = 'paradis.workspaceSwitch.agentLaunchOptions';
/** setup スクリプトをOFFにしたリポジトリ id 一覧の保存キー（StorageScope.PROFILE）。 */
const STORAGE_KEY_SETUP_DISABLED = 'paradis.workspaceSwitch.setupDisabledRepositories';
/** コマンドプレビューに埋め込むプロンプトの省略表示長。 */
const PREVIEW_PROMPT_MAX_LENGTH = 40;

export function openParadisCreateWorktreeDialog(accessor: ServicesAccessor, preselectedRepositoryId?: string, prefill?: IParadisHeadlessWorktreeRequest): void {
	const dialog = new ParadisCreateWorktreeDialog(
		accessor.get(ILayoutService),
		// git を動かすマシンはリポジトリごとに違いうるので、選択が変わるたびに引き直せるよう
		// チャネルそのものではなく解決関数を渡す
		paradisWorktreeGitHostResolver(accessor),
		accessor.get(IParadisWorkspaceSwitchService),
		accessor.get(IParadisWorktreeService),
		accessor.get(IConfigurationService),
		accessor.get(IFileService),
		accessor.get(ILogService),
		accessor.get(IStorageService),
		accessor.get(IParadisWorktreeCreateQueueService),
		preselectedRepositoryId,
		prefill,
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
	private _agentSeg!: HTMLElement;
	private _agentOptionsEl!: HTMLElement;
	private _modelGroup!: HTMLElement;
	private _modelSelect!: HTMLSelectElement;
	private _effortGroup!: HTMLElement;
	private _effortSelect!: HTMLSelectElement;
	private _permissionRow!: HTMLElement;
	private _permissionSeg!: HTMLElement;
	private _permissionHint!: HTMLElement;
	private _cmdPreview!: HTMLElement;
	private _setupRow!: HTMLElement;
	private _setupCheckbox!: HTMLInputElement;
	private _setupScriptEl!: HTMLElement;
	private _repoSelect!: HTMLSelectElement;
	private _branchSelect!: HTMLSelectElement;
	private _pathPreview!: HTMLElement;
	private _errorEl!: HTMLElement;
	private _createBtn!: HTMLButtonElement;
	private _cancelBtn!: HTMLButtonElement;

	private _branches: IParadisGitBranches | undefined;
	/** エージェントセグメントのリスナー（フォーム再構築のたびに作り直すため個別管理）。 */
	private readonly _agentListeners = this._register(new DisposableStore());
	/** 選択中のエージェント id（'none' = 実行しない）。 */
	private _selectedAgentId: string = 'none';
	/** エージェントセグメントのボタン（描画順は _agents + 'none'）。 */
	private _agentButtons: { id: string; button: HTMLButtonElement }[] = [];
	/** 権限セグメントボタンのリスナー（エージェント切り替えのたびに作り直すため個別管理）。 */
	private readonly _permissionListeners = this._register(new DisposableStore());
	private _permissionButtons: HTMLButtonElement[] = [];
	private _selectedPermissionId: string | undefined;
	/** 選択中リポジトリの setup スクリプト（未定義なら setup 行を非表示）。 */
	private _setupScript: string | undefined;
	/** 再表示（prefill）時にブランチ一覧ロード後へ引き継ぐベースブランチ。 */
	private _pendingBaseRef: string | undefined;

	constructor(
		layoutService: ILayoutService,
		private readonly resolveGitHost: (resource: URI) => IParadisWorktreeGitHost,
		private readonly switchService: IParadisWorkspaceSwitchService,
		private readonly worktreeService: IParadisWorktreeService,
		private readonly configurationService: IConfigurationService,
		private readonly fileService: IFileService,
		private readonly logService: ILogService,
		private readonly storageService: IStorageService,
		private readonly createQueueService: IParadisWorktreeCreateQueueService,
		preselectedRepositoryId: string | undefined,
		prefill: IParadisHeadlessWorktreeRequest | undefined,
	) {
		super();

		this._backdrop = $('.paradis-create-worktree-backdrop');
		// 案D レイアウトは修飾子クラスで囲う。同じ CSS ファイルを共有する
		// paradisWorkspaceLifecycleDialog は修飾子を付けないので従来の見た目のまま残る
		this._dialog = $('.paradis-create-worktree-dialog.pcw-d');
		this._backdrop.appendChild(this._dialog);

		this._register(dom.addDisposableListener(this._backdrop, 'mousedown', e => {
			if (e.target === this._backdrop) {
				this.dispose();
			}
		}));
		this._register(dom.addDisposableListener(this._backdrop, 'keydown', e => {
			if (e.key === 'Escape') {
				e.preventDefault();
				this.dispose();
			} else if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
				e.preventDefault();
				this._doCreate();
			}
		}));

		layoutService.activeContainer.appendChild(this._backdrop);
		this._renderForm(preselectedRepositoryId ?? prefill?.repositoryId, prefill);
	}

	override dispose(): void {
		this._backdrop.remove();
		super.dispose();
	}

	private get _agents(): readonly IParadisAgentCommandTemplate[] {
		const configured = this.configurationService.getValue<IParadisAgentCommandTemplate[]>('paradis.workspaceSwitch.agents');
		if (Array.isArray(configured) && configured.length > 0) {
			// 'none' は「実行しない」を表す予約識別子（セグメントの固定項目）のため、
			// 設定で誤って同じ id が指定されても既定端末とエージェント端末の二重起動を避けるため除外する
			return configured.filter(agent => agent && typeof agent.id === 'string' && agent.id !== 'none' && typeof agent.command === 'string');
		}
		return PARADIS_DEFAULT_AGENT_COMMANDS;
	}

	private get _selectedRepository(): IParadisWorkspaceRepository | undefined {
		return this.switchService.repositories.find(repository => repository.id === this._repoSelect.value);
	}

	private get _selectedAgent(): IParadisAgentCommandTemplate | undefined {
		return this._agents.find(agent => agent.id === this._selectedAgentId);
	}

	/**
	 * エージェント選択セグメントを組み立てる。「実行しない」を末尾に置き、Claude/Codex は
	 * 実際のブランドロゴ（limitsMonitor と共通のヘルパ）、それ以外は汎用アイコンを添える。
	 */
	private _renderAgentSegment(): void {
		dom.clearNode(this._agentSeg);
		this._agentListeners.clear();
		this._agentButtons = [];
		const entries: { id: string; label: string }[] = [
			...this._agents.map(agent => ({ id: agent.id, label: agent.label ?? agent.id })),
			{ id: 'none', label: STR_AGENT_NONE },
		];
		for (const entry of entries) {
			const button = dom.append(this._agentSeg, $('button.pcw-d-agent-btn')) as HTMLButtonElement;
			button.type = 'button';
			button.setAttribute('role', 'radio');
			const icon = dom.append(button, $('span.pcw-d-agent-icon'));
			if (entry.id === 'claude' || entry.id === 'codex') {
				icon.classList.add(entry.id);
				appendParadisAgentLogoSvg(icon, entry.id);
			} else {
				dom.append(icon, $(entry.id === 'none' ? 'span.codicon.codicon-circle-slash' : 'span.codicon.codicon-robot'));
			}
			dom.append(button, $('span')).textContent = entry.label;
			this._agentButtons.push({ id: entry.id, button });
			this._agentListeners.add(dom.addDisposableListener(button, 'click', () => this._selectAgent(entry.id)));
		}
		this._updateAgentSegmentState();
	}

	private _updateAgentSegmentState(): void {
		for (const entry of this._agentButtons) {
			const active = entry.id === this._selectedAgentId;
			entry.button.classList.toggle('active', active);
			entry.button.setAttribute('aria-checked', String(active));
		}
	}

	private _selectAgent(agentId: string): void {
		if (this._selectedAgentId === agentId) {
			return;
		}
		this._selectedAgentId = agentId;
		this._updateAgentSegmentState();
		this._onAgentChanged(undefined);
	}

	private _renderForm(preselectedRepositoryId: string | undefined, prefill: IParadisHeadlessWorktreeRequest | undefined): void {
		dom.clearNode(this._dialog);

		const title = dom.append(this._dialog, $('h3.pcw-title'));
		title.textContent = STR_TITLE;
		dom.append(title, $('span.pcw-d-sub')).textContent = STR_TITLE_SUB;
		const closeBtn = dom.append(this._dialog, $('button.pcw-d-close')) as HTMLButtonElement;
		closeBtn.type = 'button';
		closeBtn.title = STR_CLOSE;
		closeBtn.setAttribute('aria-label', STR_CLOSE);
		dom.append(closeBtn, $('span.codicon.codicon-close'));
		this._register(dom.addDisposableListener(closeBtn, 'click', () => this.dispose()));

		// 自然言語プロンプト。ここが一番よく書かれる欄なので最上段に置く
		this._promptInput = dom.append(this._dialog, $('textarea.pcw-prompt.pcw-d-area')) as HTMLTextAreaElement;
		this._promptInput.rows = 3;
		this._promptInput.placeholder = STR_PROMPT_PLACEHOLDER;

		// スペース名 + ブランチ名
		const nameRow = dom.append(this._dialog, $('.pcw-d-two'));
		this._nameInput = dom.append(nameRow, $('input.pcw-d-input.pcw-name')) as HTMLInputElement;
		this._nameInput.type = 'text';
		this._nameInput.placeholder = STR_NAME_PLACEHOLDER;
		this._branchInput = dom.append(nameRow, $('input.pcw-d-input.pcw-branch')) as HTMLInputElement;
		this._branchInput.type = 'text';
		this._branchInput.placeholder = STR_BRANCH_PLACEHOLDER;
		this._branchInput.spellcheck = false;

		// エージェント選択（セグメント）＋その詳細オプション
		const agentBlock = dom.append(this._dialog, $('.pcw-d-agent-block'));
		this._agentSeg = dom.append(agentBlock, $('.pcw-d-agent-seg'));
		this._agentSeg.setAttribute('role', 'radiogroup');
		this._agentSeg.setAttribute('aria-label', STR_AGENT_LABEL);
		// 開いたときの選択は、再表示(prefill) > 設定で固定した既定 > 前回選んだもの、の順で決める。
		// 設定が空なら従来どおり前回選択を覚えて使う。いずれも現在の選択肢に無い場合
		// （設定から削除された等）は「実行しない」にする
		const configuredDefault = (this.configurationService.getValue<string>('paradis.workspaceSwitch.defaultAgent') ?? '').trim();
		const lastAgentId = prefill?.agentId
			?? (configuredDefault.length > 0 ? configuredDefault : undefined)
			?? this.storageService.get(STORAGE_KEY_LAST_AGENT, StorageScope.PROFILE);
		this._selectedAgentId = lastAgentId && (lastAgentId === 'none' || this._agents.some(agent => agent.id === lastAgentId))
			? lastAgentId
			: 'none';
		this._renderAgentSegment();

		// エージェント詳細オプション（モデル/エフォート/権限＋コマンドプレビュー）。
		// 「実行しない」選択時は囲みごと非表示にする
		this._agentOptionsEl = dom.append(agentBlock, $('.pcw-agent-options'));
		const optionRow = dom.append(this._agentOptionsEl, $('.pcw-d-agent-sub'));
		this._modelGroup = dom.append(optionRow, $('label.pcw-d-sub-field'));
		dom.append(this._modelGroup, $('span.pcw-d-sub-label')).textContent = STR_MODEL_LABEL;
		this._modelSelect = dom.append(this._modelGroup, $('select.pcw-d-sub-select')) as HTMLSelectElement;
		this._effortGroup = dom.append(optionRow, $('label.pcw-d-sub-field'));
		dom.append(this._effortGroup, $('span.pcw-d-sub-label')).textContent = STR_EFFORT_LABEL;
		this._effortSelect = dom.append(this._effortGroup, $('select.pcw-d-sub-select')) as HTMLSelectElement;
		this._permissionRow = dom.append(this._agentOptionsEl, $('.pcw-d-perm-line'));
		this._permissionSeg = dom.append(this._permissionRow, $('.pcw-seg'));
		this._permissionSeg.setAttribute('role', 'radiogroup');
		this._permissionSeg.setAttribute('aria-label', STR_PERMISSION_ARIA);
		this._permissionHint = dom.append(this._permissionRow, $('span.pcw-perm-hint'));
		this._cmdPreview = dom.append(this._agentOptionsEl, $('.pcw-cmd-preview'));

		// 詳細オプション（リポジトリ / ベースブランチ / setup）は折りたたみに入れる。
		// 既定のリポジトリと HEAD で作ることがほとんどなので、開くのは変えたいときだけでよい
		const advanced = dom.append(this._dialog, $('details.pcw-d-adv')) as HTMLDetailsElement;
		dom.append(advanced, $('summary')).textContent = STR_ADVANCED;
		const advGrid = dom.append(advanced, $('.pcw-d-adv-grid'));

		const repoRow = dom.append(advGrid, $('label.pcw-d-adv-row'));
		dom.append(repoRow, $('span.pcw-d-adv-label')).textContent = STR_BASE_REPO_LABEL;
		this._repoSelect = dom.append(repoRow, $('select.pcw-d-adv-select')) as HTMLSelectElement;
		for (const repository of this.switchService.repositories) {
			const option = dom.append(this._repoSelect, $('option')) as HTMLOptionElement;
			option.value = repository.id;
			option.textContent = repository.name;
		}
		const initialRepoId = preselectedRepositoryId ?? this.switchService.activeRepository?.id;
		if (initialRepoId && this.switchService.repositories.some(repository => repository.id === initialRepoId)) {
			this._repoSelect.value = initialRepoId;
		}

		const branchRow = dom.append(advGrid, $('label.pcw-d-adv-row'));
		dom.append(branchRow, $('span.pcw-d-adv-label')).textContent = STR_BASE_BRANCH_LABEL;
		this._branchSelect = dom.append(branchRow, $('select.pcw-d-adv-select.pcw-branch-select')) as HTMLSelectElement;

		// setup スクリプトの実行トグル（リポジトリに setupScript がある場合のみ表示）
		this._setupRow = dom.append(advGrid, $('.pcw-d-adv-row.pcw-setup-row'));
		this._setupRow.classList.add('hidden');
		dom.append(this._setupRow, $('span.pcw-d-adv-label')).textContent = STR_SETUP_LABEL;
		const setupLabel = dom.append(this._setupRow, $('label.pcw-setup-label'));
		this._setupCheckbox = dom.append(setupLabel, $('input.pcw-setup-checkbox')) as HTMLInputElement;
		this._setupCheckbox.type = 'checkbox';
		dom.append(setupLabel, $('span')).textContent = STR_RUN_SETUP;
		this._setupScriptEl = dom.append(this._setupRow, $('span.pcw-setup-script'));

		this._errorEl = dom.append(this._dialog, $('.pcw-error'));

		const footer = dom.append(this._dialog, $('.pcw-footer.pcw-d-foot'));
		// 作成先パスのプレビューはフッター左端に置く（案D: 決め手にはならないが常に見えていてほしい情報）
		this._pathPreview = dom.append(footer, $('.pcw-path-preview'));
		const buttons = dom.append(footer, $('.pcw-d-btnrow'));
		this._cancelBtn = dom.append(buttons, $('button.pcw-btn')) as HTMLButtonElement;
		this._cancelBtn.textContent = STR_CANCEL;
		this._register(dom.addDisposableListener(this._cancelBtn, 'click', () => this.dispose()));
		this._createBtn = dom.append(buttons, $('button.pcw-btn.pcw-btn-primary')) as HTMLButtonElement;
		this._createBtn.textContent = STR_CREATE;
		dom.append(this._createBtn, $('span.pcw-d-kbd')).textContent = STR_CREATE_KBD;
		this._register(dom.addDisposableListener(this._createBtn, 'click', () => this._doCreate()));

		this._register(dom.addDisposableListener(this._repoSelect, 'change', () => this._onRepositoryChanged()));
		this._register(dom.addDisposableListener(this._branchInput, 'input', () => this._updatePathPreview()));
		this._register(dom.addDisposableListener(this._modelSelect, 'change', () => this._onModelChanged()));
		this._register(dom.addDisposableListener(this._effortSelect, 'change', () => this._updateCommandPreview()));
		this._register(dom.addDisposableListener(this._promptInput, 'input', () => this._updateCommandPreview()));
		this._register(dom.addDisposableListener(this._setupCheckbox, 'change', () => {
			this._setupRow.classList.toggle('off', !this._setupCheckbox.checked);
		}));

		// 再表示（作成失敗時の「ダイアログを再表示」）ではフォーム値を復元する
		if (prefill) {
			this._nameInput.value = prefill.name ?? '';
			this._branchInput.value = prefill.branch ?? '';
			this._promptInput.value = prefill.prompt ?? '';
			this._pendingBaseRef = prefill.baseRef;
		}

		this._onAgentChanged(prefill);
		this._onRepositoryChanged(prefill?.runSetup);
		this._promptInput.focus();
	}

	// --- エージェント詳細オプション -------------------------------------------------------------

	/** エージェントごとの前回選択（モデル/エフォート/権限）を読む。壊れた保存値は無視する。 */
	private _loadStoredAgentOptions(): Record<string, IParadisAgentLaunchOptions> {
		try {
			const raw = JSON.parse(this.storageService.get(STORAGE_KEY_AGENT_OPTIONS, StorageScope.PROFILE, '{}'));
			return raw && typeof raw === 'object' ? raw as Record<string, IParadisAgentLaunchOptions> : {};
		} catch {
			return {};
		}
	}

	/** エージェント切り替え時: モデル/エフォート/権限のUIを選択エージェントの定義で組み直す。 */
	private _onAgentChanged(prefill: IParadisHeadlessWorktreeRequest | undefined): void {
		const agent = this._selectedAgent;
		this._agentOptionsEl.classList.toggle('hidden', !agent || (!agent.models && !agent.efforts && !agent.permissions));
		if (!agent) {
			this._updateCommandPreview();
			return;
		}
		const stored: IParadisAgentLaunchOptions = prefill?.agentId === agent.id
			? { modelId: prefill.modelId, effortId: prefill.effortId, permissionId: prefill.permissionId }
			: this._loadStoredAgentOptions()[agent.id] ?? {};

		// モデル
		this._modelGroup.classList.toggle('hidden', !agent.models || agent.models.length === 0);
		dom.clearNode(this._modelSelect);
		const defaultModelOption = dom.append(this._modelSelect, $('option')) as HTMLOptionElement;
		defaultModelOption.value = '';
		defaultModelOption.textContent = STR_OPTION_DEFAULT;
		for (const model of agent.models ?? []) {
			const option = dom.append(this._modelSelect, $('option')) as HTMLOptionElement;
			option.value = model.id;
			option.textContent = model.label ?? model.id;
		}
		if (stored.modelId && agent.models?.some(model => model.id === stored.modelId)) {
			this._modelSelect.value = stored.modelId;
		}

		// 権限（セグメントトグル）。先頭要素を既定として選択する
		this._permissionRow.classList.toggle('hidden', !agent.permissions || agent.permissions.length === 0);
		dom.clearNode(this._permissionSeg);
		this._permissionListeners.clear();
		this._permissionButtons = [];
		this._selectedPermissionId = undefined;
		const permissions = agent.permissions ?? [];
		const initialPermissionId = stored.permissionId && permissions.some(permission => permission.id === stored.permissionId)
			? stored.permissionId
			: permissions[0]?.id;
		for (const permission of permissions) {
			const button = dom.append(this._permissionSeg, $('button.pcw-seg-btn')) as HTMLButtonElement;
			button.type = 'button';
			button.setAttribute('role', 'radio');
			button.textContent = permission.label;
			button.classList.toggle('pcw-seg-danger', !!permission.danger);
			this._permissionButtons.push(button);
			this._permissionListeners.add(dom.addDisposableListener(button, 'click', () => this._selectPermission(permission.id)));
		}
		if (initialPermissionId !== undefined) {
			this._selectPermission(initialPermissionId);
		}

		// エフォートはモデル選択に依存するため最後に組み立てる（保存値の復元込み）
		this._rebuildEffortOptions(stored.effortId);
		this._updateCommandPreview();
	}

	/** モデル切り替え時: エフォート選択肢を選択モデルの対応表で絞り直す。 */
	private _onModelChanged(): void {
		this._rebuildEffortOptions(this._effortSelect.value || undefined);
		this._updateCommandPreview();
	}

	/**
	 * エフォート選択肢を組み直す。選択中モデルの efforts で絞り込み、空配列（非対応）なら
	 * 選択UIを無効化する。preferredEffortId が新しい選択肢に無い場合は「既定」に戻す。
	 */
	private _rebuildEffortOptions(preferredEffortId: string | undefined): void {
		const agent = this._selectedAgent;
		dom.clearNode(this._effortSelect);
		this._effortGroup.classList.toggle('hidden', !agent?.efforts || agent.efforts.length === 0);
		if (!agent?.efforts || agent.efforts.length === 0) {
			return;
		}
		const model = agent.models?.find(candidate => candidate.id === this._modelSelect.value);
		const allowedIds = model?.efforts;
		if (allowedIds !== undefined && allowedIds.length === 0) {
			// モデルがエフォート非対応（例: Claude Code の haiku）
			const unsupportedOption = dom.append(this._effortSelect, $('option')) as HTMLOptionElement;
			unsupportedOption.value = '';
			unsupportedOption.textContent = STR_EFFORT_UNSUPPORTED;
			this._effortSelect.disabled = true;
			return;
		}
		this._effortSelect.disabled = false;
		const efforts = allowedIds === undefined
			? agent.efforts
			: agent.efforts.filter(effort => allowedIds.includes(effort.id));
		const defaultOption = dom.append(this._effortSelect, $('option')) as HTMLOptionElement;
		defaultOption.value = '';
		defaultOption.textContent = model?.defaultEffort
			// allow-any-unicode-next-line
			? localize('paradis.createWorktree.optionDefaultWith', "既定（{0}）", model.defaultEffort)
			: STR_OPTION_DEFAULT;
		for (const effort of efforts) {
			const option = dom.append(this._effortSelect, $('option')) as HTMLOptionElement;
			option.value = effort.id;
			option.textContent = effort.id;
		}
		if (preferredEffortId && efforts.some(effort => effort.id === preferredEffortId)) {
			this._effortSelect.value = preferredEffortId;
		}
	}

	private _selectPermission(permissionId: string): void {
		const agent = this._selectedAgent;
		const permissions = agent?.permissions ?? [];
		const selected = permissions.find(permission => permission.id === permissionId) ?? permissions[0];
		this._selectedPermissionId = selected?.id;
		permissions.forEach((permission, index) => {
			const active = permission.id === this._selectedPermissionId;
			this._permissionButtons[index]?.classList.toggle('active', active);
			this._permissionButtons[index]?.setAttribute('aria-checked', String(active));
		});
		this._permissionHint.textContent = selected?.hint ?? '';
		this._permissionHint.classList.toggle('pcw-perm-hint-danger', !!selected?.danger);
		this._updateCommandPreview();
	}

	/** 現在の選択でエージェント起動オプションを組み立てる（既定選択は undefined = フラグなし）。 */
	private _currentLaunchOptions(): IParadisAgentLaunchOptions {
		return {
			modelId: this._modelSelect.value || undefined,
			effortId: this._effortSelect.disabled ? undefined : (this._effortSelect.value || undefined),
			permissionId: this._selectedPermissionId,
		};
	}

	/** 実際に実行されるコマンドラインのプレビュー（プロンプトは省略表示）。 */
	private _updateCommandPreview(): void {
		const agent = this._selectedAgent;
		if (!agent) {
			this._cmdPreview.textContent = '';
			return;
		}
		let prompt = this._promptInput.value.trim().replace(/\s+/g, ' ');
		if (prompt.length > PREVIEW_PROMPT_MAX_LENGTH) {
			// allow-any-unicode-next-line
			prompt = `${prompt.slice(0, PREVIEW_PROMPT_MAX_LENGTH)}…`;
		}
		// プレビューは POSIX シェル表記で統一する（実行時は実際のシェルに合わせて組み直される。
		// 空プロンプトは paradisBuildAgentCommand 側で引数ごと省かれる）
		const command = paradisBuildAgentCommand(agent, prompt, undefined, this._currentLaunchOptions());
		this._cmdPreview.textContent = `$ ${command}`;
	}

	// --- リポジトリ / setup スクリプト ----------------------------------------------------------

	private _loadSetupDisabledRepositories(): string[] {
		try {
			const raw = JSON.parse(this.storageService.get(STORAGE_KEY_SETUP_DISABLED, StorageScope.PROFILE, '[]'));
			return Array.isArray(raw) ? raw.filter((value): value is string => typeof value === 'string') : [];
		} catch {
			return [];
		}
	}

	private _onRepositoryChanged(prefillRunSetup?: boolean): void {
		void this._loadBranches();
		void this._loadSetupScript(prefillRunSetup);
	}

	/** 選択中リポジトリの .paracode.json から setupScript を読み、setup 行の表示を更新する。 */
	private async _loadSetupScript(prefillRunSetup?: boolean): Promise<void> {
		const repository = this._selectedRepository;
		this._setupScript = undefined;
		this._setupRow.classList.add('hidden');
		if (!repository) {
			return;
		}
		try {
			const config = await paradisReadWorkspaceLifecycleConfig(this.fileService, repository.uri);
			if (this._store.isDisposed || this._selectedRepository?.id !== repository.id) {
				return;
			}
			this._setupScript = config.setupScript;
		} catch (error) {
			this.logService.warn('[ParadisCreateWorktree] failed to read lifecycle config', error);
			return;
		}
		if (!this._setupScript) {
			return;
		}
		this._setupRow.classList.remove('hidden');
		this._setupScriptEl.textContent = this._setupScript;
		this._setupCheckbox.checked = prefillRunSetup ?? !this._loadSetupDisabledRepositories().includes(repository.id);
		this._setupRow.classList.toggle('off', !this._setupCheckbox.checked);
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
			const host = this.resolveGitHost(repository.uri);
			const branches = await host.channel.call<IParadisGitBranches>('listBranches', [host.path(repository.uri)]);
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
			const pendingBaseRef = this._pendingBaseRef;
			this._pendingBaseRef = undefined;
			if (pendingBaseRef && branches.branches.includes(pendingBaseRef)) {
				this._branchSelect.value = pendingBaseRef;
			} else if (branches.head && branches.branches.includes(branches.head)) {
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
			// 設定値はリポジトリと同じ名前空間で解決する (リモートや UNC のリポジトリに対して
			// ローカルの file: を強制すると、作れないパスや別マシンの場所を指してしまう)。
			// 相対指定の基準は下の既定と揃えてリポジトリの親にする (作業ツリーの中に worktree を
			// 作ってしまわないように)
			const root = paradisResolveExternalPath(dirname(repository.uri), configuredRoot);
			if (root) {
				return joinPath(root, basename(repository.uri), dirName);
			}
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

	// --- 作成（バックグラウンドキューへ投入して即クローズ） --------------------------------------

	private _doCreate(): void {
		const repository = this._selectedRepository;
		const baseRef = this._branchSelect.value;
		if (!repository || !baseRef) {
			return;
		}

		const agentId = this._selectedAgentId;
		const launchOptions = this._currentLaunchOptions();

		// 次回ダイアログを開いたときに同じ選択を既定にするため記憶する
		this.storageService.store(STORAGE_KEY_LAST_AGENT, agentId, StorageScope.PROFILE, StorageTarget.MACHINE);
		if (agentId !== 'none') {
			const storedOptions = this._loadStoredAgentOptions();
			storedOptions[agentId] = launchOptions;
			this.storageService.store(STORAGE_KEY_AGENT_OPTIONS, JSON.stringify(storedOptions), StorageScope.PROFILE, StorageTarget.MACHINE);
		}
		if (this._setupScript) {
			const disabled = new Set(this._loadSetupDisabledRepositories());
			if (this._setupCheckbox.checked) {
				disabled.delete(repository.id);
			} else {
				disabled.add(repository.id);
			}
			this.storageService.store(STORAGE_KEY_SETUP_DISABLED, JSON.stringify([...disabled]), StorageScope.PROFILE, StorageTarget.MACHINE);
		}

		// 実際の作成はバックグラウンドキューが行う。進行状況は通知トースト・ステータスバー・
		// Workspaces ビューに表示され、完了通知の「このスペースに切り替える」で切り替える
		this.createQueueService.enqueue({
			repositoryId: repository.id,
			name: this._nameInput.value,
			branch: this._branchInput.value,
			baseRef,
			prompt: this._promptInput.value.trim(),
			agentId,
			...launchOptions,
			runSetup: this._setupScript ? this._setupCheckbox.checked : true,
		});
		this.dispose();
	}
}
