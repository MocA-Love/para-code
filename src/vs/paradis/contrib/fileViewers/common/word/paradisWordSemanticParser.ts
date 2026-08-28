/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import type { CancellationToken } from '../../../../../base/common/cancellation.js';
import { StopWatch } from '../../../../../base/common/stopwatch.js';
import {
	PARADIS_OFFICE_BUDGET_PROFILES,
	type ParadisOfficeBudgetProfile,
	type ParadisOfficeFingerprint,
	type ParadisOfficeInventory,
	type ParadisOfficeInventoryPart,
	type ParadisOfficeRenderAnchorKey,
} from '../paradisOfficeProtocol.js';
import {
	canonicalizeParadisOfficeArchiveName,
	type IParadisOfficeArchive,
	type ParadisOfficeArchiveEntry,
	type ParadisOfficeXmlDocument,
	type ParadisOfficeXmlNode,
	ParadisOfficePackageError,
	throwIfParadisOfficeCancelled,
} from '../office/paradisOfficeArchive.js';
import type {
	ParadisWordAltChunkNode,
	ParadisWordBookmarkNode,
	ParadisWordBreakNode,
	ParadisWordCellNode,
	ParadisWordCommentReferenceNode,
	ParadisWordCompleteness,
	ParadisWordContentControlNode,
	ParadisWordDocument,
	ParadisWordDrawingGeometry,
	ParadisWordDrawingNode,
	ParadisWordFieldNode,
	ParadisWordHeaderFooterRole,
	ParadisWordHyperlinkNode,
	ParadisWordImageNode,
	ParadisWordNode,
	ParadisWordNodeKind,
	ParadisWordNoteReferenceNode,
	ParadisWordOmmlNode,
	ParadisWordParagraphNode,
	ParadisWordRevisionNode,
	ParadisWordRowNode,
	ParadisWordSectionNode,
	ParadisWordSourceRef,
	ParadisWordStory,
	ParadisWordStoryKind,
	ParadisWordStoryReference,
	ParadisWordSymbolNode,
	ParadisWordTableDiagonalBorder,
	ParadisWordTableNode,
	ParadisWordTextNode,
	ParadisWordTextboxGeometry,
	ParadisWordUnknownBlockNode,
} from './paradisWordSemantic.js';

type XmlElement = Extract<ParadisOfficeXmlNode, { readonly kind: 'element' }>;

const wordNamespaces = new Set([
	'http://schemas.openxmlformats.org/wordprocessingml/2006/main',
	'http://purl.oclc.org/ooxml/wordprocessingml/main',
]);
const officeRelationshipNamespaces = new Set([
	'http://schemas.openxmlformats.org/officeDocument/2006/relationships',
	'http://purl.oclc.org/ooxml/officeDocument/relationships',
]);
const packageRelationshipNamespaces = new Set([
	'http://schemas.openxmlformats.org/package/2006/relationships',
	'http://purl.oclc.org/ooxml/package/relationships',
]);
const packageContentTypeNamespaces = new Set([
	'http://schemas.openxmlformats.org/package/2006/content-types',
	'http://purl.oclc.org/ooxml/package/content-types',
]);
const drawingWordprocessingNamespaces = new Set([
	'http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing',
	'http://purl.oclc.org/ooxml/drawingml/wordprocessingDrawing',
]);
const drawingNamespaces = new Set([
	'http://schemas.openxmlformats.org/drawingml/2006/main',
	'http://purl.oclc.org/ooxml/drawingml/main',
]);
const mathNamespaces = new Set([
	'http://schemas.openxmlformats.org/officeDocument/2006/math',
	'http://purl.oclc.org/ooxml/officeDocument/math',
]);
const vmlNamespaces = new Set(['urn:schemas-microsoft-com:vml']);
const xmlNamespace = 'http://www.w3.org/XML/1998/namespace';

const contentTypesPartUri = '/[Content_Types].xml';
const relationshipContentTypes = new Set(['application/vnd.openxmlformats-package.relationships+xml']);
const officeDocumentRelationshipTypes = relationshipTypes('officeDocument');
const headerRelationshipTypes = relationshipTypes('header');
const footerRelationshipTypes = relationshipTypes('footer');
const footnotesRelationshipTypes = relationshipTypes('footnotes');
const endnotesRelationshipTypes = relationshipTypes('endnotes');
const commentsRelationshipTypes = relationshipTypes('comments');
const imageRelationshipTypes = relationshipTypes('image');
const hyperlinkRelationshipTypes = relationshipTypes('hyperlink');
const altChunkRelationshipTypes = relationshipTypes('aFChunk');

const mainContentTypes: Readonly<Record<'docx' | 'docm' | 'dotx' | 'dotm', ReadonlySet<string>>> = {
	docx: new Set(['application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml']),
	docm: new Set(['application/vnd.ms-word.document.macroEnabled.main+xml']),
	dotx: new Set(['application/vnd.openxmlformats-officedocument.wordprocessingml.template.main+xml']),
	dotm: new Set(['application/vnd.ms-word.template.macroEnabledTemplate.main+xml']),
};
const headerContentTypes = new Set(['application/vnd.openxmlformats-officedocument.wordprocessingml.header+xml']);
const footerContentTypes = new Set(['application/vnd.openxmlformats-officedocument.wordprocessingml.footer+xml']);
const footnotesContentTypes = new Set(['application/vnd.openxmlformats-officedocument.wordprocessingml.footnotes+xml']);
const endnotesContentTypes = new Set(['application/vnd.openxmlformats-officedocument.wordprocessingml.endnotes+xml']);
const commentsContentTypes = new Set(['application/vnd.openxmlformats-officedocument.wordprocessingml.comments+xml']);

export interface ParadisWordSemanticLimits {
	readonly stories: number;
	readonly nodes: number;
	readonly relationships: number;
	readonly textCharacters: number;
}

export interface ParadisWordSemanticParseOptions {
	readonly limits?: Partial<ParadisWordSemanticLimits>;
	readonly now?: () => number;
	readonly deadlineMilliseconds?: number;
}

export interface ParadisWordOwnedSemanticInput {
	readonly inventory: ParadisOfficeInventory;
	readonly options: ParadisWordSemanticParseOptions;
}

export interface ParadisWordOwnedAdapterInput extends ParadisWordOwnedSemanticInput {
	readonly bytes: Uint8Array;
}

interface OwnedWordContext extends ParadisWordOwnedSemanticInput {
	readonly hardDeadline: StopWatch;
	readonly deadlineMilliseconds: number;
}

interface RawRelationship {
	readonly id: string;
	readonly type: string;
	readonly target: string;
	readonly targetMode: 'internal' | 'external';
}

interface IndexedArchivePart {
	readonly entry: ParadisOfficeArchiveEntry;
	readonly inventoryPart: ParadisOfficeInventoryPart;
}

interface ParsedXmlPart {
	readonly uri: string;
	readonly document: ParadisOfficeXmlDocument;
	readonly fingerprint: ParadisOfficeFingerprint;
}

interface SemanticArchiveReader {
	readonly parts: ReadonlyMap<string, IndexedArchivePart>;
	readonly parsed: Map<string, ParsedXmlPart>;
	readCompressedBytes: number;
	readExpandedBytes: number;
}

interface ContentTypesAuthority {
	readonly defaults: ReadonlyMap<string, string>;
	readonly overrides: ReadonlyMap<string, string>;
}

interface NodeParseState {
	readonly factory: WordNodeFactory;
	readonly relationships: ReadonlyMap<string, RawRelationship>;
	readonly inventoryParts: ReadonlyMap<string, ParadisOfficeInventoryPart>;
	readonly counters: MutableCounters;
	readonly limits: ParadisWordSemanticLimits;
	readonly checkpoint: (force?: boolean) => void;
}

interface MutableCounters {
	nodes: number;
	unknownBlocks: number;
	unresolvedRelationships: number;
	textCharacters: number;
}

interface RawSectionReference {
	readonly kind: 'header' | 'footer';
	readonly role: ParadisWordHeaderFooterRole;
	readonly sectionOrdinal: number;
	readonly targetPartUri: string;
	readonly semanticPath: readonly number[];
}

interface TextboxDescriptor {
	readonly part: ParsedXmlPart;
	readonly ownerStoryId: string;
	readonly element: XmlElement;
	readonly xmlPath: readonly number[];
	readonly container?: XmlElement;
}

const defaultLimits: ParadisWordSemanticLimits = {
	stories: 100_000,
	nodes: 2_000_000,
	relationships: 100_000,
	textCharacters: 64 * 1024 * 1024,
};
const semanticLimitKeys: readonly (keyof ParadisWordSemanticLimits)[] = ['stories', 'nodes', 'relationships', 'textCharacters'];
const maximumInventoryParts = PARADIS_OFFICE_BUDGET_PROFILES.desktopLocal.entryCount;
const maximumInventoryRelationships = 100_000;
const maximumSemanticDeadlineMilliseconds = Math.max(...Object.values(PARADIS_OFFICE_BUDGET_PROFILES).map(profile => profile.semanticParseMilliseconds));
const ownedWordContexts = new WeakMap<ParadisOfficeInventory, { readonly options: ParadisWordSemanticParseOptions; readonly context: OwnedWordContext }>();

const typedArrayPrototype = Object.getPrototypeOf(Uint8Array.prototype);
const typedArrayByteLength = Object.getOwnPropertyDescriptor(typedArrayPrototype, 'byteLength')!.get!;
const typedArrayBuffer = Object.getOwnPropertyDescriptor(typedArrayPrototype, 'buffer')!.get!;
const typedArraySet = Uint8Array.prototype.set;
const arrayBufferByteLength = Object.getOwnPropertyDescriptor(ArrayBuffer.prototype, 'byteLength')!.get!;
const arrayBufferResizable = Object.getOwnPropertyDescriptor(ArrayBuffer.prototype, 'resizable')?.get;
const arrayBufferDetached = Object.getOwnPropertyDescriptor(ArrayBuffer.prototype, 'detached')?.get;

function relationshipTypes(local: string): ReadonlySet<string> {
	return new Set([
		`http://schemas.openxmlformats.org/officeDocument/2006/relationships/${local}`,
		`http://purl.oclc.org/ooxml/officeDocument/relationships/${local}`,
	]);
}

/** Returns a fresh allow-listed package error without retaining caller or archive details. */
export function sanitizeWordPackageError(error: unknown, fallback: ParadisOfficePackageError['code'] = 'invalid'): ParadisOfficePackageError {
	let code = fallback;
	try {
		if (error !== null && typeof error === 'object' && Object.getPrototypeOf(error) === ParadisOfficePackageError.prototype) {
			const descriptor = Object.getOwnPropertyDescriptor(error, 'code');
			const value = descriptor && Object.hasOwn(descriptor, 'value') ? descriptor.value : undefined;
			if (value === 'invalid' || value === 'encrypted' || value === 'zipBomb' || value === 'limitExceeded' || value === 'malformed' || value === 'cancelled' || value === 'unsafe') {
				code = value;
			}
		}
	} catch {
		code = fallback;
	}
	return new ParadisOfficePackageError(code);
}

/** Takes a bounded ownership snapshot before common parsing crosses its first async boundary. */
export function ownWordSemanticInput(
	inventory: ParadisOfficeInventory,
	options: ParadisWordSemanticParseOptions,
	token?: CancellationToken,
	executionProfile?: ParadisOfficeInventory['budgetProfile'],
): ParadisWordOwnedSemanticInput {
	try {
		const context = createOwnedWordContext(inventory, options, token, executionProfile);
		ownedWordContexts.set(context.inventory, { options: context.options, context });
		return { inventory: context.inventory, options: context.options };
	} catch (error) {
		throw sanitizeWordPackageError(error, 'unsafe');
	}
}

/** Copies fixed-buffer bytes before reading any caller-owned inventory or option descriptor. */
export function ownWordSemanticAdapterInput(
	bytes: Uint8Array,
	inventory: ParadisOfficeInventory,
	options: ParadisWordSemanticParseOptions,
	token: CancellationToken | undefined,
	executionProfile: ParadisOfficeInventory['budgetProfile'],
): ParadisWordOwnedAdapterInput {
	try {
		const profile = budgetProfile(executionProfile);
		const hardDeadline = StopWatch.create(true);
		const checkpoint = (): void => {
			throwIfParadisOfficeCancelled(token);
			if (hardDeadline.elapsed() > profile.semanticParseMilliseconds) {
				throw new ParadisOfficePackageError('limitExceeded');
			}
		};
		const ownedBytes = ownStableWordBytes(bytes, profile.compressedInputBytes, checkpoint);
		const context = createOwnedWordContext(inventory, options, token, executionProfile, hardDeadline);
		ownedWordContexts.set(context.inventory, { options: context.options, context });
		return { bytes: ownedBytes, inventory: context.inventory, options: context.options };
	} catch (error) {
		throw sanitizeWordPackageError(error, 'unsafe');
	}
}

function createOwnedWordContext(
	inventory: ParadisOfficeInventory,
	options: ParadisWordSemanticParseOptions,
	token?: CancellationToken,
	executionProfile?: ParadisOfficeInventory['budgetProfile'],
	hardDeadline = StopWatch.create(true),
): OwnedWordContext {
	let deadlineMilliseconds = executionProfile === undefined ? maximumSemanticDeadlineMilliseconds : budgetProfile(executionProfile).semanticParseMilliseconds;
	const checkpoint = (): void => {
		throwIfParadisOfficeCancelled(token);
		if (hardDeadline.elapsed() > deadlineMilliseconds) {
			throw new ParadisOfficePackageError('limitExceeded');
		}
	};
	checkpoint();
	const inventoryRecord = dataRecord(inventory);
	const optionsRecord = dataRecord(options);
	const declaredProfile = requiredString(inventoryRecord, 'budgetProfile');
	if (executionProfile !== undefined && declaredProfile !== executionProfile) {
		throw new ParadisOfficePackageError('unsafe');
	}
	const effectiveProfile = budgetProfile((executionProfile ?? declaredProfile) as ParadisOfficeInventory['budgetProfile']);
	const requestedDeadline = optionalDataValue(optionsRecord, 'deadlineMilliseconds') ?? effectiveProfile.semanticParseMilliseconds;
	if (typeof requestedDeadline !== 'number' || !Number.isSafeInteger(requestedDeadline) || requestedDeadline < 0) {
		throw new ParadisOfficePackageError('limitExceeded');
	}
	deadlineMilliseconds = Math.min(effectiveProfile.semanticParseMilliseconds, requestedDeadline);
	const now = optionalDataValue(optionsRecord, 'now');
	if (now !== undefined && typeof now !== 'function') {
		throw new ParadisOfficePackageError('unsafe');
	}
	const limits = snapshotLimits(optionalDataValue(optionsRecord, 'limits'));
	const ownedInventory = snapshotInventory(inventoryRecord, effectiveProfile, checkpoint);
	const ownedOptions: ParadisWordSemanticParseOptions = Object.freeze({
		limits: Object.freeze(limits),
		...(now ? { now: now as () => number } : {}),
		deadlineMilliseconds,
	});
	return { inventory: ownedInventory, options: ownedOptions, hardDeadline, deadlineMilliseconds };
}

function ownStableWordBytes(value: unknown, maximumBytes: number, checkpoint: () => void): Uint8Array {
	checkpoint();
	if (!value || typeof value !== 'object' || Object.getPrototypeOf(value) !== Uint8Array.prototype) {
		throw new ParadisOfficePackageError('invalid');
	}
	for (const key of ['constructor', 'byteLength', 'slice', Symbol.species]) {
		checkpoint();
		if (Object.getOwnPropertyDescriptor(value, key)) {
			throw new ParadisOfficePackageError('invalid');
		}
	}
	const source = value as Uint8Array;
	const sourceBuffer = typedArrayBuffer.call(source) as ArrayBuffer;
	if (Object.getPrototypeOf(sourceBuffer) !== ArrayBuffer.prototype) {
		throw new ParadisOfficePackageError('invalid');
	}
	for (const key of ['constructor', 'byteLength', 'slice', Symbol.species]) {
		checkpoint();
		if (Object.getOwnPropertyDescriptor(sourceBuffer, key)) {
			throw new ParadisOfficePackageError('invalid');
		}
	}
	if (arrayBufferResizable?.call(sourceBuffer) === true || arrayBufferDetached?.call(sourceBuffer) === true) {
		throw new ParadisOfficePackageError('invalid');
	}
	const length = typedArrayByteLength.call(source) as number;
	const bufferLength = arrayBufferByteLength.call(sourceBuffer) as number;
	if (!Number.isSafeInteger(length) || length < 0 || length > maximumBytes || !Number.isSafeInteger(bufferLength) || bufferLength < length) {
		throw new ParadisOfficePackageError(length > maximumBytes ? 'limitExceeded' : 'invalid');
	}
	const owned = new Uint8Array(new ArrayBuffer(length));
	typedArraySet.call(owned, source);
	checkpoint();
	if (typedArrayBuffer.call(source) !== sourceBuffer || typedArrayByteLength.call(source) !== length || arrayBufferByteLength.call(sourceBuffer) !== bufferLength
		|| arrayBufferResizable?.call(sourceBuffer) === true || arrayBufferDetached?.call(sourceBuffer) === true) {
		throw new ParadisOfficePackageError('unsafe');
	}
	for (let index = 0; index < length; index++) {
		if ((index & 0xfff) === 0) {
			checkpoint();
		}
		if (owned[index] !== source[index]) {
			throw new ParadisOfficePackageError('unsafe');
		}
	}
	return owned;
}

type DataRecord = Readonly<Record<PropertyKey, unknown>>;

function dataRecord(value: unknown): DataRecord {
	if (value === null || typeof value !== 'object') {
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

function requiredNumber(record: DataRecord, key: PropertyKey): number {
	const value = requiredDataValue(record, key);
	if (typeof value !== 'number' || !Number.isFinite(value)) {
		throw new ParadisOfficePackageError('unsafe');
	}
	return value;
}

function requiredBoolean(record: DataRecord, key: PropertyKey): boolean {
	const value = requiredDataValue(record, key);
	if (typeof value !== 'boolean') {
		throw new ParadisOfficePackageError('unsafe');
	}
	return value;
}

function dataArray(value: unknown, maximum: number): readonly unknown[] {
	if (!Array.isArray(value)) {
		throw new ParadisOfficePackageError('unsafe');
	}
	const lengthDescriptor = Object.getOwnPropertyDescriptor(value, 'length');
	const length = lengthDescriptor && Object.hasOwn(lengthDescriptor, 'value') ? lengthDescriptor.value : undefined;
	if (typeof length !== 'number' || !Number.isSafeInteger(length) || length < 0 || length > maximum) {
		throw new ParadisOfficePackageError(length as number > maximum ? 'limitExceeded' : 'unsafe');
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

function snapshotInventory(record: DataRecord, profile: ParadisOfficeBudgetProfile, checkpoint: () => void): ParadisOfficeInventory {
	const parts = dataArray(requiredDataValue(record, 'parts'), Math.min(maximumInventoryParts, profile.entryCount)).map(value => {
		checkpoint();
		return snapshotInventoryPart(value);
	});
	const relationships = dataArray(requiredDataValue(record, 'relationships'), maximumInventoryRelationships).map(value => {
		checkpoint();
		const relationship = dataRecord(value);
		const targetMode = requiredString(relationship, 'targetMode');
		if (targetMode !== 'internal' && targetMode !== 'external') {
			throw new ParadisOfficePackageError('unsafe');
		}
		const sourcePartId = optionalDataValue(relationship, 'sourcePartId');
		return Object.freeze({
			id: requiredString(relationship, 'id'),
			...(sourcePartId !== undefined ? { sourcePartId: stringValue(sourcePartId) } : {}),
			type: requiredString(relationship, 'type'),
			target: requiredString(relationship, 'target'),
			targetMode,
			missing: requiredBoolean(relationship, 'missing'),
			cyclic: requiredBoolean(relationship, 'cyclic'),
		});
	});
	const security = dataRecord(requiredDataValue(record, 'security'));
	const budgetUsage = dataRecord(requiredDataValue(record, 'budgetUsage'));
	return Object.freeze({
		format: requiredString(record, 'format') as ParadisOfficeInventory['format'],
		container: requiredString(record, 'container') as ParadisOfficeInventory['container'],
		parts: Object.freeze(parts),
		relationships: Object.freeze(relationships),
		features: Object.freeze([]),
		security: Object.freeze({
			encrypted: requiredBoolean(security, 'encrypted'),
			hasMacros: requiredBoolean(security, 'hasMacros'),
			hasExternalRelationships: requiredBoolean(security, 'hasExternalRelationships'),
			hasEmbeddedObjects: requiredBoolean(security, 'hasEmbeddedObjects'),
			hasProtection: requiredBoolean(security, 'hasProtection'),
			hasSignatures: requiredBoolean(security, 'hasSignatures'),
		}),
		budgetProfile: requiredString(record, 'budgetProfile') as ParadisOfficeInventory['budgetProfile'],
		budgetUsage: Object.freeze({
			compressedInputBytes: requiredNumber(budgetUsage, 'compressedInputBytes'),
			expandedBytes: requiredNumber(budgetUsage, 'expandedBytes'),
			entryCount: requiredNumber(budgetUsage, 'entryCount'),
			largestPartBytes: requiredNumber(budgetUsage, 'largestPartBytes'),
			totalMediaBytes: requiredNumber(budgetUsage, 'totalMediaBytes'),
			elapsedMilliseconds: requiredNumber(budgetUsage, 'elapsedMilliseconds'),
		}),
	});
}

function snapshotInventoryPart(value: unknown): ParadisOfficeInventoryPart {
	const part = dataRecord(value);
	const base = {
		id: requiredString(part, 'id'),
		canonicalUri: requiredString(part, 'canonicalUri'),
		contentType: requiredString(part, 'contentType'),
		compressedBytes: requiredNumber(part, 'compressedBytes'),
		expandedBytes: requiredNumber(part, 'expandedBytes'),
		required: requiredBoolean(part, 'required'),
	};
	const coverage = requiredString(part, 'coverage');
	if (coverage === 'parsed') {
		return Object.freeze({ ...base, coverage, rawHash: snapshotFingerprint(requiredDataValue(part, 'rawHash')), hashCompleteness: 'allBytes' });
	}
	if (coverage === 'completeOpaque') {
		return Object.freeze({ ...base, coverage, fingerprint: snapshotFingerprint(requiredDataValue(part, 'fingerprint')), hashCompleteness: 'allBytes' });
	}
	if (coverage !== 'partial' && coverage !== 'opaque' && coverage !== 'unsafe' && coverage !== 'failed' && coverage !== 'omittedByBudget') {
		throw new ParadisOfficePackageError('unsafe');
	}
	const rawHash = optionalDataValue(part, 'rawHash');
	const hashCompleteness = optionalDataValue(part, 'hashCompleteness');
	return Object.freeze({
		...base,
		coverage,
		...(rawHash !== undefined ? { rawHash: snapshotFingerprint(rawHash) } : {}),
		...(hashCompleteness === 'allBytes' || hashCompleteness === 'incomplete' ? { hashCompleteness } : {}),
	});
}

function snapshotFingerprint(value: unknown): ParadisOfficeFingerprint {
	const fingerprint = dataRecord(value);
	if (requiredString(fingerprint, 'algorithm') !== 'sha256') {
		throw new ParadisOfficePackageError('unsafe');
	}
	const byteLength = requiredNumber(fingerprint, 'byteLength');
	if (!Number.isSafeInteger(byteLength) || byteLength < 0) {
		throw new ParadisOfficePackageError('unsafe');
	}
	return Object.freeze({ algorithm: 'sha256', value: requiredString(fingerprint, 'value'), byteLength });
}

function snapshotLimits(value: unknown): ParadisWordSemanticLimits {
	if (value === undefined) {
		return { ...defaultLimits };
	}
	const record = dataRecord(value);
	const result = { ...defaultLimits };
	for (const key of semanticLimitKeys) {
		const candidate = optionalDataValue(record, key);
		if (candidate === undefined) {
			continue;
		}
		if (typeof candidate !== 'number' || !Number.isSafeInteger(candidate) || candidate < 0) {
			throw new ParadisOfficePackageError('limitExceeded');
		}
		result[key] = Math.min(defaultLimits[key], candidate);
	}
	return result;
}

function stringValue(value: unknown): string {
	if (typeof value !== 'string') {
		throw new ParadisOfficePackageError('unsafe');
	}
	return value;
}

function budgetProfile(kind: ParadisOfficeInventory['budgetProfile']): ParadisOfficeBudgetProfile {
	if (kind !== 'desktopLocal' && kind !== 'remoteMobile' && kind !== 'browser') {
		throw new ParadisOfficePackageError('unsafe');
	}
	return PARADIS_OFFICE_BUDGET_PROFILES[kind];
}

/**
 * Parses a verified Word package into source-ordered Stories and semantic nodes. The archive is
 * consumed exactly once and is disposed on success, failure, cancellation, and deadline expiry.
 */
export async function parseWordSemantic(
	archive: IParadisOfficeArchive,
	inventory: ParadisOfficeInventory,
	token?: CancellationToken,
	options: ParadisWordSemanticParseOptions = {},
): Promise<ParadisWordDocument> {
	let disposeAttempted = false;
	try {
		const marked = ownedWordContexts.get(inventory);
		const context = marked?.options === options ? marked.context : createOwnedWordContext(inventory, options, token);
		if (marked?.options === options) {
			ownedWordContexts.delete(inventory);
		}
		const ownedInventory = context.inventory;
		const ownedOptions = context.options;
		const profile = budgetProfile(ownedInventory.budgetProfile);
		const limits = resolveWordSemanticLimits(ownedOptions.limits);
		const now = ownedOptions.now ?? Date.now;
		const started = monotonicTime(now);
		let lastTime = started;
		let checks = 0;
		const checkpoint = (force = false): void => {
			checks++;
			if (!force && (checks & 0x7f) !== 0) {
				return;
			}
			throwIfParadisOfficeCancelled(token);
			if (context.hardDeadline.elapsed() > context.deadlineMilliseconds) {
				throw new ParadisOfficePackageError('limitExceeded');
			}
			const current = monotonicTime(now);
			if (current < lastTime) {
				throw new ParadisOfficePackageError('invalid');
			}
			lastTime = current;
			if (current - started > context.deadlineMilliseconds) {
				throw new ParadisOfficePackageError('limitExceeded');
			}
		};
		checkpoint(true);
		validateInventory(ownedInventory, archive, profile);
		const inventoryParts = new Map<string, ParadisOfficeInventoryPart>();
		for (const part of ownedInventory.parts) {
			checkpoint();
			if (inventoryParts.has(part.canonicalUri) || part.id !== part.canonicalUri) {
				throw new ParadisOfficePackageError('unsafe');
			}
			inventoryParts.set(part.canonicalUri, part);
		}
		const reader = await indexWordArchive(archive, ownedInventory, profile, token, checkpoint);

		// Authority is intentionally staged. No Word Story target is read before both root and main
		// relationship documents have themselves been all-byte verified.
		const contentTypesPart = await readVerifiedXmlPart(archive, reader, contentTypesPartUri, profile, token, checkpoint);
		const contentTypes = parseContentTypes(contentTypesPart.document, checkpoint);
		const rootRelationshipsUri = relationshipPartUri(undefined);
		validateContentType(contentTypes, inventoryParts, rootRelationshipsUri, relationshipContentTypes);
		const rootRelationshipsPart = await readVerifiedXmlPart(archive, reader, rootRelationshipsUri, profile, token, checkpoint);
		const rootRelationships = parseRelationshipPart(rootRelationshipsPart.document, undefined, limits, checkpoint);
		validateRelationshipAuthority(rootRelationships, undefined, ownedInventory, reader.parts, checkpoint);
		const mainRelationship = uniqueRelationship(rootRelationships, officeDocumentRelationshipTypes);
		const documentUri = internalTarget(mainRelationship);
		validateContentType(contentTypes, inventoryParts, documentUri, mainContentTypesForFormat(ownedInventory.format));
		const documentPart = await readVerifiedXmlPart(archive, reader, documentUri, profile, token, checkpoint);

		const documentRelationshipsUri = relationshipPartUri(documentUri);
		validateContentType(contentTypes, inventoryParts, documentRelationshipsUri, relationshipContentTypes);
		const documentRelationshipsPart = await readVerifiedXmlPart(archive, reader, documentRelationshipsUri, profile, token, checkpoint);
		const documentRelationships = parseRelationshipPart(documentRelationshipsPart.document, documentUri, limits, checkpoint);
		validateRelationshipAuthority(documentRelationships, documentUri, ownedInventory, reader.parts, checkpoint);
		const relationshipsById = new Map(documentRelationships.map(relationship => [relationship.id, relationship]));
		const counters: MutableCounters = { nodes: 0, unknownBlocks: 0, unresolvedRelationships: 0, textCharacters: 0 };
		const mainFactory = new WordNodeFactory(documentPart, counters, limits, checkpoint);
		const mainState: NodeParseState = { factory: mainFactory, relationships: relationshipsById, inventoryParts, counters, limits, checkpoint };
		const documentRoot = wordRoot(documentPart.document, 'document');
		const body = uniqueWordChild(documentRoot, 'body');
		if (!body) {
			throw new ParadisOfficePackageError('malformed');
		}

		const rawSectionReferences = collectSectionReferences(body, relationshipsById, documentPart, checkpoint);
		const requestedStoryParts = new Map<string, ReadonlySet<string>>();
		for (const reference of rawSectionReferences) {
			const accepted = reference.kind === 'header' ? headerContentTypes : footerContentTypes;
			requestedStoryParts.set(reference.targetPartUri, accepted);
		}
		for (const [types, accepted] of [
			[footnotesRelationshipTypes, footnotesContentTypes],
			[endnotesRelationshipTypes, endnotesContentTypes],
			[commentsRelationshipTypes, commentsContentTypes],
		] as const) {
			const relationship = optionalUniqueRelationship(documentRelationships, types);
			if (relationship) {
				requestedStoryParts.set(internalTarget(relationship), accepted);
			}
		}
		for (const [partUri, accepted] of requestedStoryParts) {
			checkpoint();
			validateContentType(contentTypes, inventoryParts, partUri, accepted);
			await readVerifiedXmlPart(archive, reader, partUri, profile, token, checkpoint);
		}
		const storyRelationships = new Map<string, ReadonlyMap<string, RawRelationship>>();
		for (const partUri of requestedStoryParts.keys()) {
			checkpoint();
			const relationshipUri = relationshipPartUri(partUri);
			if (!reader.parts.has(relationshipUri)) {
				for (const relationship of ownedInventory.relationships) {
					checkpoint();
					if (relationship.sourcePartId === partUri) {
						throw new ParadisOfficePackageError('unsafe');
					}
				}
				storyRelationships.set(partUri, new Map());
				continue;
			}
			validateContentType(contentTypes, inventoryParts, relationshipUri, relationshipContentTypes);
			const relationshipPart = await readVerifiedXmlPart(archive, reader, relationshipUri, profile, token, checkpoint);
			const relationships = parseRelationshipPart(relationshipPart.document, partUri, limits, checkpoint);
			validateRelationshipAuthority(relationships, partUri, ownedInventory, reader.parts, checkpoint);
			storyRelationships.set(partUri, new Map(relationships.map(relationship => [relationship.id, relationship])));
		}

		const bodyStory = createBodyStory(documentPart, body, mainState);
		const stories: ParadisWordStory[] = [bodyStory];
		const headerFooterStories = createHeaderFooterStories(rawSectionReferences, reader, inventoryParts, storyRelationships, limits, counters, checkpoint);
		stories.push(...headerFooterStories.stories);
		const noteStories = createNoteStories(documentRelationships, reader, inventoryParts, storyRelationships, limits, counters, checkpoint);
		stories.push(...noteStories);
		const commentStories = createCommentStories(documentRelationships, reader, inventoryParts, storyRelationships, limits, counters, checkpoint);
		stories.push(...commentStories);
		if (stories.length > limits.stories) {
			throw new ParadisOfficePackageError('limitExceeded');
		}

		const storiesByPart = new Map<string, ParadisWordStory>();
		for (const story of stories) {
			if (story.address.kind === 'header' || story.address.kind === 'footer') {
				storiesByPart.set(story.address.partUri, story);
			}
		}
		const storyReferences = materializeStoryReferences(rawSectionReferences, storiesByPart, documentPart);

		const textboxDescriptors: TextboxDescriptor[] = [];
		collectTextboxDescriptors(documentPart, bodyStory.id, body, [], textboxDescriptors, checkpoint);
		for (const story of [...headerFooterStories.stories, ...noteStories, ...commentStories]) {
			const part = requiredParsedPart(reader, story.address.partUri);
			collectTextboxDescriptors(part, story.id, storyRootContainer(part, story.address), [], textboxDescriptors, checkpoint);
		}
		for (const descriptor of textboxDescriptors) {
			checkpoint();
			if (stories.length >= limits.stories) {
				throw new ParadisOfficePackageError('limitExceeded');
			}
			stories.push(createTextboxStory(descriptor, inventoryParts, storyRelationships, limits, counters, checkpoint, stories.length));
		}

		checkpoint(true);
		const completeness: ParadisWordCompleteness = {
			expectedParts: reader.parsed.size,
			visitedParts: reader.parsed.size,
			parsedParts: reader.parsed.size,
			stories: stories.length,
			nodes: counters.nodes,
			unknownBlocks: counters.unknownBlocks,
			unresolvedRelationships: counters.unresolvedRelationships,
			terminal: true,
		};
		const result: ParadisWordDocument = {
			documentSource: partRootSource(documentPart),
			contentTypesSource: partRootSource(contentTypesPart),
			rootRelationshipsSource: partRootSource(rootRelationshipsPart),
			documentRelationshipsSource: partRootSource(documentRelationshipsPart),
			stories: Object.freeze(stories),
			storyReferences: Object.freeze(storyReferences),
			completeness: Object.freeze(completeness),
		};
		try {
			disposeAttempted = true;
			archive.dispose();
		} catch {
			throw new ParadisOfficePackageError('invalid');
		}
		return result;
	} catch (error) {
		throw sanitizeWordPackageError(error, 'malformed');
	} finally {
		if (!disposeAttempted) {
			try {
				disposeAttempted = true;
				archive.dispose();
			} catch {
				// Cleanup never replaces the already sanitized package failure.
			}
		}
	}
}

export function resolveWordSemanticLimits(overrides: Partial<ParadisWordSemanticLimits> | undefined): ParadisWordSemanticLimits {
	return snapshotLimits(overrides);
}

function monotonicTime(now: () => number): number {
	let value: number;
	try {
		value = now();
	} catch {
		throw new ParadisOfficePackageError('invalid');
	}
	if (!Number.isFinite(value) || value < 0) {
		throw new ParadisOfficePackageError('invalid');
	}
	return value;
}

function validateInventory(inventory: ParadisOfficeInventory, archive: IParadisOfficeArchive, profile: ParadisOfficeBudgetProfile): void {
	if (!['docx', 'docm', 'dotx', 'dotm'].includes(inventory.format) || inventory.container !== 'opc') {
		throw new ParadisOfficePackageError('invalid');
	}
	if (inventory.budgetProfile !== profile.kind || inventory.budgetUsage.compressedInputBytes !== archive.containerByteLength
		|| archive.containerByteLength > profile.compressedInputBytes || inventory.parts.length > profile.entryCount) {
		throw new ParadisOfficePackageError('unsafe');
	}
}

function mainContentTypesForFormat(format: ParadisOfficeInventory['format']): ReadonlySet<string> {
	if (format !== 'docx' && format !== 'docm' && format !== 'dotx' && format !== 'dotm') {
		throw new ParadisOfficePackageError('invalid');
	}
	return mainContentTypes[format];
}

async function indexWordArchive(
	archive: IParadisOfficeArchive,
	inventory: ParadisOfficeInventory,
	profile: ParadisOfficeBudgetProfile,
	token: CancellationToken | undefined,
	checkpoint: (force?: boolean) => void,
): Promise<SemanticArchiveReader> {
	const inventoryParts = new Map(inventory.parts.map(part => [part.canonicalUri, part]));
	const parts = new Map<string, IndexedArchivePart>();
	const seen = new Set<string>();
	let entries = 0;
	let aggregateCompressedBytes = 0;
	for await (const entry of archive.entries(token)) {
		checkpoint();
		if (++entries > profile.entryCount) {
			throw new ParadisOfficePackageError('limitExceeded');
		}
		validateEntryMetadata(entry);
		aggregateCompressedBytes = safeAdd(aggregateCompressedBytes, entry.compressedBytes);
		if (aggregateCompressedBytes > archive.containerByteLength) {
			throw new ParadisOfficePackageError('zipBomb');
		}
		const rawName = entry.directory && entry.name.endsWith('/') ? entry.name.slice(0, -1) : entry.name;
		const uri = canonicalizeParadisOfficeArchiveName(rawName);
		if (seen.has(uri)) {
			throw new ParadisOfficePackageError('unsafe');
		}
		seen.add(uri);
		if (entry.directory) {
			continue;
		}
		if (entry.encrypted || entry.symlink) {
			throw new ParadisOfficePackageError('unsafe');
		}
		const inventoryPart = inventoryParts.get(uri);
		if (!inventoryPart || inventoryPart.compressedBytes !== entry.compressedBytes || inventoryPart.expandedBytes !== entry.declaredExpandedBytes) {
			throw new ParadisOfficePackageError('unsafe');
		}
		parts.set(uri, { entry, inventoryPart });
	}
	if (parts.size !== inventory.parts.length) {
		throw new ParadisOfficePackageError('unsafe');
	}
	return { parts, parsed: new Map(), readCompressedBytes: 0, readExpandedBytes: 0 };
}

async function readVerifiedXmlPart(
	archive: IParadisOfficeArchive,
	reader: SemanticArchiveReader,
	partUri: string,
	profile: ParadisOfficeBudgetProfile,
	token: CancellationToken | undefined,
	checkpoint: (force?: boolean) => void,
): Promise<ParsedXmlPart> {
	const existing = reader.parsed.get(partUri);
	if (existing) {
		return existing;
	}
	const indexed = reader.parts.get(partUri);
	if (!indexed) {
		throw new ParadisOfficePackageError('unsafe');
	}
	const expected = allByteFingerprint(indexed.inventoryPart);
	reader.readCompressedBytes = safeAdd(reader.readCompressedBytes, indexed.entry.compressedBytes);
	const bytes = await readPartBytes(archive, reader, indexed.entry, profile, token, checkpoint);
	const fingerprint = await archive.hash(bytes.slice());
	if (!sameFingerprint(expected, fingerprint)) {
		throw new ParadisOfficePackageError('unsafe');
	}
	const document = await archive.parseXml(decodeXml(bytes), {
		depth: profile.xmlDepth,
		nodes: profile.xmlNodesPerPart,
		attributeLength: profile.attributeLength,
		characters: profile.xmlPartBytes,
	}, token, () => checkpoint());
	const parsed = { uri: partUri, document, fingerprint };
	reader.parsed.set(partUri, parsed);
	checkpoint(true);
	return parsed;
}

async function readPartBytes(
	archive: IParadisOfficeArchive,
	reader: SemanticArchiveReader,
	entry: ParadisOfficeArchiveEntry,
	profile: ParadisOfficeBudgetProfile,
	token: CancellationToken | undefined,
	checkpoint: (force?: boolean) => void,
): Promise<Uint8Array> {
	const chunks: Uint8Array[] = [];
	let length = 0;
	for await (const chunk of archive.read(entry, token)) {
		checkpoint();
		if (!(chunk instanceof Uint8Array)) {
			throw new ParadisOfficePackageError('invalid');
		}
		length = safeAdd(length, chunk.byteLength);
		reader.readExpandedBytes = safeAdd(reader.readExpandedBytes, chunk.byteLength);
		if (length > profile.xmlPartBytes || reader.readExpandedBytes > profile.expandedBytes) {
			throw new ParadisOfficePackageError('limitExceeded');
		}
		if ((entry.compressedBytes === 0 ? length > 0 : length > entry.compressedBytes * profile.compressionRatio)
			|| (reader.readCompressedBytes === 0 ? reader.readExpandedBytes > 0 : reader.readExpandedBytes > reader.readCompressedBytes * profile.compressionRatio)) {
			throw new ParadisOfficePackageError('zipBomb');
		}
		chunks.push(chunk.slice());
	}
	if (length !== entry.declaredExpandedBytes) {
		throw new ParadisOfficePackageError('unsafe');
	}
	const bytes = new Uint8Array(length);
	let offset = 0;
	for (const chunk of chunks) {
		checkpoint();
		bytes.set(chunk, offset);
		offset += chunk.byteLength;
	}
	return bytes;
}

function validateEntryMetadata(entry: ParadisOfficeArchiveEntry): void {
	if (!Number.isSafeInteger(entry.compressedBytes) || entry.compressedBytes < 0 || !Number.isSafeInteger(entry.declaredExpandedBytes) || entry.declaredExpandedBytes < 0) {
		throw new ParadisOfficePackageError('invalid');
	}
}

function safeAdd(left: number, right: number): number {
	const result = left + right;
	if (!Number.isSafeInteger(result) || result < 0) {
		throw new ParadisOfficePackageError('limitExceeded');
	}
	return result;
}

function allByteFingerprint(part: ParadisOfficeInventoryPart): ParadisOfficeFingerprint {
	if (part.coverage === 'parsed' && part.hashCompleteness === 'allBytes') {
		return part.rawHash;
	}
	if (part.coverage === 'completeOpaque' && part.hashCompleteness === 'allBytes') {
		return part.fingerprint;
	}
	throw new ParadisOfficePackageError('unsafe');
}

function sameFingerprint(left: ParadisOfficeFingerprint, right: ParadisOfficeFingerprint): boolean {
	return left.algorithm === right.algorithm && left.value === right.value && left.byteLength === right.byteLength;
}

function decodeXml(bytes: Uint8Array): string {
	try {
		return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
	} catch {
		throw new ParadisOfficePackageError('malformed');
	}
}

function parseContentTypes(document: ParadisOfficeXmlDocument, checkpoint: (force?: boolean) => void): ContentTypesAuthority {
	const root = document.root;
	if (root.local !== 'Types' || !packageContentTypeNamespaces.has(root.uri)) {
		throw new ParadisOfficePackageError('malformed');
	}
	const defaults = new Map<string, string>();
	const overrides = new Map<string, string>();
	for (const node of elementChildren(root)) {
		checkpoint();
		if (node.uri !== root.uri || (node.local !== 'Default' && node.local !== 'Override')) {
			throw new ParadisOfficePackageError('malformed');
		}
		const contentType = requiredAttribute(node, '', 'ContentType');
		if (node.local === 'Default') {
			const extension = requiredAttribute(node, '', 'Extension').toLowerCase();
			if (!extension || defaults.has(extension)) {
				throw new ParadisOfficePackageError('unsafe');
			}
			defaults.set(extension, contentType);
		} else {
			const partName = requiredAttribute(node, '', 'PartName');
			if (!partName.startsWith('/')) {
				throw new ParadisOfficePackageError('malformed');
			}
			const canonical = canonicalizeParadisOfficeArchiveName(partName.slice(1));
			if (overrides.has(canonical)) {
				throw new ParadisOfficePackageError('unsafe');
			}
			overrides.set(canonical, contentType);
		}
	}
	return { defaults, overrides };
}

function validateContentType(
	authority: ContentTypesAuthority,
	inventoryParts: ReadonlyMap<string, ParadisOfficeInventoryPart>,
	partUri: string,
	accepted: ReadonlySet<string>,
): void {
	const part = inventoryParts.get(partUri);
	const dot = partUri.lastIndexOf('.');
	const slash = partUri.lastIndexOf('/');
	const extension = dot > slash ? partUri.slice(dot + 1).toLowerCase() : '';
	const rawContentType = authority.overrides.get(partUri) ?? authority.defaults.get(extension);
	if (!part || !rawContentType || rawContentType !== part.contentType || !accepted.has(rawContentType)) {
		throw new ParadisOfficePackageError('unsafe');
	}
}

function parseRelationshipPart(
	document: ParadisOfficeXmlDocument,
	sourcePartUri: string | undefined,
	limits: ParadisWordSemanticLimits,
	checkpoint: (force?: boolean) => void,
): readonly RawRelationship[] {
	const root = document.root;
	if (root.local !== 'Relationships' || !packageRelationshipNamespaces.has(root.uri)) {
		throw new ParadisOfficePackageError('malformed');
	}
	const result: RawRelationship[] = [];
	const ids = new Set<string>();
	for (const node of elementChildren(root)) {
		checkpoint();
		if (node.local !== 'Relationship' || node.uri !== root.uri || result.length >= limits.relationships) {
			throw new ParadisOfficePackageError(result.length >= limits.relationships ? 'limitExceeded' : 'malformed');
		}
		const id = requiredAttribute(node, '', 'Id');
		const type = requiredAttribute(node, '', 'Type');
		const rawTarget = requiredAttribute(node, '', 'Target');
		const targetModeValue = attribute(node, '', 'TargetMode');
		if (targetModeValue !== undefined && targetModeValue !== 'External') {
			throw new ParadisOfficePackageError('malformed');
		}
		if (ids.has(id)) {
			throw new ParadisOfficePackageError('unsafe');
		}
		ids.add(id);
		const targetMode = targetModeValue === 'External' ? 'external' : 'internal';
		result.push({ id, type, targetMode, target: targetMode === 'external' ? rawTarget : resolveRelationshipTarget(sourcePartUri, rawTarget) });
	}
	return result;
}

function validateRelationshipAuthority(
	actual: readonly RawRelationship[],
	sourcePartUri: string | undefined,
	inventory: ParadisOfficeInventory,
	parts: ReadonlyMap<string, IndexedArchivePart>,
	checkpoint: (force?: boolean) => void,
): void {
	const expected = inventory.relationships.filter(relationship => relationship.sourcePartId === sourcePartUri);
	if (actual.length !== expected.length) {
		throw new ParadisOfficePackageError('unsafe');
	}
	const actualById = new Map(actual.map(relationship => [relationship.id, relationship]));
	for (const relationship of expected) {
		checkpoint();
		const raw = actualById.get(relationship.id);
		if (!raw || raw.type !== relationship.type || raw.target !== relationship.target || raw.targetMode !== relationship.targetMode || relationship.cyclic
			|| relationship.missing !== (raw.targetMode === 'internal' && !parts.has(raw.target))) {
			throw new ParadisOfficePackageError('unsafe');
		}
	}
}

function uniqueRelationship(relationships: readonly RawRelationship[], types: ReadonlySet<string>): RawRelationship {
	const matches = relationships.filter(relationship => types.has(relationship.type));
	if (matches.length !== 1) {
		throw new ParadisOfficePackageError('unsafe');
	}
	return matches[0];
}

function optionalUniqueRelationship(relationships: readonly RawRelationship[], types: ReadonlySet<string>): RawRelationship | undefined {
	const matches = relationships.filter(relationship => types.has(relationship.type));
	if (matches.length > 1) {
		throw new ParadisOfficePackageError('unsafe');
	}
	return matches[0];
}

function internalTarget(relationship: RawRelationship): string {
	if (relationship.targetMode !== 'internal' || !relationship.target.startsWith('/')) {
		throw new ParadisOfficePackageError('unsafe');
	}
	return relationship.target;
}

function relationshipPartUri(sourcePartUri: string | undefined): string {
	if (!sourcePartUri) {
		return '/_rels/.rels';
	}
	const separator = sourcePartUri.lastIndexOf('/');
	if (separator < 0 || separator === sourcePartUri.length - 1) {
		throw new ParadisOfficePackageError('unsafe');
	}
	return `${sourcePartUri.slice(0, separator)}/_rels/${sourcePartUri.slice(separator + 1)}.rels`;
}

function resolveRelationshipTarget(sourcePartUri: string | undefined, target: string): string {
	if (!target || target.startsWith('/') || target.includes('\\') || target.includes('%')) {
		throw new ParadisOfficePackageError('malformed');
	}
	const segments = sourcePartUri ? sourcePartUri.slice(1).split('/').slice(0, -1) : [];
	for (const segment of target.split('/')) {
		if (!segment || segment === '.') {
			continue;
		}
		if (segment === '..') {
			if (segments.length === 0) {
				throw new ParadisOfficePackageError('malformed');
			}
			segments.pop();
		} else {
			segments.push(segment);
		}
	}
	return `/${segments.join('/')}`;
}

class WordNodeFactory {
	private readonly ordinals = new Map<ParadisWordNodeKind, number>();

	constructor(
		readonly part: ParsedXmlPart,
		private readonly counters: MutableCounters,
		private readonly limits: ParadisWordSemanticLimits,
		private readonly checkpoint: (force?: boolean) => void,
	) { }

	base(kind: ParadisWordNodeKind, semanticPath: readonly number[], seed: string): { readonly id: string; readonly kind: ParadisWordNodeKind; readonly source: ParadisWordSourceRef; readonly anchor: ParadisOfficeRenderAnchorKey } {
		this.checkpoint();
		if (++this.counters.nodes > this.limits.nodes) {
			throw new ParadisOfficePackageError('limitExceeded');
		}
		const ordinal = this.ordinals.get(kind) ?? 0;
		this.ordinals.set(kind, ordinal + 1);
		const path = Object.freeze([...semanticPath]);
		const fingerprint = semanticFingerprint(seed);
		const source: ParadisWordSourceRef = Object.freeze({
			partUri: this.part.uri,
			semanticPath: path,
			kind,
			ordinal,
			fingerprint,
			partFingerprint: this.part.fingerprint,
		});
		const anchor: ParadisOfficeRenderAnchorKey = Object.freeze({ partUri: this.part.uri, semanticPath: path, kind, ordinal, fingerprint });
		return Object.freeze({ id: semanticId(this.part.uri, path, kind, ordinal, fingerprint), kind, source, anchor });
	}

	text(value: string): void {
		this.counters.textCharacters = safeAdd(this.counters.textCharacters, value.length);
		if (this.counters.textCharacters > this.limits.textCharacters) {
			throw new ParadisOfficePackageError('limitExceeded');
		}
	}
}

function semanticFingerprint(seed: string): string {
	let hash = 0x811c9dc5;
	for (let index = 0; index < seed.length; index++) {
		hash ^= seed.charCodeAt(index);
		hash = Math.imul(hash, 0x01000193) >>> 0;
	}
	return `fnv1a32:${hash.toString(16).padStart(8, '0')}`;
}

function semanticId(partUri: string, path: readonly number[], kind: string, ordinal: number, fingerprint: string): string {
	return `word:${encodeURIComponent(partUri)}:${path.join('.')}:${kind}:${ordinal}:${fingerprint}`;
}

function partRootSource(part: ParsedXmlPart): ParadisWordSourceRef {
	const fingerprint = `sha256:${part.fingerprint.value}`;
	return Object.freeze({ partUri: part.uri, semanticPath: Object.freeze([]), kind: 'story', ordinal: 0, fingerprint, partFingerprint: part.fingerprint });
}

function createBodyStory(part: ParsedXmlPart, body: XmlElement, state: NodeParseState): ParadisWordStory {
	const nodes = parseBodySections(body, state);
	return createStory(part, 'body', 0, nodes);
}

function createStory(
	part: ParsedXmlPart,
	kind: ParadisWordStoryKind,
	ordinal: number,
	nodes: readonly ParadisWordNode[],
	metadata: {
		readonly roles?: readonly ParadisWordHeaderFooterRole[];
		readonly noteId?: string;
		readonly commentId?: string;
		readonly parentStoryId?: string;
		readonly parentNodeId?: string;
		readonly textboxGeometry?: ParadisWordTextboxGeometry;
		readonly author?: string;
		readonly date?: string;
	} = {},
): ParadisWordStory {
	const text = storyText(nodes);
	const fingerprint = semanticFingerprint(`${kind}|${part.uri}|${metadata.noteId ?? ''}|${metadata.commentId ?? ''}|${metadata.parentStoryId ?? ''}|${text}`);
	const source: ParadisWordSourceRef = Object.freeze({
		partUri: part.uri,
		semanticPath: Object.freeze([]),
		kind: 'story',
		ordinal,
		fingerprint,
		partFingerprint: part.fingerprint,
	});
	const anchor: ParadisOfficeRenderAnchorKey = Object.freeze({ partUri: part.uri, semanticPath: source.semanticPath, kind: 'story', ordinal, fingerprint });
	const id = semanticId(part.uri, source.semanticPath, 'story', ordinal, fingerprint);
	return Object.freeze({
		id,
		address: Object.freeze({
			kind,
			partUri: part.uri,
			ordinal,
			...(metadata.roles ? { roles: Object.freeze([...metadata.roles]) } : {}),
			...(metadata.noteId !== undefined ? { noteId: metadata.noteId } : {}),
			...(metadata.commentId !== undefined ? { commentId: metadata.commentId } : {}),
			...(metadata.parentStoryId !== undefined ? { parentStoryId: metadata.parentStoryId } : {}),
			...(metadata.parentNodeId !== undefined ? { parentNodeId: metadata.parentNodeId } : {}),
			...(metadata.textboxGeometry !== undefined ? { textboxGeometry: metadata.textboxGeometry } : {}),
		}),
		source,
		anchor,
		nodes: Object.freeze([...nodes]),
		text,
		...(metadata.author !== undefined ? { author: metadata.author } : {}),
		...(metadata.date !== undefined ? { date: metadata.date } : {}),
	});
}

function parseBodySections(body: XmlElement, state: NodeParseState): readonly ParadisWordNode[] {
	const sections: ParadisWordSectionNode[] = [];
	let sectionChildren: ParadisWordNode[] = [];
	let sectionOrdinal = 0;
	let blockOrdinal = 0;
	for (const child of elementChildren(body)) {
		state.checkpoint();
		if (isWordElement(child, 'sectPr')) {
			sections.push(createSection(state.factory, sectionOrdinal++, sectionChildren));
			sectionChildren = [];
			blockOrdinal = 0;
			continue;
		}
		const block = parseBlockElement(child, [sectionOrdinal, blockOrdinal++], state);
		if (block) {
			sectionChildren.push(block);
		}
		if (isWordElement(child, 'p') && paragraphSectionProperties(child)) {
			sections.push(createSection(state.factory, sectionOrdinal++, sectionChildren));
			sectionChildren = [];
			blockOrdinal = 0;
		}
	}
	if (sectionChildren.length > 0 || sections.length === 0) {
		sections.push(createSection(state.factory, sectionOrdinal, sectionChildren));
	}
	return Object.freeze(sections);
}

function createSection(factory: WordNodeFactory, sectionOrdinal: number, children: readonly ParadisWordNode[]): ParadisWordSectionNode {
	const base = factory.base('section', [sectionOrdinal], `section|${sectionOrdinal}`);
	return Object.freeze({ ...base, kind: 'section', sectionOrdinal, children: Object.freeze([...children]) });
}

function parseBlockChildren(element: XmlElement, basePath: readonly number[], state: NodeParseState): readonly ParadisWordNode[] {
	const result: ParadisWordNode[] = [];
	let ordinal = 0;
	for (const child of elementChildren(element)) {
		state.checkpoint();
		const node = parseBlockElement(child, [...basePath, ordinal++], state);
		if (node) {
			result.push(node);
		}
	}
	return Object.freeze(result);
}

function parseBlockElement(element: XmlElement, path: readonly number[], state: NodeParseState): ParadisWordNode | undefined {
	if (isWordElement(element, 'p')) {
		return parseParagraph(element, path, state);
	}
	if (isWordElement(element, 'tbl')) {
		return parseTable(element, path, state);
	}
	if (isWordElement(element, 'sdt')) {
		return parseContentControl(element, path, state, true);
	}
	if (isWordElement(element, 'altChunk')) {
		return parseAltChunk(element, path, state);
	}
	if (isWordElement(element, 'sectPr')) {
		return undefined;
	}
	return parseUnknownBlock(element, path, state);
}

function parseParagraph(element: XmlElement, path: readonly number[], state: NodeParseState): ParadisWordParagraphNode {
	const seed = semanticElementSignature(element, state.relationships);
	const base = state.factory.base('paragraph', path, seed);
	const children = parseParagraphInlineChildren(element, path, state);
	return Object.freeze({ ...base, kind: 'paragraph', children });
}

function parseParagraphInlineChildren(element: XmlElement, path: readonly number[], state: NodeParseState): readonly ParadisWordNode[] {
	return parseInlineChildren(elementChildren(element).filter(child => !isWordElement(child, 'pPr')), path, state);
}

function parseInlineElement(element: XmlElement, path: readonly number[], state: NodeParseState): ParadisWordNode | undefined {
	if (isWordElement(element, 'bookmarkStart') || isWordElement(element, 'bookmarkEnd')) {
		const boundary = element.local === 'bookmarkStart' ? 'start' : 'end';
		const bookmarkId = requiredAttribute(element, wordNamespace(element), 'id');
		const base = state.factory.base('bookmark', path, `bookmark|${boundary}|${bookmarkId}|${attribute(element, wordNamespace(element), 'name') ?? ''}`);
		const node: ParadisWordBookmarkNode = { ...base, kind: 'bookmark', boundary, bookmarkId, ...(attribute(element, wordNamespace(element), 'name') !== undefined ? { name: attribute(element, wordNamespace(element), 'name') } : {}) };
		return Object.freeze(node);
	}
	if (isWordElement(element, 'hyperlink')) {
		return parseHyperlink(element, path, state);
	}
	if (isWordElement(element, 'fldSimple')) {
		return parseSimpleField(element, path, state);
	}
	if (isMathElement(element, 'oMath') || isMathElement(element, 'oMathPara')) {
		const text = directDescendantText(element);
		state.factory.text(text);
		const base = state.factory.base('omml', path, `omml|${semanticElementSignature(element, state.relationships)}`);
		const node: ParadisWordOmmlNode = { ...base, kind: 'omml', text };
		return Object.freeze(node);
	}
	if (isRevisionElement(element)) {
		return parseRevision(element, path, state);
	}
	if (isWordElement(element, 'commentRangeStart') || isWordElement(element, 'commentRangeEnd')) {
		const boundary = element.local === 'commentRangeStart' ? 'start' : 'end';
		return createCommentReference(element, path, state, boundary);
	}
	if (isWordElement(element, 'sdt')) {
		return parseContentControl(element, path, state, false);
	}
	return parseUnknownBlock(element, path, state);
}

function parseRun(run: XmlElement, path: readonly number[], state: NodeParseState): readonly ParadisWordNode[] {
	const runChildren = elementChildren(run).filter(child => !isWordElement(child, 'rPr'));
	const result: ParadisWordNode[] = [];
	let ordinal = 0;
	for (const child of runChildren) {
		state.checkpoint();
		const childPath = [...path, ordinal++];
		result.push(...parseRunChild(child, childPath, state));
	}
	return Object.freeze(result);
}

function parseRunChild(child: XmlElement, path: readonly number[], state: NodeParseState): readonly ParadisWordNode[] {
	if (isWordElement(child, 't') || isWordElement(child, 'delText')) {
		const text = directText(child);
		state.factory.text(text);
		const base = state.factory.base('text', path, `text|${child.local}|${text}`);
		const node: ParadisWordTextNode = { ...base, kind: 'text', text, ...(child.local === 'delText' ? { deleted: true } : {}) };
		return Object.freeze([Object.freeze(node)]);
	} else if (isWordElement(child, 'tab')) {
		return Object.freeze([Object.freeze({ ...state.factory.base('tab', path, 'tab'), kind: 'tab' })]);
	} else if (isWordElement(child, 'br') || isWordElement(child, 'cr')) {
		const breakType = attribute(child, wordNamespace(child), 'type') ?? 'line';
		const node: ParadisWordBreakNode = { ...state.factory.base('break', path, `break|${breakType}`), kind: 'break', breakType };
		return Object.freeze([Object.freeze(node)]);
	} else if (isWordElement(child, 'sym')) {
		const font = attribute(child, wordNamespace(child), 'font');
		const character = attribute(child, wordNamespace(child), 'char');
		const node: ParadisWordSymbolNode = { ...state.factory.base('symbol', path, `symbol|${font ?? ''}|${character ?? ''}`), kind: 'symbol', ...(font !== undefined ? { font } : {}), ...(character !== undefined ? { character } : {}) };
		return Object.freeze([Object.freeze(node)]);
	} else if (isWordElement(child, 'drawing')) {
		return Object.freeze([parseDrawing(child, path, state)]);
	} else if (isWordElement(child, 'pict')) {
		return parseVmlImages(child, path, state);
	} else if (isWordElement(child, 'footnoteReference') || isWordElement(child, 'endnoteReference')) {
		const noteKind = child.local === 'footnoteReference' ? 'footnote' : 'endnote';
		const noteId = requiredAttribute(child, wordNamespace(child), 'id');
		const node: ParadisWordNoteReferenceNode = { ...state.factory.base('noteReference', path, `noteReference|${noteKind}|${noteId}`), kind: 'noteReference', noteKind, noteId };
		return Object.freeze([Object.freeze(node)]);
	} else if (isWordElement(child, 'commentReference')) {
		return Object.freeze([createCommentReference(child, path, state, 'reference')]);
	} else if (!isWordElement(child, 'instrText') && !isWordElement(child, 'fldChar')) {
		return Object.freeze([parseUnknownBlock(child, path, state)]);
	}
	return Object.freeze([]);
}

function parseVmlImages(element: XmlElement, path: readonly number[], state: NodeParseState): readonly ParadisWordNode[] {
	const images: ParadisWordNode[] = [];
	let ordinal = 0;
	walkElements(element, candidate => {
		if (!vmlNamespaces.has(candidate.uri) || candidate.local !== 'imagedata') {
			return;
		}
		state.checkpoint();
		const relationshipId = relationshipAttribute(candidate, 'id');
		const relationship = relationshipId ? state.relationships.get(relationshipId) : undefined;
		if (!relationship || !imageRelationshipTypes.has(relationship.type)) {
			state.counters.unresolvedRelationships++;
		}
		const targetPartUri = relationship?.targetMode === 'internal' ? relationship.target : undefined;
		const external = relationship?.targetMode === 'external';
		const base = state.factory.base('image', [...path, ordinal++], `image|${relationship?.type ?? ''}|${relationship?.target ?? ''}|${external}`);
		const image: ParadisWordImageNode = { ...base, kind: 'image', ...(targetPartUri !== undefined ? { targetPartUri } : {}), external };
		images.push(Object.freeze(image));
	});
	return images.length > 0 ? Object.freeze(images) : Object.freeze([parseUnknownBlock(element, path, state)]);
}

function parseHyperlink(element: XmlElement, path: readonly number[], state: NodeParseState): ParadisWordHyperlinkNode {
	const relationshipId = relationshipAttribute(element, 'id');
	const relationship = relationshipId ? state.relationships.get(relationshipId) : undefined;
	if (relationshipId && (!relationship || !hyperlinkRelationshipTypes.has(relationship.type))) {
		state.counters.unresolvedRelationships++;
	}
	const anchorName = attribute(element, wordNamespace(element), 'anchor');
	const external = relationship?.targetMode === 'external';
	const seed = `hyperlink|${anchorName ?? ''}|${relationship?.type ?? ''}|${relationship?.target ?? ''}|${external}`;
	const base = state.factory.base('hyperlink', path, seed);
	const inline = parseInlineContainer(element, [...path, 0], state);
	const paragraph = createSyntheticParagraph(state.factory, [...path, 0], inline, `hyperlink|${seed}`);
	return Object.freeze({ ...base, kind: 'hyperlink', ...(anchorName !== undefined ? { anchorName } : {}), external, children: Object.freeze([paragraph]) });
}

function parseSimpleField(element: XmlElement, path: readonly number[], state: NodeParseState): ParadisWordFieldNode {
	const instruction = attribute(element, wordNamespace(element), 'instr') ?? '';
	const dirty = attribute(element, wordNamespace(element), 'dirty');
	const locked = attribute(element, wordNamespace(element), 'fldLock');
	const inline = parseInlineContainer(element, [...path, 0], state);
	const paragraph = createSyntheticParagraph(state.factory, [...path, 0], inline, `fieldResult|${storyText(inline)}`);
	const savedResult = storyText(inline);
	const base = state.factory.base('field', path, `field|simple|${instruction}|${savedResult}|${dirty ?? ''}|${locked ?? ''}`);
	return Object.freeze({ ...base, kind: 'field', fieldKind: 'simple', instruction, savedResult, ...(dirty !== undefined ? { dirty } : {}), ...(locked !== undefined ? { locked } : {}), children: Object.freeze([paragraph]) });
}

function parseComplexField(runs: readonly XmlElement[], path: readonly number[], state: NodeParseState): ParadisWordFieldNode {
	let instruction = '';
	let inResult = false;
	let depth = 0;
	const resultChildren: ParadisWordNode[] = [];
	for (let runIndex = 0; runIndex < runs.length; runIndex++) {
		const children = elementChildren(runs[runIndex]).filter(child => !isWordElement(child, 'rPr'));
		for (let childIndex = 0; childIndex < children.length; childIndex++) {
			const child = children[childIndex];
			if (isWordElement(child, 'fldChar')) {
				const type = attribute(child, wordNamespace(child), 'fldCharType');
				if (type === 'begin') {
					depth++;
				} else if (type === 'separate' && depth === 1) {
					inResult = true;
				} else if (type === 'end') {
					depth--;
					if (depth === 0) {
						inResult = false;
					}
				}
			} else if (isWordElement(child, 'instrText') && depth === 1 && !inResult) {
				instruction += directText(child);
			} else if (inResult) {
				resultChildren.push(...parseRunChild(child, [...path.slice(0, -1), path[path.length - 1] + runIndex, childIndex], state));
			}
		}
	}
	const begin = elementChildren(runs[0]).find(child => isWordElement(child, 'fldChar') && attribute(child, wordNamespace(child), 'fldCharType') === 'begin');
	const dirty = begin ? attribute(begin, wordNamespace(begin), 'dirty') : undefined;
	const locked = begin ? attribute(begin, wordNamespace(begin), 'fldLock') : undefined;
	const savedResult = storyText(resultChildren);
	const signature = runs.map(run => semanticElementSignature(run, state.relationships)).join('');
	const base = state.factory.base('field', path, `field|complex|${instruction}|${savedResult}|${dirty ?? ''}|${locked ?? ''}|${signature}`);
	return Object.freeze({ ...base, kind: 'field', fieldKind: 'complex', instruction, savedResult, ...(dirty !== undefined ? { dirty } : {}), ...(locked !== undefined ? { locked } : {}), children: Object.freeze(resultChildren) });
}

function parseRevision(element: XmlElement, path: readonly number[], state: NodeParseState): ParadisWordRevisionNode {
	const revisionKind = revisionKindForElement(element.local);
	const revisionId = attribute(element, wordNamespace(element), 'id');
	const author = attribute(element, wordNamespace(element), 'author');
	const date = attribute(element, wordNamespace(element), 'date');
	const inline = parseInlineContainer(element, [...path, 0], state);
	const paragraph = createSyntheticParagraph(state.factory, [...path, 0], inline, `revision|${revisionKind}|${storyText(inline)}`);
	const base = state.factory.base('revision', path, `revision|${revisionKind}|${author ?? ''}|${date ?? ''}|${storyText(inline)}`);
	return Object.freeze({ ...base, kind: 'revision', revisionKind, ...(revisionId !== undefined ? { revisionId } : {}), ...(author !== undefined ? { author } : {}), ...(date !== undefined ? { date } : {}), children: Object.freeze([paragraph]) });
}

function revisionKindForElement(local: string): ParadisWordRevisionNode['revisionKind'] {
	switch (local) {
		case 'ins': return 'inserted';
		case 'del': return 'deleted';
		case 'moveFrom': return 'moveFrom';
		case 'moveTo': return 'moveTo';
		default: return 'propertyChange';
	}
}

function isRevisionElement(element: XmlElement): boolean {
	return isWordElement(element) && ['ins', 'del', 'moveFrom', 'moveTo', 'pPrChange', 'rPrChange', 'tblPrChange', 'trPrChange', 'tcPrChange', 'sectPrChange'].includes(element.local);
}

function parseInlineContainer(element: XmlElement, path: readonly number[], state: NodeParseState): readonly ParadisWordNode[] {
	return parseInlineChildren(elementChildren(element), path, state);
}

function parseInlineChildren(children: readonly XmlElement[], path: readonly number[], state: NodeParseState): readonly ParadisWordNode[] {
	const result: ParadisWordNode[] = [];
	for (let index = 0; index < children.length; index++) {
		state.checkpoint();
		const child = children[index];
		const childPath = [...path, index];
		if (isWordElement(child, 'r')) {
			const runChildren = elementChildren(child);
			if (runChildren.some(candidate => isWordElement(candidate, 'fldChar') && attribute(candidate, wordNamespace(candidate), 'fldCharType') === 'begin')) {
				let depth = 0;
				let endIndex = index;
				for (; endIndex < children.length; endIndex++) {
					const candidate = children[endIndex];
					if (!isWordElement(candidate, 'r')) {
						continue;
					}
					for (const runChild of elementChildren(candidate)) {
						if (!isWordElement(runChild, 'fldChar')) {
							continue;
						}
						const type = attribute(runChild, wordNamespace(runChild), 'fldCharType');
						if (type === 'begin') {
							depth++;
						} else if (type === 'end') {
							depth--;
						}
					}
					if (depth === 0) {
						break;
					}
				}
				const fieldRuns = children.slice(index, endIndex + 1).filter(candidate => isWordElement(candidate, 'r'));
				result.push(parseComplexField(fieldRuns, childPath, state));
				index = endIndex;
				continue;
			}
			result.push(...parseRun(child, childPath, state));
		} else {
			const node = parseInlineElement(child, childPath, state);
			if (node) {
				result.push(node);
			}
		}
	}
	return Object.freeze(result);
}

function createSyntheticParagraph(factory: WordNodeFactory, path: readonly number[], children: readonly ParadisWordNode[], seed: string): ParadisWordParagraphNode {
	const base = factory.base('paragraph', path, seed);
	return Object.freeze({ ...base, kind: 'paragraph', children: Object.freeze([...children]) });
}

function parseTable(element: XmlElement, path: readonly number[], state: NodeParseState): ParadisWordTableNode {
	const diagonalBorders = parseTableDiagonals(element, path, state.factory.part.fingerprint, state.checkpoint);
	const base = state.factory.base('table', path, `table|${diagonalSemanticSeed(diagonalBorders)}|${semanticElementSignature(element, state.relationships)}`);
	const rows: ParadisWordNode[] = [];
	let rowOrdinal = 0;
	for (const child of elementChildren(element)) {
		if (isWordElement(child, 'tr')) {
			rows.push(parseRow(child, [...path, rowOrdinal++], state));
		}
	}
	return Object.freeze({ ...base, kind: 'table', diagonalBorders, children: Object.freeze(rows) });
}

function parseRow(element: XmlElement, path: readonly number[], state: NodeParseState): ParadisWordRowNode {
	const base = state.factory.base('row', path, semanticElementSignature(element, state.relationships));
	const cells: ParadisWordNode[] = [];
	let cellOrdinal = 0;
	for (const child of elementChildren(element)) {
		if (isWordElement(child, 'tc')) {
			cells.push(parseCell(child, [...path, cellOrdinal++], state));
		}
	}
	return Object.freeze({ ...base, kind: 'row', children: Object.freeze(cells) });
}

function parseCell(element: XmlElement, path: readonly number[], state: NodeParseState): ParadisWordCellNode {
	const base = state.factory.base('cell', path, semanticElementSignature(element, state.relationships));
	const children: ParadisWordNode[] = [];
	let ordinal = 0;
	for (const child of elementChildren(element)) {
		if (isWordElement(child, 'tcPr')) {
			continue;
		}
		const node = parseBlockElement(child, [...path, ordinal++], state);
		if (node) {
			children.push(node);
		}
	}
	return Object.freeze({ ...base, kind: 'cell', children: Object.freeze(children) });
}

function parseTableDiagonals(element: XmlElement, semanticPath: readonly number[], fingerprint: ParadisOfficeFingerprint, checkpoint: (force?: boolean) => void): readonly ParadisWordTableDiagonalBorder[] {
	const result: ParadisWordTableDiagonalBorder[] = [];
	walkTableOwnedElements(element, element, node => {
		checkpoint();
		if (!isWordElement(node, 'tl2br') && !isWordElement(node, 'tr2bl')) {
			return;
		}
		const namespace = wordNamespace(node);
		result.push(Object.freeze({
			direction: node.local === 'tl2br' ? 'topLeftToBottomRight' : 'topRightToBottomLeft',
			...(attribute(node, namespace, 'val') !== undefined ? { value: attribute(node, namespace, 'val') } : {}),
			...(attribute(node, namespace, 'sz') !== undefined ? { size: attribute(node, namespace, 'sz') } : {}),
			...(attribute(node, namespace, 'space') !== undefined ? { space: attribute(node, namespace, 'space') } : {}),
			...(attribute(node, namespace, 'color') !== undefined ? { color: attribute(node, namespace, 'color') } : {}),
			...(attribute(node, namespace, 'themeColor') !== undefined ? { themeColor: attribute(node, namespace, 'themeColor') } : {}),
			...(attribute(node, namespace, 'themeTint') !== undefined ? { themeTint: attribute(node, namespace, 'themeTint') } : {}),
			...(attribute(node, namespace, 'themeShade') !== undefined ? { themeShade: attribute(node, namespace, 'themeShade') } : {}),
			sourceSemanticPath: Object.freeze([...semanticPath]),
			sourcePartFingerprint: fingerprint,
		}));
	});
	return Object.freeze(result);
}

function walkTableOwnedElements(root: XmlElement, element: XmlElement, visitor: (candidate: XmlElement) => void): void {
	visitor(element);
	for (const child of elementChildren(element)) {
		if (child !== root && isWordElement(child, 'tbl')) {
			continue;
		}
		walkTableOwnedElements(root, child, visitor);
	}
}

function diagonalSemanticSeed(diagonals: readonly ParadisWordTableDiagonalBorder[]): string {
	return diagonals.map(diagonal => [diagonal.direction, diagonal.value, diagonal.size, diagonal.space, diagonal.color, diagonal.themeColor, diagonal.themeTint, diagonal.themeShade].join('|')).join(';');
}

function parseContentControl(element: XmlElement, path: readonly number[], state: NodeParseState, block: boolean): ParadisWordContentControlNode {
	const properties = wordChild(element, 'sdtPr');
	const content = wordChild(element, 'sdtContent');
	const alias = properties ? attribute(wordChild(properties, 'alias'), wordNamespace(element), 'val') : undefined;
	const tag = properties ? attribute(wordChild(properties, 'tag'), wordNamespace(element), 'val') : undefined;
	const lock = properties ? attribute(wordChild(properties, 'lock'), wordNamespace(element), 'val') : undefined;
	const base = state.factory.base('contentControl', path, `contentControl|${alias ?? ''}|${tag ?? ''}|${lock ?? ''}`);
	const children = content ? (block ? parseBlockChildren(content, path, state) : parseInlineContainer(content, path, state)) : Object.freeze([]);
	return Object.freeze({ ...base, kind: 'contentControl', ...(alias !== undefined ? { alias } : {}), ...(tag !== undefined ? { tag } : {}), ...(lock !== undefined ? { lock } : {}), children });
}

function parseAltChunk(element: XmlElement, path: readonly number[], state: NodeParseState): ParadisWordAltChunkNode {
	const relationshipId = relationshipAttribute(element, 'id');
	const relationship = relationshipId ? state.relationships.get(relationshipId) : undefined;
	if (!relationship || !altChunkRelationshipTypes.has(relationship.type) || relationship.targetMode !== 'internal') {
		state.counters.unresolvedRelationships++;
	}
	const targetPartUri = relationship?.targetMode === 'internal' ? relationship.target : undefined;
	const contentType = targetPartUri ? state.inventoryParts.get(targetPartUri)?.contentType : undefined;
	const base = state.factory.base('altChunk', path, `altChunk|${targetPartUri ?? ''}|${contentType ?? ''}`);
	return Object.freeze({ ...base, kind: 'altChunk', ...(targetPartUri !== undefined ? { targetPartUri } : {}), ...(contentType !== undefined ? { contentType } : {}) });
}

function parseUnknownBlock(element: XmlElement, path: readonly number[], state: NodeParseState): ParadisWordUnknownBlockNode {
	state.counters.unknownBlocks++;
	const name = Object.freeze({ namespace: element.uri, local: element.local });
	const base = state.factory.base('unknownBlock', path, `unknown|${semanticElementSignature(element, state.relationships)}`);
	return Object.freeze({ ...base, kind: 'unknownBlock', name });
}

function parseDrawing(element: XmlElement, path: readonly number[], state: NodeParseState): ParadisWordDrawingNode {
	const placement = firstDescendant(element, node => drawingWordprocessingNamespaces.has(node.uri) && (node.local === 'anchor' || node.local === 'inline'));
	if (!placement) {
		const geometry: ParadisWordDrawingGeometry = Object.freeze({ placement: 'inline', distances: Object.freeze({}), sourcePartFingerprint: state.factory.part.fingerprint });
		return Object.freeze({ ...state.factory.base('drawing', path, 'drawing|missingPlacement'), kind: 'drawing', geometry, children: Object.freeze([]) });
	}
	const geometry = parseDrawingGeometry(placement, state.factory.part.fingerprint);
	const base = state.factory.base('drawing', path, `drawing|${drawingGeometrySemanticSeed(geometry)}`);
	const images: ParadisWordNode[] = [];
	let imageOrdinal = 0;
	walkElements(placement, node => {
		if (!drawingNamespaces.has(node.uri) || node.local !== 'blip') {
			return;
		}
		const embed = relationshipAttribute(node, 'embed');
		const link = relationshipAttribute(node, 'link');
		const relationshipId = embed ?? link;
		const relationship = relationshipId ? state.relationships.get(relationshipId) : undefined;
		if (relationshipId && (!relationship || !imageRelationshipTypes.has(relationship.type))) {
			state.counters.unresolvedRelationships++;
		}
		const targetPartUri = relationship?.targetMode === 'internal' ? relationship.target : undefined;
		const external = relationship?.targetMode === 'external';
		const imageBase = state.factory.base('image', [...path, imageOrdinal++], `image|${relationship?.type ?? ''}|${relationship?.target ?? ''}|${external}`);
		const image: ParadisWordImageNode = { ...imageBase, kind: 'image', ...(targetPartUri !== undefined ? { targetPartUri } : {}), external };
		images.push(Object.freeze(image));
	});
	return Object.freeze({ ...base, kind: 'drawing', geometry, children: Object.freeze(images) });
}

/**
 * wp:anchor / wp:inline から配置情報を読む。描画対象の抽出側(paradisWordRenderableExtractor)も
 * 同じ配置解釈を使う必要があるため公開している。
 */
export function parseDrawingGeometry(placement: XmlElement, partFingerprint: ParadisOfficeFingerprint): ParadisWordDrawingGeometry {
	const wp = placement.uri;
	const simplePosition = directChild(placement, wp, 'simplePos');
	const horizontal = directChild(placement, wp, 'positionH');
	const vertical = directChild(placement, wp, 'positionV');
	const extent = directChild(placement, wp, 'extent');
	const effectExtent = directChild(placement, wp, 'effectExtent');
	const wrap = elementChildren(placement).find(child => child.uri === wp && child.local.startsWith('wrap'));
	const transform = firstDescendant(placement, node => drawingNamespaces.has(node.uri) && node.local === 'xfrm');
	const transformOffset = transform ? directChild(transform, transform.uri, 'off') : undefined;
	const transformExtent = transform ? directChild(transform, transform.uri, 'ext') : undefined;
	const presetGeometry = firstDescendant(placement, node => drawingNamespaces.has(node.uri) && node.local === 'prstGeom');
	const line = firstDescendant(placement, node => drawingNamespaces.has(node.uri) && node.local === 'ln');
	const presetDash = line ? firstDescendant(line, node => drawingNamespaces.has(node.uri) && node.local === 'prstDash') : undefined;
	const headEnd = line ? directChild(line, line.uri, 'headEnd') : undefined;
	const tailEnd = line ? directChild(line, line.uri, 'tailEnd') : undefined;
	return Object.freeze({
		placement: placement.local === 'anchor' ? 'anchor' : 'inline',
		distances: Object.freeze(compact({
			top: attribute(placement, '', 'distT'), bottom: attribute(placement, '', 'distB'),
			left: attribute(placement, '', 'distL'), right: attribute(placement, '', 'distR'),
		})),
		...(simplePosition ? { simplePosition: Object.freeze(compact({ x: attribute(simplePosition, '', 'x'), y: attribute(simplePosition, '', 'y') })) } : {}),
		...(horizontal ? { horizontalPosition: Object.freeze(compact({ relativeFrom: attribute(horizontal, '', 'relativeFrom'), offset: childText(horizontal, wp, 'posOffset'), align: childText(horizontal, wp, 'align') })) } : {}),
		...(vertical ? { verticalPosition: Object.freeze(compact({ relativeFrom: attribute(vertical, '', 'relativeFrom'), offset: childText(vertical, wp, 'posOffset'), align: childText(vertical, wp, 'align') })) } : {}),
		...(extent ? { extent: Object.freeze(compact({ cx: attribute(extent, '', 'cx'), cy: attribute(extent, '', 'cy') })) } : {}),
		...(effectExtent ? {
			effectExtent: Object.freeze(compact({
				left: attribute(effectExtent, '', 'l'), top: attribute(effectExtent, '', 't'),
				right: attribute(effectExtent, '', 'r'), bottom: attribute(effectExtent, '', 'b'),
			})),
		} : {}),
		...(wrap ? {
			wrap: Object.freeze({
				kind: wrap.local.slice('wrap'.length).replace(/^./, value => value.toLowerCase()),
				...(attribute(wrap, '', 'wrapText') !== undefined ? { wrapText: attribute(wrap, '', 'wrapText') } : {}),
				distances: Object.freeze(compact({
					top: attribute(wrap, '', 'distT'), bottom: attribute(wrap, '', 'distB'),
					left: attribute(wrap, '', 'distL'), right: attribute(wrap, '', 'distR'),
				})),
			}),
		} : {}),
		...(transform ? {
			transform: Object.freeze(compact({
				rotation: attribute(transform, '', 'rot'), flipHorizontal: attribute(transform, '', 'flipH'), flipVertical: attribute(transform, '', 'flipV'),
				offset: transformOffset ? Object.freeze(compact({ x: attribute(transformOffset, '', 'x'), y: attribute(transformOffset, '', 'y') })) : undefined,
				extent: transformExtent ? Object.freeze(compact({ cx: attribute(transformExtent, '', 'cx'), cy: attribute(transformExtent, '', 'cy') })) : undefined,
			})),
		} : {}),
		...(presetGeometry && attribute(presetGeometry, '', 'prst') !== undefined ? { presetGeometry: attribute(presetGeometry, '', 'prst') } : {}),
		...(line ? {
			line: Object.freeze(compact({
				width: attribute(line, '', 'w'), presetDash: presetDash ? attribute(presetDash, '', 'val') : undefined,
				cap: attribute(line, '', 'cap'), compound: attribute(line, '', 'cmpd'), alignment: attribute(line, '', 'algn'),
				headEnd: headEnd ? Object.freeze(compact({ type: attribute(headEnd, '', 'type'), width: attribute(headEnd, '', 'w'), length: attribute(headEnd, '', 'len') })) : undefined,
				tailEnd: tailEnd ? Object.freeze(compact({ type: attribute(tailEnd, '', 'type'), width: attribute(tailEnd, '', 'w'), length: attribute(tailEnd, '', 'len') })) : undefined,
			})),
		} : {}),
		...(placement.local === 'anchor' ? {
			anchorProperties: Object.freeze(compact({
				simplePosition: attribute(placement, '', 'simplePos'), relativeHeight: attribute(placement, '', 'relativeHeight'),
				behindDocument: attribute(placement, '', 'behindDoc'), locked: attribute(placement, '', 'locked'),
				layoutInCell: attribute(placement, '', 'layoutInCell'), allowOverlap: attribute(placement, '', 'allowOverlap'),
			})),
		} : {}),
		sourcePartFingerprint: partFingerprint,
	});
}

function drawingGeometrySemanticSeed(geometry: ParadisWordDrawingGeometry): string {
	return JSON.stringify({
		placement: geometry.placement,
		distances: geometry.distances,
		simplePosition: geometry.simplePosition,
		horizontalPosition: geometry.horizontalPosition,
		verticalPosition: geometry.verticalPosition,
		extent: geometry.extent,
		effectExtent: geometry.effectExtent,
		wrap: geometry.wrap,
		transform: geometry.transform,
		presetGeometry: geometry.presetGeometry,
		line: geometry.line,
		anchorProperties: geometry.anchorProperties,
	});
}

function createCommentReference(element: XmlElement, path: readonly number[], state: NodeParseState, boundary: ParadisWordCommentReferenceNode['boundary']): ParadisWordCommentReferenceNode {
	const commentId = requiredAttribute(element, wordNamespace(element), 'id');
	const base = state.factory.base('commentReference', path, `commentReference|${boundary}|${commentId}`);
	return Object.freeze({ ...base, kind: 'commentReference', boundary, commentId });
}

function storyText(nodes: readonly ParadisWordNode[]): string {
	let result = '';
	for (const node of nodes) {
		if (node.kind === 'text' || node.kind === 'omml') {
			result += node.text;
		} else if (node.children) {
			result += storyText(node.children);
		}
	}
	return result;
}

function collectSectionReferences(
	body: XmlElement,
	relationships: ReadonlyMap<string, RawRelationship>,
	part: ParsedXmlPart,
	checkpoint: (force?: boolean) => void,
): readonly RawSectionReference[] {
	const result: RawSectionReference[] = [];
	let sectionOrdinal = 0;
	for (const child of elementChildren(body)) {
		checkpoint();
		const sectionProperties = isWordElement(child, 'sectPr') ? child : isWordElement(child, 'p') ? paragraphSectionProperties(child) : undefined;
		if (!sectionProperties) {
			continue;
		}
		let referenceOrdinal = 0;
		for (const reference of elementChildren(sectionProperties)) {
			if (!isWordElement(reference, 'headerReference') && !isWordElement(reference, 'footerReference')) {
				continue;
			}
			const kind = reference.local === 'headerReference' ? 'header' : 'footer';
			const role = attribute(reference, wordNamespace(reference), 'type');
			if (role !== 'default' && role !== 'first' && role !== 'even') {
				throw new ParadisOfficePackageError('malformed');
			}
			const relationshipId = relationshipAttribute(reference, 'id');
			const relationship = relationshipId ? relationships.get(relationshipId) : undefined;
			const accepted = kind === 'header' ? headerRelationshipTypes : footerRelationshipTypes;
			if (!relationship || !accepted.has(relationship.type) || relationship.targetMode !== 'internal') {
				throw new ParadisOfficePackageError('unsafe');
			}
			result.push(Object.freeze({ kind, role, sectionOrdinal, targetPartUri: relationship.target, semanticPath: Object.freeze([sectionOrdinal, referenceOrdinal++]) }));
		}
		sectionOrdinal++;
	}
	if (result.length === 0 && part.uri.length === 0) {
		throw new ParadisOfficePackageError('malformed');
	}
	return Object.freeze(result);
}

function paragraphSectionProperties(paragraph: XmlElement): XmlElement | undefined {
	const properties = wordChild(paragraph, 'pPr');
	return properties ? wordChild(properties, 'sectPr') : undefined;
}

function createHeaderFooterStories(
	references: readonly RawSectionReference[],
	reader: SemanticArchiveReader,
	inventoryParts: ReadonlyMap<string, ParadisOfficeInventoryPart>,
	relationshipsByPart: ReadonlyMap<string, ReadonlyMap<string, RawRelationship>>,
	limits: ParadisWordSemanticLimits,
	counters: MutableCounters,
	checkpoint: (force?: boolean) => void,
): { readonly stories: readonly ParadisWordStory[] } {
	const descriptors = new Map<string, { readonly kind: 'header' | 'footer'; readonly roles: ParadisWordHeaderFooterRole[] }>();
	for (const reference of references) {
		checkpoint();
		const existing = descriptors.get(reference.targetPartUri);
		if (existing) {
			if (existing.kind !== reference.kind) {
				throw new ParadisOfficePackageError('unsafe');
			}
			if (!existing.roles.includes(reference.role)) {
				existing.roles.push(reference.role);
			}
		} else {
			descriptors.set(reference.targetPartUri, { kind: reference.kind, roles: [reference.role] });
		}
	}
	const result: ParadisWordStory[] = [];
	let headerOrdinal = 0;
	let footerOrdinal = 0;
	for (const [partUri, descriptor] of descriptors) {
		checkpoint();
		const part = requiredParsedPart(reader, partUri);
		const root = wordRoot(part.document, descriptor.kind === 'header' ? 'hdr' : 'ftr');
		const factory = new WordNodeFactory(part, counters, limits, checkpoint);
		const state: NodeParseState = { factory, relationships: relationshipsByPart.get(partUri) ?? new Map(), inventoryParts, counters, limits, checkpoint };
		const nodes = parseBlockChildren(root, [], state);
		result.push(createStory(part, descriptor.kind, descriptor.kind === 'header' ? headerOrdinal++ : footerOrdinal++, nodes, { roles: descriptor.roles }));
	}
	return { stories: Object.freeze(result) };
}

function createNoteStories(
	relationships: readonly RawRelationship[],
	reader: SemanticArchiveReader,
	inventoryParts: ReadonlyMap<string, ParadisOfficeInventoryPart>,
	relationshipsByPart: ReadonlyMap<string, ReadonlyMap<string, RawRelationship>>,
	limits: ParadisWordSemanticLimits,
	counters: MutableCounters,
	checkpoint: (force?: boolean) => void,
): readonly ParadisWordStory[] {
	const result: ParadisWordStory[] = [];
	for (const descriptor of [
		{ kind: 'footnote' as const, relationshipTypes: footnotesRelationshipTypes, root: 'footnotes', child: 'footnote' },
		{ kind: 'endnote' as const, relationshipTypes: endnotesRelationshipTypes, root: 'endnotes', child: 'endnote' },
	]) {
		const relationship = optionalUniqueRelationship(relationships, descriptor.relationshipTypes);
		if (!relationship) {
			continue;
		}
		const partUri = internalTarget(relationship);
		const part = requiredParsedPart(reader, partUri);
		const root = wordRoot(part.document, descriptor.root);
		const factory = new WordNodeFactory(part, counters, limits, checkpoint);
		const state: NodeParseState = { factory, relationships: relationshipsByPart.get(partUri) ?? new Map(), inventoryParts, counters, limits, checkpoint };
		let ordinal = 0;
		for (const note of wordChildren(root, descriptor.child)) {
			checkpoint();
			const noteId = requiredAttribute(note, wordNamespace(note), 'id');
			if (/^-/.test(noteId)) {
				continue;
			}
			const nodes = parseBlockChildren(note, [ordinal], state);
			result.push(createStory(part, descriptor.kind, ordinal++, nodes, { noteId }));
		}
	}
	return Object.freeze(result);
}

function createCommentStories(
	relationships: readonly RawRelationship[],
	reader: SemanticArchiveReader,
	inventoryParts: ReadonlyMap<string, ParadisOfficeInventoryPart>,
	relationshipsByPart: ReadonlyMap<string, ReadonlyMap<string, RawRelationship>>,
	limits: ParadisWordSemanticLimits,
	counters: MutableCounters,
	checkpoint: (force?: boolean) => void,
): readonly ParadisWordStory[] {
	const relationship = optionalUniqueRelationship(relationships, commentsRelationshipTypes);
	if (!relationship) {
		return Object.freeze([]);
	}
	const partUri = internalTarget(relationship);
	const part = requiredParsedPart(reader, partUri);
	const root = wordRoot(part.document, 'comments');
	const factory = new WordNodeFactory(part, counters, limits, checkpoint);
	const state: NodeParseState = { factory, relationships: relationshipsByPart.get(partUri) ?? new Map(), inventoryParts, counters, limits, checkpoint };
	const result: ParadisWordStory[] = [];
	let ordinal = 0;
	for (const comment of wordChildren(root, 'comment')) {
		checkpoint();
		const commentId = requiredAttribute(comment, wordNamespace(comment), 'id');
		const author = attribute(comment, wordNamespace(comment), 'author');
		const date = attribute(comment, wordNamespace(comment), 'date');
		const nodes = parseBlockChildren(comment, [ordinal], state);
		result.push(createStory(part, 'comment', ordinal++, nodes, { commentId, ...(author !== undefined ? { author } : {}), ...(date !== undefined ? { date } : {}) }));
	}
	return Object.freeze(result);
}

function materializeStoryReferences(
	references: readonly RawSectionReference[],
	storiesByPart: ReadonlyMap<string, ParadisWordStory>,
	part: ParsedXmlPart,
): readonly ParadisWordStoryReference[] {
	return Object.freeze(references.map((reference, ordinal) => {
		const story = storiesByPart.get(reference.targetPartUri);
		if (!story) {
			throw new ParadisOfficePackageError('unsafe');
		}
		const fingerprint = semanticFingerprint(`storyReference|${reference.kind}|${reference.role}|${reference.sectionOrdinal}|${reference.targetPartUri}`);
		const source: ParadisWordSourceRef = Object.freeze({
			partUri: part.uri,
			semanticPath: reference.semanticPath,
			kind: 'storyReference',
			ordinal,
			fingerprint,
			partFingerprint: part.fingerprint,
		});
		const anchor: ParadisOfficeRenderAnchorKey = Object.freeze({ partUri: part.uri, semanticPath: source.semanticPath, kind: 'storyReference', ordinal, fingerprint });
		return Object.freeze({
			id: semanticId(part.uri, source.semanticPath, 'storyReference', ordinal, fingerprint),
			kind: reference.kind,
			role: reference.role,
			sectionOrdinal: reference.sectionOrdinal,
			storyId: story.id,
			source,
			anchor,
		});
	}));
}

function collectTextboxDescriptors(
	part: ParsedXmlPart,
	ownerStoryId: string,
	element: XmlElement,
	path: readonly number[],
	result: TextboxDescriptor[],
	checkpoint: (force?: boolean) => void,
	container?: XmlElement,
): void {
	let ordinal = 0;
	for (const child of elementChildren(element)) {
		checkpoint();
		const childPath = [...path, ordinal++];
		if (isWordElement(child, 'txbxContent')) {
			result.push(Object.freeze({ part, ownerStoryId, element: child, xmlPath: Object.freeze(childPath), ...(container ? { container } : {}) }));
			continue;
		}
		const nextContainer = (vmlNamespaces.has(child.uri) && child.local === 'shape')
			|| (drawingNamespaces.has(child.uri) && (child.local === 'graphicFrame' || child.local === 'sp')) ? child : container;
		collectTextboxDescriptors(part, ownerStoryId, child, childPath, result, checkpoint, nextContainer);
	}
}

function createTextboxStory(
	descriptor: TextboxDescriptor,
	inventoryParts: ReadonlyMap<string, ParadisOfficeInventoryPart>,
	relationshipsByPart: ReadonlyMap<string, ReadonlyMap<string, RawRelationship>>,
	limits: ParadisWordSemanticLimits,
	counters: MutableCounters,
	checkpoint: (force?: boolean) => void,
	ordinal: number,
): ParadisWordStory {
	const factory = new WordNodeFactory(descriptor.part, counters, limits, checkpoint);
	const state: NodeParseState = { factory, relationships: relationshipsByPart.get(descriptor.part.uri) ?? new Map(), inventoryParts, counters, limits, checkpoint };
	const nodes = parseBlockChildren(descriptor.element, [0x7ffffffe, ...descriptor.xmlPath], state);
	return createStory(descriptor.part, 'textbox', ordinal, nodes, {
		parentStoryId: descriptor.ownerStoryId,
		textboxGeometry: textboxGeometry(descriptor),
	});
}

function textboxGeometry(descriptor: TextboxDescriptor): ParadisWordTextboxGeometry {
	const container = descriptor.container;
	if (!container) {
		return Object.freeze({ container: 'unknown', sourcePartFingerprint: descriptor.part.fingerprint });
	}
	if (vmlNamespaces.has(container.uri) && container.local === 'shape') {
		return Object.freeze({
			container: 'vmlShape',
			...(attribute(container, '', 'id') !== undefined ? { shapeId: attribute(container, '', 'id') } : {}),
			...(attribute(container, '', 'style') !== undefined ? { rawStyle: attribute(container, '', 'style') } : {}),
			...(attribute(container, '', 'coordsize') !== undefined ? { coordinateSize: attribute(container, '', 'coordsize') } : {}),
			...(attribute(container, '', 'coordorigin') !== undefined ? { coordinateOrigin: attribute(container, '', 'coordorigin') } : {}),
			...(attribute(container, '', 'from') !== undefined ? { from: attribute(container, '', 'from') } : {}),
			...(attribute(container, '', 'to') !== undefined ? { to: attribute(container, '', 'to') } : {}),
			sourcePartFingerprint: descriptor.part.fingerprint,
		});
	}
	return Object.freeze({ container: 'drawingML', sourcePartFingerprint: descriptor.part.fingerprint });
}

function storyRootContainer(part: ParsedXmlPart, address: ParadisWordStory['address']): XmlElement {
	if (address.kind === 'header') {
		return wordRoot(part.document, 'hdr');
	}
	if (address.kind === 'footer') {
		return wordRoot(part.document, 'ftr');
	}
	if (address.kind === 'footnote' || address.kind === 'endnote') {
		const root = wordRoot(part.document, address.kind === 'footnote' ? 'footnotes' : 'endnotes');
		const childName = address.kind === 'footnote' ? 'footnote' : 'endnote';
		const match = wordChildren(root, childName).find(child => attribute(child, wordNamespace(child), 'id') === address.noteId);
		if (!match) {
			throw new ParadisOfficePackageError('unsafe');
		}
		return match;
	}
	if (address.kind === 'comment') {
		const root = wordRoot(part.document, 'comments');
		const match = wordChildren(root, 'comment').find(child => attribute(child, wordNamespace(child), 'id') === address.commentId);
		if (!match) {
			throw new ParadisOfficePackageError('unsafe');
		}
		return match;
	}
	return part.document.root;
}

function requiredParsedPart(reader: SemanticArchiveReader, partUri: string): ParsedXmlPart {
	const part = reader.parsed.get(partUri);
	if (!part) {
		throw new ParadisOfficePackageError('unsafe');
	}
	return part;
}

function wordRoot(document: ParadisOfficeXmlDocument, local: string): XmlElement {
	if (!isWordElement(document.root, local)) {
		throw new ParadisOfficePackageError('malformed');
	}
	return document.root;
}

function uniqueWordChild(element: XmlElement, local: string): XmlElement | undefined {
	const matches = wordChildren(element, local);
	if (matches.length > 1) {
		throw new ParadisOfficePackageError('malformed');
	}
	return matches[0];
}

function wordChild(element: XmlElement, local: string): XmlElement | undefined {
	return elementChildren(element).find(child => isWordElement(child, local));
}

function wordChildren(element: XmlElement, local: string): readonly XmlElement[] {
	return elementChildren(element).filter(child => isWordElement(child, local));
}

function isWordElement(element: XmlElement, local?: string): boolean {
	return wordNamespaces.has(element.uri) && (local === undefined || element.local === local);
}

function isMathElement(element: XmlElement, local?: string): boolean {
	return mathNamespaces.has(element.uri) && (local === undefined || element.local === local);
}

function wordNamespace(element: XmlElement): string {
	if (!wordNamespaces.has(element.uri)) {
		throw new ParadisOfficePackageError('malformed');
	}
	return element.uri;
}

function elementChildren(element: XmlElement): readonly XmlElement[] {
	return element.children.filter((child): child is XmlElement => child.kind === 'element');
}

function attribute(element: XmlElement | undefined, uri: string, local: string): string | undefined {
	if (!element) {
		return undefined;
	}
	const matches = element.attributes.filter(candidate => candidate.uri === uri && candidate.local === local);
	if (matches.length > 1) {
		throw new ParadisOfficePackageError('malformed');
	}
	return matches[0]?.value;
}

function requiredAttribute(element: XmlElement, uri: string, local: string): string {
	const value = attribute(element, uri, local);
	if (value === undefined) {
		throw new ParadisOfficePackageError('malformed');
	}
	return value;
}

function relationshipAttribute(element: XmlElement, local: string): string | undefined {
	const matches = element.attributes.filter(candidate => officeRelationshipNamespaces.has(candidate.uri) && candidate.local === local);
	if (matches.length > 1) {
		throw new ParadisOfficePackageError('malformed');
	}
	return matches[0]?.value;
}

function directText(element: XmlElement): string {
	return element.children.filter((child): child is Extract<ParadisOfficeXmlNode, { readonly kind: 'text' }> => child.kind === 'text').map(child => child.value).join('');
}

function directDescendantText(element: XmlElement): string {
	let result = directText(element);
	for (const child of elementChildren(element)) {
		result += directDescendantText(child);
	}
	return result;
}

function directChild(element: XmlElement, uri: string, local: string): XmlElement | undefined {
	const matches = elementChildren(element).filter(child => child.uri === uri && child.local === local);
	if (matches.length > 1) {
		throw new ParadisOfficePackageError('malformed');
	}
	return matches[0];
}

function childText(element: XmlElement, uri: string, local: string): string | undefined {
	const child = directChild(element, uri, local);
	return child ? directText(child) : undefined;
}

function firstDescendant(element: XmlElement, predicate: (candidate: XmlElement) => boolean): XmlElement | undefined {
	for (const child of elementChildren(element)) {
		if (predicate(child)) {
			return child;
		}
		const nested = firstDescendant(child, predicate);
		if (nested) {
			return nested;
		}
	}
	return undefined;
}

function walkElements(element: XmlElement, visitor: (candidate: XmlElement) => void): void {
	visitor(element);
	for (const child of elementChildren(element)) {
		walkElements(child, visitor);
	}
}

/** Expanded-QName signature with relationship attributes replaced by canonical target identity. */
function semanticElementSignature(element: XmlElement, relationships: ReadonlyMap<string, RawRelationship>, inheritedSpacePreserved = false): string {
	const attributes = element.attributes.map(candidate => {
		let value = candidate.value;
		if (officeRelationshipNamespaces.has(candidate.uri) && (candidate.local === 'id' || candidate.local === 'embed' || candidate.local === 'link')) {
			const relationship = relationships.get(candidate.value);
			value = relationship ? `${relationship.type}|${relationship.targetMode}|${relationship.target}` : 'unresolvedRelationship';
		}
		return `{${candidate.uri}}${candidate.local}=${value}`;
	}).sort();
	const xmlSpace = attribute(element, xmlNamespace, 'space');
	const spacePreserved = xmlSpace === 'preserve' || (xmlSpace !== 'default' && inheritedSpacePreserved);
	const hasElementChildren = element.children.some(child => child.kind === 'element');
	let result = `<{${element.uri}}${element.local}${attributes.length ? ` ${attributes.join(' ')}` : ''}>`;
	for (const child of element.children) {
		if (child.kind === 'text') {
			if (spacePreserved || !hasElementChildren || !/^\s*$/.test(child.value)) {
				result += child.value;
			}
		} else {
			result += semanticElementSignature(child, relationships, spacePreserved);
		}
	}
	return `${result}</{${element.uri}}${element.local}>`;
}

function compact<T extends object>(value: T): T {
	const result: Record<string, unknown> = {};
	for (const [key, candidate] of Object.entries(value)) {
		if (candidate !== undefined) {
			result[key] = candidate;
		}
	}
	return result as T;
}
