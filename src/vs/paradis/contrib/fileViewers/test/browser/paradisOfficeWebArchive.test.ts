/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import { deepStrictEqual, rejects, strictEqual } from 'assert';
import { CancellationToken, CancellationTokenSource } from '../../../../../base/common/cancellation.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { importAMDNodeModule } from '../../../../../amdX.js';
import { createParadisOfficeWebArchive, ParadisOfficeWebArchive } from '../../browser/office/paradisOfficeWebArchive.js';
import type { ParadisOfficeArchiveEntry } from '../../common/office/paradisOfficeArchive.js';
import { canonicalizeOfficeXml, parseParadisOfficeXml } from '../../common/office/paradisOfficeCanonicalXml.js';
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

	test('uses the pure XML parser without a DOMParser', async () => {
		const descriptor = Object.getOwnPropertyDescriptor(globalThis, 'DOMParser');
		const restore = () => {
			if (descriptor) { Object.defineProperty(globalThis, 'DOMParser', descriptor); }
			else { Reflect.deleteProperty(globalThis, 'DOMParser'); }
		};
		try {
			if (descriptor?.configurable) { Object.defineProperty(globalThis, 'DOMParser', { value: undefined, configurable: true }); }
			const xml = '<p:root xmlns:p="urn:root" xmlns:a="urn:attribute" a:value="a &gt; b"><p:child><![CDATA[cdata]]>&amp;</p:child></p:root>';
			const limits = { depth: 4, nodes: 2, attributeLength: 32, characters: 32 };
			const webArchive = await createParadisOfficeWebArchive(await packageFixture());
			const webDocument = await webArchive.parseXml(xml, limits);
			const commonDocument = parseParadisOfficeXml(xml, limits);
			deepStrictEqual(webDocument, commonDocument);
			strictEqual(canonicalizeOfficeXml(webDocument, () => undefined).hash.value, canonicalizeOfficeXml(commonDocument, () => undefined).hash.value);
		} finally { restore(); }
	});

	test('accepts an EOCD comment but rejects corrupted EOCD, central-directory, local-header, and truncation metadata', async () => {
		const fixture = await packageFixture();
		const commented = withComment(fixture, new Uint8Array([1, 2, 3]));
		strictEqual((await inspectOfficePackage(await createParadisOfficeWebArchive(commented), PARADIS_OFFICE_BUDGET_PROFILES.browser, CancellationToken.None)).outcome, 'complete');

		for (const mutate of [
			(bytes: Uint8Array, eocd: number) => new DataView(bytes.buffer).setUint16(eocd + 20, 1, true),
			(bytes: Uint8Array, eocd: number) => new DataView(bytes.buffer).setUint16(eocd + 4, 1, true),
			(bytes: Uint8Array, eocd: number) => new DataView(bytes.buffer).setUint16(eocd + 8, 1, true),
			(bytes: Uint8Array, eocd: number) => new DataView(bytes.buffer).setUint32(eocd + 12, 1, true),
		]) {
			const corrupted = fixture.slice();
			mutate(corrupted, findEocd(corrupted));
			await rejects(createParadisOfficeWebArchive(corrupted), /invalid/);
		}
		const trailing = new Uint8Array(fixture.byteLength + 1); trailing.set(fixture);
		await rejects(createParadisOfficeWebArchive(trailing), /invalid/);
		await rejects(createParadisOfficeWebArchive(fixture.slice(0, -1)), /invalid/);
		const localNameCorrupt = fixture.slice(); const view = new DataView(localNameCorrupt.buffer); const central = view.getUint32(findEocd(localNameCorrupt) + 16, true); const local = view.getUint32(central + 42, true); localNameCorrupt[local + 30] ^= 1;
		await rejects(inspectOfficePackage(await createParadisOfficeWebArchive(localNameCorrupt), PARADIS_OFFICE_BUDGET_PROFILES.browser, CancellationToken.None), /invalid/);
	});

	test('rejects every supported ZIP64 sentinel and corrupt STORE CRC before complete inventory', async () => {
		const fixture = await packageFixture();
		const eocd = findEocd(fixture);
		const central = new DataView(fixture.buffer, fixture.byteOffset, fixture.byteLength).getUint32(eocd + 16, true);
		for (const location of [eocd + 10, eocd + 12, eocd + 16, central + 20, central + 24, central + 34, central + 42]) {
			const corrupted = fixture.slice();
			const view = new DataView(corrupted.buffer);
			if (location === eocd + 10 || location === central + 34) { view.setUint16(location, 0xffff, true); } else { view.setUint32(location, 0xffffffff, true); }
			await rejects(createParadisOfficeWebArchive(corrupted), /invalid/);
		}
		const crcCorrupt = fixture.slice();
		new DataView(crcCorrupt.buffer).setUint32(central + 16, 0, true);
		await rejects(inspectOfficePackage(await createParadisOfficeWebArchive(crcCorrupt), PARADIS_OFFICE_BUDGET_PROFILES.browser, CancellationToken.None), /invalid/);
	});

	test('decompresses a valid DEFLATE OPC entry and rejects a corrupt data-descriptor flag', async () => {
		const fixture = await deflateFixture();
		strictEqual((await inspectOfficePackage(await createParadisOfficeWebArchive(fixture), PARADIS_OFFICE_BUDGET_PROFILES.browser, CancellationToken.None)).outcome, 'complete');
		const descriptorCorrupt = fixture.slice(); const eocd = findEocd(descriptorCorrupt); const central = new DataView(descriptorCorrupt.buffer).getUint32(eocd + 16, true); const local = new DataView(descriptorCorrupt.buffer).getUint32(central + 42, true); const view = new DataView(descriptorCorrupt.buffer); view.setUint16(central + 8, view.getUint16(central + 8, true) | 8, true); view.setUint16(local + 6, view.getUint16(local + 6, true) | 8, true); view.setUint32(local + 14, 0, true); view.setUint32(local + 18, 0, true); view.setUint32(local + 22, 0, true);
		await rejects(inspectOfficePackage(await createParadisOfficeWebArchive(descriptorCorrupt), PARADIS_OFFICE_BUDGET_PROFILES.browser, CancellationToken.None), /invalid/);
	});
});

async function packageFixture(): Promise<Uint8Array> {
	return buildOpcFixture({ parts: [['/word/document.xml', '<document/>']], relationships: [{ id: 'rId1', type: 'http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument', target: 'word/document.xml' }] });
}

async function deflateFixture(): Promise<Uint8Array> {
	const JSZip = await importAMDNodeModule<typeof import('jszip')>('jszip', 'dist/jszip.min.js'); const zip = new JSZip();
	zip.file('[Content_Types].xml', '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Override PartName="/word/document.xml" ContentType="application/xml"/></Types>');
	zip.file('_rels/.rels', '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>');
	zip.file('word/document.xml', '<document>deflate</document>');
	return zip.generateAsync({ type: 'uint8array', compression: 'DEFLATE', platform: 'DOS' });
}

function findEocd(bytes: Uint8Array): number {
	const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
	for (let offset = bytes.byteLength - 22; offset >= 0; offset--) { if (view.getUint32(offset, true) === 0x06054b50) { return offset; } }
	throw new Error('missing EOCD');
}

function withComment(bytes: Uint8Array, comment: Uint8Array): Uint8Array {
	const eocd = findEocd(bytes); const result = new Uint8Array(bytes.byteLength + comment.byteLength); result.set(bytes); result.set(comment, bytes.byteLength); new DataView(result.buffer).setUint16(eocd + 20, comment.byteLength, true); return result;
}
