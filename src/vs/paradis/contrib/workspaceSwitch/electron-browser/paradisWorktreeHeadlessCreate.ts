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
import { paradisResolveExternalPath } from '../../../common/paradisPathUri.js';
import { paradisResolveWslAgentHome } from '../../../common/paradisWslAgentHome.js';
import { IConfigurationService } from '../../../../platform/configuration/common/configuration.js';
import { IFileService } from '../../../../platform/files/common/files.js';
import { IInstantiationService, ServicesAccessor } from '../../../../platform/instantiation/common/instantiation.js';
import { ISharedProcessService } from '../../../../platform/ipc/electron-browser/services.js';
import { ILogService } from '../../../../platform/log/common/log.js';
import { TerminalLocation } from '../../../../platform/terminal/common/terminal.js';
import { ChatMessageRole, getTextResponseFromStream, ILanguageModelsService } from '../../../../workbench/contrib/chat/common/languageModels.js';
import { IAuthenticationService } from '../../../../workbench/services/authentication/common/authentication.js';
import { ITerminalEditorService, ITerminalService } from '../../../../workbench/contrib/terminal/browser/terminal.js';
import {
	IParadisCopilotUtilityRequest,
	IParadisCopilotUtilityResult,
	PARADIS_COPILOT_UTILITY_CHANNEL,
} from '../../copilotUtility/common/paradisCopilotUtility.js';
import { paradisRunAutoRunPresets } from '../../terminalPresets/browser/paradisTerminalPresets.contribution.js';
import { IParadisTerminalScopeService, IParadisWorkspaceRepository, IParadisWorkspaceSwitchService, IParadisWorktree, IParadisWorktreeService, paradisWorktreeStateKey } from '../common/paradisWorkspaceSwitch.js';
import {
	IParadisAgentCommandTemplate,
	IParadisGitBranches,
	PARADIS_DEFAULT_AGENT_COMMANDS,
	PARADIS_WORKTREE_GIT_CHANNEL,
	paradisBuildAgentCommand,
	paradisBuildWorktreeNames,
	paradisParseWorktreeNaming,
	paradisToBranchName,
	paradisToWorktreeTitle,
	paradisDeduplicateBranchName,
	paradisSanitizeBranchName,
	paradisShouldCreateDefaultTerminal,
} from '../common/paradisWorktreeCreate.js';
import { paradisCompleteCreatedWorktree } from './paradisCreateWorktreeDialog.js';
import { paradisReadWorkspaceLifecycleConfig, paradisRunWorkspaceLifecycleScript } from './paradisWorkspaceLifecycleService.js';
import { PARADIS_RESUME_SESSION_ID_PATTERN, ParadisResumeAgent } from '../../sessionResume/common/paradisSessionResume.js';

/**
 * 命名にかけてよい合計時間。ここを過ぎたらフォールバック名で worktree 作成へ進む。
 *
 * 2経路を直列に試すので、前段が食い潰すと後段が実質0秒になる。前段には別途の上限を持たせて、
 * 残りを後段に回す。
 */
const NAMING_TOTAL_TIMEOUT_MS = 10_000;
/** Copilot API 経路（1段目）の上限。初回はエンドポイント探索とトークン発行で往復が増える。 */
const NAMING_COPILOT_TIMEOUT_MS = 5_000;
/** 残り時間がこれを下回ったら2段目は起動しない（結果を待てないリクエストを投げるだけになる）。 */
const NAMING_MIN_REMAINING_MS = 1_000;

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
	/** `git worktree add` が完了し、一覧に実体の行が出せるようになった時点で呼ばれる。 */
	onWorktreeCreated?(stateKey: string): void;
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
		// 設定値はリポジトリと同じ名前空間で解決する (ダイアログ側の _computeWorktreeUri と同じ理由)
		const root = paradisResolveExternalPath(dirname(repository.uri), configuredRoot);
		if (root) {
			return joinPath(root, basename(repository.uri), dirName);
		}
	}
	return joinPath(dirname(repository.uri), `${basename(repository.uri)}-worktrees`, dirName);
}

// 見出しは一覧の表示専用なので日本語にする。ブランチ名は git の ref と worktree のディレクトリ名に
// なるため ASCII のままにすること（日本語ディレクトリは Windows やツールチェーンで事故る）。
// 2行を1回の応答で返させて、往復を増やさずに両方を得る。
const WORKTREE_NAMING_INSTRUCTION = [
	'Name a development task. Reply with exactly two lines and nothing else:',
	'Title: a short natural title for the task, in the same language as the task description, at most 20 characters, no quotes, no markdown, no trailing punctuation',
	'Branch: a git branch name, kebab-case, lowercase ascii letters/digits/hyphens, at most 30 characters, no quotes, no slashes',
].join('\n');

/** Copilot へ送る依頼文の上限。長い依頼文ほど命名が効かない、という逆転を避けるために切り詰める。 */
const NAMING_PROMPT_MAX_CHARS = 2_000;

/** 命名モデルの1回の応答を、表示用の見出しと git ブランチ名へ分解する。 */
interface IParadisWorktreeNaming {
	/** 一覧に出す見出し（日本語）。整形できなければ undefined。 */
	readonly title?: string;
	/** git ブランチ名。ブランチ名として使えなければ undefined。 */
	readonly branch?: string;
}

/**
 * 応答を見出しとブランチ名に割り、それぞれの制約で整える。
 *
 * ブランチ名が取れなかった応答も見出しだけは返す。ブランチ名は日付フォールバックで必ず作れる一方、
 * 見出しは他に作りようがないので、片方が駄目でももう片方を捨てない。
 */
function toWorktreeNaming(text: string | undefined): IParadisWorktreeNaming | undefined {
	const parsed = paradisParseWorktreeNaming(text);
	const title = paradisToWorktreeTitle(parsed.title);
	const branch = paradisToBranchName(parsed.branch);
	return title === undefined && branch === undefined ? undefined : { title, branch };
}

/**
 * GitHub のトークンで Copilot の小型モデルを直接叩いてブランチ名を作る。
 *
 * renderer の ILanguageModelsService（vendor: 'copilot'）は Copilot Chat 拡張がモデルを登録し終えて
 * いないと黙って0件を返し、GitHub にログイン済みでも命名が効かないことがある。こちらは shared process
 * 側で CAPI を直接叩く（コミットメッセージ生成と同じ経路）ので、拡張の起動状態に左右されない。
 */
async function generateWorktreeNamingViaCopilotApi(
	authenticationService: IAuthenticationService,
	sharedProcessService: ISharedProcessService,
	logService: ILogService,
	prompt: string,
): Promise<IParadisWorktreeNaming | undefined> {
	try {
		const githubToken = await paradisFindGithubAccessToken(authenticationService);
		if (!githubToken) {
			return undefined;
		}
		const result = await sharedProcessService.getChannel(PARADIS_COPILOT_UTILITY_CHANNEL)
			.call<IParadisCopilotUtilityResult>('complete', [{
				githubToken,
				messages: [
					{ role: 'system', content: WORKTREE_NAMING_INSTRUCTION },
					{ role: 'user', content: `Task: ${prompt.slice(0, NAMING_PROMPT_MAX_CHARS)}` },
				],
			} satisfies IParadisCopilotUtilityRequest]);
		return toWorktreeNaming(result?.text);
	} catch (error) {
		logService.info('[ParadisWorktreeHeadlessCreate] Copilot API naming unavailable, falling back', error);
		return undefined;
	}
}

/** Copilot のセッショントークン発行に必要なスコープ（platform/agentHost の gitHubCopilotResource と同じ）。 */
const GITHUB_COPILOT_SCOPES = ['read:user', 'user:email'];

/**
 * ログイン済みの GitHub セッションから、Copilot に使えそうなアクセストークンを1つ選ぶ。
 *
 * スコープ指定の `getSessions` は**完全一致**（github-authentication の実装）なので、ちょうど
 * `read:user`+`user:email` のセッションを探しても普通は0件になる。かといって「両方を含むもの」に
 * 絞ると、`read:user` だけのセッション（Copilot 系の拡張が作る典型形）まで落ちてしまう。
 * そこで絞り込まず、必要スコープの一致数で並べて一番近いものを採る。
 *
 * 素朴に先頭を採ると、`repo` だけのセッション（git 連携が作る）や Copilot 契約の無い別アカウントを
 * 引いて 401 になり、「たまに命名が効かない」が残る。一方で、このリポジトリのどのコードも
 * `read:user`/`user:email` 付きのセッションを作らない（実際のスコープはサインインした拡張が決める）ため、
 * 一致数0でも最後は手持ちで試す。ここで諦めると機能ごと死ぬ。
 *
 * 考え方は upstream の resolveTokenForResource と同じだが、あちらは agentHost 専用の深い階層にあり
 * 取り込み時のコンフリクト面になるので import せず、同じ選び方をここに持つ。
 * サインイン画面は出さない（命名のためにログインを迫らない）。
 */
async function paradisFindGithubAccessToken(authenticationService: IAuthenticationService): Promise<string | undefined> {
	const sessions = await authenticationService.getSessions('github');
	let best: { token: string; hits: number; extras: number } | undefined;
	for (const session of sessions) {
		const scopes = new Set(session.scopes);
		const hits = GITHUB_COPILOT_SCOPES.filter(scope => scopes.has(scope)).length;
		const extras = scopes.size;
		if (!best || hits > best.hits || (hits === best.hits && extras < best.extras)) {
			best = { token: session.accessToken, hits, extras };
		}
	}
	return best?.token;
}

/** Copilot Chat 拡張が登録した小型モデル経由で命名する（Copilot API 経路が使えない場合の二段目）。 */
async function generateWorktreeNaming(languageModelsService: ILanguageModelsService, logService: ILogService, prompt: string, timeoutMs: number): Promise<IParadisWorktreeNaming | undefined> {
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
						value: `${WORKTREE_NAMING_INSTRUCTION}\n\nTask: ${prompt.slice(0, NAMING_PROMPT_MAX_CHARS)}`,
					}],
				}], {}, cts.token);
				return getTextResponseFromStream(response);
			})();
			return toWorktreeNaming(await raceTimeout(request, timeoutMs, () => cts.cancel()));
		} finally {
			cts.dispose();
		}
	} catch (error) {
		logService.info('[ParadisWorktreeHeadlessCreate] LLM naming unavailable, falling back', error);
		return undefined;
	}
}

/**
 * LLM がどれも使えない場合のフォールバック名。
 *
 * まずユーザーが自分で書いた文字（スペース名 → 依頼文）からブランチ名を作る。日時だけの名前
 * （para-0729-2013）は一意ではあるが、ブランチ一覧で中身が全く分からないため最後の手段にする。
 */
function fallbackBranchName(seeds: readonly (string | undefined)[]): string {
	for (const seed of seeds) {
		const candidate = paradisToBranchName(seed);
		if (candidate) {
			return candidate;
		}
	}
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
	const terminalEditorService = accessor.get(ITerminalEditorService);
	const terminalScopeService = accessor.get(IParadisTerminalScopeService);
	const switchService = accessor.get(IParadisWorkspaceSwitchService);
	const agent = paradisConfiguredAgents(configurationService).find(candidate => candidate.id === request.agentId);
	if (!agent) {
		throw new Error(`unknown agent: ${request.agentId}`);
	}
	const instance = await terminalService.createTerminal({
		cwd: request.rootUri,
		location: TerminalLocation.Editor,
	});
	if (request.stateKey !== switchService.activeStateKey) {
		// PC側で非表示のワークスペース向け: スコープを付け替えて即parkさせる（表示を乱さない）。
		// エディタターミナルの park は persistentProcessId を鍵にするため PTY 起動を待ってから
		// assign する。あわせて createTerminal は openEditor の完了を待たないため先に開き切らせる。
		await instance.processReady;
		await terminalEditorService.openEditor(instance);
		terminalScopeService.assignInstanceScope(instance.instanceId, request.stateKey);
	} else {
		// PCのアクティブワークスペース向け: エディタタブとしてそのまま見える
		terminalService.setActiveInstance(instance);
	}
	await instance.processReady;
	const command = paradisBuildAgentCommand(agent, (request.prompt ?? '').trim(), instance.shellType, {
		modelId: request.modelId,
		effortId: request.effortId,
		permissionId: request.permissionId,
	});
	await instance.sendText(command, true);
}

export interface IParadisResumeAgentInWorkspaceRequest {
	readonly rootUri: URI;
	readonly stateKey: string;
	readonly agent: ParadisResumeAgent;
	readonly sessionId: string;
	readonly dangerouslyBypassPermissions?: boolean;
}

/** 検証済みのセッションIDで、指定スペースのエディタターミナルへresumeコマンドを送る。 */
export async function paradisResumeAgentInWorkspace(accessor: ServicesAccessor, request: IParadisResumeAgentInWorkspaceRequest): Promise<void> {
	if (!PARADIS_RESUME_SESSION_ID_PATTERN.test(request.sessionId)) {
		throw new Error('Invalid agent session id.');
	}
	const terminalService = accessor.get(ITerminalService);
	const terminalEditorService = accessor.get(ITerminalEditorService);
	const terminalScopeService = accessor.get(IParadisTerminalScopeService);
	const switchService = accessor.get(IParadisWorkspaceSwitchService);
	const wsl = paradisResolveWslAgentHome(request.rootUri.fsPath);
	const instance = await terminalService.createTerminal(wsl === undefined
		? { cwd: request.rootUri, location: TerminalLocation.Editor }
		: {
			config: {
				name: request.agent === 'claude' ? 'Claude Code' : 'Codex',
				executable: 'wsl.exe',
				// cwdとdistroはargv/位置引数で渡す。シェル文字列へ埋め込まない。
				args: ['-d', wsl.distro, '-e', 'sh', '-c', 'cd -- "$0" && exec "${SHELL:-/bin/bash}" -l', wsl.linuxCwd],
			},
			location: TerminalLocation.Editor,
		});
	if (request.stateKey !== switchService.activeStateKey) {
		await instance.processReady;
		await terminalEditorService.openEditor(instance);
		terminalScopeService.assignInstanceScope(instance.instanceId, request.stateKey);
	} else {
		if (wsl !== undefined) {
			await instance.processReady;
			terminalScopeService.assignInstanceScope(instance.instanceId, request.stateKey);
		}
		terminalService.setActiveInstance(instance);
	}
	await instance.processReady;
	// IDは上のホワイトリストを通り、実行ファイルと引数位置も固定。シェル文字を含まない。
	const command = request.agent === 'claude'
		? `claude ${request.dangerouslyBypassPermissions ? '--dangerously-skip-permissions ' : ''}--resume ${request.sessionId}`
		: `codex ${request.dangerouslyBypassPermissions ? '--dangerously-bypass-approvals-and-sandbox ' : ''}resume ${request.sessionId}`;
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
	const authenticationService = accessor.get(IAuthenticationService);
	const terminalService = accessor.get(ITerminalService);
	const terminalEditorService = accessor.get(ITerminalEditorService);
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

	// 1. ブランチ名の決定（手入力 > Copilot API > Copilot Chat 拡張のモデル > フォールバック）
	let branch = paradisSanitizeBranchName(request.branch ?? '');
	let suggestedTitle: string | undefined;
	if (!branch) {
		if (prompt.length > 0) {
			callbacks?.onStage?.('naming');
			// Copilot API 側はエンドポイント探索とトークン発行が呼び出し側の中断要求を意図的に無視する
			// 作りなので、shared process のタイムアウトだけでは止まらない。ここで打ち切らないと、
			// 命名で待たされて worktree 作成が始まらない。
			const deadline = Date.now() + NAMING_TOTAL_TIMEOUT_MS;
			const primary = await raceTimeout(
				generateWorktreeNamingViaCopilotApi(authenticationService, sharedProcessService, logService, prompt),
				NAMING_COPILOT_TIMEOUT_MS,
			);
			branch = primary?.branch;
			suggestedTitle = primary?.title;
			// 1段目が食い潰した分だけ2段目を短くする。残りが無いなら、結果を待てないリクエストを
			// 投げるだけになるので起動しない。
			const remaining = deadline - Date.now();
			if (!branch && remaining >= NAMING_MIN_REMAINING_MS) {
				const secondary = await generateWorktreeNaming(languageModelsService, logService, prompt, remaining);
				branch = secondary?.branch;
				suggestedTitle = suggestedTitle ?? secondary?.title;
			}
		}
		// 命名モデルが使えない環境（Copilot 未ログイン等）でも英字のブランチ名を見出しにしない。
		// 依頼文の先頭は利用者自身の言葉なので、日付だけの名前やブランチ名よりは手がかりになる。
		// ブランチ名を手入力した場合はここへ来ない（利用者が決めた名前をそのまま見出しに残す）。
		suggestedTitle = suggestedTitle ?? paradisToWorktreeTitle(prompt);
		branch = branch ?? fallbackBranchName([request.name, prompt]);
	}
	branch = paradisDeduplicateBranchName(branch, branchesInfo.branches);

	// 2. worktree 作成
	callbacks?.onStage?.('creating');
	const existingDirNames = worktreeService.getDetectedWorktrees(repository.id).map(worktree => basename(worktree.uri));
	const { displayName, dirName } = paradisBuildWorktreeNames(request.name ?? '', branch, branchesInfo.branches, existingDirNames, suggestedTitle);
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
	callbacks?.onWorktreeCreated?.(targetStateKey);

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
					location: TerminalLocation.Editor,
				});
				// park は persistentProcessId を鍵にするため PTY 起動と openEditor の完了を待ってから assign する
				await instance.processReady;
				await terminalEditorService.openEditor(instance);
				terminalScopeService.assignInstanceScope(instance.instanceId, targetStateKey);
			},
			launchAgent: async () => {
				const agent = paradisConfiguredAgents(configurationService).find(candidate => candidate.id === agentId);
				if (!agent) {
					return;
				}
				// ダイアログ発の従来実装と同じくエディタ領域に作る。非アクティブスコープへの
				// assignInstanceScope は即座に park され、切り替えで戻ったときに
				// unparkEditorTerminals がエディタとして開き直すため現在のスペースの表示は乱れない。
				// paneトークンは同様に自動注入されるため、稼働状態表示（Workspaces ビュー/
				// モバイルのホーム一覧）はそのまま効く。
				// park は persistentProcessId を鍵にするため PTY 起動と openEditor の完了を待ってから assign する。
				const instance = await terminalService.createTerminal({
					cwd: worktreeUri,
					location: TerminalLocation.Editor,
				});
				await instance.processReady;
				await terminalEditorService.openEditor(instance);
				terminalScopeService.assignInstanceScope(instance.instanceId, targetStateKey);
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
