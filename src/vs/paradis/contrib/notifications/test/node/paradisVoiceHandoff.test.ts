/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-PATCH/PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import assert from 'assert';
import { DeferredPromise } from '../../../../../base/common/async.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { IParadisIngestOpenOptions, IParadisIngestStream, IParadisIngestTerminal } from '../../common/paradisVoiceIngest.js';
import { AivisError } from '../../node/paradisAudioScheduler.js';
import { paradisHandoffVoice } from '../../node/paradisVoiceHandoff.js';

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

async function* body(...parts: number[]): AsyncGenerator<Uint8Array> {
	for (const size of parts) {
		yield new Uint8Array(size);
	}
}

async function flush(): Promise<void> {
	for (let i = 0; i < 20; i++) {
		await Promise.resolve();
	}
}

suite('paradisHandoffVoice', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	function port(stream: FakeStream | undefined, ready = true) {
		const opened: IParadisIngestOpenOptions[] = [];
		return {
			opened,
			ingest: {
				whenReady: async () => ready,
				open: (options: IParadisIngestOpenOptions) => { opened.push(options); return stream; },
			},
		};
	}

	const prelude = { path: '/sounds/chime.mp3', volume: 0.4 };

	test('releases at queued while the synthesis keeps streaming, and sends the full clip to mobile', async () => {
		const stream = new FakeStream();
		const { ingest, opened } = port(stream);
		const completed: number[] = [];
		const pending = paradisHandoffVoice({
			ingest,
			open: { priority: 'high', gainKey: 'aivis:m:default', volumeDb: -3, prelude },
			attempt: 1,
			synthesize: async () => ({ body: body(100, 200) }),
			onComplete: audio => completed.push(audio.byteLength),
			onWithdrawn: () => assert.fail('not withdrawn'),
		});
		stream.handoffGate.complete(true);
		const result = await pending;
		await flush();
		stream.finishedGate.complete({ status: 'done' });
		await flush();
		assert.deepStrictEqual({ result, opened, events: stream.events, completed }, {
			result: { kind: 'released' },
			opened: [{ priority: 'high', gainKey: 'aivis:m:default', volumeDb: -3, prelude }],
			events: ['write:100', 'write:200', 'end'],
			completed: [300],
		});
	});

	test('returns the received audio for afplay when --ingest fails before queued', async () => {
		const stream = new FakeStream();
		const pending = paradisHandoffVoice({
			ingest: port(stream).ingest,
			open: { priority: 'normal' },
			attempt: 1,
			synthesize: async () => ({ body: body(10, 20) }),
			onWithdrawn: () => { },
		});
		await flush();
		stream.handoffGate.complete(false);
		const result = await pending;
		assert.deepStrictEqual({ kind: result.kind, bytes: result.kind === 'fallback' ? result.audio?.byteLength : undefined }, { kind: 'fallback', bytes: 30 });
	});

	test('plays locally only the clips the worker withdrew after the handoff', async () => {
		const stream = new FakeStream();
		const withdrawn: number[] = [];
		const pending = paradisHandoffVoice({
			ingest: port(stream).ingest,
			open: { priority: 'normal' },
			attempt: 1,
			synthesize: async () => ({ body: body(40) }),
			onWithdrawn: audio => withdrawn.push(audio.byteLength),
		});
		stream.handoffGate.complete(true);
		await pending;
		await flush();
		stream.finishedGate.complete({ status: 'failed', reason: 'worker-unavailable', withdrawn: true });
		await flush();
		assert.deepStrictEqual(withdrawn, [40]);
	});

	test('aborts the job and rethrows when the synthesis fails, and drops the ringtone on a retry', async () => {
		const stream = new FakeStream();
		const { ingest, opened } = port(stream);
		await assert.rejects(paradisHandoffVoice({
			ingest,
			open: { priority: 'normal', prelude },
			attempt: 2,
			synthesize: async () => { throw new AivisError('retryable', 'timeout'); },
			onWithdrawn: () => { },
		}), AivisError);
		const notReady = await paradisHandoffVoice({ ingest: port(undefined, false).ingest, open: { priority: 'normal' }, attempt: 1, synthesize: async () => ({ body: body(1) }), onWithdrawn: () => { } });
		assert.deepStrictEqual({ opened, events: stream.events, notReady }, {
			opened: [{ priority: 'normal', prelude: undefined }],
			events: ['abort:synth-failed'],
			notReady: { kind: 'fallback' },
		});
	});
});
