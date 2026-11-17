/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import { deepStrictEqual } from 'assert';
import { createHash } from 'crypto';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import type { ParadisOfficeFingerprint } from '../../common/paradisOfficeProtocol.js';
import { fingerprintSpreadsheetObjectBytes } from '../../common/spreadsheet/paradisSpreadsheetObjectParser.js';
import { fingerprintParadisWordObjectBytes } from '../../common/word/paradisWordObjects.js';

/** Lengths around the SHA-256 padding boundaries (55/56 and 64 bytes), plus empty, short and multi-block inputs. */
const lengths = [0, 1, 3, 55, 56, 57, 63, 64, 65, 119, 120, 128, 300, 1000];

function sample(length: number): Uint8Array {
	const bytes = new Uint8Array(length);
	for (let index = 0; index < length; index++) {
		bytes[index] = (index * 31 + 7) & 0xff;
	}
	return bytes;
}

function expected(bytes: Uint8Array): ParadisOfficeFingerprint {
	return { algorithm: 'sha256', value: createHash('sha256').update(bytes).digest('hex'), byteLength: bytes.length };
}

suite('ParadisOfficeObjectFingerprint', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	// The other tests build their expected fingerprints with these same functions, so they
	// cannot notice a wrong digest. This one compares against an independent SHA-256.
	test('Word object fingerprints are standard SHA-256', () => {
		deepStrictEqual(lengths.map(length => fingerprintParadisWordObjectBytes(sample(length))), lengths.map(length => expected(sample(length))));
	});

	test('spreadsheet object fingerprints are standard SHA-256', () => {
		deepStrictEqual(lengths.map(length => fingerprintSpreadsheetObjectBytes(sample(length))), lengths.map(length => expected(sample(length))));
	});
});
