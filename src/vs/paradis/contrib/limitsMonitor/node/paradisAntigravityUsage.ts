/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

// AIリミットモニターの Antigravity CLI（agy）の分。shared process（SSH のウィンドウでは接続先の REH）で
// `agy -p "/usage" --output-format json` を動かして読む。この実行は会話を作らず、hook も MCP サーバーも
// 起こさない（2026-11-12 に実測）。agy の内部 API を直接呼ぶには token が要るので、CLI を通す。
//
// 起こし方は Codex の app-server（paradisLimitsMonitorChannel.ts）と同じ抑えにする:
// - 同じ値で足りる間（最短 5 分）は起こさず、前の結果を返す
// - 認証以外で失敗したら 10 分は起こさない
// - サインインしていないと答えたら、10 分たつか agy のログインの置き場所が変わるまで起こさない
// - 同時に起こすのは1本だけ（取り直しの最中に来た要求は相乗りする）
// - 手動の更新（bypassCache）は上の待ちを無視して取り直す
// サインインしていない agy はログインの URL を出して入力を待ち続けるので、その文が出た時点で止める。
// token のファイルは中身を読まない（更新時刻と大きさだけを見る）。

import * as fs from 'fs';
import * as os from 'os';
import * as path from '../../../../base/common/path.js';
import { ILogService } from '../../../../platform/log/common/log.js';
import { IParadisRunAgentCliOptions, IParadisRunAgentCliResult, paradisDetachedAgentCliEnv, paradisResolveAgentCli, paradisRunAgentCli } from '../../../node/paradisAgentCli.js';
import { paradisAntigravityNeedsSignIn, paradisParseAntigravityUsage } from '../common/paradisAntigravityUsage.js';
import { IParadisLimitsAccount, IParadisLimitsProviderSnapshot } from '../common/paradisLimitsMonitor.js';

/** agy を起こす最短の間隔（Codex の MIN_RPC_INTERVAL_MS と同じ）。 */
const MIN_RUN_INTERVAL_MS = 5 * 60_000;
/** 失敗した後に起こさない長さ（Codex の RPC_FAILURE_COOLDOWN_MS と同じ）。 */
const FAILURE_COOLDOWN_MS = 10 * 60_000;
/** 1回の打ち切り。 */
const RUN_TIMEOUT_MS = 20_000;
/** 失敗したときに「前の値」として出してよい長さ（Codex のスナップショットの SNAPSHOT_STALE_MAX_AGE_MS と同じ）。 */
const PREVIOUS_VALUE_MAX_AGE_MS = 6 * 60 * 60_000;

const USAGE_ARGS: readonly string[] = ['-p', '/usage', '--output-format', 'json'];

export type ParadisAntigravityCliRunner = (command: string, args: readonly string[], options: IParadisRunAgentCliOptions) => Promise<IParadisRunAgentCliResult>;

export interface IParadisAntigravityUsageDeps {
	readonly homedir?: () => string;
	readonly now?: () => number;
	/** agy の実行ファイルを探す。見つからなければ undefined（入れていない）。 */
	readonly resolveCommand?: (env: NodeJS.ProcessEnv) => Promise<string | undefined>;
	readonly runCli?: ParadisAntigravityCliRunner;
	/** ログインし直したかを見るための印（token のファイルの更新時刻と大きさ。中身は読まない）。 */
	readonly signInStamp?: (geminiDir: string) => Promise<string | undefined>;
	/** agy を動かす空のフォルダ。 */
	readonly workDir?: () => Promise<string>;
}

async function defaultSignInStamp(geminiDir: string): Promise<string | undefined> {
	const stamps: string[] = [];
	for (const file of [path.join(geminiDir, 'antigravity-cli', 'antigravity-oauth-token'), path.join(geminiDir, 'antigravity-cli')]) {
		try {
			const stat = await fs.promises.stat(file);
			stamps.push(`${stat.mtimeMs}:${stat.size}`);
		} catch {
			stamps.push('-');
		}
	}
	return stamps.join('|');
}

async function defaultWorkDir(): Promise<string> {
	// ホームやリポジトリで動かすと、agy がそのフォルダを作業場所として扱いうる。中身の無いフォルダで動かす。
	const dir = path.join(os.tmpdir(), 'para-code-agy-usage');
	await fs.promises.mkdir(dir, { recursive: true });
	return dir;
}

export class ParadisAntigravityUsageFetcher {

	private readonly homedir: () => string;
	private readonly now: () => number;
	private readonly resolveCommand: (env: NodeJS.ProcessEnv) => Promise<string | undefined>;
	private readonly runCli: ParadisAntigravityCliRunner;
	private readonly signInStamp: (geminiDir: string) => Promise<string | undefined>;
	private readonly workDir: () => Promise<string>;

	/** 最後に返したアカウントと、agy を起こした時刻。 */
	private last: { readonly account: IParadisLimitsAccount; readonly ranAt: number } | undefined;
	/** 最後に値が取れたアカウント（失敗したときに「前の値」として出す）。 */
	private lastGood: IParadisLimitsAccount | undefined;
	private failureAt: number | undefined;
	private signedOut: { readonly at: number; readonly stamp: string | undefined } | undefined;
	private inflight: Promise<IParadisLimitsAccount> | undefined;

	constructor(
		private readonly logService: ILogService,
		private readonly getEnv: () => Promise<NodeJS.ProcessEnv>,
		deps: IParadisAntigravityUsageDeps = {},
	) {
		this.homedir = deps.homedir ?? os.homedir;
		this.now = deps.now ?? Date.now;
		this.resolveCommand = deps.resolveCommand ?? (env => paradisResolveAgentCli('agy', env));
		this.runCli = deps.runCli ?? paradisRunAgentCli;
		this.signInStamp = deps.signInStamp ?? defaultSignInStamp;
		this.workDir = deps.workDir ?? defaultWorkDir;
	}

	/**
	 * Antigravity の分。agy が見つからなければ undefined（パネルにもタイトルバーにも出さない）。
	 * @param bypassCache 手動の更新。待ちを無視して取り直す
	 */
	async fetch(bypassCache: boolean): Promise<IParadisLimitsProviderSnapshot | undefined> {
		const env = paradisDetachedAgentCliEnv(await this.getEnv());
		const command = await this.resolveCommand(env);
		if (command === undefined) {
			return undefined;
		}
		const account = await this.fetchAccount(command, env, bypassCache);
		return { accounts: [account] };
	}

	private async fetchAccount(command: string, env: NodeJS.ProcessEnv, bypassCache: boolean): Promise<IParadisLimitsAccount> {
		if (this.inflight) {
			return this.inflight;
		}
		const geminiDir = path.join(this.homedir(), '.gemini');
		const now = this.now();
		if (!bypassCache && this.last) {
			const recent = now - this.last.ranAt < MIN_RUN_INTERVAL_MS;
			const inFailureCooldown = this.failureAt !== undefined && now - this.failureAt < FAILURE_COOLDOWN_MS;
			const signedOut = this.signedOut;
			const inSignInBackoff = signedOut !== undefined && now - signedOut.at < FAILURE_COOLDOWN_MS && signedOut.stamp === await this.signInStamp(geminiDir);
			if (recent || inFailureCooldown || inSignInBackoff) {
				return this.last.account;
			}
		}
		const promise = this.run(command, env, geminiDir).finally(() => {
			if (this.inflight === promise) {
				this.inflight = undefined;
			}
		});
		this.inflight = promise;
		return promise;
	}

	private async run(command: string, env: NodeJS.ProcessEnv, geminiDir: string): Promise<IParadisLimitsAccount> {
		const base = { provider: 'antigravity' as const, id: geminiDir, homeLabel: '~/.gemini', active: true };
		const ranAt = this.now();
		let account: IParadisLimitsAccount;
		try {
			const result = await this.runCli(command, USAGE_ARGS, {
				env,
				cwd: await this.workDir(),
				timeoutMs: RUN_TIMEOUT_MS,
				stopWhen: paradisAntigravityNeedsSignIn,
			});
			const parsed = paradisParseAntigravityUsage(result.stdout, result.stderr);
			switch (parsed.kind) {
				case 'ok':
					account = { ...base, status: 'ok', fetchedAt: this.now(), scoped: parsed.windows };
					this.lastGood = account;
					this.failureAt = undefined;
					this.signedOut = undefined;
					break;
				case 'signed_out':
					account = { ...base, status: 'relogin_required', statusDetail: 'Antigravity CLI is not signed in' };
					this.failureAt = undefined;
					// agy はログインを待つ間に自分の置き場所へ書くので、止めた後の印を覚える
					this.signedOut = { at: this.now(), stamp: await this.signInStamp(geminiDir) };
					break;
				case 'error':
					account = this.failed(base, parsed.detail);
					break;
			}
		} catch (error) {
			account = this.failed(base, (error as Error).message);
		}
		this.last = { account, ranAt };
		return account;
	}

	/** 一時的な失敗。少し前に取れた値があれば「前の値」として出す（パネルは薄く出して古さを添える）。 */
	private failed(base: Pick<IParadisLimitsAccount, 'provider' | 'id' | 'homeLabel' | 'active'>, detail: string): IParadisLimitsAccount {
		this.failureAt = this.now();
		this.logService.trace(`[ParadisLimitsMonitor] agy /usage failed: ${detail}`);
		const previous = this.lastGood;
		if (previous?.fetchedAt !== undefined && this.now() - previous.fetchedAt < PREVIOUS_VALUE_MAX_AGE_MS) {
			return { ...previous, status: 'unavailable', unavailableReason: 'not_fetched', statusDetail: detail };
		}
		return { ...base, status: 'error', statusDetail: detail };
	}
}
