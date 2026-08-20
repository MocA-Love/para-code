/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-PATCH/PARA-CODE コメント)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

// shared process 上でスペース(リポジトリ/worktree)の容量を測るサービスと IPC チャネル。
//
// **なぜ shared process か**: 計測は1周で数十秒かかる。electron-main に置くと、その間
// libuv の threadpool を stat で埋めてしまい、同じプロセスにいるホスト情報の取得
// (statfs の1秒タイムアウトや ps)まで巻き添えで詰まる。shared process なら
// worktreeGit / mobileSearch / ccusage と同じく重い I/O の置き場として隔離できる。
//
// **なぜ裏で温めるか**: モバイルのシステム画面は6秒ごとに CPU/メモリを取り直している。
// そこへ数十秒の処理を混ぜると毎回前の処理待ちで詰まる。別系統にしたうえで、
// 1時間ごとに測っておいて「開いたときにはもう出ている」状態にする(ccusage と同じ考え方)。

import { RunOnceScheduler } from '../../../../base/common/async.js';
import { Event } from '../../../../base/common/event.js';
import { IDisposable } from '../../../../base/common/lifecycle.js';
import { IPCServer, IServerChannel } from '../../../../base/parts/ipc/common/ipc.js';
import * as path from '../../../../base/common/path.js';
import { ILogService } from '../../../../platform/log/common/log.js';
import {
	IParadisWarmLeaseScheduler,
	ParadisWarmLeaseTracker,
	PARADIS_WARM_LEASE_DURATION_MS,
} from '../../../common/paradisWarmLease.js';
import {
	IParadisSpaceDiskEntry,
	IParadisSpaceDiskResult,
	IParadisSpaceDiskTarget,
	IParadisSpaceDiskWorktree,
	IParadisSpaceDiskWorktreeEntry,
	isPathInside,
	PARADIS_SPACE_DISK_CHANNEL,
	ParadisSpaceDiskWarmLeasePayload,
} from '../common/paradisSpaceDisk.js';
import { IDirectorySizeOptions, IDirectorySizeResult, measureDirectorySize } from './paradisDirectorySize.js';

/** 裏で測り直す周期。 */
const WARM_INTERVAL_MS = 60 * 60 * 1000;
/**
 * 直前に測ったばかりなら周回をとばす猶予。手動更新の直後などが該当する。
 * `WARM_INTERVAL_MS + この猶予 <= CACHE_TTL_MS` を保つこと。
 */
const WARM_SKIP_IF_FRESHER_THAN_MS = 5 * 60 * 1000;
/**
 * キャッシュの寿命。裏の周期より長くしておかないと、周回の合間に切れて
 * 「開いたら数十秒待たされる」状態が生まれる(それを無くすための仕組みなので本末転倒)。
 */
const CACHE_TTL_MS = WARM_INTERVAL_MS + WARM_SKIP_IF_FRESHER_THAN_MS + 10 * 60 * 1000;
/** 続けて失敗する対象を諦める回数。 */
const MAX_CONSECUTIVE_FAILURES = 3;
/**
 * 顔ぶれ(署名)ごとに残す計測結果の上限。
 *
 * 1つのサーバーへ複数のウィンドウが繋ぐと、ウィンドウごとに開いているスペースの集合が違う。
 * 枠が1つしか無いと互いのキャッシュを踏み潰し合い、どのウィンドウも毎回ディスクを全走査する。
 * 一方で署名は顔ぶれが変わるたびに増えるので、無制限には持たない。
 */
const MAX_CACHE_ENTRIES = 8;
const WARM_LEASE_MAX_OWNERS = 128;
const WARM_LEASE_MAX_TARGETS_PER_OWNER = 200;
const WARM_LEASE_MAX_WORKTREES_PER_TARGET = 200;
const WARM_LEASE_MAX_WORKTREES_PER_OWNER = 2_000;
const WARM_LEASE_MAX_STRING_LENGTH = 4_096;
const WARM_LEASE_MAX_SNAPSHOT_BYTES = 2 * 1024 * 1024;
const WARM_LEASE_MAX_TOTAL_TARGETS = 800;
const WARM_LEASE_MAX_TOTAL_WORKTREES = 8_000;
const WARM_LEASE_MAX_TOTAL_SNAPSHOT_BYTES = 8 * 1024 * 1024;
const WARM_LEASE_OWNER_ID_PATTERN = /^[A-Za-z0-9._:-]{1,160}$/;
const WARM_TARGET_KEY = 'space-disk';

type DirectoryMeasure = (root: string, options?: IDirectorySizeOptions) => Promise<IDirectorySizeResult>;
type WarmLeaseSchedulerFactory = (runner: () => void) => IParadisWarmLeaseScheduler;
type WarmLeaseWorktree = Readonly<{
	readonly stateKey: string;
	readonly name: string;
	readonly path: string;
}>;
type WarmLeaseTarget = Readonly<{
	readonly stateKey: string;
	readonly name: string;
	readonly path: string;
	readonly worktrees: readonly WarmLeaseWorktree[];
}>;
type WarmLeaseSnapshot = Readonly<{
	readonly ownerId: string;
	readonly targets: readonly WarmLeaseTarget[];
}>;

class IntervalWarmScheduler implements IParadisWarmLeaseScheduler {
	private timer: ReturnType<typeof setInterval> | undefined;

	constructor(private readonly runner: () => void) { }

	schedule(delay: number): void {
		if (this.timer !== undefined) {
			return;
		}
		const timer = setInterval(this.runner, delay);
		(timer as { unref?: () => void }).unref?.();
		this.timer = timer;
	}

	cancel(): void {
		if (this.timer !== undefined) {
			clearInterval(this.timer);
			this.timer = undefined;
		}
	}

	dispose(): void {
		this.cancel();
	}
}

interface IWarmLeaseOwner {
	readonly expiresAt: number;
	readonly targetCount: number;
	readonly worktreeCount: number;
	readonly cost: number;
}

interface IWarmLeaseMetrics {
	readonly targetCount: number;
	readonly worktreeCount: number;
	readonly cost: number;
}

interface ICacheEntry {
	readonly result: IParadisSpaceDiskResult;
	/** 測り終えた時刻。寿命の判定と、裏の周回を飛ばすかの判定に使う。 */
	readonly at: number;
	/** 最後にこの結果を返した時刻。上限を超えたときは、いちばん長く使われていないものから捨てる。 */
	lastUsedAt: number;
}

/**
 * 計測対象の顔ぶれを表す文字列。リポジトリの追加・削除、worktree の増減で変わる。
 *
 * これが無いと「リポジトリを足したのに一覧に出ない」「消したのに残る」が最大でTTLぶん続く。
 * 順序は呼ぶ側の都合で変わりうるので、構造を正規化してから JSON 化する。
 * 区切り文字による連結では、値自身に同じ文字が含まれたときに異なる構造が衝突する。
 */
// 以降 `<string>` を明示しているのは、ここが電文を受け取る側だからで、意味がある。
// 共有の型の既定は `ParadisHostPath`（送る側が綴りの規則を通したことの印）で、素の文字列を
// 扱えるのは検証するこちら側だけ。詳細は src/vs/paradis/common/paradisHostPath.ts を参照。
function signatureOf(targets: readonly IParadisSpaceDiskTarget<string>[]): string {
	const normalizedTargets = targets.map(target => ({
		stateKey: target.stateKey,
		// 表示名も署名に含める。含めないと、リポジトリや worktree をリネームしても
		// キャッシュがそのまま使われ、一覧に古い名前が最大でTTLぶん残る。
		name: target.name,
		path: target.path,
		worktrees: target.worktrees
			.map(worktree => [worktree.stateKey, worktree.name, worktree.path] as const)
			.sort((left, right) => JSON.stringify(left).localeCompare(JSON.stringify(right))),
	}));
	normalizedTargets.sort((left, right) => JSON.stringify(left).localeCompare(JSON.stringify(right)));
	return JSON.stringify(normalizedTargets);
}

function payloadCost(ownerId: string, active: boolean, targets: readonly IParadisSpaceDiskTarget<string>[]): number {
	return Buffer.byteLength(JSON.stringify({ ownerId, active, targets }), 'utf8');
}

function warmLeaseMetrics(ownerId: string, targets: readonly IParadisSpaceDiskTarget<string>[]): IWarmLeaseMetrics {
	return {
		targetCount: targets.length,
		worktreeCount: targets.reduce((total, target) => total + target.worktrees.length, 0),
		cost: payloadCost(ownerId, true, targets),
	};
}

export class ParadisSpaceDiskService implements IDisposable {

	/**
	 * 直近の計測結果を顔ぶれ(署名)ごとに持つ。
	 *
	 * 1ウィンドウしか繋がらない前提なら枠は1つで足りるが、接続先(REH)には複数のウィンドウが
	 * 同時に繋がりうる。それぞれが別のスペース集合を開いていると、枠が1つでは書いた側と違う
	 * 署名の要求が毎回外れ、双方が数十秒のディスク全走査を延々と繰り返すことになる。
	 */
	private readonly cache = new Map<string, ICacheEntry>();
	/** 実行中の計測(同じ顔ぶれの同時要求を1本にまとめる)。 */
	private inflight: Promise<IParadisSpaceDiskResult> | undefined;
	private inflightSignature: string | undefined;
	private readonly warmLeaseTracker: ParadisWarmLeaseTracker<WarmLeaseSnapshot>;
	private readonly warmLeaseOwners = new Map<string, IWarmLeaseOwner>();
	private readonly warmLeaseListener: IDisposable;
	private readonly warmPeriodicScheduler: IParadisWarmLeaseScheduler;
	private readonly failuresBySignature = new Map<string, number>();
	private warmScheduled = false;
	private disposed = false;
	/** 走行中の計測へ渡す中断フラグ。dispose で立てて、フォルダを歩き切る前に止める。 */
	private readonly cancellation = { isCancellationRequested: false };

	constructor(
		private readonly logService: ILogService,
		private readonly now: () => number = Date.now,
		warmLeaseSchedulerFactory: WarmLeaseSchedulerFactory = runner => new RunOnceScheduler(runner, 0),
		private readonly directoryMeasure: DirectoryMeasure = measureDirectorySize,
		warmPeriodicSchedulerFactory: WarmLeaseSchedulerFactory = runner => new IntervalWarmScheduler(runner),
	) {
		this.warmLeaseTracker = new ParadisWarmLeaseTracker(
			() => WARM_TARGET_KEY,
			(left, right) => signatureOf(left.targets) === signatureOf(right.targets),
			snapshot => payloadCost(snapshot.ownerId, true, snapshot.targets),
			this.now,
			warmLeaseSchedulerFactory,
			{
				maxOwners: WARM_LEASE_MAX_OWNERS,
				maxTargetsPerOwner: 1,
				maxDistinctTargets: 1,
				maxTotalMemberships: WARM_LEASE_MAX_OWNERS,
				maxTotalCost: WARM_LEASE_MAX_TOTAL_SNAPSHOT_BYTES,
			},
		);
		this.warmPeriodicScheduler = warmPeriodicSchedulerFactory(() => { void this.runWarmPass(); });
		this.warmLeaseListener = this.warmLeaseTracker.onDidChange(() => this.syncWarmTimer());
	}

	setWarmLease(ownerId: string, active: boolean, targets: readonly IParadisSpaceDiskTarget<string>[]): void {
		if (this.disposed) {
			return;
		}
		// expiry callback が遅れていても、renew/release の入口で tracker と集約台帳を同期する。
		this.warmLeaseTracker.activeTargets();
		this.purgeExpiredWarmLeaseOwners();
		if (!active) {
			this.warmLeaseOwners.delete(ownerId);
			this.warmLeaseTracker.release(ownerId);
			return;
		}

		const metrics = warmLeaseMetrics(ownerId, targets);
		if (!this.isWithinWarmLeaseLimits(ownerId, metrics)) {
			throw new Error('Warm lease limit exceeded');
		}
		this.warmLeaseTracker.setLease(ownerId, [{ ownerId, targets }]);
		this.warmLeaseOwners.set(ownerId, {
			expiresAt: this.now() + PARADIS_WARM_LEASE_DURATION_MS,
			...metrics,
		});
	}

	async measure(targets: readonly IParadisSpaceDiskTarget<string>[], bypassCache = false): Promise<IParadisSpaceDiskResult> {
		const signature = signatureOf(targets);
		// 諦めた対象を再開してよいのは、ユーザーが明示的に測り直したときだけ。
		// 画面を開くたびにリセットすると、失敗し続ける環境で永久にリトライすることになる。
		if (bypassCache) {
			this.failuresBySignature.delete(signature);
			this.syncWarmTimer();
		}

		if (!bypassCache) {
			const cached = this.cachedResult(signature);
			if (cached) {
				return cached;
			}
		}
		return this.run(targets, signature);
	}

	/**
	 * 使える結果があれば返す。`measuredSince` を渡すと、その時刻以降に測られた結果だけを使う
	 * (順番待ちしていた走行が「待っている間に出た結果」だけを拾うため)。
	 */
	private cachedResult(signature: string, measuredSince = 0): IParadisSpaceDiskResult | undefined {
		const entry = this.cache.get(signature);
		if (!entry) {
			return undefined;
		}
		const now = this.now();
		if (now - entry.at >= CACHE_TTL_MS) {
			this.cache.delete(signature);
			return undefined;
		}
		if (entry.at < measuredSince) {
			return undefined;
		}
		entry.lastUsedAt = now;
		return entry.result;
	}

	private storeResult(signature: string, result: IParadisSpaceDiskResult): void {
		const now = this.now();
		this.cache.set(signature, { result, at: now, lastUsedAt: now });
		this.pruneCache();
	}

	/**
	 * 期限切れを捨て、それでも上限を超えていれば「いちばん長く使われていない」ものから捨てる。
	 * 測った時刻で捨てると、古くから使われ続けているウィンドウの枠が、最近たまたま一度開いただけの
	 * 枠に押し出される(押し出された側は次の要求で数十秒の全走査に戻る)。件数が少ないので毎回なめてよい。
	 */
	private pruneCache(): void {
		const now = this.now();
		for (const [key, entry] of this.cache) {
			if (now - entry.at >= CACHE_TTL_MS) {
				this.cache.delete(key);
			}
		}
		while (this.cache.size > MAX_CACHE_ENTRIES) {
			let stalestKey: string | undefined;
			let stalestUse = Number.POSITIVE_INFINITY;
			for (const [key, entry] of this.cache) {
				if (entry.lastUsedAt < stalestUse) {
					stalestUse = entry.lastUsedAt;
					stalestKey = key;
				}
			}
			if (stalestKey === undefined) {
				return;
			}
			this.cache.delete(stalestKey);
		}
	}

	/**
	 * 実際に測る。**同じ顔ぶれの**計測が走っていれば相乗りする(数十秒の処理を二重に走らせない)。
	 * 顔ぶれが違えば相乗りしない。裏の計測に手動更新が相乗りすると、古い顔ぶれの結果が
	 * 「今測り直した値」として返り、そのまま新しい時刻でキャッシュに書かれてしまう。
	 *
	 * 顔ぶれが違う場合も**同時には走らせず、前の走行の後ろに繋ぐ**。`doMeasure` はスペースを
	 * 1つずつ処理する設計(中は並列)なので、2本同時に走らせるとディスクが飽和して両方とも遅くなる。
	 *
	 * 測り終えた結果は**無条件に**自分の署名の枠へ書く。キャッシュが署名ごとに分かれているので、
	 * 誰の走行が後から終わっても他の顔ぶれの結果を潰しようがない。かつて「最新の走行だけが書く」
	 * 「warm lease の世代が変わっていなければ書く」と絞っていたが、枠が1つだった頃の潰し合いを
	 * 防ぐための門であり、今は**数分かけて完走した正しい計測を捨てるだけ**になる。裏の周回が
	 * 走っている最中に別のウィンドウが lease を更新すると世代が上がるので、これは日常的に起きる。
	 */
	private run(targets: readonly IParadisSpaceDiskTarget<string>[], signature: string): Promise<IParadisSpaceDiskResult> {
		const inflight = this.inflight;
		if (inflight && this.inflightSignature === signature) {
			return inflight;
		}
		// 前の走行の失敗はここでは扱わない(その走行の呼び出し元が受け取っている)。
		const previous = inflight ? inflight.then(() => { }, () => { }) : Promise.resolve();
		const queuedAt = this.now();
		const promise: Promise<IParadisSpaceDiskResult> = previous
			.then(async () => {
				// 順番待ちしている間に、同じ顔ぶれが別の走行で測り終わっているかもしれない
				// (A の走行中に B が並び、さらに A が要求されると A は3本目として並ぶ)。
				// ここで見ないと、たった今出たばかりの結果を無視して測り直すことになる。
				// 見るのは待たされた場合だけで、待つものが無ければ必ず測る — この経路には
				// 明示的な測り直し(bypassCache)の要求も来るため、既存の枠を拾ってはいけない。
				// 自分が並ぶより前に測られた結果も使わない。
				const measuredWhileWaiting = inflight ? this.cachedResult(signature, queuedAt) : undefined;
				if (measuredWhileWaiting) {
					return measuredWhileWaiting;
				}
				const result = await this.doMeasure(targets);
				if (!this.disposed) {
					this.storeResult(signature, result);
					this.failuresBySignature.delete(signature);
				}
				return result;
			})
			.finally(() => {
				if (this.inflight === promise) {
					this.inflight = undefined;
					this.inflightSignature = undefined;
				}
			});
		this.inflight = promise;
		this.inflightSignature = signature;
		return promise;
	}

	private async doMeasure(targets: readonly IParadisSpaceDiskTarget<string>[]): Promise<IParadisSpaceDiskResult> {
		const started = this.now();
		const spaces: IParadisSpaceDiskEntry[] = [];

		// スペースは順に処理する。1スペースの中は measureDirectorySize が並列に歩くので、
		// ここで更に並列にするとディスクが飽和して全体が遅くなる。
		for (const target of targets) {
			// 途中で dispose された場合は投げる。ここで打ち切った半端な一覧を返すと、
			// それが「今測った結果」としてキャッシュに書かれてしまう。
			if (this.disposed) {
				throw new Error('space disk measurement was cancelled');
			}
			spaces.push(await this.measureOne(target));
		}
		// measureOne は個別の失敗を握り潰して error 付きのエントリを返すので、ここまでは
		// 基本的に成功する。全滅したときだけ「計測できなかった」として扱い、
		// 諦めの判定(MAX_CONSECUTIVE_FAILURES)を効かせる。壊れた値でキャッシュを
		// 上書きしないためでもある。
		if (spaces.length > 0 && spaces.every(space => space.error !== undefined)) {
			throw new Error(`could not measure any of ${spaces.length} spaces: ${spaces[0].error}`);
		}
		const measuredAt = this.now();
		return { spaces, measuredAt, durationMs: measuredAt - started };
	}

	private async measureOne(target: IParadisSpaceDiskTarget<string>): Promise<IParadisSpaceDiskEntry> {
		const worktrees: IParadisSpaceDiskWorktreeEntry[] = [];
		// 親の中にある worktree だけを親の集計から外す。外に置かれているものは
		// そもそも親を歩いても出てこないので引いてはいけない(引くと本体が小さく出る)。
		const inner: string[] = [];
		// 歩く側のパスは path.join で正規化されるので、除外リストも揃えておく。
		// `/a/b/./wt` のような形のまま渡すと、内側と判定しているのに除外だけ効かず、
		// 二重計上した上に遅くなる(除外が効かない木は実測で18倍遅い)。
		const targetPath = path.resolve(target.path);

		for (const worktree of target.worktrees) {
			const worktreePath = path.resolve(worktree.path);
			const outside = !isPathInside(worktreePath, targetPath);
			if (!outside) {
				inner.push(worktreePath);
			}
			try {
				const measured = await this.directoryMeasure(worktreePath, { token: this.cancellation });
				worktrees.push({
					stateKey: worktree.stateKey, name: worktree.name, bytes: measured.bytes, outside,
					...(measured.truncated ? { truncated: true } : {}),
				});
			} catch (error) {
				worktrees.push({
					stateKey: worktree.stateKey, name: worktree.name, bytes: 0, outside,
					error: error instanceof Error ? error.message : String(error),
				});
			}
		}

		try {
			// 除外は正しさだけでなく速度にも効く。実測では worktree を含めて歩くと
			// 164万ファイル/140秒、除いて 22.8万ファイル/7.8秒だった。
			const measured = await this.directoryMeasure(targetPath, { exclude: inner, token: this.cancellation });
			return {
				stateKey: target.stateKey, name: target.name, ownBytes: measured.bytes, worktrees,
				...(measured.truncated ? { truncated: true } : {}),
			};
		} catch (error) {
			return {
				stateKey: target.stateKey, name: target.name, ownBytes: 0, worktrees,
				error: error instanceof Error ? error.message : String(error),
			};
		}
	}

	private async runWarmPass(): Promise<void> {
		if (this.disposed) {
			return;
		}
		// activeTargets() は期限切れ owner を同期 purge する。expiry scheduler が遅れていても、
		// 期限後の snapshot でディスク走査を始めてはいけない。
		const snapshot = this.warmLeaseTracker.activeTargets()[0];
		if (!snapshot) {
			this.syncWarmTimer();
			return;
		}
		const { target: { targets } } = snapshot;
		const signature = signatureOf(targets);
		if ((this.failuresBySignature.get(signature) ?? 0) >= MAX_CONSECUTIVE_FAILURES || targets.length === 0 || this.inflight !== undefined) {
			this.syncWarmTimer();
			return;
		}
		// 手動更新の直後などで十分新しいなら、この周回は何もしない。
		const cached = this.cache.get(signature);
		if (cached && this.now() - cached.at < WARM_SKIP_IF_FRESHER_THAN_MS) {
			return;
		}
		try {
			// 走り切ったら必ず自分の署名の枠へ書く。以前はここで「まだ自分が warm の当番か」を
			// 見て、当番が移っていたら結果を捨てていた。当番は5分ごとの renew で入れ替わるので、
			// 数十秒かかる計測の最中に別ウィンドウが renew しただけで**測り終えた値が消えて**
			// いた。キャッシュを署名ごとに分けた今、別の顔ぶれの枠を潰す心配は無いので捨てる
			// 理由が無い。
			await this.run(targets, signature);
			if (!this.disposed) {
				this.failuresBySignature.delete(signature);
			}
		} catch (error) {
			// 失敗してもキャッシュは壊さない(古い値が残るだけ)。続けて失敗したら諦める。
			// owner generation が完了直前に切り替わっても、同じ署名の失敗履歴は失わない。
			if (!this.disposed) {
				this.recordWarmFailure(signature);
			}
			this.logService.trace(`[ParadisSpaceDisk] background measure failed: ${error}`);
		}
		this.syncWarmTimer();
	}

	private syncWarmTimer(): void {
		if (this.disposed) {
			return;
		}
		const snapshot = this.warmLeaseTracker.activeTargets()[0];
		if (!snapshot) {
			this.failuresBySignature.clear();
			this.stopWarmLoop();
			return;
		}
		if ((this.failuresBySignature.get(signatureOf(snapshot.target.targets)) ?? 0) >= MAX_CONSECUTIVE_FAILURES) {
			this.stopWarmLoop();
			return;
		}
		if (!this.warmScheduled) {
			this.warmPeriodicScheduler.schedule(WARM_INTERVAL_MS);
			this.warmScheduled = true;
		}
	}

	private recordWarmFailure(signature: string): void {
		if (!this.failuresBySignature.has(signature) && this.failuresBySignature.size >= WARM_LEASE_MAX_OWNERS) {
			const oldest = this.failuresBySignature.keys().next().value;
			if (oldest !== undefined) {
				this.failuresBySignature.delete(oldest);
			}
		}
		this.failuresBySignature.set(signature, (this.failuresBySignature.get(signature) ?? 0) + 1);
	}

	private stopWarmLoop(): void {
		if (this.warmScheduled) {
			this.warmPeriodicScheduler.cancel();
			this.warmScheduled = false;
		}
	}

	private purgeExpiredWarmLeaseOwners(): void {
		const now = this.now();
		for (const [ownerId, owner] of this.warmLeaseOwners) {
			if (owner.expiresAt <= now) {
				this.warmLeaseOwners.delete(ownerId);
			}
		}
	}

	private isWithinWarmLeaseLimits(ownerId: string, metrics: IWarmLeaseMetrics): boolean {
		if (!this.warmLeaseOwners.has(ownerId) && this.warmLeaseOwners.size >= WARM_LEASE_MAX_OWNERS) {
			return false;
		}
		let targetCount = metrics.targetCount;
		let worktreeCount = metrics.worktreeCount;
		let cost = metrics.cost;
		for (const [activeOwnerId, owner] of this.warmLeaseOwners) {
			if (activeOwnerId === ownerId) {
				continue;
			}
			targetCount += owner.targetCount;
			worktreeCount += owner.worktreeCount;
			cost += owner.cost;
		}
		return targetCount <= WARM_LEASE_MAX_TOTAL_TARGETS
			&& worktreeCount <= WARM_LEASE_MAX_TOTAL_WORKTREES
			&& cost <= WARM_LEASE_MAX_TOTAL_SNAPSHOT_BYTES;
	}

	dispose(): void {
		if (this.disposed) {
			return;
		}
		this.disposed = true;
		this.cancellation.isCancellationRequested = true;
		this.stopWarmLoop();
		this.warmPeriodicScheduler.dispose();
		this.warmLeaseListener.dispose();
		this.warmLeaseTracker.dispose();
		this.warmLeaseOwners.clear();
		this.cache.clear();
	}
}

export class ParadisSpaceDiskChannel<TContext = string> implements IServerChannel<TContext> {

	constructor(private readonly service: ParadisSpaceDiskService) { }

	listen<T>(_ctx: TContext, event: string): Event<T> {
		throw new Error(`Event not found: ${event}`);
	}

	call<T>(_ctx: TContext, command: string, arg?: unknown): Promise<T> {
		if (command === 'setWarmLease') {
			const payload = parseWarmLeasePayload(arg);
			this.service.setWarmLease(payload.ownerId, payload.active, payload.targets);
			return Promise.resolve(undefined as T);
		}
		const args = Array.isArray(arg) ? arg : [];
		switch (command) {
			case 'measure': {
				const targets = (args[0] ?? []) as IParadisSpaceDiskTarget<string>[];
				const bypassCache = args[1] === true;
				return this.service.measure(targets, bypassCache) as Promise<T>;
			}
			default:
				throw new Error(`Method not found: ${command}`);
		}
	}
}

function parseWarmLeasePayload(arg: unknown): ParadisSpaceDiskWarmLeasePayload<string> {
	if (!isExactPlainArray(arg) || arg.length !== 1 || !isExactPlainRecord(arg[0], ['ownerId', 'active', 'targets'])) {
		throw new Error('Invalid setWarmLease arguments');
	}
	const payload = arg[0];
	if (typeof payload.ownerId !== 'string'
		|| !WARM_LEASE_OWNER_ID_PATTERN.test(payload.ownerId)
		|| typeof payload.active !== 'boolean'
		|| !isExactPlainArray(payload.targets)) {
		throw new Error('Invalid warm lease payload');
	}
	if (!payload.active && payload.targets.length !== 0) {
		throw new Error('Invalid warm lease release targets');
	}
	if (payload.targets.length > WARM_LEASE_MAX_TARGETS_PER_OWNER) {
		throw new Error('Invalid warm lease target count');
	}

	let worktreeCount = 0;
	const targets: IParadisSpaceDiskTarget<string>[] = [];
	for (const value of payload.targets) {
		const target = parseWarmTarget(value);
		worktreeCount += target.worktrees.length;
		if (worktreeCount > WARM_LEASE_MAX_WORKTREES_PER_OWNER) {
			throw new Error('Invalid warm lease total worktree count');
		}
		targets.push(target);
	}
	if (payloadCost(payload.ownerId, payload.active, targets) > WARM_LEASE_MAX_SNAPSHOT_BYTES) {
		throw new Error('Warm lease snapshot too large');
	}
	return { ownerId: payload.ownerId, active: payload.active, targets };
}

function parseWarmTarget(value: unknown): IParadisSpaceDiskTarget<string> {
	if (!isExactPlainRecord(value, ['stateKey', 'name', 'path', 'worktrees'])
		|| !isBoundedString(value.stateKey)
		|| !isBoundedString(value.name)
		|| !isBoundedString(value.path)
		|| !isExactPlainArray(value.worktrees)
		|| value.worktrees.length > WARM_LEASE_MAX_WORKTREES_PER_TARGET) {
		throw new Error('Invalid warm lease target');
	}
	const worktrees: IParadisSpaceDiskWorktree<string>[] = value.worktrees.map(parseWarmWorktree);
	return { stateKey: value.stateKey, name: value.name, path: value.path, worktrees };
}

function parseWarmWorktree(value: unknown): IParadisSpaceDiskWorktree<string> {
	if (!isExactPlainRecord(value, ['stateKey', 'name', 'path'])
		|| !isBoundedString(value.stateKey)
		|| !isBoundedString(value.name)
		|| !isBoundedString(value.path)) {
		throw new Error('Invalid warm lease worktree');
	}
	return { stateKey: value.stateKey, name: value.name, path: value.path };
}

function isBoundedString(value: unknown): value is string {
	return typeof value === 'string' && value.length > 0 && value.length <= WARM_LEASE_MAX_STRING_LENGTH;
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

/** sharedProcessMain.ts の PARA-PATCH 点から1行で呼べるファクトリ。 */
export function registerParadisSpaceDisk(server: IPCServer<string>, logService: ILogService): IDisposable {
	const service = new ParadisSpaceDiskService(logService);
	server.registerChannel(PARADIS_SPACE_DISK_CHANNEL, new ParadisSpaceDiskChannel(service));
	return { dispose: () => service.dispose() };
}

/**
 * serverServices.ts（REH）の登録点から1行で呼べるファクトリ。
 *
 * SSH 接続先のスペースは接続先のファイルシステム上にしか実体が無い。shared process 版は常に
 * 手元のマシンで動き、接続先のディスクには一切到達できないため、同じチャネルを接続先にも生やす。
 */
export function registerParadisSpaceDiskForServer<TContext>(server: IPCServer<TContext>, logService: ILogService): IDisposable {
	const service = new ParadisSpaceDiskService(logService);
	server.registerChannel(PARADIS_SPACE_DISK_CHANNEL, new ParadisSpaceDiskChannel<TContext>(service));
	return { dispose: () => service.dispose() };
}
