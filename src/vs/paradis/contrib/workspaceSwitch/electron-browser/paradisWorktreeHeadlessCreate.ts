/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

// モバイルアプリ等、ダイアログUIを経由しない「新しいスペース（worktree）作成」の
// ヘッドレス実装。paradisCreateWorktreeDialog.ts の _doCreate と同じオーケストレーション
// （ブランチ命名: 手入力 > Copilot小型モデル > 決定的フォールバック → git worktree add →
// スペース切り替え → setup → 自動実行プリセット → エージェント起動）を、
// フォーム値を引数で受け取って実行する。UIへの依存（DOM・通知・レイアウト）を持たないため、
// paradisMobileWorkspaceProvider から instantiationService.invokeFunction で直接呼べる。

import { raceTimeout } from '../../../../base/common/async.js';
import { CancellationTokenSource } from '../../../../base/common/cancellation.js';
import { toErrorMessage } from '../../../../base/common/errorMessage.js';
import { basename, dirname, joinPath } from '../../../../base/common/resources.js';
import { URI } from '../../../../base/common/uri.js';
import { IConfigurationService } from '../../../../platform/configuration/common/configuration.js';
import { IFileService } from '../../../../platform/files/common/files.js';
import { IInstantiationService, ServicesAccessor } from '../../../../platform/instantiation/common/instantiation.js';
import { ISharedProcessService } from '../../../../platform/ipc/electron-browser/services.js';
import { ILogService } from '../../../../platform/log/common/log.js';
import { TerminalLocation } from '../../../../platform/terminal/common/terminal.js';
import { ChatMessageRole, getTextResponseFromStream, ILanguageModelsService } from '../../../../workbench/contrib/chat/common/languageModels.js';
import { ITerminalGroupService, ITerminalService } from '../../../../workbench/contrib/terminal/browser/terminal.js';
import { paradisRunAutoRunPresets } from '../../terminalPresets/browser/paradisTerminalPresets.contribution.js';
import { IParadisTerminalScopeService, IParadisWorkspaceRepository, IParadisWorkspaceSwitchService, IParadisWorktree, IParadisWorktreeService, paradisWorktreeStateKey } from '../common/paradisWorkspaceSwitch.js';
import {
	IParadisAgentCommandTemplate,
	IParadisGitBranches,
	PARADIS_DEFAULT_AGENT_COMMANDS,
	PARADIS_WORKTREE_GIT_CHANNEL,
	paradisBuildAgentCommand,
	paradisBuildWorktreeNames,
	paradisDeduplicateBranchName,
	paradisSanitizeBranchName,
	paradisShouldCreateDefaultTerminal,
} from '../common/paradisWorktreeCreate.js';
import { paradisCompleteCreatedWorktree } from './paradisCreateWorktreeDialog.js';
import { paradisReadWorkspaceLifecycleConfig, paradisRunWorkspaceLifecycleScript } from './paradisWorkspaceLifecycleService.js';

/** LLM 命名の待ち時間上限（ダイアログ側 NAMING_TIMEOUT_MS と同値）。 */
const NAMING_TIMEOUT_MS = 8000;

/** 作成フォームの材料（モバイルの作成シート・エージェント起動シートが選択肢を組み立てるのに使う）。 */
export interface IParadisWorktreeCreateFormData {
	/** setupScript はリポジトリ直下の .paracode.json 定義（モバイル側のトグル表示用。無ければ未定義）。 */
	readonly repos: { id: string; name: string; branches: string[]; head?: string; setupScript?: string }[];
	/** エージェント定義一式（コマンドテンプレート・モデル/エフォート/権限の選択肢を含む）。 */
	readonly agents: IParadisAgentCommandTemplate[];
}

/** ヘッドレス作成の要求。ダイアログのフォーム値に対応する。 */
export interface IParadisHeadlessWorktreeRequest {
	readonly repositoryId: string;
	/** スペース名（表示名・任意。空ならディレクトリ名を流用）。 */
	readonly name?: string;
	/** ブランチ名（任意。空なら prompt からのLLM生成 → 決定的フォールバック）。 */
	readonly branch?: string;
	/** ベースブランチ（任意。空ならメインチェックアウトの現在ブランチ）。 */
	readonly baseRef?: string;
	/** エージェントへの指示（任意。ブランチ名の自動生成にも使う）。 */
	readonly prompt?: string;
	/** 起動するエージェントID（'none' または未指定で起動しない）。 */
	readonly agentId?: string;
	/** エージェント起動時のモデル（エージェント定義の models の id。未指定 = 既定 = フラグなし）。 */
	readonly modelId?: string;
	/** エージェント起動時のエフォート（エージェント定義の efforts の id。未指定 = 既定）。 */
	readonly effortId?: string;
	/** エージェント起動時の権限モード（エージェント定義の permissions の id。未指定 = 既定）。 */
	readonly permissionId?: string;
	/** false でリポジトリ定義の setup スクリプトをスキップする（既定 true）。 */
	readonly runSetup?: boolean;
}

export interface IParadisHeadlessWorktreeResult {
	readonly name: string;
	readonly branch: string;
	/** worktree自体は作成できたが後続（setup・エージェント起動等）が失敗した場合の警告。 */
	readonly warning?: string;
}

/** 作成フローの進行段階。キューサービスがトースト/サイドバーの工程表示に使う。 */
export type ParadisWorktreeCreateStage = 'naming' | 'creating' | 'setup' | 'starting';

/** バックグラウンド作成時に進行状況を受け取るコールバック。 */
export interface IParadisWorktreeCreateFlowCallbacks {
	/** 各工程の開始時に呼ばれる。 */
	onStage?(stage: ParadisWorktreeCreateStage): void;
	/** ブランチ名（＝表示名）が確定した時点で呼ばれる。LLM生成の完了を待つため naming の後になる。 */
	onNameResolved?(name: string, branch: string): void;
}

export interface IParadisWorktreeCreateFlowOptions {
	/** true なら作成完了後に新スペースへ切り替える（従来のダイアログ/モバイルの挙動）。 */
	readonly switchToCreated: boolean;
	readonly callbacks?: IParadisWorktreeCreateFlowCallbacks;
}

export interface IParadisWorktreeCreateFlowResult extends IParadisHeadlessWorktreeResult {
	/** 作成された worktree（完了通知の「切り替える」アクションに使う）。 */
	readonly worktree: IParadisWorktree;
}

/** 設定 paradis.workspaceSwitch.agents（無ければ既定）からエージェント定義を得る（ダイアログの _agents と同じ規則）。 */
export function paradisConfiguredAgents(configurationService: IConfigurationService): readonly IParadisAgentCommandTemplate[] {
	const configured = configurationService.getValue<IParadisAgentCommandTemplate[]>('paradis.workspaceSwitch.agents');
	if (Array.isArray(configured) && configured.length > 0) {
		return configured.filter(agent => agent && typeof agent.id === 'string' && agent.id !== 'none' && typeof agent.command === 'string');
	}
	return PARADIS_DEFAULT_AGENT_COMMANDS;
}

/** worktree の作成先ディレクトリを決める（ダイアログの _computeWorktreeUri と同じ規則）。 */
function computeWorktreeUri(configurationService: IConfigurationService, repository: IParadisWorkspaceRepository, dirName: string): URI {
	const configuredRoot = (configurationService.getValue<string>('paradis.workspaceSwitch.worktreeRoot') ?? '').trim();
	if (configuredRoot.length > 0) {
		return joinPath(URI.file(configuredRoot), basename(repository.uri), dirName);
	}
	return joinPath(dirname(repository.uri), `${basename(repository.uri)}-worktrees`, dirName);
}

/** Copilot の小型モデルでプロンプトからブランチ名を生成する（ダイアログの _generateBranchName と同じ規則）。 */
async function generateBranchName(languageModelsService: ILanguageModelsService, logService: ILogService, prompt: string): Promise<string | undefined> {
	try {
		const modelIds = await languageModelsService.selectLanguageModels({ vendor: 'copilot', id: 'copilot-utility-small' });
		if (modelIds.length === 0) {
			return undefined;
		}
		const cts = new CancellationTokenSource();
		try {
			const request = (async () => {
				const response = await languageModelsService.sendChatRequest(modelIds[0], undefined, [{
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
		logService.info('[ParadisWorktreeHeadlessCreate] LLM naming unavailable, falling back', error);
		return undefined;
	}
}

/** LLM が使えない場合の決定的なフォールバック名（ダイアログの _fallbackBranchName と同じ規則）。 */
function fallbackBranchName(): string {
	const now = new Date();
	const pad = (value: number) => String(value).padStart(2, '0');
	return `para-${pad(now.getMonth() + 1)}${pad(now.getDate())}-${pad(now.getHours())}${pad(now.getMinutes())}`;
}

/** 作成フォームの材料（リポジトリ一覧＋各ブランチ＋エージェント定義）を集める。 */
export async function paradisGetWorktreeCreateForm(accessor: ServicesAccessor): Promise<IParadisWorktreeCreateFormData> {
	const switchService = accessor.get(IParadisWorkspaceSwitchService);
	const sharedProcessService = accessor.get(ISharedProcessService);
	const configurationService = accessor.get(IConfigurationService);
	const fileService = accessor.get(IFileService);
	const logService = accessor.get(ILogService);
	const channel = sharedProcessService.getChannel(PARADIS_WORKTREE_GIT_CHANNEL);
	const repos = await Promise.all(switchService.repositories.map(async r => {
		let branches: IParadisGitBranches = { branches: [], head: undefined };
		try {
			branches = await channel.call<IParadisGitBranches>('listBranches', [r.uri.fsPath]);
		} catch (error) {
			logService.warn('[ParadisWorktreeHeadlessCreate] listBranches failed', r.name, error);
		}
		// setupスクリプトの有無と内容（モバイルの「setupスクリプトを実行」トグルの表示材料）。
		// 読み取り失敗は「無し」扱いでフォーム本体を巻き添えにしない。
		let setupScript: string | undefined;
		try {
			setupScript = (await paradisReadWorkspaceLifecycleConfig(fileService, r.uri)).setupScript?.trim() || undefined;
		} catch (error) {
			logService.warn('[ParadisWorktreeHeadlessCreate] read lifecycle config failed', r.name, error);
		}
		return {
			id: r.id, name: r.name, branches: [...branches.branches],
			...(branches.head !== undefined ? { head: branches.head } : {}),
			...(setupScript !== undefined ? { setupScript } : {}),
		};
	}));
	// エージェント定義はテンプレートごと渡す（モバイル側がモデル/エフォート/権限の選択UIと
	// コマンドプレビューをPC側と同じ材料で組み立てるため）。設定由来のplain JSONなのでそのまま送れる。
	const agents = paradisConfiguredAgents(configurationService).map(agent => ({ ...agent }));
	return { repos, agents };
}

/** 既存ワークスペース（スペース）へのエージェント起動要求（モバイルの起動シートから）。 */
export interface IParadisAgentLaunchInWorkspaceRequest {
	/** 起動先のルートディレクトリ。 */
	readonly rootUri: URI;
	/** ワークスペースの状態キー（リポジトリid または worktree:...）。ターミナルのスコープ付けに使う。 */
	readonly stateKey: string;
	readonly agentId: string;
	readonly prompt?: string;
	readonly modelId?: string;
	readonly effortId?: string;
	readonly permissionId?: string;
}

/**
 * 既存ワークスペースに新しいターミナルを作り、エージェントCLIを起動する。
 * worktree作成フローの launchAgent 工程と同じ規則（パネル側に作成・非アクティブスコープは
 * assignInstanceScope で即park・paneトークン自動注入で稼働状態表示が効く）で、
 * ワークスペース作成を伴わない分だけを切り出したもの。
 */
export async function paradisLaunchAgentInWorkspace(accessor: ServicesAccessor, request: IParadisAgentLaunchInWorkspaceRequest): Promise<void> {
	const configurationService = accessor.get(IConfigurationService);
	const terminalService = accessor.get(ITerminalService);
	const terminalGroupService = accessor.get(ITerminalGroupService);
	const terminalScopeService = accessor.get(IParadisTerminalScopeService);
	const switchService = accessor.get(IParadisWorkspaceSwitchService);
	const logService = accessor.get(ILogService);
	const agent = paradisConfiguredAgents(configurationService).find(candidate => candidate.id === request.agentId);
	if (!agent) {
		throw new Error(`unknown agent: ${request.agentId}`);
	}
	const instance = await terminalService.createTerminal({
		cwd: request.rootUri,
		location: TerminalLocation.Panel,
	});
	if (request.stateKey !== switchService.activeStateKey) {
		// PC側で非表示のワークスペース向け: スコープを付け替えて即parkさせる（表示を乱さない）
		terminalScopeService.assignInstanceScope(instance.instanceId, request.stateKey);
	} else {
		// PCのアクティブワークスペース向け: モバイル発の新規ターミナル作成と同様にアクティブ化して
		// パネルを表示する（表示失敗は起動自体の失敗にしない）
		terminalService.setActiveInstance(instance);
		try {
			await terminalGroupService.showPanel(false);
		} catch (error) {
			logService.warn('[ParadisWorktreeHeadlessCreate] showPanel failed', error);
		}
	}
	await instance.processReady;
	const command = paradisBuildAgentCommand(agent, (request.prompt ?? '').trim(), instance.shellType, {
		modelId: request.modelId,
		effortId: request.effortId,
		permissionId: request.permissionId,
	});
	await instance.sendText(command, true);
}

/**
 * worktree（スペース）をヘッドレスに作成する。成功時は表示名と確定ブランチ名を返す。
 * worktree作成後の後続処理（setup・自動実行・エージェント起動）の失敗は warning として
 * 返し、作成自体は成功扱いにする（ダイアログの「作成されましたが〜」通知と同じ方針）。
 * モバイル発の作成では従来どおり作成後に新スペースへ切り替える。
 */
export async function paradisCreateWorktreeHeadless(accessor: ServicesAccessor, request: IParadisHeadlessWorktreeRequest): Promise<IParadisHeadlessWorktreeResult> {
	return paradisRunWorktreeCreateFlow(accessor, request, { switchToCreated: true });
}

/**
 * worktree 作成フローの本体。ダイアログ発のバックグラウンド作成（キューサービス）と
 * モバイル発のヘッドレス作成の両方から使う。switchToCreated が false の場合は現在の
 * スペースに留まったまま作成し、ターミナルはスコープ割り当てにより新スペース側へ park される。
 */
export async function paradisRunWorktreeCreateFlow(accessor: ServicesAccessor, request: IParadisHeadlessWorktreeRequest, options: IParadisWorktreeCreateFlowOptions): Promise<IParadisWorktreeCreateFlowResult> {
	const switchService = accessor.get(IParadisWorkspaceSwitchService);
	const worktreeService = accessor.get(IParadisWorktreeService);
	const sharedProcessService = accessor.get(ISharedProcessService);
	const configurationService = accessor.get(IConfigurationService);
	const languageModelsService = accessor.get(ILanguageModelsService);
	const terminalService = accessor.get(ITerminalService);
	const terminalScopeService = accessor.get(IParadisTerminalScopeService);
	const instantiationService = accessor.get(IInstantiationService);
	const logService = accessor.get(ILogService);

	const repository = switchService.repositories.find(r => r.id === request.repositoryId);
	if (!repository) {
		throw new Error(`unknown repository: ${request.repositoryId}`);
	}
	const prompt = (request.prompt ?? '').trim();
	const agentId = request.agentId && request.agentId.length > 0 ? request.agentId : 'none';

	// ベースブランチと重複回避に使う既存ブランチ一覧（取得失敗時は空扱いで進める）
	let branchesInfo: IParadisGitBranches = { branches: [], head: undefined };
	try {
		branchesInfo = await sharedProcessService.getChannel(PARADIS_WORKTREE_GIT_CHANNEL).call<IParadisGitBranches>('listBranches', [repository.uri.fsPath]);
	} catch (error) {
		logService.warn('[ParadisWorktreeHeadlessCreate] listBranches failed', error);
	}
	const baseRef = (request.baseRef ?? '').trim() || branchesInfo.head;
	if (!baseRef) {
		throw new Error('base branch is not specified and HEAD is detached');
	}

	const callbacks = options.callbacks;

	// 1. ブランチ名の決定（手入力 > LLM > フォールバック）
	let branch = paradisSanitizeBranchName(request.branch ?? '');
	if (!branch) {
		if (prompt.length > 0) {
			callbacks?.onStage?.('naming');
			branch = await generateBranchName(languageModelsService, logService, prompt);
		}
		branch = branch ?? fallbackBranchName();
	}
	branch = paradisDeduplicateBranchName(branch, branchesInfo.branches);

	// 2. worktree 作成
	callbacks?.onStage?.('creating');
	const existingDirNames = worktreeService.getDetectedWorktrees(repository.id).map(worktree => basename(worktree.uri));
	const { displayName, dirName } = paradisBuildWorktreeNames(request.name ?? '', branch, branchesInfo.branches, existingDirNames);
	callbacks?.onNameResolved?.(displayName, branch);
	const worktreeUri = computeWorktreeUri(configurationService, repository, dirName);
	// ダイアログ実装と同じく、これから作るターミナルを常にこのworktreeへ明示的に紐付ける
	const targetStateKey = paradisWorktreeStateKey(worktreeUri);
	await sharedProcessService.getChannel(PARADIS_WORKTREE_GIT_CHANNEL).call('addWorktree', [{
		repoPath: repository.uri.fsPath,
		worktreePath: worktreeUri.fsPath,
		newBranch: branch,
		baseRef,
	}]);

	const createdWorktree: IParadisWorktree = {
		repositoryId: repository.id,
		name: displayName,
		branch,
		uri: worktreeUri,
	};
	worktreeService.addKnownWorktree(createdWorktree);

	try {
		// 3. 新スペースへ切り替え（モバイル発・従来ダイアログ相当の挙動）。バックグラウンド作成
		//    （ダイアログ発のキュー実行）では切り替えず、現在のスペースに留まる
		if (options.switchToCreated) {
			await switchService.switchToWorktree(createdWorktree);
		}

		// 4. setup → 自動実行プリセット →（なければ既定ターミナル）→ エージェント起動
		await paradisCompleteCreatedWorktree({
			runSetup: async () => {
				if (request.runSetup === false) {
					return;
				}
				callbacks?.onStage?.('setup');
				await instantiationService.invokeFunction(paradisRunWorkspaceLifecycleScript, 'setup', repository, worktreeUri);
			},
			runAutoRun: async () => {
				callbacks?.onStage?.('starting');
				try {
					return await instantiationService.invokeFunction(paradisRunAutoRunPresets, worktreeUri, repository.uri.fsPath, targetStateKey);
				} catch (error) {
					logService.warn('[ParadisWorktreeHeadlessCreate] auto-run presets failed', error);
					return false;
				}
			},
			openDefaultTerminal: async () => {
				if (!paradisShouldCreateDefaultTerminal(agentId, prompt)) {
					return;
				}
				const instance = await terminalService.createTerminal({
					cwd: worktreeUri,
					location: TerminalLocation.Panel,
				});
				terminalScopeService.assignInstanceScope(instance.instanceId, targetStateKey);
			},
			launchAgent: async () => {
				const agent = paradisConfiguredAgents(configurationService).find(candidate => candidate.id === agentId);
				if (!agent) {
					return;
				}
				// ダイアログ発の従来実装はエディタ領域ターミナルを使っていたが、ヘッドレス・
				// バックグラウンド作成ではエディタレイアウトへの依存を避けてパネル側に作る。
				// 非アクティブスコープへの assignInstanceScope は即座に park されるため、
				// 現在のスペースの表示は乱れない。paneトークンは同様に自動注入されるため、
				// 稼働状態表示（Workspaces ビュー/モバイルのホーム一覧）はそのまま効く。
				const instance = await terminalService.createTerminal({
					cwd: worktreeUri,
					location: TerminalLocation.Panel,
				});
				terminalScopeService.assignInstanceScope(instance.instanceId, targetStateKey);
				await instance.processReady;
				const command = paradisBuildAgentCommand(agent, prompt, instance.shellType, {
					modelId: request.modelId,
					effortId: request.effortId,
					permissionId: request.permissionId,
				});
				await instance.sendText(command, true);
			},
		});
	} catch (error) {
		logService.error('[ParadisWorktreeHeadlessCreate] post-create steps failed', error);
		return { name: displayName, branch, warning: toErrorMessage(error), worktree: createdWorktree };
	}
	return { name: displayName, branch, worktree: createdWorktree };
}
