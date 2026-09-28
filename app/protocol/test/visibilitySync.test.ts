/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

/**
 * W2-34 の「裏に回った」知らせのコーデックが、app/protocol と PC 側の写し
 * （src/vs/.../common/paradisMobileVisibility.ts）で同じバイト列を作り、互いに読めること。
 */

import { describe, expect, test } from 'vitest';
import { decodeNotifyControl, decodeNotifyVisibility, encodeNotifyVisibility, encodeNotifyVisibilityAck } from '../src/notify.js';
import {
	decodeNotifyVisibility as pcDecode,
	encodeNotifyVisibility as pcEncode,
	encodeNotifyVisibilityAck as pcEncodeAck,
} from '../../../src/vs/paradis/contrib/mobileRelay/common/paradisMobileVisibility.js';

const text = (bytes: Uint8Array) => new TextDecoder().decode(bytes);

describe('notify visibility (W2-34) contract sync', () => {
	test('both sides encode the same bytes and read each other', () => {
		expect([
			text(encodeNotifyVisibility('background', 'v1')) === text(pcEncode('background', 'v1')),
			text(encodeNotifyVisibility('foreground')) === text(pcEncode('foreground')),
			text(encodeNotifyVisibilityAck('background', 'v1')) === text(pcEncodeAck('background', 'v1')),
		]).toEqual([true, true, true]);
		expect([pcDecode(encodeNotifyVisibility('background', 'v1')), decodeNotifyVisibility(pcEncodeAck('background', 'v1'))])
			.toEqual([{ t: 'visibility', state: 'background', id: 'v1' }, { t: 'visibility-ack', state: 'background', id: 'v1' }]);
	});

	test('rejects other notify messages and malformed ids, and old decoders ignore it', () => {
		const bad = [
			new TextEncoder().encode(JSON.stringify({ t: 'visibility', state: 'hidden' })),
			new TextEncoder().encode(JSON.stringify({ t: 'dismiss', id: 'x' })),
			new TextEncoder().encode('not json'),
		];
		expect(bad.map(bytes => [decodeNotifyVisibility(bytes), pcDecode(bytes)])).toEqual([[undefined, undefined], [undefined, undefined], [undefined, undefined]]);
		expect(decodeNotifyVisibility(new TextEncoder().encode(JSON.stringify({ t: 'visibility', state: 'foreground', id: 'x'.repeat(65) })))).toEqual({ t: 'visibility', state: 'foreground' });
		// 旧アプリ・旧PCの制御メッセージの読み手は、この知らせを知らないものとして捨てる。
		expect(decodeNotifyControl(encodeNotifyVisibility('background', 'v1'))).toBeUndefined();
	});
});
