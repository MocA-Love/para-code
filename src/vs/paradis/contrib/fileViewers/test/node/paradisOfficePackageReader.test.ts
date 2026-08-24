/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import { rejects, strictEqual, throws } from 'assert';
import { createHash } from 'crypto';
import { CancellationToken, CancellationTokenSource } from '../../../../../base/common/cancellation.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { aggregateOfficeOutcome, canReportNoChanges, PARADIS_OFFICE_BUDGET_PROFILES, type ParadisOfficeBudgetProfile } from '../../common/paradisOfficeProtocol.js';
import { canonicalizeOfficeXml } from '../../common/office/paradisOfficeCanonicalXml.js';
import { type IParadisOfficeArchive, type ParadisOfficeArchiveEntry } from '../../common/office/paradisOfficeArchive.js';
import { inspectOfficePackage } from '../../common/office/paradisOfficePackageCore.js';
import { createParadisOfficeNodeArchive } from '../../node/office/paradisOfficeNodeArchive.js';
import { buildOpcFixture } from '../common/paradisOfficeFixture.js';

const officeDocumentRelationship = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument';

function profile(overrides: Partial<ParadisOfficeBudgetProfile>): ParadisOfficeBudgetProfile {

	return { ...PARADIS_OFFICE_BUDGET_PROFILES.desktopLocal, ...overrides };
}

async function inspectFixture(parts: Parameters<typeof buildOpcFixture>[0]['parts'], budget: Partial<ParadisOfficeBudgetProfile> = {}) {
	const archive = await createParadisOfficeNodeArchive(await buildOpcFixture({
		parts,
		relationships: [{ id: 'rId1', type: officeDocumentRelationship, target: 'word/document.xml' }],
	}));
	return inspectOfficePackage(archive, profile(budget), CancellationToken.None);
}

class TestArchive implements IParadisOfficeArchive {

	constructor(readonly records: readonly { readonly entry: ParadisOfficeArchiveEntry; readonly chunks: readonly Uint8Array[] }[]) { }

	async *entries(): AsyncIterable<ParadisOfficeArchiveEntry> {
		for (const record of this.records) {
			yield record.entry;
		}
	}

	async *read(entry: ParadisOfficeArchiveEntry): AsyncIterable<Uint8Array> {
		const record = this.records.find(candidate => candidate.entry === entry);
		if (!record) {
			throw new Error('unknown test entry');
		}
		for (const chunk of record.chunks) {
			yield chunk;
		}
	}

	async hash(bytes: Uint8Array) {
		return { algorithm: 'sha256' as const, value: createHash('sha256').update(bytes).digest('hex'), byteLength: bytes.byteLength };
	}

	dispose(): void { }
}

function testEntry(name: string, compressedBytes: number, expandedBytes: number): ParadisOfficeArchiveEntry {

	return { name, compressedBytes, declaredExpandedBytes: expandedBytes, encrypted: false, directory: false };
}

suite('ParadisOfficePackageReader', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	test('accepts the exact entry limit and blocks the next central-directory entry before it is read', async () => {
		const exact = new TestArchive([
			{ entry: testEntry('[Content_Types].xml', 1, 1), chunks: [new Uint8Array([0])] },
		]);
		const over = new TestArchive([
			{ entry: testEntry('[Content_Types].xml', 1, 1), chunks: [new Uint8Array([0])] },
			{ entry: testEntry('word/document.xml', 1, 1), chunks: [new Uint8Array([0])] },
		]);

		await rejects(inspectOfficePackage(exact, profile({ entryCount: 0 }), CancellationToken.None), /limitExceeded/);
		await rejects(inspectOfficePackage(over, profile({ entryCount: 1 }), CancellationToken.None), /limitExceeded/);
	});

	test('uses streamed output rather than ZIP headers for expanded-byte limits', async () => {
		const archive = new TestArchive([
			{ entry: testEntry('[Content_Types].xml', 1, 0), chunks: [new Uint8Array([1, 2]), new Uint8Array([3])] },
		]);

		await rejects(inspectOfficePackage(archive, profile({ expandedBytes: 2 }), CancellationToken.None), /limitExceeded/);
	});

	test('enforces the compressed container limit at the exact boundary before decompression', async () => {
		const exact = new TestArchive([{ entry: testEntry('[Content_Types].xml', 1, 999_999), chunks: [new Uint8Array([0])] }]);
		const over = new TestArchive([{ entry: testEntry('[Content_Types].xml', 2, 0), chunks: [new Uint8Array([0])] }]);

		await rejects(inspectOfficePackage(exact, profile({ compressedInputBytes: 1 }), CancellationToken.None), /malformed/);
		await rejects(inspectOfficePackage(over, profile({ compressedInputBytes: 1 }), CancellationToken.None), /limitExceeded/);
	});

	test('blocks both entry and container compression-ratio violations', async () => {
		const entryBomb = new TestArchive([
			{ entry: testEntry('[Content_Types].xml', 1, 1), chunks: [new Uint8Array([1, 2])] },
		]);
		const containerBomb = new TestArchive([
			{ entry: testEntry('[Content_Types].xml', 2, 1), chunks: [new Uint8Array([1, 2])] },
			{ entry: testEntry('word/document.xml', 1, 1), chunks: [new Uint8Array([3, 4])] },
		]);

		await rejects(inspectOfficePackage(entryBomb, profile({ compressionRatio: 1 }), CancellationToken.None), /zipBomb/);
		await rejects(inspectOfficePackage(containerBomb, profile({ compressionRatio: 1 }), CancellationToken.None), /zipBomb/);
	});

	test('rejects duplicate and traversal names before opening an entry stream', async () => {
		for (const name of ['word\\document.xml', '/word/document.xml', 'word/../document.xml', 'word/%2e%2e/document.xml']) {
			const archive = new TestArchive([{ entry: testEntry(name, 1, 1), chunks: [new Uint8Array([0])] }]);
			await rejects(inspectOfficePackage(archive, profile({}), CancellationToken.None), /invalid/);
		}
		const duplicate = new TestArchive([
			{ entry: testEntry('[Content_Types].xml', 1, 1), chunks: [new Uint8Array([0])] },
			{ entry: testEntry('[Content_Types].xml', 1, 1), chunks: [new Uint8Array([0])] },
		]);
		await rejects(inspectOfficePackage(duplicate, profile({}), CancellationToken.None), /invalid/);
	});

	test('invents no OPC structure and reports all fully read parts with all-byte raw hashes', async () => {
		const inventory = await inspectFixture([
			['/word/document.xml', '<w:document xmlns:w="urn:w"><w:body>hello</w:body></w:document>'],
			['/word/media/image.bin', new Uint8Array([1, 2, 3])],
		]);

		strictEqual(inventory.container, 'opc');
		strictEqual(inventory.format, 'docx');
		strictEqual(inventory.parts.length, 4);
		strictEqual(inventory.parts.every(part => (part.coverage === 'completeOpaque' ? part.fingerprint : part.rawHash)?.byteLength === part.expandedBytes && part.hashCompleteness === 'allBytes'), true);
	});

	test('requires content types, root relationships, main part, and every internal relationship target', async () => {
		const missingRoot = await createParadisOfficeNodeArchive(await buildOpcFixture({ parts: [['/word/document.xml', '<document/>']] }));
		await rejects(inspectOfficePackage(missingRoot, profile({}), CancellationToken.None), /malformed/);

		const missingTarget = await createParadisOfficeNodeArchive(await buildOpcFixture({
			parts: [['/word/document.xml', '<document/>']],
			relationships: [
				{ id: 'rId1', type: officeDocumentRelationship, target: 'word/document.xml' },
				{ source: '/word/document.xml', id: 'rId2', type: 'urn:test', target: 'missing.xml' },
			],
		}));
		await rejects(inspectOfficePackage(missingTarget, profile({}), CancellationToken.None), /malformed/);
	});

	test('records an over-budget optional media part as omitted while preserving the required OPC inventory', async () => {
		const inventory = await inspectFixture([
			['/word/document.xml', '<document/>'],
			['/word/media/large.bin', new Uint8Array([1, 2, 3])],
		], { binaryPartBytes: 2 });

		strictEqual(inventory.parts.find(part => part.canonicalUri === '/word/media/large.bin')?.coverage, 'omittedByBudget');
		strictEqual(inventory.parts.some(part => part.canonicalUri === '/word/document.xml' && part.coverage === 'parsed'), true);
		strictEqual(aggregateOfficeOutcome(inventory.parts.map(part => part.coverage === 'completeOpaque'
			? { coverage: part.coverage, required: part.required, hashCompleteness: part.hashCompleteness, fingerprint: part.fingerprint }
			: { coverage: part.coverage, required: part.required })), 'degraded');
	});

	test('keeps external relationships inert and marks every edge in an internal relationship cycle', async () => {
		const archive = await createParadisOfficeNodeArchive(await buildOpcFixture({
			parts: [['/word/document.xml', '<document/>'], ['/word/other.xml', '<other/>']],
			relationships: [
				{ id: 'rId1', type: officeDocumentRelationship, target: 'word/document.xml' },
				{ source: '/word/document.xml', id: 'rId2', type: 'urn:test', target: 'other.xml' },
				{ source: '/word/document.xml', id: 'rId3', type: 'urn:external', target: 'https://example.invalid/a', targetMode: 'External' },
				{ source: '/word/other.xml', id: 'rId4', type: 'urn:test', target: 'document.xml' },
			],
		}));
		const inventory = await inspectOfficePackage(archive, profile({}), CancellationToken.None);

		strictEqual(inventory.security.hasExternalRelationships, true);
		strictEqual(inventory.relationships.find(relationship => relationship.id === 'rId3')?.target, 'https://example.invalid/a');
		strictEqual(inventory.relationships.filter(relationship => relationship.id === 'rId2' || relationship.id === 'rId4').every(relationship => relationship.cyclic), true);
	});

	test('canonicalizes namespace prefixes and attribute order without changing preserved text whitespace', () => {
		const first = canonicalizeOfficeXml('<a:x xmlns:a="urn:test" b="2" a="1"><a:y>  keep  </a:y></a:x>', () => undefined);
		const second = canonicalizeOfficeXml('<q:x xmlns:q="urn:test" a="1" b="2">\n <q:y>  keep  </q:y>\n</q:x>', () => undefined);

		strictEqual(first.hash.value, second.hash.value);
		strictEqual(first.canonical.includes('  keep  '), true);
	});

	test('canonicalizes relationship IDs, xml:space, and unknown subtrees without silently dropping either MC branch', () => {
		const withFirstId = canonicalizeOfficeXml('<p:a xmlns:p="urn:p" xmlns:r="urn:r" r:id="rId1"><x:unknown xmlns:x="urn:x"/><p:b xml:space="preserve">\n  keep indent\n</p:b><mc:Choice xmlns:mc="urn:mc">one</mc:Choice><mc:Fallback xmlns:mc="urn:mc">two</mc:Fallback></p:a>', id => id === 'rId1' ? '/word/media/a.bin' : undefined);
		const withSecondId = canonicalizeOfficeXml('<q:a xmlns:q="urn:p" xmlns:s="urn:r" s:id="rId9"><x:unknown xmlns:x="urn:x"/><q:b xml:space="preserve">\n  keep indent\n</q:b><mc:Choice xmlns:mc="urn:mc">one</mc:Choice><mc:Fallback xmlns:mc="urn:mc">two</mc:Fallback></q:a>', id => id === 'rId9' ? '/word/media/a.bin' : undefined);

		strictEqual(withFirstId.hash.value, withSecondId.hash.value);
		strictEqual(withFirstId.sourceRefs.length > 0, true);
		strictEqual(withFirstId.canonical.includes('one') && withFirstId.canonical.includes('two'), true);
	});

	test('retains hashes for selected and nonselected markup-compatibility branches', () => {
		const result = canonicalizeOfficeXml('<x xmlns:mc="http://schemas.openxmlformats.org/markup-compatibility/2006"><mc:Choice Requires="w">selected</mc:Choice><mc:Fallback>fallback</mc:Fallback></x>', () => undefined);

		strictEqual(result.markupCompatibility.length, 2);
		strictEqual(result.markupCompatibility.every(branch => branch.hash.algorithm === 'sha256'), true);
	});

	test('permits No Changes only for a terminal complete manifest with no omitted parts', () => {
		strictEqual(canReportNoChanges({ expectedParts: 1, visitedParts: 1, parsedParts: 1, opaqueParts: 0, failedParts: 0, omittedParts: 0, expectedSemanticUnits: 1, visitedSemanticUnits: 1, terminal: true }, 'complete', 0), true);
		strictEqual(canReportNoChanges({ expectedParts: 1, visitedParts: 1, parsedParts: 0, opaqueParts: 0, failedParts: 0, omittedParts: 1, expectedSemanticUnits: 1, visitedSemanticUnits: 1, terminal: true }, 'degraded', 0), false);
	});

	test('rejects DTDs, malformed XML, and XML resource limits at the exact boundary', () => {
		strictEqual(canonicalizeOfficeXml('<a><b/></a>', () => undefined, { depth: 2, nodes: 2, attributeLength: 1, characters: 100 }).canonical.length > 0, true);
		throws(() => canonicalizeOfficeXml('<!DOCTYPE a [<!ENTITY x "x">]><a>&x;</a>', () => undefined, { depth: 2, nodes: 10, attributeLength: 10, characters: 100 }), /malformed/);
		throws(() => canonicalizeOfficeXml('<a>', () => undefined, { depth: 2, nodes: 10, attributeLength: 10, characters: 100 }), /malformed/);
		throws(() => canonicalizeOfficeXml('<a><b><c/></b></a>', () => undefined, { depth: 2, nodes: 10, attributeLength: 10, characters: 100 }), /limitExceeded/);
	});

	test('observes cancellation before reading further entry chunks', async () => {
		const source = new CancellationTokenSource();
		const archive = new TestArchive([
			{ entry: testEntry('[Content_Types].xml', 2, 2), chunks: [new Uint8Array([1]), new Uint8Array([2])] },
		]);
		source.cancel();

		await rejects(inspectOfficePackage(archive, profile({}), source.token), /cancelled/);
	});
});
