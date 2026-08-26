/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import type { CancellationToken } from '../../../../../base/common/cancellation.js';
import { ParadisOfficePackageError, throwIfParadisOfficeCancelled, type ParadisOfficeXmlNode } from '../office/paradisOfficeArchive.js';
import { parseParadisOfficeXml } from '../office/paradisOfficeCanonicalXml.js';
import type { ParadisOfficeFingerprint } from '../paradisOfficeProtocol.js';
import { fingerprintParadisWordObjectBytes } from './paradisWordObjects.js';
import type { ParadisWordPartAuthority } from './paradisWordStyles.js';

type XmlElement = Extract<ParadisOfficeXmlNode, { readonly kind: 'element' }>;
type DataRecord = Readonly<Record<PropertyKey, unknown>>;

const contentTypeNamespace = 'http://schemas.openxmlformats.org/package/2006/content-types';
const packageRelationshipNamespaces = new Set([
	'http://schemas.openxmlformats.org/package/2006/relationships',
	'http://purl.oclc.org/ooxml/package/relationships',
]);
const officeRelationshipNamespaces = new Set([
	'http://schemas.openxmlformats.org/officeDocument/2006/relationships',
	'http://purl.oclc.org/ooxml/officeDocument/relationships',
]);
const wordNamespaces = new Set([
	'http://schemas.openxmlformats.org/wordprocessingml/2006/main',
	'http://purl.oclc.org/ooxml/wordprocessingml/main',
]);
const officeObjectNamespaces = new Set(['urn:schemas-microsoft-com:office:office']);
const vmlNamespaces = new Set(['urn:schemas-microsoft-com:vml']);

const relationshipsContentType = 'application/vnd.openxmlformats-package.relationships+xml';
const mainDocumentContentTypes = new Set([
	'application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml',
	'application/vnd.ms-word.document.macroenabled.main+xml',
	'application/vnd.openxmlformats-officedocument.wordprocessingml.template.main+xml',
	'application/vnd.ms-word.template.macroenabledtemplate.main+xml',
]);
const wordStoryContentTypes = new Set([
	...mainDocumentContentTypes,
	'application/vnd.openxmlformats-officedocument.wordprocessingml.header+xml',
	'application/vnd.openxmlformats-officedocument.wordprocessingml.footer+xml',
	'application/vnd.openxmlformats-officedocument.wordprocessingml.footnotes+xml',
	'application/vnd.openxmlformats-officedocument.wordprocessingml.endnotes+xml',
	'application/vnd.openxmlformats-officedocument.wordprocessingml.comments+xml',
	'application/vnd.openxmlformats-officedocument.wordprocessingml.document.glossary+xml',
]);
const vbaContentTypes = new Set([
	'application/vnd.ms-office.vbaproject',
	'application/vnd.ms-word.vbaData+xml'.toLocaleLowerCase('en-US'),
]);
const signatureContentTypes = new Set([
	'application/vnd.openxmlformats-package.digital-signature-xmlsignature+xml',
	'application/vnd.openxmlformats-package.digital-signature-origin',
	'application/vnd.openxmlformats-package.digital-signature-certificate',
	'application/vnd.ms-office.vbaprojectsignature',
]);
const oleContentTypes = new Set([
	'application/vnd.openxmlformats-officedocument.oleobject',
	'application/vnd.ms-office.oleobject',
]);
const activeXContentTypes = new Set([
	'application/vnd.ms-office.activex',
	'application/vnd.ms-office.activex+xml',
]);
const embeddedPackageContentTypes = new Set([
	'application/vnd.openxmlformats-officedocument.package',
	'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
	'application/vnd.openxmlformats-officedocument.wordprocessingml.template',
	'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
	'application/vnd.openxmlformats-officedocument.spreadsheetml.template',
	'application/vnd.openxmlformats-officedocument.presentationml.presentation',
	'application/vnd.openxmlformats-officedocument.presentationml.slideshow',
]);

const officeDocumentRelationshipTypes = relationshipTypes('officeDocument');
const vbaRelationshipTypes = relationshipTypes('vbaProject');
const oleRelationshipTypes = relationshipTypes('oleObject');
const activeXRelationshipTypes = relationshipTypes('control');
const packageRelationshipTypes = relationshipTypes('package');
const imageRelationshipTypes = relationshipTypes('image');

const hardMaximumParts = 2_048;
const hardMaximumPartBytes = 64 * 1024 * 1024;
const hardMaximumTotalBytes = 256 * 1024 * 1024;
const hardMaximumUnsafeNodes = 100_000;
const hardMaximumDeadlineMilliseconds = 60_000;
const xmlLimits = { depth: 128, nodes: 500_000, attributeLength: 1024 * 1024, characters: 64 * 1024 * 1024 } as const;

const typedArrayPrototype = Object.getPrototypeOf(Uint8Array.prototype);
const typedArrayBuffer = Object.getOwnPropertyDescriptor(typedArrayPrototype, 'buffer')!.get!;
const typedArrayByteLength = Object.getOwnPropertyDescriptor(typedArrayPrototype, 'byteLength')!.get!;
const typedArrayByteOffset = Object.getOwnPropertyDescriptor(typedArrayPrototype, 'byteOffset')!.get!;
const typedArraySet = Uint8Array.prototype.set;
const arrayBufferByteLength = Object.getOwnPropertyDescriptor(ArrayBuffer.prototype, 'byteLength')!.get!;
const arrayBufferResizable = Object.getOwnPropertyDescriptor(ArrayBuffer.prototype, 'resizable')?.get;
const arrayBufferDetached = Object.getOwnPropertyDescriptor(ArrayBuffer.prototype, 'detached')?.get;

/** Raw all-byte-authorized package Part. Caller bytes are copied before package metadata is parsed. */
export interface ParadisWordSecurityPartInput {
	readonly bytes: Uint8Array;
	readonly source: ParadisWordPartAuthority;
}

export interface ParadisWordSecurityParseInput {
	readonly parts: readonly ParadisWordSecurityPartInput[];
	readonly token?: CancellationToken;
}

export interface ParadisWordSecurityParseOptions {
	readonly deadlineMilliseconds?: number;
	readonly now?: () => number;
	readonly maximumParts?: number;
	readonly maximumPartBytes?: number;
	readonly maximumTotalBytes?: number;
	readonly maximumUnsafeNodes?: number;
}

export interface ParadisWordSecurityPreviewReference {
	/** Opaque semantic ID. It is deliberately not a package path. */
	readonly id: string;
	readonly contentType: string;
	readonly fingerprint: ParadisOfficeFingerprint;
}

interface ParadisWordUnsafeNodeBase {
	readonly id: string;
	readonly sourceFingerprint: ParadisOfficeFingerprint;
	readonly rawAssetAccess: 'denied';
}

export interface ParadisWordVbaUnsafeNode extends ParadisWordUnsafeNodeBase {
	readonly kind: 'vba';
	readonly contentType: string;
	readonly fingerprint: ParadisOfficeFingerprint;
	readonly behavior: 'notExecuted';
}

export interface ParadisWordSignatureUnsafeNode extends ParadisWordUnsafeNodeBase {
	readonly kind: 'signature';
	readonly contentType: string;
	readonly fingerprint: ParadisOfficeFingerprint;
	readonly behavior: 'notVerified';
}

export interface ParadisWordOleUnsafeNode extends ParadisWordUnsafeNodeBase {
	readonly kind: 'ole';
	readonly contentType: string;
	readonly fingerprint: ParadisOfficeFingerprint;
	readonly behavior: 'notExecuted';
	readonly objectType?: 'embedded' | 'linked' | 'unknown';
	readonly programIdFingerprint?: ParadisOfficeFingerprint;
	readonly previewReferenceId?: string;
}

export interface ParadisWordActiveXUnsafeNode extends ParadisWordUnsafeNodeBase {
	readonly kind: 'activeX';
	readonly contentType: string;
	readonly fingerprint: ParadisOfficeFingerprint;
	readonly behavior: 'notExecuted';
}

export interface ParadisWordEmbeddedPackageUnsafeNode extends ParadisWordUnsafeNodeBase {
	readonly kind: 'embeddedPackage';
	readonly contentType: string;
	readonly fingerprint: ParadisOfficeFingerprint;
	readonly behavior: 'notExpanded';
	readonly objectType?: 'embedded' | 'linked' | 'unknown';
	readonly programIdFingerprint?: ParadisOfficeFingerprint;
	readonly previewReferenceId?: string;
}

export interface ParadisWordDdeUnsafeNode extends ParadisWordUnsafeNodeBase {
	readonly kind: 'dde';
	readonly instructionFingerprint: ParadisOfficeFingerprint;
	readonly behavior: 'notExecuted';
}

export interface ParadisWordExternalUnsafeNode extends ParadisWordUnsafeNodeBase {
	readonly kind: 'externalImage' | 'externalRelationship';
	readonly relationshipTypeFingerprint: ParadisOfficeFingerprint;
	readonly targetFingerprint: ParadisOfficeFingerprint;
	readonly targetScheme?: string;
	readonly behavior: 'notFetched';
}

export type ParadisWordUnsafeNode =
	| ParadisWordVbaUnsafeNode
	| ParadisWordSignatureUnsafeNode
	| ParadisWordOleUnsafeNode
	| ParadisWordActiveXUnsafeNode
	| ParadisWordEmbeddedPackageUnsafeNode
	| ParadisWordDdeUnsafeNode
	| ParadisWordExternalUnsafeNode;

export interface ParadisWordSecurityModel {
	readonly unsafeNodes: readonly ParadisWordUnsafeNode[];
	readonly assetPolicy: {
		readonly rawAccess: 'denied';
		readonly previewReferences: readonly ParadisWordSecurityPreviewReference[];
	};
}

interface OwnedPart {
	readonly bytes: Uint8Array;
	readonly source: ParadisWordPartAuthority;
	readonly contentType?: string;
}

interface ContentTypes {
	readonly defaults: ReadonlyMap<string, string>;
	readonly overrides: ReadonlyMap<string, string>;
}

interface Relationship {
	readonly id: string;
	readonly type: string;
	readonly relationshipPartFingerprint: ParadisOfficeFingerprint;
	readonly external: boolean;
	readonly targetPartUri?: string;
	readonly targetFingerprint?: ParadisOfficeFingerprint;
	readonly targetScheme?: string;
}

interface MutablePartNode {
	readonly id: string;
	readonly kind: 'vba' | 'signature' | 'ole' | 'activeX' | 'embeddedPackage';
	readonly sourceFingerprint: ParadisOfficeFingerprint;
	readonly contentType: string;
	readonly fingerprint: ParadisOfficeFingerprint;
	readonly rawAssetAccess: 'denied';
	readonly behavior: 'notExecuted' | 'notVerified' | 'notExpanded';
	objectType?: 'embedded' | 'linked' | 'unknown';
	programIdFingerprint?: ParadisOfficeFingerprint;
	previewReferenceId?: string;
}

class SecurityGuard {
	private readonly started: number;
	private last: number;
	private nodes = 0;

	constructor(
		private readonly token: CancellationToken | undefined,
		private readonly now: () => number,
		private readonly deadlineMilliseconds: number,
		private readonly maximumUnsafeNodes: number,
	) {
		this.started = this.readTime();
		this.last = this.started;
		this.checkpoint();
	}

	checkpoint(): void {
		throwIfParadisOfficeCancelled(this.token);
		const current = this.readTime();
		if (current < this.last || current - this.started > this.deadlineMilliseconds) {
			throw new ParadisOfficePackageError('limitExceeded');
		}
		this.last = current;
	}

	unsafeNode(): void {
		this.checkpoint();
		if (++this.nodes > this.maximumUnsafeNodes) {
			throw new ParadisOfficePackageError('limitExceeded');
		}
	}

	private readTime(): number {
		let value: number;
		try {
			value = this.now();
		} catch {
			throw new ParadisOfficePackageError('unsafe');
		}
		if (!Number.isFinite(value) || value < 0) {
			throw new ParadisOfficePackageError('invalid');
		}
		return value;
	}
}

/**
 * Classifies executable, externally backed, and recursively embedded Word content. The result
 * contains only hashes, normalized dispositions, and opaque preview references: no raw asset,
 * external target, DDE instruction, ProgID, fetch, execution, or embedded-package expansion.
 */
export function parseParadisWordSecurity(input: ParadisWordSecurityParseInput, options: ParadisWordSecurityParseOptions = {}): ParadisWordSecurityModel {
	try {
		const inputRecord = dataRecord(input);
		const optionsRecord = dataRecord(options);
		const token = optionalDataValue(inputRecord, 'token') as CancellationToken | undefined;
		const nowValue = optionalDataValue(optionsRecord, 'now');
		if (nowValue !== undefined && typeof nowValue !== 'function') {
			throw new ParadisOfficePackageError('unsafe');
		}
		const deadlineMilliseconds = boundedOption(optionsRecord, 'deadlineMilliseconds', hardMaximumDeadlineMilliseconds);
		const maximumParts = boundedOption(optionsRecord, 'maximumParts', hardMaximumParts);
		const maximumPartBytes = boundedOption(optionsRecord, 'maximumPartBytes', hardMaximumPartBytes);
		const maximumTotalBytes = boundedOption(optionsRecord, 'maximumTotalBytes', hardMaximumTotalBytes);
		const maximumUnsafeNodes = boundedOption(optionsRecord, 'maximumUnsafeNodes', hardMaximumUnsafeNodes);
		const guard = new SecurityGuard(token, nowValue as (() => number) | undefined ?? Date.now, deadlineMilliseconds, maximumUnsafeNodes);
		const rawParts = ownParts(requiredDataValue(inputRecord, 'parts'), maximumParts, maximumPartBytes, maximumTotalBytes, guard);
		const contentTypesPart = rawParts.get('/[Content_Types].xml');
		if (!contentTypesPart) {
			throw new ParadisOfficePackageError('malformed');
		}
		const contentTypes = parseContentTypes(parseXml(contentTypesPart, token, guard), guard);
		const parts = attachContentTypes(rawParts, contentTypes, guard);
		const relationships = parseAllRelationships(parts, token, guard);
		validatePackageRoot(parts, relationships);
		validateSecurityRelationships(parts, relationships, guard);

		const partNodes = new Map<string, MutablePartNode>();
		for (const [partUri, part] of parts) {
			guard.checkpoint();
			if (!part.contentType) {
				continue;
			}
			const kind = unsafeKindForContentType(part.contentType);
			if (!kind) {
				continue;
			}
			guard.unsafeNode();
			partNodes.set(partUri, {
				id: opaqueId(kind, partUri), kind, sourceFingerprint: part.source.partFingerprint,
				contentType: part.contentType, fingerprint: part.source.partFingerprint, rawAssetAccess: 'denied',
				behavior: kind === 'signature' ? 'notVerified' : kind === 'embeddedPackage' ? 'notExpanded' : 'notExecuted',
			});
		}

		const previewReferences = new Map<string, ParadisWordSecurityPreviewReference>();
		const ddeNodes: ParadisWordDdeUnsafeNode[] = [];
		for (const [partUri, part] of parts) {
			guard.checkpoint();
			if (!part.contentType || !wordStoryContentTypes.has(part.contentType)) {
				continue;
			}
			const root = parseXml(part, token, guard).root;
			if (!wordNamespaces.has(root.uri) || !['document', 'hdr', 'ftr', 'footnotes', 'endnotes', 'comments', 'glossaryDocument'].includes(root.local)) {
				throw new ParadisOfficePackageError('malformed');
			}
			const ownerRelationships = relationships.get(partUri) ?? new Map<string, Relationship>();
			bindObjectMetadata(root, partUri, partNodes, parts, ownerRelationships, previewReferences, guard);
			collectDdeNodes(root, partUri, part.source.partFingerprint, ddeNodes, guard);
		}

		const externalNodes: ParadisWordExternalUnsafeNode[] = [];
		for (const [ownerPartUri, ownerRelationships] of relationships) {
			for (const relationship of ownerRelationships.values()) {
				guard.checkpoint();
				if (!relationship.external || !relationship.targetFingerprint) {
					continue;
				}
				guard.unsafeNode();
				const kind = imageRelationshipTypes.has(relationship.type) ? 'externalImage' : 'externalRelationship';
				externalNodes.push({
					id: opaqueId(kind, `${ownerPartUri}\0${relationship.id}`), kind,
					sourceFingerprint: relationship.relationshipPartFingerprint, rawAssetAccess: 'denied',
					relationshipTypeFingerprint: fingerprintText(relationship.type), targetFingerprint: relationship.targetFingerprint,
					...(relationship.targetScheme ? { targetScheme: relationship.targetScheme } : {}), behavior: 'notFetched',
				});
			}
		}

		return deepFreeze({
			unsafeNodes: [...partNodes.values(), ...ddeNodes, ...externalNodes] as ParadisWordUnsafeNode[],
			assetPolicy: { rawAccess: 'denied', previewReferences: [...previewReferences.values()] },
		});
	} catch (error) {
		throw sanitizeSecurityError(error);
	}
}

function ownParts(value: unknown, maximumParts: number, maximumPartBytes: number, maximumTotalBytes: number, guard: SecurityGuard): ReadonlyMap<string, OwnedPart> {
	const candidates = dataArray(value, maximumParts);
	if (candidates.length === 0) {
		throw new ParadisOfficePackageError('malformed');
	}
	const result = new Map<string, OwnedPart>();
	let totalBytes = 0;
	for (const candidate of candidates) {
		guard.checkpoint();
		const partRecord = dataRecord(candidate);
		const bytes = ownStableBytes(requiredDataValue(partRecord, 'bytes'), maximumPartBytes, guard);
		totalBytes += bytes.byteLength;
		if (!Number.isSafeInteger(totalBytes) || totalBytes > maximumTotalBytes) {
			throw new ParadisOfficePackageError('limitExceeded');
		}
		const sourceRecord = dataRecord(requiredDataValue(partRecord, 'source'));
		const partUri = requiredString(sourceRecord, 'partUri');
		if (canonicalPartUri(partUri) !== partUri || result.has(partUri)) {
			throw new ParadisOfficePackageError(result.has(partUri) ? 'malformed' : 'unsafe');
		}
		const declared = snapshotFingerprint(requiredDataValue(sourceRecord, 'partFingerprint'));
		const actual = fingerprintParadisWordObjectBytes(bytes);
		if (!sameFingerprint(actual, declared)) {
			throw new ParadisOfficePackageError('unsafe');
		}
		result.set(partUri, { bytes, source: { partUri, partFingerprint: actual } });
	}
	return result;
}

function ownStableBytes(value: unknown, maximumBytes: number, guard: SecurityGuard): Uint8Array {
	guard.checkpoint();
	if (!value || typeof value !== 'object' || Object.getPrototypeOf(value) !== Uint8Array.prototype) {
		throw new ParadisOfficePackageError('unsafe');
	}
	for (const key of ['constructor', 'byteLength', 'byteOffset', 'buffer', 'slice', Symbol.species]) {
		if (Object.getOwnPropertyDescriptor(value, key)) {
			throw new ParadisOfficePackageError('unsafe');
		}
	}
	const source = value as Uint8Array;
	const sourceBuffer = typedArrayBuffer.call(source) as ArrayBuffer;
	if (Object.getPrototypeOf(sourceBuffer) !== ArrayBuffer.prototype) {
		throw new ParadisOfficePackageError('unsafe');
	}
	const length = typedArrayByteLength.call(source) as number;
	const offset = typedArrayByteOffset.call(source) as number;
	const bufferLength = arrayBufferByteLength.call(sourceBuffer) as number;
	if (arrayBufferResizable?.call(sourceBuffer) === true || arrayBufferDetached?.call(sourceBuffer) === true) {
		throw new ParadisOfficePackageError('unsafe');
	}
	if (!Number.isSafeInteger(length) || length < 0 || length > maximumBytes || !Number.isSafeInteger(offset) || offset < 0
		|| !Number.isSafeInteger(bufferLength) || offset + length > bufferLength) {
		throw new ParadisOfficePackageError(length > maximumBytes ? 'limitExceeded' : 'unsafe');
	}
	const owned = new Uint8Array(length);
	typedArraySet.call(owned, source);
	guard.checkpoint();
	if (typedArrayBuffer.call(source) !== sourceBuffer || typedArrayByteLength.call(source) !== length || typedArrayByteOffset.call(source) !== offset
		|| arrayBufferByteLength.call(sourceBuffer) !== bufferLength || arrayBufferResizable?.call(sourceBuffer) === true || arrayBufferDetached?.call(sourceBuffer) === true) {
		throw new ParadisOfficePackageError('unsafe');
	}
	for (let index = 0; index < length; index++) {
		if ((index & 0xfff) === 0) {
			guard.checkpoint();
		}
		if (owned[index] !== source[index]) {
			throw new ParadisOfficePackageError('unsafe');
		}
	}
	return owned;
}

function parseContentTypes(rootDocument: ReturnType<typeof parseParadisOfficeXml>, guard: SecurityGuard): ContentTypes {
	const root = rootDocument.root;
	if (root.uri !== contentTypeNamespace || root.local !== 'Types') {
		throw new ParadisOfficePackageError('malformed');
	}
	const defaults = new Map<string, string>();
	const overrides = new Map<string, string>();
	for (const child of elementChildren(root)) {
		guard.checkpoint();
		if (child.uri !== contentTypeNamespace || child.local !== 'Default' && child.local !== 'Override') {
			throw new ParadisOfficePackageError('malformed');
		}
		const contentType = requiredAttribute(child, '', 'ContentType').toLocaleLowerCase('en-US');
		if (!validContentType(contentType)) {
			throw new ParadisOfficePackageError('malformed');
		}
		if (child.local === 'Default') {
			const extension = requiredAttribute(child, '', 'Extension').toLocaleLowerCase('en-US');
			if (!/^[a-z0-9][a-z0-9._+-]*$/.test(extension) || defaults.has(extension)) {
				throw new ParadisOfficePackageError('malformed');
			}
			defaults.set(extension, contentType);
		} else {
			const partUri = requiredAttribute(child, '', 'PartName');
			if (canonicalPartUri(partUri) !== partUri || partUri === '/[Content_Types].xml' || overrides.has(partUri)) {
				throw new ParadisOfficePackageError('malformed');
			}
			overrides.set(partUri, contentType);
		}
	}
	return { defaults, overrides };
}

function attachContentTypes(parts: ReadonlyMap<string, OwnedPart>, contentTypes: ContentTypes, guard: SecurityGuard): ReadonlyMap<string, OwnedPart> {
	const result = new Map<string, OwnedPart>();
	for (const [partUri, part] of parts) {
		guard.checkpoint();
		if (partUri === '/[Content_Types].xml') {
			result.set(partUri, part);
			continue;
		}
		const extension = partUri.slice(partUri.lastIndexOf('.') + 1).toLocaleLowerCase('en-US');
		const contentType = contentTypes.overrides.get(partUri) ?? contentTypes.defaults.get(extension);
		if (!contentType || partUri.endsWith('.rels') && contentType !== relationshipsContentType) {
			throw new ParadisOfficePackageError('unsafe');
		}
		result.set(partUri, { ...part, contentType });
	}
	for (const partUri of contentTypes.overrides.keys()) {
		if (!parts.has(partUri)) {
			throw new ParadisOfficePackageError('unsafe');
		}
	}
	return result;
}

function parseAllRelationships(parts: ReadonlyMap<string, OwnedPart>, token: CancellationToken | undefined, guard: SecurityGuard): ReadonlyMap<string, ReadonlyMap<string, Relationship>> {
	const result = new Map<string, ReadonlyMap<string, Relationship>>();
	for (const part of parts.values()) {
		guard.checkpoint();
		if (part.contentType !== relationshipsContentType) {
			continue;
		}
		const ownerPartUri = relationshipOwner(part.source.partUri);
		if (ownerPartUri !== '/' && !parts.has(ownerPartUri) || result.has(ownerPartUri)) {
			throw new ParadisOfficePackageError('malformed');
		}
		const root = parseXml(part, token, guard).root;
		if (!packageRelationshipNamespaces.has(root.uri) || root.local !== 'Relationships') {
			throw new ParadisOfficePackageError('malformed');
		}
		const relationships = new Map<string, Relationship>();
		for (const child of elementChildren(root)) {
			guard.checkpoint();
			if (child.uri !== root.uri || child.local !== 'Relationship') {
				throw new ParadisOfficePackageError('malformed');
			}
			const id = requiredAttribute(child, '', 'Id');
			const type = requiredAttribute(child, '', 'Type');
			const target = requiredAttribute(child, '', 'Target');
			const mode = optionalAttribute(child, '', 'TargetMode');
			if (relationships.has(id) || !validRelationshipType(type) || mode !== undefined && mode !== 'External') {
				throw new ParadisOfficePackageError('malformed');
			}
			if (mode === 'External') {
				const targetScheme = /^([A-Za-z][A-Za-z0-9+.-]*):/.exec(target)?.[1]?.toLocaleLowerCase('en-US');
				relationships.set(id, {
					id, type, relationshipPartFingerprint: part.source.partFingerprint, external: true,
					targetFingerprint: fingerprintText(target), ...(targetScheme ? { targetScheme } : {}),
				});
			} else {
				const targetPartUri = resolveRelationshipTarget(ownerPartUri, target);
				if (!parts.has(targetPartUri)) {
					throw new ParadisOfficePackageError('unsafe');
				}
				relationships.set(id, { id, type, relationshipPartFingerprint: part.source.partFingerprint, external: false, targetPartUri });
			}
		}
		result.set(ownerPartUri, relationships);
	}
	return result;
}

function validatePackageRoot(parts: ReadonlyMap<string, OwnedPart>, relationships: ReadonlyMap<string, ReadonlyMap<string, Relationship>>): void {
	const roots = [...(relationships.get('/')?.values() ?? [])].filter(relationship => officeDocumentRelationshipTypes.has(relationship.type));
	if (roots.length !== 1 || roots[0].external || !roots[0].targetPartUri) {
		throw new ParadisOfficePackageError('unsafe');
	}
	const document = parts.get(roots[0].targetPartUri);
	if (!document?.contentType || !mainDocumentContentTypes.has(document.contentType)) {
		throw new ParadisOfficePackageError('unsafe');
	}
}

function validateSecurityRelationships(parts: ReadonlyMap<string, OwnedPart>, relationships: ReadonlyMap<string, ReadonlyMap<string, Relationship>>, guard: SecurityGuard): void {
	for (const ownerRelationships of relationships.values()) {
		for (const relationship of ownerRelationships.values()) {
			guard.checkpoint();
			if (relationship.external || !relationship.targetPartUri) {
				continue;
			}
			const contentType = parts.get(relationship.targetPartUri)?.contentType;
			if (!contentType) {
				throw new ParadisOfficePackageError('unsafe');
			}
			if (vbaRelationshipTypes.has(relationship.type) && !vbaContentTypes.has(contentType)
				|| oleRelationshipTypes.has(relationship.type) && !oleContentTypes.has(contentType)
				|| activeXRelationshipTypes.has(relationship.type) && !activeXContentTypes.has(contentType)
				|| packageRelationshipTypes.has(relationship.type) && !embeddedPackageContentTypes.has(contentType)
				|| imageRelationshipTypes.has(relationship.type) && !contentType.startsWith('image/')) {
				throw new ParadisOfficePackageError('unsafe');
			}
		}
	}
}

function bindObjectMetadata(
	root: XmlElement,
	ownerPartUri: string,
	partNodes: Map<string, MutablePartNode>,
	parts: ReadonlyMap<string, OwnedPart>,
	relationships: ReadonlyMap<string, Relationship>,
	previewReferences: Map<string, ParadisWordSecurityPreviewReference>,
	guard: SecurityGuard,
): void {
	walkElements(root, [], (element, path) => {
		guard.checkpoint();
		if (!officeObjectNamespaces.has(element.uri) || element.local !== 'OLEObject') {
			return;
		}
		const relationshipId = relationshipAttribute(element, 'id');
		const relationship = relationshipId ? relationships.get(relationshipId) : undefined;
		if (!relationship || relationship.external || !relationship.targetPartUri
			|| !oleRelationshipTypes.has(relationship.type) && !packageRelationshipTypes.has(relationship.type)) {
			throw new ParadisOfficePackageError('unsafe');
		}
		const node = partNodes.get(relationship.targetPartUri);
		if (!node || node.kind !== (packageRelationshipTypes.has(relationship.type) ? 'embeddedPackage' : 'ole')) {
			throw new ParadisOfficePackageError('unsafe');
		}
		const type = optionalAttribute(element, '', 'Type')?.toLocaleLowerCase('en-US');
		node.objectType = type === 'embed' ? 'embedded' : type === 'link' ? 'linked' : 'unknown';
		const programId = optionalAttribute(element, '', 'ProgID');
		if (programId !== undefined) {
			node.programIdFingerprint = fingerprintText(programId);
		}
		const object = ancestorWordObject(root, path);
		const imageData = object && firstDescendant(object, vmlNamespaces, 'imagedata');
		const previewRelationshipId = imageData && relationshipAttribute(imageData, 'id');
		if (!previewRelationshipId) {
			return;
		}
		const previewRelationship = relationships.get(previewRelationshipId);
		if (!previewRelationship || previewRelationship.external || !previewRelationship.targetPartUri || !imageRelationshipTypes.has(previewRelationship.type)) {
			throw new ParadisOfficePackageError('unsafe');
		}
		const previewPart = parts.get(previewRelationship.targetPartUri);
		if (!previewPart?.contentType?.startsWith('image/')) {
			throw new ParadisOfficePackageError('unsafe');
		}
		const id = opaqueId('preview', `${ownerPartUri}\0${previewRelationship.targetPartUri}`);
		if (!previewReferences.has(id)) {
			previewReferences.set(id, { id, contentType: previewPart.contentType, fingerprint: previewPart.source.partFingerprint });
		}
		node.previewReferenceId = id;
	});
}

function collectDdeNodes(root: XmlElement, ownerPartUri: string, sourceFingerprint: ParadisOfficeFingerprint, result: ParadisWordDdeUnsafeNode[], guard: SecurityGuard): void {
	const complexFields: { instruction: string[]; separated: boolean; path: readonly number[] }[] = [];
	walkElements(root, [], (element, path) => {
		guard.checkpoint();
		if (!wordNamespaces.has(element.uri)) {
			return;
		}
		if (element.local === 'fldSimple') {
			const instruction = requiredAttribute(element, element.uri, 'instr');
			appendDdeNode(instruction, ownerPartUri, path, sourceFingerprint, result, guard);
			return;
		}
		if (element.local === 'fldChar') {
			const type = requiredAttribute(element, element.uri, 'fldCharType');
			if (type === 'begin') {
				complexFields.push({ instruction: [], separated: false, path });
			} else if (type === 'separate') {
				const field = complexFields.at(-1);
				if (!field || field.separated) {
					throw new ParadisOfficePackageError('malformed');
				}
				field.separated = true;
			} else if (type === 'end') {
				const field = complexFields.pop();
				if (!field) {
					throw new ParadisOfficePackageError('malformed');
				}
				appendDdeNode(field.instruction.join(''), ownerPartUri, field.path, sourceFingerprint, result, guard);
			} else {
				throw new ParadisOfficePackageError('malformed');
			}
			return;
		}
		if (element.local === 'instrText') {
			for (const field of complexFields) {
				if (!field.separated) {
					field.instruction.push(elementText(element));
				}
			}
		}
	});
	if (complexFields.length > 0) {
		throw new ParadisOfficePackageError('malformed');
	}
}

function appendDdeNode(instruction: string, ownerPartUri: string, path: readonly number[], sourceFingerprint: ParadisOfficeFingerprint, result: ParadisWordDdeUnsafeNode[], guard: SecurityGuard): void {
	if (!/^\s*DDE(?:AUTO)?(?:\s|$)/i.test(instruction)) {
		return;
	}
	guard.unsafeNode();
	result.push({
		id: opaqueId('dde', `${ownerPartUri}\0${path.join('.')}`), kind: 'dde', sourceFingerprint,
		rawAssetAccess: 'denied', instructionFingerprint: fingerprintText(instruction), behavior: 'notExecuted',
	});
}

function ancestorWordObject(root: XmlElement, path: readonly number[]): XmlElement | undefined {
	let current = root;
	let found = wordNamespaces.has(current.uri) && current.local === 'object' ? current : undefined;
	for (const index of path) {
		const children = elementChildren(current);
		const child = children[index];
		if (!child) {
			return undefined;
		}
		current = child;
		if (wordNamespaces.has(current.uri) && current.local === 'object') {
			found = current;
		}
	}
	return found;
}

function unsafeKindForContentType(contentType: string): MutablePartNode['kind'] | undefined {
	if (vbaContentTypes.has(contentType)) {
		return 'vba';
	}
	if (signatureContentTypes.has(contentType)) {
		return 'signature';
	}
	if (oleContentTypes.has(contentType)) {
		return 'ole';
	}
	if (activeXContentTypes.has(contentType)) {
		return 'activeX';
	}
	if (embeddedPackageContentTypes.has(contentType)) {
		return 'embeddedPackage';
	}
	return undefined;
}

function parseXml(part: OwnedPart, token: CancellationToken | undefined, guard: SecurityGuard): ReturnType<typeof parseParadisOfficeXml> {
	guard.checkpoint();
	if (part.bytes.byteLength > xmlLimits.characters) {
		throw new ParadisOfficePackageError('limitExceeded');
	}
	let xml: string;
	try {
		xml = new TextDecoder('utf-8', { fatal: true }).decode(part.bytes);
	} catch {
		throw new ParadisOfficePackageError('malformed');
	}
	return parseParadisOfficeXml(xml, xmlLimits, token, () => guard.checkpoint());
}

function relationshipOwner(partUri: string): string {
	if (partUri === '/_rels/.rels') {
		return '/';
	}
	const match = /^(.*)\/_rels\/([^/]+)\.rels$/.exec(partUri);
	if (!match) {
		throw new ParadisOfficePackageError('malformed');
	}
	return `${match[1]}/${match[2]}`;
}

function resolveRelationshipTarget(ownerPartUri: string, target: string): string {
	if (!target || target.includes('\\') || target.includes('\0') || target.includes('?') || target.includes('#') || /^[A-Za-z][A-Za-z0-9+.-]*:/.test(target)) {
		throw new ParadisOfficePackageError('unsafe');
	}
	let decoded: string;
	try {
		decoded = decodeURIComponent(target);
	} catch {
		throw new ParadisOfficePackageError('unsafe');
	}
	const ownerDirectory = ownerPartUri === '/' ? '/' : ownerPartUri.slice(0, ownerPartUri.lastIndexOf('/') + 1);
	const combined = decoded.startsWith('/') ? decoded : `${ownerDirectory}${decoded}`;
	const normalized: string[] = [];
	for (const segment of combined.split('/')) {
		if (!segment || segment === '.') {
			continue;
		}
		if (segment === '..') {
			if (normalized.length === 0) {
				throw new ParadisOfficePackageError('unsafe');
			}
			normalized.pop();
		} else {
			normalized.push(segment);
		}
	}
	const resolved = `/${normalized.join('/')}`;
	if (canonicalPartUri(resolved) !== resolved) {
		throw new ParadisOfficePackageError('unsafe');
	}
	return resolved;
}

function canonicalPartUri(value: string): string {
	if (!value.startsWith('/') || value.length > 4_096 || value.includes('\\') || value.includes('%') || value.includes('\0')
		|| value.includes('?') || value.includes('#') || /[\u0000-\u001f\u007f]/.test(value)) {
		throw new ParadisOfficePackageError('unsafe');
	}
	const segments = value.slice(1).split('/');
	if (segments.some(segment => !segment || segment === '.' || segment === '..')) {
		throw new ParadisOfficePackageError('unsafe');
	}
	return `/${segments.join('/')}`;
}

function validContentType(value: string): boolean {
	return value.length <= 1_024 && /^[a-z0-9!#$&^_.+\-]+\/[a-z0-9!#$&^_.+\-]+$/i.test(value);
}

function validRelationshipType(value: string): boolean {
	return value.length <= 4_096 && /^[A-Za-z][A-Za-z0-9+.-]*:\/\/[^\s]+$/.test(value);
}

function relationshipTypes(local: string): ReadonlySet<string> {
	return new Set([
		`http://schemas.openxmlformats.org/officeDocument/2006/relationships/${local}`,
		`http://purl.oclc.org/ooxml/officeDocument/relationships/${local}`,
	]);
}

function walkElements(element: XmlElement, path: readonly number[], visit: (element: XmlElement, path: readonly number[]) => void): void {
	visit(element, path);
	let ordinal = 0;
	for (const child of element.children) {
		if (child.kind === 'element') {
			walkElements(child, [...path, ordinal++], visit);
		}
	}
}

function firstDescendant(element: XmlElement, namespaces: ReadonlySet<string>, local: string): XmlElement | undefined {
	let result: XmlElement | undefined;
	walkElements(element, [], candidate => {
		if (!result && candidate !== element && namespaces.has(candidate.uri) && candidate.local === local) {
			result = candidate;
		}
	});
	return result;
}

function elementChildren(element: XmlElement): XmlElement[] {
	return element.children.filter((child): child is XmlElement => child.kind === 'element');
}

function elementText(element: XmlElement): string {
	return element.children.map(child => child.kind === 'text' ? child.value : elementText(child)).join('');
}

function relationshipAttribute(element: XmlElement, local: string): string | undefined {
	return element.attributes.find(attribute => officeRelationshipNamespaces.has(attribute.uri) && attribute.local === local)?.value;
}

function requiredAttribute(element: XmlElement, uri: string, local: string): string {
	const value = optionalAttribute(element, uri, local);
	if (value === undefined || value.length === 0) {
		throw new ParadisOfficePackageError('malformed');
	}
	return value;
}

function optionalAttribute(element: XmlElement, uri: string, local: string): string | undefined {
	return element.attributes.find(attribute => attribute.uri === uri && attribute.local === local)?.value;
}

function dataRecord(value: unknown): DataRecord {
	if (!value || typeof value !== 'object') {
		throw new ParadisOfficePackageError('unsafe');
	}
	const prototype = Object.getPrototypeOf(value);
	if (prototype !== Object.prototype && prototype !== null) {
		throw new ParadisOfficePackageError('unsafe');
	}
	return value as DataRecord;
}

function optionalDataValue(record: DataRecord, key: PropertyKey): unknown {
	const descriptor = Object.getOwnPropertyDescriptor(record, key);
	if (!descriptor) {
		return undefined;
	}
	if (!Object.hasOwn(descriptor, 'value')) {
		throw new ParadisOfficePackageError('unsafe');
	}
	return descriptor.value;
}

function requiredDataValue(record: DataRecord, key: PropertyKey): unknown {
	const value = optionalDataValue(record, key);
	if (value === undefined) {
		throw new ParadisOfficePackageError('unsafe');
	}
	return value;
}

function requiredString(record: DataRecord, key: PropertyKey): string {
	const value = requiredDataValue(record, key);
	if (typeof value !== 'string') {
		throw new ParadisOfficePackageError('unsafe');
	}
	return value;
}

function dataArray(value: unknown, maximum: number): readonly unknown[] {
	if (!Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype) {
		throw new ParadisOfficePackageError('unsafe');
	}
	const lengthDescriptor = Object.getOwnPropertyDescriptor(value, 'length');
	const length = lengthDescriptor && Object.hasOwn(lengthDescriptor, 'value') ? lengthDescriptor.value : undefined;
	if (typeof length !== 'number' || !Number.isSafeInteger(length) || length < 0 || length > maximum) {
		throw new ParadisOfficePackageError(typeof length === 'number' && length > maximum ? 'limitExceeded' : 'unsafe');
	}
	const result: unknown[] = [];
	for (let index = 0; index < length; index++) {
		const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
		if (!descriptor || !Object.hasOwn(descriptor, 'value')) {
			throw new ParadisOfficePackageError('unsafe');
		}
		result.push(descriptor.value);
	}
	return result;
}

function snapshotFingerprint(value: unknown): ParadisOfficeFingerprint {
	const record = dataRecord(value);
	const algorithm = requiredString(record, 'algorithm');
	const hash = requiredString(record, 'value').toLocaleLowerCase('en-US');
	const byteLength = requiredDataValue(record, 'byteLength');
	if (algorithm !== 'sha256' || !/^[0-9a-f]{64}$/.test(hash) || typeof byteLength !== 'number' || !Number.isSafeInteger(byteLength) || byteLength < 0) {
		throw new ParadisOfficePackageError('unsafe');
	}
	return { algorithm: 'sha256', value: hash, byteLength };
}

function boundedOption(record: DataRecord, key: keyof ParadisWordSecurityParseOptions, hardMaximum: number): number {
	const value = optionalDataValue(record, key);
	if (value === undefined) {
		return hardMaximum;
	}
	if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) {
		throw new ParadisOfficePackageError('limitExceeded');
	}
	return Math.min(value, hardMaximum);
}

function sameFingerprint(left: ParadisOfficeFingerprint, right: ParadisOfficeFingerprint): boolean {
	return left.algorithm === right.algorithm && left.value === right.value && left.byteLength === right.byteLength;
}

function fingerprintText(value: string): ParadisOfficeFingerprint {
	return fingerprintParadisWordObjectBytes(new TextEncoder().encode(value));
}

function opaqueId(kind: string, identity: string): string {
	return `wordSecurity:${kind}:${fingerprintText(identity).value}`;
}

function deepFreeze<T>(value: T): T {
	const seen = new WeakSet<object>();
	const stack: object[] = [];
	if (value && typeof value === 'object') {
		stack.push(value);
	}
	while (stack.length > 0) {
		const current = stack.pop()!;
		if (seen.has(current)) {
			continue;
		}
		seen.add(current);
		for (const key of Reflect.ownKeys(current)) {
			const candidate = Object.getOwnPropertyDescriptor(current, key)?.value;
			if (candidate && typeof candidate === 'object') {
				stack.push(candidate);
			}
		}
		Object.freeze(current);
	}
	return value;
}

function sanitizeSecurityError(error: unknown): ParadisOfficePackageError {
	let code: ParadisOfficePackageError['code'] = 'unsafe';
	try {
		if (error !== null && typeof error === 'object' && Object.getPrototypeOf(error) === ParadisOfficePackageError.prototype) {
			const descriptor = Object.getOwnPropertyDescriptor(error, 'code');
			const value = descriptor && Object.hasOwn(descriptor, 'value') ? descriptor.value : undefined;
			if (value === 'invalid' || value === 'encrypted' || value === 'zipBomb' || value === 'limitExceeded'
				|| value === 'malformed' || value === 'cancelled' || value === 'unsafe') {
				code = value;
			}
		}
	} catch {
		code = 'unsafe';
	}
	return new ParadisOfficePackageError(code);
}
