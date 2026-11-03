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

	test('keeps the page width exactly the fixed width and the page height at least the fixed height, short of one screen pixel', () => {
		// 1600x900 を縮めた倍率（実測の 0.39088… と、端数の出る 0.50199…）と、ほかの大きさ
		const cases = [[1600, 900, 0.39088541666666665], [1600, 900, 0.5019965277777778], [1920, 1080, 0.5], [390, 844, 0.3], [1366, 768, 0.61]] as const;
		const results = cases.map(([width, height, scale]) => {
			const { viewSize, zoom } = paraBrowserViewShrinkLayout(width, height, scale);
			const pageHeight = viewSize.height / zoom;
			return {
				viewSize,
				widthExact: Math.abs(viewSize.width / zoom - width) < 1e-9,
				heightFits: pageHeight >= height - 1e-9,
				heightExtraUnderOneScreenPixel: (pageHeight - height) * zoom < 1,
				nearScale: Math.abs(zoom - scale) < 0.01,
			};
		});
		const expected = { widthExact: true, heightFits: true, heightExtraUnderOneScreenPixel: true, nearScale: true };
		assert.deepStrictEqual(results, [
			{ viewSize: { width: 625, height: 352 }, ...expected },
			{ viewSize: { width: 803, height: 452 }, ...expected },
			{ viewSize: { width: 960, height: 540 }, ...expected },
			{ viewSize: { width: 117, height: 254 }, ...expected },
			{ viewSize: { width: 833, height: 469 }, ...expected },
		]);
	});
});
