/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese test names)

import * as assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { ParadisMobileStateDelivery } from '../../node/paradisMobileStateDelivery.js';

suite('ParadisMobileStateDelivery', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	test('初回を配送し完全一致する通常配送だけを抑制する', async () => {
		const delivery = new ParadisMobileStateDelivery();
		const sent: number[][] = [];
		const send = async (payload: Uint8Array) => { sent.push([...payload]); };

		assert.strictEqual(await delivery.deliver(Uint8Array.of(1, 2, 3), false, send), true);
		assert.strictEqual(await delivery.deliver(Uint8Array.of(1, 2, 3), false, send), false);
		assert.deepStrictEqual(sent, [[1, 2, 3]]);
	});

	test('長さまたは1バイトが異なるpayloadを配送する', async () => {
		const delivery = new ParadisMobileStateDelivery();
		const sent: number[][] = [];
		const send = async (payload: Uint8Array) => { sent.push([...payload]); };

		await delivery.deliver(Uint8Array.of(1, 2, 3), false, send);
		assert.strictEqual(await delivery.deliver(Uint8Array.of(1, 2, 4), false, send), true);
		assert.strictEqual(await delivery.deliver(Uint8Array.of(1, 2, 4, 0), false, send), true);
		assert.deepStrictEqual(sent, [[1, 2, 3], [1, 2, 4], [1, 2, 4, 0]]);
	});

	test('完全一致でも強制配送し直近の成功payloadとして記録する', async () => {
		const delivery = new ParadisMobileStateDelivery();
		let sends = 0;
		const send = async () => { sends++; };
		const payload = Uint8Array.of(7, 8, 9);

		await delivery.deliver(payload, false, send);
		assert.strictEqual(await delivery.deliver(payload, true, send), true);
		assert.strictEqual(await delivery.deliver(payload, false, send), false);
		assert.strictEqual(sends, 2);
	});

	test('送信失敗を記録せず次回に再試行する', async () => {
		const delivery = new ParadisMobileStateDelivery();
		const payload = Uint8Array.of(4, 5, 6);
		let attempts = 0;

		await assert.rejects(() => delivery.deliver(payload, false, async () => {
			attempts++;
			throw new Error('send failed');
		}), /send failed/);
		assert.strictEqual(await delivery.deliver(payload, false, async () => { attempts++; }), true);
		assert.strictEqual(attempts, 2);
	});

	test('配送成功payloadをコピーして保持する', async () => {
		const delivery = new ParadisMobileStateDelivery();
		const payload = Uint8Array.of(1, 2, 3);
		let sends = 0;

		await delivery.deliver(payload, false, async () => { sends++; });
		payload[0] = 9;
		assert.strictEqual(await delivery.deliver(Uint8Array.of(1, 2, 3), false, async () => { sends++; }), false);
		assert.strictEqual(sends, 1);
	});

	test('reset後は同じpayloadも配送する', async () => {
		const delivery = new ParadisMobileStateDelivery();
		const payload = Uint8Array.of(1);
		let sends = 0;

		await delivery.deliver(payload, false, async () => { sends++; });
		delivery.reset();
		assert.strictEqual(await delivery.deliver(payload, false, async () => { sends++; }), true);
		assert.strictEqual(sends, 2);
	});

	test('reset前に開始した送信の完了で新セッションのキャッシュを復活させない', async () => {
		const delivery = new ParadisMobileStateDelivery();
		const payload = Uint8Array.of(1, 2, 3);
		let release!: () => void;
		const pending = delivery.deliver(payload, false, () => new Promise<void>(resolve => { release = resolve; }));

		await Promise.resolve();
		delivery.reset();
		release();
		await pending;

		assert.strictEqual(await delivery.deliver(payload, false, async () => { }), true);
	});
});
