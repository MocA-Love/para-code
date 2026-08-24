/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import type { CancellationToken } from '../../../../../base/common/cancellation.js';
import type { ParadisOfficeBudgetProfile, ParadisOfficeFormat, ParadisOfficeInventory, ParadisOfficeInventoryFeature, ParadisOfficeInventoryPart, ParadisOfficeRelationship } from '../paradisOfficeProtocol.js';
import { ParadisOfficeBudget } from './paradisOfficeBudget.js';
import { canonicalizeOfficeXml } from './paradisOfficeCanonicalXml.js';
import { canonicalizeParadisOfficeArchiveName, type IParadisOfficeArchive, ParadisOfficePackageError, throwIfParadisOfficeCancelled } from './paradisOfficeArchive.js';

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

/** Builds the security-first, whole-package OPC inventory without exposing raw Part access. */
export async function inspectOfficePackage(archive: IParadisOfficeArchive, profile: ParadisOfficeBudgetProfile, token: CancellationToken): Promise<ParadisOfficeInventory> {

	const budget = new ParadisOfficeBudget(profile);
	const parts: ReadPart[] = [];
	const seen = new Set<string>();
	try {
		for await (const entry of archive.entries(token)) {
			throwIfParadisOfficeCancelled(token);
			if (entry.directory) {
				continue;
			}
			if (entry.encrypted) {
				throw new ParadisOfficePackageError('encrypted');
			}
			const name = canonicalizeParadisOfficeArchiveName(entry.name);
			if (seen.has(name)) {
				throw new ParadisOfficePackageError('invalid');
			}
			seen.add(name);
			budget.beginEntry(entry.compressedBytes);
			const chunks: Uint8Array[] = [];
			let entryBytes = 0;
			const media = isMediaPart(name);
			const binary = !name.endsWith('.xml') && !name.endsWith('.rels');
			let complete = true;
			try {
				for await (const chunk of archive.read(entry, token)) {
					throwIfParadisOfficeCancelled(token);
					if (!(chunk instanceof Uint8Array)) {
						throw new ParadisOfficePackageError('invalid');
					}
					budget.consumeEntry(chunk.byteLength, entry.compressedBytes, binary, media, entryBytes);
					entryBytes += chunk.byteLength;
					chunks.push(chunk.slice());
				}
			} catch (error) {
				if (!(error instanceof ParadisOfficePackageError) || error.code !== 'limitExceeded' || !media) {
					throw error;
				}
				complete = false;
			}
			const bytes = joinChunks(chunks, entryBytes);
			parts.push({ name, compressedBytes: entry.compressedBytes, bytes, rawHash: complete ? await archive.hash(bytes) : undefined, complete });
		}
		throwIfParadisOfficeCancelled(token);
		return buildInventory(parts, profile, budget);
	} finally {
		archive.dispose();
	}
}

function buildInventory(readParts: readonly ReadPart[], profile: ParadisOfficeBudgetProfile, budget: ParadisOfficeBudget): ParadisOfficeInventory {

	const byName = new Map(readParts.map(part => [part.name, part]));
	const contentTypes = byName.get(contentTypesName);
	const rootRelationships = byName.get(rootRelationshipsName);
	if (!contentTypes || !rootRelationships) {
		throw new ParadisOfficePackageError('malformed');
	}
	const types = parseContentTypes(asText(contentTypes.bytes));
	const relationshipRecords = readParts.filter(part => part.name.endsWith('.rels')).flatMap(part => parseRelationships(part.name, asText(part.bytes)));
	const rootOfficeDocument = relationshipRecords.find(relationship => relationship.source === '/' && relationship.type === officeDocumentRelationship && relationship.targetMode === 'internal');
	if (!rootOfficeDocument || !byName.has(rootOfficeDocument.target)) {
		throw new ParadisOfficePackageError('malformed');
	}
	if (!byName.get(rootOfficeDocument.target)!.complete) {
		throw new ParadisOfficePackageError('limitExceeded');
	}
	for (const relationship of relationshipRecords) {
		if (relationship.targetMode === 'internal') {
			const target = byName.get(relationship.target);
			if (!target) {
				throw new ParadisOfficePackageError('malformed');
			}
			if (!target.complete) {
				throw new ParadisOfficePackageError('limitExceeded');
			}
		}
	}
	const required = new Set([contentTypesName, rootRelationshipsName, rootOfficeDocument.target]);
	for (const relationship of relationshipRecords) {
		if (relationship.targetMode === 'internal') {
			required.add(relationship.target);
		}
	}
	const canonicalHashes = new Map<string, Awaited<ReturnType<IParadisOfficeArchive['hash']>>>();
	const inventoryParts: ParadisOfficeInventoryPart[] = readParts.map(part => {
		const contentType = types.get(part.name) ?? (part.name.endsWith('.rels') ? 'application/vnd.openxmlformats-package.relationships+xml' : 'application/octet-stream');
		if (!part.complete) {
			return {
				id: part.name, canonicalUri: part.name, contentType, compressedBytes: part.compressedBytes, expandedBytes: part.bytes.byteLength,
				required: required.has(part.name), coverage: 'omittedByBudget', hashCompleteness: 'incomplete',
			};
		}
		const xml = isXmlPart(part.name, contentType);
		if (xml) {
			const canonical = canonicalizeOfficeXml(asText(part.bytes), id => relationshipRecords.find(relationship => relationship.source === part.name && relationship.id === id)?.target);
			canonicalHashes.set(part.name, canonical.hash);
			return {
				id: part.name, canonicalUri: part.name, contentType, compressedBytes: part.compressedBytes, expandedBytes: part.bytes.byteLength,
				required: required.has(part.name), coverage: 'parsed', rawHash: part.rawHash!, hashCompleteness: 'allBytes', canonicalHash: canonical.hash,
			};
		}
		return {
			id: part.name, canonicalUri: part.name, contentType, compressedBytes: part.compressedBytes, expandedBytes: part.bytes.byteLength,
			required: required.has(part.name), coverage: 'completeOpaque', hashCompleteness: 'allBytes', fingerprint: part.rawHash!, rawHash: part.rawHash!, canonicalHash: part.rawHash!,
		};
	});
	const relationships: ParadisOfficeRelationship[] = relationshipRecords.map(record => ({
		id: record.id,
		sourcePartId: record.source === '/' ? undefined : record.source,
		type: record.type,
		target: record.target,
		targetMode: record.targetMode,
		missing: record.targetMode === 'internal' && !byName.has(record.target),
		cyclic: record.targetMode === 'internal' && isRelationshipCycle(record.source, record.target, relationshipRecords),
	}));
	const features = buildFeatures(readParts, relationships);
	const security = {
		encrypted: false,
		hasMacros: readParts.some(part => /vbaProject\.bin$/i.test(part.name)),
		hasExternalRelationships: relationships.some(relationship => relationship.targetMode === 'external'),
		hasEmbeddedObjects: readParts.some(part => /(?:oleObject|embeddings|activeX)/i.test(part.name)),
		hasProtection: readParts.some(part => /protection/i.test(asTextIfXml(part))),
		hasSignatures: readParts.some(part => /_xmlsignatures\//i.test(part.name)),
	};
	return { format: detectFormat(rootOfficeDocument.target, security.hasMacros), container: 'opc', parts: inventoryParts, relationships, features, security, budgetProfile: profile.kind, budgetUsage: budget.usage() };
}

function parseContentTypes(xml: string): ReadonlyMap<string, string> {

	if (!/<(?:\w+:)?Types\b/.test(xml)) {
		throw new ParadisOfficePackageError('malformed');
	}
	const result = new Map<string, string>();
	for (const match of xml.matchAll(/<(?:\w+:)?Override\b([^>]*)\/?\s*>/g)) {
		const name = attribute(match[1], 'PartName');
		const type = attribute(match[1], 'ContentType');
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

function parseRelationships(name: string, xml: string): readonly ParsedRelationship[] {

	if (!/<(?:\w+:)?Relationships\b/.test(xml)) {
		throw new ParadisOfficePackageError('malformed');
	}
	const source = relationshipSource(name);
	const records: ParsedRelationship[] = [];
	for (const match of xml.matchAll(/<(?:\w+:)?Relationship\b([^>]*)\/?\s*>/g)) {
		const id = attribute(match[1], 'Id');
		const type = attribute(match[1], 'Type');
		const targetValue = attribute(match[1], 'Target');
		const mode = attribute(match[1], 'TargetMode') === 'External' ? 'external' : 'internal';
		if (!id || !type || !targetValue) {
			throw new ParadisOfficePackageError('malformed');
		}
		records.push({ source, id, type, target: mode === 'external' ? targetValue : resolveTarget(source, targetValue), targetMode: mode });
	}
	return records;
}

function attribute(source: string, name: string): string | undefined {

	const match = new RegExp(`\\b${name}\\s*=\\s*(["'])(.*?)\\1`).exec(source);
	return match?.[2];
}

function relationshipSource(name: string): string {

	if (name === rootRelationshipsName) { return '/'; }
	const match = /^(.*)\/_rels\/([^/]+)\.rels$/.exec(name);
	if (!match) { throw new ParadisOfficePackageError('malformed'); }
	return `${match[1]}/${match[2]}`;
}

function resolveTarget(source: string, target: string): string {

	if (!target || target.startsWith('/') || target.includes('\\') || target.includes('%')) {
		throw new ParadisOfficePackageError('malformed');
	}
	const base = source === '/' ? [] : source.slice(1).split('/').slice(0, -1);
	for (const segment of target.split('/')) {
		if (!segment || segment === '.') { continue; }
		if (segment === '..') {
			if (base.length === 0) { throw new ParadisOfficePackageError('malformed'); }
			base.pop();
		} else { base.push(segment); }
	}
	return `/${base.join('/')}`;
}

function isRelationshipCycle(source: string, target: string, relationships: readonly ParsedRelationship[]): boolean {

	if (source === '/') { return false; }
	const visited = new Set<string>();
	const visit = (part: string): boolean => {
		if (part === source) { return true; }
		if (visited.has(part)) { return false; }
		visited.add(part);
		return relationships.some(relationship => relationship.source === part && relationship.targetMode === 'internal' && visit(relationship.target));
	};
	return visit(target);
}

function buildFeatures(parts: readonly ReadPart[], relationships: readonly ParadisOfficeRelationship[]): readonly ParadisOfficeInventoryFeature[] {

	const feature = (kind: string, predicate: (part: ReadPart) => boolean, safety: ParadisOfficeInventoryFeature['safety']): ParadisOfficeInventoryFeature | undefined => {
		const matching = parts.filter(predicate);
		return matching.length ? { kind, count: matching.length, partIds: matching.map(part => part.name), safety } : undefined;
	};
	return [
		feature('macro', part => /vbaProject\.bin$/i.test(part.name), 'metadataOnly'),
		feature('embeddedObject', part => /(?:oleObject|embeddings|activeX)/i.test(part.name), 'metadataOnly'),
		relationships.some(relationship => relationship.targetMode === 'external') ? { kind: 'externalRelationship', count: relationships.filter(relationship => relationship.targetMode === 'external').length, partIds: [], safety: 'blocked' } : undefined,
	].filter((value): value is ParadisOfficeInventoryFeature => value !== undefined);
}

function detectFormat(mainPart: string, hasMacros: boolean): ParadisOfficeFormat {

	if (mainPart === '/word/document.xml') { return hasMacros ? 'docm' : 'docx'; }
	if (mainPart === '/xl/workbook.xml') { return hasMacros ? 'xlsm' : 'xlsx'; }
	return 'zip';
}

function isXmlPart(name: string, contentType: string): boolean { return name.endsWith('.xml') || name.endsWith('.rels') || /(?:xml|\+xml)/i.test(contentType); }
function isMediaPart(name: string): boolean { return /\/(?:media|embeddings)\//i.test(name) || /\.(?:png|jpe?g|gif|bmp|tiff?|wmf|emf)$/i.test(name); }
function asText(bytes: Uint8Array): string {

	try {
		return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
	} catch {
		throw new ParadisOfficePackageError('malformed');
	}
}
function asTextIfXml(part: ReadPart): string { return part.name.endsWith('.xml') || part.name.endsWith('.rels') ? asText(part.bytes) : ''; }

function joinChunks(chunks: readonly Uint8Array[], length: number): Uint8Array {

	const result = new Uint8Array(length);
	let offset = 0;
	for (const chunk of chunks) { result.set(chunk, offset); offset += chunk.byteLength; }
	return result;
}
