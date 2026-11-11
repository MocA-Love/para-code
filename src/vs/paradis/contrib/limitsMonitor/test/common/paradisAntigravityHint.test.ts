/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { paradisAntigravityHintAfter, paradisParseAntigravityHints } from '../../common/paradisAntigravityHint.js';

suite('Paradis Antigravity fetch hints', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	test('remembers a read, forgets it on a sign-out together with the sign-out stamp, and keeps it otherwise', () => {
		const ok = { accounts: [{ provider: 'antigravity', id: '/home/example/.gemini', status: 'ok' }] } as const;
		const previousValue = { accounts: [{ provider: 'antigravity', id: '/home/example/.gemini', status: 'unavailable', unavailableReason: 'not_fetched' }] } as const;
		assert.deepStrictEqual({
			read: paradisAntigravityHintAfter({ signedOutStamp: 'a' }, { antigravity: ok }),
			signedOut: paradisAntigravityHintAfter({ seen: true }, { antigravitySignedOut: { stamp: 'b' } }),
			failedForNow: paradisAntigravityHintAfter({ seen: true }, { antigravity: previousValue }),
			notInstalledOrSkipped: paradisAntigravityHintAfter(undefined, {}),
		}, {
			read: { seen: true },
			signedOut: { signedOutStamp: 'b' },
			failedForNow: { seen: true },
			notInstalledOrSkipped: undefined,
		});
	});

	test('reads the stored hints per host and ignores broken values', () => {
		assert.deepStrictEqual({
			stored: [...paradisParseAntigravityHints(JSON.stringify({ local: { seen: true }, 'ssh-remote+host': { signedOutStamp: 'a' }, empty: {}, bad: 'x' }))],
			broken: [...paradisParseAntigravityHints('{')],
			none: [...paradisParseAntigravityHints(undefined)],
		}, {
			stored: [['local', { seen: true }], ['ssh-remote+host', { signedOutStamp: 'a' }]],
			broken: [],
			none: [],
		});
	});
});
