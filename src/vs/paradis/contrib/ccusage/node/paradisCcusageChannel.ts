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
import { homedir } from 'os';
import { RunOnceScheduler } from '../../../../base/common/async.js';
import { Event } from '../../../../base/common/event.js';
import * as path from '../../../../base/common/path.js';
import { IDisposable } from '../../../../base/common/lifecycle.js';
import { IPCServer, IServerChannel } from '../../../../base/parts/ipc/common/ipc.js';
import { IConfigurationService } from '../../../../platform/configuration/common/configuration.js';
import { paradisAgentCliFallbackDirs, paradisResolveAgentCli } from '../../../node/paradisAgentCli.js';
import { paradisCodexHomes } from '../../agentBrowser/node/paradisAgentHome.js';
import { IParadisTrackedChildProcess, ParadisChildProcessTreeTracker, paradisKillExitedProcessGroup } from '../../../node/paradisKillChildProcess.js';
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
	IParadisCcusageReportResult,
	IParadisCcusageReportValues,
	IParadisCcusageService,
	IParadisCcusageSessionRow,
	PARADIS_CCUSAGE_CHANNEL,
	PARADIS_CCUSAGE_FETCH_REPORT_COMMAND,
	PARADIS_CCUSAGE_SETTING_ARCHIVE_DIRS,
	PARADIS_CCUSAGE_SETTING_EXEC_TIMEOUT_SECONDS,
	PARADIS_CCUSAGE_TIMEZONE_PATTERN,
	ParadisCcusageProjects,
	ParadisCcusageWarmLeasePayload,
	ParadisCcusageWarmTarget,
	ParadisCcusageWarmTargetKind,
} from '../common/paradisCcusage.js';

/**
 * ccusage 実行のタイムアウトの既定値。JSONL 全走査+価格取得があるため長め。
 * 設定 `paradis.ccusage.execTimeoutSeconds` が明示されていればそちらを優先する
 * (実測でセッションログが数十GBある環境では既定値でも足りないことがあるため)。
 */
const DEFAULT_EXEC_TIMEOUT_MS = 180_000;
const MIN_EXEC_TIMEOUT_MS = 10_000;
/**
 * 上限を10分にしてあるのは、warm(定期先取り更新)が daily/blocks/session/projects の4種を
 * 直列に実行するため(runWarmPass)。1本ごとの上限を長くすると「対象数 × タイムアウト」で
 * 1周の所要が伸び、CACHE_TTL_MS を前提にした「周期内に必ず温め直す」不変条件が崩れる。
 * ただし warm と裏の取り直しは BACKGROUND_MIN_EXEC_TIMEOUT_MS まで走らせるので、ログが多い PC ではこの
 * 不変条件は守れない。TTL を過ぎた値は古い値（stale）として返すので、待たせることにはならない。
 */
const MAX_EXEC_TIMEOUT_MS = 10 * 60_000;
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
/**
 * TTL を過ぎた前回の値を「古い値」として返してよい長さ。ccusage はログが多いと1回に数分かかる
 * (実測で 400 秒を超える PC がある)。TTL が切れるたびに完了を待たせると、モバイルも PC の画面も
 * その間ずっと読み込み中になるので、前回の値をすぐ返して裏で取り直す。取得時刻は値に添えて返すので、
 * 古さは表示側が見せられる。メモリ上のキャッシュなので、実際には shared process が生きている間に限られる。
 */
const STALE_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;
/**
 * 古い値を返したときの裏の取り直しが失敗し続けたときの間隔(指数で伸ばす)。毎回の要求で
 * タイムアウトまで走る ccusage を起こし直さないため。手動更新(bypassCache)と warm は対象外。
 */
const REVALIDATE_BACKOFF_START_MS = 5 * 60 * 1000;
const REVALIDATE_BACKOFF_MAX_MS = 60 * 60 * 1000;
/**
 * ccusage の実行そのものの上限の下限。設定 `paradis.ccusage.execTimeoutSeconds` は「待たせる長さ」の
 * 上限で、待っている側だけをそこで打ち切る(実行は止めない)。ログが多い PC では 1 本が 400 秒を超える
 * ため、設定値で実行まで打ち切ると値がいつまでも埋まらない。実行は max(設定値, この値) まで走らせる。
 */
const BACKGROUND_MIN_EXEC_TIMEOUT_MS = 15 * 60_000;
/**
 * 値が無いまま前景の実行が失敗したとき、同じキャッシュの鍵の次の要求へ失敗をそのまま返す長さ。
 * 開くたびに設定の上限まで走る実行を起こし直さない(裏の長い実行が走っていれば、それに相乗りする)。
 */
const NEGATIVE_CACHE_MS = 2 * 60_000;
/** 連続で失敗し続ける対象を諦める回数(ccusage が入っていない環境で永久に走らせない)。 */
const WARM_MAX_CONSECUTIVE_FAILURES = 3;
const WARM_LEASE_MAX_OWNERS = 128;
const WARM_LEASE_MAX_MEMBERSHIPS = 512;
const WARM_LEASE_MAX_TARGETS_PER_OWNER = 4;
const WARM_LEASE_MAX_EXECUTABLE_PATH_LENGTH = 4096;
const WARM_LEASE_OWNER_ID_PATTERN = /^[A-Za-z0-9._:-]{1,160}$/;
/**
 * アーカイブの置き場があるかを見直す間隔。キャッシュの鍵を作るたびに見るので、毎回ディスクを見に行かない。
 * 外付けのディスクを抜き差ししても、この長さが過ぎれば次の要求から新しい鍵（＝新しい状態の値）になる。
 */
const ARCHIVE_PROBE_TTL_MS = 10_000;
/**
 * 置き場を1回確かめる長さの上限。切れたネットワークのディスクや回転待ちのディスクでは stat が返ってこないので、
 * これを過ぎたら「無い」とみなす。
 */
const ARCHIVE_PROBE_TIMEOUT_MS = 2_000;
/**
 * 返ってきていない stat の上限。打ち切っても止まった stat は libuv のスレッドプール（既定 4 本）を占めたままに
 * なるので、積もるとこのプロセスの非同期の fs・dns・zlib・crypto がすべて止まる。これ以上は新しい stat を出さない。
 */
const ARCHIVE_PROBE_MAX_PENDING_STATS = 2;

/**
 * ccusage に手元の記録と一緒に読ませるアーカイブ（設定 `paradis.ccusage.archiveDirs`）のうち、いま実在するもの。
 * 外付けのディスクが外れていれば空になり、env は今までと同じになる。
 */
export interface IParadisCcusageArchives {
	/** `projects/` を持つ Claude の置き場（`<根>/claude`）。 */
	readonly claude: readonly string[];
	/** `sessions/` か `archived_sessions/` を持つ Codex の置き場（`<根>/codex`）。 */
	readonly codex: readonly string[];
}

const NO_ARCHIVES: IParadisCcusageArchives = { claude: [], codex: [] };

interface IWarmFailure {
	readonly generation: number;
	readonly count: number;
}

interface IInflightReport {
	readonly promise: Promise<ICompletedReport>;
	/** キャッシュの鍵（`--since` を除いたもの）。 */
	readonly familyKey: string;
	foregroundCacheInterest: boolean;
}

interface ICompletedReport {
	readonly value: unknown;
	/** 取り終えた時刻。 */
	readonly at: number;
}

/**
 * キャッシュの1件。鍵は `--since` を除いた実行引数と実行ファイル（cacheFamilyKeyFor）で、
 * どの `--since` で取った値かはここに持つ。日付が変わって `--since` が1日進んでも、前日の値を古い値として返せる
 * （鍵に `--since` を含めると、日付が変わった瞬間に全部が見つからなくなり、最初の要求が完了まで待たされる）。
 */
interface ICacheEntry {
	readonly at: number;
	readonly ttl: number;
	readonly value: unknown;
	/** この値を取ったときの `--since`（無ければ undefined）。 */
	readonly since: string | undefined;
}

interface IRevalidateFailure {
	readonly count: number;
	readonly retryAt: number;
}

interface INegativeCacheEntry {
	readonly at: number;
	readonly error: unknown;
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
	/** レポート結果のキャッシュ(キー: `--since` を除いた実行引数+実行ファイルパス。{@link ICacheEntry})。 */
	private readonly cache = new Map<string, ICacheEntry>();
	/** 実行中リクエストの共有(同一キーの同時要求を1本にまとめる。キーは `--since` を含む実行引数+実行ファイルパス)。 */
	private readonly inflight = new Map<string, IInflightReport>();
	/** 古い値を返した後の裏の取り直しが失敗したキャッシュの鍵と、次に試してよい時刻。 */
	private readonly revalidateFailures = new Map<string, IRevalidateFailure>();
	/** 値が無いまま前景の実行が失敗したキャッシュの鍵（{@link NEGATIVE_CACHE_MS}）。 */
	private readonly negativeCache = new Map<string, INegativeCacheEntry>();
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
	/** 直前に見たアーカイブの置き場（{@link ARCHIVE_PROBE_TTL_MS}）。 */
	private archiveProbe: { readonly at: number; readonly setting: string; readonly archives: IParadisCcusageArchives } | undefined;
	/** 走っている置き場の確認（同じ設定の確認は1本にまとめる）。 */
	private archiveProbing: { readonly setting: string; readonly promise: Promise<void> } | undefined;
	private readonly archiveSettingListener: IDisposable | undefined;
	/**
	 * ログインシェル由来の解決済み環境(PATH 等)。shared process は Dock/Spotlight 起動の
	 * electron-main から process.env を継承するだけなので、GUI 起動では ~/.zshrc 等で
	 * nvm/volta/fnm が足す PATH が反映されず 'npx'/'ccusage' が ENOENT になりうる。
	 * getResolvedShellEnv は VS Code 本体が拡張機能ホスト起動時などに使う既存の解決ロジック。
	 */
	private readonly cachedShellEnv: ParadisCachedShellEnv;

	constructor(
		private readonly logService: ILogService,
		private readonly configurationService?: IConfigurationService,
		args?: NativeParsedArgs,
		private readonly execFile: typeof cp.execFile = cp.execFile,
		private readonly now: () => number = Date.now,
		warmLeaseSchedulerFactory: WarmLeaseSchedulerFactory = runner => new RunOnceScheduler(runner, 0),
		/** 設定 `paradis.ccusage.archiveDirs` を読むか。手元の shared process だけが読む（SSH の接続先では読まない）。 */
		private readonly readsArchives = false,
		private readonly probeArchives: (roots: readonly string[]) => Promise<IParadisCcusageArchives> = roots => defaultArchiveProber.probe(roots),
	) {
		// POSIX では ccusage を自分のプロセスグループで起こし(paradisCcusageProcessGroupOptions)、止めるときは
		// グループごと止める。npx 経由だと子は npx で、実体の node(ccusage)は孫になる。子だけを止めると孫が
		// 孤児として走査を続け、次の要求がまた新しい ccusage を起こす(ログが多い PC で数本が同時に残っていた)。
		// Windows はツリーごと止める(paradisKillChildProcessTree)。
		this.childProcesses = new ParadisChildProcessTreeTracker(
			error => this.logService.trace('[ParadisCcusage] failed to stop child process: ' + error),
			{ processGroup: true },
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
		if (readsArchives) {
			// 要求が来る前に確かめておく（設定を変えたときも）。最初の要求が確認を待たずに済むように
			this.archiveSettingListener = configurationService?.onDidChangeConfiguration(e => {
				if (e.affectsConfiguration(PARADIS_CCUSAGE_SETTING_ARCHIVE_DIRS)) {
					this.currentArchives();
				}
			});
			this.currentArchives();
		}
	}

	/** 設定 paradis.ccusage.execTimeoutSeconds(未設定なら既定値)から実行タイムアウトを求める。 */
	private getExecTimeoutMs(): number {
		const seconds = this.configurationService?.getValue<number>(PARADIS_CCUSAGE_SETTING_EXEC_TIMEOUT_SECONDS);
		if (typeof seconds !== 'number' || !Number.isFinite(seconds) || seconds <= 0) {
			return DEFAULT_EXEC_TIMEOUT_MS;
		}
		return Math.min(Math.max(seconds * 1000, MIN_EXEC_TIMEOUT_MS), MAX_EXEC_TIMEOUT_MS);
	}

	/** 誰も完了を待っていない実行の上限（{@link BACKGROUND_MIN_EXEC_TIMEOUT_MS}）。 */
	private getBackgroundExecTimeoutMs(): number {
		return Math.max(this.getExecTimeoutMs(), BACKGROUND_MIN_EXEC_TIMEOUT_MS);
	}

	/** exec に渡す環境変数(process.env にログインシェル解決分をマージしたもの)。 */
	private getExecEnv(): Promise<NodeJS.ProcessEnv> {
		return this.cachedShellEnv.getEnv();
	}

	/** 設定 `paradis.ccusage.archiveDirs` の根（文字列だけ）と、それを比べるための文字列。読まないときは undefined。 */
	private archiveSetting(): { readonly roots: readonly string[]; readonly setting: string } | undefined {
		if (!this.readsArchives) {
			return undefined;
		}
		const configured = this.configurationService?.getValue<unknown>(PARADIS_CCUSAGE_SETTING_ARCHIVE_DIRS);
		const roots = Array.isArray(configured) ? configured.filter((root): root is string => typeof root === 'string') : [];
		return roots.length === 0 ? undefined : { roots, setting: JSON.stringify(roots) };
	}

	/**
	 * いま読めるアーカイブ。キャッシュの鍵に含め、同じ値で ccusage を実行する（鍵と実際に読んだものを揃える）。
	 * ディスクは見に行かず、直前の確認の結果を返す。結果が {@link ARCHIVE_PROBE_TTL_MS} より古ければ裏で確かめ直し、
	 * 新しい結果は次の要求から使う（抜き差しを拾うため）。
	 */
	private currentArchives(): IParadisCcusageArchives {
		const configured = this.archiveSetting();
		if (!configured) {
			return NO_ARCHIVES;
		}
		const probe = this.archiveProbe;
		if (!probe || probe.setting !== configured.setting || this.now() - probe.at >= ARCHIVE_PROBE_TTL_MS) {
			void this.refreshArchives(configured.roots, configured.setting);
		}
		return probe?.setting === configured.setting ? probe.archives : NO_ARCHIVES;
	}

	/**
	 * 今の設定をまだ一度も確かめ終えていなければ、その確認を待つ（{@link ARCHIVE_PROBE_TIMEOUT_MS} が上限）。
	 * 起動直後や設定を変えた直後の要求が、置き場を読まない値を取ってしまわないようにする。
	 * 一度でも確かめ終えていれば待たない（undefined を返す）。
	 */
	private archivesReady(): Promise<void> | undefined {
		const configured = this.archiveSetting();
		return configured && this.archiveProbe?.setting !== configured.setting ? this.refreshArchives(configured.roots, configured.setting) : undefined;
	}

	private refreshArchives(roots: readonly string[], setting: string): Promise<void> {
		if (this.archiveProbing?.setting === setting) {
			return this.archiveProbing.promise;
		}
		const promise = this.probeArchives(roots).then(
			archives => archives,
			() => NO_ARCHIVES,
		).then(archives => {
			if (!this.disposed) {
				this.archiveProbe = { at: this.now(), setting, archives };
			}
		}).finally(() => {
			if (this.archiveProbing?.promise === promise) {
				this.archiveProbing = undefined;
			}
		});
		this.archiveProbing = { setting, promise };
		return promise;
	}

	async fetchDaily(options: IParadisCcusageExecOptions): Promise<IParadisCcusageDailyRow[]> {
		return (await this.fetchReport('daily', options)).value;
	}

	async fetchActiveBlock(options: IParadisCcusageExecOptions): Promise<IParadisCcusageBlock | undefined> {
		return (await this.fetchReport('blocks', options)).value;
	}

	async fetchRecentSessions(options: IParadisCcusageExecOptions): Promise<IParadisCcusageSessionRow[]> {
		return (await this.fetchReport('session', options)).value;
	}

	async fetchProjects(options: IParadisCcusageExecOptions): Promise<ParadisCcusageProjects> {
		return (await this.fetchReport('projects', options)).value;
	}

	async fetchReport<K extends ParadisCcusageWarmTargetKind>(kind: K, options: IParadisCcusageExecOptions): Promise<IParadisCcusageReportResult<IParadisCcusageReportValues[K]>> {
		const ttl = kind === 'blocks' ? BLOCK_CACHE_TTL_MS : CACHE_TTL_MS;
		const result = await this.execJson<unknown>([...warmReportArgs[kind]], options, ttl);
		return { ...result, value: paradisCcusageReportValue(kind, result.value) };
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
	private async execJson<T>(reportArgs: string[], options: IParadisCcusageExecOptions, ttl: number = CACHE_TTL_MS): Promise<IParadisCcusageReportResult<T>> {
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
			// dispose 後は残りを回さない(1本あたり既定180秒・設定次第で最大30分待つので、
			// 畳んだ後も子プロセスが続きうる)。
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
			const reportArgs = [...warmReportArgs[target.kind]];
			const archives = this.currentArchives();
			const cached = this.cache.get(this.cacheFamilyKeyFor(reportArgs, target.options, archives));
			if (cached && cached.since === sinceArg(target.options) && now - cached.at < WARM_SKIP_IF_FRESHER_THAN_MS) {
				continue;
			}
			if (this.inflight.has(this.runKeyFor(reportArgs, target.options, archives))) {
				continue;
			}
			try {
				// 鮮度判定はここで済ませているので、キャッシュを見に行かせず必ず実行させる。
				const ttl = target.kind === 'blocks' ? BLOCK_CACHE_TTL_MS : CACHE_TTL_MS;
				await this.execJsonInternal(reportArgs, { ...target.options, bypassCache: true }, ttl, () => this.warmLeaseTracker.isCurrent(key, generation), false, true);
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

	/** warm の対象の鍵。since/until/timezone を含む実行引数と実行ファイルパスで決まる（アーカイブの有無では変えない）。 */
	private cacheKeyFor(reportArgs: string[], options: IParadisCcusageExecOptions): string {
		return JSON.stringify([this.buildArgs(reportArgs, options), options.executablePath ?? '']);
	}

	/** 実行の鍵（同時実行の束ね）。{@link cacheKeyFor} に、読ませたアーカイブを足したもの。 */
	private runKeyFor(reportArgs: string[], options: IParadisCcusageExecOptions, archives: IParadisCcusageArchives): string {
		return JSON.stringify([this.buildArgs(reportArgs, options), options.executablePath ?? '', archives]);
	}

	/**
	 * キャッシュの鍵。{@link runKeyFor} から `--since` だけを除いたもの。`--since` は「今日から 90 日前」で
	 * 毎日1日ずつ進むので、鍵に含めると日付が変わるたびに前日の値が引けなくなる。until・timezone・
	 * 実行ファイルは値の意味を変えるので鍵に残す。読ませたアーカイブも残す（外付けのディスクを抜き差ししたときに、
	 * 前の状態で数えた値を出し続けないため）。
	 */
	private cacheFamilyKeyFor(reportArgs: string[], options: IParadisCcusageExecOptions, archives: IParadisCcusageArchives): string {
		return JSON.stringify([this.buildArgs(reportArgs, { ...options, since: undefined }), options.executablePath ?? '', archives]);
	}

	private buildArgs(reportArgs: string[], options: IParadisCcusageExecOptions): string[] {
		const args = [...reportArgs, '--json'];
		if (options.since && /^\d{8}$/.test(options.since)) {
			args.push('--since', options.since);
		}
		if (options.until && /^\d{8}$/.test(options.until)) {
			args.push('--until', options.until);
		}
		if (options.timezone && PARADIS_CCUSAGE_TIMEZONE_PATTERN.test(options.timezone)) {
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
		this.archiveSettingListener?.dispose();
		this.warmLeaseTracker.dispose();
		this.warmLeaseOwners.clear();
		this.warmFailures.clear();
		this.revalidateFailures.clear();
		this.negativeCache.clear();
		this.childProcesses.dispose();
	}

	/**
	 * キャッシュを見て返すか、ccusage を実行する。
	 * - TTL 内で同じ `--since` の値: そのまま返す
	 * - TTL を過ぎた値・別の `--since` で取った値（STALE_MAX_AGE_MS 以内）: すぐ `stale: true` で返し、
	 *   裏で取り直す（同じ鍵の実行は1本に束ねる。取り直しが失敗し続けたら間隔を伸ばす）
	 * - 値が無い・bypassCache: 実行の完了を待つ
	 */
	private async execJsonInternal<T>(
		reportArgs: string[],
		options: IParadisCcusageExecOptions,
		ttl: number = CACHE_TTL_MS,
		shouldCache: () => boolean = () => true,
		foregroundCacheInterest = true,
		background = false,
	): Promise<IParadisCcusageReportResult<T>> {
		const ready = this.archivesReady();
		if (ready) {
			await ready;
		}
		const archives = this.currentArchives();
		const familyKey = this.cacheFamilyKeyFor(reportArgs, options, archives);
		if (!options.bypassCache) {
			const cached = this.cache.get(familyKey);
			if (cached) {
				const age = this.now() - cached.at;
				if (cached.since === sinceArg(options) && age < cached.ttl) {
					return { value: cached.value as T, fetchedAt: cached.at, stale: false };
				}
				if (age < STALE_MAX_AGE_MS) {
					this.revalidate(reportArgs, options, ttl, archives);
					return { value: cached.value as T, fetchedAt: cached.at, stale: true };
				}
			}
		}
		if (!options.bypassCache && !background) {
			// 値が無いまま直前に失敗した: 裏の長い実行が走っていれば相乗りし、無ければ同じ失敗を返す
			const negative = this.negativeCache.get(familyKey);
			if (negative && this.now() - negative.at < NEGATIVE_CACHE_MS) {
				const running = this.inflightForFamily(familyKey);
				if (!running) {
					throw negative.error;
				}
				const joined = await this.waitWithinForegroundLimit(running.promise);
				return { value: joined.value as T, fetchedAt: joined.at, stale: false };
			}
		}
		try {
			const running = this.run(reportArgs, options, archives, ttl, shouldCache, foregroundCacheInterest);
			const completed = background ? await running : await this.waitWithinForegroundLimit(running);
			return { value: completed.value as T, fetchedAt: completed.at, stale: false };
		} catch (error) {
			if (!background && !this.disposed) {
				// 時間切れでも実行そのものは裏の上限まで続き、終われば値が入る（その間の要求は相乗りする）
				this.negativeCache.set(familyKey, { at: this.now(), error });
			}
			throw error;
		}
	}

	/**
	 * 待っている側だけを設定 `paradis.ccusage.execTimeoutSeconds` で打ち切る。実行は止めない（同じ走査を
	 * やり直さないため。裏の上限 {@link BACKGROUND_MIN_EXEC_TIMEOUT_MS} 以上まで走り、終わればキャッシュに入る）。
	 */
	private waitWithinForegroundLimit<T>(promise: Promise<T>): Promise<T> {
		const limitMs = this.getExecTimeoutMs();
		return new Promise<T>((resolve, reject) => {
			const timer = setTimeout(() => {
				const error: IParadisExecError = new Error(`command timed out after ${limitMs}ms (still running in the background)`);
				error.timedOut = true;
				reject(error);
			}, limitMs);
			promise.then(value => {
				clearTimeout(timer);
				resolve(value);
			}, error => {
				clearTimeout(timer);
				reject(error);
			});
		});
	}

	/** 同じキャッシュの鍵で走っている実行（`--since` だけ違うものを含む）。 */
	private inflightForFamily(familyKey: string): IInflightReport | undefined {
		return [...this.inflight.values()].find(record => record.familyKey === familyKey);
	}

	/** 古い値を返した後の裏の取り直し。失敗はログだけにして、次に試してよい時刻を遅らせる。 */
	private revalidate(reportArgs: string[], options: IParadisCcusageExecOptions, ttl: number, archives: IParadisCcusageArchives): void {
		const familyKey = this.cacheFamilyKeyFor(reportArgs, options, archives);
		// 同じキャッシュの鍵で走っているものがあれば（`--since` だけ違う実行を含む）、それが終われば値が入るので起こさない。
		if (this.disposed || this.inflightForFamily(familyKey)) {
			return;
		}
		const failure = this.revalidateFailures.get(familyKey);
		if (failure && this.now() < failure.retryAt) {
			return;
		}
		this.run(reportArgs, { ...options, bypassCache: true }, archives, ttl, () => true, true).then(() => {
			this.revalidateFailures.delete(familyKey);
		}, error => {
			const count = (this.revalidateFailures.get(familyKey)?.count ?? 0) + 1;
			const delay = Math.min(REVALIDATE_BACKOFF_MAX_MS, REVALIDATE_BACKOFF_START_MS * Math.pow(2, count - 1));
			if (!this.disposed) {
				this.revalidateFailures.set(familyKey, { count, retryAt: this.now() + delay });
			}
			this.logService.trace(`[ParadisCcusage] background revalidation failed for 'ccusage ${reportArgs.join(' ')}' (${count} in a row): ${error}`);
		});
	}

	/** ccusage を実行してキャッシュへ入れる。同じ鍵の実行中のものがあれば相乗りする。 */
	private run(
		reportArgs: string[],
		options: IParadisCcusageExecOptions,
		archives: IParadisCcusageArchives,
		ttl: number,
		shouldCache: () => boolean,
		foregroundCacheInterest: boolean,
	): Promise<ICompletedReport> {
		const args = this.buildArgs(reportArgs, options);
		const cacheKey = this.runKeyFor(reportArgs, options, archives);
		const familyKey = this.cacheFamilyKeyFor(reportArgs, options, archives);
		// bypassCache でも実行中の同一リクエストには相乗りする(結果はどのみち今まさに取り直したもの)
		const inflight = this.inflight.get(cacheKey);
		if (inflight) {
			inflight.foregroundCacheInterest ||= foregroundCacheInterest;
			return inflight.promise;
		}

		const record: IInflightReport = {
			familyKey,
			foregroundCacheInterest,
			// 実行の上限は常に裏の上限。待っている側の上限は waitWithinForegroundLimit が持つ
			promise: this.doExecJson<unknown>(reportArgs, args, options, archives, this.getBackgroundExecTimeoutMs())
				.then(({ value, usedOfflineFallback }) => {
					const at = this.now();
					this.negativeCache.delete(familyKey);
					if (!this.disposed && (record.foregroundCacheInterest || shouldCache())) {
						this.pruneCache();
						this.cache.set(familyKey, { at, ttl: usedOfflineFallback ? FALLBACK_CACHE_TTL_MS : ttl, value, since: sinceArg(options) });
					}
					return { value, at };
				})
				.finally(() => {
					if (this.inflight.get(cacheKey) === record) {
						this.inflight.delete(cacheKey);
					}
				}),
		};
		this.inflight.set(cacheKey, record);
		return record.promise;
	}

	/** 古い値としても返せなくなったエントリの掃除。 */
	private pruneCache(): void {
		const now = this.now();
		for (const [key, entry] of this.cache) {
			if (now - entry.at >= STALE_MAX_AGE_MS) {
				this.cache.delete(key);
			}
		}
	}

	private async doExecJson<T>(reportArgs: string[], args: string[], options: IParadisCcusageExecOptions, archives: IParadisCcusageArchives, timeoutMs: number): Promise<{ value: T; usedOfflineFallback: boolean }> {
		const executable = await this.resolveExecutable(options.executablePath);
		let stdout: string;
		let usedOfflineFallback = false;
		try {
			stdout = await this.exec(executable, args, archives, timeoutMs);
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
				stdout = await this.exec(executable, [...args, '--offline'], archives, timeoutMs);
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

	private async exec(executable: IResolvedExecutable, args: string[], archives: IParadisCcusageArchives, timeoutMs: number): Promise<string> {
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
				...paradisCcusageProcessGroupOptions(),
				env: { ...paradisCcusageDataEnv(env, paradisCodexHomes(), archives), NO_COLOR: '1', LOG_LEVEL: '0' }
			}, (err, stdout, stderr) => {
				execution.completed = true;
				const timedOut = execution.tracked?.timedOut === true;
				execution.tracked?.dispose();
				if (err || timedOut) {
					const message = stderr?.trim() || (timedOut ? `command timed out after ${timeoutMs}ms` : err!.message);
					this.logService.warn(`[ParadisCcusage] ${executable.command} ${fullArgs.join(' ')} failed: ${message}`);
					// 実行自体に失敗した場合は次回に別の候補を試せるようキャッシュを破棄する
					this.resolved = undefined;
					const execError: IParadisExecError = new Error(message);
					if (err) {
						execError.spawnFailed = (err as NodeJS.ErrnoException).code === 'ENOENT';
					}
					execError.timedOut = timedOut;
					reject(execError);
				} else {
					resolve(stdout);
				}
			});
			watchProcessGroupExit(execution.child);
			if (!execution.completed && execution.child) {
				execution.tracked = this.childProcesses.track(execution.child, timeoutMs);
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
		const isWindows = process.platform === 'win32';
		// 候補の場所は paradisResolveAgentCli と共通。PATH 上にあるかは `ccusage --version` が通るかで
		// 確かめ、そのときはコマンド名のまま execFile に渡す。
		const found = await paradisResolveAgentCli('ccusage', {}, { isOnPath: name => this.canExecute(name), fileExists: candidate => this.fileExists(candidate) });
		if (found !== undefined) {
			this.resolved = { command: found, prefixArgs: [] };
			return this.resolved;
		}
		const candidateDirs = paradisAgentCliFallbackDirs('ccusage');

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
			execution.child = this.execFile(shimInvocation?.file ?? command, shimInvocation?.args ?? ['--version'], { windowsHide: true, windowsVerbatimArguments: shimInvocation !== undefined, ...paradisCcusageProcessGroupOptions(), env }, err => {
				execution.completed = true;
				const timedOut = execution.tracked?.timedOut === true;
				execution.tracked?.dispose();
				resolve(!err && !timedOut);
			});
			watchProcessGroupExit(execution.child);
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

/** 値を取ったときの `--since`（buildArgs と同じ条件。渡されないものは undefined）。 */
function sinceArg(options: IParadisCcusageExecOptions): string | undefined {
	return options.since && /^\d{8}$/.test(options.since) ? options.since : undefined;
}

/** ccusage の JSON 出力から、レポートの種類ごとの値を取り出す（形が違っても落ちない）。 */
function paradisCcusageReportValue<K extends ParadisCcusageWarmTargetKind>(kind: K, output: unknown): IParadisCcusageReportValues[K] {
	const record = (output !== null && typeof output === 'object' ? output : {}) as { daily?: unknown; blocks?: unknown; sessions?: unknown; projects?: unknown };
	switch (kind) {
		case 'daily':
			return (Array.isArray(record.daily) ? record.daily : []) as IParadisCcusageReportValues[K];
		case 'blocks': {
			const blocks = (Array.isArray(record.blocks) ? record.blocks : []) as IParadisCcusageBlock[];
			return (blocks.find(block => block.isActive && !block.isGap) ?? blocks[0]) as IParadisCcusageReportValues[K];
		}
		case 'session':
			return (Array.isArray(record.sessions) ? record.sessions : []) as IParadisCcusageReportValues[K];
		default:
			return (record.projects !== null && typeof record.projects === 'object' ? record.projects : {}) as IParadisCcusageReportValues[K];
	}
}

/**
 * POSIX では ccusage を自分のプロセスグループで起こす(`detached`)。止めるときにグループごと止め、
 * npx の先の孫(実体の node)まで残さないため。Windows では `detached` が新しいコンソールを開くので付けない
 * (ツリーごと止める)。`detached` は execFile の型には無いが、ランタイムでは spawn へそのまま渡る。
 */
export function paradisCcusageProcessGroupOptions(platform: NodeJS.Platform = process.platform): { readonly detached?: boolean } {
	return platform === 'win32' ? {} : { detached: true };
}

/** 子が終わった瞬間に、グループに残った孫を止める（終わり方によらない。子だけが先に終わる経路があるため）。 */
function watchProcessGroupExit(child: cp.ChildProcess | undefined): void {
	if (child && typeof child.once === 'function') {
		child.once('exit', () => paradisKillExitedProcessGroup(child));
	}
}

/**
 * ccusage に読ませる Codex のホーム。アカウントを切り替えると Codex は `~/.codex-2` のような別のホームへ
 * 会話ログを書くので、Para Code が扱う全ホームを `CODEX_HOME` にカンマ区切りで渡す。ccusage 20.0.14 は
 * カンマ区切りの `CODEX_HOME` を全部読み、ホームの間で同じ会話（共有のためにハードリンク・複製したもの）を
 * 1回だけ数える（一時フォルダで実測）。ホームが1つ（既定のホームだけ、SSH の接続先）なら env を変えない
 * （利用者の `CODEX_HOME` をそのまま使う）。
 */
export function paradisCcusageCodexHomeEnv(env: NodeJS.ProcessEnv, codexHomes: readonly string[]): NodeJS.ProcessEnv {
	// カンマを含むパスは区切りと見分けられないので渡さない（そのホームだけ読まれなくなる）
	const homes = codexHomes.filter(home => !home.includes(','));
	return homes.length > 1 ? { ...env, CODEX_HOME: homes.join(',') } : env;
}

/**
 * ccusage に読ませる記録の場所を env にする。Codex のホームは {@link paradisCcusageCodexHomeEnv} のとおりで、
 * アーカイブ（{@link IParadisCcusageArchives}）があればその後ろに足す。ccusage 20.0.14 以降は `CLAUDE_CONFIG_DIR` と
 * `CODEX_HOME` のカンマ区切りを全部読み、同じ記録（Claude は message.id と requestId、Codex は response_id）を
 * 1回だけ数える。アーカイブが無ければ {@link paradisCcusageCodexHomeEnv} と同じ env を返す。
 *
 * `CLAUDE_CONFIG_DIR` を足すと ccusage の既定の場所（`$XDG_CONFIG_HOME/claude` と `~/.claude`）を見なくなるので、
 * 利用者が `CLAUDE_CONFIG_DIR` を決めていなければ既定の 2 つを先に並べる（無い方は ccusage が飛ばす）。
 * Codex もホームが 1 つのときは、利用者の `CODEX_HOME`（無ければ既定の `~/.codex`）を先に並べる。
 */
export function paradisCcusageDataEnv(env: NodeJS.ProcessEnv, codexHomes: readonly string[], archives: IParadisCcusageArchives, homeDirectory: string = env.HOME || homedir()): NodeJS.ProcessEnv {
	let result = paradisCcusageCodexHomeEnv(env, codexHomes);
	if (archives.codex.length > 0) {
		const homes = codexHomes.filter(home => !home.includes(','));
		const local = homes.length > 1 ? homes : [env.CODEX_HOME?.trim() || path.join(homeDirectory, '.codex')];
		result = { ...result, CODEX_HOME: [...local, ...archives.codex].join(',') };
	}
	if (archives.claude.length > 0) {
		const configured = env.CLAUDE_CONFIG_DIR?.trim();
		const local = configured
			? [configured]
			: [path.join(env.XDG_CONFIG_HOME?.trim() || path.join(homeDirectory, '.config'), 'claude'), path.join(homeDirectory, '.claude')];
		result = { ...result, CLAUDE_CONFIG_DIR: [...local, ...archives.claude].join(',') };
	}
	return result;
}

/**
 * 設定に書かれたアーカイブの根から、いま実在する Claude と Codex の置き場を拾う。絶対パス（`~/` と Windows の
 * `~\` は展開する）だけを見る。カンマを含むパスは区切りと見分けられないので渡さない。外付けのディスクが
 * 外れていれば何も拾わない。
 *
 * 切れたネットワークのディスクや回転待ちのディスクで stat が返ってこなくても shared process を止めないよう、
 * stat は非同期で1本ずつ出し、{@link ARCHIVE_PROBE_TIMEOUT_MS} を過ぎたらその根は「無い」とみなして残りを見ない。
 * 打ち切った stat は返ってくるまで覚えておき、その間は同じパスに新しい stat を出さない。返ってきていない stat が
 * {@link ARCHIVE_PROBE_MAX_PENDING_STATS} 本あれば、どこにも出さない（スレッドプールを埋めないため）。
 */
export class ParadisCcusageArchiveProber {

	/** 出したまま返ってきていない stat のパス。 */
	private readonly pending = new Set<string>();

	constructor(
		private readonly isDirectory: (candidate: string) => Promise<boolean> = async candidate => (await fs.promises.stat(candidate)).isDirectory(),
		private readonly timeoutMs: number = ARCHIVE_PROBE_TIMEOUT_MS,
		private readonly homeDirectory: string = homedir(),
	) { }

	async probe(roots: readonly string[]): Promise<IParadisCcusageArchives> {
		const claude: string[] = [];
		const codex: string[] = [];
		const seen: string[] = [];
		for (const raw of roots) {
			const trimmed = raw.trim();
			const root = trimmed === '~' || trimmed.startsWith('~/') || trimmed.startsWith(`~${path.sep}`) ? path.join(this.homeDirectory, trimmed.slice(1)) : trimmed;
			if (!path.isAbsolute(root) || root.includes(',') || seen.includes(root)) {
				continue;
			}
			seen.push(root);
			// undefined（返ってこない・出せない）なら、この根の残りは見ない
			const projects = await this.check(path.join(root, 'claude', 'projects'));
			if (projects === undefined) {
				continue;
			}
			if (projects) {
				claude.push(path.join(root, 'claude'));
			}
			const sessions = await this.check(path.join(root, 'codex', 'sessions'));
			if (sessions === undefined) {
				continue;
			}
			if (sessions || await this.check(path.join(root, 'codex', 'archived_sessions'))) {
				codex.push(path.join(root, 'codex'));
			}
		}
		return { claude, codex };
	}

	/** ディレクトリか。上限までに返らない・前の stat がまだ返っていない・出せる本数を超えるときは undefined。 */
	private check(candidate: string): Promise<boolean | undefined> {
		if (this.pending.has(candidate) || this.pending.size >= ARCHIVE_PROBE_MAX_PENDING_STATS) {
			return Promise.resolve(undefined);
		}
		this.pending.add(candidate);
		const stat = this.isDirectory(candidate).catch(() => false).finally(() => this.pending.delete(candidate));
		return new Promise<boolean | undefined>(resolve => {
			const timer = setTimeout(() => resolve(undefined), this.timeoutMs);
			void stat.then(result => {
				clearTimeout(timer);
				resolve(result);
			});
		});
	}
}

/** shared process の既定の確認役。止まった stat はプロセス全体のスレッドプールを占めるので、本数はプロセスで1つにまとめて数える。 */
const defaultArchiveProber = new ParadisCcusageArchiveProber();

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
		if (command === PARADIS_CCUSAGE_FETCH_REPORT_COMMAND) {
			const request = (args[0] ?? {}) as { readonly kind?: unknown; readonly options?: IParadisCcusageExecOptions };
			if (request.kind !== 'daily' && request.kind !== 'blocks' && request.kind !== 'session' && request.kind !== 'projects') {
				throw new Error('Invalid fetchReport kind');
			}
			return this.service.fetchReport(request.kind, request.options ?? {}) as Promise<T>;
		}
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
	const rawOptions = value.options;
	const has = (key: string) => Object.prototype.hasOwnProperty.call(rawOptions, key);
	const optionKeys = [
		...(has('executablePath') ? ['executablePath'] : []),
		...(kind === 'blocks' ? [] : ['since']),
		...(has('timezone') ? ['timezone'] : []),
	];
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
	const timezone = value.options.timezone;
	if (timezone !== undefined && (typeof timezone !== 'string' || !PARADIS_CCUSAGE_TIMEZONE_PATTERN.test(timezone))) {
		throw new Error('Invalid warm lease timezone');
	}
	return {
		kind,
		options: {
			...(executablePath === undefined ? {} : { executablePath }),
			...(since === undefined ? {} : { since }),
			...(timezone === undefined ? {} : { timezone }),
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
 * 設定は接続先のマシン設定（REH の machineSettingsResource）を渡す。実行タイムアウトは
 * マシンスコープの設定で、接続先のログ量に応じて延ばせる必要があるため（渡さないと接続先だけ
 * 既定値に固定され、設定画面から書いた値が誰にも読まれない）。起動引数は渡さない: シェル環境の
 * 解決は設定と引数の両方が揃ったときだけ行うので、接続先では既定の解決のままになる。
 * アーカイブ（`paradis.ccusage.archiveDirs`）も読まない（手元のディスクの場所なので、接続先には無い）。
 */
export function registerParadisCcusageForServer<TContext>(server: IPCServer<TContext>, logService: ILogService, configurationService?: IConfigurationService): IDisposable {
	const service = new ParadisCcusageService(logService, configurationService);
	server.registerChannel(PARADIS_CCUSAGE_CHANNEL, new ParadisCcusageChannel<TContext>(service));
	// REH は畳まずに終わることがある（接続が切れて延命の期限が来たときなど）。そのときも走っている ccusage を
	// グループごと止める（裏の実行は設定値より長く走るので、残すと孤児になる）。
	const onExit = () => service.dispose();
	process.once('exit', onExit);
	return {
		dispose: () => {
			process.removeListener('exit', onExit);
			service.dispose();
		}
	};
}

/**
 * sharedProcessMain.ts の PARA-PATCH 点から1行で呼べるファクトリ。
 */
export function registerParadisCcusage(server: IPCServer<string>, logService: ILogService, configurationService: IConfigurationService, args: NativeParsedArgs): IDisposable {
	const service = new ParadisCcusageService(logService, configurationService, args, undefined, undefined, undefined, true);
	server.registerChannel(PARADIS_CCUSAGE_CHANNEL, new ParadisCcusageChannel<string>(service));
	// バックグラウンド更新のタイマーを止める(unref 済みだが、明示的に畳んでおく)。
	return { dispose: () => service.dispose() };
}
