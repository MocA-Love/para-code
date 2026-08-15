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
	readonly at: number;
	/** どの顔ぶれを測った結果か。違う署名の要求には使い回さない。 */
	readonly signature: string;
}

/**
 * 計測対象の顔ぶれを表す文字列。リポジトリの追加・削除、worktree の増減で変わる。
 *
 * これが無いと「リポジトリを足したのに一覧に出ない」「消したのに残る」が最大でTTLぶん続く。
 * 順序は呼ぶ側の都合で変わりうるので、構造を正規化してから JSON 化する。
 * 区切り文字による連結では、値自身に同じ文字が含まれたときに異なる構造が衝突する。
 */
function signatureOf(targets: readonly IParadisSpaceDiskTarget[]): string {
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

function payloadCost(ownerId: string, active: boolean, targets: readonly IParadisSpaceDiskTarget[]): number {
	return Buffer.byteLength(JSON.stringify({ ownerId, active, targets }), 'utf8');
}

function warmLeaseMetrics(ownerId: string, targets: readonly IParadisSpaceDiskTarget[]): IWarmLeaseMetrics {
	return {
		targetCount: targets.length,
		worktreeCount: targets.reduce((total, target) => total + target.worktrees.length, 0),
		cost: payloadCost(ownerId, true, targets),
	};
}

export class ParadisSpaceDiskService implements IDisposable {

	/** 直近の計測結果。対象の顔ぶれが変わってもキーは1つ(画面は常に全スペースを見る)。 */
	private cache: ICacheEntry | undefined;
	/** 実行中の計測(同じ顔ぶれの同時要求を1本にまとめる)。 */
	private inflight: Promise<IParadisSpaceDiskResult> | undefined;
	private inflightSignature: string | undefined;
	private readonly warmLeaseTracker: ParadisWarmLeaseTracker<WarmLeaseSnapshot>;
	private readonly warmLeaseOwners = new Map<string, IWarmLeaseOwner>();
	private readonly warmLeaseListener: IDisposable;
	private readonly warmPeriodicScheduler: IParadisWarmLeaseScheduler;
	private failures = 0;
	private failureGeneration: number | undefined;
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

	setWarmLease(ownerId: string, active: boolean, targets: readonly IParadisSpaceDiskTarget[]): void {
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

	async measure(targets: readonly IParadisSpaceDiskTarget[], bypassCache = false): Promise<IParadisSpaceDiskResult> {
		const signature = signatureOf(targets);
		// 諦めた対象を再開してよいのは、ユーザーが明示的に測り直したときだけ。
		// 画面を開くたびにリセットすると、失敗し続ける環境で永久にリトライすることになる。
		if (bypassCache) {
			this.failures = 0;
			this.syncWarmTimer();
		}

		if (!bypassCache) {
			const cached = this.cache;
			if (cached && cached.signature === signature && this.now() - cached.at < CACHE_TTL_MS) {
				return cached.result;
			}
		}
		return this.run(targets, signature);
	}

	/**
	 * 実際に測る。**同じ顔ぶれの**計測が走っていれば相乗りする(数十秒の処理を二重に走らせない)。
	 * 顔ぶれが違えば相乗りしない。裏の計測に手動更新が相乗りすると、古い顔ぶれの結果が
	 * 「今測り直した値」として返り、そのまま新しい時刻でキャッシュに書かれてしまう。
	 *
	 * 顔ぶれが違う場合も**同時には走らせず、前の走行の後ろに繋ぐ**。理由は2つ:
	 * - `doMeasure` はスペースを1つずつ処理する設計(中は並列)。2本同時に走らせると
	 *   ディスクが飽和して両方とも遅くなる
	 * - 先に始まった古い顔ぶれの走行が後から終わると、新しい結果をキャッシュから
	 *   上書きしてしまう(値が巻き戻り、次の要求がまた数十秒の走行を起こす)
	 * キャッシュを書くのは「自分がまだ最新の走行である」場合だけに限定する。
	 */
	private run(
		targets: readonly IParadisSpaceDiskTarget[],
		signature: string,
		shouldCache: () => boolean = () => true,
	): Promise<IParadisSpaceDiskResult> {
		const inflight = this.inflight;
		if (inflight && this.inflightSignature === signature) {
			return inflight;
		}
		// 前の走行の失敗はここでは扱わない(その走行の呼び出し元が受け取っている)。
		const previous = inflight ? inflight.then(() => { }, () => { }) : Promise.resolve();
		const promise: Promise<IParadisSpaceDiskResult> = previous
			.then(() => this.doMeasure(targets))
			.then(result => {
				if (!this.disposed && this.inflight === promise && shouldCache()) {
					this.cache = { result, at: this.now(), signature };
					this.failures = 0;
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

	private async doMeasure(targets: readonly IParadisSpaceDiskTarget[]): Promise<IParadisSpaceDiskResult> {
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

	private async measureOne(target: IParadisSpaceDiskTarget): Promise<IParadisSpaceDiskEntry> {
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
		const { generation, key, target: { targets } } = snapshot;
		if (this.failureGeneration !== generation) {
			this.failureGeneration = generation;
			this.failures = 0;
		}
		if (this.failures >= MAX_CONSECUTIVE_FAILURES || targets.length === 0 || this.inflight !== undefined) {
			this.syncWarmTimer();
			return;
		}
		// 手動更新の直後などで十分新しいなら、この周回は何もしない。
		if (this.cache && this.now() - this.cache.at < WARM_SKIP_IF_FRESHER_THAN_MS) {
			return;
		}
		try {
			await this.run(targets, signatureOf(targets), () => this.warmLeaseTracker.isCurrent(key, generation));
			if (this.warmLeaseTracker.isCurrent(key, generation)) {
				this.failures = 0;
			}
		} catch (error) {
			// 失敗してもキャッシュは壊さない(古い値が残るだけ)。続けて失敗したら諦める。
			if (this.warmLeaseTracker.isCurrent(key, generation)) {
				this.failures++;
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
			this.failureGeneration = undefined;
			this.failures = 0;
			this.stopWarmLoop();
			return;
		}
		if (this.failureGeneration !== snapshot.generation) {
			this.failureGeneration = snapshot.generation;
			this.failures = 0;
		}
		if (this.failures >= MAX_CONSECUTIVE_FAILURES) {
			this.stopWarmLoop();
			return;
		}
		if (!this.warmScheduled) {
			this.warmPeriodicScheduler.schedule(WARM_INTERVAL_MS);
			this.warmScheduled = true;
		}
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
	}
}

export class ParadisSpaceDiskChannel implements IServerChannel<string> {

	constructor(private readonly service: ParadisSpaceDiskService) { }

	listen<T>(_ctx: string, event: string): Event<T> {
		throw new Error(`Event not found: ${event}`);
	}

	call<T>(_ctx: string, command: string, arg?: unknown): Promise<T> {
		if (command === 'setWarmLease') {
			const payload = parseWarmLeasePayload(arg);
			this.service.setWarmLease(payload.ownerId, payload.active, payload.targets);
			return Promise.resolve(undefined as T);
		}
		const args = Array.isArray(arg) ? arg : [];
		switch (command) {
			case 'measure': {
				const targets = (args[0] ?? []) as IParadisSpaceDiskTarget[];
				const bypassCache = args[1] === true;
				return this.service.measure(targets, bypassCache) as Promise<T>;
			}
			default:
				throw new Error(`Method not found: ${command}`);
		}
	}
}

function parseWarmLeasePayload(arg: unknown): ParadisSpaceDiskWarmLeasePayload {
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
	const targets: IParadisSpaceDiskTarget[] = [];
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

function parseWarmTarget(value: unknown): IParadisSpaceDiskTarget {
	if (!isExactPlainRecord(value, ['stateKey', 'name', 'path', 'worktrees'])
		|| !isBoundedString(value.stateKey)
		|| !isBoundedString(value.name)
		|| !isBoundedString(value.path)
		|| !isExactPlainArray(value.worktrees)
		|| value.worktrees.length > WARM_LEASE_MAX_WORKTREES_PER_TARGET) {
		throw new Error('Invalid warm lease target');
	}
	const worktrees: IParadisSpaceDiskWorktree[] = value.worktrees.map(parseWarmWorktree);
	return { stateKey: value.stateKey, name: value.name, path: value.path, worktrees };
}

function parseWarmWorktree(value: unknown): IParadisSpaceDiskWorktree {
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
