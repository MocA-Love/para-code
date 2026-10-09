/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

/** Invented minimal BMP (BITMAPINFOHEADER). Pixel data is zeros; only the layout matters to the inspector. */
export function minimalBmp(width: number, height: number, options: { readonly bitCount?: number; readonly compression?: number; readonly colors?: number; readonly imageSize?: number; readonly trailer?: number; readonly pixelBytes?: number } = {}): Uint8Array {
	const bitCount = options.bitCount ?? 24;
	const palette = bitCount <= 8 ? (options.colors ?? 2 ** bitCount) * 4 : options.compression === 3 ? 12 : options.compression === 6 ? 16 : 0;
	const rowBytes = Math.floor((bitCount * Math.abs(width) + 31) / 32) * 4;
	const pixelBytes = options.pixelBytes ?? (options.compression === 1 || options.compression === 2 ? (options.imageSize ?? 2) : rowBytes * Math.abs(height));
	const dataOffset = 14 + 40 + palette;
	const fileSize = dataOffset + pixelBytes;
	const bytes = new Uint8Array(fileSize + (options.trailer ?? 0));
	const view = new DataView(bytes.buffer);
	bytes[0] = 0x42; bytes[1] = 0x4d;
	view.setUint32(2, fileSize, true);
	view.setUint32(10, dataOffset, true);
	view.setUint32(14, 40, true);
	view.setInt32(18, width, true);
	view.setInt32(22, height, true);
	view.setUint16(26, 1, true);
	view.setUint16(28, bitCount, true);
	view.setUint32(30, options.compression ?? 0, true);
	view.setUint32(34, options.imageSize ?? 0, true);
	view.setUint32(46, options.colors ?? 0, true);
	return bytes;
}
