/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

// タイトルバーの資源表示に出す項目（Q537 の 10 A）。項目ごとにオン/オフの設定を持ち、「設定 (Para Code)」の
// チェックと、タイトルバーの資源表示の右クリックのメニューから選ぶ。既定は今までどおり CPU とメモリ
// （SSH のウィンドウでは接続先の名前も）。

import { localize } from '../../../../nls.js';
import { IParadisSystemUsageMachine, IParadisSystemUsageSample } from './paradisSystemUsage.js';
import { paradisFormatRate, paradisFormatSystemUsageValue } from './paradisSystemUsageFormat.js';

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

function compactRate(bytesPerSecond: number): string {
	// タイトルバーでは「/s」を省いて短くする（3.1 MB/s → 3.1MB）。
	return paradisFormatRate(bytesPerSecond).replace(/\s?\/s$/, '').replace(' ', '');
}

/**
 * タイトルバーに出す文字。選ばれた項目を「 · 」でつなぐ。CPU とメモリは値が無いと「--」、ほかの項目は値が
 * 無いとき（その OS で取れない・スワップの無いマシン）はその項目ごと出さない。接続先の名前は SSH のウィンドウ
 * （`remoteLabel` があるとき）だけ。何も選ばれていなければ空文字（アイコンだけになる）。
 */
export function paradisResourceTitleBarText(
	isOn: (item: ParadisResourceTitleBarItem) => boolean,
	latest: IParadisSystemUsageSample,
	machine: Pick<IParadisSystemUsageMachine, 'swapTotal'> | undefined,
	remoteLabel: string | undefined,
): string {
	const parts: string[] = [];
	if (remoteLabel !== undefined && isOn('machineName')) {
		parts.push(remoteLabel);
	}
	for (const item of PARADIS_RESOURCE_TITLE_BAR_ITEMS) {
		if (!isOn(item)) {
			continue;
		}
		switch (item) {
			case 'cpu':
				parts.push(localize('paradis.resourceMonitor.titleBar.cpu', "CPU {0}", paradisFormatSystemUsageValue(latest.cpu, 'percent')));
				break;
			case 'memory':
				parts.push(localize('paradis.resourceMonitor.titleBar.memory', "RAM {0}", paradisFormatSystemUsageValue(latest.mem, 'percent')));
				break;
			case 'disk':
				if (latest.disk !== undefined) {
					parts.push(localize('paradis.resourceMonitor.titleBar.disk', "DISK {0}", paradisFormatSystemUsageValue(latest.disk, 'percent')));
				}
				break;
			case 'swap':
				if (latest.swapUsed !== undefined && machine?.swapTotal) {
					parts.push(localize('paradis.resourceMonitor.titleBar.swap', "SWAP {0}", paradisFormatSystemUsageValue(latest.swapUsed / machine.swapTotal * 100, 'percent')));
				}
				break;
			case 'diskIo':
				if (latest.diskRead !== undefined && latest.diskWrite !== undefined) {
					parts.push(localize('paradis.resourceMonitor.titleBar.diskIo', "R {0} W {1}", compactRate(latest.diskRead), compactRate(latest.diskWrite)));
				}
				break;
			case 'network':
				if (latest.netRx !== undefined && latest.netTx !== undefined) {
					parts.push(localize('paradis.resourceMonitor.titleBar.network', "↓{0} ↑{1}", compactRate(latest.netRx), compactRate(latest.netTx)));
				}
				break;
		}
	}
	return parts.join(' · ');
}
