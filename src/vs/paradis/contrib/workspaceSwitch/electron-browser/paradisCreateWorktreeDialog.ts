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
import { IContextViewService } from '../../../../platform/contextview/browser/contextView.js';
import { ServicesAccessor } from '../../../../platform/instantiation/common/instantiation.js';
import { IFileService } from '../../../../platform/files/common/files.js';
import { ILayoutService } from '../../../../platform/layout/browser/layoutService.js';
import { ILogService } from '../../../../platform/log/common/log.js';
import { IStorageService, StorageScope, StorageTarget } from '../../../../platform/storage/common/storage.js';
import { PosixShellType } from '../../../../platform/terminal/common/terminal.js';
import { IParadisWorkspaceRepository, IParadisWorkspaceSwitchService, IParadisWorktree, IParadisWorktreeService } from '../common/paradisWorkspaceSwitch.js';
import {
	IParadisAgentCommandTemplate,
	IParadisAgentLaunchOptions,
	IParadisGitBranches,
	IParadisWorktreeGitCommandResult,
	paradisBuildAgentCommand,
	PARADIS_AGENT_LAUNCH_OPTIONS_STORAGE_KEY,
	paradisDeduplicateWorktreeDirName,
	paradisSanitizeBranchName,
} from '../common/paradisWorktreeCreate.js';
import { appendParadisAgentLogoSvg } from '../../limitsMonitor/electron-browser/paradisLimitsLogos.js';
import { IParadisAgentModelCatalogService } from '../../agentModelCatalog/common/paradisAgentModelCatalog.js';
import { ParadisSelect } from '../../../browser/paradisSelect.js';
import { paradisAppendAgentListLockNotice } from '../../agentModelCatalog/browser/paradisAgentListLockNotice.js';
import { paradisReadWorkspaceLifecycleConfig } from './paradisWorkspaceLifecycleService.js';
import { IParadisWorktreeGitHost, paradisWorktreeGitHostResolver, paradisWorktreeGitWriteHostResolver } from './paradisWorktreeGitChannelClient.js';
import { IParadisWorktreeCreateQueueService } from './paradisWorktreeCreateQueueService.js';
import { IParadisHeadlessWorktreeRequest } from './paradisWorktreeHeadlessCreate.js';
import { ParadisSwitch } from '../../../browser/paradisSwitch.js';
import { ParadisSegmented } from '../../../browser/paradisSegmented.js';
import { IParadisComboGroup, IParadisComboItem, ParadisComboBox } from '../../../browser/paradisComboBox.js';
import { ParadisCheck } from '../../../browser/paradisCheck.js';
import { ParadisButton } from '../../../browser/paradisButton.js';
import { Codicon } from '../../../../base/common/codicons.js';
import { ThemeIcon } from '../../../../base/common/themables.js';
import { toErrorMessage } from '../../../../base/common/errorMessage.js';
import { paradisFormatCrossJumpAgo } from '../../crossJump/common/paradisCrossJump.js';
import { IParadisBranchCandidates, IParadisExistingBranchChoice, IParadisExistingBranchState, ParadisExistingBranchPlan, ParadisExistingBranchSource, paradisPlanExistingBranch } from '../common/paradisWorktreeExistingBranch.js';
import { paradisModalClasses, ParadisModalSize } from '../../../browser/paradisModal.js';
import { Schemas } from '../../../../base/common/network.js';
import { PASTED_IMAGE_DIR } from '../../terminalImagePaste/browser/paradisTerminalImagePaste.js';
import { paradisAgentImageMode, paradisWorktreeImageFileName } from '../common/paradisWorktreeImageAttach.js';
import { ParadisWorktreeImageBlock, ParadisWorktreeImageComposer } from '../browser/paradisWorktreeImageComposer.js';

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
const STR_NAME_PLACEHOLDER = localize('paradis.createWorktree.namePlaceholder', "(省略可)");
// allow-any-unicode-next-line
const STR_BRANCH_PLACEHOLDER = localize('paradis.createWorktree.branchPlaceholder', "(自動生成)");
// allow-any-unicode-next-line
const STR_PROMPT_PLACEHOLDER = localize('paradis.createWorktree.promptPlaceholder', "何をしますか？ ブランチ名の自動生成にも使われます");
// allow-any-unicode-next-line
const STR_PROMPT_FIELD = localize('paradis.createWorktree.promptField', "指示（任意）");
// allow-any-unicode-next-line
const STR_IMAGES_NO_AGENT = localize('paradis.createWorktree.imagesNoAgent', "実行しないときは画像を添えられません");
// allow-any-unicode-next-line
const STR_NAME_FIELD = localize('paradis.createWorktree.nameField', "スペース名");
// allow-any-unicode-next-line
const STR_BRANCH_FIELD = localize('paradis.createWorktree.branchField', "ブランチ名");
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
// allow-any-unicode-next-line
const STR_MODE_ARIA = localize('paradis.createWorktree.modeAria', "ブランチ");
// allow-any-unicode-next-line
const STR_MODE_NEW = localize('paradis.createWorktree.modeNew', "新しいブランチ");
// allow-any-unicode-next-line
const STR_MODE_EXISTING = localize('paradis.createWorktree.modeExisting', "既存のブランチ");
// allow-any-unicode-next-line
const STR_EXISTING_FIELD = localize('paradis.createWorktree.existingField', "ブランチ");
// allow-any-unicode-next-line
const STR_EXISTING_PLACEHOLDER = localize('paradis.createWorktree.existingPlaceholder', "ブランチを探す（ローカルと origin）");
// allow-any-unicode-next-line
const STR_EXISTING_EMPTY = localize('paradis.createWorktree.existingEmpty', "一致するブランチがありません");
// allow-any-unicode-next-line
const STR_EXISTING_FOOTER = localize('paradis.createWorktree.existingFooter', "↑↓ で選んで Enter・入力で絞り込み");
// allow-any-unicode-next-line
const STR_GROUP_LOCAL = localize('paradis.createWorktree.groupLocal', "ローカル");
// allow-any-unicode-next-line
const STR_GROUP_ORIGIN = localize('paradis.createWorktree.groupOrigin', "origin（リモート）");
// allow-any-unicode-next-line
const STR_IN_USE_CHIP = localize('paradis.createWorktree.inUseChip', "使用中");
// allow-any-unicode-next-line
const STR_ALSO_LOCAL = localize('paradis.createWorktree.alsoLocal', "ローカルにもあり");
// allow-any-unicode-next-line
const STR_FETCHING = localize('paradis.createWorktree.fetching', "origin から最新のブランチを取得中…");
// allow-any-unicode-next-line
const STR_FETCHING_NOTICE = localize('paradis.createWorktree.fetchingNotice', "origin から取得中… 届いたら一覧を入れ替えます");
// allow-any-unicode-next-line
const STR_FETCHED = localize('paradis.createWorktree.fetched', "origin から取得済み（たった今）");
// allow-any-unicode-next-line
const STR_RETRY = localize('paradis.createWorktree.retry', "再試行");
// allow-any-unicode-next-line
const STR_PROMPT_PLACEHOLDER_EXISTING = localize('paradis.createWorktree.promptPlaceholderExisting', "何をしますか？");
// allow-any-unicode-next-line
const STR_PICK_BRANCH = localize('paradis.createWorktree.pickBranch', "(ブランチを選んでください)");
// allow-any-unicode-next-line
const STR_CHECKING = localize('paradis.createWorktree.checking', "ブランチの状態を確かめています…");
/** 前回選択したエージェント id の保存キー（StorageScope.PROFILE）。 */
const STORAGE_KEY_LAST_AGENT = 'paradis.workspaceSwitch.lastSelectedAgent';
/** エージェントごとのモデル/エフォート/権限の前回選択の保存キー（タブの「＋」のランチャーと共有）。 */
const STORAGE_KEY_AGENT_OPTIONS = PARADIS_AGENT_LAUNCH_OPTIONS_STORAGE_KEY;
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
		accessor.get(IParadisAgentModelCatalogService),
		accessor.get(IContextViewService),
		preselectedRepositoryId,
		prefill,
		// fetch は refs を書き換えるので、作成と同じく別のマシンへ流さない解決関数で動かす
		paradisWorktreeGitWriteHostResolver(accessor),
	);
	// ダイアログは自身の close で自己 dispose する
	void dialog;
}

export class ParadisCreateWorktreeDialog extends Disposable {

	/** 指示の欄の見出しの id を、開いたダイアログごとに分ける。 */
	private static _nextId = 1;

	private readonly _backdrop: HTMLElement;
	private readonly _dialog: HTMLElement;

	private _nameInput!: HTMLInputElement;
	private _branchInput!: HTMLInputElement;
	private _promptInput!: HTMLTextAreaElement;
	private _imageComposer!: ParadisWorktreeImageComposer;
	private _agentSeg!: HTMLElement;
	private _agentOptionsEl!: HTMLElement;
	private _modelGroup!: HTMLElement;
	private _modelSelect!: ParadisSelect;
	private _effortGroup!: HTMLElement;
	private _effortSelect!: ParadisSelect;
	private _permissionRow!: HTMLElement;
	private _permissionSeg!: HTMLElement;
	private _permissionHint!: HTMLElement;
	private _cmdPreview!: HTMLElement;
	private _setupRow!: HTMLElement;
	private _setupCheckbox!: ParadisSwitch;
	private _setupScriptEl!: HTMLElement;
	private _repoSelect!: ParadisSelect;
	private _branchSelect!: ParadisSelect;
	private _pathPreview!: HTMLElement;
	private _errorEl!: HTMLElement;
	private _createBtn!: HTMLButtonElement;
	private _cancelBtn!: HTMLButtonElement;

	private _branches: IParadisGitBranches | undefined;
	/** エージェントセグメントのリスナー（フォーム再構築のたびに作り直すため個別管理）。 */
	private readonly _agentListeners = this._register(new DisposableStore());
	/** 選択中のエージェント id（'none' = 実行しない）。 */
	private _selectedAgentId: string = 'none';
	/** 今並べているエージェント定義が設定で固定されたものか（変わったら権限まで組み直す）。 */
	private _agentsFixedBySettings = false;
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

	// --- 「既存のブランチ」（q.html Q605 案 A） ---
	private _mode: 'new' | 'existing' = 'new';
	private _modeSeg!: ParadisSegmented<'new' | 'existing'>;
	private _existingField!: HTMLElement;
	private _branchCombo!: ParadisComboBox;
	private _fetchStatusEl!: HTMLElement;
	private _fetchStatusIcon!: HTMLElement;
	private _fetchStatusText!: HTMLElement;
	private _fetchRetry!: ParadisButton;
	private _branchNoteEl!: HTMLElement;
	private _branchNameField!: HTMLElement;
	private _baseBranchRow!: HTMLElement;
	/** 選んだリポジトリの候補（fetch の前は手元の refs から）。 */
	private _candidates: IParadisBranchCandidates | undefined;
	/** 候補を読んだリポジトリ。違うリポジトリの遅い応答を捨てるため。 */
	private _candidatesRepoId: string | undefined;
	private _fetchState: 'idle' | 'loading' | 'done' | 'failed' = 'idle';
	/** fetch を済ませた（または走らせている）リポジトリ。切り替えの連打で fetch を重ねない。 */
	private _fetchRepoId: string | undefined;
	/** 選んだ既存のブランチ。 */
	private _choice: { readonly source: ParadisExistingBranchSource; readonly name: string } | undefined;
	/** 選んだブランチの今の状態と、どう開くか（確かめている間は undefined）。 */
	private _choiceState: IParadisExistingBranchState | undefined;
	private _plan: ParadisExistingBranchPlan | undefined;
	/** 選んだブランチの状態の読み込みの番号（遅い応答を捨てる）。 */
	private _inspectToken = 0;
	/** 「origin に合わせる」を利用者が切り替えた値（undefined なら判定ごとの既定）。 */
	private _syncChoice: boolean | undefined;
	/** 次に描くチェックへフォーカスを移すか（チェックを切り替えて描き直したとき）。 */
	private _focusSyncCheck = false;
	/** 注意の中のチェック（描き直すたびに作り直す）。 */
	private readonly _noteStore = this._register(new DisposableStore());

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
		private readonly modelCatalogService: IParadisAgentModelCatalogService,
		private readonly contextViewService: IContextViewService,
		preselectedRepositoryId: string | undefined,
		prefill: IParadisHeadlessWorktreeRequest | undefined,
		/** fetch（refs を書く）に使う解決関数。省くと読み取りと同じものを使う。 */
		private readonly resolveGitWriteHost: (resource: URI) => IParadisWorktreeGitHost | undefined = resolveGitHost,
	) {
		super();

		this._backdrop = $('.paradis-create-worktree-backdrop.paradis-modal-backdrop');
		// 案D レイアウトは修飾子クラスで囲う。同じ CSS ファイルを共有する
		// paradisWorkspaceLifecycleDialog は修飾子を付けないので従来の見た目のまま残る
		this._dialog = $('.paradis-create-worktree-dialog.pcw-d');
		this._dialog.classList.add(...paradisModalClasses(ParadisModalSize.Small));
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
		// インストール済み CLI のモデル候補を取り直し、届いたら選択を保ったまま並べ直す
		this._register(this.modelCatalogService.onDidChange(() => this._onAgentTemplatesChanged()));
		this.modelCatalogService.refresh();
	}

	override dispose(): void {
		this._backdrop.remove();
		super.dispose();
	}

	private get _agents(): readonly IParadisAgentCommandTemplate[] {
		// 設定を書いていなければ、既定の定義にインストール済み CLI のモデル候補を当てはめたもの
		return this.modelCatalogService.getAgentTemplates();
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
			// 見た目と読み上げは UI キットの切り替えの組（paradisSegmented.css）にそろえる（押されたボタン = aria-pressed）
			const button = dom.append(this._agentSeg, $('button.pcw-d-agent-btn.paradis-focus-ring-inset')) as HTMLButtonElement;
			button.type = 'button';
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
			entry.button.setAttribute('aria-pressed', String(active));
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

		// allow-any-unicode-next-line
		// 設定 / 通知設定 / 使用量ダッシュボードと同じシェル（ヘッダー帯 + 本文 + フッター帯）に揃える。
		// 以前はタイトルが本文の padding の中に直接あり、閉じるボタンだけが absolute で浮いていた
		const header = dom.append(this._dialog, $('.pcw-d-header'));
		dom.append(header, $('h2.pcw-title')).textContent = STR_TITLE;
		dom.append(header, $('span.pcw-d-sub')).textContent = STR_TITLE_SUB;
		const closeBtn = dom.append(header, $('button.pcw-d-close')) as HTMLButtonElement;
		closeBtn.type = 'button';
		closeBtn.title = STR_CLOSE;
		closeBtn.setAttribute('aria-label', STR_CLOSE);
		dom.append(closeBtn, $('span.codicon.codicon-close'));
		this._register(dom.addDisposableListener(closeBtn, 'click', () => this.dispose()));

		const body = dom.append(this._dialog, $('.pcw-d-body'));

		// 新しいブランチを切るか、既存のブランチ（ローカル・origin）をそのまま開くか
		const modeRow = dom.append(body, $('.pcw-d-mode'));
		this._modeSeg = this._register(new ParadisSegmented<'new' | 'existing'>(modeRow, {
			items: [{ value: 'new', label: STR_MODE_NEW }, { value: 'existing', label: STR_MODE_EXISTING }],
			value: 'new',
			ariaLabel: STR_MODE_ARIA,
		}));
		this._register(this._modeSeg.onDidChange(mode => this._setMode(mode, true)));

		// 既存のブランチの欄。どれを開くかが一番の決めごとになるので、DOM の順でも指示より前に置く（Tab の順と見た目をそろえる）
		this._existingField = dom.append(body, $('.pcw-d-field.pcw-d-existing.hidden'));
		const existingLabel = dom.append(this._existingField, $('span'));
		existingLabel.textContent = STR_EXISTING_FIELD;
		this._branchCombo = this._register(new ParadisComboBox(this._existingField, this.contextViewService, {
			ariaLabel: STR_EXISTING_FIELD,
			placeholder: STR_EXISTING_PLACEHOLDER,
			icon: Codicon.gitBranch,
			emptyLabel: STR_EXISTING_EMPTY,
			footer: STR_EXISTING_FOOTER,
		}));
		this._register(this._branchCombo.onDidSelect(item => this._onBranchChosen(item)));
		this._register(this._branchCombo.onDidRunNoticeAction(() => this._fetchOrigin(true)));
		this._fetchStatusEl = dom.append(this._existingField, $('.pcw-d-fetch-status'));
		this._fetchStatusIcon = dom.append(this._fetchStatusEl, $('span'));
		this._fetchStatusIcon.setAttribute('aria-hidden', 'true');
		this._fetchStatusText = dom.append(this._fetchStatusEl, $('span.pcw-d-fetch-text'));
		this._fetchStatusText.setAttribute('role', 'status');
		this._fetchRetry = this._register(new ParadisButton(this._fetchStatusEl, { kind: 'ghost', small: true, label: STR_RETRY }));
		this._register(this._fetchRetry.onDidClick(() => this._fetchOrigin(true)));
		this._branchNoteEl = dom.append(this._existingField, $('.pcw-d-branch-note.hidden'));

		// 自然言語プロンプト。ここが一番よく書かれる欄なので最上段に置く
		// allow-any-unicode-next-line
		// フィールドの箱そのものを label にして、見出しと入力を暗黙に関連付ける
		// (placeholder を短くしたので、支援技術に読ませる名前はここにしか無い)
		// 画像を添えられるよう、指示の欄・サムネイル・クリップを 1 つの枠にまとめる（Q615 の案 B）。枠の中にボタンがあるので
		// label では包まず、見出しの id で欄に名前を付ける
		const promptField = dom.append(body, $('.pcw-d-field'));
		const promptLabel = dom.append(promptField, $('span'));
		promptLabel.id = `paradis-create-worktree-prompt-${ParadisCreateWorktreeDialog._nextId++}`;
		promptLabel.textContent = STR_PROMPT_FIELD;
		this._imageComposer = this._register(new ParadisWorktreeImageComposer(promptField, {
			labelId: promptLabel.id,
			placeholder: STR_PROMPT_PLACEHOLDER,
			images: prefill?.images,
		}));
		this._promptInput = this._imageComposer.textarea;
		this._register(this._imageComposer.onDidChange(() => this._updateCommandPreview()));

		// スペース名 + ブランチ名
		const nameRow = dom.append(body, $('.pcw-d-two'));
		const nameField = dom.append(nameRow, $('label.pcw-d-field'));
		dom.append(nameField, $('span')).textContent = STR_NAME_FIELD;
		this._nameInput = dom.append(nameField, $('input.pcw-d-input.pcw-name')) as HTMLInputElement;
		this._nameInput.type = 'text';
		this._nameInput.placeholder = STR_NAME_PLACEHOLDER;
		const branchField = dom.append(nameRow, $('label.pcw-d-field'));
		this._branchNameField = branchField;
		dom.append(branchField, $('span')).textContent = STR_BRANCH_FIELD;
		this._branchInput = dom.append(branchField, $('input.pcw-d-input.pcw-branch')) as HTMLInputElement;
		this._branchInput.type = 'text';
		this._branchInput.placeholder = STR_BRANCH_PLACEHOLDER;
		this._branchInput.spellcheck = false;

		// エージェント選択（セグメント）＋その詳細オプション
		const agentBlock = dom.append(body, $('.pcw-d-agent-block'));
		dom.append(agentBlock, $('span.pcw-d-field-label')).textContent = STR_AGENT_LABEL;
		this._agentSeg = dom.append(agentBlock, $('.pcw-d-agent-seg.paradis-seg'));
		this._agentSeg.setAttribute('role', 'group');
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
		this._agentsFixedBySettings = this.modelCatalogService.isFixedBySettings();
		this._renderAgentSegment();
		// 一覧が設定で固定されているときは、その旨と「既定に戻す」を出す（settings.json を開くときはこのダイアログを閉じる）
		this._register(paradisAppendAgentListLockNotice(agentBlock, this.modelCatalogService, () => this.dispose()));

		// エージェント詳細オプション（モデル/エフォート/権限＋コマンドプレビュー）。
		// 「実行しない」選択時は囲みごと非表示にする
		this._agentOptionsEl = dom.append(agentBlock, $('.pcw-agent-options'));
		const optionRow = dom.append(this._agentOptionsEl, $('.pcw-d-agent-sub'));
		this._modelGroup = dom.append(optionRow, $('label.pcw-d-sub-field'));
		dom.append(this._modelGroup, $('span.pcw-d-sub-label')).textContent = STR_MODEL_LABEL;
		this._modelSelect = this._register(new ParadisSelect(this._modelGroup, this.contextViewService, this.configurationService, [], undefined, { ariaLabel: STR_MODEL_LABEL, className: 'pcw-d-sub-select' }));
		this._effortGroup = dom.append(optionRow, $('label.pcw-d-sub-field'));
		dom.append(this._effortGroup, $('span.pcw-d-sub-label')).textContent = STR_EFFORT_LABEL;
		this._effortSelect = this._register(new ParadisSelect(this._effortGroup, this.contextViewService, this.configurationService, [], undefined, { ariaLabel: STR_EFFORT_LABEL, className: 'pcw-d-sub-select' }));
		this._permissionRow = dom.append(this._agentOptionsEl, $('.pcw-d-perm-line'));
		this._permissionSeg = dom.append(this._permissionRow, $('.pcw-seg'));
		this._permissionSeg.setAttribute('role', 'radiogroup');
		this._permissionSeg.setAttribute('aria-label', STR_PERMISSION_ARIA);
		this._permissionHint = dom.append(this._permissionRow, $('span.pcw-perm-hint'));
		this._cmdPreview = dom.append(this._agentOptionsEl, $('.pcw-cmd-preview'));

		// 詳細オプション（リポジトリ / ベースブランチ / setup）は折りたたみに入れる。
		// 既定のリポジトリと HEAD で作ることがほとんどなので、開くのは変えたいときだけでよい
		const advanced = dom.append(body, $('details.pcw-d-adv')) as HTMLDetailsElement;
		dom.append(advanced, $('summary')).textContent = STR_ADVANCED;
		const advGrid = dom.append(advanced, $('.pcw-d-adv-grid'));

		const repoRow = dom.append(advGrid, $('label.pcw-d-adv-row'));
		dom.append(repoRow, $('span.pcw-d-adv-label')).textContent = STR_BASE_REPO_LABEL;
		// 一覧に無いリポジトリ（閉じたものなど）は選ばず、先頭にする
		const initialRepoId = preselectedRepositoryId ?? this.switchService.activeRepository?.id;
		const repositoryOptions = this.switchService.repositories.map(repository => ({ value: repository.id, label: repository.name }));
		this._repoSelect = this._register(new ParadisSelect(repoRow, this.contextViewService, this.configurationService,
			repositoryOptions,
			repositoryOptions.some(option => option.value === initialRepoId) ? initialRepoId : undefined, { ariaLabel: STR_BASE_REPO_LABEL, className: 'pcw-d-adv-select' }));

		const branchRow = dom.append(advGrid, $('label.pcw-d-adv-row'));
		this._baseBranchRow = branchRow;
		dom.append(branchRow, $('span.pcw-d-adv-label')).textContent = STR_BASE_BRANCH_LABEL;
		this._branchSelect = this._register(new ParadisSelect(branchRow, this.contextViewService, this.configurationService, [], undefined, { ariaLabel: STR_BASE_BRANCH_LABEL, className: 'pcw-d-adv-select pcw-branch-select' }));

		// setup スクリプトの実行トグル（リポジトリに setupScript がある場合のみ表示）
		this._setupRow = dom.append(advGrid, $('.pcw-d-adv-row.pcw-setup-row'));
		this._setupRow.classList.add('hidden');
		dom.append(this._setupRow, $('span.pcw-d-adv-label')).textContent = STR_SETUP_LABEL;
		const setupLabel = dom.append(this._setupRow, $('label.pcw-setup-label'));
		// オン/オフは共通のスイッチ（paradisSwitch.ts）。<label> で包むので、文言を押しても切り替わる
		this._setupCheckbox = this._register(new ParadisSwitch(setupLabel, { checked: true }));
		dom.append(setupLabel, $('span')).textContent = STR_RUN_SETUP;
		this._setupScriptEl = dom.append(this._setupRow, $('span.pcw-setup-script'));

		this._errorEl = dom.append(body, $('.pcw-error'));

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

		this._register(this._repoSelect.onDidChange(() => this._onRepositoryChanged()));
		this._register(dom.addDisposableListener(this._branchInput, 'input', () => this._updatePathPreview()));
		this._register(this._modelSelect.onDidChange(() => this._onModelChanged()));
		this._register(this._effortSelect.onDidChange(() => this._updateCommandPreview()));
		this._register(dom.addDisposableListener(this._promptInput, 'input', () => this._updateCommandPreview()));
		this._register(this._setupCheckbox.onDidChange(() => {
			this._setupRow.classList.toggle('off', !this._setupCheckbox.checked);
		}));

		this._register(dom.addDisposableListener(this._nameInput, 'input', () => this._updatePathPreview()));

		// 再表示（作成失敗時の「ダイアログを再表示」）ではフォーム値を復元する
		if (prefill) {
			this._nameInput.value = prefill.name ?? '';
			this._branchInput.value = prefill.branch ?? '';
			this._promptInput.value = prefill.prompt ?? '';
			this._pendingBaseRef = prefill.baseRef;
		}

		this._onAgentChanged(prefill);
		this._onRepositoryChanged(prefill?.runSetup);
		// 再表示ではモードと選んだブランチも戻す（エージェントの `auto` はダイアログからは来ないので origin として扱う）
		if (prefill?.existingBranch) {
			const choice = prefill.existingBranch;
			const source: ParadisExistingBranchSource = choice.source === 'local' ? 'local' : 'origin';
			this._choice = { source, name: choice.branch };
			this._syncChoice = choice.sync !== undefined ? true : undefined;
			this._branchCombo.selected = this._comboItemFor(source, choice.branch);
			this._modeSeg.value = 'existing';
			this._setMode('existing', false);
			void this._inspectChoice();
		}
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
		this._updateImageBlock();
		this._agentOptionsEl.classList.toggle('hidden', !agent || (!agent.models && !agent.efforts && !agent.permissions));
		if (!agent) {
			this._updateCommandPreview();
			return;
		}
		const stored: IParadisAgentLaunchOptions = prefill?.agentId === agent.id
			? { modelId: prefill.modelId, effortId: prefill.effortId, permissionId: prefill.permissionId }
			: this._loadStoredAgentOptions()[agent.id] ?? {};

		// モデル
		this._fillModelOptions(agent, stored.modelId);

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

	/** モデルの選択肢を並べる。`preferredModelId` が候補にあればそれを選ぶ（無ければ「既定」）。 */
	private _fillModelOptions(agent: IParadisAgentCommandTemplate, preferredModelId: string | undefined): void {
		this._syncModelOptions(agent);
		this._modelSelect.value = preferredModelId && agent.models?.some(model => model.id === preferredModelId) ? preferredModelId : '';
	}

	/** モデルの選択肢を選択中エージェントの候補に揃える（差分だけ入れ替える）。何か変えたら true。 */
	private _syncModelOptions(agent: IParadisAgentCommandTemplate): boolean {
		this._modelGroup.classList.toggle('hidden', !agent.models || agent.models.length === 0);
		return this._modelSelect.setOptions([
			{ value: '', label: STR_OPTION_DEFAULT },
			...(agent.models ?? []).map(model => ({ value: model.id, label: model.label ?? model.id })),
		]);
	}

	/**
	 * エージェント定義が変わったとき。設定の一覧を消した（既定に戻した）などでエージェントの顔ぶれが
	 * 変わったらセグメントから組み直し、同じならモデル候補だけを並べ直す。
	 */
	private _onAgentTemplatesChanged(): void {
		if (!this._agentSeg) {
			return;
		}
		const rendered = this._agentButtons.map(entry => entry.id).filter(id => id !== 'none');
		const current = this._agents.map(agent => agent.id);
		const fixedBySettings = this.modelCatalogService.isFixedBySettings();
		const sourceChanged = fixedBySettings !== this._agentsFixedBySettings;
		this._agentsFixedBySettings = fixedBySettings;
		if (!sourceChanged && rendered.length === current.length && rendered.every((id, index) => id === current[index])) {
			this._refreshModelOptions();
			return;
		}
		if (this._selectedAgentId !== 'none' && !current.includes(this._selectedAgentId)) {
			this._selectedAgentId = 'none';
		}
		this._renderAgentSegment();
		this._onAgentChanged(undefined);
	}

	/** モデル候補が届き直したとき: 選んでいるモデルとエフォートを保ったまま並べ直す。 */
	private _refreshModelOptions(): void {
		const agent = this._selectedAgent;
		if (!agent || !this._modelSelect) {
			return;
		}
		// 候補が同じなら何も触らない（開いているドロップダウンを閉じない）
		const current = this._modelSelect.value;
		if (!this._syncModelOptions(agent)) {
			return;
		}
		if (this._modelSelect.value !== current && agent.models?.some(model => model.id === current)) {
			this._modelSelect.value = current;
		}
		this._onModelChanged();
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
		this._effortGroup.classList.toggle('hidden', !agent?.efforts || agent.efforts.length === 0);
		if (!agent?.efforts || agent.efforts.length === 0) {
			this._effortSelect.setOptions([]);
			return;
		}
		const model = agent.models?.find(candidate => candidate.id === this._modelSelect.value);
		const allowedIds = model?.efforts;
		if (allowedIds !== undefined && allowedIds.length === 0) {
			// モデルがエフォート非対応（例: Claude Code の Haiku 4.5）
			this._effortSelect.setOptions([{ value: '', label: STR_EFFORT_UNSUPPORTED }], '');
			this._effortSelect.enabled = false;
			return;
		}
		this._effortSelect.enabled = true;
		const efforts = allowedIds === undefined
			? agent.efforts
			: agent.efforts.filter(effort => allowedIds.includes(effort.id));
		const defaultLabel = model?.defaultEffort
			// allow-any-unicode-next-line
			? localize('paradis.createWorktree.optionDefaultWith', "既定（{0}）", model.defaultEffort)
			: STR_OPTION_DEFAULT;
		this._effortSelect.setOptions([
			{ value: '', label: defaultLabel },
			...efforts.map(effort => ({ value: effort.id, label: effort.id })),
		], preferredEffortId && efforts.some(effort => effort.id === preferredEffortId) ? preferredEffortId : '');
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
			effortId: !this._effortSelect.enabled ? undefined : (this._effortSelect.value || undefined),
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
		// 種類の分からないシェル（undefined）ではバックスラッシュを含む指示を断る作りなので、表記に合わせて bash として組む
		// 添えた画像は、作るときに付く名前（時刻はプレビューを作った時点のもの）で見せる
		const now = Date.now();
		const imagePaths = this._imageComposer.images.map((image, index) => `${PASTED_IMAGE_DIR}/${paradisWorktreeImageFileName(now, index, image.mime)}`);
		const command = paradisBuildAgentCommand(agent, prompt, PosixShellType.Bash, this._currentLaunchOptions(), imagePaths);
		this._cmdPreview.textContent = `$ ${command}`;
	}

	/** 選んだエージェントに画像を渡せるかを、添付の枠へ伝える。 */
	private _updateImageBlock(): void {
		const agent = this._selectedAgent;
		if (!agent) {
			this._imageComposer.setBlock(ParadisWorktreeImageBlock.NoAgent, STR_IMAGES_NO_AGENT);
		} else if (paradisAgentImageMode(agent.id) === 'unsupported') {
			// allow-any-unicode-next-line
			this._imageComposer.setBlock(ParadisWorktreeImageBlock.Unsupported, localize('paradis.createWorktree.imagesUnsupported', "{0} には画像を渡せません（git が無視するファイルを読まないため）", agent.label ?? agent.id));
		} else {
			this._imageComposer.setBlock(ParadisWorktreeImageBlock.None, '');
		}
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
		this._imageComposer.setRemote(this._selectedRepository?.uri.scheme === Schemas.vscodeRemote);
		void this._loadBranches();
		void this._loadSetupScript(prefillRunSetup);
		if (this._candidatesRepoId !== undefined && this._candidatesRepoId !== this._selectedRepository?.id) {
			// 別のリポジトリの候補・選んだブランチ・取得の状態は持ち越さない
			this._candidates = undefined;
			this._candidatesRepoId = undefined;
			this._fetchRepoId = undefined;
			this._fetchState = 'idle';
			this._clearChoice();
		}
		if (this._mode === 'existing') {
			void this._loadCandidates();
			this._fetchOrigin(false);
		}
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
		// 狭い窓では省略記号で切れるので、全体はポインタを重ねたときに出す
		this._setupScriptEl.title = this._setupScript;
		this._setupCheckbox.checked = prefillRunSetup ?? !this._loadSetupDisabledRepositories().includes(repository.id);
		this._setupRow.classList.toggle('off', !this._setupCheckbox.checked);
	}

	private async _loadBranches(): Promise<void> {
		const repository = this._selectedRepository;
		this._branches = undefined;
		if (!repository) {
			this._branchSelect.setOptions([]);
			return;
		}
		this._branchSelect.setOptions([{ value: '', label: STR_BRANCHES_LOADING }], '');
		try {
			const host = this.resolveGitHost(repository.uri);
			const branches = await host.channel.call<IParadisGitBranches>('listBranches', [host.path(repository.uri)]);
			if (this._store.isDisposed || this._selectedRepository?.id !== repository.id) {
				return;
			}
			this._branches = branches;
			const pendingBaseRef = this._pendingBaseRef;
			this._pendingBaseRef = undefined;
			const selectedBranch = pendingBaseRef && branches.branches.includes(pendingBaseRef)
				? pendingBaseRef
				: branches.head && branches.branches.includes(branches.head) ? branches.head : undefined;
			this._branchSelect.setOptions(branches.branches.length === 0
				? [{ value: '', label: STR_NO_BRANCHES }]
				: branches.branches.map(branch => ({ value: branch, label: branch })), selectedBranch);
		} catch (error) {
			if (this._store.isDisposed) {
				return;
			}
			this._branchSelect.setOptions([{ value: '', label: STR_NO_BRANCHES }], '');
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
		const existingDirNames = this.worktreeService.getDetectedWorktrees(repository.id).map(worktree => basename(worktree.uri));
		if (this._mode === 'existing') {
			const chosen = this._choice?.name;
			if (!chosen) {
				this._pathPreview.textContent = this._computeWorktreeUri(repository, STR_PICK_BRANCH).fsPath;
			} else if (this._plan?.kind === 'inUse') {
				this._pathPreview.textContent = '';
			} else {
				// 開くブランチ自身はディレクトリ名の衝突に数えない（作成の流れと同じ）
				const dirName = paradisDeduplicateWorktreeDirName(chosen, (this._branches?.branches ?? []).filter(name => name !== chosen), existingDirNames);
				this._pathPreview.textContent = this._computeWorktreeUri(repository, dirName).fsPath;
			}
			this._updateCreateEnabled();
			return;
		}
		const branch = paradisSanitizeBranchName(this._branchInput.value);
		const dirName = branch
			? paradisDeduplicateWorktreeDirName(branch, this._branches?.branches ?? [], existingDirNames)
			: STR_AUTO;
		this._pathPreview.textContent = this._computeWorktreeUri(repository, dirName).fsPath;
		this._updateCreateEnabled();
	}

	private _showError(error: unknown): void {
		this._errorEl.textContent = error instanceof Error ? error.message : String(error);
	}

	// --- 作成（バックグラウンドキューへ投入して即クローズ） --------------------------------------

	private _doCreate(): void {
		const repository = this._selectedRepository;
		const baseRef = this._branchSelect.value;
		// ⌘⏎ はボタンを通らないので、押せない状態ならここでも止める
		if (!repository || !this._canCreate()) {
			return;
		}
		const existingBranch = this._mode === 'existing' ? this._existingBranchChoice() : undefined;
		if (this._mode === 'existing' && !existingBranch) {
			return;
		}

		const agentId = this._selectedAgentId;
		const launchOptions = this._currentLaunchOptions();
		// 実行しない・画像を渡せないエージェントでは画像を添えない（読む相手がいない）
		const images = paradisAgentImageMode(this._selectedAgent?.id) === 'unsupported' ? [] : this._imageComposer.images;

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
			branch: existingBranch ? '' : this._branchInput.value,
			baseRef: existingBranch ? '' : baseRef,
			prompt: this._promptInput.value.trim(),
			agentId,
			...launchOptions,
			runSetup: this._setupScript ? this._setupCheckbox.checked : true,
			...(existingBranch ? { existingBranch } : {}),
			...(images.length > 0 ? { images } : {}),
		});
		this.dispose();
	}

	/** 作成を受け付けられるか（新しいブランチはベースブランチがあること、既存のブランチは開ける判定が出ていること）。 */
	private _canCreate(): boolean {
		if (this._mode === 'new') {
			return !!this._branchSelect.value;
		}
		const plan = this._plan;
		return !!this._choice && !!plan && plan.kind !== 'inUse' && plan.kind !== 'missing';
	}

	private _updateCreateEnabled(): void {
		if (this._createBtn) {
			this._createBtn.disabled = !this._canCreate();
		}
	}

	/** キューへ渡す「既存のブランチ」の指定。 */
	private _existingBranchChoice(): IParadisExistingBranchChoice | undefined {
		const choice = this._choice;
		const plan = this._plan;
		if (!choice || !plan || plan.kind === 'inUse' || plan.kind === 'missing') {
			return undefined;
		}
		const sync = this._syncEnabled(plan);
		if (sync && plan.kind === 'behind') {
			return { branch: choice.name, source: choice.source, sync: 'fastForward' };
		}
		if (sync && plan.kind === 'diverged') {
			return { branch: choice.name, source: choice.source, sync: 'reset', expectedLocalSha: this._choiceState?.localSha };
		}
		return { branch: choice.name, source: choice.source };
	}

	// --- 既存のブランチ（q.html Q605 案 A） ------------------------------------------------------

	private _setMode(mode: 'new' | 'existing', fromUser: boolean): void {
		this._mode = mode;
		const existing = mode === 'existing';
		this._existingField.classList.toggle('hidden', !existing);
		// 既存のブランチでは新しいブランチ名とベースブランチは使わない。スペース名は 1 列にする
		this._branchNameField.classList.toggle('hidden', existing);
		this._baseBranchRow.classList.toggle('hidden', existing);
		this._dialog.classList.toggle('pcw-d-existing-mode', existing);
		this._promptInput.placeholder = existing ? STR_PROMPT_PLACEHOLDER_EXISTING : STR_PROMPT_PLACEHOLDER;
		this._updateNamePlaceholder();
		this._updatePathPreview();
		if (!existing) {
			this._branchCombo.close();
			return;
		}
		void this._loadCandidates();
		// 開いたときではなく、切り替えたときに裏で取得する（取得中も前回の一覧で選べる）
		this._fetchOrigin(false);
		this._renderFetchStatus();
		if (fromUser) {
			this._branchCombo.focus();
			this._branchCombo.open();
		}
	}

	private _updateNamePlaceholder(): void {
		this._nameInput.placeholder = this._mode === 'existing' && this._choice && this._plan?.kind !== 'inUse' ? this._choice.name : STR_NAME_PLACEHOLDER;
	}

	/** 手元の refs から候補を読む（fetch はしない）。 */
	private async _loadCandidates(): Promise<void> {
		const repository = this._selectedRepository;
		if (!repository) {
			return;
		}
		try {
			const host = this.resolveGitHost(repository.uri);
			const candidates = await host.channel.call<IParadisBranchCandidates>('listBranchCandidates', [host.path(repository.uri)]);
			if (this._store.isDisposed || this._selectedRepository?.id !== repository.id) {
				return;
			}
			this._candidates = candidates;
			this._candidatesRepoId = repository.id;
		} catch (error) {
			if (this._store.isDisposed) {
				return;
			}
			this.logService.warn('[ParadisCreateWorktree] listing the branch candidates failed', error);
			this._showError(error);
		}
		this._renderCandidates();
		this._renderFetchStatus();
	}

	/** 裏で `git fetch --prune origin`。リポジトリごとに 1 回（再試行は `force`）。失敗しても手元の一覧で続ける。 */
	private _fetchOrigin(force: boolean): void {
		const repository = this._selectedRepository;
		if (!repository || this._mode !== 'existing' || this._fetchState === 'loading' && this._fetchRepoId === repository.id) {
			return;
		}
		if (!force && this._fetchRepoId === repository.id) {
			return;
		}
		this._fetchRepoId = repository.id;
		this._fetchState = 'loading';
		this._renderFetchStatus();
		void (async () => {
			let ok = false;
			try {
				// origin が無ければ取得しない（オフラインとも出さない）。候補がまだ無いときは先に読む
				const candidates = this._candidatesRepoId === repository.id ? this._candidates : undefined;
				if (candidates && !candidates.hasOrigin) {
					ok = true;
				} else {
					const host = this.resolveGitWriteHost(repository.uri);
					if (host) {
						// GIT_TERMINAL_PROMPT=0・GCM_INTERACTIVE=never と時間切れは runGit が持つ（認証を求める origin で止まらない）
						const result = await host.channel.call<IParadisWorktreeGitCommandResult>('runGit', [host.path(repository.uri), ['fetch', '--prune', '--quiet', 'origin']]);
						ok = result.code === 0;
						if (!ok) {
							this.logService.info('[ParadisCreateWorktree] fetching origin failed', result.stderr.trim());
						}
					}
				}
			} catch (error) {
				this.logService.info('[ParadisCreateWorktree] fetching origin failed', toErrorMessage(error));
			}
			if (this._store.isDisposed || this._fetchRepoId !== repository.id || this._selectedRepository?.id !== repository.id) {
				return;
			}
			this._fetchState = ok ? 'done' : 'failed';
			await this._loadCandidates();
			if (ok && this._choice) {
				// 取得し直したら、選んでいる 1 本の先行・遅れも取り直す
				void this._inspectChoice();
			}
		})();
	}

	private _renderFetchStatus(): void {
		const candidates = this._candidatesRepoId === this._selectedRepository?.id ? this._candidates : undefined;
		const noOrigin = candidates !== undefined && !candidates.hasOrigin;
		let icon: ThemeIcon | undefined;
		let text = '';
		let warning = false;
		if (!noOrigin) {
			if (this._fetchState === 'loading') {
				icon = ThemeIcon.modify(Codicon.loading, 'spin');
				text = STR_FETCHING;
			} else if (this._fetchState === 'failed') {
				icon = Codicon.warning;
				warning = true;
				text = candidates?.lastFetchedAt !== undefined && Date.now() - candidates.lastFetchedAt >= 60_000
					// allow-any-unicode-next-line
					? localize('paradis.createWorktree.fetchFailedAgo', "origin に接続できません。{0}に取得した一覧です", paradisFormatCrossJumpAgo(Date.now() - candidates.lastFetchedAt))
					// allow-any-unicode-next-line
					: localize('paradis.createWorktree.fetchFailed', "origin に接続できません。手元にある一覧です");
			} else if (this._fetchState === 'done') {
				icon = Codicon.check;
				text = STR_FETCHED;
			}
		}
		this._fetchStatusEl.classList.toggle('hidden', !icon);
		this._fetchStatusEl.classList.toggle('warning', warning);
		this._fetchStatusIcon.className = icon ? ThemeIcon.asClassName(icon) : '';
		this._fetchStatusText.textContent = text;
		this._fetchRetry.element.classList.toggle('hidden', !warning);
		this._branchCombo.setNotice(this._fetchState === 'loading' && !noOrigin
			? { icon: ThemeIcon.modify(Codicon.loading, 'spin'), text: STR_FETCHING_NOTICE }
			: warning ? { icon: Codicon.warning, text, warning: true, actionLabel: STR_RETRY } : undefined);
	}

	private _comboItemFor(source: ParadisExistingBranchSource, name: string): IParadisComboItem {
		const candidates = this._candidates;
		if (source === 'local') {
			const inUse = candidates?.inUse.some(entry => entry.branch === name);
			const local = candidates?.local.find(branch => branch.name === name);
			return {
				id: `local:${name}`, label: name, icon: Codicon.gitBranch,
				...(inUse ? { chip: STR_IN_USE_CHIP } : local?.committedAt ? { detail: paradisFormatCrossJumpAgo(Date.now() - local.committedAt) } : {}),
			};
		}
		const remote = candidates?.remote.find(branch => branch.name === name);
		const alsoLocal = candidates?.local.some(branch => branch.name === name);
		return {
			id: `origin:${name}`, label: name, prefix: 'origin/', icon: Codicon.cloud,
			// 狭い一覧で名前を削らないよう、右は 1 つだけ（同名のローカルがあればそれ、無ければ更新日時）
			...(alsoLocal ? { detail: STR_ALSO_LOCAL } : remote?.committedAt ? { detail: paradisFormatCrossJumpAgo(Date.now() - remote.committedAt) } : {}),
		};
	}

	private _renderCandidates(): void {
		const candidates = this._candidatesRepoId === this._selectedRepository?.id ? this._candidates : undefined;
		const groups: IParadisComboGroup[] = [];
		if (candidates) {
			groups.push({ label: STR_GROUP_LOCAL, icon: Codicon.gitBranch, items: candidates.local.map(branch => this._comboItemFor('local', branch.name)) });
			groups.push({ label: STR_GROUP_ORIGIN, icon: Codicon.cloud, items: candidates.remote.map(branch => this._comboItemFor('origin', branch.name)) });
		}
		const before = this._branchCombo.selected;
		this._branchCombo.setGroups(groups);
		// 取得し直して選んでいたブランチが消えていたら（prune）、選択を外す
		if (candidates && before && !this._branchCombo.selected) {
			this._clearChoice();
		}
	}

	private _onBranchChosen(item: IParadisComboItem): void {
		const source: ParadisExistingBranchSource = item.id.startsWith('origin:') ? 'origin' : 'local';
		this._choice = { source, name: item.label };
		this._syncChoice = undefined;
		// スペース名の既定はブランチ名
		this._updateNamePlaceholder();
		void this._inspectChoice();
	}

	private _clearChoice(): void {
		this._choice = undefined;
		this._choiceState = undefined;
		this._plan = undefined;
		this._syncChoice = undefined;
		this._inspectToken++;
		this._branchCombo.selected = undefined;
		this._renderBranchNote();
		this._updateNamePlaceholder();
		this._updatePathPreview();
	}

	/** 選んだ 1 本の先行・遅れと使用中を読み、どう開くかを出す。 */
	private async _inspectChoice(): Promise<void> {
		const repository = this._selectedRepository;
		const choice = this._choice;
		const token = ++this._inspectToken;
		this._choiceState = undefined;
		this._plan = undefined;
		this._renderBranchNote();
		this._updatePathPreview();
		if (!repository || !choice) {
			return;
		}
		try {
			const host = this.resolveGitHost(repository.uri);
			const state = await host.channel.call<IParadisExistingBranchState>('inspectExistingBranch', [host.path(repository.uri), choice.name]);
			if (this._store.isDisposed || token !== this._inspectToken) {
				return;
			}
			this._choiceState = state;
			this._plan = paradisPlanExistingBranch(choice.source, state);
			this._errorEl.textContent = '';
		} catch (error) {
			if (this._store.isDisposed || token !== this._inspectToken) {
				return;
			}
			this._showError(error);
		}
		this._renderBranchNote();
		this._updateNamePlaceholder();
		this._updatePathPreview();
	}

	/** 判定ごとの「origin に合わせる」の値。遅れているだけなら既定オン、分かれているなら既定オフ（捨てる操作なので）。 */
	private _syncEnabled(plan: ParadisExistingBranchPlan): boolean {
		return this._syncChoice ?? plan.kind === 'behind';
	}

	/** 選んだブランチをどう開くかの注意。 */
	private _renderBranchNote(): void {
		this._noteStore.clear();
		const note = this._branchNoteEl;
		dom.clearNode(note);
		note.className = 'pcw-d-branch-note';
		const choice = this._choice;
		if (this._mode !== 'existing' || !choice) {
			note.classList.add('hidden');
			return;
		}
		const plan = this._plan;
		const icon = dom.append(note, $('span'));
		icon.setAttribute('aria-hidden', 'true');
		const body = dom.append(note, $('.pcw-d-branch-note-body'));
		const line = (message: string, ...values: string[]) => paradisAppendWithCode(dom.append(body, $('span')), message, values);
		const sub = (message: string, ...values: string[]) => paradisAppendWithCode(dom.append(body, $('span.pcw-d-branch-note-sub')), message, values);
		const b = choice.name;
		if (!plan) {
			icon.className = ThemeIcon.asClassName(ThemeIcon.modify(Codicon.loading, 'spin'));
			line(STR_CHECKING);
			return;
		}
		icon.className = ThemeIcon.asClassName(plan.kind === 'behind' || plan.kind === 'diverged' || plan.kind === 'missing' ? Codicon.warning : Codicon.info);
		note.classList.toggle('warning', plan.kind === 'behind' || plan.kind === 'diverged' || plan.kind === 'missing');
		switch (plan.kind) {
			case 'track':
				// allow-any-unicode-next-line
				line(localize('paradis.createWorktree.note.track', "{0} を追跡するローカルブランチ {1} を作って開きます。"), `origin/${b}`, b);
				// allow-any-unicode-next-line
				sub(localize('paradis.createWorktree.note.trackSub', "新しいブランチは切りません。push すると origin の同じブランチに載ります。"));
				break;
			case 'open': {
				// allow-any-unicode-next-line
				line(localize('paradis.createWorktree.note.open', "ローカルのブランチ {0} をそのまま開きます。"), b);
				const state = this._choiceState;
				if (state?.remoteSha === undefined) {
					// allow-any-unicode-next-line
					sub(localize('paradis.createWorktree.note.localOnly', "origin には無いブランチです。"));
				} else if (plan.ahead > 0) {
					// allow-any-unicode-next-line
					sub(localize('paradis.createWorktree.note.ahead', "origin に無いコミットが {0} 件あります。", plan.ahead));
				} else if (state.behind > 0) {
					// allow-any-unicode-next-line
					sub(localize('paradis.createWorktree.note.localBehind', "origin より {0} コミット遅れています。origin に合わせるなら、origin の側を選んでください。", state.behind));
				}
				break;
			}
			case 'behind': {
				const on = this._syncEnabled(plan);
				// allow-any-unicode-next-line
				line(localize('paradis.createWorktree.note.behind', "同じ名前のローカルブランチ {0} があり、origin より {1} コミット遅れています。", '{0}', String(plan.behind)), b);
				// allow-any-unicode-next-line
				this._appendSyncCheck(body, localize('paradis.createWorktree.note.fastForward', "origin に合わせて進める（早送り。ローカルの変更は失われません）"), on, false);
				// allow-any-unicode-next-line
				sub(on ? localize('paradis.createWorktree.note.fastForwardOn', "ローカルの {0} を origin の位置まで進めてから開きます。") : localize('paradis.createWorktree.note.fastForwardOff', "ローカルの古い位置のまま開きます。"), b);
				break;
			}
			case 'diverged': {
				const on = this._syncEnabled(plan);
				// allow-any-unicode-next-line
				line(localize('paradis.createWorktree.note.diverged', "同じ名前のローカルブランチ {0} が origin と分かれています。ローカルだけに {1} コミット、origin だけに {2} コミットあります。", '{0}', String(plan.ahead), String(plan.behind)), b);
				// allow-any-unicode-next-line
				this._appendSyncCheck(body, localize('paradis.createWorktree.note.reset', "ローカルの {0} コミットを捨てて origin に合わせる", plan.ahead), on, true);
				sub(on
					// allow-any-unicode-next-line
					? localize('paradis.createWorktree.note.resetOn', "push していない {0} コミットは消えます（reflog から 30 日間は戻せます）。", plan.ahead)
					// allow-any-unicode-next-line
					: localize('paradis.createWorktree.note.resetOff', "ローカルのまま開きます。origin の {0} コミットは、開いた後に pull で取り込めます。", plan.behind));
				break;
			}
			case 'inUse': {
				const worktree = plan.inUse.main ? undefined : this._worktreeAt(plan.inUse.path);
				if (plan.inUse.main) {
					// allow-any-unicode-next-line
					line(localize('paradis.createWorktree.note.inUseMain', "{0} はメインのリポジトリ（{1}）で開いています。git では 1 つのブランチを 2 か所で開けません。"), b, this._selectedRepository?.name ?? '');
				} else {
					// allow-any-unicode-next-line
					line(localize('paradis.createWorktree.note.inUse', "{0} はスペース「{1}」で開いています。git では 1 つのブランチを 2 か所で開けません。", '{0}', worktree?.name ?? plan.inUse.path), b);
				}
				const actions = dom.append(body, $('.pcw-d-branch-note-actions'));
				const canSwitch = plan.inUse.main || worktree !== undefined;
				if (canSwitch) {
					const button = this._noteStore.add(new ParadisButton(actions, {
						kind: 'primary',
						small: true,
						// allow-any-unicode-next-line
						label: plan.inUse.main ? localize('paradis.createWorktree.switchToRepository', "リポジトリへ切り替える") : localize('paradis.createWorktree.switchToSpace', "そのスペースへ切り替える"),
					}));
					this._noteStore.add(button.onDidClick(() => this._switchToInUse(plan.inUse.main, worktree)));
				}
				break;
			}
			case 'missing':
				// allow-any-unicode-next-line
				line(localize('paradis.createWorktree.note.missing', "{0} が見つかりませんでした。一覧を取得し直してください。"), choice.source === 'origin' ? `origin/${b}` : b);
				break;
		}
	}

	private _appendSyncCheck(parent: HTMLElement, label: string, checked: boolean, danger: boolean): void {
		const check = this._noteStore.add(new ParadisCheck(parent, { label, checked }));
		check.element.classList.toggle('pcw-d-sync-danger', danger && checked);
		if (this._focusSyncCheck) {
			// 描き直した後もキーボードの操作を続けられるよう、新しいチェックへフォーカスを戻す
			this._focusSyncCheck = false;
			check.focus();
		}
		this._noteStore.add(check.onDidChange(value => {
			this._syncChoice = value;
			this._focusSyncCheck = true;
			this._renderBranchNote();
		}));
	}

	/** git の一覧のパスに当たるスペース（今知っているワークツリー）。 */
	private _worktreeAt(path: string): IParadisWorktree | undefined {
		const repository = this._selectedRepository;
		if (!repository) {
			return undefined;
		}
		const host = this.resolveGitHost(repository.uri);
		const normalize = (value: string) => value.replace(/[\\/]+$/, '');
		return this.worktreeService.getDetectedWorktrees(repository.id).find(worktree => normalize(host.path(worktree.uri)) === normalize(path));
	}

	private _switchToInUse(main: boolean, worktree: IParadisWorktree | undefined): void {
		const repository = this._selectedRepository;
		this.dispose();
		if (main && repository) {
			void this.switchService.switchRepository(repository.id);
		} else if (worktree) {
			void this.switchService.switchToWorktree(worktree);
		}
	}
}

/** `{0}` などの所に値を `<code>` で差し込む（翻訳の文に名前を埋めるため。値は textContent で入れる）。 */
function paradisAppendWithCode(parent: HTMLElement, message: string, values: readonly string[]): void {
	const parts = message.split(/\{(?<index>\d+)\}/);
	parts.forEach((part, position) => {
		if (position % 2 === 0) {
			if (part) {
				parent.appendChild(dom.getWindow(parent).document.createTextNode(part));
			}
			return;
		}
		const value = values[Number(part)];
		if (value !== undefined) {
			dom.append(parent, $('code')).textContent = value;
		}
	});
}
