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

	test('配送成功payloadの参照を保持する(呼び出し元から所有権を受け取る)', async () => {
		const delivery = new ParadisMobileStateDelivery();
		let sends = 0;
		const send = async () => { sends++; };

		await delivery.deliver(Uint8Array.of(1, 2, 3), false, send);
		// payloadの参照をそのまま保持するため、呼び出し側は配送後に書き換えてはいけない。
		// 同一内容の別インスタンスとの比較は内容等価で行われ、再送は省略される
		assert.strictEqual(await delivery.deliver(new Uint8Array([1, 2, 3]), false, send), false);
		assert.strictEqual(await delivery.deliver(Uint8Array.of(1, 2, 4), false, send), true);
		assert.strictEqual(sends, 2);
	});

	test('送信中に来た State は次の 1 件として最新値で置き換え、要求への返事は置き換えても消さない（4 章 #15）', async () => {
		const delivery = new ParadisMobileStateDelivery();
		const sent: number[] = [];
		const releases: (() => void)[] = [];
		const send = (payload: Uint8Array) => new Promise<void>(resolve => { sent.push(payload[0]); releases.push(resolve); });

		const first = delivery.deliver(Uint8Array.of(1), false, send);
		const forced = delivery.deliver(Uint8Array.of(2), true, send);
		const replaced = delivery.deliver(Uint8Array.of(3), false, send);
		const newest = delivery.deliver(Uint8Array.of(4), false, send);
		const whileFirstInFlight = [...sent];
		releases.shift()!();
		await first;
		for (let i = 0; i < 10 && releases.length === 0; i++) {
			await Promise.resolve();
		}
		releases.shift()!();

		assert.deepStrictEqual({ whileFirstInFlight, sent, results: await Promise.all([first, forced, replaced, newest]) }, {
			whileFirstInFlight: [1],
			sent: [1, 4],
			results: [true, true, true, true],
		});
	});

	test('アプリが同じ版を持っていれば、要求への返事は全量の代わりに unchanged を送る（4 章 #14）', async () => {
		const delivery = new ParadisMobileStateDelivery();
		const sent: string[] = [];
		const send = async (payload: Uint8Array) => { sent.push(new TextDecoder().decode(payload)); };
		const unchanged = { identity: 'e\n5', reply: new TextEncoder().encode('unchanged') };

		await delivery.deliver(new TextEncoder().encode('state-5'), false, send, { identity: 'e\n5' });
		await delivery.deliver(new TextEncoder().encode('state-5'), true, send, { identity: 'e\n5', unchanged });
		// 手元の版が古い・内容が変わったなら全量を送る
		await delivery.deliver(new TextEncoder().encode('state-6'), true, send, { identity: 'e\n6', unchanged });
		// 手元の版を添えない要求には全量を送る
		await delivery.deliver(new TextEncoder().encode('state-6'), true, send, { identity: 'e\n6' });

		assert.deepStrictEqual(sent, ['state-5', 'unchanged', 'state-6', 'state-6']);
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
