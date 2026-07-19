// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

/**
 * モバイルアプリの状態ストア（UI非依存の中核）。RelayClient/PairingClient を束ね、
 * PCから届く state スナップショットと接続状態を保持する。Zustand から購読する。
 *
 * 永続化（identity/credentials）は KeyStore インターフェースで注入する
 * （本番は expo-secure-store、テストはメモリ実装）。
 */

import { BROWSER_JPEG_BINARY_ENCODING, type Frame, type Identity, type NotifyPayload, decodeBinaryBrowserJpegFrame, decodeNotify, decodeNotifyControl, deriveNotifyKey, encodeNotifyDismiss, generateIdentity, isBinaryBrowserJpegFrame, openNotify, randomToken, sealNotify, toBase64Url } from '@para/protocol';
import { RelayClient, encodeRelayControl, type ConnectionState, type PairedCredentials, type SocketFactory } from './relayClient.js';

/** ワークスペースの現在ブランチに紐づくGitHub PRの状態（PC版WorkspacesビューのPRチップと同じ供給源）。 */
export interface WorkspacePrStatus {
	number: number;
	state: 'open' | 'draft' | 'merged' | 'closed';
	url: string;
}

/** PCから届くワークスペース状態（stateチャネルのJSON）。 */
export interface WorkspaceState {
	protocolVersion: 3;
	desktopEpoch: string;
	revision: number;
	complete: boolean;
	renderers: { windowId: number; rendererGeneration: number; ready: boolean }[];
	activeWs: string | undefined;
	// parent: worktree（スペース）の親リポジトリid。ドロワーの親子グルーピング（開閉表示）に使う。
	// 旧PC（parent未配信）ではundefinedのままフラット表示にフォールバックする。
	// pr: 現在ブランチに紐づくGitHub PR（PC側がghでポーリング）。旧PCでは未配信。
	workspaces: { id: string; sourceId: string; windowId: number; name: string; color?: string; branch?: string; parent?: string; pr?: WorkspacePrStatus }[];
	// agent: そのターミナルでエージェントCLI（claude/codex）が動いた実績があるか（PC側のhook発火実績）。
	// ホーム一覧・Live Activity はこのフラグで「エージェントのターミナル」だけに絞る。
	terminals: { terminalKey: string; id: number; windowId: number; rendererGeneration: number; title: string; ws?: string; agent?: boolean; agentToken?: string; agentStatus?: string; cols?: number; rows?: number }[];
}

interface RendererRequestTarget {
	readonly desktopEpoch: string;
	readonly windowId: number;
	readonly rendererGeneration: number;
}

/** partial stateはready windowだけを置換し、pending windowの最後の表示を保持する。 */
export function mergeWorkspaceState(previous: WorkspaceState | undefined, incoming: WorkspaceState): WorkspaceState {
	if (previous === undefined || incoming.complete) {
		return incoming;
	}
	// desktopEpochが変わった = PC(shared process)が再起動した。起動直後の部分state
	// （windowがまだclaim/syncしていない）で旧表示を破壊すると、PC再起動のたびにホームの
	// ワークスペース・ターミナル・エージェントが全消えする。新epochのwindowが1つでも
	// readyになるまでは旧表示を保持し、以降は「未観測のwindow=pending」として扱う。
	if (previous.desktopEpoch !== incoming.desktopEpoch) {
		if (!incoming.renderers.some(renderer => renderer.ready)) {
			return previous;
		}
		const readyWindows = new Set(incoming.renderers.filter(renderer => renderer.ready).map(renderer => renderer.windowId));
		const workspaces = new Map(previous.workspaces.filter(workspace => !readyWindows.has(workspace.windowId)).map(workspace => [workspace.id, workspace]));
		for (const workspace of incoming.workspaces) {
			workspaces.set(workspace.id, workspace);
		}
		const terminals = new Map(previous.terminals.filter(terminal => !readyWindows.has(terminal.windowId)).map(terminal => [terminal.terminalKey, terminal]));
		for (const terminal of incoming.terminals) {
			terminals.set(terminal.terminalKey, terminal);
		}
		return {
			...incoming,
			workspaces: [...workspaces.values()],
			terminals: [...terminals.values()],
		};
	}
	const pendingWindows = new Set(incoming.renderers.filter(renderer => !renderer.ready).map(renderer => renderer.windowId));
	const workspaces = new Map(previous.workspaces.filter(workspace => pendingWindows.has(workspace.windowId)).map(workspace => [workspace.id, workspace]));
	for (const workspace of incoming.workspaces) {
		workspaces.set(workspace.id, workspace);
	}
	const terminals = new Map(previous.terminals.filter(terminal => pendingWindows.has(terminal.windowId)).map(terminal => [terminal.terminalKey, terminal]));
	for (const terminal of incoming.terminals) {
		terminals.set(terminal.terminalKey, terminal);
	}
	const previousActiveWorkspace = previous.activeWs === undefined
		? undefined
		: previous.workspaces.find(workspace => workspace.id === previous.activeWs);
	return {
		...incoming,
		activeWs: incoming.activeWs ?? (previousActiveWorkspace !== undefined && pendingWindows.has(previousActiveWorkspace.windowId) ? previous.activeWs : undefined),
		workspaces: [...workspaces.values()],
		terminals: [...terminals.values()],
	};
}

/** scm status 応答。 */
export interface ScmStatusResult {
	branch: string;
	files: { x: string; y: string; path: string }[];
}
/** scm diff 応答。 */
export interface ScmDiffResult {
	diff: string;
}
/** scm log 応答。 */
export interface ScmLogResult {
	/** at: committer dateのepoch ms（相対時刻はモバイル側が表示のたびに計算する）。
	 *  when: PC側で整形済みの相対時刻文字列。旧バージョンのPCはatを送らないため
	 *  フォールバック用に残っている。 */
	commits: { hash: string; when: string; subject: string; at?: number }[];
	/** skip+limitの先にまだコミットが残っているか（追加読み込みボタンの表示判定）。 */
	hasMore?: boolean;
	/** リモート(origin)から導出したWeb URL（コミットページへのリンク用）。 */
	webUrl?: string;
}
/** scm commit 応答。 */
export interface ScmCommitResult {
	output: string;
}
/** scm commitFiles 応答（1コミットの変更ファイル一覧）。 */
export interface ScmCommitFilesResult {
	files: { status: string; path: string }[];
}
/** worktree（スペース）作成フォームの材料（scm worktreeForm 応答）。 */
export interface WorktreeFormResult {
	repos: { id: string; name: string; branches: string[]; head?: string }[];
	agents: { id: string; label: string }[];
}
/** worktree（スペース）作成の応答。warning は「作成はできたが後続処理が失敗した」場合。 */
export interface WorktreeCreateResult {
	name: string;
	branch: string;
	warning?: string;
}
/** fs list 応答。 */
export interface FsListResult {
	entries: { name: string; dir: boolean; size?: number }[];
}
/** Markdown内のファイルリンクを、選択ワークスペース内の相対パスへ安全に解決した結果。 */
export interface FsResolveLinkResult {
	path: string;
}
/** fs read 応答。 */
export interface FsReadResult {
	content: string;
	truncated: boolean;
	size: number;
	/** highlight要求時: PCの現行テーマでトークン化されたHTML（.monaco-tokenized-source）。 */
	html?: string;
	/** highlight要求時: トークン色のカラーマップCSS。 */
	css?: string;
	/** highlight要求時: エディタ背景色/前景色。 */
	bg?: string;
	fg?: string;
	/** ハイライトがサイズ上限で先頭のみになっている。 */
	highlightTruncated?: boolean;
}

/** fs xlsx 応答（PC側でレンダリングされたExcelの1シート分の静的HTML + シート一覧）。 */
export interface FsXlsxResult {
	html: string;
	/** ブックの全シート名（ネイティブのシートタブ表示用）。 */
	sheets?: string[];
	/** 今回レンダリングされたシートのインデックス。 */
	sheet?: number;
}
/** fs pdf 応答（PDFバイナリの base64。WKWebView のネイティブPDF表示に使う）。 */
export interface FsPdfResult {
	data: string;
	size: number;
}
/** fs docx 応答（Word文書バイナリの base64。WebView 内の docx-preview でレンダリングする）。 */
export interface FsDocxResult {
	data: string;
	size: number;
}
/** fs media 応答（画像・動画・音声バイナリの base64）。 */
export interface FsMediaResult {
	data: string;
	size: number;
}
/** fs find 応答（ファイル名検索、ルート相対パスのランク順）。 */
export interface FsFindResult {
	files: string[];
	truncated: boolean;
}
/** fs grep 応答（テキスト全文検索）。 */
export interface FsGrepResult {
	matches: { path: string; line: number; text: string }[];
	truncated: boolean;
}
/** fs upload 応答（PC側に保存された添付ファイルのフルパス）。 */
export interface FsUploadResult {
	path: string;
}

/** Agent message submission outcome. `consumed` means pasted into the TUI but not executed. */
export type AgentMessageSendResult =
	| { readonly status: 'accepted' }
	| { readonly status: 'rejected'; readonly message?: string }
	| { readonly status: 'consumed'; readonly message?: string };

export function toAgentMessageSendResult(status: 'accepted' | 'rejected', consumed: boolean, message?: string): AgentMessageSendResult {
	return status === 'accepted'
		? { status: 'accepted' }
		: consumed
			? { status: 'consumed', ...(message !== undefined ? { message } : {}) }
			: { status: 'rejected', ...(message !== undefined ? { message } : {}) };
}
/** fs hl 応答（コード断片のPCテーマハイライト。失敗時は全フィールド欠落＝プレーン表示）。 */
export interface FsHighlightResult {
	/** `.monaco-tokenized-source` 形式のHTML（span.mtkN と <br/> のみ）。 */
	html?: string;
	/** `.mtkN { color: ... }` のカラーマップCSS。 */
	css?: string;
	/** エディタ背景色/前景色。 */
	bg?: string;
	fg?: string;
}
/** scm xlsxDiff 応答（PC側でレンダリングされたExcel差分の静的HTML）。 */
export interface ScmXlsxDiffResult {
	html: string;
}

/** ccusage: エージェント軸（ccusage のソース名に対応）。 */
export type UsageAgent = 'claude' | 'codex' | 'gemini' | 'other';
/** ccusage: 1日×1モデルのスライス。 */
export interface UsageModelSlice {
	model: string;
	agent: UsageAgent;
	cost: number;
	inputTokens: number;
	outputTokens: number;
	cacheCreationTokens: number;
	cacheReadTokens: number;
}
export interface UsageDayData {
	/** YYYY-MM-DD。 */
	date: string;
	models: UsageModelSlice[];
}
/** ccusage: 現在アクティブな5時間ブロック。 */
export interface UsageBlockData {
	startTime: number;
	endTime: number;
	costUSD: number;
	remainingMinutes?: number;
	projectedCost?: number;
	projectedTokens?: number;
	costPerHour?: number;
	tokensPerMinute?: number;
}
export interface UsageSessionData {
	project: string;
	rawProject: string;
	lastActivity?: number;
	models: string[];
	totalTokens: number;
	totalCost: number;
}
export interface UsageProjectData {
	name: string;
	rawName: string;
	dailyCosts: { date: string; cost: number }[];
}
/** ccusage usage 応答（PC側で正規化済みのダッシュボードデータ一式）。 */
export interface UsageDashboardResult {
	days: UsageDayData[];
	block?: UsageBlockData;
	sessions: UsageSessionData[];
	projects: UsageProjectData[];
	failedReports: string[];
	fetchedAt: number;
}

/** Rate Limit(AIリミット)の1ウィンドウ(5時間/7日/モデル別)。PC側 IParadisLimitsWindow と同形。 */
export interface RateLimitWindow {
	usedPercent: number;
	/** epoch ms。 */
	resetsAt?: number;
	label?: string;
}
export type RateLimitAccountStatus = 'ok' | 'token_expired' | 'no_credentials' | 'error';
/** Rate Limitの1アカウント。PC側 IParadisLimitsAccount と同形。 */
export interface RateLimitAccount {
	provider: 'claude' | 'codex';
	id: string;
	email?: string;
	active?: boolean;
	homeLabel?: string;
	slot?: number;
	status: RateLimitAccountStatus;
	statusDetail?: string;
	planType?: string;
	fiveHour?: RateLimitWindow;
	sevenDay?: RateLimitWindow;
	scoped?: RateLimitWindow[];
}
export interface RateLimitProviderSnapshot {
	accounts: RateLimitAccount[];
	sourceError?: string;
	cswapMissing?: boolean;
}
/** limits 応答（PC側で正規化済みのRate Limitスナップショット）。 */
export interface RateLimitsResult {
	claude: RateLimitProviderSnapshot;
	codex: RateLimitProviderSnapshot;
	fetchedAt: number;
}

/** browser targets 応答。sharedToken はそのページを共有中のターミナルペインのトークン（PC側 agentBrowser のバインディング由来）。 */
export interface BrowserTargetsResult {
	targets: { targetId: string; title: string; url: string; sharedToken?: string }[];
}
/** browser の直近 screencast フレーム。 */
export interface BrowserFrame {
	/** JPEG の base64。 */
	data: string;
	w: number;
	h: number;
}

/** kind==='question' の選択肢1件。 */
export interface AgentQuestionOption {
	label: string;
	description?: string;
}

/** agent チャネルの正規化済みチャットメッセージ（PC側 paradisMobileAgentChat.ts と一致）。 */
export interface AgentChatMessage {
	rev: number;
	role: 'user' | 'assistant' | 'tool';
	kind: 'text' | 'thinking' | 'tool_use' | 'tool_result' | 'question' | 'peer_message';
	text: string;
	tool?: string;
	ts?: number;
	/** kind==='question': タブ見出し。 */
	header?: string;
	/** kind==='question': 選択肢（表示順 = TUIの番号キー割り当て順）。 */
	options?: AgentQuestionOption[];
	/** kind==='question': 複数選択可能な質問か（TUIではトグル選択 + Enter確定）。 */
	multiSelect?: boolean;
	/** kind==='question' | 'tool_result': 対応付け用ID。同IDの tool_result が後続にあれば回答済み。 */
	toolUseId?: string;
	/** kind==='question': 同一 AskUserQuestion 呼び出しのグループキー（複数質問の集約表示用）。 */
	questionGroup?: string;
	/** kind==='question': グループ内の位置（0起点）。 */
	questionIndex?: number;
	/** kind==='question': グループの総質問数。 */
	questionCount?: number;
	/** kind==='peer_message': Claude Code Agent Teamsの送信元と要約。 */
	peerName?: string;
	peerSummary?: string;
}

/** セッションのメタ情報（PC側 transcript から学習した最新値）。 */
export interface AgentSessionInfo {
	/** モデル名（Claude: assistant行の model、Codex: turn_context.model）。 */
	model?: string;
	/** reasoning effort（Codex: turn_context、Claude: settings.json の既定値 + /effort の実行記録）。 */
	effort?: string;
}

/** Codexモデルが広告するreasoning effort 1件。 */
export interface AgentReasoningEffortOption {
	value: string;
	description: string;
}

/** Codex app-serverのmodel/listから正規化したモデル候補。 */
export interface AgentModelOption {
	id: string;
	model: string;
	displayName: string;
	description: string;
	efforts: AgentReasoningEffortOption[];
	defaultEffort: string;
	isDefault: boolean;
}

/** モデルカタログ取得と次ターン設定変更の状態。 */
export interface AgentModelControlState {
	status: 'idle' | 'loading' | 'ready' | 'updating' | 'error';
	requestId?: string;
	models: AgentModelOption[];
	pending?: { model: string; effort: string };
	errorCode?: string;
	errorMessage?: string;
}

/** PC側で正規化し、モバイル側でも再検証したコマンド候補。 */
export interface AgentCommandOption {
	name: string;
	insertText: string;
	description: string;
	argumentHint?: string;
	kind: 'command' | 'skill' | 'prompt';
	source: 'built-in' | 'user' | 'project';
}

/** コマンドカタログの取得状態と直近の検証済み候補。 */
export interface AgentCommandCatalogState {
	status: 'loading' | 'ready' | 'error';
	requestId?: string;
	commands: AgentCommandOption[];
	errorMessage?: string;
}

function parseAgentCommandOptions(value: unknown): AgentCommandOption[] {
	if (!Array.isArray(value) || value.length === 0 || value.length > 200) {
		return [];
	}
	const commands: AgentCommandOption[] = [];
	const names = new Set<string>();
	for (const candidate of value) {
		if (candidate === null || typeof candidate !== 'object' || Array.isArray(candidate)) {
			return [];
		}
		const raw = candidate as Record<string, unknown>;
		if (typeof raw['name'] !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,99}$/.test(raw['name'])
			|| raw['insertText'] !== `/${raw['name']}` || typeof raw['description'] !== 'string' || raw['description'].length > 240
			|| (raw['argumentHint'] !== undefined && (typeof raw['argumentHint'] !== 'string' || raw['argumentHint'].length > 120))
			|| (raw['kind'] !== 'command' && raw['kind'] !== 'skill' && raw['kind'] !== 'prompt')
			|| (raw['source'] !== 'built-in' && raw['source'] !== 'user' && raw['source'] !== 'project')) {
			return [];
		}
		const key = raw['name'].toLocaleLowerCase();
		if (names.has(key)) {
			return [];
		}
		names.add(key);
		commands.push({
			name: raw['name'], insertText: raw['insertText'], description: raw['description'],
			...(typeof raw['argumentHint'] === 'string' ? { argumentHint: raw['argumentHint'] } : {}),
			kind: raw['kind'], source: raw['source'],
		});
	}
	return commands;
}

/** relay境界では型注釈を信用せず、UIへ渡す動的カタログを上限つきで正規化する。 */
function parseAgentModelOptions(value: unknown): AgentModelOption[] {
	if (!Array.isArray(value)) {
		return [];
	}
	const models: AgentModelOption[] = [];
	for (const candidate of value.slice(0, 128)) {
		if (candidate === null || typeof candidate !== 'object' || Array.isArray(candidate)) {
			continue;
		}
		const raw = candidate as Record<string, unknown>;
		if (typeof raw['id'] !== 'string' || typeof raw['model'] !== 'string' || typeof raw['displayName'] !== 'string'
			|| typeof raw['defaultEffort'] !== 'string' || !Array.isArray(raw['efforts'])) {
			continue;
		}
		const efforts: AgentReasoningEffortOption[] = [];
		for (const candidateEffort of raw['efforts'].slice(0, 16)) {
			if (candidateEffort !== null && typeof candidateEffort === 'object' && !Array.isArray(candidateEffort)) {
				const effort = candidateEffort as Record<string, unknown>;
				if (typeof effort['value'] === 'string' && typeof effort['description'] === 'string') {
					efforts.push({ value: effort['value'].slice(0, 100), description: effort['description'].slice(0, 500) });
				}
			}
		}
		if (efforts.length === 0) {
			continue;
		}
		const id = raw['id'].slice(0, 500);
		const model = raw['model'].slice(0, 500);
		if (models.some(existing => existing.id === id || existing.model === model)) {
			continue;
		}
		models.push({
			id,
			model,
			displayName: raw['displayName'].slice(0, 200),
			description: typeof raw['description'] === 'string' ? raw['description'].slice(0, 1_000) : '',
			efforts,
			defaultEffort: raw['defaultEffort'].slice(0, 100),
			isDefault: raw['isDefault'] === true,
		});
	}
	return models;
}

/** transcript確定前の一時的な実行状況（PC側の最新値で置換され、履歴には残らない）。 */
export interface AgentLiveState {
	phase: 'thinking' | 'tool' | 'message' | 'permission';
	source: 'hook' | 'transcript' | 'codex-daemon' | 'pty';
	startedAt: number;
	updatedAt: number;
	tool?: string;
	detail?: string;
	text?: string;
	final?: boolean;
	elapsedSeconds?: number;
	tokenCount?: number;
}

export type AgentActivityStatus = 'running' | 'idle' | 'completed' | 'failed' | 'interrupted' | 'unknown';
export interface AgentActivityAgent { id: string; label: string; role: 'subagent' | 'teammate'; provider?: 'claude' | 'codex'; detail?: string; parentId?: string; depth?: number; status: AgentActivityStatus; startedAt: number; updatedAt: number }
export interface AgentActivityTask { id: string; label: string; detail?: string; assignee?: string; agentId?: string; status: AgentActivityStatus; startedAt: number; updatedAt: number }
export interface AgentActivityCompaction { id: string; trigger?: string; status: 'running' | 'completed'; startedAt: number; updatedAt: number }
export interface AgentActivityState {
	agents: AgentActivityAgent[];
	tasks: AgentActivityTask[];
	compactions: AgentActivityCompaction[];
	startedAt: number;
	updatedAt: number;
}
export interface AgentActivityDetailMessage { role: 'user' | 'assistant' | 'tool'; kind: 'text' | 'thinking' | 'tool'; text: string }

function parseAgentActivityState(value: unknown): AgentActivityState | undefined {
	if (value === null || typeof value !== 'object' || Array.isArray(value)) { return undefined; }
	const raw = value as Record<string, unknown>;
	if (!Array.isArray(raw['agents']) || !Array.isArray(raw['tasks']) || !Array.isArray(raw['compactions']) || typeof raw['startedAt'] !== 'number' || typeof raw['updatedAt'] !== 'number') { return undefined; }
	const statuses = new Set<AgentActivityStatus>(['running', 'idle', 'completed', 'failed', 'interrupted', 'unknown']);
	const agents: AgentActivityAgent[] = [];
	for (const candidate of raw['agents'].slice(0, 100)) {
		if (candidate === null || typeof candidate !== 'object' || Array.isArray(candidate)) { continue; }
		const item = candidate as Record<string, unknown>;
		if (typeof item['id'] === 'string' && typeof item['label'] === 'string' && (item['role'] === 'subagent' || item['role'] === 'teammate') && statuses.has(item['status'] as AgentActivityStatus) && typeof item['startedAt'] === 'number' && typeof item['updatedAt'] === 'number') {
			const parentId = typeof item['parentId'] === 'string' && item['parentId'] !== item['id'] ? item['parentId'].slice(0, 500) : undefined;
			const depth = typeof item['depth'] === 'number' && Number.isFinite(item['depth']) ? Math.min(5, Math.max(1, Math.trunc(item['depth']))) : undefined;
			agents.push({ id: item['id'].slice(0, 500), label: item['label'].slice(0, 1_000), role: item['role'], ...(item['provider'] === 'claude' || item['provider'] === 'codex' ? { provider: item['provider'] } : {}), ...(typeof item['detail'] === 'string' ? { detail: item['detail'].slice(0, 4_000) } : {}), ...(parentId !== undefined ? { parentId } : {}), ...(depth !== undefined ? { depth } : {}), status: item['status'] as AgentActivityStatus, startedAt: item['startedAt'], updatedAt: item['updatedAt'] });
		}
	}
	const tasks: AgentActivityTask[] = [];
	for (const candidate of raw['tasks'].slice(0, 100)) {
		if (candidate === null || typeof candidate !== 'object' || Array.isArray(candidate)) { continue; }
		const item = candidate as Record<string, unknown>;
		if (typeof item['id'] === 'string' && typeof item['label'] === 'string' && statuses.has(item['status'] as AgentActivityStatus) && typeof item['startedAt'] === 'number' && typeof item['updatedAt'] === 'number') {
			tasks.push({ id: item['id'].slice(0, 500), label: item['label'].slice(0, 1_000), ...(typeof item['detail'] === 'string' ? { detail: item['detail'].slice(0, 2_000) } : {}), ...(typeof item['assignee'] === 'string' ? { assignee: item['assignee'].slice(0, 500) } : {}), ...(typeof item['agentId'] === 'string' ? { agentId: item['agentId'].slice(0, 500) } : {}), status: item['status'] as AgentActivityStatus, startedAt: item['startedAt'], updatedAt: item['updatedAt'] });
		}
	}
	const compactions: AgentActivityCompaction[] = [];
	for (const candidate of raw['compactions'].slice(0, 5)) {
		if (candidate === null || typeof candidate !== 'object' || Array.isArray(candidate)) { continue; }
		const item = candidate as Record<string, unknown>;
		if (typeof item['id'] === 'string' && (item['status'] === 'running' || item['status'] === 'completed') && typeof item['startedAt'] === 'number' && typeof item['updatedAt'] === 'number') {
			compactions.push({ id: item['id'].slice(0, 500), ...(typeof item['trigger'] === 'string' ? { trigger: item['trigger'].slice(0, 100) } : {}), status: item['status'], startedAt: item['startedAt'], updatedAt: item['updatedAt'] });
		}
	}
	return { agents, tasks, compactions, startedAt: raw['startedAt'], updatedAt: raw['updatedAt'] };
}

/** ターミナル1つ分のエージェントチャット状態。 */
export interface AgentChatState {
	/** 'claude' | 'codex'。 */
	agent: string;
	/** PC側tailerのepoch（再接続時の差分同期に使う）。 */
	epoch: string;
	/** 受信済み最終rev。 */
	rev: number;
	messages: AgentChatMessage[];
	/** 古い履歴が省略されている。 */
	truncated: boolean;
	/** PC側にセッションが見つからなかった（エージェント未起動等）。 */
	none?: boolean;
	/** セッションのメタ情報（model / effort）。 */
	info?: AgentSessionInfo;
	/** 生成中本文・実行中ツール等の一時状態。 */
	live?: AgentLiveState;
	/** SubAgent、タスク、圧縮のプロバイダー非依存な最新状態。 */
	activity?: AgentActivityState;
	/** Codex app-server由来の動的モデルカタログと設定更新状態。 */
	modelControl?: AgentModelControlState;
	/** PC側でプロバイダーとcwdを検証して構築したスラッシュコマンド一覧。 */
	commandCatalog?: AgentCommandCatalogState;
	/** PC側がsession検証付きAgent Actionを受け付ける。 */
	capabilities?: { agentActions: true; claudeSettings?: true };
	interaction?: AgentInteraction;
}

export interface AgentInteraction {
	kind: 'question' | 'approval';
	id: string;
	title?: string;
	detail?: string;
	choices?: AgentApprovalChoice[];
}

export interface AgentApprovalChoice {
	id: string;
	label: string;
	tone: 'approve' | 'neutral' | 'deny';
}

export type AgentQuestionAnswer =
	| { kind: 'option'; index: number }
	| { kind: 'multi'; indices: number[] }
	| { kind: 'text'; optionCount: number; text: string };

/**
 * 「人間の対応が必要」なエージェント状態か（赤表示・応答待ちバッジの判定）。
 * permission = ツール実行の許可待ち、question = 選択式質問（AskUserQuestion）への回答待ち。
 */
export function isAgentWaiting(status: string | undefined): boolean {
	return status === 'permission' || status === 'question';
}

function parseAgentInteraction(value: unknown): AgentInteraction | undefined {
	if (value === null || typeof value !== 'object' || Array.isArray(value)) { return undefined; }
	const raw = value as Record<string, unknown>;
	if ((raw['kind'] !== 'question' && raw['kind'] !== 'approval') || typeof raw['id'] !== 'string' || raw['id'].length === 0 || raw['id'].length > 500) {
		return undefined;
	}
	if (raw['kind'] === 'question') {
		return { kind: 'question', id: raw['id'] };
	}
	const title = typeof raw['title'] === 'string' && raw['title'].length <= 200 ? raw['title'] : undefined;
	const detail = typeof raw['detail'] === 'string' && raw['detail'].length <= 6_000 ? raw['detail'] : undefined;
	let choices: AgentApprovalChoice[] | undefined;
	if (Array.isArray(raw['choices']) && raw['choices'].length <= 12) {
		const parsed: AgentApprovalChoice[] = [];
		for (const candidate of raw['choices']) {
			if (candidate === null || typeof candidate !== 'object' || Array.isArray(candidate)) { parsed.length = 0; break; }
			const choice = candidate as Record<string, unknown>;
			if (typeof choice['id'] !== 'string' || !/^[A-Za-z0-9._:-]{1,100}$/.test(choice['id'])
				|| typeof choice['label'] !== 'string' || choice['label'].length === 0 || choice['label'].length > 200
				|| (choice['tone'] !== 'approve' && choice['tone'] !== 'neutral' && choice['tone'] !== 'deny')
				|| parsed.some(value => value.id === choice['id'])) {
				parsed.length = 0;
				break;
			}
			parsed.push({ id: choice['id'], label: choice['label'], tone: choice['tone'] });
		}
		choices = parsed;
	}
	return { kind: 'approval', id: raw['id'], ...(title !== undefined ? { title } : {}), ...(detail !== undefined ? { detail } : {}), ...(choices !== undefined ? { choices } : {}) };
}

/**
 * ピン留めの識別キー。instanceIdはPC再起動・ウィンドウreloadで再採番される揮発値のため、
 * エージェント確定済みのターミナルは比較的安定なagentTokenを優先して使う。
 */
export function pinKeyForTerminal(terminal: { terminalKey: string }): string {
	return terminal.terminalKey;
}

/**
 * 同期プロトコル（epoch/seq）のターミナルストリームイベント。
 * snapshot はバッファ全体の置き換え（適用すべき cols/rows・unicode幅版を伴う）、
 * data は追記、exit は端末終了。
 */
export interface TermStreamEvent {
	kind: 'snapshot' | 'data' | 'exit';
	data?: string;
	cols?: number;
	rows?: number;
	unicode?: string;
}

/** attach中ターミナル1つ分の同期ストリーム状態。 */
interface TermStreamState {
	/** attach時に採番した世代番号。これと一致しない受信フレームは捨てる。 */
	epoch: number;
	/** 受信済み最終seq。snapshot受信前は undefined（ライブ出力はsnapshotに含まれるので捨てる）。 */
	lastSeq: number | undefined;
	/** 前回ACKからの受信文字数。 */
	unackedChars: number;
	listeners: Set<(ev: TermStreamEvent) => void>;
	/** タブ再訪時の即時再描画用（snapshot起点のイベント列）。 */
	cache: { events: TermStreamEvent[]; chars: number } | undefined;
	/** 最後にattachしたPC側配送先。Renderer reload/PTY再採番を検出する。 */
	rendererTarget: string | undefined;
}

/** 秘密情報の永続化。 */
export interface KeyStore {
	getItem(key: string): Promise<string | null>;
	setItem(key: string, value: string): Promise<void>;
	deleteItem(key: string): Promise<void>;
}

/** 暗号化済みoutbox blobの永続ストア。実装はアプリsandbox内ファイル。 */
export interface TerminalOperationOutboxStore {
	loadCandidates(): Promise<readonly string[]>;
	save(encrypted: string): Promise<void>;
	clear(): Promise<void>;
}

interface PersistedTerminalOperation {
	readonly operationId: string;
	readonly operationRun: number;
	readonly operationSeq: number;
	readonly payload: string;
	readonly state: 'pending' | 'unknown';
}

const MAX_TERMINAL_OPERATION_OUTBOX = 256;

export interface StoreState {
	connection: ConnectionState;
	pcOnline: boolean;
	/** 現在の暗号セッションでv3 State handshakeまで完了した。 */
	sessionProtocolReady: boolean;
	workspace: WorkspaceState | undefined;
	/** PC/モバイルの公開プロトコル不一致。黙って操作不能にせず更新案内へ使う。 */
	protocolError: string | undefined;
	/** 結果不明になったmutation。新IDで自動再実行せずUIへ明示する。 */
	terminalOperationIssue: string | undefined;
	unknownTerminalOperationCount: number;
	/** ターミナルID → 受信済み出力（末尾のみ保持）。 */
	terminalOutput: Map<string, string>;
	/** 受信した通知（新しい順、最大50件）。 */
	notifications: NotifyPayload[];
	/** browser ミラーの直近フレーム（未開始は undefined）。 */
	browserFrame: BrowserFrame | undefined;
	/** ターミナルID → エージェントチャット状態（agentチャネル）。 */
	agentChats: Map<string, AgentChatState>;
}

const IDENTITY_KEY = 'para.identity';
const CREDS_KEY = 'para.credentials';
const OPERATION_RUN_KEY = 'para.operationRun';
const MAX_TERM_BUFFER = 200_000;
// --- ターミナル同期プロトコル（epoch/seq対応PC向け）の定数 ---
// 受信文字数がこの閾値を超えるたびにACKを返す（PC側フロー制御の材料。本家
// FlowControlConstants.CharCountAckSize と同値）。
const TERM_ACK_CHARS = 5_000;
// エージェント応答ストリーミング中の delta emit を coalesce する窓（ms）。leading + trailing。
const AGENT_STREAM_EMIT_MS = 120;
// タブ再訪時に即時再描画するためのリプレイキャッシュ上限（snapshot+後続dataの合計文字数）。
// 超過したら丸ごと捨てる（途中で切るとエスケープシーケンスが壊れるため、部分保持はしない）。
const TERM_REPLAY_CACHE_LIMIT = 150_000;
const encoder = new TextEncoder();
const decoder = new TextDecoder();

/** identity を KeyStore から読み込む。無ければ生成して保存する。 */
export async function loadOrCreateIdentity(keyStore: KeyStore): Promise<{ identity: Identity; created: boolean }> {
	const raw = await keyStore.getItem(IDENTITY_KEY);
	if (raw) {
		const parsed = JSON.parse(raw) as { pub: string; sec: string };
		return {
			identity: {
				publicKey: fromB64(parsed.pub),
				secretKey: fromB64(parsed.sec),
			},
			created: false,
		};
	}
	const identity = generateIdentity();
	await keyStore.setItem(IDENTITY_KEY, JSON.stringify({ pub: toB64(identity.publicKey), sec: toB64(identity.secretKey) }));
	return { identity, created: true };
}

export async function loadCredentials(keyStore: KeyStore): Promise<PairedCredentials | undefined> {
	const raw = await keyStore.getItem(CREDS_KEY);
	if (!raw) {
		return undefined;
	}
	const p = JSON.parse(raw) as { relayUrl: string; deviceId: string; mobileId: string; mobileToken: string; pcPublicKey: string };
	return { relayUrl: p.relayUrl, deviceId: p.deviceId, mobileId: p.mobileId, mobileToken: p.mobileToken, pcPublicKey: fromB64(p.pcPublicKey) };
}

export async function clearCredentials(keyStore: KeyStore): Promise<void> {
	await keyStore.deleteItem(CREDS_KEY);
}

/** アプリprocess起動ごとのterminal operation世代をSecureStore上で単調増加させる。 */
export async function reserveOperationRun(keyStore: KeyStore): Promise<number> {
	const raw = await keyStore.getItem(OPERATION_RUN_KEY);
	const previous = raw === null ? 0 : Number(raw);
	const next = Number.isSafeInteger(previous) && previous >= 0 ? previous + 1 : 1;
	if (!Number.isSafeInteger(next)) {
		throw new Error('terminal operation run exhausted');
	}
	await keyStore.setItem(OPERATION_RUN_KEY, String(next));
	return next;
}

/**
 * リレー上の自分の資格情報を失効させる（ペアリング解除）。mobileToken 本人認証なので
 * 自分の分しか消せない。ネットワーク断などの失敗は false を返す（ローカル解除は続行してよい）。
 * RNのfetchは既定タイムアウトを持たないため、ハーフオープン接続で unpair() 全体が
 * ハングしないよう AbortController で上限を切る。
 */
export async function revokeSelfOnRelay(creds: PairedCredentials, fetchImpl: typeof fetch = fetch, timeoutMs = 5_000): Promise<boolean> {
	const httpBase = creds.relayUrl.replace(/\/$/, '').replace(/^ws/, 'http');
	const abort = new AbortController();
	const timer = setTimeout(() => abort.abort(), timeoutMs);
	try {
		const res = await fetchImpl(`${httpBase}/device/${creds.deviceId}/mobile/self-revoke`, {
			method: 'POST',
			headers: { authorization: `Bearer ${creds.mobileToken}`, 'content-type': 'application/json' },
			body: JSON.stringify({ mobileId: creds.mobileId }),
			signal: abort.signal,
		});
		return res.ok;
	} catch {
		return false;
	} finally {
		clearTimeout(timer);
	}
}

export async function saveCredentials(keyStore: KeyStore, creds: PairedCredentials): Promise<void> {
	await keyStore.setItem(CREDS_KEY, JSON.stringify({
		relayUrl: creds.relayUrl,
		deviceId: creds.deviceId,
		mobileId: creds.mobileId,
		mobileToken: creds.mobileToken,
		pcPublicKey: toB64(creds.pcPublicKey),
	}));
}

export function terminalOperationPairingScope(creds: PairedCredentials): string {
	return JSON.stringify({
		relayUrl: creds.relayUrl.replace(/\/+$/, ''),
		deviceId: creds.deviceId,
		mobileId: creds.mobileId,
		pcPublicKey: toB64(creds.pcPublicKey),
	});
}

/**
 * 接続と受信フレームを状態に反映するコントローラ。UIフレームワーク非依存で、
 * onChange コールバックで購読側（Zustand set 等）へ通知する。
 */
export class MobileController {
	private client: RelayClient | undefined;
	private lastCredentials: PairedCredentials | undefined;
	readonly state: StoreState = {
		connection: 'offline',
		pcOnline: false,
		sessionProtocolReady: false,
		workspace: undefined,
		protocolError: undefined,
		terminalOperationIssue: undefined,
		unknownTerminalOperationCount: 0,
		terminalOutput: new Map(),
		notifications: [],
		browserFrame: undefined,
		agentChats: new Map(),
	};

	/**
	 * agentチャットの購読中ターミナルID → 購読者数（参照カウント）。
	 * ホーム画面のアテンションカードとエージェント画面が同じターミナルを同時に
	 * 購読しうる（別ターミナルの場合は2件同時）ため単一IDでは表現できない。
	 * 再接続時はここに残っている全IDを再attachする。
	 */
	private attachedAgents = new Map<string, number>();
	private readonly attachedAgentTargets = new Map<string, string>();
	/** relay瞬断で制御応答だけ失われても、モデルUIを永久にbusyへ固定しない。 */
	private readonly agentControlTimers = new Map<string, { requestId: string; rendererTarget: string; timer: ReturnType<typeof setTimeout> }>();
	private readonly agentCommandCatalogTimers = new Map<string, { requestId: string; rendererTarget: string; timer: ReturnType<typeof setTimeout> }>();
	private readonly pendingAgentActions = new Map<string, { readonly terminalKey: string; readonly rendererTarget: string; readonly resolve: (result: AgentMessageSendResult) => void; readonly timer: ReturnType<typeof setTimeout> }>();
	private readonly pendingActivityDetails = new Map<string, { readonly terminalKey: string; readonly rendererTarget: string; readonly activityId: string; readonly resolve: (messages: AgentActivityDetailMessage[]) => void; readonly reject: (error: Error) => void; readonly timer: ReturnType<typeof setTimeout> }>();
	private readonly terminalOperationOutbox = new Map<string, { readonly operationRun: number; readonly operationSeq: number; readonly payload: Uint8Array; state: 'pending' | 'unknown'; durable: boolean }>();
	private terminalOperationSeq = 0;
	private operationOutboxKey: Uint8Array | undefined;
	private operationOutboxScope: string | undefined;
	private operationOutboxDirty = false;
	private resetting = false;
	/** 最後に何らかのframeを受信した時刻。presence欠落時のPC再起動検出（死活監視）に使う。 */
	private lastFrameAt = 0;
	private livenessTimer: ReturnType<typeof setInterval> | undefined;
	private static readonly LIVENESS_IDLE_MS = 45_000;
	private static readonly LIVENESS_CHECK_INTERVAL_MS = 20_000;
	private outboxReplayEpoch: string | undefined;
	private terminalOperationStorageIssue: string | undefined;
	private terminalOperationCapacityIssue: string | undefined;
	private terminalOperationEnqueueIssue: string | undefined;
	private lastNotifyPrefs: { agentDone: boolean; agentQuestion: boolean; suppressWhenPcFocused: boolean } | undefined;
	private readonly pendingNotificationDismissals = new Set<string>();
	private operationOutboxWrite = Promise.resolve();
	private terminalOperationDispatchChain = Promise.resolve();
	private terminalOperationDispatchDepth = 0;

	constructor(
		private readonly identity: Identity,
		private readonly socketFactory: SocketFactory,
		private readonly onChange: (state: StoreState) => void,
		/** 通知受信時のフック（expo-notifications によるローカル通知表示など）。 */
		private readonly onNotify?: (payload: NotifyPayload) => void,
		/** APNsデバイストークンの取得（iOS実機のみ値を返す）。接続確立ごとにリレーへ登録する。 */
		private readonly getPushToken?: () => Promise<string | undefined>,
		/** aps-environment（開発ビルド='dev'、TestFlight/App Store='prod'）。 */
		private readonly pushEnv: 'dev' | 'prod' = 'prod',
		/** 通知鍵(hex)の永続化（NSEと共有するKeychainへ。iOSのみ）。 */
		private readonly persistNotifyKey?: (hex: string) => Promise<void>,
		/** SecureStoreで予約済みのアプリ起動世代。 */
		private readonly operationRun = 1,
		private readonly operationOutboxStore?: TerminalOperationOutboxStore,
		persistedOperationOutbox?: readonly string[],
		initialCredentials?: PairedCredentials,
	) {
		if (initialCredentials !== undefined) {
			this.activatePairScope(initialCredentials, persistedOperationOutbox ?? []);
		}
	}

	private activatePairScope(creds: PairedCredentials, candidates: readonly string[]): void {
		this.operationOutboxScope = terminalOperationPairingScope(creds);
		this.operationOutboxKey = deriveNotifyKey(this.identity.secretKey, creds.pcPublicKey);
		this.restoreTerminalOperationOutbox(candidates);
	}

	private static bytesToHexStatic(bytes: Uint8Array): string {
		let out = '';
		for (const b of bytes) {
			out += b.toString(16).padStart(2, '0');
		}
		return out;
	}

	/** 接続確立時にAPNsトークンをリレーへ登録する（アプリ未起動時のプッシュ配送先）。 */
	private registerPushToken(): void {
		if (!this.getPushToken) {
			return;
		}
		this.getPushToken().then(token => {
			if (token !== undefined) {
				this.client?.sendControl(encodeRelayControl({ type: 'register-push', token, env: this.pushEnv }));
			}
		}).catch(() => { /* トークン未取得（シミュレータ・権限拒否等）は黙って無視 */ });
	}

	connect(creds: PairedCredentials): void {
		const scope = terminalOperationPairingScope(creds);
		if (this.operationOutboxScope !== scope) {
			this.terminalOperationOutbox.clear();
			this.operationOutboxDirty = false;
			this.terminalOperationStorageIssue = undefined;
			this.terminalOperationCapacityIssue = undefined;
			this.terminalOperationEnqueueIssue = undefined;
			this.refreshTerminalOperationIssue();
			this.operationOutboxScope = scope;
			this.operationOutboxKey = deriveNotifyKey(this.identity.secretKey, creds.pcPublicKey);
		}
		this.lastCredentials = creds;
		// アプリ未起動時のプッシュ本文を Notification Service Extension が復号できるよう、
		// 長期鍵ペアから導出した通知鍵を共有Keychainへ保存しておく（設計書 §5.2）。
		if (this.persistNotifyKey) {
			try {
				const notifyKey = deriveNotifyKey(this.identity.secretKey, creds.pcPublicKey);
				void this.persistNotifyKey(MobileController.bytesToHexStatic(notifyKey)).catch(() => { /* シミュレータ等では失敗してよい */ });
			} catch { /* 導出失敗時はプッシュ本文が固定文になるだけ（致命的でない） */ }
		}
		this.client?.close();
		this.client = new RelayClient(this.identity, creds, this.socketFactory, {
			onStateChange: s => {
				this.state.connection = s;
				if (s !== 'online') {
					this.state.sessionProtocolReady = false;
					this.outboxReplayEpoch = undefined;
					this.cancelPendingAgentActions();
					this.cancelPendingRequests();
					const agentChatsChanged = this.cancelStaleRendererRequests();
					this.emit(agentChatsChanged ? { agentChats: true } : undefined);
				} else {
					this.emit();
				}
				// 再接続完了時: 購読中のagentチャットがあれば手元のepoch/revで再attachする
				// （PC側はepoch一致なら差分のみ、不一致なら全量スナップショットを返す）。
				if (s === 'online') {
					this.requestState();
					this.registerPushToken();
				}
			},
			onPcPresence: online => {
				this.state.pcOnline = online;
				let agentChatsChanged = false;
				if (!online) {
					this.state.sessionProtocolReady = false;
					this.outboxReplayEpoch = undefined;
					this.cancelPendingAgentActions();
					this.cancelPendingRequests();
					agentChatsChanged = this.cancelStaleRendererRequests();
				} else if (this.state.connection === 'online') {
					this.requestState();
				}
				this.emit(agentChatsChanged ? { agentChats: true } : undefined);
			},
			onFrame: frame => { this.lastFrameAt = Date.now(); this.handleFrame(frame); },
		});
		this.client.connect();
		// presence遷移が届かないPC再起動（リレーがPC切断を検知し損ねた場合等）でも自己修復する
		// 死活監視。'online' 表示のまま一定時間何も受信していなければ、応答が必ず返るstate要求を
		// 送り、無応答なら接続を作り直す（フォアグラウンド復帰時のensureConnectedと同じ経路）。
		if (this.livenessTimer !== undefined) {
			clearInterval(this.livenessTimer);
		}
		this.lastFrameAt = Date.now();
		this.livenessTimer = setInterval(() => {
			if (this.client !== undefined && this.state.connection === 'online' && Date.now() - this.lastFrameAt > MobileController.LIVENESS_IDLE_MS) {
				this.ensureConnected();
			}
		}, MobileController.LIVENESS_CHECK_INTERVAL_MS);
	}

	disconnect(): void {
		if (this.livenessTimer !== undefined) {
			clearInterval(this.livenessTimer);
			this.livenessTimer = undefined;
		}
		this.client?.close();
		this.client = undefined;
		this.cancelPendingAgentActions();
		this.cancelPendingRequests();
		this.flushAgentEmit();
		this.state.connection = 'offline';
		this.state.pcOnline = false;
		this.state.sessionProtocolReady = false;
		const agentChatsChanged = this.cancelStaleRendererRequests();
		this.emit(agentChatsChanged ? { agentChats: true } : undefined);
	}

	/** ペアリング解除時: 接続を閉じ、保持している資格情報と表示状態をすべて初期化する。 */
	async reset(): Promise<void> {
		if (this.resetting) {
			throw new Error('reset is already in progress');
		}
		const previousCredentials = this.lastCredentials;
		this.resetting = true;
		this.client?.close();
		this.client = undefined;
		this.cancelPendingAgentActions();
		this.cancelPendingRequests();
		this.cancelStaleRendererRequests();
		this.flushAgentEmit();
		try {
			// journal mutationと同じ排他列にclearを積む。reset開始後のframe/discardは
			// resetting guardで拒否されるため、clear後に旧pair snapshotが再生成されない。
			await this.enqueueTerminalOperationDispatch(async () => {
				await this.operationOutboxWrite;
				await this.operationOutboxStore?.clear();
				this.terminalOperationOutbox.clear();
				this.operationOutboxDirty = false;
			});
			this.lastCredentials = undefined;
			this.attachedAgents.clear();
			this.attachedAgentTargets.clear();
			for (const pending of this.agentControlTimers.values()) {
				clearTimeout(pending.timer);
			}
			this.agentControlTimers.clear();
			for (const pending of this.agentCommandCatalogTimers.values()) {
				clearTimeout(pending.timer);
			}
			this.agentCommandCatalogTimers.clear();
			this.termStreams.clear();
			this.operationOutboxKey = undefined;
			this.operationOutboxScope = undefined;
			this.outboxReplayEpoch = undefined;
			this.terminalOperationStorageIssue = undefined;
			this.terminalOperationCapacityIssue = undefined;
			this.terminalOperationEnqueueIssue = undefined;
			this.state.connection = 'offline';
			this.state.pcOnline = false;
			this.state.sessionProtocolReady = false;
			this.state.workspace = undefined;
			this.state.protocolError = undefined;
			this.refreshTerminalOperationIssue();
			this.state.terminalOutput = new Map();
			this.state.notifications = [];
			this.pendingNotificationDismissals.clear();
			this.state.browserFrame = undefined;
			this.state.agentChats = new Map();
			this.emit({ term: true, notifications: true, agentChats: true });
		} catch (error) {
			// durable clearに失敗した場合は旧pairとcached stateを維持し、再試行できる状態へ戻す。
			this.resetting = false;
			if (previousCredentials !== undefined) {
				this.connect(previousCredentials);
			}
			throw error;
		} finally {
			this.resetting = false;
		}
	}

	/** 手動切断後などに、保存済み資格情報で接続し直す。 */
	reconnect(): void {
		if (this.client) {
			this.client.ensureConnected();
		} else if (this.lastCredentials) {
			this.connect(this.lastCredentials);
		}
	}

	/** バックグラウンド通知をAPNsへ一本化するため、フォアグラウンド用ソケットを止める。 */
	suspendForBackground(): void {
		if (!this.client) {
			return;
		}
		this.state.pcOnline = false;
		this.cancelPendingAgentActions();
		this.cancelPendingRequests();
		this.client.suspend();
	}

	/** 復帰時は旧ソケットを再利用せず、新しい接続から購読中データだけを再同期する。 */
	resumeFromBackground(): void {
		if (this.client) {
			this.client.resume();
		} else if (this.lastCredentials) {
			this.connect(this.lastCredentials);
		}
	}

	/** 未接続なら即座に接続、'online' 表示中は生存確認する（フォアグラウンド復帰時用）。 */
	ensureConnected(): void {
		const client = this.client;
		if (!client) {
			return;
		}
		if (client.connectionState === 'online') {
			// zombie検出: 応答が必ず返るstate要求を送り、無応答なら接続を作り直す
			this.requestState();
			client.probeLiveness();
		} else {
			client.ensureConnected();
		}
	}

	/**
	 * ターミナルにアタッチ（出力購読を要求）。attachごとに新しい epoch を採番し、
	 * PC側は epoch/seq 付きの同期ストリーム（snapshot→data...）で応答する。
	 * seq欠落検出時・再接続時の再同期もこのメソッドで行う（新epochで取り直し）。
	 */
	attachTerminal(terminalKey: string): void {
		const stream = this.ensureTermStream(terminalKey);
		stream.epoch = ++this.termEpochCounter;
		stream.lastSeq = undefined;
		stream.unackedChars = 0;
		// 旧画面は新snapshot到着まで保持する。reload中に空画面へ退行させない。
		stream.rendererTarget = this.rendererTargetFor(terminalKey);
		void this.sendTerm(terminalKey, { t: 'attach', epoch: stream.epoch });
	}

	detachTerminal(terminalKey: string): void {
		// ストリーム状態は消さない（cache をタブ再訪時の即時再描画に使う）。
		// epoch はattach時に必ず更新されるため、detach後に届く残りフレームは無害。
		void this.sendTerm(terminalKey, { t: 'detach' });
	}

	/**
	 * ターミナルの同期ストリームを購読する。購読時点のリプレイキャッシュ
	 * （最後のsnapshot＋後続data）を同期的に再生してから、以後のライブイベントを流す。
	 */
	subscribeTerminal(terminalKey: string, listener: (ev: TermStreamEvent) => void): () => void {
		const stream = this.ensureTermStream(terminalKey);
		stream.listeners.add(listener);
		if (stream.cache) {
			for (const ev of stream.cache.events) {
				listener(ev);
			}
		}
		return () => {
			stream.listeners.delete(listener);
		};
	}

	private termEpochCounter = 0;
	private readonly termStreams = new Map<string, TermStreamState>();

	private ensureTermStream(terminalKey: string): TermStreamState {
		let stream = this.termStreams.get(terminalKey);
		if (!stream) {
			stream = { epoch: 0, lastSeq: undefined, unackedChars: 0, listeners: new Set(), cache: undefined, rendererTarget: undefined };
			this.termStreams.set(terminalKey, stream);
		}
		return stream;
	}

	/** ターミナルへ入力を送る。 */
	sendInput(terminalKey: string, data: string): Promise<boolean> {
		return this.sendTerm(terminalKey, { t: 'input', data });
	}

	sendLiveInput(terminalKey: string, data: string): boolean {
		const rendererTarget = this.rendererTargetFor(terminalKey);
		// legacy TUI fallbackのキー列は遅延配送しない。durable outbox処理が先行中なら
		// 新しいinteractionへ誤注入するよりfail closedで呼び出し側に再試行させる。
		if (this.terminalOperationDispatchDepth !== 0 || !this.isLiveAvailable() || this.outboxReplayEpoch !== this.state.workspace?.desktopEpoch || rendererTarget === undefined) {
			return false;
		}
		void this.sendTerm(terminalKey, { t: 'input', data }, false, rendererTarget, this.agentInputContextFor(terminalKey));
		return true;
	}

	/**
	 * 矢印キーをセマンティック名で送る。PC側が端末モード（application cursor keys）に
	 * 合わせて CSI / SS3 へエンコードする（vim / less 等で矢印が効かない問題の対策）。
	 * data には同じ操作の生シーケンスも併載する。
	 */
	sendArrowKey(terminalKey: string, key: 'up' | 'down' | 'right' | 'left'): void {
		const fallback = { up: '\u001b[A', down: '\u001b[B', right: '\u001b[C', left: '\u001b[D' }[key];
		void this.sendTerm(terminalKey, { t: 'input', data: fallback, key });
	}

	/**
	 * コンポーザーからのテキスト入力を送る。PC側は bracketed paste モード中なら
	 * ESC[200~...ESC[201~ で包み、複数行テキストが1行目で実行されるのを防ぐ。
	 * execute=true で末尾にEnterを付けて実行する。data には改行をEnterへ正規化した
	 * 生入力も併載する。
	 */
	sendTextInput(terminalKey: string, text: string, execute: boolean): Promise<boolean> {
		const normalized = text.replace(/\r?\n/g, '\r');
		const fallback = execute && !normalized.endsWith('\r') ? normalized + '\r' : normalized;
		return this.sendTerm(terminalKey, { t: 'input', data: fallback, text, execute });
	}

	/** session検証付きAgent Action。 */
	sendAgentMessage(terminalKey: string, text: string): Promise<AgentMessageSendResult> {
		const chat = this.state.agentChats.get(terminalKey);
		if (!this.isLiveAvailable()) {
			return Promise.resolve({ status: 'rejected', message: 'PCとの接続が切れています' });
		}
		if (chat === undefined || chat.none || chat.capabilities?.agentActions !== true) {
			return Promise.resolve({ status: 'rejected', message: 'エージェントセッションを準備中です。少し待ってから再送してください。' });
		}
		return this.sendAgentActionResult(terminalKey, {
			t: 'action/sendMessage', token: this.agentToken(terminalKey), epoch: chat.epoch, text,
		});
	}

	answerAgentQuestion(terminalKey: string, interactionId: string, answers: readonly AgentQuestionAnswer[]): Promise<boolean> {
		const chat = this.state.agentChats.get(terminalKey);
		if (!this.isLiveAvailable() || chat?.capabilities?.agentActions !== true
			|| chat.interaction?.kind !== 'question' || chat.interaction.id !== interactionId) {
			return Promise.resolve(false);
		}
		return this.sendAgentAction(terminalKey, {
			t: 'action/answerQuestion', token: this.agentToken(terminalKey), epoch: chat.epoch, interactionId, answers,
		}, 60_000);
	}

	answerAgentApproval(terminalKey: string, interactionId: string, choice: string): Promise<boolean> {
		const chat = this.state.agentChats.get(terminalKey);
		if (!this.isLiveAvailable() || chat?.capabilities?.agentActions !== true
			|| chat.interaction?.kind !== 'approval' || chat.interaction.id !== interactionId
			|| (chat.interaction.choices !== undefined
				? !chat.interaction.choices.some(candidate => candidate.id === choice)
				: choice !== 'yes' && choice !== 'no')) {
			return Promise.resolve(false);
		}
		return this.sendAgentAction(terminalKey, {
			t: 'action/answerApproval', token: this.agentToken(terminalKey), epoch: chat.epoch, interactionId, choice,
		}, 60_000);
	}

	updateClaudeSetting(terminalKey: string, setting: 'model' | 'effort', value: string): Promise<boolean> {
		const chat = this.state.agentChats.get(terminalKey);
		if (!this.isLiveAvailable() || chat?.agent !== 'claude' || chat.capabilities?.claudeSettings !== true
			|| chat.interaction !== undefined || !/^[A-Za-z0-9._:-]{1,200}$/.test(value)) {
			return Promise.resolve(false);
		}
		return this.sendAgentAction(terminalKey, {
			t: 'action/claudeSetting', token: this.agentToken(terminalKey), epoch: chat.epoch, setting, value,
		});
	}

	requestAgentActivityDetail(terminalKey: string, activityId: string): Promise<AgentActivityDetailMessage[]> {
		const chat = this.state.agentChats.get(terminalKey);
		const terminal = this.terminalForKey(terminalKey);
		const rendererTarget = this.rendererTargetFor(terminalKey);
		if (!this.isLiveAvailable() || rendererTarget === undefined || chat === undefined || terminal === undefined || !chat.activity?.agents.some(agent => agent.id === activityId && agent.role === 'subagent')) {
			return Promise.reject(new Error('SubAgentが見つかりません'));
		}
		const requestId = `${this.requestPrefix}-agent-detail-${this.requestCounter++}`;
		return new Promise((resolve, reject) => {
			const timer = setTimeout(() => {
				this.pendingActivityDetails.delete(requestId);
				reject(new Error('SubAgent詳細の取得がタイムアウトしました'));
			}, 15_000);
			this.pendingActivityDetails.set(requestId, { terminalKey, rendererTarget, activityId, resolve, reject, timer });
			this.client?.send('agent', encoder.encode(JSON.stringify({ t: 'activity-detail', id: terminal.id, token: this.agentToken(terminalKey), requestId, epoch: chat.epoch, activityId })));
		});
	}

	private sendAgentAction(terminalKey: string, body: Record<string, unknown>, timeoutMs = 30_000): Promise<boolean> {
		return this.sendAgentActionResult(terminalKey, body, timeoutMs).then(result => result.status === 'accepted');
	}

	private sendAgentActionResult(terminalKey: string, body: Record<string, unknown>, timeoutMs = 30_000): Promise<AgentMessageSendResult> {
		if (!this.isLiveAvailable()) {
			return Promise.resolve({ status: 'rejected', message: 'PCへ再接続してから操作してください' });
		}
		const terminal = this.terminalForKey(terminalKey);
		const rendererTarget = this.rendererTargetFor(terminalKey);
		if (terminal === undefined || rendererTarget === undefined) {
			return Promise.resolve({ status: 'rejected', message: 'PC画面の再接続が完了してから再送してください' });
		}
		const requestId = `${this.requestPrefix}-agent-action-${this.requestCounter++}`;
		return new Promise(resolve => {
			const timer = setTimeout(() => {
				if (this.pendingAgentActions.delete(requestId)) {
					resolve({ status: 'rejected' });
				}
			}, timeoutMs);
			this.pendingAgentActions.set(requestId, { terminalKey, rendererTarget, resolve, timer });
			this.client?.send('agent', encoder.encode(JSON.stringify({ ...body, id: terminal.id, requestId })));
		});
	}

	private cancelPendingAgentActions(): void {
		for (const pending of this.pendingAgentActions.values()) {
			clearTimeout(pending.timer);
			pending.resolve({ status: 'rejected' });
		}
		this.pendingAgentActions.clear();
		for (const pending of this.pendingActivityDetails.values()) {
			clearTimeout(pending.timer);
			pending.reject(new Error('接続が切断されました'));
		}
		this.pendingActivityDetails.clear();
	}

	/** PC側に新規ターミナルを作成する（ws指定でそのリポジトリをcwdに）。 */
	createTerminal(ws?: string): void {
		const workspace = ws !== undefined ? this.state.workspace?.workspaces.find(item => item.id === ws) : this.state.workspace?.workspaces[0];
		const desktop = this.state.workspace;
		if (workspace === undefined || desktop === undefined) {
			return;
		}
		void this.sendTerminalOperation({
			protocolVersion: 3,
			desktopEpoch: desktop.desktopEpoch,
			t: 'create',
			windowId: workspace.windowId,
			ws: workspace.sourceId,
		});
	}

	/** ターミナル名を変更する。表示更新はPC側の権威的なstate再送で確定する。 */
	renameTerminal(terminalKey: string, title: string): void {
		void this.sendTerm(terminalKey, { t: 'rename', title });
	}

	/**
	 * ターミナルを削除する。PC側の実インスタンスも閉じる（instance.dispose）破壊的操作のため、
	 * 呼び出し側（ホーム長押しメニュー）で確認ダイアログを経てから呼ぶ想定。
	 * 表示更新はPC側の権威的なstate再送で確定する。
	 */
	closeTerminal(terminalKey: string): void {
		void this.sendTerm(terminalKey, { t: 'close' });
	}

	/**
	 * エージェントの「レビュー」状態を確認済みにする（ホームのステータスバッジタップ）。
	 * PC側のフォーカス中自動既読と同じ経路を通り、関連通知のdismissも走る。
	 * 表示更新はPC側の権威的なstate再送で確定する。
	 */
	ackAgentStatus(terminalKey: string): void {
		void this.sendTerm(terminalKey, { t: 'ackStatus' });
	}

	/** 現在の状態スナップショットを要求する。 */
	requestState(): void {
		this.client?.send('state', encoder.encode(JSON.stringify({ protocolVersion: 3 })));
	}

	private resumeLiveSessionSubscriptions(): void {
		for (const terminalKey of this.attachedAgents.keys()) {
			this.sendAgentAttach(terminalKey);
		}
		for (const [terminalKey, stream] of this.termStreams) {
			if (stream.listeners.size > 0) {
				this.attachTerminal(terminalKey);
			}
		}
		if (this.lastNotifyPrefs !== undefined) {
			this.client?.send('notify', encoder.encode(JSON.stringify({ t: 'prefs', ...this.lastNotifyPrefs })));
		}
		for (const id of this.pendingNotificationDismissals) {
			this.client?.send('notify', encodeNotifyDismiss(id));
		}
	}

	/**
	 * 通知設定をPCへ同期する（notifyチャネル M→PC）。PC側はオフライン端末への
	 * APNsフォールバックプッシュの抑制判定に使う（設定画面参照）。
	 */
	sendNotifyPrefs(prefs: { agentDone: boolean; agentQuestion: boolean; suppressWhenPcFocused: boolean }): void {
		this.lastNotifyPrefs = prefs;
		if (this.isLiveAvailable()) {
			this.client?.send('notify', encoder.encode(JSON.stringify({ t: 'prefs', ...prefs })));
		}
	}

	private sendTerm(terminalKey: string, msg: { t: string; data?: string; key?: string; text?: string; execute?: boolean; epoch?: number; seq?: number; title?: string }, durableMutation = true, expectedRendererTarget?: string, expectedAgentInputContext?: string): Promise<boolean> {
		const workspace = this.state.workspace;
		if (workspace === undefined || !workspace.terminals.some(terminal => terminal.terminalKey === terminalKey)) {
			return Promise.resolve(false);
		}
		return this.sendTerminalOperation({
			protocolVersion: 3,
			desktopEpoch: workspace.desktopEpoch,
			terminalKey,
			...msg,
		}, durableMutation, expectedRendererTarget, expectedAgentInputContext);
	}

	private sendTerminalOperation(body: Record<string, unknown>, durableMutation = true, expectedRendererTarget?: string, expectedAgentInputContext?: string): Promise<boolean> {
		if (this.resetting || this.operationOutboxScope === undefined || this.state.protocolError !== undefined) {
			return Promise.resolve(false);
		}
		const operationSeq = this.terminalOperationSeq++;
		const operationId = `${this.requestPrefix}-term-${this.operationRun}-${operationSeq}`;
		const payload = encoder.encode(JSON.stringify({
			...body,
			operationId,
			operationRun: this.operationRun,
			operationSeq,
		}));
		if (durableMutation && typeof body.t === 'string' && ['input', 'create', 'rename', 'close', 'ackStatus'].includes(body.t)) {
			if (this.terminalOperationOutbox.size >= MAX_TERMINAL_OPERATION_OUTBOX) {
				this.terminalOperationCapacityIssue = '未確認の操作が多いため、新しい操作を送信しませんでした。PCの状態を確認してからもう一度お試しください。';
				this.terminalOperationEnqueueIssue = this.terminalOperationCapacityIssue;
				this.refreshTerminalOperationIssue();
				this.emit();
				return Promise.resolve(false);
			}
			const operation = { operationRun: this.operationRun, operationSeq, payload, state: 'pending' as const, durable: false };
			this.terminalOperationOutbox.set(operationId, operation);
			this.operationOutboxDirty = true;
			return this.enqueueTerminalOperationDispatch(async () => {
				this.operationOutboxDirty = true;
				try {
					await this.persistTerminalOperationOutbox(() => {
						if (this.terminalOperationOutbox.get(operationId) === operation) {
							this.terminalOperationOutbox.delete(operationId);
						}
					});
					const hadEnqueueIssue = this.terminalOperationEnqueueIssue !== undefined || this.terminalOperationCapacityIssue !== undefined;
					this.terminalOperationEnqueueIssue = undefined;
					this.terminalOperationCapacityIssue = undefined;
					this.refreshTerminalOperationIssue();
					if (hadEnqueueIssue) {
						this.emit();
					}
					if (this.terminalOperationOutbox.get(operationId) === operation && operation.state === 'pending' && operation.durable && this.canDispatchTerminalOperation(operation, true)) {
						this.client?.send('term', payload);
					}
					return true;
				} catch {
					this.terminalOperationEnqueueIssue = '操作を安全に保存できなかったため、PCへ送信しませんでした。入力内容を確認して、もう一度お試しください。';
					this.refreshTerminalOperationIssue();
					this.emit();
					return false;
				}
			});
		}
		if (this.isLiveAvailable()) {
			return this.enqueueTerminalOperationDispatch(() => {
				if ((expectedRendererTarget === undefined || (typeof body.terminalKey === 'string' && this.rendererTargetFor(body.terminalKey) === expectedRendererTarget))
					&& (expectedAgentInputContext === undefined || (typeof body.terminalKey === 'string' && this.agentInputContextFor(body.terminalKey) === expectedAgentInputContext))
					&& this.canDispatchTerminalOperation({ payload })) {
					this.client?.send('term', payload);
					return true;
				}
				return false;
			});
		}
		return Promise.resolve(false);
	}

	private async resendTerminalOperationOutboxWithinDispatch(): Promise<void> {
		await this.operationOutboxWrite;
		for (const operation of [...this.terminalOperationOutbox.values()]
			.filter(operation => operation.state === 'pending' && operation.durable && this.canDispatchTerminalOperation(operation, true))
			.sort((a, b) => a.operationRun - b.operationRun || a.operationSeq - b.operationSeq)) {
			this.client?.send('term', operation.payload);
		}
	}

	private canDispatchTerminalOperation(operation: { readonly payload: Uint8Array }, allowAuthoritativeMissing = false): boolean {
		if (!this.isLiveAvailable() || this.outboxReplayEpoch === undefined) {
			return false;
		}
		try {
			const message = JSON.parse(decoder.decode(operation.payload)) as { desktopEpoch?: unknown; t?: unknown; terminalKey?: unknown; windowId?: unknown; ws?: unknown };
			if (message.desktopEpoch !== this.outboxReplayEpoch) {
				return false;
			}
			const workspace = this.state.workspace;
			if (workspace === undefined) {
				return false;
			}
			if (message.t === 'create') {
				const targetWorkspace = typeof message.windowId === 'number' && typeof message.ws === 'string'
					? workspace.workspaces.find(candidate => candidate.windowId === message.windowId && candidate.sourceId === message.ws)
					: undefined;
				return targetWorkspace === undefined
					? allowAuthoritativeMissing && workspace.complete
					: workspace.renderers.some(renderer => renderer.windowId === targetWorkspace.windowId && renderer.ready);
			}
			const terminal = typeof message.terminalKey === 'string'
				? workspace.terminals.find(candidate => candidate.terminalKey === message.terminalKey)
				: undefined;
			return terminal === undefined
				? allowAuthoritativeMissing && workspace.complete
				: workspace.renderers.some(renderer => renderer.windowId === terminal.windowId
					&& renderer.rendererGeneration === terminal.rendererGeneration && renderer.ready);
		} catch {
			return false;
		}
	}

	private isLiveAvailable(): boolean {
		return this.operationOutboxScope !== undefined && this.state.connection === 'online' && this.state.pcOnline
			&& this.state.sessionProtocolReady && this.state.protocolError === undefined && !this.resetting;
	}

	private agentInputContextFor(terminalKey: string): string {
		const chat = this.state.agentChats.get(terminalKey);
		const interaction = chat?.interaction;
		return JSON.stringify([
			chat !== undefined && !chat.none ? chat.epoch : null,
			interaction?.kind ?? null,
			interaction?.id ?? null,
		]);
	}

	private reconcileTerminalOperationOutbox(desktopEpoch: string): void {
		void this.enqueueTerminalOperationDispatch(async () => {
			if (this.resetting) {
				return;
			}
			if (this.outboxReplayEpoch === desktopEpoch) {
				try {
					if (this.operationOutboxDirty) {
						await this.persistTerminalOperationOutbox();
					}
					// 同じdesktop epochでもRenderer ready遷移後に保留操作を再評価する。
					await this.resendTerminalOperationOutboxWithinDispatch();
				} catch {
					this.setTerminalOperationStorageIssue('操作状態を安全に保存できなかったため、再送を停止しました。');
					this.emit();
				}
				return;
			}
			// 永続化が失敗した同じepochのStateで再試行できるよう、成功するまで確定しない。
			this.outboxReplayEpoch = undefined;
			let changed = false;
			for (const operation of this.terminalOperationOutbox.values()) {
				if (operation.state !== 'pending') {
					continue;
				}
				try {
					const payload = JSON.parse(decoder.decode(operation.payload)) as { desktopEpoch?: unknown };
					if (payload.desktopEpoch !== desktopEpoch) {
						operation.state = 'unknown';
						this.operationOutboxDirty = true;
						changed = true;
					}
				} catch {
					operation.state = 'unknown';
					this.operationOutboxDirty = true;
					changed = true;
				}
			}
			this.refreshTerminalOperationIssue();
			try {
				if (changed || this.operationOutboxDirty) {
					await this.persistTerminalOperationOutbox();
				}
				this.outboxReplayEpoch = desktopEpoch;
				this.refreshTerminalOperationIssue();
				this.emit();
				await this.resendTerminalOperationOutboxWithinDispatch();
			} catch {
				this.setTerminalOperationStorageIssue('操作状態を安全に保存できなかったため、再送を停止しました。');
				this.emit();
			}
		});
	}

	private refreshTerminalOperationIssue(): void {
		const count = [...this.terminalOperationOutbox.values()].filter(operation => operation.state === 'unknown').length;
		this.state.unknownTerminalOperationCount = count;
		const unknownIssue = count > 0
			? `結果を確認できなかった操作が${count}件あります。PCの状態を確認し、必要な操作だけ手動でやり直してください。`
			: undefined;
		this.state.terminalOperationIssue = this.terminalOperationEnqueueIssue ?? this.terminalOperationStorageIssue ?? this.terminalOperationCapacityIssue ?? unknownIssue;
	}

	private setTerminalOperationStorageIssue(issue: string | undefined): void {
		this.terminalOperationStorageIssue = issue;
		this.refreshTerminalOperationIssue();
	}

	private handleTerminalOperationResult(operationId: string | undefined, status: string | undefined): void {
		if (typeof operationId !== 'string' || typeof status !== 'string') {
			return;
		}
		void this.enqueueTerminalOperationDispatch(async () => {
			if (this.resetting) {
				return;
			}
			const pending = this.terminalOperationOutbox.get(operationId);
			let changed = false;
			if (pending !== undefined && (status === 'outcome-unknown' || status === 'stale-epoch')) {
				pending.state = 'unknown';
				this.operationOutboxDirty = true;
				changed = true;
			} else if (pending !== undefined && ['accepted', 'terminal-not-found', 'failed', 'stale-renderer'].includes(status)) {
				this.terminalOperationOutbox.delete(operationId);
				this.operationOutboxDirty = true;
				changed = true;
			}
			if (changed) {
				this.refreshTerminalOperationIssue();
				try {
					await this.persistTerminalOperationOutbox();
				} catch {
					// memory上の保守的状態（unknown/削除）は維持する。同じIDの再出現はPC ledgerが
					// final/unknownを再応答し、PC再起動時はdesktopEpoch gateが再実行を止める。
					this.setTerminalOperationStorageIssue('操作結果を安全に保存できませんでした。再接続後にPCの状態を確認してください。');
				}
				this.emit();
			}
			if (status !== 'accepted') {
				this.requestState();
			}
		});
	}

	async discardUnknownTerminalOperations(): Promise<boolean> {
		return this.enqueueTerminalOperationDispatch(async () => {
			if (this.resetting) {
				return false;
			}
			const removed = [...this.terminalOperationOutbox].filter(([, operation]) => operation.state === 'unknown');
			if (removed.length === 0) {
				return true;
			}
			for (const [operationId] of removed) {
				this.terminalOperationOutbox.delete(operationId);
			}
			this.operationOutboxDirty = true;
			try {
				await this.persistTerminalOperationOutbox();
				this.refreshTerminalOperationIssue();
				this.emit();
				return true;
			} catch {
				for (const [operationId, operation] of removed) {
					this.terminalOperationOutbox.set(operationId, operation);
				}
				this.operationOutboxDirty = true;
				this.setTerminalOperationStorageIssue('結果不明の操作記録を削除できませんでした。もう一度お試しください。');
				this.emit();
				return false;
			}
		});
	}

	private enqueueTerminalOperationDispatch<T>(callback: () => T | Promise<T>): Promise<T> {
		this.terminalOperationDispatchDepth++;
		const run = this.terminalOperationDispatchChain.then(callback);
		const tracked = run.then(
			value => { this.terminalOperationDispatchDepth--; return value; },
			error => { this.terminalOperationDispatchDepth--; throw error; },
		);
		this.terminalOperationDispatchChain = tracked.then(() => undefined, () => undefined);
		return tracked;
	}

	private restoreTerminalOperationOutbox(candidates: readonly string[]): void {
		const key = this.operationOutboxKey;
		const scope = this.operationOutboxScope;
		if (key === undefined || scope === undefined) {
			return;
		}
		for (const encrypted of candidates) {
			try {
				const decoded = decoder.decode(openNotify(key, fromB64(encrypted)));
				const parsed = JSON.parse(decoded) as { version?: unknown; pairingScope?: unknown; operations?: unknown };
				if (parsed.version !== 2 || parsed.pairingScope !== scope || !Array.isArray(parsed.operations)) {
					continue;
				}
				const restored = new Map<string, { readonly operationRun: number; readonly operationSeq: number; readonly payload: Uint8Array; state: 'pending' | 'unknown'; durable: boolean }>();
				for (const raw of parsed.operations.slice(0, MAX_TERMINAL_OPERATION_OUTBOX)) {
					const operation = raw as Partial<PersistedTerminalOperation>;
					if (typeof operation.operationId !== 'string' || operation.operationId.length === 0 || operation.operationId.length > 200
						|| !Number.isSafeInteger(operation.operationRun) || (operation.operationRun ?? 0) < 1
						|| !Number.isSafeInteger(operation.operationSeq) || (operation.operationSeq ?? -1) < 0
						|| typeof operation.payload !== 'string' || operation.payload.length > 500_000
						|| (operation.state !== 'pending' && operation.state !== 'unknown')) {
						continue;
					}
					const payload = encoder.encode(operation.payload);
					const message = JSON.parse(operation.payload) as { operationId?: unknown; operationRun?: unknown; operationSeq?: unknown };
					if (message.operationId !== operation.operationId || message.operationRun !== operation.operationRun || message.operationSeq !== operation.operationSeq) {
						continue;
					}
					restored.set(operation.operationId, {
						operationRun: operation.operationRun!, operationSeq: operation.operationSeq!, payload, state: operation.state, durable: true,
					});
				}
				for (const [operationId, operation] of restored) {
					this.terminalOperationOutbox.set(operationId, operation);
				}
				this.refreshTerminalOperationIssue();
				return;
			} catch {
				// 改ざん・破損候補は次のjournal候補へフォールバックする。
			}
		}
	}

	private persistTerminalOperationOutbox(onFailure?: () => void): Promise<void> {
		if (this.operationOutboxStore === undefined) {
			for (const operation of this.terminalOperationOutbox.values()) {
				operation.durable = true;
			}
			this.operationOutboxDirty = false;
			const recovered = this.terminalOperationStorageIssue !== undefined;
			this.setTerminalOperationStorageIssue(undefined);
			if (recovered) {
				this.emit();
			}
			return Promise.resolve();
		}
		const write = this.operationOutboxWrite.then(async () => {
			const key = this.operationOutboxKey;
			const pairingScope = this.operationOutboxScope;
			if (key === undefined || pairingScope === undefined) {
				throw new Error('operation outbox pair scope is unavailable');
			}
			const snapshot = [...this.terminalOperationOutbox];
			const operations: PersistedTerminalOperation[] = snapshot.map(([operationId, operation]) => ({
				operationId,
				operationRun: operation.operationRun,
				operationSeq: operation.operationSeq,
				payload: decoder.decode(operation.payload),
				state: operation.state,
			}));
			const encrypted = toBase64Url(sealNotify(key, encoder.encode(JSON.stringify({ version: 2, pairingScope, operations }))));
			await this.operationOutboxStore!.save(encrypted);
			for (const [operationId, operation] of snapshot) {
				if (this.terminalOperationOutbox.get(operationId) === operation) {
					operation.durable = true;
				}
			}
			this.operationOutboxDirty = false;
			const recovered = this.terminalOperationStorageIssue !== undefined;
			this.setTerminalOperationStorageIssue(undefined);
			if (recovered) {
				this.emit();
			}
		});
		const handled = write.catch(error => {
			onFailure?.();
			throw error;
		});
		this.operationOutboxWrite = handled.catch(() => { });
		return handled;
	}

	// --- agent チャット（エージェントセッションのチャットミラー） ----------------

	/**
	 * エージェントチャットの購読を開始する（切断→再接続時は自動で再attachされる）。
	 * 参照カウント方式: 同じidに対する2件目以降の呼び出しはPCへの再送信をせず
	 * カウントのみ増やす（ホーム画面とエージェント画面が同時に同じターミナルを
	 * 購読するケースで、片方のdetachがもう片方の購読を切らないようにするため）。
	 */
	attachAgent(terminalKey: string): void {
		const count = (this.attachedAgents.get(terminalKey) ?? 0) + 1;
		this.attachedAgents.set(terminalKey, count);
		if (count === 1) {
			this.sendAgentAttach(terminalKey);
		}
	}

	detachAgent(terminalKey: string): void {
		const count = this.attachedAgents.get(terminalKey);
		if (count === undefined) {
			return;
		}
		if (count <= 1) {
			this.attachedAgents.delete(terminalKey);
			this.attachedAgentTargets.delete(terminalKey);
			const terminal = this.terminalForKey(terminalKey);
			if (terminal !== undefined && this.isLiveAvailable() && this.rendererTargetFor(terminalKey) !== undefined) {
				this.client?.send('agent', encoder.encode(JSON.stringify({ t: 'detach', id: terminal.id, token: this.agentToken(terminalKey) })));
			}
		} else {
			this.attachedAgents.set(terminalKey, count - 1);
		}
	}

	/** チャット表示の再読み込み（セッションが見つからなかった後の再試行にも使う）。 */
	refreshAgent(terminalKey: string): void {
		if (!this.isLiveAvailable()) {
			return;
		}
		this.state.agentChats.delete(terminalKey);
		this.emit({ agentChats: true });
		if (this.attachedAgents.has(terminalKey)) {
			this.sendAgentAttach(terminalKey);
		}
	}

	/** 対象Codexセッションの最新モデルカタログをPCへ要求する。 */
	requestAgentModelCatalog(terminalKey: string): void {
		const existing = this.state.agentChats.get(terminalKey);
		const terminal = this.terminalForKey(terminalKey);
		const rendererTarget = this.rendererTargetFor(terminalKey);
		if (!this.isLiveAvailable() || rendererTarget === undefined || existing === undefined || existing.none || existing.agent !== 'codex'
			|| terminal === undefined || existing.modelControl?.status === 'loading' || existing.modelControl?.status === 'updating') {
			return;
		}
		const requestId = `${this.requestPrefix}-agent-models-${this.requestCounter++}`;
		this.state.agentChats.set(terminalKey, {
			...existing,
			modelControl: { status: 'loading', requestId, models: existing.modelControl?.models ?? [] },
		});
		this.emit({ agentChats: true });
		this.client?.send('agent', encoder.encode(JSON.stringify({ t: 'model-catalog', id: terminal.id, token: this.agentToken(terminalKey), requestId })));
		this.scheduleAgentControlTimeout(terminalKey, requestId, rendererTarget, 'Codexのモデル一覧取得がタイムアウトしました');
	}

	/** 対象セッションのプロバイダー別スラッシュコマンドとスキル一覧をPCへ要求する。 */
	requestAgentCommandCatalog(terminalKey: string): void {
		const existing = this.state.agentChats.get(terminalKey);
		const terminal = this.terminalForKey(terminalKey);
		const rendererTarget = this.rendererTargetFor(terminalKey);
		if (!this.isLiveAvailable() || rendererTarget === undefined || existing === undefined || existing.none || terminal === undefined
			|| existing.commandCatalog?.status === 'loading') {
			return;
		}
		const requestId = `${this.requestPrefix}-agent-commands-${this.requestCounter++}`;
		this.state.agentChats.set(terminalKey, {
			...existing,
			commandCatalog: { status: 'loading', requestId, commands: existing.commandCatalog?.commands ?? [] },
		});
		this.emit({ agentChats: true });
		this.client?.send('agent', encoder.encode(JSON.stringify({ t: 'command-catalog', id: terminal.id, token: this.agentToken(terminalKey), requestId })));
		this.clearAgentCommandCatalogTimeout(terminalKey);
		const timer = setTimeout(() => {
			const current = this.state.agentChats.get(terminalKey);
			if (current?.commandCatalog?.requestId === requestId) {
				this.state.agentChats.set(terminalKey, {
					...current,
					commandCatalog: { status: 'error', commands: current.commandCatalog.commands, errorMessage: 'コマンド一覧の取得がタイムアウトしました' },
				});
				this.emit({ agentChats: true });
			}
			this.agentCommandCatalogTimers.delete(terminalKey);
		}, 15_000);
		this.agentCommandCatalogTimers.set(terminalKey, { requestId, rendererTarget, timer });
	}

	private clearAgentCommandCatalogTimeout(terminalKey: string, requestId?: string): void {
		const pending = this.agentCommandCatalogTimers.get(terminalKey);
		if (pending !== undefined && (requestId === undefined || pending.requestId === requestId)) {
			clearTimeout(pending.timer);
			this.agentCommandCatalogTimers.delete(terminalKey);
		}
	}

	/** 検証済みカタログのモデルとEffortを、Codexの次ターン設定へ同時適用する。 */
	updateAgentSettings(terminalKey: string, model: string, effort: string): void {
		const existing = this.state.agentChats.get(terminalKey);
		const terminal = this.terminalForKey(terminalKey);
		const rendererTarget = this.rendererTargetFor(terminalKey);
		if (!this.isLiveAvailable() || rendererTarget === undefined || existing === undefined || existing.none || existing.agent !== 'codex' || terminal === undefined || existing.modelControl?.status === 'updating') {
			return;
		}
		const selected = existing.modelControl?.models.find(option => option.model === model);
		if (selected === undefined || !selected.efforts.some(option => option.value === effort)) {
			return;
		}
		const requestId = `${this.requestPrefix}-agent-settings-${this.requestCounter++}`;
		this.state.agentChats.set(terminalKey, {
			...existing,
			modelControl: {
				status: 'updating', requestId, models: existing.modelControl?.models ?? [],
				pending: { model, effort },
			},
		});
		this.emit({ agentChats: true });
		this.client?.send('agent', encoder.encode(JSON.stringify({ t: 'settings-update', id: terminal.id, token: this.agentToken(terminalKey), requestId, model, effort })));
		this.scheduleAgentControlTimeout(terminalKey, requestId, rendererTarget, 'Codexの設定変更がタイムアウトしました');
	}

	private scheduleAgentControlTimeout(terminalKey: string, requestId: string, rendererTarget: string, message: string): void {
		this.clearAgentControlTimeout(terminalKey);
		const timer = setTimeout(() => {
			const existing = this.state.agentChats.get(terminalKey);
			if (existing?.modelControl?.requestId === requestId) {
				this.state.agentChats.set(terminalKey, {
					...existing,
					modelControl: { status: 'error', models: existing.modelControl.models, errorCode: 'timeout', errorMessage: message },
				});
				this.emit({ agentChats: true });
			}
			this.agentControlTimers.delete(terminalKey);
		}, 30_000);
		this.agentControlTimers.set(terminalKey, { requestId, rendererTarget, timer });
	}

	private clearAgentControlTimeout(terminalKey: string, requestId?: string): void {
		const pending = this.agentControlTimers.get(terminalKey);
		if (pending !== undefined && (requestId === undefined || pending.requestId === requestId)) {
			clearTimeout(pending.timer);
			this.agentControlTimers.delete(terminalKey);
		}
	}

	private sendAgentAttach(terminalKey: string): void {
		if (!this.isLiveAvailable()) {
			return;
		}
		const terminal = this.terminalForKey(terminalKey);
		if (terminal === undefined) {
			return;
		}
		const target = this.rendererTargetFor(terminalKey);
		if (target === undefined) {
			return;
		}
		this.attachedAgentTargets.set(terminalKey, target);
		// 手元に同ターミナルの受信済み状態があれば epoch/afterRev を申告して差分だけ受け取る。
		// afterRev は「最後に受信したメッセージの rev」を申告する。PC側の rev フィールドは
		// 「次に採番される値」（最後のメッセージ+1）で、PC側の差分フィルタは m.rev > afterRev の
		// ため、これをそのまま送ると切断中に届いた最初のメッセージ (rev = afterRev) が毎回
		// 除外されてしまう（バックグラウンド復帰のたびにPCで打ったプロンプトが1件消えるバグ）。
		const existing = this.state.agentChats.get(terminalKey);
		const lastMessageRev = existing !== undefined
			? existing.messages[existing.messages.length - 1]?.rev ?? existing.rev - 1
			: undefined;
		const body = existing !== undefined && !existing.none && lastMessageRev !== undefined
			? { t: 'attach', id: terminal.id, token: this.agentToken(terminalKey), epoch: existing.epoch, afterRev: lastMessageRev }
			: { t: 'attach', id: terminal.id, token: this.agentToken(terminalKey) };
		this.client?.send('agent', encoder.encode(JSON.stringify(body)));
	}

	private terminalForKey(terminalKey: string): WorkspaceState['terminals'][number] | undefined {
		return this.state.workspace?.terminals.find(terminal => terminal.terminalKey === terminalKey);
	}

	private rendererTargetFor(terminalKey: string): string | undefined {
		const terminal = this.terminalForKey(terminalKey);
		const desktopEpoch = this.state.workspace?.desktopEpoch;
		if (terminal === undefined || desktopEpoch === undefined) {
			return undefined;
		}
		const renderer = this.state.workspace?.renderers.find(candidate => candidate.windowId === terminal.windowId);
		return renderer?.ready === true && renderer.rendererGeneration === terminal.rendererGeneration
			? JSON.stringify([desktopEpoch, terminal.windowId, terminal.rendererGeneration, terminal.id, terminal.agentToken ?? null])
			: undefined;
	}

	private agentToken(terminalKey: string): string | undefined {
		return this.terminalForKey(terminalKey)?.agentToken;
	}

	private terminalKeyForAgentFrame(terminalId: number, agentToken: string | undefined): string | undefined {
		if (agentToken === undefined) {
			return undefined;
		}
		return this.state.workspace?.terminals.find(terminal => terminal.id === terminalId && terminal.agentToken === agentToken)?.terminalKey;
	}

	// --- scm / fs（リクエスト/レスポンス） ------------------------------------

	private readonly requestPrefix = toBase64Url(randomToken(12));
	private requestCounter = 0;
	private readonly pending = new Map<string, { resolve: (v: unknown) => void; reject: (e: Error) => void; timer: ReturnType<typeof setTimeout>; rendererTarget?: RendererRequestTarget }>();

	private request<T>(channel: 'scm' | 'fs' | 'browser', body: object, timeoutMs = 30_000): Promise<T> {
		const client = this.client;
		if (!client || !this.isLiveAvailable()) {
			return Promise.reject(new Error('PCへ再接続してから操作してください'));
		}
		let requestBody = body;
		let rendererTarget: RendererRequestTarget | undefined;
		if (channel === 'scm' || channel === 'fs') {
			const desktop = this.state.workspace;
			const requestedWs = (body as { ws?: unknown }).ws;
			const workspace = typeof requestedWs === 'string'
				? desktop?.workspaces.find(candidate => candidate.id === requestedWs)
				: desktop?.workspaces.find(candidate => desktop.renderers.some(renderer => renderer.windowId === candidate.windowId && renderer.ready));
			if (desktop === undefined || workspace === undefined) {
				return Promise.reject(new Error('workspace not found'));
			}
			const renderer = desktop.renderers.find(candidate => candidate.windowId === workspace.windowId);
			if (renderer?.ready !== true) {
				return Promise.reject(new Error('PC画面の再接続が完了してから操作してください'));
			}
			rendererTarget = { desktopEpoch: desktop.desktopEpoch, windowId: renderer.windowId, rendererGeneration: renderer.rendererGeneration };
			requestBody = {
				...body,
				protocolVersion: 3,
				desktopEpoch: desktop.desktopEpoch,
				windowId: workspace.windowId,
				ws: workspace.sourceId,
			};
		}
		const id = `${this.requestPrefix}-r-${this.requestCounter++}`;
		return new Promise<T>((resolve, reject) => {
			const timer = setTimeout(() => {
				this.pending.delete(id);
				reject(new Error('request timeout'));
			}, timeoutMs);
			this.pending.set(id, { resolve: resolve as (v: unknown) => void, reject, timer, ...(rendererTarget !== undefined ? { rendererTarget } : {}) });
			client.send(channel, encoder.encode(JSON.stringify({ id, ...requestBody })));
		});
	}

	private settleResponse(payload: Uint8Array): void {
		try {
			const msg = JSON.parse(decoder.decode(payload)) as { id?: string; error?: string };
			if (!msg.id) {
				return;
			}
			const entry = this.pending.get(msg.id);
			if (!entry) {
				return;
			}
			this.pending.delete(msg.id);
			clearTimeout(entry.timer);
			if (msg.error) {
				entry.reject(new Error(msg.error));
			} else {
				entry.resolve(msg);
			}
		} catch { /* ignore */ }
	}

	private cancelPendingRequests(): void {
		for (const entry of this.pending.values()) {
			clearTimeout(entry.timer);
			entry.reject(new Error('接続が切断されました'));
		}
		this.pending.clear();
	}

	private cancelStaleRendererRequests(): boolean {
		let agentChatsChanged = false;
		for (const [id, entry] of this.pending) {
			if (entry.rendererTarget !== undefined && !this.isCurrentRendererRequestTarget(entry.rendererTarget)) {
				clearTimeout(entry.timer);
				this.pending.delete(id);
				entry.reject(new Error('PC画面が再接続されたため操作を中断しました'));
			}
		}
		for (const [requestId, pending] of this.pendingAgentActions) {
			if (!this.isLiveAvailable() || this.rendererTargetFor(pending.terminalKey) !== pending.rendererTarget) {
				clearTimeout(pending.timer);
				this.pendingAgentActions.delete(requestId);
				pending.resolve({ status: 'rejected', message: 'PC画面が再接続されたため操作を中断しました' });
			}
		}
		for (const [requestId, pending] of this.pendingActivityDetails) {
			if (!this.isLiveAvailable() || this.rendererTargetFor(pending.terminalKey) !== pending.rendererTarget) {
				clearTimeout(pending.timer);
				this.pendingActivityDetails.delete(requestId);
				pending.reject(new Error('PC画面が再接続されたため取得を中断しました'));
			}
		}
		for (const [terminalKey, pending] of this.agentControlTimers) {
			if (!this.isLiveAvailable() || this.rendererTargetFor(terminalKey) !== pending.rendererTarget) {
				clearTimeout(pending.timer);
				this.agentControlTimers.delete(terminalKey);
				const existing = this.state.agentChats.get(terminalKey);
				if (existing?.modelControl?.requestId === pending.requestId) {
					this.state.agentChats.set(terminalKey, {
						...existing,
						modelControl: { status: 'error', models: existing.modelControl.models, errorCode: 'renderer-restarting', errorMessage: 'PC画面の再接続後にもう一度お試しください' },
					});
					agentChatsChanged = true;
				}
			}
		}
		for (const [terminalKey, pending] of this.agentCommandCatalogTimers) {
			if (!this.isLiveAvailable() || this.rendererTargetFor(terminalKey) !== pending.rendererTarget) {
				clearTimeout(pending.timer);
				this.agentCommandCatalogTimers.delete(terminalKey);
				const existing = this.state.agentChats.get(terminalKey);
				if (existing?.commandCatalog?.requestId === pending.requestId) {
					this.state.agentChats.set(terminalKey, {
						...existing,
						commandCatalog: { status: 'error', commands: existing.commandCatalog.commands, errorMessage: 'PC画面の再接続後にもう一度お試しください' },
					});
					agentChatsChanged = true;
				}
			}
		}
		return agentChatsChanged;
	}

	private isCurrentRendererRequestTarget(target: RendererRequestTarget): boolean {
		const desktop = this.state.workspace;
		const renderer = desktop?.renderers.find(candidate => candidate.windowId === target.windowId);
		return desktop?.desktopEpoch === target.desktopEpoch && renderer?.ready === true && renderer.rendererGeneration === target.rendererGeneration;
	}

	/** 通知一覧を全消去する（通知一覧画面のクリアボタン用）。 */
	clearNotifications(): void {
		if (this.state.notifications.length === 0) {
			return;
		}
		this.state.notifications = [];
		this.emit({ notifications: true });
	}

	/**
	 * 通知一覧から単一項目を消す（タップして遷移した時に呼ぶ）。PCへも通知して
	 * 他のペアリング済み端末の一覧からも同じ項目を消す（notifyチャネル M→PC→他M）。
	 */
	dismissNotification(id: string): void {
		if (!this.state.notifications.some(n => n.id === id)) {
			return;
		}
		this.state.notifications = this.state.notifications.filter(n => n.id !== id);
		this.emit({ notifications: true });
		this.pendingNotificationDismissals.add(id);
		if (this.isLiveAvailable()) {
			this.client?.send('notify', encodeNotifyDismiss(id));
		}
	}

	/** git status（変更ファイル一覧 + ブランチ名）。 */
	scmStatus(ws: string): Promise<ScmStatusResult> {
		return this.request<ScmStatusResult>('scm', { t: 'status', ws });
	}

	/** git diff（path省略で全体、staged=trueでステージ済み）。 */
	scmDiff(ws: string, path?: string, staged?: boolean): Promise<ScmDiffResult> {
		return this.request<ScmDiffResult>('scm', { t: 'diff', ws, path, staged });
	}

	/** コミット（all=trueで git add -A してから）。 */
	scmCommit(ws: string, message: string, all: boolean): Promise<ScmCommitResult> {
		return this.request<ScmCommitResult>('scm', { t: 'commit', ws, message, all });
	}

	/** 直近コミット一覧。 */
	scmLog(ws: string, opts?: { limit?: number; skip?: number }): Promise<ScmLogResult> {
		return this.request<ScmLogResult>('scm', { t: 'log', ws, ...(opts?.limit !== undefined ? { limit: opts.limit } : {}), ...(opts?.skip !== undefined ? { skip: opts.skip } : {}) });
	}

	scmCommitFiles(ws: string, hash: string): Promise<ScmCommitFilesResult> {
		return this.request<ScmCommitFilesResult>('scm', { t: 'commitFiles', ws, hash });
	}

	/** worktree（スペース）作成フォームの材料（リポジトリ一覧・ブランチ・エージェント定義）。 */
	worktreeForm(): Promise<WorktreeFormResult> {
		return this.request<WorktreeFormResult>('scm', { t: 'worktreeForm' });
	}

	/**
	 * worktree（スペース）を作成する。PC版の作成ダイアログと同じ処理（ブランチ自動命名・
	 * スペース切り替え・setupスクリプト・エージェント起動）がPC側で走るため、タイムアウトは
	 * かなり長め（setupスクリプト次第で数分かかりうる。超過時もPC側の作成処理自体は継続する）。
	 */
	createWorktree(opts: { repo: string; name?: string; branch?: string; base?: string; prompt?: string; agent?: string }): Promise<WorktreeCreateResult> {
		return this.request<WorktreeCreateResult>('scm', { t: 'createWorktree', ...opts }, 300_000);
	}

	/** ディレクトリ一覧（ワークスペースルート相対パス）。 */
	fsList(ws: string, path: string): Promise<FsListResult> {
		return this.request<FsListResult>('fs', { t: 'list', ws, path });
	}

	/** Markdown内の相対・絶対ファイルリンクをワークスペース内の実在ファイルへ解決する。 */
	fsResolveLink(ws: string, path: string): Promise<FsResolveLinkResult> {
		return this.request<FsResolveLinkResult>('fs', { t: 'resolveLink', ws, path });
	}

	/** ファイル読み取り（上限つき）。highlight=trueでPCテーマのハイライトHTMLも返る。 */
	fsRead(ws: string, path: string, highlight?: boolean): Promise<FsReadResult> {
		return this.request<FsReadResult>('fs', { t: 'read', ws, path, ...(highlight ? { highlight: true } : {}) });
	}

	/** xlsx の1シートをPC側でレンダリングした静的HTMLを取得する（重いブックはPC側の生成に時間がかかるため長め）。 */
	fsXlsx(ws: string, path: string, sheet?: number): Promise<FsXlsxResult> {
		return this.request<FsXlsxResult>('fs', { t: 'xlsx', ws, path, ...(sheet !== undefined ? { sheet } : {}) }, 120_000);
	}

	/** PDF バイナリを base64 で取得する（大きい PDF はチャンク転送で時間がかかるため長め）。 */
	fsPdf(ws: string, path: string): Promise<FsPdfResult> {
		return this.request<FsPdfResult>('fs', { t: 'pdf', ws, path }, 120_000);
	}

	/** Word(.docx) バイナリを base64 で取得する（レンダリングはモバイルの WebView 内で行う）。 */
	fsDocx(ws: string, path: string): Promise<FsDocxResult> {
		return this.request<FsDocxResult>('fs', { t: 'docx', ws, path }, 120_000);
	}

	/** 画像・動画・音声バイナリを base64 で取得する（大きいファイルはチャンク転送で時間がかかるため長め）。 */
	fsMedia(ws: string, path: string): Promise<FsMediaResult> {
		return this.request<FsMediaResult>('fs', { t: 'media', ws, path }, 120_000);
	}

	/**
	 * 画像等をPCへアップロードし、保存先フルパスを受け取る（エージェントへの添付用。
	 * PC側は userData 配下の専用ディレクトリに保存し、モバイルはパスをPTYへ貼り付ける）。
	 */
	fsUpload(name: string, dataBase64: string): Promise<FsUploadResult> {
		return this.request<FsUploadResult>('fs', { t: 'upload', name, data: dataBase64 }, 120_000);
	}

	/** ファイル名検索（ワークスペース全体、.gitignore尊重、PC側ripgrep）。 */
	fsFind(ws: string, query: string): Promise<FsFindResult> {
		return this.request<FsFindResult>('fs', { t: 'find', ws, query });
	}

	/** テキスト全文検索（ワークスペース全体、PC側ripgrep）。 */
	fsGrep(ws: string, query: string): Promise<FsGrepResult> {
		return this.request<FsGrepResult>('fs', { t: 'grep', ws, query });
	}

	/** xlsx の差分(HEAD vs 作業ツリー)をPC側でレンダリングした静的HTMLを取得する。 */
	scmXlsxDiff(ws: string, path: string): Promise<ScmXlsxDiffResult> {
		return this.request<ScmXlsxDiffResult>('scm', { t: 'xlsxDiff', ws, path }, 120_000);
	}

	/** コード断片のシンタックスハイライト（PCの現行テーマ。エージェントチャットのコードブロック用）。 */
	fsHighlight(text: string, lang?: string): Promise<FsHighlightResult> {
		return this.request<FsHighlightResult>('fs', { t: 'hl', text, ...(lang !== undefined && lang.length > 0 ? { lang } : {}) }, 15_000);
	}

	/** ccusage 使用量ダッシュボード（PC版フッターの Ccusage と同じ集計データ）。 */
	usageDashboard(bypassCache?: boolean): Promise<UsageDashboardResult> {
		// PC側は他のfs応答と違い結果を data フィールドにネストして返す（reply({ t: 'usage', data })）。
		// 応答オブジェクトをそのまま結果として扱うと days/failedReports が undefined になり
		// 画面側の参照でクラッシュするため、ここで必ず剥がす。
		return this.request<{ data?: UsageDashboardResult }>('fs', { t: 'usage', ...(bypassCache ? { bypassCache: true } : {}) }, 60_000)
			.then(response => {
				if (!response.data) {
					throw new Error('empty usage response');
				}
				return response.data;
			});
	}

	/** Rate Limit(AIリミット)スナップショット（PC版タイトルバーのリミットモニターと同じデータ）。 */
	rateLimits(bypassCache?: boolean): Promise<RateLimitsResult> {
		// usageDashboard と同じく、PC側は結果を data フィールドにネストして返すためここで剥がす
		return this.request<{ data?: RateLimitsResult }>('fs', { t: 'limits', ...(bypassCache ? { bypassCache: true } : {}) }, 60_000)
			.then(response => {
				if (!response.data) {
					throw new Error('empty limits response');
				}
				return response.data;
			});
	}

	// --- browser（para-browser ミラー、設計書 M3） ------------------------------

	/** ミラー可能なブラウザページ一覧。 */
	browserTargets(): Promise<BrowserTargetsResult> {
		return this.request<BrowserTargetsResult>('browser', { t: 'targets' });
	}

	/**
	 * JPEGフレームの受信処理を一時停止するフラグ（WebRTCミラー表示中）。
	 * PC側はWebRTC確立中もJPEG screencastを並行して送り続ける（継ぎ目なしフォールバック
	 * のため）が、表示に使わないフレームを毎回フルパース（数百KBのJSON.parse）すると
	 * JSスレッドが飽和しタップ・画面切替が遅延する。suspend中は handleFrame の先頭で
	 * プレフィックス判定だけして読み捨てる。
	 */
	private jpegFramesSuspended = false;
	/** browserStop 後、次の browserStart までフレームを読み捨てる（停止が効くまでのフレーム洪水対策）。 */
	private browserStopping = false;

	setJpegFramesSuspended(suspended: boolean): void {
		this.jpegFramesSuspended = suspended;
	}

	/** screencast を開始する（フレームは state.browserFrame に流れ込む）。 */
	browserStart(targetId: string): Promise<void> {
		this.browserStopping = false;
		return this.request<void>('browser', { t: 'start', targetId, frameEncoding: BROWSER_JPEG_BINARY_ENCODING });
	}

	/**
	 * screencast を停止する。keepFrame=true のときは最後のフレームを残したまま停止する
	 * （タブのblur等で一時停止する用途。再フォーカス時に静止画→最新画面へ自然に切り替わる）。
	 */
	async browserStop(keepFrame = false): Promise<void> {
		// PC側で停止が効くまでに届く残フレームは読み捨てる（切替直後のJSスレッド飽和対策）
		this.browserStopping = true;
		// オフライン中の画面遷移ではPCへstopを送れないため、最後のframeも消さない。
		// pair解除/resetだけがcached browser stateを明示的に破棄する。
		if (!keepFrame && this.isLiveAvailable()) {
			this.state.browserFrame = undefined;
			this.emit();
		}
		try {
			await this.request<void>('browser', { t: 'stop' });
		} catch { /* 接続断などは無視 */ }
	}

	/** 入力イベントを送る（正規化座標）。 */
	browserInput(input: { kind: 'tap' | 'scroll' | 'back' | 'forward' | 'reload' | 'text' | 'navigate'; nx?: number; ny?: number; dy?: number; dx?: number; text?: string; url?: string }): void {
		if (this.isLiveAvailable()) {
			this.client?.send('browser', encoder.encode(JSON.stringify({ t: 'input', ...input })));
		}
	}

	// --- browser WebRTC ミラー（app/design/webrtc-mirror-design.md） ---------------

	/**
	 * PC→mobile の ICE candidate 受信ハンドラ（webrtcMirror.ts が登録する。単一スロット）。
	 * sid（セッションID）を持ち、別セッション宛のICEを現行ハンドラへ流さない。
	 * 確立フェーズ（TURN取得＋offer応答のawait）が長く、素早い切替では新旧セッションが
	 * 過渡的に共存するため、sidで宛先を識別する。
	 */
	webrtcIceHandler: { sid: string; fn: (candidate: object) => void } | undefined;

	/** WebRTC offer を送り、PC側ストリーマの answer SDP を待つ。 */
	webrtcOffer(targetId: string, sdp: string, sid: string): Promise<{ sdp?: string }> {
		return this.request<{ sdp?: string }>('browser', { t: 'webrtc-offer', targetId, sdp, sid }, 20_000);
	}

	/** 自分の ICE candidate をPCへ送る（fire-and-forget）。 */
	webrtcSendIce(candidate: object, sid: string): void {
		if (this.isLiveAvailable()) {
			this.client?.send('browser', encoder.encode(JSON.stringify({ t: 'webrtc-ice', candidate, sid })));
		}
	}

	/** PC側のピアを畳ませる（sid が現行セッションと違えばPC側で無視される）。 */
	webrtcStop(sid: string): void {
		if (this.isLiveAvailable()) {
			this.client?.send('browser', encoder.encode(JSON.stringify({ t: 'webrtc-stop', sid })));
		}
	}

	/**
	 * TURN短期資格情報をリレーから取得する（Cloudflare Realtime）。リレー側にシークレットが
	 * 未設定の場合や失敗時は空配列（STUNのみで続行）。対称NAT越え（キャリア回線⇔自宅PC等）に必要。
	 */
	async fetchTurnIceServers(timeoutMs = 5_000): Promise<object[]> {
		const creds = this.lastCredentials;
		if (!creds) {
			return [];
		}
		const httpBase = creds.relayUrl.replace(/\/$/, '').replace(/^ws/, 'http');
		const abort = new AbortController();
		const timer = setTimeout(() => abort.abort(), timeoutMs);
		try {
			const res = await fetch(`${httpBase}/device/${creds.deviceId}/turn`, {
				method: 'POST',
				headers: { authorization: `Bearer ${creds.mobileToken}`, 'content-type': 'application/json' },
				body: JSON.stringify({ mobileId: creds.mobileId }),
				signal: abort.signal,
			});
			if (!res.ok) {
				return [];
			}
			const data = await res.json() as { iceServers?: object[] };
			return Array.isArray(data.iceServers) ? data.iceServers : [];
		} catch {
			return [];
		} finally {
			clearTimeout(timer);
		}
	}

	private handleFrame(frame: Frame): void {
		// Stateは現在の暗号セッションでprotocol v3を交渉する唯一のhandshake frame。
		// それ以外は交渉完了前・不一致後・reset中に一切取り込まず、旧PCのpushでcached stateを汚染しない。
		if (frame.ch !== 'state' && (!this.state.sessionProtocolReady || this.state.protocolError !== undefined || this.resetting)) {
			return;
		}
		if (frame.ch === 'scm' || frame.ch === 'fs') {
			this.settleResponse(frame.payload);
			return;
		}
		if (frame.ch === 'agent') {
			this.handleAgentFrame(frame.payload);
			return;
		}
		if (frame.ch === 'browser') {
			// screencastフレーム（id無しのストリーム）と要求応答（id有り）が混在する。
			// フレームは数百KBのbase64を含むため、表示に使わない間（WebRTCミラー表示中・
			// 停止処理中）は先頭バイトのプレフィックス判定だけでフルパース前に読み捨てる
			// （PC側のシリアライズは常に t が先頭キー）。
			if (this.jpegFramesSuspended || this.browserStopping) {
				if (isBinaryBrowserJpegFrame(frame.payload)) {
					return;
				}
				const head = decoder.decode(frame.payload.subarray(0, 12));
				if (head.startsWith('{"t":"frame"')) {
					return;
				}
			}
			const binaryFrame = decodeBinaryBrowserJpegFrame(frame.payload);
			if (binaryFrame !== undefined) {
				this.state.browserFrame = binaryFrame;
				this.emit();
				return;
			}
			try {
				const msg = JSON.parse(decoder.decode(frame.payload)) as { t?: string; id?: string; data?: string; w?: number; h?: number; candidate?: object; sid?: string };
				if (msg.t === 'frame' && typeof msg.data === 'string') {
					this.state.browserFrame = { data: msg.data, w: msg.w ?? 0, h: msg.h ?? 0 };
					this.emit();
				} else if (msg.t === 'webrtc-ice' && msg.candidate) {
					// sid未設定（旧PC）は互換のため受理。設定時は現行セッション宛のみ通す
					const handler = this.webrtcIceHandler;
					if (handler && (msg.sid === undefined || msg.sid === handler.sid)) {
						handler.fn(msg.candidate);
					}
				} else if (msg.id) {
					this.settleResponse(frame.payload);
				}
			} catch { /* ignore */ }
			return;
		}
		if (frame.ch === 'state') {
			try {
				const incoming = JSON.parse(decoder.decode(frame.payload)) as WorkspaceState;
				if (incoming.protocolVersion !== 3) {
					this.state.sessionProtocolReady = false;
					this.state.protocolError = 'PC版とモバイル版の通信バージョンが一致しません。両方を最新版へ更新してください。';
					this.state.workspace = undefined;
					this.state.terminalOutput.clear();
					this.state.agentChats.clear();
					this.state.browserFrame = undefined;
					this.state.notifications = [];
					this.cancelPendingAgentActions();
					this.cancelPendingRequests();
					this.cancelStaleRendererRequests();
					this.attachedAgentTargets.clear();
					for (const stream of this.termStreams.values()) {
						stream.epoch = 0;
						stream.lastSeq = undefined;
						stream.unackedChars = 0;
						stream.cache = undefined;
						stream.rendererTarget = undefined;
					}
					this.emit({ term: true, agentChats: true, notifications: true });
					return;
				}
				if (typeof incoming.desktopEpoch !== 'string' || typeof incoming.revision !== 'number' || typeof incoming.complete !== 'boolean'
					|| !Array.isArray(incoming.renderers) || !Array.isArray(incoming.workspaces) || !Array.isArray(incoming.terminals)
					|| incoming.renderers.some(renderer => typeof renderer.windowId !== 'number' || !Number.isInteger(renderer.windowId)
						|| typeof renderer.rendererGeneration !== 'number' || !Number.isSafeInteger(renderer.rendererGeneration) || typeof renderer.ready !== 'boolean')
					|| incoming.workspaces.some(workspace => typeof workspace.id !== 'string' || workspace.id.length === 0 || typeof workspace.sourceId !== 'string' || workspace.sourceId.length === 0 || typeof workspace.windowId !== 'number')
					|| incoming.terminals.some(terminal => typeof terminal.terminalKey !== 'string' || terminal.terminalKey.length === 0 || terminal.terminalKey.length > 200 || typeof terminal.id !== 'number' || typeof terminal.windowId !== 'number' || typeof terminal.rendererGeneration !== 'number')
					|| new Set(incoming.renderers.map(renderer => renderer.windowId)).size !== incoming.renderers.length
					|| new Set(incoming.workspaces.map(workspace => workspace.id)).size !== incoming.workspaces.length
					|| new Set(incoming.terminals.map(terminal => terminal.terminalKey)).size !== incoming.terminals.length) {
					return;
				}
				this.state.protocolError = undefined;
				// 有効なv3 Stateそのものがpresenceより強い生存証拠。同一revisionでも
				// 新しい暗号sessionのgate確立と再attach処理には必ず使う。
				this.state.pcOnline = true;
				const firstReadyState = !this.state.sessionProtocolReady;
				this.state.sessionProtocolReady = true;
				const previous = this.state.workspace;
				if (previous?.desktopEpoch === incoming.desktopEpoch
					&& (incoming.revision < previous.revision || (incoming.revision === previous.revision && (previous.complete || !incoming.complete)))) {
					this.emit();
					this.reconcileTerminalOperationOutbox(incoming.desktopEpoch);
					if (firstReadyState) {
						this.resumeLiveSessionSubscriptions();
					}
					return;
				}
				// PC再起動直後の部分state（新epochだがwindow未ready）はmergeWorkspaceStateが旧表示を
				// 保持する。その間はterminal出力・agentチャットのキャッシュも道連れに消さないよう、
				// 「実際に適用されたworkspaceのepochが変わったか」で判定する。
				const applied = mergeWorkspaceState(previous, incoming);
				const epochChanged = previous !== undefined && applied.desktopEpoch !== previous.desktopEpoch;
				this.state.workspace = applied;
				this.cancelStaleRendererRequests();
				if (epochChanged) {
					this.state.terminalOutput.clear();
					this.state.agentChats.clear();
					for (const stream of this.termStreams.values()) {
						stream.epoch = 0;
						stream.lastSeq = undefined;
						stream.unackedChars = 0;
						stream.cache = undefined;
						stream.rendererTarget = undefined;
					}
					this.cancelPendingAgentActions();
					this.cancelPendingRequests();
					for (const pending of this.agentControlTimers.values()) {
						clearTimeout(pending.timer);
					}
					this.agentControlTimers.clear();
					for (const pending of this.agentCommandCatalogTimers.values()) {
						clearTimeout(pending.timer);
					}
					this.agentCommandCatalogTimers.clear();
				}
				// 切断中に exit 通知を取り逃したケースに備え、現存しないターミナルの
				// terminalOutput / agentChats エントリを掃除する。
				const live = new Set(this.state.workspace.terminals.map(terminal => terminal.terminalKey));
				for (const terminalKey of this.state.terminalOutput.keys()) {
					if (!live.has(terminalKey)) {
						this.state.terminalOutput.delete(terminalKey);
					}
				}
				for (const terminalKey of this.state.agentChats.keys()) {
					if (!live.has(terminalKey)) {
						this.state.agentChats.delete(terminalKey);
					}
				}
				for (const terminalKey of this.attachedAgents.keys()) {
					if (!live.has(terminalKey)) {
						this.attachedAgents.delete(terminalKey);
						this.attachedAgentTargets.delete(terminalKey);
					}
				}
				for (const [terminalKey, pending] of this.agentControlTimers) {
					if (!live.has(terminalKey)) {
						clearTimeout(pending.timer);
						this.agentControlTimers.delete(terminalKey);
					}
				}
				for (const [terminalKey, pending] of this.agentCommandCatalogTimers) {
					if (!live.has(terminalKey)) {
						clearTimeout(pending.timer);
						this.agentCommandCatalogTimers.delete(terminalKey);
					}
				}
				for (const terminalKey of this.termStreams.keys()) {
					if (!live.has(terminalKey)) {
						this.termStreams.delete(terminalKey);
					}
				}
				// workspace は再代入で参照が変わる。terminalOutput / agentChats は上の掃除で
				// ミューテートしうるため、常に新参照へ差し替える（掃除が空振りでも安全側に倒す）。
				this.emit({ term: true, agentChats: true });
				this.reconcileTerminalOperationOutbox(incoming.desktopEpoch);
				if (firstReadyState) {
					this.resumeLiveSessionSubscriptions();
				}
				for (const [terminalKey, stream] of this.termStreams) {
					const target = this.rendererTargetFor(terminalKey);
					if (stream.listeners.size > 0 && target !== undefined && target !== stream.rendererTarget) {
						this.attachTerminal(terminalKey);
					}
				}
				for (const terminalKey of this.attachedAgents.keys()) {
					const target = this.rendererTargetFor(terminalKey);
					if (target !== undefined && target !== this.attachedAgentTargets.get(terminalKey)) {
						this.sendAgentAttach(terminalKey);
					}
				}
			} catch { /* ignore malformed */ }
		} else if (frame.ch === 'term') {
			try {
				const msg = JSON.parse(decoder.decode(frame.payload)) as { t: string; operationId?: string; terminalKey?: string; data?: string; snapshot?: boolean; epoch?: number; seq?: number; cols?: number; rows?: number; unicode?: string; status?: string };
				if (msg.t === 'operation-result') {
					this.handleTerminalOperationResult(msg.operationId, msg.status);
					return;
				}
				if (typeof msg.terminalKey !== 'string' || !this.state.workspace?.terminals.some(terminal => terminal.terminalKey === msg.terminalKey)) {
					return;
				}
				if (msg.t === 'data' && typeof msg.data === 'string' && typeof msg.epoch === 'number' && typeof msg.seq === 'number') {
					if (!this.handleTermSyncData({ terminalKey: msg.terminalKey, data: msg.data, snapshot: msg.snapshot === true, epoch: msg.epoch, seq: msg.seq, cols: msg.cols, rows: msg.rows, unicode: msg.unicode })) {
						return;
					}
					const prev = msg.snapshot ? '' : (this.state.terminalOutput.get(msg.terminalKey) ?? '');
					const next = (prev + msg.data).slice(-MAX_TERM_BUFFER);
					this.state.terminalOutput.set(msg.terminalKey, next);
					this.emit({ term: true });
				} else if (msg.t === 'exit') {
					const stream = this.termStreams.get(msg.terminalKey);
					if (stream === undefined || typeof msg.epoch !== 'number' || msg.epoch !== stream.epoch) {
						return;
					}
					this.state.terminalOutput.delete(msg.terminalKey);
					for (const listener of stream.listeners) {
						listener({ kind: 'exit' });
					}
					this.termStreams.delete(msg.terminalKey);
					// 閉じたターミナルは二度と再attachされないため、チャット履歴も掃除する。
					// （放置すると agentChats に使い捨てターミナル分のチャットが蓄積し続ける）
					this.state.agentChats.delete(msg.terminalKey);
					this.attachedAgents.delete(msg.terminalKey);
					this.attachedAgentTargets.delete(msg.terminalKey);
					this.emit({ term: true, agentChats: true });
				}
			} catch { /* ignore */ }
		} else if (frame.ch === 'notify') {
			const control = decodeNotifyControl(frame.payload);
			if (control?.t === 'dismissed') {
				this.pendingNotificationDismissals.delete(control.id);
				// 他端末がこの通知を処理済みにした（本機の一覧からも消す。無ければ何もしない）。
				if (this.state.notifications.some(n => n.id === control.id)) {
					this.state.notifications = this.state.notifications.filter(n => n.id !== control.id);
					this.emit({ notifications: true });
				}
				return;
			}
			if (control?.t === 'dismissed-token') {
				// PC自身がそのエージェント(agentToken)のペインを確認済みにした。
				// 同じagentTokenを持つ通知は全てまとめて一覧から消す。
				if (this.state.notifications.some(n => n.agentToken === control.token)) {
					this.state.notifications = this.state.notifications.filter(n => n.agentToken !== control.token);
					this.emit({ notifications: true });
				}
				return;
			}
			try {
				const payload = decodeNotify(frame.payload);
				// 重複IDは無視。新しい順に最大50件保持。
				if (!this.pendingNotificationDismissals.has(payload.id) && !this.state.notifications.some(n => n.id === payload.id)) {
					this.state.notifications = [payload, ...this.state.notifications].slice(0, 50);
					this.emit({ notifications: true });
					this.onNotify?.(payload);
				}
			} catch { /* ignore */ }
		}
	}

	/**
	 * 同期プロトコルのターミナルデータ1フレームを処理する。
	 * - epoch不一致（再attach前の旧世代）は捨てる
	 * - snapshot はリプレイキャッシュを起点から作り直し、購読者へ「バッファ置き換え」として流す
	 * - data は seq 連続性を検証し、欠落を検出したら新epochで再attachしてsnapshotから復旧する
	 * - 受信文字数に応じてACKを返す（PC側フロー制御の材料。snapshotは大きいので即ACK）
	 */
	private handleTermSyncData(msg: { terminalKey: string; data: string; snapshot: boolean; epoch: number; seq: number; cols?: number; rows?: number; unicode?: string }): boolean {
		const stream = this.termStreams.get(msg.terminalKey);
		if (!stream || msg.epoch !== stream.epoch) {
			return false;
		}
		if (msg.snapshot) {
			stream.lastSeq = msg.seq;
			const ev: TermStreamEvent = {
				kind: 'snapshot', data: msg.data,
				...(msg.cols !== undefined ? { cols: msg.cols } : {}),
				...(msg.rows !== undefined ? { rows: msg.rows } : {}),
				...(msg.unicode !== undefined ? { unicode: msg.unicode } : {}),
			};
			stream.cache = { events: [ev], chars: msg.data.length };
			for (const listener of stream.listeners) {
				listener(ev);
			}
			this.sendTermAck(msg.terminalKey, stream);
			return true;
		}
		if (stream.lastSeq === undefined) {
			// snapshot受信前のライブ出力。この後に届くsnapshotへ反映済みなので捨てる。
			return false;
		}
		if (msg.seq !== stream.lastSeq + 1) {
			// seq欠落（リレー再接続時の取りこぼし等）。新epochで再attachし、snapshotから復旧する。
			this.attachTerminal(msg.terminalKey);
			return false;
		}
		stream.lastSeq = msg.seq;
		const ev: TermStreamEvent = { kind: 'data', data: msg.data };
		if (stream.cache) {
			stream.cache.events.push(ev);
			stream.cache.chars += msg.data.length;
			if (stream.cache.chars > TERM_REPLAY_CACHE_LIMIT) {
				// 上限超過は丸ごと捨てる（部分保持はエスケープシーケンスを壊す）。次のsnapshotで再構築。
				stream.cache = undefined;
			}
		}
		for (const listener of stream.listeners) {
			listener(ev);
		}
		stream.unackedChars += msg.data.length;
		if (stream.unackedChars >= TERM_ACK_CHARS) {
			this.sendTermAck(msg.terminalKey, stream);
		}
		return true;
	}

	private sendTermAck(terminalKey: string, stream: TermStreamState): void {
		stream.unackedChars = 0;
		if (stream.lastSeq !== undefined) {
			void this.sendTerm(terminalKey, { t: 'ack', epoch: stream.epoch, seq: stream.lastSeq });
		}
	}

	private handleAgentFrame(payload: Uint8Array): void {
		try {
			const msg = JSON.parse(decoder.decode(payload)) as {
				t: string; id: number; token?: string; agent?: string; epoch?: string; rev?: number;
				messages?: AgentChatMessage[]; truncated?: boolean; info?: AgentSessionInfo; live?: AgentLiveState | null; activity?: AgentActivityState | null;
				requestId?: string; activityId?: string; error?: string; models?: AgentModelOption[]; commands?: unknown; status?: string; code?: string; message?: string; consumed?: boolean; capabilities?: { agentActions?: unknown; claudeSettings?: unknown }; interaction?: AgentInteraction | null;
			};
			if (typeof msg.id !== 'number') {
				return;
			}
			const terminalKey = this.terminalKeyForAgentFrame(msg.id, msg.token);
			if (terminalKey === undefined) {
				return; // 別ウィンドウで同じterminalIdを持つペインからの応答
			}
			const rendererTarget = this.rendererTargetFor(terminalKey);
			if (rendererTarget === undefined || this.attachedAgentTargets.get(terminalKey) !== rendererTarget) {
				return; // pending/交代済みRendererから遅れて届いた応答
			}
			const parsedActivity = msg.activity !== null ? parseAgentActivityState(msg.activity) : undefined;
			const parsedInteraction = msg.interaction !== null ? parseAgentInteraction(msg.interaction) : undefined;
			if (msg.t === 'activity-detail' && typeof msg.requestId === 'string' && typeof msg.activityId === 'string') {
				const pending = this.pendingActivityDetails.get(msg.requestId);
				if (pending === undefined || pending.terminalKey !== terminalKey || pending.rendererTarget !== rendererTarget || pending.activityId !== msg.activityId) { return; }
				clearTimeout(pending.timer);
				this.pendingActivityDetails.delete(msg.requestId);
				if (typeof msg.error === 'string') { pending.reject(new Error(msg.error)); return; }
				const rawMessages = (msg as unknown as { messages?: unknown }).messages;
				if (!Array.isArray(rawMessages)) { pending.reject(new Error('SubAgent詳細の応答が不正です')); return; }
				const messages: AgentActivityDetailMessage[] = [];
				for (const candidate of rawMessages.slice(-200)) {
					if (candidate === null || typeof candidate !== 'object' || Array.isArray(candidate)) { continue; }
					const item = candidate as Record<string, unknown>;
					if ((item['role'] === 'user' || item['role'] === 'assistant' || item['role'] === 'tool') && (item['kind'] === 'text' || item['kind'] === 'thinking' || item['kind'] === 'tool') && typeof item['text'] === 'string') {
						messages.push({ role: item['role'], kind: item['kind'], text: item['text'].slice(0, 6_000) });
					}
				}
				pending.resolve(messages);
				return;
			}
			if (msg.t === 'none') {
				this.clearAgentControlTimeout(terminalKey);
				this.clearAgentCommandCatalogTimeout(terminalKey);
				this.state.agentChats.set(terminalKey, { agent: '', epoch: '', rev: -1, messages: [], truncated: false, none: true });
				this.emit({ agentChats: true });
				return;
			}
			if (msg.t === 'snapshot') {
				const previous = this.state.agentChats.get(terminalKey);
				if (previous?.epoch !== msg.epoch) {
					this.clearAgentControlTimeout(terminalKey);
					this.clearAgentCommandCatalogTimeout(terminalKey);
				}
				this.state.agentChats.set(terminalKey, {
					agent: msg.agent ?? 'claude',
					epoch: msg.epoch ?? '',
					rev: msg.rev ?? -1,
					messages: msg.messages ?? [],
					truncated: msg.truncated === true,
					...(msg.info !== undefined ? { info: msg.info } : {}),
					...(msg.live !== undefined && msg.live !== null ? { live: msg.live } : {}),
					...(parsedActivity !== undefined ? { activity: parsedActivity } : {}),
					...(msg.capabilities?.agentActions === true ? { capabilities: { agentActions: true as const, ...(msg.capabilities.claudeSettings === true ? { claudeSettings: true as const } : {}) } } : {}),
					...(parsedInteraction !== undefined ? { interaction: parsedInteraction } : {}),
					...(previous?.modelControl !== undefined && previous.epoch === msg.epoch ? { modelControl: previous.modelControl } : {}),
					...(previous?.commandCatalog !== undefined && previous.epoch === msg.epoch ? { commandCatalog: previous.commandCatalog } : {}),
				});
				this.emit({ agentChats: true });
				return;
			}
			if (msg.t === 'delta') {
				const existing = this.state.agentChats.get(terminalKey);
				if (!existing || existing.epoch !== msg.epoch) {
					// epoch不一致の差分は適用できない → 全量を取り直す（欠落したまま表示しない）。
					if (this.attachedAgents.has(terminalKey)) {
						this.sendAgentAttach(terminalKey);
					}
					return;
				}
				// rev の飛び（リレーのフレーム落ち等）を検出したら、黙って継ぎ足さず差分を
				// 取り直す（sendAgentAttach が afterRev 付きで欠落分から再取得する）。
				const incoming = msg.messages ?? [];
				const lastKnownRev = existing.messages[existing.messages.length - 1]?.rev ?? existing.rev - 1;
				const minIncomingRev = incoming.length > 0 ? Math.min(...incoming.map(m => m.rev)) : undefined;
				if (minIncomingRev !== undefined && minIncomingRev > lastKnownRev + 1) {
					if (this.attachedAgents.has(terminalKey)) {
						this.sendAgentAttach(terminalKey);
					}
					return;
				}
				// 重複revは捨てる（再attach応答と押し出しdeltaの競合対策）。
				const fresh = incoming.filter(m => !existing.messages.some(e => e.rev === m.rev));
				const withoutLive = msg.live === null ? (({ live: _live, ...rest }) => rest)(existing) : existing;
				const withoutActivity = msg.activity === null ? (({ activity: _activity, ...rest }) => rest)(withoutLive) : withoutLive;
				const base = msg.interaction === null ? (({ interaction: _interaction, ...rest }) => rest)(withoutActivity) : withoutActivity;
				this.state.agentChats.set(terminalKey, {
					...base,
					rev: msg.rev ?? existing.rev,
					messages: [...existing.messages, ...fresh].slice(-500),
					...(msg.info !== undefined ? { info: msg.info } : {}),
					...(msg.live !== undefined && msg.live !== null ? { live: msg.live } : {}),
					...(parsedActivity !== undefined ? { activity: parsedActivity } : {}),
					...(msg.capabilities?.agentActions === true ? { capabilities: { agentActions: true as const, ...(msg.capabilities.claudeSettings === true ? { claudeSettings: true as const } : {}) } } : {}),
					...(parsedInteraction !== undefined ? { interaction: parsedInteraction } : {}),
				});
				// ターン継続中（live あり）の高頻度な delta だけ throttle でまとめる。ターン終了
				// （live === null）や live 情報を伴わない確定 delta は即時反映する（追従の遅延・
				// 取りこぼしを避ける）。
				if (msg.live !== undefined && msg.live !== null) {
					this.emitAgentStreamThrottled();
				} else {
					this.flushAgentEmit();
					this.emit({ agentChats: true });
				}
				return;
			}
			if (msg.t === 'action-result' && typeof msg.requestId === 'string') {
				const pending = this.pendingAgentActions.get(msg.requestId);
					if (pending === undefined || pending.terminalKey !== terminalKey || pending.rendererTarget !== rendererTarget || (msg.status !== 'accepted' && msg.status !== 'rejected')) {
					return;
				}
				clearTimeout(pending.timer);
				this.pendingAgentActions.delete(msg.requestId);
				pending.resolve(toAgentMessageSendResult(msg.status, msg.consumed === true, typeof msg.message === 'string' ? msg.message : undefined));
				return;
			}
			if (msg.t === 'model-catalog' && typeof msg.requestId === 'string' && Array.isArray(msg.models)) {
				const existing = this.state.agentChats.get(terminalKey);
				if (existing?.modelControl?.requestId !== msg.requestId) {
					return;
				}
				const models = parseAgentModelOptions(msg.models);
				this.clearAgentControlTimeout(terminalKey, msg.requestId);
				this.state.agentChats.set(terminalKey, {
					...existing,
					modelControl: models.length > 0
						? { status: 'ready', models }
						: { status: 'error', models: [], errorCode: 'invalid-response', errorMessage: 'Codexのモデル一覧レスポンスが不正です' },
				});
				this.emit({ agentChats: true });
				return;
			}
			if (msg.t === 'command-catalog' && typeof msg.requestId === 'string' && Array.isArray(msg.commands)) {
				const existing = this.state.agentChats.get(terminalKey);
				if (existing?.commandCatalog?.requestId !== msg.requestId) {
					return;
				}
				const commands = parseAgentCommandOptions(msg.commands);
				this.clearAgentCommandCatalogTimeout(terminalKey, msg.requestId);
				this.state.agentChats.set(terminalKey, {
					...existing,
					commandCatalog: commands.length > 0
						? { status: 'ready', commands }
						: { status: 'error', commands: [], errorMessage: 'コマンド一覧のレスポンスが不正です' },
				});
				this.emit({ agentChats: true });
				return;
			}
			if (msg.t === 'command-catalog-error' && typeof msg.requestId === 'string') {
				const existing = this.state.agentChats.get(terminalKey);
				if (existing?.commandCatalog?.requestId !== msg.requestId) {
					return;
				}
				this.clearAgentCommandCatalogTimeout(terminalKey, msg.requestId);
				this.state.agentChats.set(terminalKey, {
					...existing,
					commandCatalog: { status: 'error', commands: existing.commandCatalog.commands, errorMessage: typeof msg.message === 'string' ? msg.message.slice(0, 500) : 'コマンド一覧を取得できませんでした' },
				});
				this.emit({ agentChats: true });
				return;
			}
			if (msg.t === 'model-control-error' && typeof msg.requestId === 'string') {
				const existing = this.state.agentChats.get(terminalKey);
				if (existing?.modelControl?.requestId !== msg.requestId) {
					return;
				}
				this.clearAgentControlTimeout(terminalKey, msg.requestId);
				this.state.agentChats.set(terminalKey, {
					...existing,
					modelControl: {
						status: 'error', models: existing.modelControl.models,
						errorCode: msg.code ?? 'unavailable', errorMessage: msg.message ?? 'モデル一覧を取得できませんでした',
					},
				});
				this.emit({ agentChats: true });
				return;
			}
			if (msg.t === 'settings-update' && typeof msg.requestId === 'string') {
				const existing = this.state.agentChats.get(terminalKey);
				if (existing?.modelControl?.requestId !== msg.requestId) {
					return;
				}
				if (msg.status === 'pending') {
					return; // 送信時点ですでにupdatingへ遷移済み
				}
				if (msg.status !== 'confirmed' && msg.status !== 'failed') {
					return;
				}
				this.clearAgentControlTimeout(terminalKey, msg.requestId);
				if (msg.status === 'confirmed') {
					this.state.agentChats.set(terminalKey, {
						...existing,
						...(msg.info !== undefined ? { info: msg.info } : {}),
						modelControl: { status: 'ready', models: existing.modelControl.models },
					});
				} else if (msg.status === 'failed') {
					this.state.agentChats.set(terminalKey, {
						...existing,
						modelControl: {
							status: 'error', models: existing.modelControl.models,
							errorCode: msg.code ?? 'unavailable', errorMessage: msg.message ?? '設定を更新できませんでした',
						},
					});
				}
				this.emit({ agentChats: true });
			}
		} catch { /* ignore */ }
	}

	/** 直近に onChange へ渡したスナップショット（未変更コレクションの参照据え置きに使う）。 */
	private lastEmitted: StoreState | undefined;

	/** ストリーミング delta の emit を coalesce するためのタイマー／保留フラグ。 */
	private agentEmitTimer: ReturnType<typeof setTimeout> | undefined;
	private agentEmitPending = false;

	/**
	 * エージェント応答のストリーミング中（ターン継続中の delta）専用の emit。1文字ごとに
	 * emit すると購読側（チャット画面）が過剰に再レンダリングし、入力欄のIME変換が
	 * 妨げられたり描画が重くなる。そこで leading + trailing の throttle（AGENT_STREAM_EMIT_MS）で
	 * まとめる。最初の delta は即時反映し、以後 window 内の更新は末尾の1回にまとめる。
	 * trailing を必ず発火させるため、最後の delta を取りこぼさない。ターン終了・スナップショット等の
	 * 重要フレームは呼び出し側が flushAgentEmit + 即時 emit で確実に反映すること。
	 */
	private emitAgentStreamThrottled(): void {
		if (this.agentEmitTimer !== undefined) {
			this.agentEmitPending = true;
			return;
		}
		this.emit({ agentChats: true });
		this.agentEmitTimer = setTimeout(() => {
			this.agentEmitTimer = undefined;
			if (this.agentEmitPending) {
				this.agentEmitPending = false;
				this.emitAgentStreamThrottled();
			}
		}, AGENT_STREAM_EMIT_MS);
	}

	/** 保留中のストリーミング emit を破棄する（即時 emit する重要フレームの直前に呼ぶ）。 */
	private flushAgentEmit(): void {
		if (this.agentEmitTimer !== undefined) {
			clearTimeout(this.agentEmitTimer);
			this.agentEmitTimer = undefined;
		}
		this.agentEmitPending = false;
	}

	/**
	 * 状態変化を購読側へ通知する。terminalOutput / notifications / agentChats の3コレクションは
	 * ミューテートしても参照は変わらないため、明示的に新しい参照へ差し替えないと Zustand の
	 * useShallow セレクタが変化を検知できない。逆に「毎回すべて new し直す」と、どのチャネルの
	 * 更新でも全画面が再レンダーされてしまう（バッテリー・描画コスト）。
	 *
	 * そこで changed で「今回中身を書き換えたコレクション」だけを新しい参照にし、書き換えていない
	 * ものは前回 emit した参照をそのまま渡す。これにより変更と参照更新が機械的に1対1で対応する。
	 * コレクションをミューテートした呼び出し元は、対応するフラグを必ず立てること
	 * （立て忘れると「更新したのに画面が変わらない」表示バグになる）。
	 *
	 * connection / pcOnline / workspace / browserFrame は常に丸ごと再代入されるスカラ相当なので、
	 * this.state の現在値をそのまま渡せば参照比較が正しく働く（changed で管理する必要はない）。
	 */
	private emit(changed?: { term?: boolean; notifications?: boolean; agentChats?: boolean }): void {
		const prev = this.lastEmitted;
		const next: StoreState = {
			connection: this.state.connection,
			pcOnline: this.state.pcOnline,
			sessionProtocolReady: this.state.sessionProtocolReady,
			workspace: this.state.workspace,
			protocolError: this.state.protocolError,
			terminalOperationIssue: this.state.terminalOperationIssue,
			unknownTerminalOperationCount: this.state.unknownTerminalOperationCount,
			browserFrame: this.state.browserFrame,
			terminalOutput: (!prev || changed?.term) ? new Map(this.state.terminalOutput) : prev.terminalOutput,
			notifications: (!prev || changed?.notifications) ? [...this.state.notifications] : prev.notifications,
			agentChats: (!prev || changed?.agentChats) ? new Map(this.state.agentChats) : prev.agentChats,
		};
		this.lastEmitted = next;
		this.onChange(next);
	}
}

// base64（依存を足さず、@para/protocol の base64url を使う）。
import { fromBase64Url as fromB64, toBase64Url as toB64 } from '@para/protocol';
