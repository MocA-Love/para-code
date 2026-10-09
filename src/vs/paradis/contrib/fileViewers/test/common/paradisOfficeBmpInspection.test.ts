/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import { deepStrictEqual } from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { inspectParadisOfficeBmp } from '../../common/office/paradisOfficeBmpInspection.js';
import { minimalBmp } from './paradisOfficeBmpFixture.js';

suite('ParadisOfficeBmpInspection', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	test('accepts well-formed BMP headers, cuts trailing data, and tells too large from broken', () => {
		const result = (bytes: Uint8Array) => {
			const inspection = inspectParadisOfficeBmp(bytes);
			return inspection.image ? `${inspection.image.width}x${inspection.image.height}:${inspection.image.end}` : inspection.rejection;
		};
		const plain = minimalBmp(3, 2);
		const truncated = minimalBmp(3, 2).subarray(0, 60);
		deepStrictEqual({
			rgb24: result(plain),
			topDown: result(minimalBmp(3, -2)),
			trailing: result(minimalBmp(3, 2, { trailer: 16 })),
			paletted: result(minimalBmp(4, 4, { bitCount: 8, colors: 16 })),
			rle8: result(minimalBmp(4, 4, { bitCount: 8, compression: 1, imageSize: 4 })),
			bitfields: result(minimalBmp(2, 2, { bitCount: 32, compression: 3 })),
			truncated: result(truncated),
			shortPixels: result(minimalBmp(3, 2, { pixelBytes: 4 })),
			rleTopDown: result(minimalBmp(4, -4, { bitCount: 8, compression: 1, imageSize: 4 })),
			embeddedJpeg: result(minimalBmp(2, 2, { compression: 4 })),
			embeddedPng: result(minimalBmp(2, 2, { compression: 5 })),
			tooManyColors: result(minimalBmp(2, 2, { bitCount: 1, colors: 3 })),
			tooWide: result(minimalBmp(40_000, 1, { pixelBytes: 120_000 })),
			notBmp: result(new TextEncoder().encode('<svg xmlns="http://www.w3.org/2000/svg"/>')),
		}, {
			rgb24: `3x2:${plain.byteLength}`,
			topDown: `3x2:${plain.byteLength}`,
			trailing: `3x2:${plain.byteLength}`,
			paletted: `4x4:${minimalBmp(4, 4, { bitCount: 8, colors: 16 }).byteLength}`,
			rle8: `4x4:${minimalBmp(4, 4, { bitCount: 8, compression: 1, imageSize: 4 }).byteLength}`,
			bitfields: `2x2:${minimalBmp(2, 2, { bitCount: 32, compression: 3 }).byteLength}`,
			truncated: 'invalid',
			shortPixels: 'invalid',
			rleTopDown: 'invalid',
			embeddedJpeg: 'invalid',
			embeddedPng: 'invalid',
			tooManyColors: 'invalid',
			tooWide: 'tooLarge',
			notBmp: 'invalid',
		});
	});
});
