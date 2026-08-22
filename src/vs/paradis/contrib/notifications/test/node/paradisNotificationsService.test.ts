/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { existsSync, mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import * as sinon from 'sinon';
import { timeout } from '../../../../../base/common/async.js';
import { join } from '../../../../../base/common/path.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { NullLogService } from '../../../../../platform/log/common/log.js';
import { PARADIS_MAX_FETCHED_AUDIO_SIZE_BYTES } from '../../common/paradisNotifications.js';
import { AivisError, AivisErrorKind } from '../../node/paradisAudioScheduler.js';
import { ParadisNotificationsService } from '../../node/paradisNotificationsService.js';

suite('ParadisNotificationsService boundaries', () => {
	const store = ensureNoDisposablesAreLeakedInTestSuite();

	// The production service has no fetch injection seam. VS Code unit suites run serially, and
	// teardown restores every process-global fetch stub before the next test can observe it.
	teardown(() => sinon.restore());

	function createService(): ParadisNotificationsService {
		return store.add(new ParadisNotificationsService(new NullLogService()));
	}

	test('rejects non-HTTPS audio URLs before issuing a request', async () => {
		const fetchStub = sinon.stub(globalThis, 'fetch').resolves(new Response(Uint8Array.of(1)));
		const service = createService();

		assert.strictEqual(await service.fetchAudio('http://example.test/sample.mp3'), null);
		assert.strictEqual(await service.fetchAudio('not a URL'), null);
		assert.strictEqual(fetchStub.called, false);
	});

	test('returns null for unsuccessful HTTP audio responses', async () => {
		sinon.stub(globalThis, 'fetch').resolves(new Response('not found', { status: 404 }));
		const service = createService();

		assert.strictEqual(await service.fetchAudio('https://example.test/missing.mp3'), null);
	});

	test('rejects an audio response whose declared size exceeds the boundary', async () => {
		sinon.stub(globalThis, 'fetch').resolves(new Response(Uint8Array.of(1), {
			headers: {
				'content-length': String(PARADIS_MAX_FETCHED_AUDIO_SIZE_BYTES + 1),
				'content-type': 'audio/mpeg',
			},
		}));
		const service = createService();

		assert.strictEqual(await service.fetchAudio('https://example.test/oversized.mp3'), null);
	});

	test('rejects an oversized audio body when content-length is absent', async () => {
		sinon.stub(globalThis, 'fetch').resolves(new Response(
			new Uint8Array(PARADIS_MAX_FETCHED_AUDIO_SIZE_BYTES + 1),
			{ headers: { 'content-type': 'audio/mpeg' } },
		));
		const service = createService();

		assert.strictEqual(await service.fetchAudio('https://example.test/undeclared-size.mp3'), null);
	});

	test('accepts the declared size boundary and preserves an audio MIME type', async () => {
		const bytes = new Uint8Array(PARADIS_MAX_FETCHED_AUDIO_SIZE_BYTES);
		bytes[0] = 1;
		bytes[bytes.length - 1] = 3;
		sinon.stub(globalThis, 'fetch').resolves(new Response(bytes, {
			headers: {
				'content-length': String(PARADIS_MAX_FETCHED_AUDIO_SIZE_BYTES),
				'content-type': 'audio/ogg; codecs=opus',
			},
		}));
		const service = createService();

		const result = await service.fetchAudio('https://example.test/sample.ogg');
		assert.ok(result);
		assert.strictEqual(result.mimeType, 'audio/ogg');
		const decoded = Buffer.from(result.base64, 'base64');
		assert.strictEqual(decoded.byteLength, PARADIS_MAX_FETCHED_AUDIO_SIZE_BYTES);
		assert.strictEqual(decoded[0], 1);
		assert.strictEqual(decoded[decoded.length - 1], 3);
	});

	test('derives an audio MIME type from the URL when the server type is not audio', async () => {
		sinon.stub(globalThis, 'fetch').resolves(new Response(Uint8Array.of(4, 5), {
			headers: { 'content-type': 'application/octet-stream' },
		}));
		const service = createService();

		assert.deepStrictEqual(await service.fetchAudio('https://example.test/sample.wav'), {
			base64: 'BAU=',
			mimeType: 'audio/wav',
		});
	});

	test('classifies Aivis synthesis HTTP status at the public playback boundary', async () => {
		const cases: ReadonlyArray<{
			readonly status: number;
			readonly kind: AivisErrorKind;
			readonly reset?: number;
		}> = [
				{ status: 401, kind: 'fatal' },
				{ status: 422, kind: 'item-specific' },
				{ status: 429, kind: 'retryable', reset: 7 },
				{ status: 503, kind: 'retryable' },
				{ status: 418, kind: 'item-specific' },
			];
		const service = createService();
		let response = new Response(null);
		sinon.stub(globalThis, 'fetch').callsFake(async () => response);

		for (const testCase of cases) {
			response = new Response('status body', {
				status: testCase.status,
				headers: testCase.reset === undefined ? undefined : {
					'X-Aivis-RateLimit-Requests-Reset': String(testCase.reset),
				},
			});

			await assert.rejects(
				service.playAivis({
					apiKey: 'api-key',
					modelUuid: 'model-uuid',
					text: 'hello',
				}),
				error => {
					assert.ok(error instanceof AivisError);
					assert.strictEqual(error.status, testCase.status);
					assert.strictEqual(error.kind, testCase.kind);
					assert.strictEqual(error.rateLimitReset, testCase.reset);
					return true;
				},
			);
		}
	});

	suite('orphan temp work dir sweep', () => {

		/** rm() は fire-and-forget なので、消えるまで(または諦めるまで)短い間隔で見に行く。 */
		async function waitUntilGone(path: string): Promise<void> {
			const deadline = Date.now() + 2_000;
			while (existsSync(path)) {
				if (Date.now() > deadline) {
					assert.fail(`expected ${path} to be swept away`);
				}
				await timeout(20);
			}
		}

		function makeDir(name: string, ageMs: number): string {
			const dir = join(tmpdir(), name);
			mkdirSync(dir, { recursive: true });
			const mtime = new Date(Date.now() - ageMs);
			utimesSync(dir, mtime, mtime);
			return dir;
		}

		test('sweeps orphaned yt-dlp/ffmpeg work dirs older than the minimum age', async () => {
			const old = mkdtempSync(join(tmpdir(), 'paradis-ytfull-'));
			utimesSync(old, new Date(Date.now() - 31 * 60 * 1000), new Date(Date.now() - 31 * 60 * 1000));

			createService();

			await waitUntilGone(old);
		});

		test('sweeps orphaned ytclip work dirs too, as insurance against hard crashes', async () => {
			const old = mkdtempSync(join(tmpdir(), 'paradis-ytclip-'));
			utimesSync(old, new Date(Date.now() - 31 * 60 * 1000), new Date(Date.now() - 31 * 60 * 1000));

			createService();

			await waitUntilGone(old);
		});

		test('leaves a recent work dir alone so it does not race another instance downloading', async () => {
			const recent = makeDir(`paradis-ytfull-recent-${Date.now()}`, 5 * 60 * 1000);
			try {
				createService();
				// 掃除対象があれば非同期に消えるはずなので、少し待ってから「消えていない」ことを確認する
				await timeout(200);
				assert.strictEqual(existsSync(recent), true);
			} finally {
				rmSync(recent, { recursive: true, force: true });
			}
		});

		test('leaves a same-named file alone, only directories are swept', async () => {
			const file = join(tmpdir(), `paradis-ytfull-file-${Date.now()}`);
			writeFileSync(file, 'not a directory');
			const oldTime = new Date(Date.now() - 31 * 60 * 1000);
			utimesSync(file, oldTime, oldTime);
			try {
				createService();
				await timeout(200);
				assert.strictEqual(existsSync(file), true);
			} finally {
				rmSync(file, { force: true });
			}
		});

		test('leaves unrelated old directories alone', async () => {
			const unrelated = makeDir(`paradis-unrelated-${Date.now()}`, 60 * 60 * 1000);
			try {
				createService();
				await timeout(200);
				assert.strictEqual(existsSync(unrelated), true);
			} finally {
				rmSync(unrelated, { recursive: true, force: true });
			}
		});
	});

	suite('install state cap', () => {
		const UNAVAILABLE_MESSAGE = 'Homebrewによる自動インストールはmacOSのみ対応しています。yt-dlpとffmpegを手動でインストールしてください。';

		// installYtDlp spawns a real `brew install` on darwin once Homebrew resolves. Forcing a
		// non-darwin platform keeps every call on the synchronous "unsupported platform" branch, so
		// the cap/eviction logic below is exercised without ever touching the real package manager.
		setup(() => { sinon.stub(process, 'platform').value('linux'); });

		test('evicts the oldest install state once more than the cap have been started', async () => {
			const service = createService();
			for (const id of ['a', 'b', 'c', 'd', 'e']) {
				await service.installYtDlp(id);
			}

			const evicted = await service.getInstallLog('a', 0);
			assert.deepStrictEqual(evicted, { lines: [], done: true, error: 'unknown installId' });

			const kept = await service.getInstallLog('e', 0);
			assert.strictEqual(kept.done, true);
			assert.strictEqual(kept.error, UNAVAILABLE_MESSAGE);
		});

		test('does not evict anything while at or under the cap', async () => {
			const service = createService();
			for (const id of ['w', 'x', 'y', 'z']) {
				await service.installYtDlp(id);
			}

			const oldest = await service.getInstallLog('w', 0);
			assert.strictEqual(oldest.error, UNAVAILABLE_MESSAGE);
			assert.notDeepStrictEqual(oldest, { lines: [], done: true, error: 'unknown installId' });
		});
	});
});
