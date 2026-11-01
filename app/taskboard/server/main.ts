// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import { execFile } from 'node:child_process';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { existsSync, promises as fs, realpathSync } from 'node:fs';
import * as http from 'node:http';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { WebSocket, WebSocketServer } from 'ws';
import type { ITaskBoardArtifact, ITaskBoardFlow, ITaskBoardPrRef, ITaskBoardPullDetail, ITaskBoardRpc, ITaskBoardSnapshot, ITaskBoardTask, TaskBoardRpcMethod, TaskBoardServerMessage } from '@engine/paradisTaskBoard.js';
import { TaskBoardError } from '@engine/paradisTaskBoard.js';
import { TaskBoardEngine } from '@engine/paradisTaskBoardEngine.js';
import { parseTaskBoardFlow } from '@engine/paradisTaskBoardFlow.js';
import { buildDemo, demoSlots } from './demo.js';
import { loadFlows, saveActiveFlow, saveFlow } from './flows.js';
import { GitHubClient, GitHubError, ghTokenProvider, redactGitHubSecrets } from './github.js';
import { GitHubSync, parseRemote, type IRepoSlug } from './githubSync.js';
import { addClaudeApprovals, claudeApprovalStates, ClaudeConfigError } from './claudeApproval.js';
import { addCodexApprovals, codexApprovalStates, CodexConfigError } from './codexApproval.js';
import { ParaCodeAgents, ParaCodeBridgeClient } from './paraCode.js';
import { RELAY_UNSUPPORTED, RelayClient, RelayUnsupportedRunner, RemoteWorkspaces, relayFlowIo, type IRelaySessionInfo } from './relay.js';
import { boardPlaces, isOtherBoardWorktree, rememberRepository, repositoryChoices } from './repositories.js';
import { CommandRunner } from './runner.js';
import { Simulation } from './sim.js';
import { dataDir, Store, StoreBusyError, storeOwner, type ILocalSettings } from './store.js';
import { excludeBoardFiles, git, GitWorkspaces, inspectClones, remoteUrl } from './workspaces.js';

/*
 * タスクボードの開発用ローカルサーバー。
 *   pnpm dev -- --repo ~/projects/para-code           GitHub の Issue を取り込み、エージェントはシミュレーション
 *   pnpm dev -- --demo                                  見本の台帳で動かす（GitHub につながない）
 *   pnpm dev -- --repo … --agents para-code             本物の Claude Code / Codex を Para Code で動かす（作業場所の git 操作と自動の工程も本物）
 *
 * 守り: 127.0.0.1 だけで待ち受け、起動ごとの乱数トークンを要求する（URL の ?token= で一度渡すと Cookie に移る）。
 * Host と Origin も確かめ、別のサイトや DNS の付け替えから叩かれないようにする。
 */

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const MAX_BODY = 6 * 1024 * 1024;
const IMAGE_TYPES = new Set(['image/png', 'image/jpeg', 'image/gif', 'image/webp', 'image/svg+xml']);
const STRING_LIMITS: Record<string, number> = { owner: 100, fieldName: 100, taskId: 200, to: 100, from: 100, stepId: 100, questionId: 100, sessionId: 200, flowId: 100, key: 20, path: 1000, title: 300, due: 10, reason: 20000, prompt: 20000, note: 20000, text: 20000, body: 20000, message: 2000 };

/** RPC の引数の形を確かめる（型を偽った送信で、エンジンに想定外の値が入らないように）。 */
function validateParams(raw: unknown): Record<string, unknown> {
	if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
		throw new TaskBoardError('invalid-params', 'params must be an object');
	}
	const params = raw as Record<string, unknown>;
	for (const [key, value] of Object.entries(params)) {
		if (value === undefined || value === null) {
			continue;
		}
		if (key in STRING_LIMITS) {
			if (typeof value !== 'string' || value.length > STRING_LIMITS[key]) {
				throw new TaskBoardError('invalid-params', `${key} must be a string up to ${STRING_LIMITS[key]} characters`);
			}
		} else if (key === 'agent') {
			if (value !== 'claude' && value !== 'codex') {
				throw new TaskBoardError('invalid-params', 'agent must be claude or codex');
			}
		} else if (key === 'scope') {
			if (value !== 'team' && value !== 'personal') {
				throw new TaskBoardError('invalid-params', 'scope must be team or personal');
			}
		} else if (key === 'project') {
			if (!Number.isInteger(value) || (value as number) < 1) {
				throw new TaskBoardError('invalid-params', 'project must be a positive integer');
			}
		} else if (key === 'options') {
			const colors = ['GRAY', 'BLUE', 'GREEN', 'YELLOW', 'ORANGE', 'RED', 'PINK', 'PURPLE'];
			if (!Array.isArray(value) || value.length > 50 || value.some(o => !o || typeof o.name !== 'string' || !o.name.trim() || o.name.length > 100 || !colors.includes(o.color) || typeof o.description !== 'string' || o.description.length > 500)) {
				throw new TaskBoardError('invalid-params', 'options must be a list of { name, color, description }');
			}
		} else if (key === 'target') {
			if (value !== 'issue' && value !== 'pr') {
				throw new TaskBoardError('invalid-params', 'target must be issue or pr');
			}
		} else if (key === 'trackedOnly') {
			if (typeof value !== 'boolean') {
				throw new TaskBoardError('invalid-params', 'trackedOnly must be a boolean');
			}
		} else if (key === 'attempt') {
			if (!Number.isInteger(value) || (value as number) < 0) {
				throw new TaskBoardError('invalid-params', 'attempt must be a non-negative integer');
			}
		} else if (key === 'optionIndex') {
			if (!Number.isInteger(value) || (value as number) < 0 || (value as number) > 20) {
				throw new TaskBoardError('invalid-params', 'optionIndex must be a small integer');
			}
		} else if (key === 'speed') {
			if (typeof value !== 'number' || !Number.isFinite(value) || value < 0.25 || value > 20) {
				throw new TaskBoardError('invalid-params', 'speed must be between 0.25 and 20');
			}
		} else if (key === 'allow') {
			if (typeof value !== 'boolean') {
				throw new TaskBoardError('invalid-params', 'allow must be a boolean');
			}
		} else if (key === 'labels') {
			if (!Array.isArray(value) || value.length > 50 || value.some(v => typeof v !== 'string' || v.length > 100)) {
				throw new TaskBoardError('invalid-params', 'labels must be a list of strings');
			}
		} else if (key === 'flow') {
			if (typeof value !== 'object' || Array.isArray(value)) {
				throw new TaskBoardError('invalid-params', 'flow must be an object');
			}
		} else {
			throw new TaskBoardError('invalid-params', `unknown parameter: ${key}`);
		}
	}
	return params;
}

// `pnpm dev -- --repo …` のように pnpm が区切りの `--` をそのまま渡してくるので、先頭の `--` は読み飛ばす
const argv = process.argv.slice(2);
const { values: args } = parseArgs({
	args: argv[0] === '--' ? argv.slice(1) : argv,
	options: {
		repo: { type: 'string' },
		port: { type: 'string', default: '4870' },
		demo: { type: 'boolean', default: false },
		'no-github': { type: 'boolean', default: false },
		data: { type: 'string' },
		clones: { type: 'string' },
		'worktree-root': { type: 'string' },
		'real-workspaces': { type: 'boolean', default: false },
		login: { type: 'string' },
		prod: { type: 'boolean', default: false },
		open: { type: 'boolean', default: false },
		token: { type: 'string' },
		speed: { type: 'string' },
		quiet: { type: 'boolean', default: false },
		agents: { type: 'string', default: 'simulated' },
		bridge: { type: 'string' },
		// Para Code が起動したボード。鍵は IPC で受け取り、起動の合図も IPC で返す（鍵付きの URL を出力しない）。
		// 親（Para Code）との IPC が切れたら止まる
		embedded: { type: 'boolean', default: false },
		// SSH の窓のボード（--embedded と一緒に使う）。リポジトリは接続先にあり、IPC で受け取った中継のセッションで扱う
		remote: { type: 'boolean', default: false },
	},
	allowPositionals: false,
});

/** Para Code（親）とのやりとり。`--embedded` のときだけ使う。 */
type EmbeddedMessage =
	| { readonly type: 'ready'; readonly port: number; readonly repo: string | undefined }
	| { readonly type: 'failed'; readonly reason: 'busy' | 'error'; readonly message: string };

// Para Code は Electron を Node として動かして（ELECTRON_RUN_AS_NODE）このサーバーを起こす。消さないと、工程のコマンド
// （Electron を起動するテストなど）にも渡って Node として動いてしまう。Electron は起動のときしかこれを読まない
if (args.embedded) {
	delete process.env.ELECTRON_RUN_AS_NODE;
}

function tellParent(message: EmbeddedMessage, sent?: () => void): void {
	if (args.embedded && process.send && process.connected) {
		process.send(message, undefined, undefined, () => sent?.());
	} else {
		sent?.();
	}
}

/** 今動いているボードを止める処理（main() が開くたびに差し替える）。Para Code との IPC が切れたら呼ぶ。 */
let stopCurrent: (() => void) | undefined;

/**
 * Para Code から鍵を受け取る（最初の IPC のメッセージ）。コマンドラインや環境変数に載せると、`ps` や
 * エージェントが走らせるコマンド（`process.env` を受け継ぐ）から読めてしまう。
 */
/** SSH の窓のボードの対象（Para Code が IPC で渡す）。 */
interface IEmbeddedRemote {
	readonly sessionId: string;
	readonly authority: string;
	readonly root: string;
}

function parseEmbeddedRemote(value: unknown): IEmbeddedRemote | undefined {
	if (!value || typeof value !== 'object') {
		return undefined;
	}
	const { sessionId, authority, root } = value as Record<string, unknown>;
	return typeof sessionId === 'string' && typeof authority === 'string' && typeof root === 'string' && root.startsWith('/') ? { sessionId, authority, root } : undefined;
}

function receiveEmbeddedToken(): Promise<{ readonly token: string; readonly boardKey: string | undefined; readonly remote: IEmbeddedRemote | undefined }> {
	return new Promise((resolve, reject) => {
		const timer = setTimeout(() => reject(new Error('Para Code did not send the key')), 30_000);
		process.once('message', (message: unknown) => {
			clearTimeout(timer);
			const init = (message as { type?: unknown } | undefined)?.type === 'init' ? message as { token?: unknown; boardKey?: unknown; remote?: unknown } : undefined;
			const token = init?.token;
			if (typeof token === 'string' && token.length >= 16) {
				// boardKey: Para Code の接続口へ送る、起動ごとの鍵（無ければ接続口は断る）
				resolve({ token, boardKey: typeof init?.boardKey === 'string' ? init.boardKey : undefined, remote: parseEmbeddedRemote(init?.remote) });
			} else {
				reject(new Error('Para Code sent an invalid key'));
			}
		});
	});
}

/** WebSocket のサブプロトコル。`taskboard.<鍵>` で鍵を送り、サーバーは `taskboard` を選ぶ。 */
const WS_PROTOCOL = 'taskboard';
const WS_PROTOCOL_PREFIX = `${WS_PROTOCOL}.`;

function log(...parts: unknown[]): void {
	if (!args.quiet) {
		console.log('[taskboard]', ...parts);
	}
}

/** ワークツリーなら本体のリポジトリ（`--git-common-dir` の 1 つ上）。そうでなければそのまま。 */
async function mainRepository(toplevel: string): Promise<string> {
	const common = await git(toplevel, ['rev-parse', '--path-format=absolute', '--git-common-dir'], 5000).catch(() => undefined);
	return common && path.basename(common) === '.git' ? path.dirname(common) : toplevel;
}

async function resolveRepo(repo = args.repo): Promise<string | undefined> {
	const candidate = path.resolve(repo ?? process.cwd());
	return git(candidate, ['rev-parse', '--show-toplevel'], 5000).catch(() => undefined);
}

/** 開発モード（Vite）で鍵なしに配ってよいパス。画面のコード・依存・公開ファイル、エンジンとロゴの /@fs/ だけ。 */
const DEV_FS_ALLOWED = [
	path.resolve(fileURLToPath(new URL('../../../src/vs/paradis/contrib/taskBoard/common/', import.meta.url))),
	path.resolve(fileURLToPath(new URL('../../../src/vs/paradis/common/paradisAgentLogoPaths.ts', import.meta.url))),
];
function devPathAllowed(rawPathname: string): boolean {
	// 符号化した区切り（%2F・%5C）や、戻ると .. になるものは、判定と実際に配るファイルがずれうるので断る
	let pathname: string;
	try {
		pathname = decodeURIComponent(rawPathname);
	} catch {
		return false;
	}
	if (/%2f|%5c/i.test(rawPathname) || pathname.includes('\\') || pathname.split('/').includes('..')) {
		return false;
	}
	if (pathname === '/' || pathname === '/index.html' || /^\/[\w.-]+\.(png|ico|svg|webmanifest)$/.test(pathname)) {
		return true;
	}
	if (['/src/', '/@vite/', '/@id/', '/@react-refresh', '/node_modules/'].some(prefix => pathname.startsWith(prefix))) {
		return true;
	}
	if (pathname.startsWith('/@fs/')) {
		const file = path.resolve(pathname.slice('/@fs'.length));
		return DEV_FS_ALLOWED.some(allowed => file === allowed || file.startsWith(`${allowed}${path.sep}`));
	}
	return false;
}

/** HTML で書かれた成果物（計画を HTML で出すエージェントもいる）。 */
function isHtmlArtifact(artifact: ITaskBoardArtifact): boolean {
	return /\.html?$/i.test(artifact.path ?? '') || /^\s*(<!doctype html|<html)/i.test(artifact.content ?? '');
}

function stripContent(task: ITaskBoardTask): ITaskBoardTask {
	return { ...task, artifacts: task.artifacts.map((a): ITaskBoardArtifact => ({ ...a, content: undefined, hasContent: Boolean(a.content) })) };
}

function prFromDetail(base: ITaskBoardPrRef, d: ITaskBoardPullDetail): ITaskBoardPrRef {
	const failing = d.checks.some(c => c.state === 'failure' || c.state === 'cancelled');
	const pending = d.checks.some(c => c.state === 'pending' || c.state === 'queued');
	// 台帳の判定（mapPr）と同じく、人ごとの最新のレビューだけを見る
	const latest = new Map<string, ITaskBoardPullDetail['reviews'][number]>();
	for (const r of [...d.reviews].sort((a, b) => Date.parse(a.at) - Date.parse(b.at))) {
		if (r.state !== 'dismissed' && r.state !== 'pending') {
			latest.set(r.author, r);
		}
	}
	const reviews = [...latest.values()].map(r => r.state);
	return {
		...base,
		title: d.title,
		state: d.state,
		checks: !d.checks.length ? 'none' : failing ? 'failure' : pending ? 'pending' : 'success',
		checksPassed: d.checks.filter(c => c.state === 'success' || c.state === 'skipped' || c.state === 'neutral').length,
		checksTotal: d.checks.length,
		review: d.reviewDecision === 'approved' ? 'approved' : d.reviewDecision === 'changes' || reviews.includes('changes') ? 'changes' : reviews.includes('approved') ? 'approved' : reviews.length ? 'commented' : 'none',
	};
}

/** リポジトリを切り替えて開き直すときに、前のサーバーから引き継ぐもの。 */
interface IRestart {
	readonly repo: string;
	readonly token: string;
	readonly port: number;
}

/** `--embedded` のとき、Para Code から受け取った鍵。 */
let embeddedToken: string | undefined;
/** `--embedded` のとき、Para Code の接続口へ送る鍵（ボードを起動するたびに Para Code が作る）。 */
let embeddedBoardKey: string | undefined;
/** `--embedded --remote` のとき、SSH の窓の中継のセッション。 */
let embeddedRemote: IEmbeddedRemote | undefined;
/** 今の中継のセッション（SSH の窓を再読み込みすると、Para Code が ipc で新しいものを知らせる）。 */
let currentRelaySessionId: string | undefined;
/** 今の中継の口（セッションを差し替えるため）。 */
let currentRelay: RelayClient | undefined;

/** 起動したときのリポジトリ。切り替えてから戻ってきたときは、起動時の引数（台帳・クローン・ワークツリーの置き場）を使う。 */
let startupRepo: string | undefined;

/**
 * ボードのサーバーを起こす。`restart` は、上部のメニューでリポジトリを切り替えたときに同じプロセスの中で
 * 開き直すためのもの（台帳・作業場所・クローンの指定・ブラウザを開くかは引き継がず、ポートと鍵だけ引き継ぐ）。
 */
async function main(restart?: IRestart): Promise<void> {
	const demo = !restart && args.demo;
	// <img> とモックの <iframe> の URL に付ける、読むだけの鍵（スナップショットで画面へ渡す。早く作っておく）
	const assetKey = randomBytes(24).toString('base64url');
	// SSH の窓のボード: リポジトリは接続先にあり、git もファイルも中継で扱う（relay.ts）。リポジトリの切り替えはしない
	const remoteTarget = args.remote && !restart ? embeddedRemote : undefined;
	let relay: RelayClient | undefined;
	let relayInfo: IRelaySessionInfo | undefined;
	if (remoteTarget) {
		// 接続口へは窓が鍵を登録してから入れるので、それまでの 403・404 はやり直す（SSE は使わない口）
		const relayBridge = new ParaCodeBridgeClient({ bridgeFile: args.bridge, boardKey: embeddedBoardKey, onEvent: () => undefined, onConnection: () => undefined });
		relay = RelayClient.of(relayBridge, currentRelaySessionId ?? remoteTarget.sessionId);
		currentRelay = relay;
		relayInfo = await relay.waitForSession();
	}
	const remoteIo = relay && relayInfo ? relayFlowIo(relay, relayInfo.root) : undefined;
	let repoPath = demo ? undefined : relayInfo ? relayInfo.root : await resolveRepo(restart?.repo);
	if (args.embedded && !restart && repoPath && !remoteTarget) {
		// Para Code の今のスペースから開く。ワークツリー（Para Code の新しいスペースやボードの作業場所）なら本体のリポジトリで
		// 開き、ボードのクローンなら断る（別の空の台帳と、ワークツリーのさらにワークツリーができてしまう）
		repoPath = await mainRepository(repoPath);
		const known = await boardPlaces();
		const real = (p: string) => { try { return realpathSync(p); } catch { return path.resolve(p); } };
		if (known.clones.map(real).includes(real(repoPath))) {
			throw new TaskBoardError('invalid-params', 'これはタスクボードの作業場所（クローン）なので、リポジトリとしては開けません');
		}
	}
	if (!restart) {
		startupRepo = repoPath;
	}
	// 起動したリポジトリへ戻ってきたら、起動時の引数をそのまま使う（別の台帳を開いて元のタスクが見えなくならないように）
	const fresh = !restart || (repoPath !== undefined && repoPath === startupRepo);
	// G0: SSH のボードの owner/repo は、起動時に窓が返した origin から決めて固定する（後から作業場所の origin を読み直さない）
	const remote: IRepoSlug | undefined = relayInfo ? parseRemote(relayInfo.originFetch) : repoPath ? parseRemote(await remoteUrl(repoPath)) : undefined;
	// 台帳の鍵: 手元と接続先の同じパスが同じ台帳にならないように、SSH のボードは接続先の URI で分ける
	const ledgerKey = remoteTarget && repoPath ? `vscode-remote://${remoteTarget.authority}${repoPath}` : repoPath;
	const store = new Store(dataDir(ledgerKey ?? (demo ? 'demo' : undefined), fresh ? args.data : undefined));
	// 同じリポジトリを開いているボードがほかにあれば断る（両方のエンジンが同じ台帳と作業場所を使ってしまう）
	if (!demo) {
		await store.lock(args.embedded ? 'embedded' : 'standalone');
	}
	const settings: ILocalSettings = (await store.loadSettings()) ?? {};
	// SSH のボードは clone を使わず、ワークツリーの置き場は窓が決めたもの
	const clones = relayInfo ? undefined : args.clones && fresh ? args.clones.split(',').map(s => s.trim()).filter(Boolean) : settings.clones;
	const worktreeRoot = relayInfo ? relayInfo.worktreeRoot : (fresh ? args['worktree-root'] : undefined) ?? settings.worktreeRoot ?? (repoPath ? path.join(path.dirname(repoPath), `${path.basename(repoPath)}-worktrees`) : '');
	if (args.agents !== 'simulated' && args.agents !== 'para-code') {
		throw new Error('--agents は simulated か para-code');
	}
	const paraCodeMode = args.agents === 'para-code';
	if (paraCodeMode && !repoPath) {
		throw new Error('--agents para-code needs --repo');
	}
	// 本物のエージェントには、本物のブランチを用意した作業場所を渡す
	const realWorkspaces = Boolean((args['real-workspaces'] || paraCodeMode) && repoPath);
	if (args['real-workspaces'] && !repoPath) {
		throw new Error('--real-workspaces needs --repo');
	}
	if (args.clones && !args.demo && fresh && !relayInfo) {
		await store.saveSettings({ ...settings, clones });
	}

	let engine!: TaskBoardEngine;
	let broadcastTimer: NodeJS.Timeout | undefined;
	const sockets = new Set<WebSocket>();
	const send = (message: TaskBoardServerMessage) => {
		const text = JSON.stringify(message);
		for (const socket of sockets) {
			if (socket.readyState === WebSocket.OPEN) {
				socket.send(text);
			}
		}
	};
	const broadcastSoon = () => {
		if (broadcastTimer) {
			return;
		}
		broadcastTimer = setTimeout(() => {
			broadcastTimer = undefined;
			send({ type: 'snapshot', snapshot: snapshot() });
		}, 60);
	};

	const sim = new Simulation({ engine: () => engine, onManualChange: broadcastSoon, repo: remote, demoManual: demo });
	sim.setSpeed(Number(args.speed ?? settings.speed ?? 1) || 1);
	const placePath = (task: ITaskBoardTask) => engine.getSlots().find(s => s.id === task.place)?.path || undefined;
	let bridgeState: { connected: boolean; detail?: string } = { connected: false };
	const paraAgents = paraCodeMode ? new ParaCodeAgents({
		engine: () => engine,
		placePath,
		bridgeFile: args.bridge,
		boardKey: embeddedBoardKey,
		relaySessionId: remoteTarget ? () => currentRelaySessionId : undefined,
		readArtifact: relay ? (place, relativePath, maxBytes) => relay!.readFile(place, relativePath, maxBytes) : undefined,
		onConnection: (connected, detail) => {
			bridgeState = { connected, detail };
			log(connected ? 'Para Code につながりました' : `Para Code: ${detail ?? '切断'}`);
			broadcastSoon();
		},
	}) : undefined;
	const useGitHub = !demo && !args['no-github'];
	const client = useGitHub ? new GitHubClient({ token: ghTokenProvider() }) : undefined;
	const commandRunner = relay ? new RelayUnsupportedRunner(() => engine) : paraCodeMode ? new CommandRunner({ engine: () => engine, placePath, repoPath: repoPath!, repo: remote, github: client }) : undefined;
	const gitWorkspaces = relay && relayInfo ? new RemoteWorkspaces(relay, relayInfo) : realWorkspaces ? new GitWorkspaces(repoPath!, worktreeRoot) : undefined;
	/** 止めるときに解除するタイマー（開き直した後も古いエンジンが動き出さないように）。 */
	const timers: NodeJS.Timeout[] = [];
	engine = new TaskBoardEngine({
		clock: Date.now,
		newId: () => randomBytes(6).toString('hex'),
		agents: paraAgents ?? sim,
		runner: commandRunner ?? sim,
		workspaces: gitWorkspaces ?? sim,
	});

	const sync = client ? new GitHubSync({
		client,
		engine,
		repo: remote,
		onState: broadcastSoon,
		onSynced: r => { if (r.added || r.removed) { send({ type: 'notice', notice: { id: randomBytes(4).toString('hex'), kind: 'synced', at: Date.now(), detail: `${r.added}/${r.updated}/${r.removed}` } }); } },
	}) : undefined;

	// Codex の設定の許可の有無（起動時と、書き足したとき・1 分ごとに読み直す）
	// まだ常に許可になっていない Codex の設定（CODEX_HOME ごと）と、足りないツール
	let codexPending: { readonly path: string; readonly missing: readonly string[]; readonly manual?: string }[] = [];
	const refreshCodexApproval = async () => {
		const next = await codexApprovalStates();
		if (JSON.stringify(next) !== JSON.stringify(codexPending)) {
			codexPending = next;
			broadcastSoon();
		}
	};
	// Claude Code のユーザーの設定（settings.json）で、まだ許可されていないものと、足りないツール
	let claudePending: { readonly path: string; readonly missing: readonly string[]; readonly manual?: string }[] = [];
	const refreshClaudeApproval = async () => {
		const next = await claudeApprovalStates();
		if (JSON.stringify(next) !== JSON.stringify(claudePending)) {
			claudePending = next;
			broadcastSoon();
		}
	};
	// 「常に許可」は手元の設定を読み書きするので、SSH のボードでは出さない（接続先の担当は接続先の設定を読む）
	if (paraCodeMode && !relay) {
		void refreshCodexApproval();
		void refreshClaudeApproval();
		timers.push(setInterval(() => void refreshCodexApproval(), 60000).unref());
		timers.push(setInterval(() => void refreshClaudeApproval(), 60000).unref());
	}

	/** タスクの担当か、フローの工程の担当に Claude Code がいるか。 */
	const claudeInUse = () => engine.getTasks().some(t => t.agent === 'claude') || engine.getFlows().some(f => f.steps.some(step => step.agent === 'claude'));
	const runtime = () => ({
		agents: paraCodeMode ? 'para-code' as const : 'simulated' as const,
		agentsConnected: paraCodeMode ? bridgeState.connected : undefined,
		agentsDetail: paraCodeMode && !bridgeState.connected ? bridgeState.detail : undefined,
		codexApprovalMissing: paraCodeMode ? [...new Set(codexPending.flatMap(p => p.missing))] : undefined,
		codexConfigPaths: paraCodeMode ? codexPending.filter(p => p.manual === undefined).map(p => p.path) : undefined,
		codexManualConfigs: paraCodeMode ? codexPending.filter(p => p.manual !== undefined).map(p => ({ path: p.path, reason: p.manual! })) : undefined,
		// Claude Code の帯は、ボードが Claude Code の担当を使うときだけ出す（~/.claude は Para Code の hook の設置でも作られるので、有無では決めない）
		claudeApprovalMissing: paraCodeMode && claudeInUse() ? [...new Set(claudePending.flatMap(p => p.missing))] : undefined,
		claudeConfigPaths: paraCodeMode && claudeInUse() ? claudePending.filter(p => p.manual === undefined).map(p => p.path) : undefined,
		claudeManualConfigs: paraCodeMode && claudeInUse() ? claudePending.filter(p => p.manual !== undefined).map(p => ({ path: p.path, reason: p.manual! })) : undefined,
		assetKey,
		speed: sim.getSpeed(),
		realWorkspaces,
		repoPath,
		repoLabel: remote ? `${remote.owner}/${remote.repo}` : demo ? 'example/para-code（見本）' : repoPath ? path.basename(repoPath) : undefined,
	});
	const snapshot = (): ITaskBoardSnapshot => ({
		version: engine.getVersion(),
		now: Date.now(),
		tasks: engine.getTasks().map(stripContent),
		flows: [...engine.getFlows()],
		activeFlowId: engine.getActiveFlowId(),
		slots: engine.getSlots(),
		manual: [...sim.manual],
		github: sync ? sync.getState() : { mode: 'off' },
		runtime: runtime(),
	});

	// 認証は時間がかかることがあるので、フロー（個人のフォルダにログイン名が要る）の読み込みと並べて待つ
	const loginPromise = client ? client.init().catch(err => { log('GitHub:', redactGitHubSecrets(err.message)); return undefined; }) : Promise.resolve(args.login ?? (demo ? 'you' : undefined));
	const login = await loginPromise;
	const loaded = await loadFlows(repoPath, login, remoteIo);
	for (const problem of loaded.problems) {
		log(`flow: ${problem.path}: ${problem.message}`);
	}
	engine.setFlows(loaded.flows, loaded.active, true);

	const slots = clones?.length ? await inspectClones(clones) : paraCodeMode ? [] : demoSlots();
	if (!realWorkspaces) {
		// 実際の git 操作をしないときは、未コミットの変更があっても貸し出せる（シミュレーションなので触らない）
		engine.setPoolSlots(slots.map(s => ({ ...s, dirty: false })));
	} else {
		engine.setPoolSlots(slots);
	}

	const persisted = await store.loadState();
	if (persisted) {
		engine.restore(persisted);
	} else if (demo) {
		const seeded = buildDemo(engine.getActiveFlowId());
		engine.restore(seeded.state);
		for (const id of seeded.resume) {
			engine.retry(id);
		}
	}

	engine.onDidChange(() => {
		store.scheduleSave(() => engine.serialize());
		sim.onEngineChange();
		paraAgents?.onEngineChange();
		sync?.scheduleWriteBack();
		broadcastSoon();
	});
	if (realWorkspaces && clones?.length) {
		// 作業場所の汚れ（未コミットの変更）は、手で片付けられることもあるので 1 分ごとに調べ直す
		timers.push(setInterval(() => void inspectClones(clones).then(slots => engine.setPoolSlots(slots)), 60000).unref());
	}
	engine.onDidNotice(notice => send({ type: 'notice', notice }));
	sim.onEngineChange();

	/* ---------------- RPC ---------------- */

	const handlers: { [M in TaskBoardRpcMethod]: (params: ITaskBoardRpc[M]['params']) => Promise<ITaskBoardRpc[M]['result']> | ITaskBoardRpc[M]['result'] } = {
		snapshot: () => snapshot(),
		addTask: p => ({ id: engine.addTask(p) }),
		start: p => engine.start(p.taskId, { stepId: p.stepId, agent: p.agent, prompt: p.prompt }),
		move: p => engine.move(p.taskId, p.to, p.reason, p.from, p.attempt),
		answer: p => engine.answer(p.taskId, p.questionId, { optionIndex: p.optionIndex, text: p.text }),
		approve: p => engine.approve(p.taskId, p.note, p.from, p.attempt),
		sendBack: p => engine.sendBack(p.taskId, p.to, p.reason, p.from, p.attempt),
		retry: p => engine.retry(p.taskId, p.from, p.attempt),
		cancel: p => engine.cancel(p.taskId),
		complete: p => engine.complete(p.taskId, p.from, p.attempt),
		markDone: p => engine.markDone(p.taskId),
		nudge: p => engine.nudge(p.taskId),
		sendInput: p => engine.sendInput(p.taskId, p.text),
		sendKey: p => engine.sendKey(p.taskId, p.key),
		removeTask: p => engine.removeTask(p.taskId),
		answerManual: p => { sim.answerManual(p.sessionId, p.allow); },
		adoptManual: p => {
			const session = sim.manual.find(m => m.id === p.sessionId);
			if (!session) {
				throw new TaskBoardError('not-found', 'session not found');
			}
			const id = engine.adopt({ sessionId: session.id, title: p.title || session.name, agent: session.agent, branch: session.branch, place: session.name });
			sim.removeManual(session.id);
			return { id };
		},
		saveFlow: async p => {
			if (!repoPath) {
				throw new TaskBoardError('invalid-state', 'リポジトリを指定して起動したときだけ保存できます（--repo）');
			}
			const problems: { path: string; message: string }[] = [];
			const parsed = parseTaskBoardFlow(p.flow, p.scope, 'flow', problems);
			if (!parsed) {
				throw new TaskBoardError('invalid-params', problems.map(x => `${x.path}: ${x.message}`).join('; '));
			}
			const before = [...engine.getFlows()];
			const next: ITaskBoardFlow[] = before.some(f => f.id === parsed.id) ? before.map(f => f.id === parsed.id ? parsed : f) : [...before, parsed];
			engine.setFlows(next, engine.getActiveFlowId());
			try {
				const file = await saveFlow(repoPath, login, parsed, p.scope, engine.getActiveFlowId(), remoteIo);
				return { path: remoteIo ? path.posix.relative(repoPath, file) : path.relative(repoPath, file) };
			} catch (err) {
				engine.setFlows(before, engine.getActiveFlowId(), true);
				throw new TaskBoardError('io', (err as Error).message);
			}
		},
		setActiveFlow: async p => {
			engine.setActiveFlow(p.flowId);
			if (repoPath) {
				await saveActiveFlow(repoPath, login, p.flowId, remoteIo).catch(err => log('save active flow:', err.message));
			}
			void sync?.syncNow();
		},
		sync: async () => {
			await sync?.syncNow();
		},
		setSpeed: async p => {
			sim.setSpeed(p.speed);
			await store.saveSettings({ ...((await store.loadSettings()) ?? {}), speed: sim.getSpeed() });
			broadcastSoon();
		},
		issueDetail: async p => {
			const task = engine.getTask(p.taskId);
			if (!task) {
				throw new TaskBoardError('not-found', 'task not found');
			}
			if (task.issue?.url && sync) {
				return await sync.issueDetail(task) ?? sim.issueDetail(task);
			}
			return sim.issueDetail(task);
		},
		pullDetail: async p => {
			const task = engine.getTask(p.taskId);
			if (!task?.pr) {
				return undefined;
			}
			if (task.pr.simulated || !sync) {
				return sim.pullDetail(task);
			}
			const detail = await sync.pullDetail(task);
			if (detail) {
				engine.reportPullRequest(task.id, prFromDetail(task.pr, detail));
			}
			return detail;
		},
		comment: async p => {
			const task = engine.getTask(p.taskId);
			if (!task) {
				throw new TaskBoardError('not-found', 'task not found');
			}
			if (!p.body.trim()) {
				throw new TaskBoardError('invalid-params', 'comment is empty');
			}
			const real = p.target === 'pr' ? task.pr && !task.pr.simulated : task.issue?.url;
			if (!real || !sync) {
				return sim.addComment(task, p.target, p.body.trim());
			}
			return sync.addComment(task, p.target, p.body.trim());
		},
		renderMarkdown: async p => {
			const task = engine.getTask(p.taskId);
			if (!task || !sync || (!task.issue?.url && !(task.pr && !task.pr.simulated))) {
				return { html: undefined };
			}
			return { html: await sync.renderMarkdown(task, p.text) };
		},
		projectFields: async p => {
			if (!sync) {
				throw new TaskBoardError('invalid-state', 'GitHub につないで起動したときだけ読めます');
			}
			return sync.projectFields(p.owner, p.project);
		},
		addProjectOptions: async p => {
			if (!sync) {
				throw new TaskBoardError('invalid-state', 'GitHub につないで起動したときだけ書けます');
			}
			return sync.addProjectOptions(p.owner, p.project, p.fieldName, p.options);
		},
		commitAndRetry: async p => {
			const task = engine.getTask(p.taskId);
			if (!task || task.status !== 'failed' || !task.uncommitted?.length || (p.attempt !== undefined && p.attempt !== task.attempt)) {
				throw new TaskBoardError('invalid-state', 'このタスクはコミットを待っていません');
			}
			// 待つ間にタスクが進んでも、別の工程をやり直さないように、今の工程と試行を固定する
			if (relay) {
				throw new TaskBoardError('invalid-state', `${RELAY_UNSUPPORTED}（ボードからのコミット）`);
			}
			const { step: fromStep, attempt: fromAttempt } = task;
			const cwd = placePath(task);
			const message = p.message.trim();
			if (!cwd || !message) {
				throw new TaskBoardError('invalid-params', !cwd ? '作業場所が分かりません' : 'コミットのメッセージが空です');
			}
			await excludeBoardFiles(cwd);
			if (p.trackedOnly && !(await git(cwd, ['status', '--porcelain', '--untracked-files=no']).catch(() => ''))) {
				throw new TaskBoardError('invalid-state', '変更したファイルがありません（新しいファイルだけです）。すべてコミットするか、差し戻してください');
			}
			// 追跡しているファイルだけを選ぶと、エージェントが作った新しいファイル（試作の残りなど）は入れない
			await git(cwd, ['add', p.trackedOnly ? '-u' : '-A']);
			await git(cwd, ['commit', '--quiet', '-m', message]);
			const sha = await git(cwd, ['rev-parse', '--short', 'HEAD']);
			engine.reportOutput(task.id, [`${cwd} $ git commit -m ${JSON.stringify(message)}`, `  ${sha}`]);
			engine.retry(task.id, fromStep, fromAttempt);
			return { sha };
		},
		restartAgent: async p => {
			const task = engine.getTask(p.taskId);
			const step = task ? engine.flowOf(task).steps.find(s => s.id === task.step) : undefined;
			if (!task || step?.kind !== 'agent' || (p.attempt !== undefined && p.attempt !== task.attempt)) {
				throw new TaskBoardError('invalid-state', 'エージェントの工程ではありません');
			}
			const { step: fromStep, attempt: fromAttempt } = task;
			if (paraAgents) {
				await paraAgents.release(task);
			}
			engine.retry(task.id, fromStep, fromAttempt);
		},
		prReady: async p => {
			const task = engine.getTask(p.taskId);
			if (!task?.pr || task.pr.simulated || task.pr.state !== 'draft') {
				throw new TaskBoardError('invalid-state', 'ドラフトの PR がありません');
			}
			if (!client) {
				throw new TaskBoardError('invalid-state', 'GitHub につないで起動したときだけ使えます');
			}
			await client.markPullRequestReady(task.pr.owner, task.pr.repo, task.pr.number).catch((err: Error) => {
				throw new TaskBoardError('invalid-state', `PR をレビュー可能にできませんでした: ${err.message}`);
			});
			engine.reportPullRequest(task.id, { ...task.pr, state: 'open' });
		},
		repositories: async () => {
			if (relay) {
				return { current: repoPath, items: [] };
			}
			let fromParaCode: { path: string; name: string }[] = [];
			if (paraAgents && bridgeState.connected) {
				const health = await paraAgents.client.request<{ windows?: { repositories?: { path: string; name: string }[] }[] }>('GET', '/v1/health', undefined, 5000).catch(() => undefined);
				fromParaCode = (health?.windows ?? []).flatMap(w => w.repositories ?? []);
			}
			// ボードの作業場所（どのボードのクローン・ワークツリーも）は、リポジトリとしては出さない
			const known = await boardPlaces();
			const places = new Set([...known.clones, ...(clones ?? []).map(c => path.resolve(c)), ...engine.getSlots().map(s => s.path).filter(Boolean)]);
			const roots = [...known.worktreeRoots, ...(worktreeRoot ? [path.resolve(worktreeRoot)] : [])];
			const items = (await repositoryChoices(fromParaCode)).filter(r => !places.has(path.resolve(r.path)) && !roots.some(root => path.resolve(r.path).startsWith(`${root}${path.sep}`)));
			// 切り替えで断るもの（ほかのボードのワークツリー）も出さない
			const others = await Promise.all(items.map(r => isOtherBoardWorktree(r.path)));
			return { current: repoPath, items: items.filter((_, i) => !others[i]) };
		},
		switchRepository: async p => {
			if (demo || relay) {
				throw new TaskBoardError('invalid-state', relay ? `${RELAY_UNSUPPORTED}（リポジトリの切り替え）` : '見本のボードではリポジトリを切り替えられません');
			}
			const target = await git(path.resolve(p.path), ['rev-parse', '--show-toplevel'], 5000).catch(() => undefined);
			if (!target) {
				throw new TaskBoardError('invalid-params', 'git のリポジトリではありません');
			}
			if (target === repoPath) {
				return;
			}
			// ボードの作業場所（クローン・ワークツリー）は、リポジトリとしては開かない。シンボリックリンクを挟んでも見分ける
			const real = (p: string) => { try { return realpathSync(p); } catch { return path.resolve(p); } };
			const known = await boardPlaces();
			const realTarget = real(target);
			const places = [...known.clones, ...(clones ?? [])].map(real);
			const roots = [...known.worktreeRoots, ...(worktreeRoot ? [worktreeRoot] : [])].map(real);
			if (places.includes(realTarget) || roots.some(root => realTarget.startsWith(`${root}${path.sep}`)) || await isOtherBoardWorktree(target)) {
				throw new TaskBoardError('invalid-params', 'これはタスクボードの作業場所なので、リポジトリとしては開けません');
			}
			const other = await storeOwner(dataDir(target));
			if (other) {
				throw new TaskBoardError('invalid-state', other.mode === 'embedded'
					? 'このリポジトリは Para Code が開いたタスクボードで開かれています'
					: 'このリポジトリはほかのタスクボード（手で起動したもの）で開かれています');
			}
			// 返事を返してから、同じポートと鍵で起動し直す
			setTimeout(() => void shutdown(target), 100);
		},
		approveCodexTools: async () => {
			if (relay) {
				throw new TaskBoardError('invalid-state', `${RELAY_UNSUPPORTED}（常に許可）`);
			}
			if (!paraCodeMode) {
				throw new TaskBoardError('invalid-state', 'Para Code につないで起動したときだけ使えます');
			}
			// 足りない設定ファイルすべてに足す。読み方に迷う形のものは書かず、理由をまとめて返す
			// 1 つが失敗（読めない形・権限・容量など）しても残りは試し、終わったら帯を出し直す
			const refused: string[] = [];
			const written: string[] = [];
			try {
				for (const pending of await codexApprovalStates()) {
					// 書き方を読み切れない設定は書かない（帯に手で足す方法を出している）
					if (pending.manual !== undefined) {
						continue;
					}
					try {
						await addCodexApprovals(pending.path);
						written.push(pending.path);
					} catch (err) {
						refused.push(`${pending.path}: ${err instanceof CodexConfigError ? err.message : `書き込めませんでした（${err instanceof Error ? err.message : String(err)}）`}`);
					}
				}
			} finally {
				await refreshCodexApproval();
			}
			if (refused.length) {
				const done = written.length ? `足しました: ${written.join(', ')}。` : '';
				throw new TaskBoardError('invalid-state', `${done}次は手で足してください。${refused.join(' / ')}`);
			}
			return { path: written.join(', ') };
		},
		approveClaudeTools: async () => {
			if (relay) {
				throw new TaskBoardError('invalid-state', `${RELAY_UNSUPPORTED}（常に許可）`);
			}
			if (!paraCodeMode) {
				throw new TaskBoardError('invalid-state', 'Para Code につないで起動したときだけ使えます');
			}
			// Codex と同じく、足りない settings.json すべてに足し、読めない形のものは書かずに理由をまとめて返す
			const refused: string[] = [];
			const written: string[] = [];
			try {
				for (const pending of await claudeApprovalStates()) {
					if (pending.manual !== undefined) {
						continue;
					}
					try {
						await addClaudeApprovals(pending.path);
						written.push(pending.path);
					} catch (err) {
						refused.push(`${pending.path}: ${err instanceof ClaudeConfigError ? err.message : `書き込めませんでした（${err instanceof Error ? err.message : String(err)}）`}`);
					}
				}
			} finally {
				await refreshClaudeApproval();
			}
			if (refused.length) {
				const done = written.length ? `足しました: ${written.join(', ')}。` : '';
				throw new TaskBoardError('invalid-state', `${done}次は手で足してください。${refused.join(' / ')}`);
			}
			return { path: written.join(', ') };
		},

		pullFilePatch: async p => {
			const task = engine.getTask(p.taskId);
			if (!task?.pr) {
				return { patch: undefined };
			}
			return { patch: task.pr.simulated || !sync ? sim.pullFilePatch(task, p.path) : await sync.pullFilePatch(task, p.path) };
		},
	};

	/* ---------------- HTTP ---------------- */

	const token = restart?.token ?? embeddedToken ?? args.token ?? randomBytes(24).toString('base64url');
	let port = restart?.port ?? Number(args.port);
	const allowedHosts = () => [`127.0.0.1:${port}`, `localhost:${port}`];
	const safeEqual = (a: string | undefined, b: string) => {
		if (!a || a.length !== b.length) {
			return false;
		}
		return timingSafeEqual(Buffer.from(a), Buffer.from(b));
	};
	// 鍵は Cookie にしない（Cookie はポートを区別せず、同じ PC の別のポートのサーバーにも送られる）。
	// 画面は鍵をこのオリジンの localStorage に持ち、ヘッダー（WebSocket はサブプロトコル）で送る
	const wsProtocolToken = (req: http.IncomingMessage) => (req.headers['sec-websocket-protocol'] ?? '').split(',').map(p => p.trim()).find(p => p.startsWith(WS_PROTOCOL_PREFIX))?.slice(WS_PROTOCOL_PREFIX.length);
	const authed = (req: http.IncomingMessage) => safeEqual(req.headers['x-taskboard-token'] as string | undefined, token) || safeEqual(wsProtocolToken(req), token);
	// <img> とモックの <iframe> はヘッダーを付けられないので、読むだけの別の鍵を URL に付ける（RPC には使えない）
	const assetAuthed = (req: http.IncomingMessage, url: URL) => safeEqual(url.searchParams.get('k') ?? undefined, assetKey) || authed(req);
	const hostOk = (req: http.IncomingMessage) => allowedHosts().includes(req.headers.host ?? '');
	const originOk = (req: http.IncomingMessage) => {
		const origin = req.headers.origin;
		return !origin || allowedHosts().some(h => origin === `http://${h}`);
	};

	const server = http.createServer();
	const prod = args.prod;
	const vite = prod ? undefined : await (await import('vite')).createServer({
		root: ROOT,
		configFile: path.join(ROOT, 'vite.config.ts'),
		appType: 'spa',
		logLevel: args.quiet ? 'error' : 'info',
		server: { middlewareMode: true, hmr: { server } },
	});

	const readBody = (req: http.IncomingMessage) => new Promise<string>((resolve, reject) => {
		let size = 0;
		const chunks: Buffer[] = [];
		req.on('data', (chunk: Buffer) => {
			size += chunk.length;
			if (size > MAX_BODY) {
				reject(new TaskBoardError('invalid-params', 'request too large'));
				req.destroy();
				return;
			}
			chunks.push(chunk);
		});
		req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
		req.on('error', reject);
	});
	const json = (res: http.ServerResponse, status: number, body: unknown) => {
		res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
		res.end(JSON.stringify(body));
	};

	const serveArtifact = (res: http.ServerResponse, taskId: string, artifactId: string) => {
		const artifact = engine.getTask(taskId)?.artifacts.find(a => a.id === artifactId);
		if (!artifact?.content) {
			res.writeHead(404).end();
			return;
		}
		const headers: Record<string, string> = { 'referrer-policy': 'no-referrer', 'cache-control': 'private, max-age=60', 'x-content-type-options': 'nosniff' };
		if (artifact.kind === 'mock' || isHtmlArtifact(artifact)) {
			// モックや HTML で書かれた計画は、別オリジン扱い（スクリプトも親の画面も触れない）で表示する
			res.writeHead(200, { ...headers, 'content-type': 'text/html; charset=utf-8', 'content-security-policy': "sandbox; default-src 'none'; style-src 'unsafe-inline'; img-src data:; font-src data:" });
			res.end(artifact.content);
			return;
		}
		const data = artifact.content.match(/^data:(?<mime>[\w/+.-]+);base64,(?<body>.*)$/s);
		// 画像として配るのは決まった種類だけ。SVG も sandbox にして、中のスクリプトや移動を止める
		if (data?.groups && IMAGE_TYPES.has(data.groups.mime)) {
			res.writeHead(200, { ...headers, 'content-type': data.groups.mime, 'content-security-policy': "sandbox; default-src 'none'; style-src 'unsafe-inline'; img-src data:" });
			res.end(Buffer.from(data.groups.body, 'base64'));
			return;
		}
		res.writeHead(200, { ...headers, 'content-type': 'text/plain; charset=utf-8' });
		res.end(artifact.content);
	};

	const serveStatic = async (req: http.IncomingMessage, res: http.ServerResponse, pathname: string) => {
		const dist = path.join(ROOT, 'dist');
		let file = path.join(dist, path.normalize(pathname).replace(/^(\.\.[/\\])+/, ''));
		if (!file.startsWith(dist + path.sep) || !existsSync(file) || (await fs.stat(file)).isDirectory()) {
			file = path.join(dist, 'index.html');
		}
		const type = ({ '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.png': 'image/png', '.woff2': 'font/woff2' } as Record<string, string>)[path.extname(file)] ?? 'application/octet-stream';
		res.writeHead(200, {
			'content-type': type,
			'x-content-type-options': 'nosniff',
			// 画面の HTML は鍵付きの URL で読まれるので、キャッシュに残さない
			...(type.startsWith('text/html') ? { 'cache-control': 'no-store' } : {}),
			'content-security-policy': `default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: https:; frame-src 'self'; connect-src 'self' ws://${req.headers.host}`,
		});
		res.end(await fs.readFile(file));
	};

	server.on('request', (req, res) => {
		void (async () => {
			if (!hostOk(req)) {
				res.writeHead(403, { 'content-type': 'text/plain' }).end('forbidden host');
				return;
			}
			const url = new URL(req.url ?? '/', `http://${req.headers.host}`);
			const given = url.searchParams.get('token');
			if (given !== null && !safeEqual(given, token)) {
				res.writeHead(401, { 'content-type': 'text/plain; charset=utf-8' }).end('トークンが違います。ターミナルに表示された URL を開いてください。');
				return;
			}
			const artifact = url.pathname.match(/^\/api\/artifacts\/(?<task>[^/]+)\/(?<artifact>[^/]+)$/);
			const isAsset = (artifact?.groups !== undefined || url.pathname === '/api/image') && req.method === 'GET';
			// 画面のコード（HTML・JS・CSS）は鍵なしで配る。データの口だけを鍵で守る
			if (url.pathname.startsWith('/api/') && !(isAsset ? assetAuthed(req, url) : authed(req))) {
				json(res, 401, { ok: false, error: { code: 'unauthorized', message: 'サーバーを起動したターミナルに表示された URL（?token= 付き）を開いてください' } });
				return;
			}
			if (url.pathname === '/api/rpc') {
				// 止めている間（開き直す前の待ち）は、画面からの操作を受け付けない
				if (closing) {
					json(res, 503, { ok: false, error: { code: 'invalid-state', message: 'タスクボードを開き直しています' } });
					return;
				}
				if (req.method !== 'POST' || !originOk(req) || !(req.headers['content-type'] ?? '').startsWith('application/json')) {
					json(res, 403, { ok: false, error: { code: 'invalid-params', message: 'bad request' } });
					return;
				}
				try {
					const body = JSON.parse(await readBody(req)) as { method: TaskBoardRpcMethod; params?: unknown };
					if (typeof body.method !== 'string' || !Object.hasOwn(handlers, body.method)) {
						throw new TaskBoardError('invalid-params', `unknown method: ${String(body.method)}`);
					}
					const params = validateParams(body.params ?? {});
					const handler = handlers[body.method] as (params: unknown) => unknown;
					const result = await handler(params);
					json(res, 200, { ok: true, result: result ?? null });
				} catch (err) {
					const code = err instanceof TaskBoardError ? err.code : err instanceof GitHubError ? 'github' : err instanceof SyntaxError ? 'invalid-params' : 'internal';
					if (code === 'internal') {
						console.error('[taskboard] rpc failed:', redactGitHubSecrets(String((err as Error)?.stack ?? err)));
					}
					json(res, 200, { ok: false, error: { code, message: redactGitHubSecrets((err as Error).message) } });
				}
				return;
			}
			if (artifact?.groups && req.method === 'GET') {
				serveArtifact(res, decodeURIComponent(artifact.groups.task), decodeURIComponent(artifact.groups.artifact));
				return;
			}
			if (url.pathname === '/api/image' && req.method === 'GET') {
				// 本文の画像の中継。GitHub の置き場だけを読み、画像として sandbox 付きで返す
				const target = url.searchParams.get('url') ?? '';
				const image = sync ? await sync.fetchImage(target).catch(() => undefined) : undefined;
				if (!image || !IMAGE_TYPES.has(image.type)) {
					res.writeHead(404, { 'cache-control': 'no-store' }).end();
					return;
				}
				res.writeHead(200, { 'content-type': image.type, 'cache-control': 'private, max-age=600', 'x-content-type-options': 'nosniff', 'referrer-policy': 'no-referrer', 'content-security-policy': "sandbox; default-src 'none'; style-src 'unsafe-inline'; img-src data:" });
				res.end(image.body);
				return;
			}
			if (url.pathname === '/api/health') {
				json(res, 200, { ok: true, version: engine.getVersion() });
				return;
			}
			if (vite) {
				// 開発モードでも、鍵なしで届くのは画面のコードだけにする（アプリのディレクトリ全体や、エディタを開く口は出さない）
				if (!devPathAllowed(url.pathname)) {
					res.writeHead(404, { 'content-type': 'text/plain' }).end('not found');
					return;
				}
				vite.middlewares(req, res, () => res.writeHead(404).end());
			} else {
				await serveStatic(req, res, url.pathname);
			}
		})().catch(err => {
			console.error('[taskboard] request failed:', err);
			if (!res.headersSent) {
				res.writeHead(500).end();
			}
		});
	});

	// 鍵はサブプロトコルで受け取る。返すサブプロトコルは鍵を含まない固定の名前にする
	const wss = new WebSocketServer({ noServer: true, maxPayload: 64 * 1024, handleProtocols: protocols => protocols.has(WS_PROTOCOL) ? WS_PROTOCOL : false });
	server.on('upgrade', (req, socket, head) => {
		const url = new URL(req.url ?? '/', 'http://localhost');
		if (url.pathname !== '/api/events') {
			return; // Vite の HMR など、ほかの口に任せる
		}
		if (!hostOk(req) || !originOk(req) || !authed(req)) {
			socket.write('HTTP/1.1 403 Forbidden\r\n\r\n');
			socket.destroy();
			return;
		}
		wss.handleUpgrade(req, socket, head, ws => {
			sockets.add(ws);
			ws.on('close', () => sockets.delete(ws));
			ws.send(JSON.stringify({ type: 'snapshot', snapshot: snapshot() } satisfies TaskBoardServerMessage));
		});
	});

	await new Promise<void>((resolve, reject) => {
		server.once('error', reject);
		server.listen(port, '127.0.0.1', () => resolve());
	});
	port = (server.address() as { port: number }).port;
	const address = `http://127.0.0.1:${port}/?token=${token}`;
	if (args.embedded) {
		// 鍵付きの URL は出さない（Para Code のログに残る）。開くのは Para Code のウィンドウ
		tellParent({ type: 'ready', port, repo: repoPath });
		log(`listening on 127.0.0.1:${port} (${store.directory})`);
	} else {
		console.log(`\n  タスクボード: ${address}\n  台帳: ${store.directory}${realWorkspaces ? '\n  作業場所: 実際に git を操作します' : ''}\n`);
	}
	if (args.open && !restart && !args.embedded) {
		execFile(process.platform === 'darwin' ? 'open' : 'xdg-open', [address]);
	}

	if (sync) {
		void sync.start();
	}
	paraAgents?.start();
	// SSH のボードは、手元のリポジトリの切り替えの一覧に入れない
	if (repoPath && !relay) {
		void rememberRepository(repoPath, remote ? `${remote.owner}/${remote.repo}` : path.basename(repoPath)).catch(() => undefined);
	}

	let closing = false;
	/** 止める。`switchTo` を渡すと、同じプロセスの中で、同じポートと鍵のままそのリポジトリを開き直す。 */
	const shutdown = async (switchTo?: string) => {
		if (closing) {
			return;
		}
		closing = true;
		// エンジンが外へ働きかける口（タイマー・作業場所・エージェント・コマンド）をすべて止める
		for (const timer of timers) {
			clearInterval(timer);
		}
		sync?.dispose();
		sim.dispose();
		paraAgents?.dispose();
		commandRunner?.dispose();
		await gitWorkspaces?.stop();
		store.scheduleSave(() => engine.serialize());
		await store.close();
		for (const socket of sockets) {
			socket.terminate();
		}
		await Promise.race([vite?.close(), new Promise(resolve => setTimeout(resolve, 3000))]);
		// 開き直すときは同じポートを使うので、受け付けが閉じるまで待つ（残った接続は待たずに切る）
		await Promise.race([new Promise<void>(resolve => server.close(() => resolve())), new Promise(resolve => setTimeout(resolve, 3000))]);
		server.closeAllConnections();
		if (switchTo) {
			// 以前は子プロセスで開き直し、親が残っていた（切り替えるたびに入れ子が 1 つ増えた）。同じプロセスで開き直す
			process.off('SIGINT', onSignal);
			process.off('SIGTERM', onSignal);
			log(`${switchTo} で開き直します`);
			// 開き直せなければ終わる。途中まで起動したもの（エンジン・作業場所・タイマー）を残したまま元のリポジトリで
			// 開き直すと、2 つのエンジンが同じ作業場所を使いうる
			main({ repo: switchTo, token, port }).catch(err => {
				console.error(`[taskboard] failed to reopen ${switchTo}:`, err);
				process.exit(1);
			});
			return;
		}
		process.exit(0);
	};
	const onSignal = () => closing ? process.exit(0) : void shutdown();
	process.on('SIGINT', onSignal);
	process.on('SIGTERM', onSignal);
	stopCurrent = onSignal;
}

async function start(): Promise<void> {
	if (args.embedded) {
		if (!process.send) {
			throw new Error('--embedded needs an IPC channel to Para Code');
		}
		// Para Code が落ちた・閉じた（IPC が切れた）ら止まる。リポジトリを切り替えている途中でも効くよう、ここで一度だけ付ける
		process.once('disconnect', () => stopCurrent ? stopCurrent() : process.exit(0));
		({ token: embeddedToken, boardKey: embeddedBoardKey, remote: embeddedRemote } = await receiveEmbeddedToken());
		if (args.remote && !embeddedRemote) {
			throw new Error('--remote needs the relay session from Para Code');
		}
		currentRelaySessionId = embeddedRemote?.sessionId;
		process.on('message', (message: unknown) => {
			const { type, sessionId } = (message ?? {}) as { type?: unknown; sessionId?: unknown };
			if (type === 'relay-session' && typeof sessionId === 'string' && /^[A-Za-z0-9_-]{16,128}$/.test(sessionId)) {
				currentRelaySessionId = sessionId;
				currentRelay?.setSession(sessionId);
			}
		});
	}
	await main();
}

start().catch(err => {
	console.error('[taskboard] failed to start:', err instanceof StoreBusyError ? err.message : err);
	// 送り終えてから終わる（Windows のパイプは非同期で、すぐ終わると返事が届かない）
	tellParent(err instanceof StoreBusyError
		? { type: 'failed', reason: 'busy', message: err.message }
		: { type: 'failed', reason: 'error', message: err instanceof Error ? err.message : String(err) }, () => process.exit(1));
});
