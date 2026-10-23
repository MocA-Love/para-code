/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese test comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { pairingKeyFingerprint } from '../../common/paradisMobileCrypto.js';

suite('pairingKeyFingerprint', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	// リレー（app/relay/test/relay.test.ts の同じ値）と同じ作り方でなければ、承認しても資格情報が渡らない
	test('is the lowercase hex SHA-256 of the raw public key, the same value the relay derives', async () => {
		assert.strictEqual(await pairingKeyFingerprint(new Uint8Array(32)), '66687aadf862bd776c8fc18b8e9f8e20089714856ee233b3902a591d0d5f2925');
	});
});
