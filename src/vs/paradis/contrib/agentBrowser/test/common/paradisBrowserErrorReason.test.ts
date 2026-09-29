/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { paradisClassifyBrowserToolErrorText } from '../../common/paradisBrowserErrorReason.js';

suite('paradisClassifyBrowserToolErrorText', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	test('folds Para Code gate reasons into fixed codes and keeps only the CDP method name', () => {
		const texts = [
			'Error: Protocol error (Input.dispatchMouseEvent): PARA_BROWSER_RETRYABLE: the bound BrowserView is focused by the user',
			'Protocol error (Input.dispatchMouseEvent): PARA_BROWSER_RETRYABLE: the bound BrowserView became focused before input dispatch',
			'Protocol error (Input.dispatchKeyEvent): PARA_BROWSER_RETRYABLE: exact BrowserView focus authority became unavailable before input dispatch',
			'Protocol error (Input.dispatchMouseEvent): PARA_BROWSER_RETRYABLE: exact BrowserView focus state is unavailable',
			'Protocol error (Input.dispatchKeyEvent): PARA_BROWSER_RETRYABLE: automation key suppression could not be activated',
			'Protocol error (Input.dispatchMouseEvent): PARA_BROWSER_RETRYABLE: prior CDP request did not complete before the input barrier timeout',
			'Protocol error (Input.dispatchMouseEvent): PARA_BROWSER_OUTCOME_UNKNOWN: BrowserView debugger input dispatch did not complete',
			'PARA_BROWSER_RETRYABLE: stale browser binding generation',
			'Protocol error (Emulation.setDeviceMetricsOverride): PARA_BROWSER_RETRYABLE: Emulation.setDeviceMetricsOverride is not an allowed valid focusless BrowserView input command',
			'PARA_BROWSER_RETRYABLE: embedded DevTools bridge terminated; retry',
			'PARA_BROWSER_OUTCOME_UNKNOWN: something new at https://example.com/private',
			'Protocol error (Page.navigate): Cannot navigate to invalid URL https://example.com/private',
			'Element not found for selector #login',
		];
		assert.deepStrictEqual(texts.map(paradisClassifyBrowserToolErrorText), [
			{ safe_error_code: 'user-focus', safe_cdp_method: 'Input.dispatchMouseEvent' },
			{ safe_error_code: 'user-focus', safe_cdp_method: 'Input.dispatchMouseEvent' },
			{ safe_error_code: 'authority-changed', safe_cdp_method: 'Input.dispatchKeyEvent' },
			{ safe_error_code: 'focus-state-unavailable', safe_cdp_method: 'Input.dispatchMouseEvent' },
			{ safe_error_code: 'key-suppression', safe_cdp_method: 'Input.dispatchKeyEvent' },
			{ safe_error_code: 'barrier-timeout', safe_cdp_method: 'Input.dispatchMouseEvent' },
			{ safe_error_code: 'dispatch-incomplete', safe_cdp_method: 'Input.dispatchMouseEvent' },
			{ safe_error_code: 'binding-changed' },
			{ safe_error_code: 'command-rejected', safe_cdp_method: 'Emulation.setDeviceMetricsOverride' },
			{ safe_error_code: 'bridge-unavailable' },
			{ safe_error_code: 'outcome-unknown-other' },
			{ safe_error_code: 'none', safe_cdp_method: 'Page.navigate' },
			{ safe_error_code: 'none' },
		]);
	});
});
