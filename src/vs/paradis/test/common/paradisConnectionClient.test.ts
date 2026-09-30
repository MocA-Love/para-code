/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../base/test/common/utils.js';
import { paradisConnectionClientId, paradisIsConnectionClientAllowed } from '../../common/paradisConnectionClient.js';

suite('ParadisConnectionClient', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	// REH の context の clientId は全ウィンドウで同じ 'renderer' なので、context のオブジェクトで見分ける。
	test('tells connections apart by the context object, not its clientId, and lets only the owner touch an owned procedure', () => {
		const windowA = { remoteAuthority: 'ssh-remote+host', clientId: 'renderer' };
		const windowB = { remoteAuthority: 'ssh-remote+host', clientId: 'renderer' };
		const a = paradisConnectionClientId(windowA);
		assert.deepStrictEqual({
			stable: paradisConnectionClientId(windowA) === a,
			distinct: paradisConnectionClientId(windowB) !== a,
			sharedProcess: paradisConnectionClientId('window:1'),
			missing: paradisConnectionClientId(undefined),
			owner: paradisIsConnectionClientAllowed(a, paradisConnectionClientId(windowA)),
			other: paradisIsConnectionClientAllowed(a, paradisConnectionClientId(windowB)),
			unknownCaller: paradisIsConnectionClientAllowed(a, undefined),
			unowned: paradisIsConnectionClientAllowed(undefined, a),
		}, {
			stable: true,
			distinct: true,
			sharedProcess: undefined,
			missing: undefined,
			owner: true,
			other: false,
			unknownCaller: false,
			unowned: true,
		});
	});
});
