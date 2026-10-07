/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { paradisFillFallbackArgs, paradisFillNeedsInsertTextFallback, paradisMergeFillFallbackResult } from '../../node/paradisBrowserFillFallback.js';

const REGISTER_FAILED = { content: [{ type: 'text', text: 'PARA_BROWSER_RETRYABLE: automation key suppression could not be registered (the page did not answer in time, it may be busy; retry in a moment)' }], isError: true };

suite('ParadisBrowserFillFallback', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	test('falls back only for fill refused because key suppression could not be prepared', () => {
		assert.deepStrictEqual({
			registered: paradisFillNeedsInsertTextFallback('fill', REGISTER_FAILED),
			activated: paradisFillNeedsInsertTextFallback('fill', { content: [{ type: 'text', text: 'PARA_BROWSER_RETRYABLE: automation key suppression could not be activated (retry)' }], isError: true }),
			userFocused: paradisFillNeedsInsertTextFallback('fill', { content: [{ type: 'text', text: 'PARA_BROWSER_RETRYABLE: the bound BrowserView is focused by the user' }], isError: true }),
			success: paradisFillNeedsInsertTextFallback('fill', { content: [{ type: 'text', text: 'automation key suppression could not be registered' }] }),
			typeText: paradisFillNeedsInsertTextFallback('type_text', REGISTER_FAILED),
			pressKey: paradisFillNeedsInsertTextFallback('press_key', REGISTER_FAILED),
		}, { registered: true, activated: true, userFocused: false, success: false, typeText: false, pressKey: false });
	});

	test('passes only the uid and the value on to fill_by', () => {
		assert.deepStrictEqual([
			paradisFillFallbackArgs({ uid: '1_5', value: 'hello', includeSnapshot: true }),
			paradisFillFallbackArgs({ uid: '1_5', value: '' }),
			paradisFillFallbackArgs({ uid: '', value: 'x' }),
			paradisFillFallbackArgs({ value: 'x' }),
			paradisFillFallbackArgs(['1_5', 'x']),
		], [{ uid: '1_5', value: 'hello' }, { uid: '1_5', value: '' }, undefined, undefined, undefined]);
	});

	test('says it switched to the insertText path, and keeps both reasons when that fails too', () => {
		assert.deepStrictEqual({
			filled: paradisMergeFillFallbackResult(REGISTER_FAILED, { content: [{ type: 'text', text: 'Selected the old content and inserted the text as trusted input.\nValue now: "hello"' }] }),
			failed: paradisMergeFillFallbackResult(REGISTER_FAILED, { content: [{ type: 'text', text: 'fill_by: the element is inside an iframe, which this tool does not reach.' }], isError: true }),
		}, {
			filled: {
				content: [
					{ type: 'text', text: 'fill could not prepare its keystrokes on this page (automation key suppression was unavailable), so it entered the text the way fill_by does instead: it selected the old content and inserted the text (date, time, select and password fields follow fill_by\'s rules).' },
					{ type: 'text', text: 'Selected the old content and inserted the text as trusted input.\nValue now: "hello"' },
				],
			},
			failed: {
				content: [{ type: 'text', text: 'PARA_BROWSER_RETRYABLE: automation key suppression could not be registered (the page did not answer in time, it may be busy; retry in a moment)\nfill then tried to enter the text the way fill_by does (select the old content, then insert the text), but that failed too: fill_by: the element is inside an iframe, which this tool does not reach.' }],
				isError: true,
			},
		});
	});
});
