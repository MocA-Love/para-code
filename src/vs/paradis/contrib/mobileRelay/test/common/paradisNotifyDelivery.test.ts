/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { IParadisNotifyDeliveryInput, PARADIS_NOTIFY_TRUST_WINDOW_MS, ParadisMissedNotifyQueue, paradisResolveNotifyDelivery } from '../../common/paradisNotifyDelivery.js';

suite('paradisResolveNotifyDelivery', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	/** 既定は「前面のアプリが自分でバナーを出せる」状態。各テストで崩す条件だけ上書きする。 */
	function input(overrides: Partial<IParadisNotifyDeliveryInput> = {}): IParadisNotifyDeliveryInput {
		return {
			kind: 'agent-question',
			prefs: { agentDone: true, agentQuestion: true, pcFocusQuiet: false },
			pcFocused: false,
			sessionReady: true,
			msSinceLastInbound: 1_000,
			...overrides,
		};
	}

	test('前面のアプリにはフレームだけ送り、プッシュは送らない', () => {
		assert.deepStrictEqual(paradisResolveNotifyDelivery(input()), { frame: true, quiet: false, push: false });
	});

	// これが今回直した本体。ソケットは残っているのにアプリが凍っている状態
	// （iOSがバックグラウンドでhalf-openのまま放置する）で、以前はプッシュを送らず通知が消えていた。
	test('ソケットが残っていても無音が続いたらプッシュを送る', () => {
		assert.deepStrictEqual(
			paradisResolveNotifyDelivery(input({ msSinceLastInbound: PARADIS_NOTIFY_TRUST_WINDOW_MS + 1 })),
			// フレームも送る（届けばそのまま通知一覧に入る）。プッシュを送るので鳴らすのは1回だけ。
			{ frame: true, quiet: true, push: true },
		);
	});

	test('境界ちょうどはまだ信用する', () => {
		assert.strictEqual(paradisResolveNotifyDelivery(input({ msSinceLastInbound: PARADIS_NOTIFY_TRUST_WINDOW_MS })).push, false);
	});

	test('受信実績が無いセッションは信用しない', () => {
		assert.strictEqual(paradisResolveNotifyDelivery(input({ msSinceLastInbound: undefined })).push, true);
	});

	test('アプリ未起動（セッション無し）はプッシュだけ', () => {
		assert.deepStrictEqual(
			paradisResolveNotifyDelivery(input({ sessionReady: false, msSinceLastInbound: undefined })),
			{ frame: false, quiet: true, push: true },
		);
	});

	// 抑制は「配送しない」ではなく「鳴らさない」。以前は配信自体を止めていたため、
	// PCの前にいた間に何があったかをあとからスマホで追えなかった。
	test('種別オフでもフレームは送る（通知一覧には残す）', () => {
		assert.deepStrictEqual(
			paradisResolveNotifyDelivery(input({ kind: 'agent-done', prefs: { agentDone: false, agentQuestion: true, pcFocusQuiet: false } })),
			{ frame: true, quiet: true, push: false },
		);
	});

	test('種別オフならアプリ未起動でもプッシュしない', () => {
		assert.strictEqual(
			paradisResolveNotifyDelivery(input({
				kind: 'agent-done',
				prefs: { agentDone: false, agentQuestion: true, pcFocusQuiet: false },
				sessionReady: false,
				msSinceLastInbound: undefined,
			})).push,
			false,
		);
	});

	test('PC操作中は鳴らさないが、通知一覧には残す', () => {
		assert.deepStrictEqual(
			paradisResolveNotifyDelivery(input({ pcFocused: true, prefs: { pcFocusQuiet: true } })),
			{ frame: true, quiet: true, push: false },
		);
	});

	// 設定を同期してきていないモバイル（初回接続直後・旧アプリ）にも同じ既定を当てる。
	test('設定が未同期ならPC操作中の抑制は既定でオン', () => {
		assert.strictEqual(paradisResolveNotifyDelivery(input({ pcFocused: true, prefs: undefined })).push, false);
		assert.strictEqual(paradisResolveNotifyDelivery(input({ pcFocused: true, prefs: {} })).push, false);
	});

	// `pcFocusQuiet` を知らない旧アプリは旧キーで送ってくる。読み取りだけそちらへ落とす
	// （書き戻すと、PCを旧版へ巻き戻したとき「配信そのものを止める」の解釈が復活する）。
	test('旧アプリが送る旧キーも読む', () => {
		assert.strictEqual(paradisResolveNotifyDelivery(input({ pcFocused: true, prefs: { suppressWhenPcFocused: false } })).quiet, undefined);
		assert.strictEqual(paradisResolveNotifyDelivery(input({ pcFocused: true, prefs: { suppressWhenPcFocused: true } })).quiet, 'muted');
		// 両方あれば新しいキーが勝つ。
		assert.strictEqual(paradisResolveNotifyDelivery(input({ pcFocused: true, prefs: { pcFocusQuiet: false, suppressWhenPcFocused: true } })).quiet, undefined);
	});

	test('明示的にオフにしたモバイルはPC操作中でも鳴らす', () => {
		assert.strictEqual(
			paradisResolveNotifyDelivery(input({ pcFocused: true, prefs: { pcFocusQuiet: false }, sessionReady: false, msSinceLastInbound: undefined })).push,
			true,
		);
	});

	// 席を外している前提そのものが崩れる知らせなので、PCフォーカスでは抑制しない。
	test('エラー・切断はPC操作中でも抑制しない', () => {
		for (const kind of ['agent-error', 'disconnected'] as const) {
			assert.strictEqual(paradisResolveNotifyDelivery(input({ kind, pcFocused: true, prefs: { pcFocusQuiet: true } })).quiet, false);
		}
	});

	test('種別が読めなければ鳴らす側に倒す', () => {
		assert.strictEqual(paradisResolveNotifyDelivery(input({ kind: undefined, pcFocused: true, prefs: { pcFocusQuiet: true } })).quiet, false);
	});
});

suite('ParadisMissedNotifyQueue', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	const bytes = (marker: string) => new TextEncoder().encode(marker);
	const ids = (entries: readonly { readonly id: string | undefined }[]) => entries.map(entry => entry.id);

	test('積んだ順に流し、流したら空になる', () => {
		const queue = new ParadisMissedNotifyQueue();
		queue.add('m1', { id: 'a', agentToken: 't1', bytes: bytes('a') });
		queue.add('m1', { id: 'b', agentToken: 't1', bytes: bytes('b') });
		assert.deepStrictEqual(ids(queue.take('m1')), ['a', 'b']);
		assert.deepStrictEqual(queue.take('m1'), []);
	});

	test('モバイルごとに独立している', () => {
		const queue = new ParadisMissedNotifyQueue();
		queue.add('m1', { id: 'a', agentToken: undefined, bytes: bytes('a') });
		queue.add('m2', { id: 'b', agentToken: undefined, bytes: bytes('b') });
		assert.deepStrictEqual(ids(queue.take('m1')), ['a']);
		assert.deepStrictEqual(ids(queue.take('m2')), ['b']);
	});

	test('上限を超えたら古い順に捨てる', () => {
		const queue = new ParadisMissedNotifyQueue(2);
		for (const id of ['a', 'b', 'c']) {
			queue.add('m1', { id, agentToken: undefined, bytes: bytes(id) });
		}
		assert.deepStrictEqual(ids(queue.take('m1')), ['b', 'c']);
	});

	// これが無いと、PCで確認した通知があとでスマホを開いたときに未読として蘇る。
	test('既読になったIDは流さない', () => {
		const queue = new ParadisMissedNotifyQueue();
		queue.add('m1', { id: 'a', agentToken: undefined, bytes: bytes('a') });
		queue.add('m1', { id: 'b', agentToken: undefined, bytes: bytes('b') });
		queue.drop({ id: 'a' });
		assert.deepStrictEqual(ids(queue.take('m1')), ['b']);
	});

	// PC側でペインを確認済みにしたときは通知のIDを持っていないので、agentTokenでまとめて消す。
	test('agentToken指定は同じエージェントの分をまとめて消す（全モバイル分）', () => {
		const queue = new ParadisMissedNotifyQueue();
		queue.add('m1', { id: 'a', agentToken: 't1', bytes: bytes('a') });
		queue.add('m1', { id: 'b', agentToken: 't2', bytes: bytes('b') });
		queue.add('m2', { id: 'c', agentToken: 't1', bytes: bytes('c') });
		queue.drop({ agentToken: 't1' });
		assert.deepStrictEqual(ids(queue.take('m1')), ['b']);
		assert.deepStrictEqual(queue.take('m2'), []);
	});

	// idもagentTokenも持たない項目まで巻き添えで消さないこと。
	test('空の条件では何も消さない', () => {
		const queue = new ParadisMissedNotifyQueue();
		queue.add('m1', { id: undefined, agentToken: undefined, bytes: bytes('a') });
		queue.drop({});
		queue.drop({ id: undefined, agentToken: undefined });
		assert.strictEqual(queue.take('m1').length, 1);
	});

	test('ペアリング解除したモバイルの分は捨てる', () => {
		const queue = new ParadisMissedNotifyQueue();
		queue.add('m1', { id: 'a', agentToken: undefined, bytes: bytes('a') });
		queue.forget('m1');
		assert.deepStrictEqual(queue.take('m1'), []);
	});
});
