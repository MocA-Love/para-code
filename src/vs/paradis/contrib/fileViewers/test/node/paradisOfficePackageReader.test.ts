/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import { deepStrictEqual, rejects, strictEqual, throws } from 'assert';
import { createHash } from 'crypto';
import { CancellationToken, CancellationTokenSource } from '../../../../../base/common/cancellation.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { aggregateOfficeOutcome, canReportNoChanges, PARADIS_OFFICE_BUDGET_PROFILES, type ParadisOfficeBudgetProfile } from '../../common/paradisOfficeProtocol.js';
import { canonicalizeOfficeXml, parseParadisOfficeXml, type ParadisOfficeXmlLimits } from '../../common/office/paradisOfficeCanonicalXml.js';
import { type IParadisOfficeArchive, type ParadisOfficeArchiveEntry, type ParadisOfficeXmlDocument, ParadisOfficePackageError } from '../../common/office/paradisOfficeArchive.js';
import { ParadisOfficeBudget, ParadisOfficeBudgetError } from '../../common/office/paradisOfficeBudget.js';
import { findParadisOfficeRelationshipCyclesForTest, inspectOfficePackage } from '../../common/office/paradisOfficePackageCore.js';
import { createParadisOfficeNodeArchive } from '../../node/office/paradisOfficeNodeArchive.js';
import { buildOpcFixture } from '../common/paradisOfficeFixture.js';

const officeDocumentRelationship = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument';

function profile(overrides: Partial<ParadisOfficeBudgetProfile>): ParadisOfficeBudgetProfile {
	return { ...PARADIS_OFFICE_BUDGET_PROFILES.desktopLocal, ...overrides };
}

async function canonicalizeXmlStringForTest(xml: string, relationshipResolver: (id: string) => string | undefined = () => undefined, limits: ParadisOfficeXmlLimits = { depth: 128, nodes: 2_000_000, attributeLength: 1024 * 1024, characters: 64 * 1024 * 1024 }) {
	const document = await new TestArchive([]).parseXml(xml, limits);
	return canonicalizeOfficeXml(document, relationshipResolver);
}

async function inspectFixture(parts: Parameters<typeof buildOpcFixture>[0]['parts'], budget: Partial<ParadisOfficeBudgetProfile> = {}) {
	const archive = await createParadisOfficeNodeArchive(
		await buildOpcFixture({
			parts,
			relationships: [
				{
					id: 'rId1',
					type: officeDocumentRelationship,
					target: 'word/document.xml',
				},
			],
		}),
	);
	return inspectOfficePackage(archive, profile(budget), CancellationToken.None);
}

class TestArchive implements IParadisOfficeArchive {
	readonly containerByteLength: number;

	constructor(
		readonly records: readonly {
			readonly entry: ParadisOfficeArchiveEntry;
			readonly chunks: readonly Uint8Array[];
		}[],
	) {
		this.containerByteLength = records.reduce((total, record) => total + record.entry.compressedBytes, 0);
	}

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
		return {
			algorithm: 'sha256' as const,
			value: createHash('sha256').update(bytes).digest('hex'),
			byteLength: bytes.byteLength,
		};
	}

	async parseXml(xml: string, limits: ParadisOfficeXmlLimits): Promise<ParadisOfficeXmlDocument> {
		return parseParadisOfficeXml(xml, limits);
	}

	dispose(): void { }
}

function testEntry(name: string, compressedBytes: number, expandedBytes: number): ParadisOfficeArchiveEntry {
	return {
		name,
		compressedBytes,
		declaredExpandedBytes: expandedBytes,
		encrypted: false,
		directory: false,
		symlink: false,
	};
}

function isBudgetError(error: unknown, code: ParadisOfficePackageError['code'], metric: ParadisOfficeBudgetError['metric']): boolean {
	return error instanceof ParadisOfficeBudgetError && error.code === code && error.metric === metric;
}

suite('ParadisOfficePackageReader', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	test('accepts the exact entry limit and blocks the next central-directory entry before it is read', async () => {
		const exact = new TestArchive([
			{
				entry: testEntry('[Content_Types].xml', 1, 1),
				chunks: [new Uint8Array([0])],
			},
		]);
		const over = new TestArchive([
			{
				entry: testEntry('[Content_Types].xml', 1, 1),
				chunks: [new Uint8Array([0])],
			},
			{
				entry: testEntry('word/document.xml', 1, 1),
				chunks: [new Uint8Array([0])],
			},
		]);

		await rejects(inspectOfficePackage(exact, profile({ entryCount: 0 }), CancellationToken.None), /limitExceeded/);
		await rejects(inspectOfficePackage(over, profile({ entryCount: 1 }), CancellationToken.None), /limitExceeded/);
	});

	test('uses streamed output rather than ZIP headers for expanded-byte limits', async () => {
		const archive = new TestArchive([
			{
				entry: testEntry('[Content_Types].xml', 1, 0),
				chunks: [new Uint8Array([1, 2]), new Uint8Array([3])],
			},
		]);

		await rejects(inspectOfficePackage(archive, profile({ expandedBytes: 2 }), CancellationToken.None), /limitExceeded/);
	});

	test('blocks a container expanded-byte breach without reading later entries', async () => {
		let secondRead = false;
		const entries = [testEntry('[Content_Types].xml', 1, 2), testEntry('word/document.xml', 1, 1)];
		const archive: IParadisOfficeArchive = {
			containerByteLength: 2,
			async *entries() { yield* entries; },
			async *read(entry) { if (entry.name === 'word/document.xml') { secondRead = true; } yield new Uint8Array([1, 2]); },
			async hash(bytes) { return { algorithm: 'sha256', value: createHash('sha256').update(bytes).digest('hex'), byteLength: bytes.byteLength }; },
			parseXml: async () => { throw new Error('unused'); }, dispose() { },
		};
		await rejects(inspectOfficePackage(archive, profile({ expandedBytes: 1 }), CancellationToken.None), /limitExceeded/);
		strictEqual(secondRead, false);
	});

	test('enforces the compressed container limit at the exact boundary before decompression', async () => {
		const exact = new TestArchive([
			{
				entry: testEntry('[Content_Types].xml', 1, 999_999),
				chunks: [new Uint8Array([0])],
			},
		]);
		const over = new TestArchive([
			{
				entry: testEntry('[Content_Types].xml', 2, 0),
				chunks: [new Uint8Array([0])],
			},
		]);

		await rejects(inspectOfficePackage(exact, profile({ compressedInputBytes: 1 }), CancellationToken.None), /invalid/);
		await rejects(inspectOfficePackage(over, profile({ compressedInputBytes: 1 }), CancellationToken.None), /limitExceeded/);
	});

	test('classifies input, entry-ratio, container-ratio, and deadline budget breaches', () => {
		throws(
			() => new ParadisOfficeBudget(profile({ compressedInputBytes: 1 }), 0).validateContainerInput(2),
			error => isBudgetError(error, 'limitExceeded', 'inputBytes'),
		);
		const entryRatio = new ParadisOfficeBudget(profile({ compressionRatio: 1 }), 0);
		entryRatio.validateContainerInput(2);
		entryRatio.beginEntry(1);
		throws(
			() => entryRatio.consumeEntry(2, 1, false, false, 0),
			error => isBudgetError(error, 'zipBomb', 'entryRatio'),
		);
		const containerRatio = new ParadisOfficeBudget(profile({ compressionRatio: 1 }), 0);
		containerRatio.validateContainerInput(1);
		containerRatio.beginEntry(2);
		throws(
			() => containerRatio.consumeEntry(2, 2, false, false, 0),
			error => isBudgetError(error, 'zipBomb', 'containerRatio'),
		);
		const deadline = new ParadisOfficeBudget(profile({ inspectMilliseconds: 10 }), 0);
		deadline.checkDeadline(8);
		deepStrictEqual(deadline.warningKinds(), ['inspectTime']);
		throws(
			() => deadline.checkDeadline(11),
			error => isBudgetError(error, 'limitExceeded', 'inspectTime'),
		);
	});

	test('blocks both entry and container compression-ratio violations', async () => {
		const entryBomb = new TestArchive([
			{
				entry: testEntry('[Content_Types].xml', 1, 1),
				chunks: [new Uint8Array([1, 2])],
			},
		]);
		const containerBomb = new TestArchive([
			{
				entry: testEntry('[Content_Types].xml', 2, 2),
				chunks: [new Uint8Array([1, 2])],
			},
		]);
		Object.defineProperty(containerBomb, 'containerByteLength', { value: 1 });

		await rejects(inspectOfficePackage(entryBomb, profile({ compressionRatio: 1 }), CancellationToken.None), /zipBomb/);
		await rejects(inspectOfficePackage(containerBomb, profile({ compressionRatio: 1 }), CancellationToken.None), /zipBomb/);
	});

	test('reports zero input usage before validation and the owned actual input afterward', () => {
		const budget = new ParadisOfficeBudget(profile({}), 0);
		strictEqual(budget.usage().compressedInputBytes, 0);
		budget.validateContainerInput(123);
		strictEqual(budget.usage().compressedInputBytes, 123);
	});

	test('does not omit an archive-supplied error that impersonates a part budget breach', async () => {
		const forged = Object.assign(new ParadisOfficePackageError('limitExceeded'), { scope: 'part', metric: 'partBytes' });
		const entry = testEntry('[Content_Types].xml', 1, 0);
		const archive: IParadisOfficeArchive = {
			containerByteLength: 1,
			async *entries() { yield entry; },
			async *read() { throw forged; },
			async hash(bytes) { return { algorithm: 'sha256', value: createHash('sha256').update(bytes).digest('hex'), byteLength: bytes.byteLength }; },
			parseXml: async () => { throw new Error('unused'); }, dispose() { },
		};

		await rejects(inspectOfficePackage(archive, profile({}), CancellationToken.None), error => error === forged);
	});

	test('rejects duplicate and traversal names before opening an entry stream', async () => {
		for (const name of ['word\\document.xml', '/word/document.xml', 'word/../document.xml', 'word/%2e%2e/document.xml']) {
			const archive = new TestArchive([{ entry: testEntry(name, 1, 1), chunks: [new Uint8Array([0])] }]);
			await rejects(inspectOfficePackage(archive, profile({}), CancellationToken.None), /invalid/);
		}
		const duplicate = new TestArchive([
			{
				entry: testEntry('[Content_Types].xml', 1, 1),
				chunks: [new Uint8Array([0])],
			},
			{
				entry: testEntry('[Content_Types].xml', 1, 1),
				chunks: [new Uint8Array([0])],
			},
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
		strictEqual(
			inventory.parts.every(part => (part.coverage === 'completeOpaque' ? part.fingerprint : part.rawHash)?.byteLength === part.expandedBytes && part.hashCompleteness === 'allBytes'),
			true,
		);
		deepStrictEqual(
			inventory.parts.map(part => [part.canonicalUri, part.coverage]),
			[
				['/[Content_Types].xml', 'parsed'],
				['/_rels/.rels', 'parsed'],
				['/word/document.xml', 'parsed'],
				['/word/media/image.bin', 'completeOpaque'],
			],
		);
		deepStrictEqual(
			inventory.relationships.map(relationship => [relationship.id, relationship.sourcePartId, relationship.target, relationship.targetMode, relationship.missing, relationship.cyclic]),
			[['rId1', undefined, '/word/document.xml', 'internal', false, false]],
		);
		deepStrictEqual(
			[
				inventory.outcome,
				inventory.completeness.expectedParts,
				inventory.completeness.visitedParts,
				inventory.completeness.parsedParts,
				inventory.completeness.opaqueParts,
				inventory.completeness.omittedParts,
				inventory.completeness.terminal,
			],
			['complete', 4, 4, 3, 1, 0, true],
		);
	});

	test('requires content types, root relationships, main part, and every internal relationship target', async () => {
		const missingRoot = await createParadisOfficeNodeArchive(await buildOpcFixture({ parts: [['/word/document.xml', '<document/>']] }));
		await rejects(inspectOfficePackage(missingRoot, profile({}), CancellationToken.None), /malformed/);

		const missingTarget = await createParadisOfficeNodeArchive(
			await buildOpcFixture({
				parts: [['/word/document.xml', '<document/>']],
				relationships: [
					{
						id: 'rId1',
						type: officeDocumentRelationship,
						target: 'word/document.xml',
					},
					{
						source: '/word/document.xml',
						id: 'rId2',
						type: 'urn:test',
						target: 'missing.xml',
					},
				],
			}),
		);
		const missingInventory = await inspectOfficePackage(missingTarget, profile({}), CancellationToken.None);
		strictEqual(missingInventory.relationships.find(relationship => relationship.id === 'rId2')?.missing, true);
		strictEqual(missingInventory.outcome, 'blocked');
	});

	test('rejects ContentTypes and Relationships with the right local names but wrong namespaces', async () => {
		for (const [contentTypes, relationships] of [
			['<Types xmlns="urn:wrong"><Override PartName="/word/document.xml" ContentType="application/xml"/></Types>', `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="${officeDocumentRelationship}" Target="word/document.xml"/></Relationships>`],
			['<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Override PartName="/word/document.xml" ContentType="application/xml"/></Types>', `<Relationships xmlns="urn:wrong"><Relationship Id="rId1" Type="${officeDocumentRelationship}" Target="word/document.xml"/></Relationships>`],
		] as const) {
			const archive = new TestArchive([
				{ entry: testEntry('[Content_Types].xml', new TextEncoder().encode(contentTypes).byteLength, new TextEncoder().encode(contentTypes).byteLength), chunks: [new TextEncoder().encode(contentTypes)] },
				{ entry: testEntry('_rels/.rels', new TextEncoder().encode(relationships).byteLength, new TextEncoder().encode(relationships).byteLength), chunks: [new TextEncoder().encode(relationships)] },
				{ entry: testEntry('word/document.xml', 1, 4), chunks: [new TextEncoder().encode('<d/>')] },
			]);
			await rejects(inspectOfficePackage(archive, profile({}), CancellationToken.None), /malformed/);
		}
	});

	test('records an over-budget optional media part as omitted while preserving the required OPC inventory', async () => {
		const inventory = await inspectFixture(
			[
				['/word/document.xml', '<document/>'],
				['/word/media/large.bin', new Uint8Array([1, 2, 3])],
			],
			{ binaryPartBytes: 2 },
		);

		strictEqual(inventory.parts.find(part => part.canonicalUri === '/word/media/large.bin')?.coverage, 'omittedByBudget');
		strictEqual(
			inventory.parts.some(part => part.canonicalUri === '/word/document.xml' && part.coverage === 'parsed'),
			true,
		);
		strictEqual(
			aggregateOfficeOutcome(
				inventory.parts.map(part =>
					part.coverage === 'completeOpaque'
						? {
							coverage: part.coverage,
							required: part.required,
							hashCompleteness: part.hashCompleteness,
							fingerprint: part.fingerprint,
						}
						: { coverage: part.coverage, required: part.required },
				),
			),
			'degraded',
		);
	});

	test('keeps external relationships inert and marks every edge in an internal relationship cycle', async () => {
		const archive = await createParadisOfficeNodeArchive(
			await buildOpcFixture({
				parts: [
					['/word/document.xml', '<document/>'],
					['/word/other.xml', '<other/>'],
				],
				relationships: [
					{
						id: 'rId1',
						type: officeDocumentRelationship,
						target: 'word/document.xml',
					},
					{
						source: '/word/document.xml',
						id: 'rId2',
						type: 'urn:test',
						target: 'other.xml',
					},
					{
						source: '/word/document.xml',
						id: 'rId3',
						type: 'urn:external',
						target: 'https://example.invalid/a',
						targetMode: 'External',
					},
					{
						source: '/word/other.xml',
						id: 'rId4',
						type: 'urn:test',
						target: 'document.xml',
					},
				],
			}),
		);
		const inventory = await inspectOfficePackage(archive, profile({}), CancellationToken.None);

		strictEqual(inventory.security.hasExternalRelationships, true);
		strictEqual(inventory.relationships.find(relationship => relationship.id === 'rId3')?.target, 'https://example.invalid/a');
		strictEqual(
			inventory.relationships.filter(relationship => relationship.id === 'rId2' || relationship.id === 'rId4').every(relationship => relationship.cyclic),
			true,
		);
	});

	test('finds cycles in a 20,000-node graph without recursion', () => {
		const nodes = Array.from({ length: 20_000 }, (_, index) => `/word/part-${index}.xml`);
		const acyclic = nodes.slice(0, -1).map((source, index) => ({ source, target: nodes[index + 1], targetMode: 'internal' as const }));
		const cyclic = [...acyclic, { source: nodes[nodes.length - 1], target: nodes[0], targetMode: 'internal' as const }];

		strictEqual(findParadisOfficeRelationshipCyclesForTest(nodes, acyclic).every(value => !value), true);
		strictEqual(findParadisOfficeRelationshipCyclesForTest(nodes, cyclic).every(value => value), true);
	});

	test('marks only complete internal SCC edges as cyclic', () => {
		const cycles = findParadisOfficeRelationshipCyclesForTest(
			['/word/a.xml', '/word/b.xml', '/word/c.xml', '/word/d.xml', '/word/e.xml'],
			[
				{ source: '/word/a.xml', target: '/word/b.xml', targetMode: 'internal' },
				{ source: '/word/b.xml', target: '/word/a.xml', targetMode: 'internal' },
				{ source: '/word/c.xml', target: '/word/c.xml', targetMode: 'internal' },
				{ source: '/word/d.xml', target: '/word/e.xml', targetMode: 'internal' },
				{ source: '/word/e.xml', target: '/word/missing.xml', targetMode: 'internal' },
				{ source: '/word/a.xml', target: 'https://example.invalid/a', targetMode: 'external' },
				{ source: '/', target: '/word/a.xml', targetMode: 'internal' },
				{ source: '/word/a.xml', target: '/word/b.xml', targetMode: 'internal' },
			],
		);

		deepStrictEqual(cycles, [true, true, true, false, false, false, false, true]);
	});

	test('propagates cancellation and deadline checkpoints while finding deep SCCs', () => {
		const nodes = Array.from({ length: 20_000 }, (_, index) => `/word/part-${index}.xml`);
		const relationships = nodes.map((source, index) => ({ source, target: nodes[(index + 1) % nodes.length], targetMode: 'internal' as const }));
		let cancellationChecks = 0;
		let deadlineChecks = 0;

		throws(
			() => findParadisOfficeRelationshipCyclesForTest(nodes, relationships, () => {
				if (++cancellationChecks === 80_000) {
					throw new ParadisOfficePackageError('cancelled');
				}
			}),
			error => error instanceof ParadisOfficePackageError && error.code === 'cancelled',
		);
		throws(
			() => findParadisOfficeRelationshipCyclesForTest(nodes, relationships, () => {
				if (++deadlineChecks === 80_000) {
					throw new ParadisOfficePackageError('limitExceeded');
				}
			}),
			error => error instanceof ParadisOfficePackageError && error.code === 'limitExceeded',
		);
	});

	test('reports unreferenced parts as metadata-only orphan inventory instead of silently dropping them', async () => {
		const inventory = await inspectFixture([
			['/word/document.xml', '<document/>'],
			['/word/custom/orphan.xml', '<orphan/>'],
		]);

		strictEqual(inventory.features.find(feature => feature.kind === 'orphanPart')?.partIds.includes('/word/custom/orphan.xml'), true);
	});

	test('keeps a disconnected relationship cycle A↔B in orphan inventory', async () => {
		const archive = await createParadisOfficeNodeArchive(
			await buildOpcFixture({
				parts: [['/word/document.xml', '<document/>'], ['/word/a.xml', '<a/>'], ['/word/b.xml', '<b/>']],
				relationships: [
					{ id: 'rId1', type: officeDocumentRelationship, target: 'word/document.xml' },
					{ source: '/word/a.xml', id: 'rId2', type: 'urn:test', target: 'b.xml' },
					{ source: '/word/b.xml', id: 'rId3', type: 'urn:test', target: 'a.xml' },
				],
			}),
		);
		const inventory = await inspectOfficePackage(archive, profile({}), CancellationToken.None);
		const orphan = inventory.features.find(feature => feature.kind === 'orphanPart');
		strictEqual(orphan?.partIds.includes('/word/a.xml'), true);
		strictEqual(orphan?.partIds.includes('/word/b.xml'), true);
	});

	test('owns the Node archive input before callers mutate their source buffer', async () => {
		const fixture = await buildOpcFixture({
			parts: [['/word/document.xml', '<document/>']],
			relationships: [
				{
					id: 'rId1',
					type: officeDocumentRelationship,
					target: 'word/document.xml',
				},
			],
		});
		const archive = await createParadisOfficeNodeArchive(fixture);
		fixture.fill(0);
		const inventory = await inspectOfficePackage(archive, profile({}), CancellationToken.None);

		strictEqual(inventory.format, 'docx');
	});

	test('uses actual container bytes, including ZIP padding, instead of central-directory declarations', async () => {
		const fixture = await buildOpcFixture({
			parts: [['/word/document.xml', '<document/>']],
			relationships: [
				{
					id: 'rId1',
					type: officeDocumentRelationship,
					target: 'word/document.xml',
				},
			],
		});
		const padded = new Uint8Array(fixture.byteLength + 128);
		padded.set(fixture);
		const exact = await createParadisOfficeNodeArchive(fixture);

		strictEqual((await inspectOfficePackage(exact, profile({ compressedInputBytes: fixture.byteLength }), CancellationToken.None)).format, 'docx');
		await rejects(createParadisOfficeNodeArchive(padded), /invalid/);
	});

	test('blocks symlink metadata before the entry stream is consumed', async () => {
		const archive = new TestArchive([
			{
				entry: { ...testEntry('unsafe-link', 0, 0), symlink: true },
				chunks: [],
			},
		]);

		await rejects(inspectOfficePackage(archive, profile({}), CancellationToken.None), /unsafe/);
	});

	test('sanitizes concrete ZIP open errors without exposing parser paths or stacks', async () => {
		await rejects(createParadisOfficeNodeArchive(new Uint8Array([0, 1, 2, 3])), error => error instanceof Error && error.message === 'invalid');
	});

	test('canonicalizes namespace prefixes and attribute order without changing preserved text whitespace', async () => {
		const first = await canonicalizeXmlStringForTest('<a:x xmlns:a="urn:test" b="2" a="1"><a:y>  keep  </a:y></a:x>');
		const second = await canonicalizeXmlStringForTest('<q:x xmlns:q="urn:test" a="1" b="2">\n <q:y>  keep  </q:y>\n</q:x>');

		strictEqual(first.hash.value, second.hash.value);
		strictEqual(first.canonical.includes('  keep  '), true);
	});

	test('canonicalizes relationship IDs, xml:space, and unknown subtrees without silently dropping either MC branch', async () => {
		const withFirstId = await canonicalizeXmlStringForTest(
			'<p:a xmlns:p="urn:p" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" r:id="rId1"><x:unknown xmlns:x="urn:x"/><p:b xml:space="preserve">\n  keep indent\n</p:b><mc:Choice xmlns:mc="urn:mc">one</mc:Choice><mc:Fallback xmlns:mc="urn:mc">two</mc:Fallback></p:a>',
			id => (id === 'rId1' ? '/word/media/a.bin' : undefined),
		);
		const withSecondId = await canonicalizeXmlStringForTest(
			'<q:a xmlns:q="urn:p" xmlns:s="http://schemas.openxmlformats.org/officeDocument/2006/relationships" s:id="rId9"><x:unknown xmlns:x="urn:x"/><q:b xml:space="preserve">\n  keep indent\n</q:b><mc:Choice xmlns:mc="urn:mc">one</mc:Choice><mc:Fallback xmlns:mc="urn:mc">two</mc:Fallback></q:a>',
			id => (id === 'rId9' ? '/word/media/a.bin' : undefined),
		);

		strictEqual(withFirstId.hash.value, withSecondId.hash.value);
		strictEqual(withFirstId.sourceRefs.length > 0, true);
		strictEqual(withFirstId.canonical.includes('one') && withFirstId.canonical.includes('two'), true);
	});

	test('retains hashes for selected and nonselected markup-compatibility branches', async () => {
		const result = await canonicalizeXmlStringForTest(
			'<x xmlns:mc="http://schemas.openxmlformats.org/markup-compatibility/2006"><mc:Choice Requires="w">selected</mc:Choice><mc:Fallback>fallback</mc:Fallback></x>',
			() => undefined,
		);

		strictEqual(result.markupCompatibility.length, 2);
		strictEqual(
			result.markupCompatibility.every(branch => branch.hash.algorithm === 'sha256'),
			true,
		);
	});

	test('selects supported nested MC Choice while retaining fallback and SourceRefs', () => {
		const result = canonicalizeOfficeXml(
			{
				root: {
					kind: 'element',
					uri: 'urn:test',
					local: 'root',
					attributes: [],
					namespaceBindings: {
						w: 'http://schemas.openxmlformats.org/wordprocessingml/2006/main',
					},
					children: [
						{
							kind: 'element',
							uri: 'urn:test',
							local: 'holder',
							attributes: [],
							children: [
								{
									kind: 'element',
									uri: 'http://schemas.openxmlformats.org/markup-compatibility/2006',
									local: 'Choice',
									namespaceBindings: {
										w: 'http://schemas.openxmlformats.org/wordprocessingml/2006/main',
									},
									attributes: [{ uri: '', local: 'Requires', value: 'w' }],
									children: [
										{
											kind: 'element',
											uri: 'urn:test',
											local: 'selected',
											attributes: [],
											children: [],
										},
									],
								},
								{
									kind: 'element',
									uri: 'http://schemas.openxmlformats.org/markup-compatibility/2006',
									local: 'Fallback',
									attributes: [],
									children: [
										{
											kind: 'element',
											uri: 'urn:test',
											local: 'fallback',
											attributes: [],
											children: [],
										},
									],
								},
							],
						},
					],
				},
			},
			() => undefined,
		);

		strictEqual(result.markupCompatibility.length, 2);
		strictEqual(result.markupCompatibility.filter(branch => branch.selected).length, 1);
		strictEqual(
			result.markupCompatibility.every(branch => branch.sourceRef.hash.value === branch.hash.value),
			true,
		);
	});

	test('permits No Changes only for a terminal complete manifest with no omitted parts', () => {
		strictEqual(
			canReportNoChanges(
				{
					expectedParts: 1,
					visitedParts: 1,
					parsedParts: 1,
					opaqueParts: 0,
					failedParts: 0,
					omittedParts: 0,
					expectedSemanticUnits: 1,
					visitedSemanticUnits: 1,
					terminal: true,
				},
				'complete',
				0,
			),
			true,
		);
		strictEqual(
			canReportNoChanges(
				{
					expectedParts: 1,
					visitedParts: 1,
					parsedParts: 0,
					opaqueParts: 0,
					failedParts: 0,
					omittedParts: 1,
					expectedSemanticUnits: 1,
					visitedSemanticUnits: 1,
					terminal: true,
				},
				'degraded',
				0,
			),
			false,
		);
	});

	test('rejects DTDs, malformed XML, and XML resource limits at the exact boundary', async () => {
		strictEqual(
			(await canonicalizeXmlStringForTest('<a><b/></a>', () => undefined, {
				depth: 2,
				nodes: 2,
				attributeLength: 1,
				characters: 100,
			})).canonical.length > 0,
			true,
		);
		await rejects(canonicalizeXmlStringForTest('<!DOCTYPE a [<!ENTITY x "x">]><a>&x;</a>'), /malformed/);
		await rejects(canonicalizeXmlStringForTest('<a>', () => undefined, { depth: 2, nodes: 10, attributeLength: 10, characters: 100 }), /malformed/);
		await rejects(canonicalizeXmlStringForTest('<a><b><c/></b></a>', () => undefined, { depth: 2, nodes: 10, attributeLength: 10, characters: 100 }), /limitExceeded/);
	});

	test('observes cancellation before reading further entry chunks', async () => {
		const source = new CancellationTokenSource();
		const archive = new TestArchive([
			{
				entry: testEntry('[Content_Types].xml', 2, 2),
				chunks: [new Uint8Array([1]), new Uint8Array([2])],
			},
		]);
		source.cancel();

		await rejects(inspectOfficePackage(archive, profile({}), source.token), /cancelled/);
	});

	test('cancels a concrete Node archive before it opens a ZIP entry stream', async () => {
		const archive = await createParadisOfficeNodeArchive(
			await buildOpcFixture({
				parts: [['/word/document.xml', '<document/>']],
				relationships: [
					{
						id: 'rId1',
						type: officeDocumentRelationship,
						target: 'word/document.xml',
					},
				],
			}),
		);
		const source = new CancellationTokenSource();
		source.cancel();

		await rejects(inspectOfficePackage(archive, profile({}), source.token), /cancelled/);
	});

	test('counts directory metadata in the entry budget before deciding whether its stream is readable', async () => {
		const archive = new TestArchive([
			{ entry: { ...testEntry('one/', 0, 0), directory: true }, chunks: [] },
			{ entry: { ...testEntry('two/', 0, 0), directory: true }, chunks: [] },
		]);

		await rejects(inspectOfficePackage(archive, profile({ entryCount: 1 }), CancellationToken.None), /limitExceeded/);
	});

	test('enforces an injected inspect deadline and reports its warning boundary', async () => {
		const archive = new TestArchive([
			{
				entry: testEntry('[Content_Types].xml', 1, 1),
				chunks: [new Uint8Array([0])],
			},
		]);
		let call = 0;

		await rejects(inspectOfficePackage(archive, profile({ inspectMilliseconds: 1 }), CancellationToken.None, { now: () => (call++ === 0 ? 0 : 2) }), /limitExceeded/);
	});

	test('returns budget warnings and an actual terminal completeness manifest', async () => {
		const archive = await createParadisOfficeNodeArchive(
			await buildOpcFixture({
				parts: [['/word/document.xml', '<document/>']],
				relationships: [
					{
						id: 'rId1',
						type: officeDocumentRelationship,
						target: 'word/document.xml',
					},
				],
			}),
		);
		let call = 0;
		const inventory = await inspectOfficePackage(archive, profile({ inspectMilliseconds: 10 }), CancellationToken.None, { now: () => (call++ === 0 ? 0 : 9) });

		deepStrictEqual(inventory.warnings.map(warning => warning.code), ['budget.inspectTime']);
		strictEqual(inventory.completeness.terminal, true);
		strictEqual(inventory.completeness.expectedParts, inventory.parts.length);
	});

	test('observes an inspect deadline from XML parser checkpoints', async () => {
		const archive = await createParadisOfficeNodeArchive(await buildOpcFixture({ parts: [['/word/document.xml', '<d><a/><b/><c/></d>']], relationships: [{ id: 'rId1', type: officeDocumentRelationship, target: 'word/document.xml' }] }));
		let calls = 0;
		await rejects(inspectOfficePackage(archive, profile({ inspectMilliseconds: 1 }), CancellationToken.None, { now: () => ++calls < 8 ? 0 : 2 }), /limitExceeded/);
	});

	test('observes an inspect deadline while traversing relationship graph metadata', async () => {
		const relationships = [{ id: 'rId1', type: officeDocumentRelationship, target: 'word/document.xml' }, ...Array.from({ length: 64 }, (_, index) => ({ source: `/word/${index}.xml`, id: `r${index}`, type: 'urn:test', target: `${(index + 1) % 64}.xml` }))];
		const parts: [string, string][] = [['/word/document.xml', '<d/>'], ...Array.from({ length: 64 }, (_, index) => [`/word/${index}.xml`, '<d/>'] as [string, string])];
		const archive = await createParadisOfficeNodeArchive(await buildOpcFixture({ parts, relationships }));
		let calls = 0;
		await rejects(inspectOfficePackage(archive, profile({ inspectMilliseconds: 1 }), CancellationToken.None, { now: () => ++calls < 200 ? 0 : 2 }), /limitExceeded/);
	});

	test('uses each profile XML depth rather than a desktop fixed parser limit', async () => {
		await inspectFixture([['/word/document.xml', '<a><b/></a>']], {
			xmlDepth: 2,
			xmlNodesPerPart: 100,
		});
		const archive = await createParadisOfficeNodeArchive(
			await buildOpcFixture({
				parts: [['/word/document.xml', '<a><b><c/></b></a>']],
				relationships: [
					{
						id: 'rId1',
						type: officeDocumentRelationship,
						target: 'word/document.xml',
					},
				],
			}),
		);

		const inventory = await inspectOfficePackage(archive, profile({ xmlDepth: 2, xmlNodesPerPart: 100 }), CancellationToken.None);
		strictEqual(inventory.outcome, 'blocked');
		strictEqual(inventory.parts.find(part => part.canonicalUri === '/word/document.xml')?.coverage, 'failed');
	});

	test('applies desktop, remote, and browser XML depth/node limits at exact and plus-one boundaries', async () => {
		for (const preset of Object.values(PARADIS_OFFICE_BUDGET_PROFILES)) {
			const exactDepth = '<a>'.repeat(preset.xmlDepth) + '</a>'.repeat(preset.xmlDepth);
			await canonicalizeXmlStringForTest(exactDepth, () => undefined, {
				depth: preset.xmlDepth,
				nodes: preset.xmlNodesPerPart,
				attributeLength: preset.attributeLength,
				characters: preset.xmlPartBytes,
			});
			const overDepth = '<a>'.repeat(preset.xmlDepth + 1) + '</a>'.repeat(preset.xmlDepth + 1);
			await rejects(canonicalizeXmlStringForTest(overDepth, () => undefined, { depth: preset.xmlDepth, nodes: preset.xmlNodesPerPart, attributeLength: preset.attributeLength, characters: preset.xmlPartBytes }), /limitExceeded/);
		}
	});

	test('rejects parser duplicate attributes while accepting quoted greater-than and unprefixed attributes', async () => {
		const valid = await inspectFixture([['/word/document.xml', '<d xmlns="urn:default" plain="a > b"><c/></d>']]);
		strictEqual(valid.parts.find(part => part.canonicalUri === '/word/document.xml')?.coverage, 'parsed');
		const duplicate = await createParadisOfficeNodeArchive(
			await buildOpcFixture({
				parts: [['/word/document.xml', '<d a="1" a="2"/>']],
				relationships: [
					{
						id: 'rId1',
						type: officeDocumentRelationship,
						target: 'word/document.xml',
					},
				],
			}),
		);
		const inventory = await inspectOfficePackage(duplicate, profile({}), CancellationToken.None);
		strictEqual(inventory.outcome, 'blocked');
		strictEqual(inventory.parts.find(part => part.canonicalUri === '/word/document.xml')?.coverage, 'failed');
	});

	test('parses XML declarations, comments, CDATA, entities, namespaces, and Unicode names deterministically', () => {
		const document = parseParadisOfficeXml('<?xml version="1.0"?><!-- ignored --><α:root xmlns:α="urn:root" xmlns:p="urn:attribute" plain="a &gt; b" p:名=\'&#x41;&#65;\'><child><![CDATA[x<y]]>&amp;&quot;&apos;</child></α:root>', { depth: 4, nodes: 2, attributeLength: 16, characters: 64 });
		deepStrictEqual(document, {
			root: {
				kind: 'element', uri: 'urn:root', local: 'root', namespaceBindings: { α: 'urn:root', p: 'urn:attribute' },
				attributes: [{ uri: '', local: 'plain', value: 'a > b' }, { uri: 'urn:attribute', local: '名', value: 'AA' }],
				children: [{ kind: 'element', uri: '', local: 'child', namespaceBindings: { α: 'urn:root', p: 'urn:attribute' }, attributes: [], children: [{ kind: 'text', value: 'x<y' }, { kind: 'text', value: '&"\'' }] }],
			},
		});
	});

	test('uses the same literal XML tree and canonical hash through the Node archive adapter', async () => {
		const xml = '<p:root xmlns:p="urn:root" xmlns:a="urn:attribute" a:value="a &gt; b"><p:child><![CDATA[cdata]]>&amp;</p:child></p:root>';
		const limits = { depth: 4, nodes: 2, attributeLength: 32, characters: 32 };
		const archive = await createParadisOfficeNodeArchive(await buildOpcFixture({ parts: [['/word/document.xml', '<document/>']], relationships: [{ id: 'rId1', type: officeDocumentRelationship, target: 'word/document.xml' }] }));
		const nodeDocument = await archive.parseXml(xml, limits);
		const commonDocument = parseParadisOfficeXml(xml, limits);
		deepStrictEqual(nodeDocument, commonDocument);
		strictEqual(canonicalizeOfficeXml(nodeDocument, () => undefined).hash.value, canonicalizeOfficeXml(commonDocument, () => undefined).hash.value);
	});

	test('rejects malformed XML names, namespace bindings, entities, and document shape', () => {
		for (const xml of [
			'<a:b:c/>', '<p:root/>', '<root p:value="x"/>', '<root xmlns:p="urn:x" xmlns:q="urn:x" p:a="1" q:a="2"/>',
			'<root>&unknown;</root>', '<root>&#X41;</root>', '<root></other>', '<one/><two/>', '<root/><!DOCTYPE root>', '<root xmlns:xml="urn:wrong"/>', '<root xmlns:xmlns="urn:x"/>', '<root xmlns="http://www.w3.org/XML/1998/namespace"/>',
		]) {
			throws(() => parseParadisOfficeXml(xml, { depth: 4, nodes: 4, attributeLength: 128, characters: 128 }), /malformed/);
		}
	});

	test('enforces XML parser limits and cancellation with bounded checkpoints', () => {
		throws(() => parseParadisOfficeXml('<a><b/></a>', { depth: 1, nodes: 2, attributeLength: 16, characters: 16 }), /limitExceeded/);
		throws(() => parseParadisOfficeXml('<a value="abcdef"/>', { depth: 1, nodes: 1, attributeLength: 5, characters: 16 }), /limitExceeded/);
		throws(() => parseParadisOfficeXml('<a>abcdef</a>', { depth: 1, nodes: 1, attributeLength: 16, characters: 5 }), /limitExceeded/);
		const source = new CancellationTokenSource();
		source.cancel();
		throws(() => parseParadisOfficeXml('<a/>', { depth: 1, nodes: 1, attributeLength: 16, characters: 16 }, source.token), /cancelled/);
		let checkpoints = 0;
		parseParadisOfficeXml(`<a>${'x'.repeat(4096)}</a>`, { depth: 1, nodes: 1, attributeLength: 16, characters: 4096 }, undefined, () => { checkpoints++; });
		strictEqual(checkpoints >= 2, true);
	});

	test('counts decoded attribute values toward the document limit before parsing the remaining attribute data', () => {
		let checkpoints = 0;
		throws(
			() => parseParadisOfficeXml('<a first="abc" second="sentinel"/>', { depth: 1, nodes: 1, attributeLength: 8, characters: 3 }, undefined, () => { checkpoints++; }),
			/limitExceeded/,
		);
		strictEqual(checkpoints, 1);
		throws(() => parseParadisOfficeXml('<a value="&amp;&amp;&amp;&amp;"/>', { depth: 1, nodes: 1, attributeLength: 3, characters: 8 }), /limitExceeded/);
		throws(() => parseParadisOfficeXml('<a first="ab" second="cd"/>', { depth: 1, nodes: 1, attributeLength: 2, characters: 3 }), /limitExceeded/);
	});

	test('rejects a one MiB attribute at limit plus one before processing its following sentinel', () => {
		const attribute = 'x'.repeat(1024 * 1024);
		let checkpoints = 0;
		throws(
			() => parseParadisOfficeXml(`<a value="${attribute}x" after="sentinel"/>`, { depth: 1, nodes: 1, attributeLength: attribute.length, characters: attribute.length }, undefined, () => { checkpoints++; }),
			/limitExceeded/,
		);
		strictEqual(checkpoints < 260, true);
	});

	test('normalizes XML line endings and literal attribute whitespace without normalizing character references', () => {
		const crlf = parseParadisOfficeXml('<a value="x\r\ny\rz\tq">one\r\ntwo\rthree</a>', { depth: 1, nodes: 1, attributeLength: 16, characters: 32 });
		const lf = parseParadisOfficeXml('<a value="x y z q">one\ntwo\nthree</a>', { depth: 1, nodes: 1, attributeLength: 16, characters: 32 });
		deepStrictEqual(crlf, lf);
		deepStrictEqual(
			parseParadisOfficeXml('<a value="&#9;&#10;&#13;&amp;"/>', { depth: 1, nodes: 1, attributeLength: 8, characters: 8 }).root.attributes,
			[{ uri: '', local: 'value', value: '\t\n\r&' }],
		);
	});

	test('accepts only a strict XML 1.0 declaration at the document start and rejects reserved PI targets', () => {
		parseParadisOfficeXml('<?xml version="1.0" encoding="UTF-8" standalone="yes"?><a/>', { depth: 1, nodes: 1, attributeLength: 1, characters: 1 });
		parseParadisOfficeXml('<?xml version=\'1.0\' encoding=\'utf8\' standalone=\'no\' ?><a/>', { depth: 1, nodes: 1, attributeLength: 1, characters: 1 });
		for (const xml of [
			'<a/><?xml version="1.0"?>',
			' <?xml version="1.0"?><a/>',
			'<?xml encoding="UTF-8" version="1.0"?><a/>',
			'<?xml version="1.1"?><a/>',
			'<?xml version="1.0" encoding="UTF-16"?><a/>',
			'<?xml version="1.0" standalone="maybe"?><a/>',
			'<?xml version="1.0" extra="no"?><a/>',
			'<a><?XML ok?></a>',
		]) {
			throws(() => parseParadisOfficeXml(xml, { depth: 1, nodes: 1, attributeLength: 32, characters: 32 }), /malformed/);
		}
	});

	test('rejects malformed comment, CDATA, and processing-instruction terminators', () => {
		for (const xml of ['<a><!-- invalid -- comment --></a>', '<a><![CDATA[unterminated</a>', '<a><?test unterminated</a>']) {
			throws(() => parseParadisOfficeXml(xml, { depth: 1, nodes: 1, attributeLength: 1, characters: 32 }), /malformed/);
		}
	});

	test('normalizes only Office relationship namespace id attributes', () => {
		const transitional = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';
		const strict = 'http://purl.oclc.org/ooxml/officeDocument/relationships';
		const resolve = (id: string) => id === 'rId1' || id === 'rId2' ? '/word/media/a.bin' : undefined;
		const first = canonicalizeOfficeXml(parseParadisOfficeXml(`<a xmlns:r="${transitional}" r:id="rId1"/>`, { depth: 1, nodes: 1, attributeLength: 128, characters: 128 }), resolve);
		const second = canonicalizeOfficeXml(parseParadisOfficeXml(`<a xmlns:r="${transitional}" r:id="rId2"/>`, { depth: 1, nodes: 1, attributeLength: 128, characters: 128 }), resolve);
		const strictResult = canonicalizeOfficeXml(parseParadisOfficeXml(`<a xmlns:r="${strict}" r:id="rId2"/>`, { depth: 1, nodes: 1, attributeLength: 128, characters: 128 }), resolve);
		const plainFirst = canonicalizeOfficeXml(parseParadisOfficeXml('<a id="rId1" xmlns:plain="urn:plain" plain:id="rId1"/>', { depth: 1, nodes: 1, attributeLength: 128, characters: 128 }), resolve);
		const plainSecond = canonicalizeOfficeXml(parseParadisOfficeXml('<a id="rId2" xmlns:plain="urn:plain" plain:id="rId2"/>', { depth: 1, nodes: 1, attributeLength: 128, characters: 128 }), resolve);

		strictEqual(first.hash.value, second.hash.value);
		strictEqual(strictResult.canonical.includes('/word/media/a.bin'), true);
		strictEqual(plainFirst.hash.value === plainSecond.hash.value, false);
	});

	test('matches Node SHA-256 for canonical XML boundary lengths and Unicode', () => {
		for (const xml of ['<a/>', '<a>abc</a>', `<a>${'x'.repeat(55)}</a>`, `<a>${'x'.repeat(56)}</a>`, `<a>${'x'.repeat(64)}</a>`, '<a>東京😀</a>']) {
			const result = canonicalizeOfficeXml(parseParadisOfficeXml(xml, { depth: 1, nodes: 1, attributeLength: 1, characters: 128 }), () => undefined);
			strictEqual(result.hash.value, createHash('sha256').update(result.canonical).digest('hex'));
		}
		strictEqual(canonicalizeOfficeXml(parseParadisOfficeXml('<a>abc</a>', { depth: 1, nodes: 1, attributeLength: 1, characters: 3 }), () => undefined).hash.value, '839597b446fd7d49db02157688112c9c4594162f607f3984d2497b8a0bf427f7');
	});

	test('canonicalizes one MiB XML text with parser checkpoints and cancellation', () => {
		const text = 'x'.repeat(1024 * 1024);
		let checkpoints = 0;
		const document = parseParadisOfficeXml(`<a>${text}</a>`, { depth: 1, nodes: 1, attributeLength: 1, characters: text.length }, undefined, () => { checkpoints++; });
		const result = canonicalizeOfficeXml(document, () => undefined, () => { checkpoints++; });
		strictEqual(result.hash.value, createHash('sha256').update(result.canonical).digest('hex'));
		strictEqual(checkpoints > 2, true);
		throws(() => canonicalizeOfficeXml(document, () => undefined, () => { throw new ParadisOfficePackageError('cancelled'); }), /cancelled/);
	});

	test('keeps canonicalization reentrant after a malformed call', async () => {
		await rejects(canonicalizeXmlStringForTest('<a>'), /malformed/);
		strictEqual((await canonicalizeXmlStringForTest('<a><b/></a>')).canonical.length > 0, true);
	});

	test('rejects malformed QName/control/surrogate XML before entity processing', async () => {
		for (const xml of ['<a:b:c/>', '<a>\u0001</a>', '<a>\ud800</a>', '<!DOCTYPE a [<!ENTITY x "x">]><a>&x;</a>']) {
			await rejects(canonicalizeXmlStringForTest(xml), /malformed/);
		}
	});

	test('does not apply a default element namespace to unprefixed attributes', () => {
		const canonical = canonicalizeOfficeXml(
			{
				root: {
					kind: 'element',
					uri: 'urn:default',
					local: 'root',
					attributes: [{ uri: '', local: 'plain', value: 'value' }],
					children: [],
				},
			},
			() => undefined,
		).canonical;

		strictEqual(canonical.includes('[{}plain="value"]'), true);
	});

	test('observes cancellation checkpoints during canonical tree traversal', () => {
		throws(
			() => canonicalizeOfficeXml({ root: { kind: 'element', uri: '', local: 'root', attributes: [], children: Array.from({ length: 4097 }, () => ({ kind: 'element' as const, uri: '', local: 'n', attributes: [], children: [] })) } }, () => undefined, () => { throw new ParadisOfficePackageError('cancelled'); }),
			/cancelled/,
		);
	});
});
