/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import * as assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { paradisSentryFingerprint, type IParadisSentryEvent } from '../../common/paradisSentryCommon.js';
import { paradisPrepareSentryEvent } from '../../common/paradisSentryEvent.js';

suite('ParadisSentryEvent', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	/**
	 * fork 所有のスタックを持つイベント（分類が 'owned' になる最小形）。
	 *
	 * limiter はモジュールスコープの共有インスタンスなので、テストごとに fingerprint を
	 * 散らしておかないと（para.operation は fingerprint の構成要素）10分3件の上限に当たり、
	 * テストを足した順に落ちるようになる。
	 */
	function ownedEvent(operation: string, tags: Record<string, unknown> = {}): IParadisSentryEvent {
		return {
			tags: { 'para.operation': operation, ...tags },
			user: { id: 'device-1' },
			request: { url: 'wss://relay.example/?token=secret' },
			server_name: 'somebodys-macbook-pro.local',
			exception: {
				values: [{
					stacktrace: { frames: [{ filename: '/Users/alice/app/out/vs/paradis/contrib/mobileRelay/node/x.js' }] },
				}],
			},
		};
	}

	// 各プロセスは init 直後に para.scope / process.type をグローバルスコープへ設定しており、
	// スコープのタグは beforeSend の前にイベントへマージされる。これを「処理済み」の判定に
	// 使うと全イベントが素通りし、上流エラーの除外・PII除去・レートリミットが丸ごと無効になる。
	test('still sanitizes events that already carry the globally-set scope tags', () => {
		const prepared = paradisPrepareSentryEvent(ownedEvent('globally-tagged', { 'para.scope': 'unknown', 'process.type': 'main' }), 'main');
		assert.deepStrictEqual({
			classified: prepared?.tags?.['para.scope'],
			processType: prepared?.tags?.['process.type'],
			user: prepared?.user,
			serverName: prepared?.server_name,
		}, { classified: 'owned', processType: 'main', user: undefined, serverName: undefined });
	});

	// renderer/utility の envelope は main 側で captureEvent され直すため beforeSend が二度走る。
	// 二度目は発生元の process.type を保ち、レートリミットも二重に消費しない。
	test('keeps the originating process type when the main process re-processes a forwarded event', () => {
		const first = paradisPrepareSentryEvent(ownedEvent('forwarded'), 'utility');
		const second = paradisPrepareSentryEvent(first!, 'main');
		assert.deepStrictEqual({
			processType: second?.tags?.['process.type'],
			scope: second?.tags?.['para.scope'],
		}, { processType: 'utility', scope: 'owned' });
	});

	// 転送元のサニタイズでは落とせない値（送信直前に Node クライアントが入れる hostname）は、
	// 二度目の処理でも必ず落とす。
	test('drops the host identity the node client adds after the originating sanitize', () => {
		const forwarded = { ...ownedEvent('host-identity', { 'para.prepared': '1' }), server_name: 'somebodys-macbook-pro.local' };
		const prepared = paradisPrepareSentryEvent(forwarded, 'main');
		assert.deepStrictEqual({
			serverName: prepared?.server_name,
			user: prepared?.user,
			request: prepared?.request,
		}, { serverName: undefined, user: undefined, request: undefined });
	});

	// fingerprint を実際にセットしないと、Sentry 側は自前のスタックトレースだけを見た
	// デフォルトグルーピングに戻ってしまい、para.operation で分けたつもりの issue が
	// 同じ行から throw した別の失敗と一緒くたに束ねられる。
	test('assigns a Sentry fingerprint derived from scope/feature/operation, not just the stacktrace', () => {
		const preparedA = paradisPrepareSentryEvent(ownedEvent('fingerprint-check-a', { 'para.feature': 'process-lifecycle' }), 'main');
		const preparedB = paradisPrepareSentryEvent(ownedEvent('fingerprint-check-b', { 'para.feature': 'process-lifecycle' }), 'main');

		// Both events throw from the exact same stack frame (ownedEvent's fixed frame), so a Sentry
		// default grouping (which only looks at exception type + stacktrace) would merge them.
		assert.deepStrictEqual(preparedA?.fingerprint, [paradisSentryFingerprint(preparedA!)]);
		assert.notDeepStrictEqual(preparedA?.fingerprint, preparedB?.fingerprint);
	});

	test('drops events that are not attributable to fork-owned code', () => {
		assert.strictEqual(paradisPrepareSentryEvent({ tags: {}, message: 'upstream failure' }, 'renderer'), null);
	});

	// ウィンドウを畳むと進行中の要求が全て cancellation sentinel で reject され、
	// onunhandledrejection に落ちる。壊れていないので送らない。
	test('drops cancellation, including one already prepared by another process', () => {
		const canceled: IParadisSentryEvent = {
			tags: { 'para.scope': 'unknown' },
			exception: {
				values: [{ type: 'Canceled', value: 'Canceled', mechanism: { type: 'auto.node.onunhandledrejection', handled: false } }],
			},
		};
		assert.strictEqual(paradisPrepareSentryEvent(canceled, 'renderer'), null);
		assert.strictEqual(paradisPrepareSentryEvent({ ...canceled, tags: { ...canceled.tags, 'para.prepared': '1' } }, 'main'), null);
	});

	test('drops automatically captured CancellationError events', () => {
		assert.strictEqual(paradisPrepareSentryEvent({
			tags: { 'para.scope': 'owned', 'para.operation': 'automatic-cancellation-error' },
			exception: {
				values: [{ type: 'CancellationError', value: 'Canceled', mechanism: { type: 'auto.node.onunhandledrejection', handled: false } }],
			},
		}, 'utility'), null);
	});

	// 実地では30件中3件の cancellation が、無関係な withScope から漏れた 'owned' / 'file-viewers'
	// を身にまとって届いていた。scope タグで判定していると、この3件だけ落とせない。
	test('drops an automatic cancellation even when scope tags leaked onto it', () => {
		assert.strictEqual(paradisPrepareSentryEvent({
			tags: { 'para.scope': 'owned', 'para.feature': 'file-viewers', 'para.operation': 'webview-fatal-error' },
			exception: {
				values: [{ type: 'Canceled', value: 'Canceled', mechanism: { type: 'auto.node.onunhandledrejection', handled: false } }],
			},
		}, 'main'), null);
	});

	// 自分から報告したものは落とさない。cancellation を意図して報告することは無いが、
	// 「明示report は必ず届く」という不変条件をここで固定しておく。
	test('keeps a cancellation that fork-owned code reported on purpose', () => {
		const reported = paradisPrepareSentryEvent({
			tags: { 'para.scope': 'owned', 'para.operation': 'deliberate-cancel' },
			exception: {
				values: [{ type: 'Canceled', value: 'Canceled', mechanism: { type: 'generic', handled: true } }],
			},
		}, 'main');
		assert.strictEqual(reported?.tags?.['para.scope'], 'owned');
	});

	test('drops a foreign native crash before preparing it for Sentry', () => {
		assert.strictEqual(paradisPrepareSentryEvent({
			platform: 'native',
			tags: { 'para.operation': 'foreign-native-crash' },
			exception: {
				values: [{
					stacktrace: {
						frames: [{ package: '/opt/homebrew/Cellar/ffmpeg/7.1/bin/ffplay' }],
					},
				}],
			},
		}, 'main'), null);
	});
});
