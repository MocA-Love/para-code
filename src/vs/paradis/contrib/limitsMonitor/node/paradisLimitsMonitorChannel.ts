/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-PATCH/PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

// AIリミットモニターのshared processバックエンド。
//
// データ取得(getSnapshot):
//   - Claude: `cswap --list --json` (claude-swap) をexecFile直叩き。マルチアカウントの認証・
//     usage取得はcswap自身が行うため、ここではJSONのパースだけを行う(CodexBarの正式
//     マルチアカウント設計と同じ方式。Keychainには一切触れない)
//   - Codex: ~/.codex / ~/.codex-* 各ホームの auth.json からaccess tokenを読み、
//     `GET https://chatgpt.com/backend-api/wham/usage` を直叩き。401/403時のみ
//     `CODEX_HOME=<home> codex -s read-only -a untrusted app-server` (JSON-RPC over stdio) へ
//     フォールバックし、トークンリフレッシュとauth.json書き戻しはcodex CLI自身に任せる
//     (このプロセスがauth.jsonへ書き込むことは決してない)
//
// アカウント追加(startCodexLogin / startClaudeSetup):
//   - Codex: 空き番号の新ホーム(~/.codex-N)をmkdir(EEXISTなら次の番号、既存ディレクトリは
//     決して再利用・上書きしない)し、`CODEX_HOME=<新ホーム> codex login` を起動。ブラウザで
//     ログインが完了するとcodexがauth.jsonを書いてexitする
//   - Claude: `claude setup-token` をPTYで駆動し、確認コードをrendererから中継、出力された
//     sk-ant-oat01トークンを `cswap add-token -` (stdin渡し)でスロット登録する。現在アクティブな
//     Claude資格情報には一切触れない

import * as cp from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import { timeout } from '../../../../base/common/async.js';
import { Event } from '../../../../base/common/event.js';
import { Disposable, IDisposable } from '../../../../base/common/lifecycle.js';
import * as path from '../../../../base/common/path.js';
import { generateUuid } from '../../../../base/common/uuid.js';
import { IPCServer, IServerChannel } from '../../../../base/parts/ipc/common/ipc.js';
import { IConfigurationService } from '../../../../platform/configuration/common/configuration.js';
import { NativeParsedArgs } from '../../../../platform/environment/common/argv.js';
import { ILogService } from '../../../../platform/log/common/log.js';
import { createParadisShellEnvResolver, ParadisCachedShellEnv } from '../../../../platform/shell/node/paradisCachedShellEnv.js';
import {
	IParadisLimitsAccount,
	IParadisLimitsFetchOptions,
	IParadisLimitsProviderSnapshot,
	IParadisLimitsSetupHandle,
	IParadisLimitsSetupState,
	IParadisLimitsSnapshot,
	IParadisLimitsWindow,
	PARADIS_LIMITS_MONITOR_CHANNEL,
	ParadisLimitsAccountStatus
} from '../common/paradisLimitsMonitor.js';

/** スナップショットのTTL。リミットの変化は緩やかなので1分共有で十分。 */
const SNAPSHOT_CACHE_TTL_MS = 60_000;
/** cswap実行のタイムアウト(全スロットのusage取得でネットワークを跨ぐため長め)。 */
const CSWAP_TIMEOUT_MS = 60_000;
/** wham/usage HTTPタイムアウト。 */
const USAGE_HTTP_TIMEOUT_MS = 30_000;
/** app-server RPCの初期化/リクエストタイムアウト。 */
const RPC_INIT_TIMEOUT_MS = 15_000;
const RPC_REQUEST_TIMEOUT_MS = 10_000;
/** RPCフォールバックも失敗したホームの再試行抑止時間(毎ポーリングでcodexを起動しないため)。 */
const RPC_FAILURE_COOLDOWN_MS = 10 * 60_000;
/** ログイン/セットアップセッションの完了までの制限時間。 */
const SETUP_TIMEOUT_MS = 10 * 60_000;
/** 完了/失敗したセットアップセッションを保持する時間(rendererの最終ポーリング用)。 */
const SETUP_RETENTION_MS = 5 * 60_000;
/** 追加先Codexホームの番号探索の上限。 */
const MAX_CODEX_HOME_INDEX = 20;

// ---------- cswap --list --json の出力型(schemaVersion 1) ----------

interface ICswapWindow {
	readonly pct?: number;
	readonly resetsAt?: string;
	readonly name?: string;
}

interface ICswapAccount {
	readonly number?: number;
	readonly email?: string;
	readonly active?: boolean;
	readonly usageStatus?: string;
	readonly usage?: {
		readonly fiveHour?: ICswapWindow;
		readonly sevenDay?: ICswapWindow;
		readonly scoped?: readonly ICswapWindow[];
	};
}

interface ICswapListResult {
	readonly schemaVersion?: number;
	readonly accounts?: readonly ICswapAccount[];
}

// ---------- wham/usage レスポンス型(CodexBar CodexOAuthUsageFetcher.swift と同じマッピング) ----------

interface IWhamWindow {
	readonly used_percent?: number;
	/** epoch秒。 */
	readonly reset_at?: number;
	readonly limit_window_seconds?: number;
}

interface IWhamRateLimit {
	readonly primary_window?: IWhamWindow;
	readonly secondary_window?: IWhamWindow;
}

interface IWhamUsageResponse {
	readonly plan_type?: string;
	readonly rate_limit?: IWhamRateLimit;
	readonly additional_rate_limits?: readonly { readonly limit_name?: string; readonly rate_limit?: IWhamRateLimit }[];
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
		readonly primary?: IRpcRateLimitWindow;
		readonly secondary?: IRpcRateLimitWindow;
		readonly planType?: string;
	};
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

interface ISetupSession {
	readonly id: string;
	state: IParadisLimitsSetupState;
	/** セッション終了時の後始末(子プロセスkill等)。 */
	dispose(): void;
	/** Claudeセットアップのみ: 確認コードの投入。 */
	submitCode?(code: string): void;
}

export class ParadisLimitsMonitorService {

	private snapshotCache: { at: number; key: string; value: IParadisLimitsSnapshot } | undefined;
	private inflight: Promise<IParadisLimitsSnapshot> | undefined;
	private inflightKey: string | undefined;
	/** RPCフォールバックまで失敗したCodexホーム → 失敗時刻(クールダウン用)。 */
	private readonly rpcFailureAt = new Map<string, number>();
	private readonly setupSessions = new Map<string, ISetupSession>();
	private readonly cachedShellEnv: ParadisCachedShellEnv;

	constructor(
		private readonly logService: ILogService,
		configurationService: IConfigurationService,
		args: NativeParsedArgs,
	) {
		this.cachedShellEnv = new ParadisCachedShellEnv(
			logService,
			'ParadisLimitsMonitor',
			createParadisShellEnvResolver(logService, configurationService, args),
		);
	}

	dispose(): void {
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
		const key = JSON.stringify([options.cswapPath ?? '', options.codexHomes ?? []]);
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
		const [claude, codex] = await Promise.all([
			this.fetchClaudeAccounts(options.cswapPath),
			this.fetchCodexAccounts(options.codexHomes),
		]);
		return { claude, codex, fetchedAt: Date.now() };
	}

	// ---------- Claude (cswap) ----------

	private async fetchClaudeAccounts(cswapPath: string | undefined): Promise<IParadisLimitsProviderSnapshot> {
		let command: string;
		try {
			command = await this.resolveCommand('cswap', cswapPath);
		} catch (error) {
			return { accounts: [], sourceError: (error as Error).message, cswapMissing: true };
		}
		let stdout: string;
		try {
			stdout = await this.execFile(command, ['--list', '--json'], { timeoutMs: CSWAP_TIMEOUT_MS });
		} catch (error) {
			this.logService.warn(`[ParadisLimitsMonitor] cswap --list failed: ${(error as Error).message}`);
			return { accounts: [], sourceError: (error as Error).message };
		}
		let parsed: ICswapListResult;
		try {
			parsed = JSON.parse(stdout) as ICswapListResult;
		} catch {
			return { accounts: [], sourceError: 'cswap returned invalid JSON output' };
		}
		if (parsed.schemaVersion !== 1) {
			return { accounts: [], sourceError: `unsupported cswap schemaVersion: ${parsed.schemaVersion}` };
		}
		const accounts: IParadisLimitsAccount[] = [];
		for (const raw of parsed.accounts ?? []) {
			if (typeof raw?.number !== 'number') {
				continue;
			}
			accounts.push(this.mapCswapAccount(raw));
		}
		return { accounts };
	}

	private mapCswapAccount(raw: ICswapAccount): IParadisLimitsAccount {
		const usageStatus = raw.usageStatus ?? 'unavailable';
		let status: ParadisLimitsAccountStatus;
		switch (usageStatus) {
			case 'ok': status = 'ok'; break;
			case 'token_expired': status = 'token_expired'; break;
			case 'no_credentials': status = 'no_credentials'; break;
			default: status = 'error'; break;
		}
		const mapWindow = (window: ICswapWindow | undefined, label?: string): IParadisLimitsWindow | undefined => {
			if (typeof window?.pct !== 'number') {
				return undefined;
			}
			const resetsAt = window.resetsAt ? Date.parse(window.resetsAt) : NaN;
			return {
				usedPercent: window.pct,
				resetsAt: isNaN(resetsAt) ? undefined : resetsAt,
				label: label ?? window.name,
			};
		};
		const scoped: IParadisLimitsWindow[] = [];
		for (const rawScoped of raw.usage?.scoped ?? []) {
			const mapped = mapWindow(rawScoped);
			if (mapped) {
				scoped.push(mapped);
			}
		}
		return {
			provider: 'claude',
			id: `claude-swap:${raw.number}`,
			slot: raw.number,
			email: raw.email,
			active: raw.active === true,
			status,
			statusDetail: status === 'ok' ? undefined : usageStatus,
			fiveHour: mapWindow(raw.usage?.fiveHour),
			sevenDay: mapWindow(raw.usage?.sevenDay),
			scoped: scoped.length > 0 ? scoped : undefined,
		};
	}

	// ---------- Codex (auth.json + wham/usage) ----------

	private async fetchCodexAccounts(extraHomes: readonly string[] | undefined): Promise<IParadisLimitsProviderSnapshot> {
		const homes = await this.discoverCodexHomes(extraHomes);
		if (homes.length === 0) {
			return { accounts: [], sourceError: 'no Codex homes with auth.json found' };
		}
		const accounts = await Promise.all(homes.map(home => this.fetchCodexAccount(home)));
		return { accounts };
	}

	private async discoverCodexHomes(extraHomes: readonly string[] | undefined): Promise<string[]> {
		const homes = new Set<string>();
		const home = os.homedir();
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
			if (typeof extra === 'string' && extra.trim().length > 0) {
				homes.add(extra.startsWith('~') ? path.join(home, extra.slice(1)) : extra);
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
		const home = os.homedir();
		return homePath.startsWith(home) ? `~${homePath.slice(home.length)}` : homePath;
	}

	private async fetchCodexAccount(homePath: string): Promise<IParadisLimitsAccount> {
		const base: { provider: 'codex'; id: string; homeLabel: string } = {
			provider: 'codex',
			id: homePath,
			homeLabel: this.codexHomeLabel(homePath),
		};
		let auth: ICodexAuthJson;
		try {
			auth = JSON.parse(await fs.promises.readFile(path.join(homePath, 'auth.json'), 'utf8')) as ICodexAuthJson;
		} catch (error) {
			return { ...base, status: 'error', statusDetail: `failed to read auth.json: ${(error as Error).message}` };
		}
		const accessToken = auth.tokens?.access_token;
		if (!accessToken) {
			return { ...base, status: 'no_credentials', statusDetail: 'auth.json has no access token' };
		}
		const email = this.emailFromIdToken(auth.tokens?.id_token);

		try {
			const usage = await this.fetchWhamUsage(accessToken, auth.tokens?.account_id);
			return { ...base, email, ...this.mapWhamUsage(usage), status: 'ok' };
		} catch (error) {
			const httpStatus = (error as { httpStatus?: number }).httpStatus;
			if (httpStatus !== 401 && httpStatus !== 403) {
				return { ...base, email, status: 'error', statusDetail: (error as Error).message };
			}
		}

		// access token失効 → codex app-server RPCへフォールバック(codex CLI自身にリフレッシュさせる)
		const lastFailure = this.rpcFailureAt.get(homePath);
		if (lastFailure !== undefined && Date.now() - lastFailure < RPC_FAILURE_COOLDOWN_MS) {
			return { ...base, email, status: 'token_expired', statusDetail: 'access token expired (re-login required)' };
		}
		try {
			const viaRpc = await this.fetchCodexAccountViaRpc(homePath);
			this.rpcFailureAt.delete(homePath);
			return { ...base, email: viaRpc.email ?? email, ...viaRpc.windows, planType: viaRpc.planType, status: 'ok' };
		} catch (error) {
			this.rpcFailureAt.set(homePath, Date.now());
			this.logService.warn(`[ParadisLimitsMonitor] codex app-server fallback failed for ${base.homeLabel}: ${(error as Error).message}`);
			return { ...base, email, status: 'token_expired', statusDetail: (error as Error).message };
		}
	}

	/** id_token(JWT)のpayloadからemailを取り出す(署名検証はしない。表示用途のみ)。 */
	private emailFromIdToken(idToken: string | undefined): string | undefined {
		if (!idToken) {
			return undefined;
		}
		try {
			const payloadPart = idToken.split('.')[1];
			const payload = JSON.parse(Buffer.from(payloadPart, 'base64url').toString('utf8')) as Record<string, unknown>;
			if (typeof payload['email'] === 'string') {
				return payload['email'];
			}
			const profile = payload['https://api.openai.com/profile'];
			if (profile && typeof (profile as Record<string, unknown>)['email'] === 'string') {
				return (profile as Record<string, unknown>)['email'] as string;
			}
		} catch {
			// 表示用の補助情報なので失敗は無視
		}
		return undefined;
	}

	private async fetchWhamUsage(accessToken: string, accountId: string | undefined): Promise<IWhamUsageResponse> {
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
			const response = await fetch('https://chatgpt.com/backend-api/wham/usage', { method: 'GET', headers, signal: controller.signal });
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
		const mapWindow = (window: IWhamWindow | undefined, label?: string): IParadisLimitsWindow | undefined => {
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
		return {
			planType: usage.plan_type,
			fiveHour: mapWindow(usage.rate_limit?.primary_window),
			sevenDay: mapWindow(usage.rate_limit?.secondary_window),
			scoped: scoped.length > 0 ? scoped : undefined,
		};
	}

	/** `codex app-server` (JSON-RPC over stdio) でrate limitsとアカウント情報を取得する。 */
	private async fetchCodexAccountViaRpc(homePath: string): Promise<{ email?: string; planType?: string; windows: { fiveHour?: IParadisLimitsWindow; sevenDay?: IParadisLimitsWindow } }> {
		const command = await this.resolveCommand('codex', undefined);
		const env = { ...await this.getExecEnv(), CODEX_HOME: homePath };
		const rpc = new ParadisCodexRpcSession(command, env, this.logService);
		try {
			await rpc.request('initialize', { clientInfo: { name: 'para-code-limits-monitor', version: '1.0.0' } }, RPC_INIT_TIMEOUT_MS);
			rpc.notify('initialized');
			const rateLimits = await rpc.request('account/rateLimits/read', undefined, RPC_REQUEST_TIMEOUT_MS) as IRpcRateLimitsResult;
			let account: IRpcAccountResult | undefined;
			try {
				account = await rpc.request('account/read', undefined, RPC_REQUEST_TIMEOUT_MS) as IRpcAccountResult;
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
			return {
				email: account?.account?.email,
				planType: account?.account?.planType ?? rateLimits.rateLimits?.planType,
				windows: {
					fiveHour: mapWindow(rateLimits.rateLimits?.primary),
					sevenDay: mapWindow(rateLimits.rateLimits?.secondary),
				},
			};
		} finally {
			rpc.dispose();
		}
	}

	// ---------- アカウント追加: Codex ----------

	async startCodexLogin(existingHome: string | undefined): Promise<IParadisLimitsSetupHandle> {
		const sessionId = generateUuid();
		const session: ISetupSession = {
			id: sessionId,
			state: { phase: 'starting' },
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
			const knownHomes = await this.discoverCodexHomes(undefined);
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
		const child = cp.spawn(command, ['login'], { env, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
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
			try {
				child.kill();
			} catch {
				// already dead
			}
		};
		this.scheduleSetupTimeout(session);

		const exitCode = await new Promise<number | null>(resolve => {
			child.on('error', () => resolve(null));
			child.on('exit', code => resolve(code));
		});

		const loginSucceeded = exitCode === 0 && await this.fileExists(path.join(homePath, 'auth.json'));
		if (loginSucceeded) {
			let email: string | undefined;
			try {
				const auth = JSON.parse(await fs.promises.readFile(path.join(homePath, 'auth.json'), 'utf8')) as ICodexAuthJson;
				email = this.emailFromIdToken(auth.tokens?.id_token);
			} catch {
				// 表示用のみ
			}
			this.snapshotCache = undefined;
			this.rpcFailureAt.delete(homePath);
			session.state = { ...session.state, phase: 'done', email };
			this.scheduleSetupCleanup(session);
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
				await fs.promises.mkdir(candidate);
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

	// ---------- アカウント追加: Claude (claude setup-token + cswap add-token) ----------

	async startClaudeSetup(slot: number | undefined): Promise<IParadisLimitsSetupHandle> {
		const sessionId = generateUuid();
		const session: ISetupSession = {
			id: sessionId,
			state: { phase: 'starting' },
			dispose: () => { },
		};
		this.setupSessions.set(sessionId, session);
		this.runClaudeSetup(session, slot).catch(error => {
			session.state = { ...session.state, phase: 'error', error: (error as Error).message };
			this.scheduleSetupCleanup(session);
		});
		return { sessionId };
	}

	private async runClaudeSetup(session: ISetupSession, slot: number | undefined): Promise<void> {
		const claudeCommand = await this.resolveCommand('claude', undefined);
		const cswapCommand = await this.resolveCommand('cswap', undefined);
		const env = await this.getExecEnv();

		// claude setup-token はInk製の対話UIでTTYを要求するためPTYで駆動する。
		// ptyHostと同じnode-ptyをshared processから直接使う
		const pty = await import('node-pty');
		const ptyEnv: { [key: string]: string } = { NO_COLOR: '1' };
		for (const [key, value] of Object.entries(env)) {
			if (typeof value === 'string') {
				ptyEnv[key] = value;
			}
		}
		const child = pty.spawn(claudeCommand, ['setup-token'], {
			name: 'xterm-256color',
			cols: 200,
			rows: 50,
			cwd: os.homedir(),
			env: ptyEnv,
		});

		let output = '';
		let finished = false;
		let tokenResolve: ((token: string) => void) | undefined;
		let tokenReject: ((error: Error) => void) | undefined;
		const tokenPromise = new Promise<string>((resolve, reject) => {
			tokenResolve = resolve;
			tokenReject = reject;
		});

		const extractToken = () => /sk-ant-oat01-[A-Za-z0-9_-]{20,}/.exec(stripAnsi(output))?.[0];
		let tokenSettleTimer: ReturnType<typeof setTimeout> | undefined;
		child.onData(data => {
			output += data;
			const plain = stripAnsi(output);
			// チャンク境界でURLが途切れた状態を確定させないよう、蓄積出力から毎回抽出し直して更新する
			const url = /https:\/\/[^\s"')]+oauth[^\s"')]*/i.exec(plain)?.[0] ?? /https:\/\/(?:claude\.ai|console\.anthropic\.com)[^\s"')]+/.exec(plain)?.[0];
			if (url && url !== session.state.url && session.state.phase !== 'done' && session.state.phase !== 'error' && session.state.phase !== 'registering') {
				session.state = { ...session.state, phase: 'waiting_code', url };
			}
			// トークンもチャンク境界で途切れうるため、初検出から少し待って蓄積出力から取り直して確定する
			if (extractToken() && !finished && tokenSettleTimer === undefined) {
				tokenSettleTimer = setTimeout(() => {
					const settled = extractToken();
					if (settled && !finished) {
						finished = true;
						tokenResolve?.(settled);
					}
				}, 500);
			}
		});
		child.onExit(({ exitCode }) => {
			if (finished) {
				return;
			}
			// トークン表示直後にexitした場合は確定待ちタイマーと競合するため、ここで最終抽出を試みる
			const settled = extractToken();
			finished = true;
			if (settled) {
				tokenResolve?.(settled);
			} else {
				tokenReject?.(new Error(`claude setup-token exited with code ${exitCode} before producing a token`));
			}
		});

		session.submitCode = code => {
			// PTYへの書き込みは制御文字を除去した1行に限定する(貼り付け内容の混入対策)
			child.write(code.trim().replace(/[\u0000-\u001F\u007F]/g, '') + '\r');
		};
		session.dispose = () => {
			if (!finished) {
				finished = true;
				tokenReject?.(new Error('cancelled'));
			}
			try {
				child.kill();
			} catch {
				// already dead
			}
		};
		this.scheduleSetupTimeout(session);
		if (session.state.phase === 'starting') {
			session.state = { phase: 'waiting_code' };
		}

		let token: string;
		try {
			token = await tokenPromise;
		} finally {
			try {
				child.kill();
			} catch {
				// already dead
			}
		}

		session.state = { ...session.state, phase: 'registering' };
		const addArgs = ['add-token', '-'];
		if (typeof slot === 'number') {
			addArgs.push('--slot', String(slot));
		}
		// トークンはargvに載せない(psに見えるため)。stdin渡しはcswapが公式サポートしている
		await this.execFile(cswapCommand, addArgs, { timeoutMs: CSWAP_TIMEOUT_MS, stdin: token });
		this.snapshotCache = undefined;
		session.state = { ...session.state, phase: 'done' };
		this.scheduleSetupCleanup(session);
	}

	// ---------- セットアップセッション共通 ----------

	getSetupState(sessionId: string): IParadisLimitsSetupState {
		const session = this.setupSessions.get(sessionId);
		if (!session) {
			return { phase: 'error', error: 'setup session not found' };
		}
		return session.state;
	}

	submitClaudeSetupCode(sessionId: string, code: string): void {
		const session = this.setupSessions.get(sessionId);
		if (!session?.submitCode) {
			throw new Error('setup session not found or does not accept a code');
		}
		if (typeof code !== 'string' || code.trim().length === 0 || code.length > 512) {
			throw new Error('invalid confirmation code');
		}
		session.submitCode(code);
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

	private execFile(command: string, args: string[], options: { timeoutMs: number; stdin?: string }): Promise<string> {
		return new Promise<string>((resolve, reject) => {
			this.getExecEnv().then(env => {
				const child = cp.execFile(command, args, {
					encoding: 'utf8',
					timeout: options.timeoutMs,
					maxBuffer: 16 * 1024 * 1024,
					windowsHide: true,
					env: { ...env, NO_COLOR: '1' },
				}, (err, stdout, stderr) => {
					if (err) {
						reject(new Error(stderr?.trim() || err.message));
					} else {
						resolve(stdout);
					}
				});
				if (options.stdin !== undefined) {
					child.stdin?.write(options.stdin);
					child.stdin?.end();
				}
			}, reject);
		});
	}

	/**
	 * コマンドを解決する。優先順: 明示パス(絶対パス必須) → PATH → よくあるインストール先。
	 * GUI起動ではログインシェルのPATHが継承されないため、候補ディレクトリを直接確認する。
	 */
	private async resolveCommand(name: 'cswap' | 'claude' | 'codex', explicitPath: string | undefined): Promise<string> {
		if (explicitPath) {
			if (!path.isAbsolute(explicitPath)) {
				throw new Error(`configured path for ${name} must be absolute: ${explicitPath}`);
			}
			return explicitPath;
		}
		const isWindows = process.platform === 'win32';
		const names = isWindows ? [`${name}.exe`, `${name}.cmd`, name] : [name];
		for (const candidate of names) {
			if (await this.canExecute(candidate)) {
				return candidate;
			}
		}
		const home = os.homedir();
		const candidateDirs = isWindows
			? [path.join(home, '.local', 'bin'), path.join(home, 'AppData', 'Roaming', 'npm'), path.join(home, '.codex', 'bin')]
			: [path.join(home, '.local', 'bin'), path.join(home, '.npm-global', 'bin'), path.join(home, '.bun', 'bin'), '/opt/homebrew/bin', '/usr/local/bin'];
		for (const dir of candidateDirs) {
			for (const candidate of names) {
				const fullPath = path.join(dir, candidate);
				if (await this.fileExists(fullPath)) {
					return fullPath;
				}
			}
		}
		throw new Error(`${name} not found (install it or set the executable path in settings)`);
	}

	private async canExecute(command: string): Promise<boolean> {
		const env = await this.getExecEnv();
		return new Promise<boolean>(resolve => {
			cp.execFile(command, ['--version'], { timeout: 10_000, windowsHide: true, env }, err => resolve(!err));
		});
	}

	private fileExists(filePath: string): Promise<boolean> {
		return new Promise<boolean>(resolve => {
			fs.access(filePath, fs.constants.F_OK, err => resolve(!err));
		});
	}
}

/** ANSIエスケープ(CSI/OSC)を除去する。PTY出力からURL/トークンを抽出するための最小実装。 */
function stripAnsi(value: string): string {
	return value.replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g, '').replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, '');
}

/** `codex app-server` との改行区切りJSON-RPCセッション(読み取り専用サンドボックスで起動)。 */
class ParadisCodexRpcSession extends Disposable {

	private readonly child: cp.ChildProcess;
	private buffer = '';
	private nextId = 1;
	private readonly pending = new Map<number, { resolve: (value: unknown) => void; reject: (error: Error) => void }>();

	constructor(command: string, env: NodeJS.ProcessEnv, logService: ILogService) {
		super();
		this.child = cp.spawn(command, ['-s', 'read-only', '-a', 'untrusted', 'app-server'], {
			env,
			stdio: ['pipe', 'pipe', 'pipe'],
			windowsHide: true,
		});
		this.child.stdout?.on('data', (chunk: Buffer) => this.onStdout(chunk));
		this.child.stderr?.on('data', (chunk: Buffer) => {
			logService.trace(`[ParadisLimitsMonitor] codex app-server stderr: ${chunk.toString('utf8').trim()}`);
		});
		this.child.on('exit', () => this.failAll(new Error('codex app-server exited')));
		this.child.on('error', error => this.failAll(new Error(`failed to launch codex app-server: ${error.message}`)));
		this._register({ dispose: () => this.terminate() });
	}

	private onStdout(chunk: Buffer): void {
		this.buffer += chunk.toString('utf8');
		let newlineIndex: number;
		while ((newlineIndex = this.buffer.indexOf('\n')) >= 0) {
			const line = this.buffer.slice(0, newlineIndex).trim();
			this.buffer = this.buffer.slice(newlineIndex + 1);
			if (!line) {
				continue;
			}
			let message: { id?: unknown; result?: unknown; error?: { message?: string } };
			try {
				message = JSON.parse(line);
			} catch {
				continue;
			}
			if (typeof message.id !== 'number') {
				continue; // 通知はすべて無視する
			}
			const pending = this.pending.get(message.id);
			if (!pending) {
				continue;
			}
			this.pending.delete(message.id);
			if (message.error) {
				pending.reject(new Error(message.error.message ?? 'codex app-server request failed'));
			} else {
				pending.resolve(message.result);
			}
		}
	}

	async request(method: string, params: unknown, timeoutMs: number): Promise<unknown> {
		const id = this.nextId++;
		const payload = JSON.stringify({ jsonrpc: '2.0', id, method, ...(params !== undefined ? { params } : {}) });
		const result = new Promise<unknown>((resolve, reject) => {
			this.pending.set(id, { resolve, reject });
		});
		this.child.stdin?.write(payload + '\n');
		return Promise.race([
			result,
			timeout(timeoutMs).then(() => {
				if (this.pending.delete(id)) {
					this.terminate();
				}
				throw new Error(`codex app-server request '${method}' timed out`);
			}),
		]);
	}

	notify(method: string): void {
		this.child.stdin?.write(JSON.stringify({ jsonrpc: '2.0', method }) + '\n');
	}

	private failAll(error: Error): void {
		for (const pending of this.pending.values()) {
			pending.reject(error);
		}
		this.pending.clear();
	}

	private terminate(): void {
		try {
			this.child.kill();
		} catch {
			// already dead
		}
	}
}

export class ParadisLimitsMonitorChannel implements IServerChannel<string> {

	constructor(private readonly service: ParadisLimitsMonitorService) { }

	listen<T>(_ctx: string, event: string): Event<T> {
		throw new Error(`Event not found: ${event}`);
	}

	call<T>(_ctx: string, command: string, arg?: unknown): Promise<T> {
		const args = Array.isArray(arg) ? arg : [];
		switch (command) {
			case 'getSnapshot': return this.service.getSnapshot((args[0] ?? {}) as IParadisLimitsFetchOptions) as Promise<T>;
			case 'startCodexLogin': return this.service.startCodexLogin(typeof args[0] === 'string' ? args[0] : undefined) as Promise<T>;
			case 'startClaudeSetup': return this.service.startClaudeSetup(typeof args[0] === 'number' ? args[0] : undefined) as Promise<T>;
			case 'getSetupState': return Promise.resolve(this.service.getSetupState(String(args[0]))) as Promise<T>;
			case 'submitClaudeSetupCode': return Promise.resolve(this.service.submitClaudeSetupCode(String(args[0]), String(args[1]))) as Promise<T>;
			case 'cancelSetup': return Promise.resolve(this.service.cancelSetup(String(args[0]))) as Promise<T>;
			default:
				throw new Error(`Method not found: ${command}`);
		}
	}
}

/** sharedProcessMain.ts の PARA-PATCH 点から1行で呼べるファクトリ。 */
export function registerParadisLimitsMonitor(server: IPCServer<string>, logService: ILogService, configurationService: IConfigurationService, args: NativeParsedArgs): IDisposable {
	const service = new ParadisLimitsMonitorService(logService, configurationService, args);
	server.registerChannel(PARADIS_LIMITS_MONITOR_CHANNEL, new ParadisLimitsMonitorChannel(service));
	return { dispose: () => service.dispose() };
}
