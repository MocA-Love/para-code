/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import * as assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { ParadisSystemUsageGrid, paradisSystemUsagePaths } from '../../browser/paradisSystemUsageChart.js';
import { paradisFormatRate, paradisSystemUsageAxisMax } from '../../common/paradisSystemUsageFormat.js';

suite('ParadisSystemUsageChart', () => {
	const store = ensureNoDisposablesAreLeakedInTestSuite();

	test('draws one run per stretch of measured points and breaks at gaps', () => {
		const samples = [
			{ t: 0, cpu: 0 },
			{ t: 5, cpu: 50 },
			{ t: 10 },
			{ t: 15, cpu: 100 },
			{ t: 20, cpu: 100 },
			// 60 まで空いた（スリープ）: 線を切る
			{ t: 80, cpu: 25 },
		];
		assert.deepStrictEqual(paradisSystemUsagePaths(samples, 'cpu', 0, 100, 100, 15), {
			line: 'M0,100L50,50M150,0L200,0M800,75',
			area: 'M0,100L0,100L50,50L50,100ZM150,100L150,0L200,0L200,100ZM800,100L800,75L800,100Z',
		});
	});

	test('formats rates and picks round axis tops', () => {
		assert.deepStrictEqual({
			rates: [0, 512, 1536, 20 * 1024, 3 * 1024 * 1024, 2 * 1024 ** 3].map(paradisFormatRate),
			axes: [
				paradisSystemUsageAxisMax('percent', 30),
				paradisSystemUsageAxisMax('rate', undefined),
				paradisSystemUsageAxisMax('rate', 3000),
				paradisSystemUsageAxisMax('bytes', 100, 4096),
			],
		}, {
			rates: ['0 B/s', '512 B/s', '1.5 KB/s', '20 KB/s', '3.0 MB/s', '2.00 GB/s'],
			axes: [100, 2048, 4096, 4096],
		});
	});

	test('renders unsupported items and a remote without history without drawing lines', () => {
		const container = document.createElement('div');
		const grid = store.add(new ParadisSystemUsageGrid(container, { compact: true, maxPoints: 60 }));
		grid.update({
			samples: [],
			latest: { t: 1, cpu: 42, mem: 80 },
			windowStart: 0,
			windowEnd: 0,
			windowMs: 300_000,
			stepMs: 5_000,
			unsupported: ['diskIo', 'network', 'swap'],
			legacy: true,
			swapTotal: undefined,
		});
		const cards = [...container.querySelectorAll('.paradis-sysusage-card')].map(card => ({
			value: card.querySelector('.paradis-sysusage-card-value')?.textContent,
			note: card.querySelector('.paradis-sysusage-card-note')?.textContent,
			line: card.querySelector('.paradis-sysusage-line')?.getAttribute('d'),
		}));
		const legacy = '接続先の Para Code を更新すると推移が出ます';
		const unsupported = 'このマシンでは取得できません';
		assert.deepStrictEqual(cards.map(card => ({ ...card, note: card.note === legacy ? 'legacy' : card.note === unsupported ? 'unsupported' : card.note })), [
			{ value: '42%', note: 'legacy', line: '' },
			{ value: '80%', note: 'legacy', line: '' },
			{ value: '--', note: 'legacy', line: '' },
			{ value: '--', note: 'unsupported', line: '' },
			{ value: '--', note: 'unsupported', line: '' },
			{ value: '--', note: 'unsupported', line: '' },
		]);
	});
});
