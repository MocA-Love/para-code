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
import { IParadisIngestOpenOptions, IParadisIngestStream, IParadisIngestTerminal, IParadisLocalVoiceOutput, IParadisVoiceRetention } from '../../../notifications/common/paradisVoiceIngest.js';
import { ParadisVoiceRetentionBudget } from '../../../notifications/common/paradisVoiceRetention.js';
import { paradisMp3Bitrate } from '../../common/paradisRemoteVoice.js';
import { IParadisRemoteVoiceIngressDeps, IParadisRemoteVoiceResult, paradisReceiveRemoteVoice, paradisSendVoiceTicketRejected } from '../../node/paradisRemoteVoiceIngress.js';
import { PARADIS_MCP_REQUEST_TIMEOUT_MS, paradisArmRequestBodyTimeout, paradisConfigureMcpHttpServer } from '../../node/paradisHttpRequestTimeouts.js';
import * as sinon from 'sinon';
import { EventEmitter } from 'events';

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
	/** 'block' なら書き込みは解かれるまで返らない（子の drain が遅い）、'fail' なら失敗する。 */
	writeMode: 'ok' | 'block' | 'fail' = 'ok';
	readonly writeGate = new DeferredPromise<void>();
	async write(chunk: Uint8Array): Promise<void> {
		this.events.push(`write:${chunk.byteLength}`);
		if (this.writeMode === 'fail') {
			throw new Error('stdin closed');
		}
		if (this.writeMode === 'block') {
			await this.writeGate.p;
		}
	}
	async end(): Promise<void> { this.events.push('end'); }
	async abort(reason: string): Promise<void> { this.events.push(`abort:${reason}`); }
	/** withdraw の答え（undefined なら withdraw を持たない古い実装）。 */
	withdrawAnswer: boolean | undefined;
	get withdraw(): (() => Promise<boolean | undefined>) | undefined {
		const answer = this.withdrawAnswer;
		return answer === undefined ? undefined : async () => {
			this.events.push(`withdraw:${answer}`);
			if (answer) {
				this.finishedGate.complete({ status: 'skipped', reason: 'withdrawn', withdrawn: true });
			}
			return answer;
		};
	}
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
	readonly now?: () => number;
	/** モバイルへの流れの口を渡す（無ければ全部受け取ってから 1 本で渡す）。 */
	readonly mobileStream?: boolean;
	readonly ingestWrite?: 'ok' | 'block' | 'fail';
	readonly ticketCurrent?: () => boolean;
	readonly withdrawAnswer?: boolean;
	/** handoff の後に worker が知らせる終わり。 */
	readonly terminal?: IParadisIngestTerminal;
	/** 控えの枠（無ければ上限なし）。 */
	readonly retention?: () => IParadisVoiceRetention | undefined;
	/** 行き先の判断の記録を受ける（無ければ記録しない）。 */
	readonly logs?: string[];
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
			events.push(`${open.gainKey ? `open:${open.priority}:${open.gainKey}` : `open:${open.priority}`}${open.tagged ? ':tagged' : ''}`);
			const stream = new FakeStream();
			stream.writeMode = options.ingestWrite ?? 'ok';
			stream.withdrawAnswer = options.withdrawAnswer;
			streams.push(stream);
			if (options.handoff !== undefined) {
				stream.handoffGate.complete(options.handoff);
				if (options.handoff) {
					stream.finishedGate.complete(options.terminal ?? { status: 'done' });
				}
			}
			return stream;
		},
		...(options.retention ? { reserveFallbackCopy: options.retention } : {}),
		playFallback: async (audio, gainKey) => { events.push(gainKey ? `afplay:${audio.byteLength}:${gainKey}` : `afplay:${audio.byteLength}`); return true; },
	};
	const server = httpModule.createServer((req, res) => {
		const controller = new AbortController();
		req.once('aborted', () => controller.abort());
		res.once('close', () => { if (!res.writableEnded) { controller.abort(); } });
		void paradisReceiveRemoteVoice(req, res, { localPlayback: options.localPlayback, signal: controller.signal, enqueueDeadlineMs: 1_000 }, {
			voiceOutput,
			playViaPlayAudio: async audio => { events.push(`play-audio:${audio.byteLength}`); return options.playAudio ?? false; },
			publishMobileVoiceClip: audio => events.push(`mobile:${audio.byteLength}`),
			beginMobileVoiceStream: options.mobileStream ? gainKey => {
				events.push(`mobile-start:${gainKey ?? '-'}`);
				return {
					write: chunk => events.push(`mobile-write:${chunk.byteLength}`),
					end: () => events.push('mobile-end'),
					abort: () => events.push('mobile-abort'),
				};
			} : undefined,
			reserveBytes: options.reserve ?? (() => true),
			onBodyReceived: () => events.push('body-received'),
			isTicketCurrent: options.ticketCurrent ?? (() => true),
			log: options.logs ? message => options.logs!.push(message) : undefined,
			limits: options.limits,
			now: options.now,
		}).then(async result => {
			await result.localPlayback;
			results.push(result);
			resultGate.complete(result);
		});
	});
	// 本番と同じ時間の上限で動かす（requestTimeout が 30 秒だと chunked の声が途中で切られる）
	paradisConfigureMcpHttpServer(server);
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

	test('chunked: streams to the mobile while receiving once the head looks like MP3, with the gain key of the voice', async () => {
		const harness = await startServer({ localPlayback: false, mobileStream: true });
		try {
			const { request, response } = openRequest(harness.url, { 'Transfer-Encoding': 'chunked', 'X-Para-Gain-Key': 'elevenlabs:voice:eleven_v4_turbo' });
			request.write(mp3(1000));
			const head = await response;
			for (let i = 0; i < 50 && !harness.events.includes('mobile-write:1000'); i++) {
				await new Promise(resolve => setTimeout(resolve, 10));
			}
			// 本文を送り終える前に、最初の固まりはもうモバイルへ流れている
			const beforeEnd = [...harness.events];
			request.end(mp3(500));
			await head.body;
			await harness.resultReady;
			assert.deepStrictEqual({ beforeEnd, events: harness.events }, {
				beforeEnd: ['mobile-start:elevenlabs:voice:eleven_v4_turbo', 'mobile-write:1000'],
				events: ['mobile-start:elevenlabs:voice:eleven_v4_turbo', 'mobile-write:1000', 'mobile-write:500', 'mobile-end', 'body-received'],
			});
		} finally {
			await harness.close();
		}
	});

	test('chunked: keeps streaming to the mobile while the local --ingest write is slow, and does not abort the mobile when it fails', async () => {
		const outcomes: unknown[] = [];
		for (const ingestWrite of ['block', 'fail'] as const) {
			const harness = await startServer({ localPlayback: true, ingest: true, handoff: true, mobileStream: true, ingestWrite });
			try {
				const { request, response } = openRequest(harness.url, { 'Transfer-Encoding': 'chunked' });
				request.write(mp3(1000));
				const head = await response;
				request.write(mp3(500));
				for (let i = 0; i < 50 && !harness.events.includes('mobile-write:500'); i++) {
					await new Promise(resolve => setTimeout(resolve, 10));
				}
				// 手元の書き込みが 1 つ目で止まっていても、2 つ目はもうモバイルへ流れている
				const whileLocalStuck = harness.events.filter(event => event.startsWith('mobile-'));
				request.end();
				for (let i = 0; i < 50 && !harness.events.includes('mobile-end') && !harness.events.includes('mobile-abort'); i++) {
					await new Promise(resolve => setTimeout(resolve, 10));
				}
				harness.streams[0]?.writeGate.complete();
				await head.body;
				await harness.resultReady;
				outcomes.push({ ingestWrite, whileLocalStuck, mobile: harness.events.filter(event => event.startsWith('mobile-')), stream: harness.streams[0]?.events });
			} finally {
				await harness.close();
			}
		}
		assert.deepStrictEqual(outcomes, [
			{ ingestWrite: 'block', whileLocalStuck: ['mobile-start:-', 'mobile-write:1000', 'mobile-write:500'], mobile: ['mobile-start:-', 'mobile-write:1000', 'mobile-write:500', 'mobile-end'], stream: ['write:1000', 'write:500', 'end'] },
			// 手元へ渡せなくなっても、モバイルは届いた分で普通に終える（手元は鳴らし直しへ回る）
			{ ingestWrite: 'fail', whileLocalStuck: ['mobile-start:-', 'mobile-write:1000', 'mobile-write:500'], mobile: ['mobile-start:-', 'mobile-write:1000', 'mobile-write:500', 'mobile-end'], stream: ['write:1000', 'abort:write-failed'] },
		]);
	});

	test('chunked: a stuck local --ingest write does not keep the reader waiting after the utterance is cut off', async () => {
		const harness = await startServer({ localPlayback: true, ingest: true, mobileStream: true, ingestWrite: 'block', limits: { maxDurationMs: 300, slowArrivalMs: 60_000 } });
		try {
			const { request, response } = openRequest(harness.url, { 'Transfer-Encoding': 'chunked' });
			request.on('error', () => { });
			await new Promise<void>(resolve => request.write(mp3(1000), () => resolve()));
			await response;
			// 手元の列（1MiB）を超えるまで送る。読み進めは溜まりすぎの待ちで止まる
			for (let i = 0; i < 24; i++) {
				request.write(mp3(64 * 1024));
			}
			const result = await harness.resultReady;
			assert.deepStrictEqual({ outcome: result.outcome, mobileClosed: harness.events.includes('mobile-end') || harness.events.includes('mobile-abort') }, { outcome: 'played-locally', mobileClosed: true });
		} finally {
			harness.streams[0]?.writeGate.complete();
			await harness.close();
		}
	});

	test('chunked: aborts the mobile stream when the remote side disconnects midway', async () => {
		const harness = await startServer({ localPlayback: false, mobileStream: true });
		try {
			const { request, response } = openRequest(harness.url, { 'Transfer-Encoding': 'chunked' });
			request.write(mp3(400));
			await response;
			for (let i = 0; i < 50 && !harness.events.includes('mobile-write:400'); i++) {
				await new Promise(resolve => setTimeout(resolve, 10));
			}
			request.destroy();
			await harness.resultReady;
			assert.deepStrictEqual(harness.events, ['mobile-start:-', 'mobile-write:400', 'body-received', 'mobile-abort']);
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
			// 引き受けないときは明示の拒否を返す（aivis-mcp 2.5.1 の取り決め）
			{ accepted: 'rejected', body: { localPlayback: false }, events: ['body-received', 'mobile:300'] },
			{ accepted: 'rejected', body: { localPlayback: false }, events: ['body-received', 'mobile:300'] },
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
			// 旧方式は全部受け取ってから手元へ渡す（受け取りの途中では鳴らさない。M1）
			{ status: 202, accepted: undefined, body: { localPlayback: true }, events: ['body-received', 'mobile:600', 'open:normal'] },
			{ status: 202, accepted: undefined, body: { localPlayback: true }, events: ['body-received', 'mobile:600', 'play-audio:600'] },
			{ status: 202, accepted: undefined, body: { localPlayback: false }, events: ['body-received', 'mobile:600', 'open:normal', 'play-audio:600'] },
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
			// 引き受けた声は、届いた分で worker に終えてもらう
			{ outcome: 'played-locally', stream: ['write:418', 'end'] },
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

	test('after accepting, plays what arrived with --play-audio then afplay when the stream is too slow and --ingest is not there', async () => {
		const harness = await startServer({ localPlayback: true, ingest: false, playAudio: false, limits: { slowArrivalMs: 400 } });
		try {
			const { request, response } = openRequest(harness.url, { 'Transfer-Encoding': 'chunked', 'X-Para-Gain-Key': 'elevenlabs:voice1:eleven_v3' });
			request.on('error', () => { });
			request.write(mp3(418));
			const head = await response;
			const result = await harness.resultReady;
			assert.deepStrictEqual({ accepted: head.accepted, outcome: result.outcome, events: harness.events }, {
				accepted: 'accepted',
				outcome: 'played-locally',
				events: ['body-received', 'play-audio:418', 'afplay:418:elevenlabs:voice1:eleven_v3'],
			});
		} finally {
			await harness.close();
		}
	});

	test('keeps a chunked voice that streams for more than 30 seconds on the production server settings', async () => {
		// 時計を 1 秒ずつ進めながら、実時間と同じ速さ（128kbps で 1 秒 16000 バイト）で 35 秒分を送る
		let fakeNow = 1_000_000;
		const harness = await startServer({ localPlayback: true, ingest: true, handoff: true, now: () => fakeNow });
		try {
			const { request, response } = openRequest(harness.url, { 'Transfer-Encoding': 'chunked', 'X-Para-Gain-Key': 'aivis:model:default' });
			request.write(mp3(16_000));
			const head = await response;
			for (let second = 1; second < 35; second++) {
				fakeNow += 1_000;
				request.write(mp3(16_000));
				await new Promise(resolve => setTimeout(resolve, 2));
			}
			fakeNow += 1_000;
			request.end();
			const body = JSON.parse(await head.body);
			const result = await harness.resultReady;
			assert.deepStrictEqual({
				requestTimeout: PARADIS_MCP_REQUEST_TIMEOUT_MS >= 130_000,
				body,
				outcome: result.outcome,
				open: harness.events[0],
				ended: harness.streams[0].events.at(-1),
				bytes: harness.streams[0].events.filter(event => event.startsWith('write:')).reduce((sum, event) => sum + Number(event.slice(6)), 0),
			}, {
				requestTimeout: true,
				body: { localPlayback: true },
				outcome: 'played-locally',
				open: 'open:normal:aivis:model:default',
				ended: 'end',
				bytes: 35 * 16_000,
			});
		} finally {
			await harness.close();
		}
	});

	test('the other routes keep the 30-second limit for receiving a request body', () => {
		const clock = sinon.useFakeTimers();
		try {
			const make = () => {
				const req = Object.assign(new EventEmitter(), { complete: false, destroyed: false, destroy() { this.destroyed = true; } });
				const res = Object.assign(new EventEmitter(), { headersSent: false, writableEnded: false, status: 0, writeHead(status: number) { this.status = status; this.headersSent = true; }, end() { this.writableEnded = true; } });
				return { req, res };
			};
			const slow = make();
			paradisArmRequestBodyTimeout(slow.req as unknown as http.IncomingMessage, slow.res as unknown as http.ServerResponse);
			const finished = make();
			paradisArmRequestBodyTimeout(finished.req as unknown as http.IncomingMessage, finished.res as unknown as http.ServerResponse);
			finished.req.complete = true;
			finished.res.emit('finish');
			// 本文を読まずに返す応答には Connection: close を付け、返し終えたら 1 秒だけ読み捨ててから閉じる（M2・L-2）
			const repliedEarly = make();
			const repliedEarlyHeaders: Record<string, string> = {};
			Object.assign(repliedEarly.res, { setHeader: (name: string, value: string) => { repliedEarlyHeaders[name] = value; } });
			Object.assign(repliedEarly.req, { resume: () => { } });
			paradisArmRequestBodyTimeout(repliedEarly.req as unknown as http.IncomingMessage, repliedEarly.res as unknown as http.ServerResponse);
			repliedEarly.res.writeHead(200);
			repliedEarly.res.emit('finish');
			const repliedEarlyRightAfter = repliedEarly.req.destroyed;
			clock.tick(1_000);
			const repliedEarlyDestroyed = { rightAfter: repliedEarlyRightAfter, afterDrain: repliedEarly.req.destroyed, headers: repliedEarlyHeaders };
			// 応答を返し終えても、本文がまだ届いている間は時計を外さない（SSE など応答を先に閉じない経路は 30 秒で切る）
			const streaming = make();
			paradisArmRequestBodyTimeout(streaming.req as unknown as http.IncomingMessage, streaming.res as unknown as http.ServerResponse);
			streaming.res.emit('close');
			// 受理した音声取込は守りを外す
			const accepted = make();
			paradisArmRequestBodyTimeout(accepted.req as unknown as http.IncomingMessage, accepted.res as unknown as http.ServerResponse).dispose();
			// 本文を読み終えたら外す
			const read = make();
			paradisArmRequestBodyTimeout(read.req as unknown as http.IncomingMessage, read.res as unknown as http.ServerResponse);
			read.req.complete = true;
			// 読み捨ての 1 秒を進めた分を引く
			clock.tick(29_999 - 1_000);
			const before = slow.req.destroyed;
			clock.tick(1);
			// streaming は 1 秒遅れて掛けたので、その分を進める
			clock.tick(1_000);
			assert.deepStrictEqual({
				before,
				slow: { destroyed: slow.req.destroyed, status: slow.res.status },
				finished: finished.req.destroyed,
				repliedEarlyDestroyed,
				streaming: streaming.req.destroyed,
				accepted: accepted.req.destroyed,
				read: read.req.destroyed,
			}, {
				before: false,
				slow: { destroyed: true, status: 408 },
				finished: false,
				repliedEarlyDestroyed: { rightAfter: false, afterDrain: true, headers: { Connection: 'close' } },
				streaming: true,
				accepted: false,
				read: false,
			});
		} finally {
			clock.restore();
		}
	});

	test('cuts off a Content-Length request that stops sending with a 4xx before closing', async () => {
		const harness = await startServer({ localPlayback: true, ingest: true, limits: { slowArrivalMs: 400 } });
		try {
			const { request, response } = openRequest(harness.url, { 'Content-Length': 100_000 });
			request.on('error', () => { });
			request.write(mp3(418));
			const head = await response;
			await harness.resultReady;
			// 受け取りきるまで手元へは渡さない（M1）
			assert.deepStrictEqual({ status: head.status, streams: harness.streams.length }, { status: 408, streams: 0 });
		} finally {
			await harness.close();
		}
	});
	test('Content-Length: withdraws instead of aborting when queued does not arrive in time, and decides by the answer (L14)', async () => {
		const outcomes: unknown[] = [];
		for (const withdrawAnswer of [true, false]) {
			const harness = await startServer({ localPlayback: true, ingest: true, withdrawAnswer, playAudio: true });
			try {
				const audio = mp3(600);
				const { request, response } = openRequest(harness.url, { 'Content-Length': audio.byteLength });
				request.end(audio);
				const head = await response;
				outcomes.push({ body: JSON.parse(await head.body), stream: harness.streams[0]?.events, events: harness.events });
			} finally {
				await harness.close();
			}
		}
		assert.deepStrictEqual(outcomes, [
			// 外せた（まだ鳴っていない）ので --play-audio へ
			{ body: { localPlayback: true }, stream: ['write:600', 'end', 'withdraw:true'], events: ['body-received', 'mobile:600', 'open:normal', 'play-audio:600'] },
			// 外せなかった（worker が鳴らす）ので鳴らし直さない
			{ body: { localPlayback: true }, stream: ['write:600', 'end', 'withdraw:false'], events: ['body-received', 'mobile:600', 'open:normal'] },
		]);
	});

	test('chunked: answers accepted only after the head looks like MP3, so a rejected body is never accepted (OM1)', async () => {
		const harness = await startServer({ localPlayback: true, ingest: true, handoff: true });
		try {
			const { request, response } = openRequest(harness.url, { 'Transfer-Encoding': 'chunked' });
			request.on('error', () => { });
			request.write(Buffer.from('<html>not audio</html>'));
			const head = await response;
			await harness.resultReady;
			assert.deepStrictEqual({ status: head.status, accepted: head.accepted, streams: harness.streams.length }, { status: 415, accepted: undefined, streams: 0 });
		} finally {
			await harness.close();
		}
	});

	test('chunked: stops receiving and forwarding when the ticket owner goes away, and does not replay (M9)', async () => {
		let current = true;
		const harness = await startServer({ localPlayback: true, ingest: true, ticketCurrent: () => current });
		try {
			const { request, response } = openRequest(harness.url, { 'Transfer-Encoding': 'chunked' });
			request.on('error', () => { });
			request.write(mp3(400));
			await response;
			for (let i = 0; i < 50 && harness.streams[0]?.events.length !== 1; i++) {
				await new Promise(resolve => setTimeout(resolve, 10));
			}
			current = false;
			const result = await harness.resultReady;
			assert.deepStrictEqual({ outcome: result.outcome, stream: harness.streams[0].events, afplay: harness.events.some(event => event.startsWith('afplay') || event.startsWith('play-audio')) }, {
				outcome: 'rejected',
				stream: ['write:400', 'abort:revoked'],
				afplay: false,
			});
		} finally {
			await harness.close();
		}
	});

	test('answers 401 when the ticket owner went away before accepting, so aivis-mcp 2.5.1 does not play it remotely (ticket-unavailable)', async () => {
		const harness = await startServer({ localPlayback: true, ingest: true, ticketCurrent: () => false });
		try {
			const audio = mp3(300);
			const { request, response } = openRequest(harness.url, { 'Content-Length': audio.byteLength });
			request.on('error', () => { });
			request.end(audio);
			const head = await response;
			assert.deepStrictEqual({ status: head.status, accepted: head.accepted, streams: harness.streams.length }, { status: 401, accepted: undefined, streams: 0 });
		} finally {
			await harness.close();
		}
	});

	test('rejects an unknown, expired, used or stale voice ticket with 401 instead of 404 (aivis-mcp 2.5.1 ticket-unavailable)', async () => {
		const server = httpModule.createServer((_req, res) => paradisSendVoiceTicketRejected(res));
		await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
		try {
			const port = (server.address() as AddressInfo).port;
			const { request, response } = openRequest(new URL(`http://127.0.0.1:${port}/paradis-mcp/mobile-voice`), { 'Content-Length': 0 });
			request.end();
			const head = await response;
			assert.deepStrictEqual({ status: head.status, body: JSON.parse(await head.body) }, { status: 401, body: { error: 'Voice ticket rejected.' } });
		} finally {
			server.closeAllConnections();
			await new Promise<void>(resolve => server.close(() => resolve()));
		}
	});

	test('chunked: gives up on a stuck local write after the close limit instead of waiting forever (H3)', async () => {
		const harness = await startServer({ localPlayback: true, ingest: true, ingestWrite: 'block', limits: { localCloseTimeoutMs: 100 } });
		try {
			const { request, response } = openRequest(harness.url, { 'Transfer-Encoding': 'chunked' });
			request.end(mp3(500));
			const head = await response;
			await head.body;
			const result = await harness.resultReady;
			assert.deepStrictEqual({ outcome: result.outcome, stream: harness.streams[0].events }, { outcome: 'played-locally', stream: ['write:500', 'abort:write-failed'] });
		} finally {
			harness.streams[0]?.writeGate.complete();
			await harness.close();
		}
	});

	test('chunked: replays a voice the worker gave up on before the first audio, only within the retention budget (L2, H4)', async () => {
		const outcomes: unknown[] = [];
		for (const budget of [new ParadisVoiceRetentionBudget(), new ParadisVoiceRetentionBudget(100)]) {
			const harness = await startServer({ localPlayback: true, ingest: true, handoff: true, terminal: { status: 'failed', reason: 'first-audio-timeout' }, playAudio: false, retention: () => budget.open() });
			try {
				const { request, response } = openRequest(harness.url, { 'Transfer-Encoding': 'chunked' });
				request.end(mp3(700));
				const head = await response;
				await head.body;
				await harness.resultReady;
				outcomes.push({ events: harness.events, held: budget.usage });
			} finally {
				await harness.close();
			}
		}
		assert.deepStrictEqual(outcomes, [
			{ events: ['open:normal', 'body-received', 'mobile:700', 'play-audio:700', 'afplay:700'], held: { bytes: 0, count: 0 } },
			{ events: ['open:normal', 'body-received', 'mobile:700'], held: { bytes: 0, count: 0 } },
		]);
	});
	test('chunked: does not replay a voice that expired in the local queue, and logs why (Q309 3)', async () => {
		const outcomes: unknown[] = [];
		for (const terminal of [{ status: 'skipped', reason: 'expired' }, { status: 'failed', reason: 'first-audio-timeout' }] as const) {
			const logs: string[] = [];
			const harness = await startServer({ localPlayback: true, ingest: true, handoff: true, terminal, playAudio: true, logs });
			try {
				const { request, response } = openRequest(harness.url, { 'Transfer-Encoding': 'chunked' });
				request.end(mp3(700));
				await (await response).body;
				await harness.resultReady;
				outcomes.push({ events: harness.events, logs });
			} finally {
				await harness.close();
			}
		}
		assert.deepStrictEqual(outcomes, [
			{ events: ['open:normal', 'body-received', 'mobile:700'], logs: ['remote voice not played locally and not replayed (status=skipped, reason=expired)'] },
			{ events: ['open:normal', 'body-received', 'mobile:700', 'play-audio:700'], logs: ['remote voice replayed by Para Code (reason=first-audio-timeout)'] },
		]);
	});

	test('chunked: passes X-Para-Tagged to --ingest as a tagged job', async () => {
		const harness = await startServer({ localPlayback: true, ingest: true, handoff: true });
		try {
			const { request, response } = openRequest(harness.url, { 'Transfer-Encoding': 'chunked', 'X-Para-Tagged': '1' });
			request.end(mp3(300));
			const head = await response;
			await head.body;
			await harness.resultReady;
			assert.deepStrictEqual(harness.events[0], 'open:normal:tagged');
		} finally {
			await harness.close();
		}
	});
	test('accepts a voice muted on the remote side but only forwards it to the mobile (X-Para-Muted)', async () => {
		const outcomes: unknown[] = [];
		for (const headers of [{ 'Transfer-Encoding': 'chunked', 'X-Para-Muted': '1' }, { 'Content-Length': 500, 'X-Para-Muted': '1' }]) {
			const harness = await startServer({ localPlayback: true, ingest: true, handoff: true, hasLocalAivis: false, playAudio: true });
			try {
				const { request, response } = openRequest(harness.url, headers);
				request.end(mp3(500));
				const head = await response;
				const body = JSON.parse(await head.body);
				await harness.resultReady;
				outcomes.push({ accepted: head.accepted, body, events: harness.events });
			} finally {
				await harness.close();
			}
		}
		assert.deepStrictEqual(outcomes, [
			{ accepted: 'accepted', body: { localPlayback: true }, events: ['body-received', 'mobile:500'] },
			{ accepted: undefined, body: { localPlayback: true }, events: ['body-received', 'mobile:500'] },
		]);
	});
	test('Content-Length: does not wait for a stuck local write beyond the remote deadline (L-4)', async () => {
		const harness = await startServer({ localPlayback: true, ingest: true, ingestWrite: 'block', playAudio: true });
		try {
			const audio = mp3(600);
			const { request, response } = openRequest(harness.url, { 'Content-Length': audio.byteLength });
			request.end(audio);
			const head = await response;
			assert.deepStrictEqual({ body: JSON.parse(await head.body), stream: harness.streams[0].events, events: harness.events }, {
				body: { localPlayback: true },
				stream: ['write:600', 'abort:write-failed'],
				events: ['body-received', 'mobile:600', 'open:normal', 'play-audio:600'],
			});
		} finally {
			harness.streams[0]?.writeGate.complete();
			await harness.close();
		}
	});
});
