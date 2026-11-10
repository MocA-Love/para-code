/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import * as assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { PARADIS_MARKDOWN_WIDTH_STYLES, paradisMarkdownWidthClass, paradisMarkdownWidthMessage, paradisMarkdownWidthScript, paradisResolveMarkdownWidth } from '../../common/paradisMarkdownWidth.js';
import { paradisReadViewerScrollState } from '../../common/paradisViewerScroll.js';

suite('ParadisMarkdownWidth', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	test('the width chosen for the file wins over the setting, which wins over 882', () => {
		assert.deepStrictEqual([
			paradisResolveMarkdownWidth('full', 'wide'),
			// Files without a choice follow the setting, also when it changes while the file is open.
			paradisResolveMarkdownWidth(undefined, 'wide'),
			paradisResolveMarkdownWidth(undefined, 'full'),
			paradisResolveMarkdownWidth(undefined, undefined),
			paradisResolveMarkdownWidth('huge', 'narrow'),
			paradisResolveMarkdownWidth(1280, null),
		], ['full', 'wide', 'full', 'readable', 'readable', 'readable']);
	});

	test('the width is saved and read back with the scroll position, and only when it is valid', () => {
		assert.deepStrictEqual([
			paradisReadViewerScrollState({ scrollProgress: 0.25, markdownWidth: 'wide' }),
			paradisReadViewerScrollState({ scrollProgress: 0.25, markdownWidth: 'huge' }),
			paradisReadViewerScrollState({ scrollProgress: 0.25 }),
			paradisReadViewerScrollState(JSON.parse(JSON.stringify({ scrollProgress: 0, markdownWidth: 'full' }))),
			paradisReadViewerScrollState({ markdownWidth: 'full' }),
		], [
			{ scrollProgress: 0.25, markdownWidth: 'wide' },
			{ scrollProgress: 0.25 },
			{ scrollProgress: 0.25 },
			{ scrollProgress: 0, markdownWidth: 'full' },
			undefined,
		]);
	});

	test('the page CSS overrides the upstream 882px per class, and the message and script use the same names', () => {
		const script = paradisMarkdownWidthScript('abc');
		assert.deepStrictEqual({
			styles: PARADIS_MARKDOWN_WIDTH_STYLES.split('\n'),
			className: paradisMarkdownWidthClass('wide'),
			message: paradisMarkdownWidthMessage('full'),
			nonce: script.startsWith('<script nonce="abc">'),
			classes: script.includes(`'full':'${paradisMarkdownWidthClass('full')}'`),
		}, {
			styles: [
				'html.paradis-md-width-readable body { max-width: 882px; }',
				'html.paradis-md-width-wide body { max-width: 1280px; }',
				'html.paradis-md-width-full body { max-width: none; }',
			],
			className: 'paradis-md-width-wide',
			message: { __paradisMarkdownWidth: 'full' },
			nonce: true,
			classes: true,
		});
	});
});
