// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import { describe, expect, test } from 'vitest';
// モバイル（Hermes）でグローバルの TextDecoder になっている Expo の純 JS 版。結果をこれと揃える。
// app/.npmrc の `node-linker=hoisted` で expo が app/node_modules に置かれる前提の相対パス。
import { TextDecoder as ExpoTextDecoder } from '../../node_modules/expo/src/winter/TextDecoder';
import { decodeUtf8 } from '../src/utf8.js';

const encoder = new TextEncoder();
const expoDecoder = new ExpoTextDecoder();
// Expo 版の型は ArrayBuffer | DataView だけを受けるが、実装は Uint8Array も読む（normalizeBytes）。
const expoDecode = (input: Uint8Array): string => expoDecoder.decode(input as unknown as DataView);
const nativeDecoder = new TextDecoder();

function bytes(...values: number[]): Uint8Array {
	return Uint8Array.from(values);
}

function expectSameAsTextDecoder(input: Uint8Array): void {
	const actual = decodeUtf8(input);
	expect(actual).toBe(expoDecode(input));
	expect(actual).toBe(nativeDecoder.decode(input));
}

describe('decodeUtf8', () => {
	test.each([
		['empty', ''],
		['ASCII', '{"id":"1","t":"read","content":"hello\\nworld"}'],
		['Japanese', '日本語のテキスト。半角ｶﾅと全角の記号「」も含む'],
		['emoji (surrogate pairs)', '🙂👨‍👩‍👧‍👦🇯🇵 𠮷野家'],
		['mixed', 'a\u0000b\u007f\u0080߿ࠀ￿\u{10000}\u{10ffff}'],
	])('matches TextDecoder for %s', (_name, text) => {
		const input = encoder.encode(text);
		expectSameAsTextDecoder(input);
		expect(decodeUtf8(input)).toBe(text);
	});

	test('strips only a leading BOM', () => {
		expectSameAsTextDecoder(bytes(0xef, 0xbb, 0xbf, 0x61));
		expectSameAsTextDecoder(bytes(0xef, 0xbb, 0xbf));
		expectSameAsTextDecoder(bytes(0xef, 0xbb, 0xbf, 0xef, 0xbb, 0xbf, 0x61));
		expectSameAsTextDecoder(bytes(0x61, 0xef, 0xbb, 0xbf));
		expect(decodeUtf8(bytes(0xef, 0xbb, 0xbf, 0xef, 0xbb, 0xbf, 0x61))).toBe('﻿a');
	});

	test.each([
		['lone continuation', [0x80]],
		['continuations', [0x61, 0x80, 0xbf, 0x62]],
		['overlong 2 bytes', [0xc0, 0xaf]],
		['overlong 2 bytes (C1)', [0xc1, 0xbf]],
		['overlong 3 bytes', [0xe0, 0x80, 0xaf]],
		['overlong 4 bytes', [0xf0, 0x80, 0x80, 0xaf]],
		['surrogate encoded', [0xed, 0xa0, 0x80]],
		['above U+10FFFF', [0xf4, 0x90, 0x80, 0x80]],
		['F5..FF', [0xf5, 0xf8, 0xfc, 0xfe, 0xff]],
		['truncated 2 bytes at end', [0x61, 0xc3]],
		['truncated 3 bytes at end', [0x61, 0xe3, 0x81]],
		['truncated 4 bytes at end', [0x61, 0xf0, 0x9f, 0x99]],
		['broken 3 bytes then ASCII', [0xe3, 0x81, 0x41]],
		['broken 4 bytes then ASCII', [0xf0, 0x9f, 0x41, 0x42]],
		['broken 4 bytes at third', [0xf0, 0x9f, 0x99, 0x41]],
		['lead then lead', [0xe3, 0xe3, 0x81, 0x82]],
		['C2 then non-continuation', [0xc2, 0x41]],
		['surrogate low end', [0xed, 0xbf, 0xbf]],
		['E0 below A0', [0xe0, 0x9f, 0xbf]],
		['F0 below 90', [0xf0, 0x8f, 0xbf, 0xbf]],
		['F5 lead', [0xf5, 0x80, 0x80, 0x80]],
		['5-byte form', [0xf8, 0x88, 0x80, 0x80, 0x80]],
		['6-byte form', [0xfc, 0x84, 0x80, 0x80, 0x80, 0x80]],
		['invalid between valid characters (fast path candidate)', [0xe3, 0x81, 0x82, 0xed, 0xa0, 0x80, 0xe3, 0x81, 0x82]],
	])('replaces invalid bytes like TextDecoder: %s', (_name, values) => {
		expectSameAsTextDecoder(bytes(...values));
	});

	test('matches TextDecoder for every 1- and 2-byte sequence', () => {
		for (let a = 0; a < 256; a++) {
			expectSameAsTextDecoder(bytes(a));
			for (let b = 0; b < 256; b++) {
				expectSameAsTextDecoder(bytes(a, b));
			}
		}
	});

	test('matches TextDecoder for random byte soup', () => {
		let seed = 1;
		const random = () => {
			seed = (seed * 1103515245 + 12345) & 0x7fffffff;
			return seed;
		};
		const pool = [0x00, 0x41, 0x7f, 0x80, 0x9f, 0xa0, 0xbf, 0xc0, 0xc2, 0xdf, 0xe0, 0xe3, 0xed, 0xef, 0xf0, 0xf4, 0xf5, 0xff];
		for (let round = 0; round < 2000; round++) {
			const input = new Uint8Array(1 + (random() % 12));
			for (let i = 0; i < input.length; i++) {
				input[i] = pool[random() % pool.length]!;
			}
			expectSameAsTextDecoder(input);
		}
	});

	// 64 KiB ずつ読み、その中を 8192 バイトずつ文字列にするので、両方の境目をまたぐ位置に置く。
	test.each([8189, 8190, 8191, 8192, 8193, 65532, 65533, 65534, 65535, 65536, 65537, 131071])('keeps characters intact across the internal chunk boundary (ASCII prefix %i)', prefix => {
		for (const tail of ['あ', '🙂', 'é', '🙂🙂', 'あ🙂あ']) {
			const text = 'a'.repeat(prefix) + tail + 'z';
			const input = encoder.encode(text);
			expect(decodeUtf8(input)).toBe(text);
			expectSameAsTextDecoder(input);
		}
		// 境目の直前に不正なバイトと途切れた文字を置く。
		const broken = new Uint8Array(prefix + 6);
		broken.fill(0x61, 0, prefix);
		broken.set([0xf0, 0x9f, 0x99, 0xe3, 0x81, 0x82], prefix);
		expectSameAsTextDecoder(broken);
		// 継続バイトだけが 4 つ以上続く並び（どの文字にも収まらない）を境目に置く。
		for (const run of [[0x80, 0x80, 0x80, 0x80], [0xf0, 0x90, 0x80, 0x80, 0x80, 0x80], [0xe0, 0x80, 0x80, 0x80, 0x80], [0xed, 0xa0, 0x80, 0x41]]) {
			const input = new Uint8Array(prefix + run.length + 1);
			input.fill(0x61, 0, prefix);
			input.set(run, prefix - 1);
			input[input.length - 1] = 0xe3;
			expectSameAsTextDecoder(input);
		}
	});

	test('matches TextDecoder when invalid bytes sit at every offset around a block boundary', () => {
		const base = encoder.encode('あ'.repeat(30_000)); // 90,000 バイト。3 の倍数なので 65536 は文字の途中
		for (let offset = 65530; offset < 65542; offset++) {
			for (const bad of [0xff, 0x80, 0xc0, 0xe3]) {
				const input = base.slice();
				input[offset] = bad;
				expectSameAsTextDecoder(input);
			}
		}
	});

	test('matches TextDecoder for large Japanese and emoji text', () => {
		const unit = '<p>日本語の段落。English text 123 🙂 𠮷</p>\n';
		const text = unit.repeat(Math.ceil(1_000_000 / unit.length));
		const input = encoder.encode(text);
		expect(decodeUtf8(input)).toBe(text);
		expect(decodeUtf8(input)).toBe(expoDecode(input));
	});

	test('matches TextDecoder for large data with scattered invalid bytes', () => {
		const input = encoder.encode('あいうえお🙂abc'.repeat(50_000));
		for (let i = 7; i < input.length; i += 997) {
			input[i] = 0xff;
		}
		input[input.length - 1] = 0xe3;
		expectSameAsTextDecoder(input);
	});
});
