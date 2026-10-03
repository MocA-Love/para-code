/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

// システム使用率のグラフの項目の定義と、数の書き方（パネルとエディタで共有する）。

import { localize } from '../../../../nls.js';
import { IParadisSystemUsageSample, ParadisSystemUsageField, ParadisSystemUsageMetric, ParadisSystemUsageRange } from './paradisSystemUsage.js';
import { paradisFormatMemory } from './paradisResourceMonitorFormat.js';

export type ParadisSystemUsageUnit = 'percent' | 'rate' | 'bytes';

export interface IParadisSystemUsageSeriesSpec {
	readonly field: ParadisSystemUsageField;
	readonly label: string;
}

export interface IParadisSystemUsageMetricSpec {
	readonly id: ParadisSystemUsageMetric;
	readonly label: string;
	readonly unit: ParadisSystemUsageUnit;
	/** 1 本目は面を塗る線、2 本目は線だけ。 */
	readonly series: readonly IParadisSystemUsageSeriesSpec[];
}

export function paradisSystemUsageMetricSpecs(): readonly IParadisSystemUsageMetricSpec[] {
	return [
		{ id: 'cpu', label: localize('paradis.systemUsage.cpu', "CPU 使用率"), unit: 'percent', series: [{ field: 'cpu', label: localize('paradis.systemUsage.cpuSeries', "CPU") }] },
		{ id: 'memory', label: localize('paradis.systemUsage.memory', "メモリ使用率"), unit: 'percent', series: [{ field: 'mem', label: localize('paradis.systemUsage.memorySeries', "メモリ") }] },
		{ id: 'disk', label: localize('paradis.systemUsage.disk', "ディスク使用率"), unit: 'percent', series: [{ field: 'disk', label: localize('paradis.systemUsage.diskSeries', "ディスク") }] },
		{
			id: 'diskIo', label: localize('paradis.systemUsage.diskIo', "ディスク I/O"), unit: 'rate', series: [
				{ field: 'diskRead', label: localize('paradis.systemUsage.diskRead', "読み") },
				{ field: 'diskWrite', label: localize('paradis.systemUsage.diskWrite', "書き") },
			],
		},
		{
			id: 'network', label: localize('paradis.systemUsage.network', "帯域幅"), unit: 'rate', series: [
				{ field: 'netRx', label: localize('paradis.systemUsage.netRx', "受信") },
				{ field: 'netTx', label: localize('paradis.systemUsage.netTx', "送信") },
			],
		},
		{ id: 'swap', label: localize('paradis.systemUsage.swap', "スワップ使用量"), unit: 'bytes', series: [{ field: 'swapUsed', label: localize('paradis.systemUsage.swapSeries', "スワップ") }] },
	];
}

export function paradisSystemUsageRangeLabel(range: ParadisSystemUsageRange): string {
	switch (range) {
		case '5m': return localize('paradis.systemUsage.range5m', "5 分");
		case '1h': return localize('paradis.systemUsage.range1h', "1 時間");
		case '24h': return localize('paradis.systemUsage.range24h', "24 時間");
	}
}

const KB = 1024;
const MB = KB * 1024;
const GB = MB * 1024;

/** 毎秒の量（`1.2 MB/s`）。 */
export function paradisFormatRate(bytesPerSecond: number): string {
	const value = Math.max(0, bytesPerSecond);
	if (value < KB) {
		return `${Math.round(value)} B/s`;
	}
	if (value < MB) {
		return `${(value / KB).toFixed(value < 10 * KB ? 1 : 0)} KB/s`;
	}
	if (value < GB) {
		return `${(value / MB).toFixed(value < 10 * MB ? 1 : 0)} MB/s`;
	}
	return `${(value / GB).toFixed(2)} GB/s`;
}

export function paradisFormatSystemUsageValue(value: number | undefined, unit: ParadisSystemUsageUnit): string {
	if (value === undefined || !Number.isFinite(value)) {
		return '--';
	}
	switch (unit) {
		case 'percent': return `${Math.round(value)}%`;
		case 'rate': return paradisFormatRate(value);
		case 'bytes': return paradisFormatMemory(Math.max(0, value));
	}
}

/** 点の並びのうち、その項目の最大。 */
export function paradisSystemUsageMax(samples: readonly IParadisSystemUsageSample[], fields: readonly ParadisSystemUsageField[]): number | undefined {
	let max: number | undefined;
	for (const sample of samples) {
		for (const field of fields) {
			const value = sample[field];
			if (typeof value === 'number' && Number.isFinite(value) && (max === undefined || value > max)) {
				max = value;
			}
		}
	}
	return max;
}

/**
 * 縦軸の上端。% は 0〜100 に固定し、速度・量は最大の少し上のきりのいい値にする（線が上端に張り付かないように）。
 * スワップは総量が分かればそれを上端にする。
 */
export function paradisSystemUsageAxisMax(unit: ParadisSystemUsageUnit, max: number | undefined, total?: number): number {
	if (unit === 'percent') {
		return 100;
	}
	if (unit === 'bytes' && total !== undefined && total > 0) {
		return Math.max(total, max ?? 0);
	}
	const top = Math.max(max ?? 0, unit === 'rate' ? KB : MB);
	const magnitude = Math.pow(2, Math.ceil(Math.log2(top * 1.1)));
	return magnitude;
}
