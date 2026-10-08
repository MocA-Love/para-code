/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-PATCH/PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

// Word に埋め込まれた画像（PNG・JPEG・GIF）を、表示へ渡す前に中身で確かめる（Q312 A）。
// 拡張子や content type は信じず、先頭の署名と、大きさを決める構造（PNG の IHDR、JPEG の SOF、GIF の
// 論理画面）を読む。画像を展開はしない。ここで通らなかったもの、EMF・WMF・TIFF などは、これまでどおり
// 代替表示の箱にする。

export type ParadisWordRasterFormat = 'png' | 'jpeg' | 'gif';

export interface ParadisWordRasterImage {
	readonly format: ParadisWordRasterFormat;
	readonly mimeType: 'image/png' | 'image/jpeg' | 'image/gif';
	readonly width: number;
	readonly height: number;
}

export interface ParadisWordImageInspectionLimits {
	/** 1 枚の画像のバイト数の上限。 */
	readonly bytes: number;
	/** 幅×高さの上限（展開したときのメモリを抑える）。 */
	readonly pixels: number;
	/** 幅・高さそれぞれの上限。 */
	readonly side: number;
}

export const PARADIS_WORD_IMAGE_LIMITS: ParadisWordImageInspectionLimits = Object.freeze({
	bytes: 16 * 1024 * 1024,
	pixels: 50_000_000,
	side: 32_767,
});

const pngSignature = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

function readUint32(bytes: Uint8Array, offset: number): number {
	return ((bytes[offset] << 24) | (bytes[offset + 1] << 16) | (bytes[offset + 2] << 8) | bytes[offset + 3]) >>> 0;
}

function readUint16(bytes: Uint8Array, offset: number): number {
	return (bytes[offset] << 8) | bytes[offset + 1];
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

/** PNG: 署名、最初のチャンクが 13 バイトの IHDR、末尾まで辿れるチャンク列、最後が IEND。 */
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
		if (!/^[A-Za-z]{4}$/.test(type) || offset + 12 + length > bytes.byteLength) {
			return undefined;
		}
		if (type === 'IDAT') {
			sawData = true;
		}
		offset += 12 + length;
		if (type === 'IEND') {
			return sawData ? { format: 'png', mimeType: 'image/png', width, height } : undefined;
		}
	}
	return undefined;
}

/** JPEG: SOI から始まり、SOS より前のセグメントを長さで辿って SOF の大きさを読む。 */
function inspectJpeg(bytes: Uint8Array, limits: ParadisWordImageInspectionLimits): ParadisWordRasterImage | undefined {
	if (bytes.byteLength < 4 || bytes[0] !== 0xff || bytes[1] !== 0xd8) {
		return undefined;
	}
	let offset = 2;
	let size: { readonly width: number; readonly height: number } | undefined;
	while (offset + 4 <= bytes.byteLength) {
		if (bytes[offset] !== 0xff) {
			return undefined;
		}
		const marker = bytes[offset + 1];
		if (marker === 0xff) {
			offset++;
			continue;
		}
		if (marker === 0xd8 || marker === 0xd9 || (marker >= 0xd0 && marker <= 0xd7) || marker === 0x01) {
			return undefined;
		}
		const length = readUint16(bytes, offset + 2);
		if (length < 2 || offset + 2 + length > bytes.byteLength) {
			return undefined;
		}
		const isStartOfFrame = marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc;
		if (isStartOfFrame) {
			if (length < 8) {
				return undefined;
			}
			size = { height: readUint16(bytes, offset + 5), width: readUint16(bytes, offset + 7) };
		}
		if (marker === 0xda) {
			// 画像データ本体。ここから先は読まず、末尾が EOI かだけを見る。
			if (!size || !withinLimits(size.width, size.height, limits)) {
				return undefined;
			}
			let end = bytes.byteLength;
			while (end > offset && bytes[end - 1] === 0x00) {
				end--;
			}
			return end >= 2 && bytes[end - 2] === 0xff && bytes[end - 1] === 0xd9 ? { format: 'jpeg', mimeType: 'image/jpeg', width: size.width, height: size.height } : undefined;
		}
		offset += 2 + length;
	}
	return undefined;
}

/** GIF: GIF87a/GIF89a の署名と論理画面の大きさ、末尾のトレーラ（0x3B）。 */
function inspectGif(bytes: Uint8Array, limits: ParadisWordImageInspectionLimits): ParadisWordRasterImage | undefined {
	if (bytes.byteLength < 14) {
		return undefined;
	}
	const signature = ascii(bytes, 0, 6);
	if (signature !== 'GIF87a' && signature !== 'GIF89a') {
		return undefined;
	}
	const width = bytes[6] | (bytes[7] << 8);
	const height = bytes[8] | (bytes[9] << 8);
	if (!withinLimits(width, height, limits) || bytes[bytes.byteLength - 1] !== 0x3b) {
		return undefined;
	}
	return { format: 'gif', mimeType: 'image/gif', width, height };
}

/**
 * 画像の中身を確かめ、表示してよい形式なら形式と大きさを返す。表示してはいけないもの（壊れている、
 * 大きすぎる、PNG・JPEG・GIF 以外）は undefined。
 */
export function inspectParadisWordRasterImage(bytes: Uint8Array, limits: ParadisWordImageInspectionLimits = PARADIS_WORD_IMAGE_LIMITS): ParadisWordRasterImage | undefined {
	if (!(bytes instanceof Uint8Array) || bytes.byteLength === 0 || bytes.byteLength > limits.bytes) {
		return undefined;
	}
	return inspectPng(bytes, limits) ?? inspectJpeg(bytes, limits) ?? inspectGif(bytes, limits);
}
