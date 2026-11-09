/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese test comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import * as assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { IParadisSystemUsageSample } from '../../common/paradisSystemUsage.js';
import { ParadisResourceTitleBarFormat, ParadisResourceTitleBarItem, ParadisResourceTitleBarSizedItem, paradisFormatTitleBarSize, paradisFormatTitleBarUsedOfTotal, paradisParseResourceTitleBarFormat, paradisResourceTitleBarDetail, paradisResourceTitleBarParts, paradisResourceTitleBarText, paradisSplitResourceTitleBarPart } from '../../common/paradisResourceTitleBar.js';

const MB = 1024 ** 2;
const GB = 1024 ** 3;
const TB = 1024 ** 4;

suite('ParadisResourceTitleBar', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	// 単位は大きさに合わせて MB・GB・TB、小数は 1 桁まで（10 以上は整数、2.0 は 2）
	test('formats sizes with an automatic unit and at most one decimal', () => {
		assert.deepStrictEqual({
			sizes: [0, 512 * MB, 1023.97 * MB, 1.25 * GB, 2 * GB, 9.96 * GB, 48 * GB, 1.5 * TB].map(paradisFormatTitleBarSize),
			usedOfTotal: [paradisFormatTitleBarUsedOfTotal(412 * GB, 460 * GB), paradisFormatTitleBarUsedOfTotal(1.2 * TB, 2 * TB), paradisFormatTitleBarUsedOfTotal(12 * MB, 2 * GB)],
			parsed: ['percent', 'usedOfTotal', 'used', 'free', true, 'other', undefined].map(paradisParseResourceTitleBarFormat),
		}, {
			sizes: ['0 MB', '512 MB', '1 GB', '1.3 GB', '2 GB', '10 GB', '48 GB', '1.5 TB'],
			usedOfTotal: ['412 / 460 GB', '1.2 / 2 TB', '0 / 2 GB'],
			parsed: ['percent', 'usedOfTotal', 'used', 'free', 'percent', 'percent', 'percent'],
		});
	});

	// 出し方は項目ごと。大きさが分からない（古い接続先・総量が無い）ときは割合に戻す。ホバーは出し方に関わらず詳しく
	test('shows memory, disk and swap in the chosen format and the full numbers in the hover', () => {
		const items = new Set<ParadisResourceTitleBarItem>(['cpu', 'memory', 'disk', 'swap']);
		const latest = { t: 1, cpu: 84, mem: 27, memUsed: 17.3 * GB, disk: 89.6, diskUsed: 412 * GB, swapUsed: 0 };
		const machine = { memTotal: 64 * GB, diskTotal: 460 * GB, swapTotal: 2 * GB };
		const formats = (memory: ParadisResourceTitleBarFormat, disk: ParadisResourceTitleBarFormat, swap: ParadisResourceTitleBarFormat) =>
			(item: ParadisResourceTitleBarSizedItem) => ({ memory, disk, swap })[item];
		const text = (format: (item: ParadisResourceTitleBarSizedItem) => ParadisResourceTitleBarFormat, sample: IParadisSystemUsageSample = latest, info: typeof machine | undefined = machine) =>
			paradisResourceTitleBarText(item => items.has(item), sample, info, undefined, format);
		const { diskUsed: _diskUsed, ...withoutDiskBytes } = latest;
		assert.deepStrictEqual({
			defaults: paradisResourceTitleBarText(item => items.has(item), latest, machine, undefined),
			mixed: text(formats('usedOfTotal', 'free', 'used')),
			used: text(formats('used', 'used', 'usedOfTotal')),
			// 古い接続先はディスクの使用量を送らないので、割合と全体から出す
			derived: text(formats('percent', 'used', 'percent'), { ...withoutDiskBytes, disk: 50 }),
			noMachine: paradisResourceTitleBarText(item => items.has(item), latest, undefined, undefined, formats('usedOfTotal', 'free', 'used')),
			hover: paradisResourceTitleBarDetail(latest, machine, 'dev-server').split('\n'),
		}, {
			defaults: 'CPU 84% · RAM 27% · DISK 90% · SWAP 0%',
			mixed: 'CPU 84% · RAM 17 / 64 GB · DISK 48 GB 空き · SWAP 0 MB',
			used: 'CPU 84% · RAM 17 GB · DISK 412 GB · SWAP 0 / 2 GB',
			derived: 'CPU 84% · RAM 27% · DISK 230 GB · SWAP 0%',
			noMachine: 'CPU 84% · RAM 27% · DISK 90%',
			hover: [
				'dev-server の使用率',
				'CPU: 84%',
				'メモリ: 17.30 GB / 64.00 GB を使用（27%）・空き 46.70 GB',
				'ディスク: 412.00 GB / 460.00 GB を使用（90%）・空き 48.00 GB',
				'スワップ: 0 KB / 2.00 GB を使用（0%）・空き 2.00 GB',
			],
		});
	});

	// 値ごとに一番広い値（reserve）を持ち、桁が変わっても箱の幅が変わらない。文字は値の前後と値に分けられる
	test('gives each value the widest text to reserve so the width does not follow the digits', () => {
		const items = new Set<ParadisResourceTitleBarItem>(['machineName', 'cpu', 'memory', 'disk', 'swap', 'network']);
		const machine = { memTotal: 64 * GB, diskTotal: 460 * GB, swapTotal: 2 * GB };
		const formats = { memory: 'usedOfTotal', disk: 'free', swap: 'percent' } as const;
		const parts = (cpu: number | undefined) => paradisResourceTitleBarParts(item => items.has(item), { t: 1, cpu, mem: 27, memUsed: 17.3 * GB, disk: 89.6, diskUsed: 412 * GB, swapUsed: 0, netRx: 3.1 * MB, netTx: 0 }, machine, 'dev-server', item => formats[item]);
		const describe = (cpu: number | undefined) => parts(cpu).map(part => paradisSplitResourceTitleBarPart(part).map(piece => typeof piece === 'string' ? piece : `[${piece.value}|${piece.reserve}]`).join(''));
		assert.deepStrictEqual({
			cpu: [undefined, 0, 9, 10, 100].map(cpu => describe(cpu)[1]),
			others: describe(44),
		}, {
			cpu: ['CPU [--|100%]', 'CPU [0%|100%]', 'CPU [9%|100%]', 'CPU [10%|100%]', 'CPU [100%|100%]'],
			others: ['dev-server', 'CPU [44%|100%]', 'RAM [17 / 64 GB|000 / 64 GB]', 'DISK [48 GB 空き|999 MB 空き]', 'SWAP [0%|100%]', '↓[3.1MB|999MB] ↑[0B|999MB]'],
		});
	});
});
