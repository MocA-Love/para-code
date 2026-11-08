/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

// scrcpy-server v5.0.1 と話す形（scrcpy の app/src/control_msg.c・doc/develop.md と同じバイトの並び）。

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { ParadisScrcpyDeviceMessageParser, ParadisScrcpyTouchAction, ParadisScrcpyVideoParser, paradisScrcpyGetClipboard, paradisAndroidInputMessages, paradisH264CodecString, paradisScrcpyKeycode, paradisScrcpyResetVideo, paradisScrcpyScid, paradisScrcpyServerArgs, paradisScrcpySetClipboard, paradisScrcpyText, paradisScrcpyTouch } from '../../common/paradisScrcpy.js';

function hex(bytes: Uint8Array): string {
	return [...bytes].map(value => value.toString(16).padStart(2, '0')).join('');
}

function concat(...chunks: Uint8Array[]): Uint8Array {
	const bytes = new Uint8Array(chunks.reduce((sum, chunk) => sum + chunk.length, 0));
	let offset = 0;
	for (const chunk of chunks) {
		bytes.set(chunk, offset);
		offset += chunk.length;
	}
	return bytes;
}

function u32(...values: number[]): Uint8Array {
	const bytes = new Uint8Array(values.length * 4);
	values.forEach((value, index) => new DataView(bytes.buffer).setUint32(index * 4, value));
	return bytes;
}

/** 端末の名前（64 バイト）・H.264 の印・セッションの包み・config・key frame・delta frame の流れ。 */
export function paradisScrcpyTestStream(): Uint8Array {
	const name = new Uint8Array(64);
	name.set(new TextEncoder().encode('Pixel 9'));
	const sps = new Uint8Array([0, 0, 0, 1, 0x67, 0x64, 0x00, 0x28, 0xac]);
	const key = new Uint8Array([0, 0, 0, 1, 0x65, 1, 2, 3]);
	const delta = new Uint8Array([0, 0, 0, 1, 0x41, 9]);
	return concat(
		name,
		u32(0x68323634),
		u32(0x80000000, 1080, 2400),
		u32(0x40000000, 0, sps.length), sps,
		u32(0x20000000, 1000, key.length), key,
		u32(0x00000000, 2000, delta.length), delta,
	);
}

suite('Paradis simulator: scrcpy protocol', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	// 1 バイトずつ届いても同じに読めること
	test('reads the device name, the codec, sessions and media packets from the video socket', () => {
		const stream = paradisScrcpyTestStream();
		const whole = new ParadisScrcpyVideoParser(true).push(stream);
		const oneByOne = new ParadisScrcpyVideoParser(true);
		const bytes = [...stream].flatMap(byte => oneByOne.push(new Uint8Array([byte])));
		const describe = (events: typeof whole) => events.map(event => event.kind === 'config' || event.kind === 'frame' ? { ...event, data: hex(event.data) } : event);
		assert.deepStrictEqual({ whole: describe(whole), sameOneByOne: JSON.stringify(describe(bytes)) === JSON.stringify(describe(whole)) }, {
			whole: [
				{ kind: 'device', name: 'Pixel 9' },
				{ kind: 'session', width: 1080, height: 2400 },
				{ kind: 'config', data: '00000001676400 28ac'.replace(' ', '') },
				{ kind: 'frame', data: '0000000165010203', key: true, pts: 1000 },
				{ kind: 'frame', data: '000000014109', key: false, pts: 2000 },
			],
			sameOneByOne: true,
		});
		assert.throws(() => new ParadisScrcpyVideoParser(false).push(u32(0x68323635)), /unexpected video codec/);
	});

	test('serializes control messages like the scrcpy client', () => {
		assert.deepStrictEqual({
			touch: hex(paradisScrcpyTouch(ParadisScrcpyTouchAction.Down, 1, 100, 200, 1080, 2400)),
			up: hex(paradisScrcpyTouch(ParadisScrcpyTouchAction.Up, 0, 5000, -3, 1080, 2400)),
			key: hex(paradisScrcpyKeycode(true, 66)),
			text: hex(paradisScrcpyText('hi')),
			clipboard: hex(paradisScrcpySetClipboard('あ', true)),
			reset: hex(paradisScrcpyResetVideo()),
		}, {
			touch: '0200' + '0000000000000001' + '00000064' + '000000c8' + '0438' + '0960' + 'ffff' + '00000000' + '00000000',
			up: '0201' + '0000000000000000' + '00000437' + '00000000' + '0438' + '0960' + '0000' + '00000000' + '00000000',
			key: '00' + '00' + '00000042' + '00000000' + '00000000',
			text: '01' + '00000002' + '6869',
			clipboard: '09' + '0000000000000000' + '01' + '00000003' + 'e38182',
			reset: '11',
		});
	});

	test('builds the server arguments, the scid and the WebCodecs codec string', () => {
		assert.deepStrictEqual({
			args: paradisScrcpyServerArgs('0abc1234', { maxSize: 1600, maxFps: 30 }),
			scid: [paradisScrcpyScid(0), paradisScrcpyScid(0.5).length],
			codec: [paradisH264CodecString(new Uint8Array([0, 0, 0, 1, 0x67, 0x64, 0x00, 0x28])), paradisH264CodecString(new Uint8Array([0, 0, 1, 0x65, 1]))],
		}, {
			args: ['CLASSPATH=/data/local/tmp/scrcpy-server.jar', 'app_process', '/', 'com.genymobile.scrcpy.Server', '5.0.1', 'scid=0abc1234', 'log_level=info', 'audio=false', 'video_codec=h264', 'max_size=1600', 'max_fps=30', 'tunnel_forward=false', 'cleanup=true', 'clipboard_autosync=false', 'power_on=true'],
			scid: ['00000000', 8],
			codec: ['avc1.640028', undefined],
		});
	});

	// ペインの入力: タッチは映像の画素へ、文字のキーは文字、それ以外は keycode、ボタンは押して離す
	test('turns pane input into control messages and refuses malformed input', () => {
		const size = { width: 1080, height: 2400 };
		const keycode = (name: string) => name === 'home' ? 3 : undefined;
		assert.deepStrictEqual({
			touch: paradisAndroidInputMessages({ kind: 'touch', phase: 'begin', x: 0.5, y: 0.25 }, size, keycode).map(hex),
			letter: paradisAndroidInputMessages({ kind: 'key', down: true, code: 'KeyA', key: 'a' }, size, keycode).map(hex),
			letterUp: paradisAndroidInputMessages({ kind: 'key', down: false, code: 'KeyA', key: 'a' }, size, keycode),
			enter: paradisAndroidInputMessages({ kind: 'key', down: true, code: 'Enter', key: 'Enter' }, size, keycode).map(hex),
			home: paradisAndroidInputMessages({ kind: 'button', button: 'home' }, size, keycode).map(hex),
		}, {
			touch: [hex(paradisScrcpyTouch(ParadisScrcpyTouchAction.Down, 0, 540, 600, 1080, 2400))],
			letter: [hex(paradisScrcpyText('a'))],
			letterUp: [],
			enter: [hex(paradisScrcpyKeycode(true, 66))],
			home: [hex(paradisScrcpyKeycode(true, 3)), hex(paradisScrcpyKeycode(false, 3))],
		});
		assert.throws(() => paradisAndroidInputMessages({ kind: 'shell', command: 'ls' }, size, keycode));
		assert.throws(() => paradisAndroidInputMessages({ kind: 'button', button: 'nope' }, size, keycode));
	});

	// 端末から操作のソケットに届く知らせ（scrcpy の app/src/device_msg.c と同じ並び）。1 バイトずつでも読めること
	test('reads clipboard and acknowledgement messages from the control socket', () => {
		const text = new TextEncoder().encode('こんにちは');
		const stream = concat(new Uint8Array([0]), u32(text.length), text, new Uint8Array([1, 0, 0, 0, 0, 0, 0, 0, 7]));
		const parser = new ParadisScrcpyDeviceMessageParser();
		const messages = [...stream].flatMap(byte => parser.push(new Uint8Array([byte])));
		assert.deepStrictEqual({ messages, get: hex(paradisScrcpyGetClipboard()), set: hex(paradisScrcpySetClipboard('a', false, 5)) }, {
			messages: [{ kind: 'clipboard', text: 'こんにちは' }, { kind: 'ackClipboard', sequence: 7n }],
			get: '0800',
			set: '09' + '0000000000000005' + '00' + '00000001' + '61',
		});
		assert.throws(() => new ParadisScrcpyDeviceMessageParser().push(new Uint8Array([9])));
	});
});
