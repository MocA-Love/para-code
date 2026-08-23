/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import { VSBuffer } from '../../../../base/common/buffer.js';
import type { ParadisOfficeError } from './paradisOfficeErrors.js';

/** Result of an Office analysis or rendering operation. */
export type ParadisOfficeOutcome = 'complete' | 'degraded' | 'blocked' | 'sideMissing' | 'cancelled' | 'stale' | 'failed';

/** Analysis coverage of one package Part. */
export type ParadisOfficePartCoverage = 'parsed' | 'partial' | 'opaque' | 'completeOpaque' | 'unsafe' | 'failed' | 'omittedByBudget';

/** Minimal Part status consumed by outcome aggregation. */
export interface ParadisOfficePartStatus {
	readonly coverage: ParadisOfficePartCoverage;
	readonly required: boolean;
}

/** V1 transport and semantic payload limits. */
export const PARADIS_OFFICE_LIMITS = {
	maxChangeValueDepth: 8,
	maxChangeValueListItems: 256,
	maxChangeValueRecordFields: 128,
	maxChangeValueStringLength: 4096,
	maxChangeSerializedBytes: 64 * 1024,
	maxSerializedResponseBytes: 2 * 1024 * 1024,
	maxAssetRequestBytes: 2 * 1024 * 1024,
	maxCursorLength: 16 * 1024,
} as const;

/** Serializable data accepted by Office IPC, in addition to VSBuffer. */
export type ParadisOfficeSerializableData =
	| null
	| boolean
	| number
	| string
	| VSBuffer
	| readonly ParadisOfficeSerializableData[]
	| { readonly [key: string]: ParadisOfficeSerializableData };

/** Serializable source identity. Streams, watchers, and file handles stay backend-owned. */
export interface ParadisOfficeSourceDescriptor {
	readonly kind: 'file' | 'remote' | 'gitCommit' | 'gitIndex' | 'workingTree' | 'untitled' | 'sideMissing';
	readonly uri?: string;
	readonly revisionHint?: string;
	readonly displayName: string;
	readonly side?: 'original' | 'modified';
}

/** SHA-256 identity of all bytes represented by a value or Part. */
export interface ParadisOfficeFingerprint {
	readonly algorithm: 'sha256';
	readonly value: string;
	readonly byteLength: number;
}

/** Platform budget profile frozen into the v1 contract. */
export interface ParadisOfficeBudgetProfile {
	readonly kind: 'desktopLocal' | 'remoteMobile' | 'browser';
	readonly compressedInputBytes: number;
	readonly expandedBytes: number;
	readonly entryCount: number;
	readonly xmlPartBytes: number;
	readonly binaryPartBytes: number;
	readonly totalMediaBytes: number;
	readonly compressionRatio: number;
	readonly xmlDepth: number;
	readonly xmlNodesPerPart: number;
	readonly attributeLength: number;
	readonly imagePixels: number;
	readonly inspectMilliseconds: number;
	readonly semanticParseMilliseconds: number;
	readonly diffMilliseconds: number;
}

/** Normative Office security budgets by execution platform. */
export const PARADIS_OFFICE_BUDGET_PROFILES: Readonly<Record<ParadisOfficeBudgetProfile['kind'], ParadisOfficeBudgetProfile>> = {
	desktopLocal: {
		kind: 'desktopLocal', compressedInputBytes: 32 * 1024 * 1024, expandedBytes: 256 * 1024 * 1024, entryCount: 20_000,
		xmlPartBytes: 64 * 1024 * 1024, binaryPartBytes: 32 * 1024 * 1024, totalMediaBytes: 128 * 1024 * 1024,
		compressionRatio: 200, xmlDepth: 128, xmlNodesPerPart: 2_000_000, attributeLength: 1024 * 1024, imagePixels: 100_000_000,
		inspectMilliseconds: 30_000, semanticParseMilliseconds: 60_000, diffMilliseconds: 90_000,
	},
	remoteMobile: {
		kind: 'remoteMobile', compressedInputBytes: 20 * 1024 * 1024, expandedBytes: 128 * 1024 * 1024, entryCount: 10_000,
		xmlPartBytes: 32 * 1024 * 1024, binaryPartBytes: 24 * 1024 * 1024, totalMediaBytes: 64 * 1024 * 1024,
		compressionRatio: 150, xmlDepth: 96, xmlNodesPerPart: 1_000_000, attributeLength: 512 * 1024, imagePixels: 50_000_000,
		inspectMilliseconds: 30_000, semanticParseMilliseconds: 60_000, diffMilliseconds: 90_000,
	},
	browser: {
		kind: 'browser', compressedInputBytes: 16 * 1024 * 1024, expandedBytes: 96 * 1024 * 1024, entryCount: 10_000,
		xmlPartBytes: 24 * 1024 * 1024, binaryPartBytes: 16 * 1024 * 1024, totalMediaBytes: 48 * 1024 * 1024,
		compressionRatio: 100, xmlDepth: 96, xmlNodesPerPart: 750_000, attributeLength: 512 * 1024, imagePixels: 40_000_000,
		inspectMilliseconds: 20_000, semanticParseMilliseconds: 45_000, diffMilliseconds: 60_000,
	},
};

/** Measured resource use. Counters are based on consumed streams, not archive declarations. */
export interface ParadisOfficeBudgetUsage {
	readonly compressedInputBytes: number;
	readonly expandedBytes: number;
	readonly entryCount: number;
	readonly largestPartBytes: number;
	readonly totalMediaBytes: number;
	readonly elapsedMilliseconds: number;
}

/** Package format detected before semantic parsing. */
export type ParadisOfficeFormat = 'xlsx' | 'xlsm' | 'xltx' | 'xltm' | 'docx' | 'docm' | 'dotx' | 'dotm' | 'zip' | 'cfbEncrypted' | 'unknown';

/** Inventory entry common to every coverage state. */
export interface ParadisOfficeInventoryPartBase extends ParadisOfficePartStatus {
	readonly id: string;
	readonly canonicalUri: string;
	readonly contentType: string;
	readonly compressedBytes: number;
	readonly expandedBytes: number;
	readonly canonicalHash?: ParadisOfficeFingerprint;
}

/** Inventory Part. completeOpaque requires a hash over every raw byte. */
export type ParadisOfficeInventoryPart =
	| (ParadisOfficeInventoryPartBase & { readonly coverage: 'completeOpaque'; readonly rawHash: ParadisOfficeFingerprint; readonly hashCompleteness: 'allBytes' })
	| (ParadisOfficeInventoryPartBase & { readonly coverage: 'parsed'; readonly rawHash: ParadisOfficeFingerprint; readonly hashCompleteness: 'allBytes' })
	| (ParadisOfficeInventoryPartBase & {
		readonly coverage: Exclude<ParadisOfficePartCoverage, 'completeOpaque' | 'parsed'>;
		readonly rawHash?: ParadisOfficeFingerprint;
		readonly hashCompleteness?: 'allBytes' | 'incomplete';
	});

/** Directed relationship discovered in an OPC package. */
export interface ParadisOfficeRelationship {
	readonly id: string;
	readonly sourcePartId?: string;
	readonly type: string;
	readonly target: string;
	readonly targetMode: 'internal' | 'external';
	readonly missing: boolean;
	readonly cyclic: boolean;
}

/** Feature occurrence discovered without exposing its raw Part. */
export interface ParadisOfficeInventoryFeature {
	readonly kind: string;
	readonly count: number;
	readonly partIds: readonly string[];
	readonly safety: 'safe' | 'sanitized' | 'metadataOnly' | 'blocked';
}

/** Package security summary. */
export interface ParadisOfficeSecuritySummary {
	readonly encrypted: boolean;
	readonly hasMacros: boolean;
	readonly hasExternalRelationships: boolean;
	readonly hasEmbeddedObjects: boolean;
	readonly hasProtection: boolean;
	readonly hasSignatures: boolean;
}

/** Bounded package inventory generated before render or semantic analysis. */
export interface ParadisOfficeInventory {
	readonly format: ParadisOfficeFormat;
	readonly container: 'opc' | 'zip' | 'cfb' | 'unknown';
	readonly parts: readonly ParadisOfficeInventoryPart[];
	readonly relationships: readonly ParadisOfficeRelationship[];
	readonly features: readonly ParadisOfficeInventoryFeature[];
	readonly security: ParadisOfficeSecuritySummary;
	readonly budgetProfile: ParadisOfficeBudgetProfile['kind'];
	readonly budgetUsage: ParadisOfficeBudgetUsage;
}

/** Terminal completeness counters for full-document analysis. */
export interface ParadisOfficeCompletenessManifest {
	readonly expectedParts: number;
	readonly visitedParts: number;
	readonly parsedParts: number;
	readonly opaqueParts: number;
	readonly failedParts: number;
	readonly omittedParts: number;
	readonly expectedSemanticUnits: number;
	readonly visitedSemanticUnits: number;
	readonly terminal: boolean;
}

/** Revision fence for a document or a two-sided comparison. */
export type ParadisOfficeRevision =
	| { readonly kind: 'document'; readonly sourceRevision: string }
	| {
		readonly kind: 'comparison';
		readonly originalRevision: string;
		readonly modifiedRevision: string;
		readonly comparisonRevision: string;
	};

/** Bounded, recursively serializable value used by semantic changes. */
export type ParadisOfficeChangeValue =
	| { readonly kind: 'none' }
	| { readonly kind: 'scalar'; readonly valueType: 'text' | 'number' | 'boolean' | 'null'; readonly value: string | boolean | null }
	| { readonly kind: 'list'; readonly items: readonly ParadisOfficeChangeValue[] }
	| { readonly kind: 'record'; readonly fields: readonly { readonly name: string; readonly value: ParadisOfficeChangeValue }[] }
	| ({ readonly kind: 'fingerprint' } & ParadisOfficeFingerprint);

/** Explicit renderer fallback for unsupported, unsafe, or unanchored content. */
export interface ParadisOfficePlaceholder {
	readonly nodeId: string;
	readonly feature: string;
	readonly reason: 'unsupported' | 'unsafe' | 'notEvaluated' | 'budget' | 'noAnchor';
	readonly title: string;
	readonly detail?: string;
	readonly fingerprint?: string;
}

/** Stable semantic-to-render address. */
export interface ParadisOfficeRenderAnchorKey {
	readonly partUri: string;
	readonly semanticPath: readonly number[];
	readonly kind: string;
	readonly ordinal: number;
	readonly fingerprint: string;
}

/** Script-free inline formatting shared by viewport and print models. */
export interface ParadisOfficeTextFormat {
	readonly bold?: boolean;
	readonly italic?: boolean;
	readonly underline?: 'single' | 'double';
	readonly strike?: boolean;
	readonly foreground?: string;
	readonly background?: string;
	readonly fontFamily?: string;
	readonly fontSize?: number;
	readonly horizontalAlignment?: 'start' | 'center' | 'end' | 'justify';
}

/** Text run with no executable markup. */
export interface ParadisOfficeTextRun {
	readonly text: string;
	readonly format?: ParadisOfficeTextFormat;
}

/** Typed spreadsheet cell viewport primitive. */
export interface ParadisOfficeRenderCell {
	readonly nodeId: string;
	readonly row: number;
	readonly column: number;
	readonly text: string;
	readonly value?: ParadisOfficeChangeValue;
	readonly format?: ParadisOfficeTextFormat;
	readonly rowSpan?: number;
	readonly columnSpan?: number;
	readonly anchor?: ParadisOfficeRenderAnchorKey;
}

/** Typed document block viewport primitive. */
export interface ParadisOfficeRenderBlock {
	readonly nodeId: string;
	readonly kind: 'paragraph' | 'heading' | 'table' | 'tableRow' | 'tableCell' | 'list' | 'listItem' | 'section' | 'story' | 'unknown';
	readonly runs?: readonly ParadisOfficeTextRun[];
	readonly children?: readonly ParadisOfficeRenderBlock[];
	readonly level?: number;
	readonly anchor?: ParadisOfficeRenderAnchorKey;
}

/** Typed safe object viewport primitive. */
export interface ParadisOfficeRenderObject {
	readonly nodeId: string;
	readonly kind: 'rasterImage' | 'sanitizedSvg' | 'chart' | 'shape' | 'math' | 'objectPreview';
	readonly assetId?: string;
	readonly altText?: string;
	readonly bounds?: { readonly x: number; readonly y: number; readonly width: number; readonly height: number };
	readonly anchor?: ParadisOfficeRenderAnchorKey;
}

/** Bounded tile returned for a spreadsheet range or document locator. */
export interface ParadisOfficeRenderTile {
	readonly locator: string;
	readonly range: readonly [number, number, number, number];
	readonly side?: 'original' | 'modified' | 'combined';
	readonly cells: readonly ParadisOfficeRenderCell[];
	readonly blocks: readonly ParadisOfficeRenderBlock[];
	readonly objects: readonly ParadisOfficeRenderObject[];
	readonly placeholders: readonly ParadisOfficePlaceholder[];
}

/** Semantic search result with a stable navigation target and location badge. */
export interface ParadisOfficeSearchResult {
	readonly id: string;
	readonly locator: string;
	readonly preview: { readonly before: string; readonly match: string; readonly after: string };
	readonly locationBadge: { readonly kind: 'sheet' | 'story' | 'object' | 'placeholder' | 'metadata'; readonly label: string };
	readonly navigableAnchor?: string;
	readonly side?: 'original' | 'modified' | 'combined';
}

/** Script-free print block tree. */
export type ParadisOfficePrintBlock =
	| { readonly kind: 'text'; readonly nodeId: string; readonly runs: readonly ParadisOfficeTextRun[] }
	| { readonly kind: 'container'; readonly nodeId: string; readonly role: 'section' | 'table' | 'row' | 'cell' | 'list'; readonly children: readonly ParadisOfficePrintBlock[] }
	| { readonly kind: 'object'; readonly nodeId: string; readonly object: ParadisOfficeRenderObject }
	| { readonly kind: 'placeholder'; readonly nodeId: string; readonly placeholder: ParadisOfficePlaceholder };

/** One page in a script-free print model. */
export interface ParadisOfficePrintPage {
	readonly pageNumber: number;
	readonly widthPoints: number;
	readonly heightPoints: number;
	readonly blocks: readonly ParadisOfficePrintBlock[];
	readonly placeholders: readonly ParadisOfficePlaceholder[];
}

/** Complete script-free print model produced independently of live viewer DOM. */
export interface ParadisOfficePrintModel {
	readonly title: string;
	readonly pages: readonly ParadisOfficePrintPage[];
	readonly approximationWarnings: readonly { readonly code: string; readonly message: string }[];
}

/** Allowlisted asset metadata. No package path or generic raw Part identifier is exposed. */
export interface ParadisOfficeRenderableAsset {
	readonly id: string;
	readonly kind: 'rasterImage' | 'sanitizedSvg' | 'fontSubset' | 'chartPreview' | 'placeholderPreview' | 'generatedPdf';
	readonly mime: 'image/png' | 'image/jpeg' | 'image/gif' | 'image/webp' | 'image/svg+xml' | 'font/woff2' | 'application/pdf';
	readonly byteLength: number;
	readonly fingerprint: ParadisOfficeFingerprint;
	readonly altText?: string;
}

/** Change category shared by comparison filters and result records. */
export type ParadisOfficeChangeCategory = 'content' | 'formatting' | 'structure' | 'annotation' | 'revision' | 'object' | 'security';

/** Bounded semantic change record. */
export interface ParadisOfficeChange {
	readonly id: string;
	readonly category: ParadisOfficeChangeCategory;
	readonly subject: { readonly kind: string; readonly locator: string };
	readonly before: ParadisOfficeChangeValue;
	readonly after: ParadisOfficeChangeValue;
	readonly certainty: 'exact' | 'normalized' | 'heuristic' | 'ambiguous' | 'opaque' | 'degraded';
	readonly sourceParts: readonly string[];
	readonly navigableAnchor?: string;
}

/** Backend-owned document or comparison handle reference. */
export type ParadisOfficeHandleRef =
	| { readonly kind: 'document'; readonly id: string }
	| { readonly kind: 'comparison'; readonly id: string };

/** All v1 Office channel requests. */
export type ParadisOfficeRequest =
	| { readonly version: 1; readonly requestId: string; readonly operation: 'inspect'; readonly source: ParadisOfficeSourceDescriptor }
	| { readonly version: 1; readonly requestId: string; readonly operation: 'open'; readonly source: ParadisOfficeSourceDescriptor }
	| {
		readonly version: 1; readonly requestId: string; readonly operation: 'getViewport'; readonly handle: ParadisOfficeHandleRef;
		readonly locator: string; readonly range: readonly [number, number, number, number];
	}
	| {
		readonly version: 1; readonly requestId: string; readonly operation: 'compare'; readonly original: ParadisOfficeSourceDescriptor;
		readonly modified: ParadisOfficeSourceDescriptor; readonly categories?: readonly ParadisOfficeChangeCategory[]; readonly cursor?: string;
	}
	| {
		readonly version: 1; readonly requestId: string; readonly operation: 'search'; readonly handle: ParadisOfficeHandleRef;
		readonly query: string; readonly options?: { readonly matchCase?: boolean; readonly normalizeNfc?: boolean }; readonly cursor?: string;
	}
	| {
		readonly version: 1; readonly requestId: string; readonly operation: 'getRenderableAsset'; readonly handle: ParadisOfficeHandleRef;
		readonly assetId: string; readonly offset: number; readonly length: number;
	}
	| {
		readonly version: 1; readonly requestId: string; readonly operation: 'getPrintModel'; readonly handle: ParadisOfficeHandleRef;
		readonly options: { readonly includePlaceholders: true; readonly pageRange?: readonly [number, number] };
	}
	| {
		readonly version: 1; readonly requestId: string; readonly operation: 'exportPrint'; readonly handle: ParadisOfficeHandleRef;
		readonly format: 'pdf'; readonly pageRange?: readonly [number, number];
	}
	| { readonly version: 1; readonly requestId: string; readonly operation: 'close' | 'cancel'; readonly handle?: ParadisOfficeHandleRef; readonly targetRequestId?: string };

/** Metadata common to successful v1 responses. */
export interface ParadisOfficeResponseMeta {
	readonly version: 1;
	readonly requestId: string;
	readonly outcome: ParadisOfficeOutcome;
	readonly warnings: readonly { readonly code: string; readonly message: string }[];
	readonly budgetUsage: Readonly<Record<string, number>>;
	readonly timings: Readonly<Record<string, number>>;
}

/** Response metadata fenced to one source revision. */
export interface ParadisOfficeDocumentResponseBase extends ParadisOfficeResponseMeta {
	readonly revision: Extract<ParadisOfficeRevision, { readonly kind: 'document' }>;
	readonly completeness: ParadisOfficeCompletenessManifest;
}

/** Response metadata fenced to both source revisions and the comparison revision. */
export interface ParadisOfficeComparisonResponseBase extends ParadisOfficeResponseMeta {
	readonly revision: Extract<ParadisOfficeRevision, { readonly kind: 'comparison' }>;
	readonly completeness: ParadisOfficeCompletenessManifest;
}

/** Response metadata accepted by operations that work with either handle kind. */
export type ParadisOfficeHandleResponseBase = ParadisOfficeDocumentResponseBase | ParadisOfficeComparisonResponseBase;

/** All v1 Office channel responses. */
export type ParadisOfficeResponse =
	| (ParadisOfficeDocumentResponseBase & { readonly ok: true; readonly operation: 'inspect'; readonly inventory: ParadisOfficeInventory })
	| (ParadisOfficeDocumentResponseBase & {
		readonly ok: true; readonly operation: 'open'; readonly handle: { readonly kind: 'document'; readonly id: string };
		readonly capabilities: readonly string[];
	})
	| (ParadisOfficeHandleResponseBase & { readonly ok: true; readonly operation: 'getViewport'; readonly tile: ParadisOfficeRenderTile })
	| (ParadisOfficeComparisonResponseBase & {
		readonly ok: true; readonly operation: 'compare'; readonly handle: { readonly kind: 'comparison'; readonly id: string };
		readonly changes: readonly ParadisOfficeChange[]; readonly nextCursor?: string; readonly terminal: boolean;
	})
	| (ParadisOfficeHandleResponseBase & { readonly ok: true; readonly operation: 'search'; readonly results: readonly ParadisOfficeSearchResult[]; readonly nextCursor?: string })
	| (ParadisOfficeHandleResponseBase & {
		readonly ok: true; readonly operation: 'getRenderableAsset'; readonly assetId: string; readonly offset: number;
		readonly totalLength: number; readonly bytes: VSBuffer;
	})
	| (ParadisOfficeHandleResponseBase & { readonly ok: true; readonly operation: 'getPrintModel'; readonly printModel: ParadisOfficePrintModel })
	| (ParadisOfficeHandleResponseBase & {
		readonly ok: true; readonly operation: 'exportPrint'; readonly assetId: string; readonly mime: 'application/pdf'; readonly byteLength: number;
	})
	| (ParadisOfficeResponseMeta & { readonly ok: true; readonly operation: 'close' | 'cancel'; readonly acknowledged: true })
	| {
		readonly version: 1; readonly requestId: string; readonly operation: ParadisOfficeRequest['operation']; readonly ok: false;
		readonly revision?: ParadisOfficeRevision; readonly outcome: Exclude<ParadisOfficeOutcome, 'complete'>;
		readonly completeness?: ParadisOfficeCompletenessManifest; readonly error: ParadisOfficeError;
	};

/** Value or change validation failure requiring a fingerprint fallback. */
export type ParadisOfficeValidationViolation = 'depth' | 'listItems' | 'recordFields' | 'stringLength' | 'fingerprint' | 'serializedBytes' | 'nonSerializable';

/** Result of validating one bounded value or change. */
export interface ParadisOfficeValidationResult {
	readonly valid: boolean;
	readonly serializedBytes: number;
	readonly violation?: ParadisOfficeValidationViolation;
	readonly path?: readonly (string | number)[];
}

/** Aggregates Part coverage using the normative required/optional rules. */
export function aggregateOfficeOutcome(parts: readonly ParadisOfficePartStatus[]): ParadisOfficeOutcome {
	let degraded = false;
	for (const part of parts) {
		if (part.required && (part.coverage === 'failed' || part.coverage === 'omittedByBudget')) {
			return 'blocked';
		}
		if (part.coverage !== 'parsed' && part.coverage !== 'completeOpaque') {
			degraded = true;
		}
	}
	return degraded ? 'degraded' : 'complete';
}

/** Returns true only when an empty complete result is safe to present as No Changes. */
export function canReportNoChanges(manifest: ParadisOfficeCompletenessManifest, outcome: ParadisOfficeOutcome, changeCount: number): boolean {
	return outcome === 'complete'
		&& changeCount === 0
		&& manifest.terminal
		&& manifest.expectedParts === manifest.visitedParts
		&& manifest.expectedSemanticUnits === manifest.visitedSemanticUnits
		&& manifest.failedParts === 0
		&& manifest.omittedParts === 0;
}

function serializedByteLength(value: object): number {
	return VSBuffer.fromString(JSON.stringify(value)).byteLength;
}

function validationFailure(serializedBytes: number, violation: ParadisOfficeValidationViolation, path: readonly (string | number)[]): ParadisOfficeValidationResult {
	return { valid: false, serializedBytes, violation, path };
}

function validateChangeValueNode(
	value: ParadisOfficeChangeValue,
	depth: number,
	path: readonly (string | number)[],
	ancestors: Set<object>,
): ParadisOfficeValidationResult | undefined {
	if (depth > PARADIS_OFFICE_LIMITS.maxChangeValueDepth) {
		return validationFailure(0, 'depth', path);
	}
	if (ancestors.has(value)) {
		return validationFailure(0, 'nonSerializable', path);
	}
	ancestors.add(value);
	try {
		switch (value.kind) {
			case 'none':
				return undefined;
			case 'scalar': {
				const matchesType = (value.valueType === 'text' || value.valueType === 'number') ? typeof value.value === 'string'
					: value.valueType === 'boolean' ? typeof value.value === 'boolean' : value.value === null;
				if (!matchesType) {
					return validationFailure(0, 'nonSerializable', path);
				}
				if (typeof value.value === 'string' && value.value.length > PARADIS_OFFICE_LIMITS.maxChangeValueStringLength) {
					return validationFailure(0, 'stringLength', [...path, 'value']);
				}
				return undefined;
			}
			case 'list':
				if (value.items.length > PARADIS_OFFICE_LIMITS.maxChangeValueListItems) {
					return validationFailure(0, 'listItems', path);
				}
				for (let index = 0; index < value.items.length; index++) {
					const childFailure = validateChangeValueNode(value.items[index], depth + 1, [...path, index], ancestors);
					if (childFailure) {
						return childFailure;
					}
				}
				return undefined;
			case 'record':
				if (value.fields.length > PARADIS_OFFICE_LIMITS.maxChangeValueRecordFields) {
					return validationFailure(0, 'recordFields', path);
				}
				for (let index = 0; index < value.fields.length; index++) {
					const field = value.fields[index];
					if (field.name.length > PARADIS_OFFICE_LIMITS.maxChangeValueStringLength) {
						return validationFailure(0, 'stringLength', [...path, index, 'name']);
					}
					const childFailure = validateChangeValueNode(field.value, depth + 1, [...path, index, 'value'], ancestors);
					if (childFailure) {
						return childFailure;
					}
				}
				return undefined;
			case 'fingerprint':
				return value.algorithm === 'sha256' && /^[a-f\d]{64}$/i.test(value.value) && Number.isSafeInteger(value.byteLength) && value.byteLength >= 0
					? undefined : validationFailure(0, 'fingerprint', path);
		}
	} finally {
		ancestors.delete(value);
	}
}

/** Validates recursive value limits. Invalid subtrees must be replaced by a full-byte fingerprint value. */
export function validateOfficeChangeValue(value: ParadisOfficeChangeValue): ParadisOfficeValidationResult {
	const failure = validateChangeValueNode(value, 1, [], new Set<object>());
	let bytes = 0;
	try {
		bytes = serializedByteLength(value);
	} catch {
		return validationFailure(0, 'nonSerializable', failure?.path ?? []);
	}
	return failure ? { ...failure, serializedBytes: bytes } : { valid: true, serializedBytes: bytes };
}

/** Validates both recursive values and the 64 KiB serialized change limit. */
export function validateOfficeChange(change: ParadisOfficeChange): ParadisOfficeValidationResult {
	const before = validateOfficeChangeValue(change.before);
	if (!before.valid) {
		return { ...before, path: ['before', ...(before.path ?? [])] };
	}
	const after = validateOfficeChangeValue(change.after);
	if (!after.valid) {
		return { ...after, path: ['after', ...(after.path ?? [])] };
	}
	if (!isOfficeSerializableData(change)) {
		return validationFailure(0, 'nonSerializable', []);
	}
	const bytes = serializedByteLength(change);
	return bytes <= PARADIS_OFFICE_LIMITS.maxChangeSerializedBytes
		? { valid: true, serializedBytes: bytes }
		: validationFailure(bytes, 'serializedBytes', []);
}

function revisionIdentity(revision: ParadisOfficeRevision): string {
	return revision.kind === 'document'
		? `d:${revision.sourceRevision.length}:${revision.sourceRevision}`
		: `c:${revision.originalRevision.length}:${revision.originalRevision}`
		+ `${revision.modifiedRevision.length}:${revision.modifiedRevision}`
		+ `${revision.comparisonRevision.length}:${revision.comparisonRevision}`;
}

const officeCursorPrefix = 'office-v1:';

/** Creates an opaque cursor fenced to the exact document or comparison revision. */
export function createOfficeCursor(revision: ParadisOfficeRevision, continuation: string): string {
	const identity = revisionIdentity(revision);
	const cursor = `${officeCursorPrefix}${identity.length}:${continuation.length}:${identity}${continuation}`;
	if (cursor.length > PARADIS_OFFICE_LIMITS.maxCursorLength) {
		throw new RangeError('Office cursor exceeds the protocol limit');
	}
	return cursor;
}

/** Reads a cursor only when its shape, length, and revision fence are valid. */
export function readOfficeCursor(cursor: string, revision: ParadisOfficeRevision): string | undefined {
	if (!cursor.startsWith(officeCursorPrefix) || cursor.length > PARADIS_OFFICE_LIMITS.maxCursorLength) {
		return undefined;
	}
	const header = /^(\d+):(\d+):/.exec(cursor.slice(officeCursorPrefix.length));
	if (!header) {
		return undefined;
	}
	const identityLength = Number(header[1]);
	const continuationLength = Number(header[2]);
	if (!Number.isSafeInteger(identityLength) || !Number.isSafeInteger(continuationLength)) {
		return undefined;
	}
	const valueOffset = officeCursorPrefix.length + header[0].length;
	if (valueOffset + identityLength + continuationLength !== cursor.length) {
		return undefined;
	}
	const identity = cursor.slice(valueOffset, valueOffset + identityLength);
	return identity === revisionIdentity(revision) ? cursor.slice(valueOffset + identityLength) : undefined;
}

/** Checks the serialized size supplied by the v1 transport serializer. */
export function isOfficeSerializedPayloadWithinBudget(serializedByteLength: number): boolean {
	return Number.isSafeInteger(serializedByteLength)
		&& serializedByteLength >= 0
		&& serializedByteLength <= PARADIS_OFFICE_LIMITS.maxSerializedResponseBytes;
}

/** Checks a requested allowlisted asset range before reading bytes. */
export function isOfficeAssetRequestWithinBudget(offset: number, length: number): boolean {
	return Number.isSafeInteger(offset)
		&& offset >= 0
		&& Number.isSafeInteger(length)
		&& length > 0
		&& length <= PARADIS_OFFICE_LIMITS.maxAssetRequestBytes
		&& Number.isSafeInteger(offset + length);
}

/** Runtime guard for the cyclic-free plain-data subset accepted by Office IPC. */
export function isOfficeSerializableData(value: unknown): value is ParadisOfficeSerializableData {
	const ancestors = new Set<object>();
	const visit = (candidate: unknown): boolean => {
		if (candidate === null || typeof candidate === 'string' || typeof candidate === 'boolean') {
			return true;
		}
		if (typeof candidate === 'number') {
			return Number.isFinite(candidate);
		}
		if (candidate instanceof VSBuffer) {
			return true;
		}
		if (typeof candidate !== 'object' || ancestors.has(candidate)) {
			return false;
		}
		const prototype = Object.getPrototypeOf(candidate);
		if (!Array.isArray(candidate) && prototype !== Object.prototype && prototype !== null) {
			return false;
		}
		if (Object.getOwnPropertySymbols(candidate).length > 0) {
			return false;
		}
		ancestors.add(candidate);
		try {
			return Array.isArray(candidate)
				? candidate.every(visit)
				: Object.values(candidate).every(visit);
		} catch {
			return false;
		} finally {
			ancestors.delete(candidate);
		}
	};
	return visit(value);
}
