/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-PATCH/PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

// Word に埋め込まれた画像（PNG・JPEG・GIF）を、表示へ渡す前に中身で確かめる（Q312 A）。
// 拡張子や content type は信じず、先頭の署名と、大きさを決める構造（PNG の IHDR とチャンクの CRC、
// JPEG の SOF とセグメント、GIF の論理画面・画像記述子・拡張ブロック）を読む。画像を展開はしない。
// 静止画だけを通す（APNG は箱にする）。画像の終わり（PNG の IEND、JPEG の EOI、GIF のトレーラ）より
// 後ろにあるデータは、表示へ渡すときに切る（`end`）。ここで通らなかったもの、EMF・WMF・TIFF などは、
// これまでどおり代替表示の箱にする。

export type ParadisWordRasterFormat = 'png' | 'jpeg' | 'gif';

export interface ParadisWordRasterImage {
	readonly format: ParadisWordRasterFormat;
	readonly mimeType: 'image/png' | 'image/jpeg' | 'image/gif';
	readonly width: number;
	readonly height: number;
	/** 展開したときの画素数の見積もり。GIF は各フレームの面積の合計。文書全体の上限に数える。 */
	readonly pixels: number;
	/** 画像の終わりの次のバイト位置。表示へはここまでを渡す（後ろに付いたデータは切る）。 */
	readonly end: number;
}

export interface ParadisWordImageInspectionLimits {
	/** 1 枚の画像のバイト数の上限。 */
	readonly bytes: number;
	/** 幅×高さの上限（展開したときのメモリを抑える）。 */
	readonly pixels: number;
	/** 幅・高さそれぞれの上限。 */
	readonly side: number;
	/** GIF のフレーム数の上限。 */
	readonly frames: number;
}

export const PARADIS_WORD_IMAGE_LIMITS: ParadisWordImageInspectionLimits = Object.freeze({
	bytes: 16 * 1024 * 1024,
	pixels: 50_000_000,
	side: 32_767,
	frames: 1_000,
});

/** 1 つの文書で描く画像の画素数の合計の上限。超えた画像は箱にする。 */
export const PARADIS_WORD_DOCUMENT_IMAGE_PIXELS = 100_000_000;

const pngSignature = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

let crcTable: Uint32Array | undefined;

function crc32(bytes: Uint8Array, start: number, end: number): number {
	const table = crcTable ??= (() => {
		const values = new Uint32Array(256);
		for (let index = 0; index < 256; index++) {
			let value = index;
			for (let bit = 0; bit < 8; bit++) {
				value = (value & 1) ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
			}
			values[index] = value >>> 0;
		}
		return values;
	})();
	let crc = 0xffffffff;
	for (let index = start; index < end; index++) {
		crc = table[(crc ^ bytes[index]) & 0xff] ^ (crc >>> 8);
	}
	return (crc ^ 0xffffffff) >>> 0;
}

function readUint32(bytes: Uint8Array, offset: number): number {
	return ((bytes[offset] << 24) | (bytes[offset + 1] << 16) | (bytes[offset + 2] << 8) | bytes[offset + 3]) >>> 0;
}

function readUint16(bytes: Uint8Array, offset: number): number {
	return (bytes[offset] << 8) | bytes[offset + 1];
}

function readUint16LittleEndian(bytes: Uint8Array, offset: number): number {
	return bytes[offset] | (bytes[offset + 1] << 8);
}

function withinLimits(width: number, height: number, limits: ParadisWordImageInspectionLimits): boolean {
	return width > 0 && height > 0 && width <= limits.side && height <= limits.side && width * height <= limits.pixels;
}

function ascii(bytes: Uint8Array, offset: number, length: number): string {
	let value = '';
	for (let index = 0; index < length; index++) {
		value += String.fromCharCode(bytes[offset + index]);
	}
	return value;
}

/**
 * PNG: 署名、最初のチャンクが 13 バイトの IHDR、CRC の合うチャンク列、IEND で終わる。アニメーション
 * （`acTL` を持つ APNG）は通さない。
 */
function inspectPng(bytes: Uint8Array, limits: ParadisWordImageInspectionLimits): ParadisWordRasterImage | undefined {
	if (bytes.byteLength < 8 + 25 + 12 || pngSignature.some((value, index) => bytes[index] !== value)) {
		return undefined;
	}
	if (readUint32(bytes, 8) !== 13 || ascii(bytes, 12, 4) !== 'IHDR') {
		return undefined;
	}
	const width = readUint32(bytes, 16);
	const height = readUint32(bytes, 20);
	const bitDepth = bytes[24];
	const colorType = bytes[25];
	if (!withinLimits(width, height, limits) || ![1, 2, 4, 8, 16].includes(bitDepth) || ![0, 2, 3, 4, 6].includes(colorType)
		|| bytes[26] !== 0 || bytes[27] !== 0 || bytes[28] > 1) {
		return undefined;
	}
	let offset = 8;
	let sawData = false;
	while (offset + 12 <= bytes.byteLength) {
		const length = readUint32(bytes, offset);
		const type = ascii(bytes, offset + 4, 4);
		const dataEnd = offset + 8 + length;
		if (!/^[A-Za-z]{4}$/.test(type) || dataEnd + 4 > bytes.byteLength) {
			return undefined;
		}
		// CRC は型とデータにかかる（PNG §5.3）。
		if (crc32(bytes, offset + 4, dataEnd) !== readUint32(bytes, dataEnd)) {
			return undefined;
		}
		if (type === 'acTL') {
			return undefined;
		}
		if (type === 'IDAT') {
			sawData = true;
		}
		offset = dataEnd + 4;
		if (type === 'IEND') {
			return sawData ? { format: 'png', mimeType: 'image/png', width, height, pixels: width * height, end: offset } : undefined;
		}
	}
	return undefined;
}

/**
 * JPEG: SOI から始まり、セグメントを長さで辿って SOF の大きさを読む。SOS の後は、詰め物（FF 00）と
 * 再同期マーカー（RST）を飛ばし、プログレッシブの途中のセグメントは長さで飛ばして、最初の EOI で終わる。
 */
function inspectJpeg(bytes: Uint8Array, limits: ParadisWordImageInspectionLimits): ParadisWordRasterImage | undefined {
	if (bytes.byteLength < 4 || bytes[0] !== 0xff || bytes[1] !== 0xd8) {
		return undefined;
	}
	let offset = 2;
	let size: { readonly width: number; readonly height: number } | undefined;
	let scanning = false;
	while (offset + 1 < bytes.byteLength) {
		if (scanning && bytes[offset] !== 0xff) {
			offset++;
			continue;
		}
		if (bytes[offset] !== 0xff) {
			return undefined;
		}
		const marker = bytes[offset + 1];
		if (marker === 0xff) {
			offset++;
			continue;
		}
		if (scanning && (marker === 0x00 || (marker >= 0xd0 && marker <= 0xd7))) {
			offset += 2;
			continue;
		}
		if (marker === 0xd9) {
			return scanning && size ? { format: 'jpeg', mimeType: 'image/jpeg', width: size.width, height: size.height, pixels: size.width * size.height, end: offset + 2 } : undefined;
		}
		if (marker === 0xd8 || (marker >= 0xd0 && marker <= 0xd7) || marker === 0x01 || marker === 0x00) {
			return undefined;
		}
		if (offset + 4 > bytes.byteLength) {
			return undefined;
		}
		const length = readUint16(bytes, offset + 2);
		if (length < 2 || offset + 2 + length > bytes.byteLength) {
			return undefined;
		}
		const isStartOfFrame = marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc;
		if (isStartOfFrame) {
			if (length < 8 || size) {
				return undefined;
			}
			size = { height: readUint16(bytes, offset + 5), width: readUint16(bytes, offset + 7) };
			if (!withinLimits(size.width, size.height, limits)) {
				return undefined;
			}
		}
		if (marker === 0xda) {
			if (!size) {
				return undefined;
			}
			scanning = true;
		}
		offset += 2 + length;
	}
	return undefined;
}

/** GIF のデータの小ブロック列（長さ 0 で終わる）を飛ばし、次の位置を返す。 */
function skipGifSubBlocks(bytes: Uint8Array, offset: number): number | undefined {
	while (offset < bytes.byteLength) {
		const length = bytes[offset];
		offset += 1 + length;
		if (length === 0) {
			return offset;
		}
	}
	return undefined;
}

/**
 * GIF: GIF87a/GIF89a の署名と論理画面、続く拡張ブロックと画像記述子を辿り、トレーラ（0x3B）で終わる。
 * フレームの数に上限を付け、各フレームが論理画面の中に収まることを確かめる。
 */
function inspectGif(bytes: Uint8Array, limits: ParadisWordImageInspectionLimits): ParadisWordRasterImage | undefined {
	if (bytes.byteLength < 14) {
		return undefined;
	}
	const signature = ascii(bytes, 0, 6);
	if (signature !== 'GIF87a' && signature !== 'GIF89a') {
		return undefined;
	}
	const width = readUint16LittleEndian(bytes, 6);
	const height = readUint16LittleEndian(bytes, 8);
	if (!withinLimits(width, height, limits)) {
		return undefined;
	}
	const screenFlags = bytes[10];
	let offset = 13 + ((screenFlags & 0x80) ? 3 * (1 << ((screenFlags & 0x07) + 1)) : 0);
	let frames = 0;
	let pixels = 0;
	while (offset < bytes.byteLength) {
		const introducer = bytes[offset];
		if (introducer === 0x3b) {
			return frames > 0 ? { format: 'gif', mimeType: 'image/gif', width, height, pixels, end: offset + 1 } : undefined;
		}
		if (introducer === 0x21) {
			if (offset + 2 > bytes.byteLength) {
				return undefined;
			}
			const next = skipGifSubBlocks(bytes, offset + 2);
			if (next === undefined) {
				return undefined;
			}
			offset = next;
			continue;
		}
		if (introducer !== 0x2c || offset + 10 > bytes.byteLength) {
			return undefined;
		}
		const left = readUint16LittleEndian(bytes, offset + 1);
		const top = readUint16LittleEndian(bytes, offset + 3);
		const frameWidth = readUint16LittleEndian(bytes, offset + 5);
		const frameHeight = readUint16LittleEndian(bytes, offset + 7);
		const frameFlags = bytes[offset + 9];
		if (frameWidth === 0 || frameHeight === 0 || left + frameWidth > width || top + frameHeight > height || ++frames > limits.frames) {
			return undefined;
		}
		pixels += frameWidth * frameHeight;
		if (pixels > limits.pixels) {
			return undefined;
		}
		offset += 10 + ((frameFlags & 0x80) ? 3 * (1 << ((frameFlags & 0x07) + 1)) : 0);
		// LZW の最小符号長（1 バイト、1〜8）と、画像データの小ブロック列。
		if (offset >= bytes.byteLength || bytes[offset] < 1 || bytes[offset] > 8) {
			return undefined;
		}
		const next = skipGifSubBlocks(bytes, offset + 1);
		if (next === undefined) {
			return undefined;
		}
		offset = next;
	}
	return undefined;
}

/**
 * 画像の中身を確かめ、表示してよい形式なら形式と大きさを返す。表示してはいけないもの（壊れている、
 * 大きすぎる、動く PNG、PNG・JPEG・GIF 以外）は undefined。
 */
export function inspectParadisWordRasterImage(bytes: Uint8Array, limits: ParadisWordImageInspectionLimits = PARADIS_WORD_IMAGE_LIMITS): ParadisWordRasterImage | undefined {
	return inspectParadisWordRasterImageWithReason(bytes, limits).image;
}

/** 画像を表示しない理由。`tooLarge` は、1 枚のバイト数・画素数・一辺・GIF のフレーム数の上限を越えたもの。 */
export type ParadisWordRasterRejection = 'tooLarge' | 'invalid';

export type ParadisWordRasterInspection =
	| { readonly image: ParadisWordRasterImage; readonly rejection?: undefined }
	| { readonly image?: undefined; readonly rejection: ParadisWordRasterRejection };

/** 上限を外して読み直すときの上限（バイト数は元のまま。読む量は変わらない）。 */
const UNBOUNDED_DIMENSIONS = { pixels: Number.MAX_SAFE_INTEGER, side: Number.MAX_SAFE_INTEGER, frames: Number.MAX_SAFE_INTEGER };

/**
 * `inspectParadisWordRasterImage` と同じ検査をし、表示しないときはその理由も返す。上限を越えたかどうかは、
 * 大きさの上限だけを外して読み直し、それで通るかで見分ける（壊れた画像を「大きすぎる」と言わないため）。
 */
export function inspectParadisWordRasterImageWithReason(bytes: Uint8Array, limits: ParadisWordImageInspectionLimits = PARADIS_WORD_IMAGE_LIMITS): ParadisWordRasterInspection {
	if (!(bytes instanceof Uint8Array) || bytes.byteLength === 0) {
		return { rejection: 'invalid' };
	}
	if (bytes.byteLength > limits.bytes) {
		return { rejection: 'tooLarge' };
	}
	const image = inspectPng(bytes, limits) ?? inspectJpeg(bytes, limits) ?? inspectGif(bytes, limits);
	if (image) {
		return { image };
	}
	const relaxed = { ...limits, ...UNBOUNDED_DIMENSIONS };
	return { rejection: inspectPng(bytes, relaxed) ?? inspectJpeg(bytes, relaxed) ?? inspectGif(bytes, relaxed) ? 'tooLarge' : 'invalid' };
}
