/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

// タイトルバーの資源表示に出す項目（Q537 の 10 A）。項目ごとにオン/オフの設定を持ち、「設定 (Para Code)」の
// チェックと、タイトルバーの資源表示の右クリックのメニューから選ぶ。既定は今までどおり CPU とメモリ
// （SSH のウィンドウでは接続先の名前も）。
// メモリ・ディスク・スワップは、出し方（割合・使用量 / 全体・使用量・空き）も項目ごとに選べる。CPU は割合だけ、
// ディスクの読み書きとネットワークは毎秒の量で全体の大きさが無いので、出し方の設定を持たない。

import { localize } from '../../../../nls.js';
import { IParadisSystemUsageMachine, IParadisSystemUsageSample } from './paradisSystemUsage.js';
import { paradisFormatRate, paradisFormatSystemUsageValue } from './paradisSystemUsageFormat.js';
import { paradisFormatMemory } from './paradisResourceMonitorFormat.js';

export type ParadisResourceTitleBarItem = 'machineName' | 'cpu' | 'memory' | 'disk' | 'swap' | 'diskIo' | 'network';

/** 並びの順（タイトルバーに出す順でもある）。 */
export const PARADIS_RESOURCE_TITLE_BAR_ITEMS: readonly ParadisResourceTitleBarItem[] = ['cpu', 'memory', 'disk', 'swap', 'diskIo', 'network', 'machineName'];

export function paradisResourceTitleBarSettingKey(item: ParadisResourceTitleBarItem): string {
	return `paradis.resourceMonitor.titleBar.${item}`;
}

/** 既定でオンの項目（今までのタイトルバーの表示と同じ）。 */
export function paradisResourceTitleBarDefault(item: ParadisResourceTitleBarItem): boolean {
	return item === 'cpu' || item === 'memory' || item === 'machineName';
}

/** 設定・メニューに出す項目の名前。 */
export function paradisResourceTitleBarItemLabel(item: ParadisResourceTitleBarItem): string {
	switch (item) {
		case 'cpu': return localize('paradis.resourceMonitor.item.cpu', "CPU");
		case 'memory': return localize('paradis.resourceMonitor.item.memory', "メモリ");
		case 'disk': return localize('paradis.resourceMonitor.item.disk', "ディスク");
		case 'swap': return localize('paradis.resourceMonitor.item.swap', "スワップ");
		case 'diskIo': return localize('paradis.resourceMonitor.item.diskIo', "ディスクの読み書き");
		case 'network': return localize('paradis.resourceMonitor.item.network', "ネットワーク");
		case 'machineName': return localize('paradis.resourceMonitor.item.machineName', "接続先の名前（SSH）");
	}
}

/** 出し方を選べる項目（全体の大きさがある項目）。 */
export type ParadisResourceTitleBarSizedItem = 'memory' | 'disk' | 'swap';

export const PARADIS_RESOURCE_TITLE_BAR_SIZED_ITEMS: readonly ParadisResourceTitleBarSizedItem[] = ['memory', 'disk', 'swap'];

/** 出し方。`percent` が既定（今までの表示）。 */
export type ParadisResourceTitleBarFormat = 'percent' | 'usedOfTotal' | 'used' | 'free';

export const PARADIS_RESOURCE_TITLE_BAR_FORMATS: readonly ParadisResourceTitleBarFormat[] = ['percent', 'usedOfTotal', 'used', 'free'];

export function paradisResourceTitleBarFormatSettingKey(item: ParadisResourceTitleBarSizedItem): string {
	return `paradis.resourceMonitor.titleBar.${item}Format`;
}

/** 設定の値を読む。知らない値（古い・手で書き換えた）は割合として扱う。 */
export function paradisParseResourceTitleBarFormat(value: unknown): ParadisResourceTitleBarFormat {
	return PARADIS_RESOURCE_TITLE_BAR_FORMATS.includes(value as ParadisResourceTitleBarFormat) ? value as ParadisResourceTitleBarFormat : 'percent';
}

/** 設定・メニューに出す出し方の名前。 */
export function paradisResourceTitleBarFormatLabel(format: ParadisResourceTitleBarFormat): string {
	switch (format) {
		case 'percent': return localize('paradis.resourceMonitor.format.percent', "割合（例: 98%）");
		case 'usedOfTotal': return localize('paradis.resourceMonitor.format.usedOfTotal', "使用量 / 全体（例: 412 / 460 GB）");
		case 'used': return localize('paradis.resourceMonitor.format.used', "使用量（例: 412 GB）");
		case 'free': return localize('paradis.resourceMonitor.format.free', "空き（例: 48 GB 空き）");
	}
}

/** 出し方の設定・メニューの見出し（「ディスクの表示」）。 */
export function paradisResourceTitleBarFormatTitle(item: ParadisResourceTitleBarSizedItem): string {
	switch (item) {
		case 'memory': return localize('paradis.resourceMonitor.formatTitle.memory', "メモリの表示");
		case 'disk': return localize('paradis.resourceMonitor.formatTitle.disk', "ディスクの表示");
		case 'swap': return localize('paradis.resourceMonitor.formatTitle.swap', "スワップの表示");
	}
}

const SIZE_UNITS: readonly { readonly name: string; readonly bytes: number }[] = [
	{ name: 'TB', bytes: 1024 ** 4 },
	{ name: 'GB', bytes: 1024 ** 3 },
	{ name: 'MB', bytes: 1024 ** 2 },
];

/** 大きさに合う単位（1 以上になる一番大きい単位。MB 未満も MB）。パネルと同じく 1024 で割る。 */
function sizeUnitOf(bytes: number): { readonly name: string; readonly bytes: number } {
	for (let i = 0; i < SIZE_UNITS.length; i++) {
		const unit = SIZE_UNITS[i];
		if (bytes >= unit.bytes || i === SIZE_UNITS.length - 1) {
			// 丸めると 1024 になる値（1023.97 MB）は上の単位で書く（1 GB）
			return i > 0 && roundedSize(bytes / unit.bytes) >= 1024 ? SIZE_UNITS[i - 1] : unit;
		}
	}
	return SIZE_UNITS[SIZE_UNITS.length - 1];
}

/** 小数は 1 桁まで（10 以上は整数）。`2.0` は `2` と書く。 */
function roundedSize(value: number): number {
	const oneDecimal = Math.round(value * 10) / 10;
	return oneDecimal >= 10 ? Math.round(value) : oneDecimal;
}

function formatSizeIn(bytes: number, unit: { readonly bytes: number }): string {
	return String(roundedSize(Math.max(0, bytes) / unit.bytes));
}

/** タイトルバーの大きさ（`48 GB`・`1.2 TB`・`512 MB`）。 */
export function paradisFormatTitleBarSize(bytes: number): string {
	const unit = sizeUnitOf(Math.max(0, bytes));
	return `${formatSizeIn(bytes, unit)} ${unit.name}`;
}

/** 「使用量 / 全体」。単位は全体の大きさで決め、両方をその単位で書く（`412 / 460 GB`）。 */
export function paradisFormatTitleBarUsedOfTotal(used: number, total: number): string {
	const unit = sizeUnitOf(Math.max(0, total));
	return `${formatSizeIn(used, unit)} / ${formatSizeIn(total, unit)} ${unit.name}`;
}

/** 項目の使用量と全体（バイト）と割合。測る側が使用量を送らない（古い）ときは割合と全体から出す。 */
interface IParadisSizedValue {
	readonly percent: number | undefined;
	readonly used: number | undefined;
	readonly total: number | undefined;
}

type ParadisTitleBarMachine = Pick<IParadisSystemUsageMachine, 'swapTotal'> & Partial<Pick<IParadisSystemUsageMachine, 'memTotal' | 'diskTotal'>>;

function sizedValue(item: ParadisResourceTitleBarSizedItem, latest: IParadisSystemUsageSample, machine: ParadisTitleBarMachine | undefined): IParadisSizedValue {
	const positive = (value: number | undefined) => value !== undefined && Number.isFinite(value) && value > 0 ? value : undefined;
	const usedOf = (percent: number | undefined, used: number | undefined, total: number | undefined) =>
		used !== undefined && Number.isFinite(used) ? used : percent !== undefined && total !== undefined ? percent / 100 * total : undefined;
	switch (item) {
		case 'memory': {
			const total = positive(machine?.memTotal);
			return { percent: latest.mem, used: usedOf(latest.mem, latest.memUsed, total), total };
		}
		case 'disk': {
			const total = positive(machine?.diskTotal);
			return { percent: latest.disk, used: usedOf(latest.disk, latest.diskUsed, total), total };
		}
		case 'swap': {
			const total = positive(machine?.swapTotal);
			return { percent: latest.swapUsed !== undefined && total !== undefined ? latest.swapUsed / total * 100 : undefined, used: latest.swapUsed, total };
		}
	}
}

/**
 * タイトルバーの 1 つの値と、その値の箱に確保しておく一番広い文字（`reserve`）。数字の桁が変わっても
 * （9% → 10% → 100%）箱の幅が変わらず、右に並ぶ部品が動かないようにする（箱の幅は CSS で
 * max(値, reserve) になる。paradisResourceMonitor.css の `.paradis-resource-monitor-trigger-value`）。
 */
export interface IParadisResourceTitleBarValue {
	readonly value: string;
	readonly reserve: string;
}

/** 割合の一番広い値（100%）。 */
const PERCENT_RESERVE = paradisFormatSystemUsageValue(100, 'percent');

/**
 * 単位の決まっていない大きさ・毎秒の量の一番広い数字。数字は 3 桁まで（1000〜1023 の間だけ 4 桁になるが、
 * そこまで確保すると普段の隙間が 1 桁ぶん広がるので、その間だけ箱が広がるのを許す）。
 */
const NUMBER_RESERVE = '999';

/** 単位に MB を使う（GB・TB・KB より広い M で確保する）。 */
const SIZE_RESERVE = `${NUMBER_RESERVE} MB`;

function percentValue(percent: number | undefined): IParadisResourceTitleBarValue {
	return { value: paradisFormatSystemUsageValue(percent, 'percent'), reserve: PERCENT_RESERVE };
}

function freeText(size: string): string {
	return localize('paradis.resourceMonitor.titleBar.free', "{0} 空き", size);
}

/**
 * 「使用量 / 全体」の一番広い文字。全体と単位は変わらないので実際の値を使い、使用量は全体の整数部の桁数
 * （小数の 9.9 も入るよう 3 桁以上）を確保する（`412 / 460 GB` → `000 / 460 GB`）。
 */
function usedOfTotalReserve(total: number): string {
	const unit = sizeUnitOf(Math.max(0, total));
	const totalText = formatSizeIn(total, unit);
	const digits = Math.max(NUMBER_RESERVE.length, totalText.split('.')[0].length);
	return `${'0'.repeat(digits)} / ${totalText} ${unit.name}`;
}

/** 選んだ出し方の値の文字。大きさが分からなければ割合に戻す（割合も無ければ undefined）。 */
function formatSized(value: IParadisSizedValue, format: ParadisResourceTitleBarFormat): IParadisResourceTitleBarValue | undefined {
	const { used, total } = value;
	if (format !== 'percent' && used !== undefined && total !== undefined) {
		switch (format) {
			case 'usedOfTotal': return { value: paradisFormatTitleBarUsedOfTotal(Math.min(used, total), total), reserve: usedOfTotalReserve(total) };
			case 'used': return { value: paradisFormatTitleBarSize(used), reserve: SIZE_RESERVE };
			case 'free': return { value: freeText(paradisFormatTitleBarSize(Math.max(0, total - used))), reserve: freeText(SIZE_RESERVE) };
		}
	}
	return value.percent !== undefined ? percentValue(value.percent) : undefined;
}

function compactRate(bytesPerSecond: number): IParadisResourceTitleBarValue {
	// タイトルバーでは「/s」を省いて短くする（3.1 MB/s → 3.1MB）。
	return { value: paradisFormatRate(bytesPerSecond).replace(/\s?\/s$/, '').replace(' ', ''), reserve: `${NUMBER_RESERVE}MB` };
}

/** タイトルバーの 1 項目（`CPU 44%`）と、その中の値（出てくる順）。 */
export interface IParadisResourceTitleBarPart {
	readonly text: string;
	readonly values: readonly IParadisResourceTitleBarValue[];
}

/** 項目の文字を、値の前後の文字と値に分ける（値は {@link IParadisResourceTitleBarPart.values} の順に探す）。 */
export function paradisSplitResourceTitleBarPart(part: IParadisResourceTitleBarPart): (string | IParadisResourceTitleBarValue)[] {
	const pieces: (string | IParadisResourceTitleBarValue)[] = [];
	let cursor = 0;
	for (const value of part.values) {
		const index = part.text.indexOf(value.value, cursor);
		if (index < 0) {
			continue;
		}
		if (index > cursor) {
			pieces.push(part.text.slice(cursor, index));
		}
		pieces.push(value);
		cursor = index + value.value.length;
	}
	if (cursor < part.text.length) {
		pieces.push(part.text.slice(cursor));
	}
	return pieces;
}

/**
 * タイトルバーに出す項目。CPU とメモリは値が無いと「--」、ほかの項目は値が無いとき（その OS で取れない・
 * スワップの無いマシン）はその項目ごと出さない。接続先の名前は SSH のウィンドウ（`remoteLabel` があるとき）
 * だけ。何も選ばれていなければ空（アイコンだけになる）。
 */
export function paradisResourceTitleBarParts(
	isOn: (item: ParadisResourceTitleBarItem) => boolean,
	latest: IParadisSystemUsageSample,
	machine: ParadisTitleBarMachine | undefined,
	remoteLabel: string | undefined,
	formatOf: (item: ParadisResourceTitleBarSizedItem) => ParadisResourceTitleBarFormat = () => 'percent',
): IParadisResourceTitleBarPart[] {
	const parts: IParadisResourceTitleBarPart[] = [];
	if (remoteLabel !== undefined && isOn('machineName')) {
		parts.push({ text: remoteLabel, values: [] });
	}
	for (const item of PARADIS_RESOURCE_TITLE_BAR_ITEMS) {
		if (!isOn(item)) {
			continue;
		}
		switch (item) {
			case 'cpu': {
				const value = percentValue(latest.cpu);
				parts.push({ text: localize('paradis.resourceMonitor.titleBar.cpu', "CPU {0}", value.value), values: [value] });
				break;
			}
			case 'memory': {
				const value = formatSized(sizedValue('memory', latest, machine), formatOf('memory')) ?? percentValue(undefined);
				parts.push({ text: localize('paradis.resourceMonitor.titleBar.memory', "RAM {0}", value.value), values: [value] });
				break;
			}
			case 'disk': {
				const value = formatSized(sizedValue('disk', latest, machine), formatOf('disk'));
				if (value !== undefined) {
					parts.push({ text: localize('paradis.resourceMonitor.titleBar.disk', "DISK {0}", value.value), values: [value] });
				}
				break;
			}
			case 'swap': {
				// スワップの無いマシン（総量 0）では出さない
				const swap = sizedValue('swap', latest, machine);
				const value = swap.total !== undefined ? formatSized(swap, formatOf('swap')) : undefined;
				if (value !== undefined) {
					parts.push({ text: localize('paradis.resourceMonitor.titleBar.swap', "SWAP {0}", value.value), values: [value] });
				}
				break;
			}
			case 'diskIo':
				if (latest.diskRead !== undefined && latest.diskWrite !== undefined) {
					const read = compactRate(latest.diskRead);
					const write = compactRate(latest.diskWrite);
					parts.push({ text: localize('paradis.resourceMonitor.titleBar.diskIo', "R {0} W {1}", read.value, write.value), values: [read, write] });
				}
				break;
			case 'network':
				if (latest.netRx !== undefined && latest.netTx !== undefined) {
					const rx = compactRate(latest.netRx);
					const tx = compactRate(latest.netTx);
					parts.push({ text: localize('paradis.resourceMonitor.titleBar.network', "↓{0} ↑{1}", rx.value, tx.value), values: [rx, tx] });
				}
				break;
		}
	}
	return parts;
}

/** タイトルバーの項目をつなぐ文字。 */
export const PARADIS_RESOURCE_TITLE_BAR_SEPARATOR = ' · ';

/** タイトルバーに出す文字（{@link paradisResourceTitleBarParts} を「 · 」でつないだもの）。 */
export function paradisResourceTitleBarText(
	isOn: (item: ParadisResourceTitleBarItem) => boolean,
	latest: IParadisSystemUsageSample,
	machine: ParadisTitleBarMachine | undefined,
	remoteLabel: string | undefined,
	formatOf: (item: ParadisResourceTitleBarSizedItem) => ParadisResourceTitleBarFormat = () => 'percent',
): string {
	return paradisResourceTitleBarParts(isOn, latest, machine, remoteLabel, formatOf).map(part => part.text).join(PARADIS_RESOURCE_TITLE_BAR_SEPARATOR);
}

/**
 * ホバーに出す詳しい数字（出し方の設定に関わらず、取れた項目をすべて 1 行ずつ）。
 * 例: 「ディスク: 412 GB / 460 GB を使用（98%）・空き 48 GB」。
 */
export function paradisResourceTitleBarDetail(latest: IParadisSystemUsageSample, machine: ParadisTitleBarMachine | undefined, label: string): string {
	const lines = [localize('paradis.resourceMonitor.detail.title', "{0} の使用率", label)];
	if (latest.cpu !== undefined) {
		lines.push(localize('paradis.resourceMonitor.detail.cpu', "CPU: {0}", paradisFormatSystemUsageValue(latest.cpu, 'percent')));
	}
	for (const item of PARADIS_RESOURCE_TITLE_BAR_SIZED_ITEMS) {
		const value = sizedValue(item, latest, machine);
		const name = paradisResourceTitleBarItemLabel(item);
		if (value.used !== undefined && value.total !== undefined) {
			const percent = paradisFormatSystemUsageValue(value.percent ?? value.used / value.total * 100, 'percent');
			lines.push(localize('paradis.resourceMonitor.detail.sized', "{0}: {1} / {2} を使用（{3}）・空き {4}", name, paradisFormatMemory(Math.min(value.used, value.total)), paradisFormatMemory(value.total), percent, paradisFormatMemory(Math.max(0, value.total - value.used))));
		} else if (value.percent !== undefined) {
			lines.push(localize('paradis.resourceMonitor.detail.percent', "{0}: {1}", name, paradisFormatSystemUsageValue(value.percent, 'percent')));
		}
	}
	if (latest.diskRead !== undefined && latest.diskWrite !== undefined) {
		lines.push(localize('paradis.resourceMonitor.detail.diskIo', "ディスクの読み書き: 読み {0}・書き {1}", paradisFormatRate(latest.diskRead), paradisFormatRate(latest.diskWrite)));
	}
	if (latest.netRx !== undefined && latest.netTx !== undefined) {
		lines.push(localize('paradis.resourceMonitor.detail.network', "ネットワーク: 受信 {0}・送信 {1}", paradisFormatRate(latest.netRx), paradisFormatRate(latest.netTx)));
	}
	return lines.join('\n');
}
