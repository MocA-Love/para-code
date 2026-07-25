// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

/**
 * 保活の ping/pong は、リレー(Durable Object)の `setWebSocketAutoResponse` がバイト列の
 * 完全一致で照合するため、定数と `encodeRelayControl` の出力が1バイトでもズレると pong が
 * 返らなくなる。PC側の複製（src/vs/paradis/.../paradisMobileProtocol.ts）との突き合わせは、
 * CIで確実に走る src/vs 側のテスト（paradisRelayProtocolSync.test.ts）で行う。
 */

import { describe, expect, test } from 'vitest';
import { PARADIS_RELAY_KEEPALIVE_PING, PARADIS_RELAY_KEEPALIVE_PONG, encodeRelayControl } from '../src/relay.js';

describe('relay keepalive', () => {
	test('constants are byte-identical to the encoded control messages', () => {
		expect(encodeRelayControl({ type: 'ping' })).toBe(PARADIS_RELAY_KEEPALIVE_PING);
		expect(encodeRelayControl({ type: 'pong' })).toBe(PARADIS_RELAY_KEEPALIVE_PONG);
	});
});
