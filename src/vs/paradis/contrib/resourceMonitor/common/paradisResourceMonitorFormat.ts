/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-PATCH/PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

// CPU/RAMモニタの数値フォーマットと重大度判定(Superset apps/desktop の
// TopBar/components/ResourceConsumption/utils/{formatters,resourceSeverity}.ts 移植)。
// electron-browser側のウィジェット/パネルからのみ参照される純粋関数。

import { IParadisResourceUsage } from './paradisResourceMonitor.js';

const KB = 1024;
const MB = KB * 1024;
const GB = MB * 1024;

export function paradisFormatMemory(bytes: number): string {
	if (bytes < MB) {
		return `${(bytes / KB).toFixed(0)} KB`;
	}
	if (bytes < GB) {
		return `${(bytes / MB).toFixed(1)} MB`;
	}
	return `${(bytes / GB).toFixed(2)} GB`;
}

export function paradisFormatCpu(percent: number): string {
	return `${percent.toFixed(1)}%`;
}

export function paradisFormatPercent(value: number): string {
	return `${value.toFixed(0)}%`;
}

export type ParadisUsageSeverity = 'normal' | 'elevated' | 'high';

/**
 * 個々の行(App/Main/Renderer/スコープ/セッション)の重大度。絶対値がまず高ければそれで確定し、
 * そうでなければ `totals` に対する占有率(share)で elevated/high を判定する。
 */
export function paradisGetUsageSeverity(values: IParadisResourceUsage, totals: IParadisResourceUsage, options: { includeShare?: boolean } = {}): ParadisUsageSeverity {
	const includeShare = options.includeShare ?? true;

	if (values.cpu >= 120 || values.memory >= 3 * GB) {
		return 'high';
	}
	if (values.cpu >= 70 || values.memory >= 1.5 * GB) {
		return 'elevated';
	}
	if (!includeShare) {
		return 'normal';
	}

	const isCpuPressure = totals.cpu >= 60;
	const isMemoryPressure = totals.memory >= 1.5 * GB;
	if (!isCpuPressure && !isMemoryPressure) {
		return 'normal';
	}

	const cpuShare = totals.cpu > 0 ? values.cpu / totals.cpu : 0;
	const memoryShare = totals.memory > 0 ? values.memory / totals.memory : 0;

	if ((isCpuPressure && cpuShare >= 0.55 && values.cpu >= 25) || (isMemoryPressure && memoryShare >= 0.55 && values.memory >= 768 * MB)) {
		return 'high';
	}
	if ((isCpuPressure && cpuShare >= 0.35 && values.cpu >= 15) || (isMemoryPressure && memoryShare >= 0.35 && values.memory >= 512 * MB)) {
		return 'elevated';
	}
	return 'normal';
}

/** ホストの物理メモリに対する追跡対象(App+全スコープ)の占有率から、トリガー右上ドット等の重大度を決める。 */
export function paradisGetTrackedHostMemorySeverity(trackedMemorySharePercent: number): ParadisUsageSeverity {
	if (trackedMemorySharePercent >= 35) {
		return 'high';
	}
	if (trackedMemorySharePercent >= 20) {
		return 'elevated';
	}
	return 'normal';
}
