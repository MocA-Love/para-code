/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../base/test/common/utils.js';
import { paraBrowserViewShrinkLayout } from '../../common/paraBrowserViewShrinkLayout.js';

suite('paraBrowserViewShrinkLayout', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	test('keeps the page area of a shrunk fixed size at least the fixed size, so a page of exactly that size does not overflow', () => {
		// 1600x900 を 1088x? のエディタへ縮めた倍率（実測の 0.39088…）と、端数の出る 0.50199…
		const cases = [[1600, 900, 0.39088541666666665], [1600, 900, 0.5019965277777778], [1920, 1080, 0.5], [390, 844, 0.3]] as const;
		const results = cases.map(([width, height, scale]) => {
			const { viewSize, zoom } = paraBrowserViewShrinkLayout(width, height, scale);
			return {
				viewSize,
				pageWidthFits: viewSize.width / zoom >= width - 1e-9,
				pageHeightFits: viewSize.height / zoom >= height - 1e-9,
				oneSideExact: Math.abs(viewSize.width / zoom - width) < 1e-9 || Math.abs(viewSize.height / zoom - height) < 1e-9,
				nearScale: Math.abs(zoom - scale) < 0.01,
			};
		});
		assert.deepStrictEqual(results, [
			{ viewSize: { width: 625, height: 352 }, pageWidthFits: true, pageHeightFits: true, oneSideExact: true, nearScale: true },
			{ viewSize: { width: 803, height: 452 }, pageWidthFits: true, pageHeightFits: true, oneSideExact: true, nearScale: true },
			{ viewSize: { width: 960, height: 540 }, pageWidthFits: true, pageHeightFits: true, oneSideExact: true, nearScale: true },
			{ viewSize: { width: 117, height: 253 }, pageWidthFits: true, pageHeightFits: true, oneSideExact: true, nearScale: true },
		]);
	});
});
