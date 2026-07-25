/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import {
	PARADIS_RELAY_KEEPALIVE_PING,
	PARADIS_RELAY_KEEPALIVE_PONG,
	decodeRelayControl,
	encodeRelayControl,
} from '../../common/paradisMobileProtocol.js';

suite('ParadisRelayKeepalive', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	// リレー側は setWebSocketAutoResponse でバイト列の完全一致を見るため、1バイトでもズレると
	// pongが返らず、保活が「毎回タイムアウトして自分から切断する」タイマーに化ける。
	test('the ping constant is byte-identical to the encoded control message', () => {
		assert.strictEqual(encodeRelayControl({ type: 'ping' }), PARADIS_RELAY_KEEPALIVE_PING);
		assert.strictEqual(encodeRelayControl({ type: 'pong' }), PARADIS_RELAY_KEEPALIVE_PONG);
	});

	test('the auto-responded pong decodes as a normal control message', () => {
		assert.deepStrictEqual(decodeRelayControl(PARADIS_RELAY_KEEPALIVE_PONG), { type: 'pong' });
	});
});
