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

	test('folds Para Code gate reasons into fixed codes, keeps retryable apart from outcome-unknown, and keeps only CDP method names of known domains', () => {
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
			'Protocol error (SecretWord.leakMe): something the page wrote',
		];
		assert.deepStrictEqual(texts.map(paradisClassifyBrowserToolErrorText), [
			{ safe_gate_reason: 'user-focus', safe_error_status: 'retryable', safe_cdp_method: 'Input.dispatchMouseEvent' },
			{ safe_gate_reason: 'user-focus', safe_error_status: 'retryable', safe_cdp_method: 'Input.dispatchMouseEvent' },
			{ safe_gate_reason: 'authority-changed', safe_error_status: 'retryable', safe_cdp_method: 'Input.dispatchKeyEvent' },
			{ safe_gate_reason: 'focus-state-unavailable', safe_error_status: 'retryable', safe_cdp_method: 'Input.dispatchMouseEvent' },
			{ safe_gate_reason: 'key-suppression', safe_error_status: 'retryable', safe_cdp_method: 'Input.dispatchKeyEvent' },
			{ safe_gate_reason: 'barrier-timeout', safe_error_status: 'retryable', safe_cdp_method: 'Input.dispatchMouseEvent' },
			{ safe_gate_reason: 'dispatch-incomplete', safe_error_status: 'outcome-unknown', safe_cdp_method: 'Input.dispatchMouseEvent' },
			{ safe_gate_reason: 'binding-changed', safe_error_status: 'retryable' },
			{ safe_gate_reason: 'command-rejected', safe_error_status: 'retryable', safe_cdp_method: 'Emulation.setDeviceMetricsOverride' },
			{ safe_gate_reason: 'bridge-unavailable', safe_error_status: 'retryable' },
			{ safe_gate_reason: 'outcome-unknown-other', safe_error_status: 'outcome-unknown' },
			{ safe_gate_reason: 'none', safe_cdp_method: 'Page.navigate' },
			{ safe_gate_reason: 'none' },
			{ safe_gate_reason: 'none' },
		]);
	});
});
