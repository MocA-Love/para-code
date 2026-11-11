/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import assert from 'assert';
import { URI } from '../../../../../base/common/uri.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { paradisIsPalettePreviewMarkdown, paradisLooksBinary, PARADIS_PALETTE_PREVIEW_BINARY_SNIFF_BYTES, PARADIS_PALETTE_PREVIEW_MAX_LINES, paradisPalettePreviewHead, paradisPalettePreviewState } from '../../browser/paradisPalettePreview.js';

suite('paradisPalettePreview', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	test('a long file shows only its head; markdown is drawn, other files are colored', () => {
		const long = Array.from({ length: PARADIS_PALETTE_PREVIEW_MAX_LINES + 5 }, (_, index) => `line ${index}`).join('\n');
		const head = paradisPalettePreviewHead(long);
		assert.deepStrictEqual({
			short: paradisPalettePreviewHead('a\nb'),
			longLines: head.text.split('\n').length,
			longTruncated: head.truncated,
			markdown: [
				paradisIsPalettePreviewMarkdown(URI.file('/r/README.md'), null),
				paradisIsPalettePreviewMarkdown(URI.file('/r/notes.txt'), 'markdown'),
				paradisIsPalettePreviewMarkdown(URI.file('/r/a.ts'), 'typescript'),
			],
		}, {
			short: { text: 'a\nb', truncated: false },
			longLines: PARADIS_PALETTE_PREVIEW_MAX_LINES,
			longTruncated: true,
			markdown: [true, true, false],
		});
	});

	test('a NUL in the first bytes means binary (not shown as text)', () => {
		const text = new TextEncoder().encode('const x = 1;\n');
		const late = new Uint8Array(PARADIS_PALETTE_PREVIEW_BINARY_SNIFF_BYTES + 10).fill(65);
		late[PARADIS_PALETTE_PREVIEW_BINARY_SNIFF_BYTES + 5] = 0;
		assert.deepStrictEqual([
			paradisLooksBinary(text),
			paradisLooksBinary(new Uint8Array([0x50, 0x4b, 0x03, 0x04, 0x14, 0x00])),
			paradisLooksBinary(late),
			paradisLooksBinary(new Uint8Array()),
		], [false, true, false, false]);
	});

	test('the preview toggle shows on/off only where the window can hold the preview', () => {
		assert.deepStrictEqual([
			paradisPalettePreviewState(2560, true),
			paradisPalettePreviewState(1440, false),
			paradisPalettePreviewState(1000, true),
		], [true, false, undefined]);
	});
});
