/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese test comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import assert from 'assert';
import { mainWindow } from '../../../../../base/browser/window.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { PARADIS_SHARE_CARD_HEIGHT, PARADIS_SHARE_CARD_WIDTH, paradisDrawShareCard, paradisShareCardPng, paradisShareCardStats } from '../../electron-browser/paradisWorkShareCard.js';

suite('ParadisWorkShareCard', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	const data = { periodLabel: '2026/09/20 – 09/26', scopeLabel: 'Codex', sessions: 48, turns: 1236, activeMs: (31 * 60 + 20) * 60_000, prs: 17, dailyTurns: [3, 0, 9] };

	test('puts only the period and the four numbers on the card', () => {
		assert.deepStrictEqual(paradisShareCardStats(data).map(stat => stat.value), ['48', '1,236', '31h 20m', '17']);
	});

	test('draws a white 1200 x 630 PNG', async () => {
		const canvas = paradisDrawShareCard(mainWindow.document, data);
		const pixel = [...canvas.getContext('2d')!.getImageData(10, 10, 1, 1).data];
		const png = await paradisShareCardPng(canvas);
		assert.deepStrictEqual({ width: canvas.width, height: canvas.height, pixel, type: png.type }, {
			width: PARADIS_SHARE_CARD_WIDTH, height: PARADIS_SHARE_CARD_HEIGHT, pixel: [255, 255, 255, 255], type: 'image/png',
		});
	});
});
