/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import type { CancellationToken } from '../../../../../base/common/cancellation.js';
import {
	aggregateOfficeOutcome,
	type ParadisOfficeBudgetProfile,
	type ParadisOfficeCompletenessManifest,
	type ParadisOfficeFormat,
	type ParadisOfficeInventory,
	type ParadisOfficeInventoryFeature,
	type ParadisOfficeInventoryPart,
	type ParadisOfficeOutcome,
	type ParadisOfficePartStatus,
	type ParadisOfficeRelationship,
} from '../paradisOfficeProtocol.js';
import { isParadisOfficePartBudgetError, ParadisOfficeBudget } from './paradisOfficeBudget.js';
import { canonicalizeOfficeXml } from './paradisOfficeCanonicalXml.js';
import {
	canonicalizeParadisOfficeArchiveName,
	type IParadisOfficeArchive,
	type ParadisOfficeXmlDocument,
	type ParadisOfficeXmlNode,
	ParadisOfficePackageError,
	throwIfParadisOfficeCancelled,
} from './paradisOfficeArchive.js';

interface ReadPart {
	readonly name: string;
	readonly compressedBytes: number;
	readonly bytes: Uint8Array;
	readonly rawHash?: Awaited<ReturnType<IParadisOfficeArchive['hash']>>;
	readonly complete: boolean;
}

const contentTypesName = '/[Content_Types].xml';
const rootRelationshipsName = '/_rels/.rels';
const officeDocumentRelationship = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument';

/** Terminal inventory detail retained in common code without changing the v1 protocol base type. */
export interface ParadisOfficePackageInventory extends ParadisOfficeInventory {
	readonly outcome: ParadisOfficeOutcome;
	readonly completeness: ParadisOfficeCompletenessManifest;
	readonly warnings: readonly {
		readonly code: string;
		readonly message: string;
	}[];
}

export interface ParadisOfficeInspectOptions {
	readonly now?: () => number;
}

/** Builds the security-first, whole-package OPC inventory without exposing raw Part access. */
export async function inspectOfficePackage(
	archive: IParadisOfficeArchive,
	profile: ParadisOfficeBudgetProfile,
	token: CancellationToken,
	options: ParadisOfficeInspectOptions = {},
): Promise<ParadisOfficePackageInventory> {
	const now = options.now ?? Date.now;
	const budget = new ParadisOfficeBudget(profile, now());
	const checkpoint = () => { throwIfParadisOfficeCancelled(token); budget.checkDeadline(now()); };
	const parts: ReadPart[] = [];
	const seen = new Set<string>();
	try {
		budget.validateContainerInput(archive.containerByteLength);
		for await (const entry of archive.entries(token)) {
			budget.checkDeadline(now());
			throwIfParadisOfficeCancelled(token);
			const name = canonicalizeParadisOfficeArchiveName(entry.name.endsWith('/') ? entry.name.slice(0, -1) : entry.name);
			if (!Number.isSafeInteger(entry.compressedBytes) || entry.compressedBytes < 0 || !Number.isSafeInteger(entry.declaredExpandedBytes) || entry.declaredExpandedBytes < 0) {
				throw new ParadisOfficePackageError('invalid');
			}
			if (entry.encrypted) {
				throw new ParadisOfficePackageError('encrypted');
			}
			if (entry.symlink) {
				throw new ParadisOfficePackageError('unsafe');
			}
			if (seen.has(name)) {
				throw new ParadisOfficePackageError('invalid');
			}
			seen.add(name);
			budget.beginEntry(entry.compressedBytes);
			if (entry.directory) {
				continue;
			}
			const chunks: Uint8Array[] = [];
			let entryBytes = 0;
			let crc = 0xffffffff;
			const media = isMediaPart(name);
			const binary = !name.endsWith('.xml') && !name.endsWith('.rels');
			let complete = true;
			try {
				for await (const chunk of archive.read(entry, token)) {
					budget.checkDeadline(now());
					throwIfParadisOfficeCancelled(token);
					if (!(chunk instanceof Uint8Array)) {
						throw new ParadisOfficePackageError('invalid');
					}
					budget.consumeEntry(chunk.byteLength, entry.compressedBytes, binary, media, entryBytes);
					entryBytes += chunk.byteLength;
					crc = updateCrc32(crc, chunk);
					chunks.push(chunk.slice());
				}
			} catch (error) {
				if (!isParadisOfficePartBudgetError(error)) {
					throw error;
				}
				complete = false;
			}
			const bytes = joinChunks(chunks, entryBytes);
			if (complete && (entryBytes !== entry.declaredExpandedBytes || (entry.crc32 !== undefined && ((crc ^ 0xffffffff) >>> 0) !== entry.crc32))) {
				throw new ParadisOfficePackageError('invalid');
			}
			parts.push({
				name,
				compressedBytes: entry.compressedBytes,
				bytes,
				rawHash: complete ? await archive.hash(bytes) : undefined,
				complete,
			});
		}
		throwIfParadisOfficeCancelled(token);
		budget.checkDeadline(now());
		return await buildInventory(parts, profile, budget, archive, token, checkpoint);
	} finally {
		archive.dispose();
	}
}

async function buildInventory(
	readParts: readonly ReadPart[],
	profile: ParadisOfficeBudgetProfile,
	budget: ParadisOfficeBudget,
	archive: IParadisOfficeArchive,
	token: CancellationToken,
	checkpoint: () => void,
): Promise<ParadisOfficePackageInventory> {
	const byName = new Map(readParts.map(part => [part.name, part]));
	const contentTypes = byName.get(contentTypesName);
	const rootRelationships = byName.get(rootRelationshipsName);
	if ((contentTypes && !contentTypes.complete) || (rootRelationships && !rootRelationships.complete)) {
		throw new ParadisOfficePackageError('limitExceeded');
	}
	if (!contentTypes || !rootRelationships) {
		throw new ParadisOfficePackageError('malformed');
	}
	const limits = {
		depth: profile.xmlDepth,
		nodes: profile.xmlNodesPerPart,
		attributeLength: profile.attributeLength,
		characters: profile.xmlPartBytes,
	};
	checkpoint();
	const types = parseContentTypes(await archive.parseXml(asText(contentTypes.bytes), limits, token, checkpoint), checkpoint);
	const relationshipRecords = (
		await Promise.all(
			readParts.filter(part => part.complete && part.name.endsWith('.rels')).map(async part => parseRelationships(part.name, await archive.parseXml(asText(part.bytes), limits, token, checkpoint), checkpoint)),
		)
	).flat();
	const rootOfficeDocument = relationshipRecords.find(relationship => relationship.source === '/' && relationship.type === officeDocumentRelationship && relationship.targetMode === 'internal');
	if (!rootOfficeDocument || !byName.has(rootOfficeDocument.target)) {
		throw new ParadisOfficePackageError('malformed');
	}
	if (!byName.get(rootOfficeDocument.target)!.complete) {
		throw new ParadisOfficePackageError('limitExceeded');
	}
	const required = new Set([contentTypesName, rootRelationshipsName, rootOfficeDocument.target]);
	for (const relationship of relationshipRecords) {
		if (isRequiredRelationship(relationship, rootOfficeDocument.target)) {
			required.add(relationship.target);
		}
	}
	const inventoryParts: ParadisOfficeInventoryPart[] = [];
	for (const part of readParts) {
		const contentType = types.get(part.name) ?? (part.name.endsWith('.rels') ? 'application/vnd.openxmlformats-package.relationships+xml' : 'application/octet-stream');
		if (!part.complete) {
			inventoryParts.push({
				id: part.name,
				canonicalUri: part.name,
				contentType,
				compressedBytes: part.compressedBytes,
				expandedBytes: part.bytes.byteLength,
				required: required.has(part.name),
				coverage: 'omittedByBudget',
				hashCompleteness: 'incomplete',
			});
			continue;
		}
		const xml = isXmlPart(part.name, contentType);
		if (xml) {
			try {
				const tree = await archive.parseXml(asText(part.bytes), limits, token, checkpoint);
				const canonical = canonicalizeOfficeXml(tree, id => relationshipRecords.find(relationship => relationship.source === part.name && relationship.id === id)?.target, checkpoint);
				inventoryParts.push({
					id: part.name,
					canonicalUri: part.name,
					contentType,
					compressedBytes: part.compressedBytes,
					expandedBytes: part.bytes.byteLength,
					required: required.has(part.name),
					coverage: 'parsed',
					rawHash: part.rawHash!,
					hashCompleteness: 'allBytes',
					canonicalHash: canonical.hash,
				});
			} catch (error) {
				if (!(error instanceof ParadisOfficePackageError)) {
					throw error;
				}
				inventoryParts.push({
					id: part.name,
					canonicalUri: part.name,
					contentType,
					compressedBytes: part.compressedBytes,
					expandedBytes: part.bytes.byteLength,
					required: required.has(part.name),
					coverage: 'failed',
					hashCompleteness: 'incomplete',
				});
			}
			continue;
		}
		inventoryParts.push({
			id: part.name,
			canonicalUri: part.name,
			contentType,
			compressedBytes: part.compressedBytes,
			expandedBytes: part.bytes.byteLength,
			required: required.has(part.name),
			coverage: 'completeOpaque',
			hashCompleteness: 'allBytes',
			fingerprint: part.rawHash!,
			canonicalHash: part.rawHash!,
		});
	}
	const completePartNames = new Set<string>();
	for (const part of readParts) {
		checkpoint();
		if (part.complete) {
			completePartNames.add(part.name);
		}
	}
	const cyclicRelationships = findCyclicRelationships(relationshipRecords, completePartNames, checkpoint);
	const relationships: ParadisOfficeRelationship[] = [];
	for (let index = 0; index < relationshipRecords.length; index++) {
		checkpoint();
		const record = relationshipRecords[index];
		relationships.push({
			id: record.id,
			sourcePartId: record.source === '/' ? undefined : record.source,
			type: record.type,
			target: record.target,
			targetMode: record.targetMode,
			missing: record.targetMode === 'internal' && !byName.get(record.target)?.complete,
			cyclic: cyclicRelationships[index],
		});
	}
	const features = buildFeatures(readParts, relationships, checkpoint);
	const security = {
		encrypted: false,
		hasMacros: readParts.some(part => /vbaProject\.bin$/i.test(part.name)),
		hasExternalRelationships: relationships.some(relationship => relationship.targetMode === 'external'),
		hasEmbeddedObjects: readParts.some(part => /(?:oleObject|embeddings|activeX)/i.test(part.name)),
		hasProtection: readParts.some(part => /protection/i.test(asTextIfXml(part))),
		hasSignatures: readParts.some(part => /_xmlsignatures\//i.test(part.name)),
	};
	const statuses: ParadisOfficePartStatus[] = inventoryParts.map(part =>
		part.coverage === 'completeOpaque'
			? {
				coverage: 'completeOpaque',
				required: part.required,
				hashCompleteness: 'allBytes',
				fingerprint: part.fingerprint,
			}
			: { coverage: part.coverage, required: part.required },
	);
	const missingRequired = relationships.some(relationship => relationship.missing && (relationship.sourcePartId === undefined || relationship.sourcePartId === rootOfficeDocument.target));
	const baseOutcome = aggregateOfficeOutcome(statuses);
	const outcome = missingRequired ? 'blocked' : relationships.some(relationship => relationship.missing) && baseOutcome === 'complete' ? 'degraded' : baseOutcome;
	const parsedParts = inventoryParts.filter(part => part.coverage === 'parsed').length;
	const opaqueParts = inventoryParts.filter(part => part.coverage === 'completeOpaque').length;
	const failedParts = inventoryParts.filter(part => part.coverage === 'failed').length;
	const omittedParts = inventoryParts.filter(part => part.coverage === 'omittedByBudget').length;
	const completeness: ParadisOfficeCompletenessManifest = {
		expectedParts: inventoryParts.length,
		visitedParts: inventoryParts.length,
		parsedParts,
		opaqueParts,
		failedParts,
		omittedParts,
		expectedSemanticUnits: inventoryParts.length,
		visitedSemanticUnits: inventoryParts.length,
		terminal: true,
	};
	const warnings = budget.warningKinds().map(kind => ({
		code: `budget.${kind}`,
		message: `Office package budget is at least 80% consumed: ${kind}`,
	}));
	return {
		format: detectFormat(rootOfficeDocument.target, security.hasMacros),
		container: 'opc',
		parts: inventoryParts,
		relationships,
		features,
		security,
		budgetProfile: profile.kind,
		budgetUsage: budget.usage(),
		outcome,
		completeness,
		warnings,
	};
}

function isRequiredRelationship(relationship: ParsedRelationship, mainPart: string): boolean {
	if (relationship.targetMode !== 'internal') {
		return false;
	}
	if (relationship.source === '/') {
		return relationship.type === officeDocumentRelationship;
	}
	if (relationship.source !== mainPart) {
		return false;
	}
	return /\/(?:styles|settings|numbering|theme|sharedStrings|workbook)$/i.test(relationship.type);
}

function parseContentTypes(document: ParadisOfficeXmlDocument, checkpoint?: () => void): ReadonlyMap<string, string> {
	if (document.root.local !== 'Types' || document.root.uri !== 'http://schemas.openxmlformats.org/package/2006/content-types') {
		throw new ParadisOfficePackageError('malformed');
	}
	const result = new Map<string, string>();
	for (const node of document.root.children) {
		checkpoint?.();
		if (node.kind !== 'element' || node.local !== 'Override') {
			continue;
		}
		const name = attribute(node, 'PartName');
		const type = attribute(node, 'ContentType');
		if (!name || !type || !name.startsWith('/')) {
			throw new ParadisOfficePackageError('malformed');
		}
		result.set(name, type);
	}
	return result;
}

interface ParsedRelationship {
	readonly source: string;
	readonly id: string;
	readonly type: string;
	readonly target: string;
	readonly targetMode: 'internal' | 'external';
}

interface RelationshipCycleEdge {
	readonly source: string;
	readonly target: string;
	readonly targetMode: 'internal' | 'external';
}

function parseRelationships(name: string, document: ParadisOfficeXmlDocument, checkpoint?: () => void): readonly ParsedRelationship[] {
	if (document.root.local !== 'Relationships' || document.root.uri !== 'http://schemas.openxmlformats.org/package/2006/relationships') {
		throw new ParadisOfficePackageError('malformed');
	}
	const source = relationshipSource(name);
	const records: ParsedRelationship[] = [];
	for (const node of document.root.children) {
		checkpoint?.();
		if (node.kind !== 'element' || node.local !== 'Relationship') {
			continue;
		}
		const id = attribute(node, 'Id');
		const type = attribute(node, 'Type');
		const targetValue = attribute(node, 'Target');
		const mode = attribute(node, 'TargetMode') === 'External' ? 'external' : 'internal';
		if (!id || !type || !targetValue) {
			throw new ParadisOfficePackageError('malformed');
		}
		records.push({
			source,
			id,
			type,
			target: mode === 'external' ? targetValue : resolveTarget(source, targetValue),
			targetMode: mode,
		});
	}
	return records;
}

function attribute(node: Extract<ParadisOfficeXmlNode, { readonly kind: 'element' }>, name: string): string | undefined {
	return node.attributes.find(attribute => attribute.local === name && attribute.uri === '')?.value;
}

function relationshipSource(name: string): string {
	if (name === rootRelationshipsName) {
		return '/';
	}
	const match = /^(.*)\/_rels\/([^/]+)\.rels$/.exec(name);
	if (!match) {
		throw new ParadisOfficePackageError('malformed');
	}
	return `${match[1]}/${match[2]}`;
}

function resolveTarget(source: string, target: string): string {
	if (!target || target.startsWith('/') || target.includes('\\') || target.includes('%')) {
		throw new ParadisOfficePackageError('malformed');
	}
	const base = source === '/' ? [] : source.slice(1).split('/').slice(0, -1);
	for (const segment of target.split('/')) {
		if (!segment || segment === '.') {
			continue;
		}
		if (segment === '..') {
			if (base.length === 0) {
				throw new ParadisOfficePackageError('malformed');
			}
			base.pop();
		} else {
			base.push(segment);
		}
	}
	return `/${base.join('/')}`;
}

function findCyclicRelationships(relationships: readonly RelationshipCycleEdge[], completePartNames: ReadonlySet<string>, checkpoint: () => void): readonly boolean[] {
	const adjacency = new Map<string, string[]>();
	const reverseAdjacency = new Map<string, string[]>();
	for (const partName of completePartNames) {
		checkpoint();
		adjacency.set(partName, []);
		reverseAdjacency.set(partName, []);
	}
	for (const relationship of relationships) {
		checkpoint();
		if (relationship.targetMode !== 'internal' || relationship.source === '/' || !adjacency.has(relationship.source) || !adjacency.has(relationship.target)) {
			continue;
		}
		adjacency.get(relationship.source)!.push(relationship.target);
		reverseAdjacency.get(relationship.target)!.push(relationship.source);
	}

	const visited = new Set<string>();
	const completed = [] as string[];
	for (const partName of adjacency.keys()) {
		checkpoint();
		if (visited.has(partName)) {
			continue;
		}
		const stack: { readonly partName: string; nextEdge: number }[] = [{ partName, nextEdge: 0 }];
		visited.add(partName);
		while (stack.length) {
			checkpoint();
			const current = stack[stack.length - 1];
			const targets = adjacency.get(current.partName)!;
			if (current.nextEdge === targets.length) {
				completed.push(current.partName);
				stack.pop();
				continue;
			}
			const target = targets[current.nextEdge++];
			if (visited.has(target)) {
				continue;
			}
			visited.add(target);
			stack.push({ partName: target, nextEdge: 0 });
		}
	}

	const componentByPartName = new Map<string, number>();
	const componentSizes = [] as number[];
	for (let index = completed.length - 1; index >= 0; index--) {
		checkpoint();
		const partName = completed[index];
		if (componentByPartName.has(partName)) {
			continue;
		}
		const component = componentSizes.length;
		let componentSize = 0;
		const stack = [partName];
		componentByPartName.set(partName, component);
		while (stack.length) {
			checkpoint();
			const current = stack.pop()!;
			componentSize++;
			for (const source of reverseAdjacency.get(current)!) {
				checkpoint();
				if (!componentByPartName.has(source)) {
					componentByPartName.set(source, component);
					stack.push(source);
				}
			}
		}
		componentSizes.push(componentSize);
	}

	const cyclic = new Array<boolean>(relationships.length).fill(false);
	for (let index = 0; index < relationships.length; index++) {
		checkpoint();
		const relationship = relationships[index];
		if (relationship.targetMode !== 'internal' || relationship.source === '/' || !adjacency.has(relationship.source) || !adjacency.has(relationship.target)) {
			continue;
		}
		const sourceComponent = componentByPartName.get(relationship.source)!;
		const targetComponent = componentByPartName.get(relationship.target)!;
		cyclic[index] = relationship.source === relationship.target || (sourceComponent === targetComponent && componentSizes[sourceComponent] > 1);
	}
	return cyclic;
}

/** @internal Test seam for graph-depth and checkpoint coverage without expanding the Office protocol. */
export function findParadisOfficeRelationshipCyclesForTest(partNames: readonly string[], relationships: readonly RelationshipCycleEdge[], checkpoint: () => void = () => { }): readonly boolean[] {
	const completePartNames = new Set<string>();
	for (const partName of partNames) {
		checkpoint();
		completePartNames.add(partName);
	}
	return findCyclicRelationships(relationships, completePartNames, checkpoint);
}

function buildFeatures(parts: readonly ReadPart[], relationships: readonly ParadisOfficeRelationship[], checkpoint?: () => void): readonly ParadisOfficeInventoryFeature[] {
	const feature = (kind: string, predicate: (part: ReadPart) => boolean, safety: ParadisOfficeInventoryFeature['safety']): ParadisOfficeInventoryFeature | undefined => {
		const matching = parts.filter(predicate);
		return matching.length
			? {
				kind,
				count: matching.length,
				partIds: matching.map(part => part.name),
				safety,
			}
			: undefined;
	};
	const reachable = new Set<string>([contentTypesName, rootRelationshipsName]);
	const pending = ['/'];
	while (pending.length) {
		checkpoint?.();
		const source = pending.shift()!;
		for (const relationship of relationships) {
			if ((relationship.sourcePartId ?? '/') !== source || relationship.targetMode !== 'internal' || relationship.missing) {
				continue;
			}
			if (!reachable.has(relationship.target)) {
				reachable.add(relationship.target);
				pending.push(relationship.target);
			}
			reachable.add(relationshipPartName(source));
		}
	}
	return [
		feature('macro', part => /vbaProject\.bin$/i.test(part.name), 'metadataOnly'),
		feature('embeddedObject', part => /(?:oleObject|embeddings|activeX)/i.test(part.name), 'metadataOnly'),
		relationships.some(relationship => relationship.targetMode === 'external')
			? {
				kind: 'externalRelationship',
				count: relationships.filter(relationship => relationship.targetMode === 'external').length,
				partIds: [],
				safety: 'blocked',
			}
			: undefined,
		feature('orphanPart', part => !reachable.has(part.name), 'metadataOnly'),
	].filter((value): value is ParadisOfficeInventoryFeature => value !== undefined);
}

function relationshipPartName(source: string): string {
	if (source === '/') {
		return rootRelationshipsName;
	}
	const slash = source.lastIndexOf('/');
	return `${source.slice(0, slash)}/_rels/${source.slice(slash + 1)}.rels`;
}

function detectFormat(mainPart: string, hasMacros: boolean): ParadisOfficeFormat {
	if (mainPart === '/word/document.xml') {
		return hasMacros ? 'docm' : 'docx';
	}
	if (mainPart === '/xl/workbook.xml') {
		return hasMacros ? 'xlsm' : 'xlsx';
	}
	return 'zip';
}

function isXmlPart(name: string, contentType: string): boolean {
	return name.endsWith('.xml') || name.endsWith('.rels') || /(?:xml|\+xml)/i.test(contentType);
}
function isMediaPart(name: string): boolean {
	return /\/(?:media|embeddings)\//i.test(name) || /\.(?:png|jpe?g|gif|bmp|tiff?|wmf|emf)$/i.test(name);
}
function asText(bytes: Uint8Array): string {
	try {
		return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
	} catch {
		throw new ParadisOfficePackageError('malformed');
	}
}
function asTextIfXml(part: ReadPart): string {
	return part.name.endsWith('.xml') || part.name.endsWith('.rels') ? asText(part.bytes) : '';
}

function joinChunks(chunks: readonly Uint8Array[], length: number): Uint8Array {
	const result = new Uint8Array(length);
	let offset = 0;
	for (const chunk of chunks) {
		result.set(chunk, offset);
		offset += chunk.byteLength;
	}
	return result;
}

function updateCrc32(value: number, bytes: Uint8Array): number {

	let crc = value;
	for (const byte of bytes) {
		crc ^= byte;
		for (let bit = 0; bit < 8; bit++) {
			crc = (crc >>> 1) ^ ((crc & 1) === 1 ? 0xedb88320 : 0);
		}
	}
	return crc;
}
