/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import assert from 'assert';
import { promises as fs } from 'fs';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { NullLogService } from '../../../../../platform/log/common/log.js';
import { ParadisCdpUpstream } from '../../node/paradisCdpUpstream.js';

suite('ParadisCdpUpstream', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	test('falls back to the port file when the port it was using stops answering', async () => {
		// アプリを再起動するとポートが変わる。ファイルには新しい値が入るので、そちらへ移れること。
		let filePort = '41001\n';
		let livePort = 41_001;
		const urls: string[] = [];
		const upstream = new ParadisCdpUpstream('/tmp/profile', new NullLogService(), {
			openFile: openPortFile(() => filePort),
			fetch: async (url: string) => {
				urls.push(url);
				if (!url.includes(`:${livePort}/`)) {
					throw new Error('ECONNREFUSED');
				}
				return jsonResponse({ Browser: 'ok' });
			},
			fetchTimeoutMs: 5_000,
		});

		assert.deepStrictEqual(await upstream.fetchJson('/json/version'), { Browser: 'ok' });
		filePort = '41002\n';
		livePort = 41_002;
		assert.deepStrictEqual(await upstream.fetchJsonWithPort('/json/version'), { value: { Browser: 'ok' }, port: 41_002 });
		assert.deepStrictEqual(urls, [
			'http://127.0.0.1:41001/json/version',
			'http://127.0.0.1:41001/json/version',
			'http://127.0.0.1:41002/json/version',
		]);
	});

	test('recovers when a second app instance overwrites the port file with a dead port', async () => {
		// 2つ目の Para Code が起動すると、シングルインスタンスロックで終了する前に
		// DevToolsActivePort を自分のポートで上書きしてしまう。ファイルを何度読み直しても
		// 死んだポートしか出てこないので、実際に応答が返った実績のあるポートへ戻れることを見る。
		//
		// 「直近で使えたポート」が生きているとそこで当たってしまい、実績ポートへの復帰が検査
		// されない。そこで一度だけ接続を失敗させて直近ぶんを捨てさせ、その状態でファイルが
		// 嘘になっている、という並びにする。
		let filePort = '41001\n';
		let live = true;
		const upstream = new ParadisCdpUpstream('/tmp/profile', new NullLogService(), {
			openFile: openPortFile(() => filePort),
			fetch: async (url: string) => {
				if (!url.includes(':41001/') || !live) {
					throw new Error('ECONNREFUSED');
				}
				return jsonResponse({ Browser: 'ok' });
			},
			fetchTimeoutMs: 5_000,
		});

		assert.deepStrictEqual(await upstream.fetchJson('/json/version'), { Browser: 'ok' });

		// 一瞬だけ落ちる（＝直近で使えたポートが捨てられる）。同時にファイルが死にポートへ。
		live = false;
		filePort = '62544\n';
		await assert.rejects(() => upstream.fetchJson('/json/list'), /Upstream CDP fetch failed on every known port \(41001, 62544\)/);

		// 応答を確かめない用途（モバイルのブラウザミラーが WebSocket を直接張る）にも同じ順序が要る。
		// ここでファイルの死にポートを返すと、そちらは 5 秒待たされてタイムアウトするだけになる。
		assert.strictEqual(await upstream.resolvePort(0), 41_001);

		live = true;
		assert.deepStrictEqual(await upstream.fetchJsonWithPort('/json/list'), { value: { Browser: 'ok' }, port: 41_001 });
		// 応答を確かめない用途（WebSocket を直接張る側）にも、生きているポートを返し続ける。
		assert.strictEqual(await upstream.resolvePort(0), 41_001);
	});

	test('refuses to pin a port that answers as a different browser', async () => {
		// ファイルが嘘のとき、そのポートを無関係なローカル Chromium が握っていることがある。
		// 応答が返ったというだけで固定すると、他人のブラウザへ繋ぎっぱなしになる。
		const upstream = new ParadisCdpUpstream('/tmp/profile', new NullLogService(), {
			openFile: openPortFile(() => '62544\n'),
			fetch: async () => jsonResponse({ Browser: 'Chrome/1.0.0.0' }),
			fetchTimeoutMs: 5_000,
			chromeVersion: '148.0.7778.280',
		});

		// 弾いた理由は cause に畳んで投げる（ゲートウェイ側がログに1段展開する）。
		await assert.rejects(
			() => upstream.fetchJson('/json/version'),
			(error: Error) => /every known port \(62544\)/.test(error.message) && /another browser/.test(String((error.cause as Error)?.message)),
		);
		// 固定されていないので、次に聞かれてもファイルの値を読み直すだけ。
		assert.strictEqual(await upstream.resolvePort(0), 62_544);
	});

	test('refuses to pin a foreign browser reached through a path that cannot identify it', async () => {
		// 実際の初回呼び出しは `/json/list`（ゲートウェイもモバイルのミラーもこちら）。その応答からは
		// 相手が誰か分からないので、身元を確かめずに固定すると他人のブラウザのターゲット一覧を返した
		// うえ、そのポートに貼り付いてしまう。
		const paths: string[] = [];
		const upstream = new ParadisCdpUpstream('/tmp/profile', new NullLogService(), {
			openFile: openPortFile(() => '62544\n'),
			fetch: async (url: string) => {
				paths.push(new URL(url).pathname);
				return url.endsWith('/json/version')
					? jsonResponse({ Browser: 'Chrome/1.0.0.0' })
					: jsonResponse([{ id: 'foreign-target', type: 'page' }]);
			},
			fetchTimeoutMs: 5_000,
			chromeVersion: '148.0.7778.280',
		});

		await assert.rejects(
			() => upstream.fetchJson('/json/list'),
			(error: Error) => /another browser/.test(String((error.cause as Error)?.message)),
		);
		assert.deepStrictEqual(paths, ['/json/list', '/json/version']);
		// 実績として残っていない＝次も身元から確かめ直す。
		assert.strictEqual(await upstream.resolvePort(0), 62_544);
	});

	test('refuses a browser that only shares our Chromium major version', async () => {
		// もう1つの Para Code や、同じ Chromium を積んだ別の Electron アプリはメジャーが一致する。
		// メジャーだけで見分けると、まさに今回の障害の相手（2つ目の Para Code）を素通りさせてしまう。
		const upstream = new ParadisCdpUpstream('/tmp/profile', new NullLogService(), {
			openFile: openPortFile(() => '62544\n'),
			fetch: async () => jsonResponse({ Browser: 'Chrome/148.0.1234.5' }),
			fetchTimeoutMs: 5_000,
			chromeVersion: '148.0.7778.280',
		});

		await assert.rejects(
			() => upstream.fetchJson('/json/version'),
			(error: Error) => /another browser/.test(String((error.cause as Error)?.message)),
		);
	});

	test('gives up a remembered port once it answers as a different browser', async () => {
		// アプリが落ちたあとに別プロセスが同じポートを掴む、という並び。実績として覚えたままだと
		// 他人のブラウザへ恒久的に貼り付く（今回直した障害と同じ「ずっと壊れたまま」の形）。
		let ours = true;
		const upstream = new ParadisCdpUpstream('/tmp/profile', new NullLogService(), {
			openFile: openPortFile(() => '41001\n'),
			fetch: async () => jsonResponse({ Browser: ours ? 'Chrome/148.0.7778.280' : 'Chrome/1.0.0.0' }),
			fetchTimeoutMs: 5_000,
			chromeVersion: '148.0.7778.280',
		});

		assert.strictEqual((await upstream.fetchJsonWithPort('/json/version')).port, 41_001);
		ours = false;
		await assert.rejects(() => upstream.fetchJson('/json/version'), /every known port \(41001\)/);
		// 実績が取り消されているので、次はファイルから読み直す（＝居座らない）。
		assert.strictEqual(await upstream.resolvePort(0), 41_001);
		assert.strictEqual((upstream as unknown as { _lastKnownGoodPort: number | undefined })._lastKnownGoodPort, undefined);
	});

	test('accepts the browser it is actually running against', async () => {
		const upstream = new ParadisCdpUpstream('/tmp/profile', new NullLogService(), {
			openFile: openPortFile(() => '62544\n'),
			fetch: async () => jsonResponse({ Browser: 'Chrome/148.0.7778.280' }),
			fetchTimeoutMs: 5_000,
			chromeVersion: '148.0.7778.280',
		});

		assert.deepStrictEqual(await upstream.fetchJsonWithPort('/json/version'), {
			value: { Browser: 'Chrome/148.0.7778.280' },
			port: 62_544,
		});
	});

	test('stops after trying every known port instead of looping', async () => {
		let attempts = 0;
		const upstream = new ParadisCdpUpstream('/tmp/profile', new NullLogService(), {
			openFile: openPortFile(() => '41001\n'),
			fetch: async () => {
				attempts++;
				throw new Error('offline');
			},
			fetchTimeoutMs: 5_000,
		});

		await assert.rejects(() => upstream.fetchJson('/json/list'), /Upstream CDP fetch failed on every known port/);
		assert.strictEqual(attempts, 1);
	});

	test('rejects oversized and malformed upstream JSON without using Response.json', async () => {
		for (const bytes of [
			new Uint8Array(8 * 1024 * 1024 + 1),
			new TextEncoder().encode('{"unterminated":'),
		]) {
			let attempts = 0;
			const upstream = new ParadisCdpUpstream('/tmp/profile', new NullLogService(), {
				openFile: openPortFile(() => '41001\n'),
				fetch: async () => {
					attempts++;
					return { ok: true, status: 200, arrayBuffer: async () => bytes.buffer };
				},
			});
			await assert.rejects(() => upstream.fetchJson('/json/list'), /Upstream CDP fetch failed on every known port/);
			// 検証済みのポートがまだ無いので候補はファイルの1つだけ。壊れた応答で固定もされない。
			assert.strictEqual(attempts, 1);
		}
	});

	test('accepts only a small strict decimal DevToolsActivePort', async () => {
		for (const invalid of ['41001junk\n', ' 41001\n', '65536\n', `${'1'.repeat(129)}\n`]) {
			let fetchCalls = 0;
			const upstream = new ParadisCdpUpstream('/tmp/profile', new NullLogService(), {
				openFile: openPortFile(() => invalid),
				fetch: async () => { fetchCalls++; return jsonResponse({}); },
			});
			assert.strictEqual(await upstream.resolvePort(0), undefined);
			assert.strictEqual(fetchCalls, 0);
		}
	});

	test('never asks an injected port-file handle to read more than the strict prefix bound', async () => {
		let maximumReadLength = 0;
		const upstream = new ParadisCdpUpstream('/tmp/profile', new NullLogService(), {
			openFile: openPortFile(() => `41001\n${'private'.repeat(10_000)}`, length => {
				maximumReadLength = Math.max(maximumReadLength, length);
			}),
		});
		assert.strictEqual(await upstream.resolvePort(0), undefined);
		assert.ok(maximumReadLength <= 129);
	});
});

function jsonResponse(value: unknown): Pick<Response, 'ok' | 'status' | 'arrayBuffer'> {
	const bytes = new TextEncoder().encode(JSON.stringify(value));
	return { ok: true, status: 200, arrayBuffer: async () => bytes.buffer };
}

function openPortFile(contents: () => string, onRead?: (length: number) => void): typeof fs.open {
	return (async () => {
		const source = Buffer.from(contents(), 'utf8');
		return {
			read: async (buffer: Buffer, offset: number, length: number, position: number) => {
				onRead?.(length);
				const bytesRead = Math.min(length, Math.max(0, source.byteLength - position));
				source.copy(buffer, offset, position, position + bytesRead);
				return { bytesRead, buffer };
			},
			close: async () => undefined,
		};
	}) as unknown as typeof fs.open;
}
