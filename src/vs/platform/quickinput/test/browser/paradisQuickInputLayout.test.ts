/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../base/test/common/utils.js';
import { IQuickInput } from '../../common/quickInput.js';
import { paradisComputeQuickInputLayout, paradisCurrentQuickInputLayout, paradisQuickInputWidth, paradisQuickPickItemHeight, paradisRegisterQuickInputLayout, paradisResetQuickInputLayout, paradisSetQuickInputPreviewEnabled } from '../../browser/paradisQuickInputLayout.js';

suite('paradisQuickInputLayout', () => {
	const store = ensureNoDisposablesAreLeakedInTestSuite();

	// 登録は store の dispose で外れる。プレビューの on/off と覚えている器の幅は、ほかのテスト（本家の quick input）に
	// 残さないよう毎回戻す
	teardown(() => paradisResetQuickInputLayout());

	const upstream = (windowWidth: number) => Math.min(windowWidth * 0.62, 600);

	test('the widget widens by window width tiers only for a previewing input with the preview on', () => {
		const preview = { preview: true, inlineDetail: true };
		const widths = [3840, 2560, 2400, 2399, 1600, 1440, 1100, 1099, 1000, 390];
		assert.deepStrictEqual({
			on: widths.map(width => { const layout = paradisComputeQuickInputLayout(width, upstream(width), preview, true); return [layout.width, layout.previewWidth, layout.listWidth, layout.inlineDetail]; }),
			off: paradisComputeQuickInputLayout(2560, upstream(2560), preview, false),
			other: paradisComputeQuickInputLayout(2560, upstream(2560), undefined, true),
		}, {
			on: [
				[1200, 420, 779, true],
				[1200, 420, 779, true],
				[1200, 420, 779, true],
				[1040, 360, 679, true],
				[1040, 360, 679, true],
				[880, 300, 579, true],
				[880, 300, 579, true],
				[600, 0, 600, true],
				[600, 0, 600, true],
				[241.8, 0, 241.8, false],
			],
			off: { width: 600, previewWidth: 0, listWidth: 600, inlineDetail: true },
			other: { width: 600, previewWidth: 0, listWidth: 600, inlineDetail: false },
		});
	});

	test('registered inputs, anchored inputs and the row height follow the last layout', () => {
		store.add(paradisRegisterQuickInputLayout('paradisTestCommands', { preview: true, inlineDetail: true }));
		const centered = { contextKey: 'paradisTestCommands', anchor: undefined, ignoreFocusOut: false } as unknown as IQuickInput;
		const anchored = { contextKey: 'paradisTestCommands', anchor: {}, ignoreFocusOut: false } as unknown as IQuickInput;
		paradisSetQuickInputPreviewEnabled(false);
		const off = paradisQuickInputWidth(2560, upstream(2560), centered);
		paradisSetQuickInputPreviewEnabled(true);
		const wide = paradisQuickInputWidth(2560, upstream(2560), centered);
		const wideRow = paradisQuickPickItemHeight('Developer: Reload Window');
		const anchoredWidth = paradisQuickInputWidth(2560, upstream(2560), anchored);
		const narrow = paradisQuickInputWidth(390, upstream(390), centered);
		const narrowRow = paradisQuickPickItemHeight('Developer: Reload Window');
		const noDetail = paradisQuickPickItemHeight(undefined);
		assert.deepStrictEqual({ off, wide, wideRow, anchoredWidth, narrow, narrowRow, noDetail }, { off: 600, wide: 1200, wideRow: 28, anchoredWidth: 600, narrow: 241.8, narrowRow: 44, noDetail: 28 });
	});

	test('reset returns to the initial state (the preview on, nothing remembered)', () => {
		paradisSetQuickInputPreviewEnabled(false);
		paradisQuickInputWidth(2560, upstream(2560), undefined);
		paradisResetQuickInputLayout();
		assert.deepStrictEqual({ layout: paradisCurrentQuickInputLayout(), row: paradisQuickPickItemHeight('detail') }, { layout: { width: 0, previewWidth: 0, listWidth: 0, inlineDetail: false }, row: 44 });
	});
});
