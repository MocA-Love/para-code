/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { paradisParseTerminalActiveGroups, paradisSerializeTerminalActiveGroups, paradisTerminalGroupIdentity, paradisUpdateTerminalActiveGroup } from '../../common/paradisTerminalActiveGroup.js';

suite('paradisTerminalActiveGroup', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	test('keeps a group identity stable when pane order changes', () => {
		assert.strictEqual(
			paradisTerminalGroupIdentity([{ shellIntegrationNonce: 'b' }, { shellIntegrationNonce: 'a' }]),
			paradisTerminalGroupIdentity([{ shellIntegrationNonce: 'a' }, { shellIntegrationNonce: 'b' }]),
		);
	});

	test('round-trips active groups by space', () => {
		const groups = new Map([['space:a', '["nonce-a"]'], ['space:b', '["nonce-b"]']]);
		assert.deepStrictEqual([...paradisParseTerminalActiveGroups(paradisSerializeTerminalActiveGroups(groups))], [...groups]);
	});

	test('merges one scope into the latest shared snapshot', () => {
		const firstWindow = paradisSerializeTerminalActiveGroups(new Map([['space:a', '["nonce-a"]']]));
		const secondWindow = paradisUpdateTerminalActiveGroup(firstWindow, 'space:b', '["nonce-b"]');
		assert.deepStrictEqual([...paradisParseTerminalActiveGroups(secondWindow)], [
			['space:a', '["nonce-a"]'],
			['space:b', '["nonce-b"]'],
		]);
	});

	test('retires only the requested scope from the latest shared snapshot', () => {
		const shared = paradisSerializeTerminalActiveGroups(new Map([
			['space:a', '["nonce-a"]'],
			['space:b', '["nonce-b"]'],
		]));
		assert.deepStrictEqual(
			[...paradisParseTerminalActiveGroups(paradisUpdateTerminalActiveGroup(shared, 'space:a', undefined))],
			[['space:b', '["nonce-b"]']],
		);
	});
});
