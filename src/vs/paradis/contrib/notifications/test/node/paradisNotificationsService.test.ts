/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import * as sinon from 'sinon';
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
});
