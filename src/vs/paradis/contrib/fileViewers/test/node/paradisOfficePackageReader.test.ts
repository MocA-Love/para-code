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
import { canonicalizeOfficeXml, canonicalizeOfficeXmlTree, type ParadisOfficeXmlLimits } from '../../common/office/paradisOfficeCanonicalXml.js';
import { type IParadisOfficeArchive, type ParadisOfficeArchiveEntry, type ParadisOfficeXmlDocument, type ParadisOfficeXmlNode } from '../../common/office/paradisOfficeArchive.js';
import { inspectOfficePackage } from '../../common/office/paradisOfficePackageCore.js';
import { createParadisOfficeNodeArchive } from '../../node/office/paradisOfficeNodeArchive.js';
import { buildOpcFixture } from '../common/paradisOfficeFixture.js';

const officeDocumentRelationship = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument';

function profile(overrides: Partial<ParadisOfficeBudgetProfile>): ParadisOfficeBudgetProfile {
	return { ...PARADIS_OFFICE_BUDGET_PROFILES.desktopLocal, ...overrides };
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
		const document = new DOMParser().parseFromString(xml, 'application/xml');
		if (document.querySelector('parsererror') || !document.documentElement) {
			throw new Error('malformed');
		}
		let nodes = 0;
		const convert = (node: Node, depth: number): ParadisOfficeXmlNode | undefined => {
			if (node.nodeType === Node.TEXT_NODE) {
				return { kind: 'text', value: node.textContent ?? '' };
			}
			if (node.nodeType !== Node.ELEMENT_NODE) {
				return undefined;
			}
			if (++nodes > limits.nodes || depth > limits.depth) {
				throw new Error('limitExceeded');
			}
			const element = node as Element;
			return {
				kind: 'element',
				uri: element.namespaceURI ?? '',
				local: element.localName ?? element.nodeName,
				attributes: [...element.attributes]
					.filter(attribute => !attribute.name.startsWith('xmlns'))
					.map(attribute => ({
						uri: attribute.namespaceURI ?? '',
						local: attribute.localName ?? attribute.name,
						value: attribute.value,
					})),
				children: [...element.childNodes].map(child => convert(child, depth + 1)).filter((child): child is ParadisOfficeXmlNode => child !== undefined),
			};
		};
		const root = convert(document.documentElement, 1);
		if (!root || root.kind !== 'element') {
			throw new Error('malformed');
		}
		return { root };
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

		await rejects(inspectOfficePackage(exact, profile({ compressedInputBytes: 1 }), CancellationToken.None), /malformed/);
		await rejects(inspectOfficePackage(over, profile({ compressedInputBytes: 1 }), CancellationToken.None), /limitExceeded/);
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
				entry: testEntry('[Content_Types].xml', 2, 1),
				chunks: [new Uint8Array([1, 2])],
			},
			{
				entry: testEntry('word/document.xml', 1, 1),
				chunks: [new Uint8Array([3, 4])],
			},
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

	test('reports unreferenced parts as metadata-only orphan inventory instead of silently dropping them', async () => {
		const inventory = await inspectFixture([
			['/word/document.xml', '<document/>'],
			['/word/custom/orphan.xml', '<orphan/>'],
		]);

		strictEqual(inventory.features.find(feature => feature.kind === 'orphanPart')?.partIds.includes('/word/custom/orphan.xml'), true);
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

	test('canonicalizes namespace prefixes and attribute order without changing preserved text whitespace', () => {
		const first = canonicalizeOfficeXml('<a:x xmlns:a="urn:test" b="2" a="1"><a:y>  keep  </a:y></a:x>', () => undefined);
		const second = canonicalizeOfficeXml('<q:x xmlns:q="urn:test" a="1" b="2">\n <q:y>  keep  </q:y>\n</q:x>', () => undefined);

		strictEqual(first.hash.value, second.hash.value);
		strictEqual(first.canonical.includes('  keep  '), true);
	});

	test('canonicalizes relationship IDs, xml:space, and unknown subtrees without silently dropping either MC branch', () => {
		const withFirstId = canonicalizeOfficeXml(
			'<p:a xmlns:p="urn:p" xmlns:r="urn:r" r:id="rId1"><x:unknown xmlns:x="urn:x"/><p:b xml:space="preserve">\n  keep indent\n</p:b><mc:Choice xmlns:mc="urn:mc">one</mc:Choice><mc:Fallback xmlns:mc="urn:mc">two</mc:Fallback></p:a>',
			id => (id === 'rId1' ? '/word/media/a.bin' : undefined),
		);
		const withSecondId = canonicalizeOfficeXml(
			'<q:a xmlns:q="urn:p" xmlns:s="urn:r" s:id="rId9"><x:unknown xmlns:x="urn:x"/><q:b xml:space="preserve">\n  keep indent\n</q:b><mc:Choice xmlns:mc="urn:mc">one</mc:Choice><mc:Fallback xmlns:mc="urn:mc">two</mc:Fallback></q:a>',
			id => (id === 'rId9' ? '/word/media/a.bin' : undefined),
		);

		strictEqual(withFirstId.hash.value, withSecondId.hash.value);
		strictEqual(withFirstId.sourceRefs.length > 0, true);
		strictEqual(withFirstId.canonical.includes('one') && withFirstId.canonical.includes('two'), true);
	});

	test('retains hashes for selected and nonselected markup-compatibility branches', () => {
		const result = canonicalizeOfficeXml(
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
		const result = canonicalizeOfficeXmlTree(
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

	test('rejects DTDs, malformed XML, and XML resource limits at the exact boundary', () => {
		strictEqual(
			canonicalizeOfficeXml('<a><b/></a>', () => undefined, {
				depth: 2,
				nodes: 2,
				attributeLength: 1,
				characters: 100,
			}).canonical.length > 0,
			true,
		);
		throws(() => canonicalizeOfficeXml('<!DOCTYPE a [<!ENTITY x "x">]><a>&x;</a>', () => undefined, { depth: 2, nodes: 10, attributeLength: 10, characters: 100 }), /malformed/);
		throws(
			() =>
				canonicalizeOfficeXml('<a>', () => undefined, {
					depth: 2,
					nodes: 10,
					attributeLength: 10,
					characters: 100,
				}),
			/malformed/,
		);
		throws(
			() =>
				canonicalizeOfficeXml('<a><b><c/></b></a>', () => undefined, {
					depth: 2,
					nodes: 10,
					attributeLength: 10,
					characters: 100,
				}),
			/limitExceeded/,
		);
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

		strictEqual(inventory.warnings.length > 0, true);
		strictEqual(inventory.completeness.terminal, true);
		strictEqual(inventory.completeness.expectedParts, inventory.parts.length);
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

	test('applies desktop, remote, and browser XML depth/node limits at exact and plus-one boundaries', () => {
		for (const preset of Object.values(PARADIS_OFFICE_BUDGET_PROFILES)) {
			const exactDepth = '<a>'.repeat(preset.xmlDepth) + '</a>'.repeat(preset.xmlDepth);
			canonicalizeOfficeXml(exactDepth, () => undefined, {
				depth: preset.xmlDepth,
				nodes: preset.xmlNodesPerPart,
				attributeLength: preset.attributeLength,
				characters: preset.xmlPartBytes,
			});
			const overDepth = '<a>'.repeat(preset.xmlDepth + 1) + '</a>'.repeat(preset.xmlDepth + 1);
			throws(
				() =>
					canonicalizeOfficeXml(overDepth, () => undefined, {
						depth: preset.xmlDepth,
						nodes: preset.xmlNodesPerPart,
						attributeLength: preset.attributeLength,
						characters: preset.xmlPartBytes,
					}),
				/limitExceeded/,
			);
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

	test('keeps canonicalization reentrant after a malformed call', () => {
		throws(() => canonicalizeOfficeXml('<a>', () => undefined), /malformed/);
		strictEqual(canonicalizeOfficeXml('<a><b/></a>', () => undefined).canonical.length > 0, true);
	});

	test('rejects malformed QName/control/surrogate XML before entity processing', () => {
		for (const xml of ['<a:b:c/>', '<a>\u0001</a>', '<a>\ud800</a>', '<!DOCTYPE a [<!ENTITY x "x">]><a>&x;</a>']) {
			throws(() => canonicalizeOfficeXml(xml, () => undefined), /malformed/);
		}
	});

	test('does not apply a default element namespace to unprefixed attributes', () => {
		const canonical = canonicalizeOfficeXmlTree(
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
});
