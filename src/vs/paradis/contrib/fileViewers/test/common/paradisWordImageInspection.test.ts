/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import { deepStrictEqual } from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { inspectParadisWordRasterImage } from '../../common/word/paradisWordImageInspection.js';

function uint32(value: number): number[] {
	return [(value >>> 24) & 0xff, (value >>> 16) & 0xff, (value >>> 8) & 0xff, value & 0xff];
}

function chunk(type: string, data: readonly number[]): number[] {
	// The inspector does not verify CRCs (the renderer decodes the image itself); zeros are enough here.
	return [...uint32(data.length), ...[...type].map(character => character.charCodeAt(0)), ...data, 0, 0, 0, 0];
}

function png(width: number, height: number, options: { readonly end?: boolean; readonly data?: boolean } = {}): Uint8Array {
	return new Uint8Array([
		0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
		...chunk('IHDR', [...uint32(width), ...uint32(height), 8, 6, 0, 0, 0]),
		...(options.data === false ? [] : chunk('IDAT', [0x78, 0x9c, 0x63, 0x00, 0x00])),
		...(options.end === false ? [] : chunk('IEND', [])),
	]);
}

function jpeg(width: number, height: number, trailer = [0xff, 0xd9]): Uint8Array {
	return new Uint8Array([
		0xff, 0xd8,
		0xff, 0xe0, 0x00, 0x04, 0x4a, 0x46,
		0xff, 0xc0, 0x00, 0x0b, 0x08, height >> 8, height & 0xff, width >> 8, width & 0xff, 0x01, 0x01, 0x11, 0x00,
		0xff, 0xda, 0x00, 0x08, 0x01, 0x01, 0x00, 0x00, 0x3f, 0x00,
		0x12, 0x34,
		...trailer,
	]);
}

function gif(width: number, height: number, trailer = 0x3b): Uint8Array {
	return new Uint8Array([...'GIF89a'].map(character => character.charCodeAt(0)).concat([width & 0xff, width >> 8, height & 0xff, height >> 8, 0, 0, 0, 0x2c, 0, 0, trailer]));
}

suite('ParadisWordImageInspection', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	test('accepts structurally complete PNG, JPEG, and GIF images and rejects everything else', () => {
		const emf = new Uint8Array([0x01, 0x00, 0x00, 0x00, 0x6c, 0x00, 0x00, 0x00, 0x20, 0x45, 0x4d, 0x46]);
		const results = {
			png: inspectParadisWordRasterImage(png(3, 2)),
			jpeg: inspectParadisWordRasterImage(jpeg(5, 4)),
			gif: inspectParadisWordRasterImage(gif(7, 6)),
			truncatedPng: inspectParadisWordRasterImage(png(3, 2, { end: false })),
			pngWithoutData: inspectParadisWordRasterImage(png(3, 2, { data: false })),
			hugePng: inspectParadisWordRasterImage(png(100_000, 100_000)),
			jpegWithoutEnd: inspectParadisWordRasterImage(jpeg(5, 4, [0x56, 0x78])),
			gifWithoutTrailer: inspectParadisWordRasterImage(gif(7, 6, 0x00)),
			emptyGif: inspectParadisWordRasterImage(gif(0, 6)),
			emf: inspectParadisWordRasterImage(emf),
		};
		deepStrictEqual(results, {
			png: { format: 'png', mimeType: 'image/png', width: 3, height: 2 },
			jpeg: { format: 'jpeg', mimeType: 'image/jpeg', width: 5, height: 4 },
			gif: { format: 'gif', mimeType: 'image/gif', width: 7, height: 6 },
			truncatedPng: undefined,
			pngWithoutData: undefined,
			hugePng: undefined,
			jpegWithoutEnd: undefined,
			gifWithoutTrailer: undefined,
			emptyGif: undefined,
			emf: undefined,
		});
	});
});
