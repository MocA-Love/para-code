/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-PATCH/PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import assert from 'assert';
import type * as http from 'http';
import { AddressInfo } from 'net';
import { DeferredPromise } from '../../../../../base/common/async.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { IParadisIngestOpenOptions, IParadisIngestStream, IParadisIngestTerminal, IParadisLocalVoiceOutput } from '../../../notifications/common/paradisVoiceIngest.js';
import { paradisMp3Bitrate } from '../../common/paradisRemoteVoice.js';
import { IParadisRemoteVoiceIngressDeps, IParadisRemoteVoiceResult, paradisReceiveRemoteVoice } from '../../node/paradisRemoteVoiceIngress.js';

/** MPEG1 Layer III 128kbps のフレームの先頭。 */
function mp3(size: number): Buffer {
	const buffer = Buffer.alloc(size);
	buffer.set([0xff, 0xfb, 0x90, 0x00]);
	return buffer;
}

class FakeStream implements IParadisIngestStream {
	readonly id = 'job';
	readonly events: string[] = [];
	readonly handoffGate = new DeferredPromise<boolean>();
	readonly finishedGate = new DeferredPromise<IParadisIngestTerminal>();
	readonly handoff = this.handoffGate.p;
	readonly finished = this.finishedGate.p;
	onDidStart(): void { }
	async write(chunk: Uint8Array): Promise<void> { this.events.push(`write:${chunk.byteLength}`); }
	async end(): Promise<void> { this.events.push('end'); }
	async abort(reason: string): Promise<void> { this.events.push(`abort:${reason}`); }
}

interface IHarness {
	readonly url: URL;
	readonly results: IParadisRemoteVoiceResult[];
	readonly events: string[];
	readonly streams: FakeStream[];
	readonly resultReady: Promise<IParadisRemoteVoiceResult>;
	close(): Promise<void>;
}

let httpModule: typeof http;

async function startServer(options: {
	readonly localPlayback: boolean;
	readonly hasLocalAivis?: boolean;
	readonly ingest?: boolean;
	readonly handoff?: boolean;
	readonly playAudio?: boolean;
	readonly reserve?: (bytes: number) => boolean;
	readonly limits?: IParadisRemoteVoiceIngressDeps['limits'];
}): Promise<IHarness> {
	const events: string[] = [];
	const streams: FakeStream[] = [];
	const results: IParadisRemoteVoiceResult[] = [];
	const resultGate = new DeferredPromise<IParadisRemoteVoiceResult>();
	const voiceOutput: IParadisLocalVoiceOutput = {
		hasLocalAivis: async () => options.hasLocalAivis ?? true,
		openIngest: async (open: IParadisIngestOpenOptions) => {
			if (!options.ingest) {
				return undefined;
			}
			events.push(`open:${open.priority}`);
			const stream = new FakeStream();
			streams.push(stream);
			if (options.handoff !== undefined) {
				stream.handoffGate.complete(options.handoff);
				if (options.handoff) {
					stream.finishedGate.complete({ status: 'done' });
				}
			}
			return stream;
		},
		playFallback: async audio => { events.push(`afplay:${audio.byteLength}`); },
	};
	const server = httpModule.createServer((req, res) => {
		const controller = new AbortController();
		req.once('aborted', () => controller.abort());
		res.once('close', () => { if (!res.writableEnded) { controller.abort(); } });
		void paradisReceiveRemoteVoice(req, res, { localPlayback: options.localPlayback, signal: controller.signal, enqueueDeadlineMs: 1_000 }, {
			voiceOutput,
			playViaPlayAudio: async audio => { events.push(`play-audio:${audio.byteLength}`); return options.playAudio ?? false; },
			publishMobileVoiceClip: audio => events.push(`mobile:${audio.byteLength}`),
			reserveBytes: options.reserve ?? (() => true),
			onBodyReceived: () => events.push('body-received'),
			isTicketCurrent: () => true,
			limits: options.limits,
		}).then(async result => {
			await result.localPlayback;
			results.push(result);
			resultGate.complete(result);
		});
	});
	await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
	const port = (server.address() as AddressInfo).port;
	return {
		url: new URL(`http://127.0.0.1:${port}/paradis-mcp/mobile-voice`),
		results,
		events,
		streams,
		resultReady: resultGate.p,
		close: () => new Promise<void>(resolve => {
			server.closeAllConnections();
			server.close(() => resolve());
		}),
	};
}

function openRequest(url: URL, headers: http.OutgoingHttpHeaders): { readonly request: http.ClientRequest; readonly response: Promise<{ readonly status: number; readonly accepted: string | undefined; readonly body: Promise<string> }> } {
	const request = httpModule.request(url, { method: 'POST', headers: { 'Content-Type': 'audio/mpeg', ...headers } });
	const response = new Promise<{ readonly status: number; readonly accepted: string | undefined; readonly body: Promise<string> }>((resolve, reject) => {
		request.once('response', res => {
			const body = new Promise<string>(resolveBody => {
				let text = '';
				res.setEncoding('utf8');
				res.on('data', (chunk: string) => { text += chunk; });
				res.once('end', () => resolveBody(text));
				res.once('error', () => resolveBody(text));
				res.once('close', () => resolveBody(text));
			});
			resolve({ status: res.statusCode ?? 0, accepted: res.headers['x-para-local-playback'] as string | undefined, body });
		});
		request.once('error', reject);
	});
	response.catch(() => undefined);
	return { request, response };
}

suite('paradisReceiveRemoteVoice', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	suiteSetup(async () => {
		httpModule = await import('http');
	});

	test('chunked: answers accepted as soon as the headers arrive, streams to --ingest and closes when the body ends', async () => {
		const harness = await startServer({ localPlayback: true, ingest: true, handoff: true });
		try {
			const { request, response } = openRequest(harness.url, { 'Transfer-Encoding': 'chunked' });
			request.write(mp3(1000));
			const head = await response; // 本文を送り終える前にヘッダーが届く
			request.write(mp3(500));
			request.end();
			const body = await head.body;
			await harness.resultReady;
			assert.deepStrictEqual({ status: head.status, accepted: head.accepted, body: JSON.parse(body), events: harness.events, stream: harness.streams[0].events, outcome: harness.results[0].outcome }, {
				status: 202,
				accepted: 'accepted',
				body: { localPlayback: true },
				events: ['open:normal', 'body-received', 'mobile:1500'],
				stream: ['write:1000', 'write:500', 'end'],
				outcome: 'played-locally',
			});
		} finally {
			await harness.close();
		}
	});

	test('chunked: without --ingest it plays with --play-audio and then afplay after receiving everything', async () => {
		const harness = await startServer({ localPlayback: true, ingest: false, playAudio: false });
		try {
			const { request, response } = openRequest(harness.url, { 'Transfer-Encoding': 'chunked' });
			request.end(mp3(800));
			const head = await response;
			await head.body;
			await harness.resultReady;
			assert.deepStrictEqual({ accepted: head.accepted, events: harness.events }, {
				accepted: 'accepted',
				events: ['body-received', 'mobile:800', 'play-audio:800', 'afplay:800'],
			});
		} finally {
			await harness.close();
		}
	});

	test('chunked: does not accept without a local aivis-mcp or for a mobile-only ticket', async () => {
		const results: Array<{ readonly accepted: string | undefined; readonly body: unknown; readonly events: string[] }> = [];
		for (const options of [{ localPlayback: true, hasLocalAivis: false, ingest: true }, { localPlayback: false, ingest: true }]) {
			const harness = await startServer(options);
			try {
				const { request, response } = openRequest(harness.url, { 'Transfer-Encoding': 'chunked' });
				request.end(mp3(300));
				const head = await response;
				const body = JSON.parse(await head.body);
				await harness.resultReady;
				results.push({ accepted: head.accepted, body, events: harness.events });
			} finally {
				await harness.close();
			}
		}
		assert.deepStrictEqual(results, [
			{ accepted: undefined, body: { localPlayback: false }, events: ['body-received', 'mobile:300'] },
			{ accepted: undefined, body: { localPlayback: false }, events: ['body-received', 'mobile:300'] },
		]);
	});

	test('chunked: aborts the --ingest job when the remote side disconnects midway', async () => {
		const harness = await startServer({ localPlayback: true, ingest: true });
		try {
			const { request, response } = openRequest(harness.url, { 'Transfer-Encoding': 'chunked' });
			request.write(mp3(400));
			await response;
			for (let i = 0; i < 50 && harness.streams[0]?.events.length !== 1; i++) {
				await new Promise(resolve => setTimeout(resolve, 10));
			}
			request.destroy();
			const result = await harness.resultReady;
			assert.deepStrictEqual({ outcome: result.outcome, stream: harness.streams[0].events, events: harness.events }, {
				outcome: 'aborted',
				stream: ['write:400', 'abort:ssh-closed'],
				events: ['open:normal', 'body-received'],
			});
		} finally {
			await harness.close();
		}
	});

	test('Content-Length (old aivis-mcp): reports localPlayback after --ingest queues it, or after --play-audio', async () => {
		const outcomes: unknown[] = [];
		for (const options of [{ localPlayback: true, ingest: true, handoff: true }, { localPlayback: true, ingest: false, playAudio: true }, { localPlayback: true, ingest: true, handoff: false, playAudio: false }]) {
			const harness = await startServer(options);
			try {
				const audio = mp3(600);
				const { request, response } = openRequest(harness.url, { 'Content-Length': audio.byteLength });
				request.end(audio);
				const head = await response;
				outcomes.push({ status: head.status, accepted: head.accepted, body: JSON.parse(await head.body), events: harness.events });
				await harness.resultReady;
			} finally {
				await harness.close();
			}
		}
		assert.deepStrictEqual(outcomes, [
			{ status: 202, accepted: undefined, body: { localPlayback: true }, events: ['open:normal', 'body-received', 'mobile:600'] },
			{ status: 202, accepted: undefined, body: { localPlayback: true }, events: ['body-received', 'mobile:600', 'play-audio:600'] },
			{ status: 202, accepted: undefined, body: { localPlayback: false }, events: ['open:normal', 'body-received', 'mobile:600', 'play-audio:600'] },
		]);
	});

	test('rejects a body that is not MP3 or over the reserved bytes without handing it to --ingest', async () => {
		const outcomes: unknown[] = [];
		for (const [options, payload] of [
			[{ localPlayback: true, ingest: true }, Buffer.from('<html>not audio</html>')],
			[{ localPlayback: true, ingest: true, reserve: () => false }, mp3(100)],
		] as const) {
			const harness = await startServer(options);
			try {
				const { request, response } = openRequest(harness.url, { 'Content-Length': payload.byteLength });
				request.end(payload);
				const head = await response.catch(() => undefined);
				const result = await harness.resultReady;
				outcomes.push({ status: head?.status, outcome: result.outcome, streams: harness.streams.length });
			} finally {
				await harness.close();
			}
		}
		assert.deepStrictEqual(outcomes, [
			{ status: 415, outcome: 'rejected', streams: 0 },
			{ status: 413, outcome: 'rejected', streams: 0 },
		]);
	});

	test('cuts off a stream that never sends audio or arrives slower than half real time', async () => {
		const outcomes: unknown[] = [];
		// 最初の音が来ない
		{
			const harness = await startServer({ localPlayback: true, ingest: true, limits: { firstAudioTimeoutMs: 100 } });
			try {
				const { request } = openRequest(harness.url, { 'Transfer-Encoding': 'chunked' });
				request.flushHeaders();
				request.on('error', () => { });
				const result = await harness.resultReady;
				outcomes.push({ outcome: result.outcome, streams: harness.streams.length });
			} finally {
				await harness.close();
			}
		}
		// 届く速さが遅い（128kbps で 418 バイトは約 26ms 分しかない）
		{
			const harness = await startServer({ localPlayback: true, ingest: true, limits: { slowArrivalMs: 400 } });
			try {
				const { request, response } = openRequest(harness.url, { 'Transfer-Encoding': 'chunked' });
				request.on('error', () => { });
				request.write(mp3(418));
				await response;
				const result = await harness.resultReady;
				outcomes.push({ outcome: result.outcome, stream: harness.streams[0].events });
			} finally {
				await harness.close();
			}
		}
		assert.deepStrictEqual(outcomes, [
			{ outcome: 'rejected', streams: 0 },
			{ outcome: 'rejected', stream: ['write:418', 'abort:slow-arrival'] },
		]);
	});

	test('reads the bitrate of the first MPEG frame after an ID3 tag', () => {
		const id3 = Buffer.from([0x49, 0x44, 0x33, 4, 0, 0, 0, 0, 0, 2, 0, 0]);
		assert.deepStrictEqual([
			paradisMp3Bitrate(mp3(4)),
			paradisMp3Bitrate(Buffer.concat([id3, mp3(4)])),
			paradisMp3Bitrate(Buffer.from([0xff, 0xf3, 0x40, 0x00])),
			paradisMp3Bitrate(Buffer.from([0x00, 0x01, 0x02, 0x03])),
		], [
			{ kbps: 128, offset: 0 },
			{ kbps: 128, offset: 12 },
			{ kbps: 32, offset: 0 },
			undefined,
		]);
	});
});
