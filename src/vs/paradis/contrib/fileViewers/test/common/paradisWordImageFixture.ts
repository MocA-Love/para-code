/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

// Minimal invented images for the image inspection tests. None of them comes from a real file.

function uint32(value: number): number[] {
	return [(value >>> 24) & 0xff, (value >>> 16) & 0xff, (value >>> 8) & 0xff, value & 0xff];
}

function crc32(bytes: readonly number[]): number {
	let crc = 0xffffffff;
	for (const byte of bytes) {
		crc ^= byte;
		for (let bit = 0; bit < 8; bit++) {
			crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0);
		}
	}
	return (crc ^ 0xffffffff) >>> 0;
}

/** One PNG chunk with its CRC. */
export function pngChunk(type: string, data: readonly number[]): number[] {
	const typed = [...[...type].map(character => character.charCodeAt(0)), ...data];
	return [...uint32(data.length), ...typed, ...uint32(crc32(typed))];
}

export function minimalPng(width: number, height: number, options: { readonly end?: boolean; readonly data?: boolean; readonly before?: readonly number[] } = {}): Uint8Array {
	return new Uint8Array([
		0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
		...pngChunk('IHDR', [...uint32(width), ...uint32(height), 8, 6, 0, 0, 0]),
		...(options.before ?? []),
		...(options.data === false ? [] : pngChunk('IDAT', [0x78, 0x9c, 0x63, 0x00, 0x00])),
		...(options.end === false ? [] : pngChunk('IEND', [])),
	]);
}

export function minimalJpeg(width: number, height: number, trailer = [0xff, 0xd9]): Uint8Array {
	return new Uint8Array([
		0xff, 0xd8,
		0xff, 0xe0, 0x00, 0x04, 0x4a, 0x46,
		0xff, 0xc0, 0x00, 0x0b, 0x08, height >> 8, height & 0xff, width >> 8, width & 0xff, 0x01, 0x01, 0x11, 0x00,
		0xff, 0xda, 0x00, 0x08, 0x01, 0x01, 0x00, 0x00, 0x3f, 0x00,
		0x12, 0xff, 0x00, 0x34,
		...trailer,
	]);
}

export function minimalGif(width: number, height: number, options: { readonly frames?: number; readonly frameWidth?: number; readonly trailer?: boolean } = {}): Uint8Array {
	const frame = (index: number) => [
		// Graphic control extension, then an image descriptor with no local color table and one data sub-block.
		0x21, 0xf9, 0x04, 0x00, index & 0xff, 0x00, 0x00, 0x00,
		0x2c, 0, 0, 0, 0, (options.frameWidth ?? width) & 0xff, (options.frameWidth ?? width) >> 8, height & 0xff, height >> 8, 0x00,
		0x02, 0x02, 0x44, 0x01, 0x00,
	];
	const frames: number[] = [];
	for (let index = 0; index < (options.frames ?? 1); index++) {
		frames.push(...frame(index));
	}
	return new Uint8Array([
		...[...'GIF89a'].map(character => character.charCodeAt(0)),
		width & 0xff, width >> 8, height & 0xff, height >> 8, 0x00, 0x00, 0x00,
		...frames,
		...(options.trailer === false ? [] : [0x3b]),
	]);
}
