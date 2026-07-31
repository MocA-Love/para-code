/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-PATCH/PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

// ホスト全体のリソース使用量を、モバイルへ常時配信できる粒度まで丸める。
//
// desktop state はモバイル全台へブロードキャストされるため、生の数値をそのまま載せると
// CPUが1%動くたびに state 全体を再送してしまう。バッテリー（5%刻み・変化時のみ配信）と
// 同じ考え方で、表示に必要な粒度まで落としてから載せる。

import { IParadisHostResources } from '../../resourceMonitor/common/paradisResourceMonitor.js';
import { IParadisMobileDesktopResources } from './paradisMobileRelay.js';

/**
 * CPU使用率の刻み(%)。実機で10秒サンプリングを繰り返すと、負荷が一定でも±数%は揺れるため、
 * 5%刻みでは毎回バケットを跨いで「丸めたのに毎回再送」になる（実測で9/9区間が変化）。
 * ドロワーのゲージは閾値の色分けが本体なので、この粒度で足りる。
 */
const CPU_STEP_PERCENT = 10;
/**
 * メモリ使用量の刻み（総量に対する比率）。2%刻み＝32GB機で約660MB。
 * macOSの `os.freemem()` はファイルキャッシュで常時数百MB動くため、1%では吸収しきれない。
 */
const MEMORY_STEP_RATIO = 0.02;
/** ディスク空き容量の刻み（総量に対する比率）。0.5%刻み＝1TBで約5GB。 */
const DISK_STEP_RATIO = 0.005;
/**
 * 空きがこれを下回る領域では、比率ではなく固定刻みに切り替える。
 * 「残り10GBで赤」のような絶対量の判定を、丸め幅（1TBなら±2.5GB）が跨いでしまわないようにする。
 */
const DISK_SMALL_FREE_THRESHOLD_BYTES = 50 * 1024 * 1024 * 1024;
/** 空きが少ない領域での固定刻み。 */
const DISK_SMALL_FREE_STEP_BYTES = 256 * 1024 * 1024;

function roundToStep(value: number, step: number, max: number): number {
	if (!Number.isFinite(value) || step <= 0) {
		return 0;
	}
	return Math.min(max, Math.max(0, Math.round(value / step) * step));
}

/**
 * 空き容量は必ず切り捨てる。切り上げると「実際より空きがある」と誤認させ、
 * 残量アラートの意味が失われる。
 */
function floorFreeBytes(free: number, total: number): number {
	if (!Number.isFinite(free) || free <= 0) {
		return 0;
	}
	const step = free < DISK_SMALL_FREE_THRESHOLD_BYTES
		? DISK_SMALL_FREE_STEP_BYTES
		: Math.max(1, Math.round(total * DISK_STEP_RATIO));
	return Math.min(total, Math.floor(free / step) * step);
}

/**
 * 配信用に丸める。メモリ総量が読めない場合（＝何も表示できない）は undefined を返し、
 * 呼び出し側は state に載せない。
 */
export function paradisRoundMobileResources(host: IParadisHostResources): IParadisMobileDesktopResources | undefined {
	const memTotal = Math.max(0, Math.round(host.memory.total));
	if (!Number.isFinite(memTotal) || memTotal <= 0) {
		return undefined;
	}
	const memStep = Math.max(1, Math.round(memTotal * MEMORY_STEP_RATIO));
	const primaryDisk = host.disks.length > 0 ? host.disks[0] : undefined;
	const diskTotal = primaryDisk !== undefined ? Math.max(0, Math.round(primaryDisk.total)) : 0;

	return {
		...(host.cpu !== undefined ? { cpu: roundToStep(host.cpu, CPU_STEP_PERCENT, 100) } : {}),
		memUsed: roundToStep(host.memory.used, memStep, memTotal),
		memTotal,
		...(primaryDisk !== undefined && diskTotal > 0
			? { diskFree: floorFreeBytes(primaryDisk.free, diskTotal), diskTotal }
			: {}),
	};
}

/**
 * 丸め済みの2値が配信上等価か。等価なら desktop state を再送しない。
 */
export function paradisMobileResourcesEqual(a: IParadisMobileDesktopResources | undefined, b: IParadisMobileDesktopResources | undefined): boolean {
	if (a === undefined || b === undefined) {
		return a === b;
	}
	return a.cpu === b.cpu
		&& a.memUsed === b.memUsed
		&& a.memTotal === b.memTotal
		&& a.diskFree === b.diskFree
		&& a.diskTotal === b.diskTotal;
}
