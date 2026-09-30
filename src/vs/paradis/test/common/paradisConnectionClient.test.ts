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

	test('takes the client id only from a REH context, and lets only the owner touch an owned procedure', () => {
		assert.deepStrictEqual({
			reh: paradisConnectionClientId({ remoteAuthority: 'ssh-remote+host', clientId: 'a' }),
			sharedProcess: paradisConnectionClientId('window:1'),
			empty: paradisConnectionClientId({ clientId: '' }),
			missing: paradisConnectionClientId(undefined),
			owner: paradisIsConnectionClientAllowed('a', 'a'),
			other: paradisIsConnectionClientAllowed('a', 'b'),
			unknownCaller: paradisIsConnectionClientAllowed('a', undefined),
			unowned: paradisIsConnectionClientAllowed(undefined, 'b'),
		}, {
			reh: 'a',
			sharedProcess: undefined,
			empty: undefined,
			missing: undefined,
			owner: true,
			other: false,
			unknownCaller: false,
			unowned: true,
		});
	});
});
