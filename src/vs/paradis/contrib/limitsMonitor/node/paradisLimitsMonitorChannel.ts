/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-PATCH/PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

// AIリミットモニターのshared processバックエンド（Codex の分）。
//
// Claude の分は、手元のウィンドウでは paradisClaudeAccountService.ts（別チャネル、手元の shared process）が
// 持つ。以前は claude-swap (cswap) を呼んでいたが撤去した。このチャネルの getSnapshot は Claude を
// 空で返し、レンダラー側のクライアントが Claude の結果を差し込む。SSH のウィンドウでは、REH に生やした
// このチャネルの getClaudeHostState（paradisClaudeHostUsage.ts、読み取り専用）が接続先のログインの分を返す。
//
// データ取得(getSnapshot):
//   - Codex: ~/.codex / ~/.codex-* 各ホームについて、Orca（codex-fetcher.ts）と同じく
//     `CODEX_HOME=<home> codex -s read-only -a never app-server` (JSON-RPC over stdio) の
//     `account/rateLimits/read` から先に取る。トークンリフレッシュとauth.json書き戻しはcodex CLI自身に
//     任せる(このプロセスがauth.jsonへ書き込むことは決してない)。RPC が認証切れ以外で失敗したときは
//     auth.json の access token で `GET https://chatgpt.com/backend-api/wham/usage` を直叩きする
//
// アカウント追加(startCodexLogin):
//   - Codex: 空き番号の新ホーム(~/.codex-N)をmkdir(EEXISTなら次の番号、既存ディレクトリは
//     決して再利用・上書きしない)し、`CODEX_HOME=<新ホーム> codex login` を起動。ブラウザで
//     ログインが完了するとcodexがauth.jsonを書いてexitする

import * as cp from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import { timeout } from '../../../../base/common/async.js';
import { Event } from '../../../../base/common/event.js';
import { IDisposable } from '../../../../base/common/lifecycle.js';
import * as path from '../../../../base/common/path.js';
import { generateUuid } from '../../../../base/common/uuid.js';
import { IPCServer, IServerChannel } from '../../../../base/parts/ipc/common/ipc.js';
import { IConfigurationService } from '../../../../platform/configuration/common/configuration.js';
import { IParadisTrackedChildProcess, ParadisChildProcessTreeTracker, paradisKillChildProcessTree } from '../../../node/paradisKillChildProcess.js';
import { NativeParsedArgs } from '../../../../platform/environment/common/argv.js';
import { ILogService } from '../../../../platform/log/common/log.js';
import { createParadisShellEnvResolver, ParadisCachedShellEnv } from '../../../../platform/shell/node/paradisCachedShellEnv.js';
import { reportParadisDiagnosticError, reportParadisShellEnvDiagnosticError } from '../../sentry/common/paradisSentryDiagnostics.js';
import { paradisWrapWindowsScriptShim } from '../../../common/paradisWindowsScriptShim.js';
import { paradisResolveAgentCli } from '../../../node/paradisAgentCli.js';
import { paradisIsCodexAuthError, paradisStartCodexAppServerRpc } from '../../../node/paradisCodexAppServerRpc.js';
import { paradisNormalizeCodexHomePath, paradisNotifyCodexHomesChanged } from '../../agentBrowser/node/paradisAgentHome.js';
import {
	IParadisLimitsAccount,
	IParadisLimitsCodexRemovalTarget,
	IParadisLimitsFetchOptions,
	IParadisLimitsProviderSnapshot,
	IParadisLimitsSetupHandle,
	IParadisLimitsSetupState,
	IParadisLimitsSnapshot,
	IParadisLimitsWindow,
	PARADIS_LIMITS_MONITOR_CHANNEL,
	ParadisLimitsDuplicateDecision,
	paradisNormalizeCodexLimitWindows
} from '../common/paradisLimitsMonitor.js';
import { IParadisClaudeStateRequest, PARADIS_CLAUDE_HOST_STATE_COMMAND } from '../common/paradisClaudeAccounts.js';
import { ParadisClaudeHostUsage } from './paradisClaudeHostUsage.js';
import { ParadisClaudeOAuthClient } from './paradisClaudeOAuthClient.js';

/**
 * スナップショットのTTL。ウィジェット表示中(30秒ポーリング)・非表示中(120秒ポーリング)の
 * いずれもTTL内の要求はキャッシュで応答されるため、実取得は最短でも約2.5分に1回になる。
 * リミットの変化は緩やかなので十分で、手動更新(bypassCache)は常に実取得する。
 */
const SNAPSHOT_CACHE_TTL_MS = 150_000;
/** wham/usage HTTPタイムアウト。 */
const USAGE_HTTP_TIMEOUT_MS = 30_000;
/** app-server RPCのリクエストタイムアウト（初期化は paradisCodexAppServerRpc.ts 側の15秒）。 */
const RPC_REQUEST_TIMEOUT_MS = 10_000;
/** RPCが失敗したホームの再試行抑止時間(毎ポーリングでcodexを起動しないため)。 */
const RPC_FAILURE_COOLDOWN_MS = 10 * 60_000;
/** 同じホームで RPC を起こす最短の間隔（Orca の MIN_REFETCH_MS）。その間は wham/usage で読む。 */
const MIN_RPC_INTERVAL_MS = 5 * 60_000;
/** ホームをまたいで RPC を起こすときの間隔（Orca の INACTIVE_CODEX_PROBE_STAGGER_MS）。 */
const RPC_STAGGER_MS = 2_000;
/** ログイン/セットアップセッションの完了までの制限時間。 */
const SETUP_TIMEOUT_MS = 10 * 60_000;
/** 完了/失敗したセットアップセッションを保持する時間(rendererの最終ポーリング用)。 */
const SETUP_RETENTION_MS = 5 * 60_000;
/** 追加先Codexホームの番号探索の上限。 */
const MAX_CODEX_HOME_INDEX = 20;

/**
 * 再ログインでしか解決しない失敗か。この種の失敗はユーザーが対処するまで毎ポーリングで再発し、
 * かつパネル上に復帰導線（「再ログイン…」ボタン）が出ているので、Sentryへは報告しない。
 */
/**
 * Sentryへ載せる失敗種別。文言は全てこのファイルが組み立てる固定文字列由来なので、
 * 種別だけを送ればパス・トークン・レスポンス本文を含まない。
 */
export type ParadisCodexRpcFailureKind = 'auth' | 'binary-missing' | 'spawn-failed' | 'exited' | 'init-timeout' | 'request-timeout' | 'rpc-error' | 'unknown';

/** codex app-server との RPC（paradisCodexAppServerRpc.ts）が投げるエラー文言をSentry用の種別に分類する。 */
export function classifyCodexRpcFailure(error: unknown): ParadisCodexRpcFailureKind {
	if (isCodexAuthFailure(error)) {
		return 'auth';
	}
	const message = error instanceof Error ? error.message : String(error ?? '');
	if (message.startsWith('codex not found')) {
		return 'binary-missing';
	}
	if (message.startsWith('failed to launch codex app-server')) {
		return 'spawn-failed';
	}
	if (message.startsWith('codex app-server exited')) {
		return 'exited';
	}
	if (/request 'initialize' timed out$/.test(message)) {
		return 'init-timeout';
	}
	if (/ timed out$/.test(message)) {
		return 'request-timeout';
	}
	if (message.startsWith('failed to fetch codex')) {
		return 'rpc-error';
	}
	return 'unknown';
}

function isCodexAuthFailure(error: unknown): boolean {
	const httpStatus = (error as { httpStatus?: number } | undefined)?.httpStatus;
	if (httpStatus === 401 || httpStatus === 403) {
		return true;
	}
	// 数字では判定しない。RPCのエラー文にはリクエストIDや所要msが混ざるので、`401` 単独で
	// 拾うと本物の障害まで無言で握りつぶす。認証を指す語が出ていることを条件にする（Orca と同じ一覧）。
	return paradisIsCodexAuthError(error);
}

// ---------- wham/usage レスポンス型(CodexBar CodexOAuthUsageFetcher.swift と同じマッピング) ----------

export interface IWhamWindow {
	readonly used_percent?: number;
	/** epoch秒。 */
	readonly reset_at?: number;
	readonly limit_window_seconds?: number;
}

export interface IWhamRateLimit {
	readonly primary_window?: IWhamWindow | null;
	readonly secondary_window?: IWhamWindow | null;
}

export interface IWhamUsageResponse {
	readonly plan_type?: string;
	readonly rate_limit?: IWhamRateLimit | null;
	readonly additional_rate_limits?: readonly { readonly limit_name?: string; readonly rate_limit?: IWhamRateLimit | null }[];
}

// ---------- codex app-server RPC レスポンス型 ----------

interface IRpcRateLimitWindow {
	readonly usedPercent?: number;
	readonly windowDurationMins?: number;
	/** epoch秒。 */
	readonly resetsAt?: number;
}

interface IRpcRateLimitsResult {
	readonly rateLimits?: {
		readonly primary?: IRpcRateLimitWindow | null;
		readonly secondary?: IRpcRateLimitWindow | null;
		readonly planType?: string;
	} | null;
}

interface IRpcAccountResult {
	readonly account?: { readonly type?: string; readonly email?: string; readonly planType?: string };
}

interface ICodexAuthJson {
	readonly tokens?: {
		readonly id_token?: string;
		readonly access_token?: string;
		readonly account_id?: string;
	};
}

export interface ICodexAccountResult {
	readonly account: IParadisLimitsAccount;
	/** rendererへは返さず、shared process内の重複判定だけに使う。 */
	readonly accountId?: string;
}

interface ISetupSession {
	readonly id: string;
	state: IParadisLimitsSetupState;
	/** Codex新規追加時に作成したホーム。重複確認の解決時だけ使う。 */
	codexHomePath?: string;
	/** 重複判定へ含める設定由来の追加Codexホーム。 */
	codexExtraHomes?: readonly string[];
	/** セッション終了時の後始末(子プロセスkill等)。 */
	dispose(): void;
}

export class ParadisLimitsMonitorService {

	private snapshotCache: { at: number; key: string; value: IParadisLimitsSnapshot } | undefined;
	private inflight: Promise<IParadisLimitsSnapshot> | undefined;
	private inflightKey: string | undefined;
	/** RPCフォールバックまで失敗したCodexホーム → 失敗時刻(クールダウン用)。 */
	private readonly rpcFailureAt = new Map<string, number>();
	/** RPC が認証切れと答えたホームと、そのときの auth.json（ログインし直したら試し直す）。 */
	private readonly rpcAuthFailure = new Map<string, { readonly at: number; readonly authStamp: string | undefined }>();
	/** ホームごとに最後に RPC を起こした時刻。 */
	private readonly lastRpcAt = new Map<string, number>();
	/** RPC をホームをまたいで1つずつ流す列と、最後の RPC が終わった時刻。 */
	private rpcQueue: Promise<void> = Promise.resolve();
	private lastRpcEndAt = 0;
	/**
	 * Sentryへ報告済みのCodexホーム。クールダウン明けごとに同じ失敗が再発するため
	 * (2026-08〜09に1台から90日で2,400件)、ホームごとにプロセス生存中1回だけ報告し、
	 * RPCが成功したら解除して次の失敗をまた1回だけ報告する。
	 */
	private readonly rpcFailureReported = new Set<string>();
	private readonly setupSessions = new Map<string, ISetupSession>();
	private readonly childProcesses: ParadisChildProcessTreeTracker;
	private disposed = false;
	/** 同時ログイン完了時の重複判定・確定を直列化する。 */
	private codexFinalizationQueue = Promise.resolve();
	private readonly cachedShellEnv: ParadisCachedShellEnv;

	constructor(
		private readonly logService: ILogService,
		// 接続先（REH）にはこのアプリの設定も起動引数も無い。どちらもシェル環境の解決にしか
		// 使わないので、無ければ既定の解決に任せる。
		configurationService?: IConfigurationService,
		args?: NativeParsedArgs,
		// Codex ホーム探索・削除のテストで実ホームディレクトリに触れずに済むようにするための注入点。
		// 本番は既定の os.homedir のまま。
		private readonly _homedir: () => string = os.homedir,
		private readonly _execFile: typeof cp.execFile = cp.execFile,
	) {
		this.childProcesses = new ParadisChildProcessTreeTracker(
			error => this.logService.trace('[ParadisLimitsMonitor] failed to stop child process: ' + error),
		);
		this.cachedShellEnv = new ParadisCachedShellEnv(
			logService,
			'ParadisLimitsMonitor',
			createParadisShellEnvResolver(logService, configurationService, args),
			Date.now,
			reportParadisShellEnvDiagnosticError,
		);
	}

	dispose(): void {
		this.disposed = true;
		this.childProcesses.dispose();
		for (const session of this.setupSessions.values()) {
			session.dispose();
		}
		this.setupSessions.clear();
	}

	private getExecEnv(): Promise<NodeJS.ProcessEnv> {
		return this.cachedShellEnv.getEnv();
	}

	// ---------- スナップショット取得 ----------

	async getSnapshot(options: IParadisLimitsFetchOptions): Promise<IParadisLimitsSnapshot> {
		const key = JSON.stringify(options.codexHomes ?? []);
		if (!options.bypassCache && this.snapshotCache && this.snapshotCache.key === key && Date.now() - this.snapshotCache.at < SNAPSHOT_CACHE_TTL_MS) {
			return this.snapshotCache.value;
		}
		if (this.inflight && this.inflightKey === key) {
			return this.inflight;
		}
		const promise = this.doGetSnapshot(options)
			.then(value => {
				this.snapshotCache = { at: Date.now(), key, value };
				return value;
			})
			.finally(() => {
				if (this.inflight === promise) {
					this.inflight = undefined;
					this.inflightKey = undefined;
				}
			});
		this.inflight = promise;
		this.inflightKey = key;
		return promise;
	}

	private async doGetSnapshot(options: IParadisLimitsFetchOptions): Promise<IParadisLimitsSnapshot> {
		const codex = await this.fetchCodexAccounts(options.codexHomes);
		// Claude はレンダラー側で paradisClaudeAccounts チャネルの結果を差し込む。
		return { claude: { accounts: [] }, codex, fetchedAt: Date.now() };
	}

	// ---------- Codex (auth.json + wham/usage) ----------

	private async fetchCodexAccounts(extraHomes: readonly string[] | undefined): Promise<IParadisLimitsProviderSnapshot> {
		const homes = await this.discoverCodexHomes(extraHomes);
		if (homes.length === 0) {
			return { accounts: [], sourceError: 'no Codex homes with auth.json found' };
		}
		const results = await Promise.all(homes.map(home => this.fetchCodexAccount(home)));
		const accounts = results.map((result, index) => {
			if (!result.accountId) {
				return result.account;
			}
			const duplicateHomeLabels = results
				.filter((other, otherIndex) => otherIndex !== index && other.accountId === result.accountId)
				.map(other => other.account.homeLabel)
				.filter(homeLabel => homeLabel !== undefined);
			return duplicateHomeLabels.length > 0
				? { ...result.account, duplicateHomeLabels }
				: result.account;
		});
		return { accounts };
	}

	private async discoverCodexHomes(extraHomes: readonly string[] | undefined): Promise<string[]> {
		const homes = new Set<string>();
		const home = this._homedir();
		let entries: string[] = [];
		try {
			entries = await fs.promises.readdir(home);
		} catch {
			// ホーム走査不能でも設定分は試す
		}
		for (const entry of entries) {
			if (/^\.codex(-[\w.]+)?$/.test(entry)) {
				homes.add(path.join(home, entry));
			}
		}
		if (process.env['CODEX_HOME']) {
			homes.add(process.env['CODEX_HOME']);
		}
		for (const extra of extraHomes ?? []) {
			// 切替（codexAccounts）と同じ正規化を通し、同じホームを同じ id（絶対パス）で扱う。
			const normalized = paradisNormalizeCodexHomePath(extra, home);
			if (normalized !== undefined) {
				homes.add(normalized);
			}
		}
		const result: string[] = [];
		for (const candidate of homes) {
			if (await this.fileExists(path.join(candidate, 'auth.json'))) {
				result.push(candidate);
			}
		}
		result.sort();
		return result;
	}

	private codexHomeLabel(homePath: string): string {
		const home = this._homedir();
		return homePath.startsWith(home) ? `~${homePath.slice(home.length)}` : homePath;
	}

	private async isRemovableCodexHome(homePath: string): Promise<boolean> {
		try {
			const resolvedHome = path.resolve(this._homedir());
			const resolvedCandidate = path.resolve(homePath);
			if (path.dirname(resolvedCandidate) !== resolvedHome) {
				return false;
			}
			const match = /^\.codex-(\d+)$/.exec(path.basename(resolvedCandidate));
			const index = match ? Number(match[1]) : NaN;
			if (!match || !Number.isSafeInteger(index) || index < 2 || String(index) !== match[1]) {
				return false;
			}
			const stat = await fs.promises.lstat(resolvedCandidate);
			return stat.isDirectory()
				&& !stat.isSymbolicLink()
				&& await this.fileExists(path.join(resolvedCandidate, 'auth.json'));
		} catch {
			return false;
		}
	}

	async validateCodexHomeRemoval(homePath: string): Promise<IParadisLimitsCodexRemovalTarget> {
		if (typeof homePath !== 'string' || homePath.length === 0 || homePath.length > 4096 || !path.isAbsolute(homePath)) {
			throw new Error('invalid Codex home path');
		}
		const resolved = path.resolve(homePath);
		const knownHomes = await this.discoverCodexHomes(undefined);
		if (!knownHomes.includes(resolved) || !await this.isRemovableCodexHome(resolved)) {
			throw new Error('Codex home is not removable');
		}
		return { homePath: resolved };
	}

	/**
	 * 検証済みの Codex ホームを、このチャネルを提供しているマシン側で完全に削除する。
	 *
	 * 検証と削除を同じプロセス（=同じマシン）で完結させるのが要点。renderer 側で
	 * 「検証は routed channel（SSH 中はリモート）、削除は URI.file() + fileService.del（常に
	 * ローカル）」と分離すると、絶対パスが一致した別マシンのディレクトリを手元のゴミ箱へ
	 * 移動してしまう（データ消失）。
	 *
	 * ゴミ箱への移動は Electron main プロセスの機能のため REH からは使えない（upstream も
	 * リモートの削除は永久削除）。対象は ~/.codex-2 以降の検証済みホームのみであり、
	 * 既定の ~/.codex は決して消えない。
	 */
	async removeCodexHome(homePath: string): Promise<void> {
		const resolved = (await this.validateCodexHomeRemoval(homePath)).homePath;
		await fs.promises.rm(resolved, { recursive: true });
		// 選ばれていたホームなら、Codex の切替（codexAccounts）が既定のホームへ戻す。
		paradisNotifyCodexHomesChanged();
	}

	private async readCodexIdentity(homePath: string): Promise<{ accountId?: string; email?: string }> {
		try {
			const auth = JSON.parse(await fs.promises.readFile(path.join(homePath, 'auth.json'), 'utf8')) as ICodexAuthJson;
			const rawAccountId = auth.tokens?.account_id;
			return {
				accountId: typeof rawAccountId === 'string' && rawAccountId.trim().length > 0 ? rawAccountId.trim() : undefined,
				email: this.emailFromIdToken(auth.tokens?.id_token),
			};
		} catch {
			return {};
		}
	}

	private async findDuplicateCodexHomeLabels(homePath: string, accountId: string | undefined, extraHomes: readonly string[] | undefined): Promise<string[]> {
		if (!accountId) {
			return [];
		}
		const homes = (await this.discoverCodexHomes(extraHomes)).filter(home => home !== homePath);
		const identities = await Promise.all(homes.map(async home => ({ home, identity: await this.readCodexIdentity(home) })));
		return identities
			.filter(candidate => candidate.identity.accountId === accountId)
			.map(candidate => this.codexHomeLabel(candidate.home));
	}

	private async finalizeCodexLogin(session: ISetupSession, homePath: string, isNewHome: boolean): Promise<void> {
		const previous = this.codexFinalizationQueue;
		let releaseQueue: () => void = () => { };
		this.codexFinalizationQueue = new Promise<void>(resolve => { releaseQueue = resolve; });
		await previous;
		try {
			const identity = await this.readCodexIdentity(homePath);
			if (isNewHome) {
				const duplicateHomeLabels = await this.findDuplicateCodexHomeLabels(homePath, identity.accountId, session.codexExtraHomes);
				if (duplicateHomeLabels.length > 0) {
					session.codexHomePath = homePath;
					session.state = {
						...session.state,
						phase: 'waiting_duplicate',
						email: identity.email,
						homePath,
						duplicateHomeLabels,
					};
					return;
				}
			}
			this.snapshotCache = undefined;
			this.rpcFailureAt.delete(homePath);
			this.rpcFailureReported.delete(homePath);
			session.state = { ...session.state, phase: 'done', email: identity.email };
			// Codex の切替（codexAccounts）へ、ログインが終わったホームを知らせる。
			paradisNotifyCodexHomesChanged();
			this.scheduleSetupCleanup(session);
		} finally {
			releaseQueue();
		}
	}

	protected async fetchCodexAccount(homePath: string): Promise<ICodexAccountResult> {
		const base: { provider: 'codex'; id: string; homeLabel: string; removable: boolean } = {
			provider: 'codex',
			id: homePath,
			homeLabel: this.codexHomeLabel(homePath),
			removable: await this.isRemovableCodexHome(homePath),
		};
		let auth: ICodexAuthJson;
		try {
			auth = JSON.parse(await fs.promises.readFile(path.join(homePath, 'auth.json'), 'utf8')) as ICodexAuthJson;
		} catch (error) {
			return { account: { ...base, status: 'error', statusDetail: `failed to read auth.json: ${(error as Error).message}` } };
		}
		const rawAccountId = auth.tokens?.account_id;
		const accountId = typeof rawAccountId === 'string' && rawAccountId.trim().length > 0 ? rawAccountId.trim() : undefined;
		const accessToken = auth.tokens?.access_token;
		if (!accessToken) {
			return { account: { ...base, status: 'no_credentials', statusDetail: 'auth.json has no access token' }, accountId };
		}
		const email = this.emailFromIdToken(auth.tokens?.id_token);

		// Orca（codex-fetcher.ts）と同じく、`codex app-server` の RPC から先に取る。トークンの更新と
		// auth.json の書き戻しは codex 自身がする。RPC で取れないときだけ wham/usage を使う。
		// 画面を読む方式（PTY の /status）は使わない。app-server を起こしすぎないよう、次の抑えを入れる
		// （Orca と同じ考え方）:
		// - 同じホームの RPC は最短 5 分おき（Orca の MIN_REFETCH_MS）。その間は wham/usage（HTTP だけ）で読む
		// - 認証切れ以外で失敗したホームは 10 分間 RPC を飛ばす
		// - 認証切れのホームは、10 分たつか auth.json が変わる（ログインし直した）まで RPC を飛ばす
		// - RPC はホームをまたいで1つずつ、2 秒ずつずらして起こす（Orca の INACTIVE_CODEX_PROBE_STAGGER_MS）
		const now = this.now();
		const authStamp = await this.authStamp(homePath);
		const authBackoff = this.rpcAuthFailure.get(homePath);
		const inAuthBackoff = authBackoff !== undefined && now - authBackoff.at < RPC_FAILURE_COOLDOWN_MS && authBackoff.authStamp === authStamp;
		const lastFailure = this.rpcFailureAt.get(homePath);
		const inFailureCooldown = lastFailure !== undefined && now - lastFailure < RPC_FAILURE_COOLDOWN_MS;
		const lastRpc = this.lastRpcAt.get(homePath);
		const dueForRpc = lastRpc === undefined || now - lastRpc >= MIN_RPC_INTERVAL_MS;

		let rpcTried = false;
		if (!inAuthBackoff && !inFailureCooldown && dueForRpc) {
			rpcTried = true;
			const viaRpc = await this.tryCodexRpc(homePath, base.homeLabel);
			if (viaRpc.kind !== 'failed') {
				return this.rpcResult(viaRpc, homePath, base, email, accountId);
			}
		}

		try {
			const usage = await this.fetchWhamUsage(accessToken, accountId);
			return { account: { ...base, email, ...this.mapWhamUsage(usage), status: 'ok' }, accountId };
		} catch (error) {
			const httpStatus = (error as { httpStatus?: number }).httpStatus;
			if (httpStatus !== 401 && httpStatus !== 403) {
				return { account: { ...base, email, status: 'error', statusDetail: (error as Error).message }, accountId };
			}
			if (inAuthBackoff) {
				// codex もさっき認証切れと答えた。ログインし直すまで直らない。
				return { account: { ...base, email, status: 'relogin_required', statusDetail: 'access token expired (re-login required)' }, accountId };
			}
			if (!rpcTried && !inFailureCooldown) {
				// アクセストークンの期限が切れただけかもしれない。間隔を待たずに codex に更新させる。
				const viaRpc = await this.tryCodexRpc(homePath, base.homeLabel);
				if (viaRpc.kind !== 'failed') {
					return this.rpcResult(viaRpc, homePath, base, email, accountId);
				}
			}
			// codex で更新できない（app-server が動かない）。再ログインで直るとは限らないので、要再ログインにはしない。
			return { account: { ...base, email, status: 'error', statusDetail: 'access token expired and codex app-server is unavailable to refresh it' }, accountId };
		}
	}

	/** auth.json の更新時刻と大きさ（ログインし直したかの判断に使う）。 */
	private async authStamp(homePath: string): Promise<string | undefined> {
		try {
			const stat = await fs.promises.stat(path.join(homePath, 'auth.json'));
			return `${stat.mtimeMs}:${stat.size}`;
		} catch {
			return undefined;
		}
	}

	/** RPC で取る。ホームをまたいで1つずつ、前の RPC から 2 秒あけて起こす。 */
	private async tryCodexRpc(homePath: string, homeLabel: string | undefined): Promise<{ kind: 'ok'; value: Awaited<ReturnType<ParadisLimitsMonitorService['fetchCodexAccountViaRpc']>> } | { kind: 'auth'; error: Error } | { kind: 'failed' }> {
		const run = async () => {
			const wait = this.lastRpcEndAt + RPC_STAGGER_MS - this.now();
			if (wait > 0) {
				await this.delay(wait);
			}
			this.lastRpcAt.set(homePath, this.now());
			try {
				return await this.fetchCodexAccountViaRpc(homePath);
			} finally {
				this.lastRpcEndAt = this.now();
			}
		};
		const queued = this.rpcQueue.then(run, run);
		this.rpcQueue = queued.then(() => undefined, () => undefined);
		try {
			const value = await queued;
			this.rpcFailureAt.delete(homePath);
			this.rpcFailureReported.delete(homePath);
			this.rpcAuthFailure.delete(homePath);
			return { kind: 'ok', value };
		} catch (error) {
			if (isCodexAuthFailure(error)) {
				// 認証切れは再ログインでしか直らない（Orca も PTY へは落ちずにそのまま返す）。
				this.rpcAuthFailure.set(homePath, { at: this.now(), authStamp: await this.authStamp(homePath) });
				return { kind: 'auth', error: error as Error };
			}
			this.rpcFailureAt.set(homePath, this.now());
			const kind = classifyCodexRpcFailure(error);
			// codex を入れていない人は毎回同じ理由で失敗するので報告しない（パネルは wham/usage で出せる）。
			if (kind !== 'binary-missing' && !this.rpcFailureReported.has(homePath)) {
				this.rpcFailureReported.add(homePath);
				const { exitCode, exitSignal } = error as { exitCode?: number | null; exitSignal?: string | null };
				reportParadisDiagnosticError('owned', 'limits-monitor', 'codex-app-server-fallback', error, {
					phase: 'refresh',
					transport: 'stdio',
					safe_error_kind: kind,
					...(typeof exitCode === 'number' ? { safe_exit_code: exitCode } : {}),
					...(typeof exitSignal === 'string' ? { signal: exitSignal } : {}),
				});
			}
			this.logService.warn(`[ParadisLimitsMonitor] codex app-server failed for ${homeLabel}; reading wham/usage instead: ${(error as Error).message}`);
			return { kind: 'failed' };
		}
	}

	private async rpcResult(viaRpc: { kind: 'ok'; value: Awaited<ReturnType<ParadisLimitsMonitorService['fetchCodexAccountViaRpc']>> } | { kind: 'auth'; error: Error }, homePath: string, base: { provider: 'codex'; id: string; homeLabel: string; removable: boolean }, email: string | undefined, accountId: string | undefined): Promise<ICodexAccountResult> {
		if (viaRpc.kind === 'auth') {
			// パネルは status='relogin_required' を受けて「再ログイン…」を出す（paradisLimitsMonitorPanel.ts）。
			return { account: { ...base, email, status: 'relogin_required', statusDetail: viaRpc.error.message }, accountId };
		}
		// codex が RPC の中でトークンを更新していることがあるので、足す分は読み直したトークンで読む。
		const fresh = await this.readAuthTokens(homePath);
		const windows = fresh.accessToken !== undefined
			? await this.supplementRpcWindows(viaRpc.value, fresh.accessToken, fresh.accountId ?? accountId)
			: { planType: viaRpc.value.planType, fiveHour: viaRpc.value.windows.fiveHour, sevenDay: viaRpc.value.windows.sevenDay };
		return { account: { ...base, email: viaRpc.value.email ?? email, ...windows, status: 'ok' }, accountId };
	}

	private async readAuthTokens(homePath: string): Promise<{ accessToken?: string; accountId?: string }> {
		try {
			const auth = JSON.parse(await fs.promises.readFile(path.join(homePath, 'auth.json'), 'utf8')) as ICodexAuthJson;
			const rawAccountId = auth.tokens?.account_id;
			return {
				accessToken: typeof auth.tokens?.access_token === 'string' && auth.tokens.access_token.length > 0 ? auth.tokens.access_token : undefined,
				accountId: typeof rawAccountId === 'string' && rawAccountId.trim().length > 0 ? rawAccountId.trim() : undefined,
			};
		} catch {
			return {};
		}
	}

	/** 時刻（テストで差し替える）。 */
	protected now(): number {
		return Date.now();
	}

	/** 待つ（テストで差し替える）。 */
	protected delay(ms: number): Promise<void> {
		return timeout(ms);
	}

	/**
	 * RPC の結果に、wham/usage の分を足す（取れなければ RPC の結果のまま）。Orca の
	 * supplementCodexSessionWindow と同じく、5時間の枠が無く週の枠だけのときは wham/usage の枠で埋める。
	 * RPC は追加の枠（`additional_rate_limits`）を返さないので、Para Code が出しているその枠も
	 * wham/usage から足す（Orca は追加の枠を出さないので、ここだけ Para Code の独自）。
	 */
	private async supplementRpcWindows(viaRpc: { planType?: string; windows: { fiveHour?: IParadisLimitsWindow; sevenDay?: IParadisLimitsWindow } }, accessToken: string, accountId: string | undefined): Promise<{ planType?: string; fiveHour?: IParadisLimitsWindow; sevenDay?: IParadisLimitsWindow; scoped?: IParadisLimitsWindow[] }> {
		const fromRpc = { planType: viaRpc.planType, fiveHour: viaRpc.windows.fiveHour, sevenDay: viaRpc.windows.sevenDay };
		let usage: ReturnType<ParadisLimitsMonitorService['mapWhamUsage']>;
		try {
			usage = this.mapWhamUsage(await this.fetchWhamUsage(accessToken, accountId));
		} catch {
			return fromRpc;
		}
		const fillSession = fromRpc.fiveHour === undefined && fromRpc.sevenDay !== undefined && usage.fiveHour !== undefined;
		return {
			planType: fromRpc.planType ?? usage.planType,
			fiveHour: fillSession ? usage.fiveHour : fromRpc.fiveHour,
			sevenDay: fillSession ? usage.sevenDay ?? fromRpc.sevenDay : fromRpc.sevenDay,
			scoped: usage.scoped,
		};
	}

	/** id_token(JWT)のpayloadからemailを取り出す(署名検証はしない。表示用途のみ)。 */
	private emailFromIdToken(idToken: string | undefined): string | undefined {
		if (!idToken) {
			return undefined;
		}
		try {
			const payloadPart = idToken.split('.')[1];
			const payload = JSON.parse(Buffer.from(payloadPart, 'base64url').toString('utf8')) as Record<string, unknown>;
			if (typeof payload.email === 'string') {
				return payload.email;
			}
			const profile = payload['https://api.openai.com/profile'];
			if (profile && typeof (profile as Record<string, unknown>).email === 'string') {
				return (profile as Record<string, unknown>).email as string;
			}
		} catch {
			// 表示用の補助情報なので失敗は無視
		}
		return undefined;
	}

	protected async fetchWhamUsage(accessToken: string, accountId: string | undefined): Promise<IWhamUsageResponse> {
		const controller = new AbortController();
		const timer = setTimeout(() => controller.abort(), USAGE_HTTP_TIMEOUT_MS);
		try {
			const headers: Record<string, string> = {
				'Authorization': `Bearer ${accessToken}`,
				'Accept': 'application/json',
				'User-Agent': 'ParaCode-LimitsMonitor',
			};
			if (accountId) {
				headers['ChatGPT-Account-Id'] = accountId;
			}
			// トークンを chatgpt.com の外へ転送させない
			const response = await fetch('https://chatgpt.com/backend-api/wham/usage', { method: 'GET', headers, redirect: 'error', signal: controller.signal });
			if (!response.ok) {
				const error = new Error(`Codex usage API returned ${response.status}`) as Error & { httpStatus: number };
				error.httpStatus = response.status;
				throw error;
			}
			return await response.json() as IWhamUsageResponse;
		} finally {
			clearTimeout(timer);
		}
	}

	private mapWhamUsage(usage: IWhamUsageResponse): { planType?: string; fiveHour?: IParadisLimitsWindow; sevenDay?: IParadisLimitsWindow; scoped?: IParadisLimitsWindow[] } {
		const mapWindow = (window: IWhamWindow | null | undefined, label?: string): IParadisLimitsWindow | undefined => {
			if (typeof window?.used_percent !== 'number') {
				return undefined;
			}
			return {
				usedPercent: window.used_percent,
				resetsAt: typeof window.reset_at === 'number' ? window.reset_at * 1000 : undefined,
				label,
			};
		};
		const scoped: IParadisLimitsWindow[] = [];
		for (const additional of usage.additional_rate_limits ?? []) {
			const mapped = mapWindow(additional.rate_limit?.primary_window, additional.limit_name ?? 'extra');
			if (mapped) {
				scoped.push(mapped);
			}
		}
		const windows = paradisNormalizeCodexLimitWindows(
			usage.rate_limit?.primary_window,
			usage.rate_limit?.secondary_window,
			window => typeof window.limit_window_seconds === 'number' ? window.limit_window_seconds / 60 : undefined,
		);
		return {
			planType: usage.plan_type,
			fiveHour: mapWindow(windows.fiveHour),
			sevenDay: mapWindow(windows.sevenDay),
			scoped: scoped.length > 0 ? scoped : undefined,
		};
	}

	/** `codex app-server` (JSON-RPC over stdio) でrate limitsとアカウント情報を取得する。 */
	protected async fetchCodexAccountViaRpc(homePath: string): Promise<{ email?: string; planType?: string; windows: { fiveHour?: IParadisLimitsWindow; sevenDay?: IParadisLimitsWindow } }> {
		const command = await this.resolveCommand('codex', undefined);
		const env = { ...await this.getExecEnv(), CODEX_HOME: homePath };
		// initialize の失敗は開始関数の中で子プロセスを片付けてから投げる。
		const rpc = await paradisStartCodexAppServerRpc(command, env, this.logService, 'para-code-limits-monitor', { shortLivedProbe: true });
		try {
			const rateLimits = await rpc.request('account/rateLimits/read', undefined, RPC_REQUEST_TIMEOUT_MS) as IRpcRateLimitsResult;
			let account: IRpcAccountResult | undefined;
			try {
				// codex 0.154 は `params` 省略を `missing field 'params'` で拒否するので空オブジェクトを渡す
				account = await rpc.request('account/read', {}, RPC_REQUEST_TIMEOUT_MS) as IRpcAccountResult;
			} catch {
				// email/planは補助情報。rate limitsが取れていれば成立させる
			}
			const mapWindow = (window: IRpcRateLimitWindow | undefined): IParadisLimitsWindow | undefined => {
				if (typeof window?.usedPercent !== 'number') {
					return undefined;
				}
				return {
					usedPercent: window.usedPercent,
					resetsAt: typeof window.resetsAt === 'number' ? window.resetsAt * 1000 : undefined,
				};
			};
			const windows = paradisNormalizeCodexLimitWindows(
				rateLimits.rateLimits?.primary,
				rateLimits.rateLimits?.secondary,
				window => typeof window.windowDurationMins === 'number' ? window.windowDurationMins : undefined,
			);
			return {
				email: account?.account?.email,
				planType: account?.account?.planType ?? rateLimits.rateLimits?.planType,
				windows: {
					fiveHour: mapWindow(windows.fiveHour),
					sevenDay: mapWindow(windows.sevenDay),
				},
			};
		} finally {
			rpc.dispose();
		}
	}

	// ---------- アカウント追加: Codex ----------

	async startCodexLogin(existingHome: string | undefined, extraHomes: readonly string[] | undefined): Promise<IParadisLimitsSetupHandle> {
		const sessionId = generateUuid();
		const session: ISetupSession = {
			id: sessionId,
			state: { phase: 'starting' },
			codexExtraHomes: extraHomes,
			dispose: () => { },
		};
		this.setupSessions.set(sessionId, session);
		this.runCodexLogin(session, existingHome).catch(error => {
			session.state = { ...session.state, phase: 'error', error: (error as Error).message };
			this.scheduleSetupCleanup(session);
		});
		return { sessionId };
	}

	private async runCodexLogin(session: ISetupSession, existingHome: string | undefined): Promise<void> {
		let homePath: string;
		let createdHome = false;
		let copiedConfig = false;
		if (existingHome) {
			// 再ログイン: 既存ホームに対してcodex自身のloginを実行するだけ(ファイルは一切触らない)。
			// IPC経由の任意パスに対してcodexを起動しないよう、発見済みホームのみに制限する
			const knownHomes = await this.discoverCodexHomes(session.codexExtraHomes);
			if (!knownHomes.includes(existingHome)) {
				throw new Error(`not a recognized Codex home: ${existingHome}`);
			}
			homePath = existingHome;
		} else {
			homePath = await this.allocateCodexHome();
			createdHome = true;
			// モデル設定等を引き継ぐためconfig.tomlのみコピーする(auth.jsonは決してコピーしない)
			const defaultConfig = path.join(os.homedir(), '.codex', 'config.toml');
			if (await this.fileExists(defaultConfig)) {
				await fs.promises.copyFile(defaultConfig, path.join(homePath, 'config.toml'));
				copiedConfig = true;
			}
		}
		session.state = { phase: 'waiting_browser', homeLabel: this.codexHomeLabel(homePath) };

		const command = await this.resolveCommand('codex', undefined);
		const env = { ...await this.getExecEnv(), CODEX_HOME: homePath };
		// Windows で解決先が .cmd/.bat シムのときは cmd.exe 経由にラップする
		// (shell 指定なしの spawn は CVE-2024-27980 対策後の Node では EINVAL になる)。
		const shimInvocation = process.platform === 'win32' ? paradisWrapWindowsScriptShim(command, ['login']) : undefined;
		const child = cp.spawn(shimInvocation?.file ?? command, shimInvocation?.args ?? ['login'], {
			env,
			stdio: ['ignore', 'pipe', 'pipe'],
			windowsHide: true,
			windowsVerbatimArguments: shimInvocation !== undefined,
		});
		let output = '';
		const onData = (chunk: Buffer) => {
			output += chunk.toString('utf8');
			// チャンク境界でURLが途切れた状態を確定させないよう、蓄積出力から毎回抽出し直して更新する
			const url = /https:\/\/auth\.openai\.com[^\s"')]+/.exec(output)?.[0];
			if (url && url !== session.state.url && session.state.phase === 'waiting_browser') {
				session.state = { ...session.state, url };
			}
		};
		child.stdout?.on('data', onData);
		child.stderr?.on('data', onData);

		let cancelled = false;
		session.dispose = () => {
			cancelled = true;
			// cmd.exe ラップ時は kill() だと実体の codex が孫として残るためツリーごと落とす
			paradisKillChildProcessTree(child, error => this.logService.trace(`[ParadisLimitsMonitor] failed to stop 'codex login': ${error}`));
		};
		this.scheduleSetupTimeout(session);

		const exitCode = await new Promise<number | null>(resolve => {
			child.on('error', () => resolve(null));
			child.on('exit', code => resolve(code));
		});

		const loginSucceeded = exitCode === 0 && await this.fileExists(path.join(homePath, 'auth.json'));
		if (loginSucceeded) {
			await this.finalizeCodexLogin(session, homePath, createdHome);
			return;
		}

		// 失敗/キャンセル時: 自分が作った新ホームのみ後始末する(既存ホームは決して消さない)。
		// 消してよいのは自分が置いたconfig.tomlコピーだけで、他に何かができていたら残す
		if (createdHome && !(await this.fileExists(path.join(homePath, 'auth.json')))) {
			try {
				if (copiedConfig) {
					await fs.promises.rm(path.join(homePath, 'config.toml'), { force: true });
				}
				await fs.promises.rmdir(homePath);
			} catch {
				// 空でない(codexが何かを書いた)場合は残す
			}
		}
		if (!cancelled) {
			const detail = output.trim().split('\n').pop() ?? '';
			throw new Error(exitCode === null ? 'failed to launch codex login' : `codex login exited with code ${exitCode}${detail ? `: ${detail}` : ''}`);
		}
	}

	/**
	 * 追加アカウント用の新しいCodexホームを確保する。~/.codex-2 から順に走査し、
	 * mkdir(recursive無し)のEEXISTで存在検知することで、既存ディレクトリを決して
	 * 再利用・上書きしない(TOCTOUも排除)。
	 */
	private async allocateCodexHome(): Promise<string> {
		const home = os.homedir();
		for (let index = 2; index <= MAX_CODEX_HOME_INDEX; index++) {
			const candidate = path.join(home, `.codex-${index}`);
			try {
				// 会話ログや認証情報が入るので、同じ PC の別ユーザーから読めないようにする。
				await fs.promises.mkdir(candidate, { mode: 0o700 });
				return candidate;
			} catch (error) {
				if ((error as NodeJS.ErrnoException).code === 'EEXIST') {
					continue;
				}
				throw error;
			}
		}
		throw new Error(`no free Codex home slot up to ~/.codex-${MAX_CODEX_HOME_INDEX}`);
	}

	// ---------- セットアップセッション共通 ----------

	async resolveCodexDuplicate(sessionId: string, decision: ParadisLimitsDuplicateDecision): Promise<void> {
		if (decision !== 'keep' && decision !== 'discard') {
			throw new Error('invalid duplicate-account decision');
		}
		const session = this.setupSessions.get(sessionId);
		if (!session || session.state.phase !== 'waiting_duplicate' || !session.codexHomePath) {
			throw new Error('setup session is not waiting for a duplicate-account decision');
		}
		if (decision === 'discard' && await this.fileExists(session.codexHomePath)) {
			throw new Error('Codex home must be removed before discarding the duplicate account');
		}
		this.snapshotCache = undefined;
		this.rpcFailureAt.delete(session.codexHomePath);
		this.rpcFailureReported.delete(session.codexHomePath);
		session.codexHomePath = undefined;
		session.state = { ...session.state, phase: 'done' };
		paradisNotifyCodexHomesChanged();
		this.scheduleSetupCleanup(session);
	}

	getSetupState(sessionId: string): IParadisLimitsSetupState {
		const session = this.setupSessions.get(sessionId);
		if (!session) {
			return { phase: 'error', error: 'setup session not found' };
		}
		return session.state;
	}

	cancelSetup(sessionId: string): void {
		const session = this.setupSessions.get(sessionId);
		if (!session) {
			return;
		}
		session.dispose();
		if (session.state.phase !== 'done') {
			session.state = { ...session.state, phase: 'error', error: 'cancelled' };
		}
		this.setupSessions.delete(sessionId);
	}

	private scheduleSetupTimeout(session: ISetupSession): void {
		timeout(SETUP_TIMEOUT_MS).then(() => {
			if (this.setupSessions.get(session.id) === session && session.state.phase !== 'done' && session.state.phase !== 'error') {
				session.dispose();
				session.state = { ...session.state, phase: 'error', error: 'timed out' };
				this.scheduleSetupCleanup(session);
			}
		});
	}

	private scheduleSetupCleanup(session: ISetupSession): void {
		timeout(SETUP_RETENTION_MS).then(() => {
			if (this.setupSessions.get(session.id) === session) {
				this.setupSessions.delete(session.id);
			}
		});
	}

	// ---------- 実行ヘルパー ----------

	/**
	 * コマンドを解決する。優先順: 明示パス(絶対パス必須) → PATH → よくあるインストール先
	 * （候補の場所は paradisResolveAgentCli と共通）。PATH 上にあるかは `codex --version` が
	 * 通るかで確かめ、そのときはコマンド名のまま返す。
	 */
	private async resolveCommand(name: 'codex', explicitPath: string | undefined): Promise<string> {
		if (explicitPath) {
			if (!path.isAbsolute(explicitPath)) {
				throw new Error(`configured path for ${name} must be absolute: ${explicitPath}`);
			}
			return explicitPath;
		}
		const found = await paradisResolveAgentCli(name, {}, { isOnPath: candidate => this.canExecute(candidate), fileExists: candidate => this.fileExists(candidate) });
		if (found === undefined) {
			throw new Error(`${name} not found (install it or set the executable path in settings)`);
		}
		return found;
	}

	private async canExecute(command: string): Promise<boolean> {
		const env = await this.getExecEnv();
		if (this.disposed) {
			return false;
		}
		// .cmd シム候補も EINVAL ではなく実際の終了コードで判定できるよう、
		// 実行時と同じ cmd.exe ラップを通す。
		const shimInvocation = process.platform === 'win32' ? paradisWrapWindowsScriptShim(command, ['--version']) : undefined;
		return new Promise<boolean>(resolve => {
			const execution: { child?: cp.ChildProcess; tracked?: IParadisTrackedChildProcess; completed: boolean } = { completed: false };
			execution.child = this._execFile(shimInvocation?.file ?? command, shimInvocation?.args ?? ['--version'], { windowsHide: true, windowsVerbatimArguments: shimInvocation !== undefined, env }, err => {
				execution.completed = true;
				const timedOut = execution.tracked?.timedOut === true;
				execution.tracked?.dispose();
				resolve(!err && !timedOut);
			});
			if (!execution.completed && execution.child) {
				execution.tracked = this.childProcesses.track(execution.child, 10_000);
			}
		});
	}

	private fileExists(filePath: string): Promise<boolean> {
		return new Promise<boolean>(resolve => {
			fs.access(filePath, fs.constants.F_OK, err => resolve(!err));
		});
	}
}

// 接続先（REH）へも同じチャネルを生やすため context は型引数にしておく（中身では使わない）。
export class ParadisLimitsMonitorChannel<TContext = string> implements IServerChannel<TContext> {

	/**
	 * @param claudeHost 接続先（REH）の Claude のログインの使用量（読み取り専用）。REH にだけ渡す。
	 * shared process では渡さず、{@link PARADIS_CLAUDE_HOST_STATE_COMMAND} は「無い」と答える。
	 */
	constructor(private readonly service: ParadisLimitsMonitorService, private readonly claudeHost?: ParadisClaudeHostUsage) { }

	listen<T>(_ctx: TContext, event: string): Event<T> {
		throw new Error(`Event not found: ${event}`);
	}

	call<T>(_ctx: TContext, command: string, arg?: unknown): Promise<T> {
		const args = Array.isArray(arg) ? arg : [];
		switch (command) {
			case 'getSnapshot': return this.service.getSnapshot((args[0] ?? {}) as IParadisLimitsFetchOptions) as Promise<T>;
			case 'startCodexLogin': return this.service.startCodexLogin(
				typeof args[0] === 'string' ? args[0] : undefined,
				Array.isArray(args[1]) ? args[1].filter((entry): entry is string => typeof entry === 'string') : undefined,
			) as Promise<T>;
			case 'validateCodexHomeRemoval': return this.service.validateCodexHomeRemoval(typeof args[0] === 'string' ? args[0] : '') as Promise<T>;
			case 'removeCodexHome': return this.service.removeCodexHome(typeof args[0] === 'string' ? args[0] : '') as Promise<T>;
			case 'resolveCodexDuplicate': return this.service.resolveCodexDuplicate(String(args[0]), args[1] as ParadisLimitsDuplicateDecision) as Promise<T>;
			case 'getSetupState': return Promise.resolve(this.service.getSetupState(String(args[0]))) as Promise<T>;
			case 'cancelSetup': return Promise.resolve(this.service.cancelSetup(String(args[0]))) as Promise<T>;
			case PARADIS_CLAUDE_HOST_STATE_COMMAND:
				if (this.claudeHost) {
					const request = (args[0] ?? {}) as IParadisClaudeStateRequest;
					return this.claudeHost.getState({ refresh: request.refresh === true, passive: request.passive === true }) as Promise<T>;
				}
				throw new Error(`Method not found: ${command}`);
			default:
				throw new Error(`Method not found: ${command}`);
		}
	}
}

/**
 * REH (接続先) 側の登録。利用上限は接続先の認証情報から読むので、繋いでいる間は接続先に聞く。
 * 設定と起動引数は渡さない（どちらも省略可で、シェル環境の解決だけに使う）。
 *
 * Claude は、接続先の Claude Code がいまログインしているアカウントの使用量だけを読み取り専用で答える
 * （{@link ParadisClaudeHostUsage}。トークンの更新もファイルへの書き込みもしない）。`CLAUDE_CONFIG_DIR` は
 * この REH のプロセスの環境にあるときだけ使う。
 */
export function registerParadisLimitsMonitorForServer<TContext>(server: IPCServer<TContext>, logService: ILogService): IDisposable {
	const service = new ParadisLimitsMonitorService(logService);
	const claudeHost = new ParadisClaudeHostUsage({
		homedir: os.homedir(),
		platform: process.platform,
		configDir: process.env['CLAUDE_CONFIG_DIR'],
		oauth: new ParadisClaudeOAuthClient(),
		logService,
	});
	server.registerChannel(PARADIS_LIMITS_MONITOR_CHANNEL, new ParadisLimitsMonitorChannel<TContext>(service, claudeHost));
	return { dispose: () => service.dispose() };
}

/** sharedProcessMain.ts の PARA-PATCH 点から1行で呼べるファクトリ。 */
export function registerParadisLimitsMonitor(server: IPCServer<string>, logService: ILogService, configurationService: IConfigurationService, args: NativeParsedArgs): IDisposable {
	const service = new ParadisLimitsMonitorService(logService, configurationService, args);
	server.registerChannel(PARADIS_LIMITS_MONITOR_CHANNEL, new ParadisLimitsMonitorChannel<string>(service));
	return { dispose: () => service.dispose() };
}
