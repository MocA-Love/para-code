/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import * as assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { ParadisAgentTabLedger, paradisIsAllowedAgentTabUrl, paradisSanitizeAgentPageRequestReason, paradisSanitizeDisplayText, paradisUrlOrigin } from '../../common/paradisAgentBrowserTabs.js';

suite('ParadisAgentBrowserTabs', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	test('only http(s) and about:blank can be opened by an agent', () => {
		assert.deepStrictEqual(
			['https://example.com', 'http://localhost:3000/a', 'about:blank', 'javascript:alert(1)', 'file:///etc/passwd', 'data:text/html,x', 'vscode-file://x', 'not a url', 'about:config'].map(paradisIsAllowedAgentTabUrl),
			[true, true, true, false, false, false, false, false, false],
		);
	});

	test('removes control, zero-width and bidi characters from text shown in dialogs and lists', () => {
		assert.deepStrictEqual([
			paradisSanitizeAgentPageRequestReason(undefined),
			paradisSanitizeAgentPageRequestReason('  \n \t '),
			paradisSanitizeAgentPageRequestReason('log in\nto the\u202e dashboard'),
			paradisSanitizeAgentPageRequestReason('x'.repeat(400))?.length,
			paradisSanitizeDisplayText('invoice\u202efdp.exe', 100),
			paradisSanitizeDisplayText('a\u200bb\u2066c\ufeffd', 100),
			paradisSanitizeDisplayText('abcdef', 3),
		], [undefined, undefined, 'log in to the dashboard', 301, 'invoice fdp.exe', 'a b c d', 'abc\u2026']);
	});

	test('reduces an unshared tab URL to its origin', () => {
		assert.deepStrictEqual(
			[paradisUrlOrigin('https://mail.example.com/inbox?id=42#x'), paradisUrlOrigin('about:blank'), paradisUrlOrigin(undefined), paradisUrlOrigin('garbage')],
			['https://mail.example.com', '', '', ''],
		);
	});

	test('enforces the per-pane limit including tabs still being opened', () => {
		const ledger = new ParadisAgentTabLedger(2);
		assert.strictEqual(ledger.tryReserveSlot('a'), true);
		assert.strictEqual(ledger.tryReserveSlot('a'), true);
		assert.strictEqual(ledger.tryReserveSlot('a'), false, 'two opens in flight already use the whole limit');
		assert.strictEqual(ledger.tryReserveSlot('b'), true, 'the limit is per pane');
		ledger.registerAgentTab('a', 'view-1');
		ledger.releaseSlot('a');
		ledger.releaseSlot('a');
		assert.strictEqual(ledger.tryReserveSlot('a'), true);
		ledger.registerAgentTab('a', 'view-2');
		ledger.releaseSlot('a');
		assert.deepStrictEqual([ledger.openedCount('a'), ledger.tryReserveSlot('a'), ledger.isOpenedBy('a', 'view-1'), ledger.isOpenedBy('b', 'view-1'), ledger.isAgentTab('view-1')], [2, false, true, false, true]);
		ledger.forget('view-1');
		assert.deepStrictEqual([ledger.openedCount('a'), ledger.agentTabsOf('a'), ledger.isAgentTab('view-1')], [1, ['view-2'], false]);
	});
});
