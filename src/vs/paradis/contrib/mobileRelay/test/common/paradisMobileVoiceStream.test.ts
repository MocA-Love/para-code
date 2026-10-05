/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-PATCH/PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import {
	paradisClampVoiceGainDb,
	paradisDecodeVoiceStreamChunk,
	paradisEncodeVoiceStreamChunk,
	paradisIsVoiceStreamChunk,
	paradisParseVoiceStreamEnd,
	paradisParseVoiceStreamStart,
	ParadisMobileVoiceEvent,
	ParadisMobileVoiceStreamWriter,
} from '../../common/paradisMobileVoiceStream.js';

const STREAM_ID = '000102030405060708090a0b0c0d0e0f';

suite('ParadisMobileVoiceStream', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	test('writes and reads the binary chunk frame (PVS\\x01 + streamId 16 bytes + seq 4 bytes + MP3)', () => {
		const encoded = paradisEncodeVoiceStreamChunk(STREAM_ID, 0x01020304, new Uint8Array([0xff, 0xfb]));
		const decoded = paradisDecodeVoiceStreamChunk(encoded)!;

		assert.deepStrictEqual({ wire: [...encoded], decoded: { ...decoded, data: [...decoded.data] } }, {
			wire: [0x50, 0x56, 0x53, 0x01, 0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 1, 2, 3, 4, 0xff, 0xfb],
			decoded: { streamId: STREAM_ID, seq: 0x01020304, data: [0xff, 0xfb] },
		});
	});

	test('does not mistake JSON, a screen JPEG or a header without audio for a chunk', () => {
		const jpeg = new Uint8Array(30);
		jpeg.set([0x50, 0x4a, 0x46, 0x01]);
		const headerOnly = paradisEncodeVoiceStreamChunk(STREAM_ID, 0, new Uint8Array(0));
		assert.deepStrictEqual([
			paradisIsVoiceStreamChunk(new TextEncoder().encode('{"t":"voice-stream-start","sid":"s"}')),
			paradisIsVoiceStreamChunk(jpeg),
			paradisDecodeVoiceStreamChunk(headerOnly),
		], [false, false, undefined]);
	});

	test('reads start and end messages and clamps gainDb to -30..+8', () => {
		assert.deepStrictEqual([
			paradisParseVoiceStreamStart({ t: 'voice-stream-start', sid: 'sid', streamId: STREAM_ID, mime: 'audio/mpeg', gainDb: 12, epoch: 3 }),
			paradisParseVoiceStreamStart({ t: 'voice-stream-start', sid: 'sid', streamId: 'not-hex', gainDb: 0 }),
			paradisParseVoiceStreamStart({ t: 'voice-stream-start', sid: 'sid', streamId: STREAM_ID, mime: 'audio/wav' }),
			paradisParseVoiceStreamEnd({ t: 'voice-stream-end', streamId: STREAM_ID, seq: 4, bytes: 100, aborted: true }),
			paradisParseVoiceStreamEnd({ t: 'voice-stream-end', streamId: STREAM_ID }),
			[paradisClampVoiceGainDb(-40), paradisClampVoiceGainDb(4.14), paradisClampVoiceGainDb('3')],
		], [
			{ t: 'voice-stream-start', sid: 'sid', streamId: STREAM_ID, mime: 'audio/mpeg', gainDb: 8, epoch: 3 },
			undefined,
			undefined,
			{ t: 'voice-stream-end', streamId: STREAM_ID, seq: 4, bytes: 100, aborted: true },
			{ t: 'voice-stream-end', streamId: STREAM_ID, seq: 0, bytes: 0, aborted: false },
			[-30, 4.1, 0],
		]);
	});

	test('the writer emits start, copies of the chunks and one end, and aborts when it grows past the limit', () => {
		const events: string[] = [];
		const describeEvent = (event: ParadisMobileVoiceEvent) => {
			switch (event.kind) {
				case 'stream-start': return `start:${event.gainDb}`;
				case 'stream-data': return `data:${event.chunk.byteLength}`;
				case 'stream-end': return `end:${event.aborted}`;
				default: return 'clip';
			}
		};
		const writer = new ParadisMobileVoiceStreamWriter(event => events.push(describeEvent(event)), 4.1, 10);
		const reused = new Uint8Array(4);
		writer.write(reused);
		writer.write(new Uint8Array(0));
		writer.write(new Uint8Array(7));
		writer.write(new Uint8Array(1));
		writer.end();
		const empty = new ParadisMobileVoiceStreamWriter(event => events.push(describeEvent(event)), 0);
		empty.end();

		assert.deepStrictEqual({ events, streamId: /^[0-9a-f]{32}$/.test(writer.streamId) }, {
			events: ['start:4.1', 'data:4', 'end:true', 'start:0', 'end:true'],
			streamId: true,
		});
	});
});
