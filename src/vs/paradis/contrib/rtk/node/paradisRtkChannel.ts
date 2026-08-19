/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-PATCH/PARA-CODE コメント)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

// shared process 上(および SSH 接続先の REH 上)で rtk (Rust Token Killer) CLI を実行し、
// 節約量の集計を返すサービスと IPC チャネル。workbench からは接続状態に応じて
// shared process / 接続先のどちらかのチャネルへ呼ぶ(electron-browser/paradisRtkClient.ts)。
// 実装方式は paradisCcusageChannel.ts と同じ execFile 直叩き(shell は使わない)。
// 引数はここでレポート種別ごとに固定構築し、renderer から任意の CLI 引数は渡させない。
//
// rtk が JSON を出せるのは `gain -f json -d`(summary + daily)だけで、コマンド別内訳と
// 直近の履歴は人間向けのテキスト表しか無い。テキスト側は列幅で切り詰められる・単位が混在する
// といった崩れやすい入力なので、行単位で読み捨てる方針にしてある(1行の解釈に失敗しても
// その行を飛ばすだけで、セクション全体が壊れていれば空配列を返す)。

import * as cp from 'child_process';
import { Event } from '../../../../base/common/event.js';
import * as path from '../../../../base/common/path.js';
import { IDisposable } from '../../../../base/common/lifecycle.js';
import { IPCServer, IServerChannel } from '../../../../base/parts/ipc/common/ipc.js';
import { IConfigurationService } from '../../../../platform/configuration/common/configuration.js';
import { NativeParsedArgs } from '../../../../platform/environment/common/argv.js';
import { ILogService } from '../../../../platform/log/common/log.js';
import { createParadisShellEnvResolver, ParadisCachedShellEnv } from '../../../../platform/shell/node/paradisCachedShellEnv.js';
import { reportParadisShellEnvDiagnosticError } from '../../sentry/common/paradisSentryDiagnostics.js';
import {
	IParadisRtkCommandRow,
	IParadisRtkDailyRow,
	IParadisRtkExecOptions,
	IParadisRtkHistoryEntry,
	IParadisRtkService,
	IParadisRtkSummary,
	paradisRtkLocalDateString,
	PARADIS_RTK_CHANNEL,
	PARADIS_RTK_NOT_FOUND_MARKER
} from '../common/paradisRtk.js';

/** rtk 実行のタイムアウト。ローカルの集計だけなので ccusage ほど時間はかからない。 */
const EXEC_TIMEOUT_MS = 60_000;
/** 出力の最大サイズ(履歴が長いと大きくなる)。 */
const EXEC_MAX_BUFFER = 64 * 1024 * 1024;
/** バックグラウンドで取り直す周期。ステータスバーのポーリング間隔に合わせてある。 */
const WARM_INTERVAL_MS = 10 * 60 * 1000;
/**
 * 直前に取り直したばかりのエントリを、周回が来たからといってもう一度走らせないための猶予。
 * `WARM_INTERVAL_MS + この猶予 <= CACHE_TTL_MS` を保つこと(破れるとキャッシュが切れる窓ができる)。
 */
const WARM_SKIP_IF_FRESHER_THAN_MS = 2 * 60 * 1000;
/** 結果キャッシュのTTL。ダッシュボードとステータスバーで同じ実行結果を共有する。 */
const CACHE_TTL_MS = WARM_INTERVAL_MS + WARM_SKIP_IF_FRESHER_THAN_MS + 2 * 60 * 1000;
/** 最後に要求されてからこの時間を過ぎたエントリは温めるのをやめる。 */
const WARM_IDLE_TIMEOUT_MS = 12 * 60 * 60 * 1000;
/** 連続で失敗し続ける対象を諦める回数(rtk が入っていない環境で永久に走らせない)。 */
const WARM_MAX_CONSECUTIVE_FAILURES = 3;

/** summary と daily は同じ1回の実行から取れるので、引数もキャッシュも共有する。 */
const GAIN_JSON_ARGS = ['gain', '-f', 'json', '-d'];
/** "By Command" の表。`-f json` は未対応なのでテキストを読む。 */
const GAIN_TEXT_ARGS = ['gain'];
/** "Recent Commands" の一覧。同じくテキストのみ。 */
const GAIN_HISTORY_ARGS = ['gain', '-H'];

interface IParadisRtkGainJson {
	readonly summary?: IParadisRtkSummary;
	readonly daily?: IParadisRtkDailyRow[];
}

/** バックグラウンド更新の対象。要求のたびに登録・更新する。 */
interface IWarmTarget {
	readonly args: string[];
	readonly options: IParadisRtkExecOptions;
	readonly parse: (stdout: string) => unknown;
	lastRequestedAt: number;
	/** 連続失敗回数。上限に達した対象は温めをやめる(次に要求されたら0に戻る)。 */
	failures: number;
}

export class ParadisRtkService implements IParadisRtkService {

	/** レポート結果のTTLキャッシュ(キー: 実行引数+実行ファイルパス)。 */
	private readonly cache = new Map<string, { at: number; value: unknown }>();
	/** 実行中リクエストの共有(同一キーの同時要求を1本にまとめる)。 */
	private readonly inflight = new Map<string, Promise<unknown>>();
	/** dispose 時に停止する実行中の子プロセス。 */
	private readonly activeChildren = new Set<cp.ChildProcess>();
	/** バックグラウンドで温め続ける対象(キーは cache と同じ)。 */
	private readonly warmTargets = new Map<string, IWarmTarget>();
	/** 温め直しのタイマー。最初の要求が来て初めて回り始める。 */
	private warmTimer: ReturnType<typeof setInterval> | undefined;
	/** dispose 後にタイマーが再起動しないようにする。 */
	private disposed = false;
	/**
	 * ログインシェル由来の解決済み環境(PATH 等)。shared process は Dock/Spotlight 起動の
	 * electron-main から process.env を継承するだけなので、GUI 起動では ~/.zshrc 等が足す PATH が
	 * 反映されず、PATH 上にあるはずの 'rtk' が ENOENT になりうる。
	 */
	private readonly cachedShellEnv: ParadisCachedShellEnv;

	constructor(
		private readonly logService: ILogService,
		configurationService?: IConfigurationService,
		args?: NativeParsedArgs,
		private readonly execFile: typeof cp.execFile = cp.execFile,
		private readonly now: () => number = Date.now,
		/**
		 * バックグラウンドでの取り直しを行うか。接続先(REH)では false にする —
		 * サーバーは孤児ターミナルのために接続が切れた後も延命されることがあり、
		 * 誰も見ていない間まで10分ごとに rtk を回し続ける理由が無いため。
		 */
		private readonly backgroundWarm: boolean = true,
	) {
		this.cachedShellEnv = new ParadisCachedShellEnv(
			logService,
			'ParadisRtk',
			createParadisShellEnvResolver(logService, configurationService, args),
			this.now,
			reportParadisShellEnvDiagnosticError,
		);
	}

	/** rtk を実行するこのマシンにとっての今日。CLI は動かさないのでキャッシュもしない。 */
	async fetchToday(): Promise<string> {
		return paradisRtkLocalDateString(new Date(this.now()));
	}

	async fetchSummary(options: IParadisRtkExecOptions): Promise<IParadisRtkSummary> {
		const result = await this.fetchGainJson(options);
		return result.summary ?? {};
	}

	async fetchDaily(options: IParadisRtkExecOptions): Promise<IParadisRtkDailyRow[]> {
		const result = await this.fetchGainJson(options);
		return Array.isArray(result.daily) ? result.daily.filter(row => typeof row?.date === 'string') : [];
	}

	fetchByCommand(options: IParadisRtkExecOptions): Promise<IParadisRtkCommandRow[]> {
		return this.execCached(GAIN_TEXT_ARGS, options, parseParadisRtkByCommand);
	}

	fetchRecentHistory(options: IParadisRtkExecOptions): Promise<IParadisRtkHistoryEntry[]> {
		return this.execCached(GAIN_HISTORY_ARGS, options, parseParadisRtkHistory);
	}

	private fetchGainJson(options: IParadisRtkExecOptions): Promise<IParadisRtkGainJson> {
		return this.execCached(GAIN_JSON_ARGS, options, stdout => {
			try {
				return JSON.parse(stdout) as IParadisRtkGainJson;
			} catch (error) {
				this.logService.warn(`[ParadisRtk] failed to parse JSON output of 'rtk ${GAIN_JSON_ARGS.join(' ')}': ${error}`);
				throw new Error('rtk returned invalid JSON output');
			}
		});
	}

	/**
	 * 呼び出し側からの要求。ここを通ったものだけを「温め続ける対象」として覚える
	 * (バックグラウンドの取り直しはこの経路を通さないので、自分で自分を延命しない)。
	 */
	private execCached<T>(args: string[], options: IParadisRtkExecOptions, parse: (stdout: string) => T): Promise<T> {
		this.rememberWarmTarget(args, options, parse);
		return this.execCachedInternal(args, options, parse);
	}

	private rememberWarmTarget(args: string[], options: IParadisRtkExecOptions, parse: (stdout: string) => unknown): void {
		if (this.disposed || !this.backgroundWarm) {
			return;
		}
		const key = this.cacheKeyFor(args, options);
		const existing = this.warmTargets.get(key);
		if (existing) {
			existing.lastRequestedAt = this.now();
			// 実際に要求が来たなら、諦めていた対象も温め直す価値がある。
			existing.failures = 0;
		} else {
			// bypassCache は要求ごとの都合なので覚えない(温め直しは常に実行する)。
			const { bypassCache: _ignored, ...rest } = options;
			this.warmTargets.set(key, { args, options: rest, parse, lastRequestedAt: this.now(), failures: 0 });
		}
		if (this.warmTimer === undefined) {
			const timer = setInterval(() => { void this.runWarmPass(); }, WARM_INTERVAL_MS);
			// shared process の終了を、この定期処理だけのために引き止めない。
			(timer as { unref?: () => void }).unref?.();
			this.warmTimer = timer;
		}
	}

	/**
	 * 一度使われたレポートを定期的に取り直し、キャッシュが切れた状態を作らない。
	 * 直列に回すのは、誰も待っていない裏の処理で一時的にCPUを占めるのを避けるため。
	 */
	private async runWarmPass(): Promise<void> {
		for (const [key, target] of [...this.warmTargets]) {
			if (this.disposed) {
				return;
			}
			const now = this.now();
			if (now - target.lastRequestedAt >= WARM_IDLE_TIMEOUT_MS || target.failures >= WARM_MAX_CONSECUTIVE_FAILURES) {
				this.warmTargets.delete(key);
				continue;
			}
			// 直前に手動更新された等で十分新しいものは飛ばす(同じ実行を続けて2回しない)。
			const cached = this.cache.get(key);
			if (cached && now - cached.at < WARM_SKIP_IF_FRESHER_THAN_MS) {
				continue;
			}
			if (this.inflight.has(key)) {
				continue;
			}
			try {
				// 鮮度判定はここで済ませているので、キャッシュを見に行かせず必ず実行させる。
				await this.execCachedInternal(target.args, { ...target.options, bypassCache: true }, target.parse);
				target.failures = 0;
			} catch (error) {
				// 失敗してもキャッシュは壊さない(古い値が残るだけ)。
				target.failures++;
				this.logService.trace(`[ParadisRtk] background refresh failed for 'rtk ${target.args.join(' ')}': ${error}`);
				if (target.failures >= WARM_MAX_CONSECUTIVE_FAILURES) {
					this.warmTargets.delete(key);
				}
			}
		}
		if (this.warmTargets.size === 0 && this.warmTimer !== undefined) {
			clearInterval(this.warmTimer);
			this.warmTimer = undefined;
		}
	}

	private cacheKeyFor(args: string[], options: IParadisRtkExecOptions): string {
		return JSON.stringify([args, options.executablePath ?? '']);
	}

	private execCachedInternal<T>(args: string[], options: IParadisRtkExecOptions, parse: (stdout: string) => T): Promise<T> {
		const cacheKey = this.cacheKeyFor(args, options);
		if (!options.bypassCache) {
			const cached = this.cache.get(cacheKey);
			if (cached && this.now() - cached.at < CACHE_TTL_MS) {
				return Promise.resolve(cached.value as T);
			}
		}
		// bypassCache でも実行中の同一リクエストには相乗りする(結果はどのみち今まさに取り直したもの)。
		const inflight = this.inflight.get(cacheKey);
		if (inflight) {
			return inflight as Promise<T>;
		}

		const promise = this.exec(options.executablePath, args)
			.then(stdout => {
				const value = parse(stdout);
				if (!this.disposed) {
					this.pruneCache();
					this.cache.set(cacheKey, { at: this.now(), value });
				}
				return value;
			})
			.finally(() => {
				if (this.inflight.get(cacheKey) === promise) {
					this.inflight.delete(cacheKey);
				}
			});
		this.inflight.set(cacheKey, promise);
		return promise;
	}

	private pruneCache(): void {
		const now = this.now();
		for (const [key, entry] of this.cache) {
			if (now - entry.at >= CACHE_TTL_MS) {
				this.cache.delete(key);
			}
		}
	}

	/**
	 * rtk は PATH 上のものだけを見る(ccusage のような npx フォールバックは無い)。
	 * 明示パスが設定されている場合のみ、そのバイナリを直接実行する。
	 */
	private resolveCommand(explicitPath: string | undefined): string {
		if (explicitPath) {
			if (!path.isAbsolute(explicitPath)) {
				throw new Error(`paradis.rtk.executablePath must be an absolute path: ${explicitPath}`);
			}
			return explicitPath;
		}
		return 'rtk';
	}

	private async exec(explicitPath: string | undefined, args: string[]): Promise<string> {
		const command = this.resolveCommand(explicitPath);
		const env = await this.cachedShellEnv.getEnv();
		return new Promise<string>((resolve, reject) => {
			const execution: { child?: cp.ChildProcess; completed: boolean } = { completed: false };
			execution.child = this.execFile(command, args, {
				encoding: 'utf8',
				timeout: EXEC_TIMEOUT_MS,
				maxBuffer: EXEC_MAX_BUFFER,
				windowsHide: true,
				env: { ...env, NO_COLOR: '1' }
			}, (err, stdout, stderr) => {
				execution.completed = true;
				if (execution.child) {
					this.activeChildren.delete(execution.child);
				}
				if (err) {
					if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
						// renderer 側はこの目印で「未インストール」の案内へ切り替える。
						this.logService.trace(`[ParadisRtk] rtk executable not found (${command})`);
						reject(new Error(`${PARADIS_RTK_NOT_FOUND_MARKER}: ${command} was not found on PATH`));
						return;
					}
					this.logService.warn(`[ParadisRtk] ${command} ${args.join(' ')} failed: ${stderr || err.message}`);
					reject(new Error(stderr?.trim() || err.message));
				} else {
					resolve(stdout);
				}
			});
			if (!execution.completed && execution.child) {
				this.activeChildren.add(execution.child);
			}
		});
	}

	dispose(): void {
		this.disposed = true;
		if (this.warmTimer !== undefined) {
			clearInterval(this.warmTimer);
			this.warmTimer = undefined;
		}
		this.warmTargets.clear();
		for (const child of this.activeChildren) {
			try {
				child.kill();
			} catch (error) {
				this.logService.trace(`[ParadisRtk] failed to stop child process during dispose: ${error}`);
			}
		}
		this.activeChildren.clear();
	}
}

// ---------- text output parsing ----------

/** インパクトバーに使われる文字(列の末尾に付く装飾なので読み飛ばす)。 */
const IMPACT_BAR_PATTERN = /^[█░]+$/;
/** "Recent Commands" 行の先頭に付く記号(装飾)。ASCII しか含まないコマンド名とは衝突しない。 */
const HISTORY_ICON_PATTERN = /^[^\x00-\x7F]+\s+/;

/**
 * "1405.9M" のような接尾辞付きの数を数値へ直す。接尾辞が無い場合はそのままの数として読む。
 * 解釈できない場合は undefined(呼び出し側はその行を捨てる)。
 */
export function parseParadisRtkTokenAmount(raw: string): number | undefined {
	const match = /^(\d+(?:\.\d+)?)([KMB])?$/.exec(raw);
	if (!match) {
		return undefined;
	}
	const value = Number(match[1]);
	switch (match[2]) {
		case 'K': return Math.round(value * 1e3);
		case 'M': return Math.round(value * 1e6);
		case 'B': return Math.round(value * 1e9);
		default: return value;
	}
}

/**
 * "3.9s" / "78ms" / "2m3s" のような単位混在の所要時間をミリ秒へ直す。
 * 解釈できない場合は undefined。
 */
export function parseParadisRtkDurationMs(raw: string): number | undefined {
	if (!/^(?:\d+(?:\.\d+)?(?:ms|h|m|s))+$/.test(raw)) {
		return undefined;
	}
	const unitPattern = /(\d+(?:\.\d+)?)(ms|h|m|s)/g;
	let total = 0;
	let match: RegExpExecArray | null;
	while ((match = unitPattern.exec(raw)) !== null) {
		const value = Number(match[1]);
		switch (match[2]) {
			case 'ms': total += value; break;
			case 's': total += value * 1000; break;
			case 'm': total += value * 60_000; break;
			case 'h': total += value * 3_600_000; break;
		}
	}
	return total;
}

/**
 * 見出し行から次の見出し(装飾でも表の行でもない、英字だけの行)までを切り出す。
 * 見出しが無ければ空配列(＝セクションごと壊れていれば呼び出し側は空を返す)。
 */
function sliceSection(stdout: string, heading: string): string[] {
	const lines = stdout.split(/\r?\n/);
	const start = lines.findIndex(line => line.trim() === heading);
	if (start < 0) {
		return [];
	}
	const section: string[] = [];
	for (const line of lines.slice(start + 1)) {
		if (/^[A-Za-z][A-Za-z ]*$/.test(line.trim())) {
			break;
		}
		section.push(line);
	}
	return section;
}

/**
 * `rtk gain` の "By Command" 表をパースする。
 *
 * 列は幅で右寄せ・切り詰めされるため、桁数が増えると列同士の隙間が1文字まで詰まりうる。
 * 位置ではなく右端から数えて読む(末尾のインパクトバー → Time → Avg% → Saved → Count の順に
 * 取り除き、残りをコマンド名とする)ことで、幅の変化に影響されないようにしている。
 */
export function parseParadisRtkByCommand(stdout: string): IParadisRtkCommandRow[] {
	const rows: IParadisRtkCommandRow[] = [];
	for (const line of sliceSection(stdout, 'By Command')) {
		const tokens = line.trim().split(/\s+/);
		// 表の行は必ず "N." で始まる(区切り線・ヘッダーはここで落ちる)。
		if (!/^\d+\.$/.test(tokens[0] ?? '')) {
			continue;
		}
		while (tokens.length > 0 && IMPACT_BAR_PATTERN.test(tokens[tokens.length - 1])) {
			tokens.pop();
		}
		if (tokens.length < 6) {
			continue;
		}
		const avgTimeMs = parseParadisRtkDurationMs(tokens.pop()!);
		const percent = /^(\d+(?:\.\d+)?)%$/.exec(tokens.pop()!);
		const savedTokens = parseParadisRtkTokenAmount(tokens.pop()!);
		// Count は現行の rtk では常に生整数だが、将来 "1,234" や "1.2K" になっても読めるよう
		// savedTokens と同じパーサーを通す(桁区切りだけ先に剥がす)。
		const count = parseParadisRtkTokenAmount((tokens[tokens.length - 1] ?? '').replace(/,/g, ''));
		if (count !== undefined) {
			tokens.pop();
		}
		const command = tokens.slice(1).join(' ');
		if (avgTimeMs === undefined || !percent || savedTokens === undefined || count === undefined || command.length === 0) {
			continue;
		}
		rows.push({ command, count, savedTokens, avgSavingsPct: Number(percent[1]), avgTimeMs });
	}
	return rows;
}

/**
 * `rtk gain -H` の "Recent Commands" をパースする。
 * 形式は `MM-DD HH:MM <記号> <コマンド> -N% (<トークン>)`。記号は装飾なので捨てる。
 */
export function parseParadisRtkHistory(stdout: string): IParadisRtkHistoryEntry[] {
	const entries: IParadisRtkHistoryEntry[] = [];
	for (const line of sliceSection(stdout, 'Recent Commands')) {
		// トークン数は "(924)" のときも "(48.5K)" のときもある。節約率はほぼ常に "-N%" だが、
		// 増加(悪化)側を "+N%" で出す可能性も考えて符号は両方受け付ける。
		const match = /^(\d{2}-\d{2} \d{2}:\d{2})\s+(.*?)\s+[-+]?(\d+(?:\.\d+)?)%\s+\((\d+(?:\.\d+)?[KMB]?)\)$/.exec(line.trim());
		if (!match) {
			continue;
		}
		const command = match[2].replace(HISTORY_ICON_PATTERN, '').trim();
		const tokens = parseParadisRtkTokenAmount(match[4]);
		if (command.length === 0 || tokens === undefined) {
			continue;
		}
		// 節約率は "-42%"(42%削減)の形で出るので、大きさだけを持つ。
		entries.push({ timestampLabel: match[1], command, savingsPct: Number(match[3]), tokens });
	}
	return entries;
}

// ccusage と同じく、shared process と REH の双方へ同じ形で生やす。
export class ParadisRtkChannel<TContext = string> implements IServerChannel<TContext> {

	constructor(private readonly service: ParadisRtkService) { }

	listen<T>(_ctx: TContext, event: string): Event<T> {
		throw new Error(`Event not found: ${event}`);
	}

	call<T>(_ctx: TContext, command: string, arg?: unknown): Promise<T> {
		const args = Array.isArray(arg) ? arg : [];
		const options = (args[0] ?? {}) as IParadisRtkExecOptions;
		switch (command) {
			case 'fetchToday': return this.service.fetchToday() as Promise<T>;
			case 'fetchSummary': return this.service.fetchSummary(options) as Promise<T>;
			case 'fetchDaily': return this.service.fetchDaily(options) as Promise<T>;
			case 'fetchByCommand': return this.service.fetchByCommand(options) as Promise<T>;
			case 'fetchRecentHistory': return this.service.fetchRecentHistory(options) as Promise<T>;
			default:
				throw new Error(`Method not found: ${command}`);
		}
	}
}

/**
 * serverServices.ts(REH)から1行で呼べるファクトリ。
 * rtk はコマンドを実行したマシンのローカルDBに記録するため、SSH/WSL で接続している間の
 * 節約量は接続先に貯まる。手元の shared process だけを見ているとその分がまるごと欠けるので、
 * 同じチャネルを接続先にも生やして、クライアントから繋いでいる先へ聞けるようにする。
 * サーバー側は configurationService/args を持たないため、シェル環境の解決は行わず
 * サーバープロセスが継承した PATH をそのまま使う(ccusage の server 版と同じ)。
 */
export function registerParadisRtkForServer<TContext>(server: IPCServer<TContext>, logService: ILogService): IDisposable {
	const service = new ParadisRtkService(logService, undefined, undefined, cp.execFile, Date.now, false);
	server.registerChannel(PARADIS_RTK_CHANNEL, new ParadisRtkChannel<TContext>(service));
	return { dispose: () => service.dispose() };
}

/**
 * sharedProcessMain.ts の PARA-PATCH 点から1行で呼べるファクトリ。
 */
export function registerParadisRtk(server: IPCServer<string>, logService: ILogService, configurationService: IConfigurationService, args: NativeParsedArgs): IDisposable {
	const service = new ParadisRtkService(logService, configurationService, args);
	server.registerChannel(PARADIS_RTK_CHANNEL, new ParadisRtkChannel<string>(service));
	// バックグラウンド更新のタイマーを止める(unref 済みだが、明示的に畳んでおく)。
	return { dispose: () => service.dispose() };
}
