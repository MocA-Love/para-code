/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import * as assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { ParadisAgentTabLedger, paradisIsAllowedAgentTabUrl, paradisSanitizeAgentPageRequestReason } from '../../common/paradisAgentBrowserTabs.js';

suite('ParadisAgentBrowserTabs', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	test('only http(s) and about:blank can be opened by an agent', () => {
		assert.deepStrictEqual(
			['https://example.com', 'http://localhost:3000/a', 'about:blank', 'javascript:alert(1)', 'file:///etc/passwd', 'data:text/html,x', 'vscode-file://x', 'not a url', 'about:config'].map(paradisIsAllowedAgentTabUrl),
			[true, true, true, false, false, false, false, false, false],
		);
	});

	test('sanitizes the reason shown in the approval dialog', () => {
		assert.deepStrictEqual([
			paradisSanitizeAgentPageRequestReason(undefined),
			paradisSanitizeAgentPageRequestReason('  \n\t '),
			paradisSanitizeAgentPageRequestReason('log in\nto the‮ dashboard'),
			paradisSanitizeAgentPageRequestReason('x'.repeat(400))?.length,
		], [undefined, undefined, 'log in to the dashboard', 301]);
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
		assert.deepStrictEqual([ledger.openedCount('a'), ledger.tryReserveSlot('a'), ledger.isOpenedBy('a', 'view-1'), ledger.isOpenedBy('b', 'view-1')], [2, false, true, false]);
		ledger.forget('view-1');
		assert.deepStrictEqual([ledger.openedCount('a'), ledger.agentTabsOf('a')], [1, ['view-2']]);
	});

	test('remembers user pages shared with a pane while the agent moves between its tabs', () => {
		const ledger = new ParadisAgentTabLedger();
		ledger.registerAgentTab('pane', 'agent-tab');

		// The user shares their page.
		ledger.observeBindings([{ token: 'pane', pageId: 'user-page' }]);
		// The agent opens its own tab and moves the share there; the user page stays approved.
		ledger.beginSwitch('pane', 'agent-tab');
		ledger.endSwitch('pane', 'agent-tab', true);
		ledger.observeBindings([{ token: 'pane', pageId: 'agent-tab' }]);
		assert.deepStrictEqual(ledger.approvedOf('pane'), ['user-page']);

		// The agent moves back, then the user stops sharing: the approval is withdrawn.
		ledger.beginSwitch('pane', 'user-page');
		ledger.observeBindings([{ token: 'pane', pageId: 'user-page' }]);
		ledger.endSwitch('pane', 'user-page', true);
		ledger.observeBindings([]);
		assert.deepStrictEqual([ledger.approvedOf('pane'), ledger.isApproved('pane', 'user-page')], [[], false]);
	});

	test('a failed switch does not protect the previous page from a later unshare', () => {
		const ledger = new ParadisAgentTabLedger();
		ledger.observeBindings([{ token: 'pane', pageId: 'user-page' }]);
		ledger.beginSwitch('pane', 'other');
		ledger.endSwitch('pane', 'other', false);
		ledger.observeBindings([{ token: 'pane', pageId: 'another-user-page' }]);
		assert.deepStrictEqual(ledger.approvedOf('pane'), ['another-user-page']);
	});
});
