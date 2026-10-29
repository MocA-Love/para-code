/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import * as assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { paradisShareWarningFor } from '../../electron-browser/paradisBrowserExtensionsService.js';

const extension = (name: string, touchesPages: boolean) => ({ id: 'a'.repeat(32), name, touchesPages });

suite('ParadisBrowserExtensionsService share warning', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	test('warns only about extensions that can read and write pages', () => {
		const warning = (extensions: Parameters<typeof paradisShareWarningFor>[0]) => {
			const text = paradisShareWarningFor(extensions);
			// 名前の並びだけを取り出して比べる（文の言い回しは訳で変わるため）
			return text === undefined ? undefined : /（(?<names>.*?)）/.exec(text)?.groups?.names;
		};
		assert.deepStrictEqual([
			warning([]),
			warning([extension('Theme', false)]),
			warning([extension('Theme', false), extension('Bitwarden', true)]),
			warning([extension('A', true), extension('B', true), extension('C', true), extension('D', true), extension('E', true)]),
		], [undefined, undefined, 'Bitwarden', 'A、B、C ほか 2 個']);
	});
});
