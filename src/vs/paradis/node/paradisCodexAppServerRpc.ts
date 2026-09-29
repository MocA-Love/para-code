/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-PATCH/PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

// `CODEX_HOME=<ホーム> codex app-server`（stdio、改行区切り JSON-RPC）と短く話す最小のクライアント。
//
// limitsMonitor（使用量の取得、shared process と REH）、codexAccounts（リセットクレジットの読み取りと
// 消費）、agentHookTrust（`hooks/list` → `config/batchWrite`）、agentModelCatalog（`model/list`）が
// 共有する。認証の更新・auth.json の書き戻しは codex 自身に任せる（このプロセスは auth.json を書かない）。
//
// どれも `-s read-only -a never` で起こす。hook の信頼の `config/batchWrite`（CODEX_HOME/config.toml
// への書き込み）は app-server 自身が書くので、サンドボックスは効かない（codex 0.155.1 を一時の HOME と
// CODEX_HOME で動かし、読み取り専用でも書けることを 2026-09-27 に確かめた）。
//
// 投げるエラーの文言は limitsMonitor の Sentry 用の分類（classifyCodexRpcFailure）が前提にしている。
// 変えるときはそちらのテストも合わせること。

import * as cp from 'child_process';
import { homedir } from 'os';
import { timeout } from '../../base/common/async.js';
import { Disposable } from '../../base/common/lifecycle.js';
import { join, resolve } from '../../base/common/path.js';
import { ILogService } from '../../platform/log/common/log.js';
import { paradisSpawnAgentCli } from './paradisAgentCli.js';
import { paradisKillChildProcessTree, paradisKillExitedProcessGroup } from './paradisKillChildProcess.js';

/** app-server が返したエラー。message は app-server の文言（パス・トークンは含まない）。 */
export class ParadisCodexRpcError extends Error {
	constructor(message: string, readonly code: number | undefined) {
		super(message);
	}
}

/** Codex が「そのメソッドは無い」と答えた（古い CLI など）。message は app-server の文言のまま。 */
export class ParadisCodexRpcMethodNotFoundError extends ParadisCodexRpcError {
	constructor(message: string, code: number | undefined, readonly method: string) {
		super(message, code);
	}
}

const JSON_RPC_METHOD_NOT_FOUND = -32601;

/**
 * 認証が無い・切れているときの codex の文言（再ログインでしか直らない）。Orca の
 * `shared/codex-auth-errors.ts` の一覧に、Para Code が以前から拾っていた語を足したもの。
 * `forbidden` は拾わない（Cloudflare の 403 のように再ログインでは直らない失敗も含むため。HTTP の
 * 状態で分かるときは呼び出し側がそちらで判断する）。数字（`401`）も拾わない（リクエスト ID などに混ざる）。
 */
const CODEX_AUTH_ERROR_PATTERNS: readonly RegExp[] = [
	/access token could not be refreshed/i,
	/authentication session could not be refreshed/i,
	/refresh token (?:has expired|was already used|was revoked)/i,
	/you have since logged out or signed in to another account/i,
	/please (?:log out and )?sign in again/i,
	/please reauthenticate/i,
	/not logged in/i,
	/sign in with chatgpt/i,
	/token data is not available/i,
	/auth (?:is missing|tokens are missing|does not expose)/i,
	/chatgpt authentication required/i,
	/authentication required/i,
	/unauthorized/i,
	/re-?login/i,
	/token (?:has )?expired|expired token/i,
];

/** 認証が無い・切れているときの app-server の文言か（再ログインでしか直らない）。 */
export function paradisIsCodexAuthError(error: unknown): boolean {
	const message = error instanceof Error ? error.message : String(error ?? '');
	return CODEX_AUTH_ERROR_PATTERNS.some(pattern => pattern.test(message));
}

export interface IParadisCodexAppServerRpc {
	/** @param timeoutMs 省略時は 20 秒。 */
	request(method: string, params: unknown, timeoutMs?: number): Promise<unknown>;
	dispose(): void;
}

/** 起動の細かい指定。どれも省略できる。 */
export interface IParadisCodexAppServerRpcOptions {
	/** 対象の CODEX_HOME（絶対パス）。指定すると env の CODEX_HOME を上書きする。 */
	readonly codexHome?: string;
	/** app-server の作業ディレクトリ。 */
	readonly cwd?: string;
	/** initialize の clientInfo.title。 */
	readonly clientTitle?: string;
	/**
	 * 短命の問い合わせ（使用量など）として起こす。Orca の `CODEX_SHORT_LIVED_PROBE_APP_SERVER_ARGS` と
	 * 同じく `-c features.plugins=false` を付け、プラグインの起動（マーケットプレイスの clone など、
	 * 問い合わせより長く生き残るもの）を止める。
	 */
	readonly shortLivedProbe?: boolean;
}

export type ParadisCodexAppServerRpcFactory = (command: string, env: NodeJS.ProcessEnv, logService: ILogService, clientName?: string, options?: IParadisCodexAppServerRpcOptions) => Promise<IParadisCodexAppServerRpc>;

const INITIALIZE_TIMEOUT_MS = 15_000;
const DEFAULT_REQUEST_TIMEOUT_MS = 20_000;
/**
 * 同じホームのロックを待つ上限。セッションは要求の時間切れで必ず閉じるので普通は届かないが、閉じ忘れが
 * あっても取得が止まり続けないよう、これを過ぎたら待たずに進む。
 */
const HOME_LOCK_WAIT_MS = 60_000;

const homeLockTails = new Map<string, Promise<void>>();

function codexHomeLockKey(env: NodeJS.ProcessEnv): string {
	const home = env.CODEX_HOME && env.CODEX_HOME.length > 0 ? env.CODEX_HOME : join(homedir(), '.codex');
	const resolved = resolve(home);
	return process.platform === 'win32' || process.platform === 'darwin' ? resolved.toLowerCase() : resolved;
}

/**
 * ホームのロックを取る。返す関数で外す（何度呼んでもよい）。
 *
 * 待つのをあきらめたら、その時点で自分の番とみなす。後ろに並んだ者は、あきらめた前の保持者ではなく
 * 自分が外すのを待つ（閉じ忘れた保持者が1人いるだけで、後ろの全員が上限まで待たされ続けないように）。
 * @internal テスト用に `waitMs` を変えられる。
 */
export async function paradisAcquireCodexHomeLock(key: string, waitMs: number = HOME_LOCK_WAIT_MS): Promise<() => void> {
	const prior = homeLockTails.get(key) ?? Promise.resolve();
	let releaseTail!: () => void;
	const tail = new Promise<void>(resolveTail => { releaseTail = resolveTail; });
	const giveUp = timeout(waitMs);
	const turn = Promise.race([prior, giveUp.then(() => undefined, () => undefined)]);
	const chained = turn.then(() => tail);
	homeLockTails.set(key, chained);
	try {
		await turn;
	} finally {
		giveUp.cancel();
	}
	let released = false;
	return () => {
		if (released) {
			return;
		}
		released = true;
		releaseTail();
		if (homeLockTails.get(key) === chained) {
			homeLockTails.delete(key);
		}
	};
}

/**
 * app-server を起動して `initialize` / `initialized` まで済ませたセッションを返す。
 * 呼び出し側は使い終わったら必ず dispose する（子プロセスを残さない）。
 */
export const paradisStartCodexAppServerRpc: ParadisCodexAppServerRpcFactory = async (command, env, logService, clientName = 'para-code', options = {}) => {
	const childEnv = options.codexHome !== undefined ? { ...env, CODEX_HOME: options.codexHome } : env;
	// Orca（`codex-home-process-lock.ts`）と同じく、同じホームの app-server は1つずつにする。codex は
	// ホームの auth.json の使い捨てのリフレッシュトークンで更新するので、同じホームで2つが同時に更新すると
	// 1回分の更新を二重に使い、保存したログインを無効にしうる。ロックはセッションを閉じるまで持つ。
	const release = await paradisAcquireCodexHomeLock(codexHomeLockKey(childEnv));
	let session: ParadisCodexAppServerRpcSession;
	try {
		session = new ParadisCodexAppServerRpcSession(command, childEnv, options.cwd, logService, options.shortLivedProbe === true, release);
	} catch (error) {
		release();
		throw error;
	}
	try {
		const clientInfo = { name: clientName, ...(options.clientTitle !== undefined ? { title: options.clientTitle } : {}), version: '1.0.0' };
		await session.request('initialize', { clientInfo }, INITIALIZE_TIMEOUT_MS);
		session.notify('initialized');
		return session;
	} catch (error) {
		session.dispose();
		throw error;
	}
};

class ParadisCodexAppServerRpcSession extends Disposable implements IParadisCodexAppServerRpc {

	private readonly child: cp.ChildProcessWithoutNullStreams;
	/** 終了した・起動できなかった・破棄した理由。以後の要求はすぐこれで断る。 */
	private closedError: Error | undefined;
	private buffer = '';
	private nextId = 1;
	private readonly pending = new Map<number, { readonly method: string; resolve: (value: unknown) => void; reject: (error: Error) => void }>();

	constructor(command: string, env: NodeJS.ProcessEnv, cwd: string | undefined, private readonly logService: ILogService, shortLivedProbe: boolean, releaseHomeLock: () => void) {
		super();
		this._register({ dispose: releaseHomeLock });
		// `-a never`: 読み取り・消費・設定の書き込みしか呼ばないので承認は起きない。limitsMonitor と
		// 同じ理由で `untrusted` は使わない（codex 0.149 以降は受け付けない）。
		// Windows の .cmd シムは paradisSpawnAgentCli が cmd.exe で包む。POSIX では自分のプロセスグループで
		// 起こし、止めるときはグループごと止める（app-server が起こした子まで残さない）。
		const args = [...(shortLivedProbe ? ['-c', 'features.plugins=false'] : []), '-s', 'read-only', '-a', 'never', 'app-server'];
		this.child = paradisSpawnAgentCli(command, args, { env, cwd, processGroup: true });
		this.child.stdout?.on('data', (chunk: Buffer) => this.onStdout(chunk));
		this.child.stderr?.on('data', (chunk: Buffer) => {
			this.logService.trace(`[ParadisCodexAppServer] codex app-server stderr: ${chunk.toString('utf8').trim()}`);
		});
		this.child.on('exit', (code, signal) => {
			// app-server が先に終わっても、起こしたプラグインや MCP がグループに残らないようにする。
			paradisKillExitedProcessGroup(this.child);
			// 終了コードとシグナルは Sentry へ載せる（limitsMonitor）。文言には含めたまま。
			const error = new Error(`codex app-server exited (code=${code}, signal=${signal})`);
			Object.assign(error, { exitCode: code, exitSignal: signal });
			this.closedError ??= error;
			this.failAll(error);
		});
		this.child.on('error', error => {
			const launchError = new Error(`failed to launch codex app-server: ${error.message}`);
			this.closedError ??= launchError;
			this.failAll(launchError);
		});
		// stdin が閉じた後の書き込みで EPIPE が未処理例外にならないようにする。
		this.child.stdin?.on('error', error => this.failAll(new Error(`codex app-server stdin failed: ${error.message}`)));
		this._register({
			dispose: () => {
				// 待っている要求は時間切れを待たせずにその場で断る
				this.closedError ??= new Error('codex app-server session disposed');
				this.failAll(this.closedError);
				this.terminate();
			},
		});
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
			let message: { id?: unknown; result?: unknown; error?: { message?: string; code?: number } };
			try {
				message = JSON.parse(line);
			} catch {
				continue;
			}
			if (typeof message.id !== 'number') {
				continue; // 通知は使わない
			}
			const pending = this.pending.get(message.id);
			if (!pending) {
				continue;
			}
			this.pending.delete(message.id);
			if (message.error) {
				const text = message.error.message ?? 'codex app-server request failed';
				// 知らないメソッドには -32601 のほか、-32600 の「unknown variant」で答える（codex 0.155.1 で確認）。
				pending.reject(message.error.code === JSON_RPC_METHOD_NOT_FOUND || /method not found|unknown variant/i.test(text)
					? new ParadisCodexRpcMethodNotFoundError(text, message.error.code, pending.method)
					: new ParadisCodexRpcError(text, message.error.code));
			} else {
				pending.resolve(message.result);
			}
		}
	}

	async request(method: string, params: unknown, timeoutMs: number = DEFAULT_REQUEST_TIMEOUT_MS): Promise<unknown> {
		// 終わった app-server へは送らない（書き込みが EPIPE にならないと、時間切れまで待たされる）
		if (this.closedError !== undefined) {
			throw this.closedError;
		}
		const id = this.nextId++;
		const payload = JSON.stringify({ jsonrpc: '2.0', id, method, ...(params !== undefined ? { params } : {}) });
		const result = new Promise<unknown>((resolve, reject) => {
			this.pending.set(id, { method, resolve, reject });
		});
		this.child.stdin?.write(payload + '\n');
		const timer = timeout(timeoutMs);
		try {
			return await Promise.race([
				result,
				timer.then(() => {
					if (this.pending.delete(id)) {
						this.terminate();
					}
					throw new Error(`codex app-server request '${method}' timed out`);
				}),
			]);
		} finally {
			// 応答が先に来たらタイマーを止める（プロセスの終了を待たせない）。
			timer.cancel();
		}
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
		paradisKillChildProcessTree(this.child, error => this.logService.trace(`[ParadisCodexAppServer] failed to stop codex app-server: ${error}`), { processGroup: true });
	}
}
