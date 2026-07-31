/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-PATCH/PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

// ホストマシン全体のCPU/メモリ/ディスク使用量を読むnodeレイヤーの共有モジュール。
// 既存の resourceMonitor は「Para Code本体＋ターミナルのプロセスツリー」しか測っていないため、
// 「PCが今どれくらい忙しいか」を答えるにはここが必要になる。
//
// 2箇所から使われる:
//  - electron-main の ParadisResourceMonitorMainService（モバイルの詳細画面向けスナップショット）
//  - shared process の mobileRelay（モバイルへ常時配信する軽量3値）
// どちらも独立したサンプラーを持つ（CPUは累積値の差分なので、呼ぶ側ごとに前回値が要る）。

import { cpus, homedir, totalmem, freemem } from 'os';
import { stat, statfs } from 'fs/promises';
import { IParadisHostDiskVolume, IParadisHostMemory, IParadisHostResources } from '../common/paradisResourceMonitor.js';

/** CPU累積時間のサンプル1点。使用率は2点の差分からしか出せない。 */
export interface IParadisHostCpuSample {
	/** 全コアのidle時間の合計(ms)。 */
	readonly idle: number;
	/** 全コアの全モードの時間の合計(ms)。 */
	readonly total: number;
	/** サンプルを取った時刻(ms)。古すぎるサンプルとの差分を避けるために持つ。 */
	readonly at: number;
	/** 論理コア数。 */
	readonly cores: number;
}

/**
 * 使用率を出すのに必要な、1コアあたりの最小の累積時間差(ms)。
 * これを下回るサンプル差は比率が暴れるので undefined を返す。
 */
const CPU_MIN_DELTA_PER_CORE_MS = 50;
/** 2点差分に使うには古すぎるとみなす間隔。これを超えていたら短時間の再サンプルで測り直す。 */
const CPU_SAMPLE_MAX_AGE_MS = 90_000;
/** 前回サンプルが無い/古い場合に、その場で2点測るための待ち時間。 */
const CPU_SAMPLE_SETTLE_MS = 240;

/**
 * 全コアのCPU累積時間を1点読む。`os.cpus()` はプロセス起動時ではなくOS起動時からの累積。
 */
export function paradisReadCpuSample(now: number = Date.now()): IParadisHostCpuSample {
	let idle = 0;
	let total = 0;
	const list = cpus();
	for (const cpu of list) {
		const times = cpu.times;
		idle += times.idle;
		total += times.user + times.nice + times.sys + times.idle + times.irq;
	}
	return { idle, total, at: now, cores: list.length };
}

/**
 * 2点のサンプルからCPU使用率(0〜100)を出す。差分が無い/巻き戻っている場合はundefined。
 */
export function paradisComputeCpuPercent(previous: IParadisHostCpuSample, next: IParadisHostCpuSample): number | undefined {
	const totalDelta = next.total - previous.total;
	const idleDelta = next.idle - previous.idle;
	if (!Number.isFinite(totalDelta) || !Number.isFinite(idleDelta) || totalDelta <= 0) {
		return undefined;
	}
	// 差分が小さすぎるサンプル（短いスリープからの復帰など、tickがほとんど進んでいない）は
	// 比率が跳ねるだけで意味を持たない。1コアあたり数tick未満なら算出しない。
	if (totalDelta < Math.max(1, next.cores) * CPU_MIN_DELTA_PER_CORE_MS) {
		return undefined;
	}
	const busy = totalDelta - idleDelta;
	return Math.min(100, Math.max(0, (busy / totalDelta) * 100));
}

export function paradisReadHostMemory(): IParadisHostMemory {
	const total = Math.max(0, totalmem());
	const free = Math.max(0, freemem());
	return { total, used: Math.max(0, total - free) };
}

/** 1回の収集で問い合わせるパスの上限。worktreeが増えても `statfs` の実行数を頭打ちにする。 */
const DISK_PATH_LIMIT = 24;
/**
 * `statfs` 1件あたりの打ち切り時間。切断済みのネットワークマウントやスリープした外付けは
 * 数十秒返らないことがあり、そのままだと収集全体が止まる（libuvのthreadpoolも掴んだままになる）。
 */
const DISK_STAT_TIMEOUT_MS = 1_000;

/** 指定時間内に解決しなければ undefined を返す。 */
async function withTimeout<T>(work: Promise<T>, timeoutMs: number): Promise<T | undefined> {
	let timer: ReturnType<typeof setTimeout> | undefined;
	try {
		return await Promise.race([
			work,
			new Promise<undefined>(resolve => { timer = setTimeout(() => resolve(undefined), timeoutMs); }),
		]);
	} catch {
		return undefined;
	} finally {
		if (timer !== undefined) {
			clearTimeout(timer);
		}
	}
}

/**
 * 指定パスが載っているボリュームの容量を読む。同じボリュームを指すパスは1件にまとめる
 * （判定にはデバイスID `Stats.dev` を使う。容量が同じ別ボリューム——同型の外付け2台や
 * 同サイズのパーティション——を1件に潰さないため）。
 * 読めなかったパス・時間内に応答しなかったパスは黙って捨てる（取り外し済みのworktree等）。
 */
export async function paradisReadDiskVolumes(paths: readonly string[]): Promise<IParadisHostDiskVolume[]> {
	const volumes: IParadisHostDiskVolume[] = [];
	const seen = new Set<number>();
	for (const path of paths.slice(0, DISK_PATH_LIMIT)) {
		const [stats, entry] = await Promise.all([
			withTimeout(statfs(path), DISK_STAT_TIMEOUT_MS),
			withTimeout(stat(path), DISK_STAT_TIMEOUT_MS),
		]);
		if (stats === undefined || entry === undefined) {
			continue;
		}
		const device = Number(entry.dev);
		if (!Number.isFinite(device) || seen.has(device)) {
			continue;
		}
		const blockSize = Number(stats.bsize);
		const blocks = Number(stats.blocks);
		const available = Number(stats.bavail);
		if (!Number.isFinite(blockSize) || !Number.isFinite(blocks) || blockSize <= 0 || blocks <= 0) {
			continue;
		}
		seen.add(device);
		volumes.push({
			// 表示名はパスそのもの。パス末尾だけにすると、ホーム配下に全リポジトリがある
			// 一般的な構成では「ボリューム」軸にOSのアカウント名が1行だけ並ぶことになる。
			path,
			label: path,
			total: blocks * blockSize,
			free: Math.max(0, (Number.isFinite(available) ? available : 0) * blockSize),
		});
	}
	return volumes;
}

/**
 * ホスト全体の使用量を読む。CPUは累積値の差分なので前回サンプルを内部に持ち、
 * 前回が無い/古すぎる場合はその場で短時間の2点測定にフォールバックする。
 *
 * 呼ぶ側ごとに1インスタンス持つこと（前回サンプルを共有すると差分が壊れる）。
 */
export class ParadisHostResourceSampler {

	private previousCpuSample: IParadisHostCpuSample | undefined;

	constructor(
		/** テストから時刻・待機を差し替えるための注入点（既定は実時間）。 */
		private readonly now: () => number = () => Date.now(),
		private readonly delay: (ms: number) => Promise<void> = ms => new Promise(resolve => setTimeout(resolve, ms)),
	) { }

	/**
	 * @param diskPaths 容量を見たいパス。省略時はホームディレクトリのみ。
	 */
	async read(diskPaths: readonly string[] = [homedir()]): Promise<IParadisHostResources> {
		const { percent, cores } = await this.readCpu();
		const disks = await paradisReadDiskVolumes(diskPaths.length > 0 ? diskPaths : [homedir()]);
		return {
			cpu: percent,
			cores,
			memory: paradisReadHostMemory(),
			disks,
			collectedAt: this.now(),
		};
	}

	private async readCpu(): Promise<{ percent: number | undefined; cores: number }> {
		const now = this.now();
		let previous = this.previousCpuSample;
		if (previous === undefined || now - previous.at > CPU_SAMPLE_MAX_AGE_MS) {
			previous = paradisReadCpuSample(now);
			await this.delay(CPU_SAMPLE_SETTLE_MS);
		}
		const next = paradisReadCpuSample(this.now());
		this.previousCpuSample = next;
		return { percent: paradisComputeCpuPercent(previous, next), cores: next.cores };
	}
}
