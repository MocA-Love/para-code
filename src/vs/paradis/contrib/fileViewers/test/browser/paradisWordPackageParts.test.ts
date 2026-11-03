/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import { deepStrictEqual } from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { createParadisOfficeWebArchive } from '../../browser/office/paradisOfficeWebArchive.js';
import { readWordRenderablePackageParts } from '../../browser/word/paradisWordPackageParts.js';
import { PARADIS_OFFICE_BUDGET_PROFILES } from '../../common/paradisOfficeProtocol.js';
import { buildOpcFixture } from '../common/paradisOfficeFixture.js';

/** 本文の XML。決まった並びの文字（縮みにくい）と同じ文字の繰り返し（よく縮む）で、圧縮率を 100〜200 倍にする。 */
function documentXml(): string {
	let seed = 1;
	let noise = '';
	for (let i = 0; i < 2000; i++) {
		seed = (seed * 1103515245 + 12345) % 2147483648;
		noise += String.fromCharCode(97 + seed % 26);
	}
	return `<w:document xmlns:w="urn:w"><w:body><w:p><w:r><w:t>${noise}${'a'.repeat(250_000)}</w:t></w:r></w:p></w:body></w:document>`;
}

suite('ParadisWordPackageParts', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	test('reads parts compressed between the browser and the desktop budgets, like the detailed Word analysis', async () => {
		const fixture = await buildOpcFixture({
			parts: [['/word/document.xml', documentXml()]],
			relationships: [{ id: 'rId1', type: 'http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument', target: 'word/document.xml' }],
			compression: 'DEFLATE',
		});
		const archive = await createParadisOfficeWebArchive(fixture.slice());
		let ratio = 0;
		try {
			for await (const entry of archive.entries()) {
				if (entry.name === 'word/document.xml') {
					ratio = entry.declaredExpandedBytes / entry.compressedBytes;
				}
			}
		} finally {
			archive.dispose();
		}
		const parts = await readWordRenderablePackageParts(fixture);
		deepStrictEqual({
			betweenBudgets: ratio > PARADIS_OFFICE_BUDGET_PROFILES.browser.compressionRatio && ratio < PARADIS_OFFICE_BUDGET_PROFILES.desktopLocal.compressionRatio,
			read: parts.has('/word/document.xml'),
		}, { betweenBudgets: true, read: true });
	});
});
