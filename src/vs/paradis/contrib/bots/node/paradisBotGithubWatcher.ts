/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

// Bot の GitHub の見張り（shared process に 1 つ）。手元の gh で GraphQL を 1 回ずつ読み、自分宛ての新着で
// 見張っている Bot の見回りを起こす。項目に結んだ PR の状態も同じ回で読み、画面へ出す。
//
// - タイマーは 1 本。設定 `paradis.bots.enabled` がオフか、見張る Bot（一時停止を除く）がいなければ立てず、gh も呼ばない
// - 見張りを始めた最初の回は、今あるものを見たことにするだけ（溜まっている分で一斉に起こさない）
// - 起こすのは見回り（読むだけ）で、Bot ごとに間隔と 1 日の回数の上限がある（外の人がレビューの依頼で起こせるため）
// - GitHub の枠を使い切ったら、ほかの gh と同じ台帳（paradisGithubRateLimitPause）でリセットまで止める
// - gh が無い・ログインしていないときは静かに止め、理由を画面向けの様子に出す。Bot の入り切りか設定を変えるか、
//   再起動するまで読み直さない
// - トークンは gh が持ち、ここでは扱わない。gh の出力はログに出さない（失敗の文は切ってから様子に出す）

import * as cp from 'child_process';
import { Disposable, IDisposable, MutableDisposable } from '../../../../base/common/lifecycle.js';
import { IConfigurationService } from '../../../../platform/configuration/common/configuration.js';
import { NativeParsedArgs } from '../../../../platform/environment/common/argv.js';
import { ILogService } from '../../../../platform/log/common/log.js';
import { createParadisShellEnvResolver, ParadisCachedShellEnv } from '../../../../platform/shell/node/paradisCachedShellEnv.js';
import { reportParadisShellEnvDiagnosticError } from '../../sentry/common/paradisSentryDiagnostics.js';
import { paradisIsGithubRateLimitMessage, paradisRecordGithubCall, paradisTruncateGithubErrorMessage } from '../../githubMetrics/common/paradisGithubMetrics.js';
import { ParadisGithubRateLimitPause } from '../../githubMetrics/common/paradisGithubRateLimitPause.js';
import { IParadisBot } from '../common/paradisBots.js';
import {
	IParadisBotGithubNotice,
	IParadisBotGithubPullRequest,
	IParadisBotGithubView,
	PARADIS_BOT_GITHUB_LIMITS,
	PARADIS_BOT_GITHUB_MAX_BACKOFF_MS,
	PARADIS_BOT_GITHUB_OFF_VIEW,
	PARADIS_BOT_GITHUB_POLL_MS,
	PARADIS_BOT_GITHUB_START_DELAY_MS,
	ParadisBotGithubStatus,
	paradisBotGithubDiff,
	paradisBotGithubMayWake,
	paradisBotGithubParseResponse,
	paradisBotGithubQuery,
} from '../common/paradisBotGithub.js';

/** gh を 1 回起動した結果。 */
export interface IParadisBotGhOutput {
	readonly stdout: string;
	readonly stderr: string;
	readonly failed: boolean;
	/** gh が無い（ENOENT）。 */
	readonly notFound: boolean;
	readonly timedOut: boolean;
}

export type ParadisBotGhRunner = (args: readonly string[]) => Promise<IParadisBotGhOutput>;

export interface IParadisBotGithubWatcherOptions {
	/** Bot の機能（`paradis.bots.enabled`）がオンか。 */
	readonly enabled: () => boolean;
	readonly bots: () => readonly IParadisBot[];
	/** 状態を読む PR（見張る Bot の開いている項目に結んだ `owner/repo#n`）。 */
	readonly pullRequestRefs: () => readonly string[];
	readonly runGh: ParadisBotGhRunner;
	readonly rateLimitPause: ParadisGithubRateLimitPause;
	/** Bot の見回りを今すぐ走らせる。走らせたら true（見回りが無い・動いている最中なら false）。 */
	readonly wake: (botId: string) => Promise<boolean>;
	/** 画面向けの様子が変わった。 */
	readonly publish: (view: IParadisBotGithubView) => void;
	readonly now?: () => number;
	readonly setTimer?: (callback: () => void, ms: number) => IDisposable;
	readonly recordCall?: typeof paradisRecordGithubCall;
}

const CALL_SITE = 'gh api graphql (bot github)';
const GH_TIMEOUT_MS = 30_000;
const GH_MAX_BUFFER = 4 * 1024 * 1024;

/**
 * gh を手元のログインシェルの env で起動する口を作る（「タスク」の画面の gh と同じやり方。あちらの口は contribution の
 * ファイルの中にあり、読み込むと登録の副作用ごと読むので、同じ形をここに置く）。env は最初に gh を呼ぶときまで解決しない。
 */
export function createParadisBotGhRunner(logService: ILogService, configurationService: IConfigurationService, args: NativeParsedArgs): ParadisBotGhRunner {
	let shellEnv: ParadisCachedShellEnv | undefined;
	return async ghArgs => {
		shellEnv ??= new ParadisCachedShellEnv(logService, 'ParadisBotsGithub', createParadisShellEnvResolver(logService, configurationService, args), Date.now, reportParadisShellEnvDiagnosticError);
		const env = await shellEnv.getEnv();
		return new Promise<IParadisBotGhOutput>(resolve => {
			cp.execFile('gh', [...ghArgs], {
				encoding: 'utf8',
				timeout: GH_TIMEOUT_MS,
				maxBuffer: GH_MAX_BUFFER,
				killSignal: 'SIGKILL',
				windowsHide: true,
				env: { ...env, GH_PROMPT_DISABLED: '1', GH_NO_UPDATE_NOTIFIER: '1' },
			}, (err, stdout, stderr) => {
				const notFound = (err as { code?: unknown } | null)?.code === 'ENOENT';
				// execFile の timeout で止めたときは killed が立つ（SIGKILL）
				const timedOut = Boolean(err && (err as { killed?: boolean }).killed);
				resolve({ stdout: stdout ?? '', stderr: stderr ?? (err?.message ?? ''), failed: Boolean(err), notFound, timedOut });
			});
		});
	};
}

function defaultTimer(callback: () => void, ms: number): IDisposable {
	const handle = setTimeout(callback, ms);
	return { dispose: () => clearTimeout(handle) };
}

export class ParadisBotGithubWatcher extends Disposable {

	private readonly timer = this._register(new MutableDisposable());
	private readonly now: () => number;
	private readonly setTimer: (callback: () => void, ms: number) => IDisposable;
	private readonly recordCall: typeof paradisRecordGithubCall;

	/** 見張っている Bot の id（並べた文字列。入り切りが変わったかを見る）。空なら止まっている。 */
	private watching = '';
	/** 次の回は印を付けるだけ（見張りを始めた最初の回）。 */
	private baseline = true;
	/** gh が無い・ログインしていないので止めている。 */
	private halted = false;
	private polling = false;
	private failures = 0;
	private seen = new Map<string, number>();
	private notices: IParadisBotGithubNotice[] = [];
	private readonly wakes = new Map<string, number[]>();
	private view: IParadisBotGithubView = PARADIS_BOT_GITHUB_OFF_VIEW;

	constructor(private readonly options: IParadisBotGithubWatcherOptions) {
		super();
		this.now = options.now ?? Date.now;
		this.setTimer = options.setTimer ?? defaultTimer;
		this.recordCall = options.recordCall ?? paradisRecordGithubCall;
	}

	/** 今の様子と PR の状態。 */
	getView(): IParadisBotGithubView {
		return this.view;
	}

	/** Bot が読める新着（新しい順ではなく見つけた順。古いものは落としてある）。 */
	getNotices(): readonly IParadisBotGithubNotice[] {
		const now = this.now();
		return this.notices.filter(notice => now - notice.at <= PARADIS_BOT_GITHUB_LIMITS.noticeMs);
	}

	/** 設定か Bot の台帳が変わった。見張る Bot の入り切りに合わせてタイマーを立てる・止める。 */
	refresh(): void {
		const watchers = this.options.enabled() ? this.watchers().map(bot => bot.id).sort().join(',') : '';
		if (watchers === this.watching) {
			return;
		}
		const starting = this.watching === '';
		this.watching = watchers;
		if (watchers === '') {
			// 止めた。次に始めるときは、溜まっている分で起こさないよう印を付け直す
			this.timer.clear();
			this.baseline = true;
			this.halted = false;
			this.failures = 0;
			this.notices = [];
			this.setView(PARADIS_BOT_GITHUB_OFF_VIEW);
			return;
		}
		if (starting) {
			this.baseline = true;
		}
		// 入り切りが変わったら、gh が無い・ログインしていないで止めていたのも読み直す
		this.halted = false;
		this.failures = 0;
		this.schedule(PARADIS_BOT_GITHUB_START_DELAY_MS);
	}

	private watchers(): IParadisBot[] {
		return this.options.bots().filter(bot => bot.watchGithub === true && !bot.paused && bot.preserved === undefined);
	}

	private schedule(ms: number): void {
		this.timer.value = this.setTimer(() => {
			this.timer.clear();
			void this.poll();
		}, Math.max(0, ms));
	}

	private setView(view: IParadisBotGithubView): void {
		if (JSON.stringify(view) === JSON.stringify(this.view)) {
			return;
		}
		this.view = view;
		this.options.publish(view);
	}

	private setStatus(status: ParadisBotGithubStatus, pullRequests: Readonly<Record<string, IParadisBotGithubPullRequest>> = this.view.pullRequests): void {
		this.setView({ status, pullRequests });
	}

	/** 失敗が続くほど間隔を伸ばして読み直す。 */
	private retryLater(message: string): void {
		this.failures++;
		const delay = Math.min(PARADIS_BOT_GITHUB_POLL_MS * 2 ** (this.failures - 1), PARADIS_BOT_GITHUB_MAX_BACKOFF_MS);
		this.setStatus({ state: 'failed', message: paradisTruncateGithubErrorMessage(message), retryAt: this.now() + delay });
		this.schedule(delay);
	}

	/** 1 回読む。テストからも呼ぶ。 */
	async poll(): Promise<void> {
		if (this.polling || this.watching === '' || this.halted) {
			return;
		}
		this.polling = true;
		const watching = this.watching;
		try {
			await this.pollOnce(watching);
		} finally {
			this.polling = false;
		}
	}

	private async pollOnce(watching: string): Promise<void> {
		const pausedUntil = this.options.rateLimitPause.pausedUntilFor('', 'graphql');
		if (pausedUntil !== undefined) {
			this.setStatus({ state: 'rate-limited', retryAt: pausedUntil });
			this.schedule(pausedUntil - this.now());
			return;
		}
		const refs = this.options.pullRequestRefs();
		const { query, variables } = paradisBotGithubQuery(refs);
		const args = ['api', 'graphql', '-f', `query=${query}`];
		for (const [name, value] of Object.entries(variables)) {
			args.push(typeof value === 'number' ? '-F' : '-f', `${name}=${value}`);
		}
		const startedAt = this.now();
		let output: IParadisBotGhOutput;
		try {
			output = await this.options.runGh(args);
		} catch (error) {
			output = { stdout: '', stderr: error instanceof Error ? error.message : String(error), failed: true, notFound: false, timedOut: false };
		}
		// 読んでいる間に止めた・入り切りが変わった。結果は捨てる（入り切りが変わったときは refresh が次を立ててある）
		if (this.watching !== watching || this._store.isDisposed) {
			return;
		}
		const record = (success: boolean, rateLimited: boolean, errorMessage?: string) => this.recordCall({ at: this.now(), callSite: CALL_SITE, resource: 'graphql', durationMs: this.now() - startedAt, success, rateLimited, ...(errorMessage !== undefined ? { errorMessage } : {}) });
		if (output.notFound) {
			this.halted = true;
			this.setStatus({ state: 'no-gh' });
			return;
		}
		if (output.timedOut) {
			record(false, false, 'gh did not answer in time');
			this.retryLater('gh did not answer in time');
			return;
		}
		let envelope: { data?: unknown; errors?: readonly { type?: unknown; message?: unknown }[] } | undefined;
		try {
			envelope = output.stdout.trim() ? JSON.parse(output.stdout) : undefined;
		} catch {
			envelope = undefined;
		}
		const errorText = [output.stderr, ...(Array.isArray(envelope?.errors) ? envelope.errors : []).map(error => `${typeof error?.type === 'string' ? error.type : ''} ${typeof error?.message === 'string' ? error.message : ''}`)].join('\n').trim();
		const parsed = envelope?.data !== undefined ? paradisBotGithubParseResponse(envelope.data, refs) : undefined;
		if (parsed === undefined) {
			const message = paradisTruncateGithubErrorMessage(errorText || 'GitHub returned no result');
			const rateLimited = paradisIsGithubRateLimitMessage(errorText);
			record(false, rateLimited, message);
			if (rateLimited) {
				const retryAt = this.options.rateLimitPause.noteRateLimited('', 'graphql');
				this.setStatus({ state: 'rate-limited', retryAt });
				this.schedule(retryAt - this.now());
				return;
			}
			if (/gh auth login|not logged in|authentication|\bHTTP 401\b|bad credentials/i.test(errorText)) {
				this.halted = true;
				this.setStatus({ state: 'auth', message });
				return;
			}
			// 検索が読めない部分的な応答も含む（見た印は変えない）
			this.retryLater(message);
			return;
		}
		record(true, false);
		if (parsed.rateLimit) {
			this.options.rateLimitPause.noteRateLimits([{ resource: 'graphql', limit: parsed.rateLimit.limit, used: parsed.rateLimit.limit - parsed.rateLimit.remaining, remaining: parsed.rateLimit.remaining, resetAt: parsed.rateLimit.resetAt }]);
		}
		const now = this.now();
		const { seen, fresh } = paradisBotGithubDiff(this.seen, parsed.found, now, this.baseline);
		this.seen = seen;
		this.baseline = false;
		this.failures = 0;
		this.notices = [...this.notices, ...fresh].filter(notice => now - notice.at <= PARADIS_BOT_GITHUB_LIMITS.noticeMs).slice(-PARADIS_BOT_GITHUB_LIMITS.notices);
		this.setStatus({ state: 'ok', checkedAt: now }, parsed.pullRequests);
		this.schedule(PARADIS_BOT_GITHUB_POLL_MS);
		if (fresh.length > 0) {
			await this.wakeWatchers(now);
		}
	}

	/** 新着があった。見張っている Bot の見回りを、間隔と 1 日の回数の上限の中で起こす。 */
	private async wakeWatchers(now: number): Promise<void> {
		for (const bot of this.watchers()) {
			const wakes = (this.wakes.get(bot.id) ?? []).filter(at => now - at < 24 * 60 * 60_000);
			if (!paradisBotGithubMayWake(wakes, now)) {
				continue;
			}
			let woke = false;
			try {
				woke = await this.options.wake(bot.id);
			} catch {
				woke = false;
			}
			// 見回りが無い・動いている最中なら起こさずに貯めるだけ（新着は次の見回りで読める）
			this.wakes.set(bot.id, woke ? [...wakes, now] : wakes);
		}
	}
}
