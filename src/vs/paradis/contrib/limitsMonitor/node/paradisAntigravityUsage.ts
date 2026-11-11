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
// - サインインしていないと答えたら、agy のログインの置き場所が変わるまで起こさない（時間では取り直さない。
//   Codex と違って agy は自分では直らず、サインインしていない agy はブラウザでログインのページを開こうとする
//   ことがある（Linux では開かないことを確かめた。macOS は未確認）ので、何度も起こさない）
// - 同時に起こすのは1本だけ（取り直しの最中に来た要求は相乗りする）
// - 手動の更新（bypassCache）は上の待ちを無視して取り直す
// サインインしていない agy はログインの URL を出して入力を待ち続けるので、その文が出た時点で止める。
// 自動の取得で agy を起こすのは、次のどれかに当てはまるときだけ（起動のたびに、使っていない人の agy を起こさないため）:
//   1. token のファイル（~/.gemini/antigravity-cli/antigravity-oauth-token）がある
//   2. Para Code が前に agy から値を取れたことがある（レンダラーが覚えて渡す。このプロセスで取れた場合も同じ）
//   3. history.jsonl か conversation_summaries.db があり空でない（agy を使った人。macOS ではログインがキーチェーンに
//      あって token のファイルが無い）。ただし前に自動で起こして「サインインしていない」と答えたときから、
//      これらのファイルの更新時刻と大きさが変わっていなければ起こさない（ログインのページを毎回開かないため）
// どれにも当てはまらなければ、手動の更新のときだけ起こす。ファイルはどれも中身を読まない（stat だけ）。
// agy は毎回 mkdtemp で作った自分だけの空のフォルダで動かし、終わったら消す（決まった名前の共有のフォルダだと、
// 同じマシンの別の人が先に作ったフォルダやリンクを作業場所として読ませられるため）。

import * as fs from 'fs';
import * as os from 'os';
import * as path from '../../../../base/common/path.js';
import { ILogService } from '../../../../platform/log/common/log.js';
import { IParadisRunAgentCliOptions, IParadisRunAgentCliResult, paradisDetachedAgentCliEnv, paradisResolveAgentCli, paradisRunAgentCli } from '../../../node/paradisAgentCli.js';
import { paradisAntigravityNeedsSignIn, paradisParseAntigravityUsage } from '../common/paradisAntigravityUsage.js';
import { IParadisAntigravityFetchHint, IParadisLimitsAccount, IParadisLimitsProviderSnapshot } from '../common/paradisLimitsMonitor.js';

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
	/** ログインの置き場所の様子（stat だけ。中身は読まない）。 */
	readonly signInFiles?: (geminiDir: string) => Promise<IParadisAntigravitySignInFiles>;
	/** agy を動かす空のフォルダを作る（終わったら dispose で消す）。 */
	readonly workDir?: () => Promise<IParadisAntigravityWorkDir>;
}

/** {@link ParadisAntigravityUsageFetcher.fetch} の結果。 */
export interface IParadisAntigravityUsage {
	/** 出す分。agy が無い・サインインしていない・枠が無いときは undefined。 */
	readonly snapshot?: IParadisLimitsProviderSnapshot;
	/** agy を起こしたら「サインインしていない」と答えた。そのときの印（レンダラーが覚えて、次から渡す）。 */
	readonly signedOutStamp?: string;
}

export interface IParadisAntigravityWorkDir {
	readonly path: string;
	dispose(): Promise<void>;
}

export interface IParadisAntigravitySignInFiles {
	/** token のファイルがある。 */
	readonly token: boolean;
	/** history.jsonl か conversation_summaries.db があり、空でない（agy を使ったことがある）。 */
	readonly used: boolean;
	/** これらのファイルの更新時刻と大きさをつないだ印（ログインし直した・使ったかを見る）。 */
	readonly stamp: string;
}

/** ログインの置き場所の様子。どのファイルも stat だけで、中身は読まない。 */
export async function paradisAntigravitySignInFiles(geminiDir: string): Promise<IParadisAntigravitySignInFiles> {
	const dir = path.join(geminiDir, 'antigravity-cli');
	const stats = await Promise.all(['antigravity-oauth-token', 'history.jsonl', 'conversation_summaries.db'].map(async name => {
		try {
			const stat = await fs.promises.stat(path.join(dir, name));
			return stat.isFile() ? stat : undefined;
		} catch {
			return undefined;
		}
	}));
	const [token, history, summaries] = stats;
	return {
		token: token !== undefined,
		used: (history?.size ?? 0) > 0 || (summaries?.size ?? 0) > 0,
		stamp: stats.map(stat => stat ? `${stat.mtimeMs}:${stat.size}` : '-').join('|'),
	};
}

/**
 * agy を動かす空のフォルダを作る。ホームやリポジトリで動かすと、agy がそのフォルダを作業場所として扱いうるので、
 * 毎回 mkdtemp で自分だけ（0700）の新しいフォルダを作り、終わったら消す。
 */
export async function paradisCreateAntigravityWorkDir(parent: string = os.tmpdir()): Promise<IParadisAntigravityWorkDir> {
	const dir = await fs.promises.mkdtemp(path.join(parent, 'para-code-agy-usage-'));
	return {
		path: dir,
		dispose: () => fs.promises.rm(dir, { recursive: true, force: true }).catch(() => undefined),
	};
}

export class ParadisAntigravityUsageFetcher {

	private readonly homedir: () => string;
	private readonly now: () => number;
	private readonly resolveCommand: (env: NodeJS.ProcessEnv) => Promise<string | undefined>;
	private readonly runCli: ParadisAntigravityCliRunner;
	private readonly signInFiles: (geminiDir: string) => Promise<IParadisAntigravitySignInFiles>;
	private readonly workDir: () => Promise<IParadisAntigravityWorkDir>;

	/** 最後に返したアカウントと、agy を起こした時刻。 */
	private last: { readonly account: IParadisLimitsAccount; readonly ranAt: number } | undefined;
	/** 最後に値が取れたアカウント（失敗したときに「前の値」として出す）。 */
	private lastGood: IParadisLimitsAccount | undefined;
	private failureAt: number | undefined;
	private signedOut: { readonly stamp: string } | undefined;
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
		this.signInFiles = deps.signInFiles ?? paradisAntigravitySignInFiles;
		this.workDir = deps.workDir ?? (() => paradisCreateAntigravityWorkDir());
	}

	/**
	 * Antigravity の分。agy が見つからない・サインインしていないときは undefined（パネルにもタイトルバーにも出さない。
	 * agy を入れただけで使っていない人に、直し方の列や赤い輪を出し続けないため）。
	 * @param bypassCache 手動の更新。待ちを無視して取り直す（サインインの手がかりが無くても agy を起こす）
	 * @param hint レンダラーが覚えている、自動で取りに行ってよいかの手がかり
	 */
	async fetch(bypassCache: boolean, hint: IParadisAntigravityFetchHint = {}): Promise<IParadisAntigravityUsage> {
		const env = paradisDetachedAgentCliEnv(await this.getEnv());
		const command = await this.resolveCommand(env);
		if (command === undefined) {
			return {};
		}
		const account = await this.fetchAccount(command, env, bypassCache, hint);
		// サインインしていなければ出さない。手動の更新か、ログインの置き場所が変わったときに取り直し、サインインしていれば出す
		if (account.status === 'relogin_required') {
			return this.signedOut ? { signedOutStamp: this.signedOut.stamp } : {};
		}
		// 取れても枠が1つも無ければ出さない（空の列を出さない）
		if (account.status === 'ok' && (account.scoped ?? []).length === 0) {
			return {};
		}
		return { snapshot: { accounts: [account] } };
	}

	private async fetchAccount(command: string, env: NodeJS.ProcessEnv, bypassCache: boolean, hint: IParadisAntigravityFetchHint): Promise<IParadisLimitsAccount> {
		if (this.inflight) {
			return this.inflight;
		}
		const geminiDir = path.join(this.homedir(), '.gemini');
		const now = this.now();
		if (!bypassCache) {
			const files = await this.signInFiles(geminiDir);
			// 前に「サインインしていない」と答えたときから、ログインの置き場所が変わっていなければ起こさない
			const signedOutStamp = this.signedOut?.stamp ?? hint.signedOutStamp;
			const seen = hint.seen === true || this.lastGood !== undefined;
			if (signedOutStamp === files.stamp || !(files.token || seen || files.used)) {
				return this.last?.account.status === 'relogin_required' ? this.last.account : { ...this.base(geminiDir), status: 'relogin_required', statusDetail: 'Antigravity CLI is not signed in' };
			}
			if (this.last) {
				const recent = now - this.last.ranAt < MIN_RUN_INTERVAL_MS;
				const inFailureCooldown = this.failureAt !== undefined && now - this.failureAt < FAILURE_COOLDOWN_MS;
				if (recent || inFailureCooldown) {
					return this.last.account;
				}
			}
		}
		// 上の確かめの途中（await の間）に別の要求が起こしていれば、それに相乗りする
		if (this.inflight) {
			return this.inflight;
		}
		const promise = this.run(command, env, geminiDir).finally(() => {
			if (this.inflight === promise) {
				this.inflight = undefined;
			}
		});
		this.inflight = promise;
		return promise;
	}

	private base(geminiDir: string): Pick<IParadisLimitsAccount, 'provider' | 'id' | 'homeLabel' | 'active'> {
		return { provider: 'antigravity', id: geminiDir, homeLabel: '~/.gemini', active: true };
	}

	private async run(command: string, env: NodeJS.ProcessEnv, geminiDir: string): Promise<IParadisLimitsAccount> {
		const base = this.base(geminiDir);
		const ranAt = this.now();
		let account: IParadisLimitsAccount;
		try {
			const workDir = await this.workDir();
			let result: IParadisRunAgentCliResult;
			try {
				result = await this.runCli(command, USAGE_ARGS, {
					env,
					cwd: workDir.path,
					timeoutMs: RUN_TIMEOUT_MS,
					stopWhen: paradisAntigravityNeedsSignIn,
				});
			} finally {
				await workDir.dispose();
			}
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
					this.signedOut = { stamp: (await this.signInFiles(geminiDir)).stamp };
					// 前に取れた印も外す（サインインし直すまで、手がかり 2 では起こさない）
					this.lastGood = undefined;
					break;
				case 'error':
					account = this.failed(base, parsed.detail);
					break;
			}
		} catch (error) {
			// 失敗の文（パネル・モバイルへ出る）には実行ファイルの絶対パスを含めない
			account = this.failed(base, ((error as Error).message ?? '').split(command).join('agy'));
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
