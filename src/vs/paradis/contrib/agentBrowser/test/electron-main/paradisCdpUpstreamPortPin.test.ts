/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { ParadisCdpUpstreamPortPin, readBoundedText } from '../../electron-main/paradisCdpUpstreamPortPin.js';

suite('ParadisCdpUpstreamPortPin', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	test('pins the port whose targets belong to this process', async () => {
		const pin = new ParadisCdpUpstreamPortPin({
			userDataPath: '/tmp/profile',
			readPortFile: async () => 41_001,
			fetchTargetIds: async () => ['own-window'],
			ownsTargetId: targetId => targetId === 'own-window',
			delay: async () => undefined,
		});

		assert.strictEqual(await pin.pin(), 41_001);
		assert.strictEqual(pin.pinnedPort, 41_001);
	});

	// これが本題。もう1つの Para Code は同じ Chromium 版を積んでいるのでバージョン一致では
	// 見分けられない。`webContents.fromDevToolsTargetId` は自プロセスの WebContents しか
	// 返さないので、他インスタンスのエンドポイントはここで落ちる。
	test('refuses an endpoint that belongs to another instance and never pins it', async () => {
		let reads = 0;
		const pin = new ParadisCdpUpstreamPortPin({
			userDataPath: '/tmp/profile',
			readPortFile: async () => { reads++; return 41_999; },
			fetchTargetIds: async () => ['someone-elses-window'],
			ownsTargetId: targetId => targetId === 'own-window',
			timeoutMs: 0,
			delay: async () => undefined,
		});

		assert.strictEqual(await pin.pin(), undefined);
		assert.strictEqual(pin.pinnedPort, undefined);
		assert.strictEqual(reads, 1);
	});

	// 応答が空＝相手が誰か確かめられていない。ワークベンチウィンドウは必ず1つあるので、
	// 空を「たぶん自分」と扱うと他人のブラウザに貼り付く経路が復活する。
	test('refuses an endpoint that lists no targets at all', async () => {
		const pin = new ParadisCdpUpstreamPortPin({
			userDataPath: '/tmp/profile',
			readPortFile: async () => 41_001,
			fetchTargetIds: async () => [],
			ownsTargetId: () => true,
			timeoutMs: 0,
			delay: async () => undefined,
		});

		assert.strictEqual(await pin.pin(), undefined);
	});

	// 起動直後はファイルがまだ書かれていない。書かれるまで待てること。
	test('waits for the port file to appear before giving up', async () => {
		let attempt = 0;
		const pin = new ParadisCdpUpstreamPortPin({
			userDataPath: '/tmp/profile',
			readPortFile: async () => (++attempt < 3 ? undefined : 41_001),
			fetchTargetIds: async () => ['own-window'],
			ownsTargetId: () => true,
			retryIntervalMs: 0,
			delay: async () => undefined,
		});

		assert.strictEqual(await pin.pin(), 41_001);
		assert.strictEqual(attempt, 3);
	});

	// 確定後は二度と読み直さない。読み直せば「上書きされたファイルを掴む」危険が戻るだけで、
	// アプリが生きている間ポートは変わらないので得るものが無い。
	test('reads nothing more once the port is pinned', async () => {
		let reads = 0;
		const pin = new ParadisCdpUpstreamPortPin({
			userDataPath: '/tmp/profile',
			readPortFile: async () => { reads++; return 41_001; },
			fetchTargetIds: async () => ['own-window'],
			ownsTargetId: () => true,
			delay: async () => undefined,
		});

		assert.deepStrictEqual([await pin.pin(), await pin.pin(), await pin.pin()], [41_001, 41_001, 41_001]);
		assert.strictEqual(reads, 1);
	});

	// 起動時の先行確定と shared process からの問い合わせは重なる。二重に走らせない。
	test('shares one in-flight attempt between concurrent callers', async () => {
		let reads = 0;
		let release: (() => void) | undefined;
		const gate = new Promise<void>(resolve => { release = resolve; });
		const pin = new ParadisCdpUpstreamPortPin({
			userDataPath: '/tmp/profile',
			readPortFile: async () => { reads++; await gate; return 41_001; },
			fetchTargetIds: async () => ['own-window'],
			ownsTargetId: () => true,
			delay: async () => undefined,
		});

		const both = Promise.all([pin.pin(), pin.pin()]);
		release?.();
		assert.deepStrictEqual(await both, [41_001, 41_001]);
		assert.strictEqual(reads, 1);
	});

	// 失敗を覚え込むと、あとから上流が立ち上がっても永久に諦めたままになる。
	test('retries after a failed attempt instead of caching the failure', async () => {
		let healthy = false;
		const pin = new ParadisCdpUpstreamPortPin({
			userDataPath: '/tmp/profile',
			readPortFile: async () => (healthy ? 41_001 : undefined),
			fetchTargetIds: async () => ['own-window'],
			ownsTargetId: () => true,
			timeoutMs: 0,
			delay: async () => undefined,
		});

		assert.strictEqual(await pin.pin(), undefined);
		healthy = true;
		assert.strictEqual(await pin.pin(), 41_001);
	});

	// 呼び出し側（shared process）はブラウザ操作の途中にいるので、確定を待ち切らせない。
	// 待たせると、上流が使えない構成でブラウザ操作のたびに固まって見える。
	test('gives up waiting after the bound but keeps pinning in the background', async () => {
		let release: (() => void) | undefined;
		const gate = new Promise<void>(resolve => { release = resolve; });
		const pin = new ParadisCdpUpstreamPortPin({
			userDataPath: '/tmp/profile',
			readPortFile: async () => { await gate; return 41_001; },
			fetchTargetIds: async () => ['own-window'],
			ownsTargetId: () => true,
			delay: async () => undefined,
		});

		assert.strictEqual(await pin.resolveWithin(1), undefined);
		release?.();
		// 諦めたのは待つのをやめただけで、確定処理は生きている。
		assert.strictEqual(await pin.pin(), 41_001);
		assert.strictEqual(await pin.resolveWithin(0), 41_001);
	});

	// 上流が本当に使えない構成（--remote-debugging-pipe 等）では確定は永久に成功しない。
	// 聞かれるたびにリトライループを回すと、main が延々とファイルを読み続けることになる。
	test('waits out the cooldown before starting another attempt after a failure', async () => {
		let reads = 0;
		let clock = 1_000;
		const pin = new ParadisCdpUpstreamPortPin({
			userDataPath: '/tmp/profile',
			readPortFile: async () => { reads++; return undefined; },
			fetchTargetIds: async () => ['own-window'],
			ownsTargetId: () => true,
			timeoutMs: 0,
			retryCooldownMs: 30_000,
			delay: async () => undefined,
			now: () => clock,
		});

		assert.strictEqual(await pin.pin(), undefined);
		assert.strictEqual(reads, 1);
		clock += 29_000;
		assert.strictEqual(await pin.pin(), undefined);
		assert.strictEqual(reads, 1, 'still inside the cooldown');
		clock += 2_000;
		assert.strictEqual(await pin.pin(), undefined);
		assert.strictEqual(reads, 2, 'tries again once the cooldown has passed');
	});

	// 確定できたあとは間隔を空けない（成功は覚えたままで、待たせる理由が無い）。
	test('answers instantly once pinned, regardless of the cooldown', async () => {
		const clock = 1_000;
		const pin = new ParadisCdpUpstreamPortPin({
			userDataPath: '/tmp/profile',
			readPortFile: async () => 41_001,
			fetchTargetIds: async () => ['own-window'],
			ownsTargetId: () => true,
			delay: async () => undefined,
			now: () => clock,
		});

		assert.strictEqual(await pin.pin(), 41_001);
		assert.strictEqual(await pin.resolveWithin(0), 41_001);
	});

	// 上限はもう防御であって最適化ではない。相手はポート番号を再利用した無関係なサーバかも
	// しれず、ここは main プロセスなので、読み切ってから測ると積み上がったヒープでウィンドウ
	// ごと固まる。**読みながら**切っていることを固定する（この既定実装はピン本体のテストが
	// `fetchTargetIds` を注入するせいで一度も通らないため、ここで直接触る）。
	test('stops reading a /json/list body that keeps growing past the limit', async () => {
		let produced = 0;
		let cancelled = false;
		const chunk = new Uint8Array(64 * 1024);
		const response = {
			body: {
				getReader: () => ({
					read: async () => { produced += chunk.byteLength; return { done: false, value: chunk }; },
					cancel: async () => { cancelled = true; },
					releaseLock: () => undefined,
				}),
			},
		} as unknown as Response;

		await assert.rejects(readBoundedText(response), /exceeds the byte limit/);
		assert.ok(cancelled, 'cancels the stream instead of draining it');
		// 上限（256KiB）を少し超えたところで止まっている＝読み切っていない。
		assert.ok(produced <= 512 * 1024, `read ${produced} bytes before stopping`);
	});

	test('reads a small body through to the end', async () => {
		const bytes = new TextEncoder().encode('[{"id":"a","type":"page"}]');
		let sent = false;
		const response = {
			body: {
				getReader: () => ({
					read: async () => (sent ? { done: true, value: undefined } : (sent = true, { done: false, value: bytes })),
					cancel: async () => undefined,
					releaseLock: () => undefined,
				}),
			},
		} as unknown as Response;

		assert.strictEqual(await readBoundedText(response), '[{"id":"a","type":"page"}]');
	});
});
