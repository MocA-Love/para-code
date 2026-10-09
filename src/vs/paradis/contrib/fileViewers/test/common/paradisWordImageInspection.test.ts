/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import { deepStrictEqual } from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { inspectParadisWordRasterImage, inspectParadisWordRasterImageWithReason, PARADIS_WORD_IMAGE_LIMITS } from '../../common/word/paradisWordImageInspection.js';
import { minimalGif, minimalJpeg, minimalPng, pngChunk } from './paradisWordImageFixture.js';

suite('ParadisWordImageInspection', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	test('accepts structurally complete still PNG, JPEG, and GIF images and rejects everything else', () => {
		const emf = new Uint8Array([0x01, 0x00, 0x00, 0x00, 0x6c, 0x00, 0x00, 0x00, 0x20, 0x45, 0x4d, 0x46]);
		const png = minimalPng(3, 2);
		const crcBroken = png.slice();
		crcBroken[29] ^= 0xff;
		const results = {
			png: inspectParadisWordRasterImage(png),
			jpeg: inspectParadisWordRasterImage(minimalJpeg(5, 4)),
			gif: inspectParadisWordRasterImage(minimalGif(7, 6)),
			truncatedPng: inspectParadisWordRasterImage(minimalPng(3, 2, { end: false })),
			pngWithoutData: inspectParadisWordRasterImage(minimalPng(3, 2, { data: false })),
			pngWithBrokenCrc: inspectParadisWordRasterImage(crcBroken),
			animatedPng: inspectParadisWordRasterImage(minimalPng(3, 2, { before: pngChunk('acTL', [0, 0, 0, 2, 0, 0, 0, 0]) })),
			hugePng: inspectParadisWordRasterImage(minimalPng(100_000, 100_000)),
			jpegWithoutEnd: inspectParadisWordRasterImage(minimalJpeg(5, 4, [0x56, 0x78])),
			gifWithoutTrailer: inspectParadisWordRasterImage(minimalGif(7, 6, { trailer: false })),
			gifWithoutFrames: inspectParadisWordRasterImage(minimalGif(7, 6, { frames: 0 })),
			gifTooManyFrames: inspectParadisWordRasterImage(minimalGif(7, 6, { frames: 1_001 })),
			gifFrameOutsideScreen: inspectParadisWordRasterImage(minimalGif(7, 6, { frameWidth: 8 })),
			gifLzwCodeSizeZero: inspectParadisWordRasterImage(minimalGif(7, 6, { lzwMinimumCodeSize: 0 })),
			gifLzwCodeSizeNine: inspectParadisWordRasterImage(minimalGif(7, 6, { lzwMinimumCodeSize: 9 })),
			emptyGif: inspectParadisWordRasterImage(minimalGif(0, 6)),
			svgNamedPng: inspectParadisWordRasterImage(new TextEncoder().encode('<svg xmlns="http://www.w3.org/2000/svg"/>')),
			emf: inspectParadisWordRasterImage(emf),
		};
		deepStrictEqual(results, {
			png: { format: 'png', mimeType: 'image/png', width: 3, height: 2, pixels: 6, end: png.byteLength },
			jpeg: { format: 'jpeg', mimeType: 'image/jpeg', width: 5, height: 4, pixels: 20, end: minimalJpeg(5, 4).byteLength },
			gif: { format: 'gif', mimeType: 'image/gif', width: 7, height: 6, pixels: 42, end: minimalGif(7, 6).byteLength },
			truncatedPng: undefined,
			pngWithoutData: undefined,
			pngWithBrokenCrc: undefined,
			animatedPng: undefined,
			hugePng: undefined,
			jpegWithoutEnd: undefined,
			gifWithoutTrailer: undefined,
			gifWithoutFrames: undefined,
			gifTooManyFrames: undefined,
			gifFrameOutsideScreen: undefined,
			gifLzwCodeSizeZero: undefined,
			gifLzwCodeSizeNine: undefined,
			emptyGif: undefined,
			svgNamedPng: undefined,
			emf: undefined,
		});
	});

	test('tells an image that is only too large from one that is broken', () => {
		const reason = (bytes: Uint8Array, limits = PARADIS_WORD_IMAGE_LIMITS) => inspectParadisWordRasterImageWithReason(bytes, limits).rejection ?? 'shown';
		deepStrictEqual({
			shown: reason(minimalPng(3, 2)),
			tooWide: reason(minimalPng(40_000, 1)),
			tooManyPixels: reason(minimalJpeg(10_000, 10_000)),
			tooManyFrames: reason(minimalGif(7, 6, { frames: 1_001 })),
			tooManyBytes: reason(minimalPng(3, 2), { ...PARADIS_WORD_IMAGE_LIMITS, bytes: 16 }),
			broken: reason(minimalPng(3, 2, { end: false })),
			brokenAndWide: reason(minimalPng(40_000, 1, { end: false })),
			animated: reason(minimalPng(3, 2, { before: pngChunk('acTL', [0, 0, 0, 2, 0, 0, 0, 0]) })),
			empty: reason(new Uint8Array()),
		}, {
			shown: 'shown',
			tooWide: 'tooLarge',
			tooManyPixels: 'tooLarge',
			tooManyFrames: 'tooLarge',
			tooManyBytes: 'tooLarge',
			broken: 'invalid',
			brokenAndWide: 'invalid',
			animated: 'invalid',
			empty: 'invalid',
		});
	});

	test('ends each image at its end marker so trailing data can be cut', () => {
		const html = [...new TextEncoder().encode('<html><script>alert(1)</script></html>')];
		const png = minimalPng(3, 2);
		const jpeg = minimalJpeg(5, 4);
		const gif = minimalGif(7, 6, { frames: 3 });
		deepStrictEqual([
			inspectParadisWordRasterImage(Uint8Array.from([...png, ...html]))?.end,
			inspectParadisWordRasterImage(Uint8Array.from([...jpeg, ...html]))?.end,
			inspectParadisWordRasterImage(Uint8Array.from([...gif, ...html]))?.end,
			inspectParadisWordRasterImage(gif)?.pixels,
		], [png.byteLength, jpeg.byteLength, gif.byteLength, 3 * 42]);
	});

	test('does not stop at the end marker of an EXIF thumbnail inside APP1', () => {
		// An APP1 segment that carries its own small JPEG (FFD8 … FFD9) before the real image.
		const thumbnail = [...new TextEncoder().encode('Exif'), 0, 0, ...minimalJpeg(1, 1)];
		const jpeg = minimalJpeg(5, 4, [0xff, 0xd9], thumbnail);
		deepStrictEqual(inspectParadisWordRasterImage(jpeg), { format: 'jpeg', mimeType: 'image/jpeg', width: 5, height: 4, pixels: 20, end: jpeg.byteLength });
	});
});
