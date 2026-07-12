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
import { IInstantiationService, ServicesAccessor } from '../../../../platform/instantiation/common/instantiation.js';
import { ISharedProcessService } from '../../../../platform/ipc/electron-browser/services.js';
import { ILogService } from '../../../../platform/log/common/log.js';
import { TerminalLocation } from '../../../../platform/terminal/common/terminal.js';
import { ChatMessageRole, getTextResponseFromStream, ILanguageModelsService } from '../../../../workbench/contrib/chat/common/languageModels.js';
import { ITerminalService } from '../../../../workbench/contrib/terminal/browser/terminal.js';
import { paradisRunAutoRunPresets } from '../../terminalPresets/browser/paradisTerminalPresets.contribution.js';
import { IParadisTerminalScopeService, IParadisWorkspaceRepository, IParadisWorkspaceSwitchService, IParadisWorktreeService, paradisWorktreeStateKey } from '../common/paradisWorkspaceSwitch.js';
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
import { paradisRunWorkspaceLifecycleScript } from './paradisWorkspaceLifecycleService.js';

/** LLM 命名の待ち時間上限（ダイアログ側 NAMING_TIMEOUT_MS と同値）。 */
const NAMING_TIMEOUT_MS = 8000;

/** 作成フォームの材料（モバイルの作成シートが選択肢を組み立てるのに使う）。 */
export interface IParadisWorktreeCreateFormData {
	readonly repos: { id: string; name: string; branches: string[]; head?: string }[];
	readonly agents: { id: string; label: string }[];
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
}

export interface IParadisHeadlessWorktreeResult {
	readonly name: string;
	readonly branch: string;
	/** worktree自体は作成できたが後続（setup・エージェント起動等）が失敗した場合の警告。 */
	readonly warning?: string;
}

/** 設定 paradis.workspaceSwitch.agents（無ければ既定）からエージェント定義を得る（ダイアログの _agents と同じ規則）。 */
function configuredAgents(configurationService: IConfigurationService): readonly IParadisAgentCommandTemplate[] {
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
	const logService = accessor.get(ILogService);
	const channel = sharedProcessService.getChannel(PARADIS_WORKTREE_GIT_CHANNEL);
	const repos = await Promise.all(switchService.repositories.map(async r => {
		let branches: IParadisGitBranches = { branches: [], head: undefined };
		try {
			branches = await channel.call<IParadisGitBranches>('listBranches', [r.uri.fsPath]);
		} catch (error) {
			logService.warn('[ParadisWorktreeHeadlessCreate] listBranches failed', r.name, error);
		}
		return { id: r.id, name: r.name, branches: [...branches.branches], ...(branches.head !== undefined ? { head: branches.head } : {}) };
	}));
	const agents = configuredAgents(configurationService).map(agent => ({ id: agent.id, label: agent.label }));
	return { repos, agents };
}

/**
 * worktree（スペース）をヘッドレスに作成する。成功時は表示名と確定ブランチ名を返す。
 * worktree作成後の後続処理（setup・自動実行・エージェント起動）の失敗は warning として
 * 返し、作成自体は成功扱いにする（ダイアログの「作成されましたが〜」通知と同じ方針）。
 */
export async function paradisCreateWorktreeHeadless(accessor: ServicesAccessor, request: IParadisHeadlessWorktreeRequest): Promise<IParadisHeadlessWorktreeResult> {
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

	// 1. ブランチ名の決定（手入力 > LLM > フォールバック）
	let branch = paradisSanitizeBranchName(request.branch ?? '');
	if (!branch) {
		if (prompt.length > 0) {
			branch = await generateBranchName(languageModelsService, logService, prompt);
		}
		branch = branch ?? fallbackBranchName();
	}
	branch = paradisDeduplicateBranchName(branch, branchesInfo.branches);

	// 2. worktree 作成
	const existingDirNames = worktreeService.getDetectedWorktrees(repository.id).map(worktree => basename(worktree.uri));
	const { displayName, dirName } = paradisBuildWorktreeNames(request.name ?? '', branch, branchesInfo.branches, existingDirNames);
	const worktreeUri = computeWorktreeUri(configurationService, repository, dirName);
	// ダイアログ実装と同じく、これから作るターミナルを常にこのworktreeへ明示的に紐付ける
	const targetStateKey = paradisWorktreeStateKey(worktreeUri);
	await sharedProcessService.getChannel(PARADIS_WORKTREE_GIT_CHANNEL).call('addWorktree', [{
		repoPath: repository.uri.fsPath,
		worktreePath: worktreeUri.fsPath,
		newBranch: branch,
		baseRef,
	}]);

	worktreeService.addKnownWorktree({
		repositoryId: repository.id,
		name: displayName,
		branch,
		uri: worktreeUri,
	});

	try {
		// 3. 新スペースへ切り替え（PC版ダイアログと同じ挙動。モバイルのホーム一覧も追従する）
		await switchService.switchToWorktree({
			repositoryId: repository.id,
			name: displayName,
			branch,
			uri: worktreeUri,
		});

		// 4. setup → 自動実行プリセット →（なければ既定ターミナル）→ エージェント起動
		await paradisCompleteCreatedWorktree({
			runSetup: async () => {
				await instantiationService.invokeFunction(paradisRunWorkspaceLifecycleScript, 'setup', repository, worktreeUri);
			},
			runAutoRun: async () => {
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
				const agent = configuredAgents(configurationService).find(candidate => candidate.id === agentId);
				if (!agent || prompt.length === 0) {
					return;
				}
				// ダイアログはエディタ領域ターミナルを使うが、ヘッドレス（モバイル発）では
				// エディタレイアウトへの依存を避けてパネル側に作る。paneトークンは同様に
				// 自動注入されるため、ホーム一覧の稼働状態表示はそのまま効く。
				const instance = await terminalService.createTerminal({
					cwd: worktreeUri,
					location: TerminalLocation.Panel,
				});
				terminalScopeService.assignInstanceScope(instance.instanceId, targetStateKey);
				await instance.processReady;
				const command = paradisBuildAgentCommand(agent, prompt, instance.shellType);
				await instance.sendText(command, true);
			},
		});
	} catch (error) {
		logService.error('[ParadisWorktreeHeadlessCreate] post-create steps failed', error);
		return { name: displayName, branch, warning: toErrorMessage(error) };
	}
	return { name: displayName, branch };
}
