/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese test comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { paradisConfirmedAgentPaneTokens, paradisParseCodexSessionMeta } from '../../node/paradisMobileAgentChat.js';

suite('ParadisMobileAgentChat', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	test('publishes only live panes with a confirmed agent session', () => {
		assert.deepStrictEqual(
			paradisConfirmedAgentPaneTokens(['pane-b', 'closed-pane', 'pane-a'], ['pane-a', 'plain-pane', 'pane-b']),
			['pane-a', 'pane-b'],
		);
	});

	test('uses globally unique pane tokens instead of window-local terminal IDs', () => {
		assert.deepStrictEqual(
			paradisConfirmedAgentPaneTokens(['window-2-pane-1'], ['window-1-pane-1', 'window-2-pane-1']),
			['window-2-pane-1'],
		);
	});

	test('keeps the Codex thread ID discovered from rollout session metadata', () => {
		assert.deepStrictEqual(paradisParseCodexSessionMeta(JSON.stringify({
			type: 'session_meta',
			payload: { cwd: '/workspace', id: 'thread-1' },
		})), { cwd: '/workspace', sessionId: 'thread-1' });
	});

	test('rejects non-session metadata', () => {
		assert.strictEqual(paradisParseCodexSessionMeta('{"type":"event_msg","payload":{}}'), undefined);
	});
});
