/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-PATCH/PARA-CODE コメント)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

// shared process 上で ccusage CLI (https://ccusage.com) を実行し、--json 出力を返すサービスと
// IPC チャネル。workbench からは ISharedProcessService.getChannel(PARADIS_CCUSAGE_CHANNEL) 経由で呼ぶ。
// 実装方式は paradisWorktreeGitChannel.ts と同じ execFile 直叩き(shell は使わない)。
// Windows のみ、解決先が npm 由来の .cmd/.bat シムのときに cmd.exe /d /s /c へラップする
// (paradisWindowsScriptShim.ts。shell 指定なしでは EINVAL になるため)。
// 引数はここでレポート種別ごとに固定構築し、renderer から任意の CLI 引数は渡させない。

import * as cp from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import { RunOnceScheduler } from '../../../../base/common/async.js';
import { Event } from '../../../../base/common/event.js';
import * as path from '../../../../base/common/path.js';
import { IDisposable } from '../../../../base/common/lifecycle.js';
import { IPCServer, IServerChannel } from '../../../../base/parts/ipc/common/ipc.js';
import { IConfigurationService } from '../../../../platform/configuration/common/configuration.js';
import { IParadisTrackedChildProcess, ParadisChildProcessTreeTracker } from '../../../node/paradisKillChildProcess.js';
import { NativeParsedArgs } from '../../../../platform/environment/common/argv.js';
import { ILogService } from '../../../../platform/log/common/log.js';
import { createParadisShellEnvResolver, ParadisCachedShellEnv } from '../../../../platform/shell/node/paradisCachedShellEnv.js';
import { reportParadisShellEnvDiagnosticError } from '../../sentry/common/paradisSentryDiagnostics.js';
import { paradisWrapWindowsScriptShim } from '../../../common/paradisWindowsScriptShim.js';
import { IParadisWarmLeaseScheduler, ParadisWarmLeaseTracker, PARADIS_WARM_LEASE_DURATION_MS } from '../../../common/paradisWarmLease.js';
import {
	IParadisCcusageBlock,
	IParadisCcusageDailyRow,
	IParadisCcusageExecOptions,
	IParadisCcusageService,
	IParadisCcusageSessionRow,
	PARADIS_CCUSAGE_CHANNEL,
	ParadisCcusageProjects,
	ParadisCcusageWarmLeasePayload,
	ParadisCcusageWarmTarget,
	ParadisCcusageWarmTargetKind,
} from '../common/paradisCcusage.js';

/** ccusage 実行のタイムアウト。JSONL 全走査+価格取得があるため長め。 */
const EXEC_TIMEOUT_MS = 60_000;
/**
 * npx フォールバック時に使うバージョン。サプライチェーン対策として @latest ではなく
 * 実機検証済みのバージョンへ固定する(更新したい場合はローカルインストールか
 * 設定 paradis.ccusage.executablePath を使ってもらう)。
 */
const NPX_PINNED_VERSION = 'ccusage@20.0.14';
/** JSON 出力の最大サイズ(セッションが多いと数MBになる)。 */
const EXEC_MAX_BUFFER = 64 * 1024 * 1024;
/** バックグラウンドで取り直す周期。 */
const WARM_INTERVAL_MS = 30 * 60 * 1000;
/**
 * 直前に取り直したばかりのエントリを、周回が来たからといってもう一度走らせないための猶予。
 * 手動更新の直後などが該当する。
 *
 * `WARM_INTERVAL_MS + この猶予 <= CACHE_TTL_MS` を保つこと。ここが破れると、
 * 「周回を1つ飛ばした直後にTTLが切れる」窓ができ、キャッシュを切らさないという前提が崩れる。
 */
const WARM_SKIP_IF_FRESHER_THAN_MS = 3 * 60 * 1000;
/**
 * 結果キャッシュのTTL。ccusage は毎回 JSONL 全走査で数秒かかるため、
 * ダッシュボードとステータスバーで走査結果を共有する。手動更新は bypassCache で貫通できる。
 *
 * バックグラウンドの取り直し周期より長くしてある。短いと周期の合間にキャッシュが切れ、
 * そこへ来た要求が結局走査の完了を待つことになる(その待ち時間を無くすための仕組みなので、
 * TTLが周期を跨げないと意味が無い)。
 */
const CACHE_TTL_MS = WARM_INTERVAL_MS + WARM_SKIP_IF_FRESHER_THAN_MS + 5 * 60 * 1000;
/**
 * アクティブブロックも同じTTLで扱う。ここだけ短くしても、4レポートは並列に取るので
 * 「一番遅い1本」が待ち時間になり、結局待たされる(＝速くするには全部キャッシュに載せる必要がある)。
 *
 * 代わりに、時間に依存する値(残り時間・枠が終わったかどうか)は**表示側で現在時刻から出し直す**。
 * スナップショットに入っている `remainingMinutes` をそのまま出すと、取得から時間が経つほど
 * 現在時刻と食い違い、終わった枠を「進行中」として見せてしまう。
 */
const BLOCK_CACHE_TTL_MS = CACHE_TTL_MS;
/** --offline フォールバックで得た結果(価格が古い可能性)は短命キャッシュに留める。 */
const FALLBACK_CACHE_TTL_MS = 60 * 1000;
/** 連続で失敗し続ける対象を諦める回数(ccusage が入っていない環境で永久に走らせない)。 */
const WARM_MAX_CONSECUTIVE_FAILURES = 3;
const WARM_LEASE_MAX_OWNERS = 128;
const WARM_LEASE_MAX_MEMBERSHIPS = 512;
const WARM_LEASE_MAX_TARGETS_PER_OWNER = 4;
const WARM_LEASE_MAX_EXECUTABLE_PATH_LENGTH = 4096;
const WARM_LEASE_OWNER_ID_PATTERN = /^[A-Za-z0-9._:-]{1,160}$/;

interface IWarmFailure {
	readonly generation: number;
	readonly count: number;
}

interface IInflightReport {
	readonly promise: Promise<unknown>;
	foregroundCacheInterest: boolean;
}

interface IWarmLeaseOwner {
	readonly expiresAt: number;
	readonly targetKeys: readonly string[];
}

type WarmLeaseSchedulerFactory = (runner: () => void) => IParadisWarmLeaseScheduler;

const warmReportArgs: Readonly<Record<ParadisCcusageWarmTargetKind, readonly string[]>> = {
	daily: ['daily'],
	blocks: ['blocks', '--active'],
	session: ['claude', 'session', '--order', 'desc'],
	projects: ['claude', 'daily', '--instances'],
};

interface IResolvedExecutable {
	readonly command: string;
	readonly prefixArgs: string[];
}

/** exec 失敗の原因分類。--offline 再試行の要否判断に使う。 */
interface IParadisExecError extends Error {
	/** バイナリが起動できなかった(ENOENT 等)。 */
	spawnFailed?: boolean;
	/** タイムアウトで kill された。 */
	timedOut?: boolean;
}

export class ParadisCcusageService implements IParadisCcusageService {

	/** 自動解決したバイナリのキャッシュ(明示パス指定時はキーが変わるので使わない)。 */
	private resolved: IResolvedExecutable | undefined;
	/** 解決処理の in-flight メモ(並列 fetch の初回に解決が多重実行されるのを防ぐ)。 */
	private resolving: Promise<IResolvedExecutable> | undefined;
	/** レポート結果のTTLキャッシュ(キー: 実行引数+実行ファイルパス)。 */
	private readonly cache = new Map<string, { at: number; ttl: number; value: unknown }>();
	/** 実行中リクエストの共有(同一キーの同時要求を1本にまとめる)。 */
	private readonly inflight = new Map<string, IInflightReport>();
	/** 実行のdeadlineと子プロセスツリーの停止を所有する。 */
	private readonly childProcesses: ParadisChildProcessTreeTracker;
	private readonly warmLeaseTracker: ParadisWarmLeaseTracker<ParadisCcusageWarmTarget>;
	private readonly warmLeaseOwners = new Map<string, IWarmLeaseOwner>();
	private readonly warmFailures = new Map<string, IWarmFailure>();
	private readonly warmLeaseListener: IDisposable;
	/** active lease がある間だけ温め直すタイマー。 */
	private warmTimer: ReturnType<typeof setInterval> | undefined;
	private warmPassRunning = false;
	private warmPassPending = false;
	/** dispose 後にタイマーが再起動しないようにする。 */
	private disposed = false;
	/**
	 * ログインシェル由来の解決済み環境(PATH 等)。shared process は Dock/Spotlight 起動の
	 * electron-main から process.env を継承するだけなので、GUI 起動では ~/.zshrc 等で
	 * nvm/volta/fnm が足す PATH が反映されず 'npx'/'ccusage' が ENOENT になりうる。
	 * getResolvedShellEnv は VS Code 本体が拡張機能ホスト起動時などに使う既存の解決ロジック。
	 */
	private readonly cachedShellEnv: ParadisCachedShellEnv;

	constructor(
		private readonly logService: ILogService,
		configurationService?: IConfigurationService,
		args?: NativeParsedArgs,
		private readonly execFile: typeof cp.execFile = cp.execFile,
		private readonly now: () => number = Date.now,
		warmLeaseSchedulerFactory: WarmLeaseSchedulerFactory = runner => new RunOnceScheduler(runner, 0),
	) {
		this.childProcesses = new ParadisChildProcessTreeTracker(
			error => this.logService.trace('[ParadisCcusage] failed to stop child process: ' + error),
		);
		this.cachedShellEnv = new ParadisCachedShellEnv(
			logService,
			'ParadisCcusage',
			createParadisShellEnvResolver(logService, configurationService, args),
			this.now,
			reportParadisShellEnvDiagnosticError,
		);
		this.warmLeaseTracker = new ParadisWarmLeaseTracker(
			target => this.warmTargetKey(target),
			(left, right) => this.warmTargetKey(left) === this.warmTargetKey(right),
			() => 1,
			this.now,
			warmLeaseSchedulerFactory,
			{
				maxOwners: WARM_LEASE_MAX_OWNERS,
				maxTargetsPerOwner: WARM_LEASE_MAX_TARGETS_PER_OWNER,
				maxDistinctTargets: WARM_LEASE_MAX_MEMBERSHIPS,
				maxTotalMemberships: WARM_LEASE_MAX_MEMBERSHIPS,
				maxTotalCost: WARM_LEASE_MAX_MEMBERSHIPS,
			},
		);
		this.warmLeaseListener = this.warmLeaseTracker.onDidChange(() => this.syncWarmTimer());
	}

	/** exec に渡す環境変数(process.env にログインシェル解決分をマージしたもの)。 */
	private getExecEnv(): Promise<NodeJS.ProcessEnv> {
		return this.cachedShellEnv.getEnv();
	}

	async fetchDaily(options: IParadisCcusageExecOptions): Promise<IParadisCcusageDailyRow[]> {
		const result = await this.execJson<{ daily?: IParadisCcusageDailyRow[] }>(['daily'], options);
		return Array.isArray(result.daily) ? result.daily : [];
	}

	async fetchActiveBlock(options: IParadisCcusageExecOptions): Promise<IParadisCcusageBlock | undefined> {
		const result = await this.execJson<{ blocks?: IParadisCcusageBlock[] }>(['blocks', '--active'], options, BLOCK_CACHE_TTL_MS);
		const blocks = Array.isArray(result.blocks) ? result.blocks : [];
		return blocks.find(block => block.isActive && !block.isGap) ?? blocks[0];
	}

	async fetchRecentSessions(options: IParadisCcusageExecOptions): Promise<IParadisCcusageSessionRow[]> {
		const result = await this.execJson<{ sessions?: IParadisCcusageSessionRow[] }>(['claude', 'session', '--order', 'desc'], options);
		return Array.isArray(result.sessions) ? result.sessions : [];
	}

	async fetchProjects(options: IParadisCcusageExecOptions): Promise<ParadisCcusageProjects> {
		const result = await this.execJson<{ projects?: ParadisCcusageProjects }>(['claude', 'daily', '--instances'], options);
		return result.projects ?? {};
	}

	setWarmLease(ownerId: string, targets: readonly ParadisCcusageWarmTarget[]): void {
		if (this.disposed) {
			return;
		}
		this.warmLeaseTracker.activeTargets();
		this.purgeExpiredWarmLeaseOwners();
		if (targets.length === 0) {
			this.warmLeaseOwners.delete(ownerId);
			this.warmLeaseTracker.release(ownerId);
			return;
		}
		if (!this.isWithinWarmLeaseLimits(ownerId, targets)) {
			throw new Error('Warm lease limit exceeded');
		}
		this.warmLeaseTracker.setLease(ownerId, targets);
		this.warmLeaseOwners.set(ownerId, {
			expiresAt: this.now() + PARADIS_WARM_LEASE_DURATION_MS,
			targetKeys: targets.map(target => this.warmTargetKey(target)),
		});
	}

	/** foreground の要求。warm ownership は setWarmLease だけが変更する。 */
	private async execJson<T>(reportArgs: string[], options: IParadisCcusageExecOptions, ttl: number = CACHE_TTL_MS): Promise<T> {
		return this.execJsonInternal<T>(reportArgs, options, ttl);
	}

	/**
	 * 一度使われたレポートを定期的に取り直し、キャッシュが切れた状態を作らない。
	 * ccusage は JSONL 全走査で数秒かかるため、これが無いと「TTLが切れた後に最初に開いた人」が
	 * 毎回その数秒を負担することになる(PC版のダッシュボード・ステータスバーとモバイルが
	 * 同じキャッシュを共有している)。
	 *
	 * 直列に回すのは、4レポートを同時に起動して一時的にCPUを占めるのを避けるため
	 * (誰も待っていない裏の処理なので、速く終わらせる必要が無い)。
	 */
	private async runWarmPass(): Promise<void> {
		const snapshots = this.warmLeaseTracker.activeTargets();
		for (const snapshot of snapshots) {
			// dispose 後は残りを回さない(1本60秒待つので、畳んだ後も子プロセスが続きうる)。
			if (this.disposed) {
				return;
			}
			const { generation, key, target } = snapshot;
			if (!this.warmLeaseTracker.isCurrent(key, generation)) {
				continue;
			}
			const failure = this.warmFailures.get(key);
			if (failure?.generation === generation && failure.count >= WARM_MAX_CONSECUTIVE_FAILURES) {
				continue;
			}
			// 経過時間はループの都度見る(1本に数十秒かかるので、入口の1回では古くなる)。
			const now = this.now();
			// 直前に手動更新された等で十分新しいものは飛ばす(同じ走査を続けて2回しない)。
			const cached = this.cache.get(key);
			if (cached && now - cached.at < WARM_SKIP_IF_FRESHER_THAN_MS) {
				continue;
			}
			if (this.inflight.has(key)) {
				continue;
			}
			try {
				// 鮮度判定はここで済ませているので、キャッシュを見に行かせず必ず実行させる。
				const reportArgs = [...warmReportArgs[target.kind]];
				const ttl = target.kind === 'blocks' ? BLOCK_CACHE_TTL_MS : CACHE_TTL_MS;
				await this.execJsonInternal(reportArgs, { ...target.options, bypassCache: true }, ttl, () => this.warmLeaseTracker.isCurrent(key, generation), false);
				if (this.warmLeaseTracker.isCurrent(key, generation)) {
					this.warmFailures.delete(key);
				}
			} catch (error) {
				// 失敗してもキャッシュは壊さない(古い値が残るだけ)。
				// ccusage が入っていない環境では毎回タイムアウトまで待つことになるので、
				// 続けて失敗する対象は、target generation が変わるまで温めない。
				if (this.warmLeaseTracker.isCurrent(key, generation)) {
					const count = failure?.generation === generation ? failure.count + 1 : 1;
					this.warmFailures.set(key, { generation, count });
				}
				this.logService.trace(`[ParadisCcusage] background refresh failed for 'ccusage ${warmReportArgs[target.kind].join(' ')}': ${error}`);
			}
		}
		this.syncWarmTimer();
	}

	private requestWarmPass(): void {
		if (this.disposed) {
			return;
		}
		if (this.warmPassRunning) {
			this.warmPassPending = true;
			return;
		}
		this.warmPassRunning = true;
		void this.drainWarmPasses();
	}

	private async drainWarmPasses(): Promise<void> {
		try {
			do {
				this.warmPassPending = false;
				await this.runWarmPass();
			} while (this.warmPassPending && !this.disposed);
		} finally {
			this.warmPassRunning = false;
			if (this.disposed) {
				this.warmPassPending = false;
			}
		}
	}

	private syncWarmTimer(): void {
		if (this.disposed) {
			return;
		}
		const activeTargets = this.warmLeaseTracker.activeTargets();
		const activeKeys = new Set(activeTargets.map(snapshot => snapshot.key));
		for (const key of this.warmFailures.keys()) {
			if (!activeKeys.has(key)) {
				this.warmFailures.delete(key);
			}
		}
		const hasWarmableTarget = activeTargets.some(snapshot => {
			const failure = this.warmFailures.get(snapshot.key);
			return failure?.generation !== snapshot.generation || failure.count < WARM_MAX_CONSECUTIVE_FAILURES;
		});
		if (hasWarmableTarget && this.warmTimer === undefined) {
			const timer = setInterval(() => this.requestWarmPass(), WARM_INTERVAL_MS);
			(timer as { unref?: () => void }).unref?.();
			this.warmTimer = timer;
		} else if (!hasWarmableTarget && this.warmTimer !== undefined) {
			clearInterval(this.warmTimer);
			this.warmTimer = undefined;
		}
	}

	private warmTargetKey(target: ParadisCcusageWarmTarget): string {
		return this.cacheKeyFor([...warmReportArgs[target.kind]], target.options);
	}

	private purgeExpiredWarmLeaseOwners(): void {
		const now = this.now();
		for (const [ownerId, owner] of this.warmLeaseOwners) {
			if (owner.expiresAt <= now) {
				this.warmLeaseOwners.delete(ownerId);
			}
		}
	}

	private isWithinWarmLeaseLimits(ownerId: string, targets: readonly ParadisCcusageWarmTarget[]): boolean {
		if (targets.length > WARM_LEASE_MAX_TARGETS_PER_OWNER) {
			return false;
		}
		const targetKeys = targets.map(target => this.warmTargetKey(target));
		if (new Set(targetKeys).size !== targetKeys.length) {
			return false;
		}
		if (!this.warmLeaseOwners.has(ownerId) && this.warmLeaseOwners.size >= WARM_LEASE_MAX_OWNERS) {
			return false;
		}

		let memberships = targetKeys.length;
		const distinctKeys = new Set(targetKeys);
		for (const [activeOwnerId, owner] of this.warmLeaseOwners) {
			if (activeOwnerId === ownerId) {
				continue;
			}
			memberships += owner.targetKeys.length;
			for (const key of owner.targetKeys) {
				distinctKeys.add(key);
			}
		}
		return memberships <= WARM_LEASE_MAX_MEMBERSHIPS && distinctKeys.size <= WARM_LEASE_MAX_MEMBERSHIPS;
	}

	/** キャッシュキー。since/until/timezone を含む実行引数と実行ファイルパスで決まる。 */
	private cacheKeyFor(reportArgs: string[], options: IParadisCcusageExecOptions): string {
		return JSON.stringify([this.buildArgs(reportArgs, options), options.executablePath ?? '']);
	}

	private buildArgs(reportArgs: string[], options: IParadisCcusageExecOptions): string[] {
		const args = [...reportArgs, '--json'];
		if (options.since && /^\d{8}$/.test(options.since)) {
			args.push('--since', options.since);
		}
		if (options.until && /^\d{8}$/.test(options.until)) {
			args.push('--until', options.until);
		}
		if (options.timezone && /^[A-Za-z0-9_+\-/]+$/.test(options.timezone)) {
			args.push('--timezone', options.timezone);
		}
		return args;
	}

	dispose(): void {
		this.disposed = true;
		this.warmPassPending = false;
		if (this.warmTimer !== undefined) {
			clearInterval(this.warmTimer);
			this.warmTimer = undefined;
		}
		this.warmLeaseListener.dispose();
		this.warmLeaseTracker.dispose();
		this.warmLeaseOwners.clear();
		this.warmFailures.clear();
		this.childProcesses.dispose();
	}

	private async execJsonInternal<T>(
		reportArgs: string[],
		options: IParadisCcusageExecOptions,
		ttl: number = CACHE_TTL_MS,
		shouldCache: () => boolean = () => true,
		foregroundCacheInterest = true,
	): Promise<T> {
		const args = this.buildArgs(reportArgs, options);
		const cacheKey = JSON.stringify([args, options.executablePath ?? '']);
		if (!options.bypassCache) {
			const cached = this.cache.get(cacheKey);
			if (cached && this.now() - cached.at < cached.ttl) {
				return cached.value as T;
			}
		}
		// bypassCache でも実行中の同一リクエストには相乗りする(結果はどのみち今まさに取り直したもの)
		const inflight = this.inflight.get(cacheKey);
		if (inflight) {
			inflight.foregroundCacheInterest ||= foregroundCacheInterest;
			return inflight.promise as Promise<T>;
		}

		const record: IInflightReport = {
			foregroundCacheInterest,
			promise: this.doExecJson<T>(reportArgs, args, options)
				.then(({ value, usedOfflineFallback }) => {
					if (!this.disposed && (record.foregroundCacheInterest || shouldCache())) {
						this.pruneCache();
						this.cache.set(cacheKey, { at: this.now(), ttl: usedOfflineFallback ? FALLBACK_CACHE_TTL_MS : ttl, value });
					}
					return value;
				})
				.finally(() => {
					if (this.inflight.get(cacheKey) === record) {
						this.inflight.delete(cacheKey);
					}
				}),
		};
		this.inflight.set(cacheKey, record);
		return record.promise as Promise<T>;
	}

	/** 期限切れエントリの掃除(since が日付で変わるため古いキーが溜まり続けるのを防ぐ)。 */
	private pruneCache(): void {
		const now = this.now();
		for (const [key, entry] of this.cache) {
			if (now - entry.at >= entry.ttl) {
				this.cache.delete(key);
			}
		}
	}

	private async doExecJson<T>(reportArgs: string[], args: string[], options: IParadisCcusageExecOptions): Promise<{ value: T; usedOfflineFallback: boolean }> {
		const executable = await this.resolveExecutable(options.executablePath);
		let stdout: string;
		let usedOfflineFallback = false;
		try {
			stdout = await this.exec(executable, args);
		} catch (error) {
			// 価格表のオンライン取得失敗(オフライン環境等)で落ちることがあるため、キャッシュ済み価格を
			// 使う --offline で一度だけ再試行する。ただしバイナリが起動できなかった(ENOENT)・timeout の
			// 場合は再試行しても同じ失敗(npx なら二重のパッケージ取得)になるだけなので、そのまま投げる。
			const execError = error as IParadisExecError;
			if (execError.spawnFailed || execError.timedOut) {
				throw error;
			}
			this.logService.info(`[ParadisCcusage] retrying 'ccusage ${reportArgs.join(' ')}' with --offline: ${execError.message}`);
			try {
				// 1回目に解決済みの executable をそのまま使う(再解決の PATH プローブを避ける)
				stdout = await this.exec(executable, [...args, '--offline']);
				usedOfflineFallback = true;
			} catch {
				// 再試行も失敗した場合は元のエラーの方が原因を表している
				throw error;
			}
		}
		try {
			return { value: JSON.parse(stdout) as T, usedOfflineFallback };
		} catch (error) {
			this.logService.warn(`[ParadisCcusage] failed to parse JSON output of 'ccusage ${reportArgs.join(' ')}': ${error}`);
			throw new Error('ccusage returned invalid JSON output');
		}
	}

	private async exec(executable: IResolvedExecutable, args: string[]): Promise<string> {
		const fullArgs = [...executable.prefixArgs, ...args];
		const env = await this.getExecEnv();
		// Windows で解決先が .cmd/.bat シムのときは cmd.exe 経由にラップする。旧 Node の
		// 自動委譲は CVE-2024-27980 対策で撤去済みで、ラップしないと EINVAL になる。
		const shimInvocation = process.platform === 'win32' ? paradisWrapWindowsScriptShim(executable.command, fullArgs) : undefined;
		return new Promise<string>((resolve, reject) => {
			const execution: { child?: cp.ChildProcess; tracked?: IParadisTrackedChildProcess; completed: boolean } = { completed: false };
			execution.child = this.execFile(shimInvocation?.file ?? executable.command, shimInvocation?.args ?? fullArgs, {
				encoding: 'utf8',
				maxBuffer: EXEC_MAX_BUFFER,
				windowsHide: true,
				windowsVerbatimArguments: shimInvocation !== undefined,
				env: { ...env, NO_COLOR: '1', LOG_LEVEL: '0' }
			}, (err, stdout, stderr) => {
				execution.completed = true;
				const timedOut = execution.tracked?.timedOut === true;
				execution.tracked?.dispose();
				if (err) {
					this.logService.warn(`[ParadisCcusage] ${executable.command} ${fullArgs.join(' ')} failed: ${stderr || err.message}`);
					// 実行自体に失敗した場合は次回に別の候補を試せるようキャッシュを破棄する
					this.resolved = undefined;
					const execError: IParadisExecError = new Error(stderr?.trim() || err.message);
					execError.spawnFailed = (err as NodeJS.ErrnoException).code === 'ENOENT';
					execError.timedOut = timedOut;
					reject(execError);
				} else {
					resolve(stdout);
				}
			});
			if (!execution.completed && execution.child) {
				execution.tracked = this.childProcesses.track(execution.child, EXEC_TIMEOUT_MS);
			}
		});
	}

	/**
	 * ccusage 実行コマンドを解決する。優先順: 明示パス設定 → PATH 上の ccusage →
	 * よくあるインストール先 → npx フォールバック(未インストールでも動くが初回が遅い)。
	 */
	private async resolveExecutable(explicitPath: string | undefined): Promise<IResolvedExecutable> {
		if (explicitPath) {
			if (!path.isAbsolute(explicitPath)) {
				throw new Error(`paradis.ccusage.executablePath must be an absolute path: ${explicitPath}`);
			}
			return { command: explicitPath, prefixArgs: [] };
		}
		if (this.resolved) {
			return this.resolved;
		}
		if (!this.resolving) {
			this.resolving = this.doResolveExecutable().finally(() => { this.resolving = undefined; });
		}
		return this.resolving;
	}

	private async doResolveExecutable(): Promise<IResolvedExecutable> {
		const home = os.homedir();
		const isWindows = process.platform === 'win32';
		const names = isWindows ? ['ccusage.cmd', 'ccusage.exe', 'ccusage'] : ['ccusage'];
		const candidateDirs = isWindows
			? [path.join(home, 'AppData', 'Roaming', 'npm'), path.join(home, '.bun', 'bin')]
			: [path.join(home, '.npm-global', 'bin'), path.join(home, '.bun', 'bin'), path.join(home, '.local', 'bin'), path.join(home, '.deno', 'bin'), '/opt/homebrew/bin', '/usr/local/bin'];

		// PATH 上にあればそれを使う(コマンド名のまま execFile に渡す)
		for (const name of names) {
			if (await this.canExecute(name)) {
				this.resolved = { command: name, prefixArgs: [] };
				return this.resolved;
			}
		}
		for (const dir of candidateDirs) {
			for (const name of names) {
				const candidate = path.join(dir, name);
				if (await this.fileExists(candidate)) {
					this.resolved = { command: candidate, prefixArgs: [] };
					return this.resolved;
				}
			}
		}

		this.logService.warn(`[ParadisCcusage] ccusage binary not found, falling back to 'npx -y ${NPX_PINNED_VERSION}' (fetches from the npm registry on first run)`);
		// GUI 起動でシェル環境解決に失敗すると PATH に npx が居ないことがあるため、
		// PATH 上で見つからない場合は候補ディレクトリから絶対パスで解決する
		const npxNames = isWindows ? ['npx.cmd'] : ['npx'];
		let npxCommand = npxNames[0];
		if (!(await this.canExecute(npxCommand))) {
			for (const dir of candidateDirs) {
				for (const name of npxNames) {
					const candidate = path.join(dir, name);
					if (await this.fileExists(candidate)) {
						npxCommand = candidate;
						break;
					}
				}
				if (path.isAbsolute(npxCommand)) {
					break;
				}
			}
		}
		this.resolved = { command: npxCommand, prefixArgs: ['-y', NPX_PINNED_VERSION] };
		return this.resolved;
	}

	/** コマンド名が PATH 上で実行可能か(`<cmd> --version` の成否)を確認する。 */
	private async canExecute(command: string): Promise<boolean> {
		const env = await this.getExecEnv();
		const shimInvocation = process.platform === 'win32' ? paradisWrapWindowsScriptShim(command, ['--version']) : undefined;
		return new Promise<boolean>(resolve => {
			const execution: { child?: cp.ChildProcess; tracked?: IParadisTrackedChildProcess; completed: boolean } = { completed: false };
			execution.child = this.execFile(shimInvocation?.file ?? command, shimInvocation?.args ?? ['--version'], { windowsHide: true, windowsVerbatimArguments: shimInvocation !== undefined, env }, err => {
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
			fs.access(filePath, fs.constants.X_OK, err => resolve(!err));
		});
	}
}

// 接続先（REH）へも同じチャネルを生やすため context は型引数にしておく（中身では使わない）。
export class ParadisCcusageChannel<TContext = string> implements IServerChannel<TContext> {

	constructor(private readonly service: ParadisCcusageService) { }

	listen<T>(_ctx: TContext, event: string): Event<T> {
		throw new Error(`Event not found: ${event}`);
	}

	call<T>(_ctx: TContext, command: string, arg?: unknown): Promise<T> {
		if (command === 'setWarmLease') {
			const payload = parseWarmLeasePayload(arg);
			this.service.setWarmLease(payload.ownerId, payload.active ? payload.targets : []);
			return Promise.resolve(undefined as T);
		}
		const args = Array.isArray(arg) ? arg : [];
		const options = (args[0] ?? {}) as IParadisCcusageExecOptions;
		switch (command) {
			case 'fetchDaily': return this.service.fetchDaily(options) as Promise<T>;
			case 'fetchActiveBlock': return this.service.fetchActiveBlock(options) as Promise<T>;
			case 'fetchRecentSessions': return this.service.fetchRecentSessions(options) as Promise<T>;
			case 'fetchProjects': return this.service.fetchProjects(options) as Promise<T>;
			default:
				throw new Error(`Method not found: ${command}`);
		}
	}
}

function parseWarmLeasePayload(arg: unknown): ParadisCcusageWarmLeasePayload {
	if (!isExactPlainArray(arg) || arg.length !== 1 || !isExactPlainRecord(arg[0], ['ownerId', 'active', 'targets'])) {
		throw new Error('Invalid setWarmLease arguments');
	}
	const payload = arg[0];
	if (typeof payload.ownerId !== 'string'
		|| !WARM_LEASE_OWNER_ID_PATTERN.test(payload.ownerId)
		|| typeof payload.active !== 'boolean'
		|| !Array.isArray(payload.targets)) {
		throw new Error('Invalid warm lease payload');
	}
	if ((!payload.active && payload.targets.length !== 0)
		|| (payload.active && (payload.targets.length === 0 || payload.targets.length > WARM_LEASE_MAX_TARGETS_PER_OWNER))) {
		throw new Error('Invalid warm lease target count');
	}
	if (!isExactPlainArray(payload.targets)) {
		throw new Error('Invalid warm lease targets array');
	}

	const targets: ParadisCcusageWarmTarget[] = [];
	const kinds = new Set<ParadisCcusageWarmTargetKind>();
	for (const value of payload.targets) {
		const target = parseWarmTarget(value);
		if (kinds.has(target.kind)) {
			throw new Error('Duplicate warm lease target');
		}
		kinds.add(target.kind);
		targets.push(target);
	}
	return { ownerId: payload.ownerId, active: payload.active, targets };
}

function parseWarmTarget(value: unknown): ParadisCcusageWarmTarget {
	if (!isExactPlainRecord(value, ['kind', 'options'])
		|| (value.kind !== 'daily' && value.kind !== 'blocks' && value.kind !== 'session' && value.kind !== 'projects')
		|| !isPlainRecord(value.options)) {
		throw new Error('Invalid warm lease target');
	}
	const kind = value.kind;
	const optionKeys = kind === 'blocks'
		? (Object.prototype.hasOwnProperty.call(value.options, 'executablePath') ? ['executablePath'] : [])
		: (Object.prototype.hasOwnProperty.call(value.options, 'executablePath') ? ['executablePath', 'since'] : ['since']);
	if (!isExactPlainRecord(value.options, optionKeys)) {
		throw new Error('Invalid warm lease target options');
	}
	const executablePath = value.options.executablePath;
	if (executablePath !== undefined && (typeof executablePath !== 'string'
		|| executablePath.length === 0
		|| executablePath.length > WARM_LEASE_MAX_EXECUTABLE_PATH_LENGTH
		|| executablePath.trim() !== executablePath)) {
		throw new Error('Invalid warm lease executable path');
	}
	const since = value.options.since;
	if (kind === 'blocks') {
		if (since !== undefined) {
			throw new Error('Invalid blocks warm lease target');
		}
	} else if (typeof since !== 'string' || !/^\d{8}$/.test(since)) {
		throw new Error('Invalid warm lease since date');
	}
	return {
		kind,
		options: {
			...(executablePath === undefined ? {} : { executablePath }),
			...(since === undefined ? {} : { since }),
		},
	};
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
	if (value === null || typeof value !== 'object' || Array.isArray(value)) {
		return false;
	}
	const prototype = Object.getPrototypeOf(value);
	return prototype === Object.prototype || prototype === null;
}

function isExactPlainArray(value: unknown): value is unknown[] {
	if (!Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype || Reflect.ownKeys(value).length !== value.length + 1) {
		return false;
	}
	for (let index = 0; index < value.length; index++) {
		const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
		if (!descriptor || !descriptor.enumerable || !Object.prototype.hasOwnProperty.call(descriptor, 'value')) {
			return false;
		}
	}
	return true;
}

function isExactPlainRecord(value: unknown, expectedKeys: readonly string[]): value is Record<string, unknown> {
	if (!isPlainRecord(value)) {
		return false;
	}
	const keys = Reflect.ownKeys(value);
	if (keys.length !== expectedKeys.length || keys.some(key => typeof key !== 'string' || !expectedKeys.includes(key))) {
		return false;
	}
	return expectedKeys.every(key => {
		const descriptor = Object.getOwnPropertyDescriptor(value, key);
		return descriptor?.enumerable === true && Object.prototype.hasOwnProperty.call(descriptor, 'value');
	});
}

/**
 * REH (接続先) 側の登録。SSH で繋いでいる間、使った量は接続先の `~/.claude` に記録されるので、
 * 手元で数えるとその分がまるごと抜ける。同じチャネルを接続先にも生やし、繋いでいるウィンドウは
 * そちらへ聞く。
 *
 * 設定と起動引数は渡さない（どちらも省略可で、シェル環境の解決だけに使う）。接続先には
 * このアプリの設定も引数も無いため、既定の解決に任せる。
 */
export function registerParadisCcusageForServer<TContext>(server: IPCServer<TContext>, logService: ILogService): IDisposable {
	const service = new ParadisCcusageService(logService);
	server.registerChannel(PARADIS_CCUSAGE_CHANNEL, new ParadisCcusageChannel<TContext>(service));
	return { dispose: () => service.dispose() };
}

/**
 * sharedProcessMain.ts の PARA-PATCH 点から1行で呼べるファクトリ。
 */
export function registerParadisCcusage(server: IPCServer<string>, logService: ILogService, configurationService: IConfigurationService, args: NativeParsedArgs): IDisposable {
	const service = new ParadisCcusageService(logService, configurationService, args);
	server.registerChannel(PARADIS_CCUSAGE_CHANNEL, new ParadisCcusageChannel<string>(service));
	// バックグラウンド更新のタイマーを止める(unref 済みだが、明示的に畳んでおく)。
	return { dispose: () => service.dispose() };
}
