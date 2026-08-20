/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-PATCH/PARA-CODE コメント)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

// GitHub API 利用状況の収集バックエンド（shared process）。
// - `gh api rate_limit` でアカウント全体のレート枠を取得する（この endpoint は枠を消費しない）
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
	paradisParseGhRateLimit,
	paradisSetGithubCallSink,
	paradisTruncateGithubErrorMessage,
	ParadisGithubCallLog,
	ParadisGithubRateLimitHistory,
	PARADIS_GITHUB_METRICS_CHANNEL,
} from '../common/paradisGithubMetrics.js';

/**
 * レート枠の再取得を抑える最短間隔。renderer 側の最短ポーリング間隔（ダッシュボード表示中の60秒）
 * 以下かつ十分長い値にして、ウィンドウやエディタが複数開いていても gh の起動回数が
 * その数に比例しないようにする。
 */
const RATE_LIMIT_MIN_REFRESH_MS = 45_000;
/** gh の実行タイムアウト。ネットワーク I/O のため必須。 */
const GH_TIMEOUT_MS = 15_000;
/** 連続失敗時のバックオフ（未認証環境などで gh を起動し続けないための上限つき指数バックオフ）。 */
const FAILURE_BACKOFF_START_MS = 60_000;
const FAILURE_BACKOFF_MAX_MS = 15 * 60_000;

/** レート枠取得の引数。呼び出し元名（`gh api rate_limit`）もここから作る。 */
const RATE_LIMIT_ARGS = ['api', 'rate_limit'];

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
		// 同時に複数ウィンドウから呼ばれても gh は1回だけ起動する
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
	 * この呼び出し自体は枠を消費しない管理用エンドポイントなので、
	 * 「Para Code が送ったリクエスト」の内訳には数えない（監視自身が1位に居座らないようにする）。
	 */
	private async fetchRateLimits(): Promise<void> {
		try {
			const stdout = await this.execGh(RATE_LIMIT_ARGS);
			const entries = paradisParseGhRateLimit(stdout);
			const finishedAt = this.now();
			if (entries.length === 0) {
				this.consecutiveFailures++;
				this.rateLimitError = localize('paradis.githubMetrics.unexpectedResponse', "Unexpected response from `gh api rate_limit`");
			} else {
				this.consecutiveFailures = 0;
				this.rateLimitError = undefined;
				this.rateLimits = entries;
				this.history.record(entries, finishedAt);
			}
			this.rateLimitFetchedAt = finishedAt;
		} catch (error) {
			// gh の stderr がそのまま入るため、UI へ出す前にここで丸める（呼び出しログと同じ上限）。
			const message = paradisTruncateGithubErrorMessage(error instanceof Error ? error.message : String(error));
			this.consecutiveFailures++;
			this.rateLimitError = message;
			this.rateLimitFetchedAt = this.now();
			this.logService.trace(`[ParadisGithubMetrics] gh api rate_limit failed (${this.consecutiveFailures} in a row): ${message}`);
		}
	}

	private async execGh(args: string[]): Promise<string> {
		const env = await this.cachedShellEnv.getEnv();
		return new Promise<string>((resolve, reject) => {
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
					}
					reject(new Error(stderr?.trim() || err.message));
				} else {
					// 実行できたなら「未インストール」判定は取り消す
					this.ghAvailable = true;
					resolve(stdout);
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
