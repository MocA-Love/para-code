/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-PATCH/PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { paradisLimitsPanelLayout } from '../../common/paradisLimitsPanelLayout.js';

suite('Paradis limits panel layout', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	test('keeps the panel inside the window and narrows or stacks it when the window is small', () => {
		assert.deepStrictEqual({
			// ボタンの左端に揃える
			wide: paradisLimitsPanelLayout(100, 1600),
			// ボタンが右寄りにある → 右端からはみ出さないよう左へ押し戻す
			pushedLeft: paradisLimitsPanelLayout(1400, 1600),
			// ボタンが左端より左（あり得ないが）→ 左の余白から
			pushedRight: paradisLimitsPanelLayout(-20, 1600),
			// 800px は入らないが 2列は入る → 幅いっぱいの2列
			narrowTwoColumns: paradisLimitsPanelLayout(500, 700),
			// 2列が入らない → 400px の1列
			oneColumn: paradisLimitsPanelLayout(500, 600),
			// 400px も入らない → 幅いっぱいの1列
			tiny: paradisLimitsPanelLayout(100, 300),
		}, {
			wide: { left: 100, width: 800, columns: 2 },
			pushedLeft: { left: 792, width: 800, columns: 2 },
			pushedRight: { left: 8, width: 800, columns: 2 },
			narrowTwoColumns: { left: 8, width: 684, columns: 2 },
			oneColumn: { left: 192, width: 400, columns: 1 },
			tiny: { left: 8, width: 284, columns: 1 },
		});
	});

	test('never lets either edge leave the window at any width', () => {
		const clipped: string[] = [];
		for (let viewport = 216; viewport <= 2000; viewport += 37) {
			for (const anchor of [0, viewport / 2, viewport - 10]) {
				const layout = paradisLimitsPanelLayout(anchor, viewport);
				if (layout.left < 8 || layout.left + layout.width > viewport - 8) {
					clipped.push(`${viewport}:${anchor}`);
				}
			}
		}
		assert.deepStrictEqual(clipped, []);
	});
});
