/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import { deepStrictEqual } from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { judgeParadisImageDecode, readParadisImageHeader } from '../../browser/image/paradisImageDimensions.js';

function bytes(...parts: (number[] | string | Uint8Array)[]): Uint8Array {
	const values: number[] = [];
	for (const part of parts) {
		values.push(...(typeof part === 'string' ? [...part].map(c => c.charCodeAt(0)) : part));
	}
	return new Uint8Array(values);
}
const be32 = (value: number) => [(value >>> 24) & 0xff, (value >>> 16) & 0xff, (value >>> 8) & 0xff, value & 0xff];
const be16 = (value: number) => [(value >>> 8) & 0xff, value & 0xff];
const le32 = (value: number) => [value & 0xff, (value >>> 8) & 0xff, (value >>> 16) & 0xff, (value >>> 24) & 0xff];
const le24 = (value: number) => [value & 0xff, (value >>> 8) & 0xff, (value >>> 16) & 0xff];
const le16 = (value: number) => [value & 0xff, (value >>> 8) & 0xff];

const png = (width: number, height: number) => bytes([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], be32(13), 'IHDR', be32(width), be32(height), [8, 6, 0, 0, 0]);
const jpeg = (width: number, height: number) => bytes([0xff, 0xd8, 0xff, 0xe0], be16(16), 'JFIF', [0, 1, 1, 0, 0, 1, 0, 1, 0, 0], [0xff, 0xc2], be16(17), [8], be16(height), be16(width), [3]);
const gif = (width: number, height: number) => bytes('GIF89a', le16(width), le16(height), [0, 0, 0]);
const webpVp8x = (width: number, height: number) => bytes('RIFF', le32(30), 'WEBP', 'VP8X', le32(10), [0, 0, 0, 0], le24(width - 1), le24(height - 1));
const webpVp8l = (width: number, height: number) => {
	const w = width - 1, h = height - 1;
	return bytes('RIFF', le32(30), 'WEBP', 'VP8L', le32(10), [0x2f, w & 0xff, ((w >> 8) & 0x3f) | ((h & 0x03) << 6), (h >> 2) & 0xff, (h >> 10) & 0x0f], [0, 0, 0, 0, 0]);
};
const bmp = (width: number, height: number) => bytes('BM', le32(0), le32(0), le32(54), le32(40), le32(width), le32(height), [1, 0, 32, 0]);
const icoWithPng = (width: number, height: number) => bytes([0, 0, 1, 0], le16(1), [0, 0, 0, 0, 1, 0, 32, 0], le32(33), le32(22), png(width, height));
const avif = (width: number, height: number) => bytes(be32(28), 'ftyp', 'avif', be32(0), 'avifmif1', be32(20), 'ispe', be32(0), be32(width), be32(height));

suite('ParadisImageDimensions', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	test('reads the size from the header of every raster format the viewer opens', () => {
		deepStrictEqual([
			png(577, 300), jpeg(4000, 3000), gif(320, 200), webpVp8x(5000, 4000), webpVp8l(1024, 768),
			bmp(640, -480), icoWithPng(512, 512), avif(8192, 4096), bytes('<svg/>'),
		].map(readParadisImageHeader), [
			{ format: 'png', width: 577, height: 300 },
			{ format: 'jpeg', width: 4000, height: 3000 },
			{ format: 'gif', width: 320, height: 200 },
			{ format: 'webp', width: 5000, height: 4000 },
			{ format: 'webp', width: 1024, height: 768 },
			{ format: 'bmp', width: 640, height: 480 },
			{ format: 'ico', width: 512, height: 512 },
			{ format: 'avif', width: 8192, height: 4096 },
			undefined,
		]);
	});

	test('refuses images that would decode to more pixels than the limit, and content that does not match an image', () => {
		const limit = 100_000_000;
		deepStrictEqual({
			small: judgeParadisImageDecode(png(4082, 4082), 'image/png', limit),
			pngBomb: judgeParadisImageDecode(png(20_000, 20_000), 'image/png', limit),
			jpegBombNamedWebp: judgeParadisImageDecode(jpeg(60_000, 60_000), 'image/webp', limit),
			gifBomb: judgeParadisImageDecode(gif(65_535, 65_535), 'image/gif', limit),
			icoWithPngBomb: judgeParadisImageDecode(icoWithPng(30_000, 30_000), 'image/x-icon', limit),
			avifBomb: judgeParadisImageDecode(avif(20_000, 20_000), 'image/avif', limit),
			avifWithoutSize: judgeParadisImageDecode(bytes(be32(16), 'ftyp', 'avif', be32(0)), 'image/avif', limit),
			svg: judgeParadisImageDecode(bytes('<svg xmlns="http://www.w3.org/2000/svg"/>'), 'image/svg+xml', limit),
			htmlNamedPng: judgeParadisImageDecode(bytes('<html><script>alert(1)</script></html>'), 'image/png', limit),
			truncatedJpeg: judgeParadisImageDecode(bytes([0xff, 0xd8, 0xff, 0xda, 0, 2]), 'image/jpeg', limit),
		}, {
			small: 'ok',
			pngBomb: 'tooLarge',
			jpegBombNamedWebp: 'tooLarge',
			gifBomb: 'tooLarge',
			icoWithPngBomb: 'tooLarge',
			avifBomb: 'tooLarge',
			avifWithoutSize: 'ok',
			svg: 'ok',
			htmlNamedPng: 'invalid',
			truncatedJpeg: 'invalid',
		});
	});
});
