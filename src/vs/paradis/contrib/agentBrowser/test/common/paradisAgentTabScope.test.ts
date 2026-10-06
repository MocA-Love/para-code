/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { PARADIS_TAB_ID_PROPERTY_SCHEMA, paradisAgentTabScopeKey, paradisIsValidAgentTabId, paradisPaneTokenOfScopeKey, paradisParseAgentTabScopeKey, paradisScopeKeyBelongsTo, paradisTakeTabIdArgument, paradisWithTabIdArgument } from '../../common/paradisAgentTabScope.js';

suite('Paradis agent tab scope', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	test('a scope key splits back into the pane token and the tab, and a plain token has no tab', () => {
		const key = paradisAgentTabScopeKey('pane-token', 'tab-1');
		assert.deepStrictEqual({
			scoped: paradisParseAgentTabScopeKey(key),
			plain: paradisParseAgentTabScopeKey('pane-token'),
			paneOfScoped: paradisPaneTokenOfScopeKey(key),
			paneOfPlain: paradisPaneTokenOfScopeKey('pane-token'),
			belongs: [paradisScopeKeyBelongsTo(key, 'pane-token'), paradisScopeKeyBelongsTo('pane-token', 'pane-token'), paradisScopeKeyBelongsTo(key, 'pane'), paradisScopeKeyBelongsTo('pane-token-2', 'pane-token')],
		}, {
			scoped: { token: 'pane-token', tabId: 'tab-1' },
			plain: { token: 'pane-token' },
			paneOfScoped: 'pane-token',
			paneOfPlain: 'pane-token',
			belongs: [true, true, false, false],
		});
	});

	test('takes tab_id out of the arguments and refuses values that are not a tab id', () => {
		assert.deepStrictEqual([
			paradisTakeTabIdArgument({ tab_id: 'tab-1', uid: 'e1' }),
			paradisTakeTabIdArgument({ uid: 'e1' }),
			paradisTakeTabIdArgument({ tab_id: '', uid: 'e1' }),
			paradisTakeTabIdArgument({ tab_id: 7 }),
			paradisTakeTabIdArgument({ tab_id: 'a\u0001b' }),
			paradisTakeTabIdArgument({ tab_id: 'x'.repeat(129) }),
			paradisTakeTabIdArgument(undefined),
		], [
			{ tabId: 'tab-1', invalid: false, rest: { uid: 'e1' } },
			{ invalid: false, rest: { uid: 'e1' } },
			{ invalid: false, rest: { uid: 'e1' } },
			{ invalid: true, rest: {} },
			{ invalid: true, rest: {} },
			{ invalid: true, rest: {} },
			{ invalid: false, rest: undefined },
		]);
		assert.deepStrictEqual([paradisIsValidAgentTabId('0b5a9c1e-3d4f-4c0a-9a7e-1f2b3c4d5e6f'), paradisIsValidAgentTabId('')], [true, false]);
	});

	test('adds tab_id to an object input schema once and leaves other schemas alone', () => {
		const tool = { name: 'click', inputSchema: { type: 'object', properties: { uid: { type: 'string' } }, required: ['uid'], additionalProperties: false } };
		const withTab = paradisWithTabIdArgument(tool);
		assert.deepStrictEqual(withTab, {
			name: 'click',
			inputSchema: { type: 'object', properties: { uid: { type: 'string' }, tab_id: PARADIS_TAB_ID_PROPERTY_SCHEMA }, required: ['uid'], additionalProperties: false },
		});
		assert.strictEqual(paradisWithTabIdArgument(withTab), withTab);
		assert.deepStrictEqual(paradisWithTabIdArgument({ name: 'empty', inputSchema: { type: 'object' } }).inputSchema, { type: 'object', properties: { tab_id: PARADIS_TAB_ID_PROPERTY_SCHEMA } });
		const notObject = { name: 'odd', inputSchema: { type: 'string' } };
		assert.strictEqual(paradisWithTabIdArgument(notObject), notObject);
	});
});
