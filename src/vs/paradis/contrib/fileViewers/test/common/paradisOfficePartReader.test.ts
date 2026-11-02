/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import { deepStrictEqual } from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { joinParadisOfficeChunks, ParadisOfficePackageError, readParadisOfficePart, type IParadisOfficeArchive, type ParadisOfficeArchiveEntry } from '../../common/office/paradisOfficeArchive.js';

function entry(overrides: Partial<ParadisOfficeArchiveEntry>): ParadisOfficeArchiveEntry {
	return { name: 'word/document.xml', compressedBytes: 4, declaredExpandedBytes: 6, encrypted: false, directory: false, symlink: false, ...overrides };
}

const archive = {
	async *read() {
		yield new Uint8Array([1, 2, 3]);
		yield new Uint8Array([4, 5, 6]);
	},
} as unknown as IParadisOfficeArchive;

async function outcome(target: ParadisOfficeArchiveEntry, maxBytes = 100, compressionRatio = 10): Promise<unknown> {
	try {
		const bytes = await readParadisOfficePart(archive, target, { maxBytes, compressionRatio });
		return bytes ? Array.from(bytes) : 'skipped';
	} catch (error) {
		return error instanceof ParadisOfficePackageError ? error.code : String(error);
	}
}

suite('ParadisOfficePartReader', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	test('joins the chunks, skips a part over the size limit, and refuses encrypted, symlink and over-compressed parts', async () => {
		deepStrictEqual([
			await outcome(entry({})),
			await outcome(entry({}), 5),
			await outcome(entry({ encrypted: true })),
			await outcome(entry({ symlink: true })),
			await outcome(entry({ compressedBytes: 1 }), 100, 2),
			await outcome(entry({ compressedBytes: 0 })),
			Array.from(joinParadisOfficeChunks([new Uint8Array([7]), new Uint8Array([8, 9])], 3)),
		], [[1, 2, 3, 4, 5, 6], 'skipped', 'encrypted', 'unsafe', 'zipBomb', 'zipBomb', [7, 8, 9]]);
	});
});
