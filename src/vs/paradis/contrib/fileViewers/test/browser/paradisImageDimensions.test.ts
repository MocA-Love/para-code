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
		for (const value of typeof part === 'string' ? [...part].map(c => c.charCodeAt(0)) : part) {
			values.push(value);
		}
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
/** GIF: logical screen, a graphic control extension, then one frame (left, top, width, height) with a tiny image data block. */
const gif = (width: number, height: number, frame = { left: 0, top: 0, width, height }) => bytes(
	'GIF89a', le16(width), le16(height), [0, 0, 0],
	[0x21, 0xf9, 4, 0, 0, 0, 0, 0],
	[0x2c], le16(frame.left), le16(frame.top), le16(frame.width), le16(frame.height), [0],
	[2, 2, 0x4c, 0x01, 0], [0x3b]);
const webpVp8x = (width: number, height: number) => bytes('RIFF', le32(30), 'WEBP', 'VP8X', le32(10), [0, 0, 0, 0], le24(width - 1), le24(height - 1));
const webpVp8l = (width: number, height: number) => {
	const w = width - 1, h = height - 1;
	return bytes('RIFF', le32(30), 'WEBP', 'VP8L', le32(10), [0x2f, w & 0xff, ((w >> 8) & 0x3f) | ((h & 0x03) << 6), (h >> 2) & 0xff, (h >> 10) & 0x0f], [0, 0, 0, 0, 0]);
};
const bmp = (width: number, height: number) => bytes('BM', le32(0), le32(0), le32(54), le32(40), le32(width), le32(height), [1, 0, 32, 0]);
const icoWithPng = (width: number, height: number) => bytes([0, 0, 1, 0], le16(1), [0, 0, 0, 0, 1, 0, 32, 0], le32(33), le32(22), png(width, height));
const box = (type: string, ...content: (number[] | string | Uint8Array)[]) => {
	const body = bytes(...content);
	return bytes(be32(8 + body.byteLength), type, body);
};
const ispe = (width: number, height: number) => box('ispe', be32(0), be32(width), be32(height));
const ftyp = box('ftyp', 'avif', be32(0), 'avifmif1');
const meta = (...properties: Uint8Array[]) => box('meta', be32(0), box('hdlr', be32(0), be32(0), 'pict', be32(0), be32(0), be32(0), [0]), box('iprp', box('ipco', ...properties), box('ipma', be32(0), be32(0))));
const avif = (width: number, height: number) => bytes(ftyp, meta(ispe(width, height)), box('mdat', [0, 0, 0, 0]));
/** Animated AVIF (brand avis): one track whose sample description is an av01 visual sample entry, or another codec. */
const ftypAvis = box('ftyp', 'avis', be32(0), 'avismif1');
const trak = (codec: string, width: number, height: number) => box('trak', box('tkhd', new Uint8Array(84)), box('mdia', box('mdhd', new Uint8Array(24)), box('minf', box('stbl',
	box('stsd', be32(0), be32(1), box(codec, new Uint8Array(6), be16(1), new Uint8Array(16), be16(width), be16(height), new Uint8Array(50)))))));
const moov = (...tracks: Uint8Array[]) => box('moov', box('mvhd', new Uint8Array(100)), ...tracks);
const avis = (...parts: Uint8Array[]) => bytes(ftypAvis, ...parts, box('mdat', [0, 0, 0, 0]));

suite('ParadisImageDimensions', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	test('reads the size from the header of every raster format the viewer opens', () => {
		deepStrictEqual([
			png(577, 300), jpeg(4000, 3000), gif(320, 200), webpVp8x(5000, 4000), webpVp8l(1024, 768),
			bmp(640, -480), icoWithPng(512, 512), avif(8192, 4096), avis(moov(trak('av01', 640, 480))), bytes('<svg/>'),
		].map(readParadisImageHeader), [
			{ format: 'png', width: 577, height: 300 },
			{ format: 'jpeg', width: 4000, height: 3000 },
			{ format: 'gif', width: 320, height: 200 },
			{ format: 'webp', width: 5000, height: 4000 },
			{ format: 'webp', width: 1024, height: 768 },
			{ format: 'bmp', width: 640, height: 480 },
			{ format: 'ico', width: 512, height: 512 },
			{ format: 'avif', width: 8192, height: 4096 },
			{ format: 'avif', width: 640, height: 480 },
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
			avifWithoutSize: judgeParadisImageDecode(ftyp, 'image/avif', limit),
			gifFrameLargerThanScreen: judgeParadisImageDecode(gif(1, 1, { left: 0, top: 0, width: 65_535, height: 65_535 }), 'image/gif', limit),
			gifFrameOffsetOutsideScreen: judgeParadisImageDecode(gif(1, 1, { left: 60_000, top: 60_000, width: 2, height: 2 }), 'image/gif', limit),
			gifWithoutFrame: judgeParadisImageDecode(bytes('GIF89a', le16(1), le16(1), [0, 0, 0], [0x3b]), 'image/gif', limit),
			avifMetaAfterOneMiB: judgeParadisImageDecode(bytes(ftyp, box('mdat', new Uint8Array(1_100_000)), meta(ispe(20_000, 20_000))), 'image/avif', limit),
			avifDecoyIspe: judgeParadisImageDecode(bytes(ftyp, box('free', ispe(1, 1)), meta(ispe(64, 64), ispe(20_000, 20_000))), 'image/avif', limit),
			avisTrackOnly: judgeParadisImageDecode(avis(moov(trak('av01', 1920, 1080))), 'image/avif', limit),
			avisTrackOnlyBomb: judgeParadisImageDecode(avis(moov(trak('av01', 20_000, 20_000))), 'image/avif', limit),
			avisSmallIspeLargeTrack: judgeParadisImageDecode(avis(meta(ispe(64, 64)), moov(trak('av01', 20_000, 20_000))), 'image/avif', limit),
			avisLargerSecondTrack: judgeParadisImageDecode(avis(meta(ispe(64, 64)), moov(trak('av01', 64, 64), trak('av01', 20_000, 20_000))), 'image/avif', limit),
			avisWithoutAv01: judgeParadisImageDecode(avis(moov(trak('mp4a', 0, 0))), 'image/avif', limit),
			avifIspeOutsideMeta: judgeParadisImageDecode(bytes(ftyp, ispe(1, 1), box('mdat', [0])), 'image/avif', limit),
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
			avifWithoutSize: 'invalid',
			gifFrameLargerThanScreen: 'tooLarge',
			gifFrameOffsetOutsideScreen: 'tooLarge',
			gifWithoutFrame: 'invalid',
			avifMetaAfterOneMiB: 'tooLarge',
			avifDecoyIspe: 'tooLarge',
			avisTrackOnly: 'ok',
			avisTrackOnlyBomb: 'tooLarge',
			avisSmallIspeLargeTrack: 'tooLarge',
			avisLargerSecondTrack: 'tooLarge',
			avisWithoutAv01: 'invalid',
			avifIspeOutsideMeta: 'invalid',
			svg: 'ok',
			htmlNamedPng: 'invalid',
			truncatedJpeg: 'invalid',
		});
	});
});
