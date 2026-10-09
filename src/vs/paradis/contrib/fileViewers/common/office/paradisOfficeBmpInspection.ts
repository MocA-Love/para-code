/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-PATCH/PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

// Office に貼られた BMP の画像を、表示へ渡す前に中身で確かめる。画素は展開せず、ファイルの見出し
// （BITMAPFILEHEADER）と DIB の見出しを読み、大きさ・色の数・圧縮の種類と、色の表・画素のデータが
// ファイルの中に収まることを見る。通ったものは、ファイルの見出しが言う長さで切って、そのまま
// `image/bmp` としてブラウザの画像の読み込みに渡す（PNG へは変換しない）。JPEG・PNG を中に入れた BMP
// （圧縮 4・5）と、知らない見出しは通さない。

import { PARADIS_WORD_IMAGE_LIMITS, type ParadisWordImageInspectionLimits } from '../word/paradisWordImageInspection.js';

export interface ParadisOfficeBmpImage {
	readonly mimeType: 'image/bmp';
	readonly width: number;
	readonly height: number;
	readonly pixels: number;
	/** 画像の終わりの次のバイト位置（ファイルの見出しが言う長さ）。表示へはここまでを渡す。 */
	readonly end: number;
}

export type ParadisOfficeBmpInspection =
	| { readonly image: ParadisOfficeBmpImage; readonly rejection?: undefined }
	| { readonly image?: undefined; readonly rejection: 'tooLarge' | 'invalid' };

/** DIB の見出しの長さ（BITMAPCOREHEADER・BITMAPINFOHEADER・V2・V3・V4・V5）。 */
const DIB_HEADER_SIZES = new Set([12, 40, 52, 56, 108, 124]);
const BI_RGB = 0;
const BI_RLE8 = 1;
const BI_RLE4 = 2;
const BI_BITFIELDS = 3;
const BI_ALPHABITFIELDS = 6;

function uint16(bytes: Uint8Array, offset: number): number {
	return bytes[offset] | (bytes[offset + 1] << 8);
}

function uint32(bytes: Uint8Array, offset: number): number {
	return (bytes[offset] | (bytes[offset + 1] << 8) | (bytes[offset + 2] << 16) | (bytes[offset + 3] << 24)) >>> 0;
}

function int32(bytes: Uint8Array, offset: number): number {
	return bytes[offset] | (bytes[offset + 1] << 8) | (bytes[offset + 2] << 16) | (bytes[offset + 3] << 24);
}

/** BMP の中身を確かめる。表示しないときは、大きすぎる（`tooLarge`）か、それ以外（`invalid`）かを返す。 */
export function inspectParadisOfficeBmp(bytes: Uint8Array, limits: ParadisWordImageInspectionLimits = PARADIS_WORD_IMAGE_LIMITS): ParadisOfficeBmpInspection {
	if (!(bytes instanceof Uint8Array) || bytes.byteLength < 26 || bytes[0] !== 0x42 || bytes[1] !== 0x4d) {
		return { rejection: 'invalid' };
	}
	const fileSize = uint32(bytes, 2);
	if (fileSize > limits.bytes) {
		return { rejection: 'tooLarge' };
	}
	const dataOffset = uint32(bytes, 10);
	const dibSize = uint32(bytes, 14);
	if (fileSize < 26 || fileSize > bytes.byteLength || !DIB_HEADER_SIZES.has(dibSize) || 14 + dibSize > dataOffset || dataOffset >= fileSize) {
		return { rejection: 'invalid' };
	}
	const core = dibSize === 12;
	const width = core ? uint16(bytes, 18) : int32(bytes, 18);
	const signedHeight = core ? uint16(bytes, 20) : int32(bytes, 22);
	const planes = core ? uint16(bytes, 22) : uint16(bytes, 26);
	const bitCount = core ? uint16(bytes, 24) : uint16(bytes, 28);
	const compression = core ? BI_RGB : uint32(bytes, 30);
	const height = Math.abs(signedHeight);
	if (planes !== 1 || width <= 0 || height === 0 || ![1, 4, 8, 16, 24, 32].includes(bitCount)) {
		return { rejection: 'invalid' };
	}
	const compressed = compression === BI_RLE8 || compression === BI_RLE4;
	const supported = compression === BI_RGB
		|| (compression === BI_RLE8 && bitCount === 8)
		|| (compression === BI_RLE4 && bitCount === 4)
		|| ((compression === BI_BITFIELDS || compression === BI_ALPHABITFIELDS) && (bitCount === 16 || bitCount === 32));
	// 上から下へ並ぶ画素（高さが負）は、圧縮と組み合わせられない。
	if (!supported || (compressed && signedHeight < 0)) {
		return { rejection: 'invalid' };
	}
	// BITMAPINFOHEADER の色のマスク（BITFIELDS は 3 つ、ALPHABITFIELDS は 4 つ）は、見出しの後ろに置かれる。
	const masks = dibSize === 40 && compression === BI_BITFIELDS ? 12 : dibSize === 40 && compression === BI_ALPHABITFIELDS ? 16 : 0;
	if (14 + dibSize + masks > dataOffset) {
		return { rejection: 'invalid' };
	}
	// 色の表（8 ビット以下）は、DIB の見出しと画素のデータの間に収まること。
	if (bitCount <= 8) {
		const used = core ? 0 : uint32(bytes, 46);
		const colors = used === 0 ? 2 ** bitCount : used;
		if (colors > 2 ** bitCount || 14 + dibSize + colors * (core ? 3 : 4) > dataOffset) {
			return { rejection: 'invalid' };
		}
	}
	if (compressed) {
		const imageSize = uint32(bytes, 34);
		if (imageSize === 0 || dataOffset + imageSize > fileSize) {
			return { rejection: 'invalid' };
		}
	} else {
		const rowBytes = Math.floor((bitCount * width + 31) / 32) * 4;
		if (rowBytes * height > fileSize - dataOffset) {
			return { rejection: 'invalid' };
		}
	}
	if (width > limits.side || height > limits.side || width * height > limits.pixels) {
		return { rejection: 'tooLarge' };
	}
	return { image: { mimeType: 'image/bmp', width, height, pixels: width * height, end: fileSize } };
}
