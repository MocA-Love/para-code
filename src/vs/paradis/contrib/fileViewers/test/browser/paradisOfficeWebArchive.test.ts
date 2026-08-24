/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import { deepStrictEqual, rejects, strictEqual } from 'assert';
import { CancellationToken, CancellationTokenSource } from '../../../../../base/common/cancellation.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { createParadisOfficeWebArchive, ParadisOfficeWebArchive } from '../../browser/office/paradisOfficeWebArchive.js';
import type { ParadisOfficeArchiveEntry } from '../../common/office/paradisOfficeArchive.js';
import { PARADIS_OFFICE_BUDGET_PROFILES } from '../../common/paradisOfficeProtocol.js';
import { inspectOfficePackage } from '../../common/office/paradisOfficePackageCore.js';
import { buildOpcFixture } from '../common/paradisOfficeFixture.js';

suite('ParadisOfficeWebArchive', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	test('opens an owned native ZIP-backed OPC input and produces the common inventory contract', async () => {
		const fixture = await buildOpcFixture({
			parts: [
				['/word/document.xml', '<w:document xmlns:w="urn:w"><w:body>hello</w:body></w:document>'],
				['/word/media/image.bin', new Uint8Array([1, 2, 3])],
			],
			relationships: [{ id: 'rId1', type: 'http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument', target: 'word/document.xml' }],
		});
		const archive = await createParadisOfficeWebArchive(fixture);
		fixture.fill(0);
		const inventory = await inspectOfficePackage(archive, PARADIS_OFFICE_BUDGET_PROFILES.browser, CancellationToken.None);

		strictEqual(inventory.container, 'opc');
		strictEqual(inventory.format, 'docx');
		strictEqual(inventory.parts.length, 4);
		strictEqual(inventory.outcome, 'complete');
		deepStrictEqual(inventory.parts.map(part => [part.canonicalUri, part.coverage]), [
			['/[Content_Types].xml', 'parsed'],
			['/_rels/.rels', 'parsed'],
			['/word/document.xml', 'parsed'],
			['/word/media/image.bin', 'completeOpaque'],
		]);
		deepStrictEqual(inventory.relationships.map(relationship => [relationship.id, relationship.sourcePartId, relationship.target, relationship.targetMode, relationship.missing, relationship.cyclic]), [
			['rId1', undefined, '/word/document.xml', 'internal', false, false],
		]);
		deepStrictEqual([inventory.outcome, inventory.completeness.expectedParts, inventory.completeness.visitedParts, inventory.completeness.parsedParts, inventory.completeness.opaqueParts, inventory.completeness.omittedParts, inventory.completeness.terminal], ['complete', 4, 4, 3, 1, 0, true]);
	});

	test('cancels and sanitizes a Web archive stream before raw primitive errors escape', async () => {
		let closed = false;
		const entry: ParadisOfficeArchiveEntry = { name: 'word/document.xml', compressedBytes: 1, declaredExpandedBytes: 1, encrypted: false, directory: false, symlink: false };
		const archive = new ParadisOfficeWebArchive({
			async *entries() { yield entry; },
			async *read() { throw new Error('/raw/private/archive error'); },
			close() { closed = true; },
		}, 1);
		const source = new CancellationTokenSource();
		source.cancel();

		await rejects((async () => { for await (const _chunk of archive.read(entry, source.token)) { } })(), /cancelled/);
		await rejects((async () => { for await (const _chunk of archive.read(entry, CancellationToken.None)) { } })(), /invalid/);
		archive.dispose();
		strictEqual(closed, true);
	});
});
