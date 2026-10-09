/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-PATCH/PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

// 画像を Chromium にデコードさせる前に、ヘッダーだけを読んで縦横の大きさを確かめる。
//
// upstream の画像プレビューは webview の中で画像をデコードしていたので、巨大な画像（展開すると何 GB にも
// なる「画像の爆弾」）で落ちてもそのフレームだけで済んだ。画像ビューアはワークベンチの renderer で
// デコードするので、展開後の大きさが上限を超える画像は、デコードさせずに断る。
//
// 形式は拡張子ではなく先頭の署名で決める（Chromium も <img> では署名で形式を決めるため。拡張子と中身が
// 食い違っていても、実際にデコードされる形式で確かめる）。ここではヘッダーを読むだけで、展開はしない。
// Word の画像の検査（common/word/paradisWordImageInspection.ts）はチャンク全体の CRC を JS で計算し、
// 動く PNG を断るので、開くたびに全体を見る画像ビューアには使わない。

export type ParadisImageFormat = 'png' | 'jpeg' | 'gif' | 'webp' | 'bmp' | 'ico' | 'avif';

export interface ParadisImageDimensions {
	readonly format: ParadisImageFormat;
	readonly width: number;
	readonly height: number;
}

function u16be(bytes: Uint8Array, offset: number): number {
	return (bytes[offset] << 8) | bytes[offset + 1];
}

function u32be(bytes: Uint8Array, offset: number): number {
	return ((bytes[offset] << 24) | (bytes[offset + 1] << 16) | (bytes[offset + 2] << 8) | bytes[offset + 3]) >>> 0;
}

function u16le(bytes: Uint8Array, offset: number): number {
	return bytes[offset] | (bytes[offset + 1] << 8);
}

function u24le(bytes: Uint8Array, offset: number): number {
	return bytes[offset] | (bytes[offset + 1] << 8) | (bytes[offset + 2] << 16);
}

function i32le(bytes: Uint8Array, offset: number): number {
	return bytes[offset] | (bytes[offset + 1] << 8) | (bytes[offset + 2] << 16) | (bytes[offset + 3] << 24);
}

function ascii(bytes: Uint8Array, offset: number, length: number): string {
	let value = '';
	for (let index = 0; index < length && offset + index < bytes.byteLength; index++) {
		value += String.fromCharCode(bytes[offset + index]);
	}
	return value;
}

const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

function isPng(bytes: Uint8Array, offset = 0): boolean {
	return bytes.byteLength >= offset + 24 && PNG_SIGNATURE.every((value, index) => bytes[offset + index] === value);
}

function pngDimensions(bytes: Uint8Array, offset = 0): { width: number; height: number } {
	// 最初のチャンクは IHDR（幅・高さの順に 4 バイトずつ）。
	if (ascii(bytes, offset + 12, 4) !== 'IHDR') {
		return { width: 0, height: 0 };
	}
	return { width: u32be(bytes, offset + 16), height: u32be(bytes, offset + 20) };
}

function jpegDimensions(bytes: Uint8Array): { width: number; height: number } {
	let offset = 2;
	while (offset + 4 <= bytes.byteLength) {
		if (bytes[offset] !== 0xff) {
			return { width: 0, height: 0 };
		}
		const marker = bytes[offset + 1];
		if (marker === 0xff) {
			// 詰め物の 0xFF。
			offset++;
			continue;
		}
		if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd8)) {
			offset += 2;
			continue;
		}
		if (marker === 0xd9 || marker === 0xda) {
			// SOF より前に画像データ（SOS）や終わり（EOI）が来た。
			return { width: 0, height: 0 };
		}
		const length = u16be(bytes, offset + 2);
		const isStartOfFrame = marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc;
		if (isStartOfFrame) {
			if (offset + 9 > bytes.byteLength) {
				return { width: 0, height: 0 };
			}
			return { height: u16be(bytes, offset + 5), width: u16be(bytes, offset + 7) };
		}
		if (length < 2) {
			return { width: 0, height: 0 };
		}
		offset += 2 + length;
	}
	return { width: 0, height: 0 };
}

function webpDimensions(bytes: Uint8Array): { width: number; height: number } {
	const chunk = ascii(bytes, 12, 4);
	if (chunk === 'VP8X' && bytes.byteLength >= 30) {
		return { width: 1 + u24le(bytes, 24), height: 1 + u24le(bytes, 27) };
	}
	if (chunk === 'VP8L' && bytes.byteLength >= 25 && bytes[20] === 0x2f) {
		const b1 = bytes[21], b2 = bytes[22], b3 = bytes[23], b4 = bytes[24];
		return { width: 1 + (b1 | ((b2 & 0x3f) << 8)), height: 1 + ((b2 >> 6) | (b3 << 2) | ((b4 & 0x0f) << 10)) };
	}
	if (chunk === 'VP8 ' && bytes.byteLength >= 30) {
		return { width: u16le(bytes, 26) & 0x3fff, height: u16le(bytes, 28) & 0x3fff };
	}
	return { width: 0, height: 0 };
}

function bmpDimensions(bytes: Uint8Array, offset: number, iconHalfHeight: boolean): { width: number; height: number } {
	if (bytes.byteLength < offset + 12) {
		return { width: 0, height: 0 };
	}
	const headerSize = i32le(bytes, offset);
	if (headerSize === 12) {
		const height = u16le(bytes, offset + 6);
		return { width: u16le(bytes, offset + 4), height: iconHalfHeight ? height / 2 : height };
	}
	if (headerSize < 40) {
		return { width: 0, height: 0 };
	}
	const height = Math.abs(i32le(bytes, offset + 8));
	return { width: Math.abs(i32le(bytes, offset + 4)), height: iconHalfHeight ? height / 2 : height };
}

/** ICO / CUR: 中の画像のうち一番大きいもの（Chromium はその中から 1 枚を選んでデコードする）。 */
function icoDimensions(bytes: Uint8Array): { width: number; height: number } {
	const count = u16le(bytes, 4);
	if (count === 0 || bytes.byteLength < 6 + count * 16) {
		return { width: 0, height: 0 };
	}
	let best = { width: 0, height: 0 };
	for (let index = 0; index < count; index++) {
		const entry = 6 + index * 16;
		const dataOffset = i32le(bytes, entry + 12) >>> 0;
		let size = { width: bytes[entry] || 256, height: bytes[entry + 1] || 256 };
		if (isPng(bytes, dataOffset)) {
			size = pngDimensions(bytes, dataOffset);
		} else if (dataOffset + 12 <= bytes.byteLength) {
			const bmp = bmpDimensions(bytes, dataOffset, true);
			if (bmp.width && bmp.height) {
				size = bmp;
			}
		}
		if (!size.width || !size.height) {
			return { width: 0, height: 0 };
		}
		if (size.width * size.height > best.width * best.height) {
			best = size;
		}
	}
	return best;
}

/** AVIF（ISOBMFF）: `ispe`（画像の空間的な大きさ）の箱のうち一番大きいもの。見つからなければ 0。 */
function avifDimensions(bytes: Uint8Array): { width: number; height: number } {
	let best = { width: 0, height: 0 };
	const last = Math.min(bytes.byteLength - 16, 1024 * 1024);
	for (let offset = 8; offset <= last; offset++) {
		if (bytes[offset] === 0x69 && bytes[offset + 1] === 0x73 && bytes[offset + 2] === 0x70 && bytes[offset + 3] === 0x65) {
			const size = { width: u32be(bytes, offset + 8), height: u32be(bytes, offset + 12) };
			if (size.width * size.height > best.width * best.height) {
				best = size;
			}
		}
	}
	return best;
}

/**
 * 先頭の署名で形式を決め、ヘッダーから縦横の大きさを読む。署名が分からなければ undefined。
 * 形式は分かったが大きさが読めなかったときは width/height が 0 になる。
 */
export function readParadisImageHeader(bytes: Uint8Array): ParadisImageDimensions | undefined {
	if (isPng(bytes)) {
		return { format: 'png', ...pngDimensions(bytes) };
	}
	if (bytes.byteLength >= 4 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) {
		return { format: 'jpeg', ...jpegDimensions(bytes) };
	}
	const head = ascii(bytes, 0, 6);
	if (head === 'GIF87a' || head === 'GIF89a') {
		return bytes.byteLength >= 10 ? { format: 'gif', width: u16le(bytes, 6), height: u16le(bytes, 8) } : { format: 'gif', width: 0, height: 0 };
	}
	if (ascii(bytes, 0, 4) === 'RIFF' && ascii(bytes, 8, 4) === 'WEBP') {
		return { format: 'webp', ...webpDimensions(bytes) };
	}
	if (ascii(bytes, 0, 2) === 'BM') {
		return { format: 'bmp', ...bmpDimensions(bytes, 14, false) };
	}
	if (bytes.byteLength >= 6 && bytes[0] === 0 && bytes[1] === 0 && (bytes[2] === 1 || bytes[2] === 2) && bytes[3] === 0) {
		return { format: 'ico', ...icoDimensions(bytes) };
	}
	if (ascii(bytes, 4, 4) === 'ftyp' && ['avif', 'avis', 'mif1', 'msf1'].includes(ascii(bytes, 8, 4))) {
		return { format: 'avif', ...avifDimensions(bytes) };
	}
	return undefined;
}

export type ParadisImageDecodeVerdict = 'ok' | 'tooLarge' | 'invalid';

/**
 * デコードさせてよいか。展開後の画素数が `maxPixels` を超えるもの、署名の分かる形式なのに大きさが
 * 読めないものは断る。SVG（ベクタ。<img> では表示の大きさで描く）と、大きさの箱が見つからない AVIF は、
 * バイト数の上限だけで通す。署名の分からないものは、SVG 以外は断る（Chromium もデコードできない）。
 */
export function judgeParadisImageDecode(bytes: Uint8Array, mimeType: string, maxPixels: number): ParadisImageDecodeVerdict {
	const header = readParadisImageHeader(bytes);
	if (!header) {
		return mimeType === 'image/svg+xml' ? 'ok' : 'invalid';
	}
	if (!header.width || !header.height) {
		return header.format === 'avif' ? 'ok' : 'invalid';
	}
	return header.width * header.height > maxPixels ? 'tooLarge' : 'ok';
}
