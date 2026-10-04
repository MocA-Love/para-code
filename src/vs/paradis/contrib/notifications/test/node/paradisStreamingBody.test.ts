/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-PATCH/PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { IParadisBodyTeeSink, ParadisMobileVoiceTaskGate, paradisTeeBody } from '../../node/paradisStreamingBody.js';

async function* body(chunks: readonly number[], failAfter?: number): AsyncGenerator<Uint8Array> {
	for (const [index, size] of chunks.entries()) {
		if (failAfter !== undefined && index === failAfter) {
			throw new Error('connection reset');
		}
		yield new Uint8Array(size);
	}
}

function sink(events: string[]): () => IParadisBodyTeeSink {
	return () => {
		events.push('open');
		return {
			write: chunk => events.push(`write:${chunk.byteLength}`),
			end: () => events.push('end'),
			abort: () => events.push('abort'),
		};
	};
}

suite('paradisTeeBody', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	test('passes every chunk through while writing it to the mobile stream, and ends the stream after the body', async () => {
		const events: string[] = [];
		const read: number[] = [];
		for await (const chunk of paradisTeeBody(body([3, 5]), sink(events))) {
			read.push(chunk.byteLength);
			events.push(`read:${chunk.byteLength}`);
		}
		assert.deepStrictEqual({ read, events }, { read: [3, 5], events: ['open', 'write:3', 'read:3', 'write:5', 'read:5', 'end'] });
	});

	test('aborts the mobile stream when the body fails or the reader stops early, and opens nothing for an unread body', async () => {
		const failed: string[] = [];
		await assert.rejects(async () => {
			for await (const _chunk of paradisTeeBody(body([3, 5], 1), sink(failed))) { /* drain */ }
		});
		const stopped: string[] = [];
		for await (const _chunk of paradisTeeBody(body([3, 5]), sink(stopped))) {
			break;
		}
		const unread: string[] = [];
		paradisTeeBody(body([3]), sink(unread));

		assert.deepStrictEqual({ failed, stopped, unread }, { failed: ['open', 'write:3', 'abort'], stopped: ['open', 'write:3', 'abort'], unread: [] });
	});

	test('keeps one mobile stream per task across synthesis retries: stops after a stream that already played a head was aborted', async () => {
		const drain = async (gate: ParadisMobileVoiceTaskGate, chunks: readonly number[], failAfter?: number) => {
			try {
				for await (const _chunk of paradisTeeBody(body(chunks, failAfter), () => gate.openSink())) { /* drain */ }
			} catch { /* retry */ }
		};
		// 1 回目が音を流し始めてから切れた → 再試行の成功分はモバイルへ送らない
		const headPlayed: string[] = [];
		const gateA = new ParadisMobileVoiceTaskGate(sink(headPlayed));
		await drain(gateA, [3, 5], 1);
		await drain(gateA, [3, 5]);
		// 1 回目が音を流す前に切れた → 再試行で流れを 1 本だけ開く
		const nothingPlayed: string[] = [];
		const gateB = new ParadisMobileVoiceTaskGate(sink(nothingPlayed));
		await drain(gateB, [3], 0);
		await drain(gateB, [3]);
		await drain(gateB, [4]);

		assert.deepStrictEqual({ headPlayed, nothingPlayed }, {
			headPlayed: ['open', 'write:3', 'abort'],
			nothingPlayed: ['open', 'abort', 'open', 'write:3', 'end'],
		});
	});
});
