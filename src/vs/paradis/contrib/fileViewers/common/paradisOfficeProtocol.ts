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

/** Part status consumed by outcome aggregation. completeOpaque proves every raw byte was hashed. */
export type ParadisOfficePartStatus =
	| {
		readonly coverage: 'completeOpaque';
		readonly required: boolean;
		readonly hashCompleteness: 'allBytes';
		readonly fingerprint: ParadisOfficeFingerprint;
	}
	| {
		readonly coverage: Exclude<ParadisOfficePartCoverage, 'completeOpaque'>;
		readonly required: boolean;
	};

/** V1 transport and semantic payload limits. */
export const PARADIS_OFFICE_LIMITS = {
	maxChangeValueDepth: 8,
	maxChangeValueListItems: 256,
	maxChangeValueRecordFields: 128,
	maxChangeValueStringLength: 4096, // Unicode code points; UTF-8 bytes are counted separately.
	maxChangeSerializedBytes: 64 * 1024,
	maxSerializedResponseBytes: 2 * 1024 * 1024,
	maxAssetRequestBytes: 2 * 1024 * 1024,
	maxCursorLength: 16 * 1024,
	maxSerializableDepth: 64,
	maxSerializableNodes: 65_536,
} as const;

/** Search text and indexed semantic text are always normalized by the backend. */
export const PARADIS_OFFICE_SEARCH_NORMALIZATION = 'NFC' as const;

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
export interface ParadisOfficeInventoryPartBase {
	readonly id: string;
	readonly canonicalUri: string;
	readonly contentType: string;
	readonly compressedBytes: number;
	readonly expandedBytes: number;
	readonly required: boolean;
	readonly canonicalHash?: ParadisOfficeFingerprint;
}

/** Inventory Part. The completeOpaque fingerprint is the raw hash over every byte. */
export type ParadisOfficeInventoryPart =
	| (ParadisOfficeInventoryPartBase & Extract<ParadisOfficePartStatus, { readonly coverage: 'completeOpaque' }>)
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
	readonly coverage: ParadisOfficeRenderCoverage;
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
	readonly coverage: ParadisOfficeRenderCoverage;
	readonly kind: 'paragraph' | 'heading' | 'table' | 'tableRow' | 'tableCell' | 'list' | 'listItem' | 'section' | 'story' | 'unknown';
	readonly runs?: readonly ParadisOfficeTextRun[];
	readonly children?: readonly ParadisOfficeRenderBlock[];
	readonly level?: number;
	readonly anchor?: ParadisOfficeRenderAnchorKey;
}

/** Typed safe object viewport primitive. */
export interface ParadisOfficeRenderObject {
	readonly nodeId: string;
	readonly coverage: ParadisOfficeRenderCoverage;
	readonly kind: 'rasterImage' | 'sanitizedSvg' | 'chart' | 'shape' | 'math' | 'objectPreview';
	readonly assetId?: string;
	readonly altText?: string;
	readonly bounds?: { readonly x: number; readonly y: number; readonly width: number; readonly height: number };
	readonly anchor?: ParadisOfficeRenderAnchorKey;
}

/** Renderer disposition of each semantic node, independent of analysis coverage. */
export type ParadisOfficeRenderCoverage = 'rendered' | 'approximated' | 'placeholder' | 'blockedByPolicy' | 'noAnchor';

/** Runtime guard for the fixed renderer coverage vocabulary. */
export function isOfficeRenderCoverage(value: unknown): value is ParadisOfficeRenderCoverage {
	return value === 'rendered' || value === 'approximated' || value === 'placeholder' || value === 'blockedByPolicy' || value === 'noAnchor';
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

/** Fields shared by every allowlisted asset metadata variant. */
export interface ParadisOfficeRenderableAssetBase {
	readonly id: string;
	readonly byteLength: number;
	readonly fingerprint: ParadisOfficeFingerprint;
	readonly altText?: string;
}

/** Safe raster image MIME types accepted by the renderable asset API. */
export type ParadisOfficeRasterMime = 'image/png' | 'image/jpeg' | 'image/gif' | 'image/webp';

/** Allowlisted asset metadata. Kind and MIME are a fixed discriminated pair. */
export type ParadisOfficeRenderableAsset = ParadisOfficeRenderableAssetBase & (
	| { readonly kind: 'rasterImage'; readonly mime: ParadisOfficeRasterMime }
	| { readonly kind: 'sanitizedSvg'; readonly mime: 'image/svg+xml' }
	| { readonly kind: 'fontSubset'; readonly mime: 'font/woff2' }
	| { readonly kind: 'chartPreview'; readonly mime: 'image/png' | 'image/svg+xml' }
	| { readonly kind: 'placeholderPreview'; readonly mime: 'image/png' | 'image/svg+xml' }
	| { readonly kind: 'generatedPdf'; readonly mime: 'application/pdf' }
);

/** Runtime guard for safe asset shape, hash, size, and kind/MIME correlation. */
export function isOfficeRenderableAsset(value: unknown): value is ParadisOfficeRenderableAsset {
	const descriptors = getRecordDescriptors(value, new Set(['id', 'kind', 'mime', 'byteLength', 'fingerprint', 'altText']));
	if (!descriptors || (Object.keys(descriptors).length !== 5 && Object.keys(descriptors).length !== 6)) {
		return false;
	}
	const id = getDataValue(descriptors, 'id');
	const kind = getDataValue(descriptors, 'kind');
	const mime = getDataValue(descriptors, 'mime');
	const byteLength = getDataValue(descriptors, 'byteLength');
	const fingerprint = getDataValue(descriptors, 'fingerprint');
	const fingerprintByteLength = getValidFingerprintByteLength(fingerprint);
	const altText = getDataValue(descriptors, 'altText');
	if (typeof id !== 'string' || typeof kind !== 'string' || typeof mime !== 'string'
		|| typeof byteLength !== 'number' || !Number.isSafeInteger(byteLength) || byteLength < 0
		|| fingerprintByteLength === undefined || fingerprintByteLength !== byteLength
		|| (altText !== undefined && typeof altText !== 'string')) {
		return false;
	}
	return (kind === 'rasterImage' && (mime === 'image/png' || mime === 'image/jpeg' || mime === 'image/gif' || mime === 'image/webp'))
		|| (kind === 'sanitizedSvg' && mime === 'image/svg+xml')
		|| (kind === 'fontSubset' && mime === 'font/woff2')
		|| (kind === 'chartPreview' && (mime === 'image/png' || mime === 'image/svg+xml'))
		|| (kind === 'placeholderPreview' && (mime === 'image/png' || mime === 'image/svg+xml'))
		|| (kind === 'generatedPdf' && mime === 'application/pdf');
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
		/** NFC normalization is mandatory in the backend and therefore is not a caller option. */
		readonly query: string; readonly options?: { readonly matchCase?: boolean }; readonly cursor?: string;
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

interface ParadisOfficeSerializableInspection {
	readonly valid: boolean;
	readonly serializedBytes: number;
	readonly violation?: 'serializedBytes' | 'nonSerializable';
}

function isDataDescriptor(descriptor: PropertyDescriptor | undefined): descriptor is PropertyDescriptor & { readonly value: unknown } {
	return descriptor !== undefined && Object.prototype.hasOwnProperty.call(descriptor, 'value');
}

function validationFailure(serializedBytes: number, violation: ParadisOfficeValidationViolation, path: readonly (string | number)[]): ParadisOfficeValidationResult {
	return { valid: false, serializedBytes, violation, path };
}

function getRecordDescriptors(value: unknown, allowedKeys?: ReadonlySet<string>): Readonly<Record<string, PropertyDescriptor>> | undefined {
	if (typeof value !== 'object' || value === null || Array.isArray(value) || value instanceof VSBuffer) {
		return undefined;
	}
	try {
		const prototype = Object.getPrototypeOf(value);
		if (prototype !== Object.prototype && prototype !== null) {
			return undefined;
		}
		const keys = Reflect.ownKeys(value);
		if (keys.some(key => typeof key !== 'string' || (allowedKeys !== undefined && !allowedKeys.has(key)))) {
			return undefined;
		}
		const descriptors = Object.getOwnPropertyDescriptors(value);
		for (const key of keys) {
			const descriptor = descriptors[key as string];
			if (!descriptor?.enumerable || !isDataDescriptor(descriptor)) {
				return undefined;
			}
		}
		return descriptors;
	} catch {
		return undefined;
	}
}

function getDataValue(descriptors: Readonly<Record<string, PropertyDescriptor>>, name: string): unknown {
	const descriptor = descriptors[name];
	return isDataDescriptor(descriptor) ? descriptor.value : undefined;
}

function getArrayLength(value: unknown): number | undefined {
	if (!Array.isArray(value)) {
		return undefined;
	}
	try {
		const descriptor = Object.getOwnPropertyDescriptor(value, 'length');
		const length = isDataDescriptor(descriptor) ? descriptor.value : undefined;
		return typeof length === 'number' && Number.isSafeInteger(length) && length >= 0 ? length : undefined;
	} catch {
		return undefined;
	}
}

function getDenseArrayValues(value: unknown, maximumLength: number): readonly unknown[] | undefined {
	if (!Array.isArray(value)) {
		return undefined;
	}
	try {
		if (Object.getPrototypeOf(value) !== Array.prototype) {
			return undefined;
		}
		const length = getArrayLength(value);
		if (length === undefined || length > maximumLength) {
			return undefined;
		}
		const keys = Reflect.ownKeys(value);
		if (keys.length !== length + 1 || keys.some(key => typeof key !== 'string' || (key !== 'length' && !/^\d+$/.test(key)))) {
			return undefined;
		}
		const descriptors = Object.getOwnPropertyDescriptors(value);
		const values: unknown[] = [];
		for (let index = 0; index < length; index++) {
			const descriptor = descriptors[String(index)];
			if (!descriptor?.enumerable || !isDataDescriptor(descriptor)) {
				return undefined;
			}
			values.push(descriptor.value);
		}
		return values;
	} catch {
		return undefined;
	}
}

function jsonStringByteLength(value: string, maximumBytes: number): number {
	if (value.length + 2 > maximumBytes) {
		return maximumBytes + 1;
	}
	let bytes = 2;
	for (let index = 0; index < value.length; index++) {
		const code = value.charCodeAt(index);
		if (code === 0x22 || code === 0x5c || code === 0x08 || code === 0x09 || code === 0x0a || code === 0x0c || code === 0x0d) {
			bytes += 2;
		} else if (code <= 0x1f || (code >= 0xdc00 && code <= 0xdfff)) {
			bytes += 6;
		} else if (code >= 0xd800 && code <= 0xdbff) {
			if (index + 1 < value.length) {
				const low = value.charCodeAt(index + 1);
				if (low >= 0xdc00 && low <= 0xdfff) {
					bytes += 4;
					index++;
				} else {
					bytes += 6;
				}
			} else {
				bytes += 6;
			}
		} else if (code <= 0x7f) {
			bytes++;
		} else if (code <= 0x7ff) {
			bytes += 2;
		} else {
			bytes += 3;
		}
		if (bytes > maximumBytes) {
			return maximumBytes + 1;
		}
	}
	return bytes;
}

function inspectSerializableData(value: unknown, maximumBytes: number): ParadisOfficeSerializableInspection {
	type WorkItem = { readonly value: unknown; readonly depth: number };
	const work: WorkItem[] = [{ value, depth: 1 }];
	const seen = new Set<object>();
	let serializedBytes = 0;
	let nodeCount = 0;
	const addBytes = (count: number): boolean => {
		serializedBytes += count;
		return serializedBytes <= maximumBytes;
	};
	while (work.length > 0) {
		const item = work.pop()!;
		if (++nodeCount > PARADIS_OFFICE_LIMITS.maxSerializableNodes || item.depth > PARADIS_OFFICE_LIMITS.maxSerializableDepth) {
			return { valid: false, serializedBytes, violation: 'nonSerializable' };
		}
		const candidate = item.value;
		if (candidate === null) {
			if (!addBytes(4)) {
				return { valid: false, serializedBytes, violation: 'serializedBytes' };
			}
			continue;
		}
		if (typeof candidate === 'string') {
			const remaining = maximumBytes - serializedBytes;
			if (!addBytes(jsonStringByteLength(candidate, remaining))) {
				return { valid: false, serializedBytes, violation: 'serializedBytes' };
			}
			continue;
		}
		if (typeof candidate === 'boolean') {
			if (!addBytes(candidate ? 4 : 5)) {
				return { valid: false, serializedBytes, violation: 'serializedBytes' };
			}
			continue;
		}
		if (typeof candidate === 'number') {
			if (!Number.isFinite(candidate) || !addBytes(String(candidate).length)) {
				return { valid: false, serializedBytes, violation: Number.isFinite(candidate) ? 'serializedBytes' : 'nonSerializable' };
			}
			continue;
		}
		if (candidate instanceof VSBuffer) {
			if (!addBytes(candidate.byteLength)) {
				return { valid: false, serializedBytes, violation: 'serializedBytes' };
			}
			continue;
		}
		if (typeof candidate !== 'object' || seen.has(candidate)) {
			return { valid: false, serializedBytes, violation: 'nonSerializable' };
		}
		seen.add(candidate);
		try {
			if (Array.isArray(candidate)) {
				const values = getDenseArrayValues(candidate, PARADIS_OFFICE_LIMITS.maxSerializableNodes);
				if (!values || !addBytes(2 + Math.max(0, values.length - 1))) {
					return { valid: false, serializedBytes, violation: values ? 'serializedBytes' : 'nonSerializable' };
				}
				for (let index = values.length - 1; index >= 0; index--) {
					work.push({ value: values[index], depth: item.depth + 1 });
				}
				continue;
			}
			const descriptors = getRecordDescriptors(candidate);
			if (!descriptors) {
				return { valid: false, serializedBytes, violation: 'nonSerializable' };
			}
			const keys = Object.keys(descriptors);
			if (!addBytes(2 + Math.max(0, keys.length - 1))) {
				return { valid: false, serializedBytes, violation: 'serializedBytes' };
			}
			for (let index = keys.length - 1; index >= 0; index--) {
				const key = keys[index];
				const remaining = maximumBytes - serializedBytes;
				if (!addBytes(jsonStringByteLength(key, remaining)) || !addBytes(1)) {
					return { valid: false, serializedBytes, violation: 'serializedBytes' };
				}
				work.push({ value: descriptors[key].value, depth: item.depth + 1 });
			}
		} catch {
			return { valid: false, serializedBytes, violation: 'nonSerializable' };
		}
	}
	return { valid: true, serializedBytes };
}

function getValidFingerprintByteLength(value: unknown): number | undefined {
	const descriptors = getRecordDescriptors(value, new Set(['kind', 'algorithm', 'value', 'byteLength']));
	if (!descriptors || (Object.keys(descriptors).length !== 3 && Object.keys(descriptors).length !== 4)) {
		return undefined;
	}
	const kind = getDataValue(descriptors, 'kind');
	const algorithm = getDataValue(descriptors, 'algorithm');
	const fingerprint = getDataValue(descriptors, 'value');
	const byteLength = getDataValue(descriptors, 'byteLength');
	return (kind === undefined || kind === 'fingerprint') && algorithm === 'sha256'
		&& typeof fingerprint === 'string' && /^[a-f\d]{64}$/i.test(fingerprint)
		&& typeof byteLength === 'number' && Number.isSafeInteger(byteLength) && byteLength >= 0 ? byteLength : undefined;
}

function isValidFingerprint(value: unknown): value is ParadisOfficeFingerprint {
	return getValidFingerprintByteLength(value) !== undefined;
}

/** Aggregates Part coverage using the normative required/optional rules. */
export function aggregateOfficeOutcome(parts: readonly ParadisOfficePartStatus[]): ParadisOfficeOutcome {
	let degraded = false;
	for (const part of parts) {
		const descriptors = getRecordDescriptors(part);
		if (!descriptors) {
			degraded = true;
			continue;
		}
		const coverage = getDataValue(descriptors, 'coverage');
		const required = getDataValue(descriptors, 'required');
		if (typeof required !== 'boolean' || typeof coverage !== 'string') {
			degraded = true;
			continue;
		}
		if (required && (coverage === 'failed' || coverage === 'omittedByBudget')) {
			return 'blocked';
		}
		if (coverage === 'completeOpaque') {
			if (getDataValue(descriptors, 'hashCompleteness') !== 'allBytes' || !isValidFingerprint(getDataValue(descriptors, 'fingerprint'))) {
				degraded = true;
			}
		} else if (coverage !== 'parsed') {
			degraded = true;
		}
	}
	return degraded ? 'degraded' : 'complete';
}

/** Returns true only when an empty complete result is safe to present as No Changes. */
export function canReportNoChanges(manifest: ParadisOfficeCompletenessManifest, outcome: ParadisOfficeOutcome, changeCount: number): boolean {
	const manifestDescriptors = getRecordDescriptors(manifest);
	if (!manifestDescriptors || outcome !== 'complete' || changeCount !== 0 || !Number.isSafeInteger(changeCount)) {
		return false;
	}
	const counterNames = [
		'expectedParts', 'visitedParts', 'parsedParts', 'opaqueParts', 'failedParts', 'omittedParts', 'expectedSemanticUnits', 'visitedSemanticUnits',
	] as const;
	const counters = counterNames.map(name => getDataValue(manifestDescriptors, name));
	if (counters.some(counter => typeof counter !== 'number' || !Number.isSafeInteger(counter) || counter < 0)
		|| getDataValue(manifestDescriptors, 'terminal') !== true) {
		return false;
	}
	const [expectedParts, visitedParts, parsedParts, opaqueParts, failedParts, omittedParts, expectedSemanticUnits, visitedSemanticUnits] = counters as number[];
	const categorizedParts = parsedParts + opaqueParts + failedParts + omittedParts;
	return Number.isSafeInteger(categorizedParts)
		&& visitedParts === categorizedParts
		&& visitedParts <= expectedParts
		&& expectedParts === visitedParts
		&& visitedSemanticUnits <= expectedSemanticUnits
		&& expectedSemanticUnits === visitedSemanticUnits
		&& failedParts === 0
		&& omittedParts === 0;
}

function hasAtMostCodePoints(value: string, maximum: number): boolean {
	let count = 0;
	for (const _character of value) {
		if (++count > maximum) {
			return false;
		}
	}
	return true;
}

function validateChangeValueStructure(value: unknown, serializedBytes: number): ParadisOfficeValidationResult {
	type WorkItem = { readonly value: unknown; readonly depth: number; readonly path: readonly (string | number)[] };
	const work: WorkItem[] = [{ value, depth: 1, path: [] }];
	while (work.length > 0) {
		const item = work.pop()!;
		if (item.depth > PARADIS_OFFICE_LIMITS.maxChangeValueDepth) {
			return validationFailure(serializedBytes, 'depth', item.path);
		}
		const descriptors = getRecordDescriptors(item.value);
		if (!descriptors) {
			return validationFailure(serializedBytes, 'nonSerializable', item.path);
		}
		const kind = getDataValue(descriptors, 'kind');
		if (kind === 'none') {
			if (Object.keys(descriptors).length !== 1) {
				return validationFailure(serializedBytes, 'nonSerializable', item.path);
			}
			continue;
		}
		if (kind === 'scalar') {
			if (Object.keys(descriptors).length !== 3) {
				return validationFailure(serializedBytes, 'nonSerializable', item.path);
			}
			const valueType = getDataValue(descriptors, 'valueType');
			const scalar = getDataValue(descriptors, 'value');
			const matches = (valueType === 'text' || valueType === 'number') ? typeof scalar === 'string'
				: valueType === 'boolean' ? typeof scalar === 'boolean' : valueType === 'null' && scalar === null;
			if (!matches) {
				return validationFailure(serializedBytes, 'nonSerializable', item.path);
			}
			if (typeof scalar === 'string' && !hasAtMostCodePoints(scalar, PARADIS_OFFICE_LIMITS.maxChangeValueStringLength)) {
				return validationFailure(serializedBytes, 'stringLength', [...item.path, 'value']);
			}
			continue;
		}
		if (kind === 'list') {
			if (Object.keys(descriptors).length !== 2) {
				return validationFailure(serializedBytes, 'nonSerializable', item.path);
			}
			const items = getDenseArrayValues(getDataValue(descriptors, 'items'), PARADIS_OFFICE_LIMITS.maxChangeValueListItems);
			if (!items) {
				const rawItemLength = getArrayLength(getDataValue(descriptors, 'items'));
				return validationFailure(serializedBytes, rawItemLength !== undefined && rawItemLength > PARADIS_OFFICE_LIMITS.maxChangeValueListItems ? 'listItems' : 'nonSerializable', item.path);
			}
			for (let index = items.length - 1; index >= 0; index--) {
				work.push({ value: items[index], depth: item.depth + 1, path: [...item.path, index] });
			}
			continue;
		}
		if (kind === 'record') {
			if (Object.keys(descriptors).length !== 2) {
				return validationFailure(serializedBytes, 'nonSerializable', item.path);
			}
			const fields = getDenseArrayValues(getDataValue(descriptors, 'fields'), PARADIS_OFFICE_LIMITS.maxChangeValueRecordFields);
			if (!fields) {
				const rawFieldLength = getArrayLength(getDataValue(descriptors, 'fields'));
				return validationFailure(serializedBytes, rawFieldLength !== undefined && rawFieldLength > PARADIS_OFFICE_LIMITS.maxChangeValueRecordFields ? 'recordFields' : 'nonSerializable', item.path);
			}
			for (let index = fields.length - 1; index >= 0; index--) {
				const fieldDescriptors = getRecordDescriptors(fields[index], new Set(['name', 'value']));
				const name = fieldDescriptors && getDataValue(fieldDescriptors, 'name');
				if (!fieldDescriptors || Object.keys(fieldDescriptors).length !== 2 || typeof name !== 'string') {
					return validationFailure(serializedBytes, 'nonSerializable', [...item.path, index]);
				}
				if (!hasAtMostCodePoints(name, PARADIS_OFFICE_LIMITS.maxChangeValueStringLength)) {
					return validationFailure(serializedBytes, 'stringLength', [...item.path, index, 'name']);
				}
				work.push({ value: getDataValue(fieldDescriptors, 'value'), depth: item.depth + 1, path: [...item.path, index, 'value'] });
			}
			continue;
		}
		if (kind === 'fingerprint') {
			if (!isValidFingerprint(item.value) || Object.keys(descriptors).length !== 4) {
				return validationFailure(serializedBytes, 'fingerprint', item.path);
			}
			continue;
		}
		return validationFailure(serializedBytes, 'nonSerializable', item.path);
	}
	return { valid: true, serializedBytes };
}

/** Validates recursive value limits using Unicode code points and a bounded UTF-8 JSON-size walk. */
export function validateOfficeChangeValue(value: unknown): ParadisOfficeValidationResult {
	const inspection = inspectSerializableData(value, PARADIS_OFFICE_LIMITS.maxChangeSerializedBytes);
	if (!inspection.valid) {
		return validationFailure(inspection.serializedBytes, inspection.violation ?? 'nonSerializable', []);
	}
	return validateChangeValueStructure(value, inspection.serializedBytes);
}

/** Validates both recursive values and the 64 KiB whole serialized change limit. */
export function validateOfficeChange(change: unknown): ParadisOfficeValidationResult {
	const inspection = inspectSerializableData(change, PARADIS_OFFICE_LIMITS.maxChangeSerializedBytes);
	if (!inspection.valid) {
		return validationFailure(inspection.serializedBytes, inspection.violation ?? 'nonSerializable', []);
	}
	const descriptors = getRecordDescriptors(change, new Set(['id', 'category', 'subject', 'before', 'after', 'certainty', 'sourceParts', 'navigableAnchor']));
	if (!descriptors) {
		return validationFailure(inspection.serializedBytes, 'nonSerializable', []);
	}
	const id = getDataValue(descriptors, 'id');
	const category = getDataValue(descriptors, 'category');
	const subject = getRecordDescriptors(getDataValue(descriptors, 'subject'), new Set(['kind', 'locator']));
	const certainty = getDataValue(descriptors, 'certainty');
	const sourceParts = getDenseArrayValues(getDataValue(descriptors, 'sourceParts'), PARADIS_OFFICE_LIMITS.maxSerializableNodes);
	const navigableAnchor = getDataValue(descriptors, 'navigableAnchor');
	const validCategories: readonly ParadisOfficeChangeCategory[] = ['content', 'formatting', 'structure', 'annotation', 'revision', 'object', 'security'];
	const validCertainties: readonly ParadisOfficeChange['certainty'][] = ['exact', 'normalized', 'heuristic', 'ambiguous', 'opaque', 'degraded'];
	if (typeof id !== 'string' || typeof category !== 'string' || !validCategories.includes(category as ParadisOfficeChangeCategory)
		|| !subject || Object.keys(subject).length !== 2 || typeof getDataValue(subject, 'kind') !== 'string' || typeof getDataValue(subject, 'locator') !== 'string'
		|| typeof certainty !== 'string' || !validCertainties.includes(certainty as ParadisOfficeChange['certainty'])
		|| !sourceParts || sourceParts.some(part => typeof part !== 'string')
		|| (navigableAnchor !== undefined && typeof navigableAnchor !== 'string')) {
		return validationFailure(inspection.serializedBytes, 'nonSerializable', []);
	}
	const before = validateChangeValueStructure(getDataValue(descriptors, 'before'), inspection.serializedBytes);
	if (!before.valid) {
		return { ...before, path: ['before', ...(before.path ?? [])] };
	}
	const after = validateChangeValueStructure(getDataValue(descriptors, 'after'), inspection.serializedBytes);
	return after.valid ? { valid: true, serializedBytes: inspection.serializedBytes } : { ...after, path: ['after', ...(after.path ?? [])] };
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
	return inspectSerializableData(value, PARADIS_OFFICE_LIMITS.maxSerializedResponseBytes).valid;
}
