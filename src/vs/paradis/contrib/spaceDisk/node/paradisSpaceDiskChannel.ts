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

import { Event } from '../../../../base/common/event.js';
import { IDisposable } from '../../../../base/common/lifecycle.js';
import { IPCServer, IServerChannel } from '../../../../base/parts/ipc/common/ipc.js';
import * as path from '../../../../base/common/path.js';
import { ILogService } from '../../../../platform/log/common/log.js';
import {
	IParadisSpaceDiskEntry,
	IParadisSpaceDiskResult,
	IParadisSpaceDiskTarget,
	IParadisSpaceDiskWorktreeEntry,
	isPathInside,
	PARADIS_SPACE_DISK_CHANNEL,
} from '../common/paradisSpaceDisk.js';
import { measureDirectorySize } from './paradisDirectorySize.js';

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
/**
 * 最後に要求されてからこの時間を過ぎたら裏の計測をやめる。
 * 一度システム画面を開いただけの人のマシンで、以後ずっとディスクを舐め続けない。
 */
const WARM_IDLE_TIMEOUT_MS = 12 * 60 * 60 * 1000;
/** 続けて失敗する対象を諦める回数。 */
const MAX_CONSECUTIVE_FAILURES = 3;

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
 * 順序は呼ぶ側の都合で変わりうるので、並べ替えてから繋ぐ。
 */
function signatureOf(targets: readonly IParadisSpaceDiskTarget[]): string {
	return targets
		.map(target => [
			target.stateKey,
			// 表示名も署名に含める。含めないと、リポジトリや worktree をリネームしても
			// キャッシュがそのまま使われ、一覧に古い名前が最大でTTLぶん残る。
			target.name,
			target.path,
			...target.worktrees.map(w => [w.stateKey, w.name, w.path].join('\t')).sort(),
		].join('|'))
		.sort()
		.join('\n');
}

export class ParadisSpaceDiskService implements IDisposable {

	/** 直近の計測結果。対象の顔ぶれが変わってもキーは1つ(画面は常に全スペースを見る)。 */
	private cache: ICacheEntry | undefined;
	/** 実行中の計測(同じ顔ぶれの同時要求を1本にまとめる)。 */
	private inflight: Promise<IParadisSpaceDiskResult> | undefined;
	private inflightSignature: string | undefined;
	/** 裏で測り直すための、最後に要求された対象。 */
	private warmTargets: readonly IParadisSpaceDiskTarget[] = [];
	private warmSignature = '';
	private lastRequestedAt = 0;
	private failures = 0;
	private warmTimer: ReturnType<typeof setInterval> | undefined;
	private disposed = false;
	/** 走行中の計測へ渡す中断フラグ。dispose で立てて、フォルダを歩き切る前に止める。 */
	private readonly cancellation = { isCancellationRequested: false };

	constructor(private readonly logService: ILogService) { }

	async measure(targets: readonly IParadisSpaceDiskTarget[], bypassCache = false): Promise<IParadisSpaceDiskResult> {
		const signature = signatureOf(targets);
		this.warmTargets = targets;
		this.warmSignature = signature;
		this.lastRequestedAt = Date.now();
		// 諦めた対象を再開してよいのは、ユーザーが明示的に測り直したときだけ。
		// 画面を開くたびにリセットすると、失敗し続ける環境で永久にリトライすることになる。
		if (bypassCache) {
			this.failures = 0;
		}
		this.ensureWarmLoop();

		if (!bypassCache) {
			const cached = this.cache;
			if (cached && cached.signature === signature && Date.now() - cached.at < CACHE_TTL_MS) {
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
	private run(targets: readonly IParadisSpaceDiskTarget[], signature: string): Promise<IParadisSpaceDiskResult> {
		const inflight = this.inflight;
		if (inflight && this.inflightSignature === signature) {
			return inflight;
		}
		// 前の走行の失敗はここでは扱わない(その走行の呼び出し元が受け取っている)。
		const previous = inflight ? inflight.then(() => { }, () => { }) : Promise.resolve();
		const promise: Promise<IParadisSpaceDiskResult> = previous
			.then(() => this.doMeasure(targets))
			.then(result => {
				if (this.inflight === promise) {
					this.cache = { result, at: Date.now(), signature };
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
		const started = Date.now();
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
		return { spaces, measuredAt: Date.now(), durationMs: Date.now() - started };
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
				const measured = await measureDirectorySize(worktreePath, { token: this.cancellation });
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
			const measured = await measureDirectorySize(targetPath, { exclude: inner, token: this.cancellation });
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

	private ensureWarmLoop(): void {
		if (this.disposed || this.warmTimer !== undefined) {
			return;
		}
		const timer = setInterval(() => { void this.runWarmPass(); }, WARM_INTERVAL_MS);
		// この定期処理だけのために shared process の終了を引き止めない。
		(timer as { unref?: () => void }).unref?.();
		this.warmTimer = timer;
	}

	private async runWarmPass(): Promise<void> {
		if (this.disposed) {
			return;
		}
		const now = Date.now();
		if (now - this.lastRequestedAt >= WARM_IDLE_TIMEOUT_MS || this.failures >= MAX_CONSECUTIVE_FAILURES) {
			this.stopWarmLoop();
			return;
		}
		if (this.warmTargets.length === 0 || this.inflight !== undefined) {
			return;
		}
		// 手動更新の直後などで十分新しいなら、この周回は何もしない。
		if (this.cache && now - this.cache.at < WARM_SKIP_IF_FRESHER_THAN_MS) {
			return;
		}
		try {
			await this.run(this.warmTargets, this.warmSignature);
		} catch (error) {
			// 失敗してもキャッシュは壊さない(古い値が残るだけ)。続けて失敗したら諦める。
			this.failures++;
			this.logService.trace(`[ParadisSpaceDisk] background measure failed: ${error}`);
		}
	}

	private stopWarmLoop(): void {
		if (this.warmTimer !== undefined) {
			clearInterval(this.warmTimer);
			this.warmTimer = undefined;
		}
	}

	dispose(): void {
		this.disposed = true;
		this.cancellation.isCancellationRequested = true;
		this.stopWarmLoop();
	}
}

export class ParadisSpaceDiskChannel implements IServerChannel<string> {

	constructor(private readonly service: ParadisSpaceDiskService) { }

	listen<T>(_ctx: string, event: string): Event<T> {
		throw new Error(`Event not found: ${event}`);
	}

	call<T>(_ctx: string, command: string, arg?: unknown): Promise<T> {
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

/** sharedProcessMain.ts の PARA-PATCH 点から1行で呼べるファクトリ。 */
export function registerParadisSpaceDisk(server: IPCServer<string>, logService: ILogService): IDisposable {
	const service = new ParadisSpaceDiskService(logService);
	server.registerChannel(PARADIS_SPACE_DISK_CHANNEL, new ParadisSpaceDiskChannel(service));
	return { dispose: () => service.dispose() };
}
