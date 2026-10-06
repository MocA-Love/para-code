/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import * as sinon from 'sinon';
import { timeout } from '../../../../../base/common/async.js';
import { join } from '../../../../../base/common/path.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { NullLogService } from '../../../../../platform/log/common/log.js';
import { PARADIS_MAX_CUSTOM_AUDIO_SIZE_BYTES, PARADIS_MAX_FETCHED_AUDIO_SIZE_BYTES } from '../../common/paradisNotifications.js';
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

	suite('Myinstants download', () => {
		const MP3_URL = 'https://www.myinstants.com/media/sounds/fahhh_KcgAXfs.mp3';
		// ID3v2.3 header followed by a little padding: enough for the leading-bytes check.
		const MP3_BYTES = Uint8Array.of(0x49, 0x44, 0x33, 0x03, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0xff, 0xfb, 0x90, 0x64);

		function mp3Response(body: BodyInit = MP3_BYTES, headers: Record<string, string> = { 'content-type': 'audio/mpeg' }): Response {
			return new Response(body, { headers });
		}

		test('fetches an allowed mp3 once, follows an allowed redirect manually and keeps it as a temp audio', async () => {
			const redirected = 'https://myinstants.com/media/sounds/fahhh_KcgAXfs.mp3';
			const fetchStub = sinon.stub(globalThis, 'fetch').callsFake(async input => String(input) === MP3_URL
				? new Response(null, { status: 301, headers: { location: redirected } })
				: mp3Response());
			const service = createService();

			const result = await service.downloadMyinstantsAudio(MP3_URL);
			assert.ok(result.ok);
			const { tempId, ...rest } = result;
			assert.deepStrictEqual(rest, { ok: true, sourceUrl: redirected, fileName: 'fahhh_KcgAXfs.mp3', sizeBytes: MP3_BYTES.byteLength, suggestedName: 'Fahhh' });
			assert.deepStrictEqual(fetchStub.getCalls().map(call => [String(call.args[0]), call.args[1]?.redirect]), [[MP3_URL, 'manual'], [redirected, 'manual']]);
			assert.deepStrictEqual(await service.readTempAudioFile(tempId), { base64: Buffer.from(MP3_BYTES).toString('base64'), mimeType: 'audio/mpeg' });

			await service.cleanupTempAudio(tempId);
			assert.strictEqual(await service.readTempAudioFile(tempId), null);
		});

		test('refuses URLs outside the allowed shape before issuing a request', async () => {
			const fetchStub = sinon.stub(globalThis, 'fetch').resolves(mp3Response());
			const service = createService();

			assert.deepStrictEqual([
				await service.downloadMyinstantsAudio('https://www.myinstants.com/en/instant/fahhh-42300/'),
				await service.downloadMyinstantsAudio('https://example.test/media/sounds/a.mp3'),
				await service.downloadMyinstantsAudio(`${MP3_URL}?download=1`),
			], [
				{ ok: false, reason: 'pageUrl' },
				{ ok: false, reason: 'invalidUrl' },
				{ ok: false, reason: 'invalidUrl' },
			]);
			assert.strictEqual(fetchStub.called, false);
		});

		test('does not follow a redirect that leaves the allowed shape', async () => {
			const fetchStub = sinon.stub(globalThis, 'fetch').resolves(new Response(null, { status: 302, headers: { location: 'https://evil.example/media/sounds/a.mp3' } }));
			const service = createService();

			assert.deepStrictEqual(await service.downloadMyinstantsAudio(MP3_URL), { ok: false, reason: 'redirect' });
			assert.strictEqual(fetchStub.callCount, 1);
		});

		test('stops after too many redirects', async () => {
			const fetchStub = sinon.stub(globalThis, 'fetch').callsFake(async () => new Response(null, { status: 302, headers: { location: '/media/sounds/again_KcgAXfs.mp3' } }));
			const service = createService();

			assert.deepStrictEqual(await service.downloadMyinstantsAudio(MP3_URL), { ok: false, reason: 'redirect' });
			assert.strictEqual(fetchStub.callCount, 4);
		});

		test('maps HTTP failures, non-mp3 responses and oversized bodies to reasons', async () => {
			let response = new Response(null);
			sinon.stub(globalThis, 'fetch').callsFake(async () => response);
			const service = createService();
			const responses: Response[] = [
				new Response('gone', { status: 404 }),
				new Response('Just a moment...', { status: 403, headers: { 'cf-mitigated': 'challenge' } }),
				new Response('oops', { status: 500 }),
				mp3Response('<!DOCTYPE html>', { 'content-type': 'text/html' }),
				mp3Response('<!DOCTYPE html>', { 'content-type': 'audio/mpeg' }),
				mp3Response(MP3_BYTES, { 'content-type': 'audio/mpeg', 'content-length': String(PARADIS_MAX_CUSTOM_AUDIO_SIZE_BYTES + 1) }),
				mp3Response(new Uint8Array(PARADIS_MAX_CUSTOM_AUDIO_SIZE_BYTES + 1)),
			];

			const results = [];
			for (const next of responses) {
				response = next;
				results.push(await service.downloadMyinstantsAudio(MP3_URL));
			}
			assert.deepStrictEqual(results, [
				{ ok: false, reason: 'notFound', status: 404 },
				{ ok: false, reason: 'blocked', status: 403 },
				{ ok: false, reason: 'http', status: 500 },
				{ ok: false, reason: 'notMp3' },
				{ ok: false, reason: 'notMp3' },
				{ ok: false, reason: 'tooLarge' },
				{ ok: false, reason: 'tooLarge' },
			]);
		});

		test('reports a network failure without throwing', async () => {
			sinon.stub(globalThis, 'fetch').rejects(new TypeError('fetch failed'));
			const service = createService();

			assert.deepStrictEqual(await service.downloadMyinstantsAudio(MP3_URL), { ok: false, reason: 'network' });
		});

		test('refuses to import a temp audio that did not come from Myinstants', async () => {
			const service = createService();

			await assert.rejects(service.importMyinstantsAudio('unknown-temp-id', 'Name'));
		});

		test('stops a request that has not answered after 15 seconds', async () => {
			const clock = sinon.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
			sinon.stub(globalThis, 'fetch').callsFake((_input, init) => new Promise<Response>((_resolve, reject) => {
				init?.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')));
			}));
			const service = createService();

			let settled = false;
			const pending = service.downloadMyinstantsAudio(MP3_URL).finally(() => { settled = true; });
			await clock.tickAsync(14_999);
			assert.strictEqual(settled, false);
			await clock.tickAsync(1);
			assert.deepStrictEqual(await pending, { ok: false, reason: 'timeout' });
		});

		suite('saving into the custom ringtone slot', () => {
			let assetsDir: string;
			setup(() => { assetsDir = mkdtempSync(join(tmpdir(), 'paradis-ringtones-test-')); });
			teardown(() => rmSync(assetsDir, { recursive: true, force: true }));

			function createServiceWithAssets(): ParadisNotificationsService {
				return store.add(new ParadisNotificationsService(new NullLogService(), undefined, { assetsDir }));
			}

			function readMetadata(): Record<string, unknown> {
				return JSON.parse(readFileSync(join(assetsDir, 'notification-custom.json'), 'utf8'));
			}

			test('overwrites the slot, keeps the source URL across a rename and drops the YouTube edit state', async () => {
				// A previous YouTube import: clip, re-edit source and edit state.
				writeFileSync(join(assetsDir, 'notification-custom.mp3'), 'old clip');
				writeFileSync(join(assetsDir, 'notification-custom-source.m4a'), 'old source');
				writeFileSync(join(assetsDir, 'notification-custom.json'), JSON.stringify({
					name: 'Me at the zoo', importedAt: 1, thumbnailUrl: 'https://example.test/t.jpg',
					editState: { startSeconds: 0, endSeconds: 3, sourceUrl: 'https://www.youtube.com/watch?v=jNQXAC9IVRw' },
				}));
				sinon.stub(globalThis, 'fetch').resolves(mp3Response());
				const service = createServiceWithAssets();

				const downloaded = await service.downloadMyinstantsAudio(MP3_URL);
				assert.ok(downloaded.ok);
				const info = await service.importMyinstantsAudio(downloaded.tempId, '  Fahhh  ');
				const afterImport = readMetadata();
				await service.renameCustomAudio('Renamed');

				assert.deepStrictEqual({
					info,
					afterImport: { name: afterImport.name, sourceUrl: afterImport.sourceUrl, hasEditState: afterImport.editState !== undefined, hasThumbnail: afterImport.thumbnailUrl !== undefined },
					afterRename: (({ importedAt: _importedAt, ...rest }) => rest)(readMetadata()),
					editState: await service.getCustomEditState(),
					files: readdirSync(assetsDir).sort(),
					audio: readFileSync(join(assetsDir, 'notification-custom.mp3')).equals(Buffer.from(MP3_BYTES)),
					tempGone: await service.readTempAudioFile(downloaded.tempId),
				}, {
					info: { id: 'custom', name: 'Fahhh', description: 'Imported from your local machine', emoji: '\u{1F50A}' },
					afterImport: { name: 'Fahhh', sourceUrl: MP3_URL, hasEditState: false, hasThumbnail: false },
					afterRename: { name: 'Renamed', sourceUrl: MP3_URL },
					editState: null,
					files: ['notification-custom.json', 'notification-custom.mp3'],
					audio: true,
					tempGone: null,
				});
			});

			test('still reads metadata written before the source URL field existed', async () => {
				writeFileSync(join(assetsDir, 'notification-custom.wav'), 'legacy');
				writeFileSync(join(assetsDir, 'notification-custom.json'), JSON.stringify({ name: 'Legacy', importedAt: 1 }));
				const service = createServiceWithAssets();

				const info = await service.getCustomRingtoneInfo();
				await service.renameCustomAudio('Legacy 2');
				assert.deepStrictEqual({ info, editState: await service.getCustomEditState(), metadata: readMetadata() }, {
					info: { id: 'custom', name: 'Legacy', description: 'Imported from your local machine', emoji: '\u{1F50A}' },
					editState: null,
					metadata: { name: 'Legacy 2', importedAt: 1 },
				});
			});
		});
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
