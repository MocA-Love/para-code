/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-PATCH/PARA-CODE コメント)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

// GitHub API 利用状況の収集バックエンド（shared process）。
// - アカウント全体のレート枠は、実リクエストのレスポンスヘッダ `X-RateLimit-*` から取得する
//   （`gh api rate_limit` のボディは 2026-09 時点で常に「未使用の新しい窓」を返し使えない。NOTES.md 参照）
// - Para Code 自身の gh 呼び出しは common 側の記録シンク(paradisRecordGithubCall)に集まる。
//   ここでその受け口(ParadisGithubCallLog)を用意し、スナップショットとして renderer へ返す。
// gh CLI 実行という点で workspaceSwitch/node/paradisWorktreeGitChannel.ts と同じ流儀
// （cp.execFile 直叩き + ログインシェル env のキャッシュ）に揃えている。

import * as cp from 'child_process';
import { Event } from '../../../../base/common/event.js';
import { IDisposable } from '../../../../base/common/lifecycle.js';
import { IPCServer, IServerChannel } from '../../../../base/parts/ipc/common/ipc.js';
import { localize } from '../../../../nls.js';
import { NativeParsedArgs } from '../../../../platform/environment/common/argv.js';
import { IConfigurationService } from '../../../../platform/configuration/common/configuration.js';
import { ILogService } from '../../../../platform/log/common/log.js';
import { createParadisShellEnvResolver, ParadisCachedShellEnv, ParadisRawShellEnvResolver } from '../../../../platform/shell/node/paradisCachedShellEnv.js';
import { reportParadisShellEnvDiagnosticError } from '../../sentry/common/paradisSentryDiagnostics.js';
import {
	IParadisGithubCallEvent,
	IParadisGithubMetricsSnapshot,
	IParadisGithubRateLimitEntry,
	paradisClearGithubCallSink,
	paradisCoerceGithubCallEvent,
	paradisIsGithubRateLimitMessage,
	paradisParseGhRateLimitHeaders,
	paradisSetGithubCallSink,
	paradisTruncateGithubErrorMessage,
	ParadisGithubCallLog,
	ParadisGithubRateLimitHistory,
	PARADIS_GITHUB_METRICS_CHANNEL,
	PARADIS_GITHUB_MONITOR_SPACE,
} from '../common/paradisGithubMetrics.js';

/**
 * レート枠の再取得を抑える最短間隔。renderer 側の最短ポーリング間隔（ダッシュボード表示中の60秒）
 * 以下かつ十分長い値にして、ウィンドウやエディタが複数開いていても gh の起動回数が
 * その数に比例しないようにする。
 * プローブ自体が資源ごとに枠を1消費するため、この間隔がそのまま監視のコストの上限になる
 * （45秒間隔まで縮んだ場合で core/graphql それぞれ1時間あたり80消費＝5000枠の1.6%。
 * ウィンドウ1つなら renderer の2分間隔どおりで30消費＝0.6%）。
 */
const RATE_LIMIT_MIN_REFRESH_MS = 45_000;
/** gh の実行タイムアウト。ネットワーク I/O のため必須。 */
const GH_TIMEOUT_MS = 15_000;
/** 連続失敗時のバックオフ（未認証環境などで gh を起動し続けないための上限つき指数バックオフ）。 */
const FAILURE_BACKOFF_START_MS = 60_000;
const FAILURE_BACKOFF_MAX_MS = 15 * 60_000;

/** `gh` の実行結果。HTTP エラーでも stdout を捨てないため、成功・失敗を1つの型で表す。 */
interface IParadisGhResult {
	readonly stdout: string;
	/** gh が非0終了したときの表示用メッセージ。正常終了なら未設定。 */
	readonly errorMessage?: string;
}

/**
 * レート枠を読むためのプローブ。`gh api -i` でレスポンスヘッダごと受け取り、`X-RateLimit-*` を読む。
 *
 * REST(core)とGraphQLは枠が別なので、資源ごとに1本ずつ最も軽い呼び出しを投げる。
 * core は本文を捨てられる HEAD、GraphQL は最小のクエリ。どちらも枠を1消費するため、
 * 呼び出し内訳にも `callSite` を付けて出す（監視自身の消費をユーザーが識別できるようにする）。
 */
interface IParadisRateLimitProbe {
	readonly resource: 'core' | 'graphql';
	readonly args: readonly string[];
	readonly callSite: string;
}

const RATE_LIMIT_PROBES: readonly IParadisRateLimitProbe[] = [
	{ resource: 'core', args: ['api', '--method', 'HEAD', 'user', '-i'], callSite: 'gh api user (rate limit probe)' },
	{ resource: 'graphql', args: ['api', 'graphql', '-i', '-f', 'query={viewer{login}}'], callSite: 'gh api graphql (rate limit probe)' },
];

export interface IParadisGithubMetricsRequestOptions {
	/** true なら最短間隔を無視して取り直す（UI の「更新」ボタン）。 */
	readonly force?: boolean;
}

export class ParadisGithubMetricsService {

	private readonly cachedShellEnv: ParadisCachedShellEnv;
	private readonly callLog: ParadisGithubCallLog;
	private readonly history = new ParadisGithubRateLimitHistory();

	private rateLimits: readonly IParadisGithubRateLimitEntry[] = [];
	private rateLimitFetchedAt: number | undefined;
	private rateLimitError: string | undefined;
	private ghAvailable = true;
	private inFlight: Promise<void> | undefined;
	private consecutiveFailures = 0;

	constructor(
		private readonly logService: ILogService,
		configurationService?: IConfigurationService,
		args?: NativeParsedArgs,
		private readonly execFile: typeof cp.execFile = cp.execFile,
		private readonly now: () => number = Date.now,
		shellEnvResolver?: ParadisRawShellEnvResolver,
	) {
		this.cachedShellEnv = new ParadisCachedShellEnv(
			logService,
			'ParadisGithubMetrics',
			shellEnvResolver ?? createParadisShellEnvResolver(logService, configurationService, args),
			this.now,
			reportParadisShellEnvDiagnosticError,
		);
		this.callLog = new ParadisGithubCallLog(this.now());
		// Para Code 内の他の gh 呼び出し（worktree の PR 状態取得など）をここへ集める
		paradisSetGithubCallSink(this.callLog);
	}

	dispose(): void {
		paradisClearGithubCallSink(this.callLog);
	}

	async getSnapshot(options: IParadisGithubMetricsRequestOptions = {}): Promise<IParadisGithubMetricsSnapshot> {
		await this.refreshRateLimits(options.force === true);

		const now = this.now();
		const { operations, spaces, totals, lastErrors } = this.callLog.snapshot(now);
		return {
			generatedAt: now,
			sessionStartedAt: this.callLog.sessionStartedAt,
			ghAvailable: this.ghAvailable,
			rateLimitError: this.rateLimitError,
			rateLimitFetchedAt: this.rateLimitFetchedAt,
			rateLimits: this.rateLimits,
			consumption: this.history.consumption(now),
			operations,
			spaces,
			totals,
			lastErrors,
		};
	}

	/**
	 * 別プロセス（Agent Sessionsウィンドウ等）からIPC経由で転送された gh 呼び出しを記録する。
	 * 同一プロセス側の paradisRecordGithubCall と違い、こちらは常にこのサービスの callLog へ直接書く
	 * （転送元は常にこのサービスと同じ shared process インスタンスへ届くため）。
	 */
	recordCall(event: IParadisGithubCallEvent): void {
		this.callLog.record(event);
	}

	private async refreshRateLimits(force: boolean): Promise<void> {
		// gh 未インストールと判定済みでも、明示的な更新操作のときだけは再確認する
		// （後からインストールした場合にアプリの再起動を強いない）
		if (!this.ghAvailable && !force) {
			return;
		}
		if (!force && this.rateLimitFetchedAt !== undefined && this.now() - this.rateLimitFetchedAt < this.minRefreshIntervalMs()) {
			return;
		}
		// 同時に複数ウィンドウから呼ばれても、プローブ一式は1回しか走らせない
		if (!this.inFlight) {
			this.inFlight = this.fetchRateLimits().finally(() => {
				this.inFlight = undefined;
			});
		}
		await this.inFlight;
	}

	/** 連続失敗中は指数バックオフで間隔を伸ばす（未認証環境で gh を起動し続けない）。 */
	private minRefreshIntervalMs(): number {
		if (this.consecutiveFailures === 0) {
			return RATE_LIMIT_MIN_REFRESH_MS;
		}
		const backoff = FAILURE_BACKOFF_START_MS * Math.pow(2, this.consecutiveFailures - 1);
		return Math.min(FAILURE_BACKOFF_MAX_MS, backoff);
	}

	/**
	 * レート枠を取り直す。
	 * 資源ごとのプローブを並行に投げ、取れた資源だけを差し替える。片方が失敗した回は、
	 * その資源だけ前回の値を残す（配列ごと入れ替えると、生きている資源の行まで UI から消える）。
	 */
	private async fetchRateLimits(): Promise<void> {
		const results = await Promise.all(RATE_LIMIT_PROBES.map(probe => this.probeRateLimit(probe)));
		const finishedAt = this.now();

		const entries: IParadisGithubRateLimitEntry[] = [];
		const errors: string[] = [];
		for (const result of results) {
			if (typeof result === 'string') {
				errors.push(result);
			} else {
				entries.push(result);
			}
		}

		if (entries.length === 0) {
			this.consecutiveFailures++;
		} else {
			this.consecutiveFailures = 0;
			// リセット時刻を過ぎた前回値は残さない。窓が回った後の remaining は意味を持たず、
			// 残すとステータスバーの%と警告色が古い値のまま固まる（取得できない資源は行ごと消える）
			const merged = new Map(this.rateLimits
				.filter(entry => entry.resetAt > finishedAt)
				.map(entry => [entry.resource, entry]));
			for (const entry of entries) {
				merged.set(entry.resource, entry);
			}
			// 表示順はプローブの定義順（core → graphql）に固定する
			this.rateLimits = RATE_LIMIT_PROBES
				.map(probe => merged.get(probe.resource))
				.filter((entry): entry is IParadisGithubRateLimitEntry => !!entry);
			// 履歴には取れたものだけを入れる。前回値を今回の時刻で入れ直すと、
			// 実測していない区間を「消費0」として記録することになる
			this.history.record(entries, finishedAt);
		}
		// 片方だけ失敗したときも、その資源の値が古いままである理由を UI に出す
		this.rateLimitError = errors[0];
		this.rateLimitFetchedAt = finishedAt;
	}

	/** プローブ1本。成功ならエントリ、失敗なら表示用のメッセージを返す。 */
	private async probeRateLimit(probe: IParadisRateLimitProbe): Promise<IParadisGithubRateLimitEntry | string> {
		const startedAt = this.now();
		let result: IParadisGhResult;
		try {
			result = await this.execGh([...probe.args]);
		} catch (error) {
			// シェル環境の解決に失敗した場合など、gh を起動できなかったとき
			return paradisTruncateGithubErrorMessage(error instanceof Error ? error.message : String(error));
		}

		// 枠を使い切ると gh は HTTP 403 で非0終了するが、そのレスポンスにも X-RateLimit-* は載っている。
		// 終了コードだけを見て捨てると、残量0とリセット時刻という一番知りたい情報を落としてしまう。
		const entry = paradisParseGhRateLimitHeaders(result.stdout, probe.resource);

		// ヘッダが読めた呼び出しだけを記録する。プローブは枠を消費するので内訳に出すが、
		// gh 不在・未認証・ネットワーク断のように枠を使っていない失敗まで記録すると、
		// lastErrors がプローブのエラーで埋まり、ユーザー自身の gh の失敗が押し出される。
		// 代わりに「届いたがヘッダを読めなかった」失敗（プロキシの5xx、送信後のタイムアウト）は
		// 枠を消費していても内訳から漏れる。件数が少ないので、この取りこぼしは許容する。
		if (entry) {
			this.callLog.record({
				at: this.now(),
				callSite: probe.callSite,
				// worktree に紐付かないが、Agent Sessions ウィンドウの消費とも混ぜない
				worktreePath: PARADIS_GITHUB_MONITOR_SPACE,
				resource: probe.resource,
				durationMs: this.now() - startedAt,
				success: result.errorMessage === undefined,
				rateLimited: paradisIsGithubRateLimitMessage(result.errorMessage),
				errorMessage: result.errorMessage,
			});
			return entry;
		}

		const message = result.errorMessage
			?? localize('paradis.githubMetrics.unexpectedResponse', "`{0}` の応答にレート制限のヘッダがありません", `gh ${probe.args.join(' ')}`);
		this.logService.trace(`[ParadisGithubMetrics] gh ${probe.args.join(' ')} failed (${this.consecutiveFailures + 1} in a row): ${message}`);
		return message;
	}

	/**
	 * gh を実行する。`gh api -i` は HTTP エラーでも非0終了しつつヘッダを stdout に出すため、
	 * 失敗しても stdout を捨てずに返す（呼び出し側が X-RateLimit-* を読めるようにする）。
	 * gh を起動できなかったときだけ reject する。
	 */
	private async execGh(args: string[]): Promise<IParadisGhResult> {
		const env = await this.cachedShellEnv.getEnv();
		return new Promise<IParadisGhResult>((resolve, reject) => {
			this.execFile('gh', args, {
				encoding: 'utf8',
				timeout: GH_TIMEOUT_MS,
				killSignal: 'SIGKILL',
				windowsHide: true,
				env: { ...env, GH_PROMPT_DISABLED: '1', GH_NO_UPDATE_NOTIFIER: '1' },
			}, (err, stdout, stderr) => {
				if (err) {
					if ((err as { code?: unknown }).code === 'ENOENT') {
						// gh 未インストール。以降は起動を繰り返さない
						this.ghAvailable = false;
						reject(new Error(stderr?.trim() || err.message));
						return;
					}
					// 起動はできている（HTTP エラー・タイムアウト等）
					this.ghAvailable = true;
					// gh の stderr がそのまま入るため、UI へ出す前にここで丸める（呼び出しログと同じ上限）
					resolve({ stdout: stdout ?? '', errorMessage: paradisTruncateGithubErrorMessage(stderr?.trim() || err.message) });
				} else {
					// 実行できたなら「未インストール」判定は取り消す
					this.ghAvailable = true;
					resolve({ stdout });
				}
			});
		});
	}
}

// ccusage / rtk と同じく、shared process と接続先(REH)の双方へ同じ形で生やす。
export class ParadisGithubMetricsChannel<TContext = string> implements IServerChannel<TContext> {

	constructor(private readonly service: ParadisGithubMetricsService) { }

	listen<T>(_ctx: TContext, event: string): Event<T> {
		throw new Error(`Event not found: ${event}`);
	}

	call<T>(_ctx: TContext, command: string, arg?: unknown): Promise<T> {
		const args = Array.isArray(arg) ? arg : [];
		switch (command) {
			case 'getSnapshot': return this.service.getSnapshot((args[0] ?? {}) as IParadisGithubMetricsRequestOptions) as Promise<T>;
			case 'recordCall': {
				// 別プロセス(Agent Sessionsウィンドウ)からのIPC入力なので、記録前に必ず検証する
				const event = paradisCoerceGithubCallEvent(args[0]);
				if (event) {
					this.service.recordCall(event);
				}
				return Promise.resolve(undefined as T);
			}
			default:
				throw new Error(`Method not found: ${command}`);
		}
	}
}

/**
 * sharedProcessMain.ts の PARA-PATCH 点から1行で呼べるファクトリ。
 */
export function registerParadisGithubMetrics(server: IPCServer<string>, logService: ILogService, configurationService: IConfigurationService, args: NativeParsedArgs): IDisposable {
	const service = new ParadisGithubMetricsService(logService, configurationService, args);
	server.registerChannel(PARADIS_GITHUB_METRICS_CHANNEL, new ParadisGithubMetricsChannel(service));
	return { dispose: () => service.dispose() };
}

/**
 * serverServices.ts(REH)の登録点から1行で呼べるファクトリ。
 *
 * 記録シンク(paradisSetGithubCallSink)はプロセスごとのモジュール変数なので、shared process で
 * 差しても接続先のプロセスには届かない。接続している間、worktree の PR 状態取得などの gh は
 * すべて接続先で走る(paradisWorktreeGitChannel の server 版)ため、ここでサービスを立てて
 * シンクを差さないと、その間の呼び出しは1件残らず捨てられる。
 *
 * レート枠も gh の認証情報も接続先のものなので、クライアントは接続中このチャネルへ聞く
 * (ccusage / rtk / hostResources と同じ振り分け)。サーバー側は configurationService/args を
 * 持たないため、シェル環境の解決は行わずサーバープロセスが継承した PATH をそのまま使う。
 * このサービスは要求されたときにしか gh を起動しない(定期処理を持たない)ので、接続が切れた
 * あとサーバーが延命されても裏で動き続けることはない。
 */
export function registerParadisGithubMetricsForServer<TContext>(server: IPCServer<TContext>, logService: ILogService): IDisposable {
	const service = new ParadisGithubMetricsService(logService);
	server.registerChannel(PARADIS_GITHUB_METRICS_CHANNEL, new ParadisGithubMetricsChannel<TContext>(service));
	return { dispose: () => service.dispose() };
}
