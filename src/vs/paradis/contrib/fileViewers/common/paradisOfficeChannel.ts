/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import { VSBuffer } from '../../../../base/common/buffer.js';
import type { CancellationToken } from '../../../../base/common/cancellation.js';
import { PARADIS_SPREADSHEET_CHANNEL } from './paradisSpreadsheet.js';
import { createParadisOfficeError, type ParadisOfficeError, type ParadisOfficeErrorDetails } from './paradisOfficeErrors.js';
import {
	PARADIS_OFFICE_LIMITS,
	validateOfficeChange,
	type ParadisOfficeChangeCategory,
	type ParadisOfficeRequest,
	type ParadisOfficeResponse,
	type ParadisOfficeSourceDescriptor,
} from './paradisOfficeProtocol.js';

export const PARADIS_OFFICE_CHANNEL = 'officeDocument/v1';
export const PARADIS_OFFICE_PROTOCOL_VERSION = 1 as const;
export const PARADIS_OFFICE_LEGACY_PROTOCOL_VERSION = 0 as const;
export const PARADIS_OFFICE_OPERATIONS = ['inspect', 'open', 'getViewport', 'compare', 'search', 'getRenderableAsset', 'getPrintModel', 'exportPrint', 'close', 'cancel'] as const;

export interface ParadisOfficeV1Negotiation {
	readonly version: 1;
	readonly channel: typeof PARADIS_OFFICE_CHANNEL;
	readonly capabilities: typeof PARADIS_OFFICE_OPERATIONS;
}

export interface ParadisOfficeV0Negotiation {
	readonly version: 0;
	readonly channel: typeof PARADIS_SPREADSHEET_CHANNEL;
	readonly capabilities: readonly ['parseWorkbook'];
}

export type ParadisOfficeNegotiation = ParadisOfficeV1Negotiation | ParadisOfficeV0Negotiation;

export type ParadisOfficeRestoreState =
	| { readonly version: 1; readonly mode: 'document'; readonly source: ParadisOfficeSourceDescriptor }
	| { readonly version: 1; readonly mode: 'comparison'; readonly original: ParadisOfficeSourceDescriptor; readonly modified: ParadisOfficeSourceDescriptor };

export type ParadisOfficeControlRequest = Extract<ParadisOfficeRequest, { readonly operation: 'close' | 'cancel' }>;
export type ParadisOfficeCloseRequest = ParadisOfficeControlRequest & { readonly operation: 'close' };
export type ParadisOfficeCancelRequest = ParadisOfficeControlRequest & { readonly operation: 'cancel' };

/** Transport backend. Format adapters implement behavior; the channel owns validation and capabilities. */
export interface IParadisOfficeDocumentBackend {
	inspect(ownerId: string, request: Extract<ParadisOfficeRequest, { readonly operation: 'inspect' }>, token: CancellationToken): Promise<unknown>;
	open(ownerId: string, request: Extract<ParadisOfficeRequest, { readonly operation: 'open' }>, token: CancellationToken): Promise<unknown>;
	getViewport(ownerId: string, request: Extract<ParadisOfficeRequest, { readonly operation: 'getViewport' }>, token: CancellationToken): Promise<unknown>;
	compare(ownerId: string, request: Extract<ParadisOfficeRequest, { readonly operation: 'compare' }>, token: CancellationToken): Promise<unknown>;
	search(ownerId: string, request: Extract<ParadisOfficeRequest, { readonly operation: 'search' }>, token: CancellationToken): Promise<unknown>;
	getRenderableAsset(ownerId: string, request: Extract<ParadisOfficeRequest, { readonly operation: 'getRenderableAsset' }>, token: CancellationToken): Promise<unknown>;
	getPrintModel(ownerId: string, request: Extract<ParadisOfficeRequest, { readonly operation: 'getPrintModel' }>, token: CancellationToken): Promise<unknown>;
	exportPrint(ownerId: string, request: Extract<ParadisOfficeRequest, { readonly operation: 'exportPrint' }>, token: CancellationToken): Promise<unknown>;
	close(ownerId: string, request: ParadisOfficeCloseRequest, token: CancellationToken): Promise<unknown>;
	cancel(ownerId: string, request: ParadisOfficeCancelRequest, token: CancellationToken): Promise<unknown>;
	disconnect(ownerId: string): void;
}

export class ParadisOfficeWireError extends Error {
	override readonly name = 'ParadisOfficeWireError';
	constructor(readonly code: 'invalid' | 'payloadTooLarge' = 'invalid') {
		super('The Office protocol value was rejected.');
		Object.defineProperty(this, 'stack', { configurable: true, value: '' });
	}
}

interface WireSnapshot { readonly value: unknown; readonly bytes: number }
interface SnapshotState { readonly seen: Set<object>; nodes: number }

function wireError(code: 'invalid' | 'payloadTooLarge' = 'invalid'): never { throw new ParadisOfficeWireError(code); }

function stringWireBytes(value: string): number {
	return VSBuffer.fromString(JSON.stringify(value)).byteLength;
}

function dataDescriptor(value: object, key: PropertyKey): PropertyDescriptor & { readonly value: unknown } {
	const descriptor = Object.getOwnPropertyDescriptor(value, key);
	if (!descriptor?.enumerable || !Object.prototype.hasOwnProperty.call(descriptor, 'value')) { return wireError(); }
	return descriptor as PropertyDescriptor & { readonly value: unknown };
}

function arrayLengthDescriptor(value: unknown[]): number {
	const descriptor = Object.getOwnPropertyDescriptor(value, 'length');
	if (!descriptor || !Object.prototype.hasOwnProperty.call(descriptor, 'value') || typeof descriptor.value !== 'number' || !Number.isSafeInteger(descriptor.value) || descriptor.value < 0) { return wireError(); }
	return descriptor.value;
}

function snapshotWireValue(value: unknown, maximumBytes: number, state: SnapshotState, depth: number): WireSnapshot {
	if (++state.nodes > PARADIS_OFFICE_LIMITS.maxSerializableNodes || depth > PARADIS_OFFICE_LIMITS.maxSerializableDepth) { return wireError(); }
	if (value === null) { return { value: null, bytes: 4 }; }
	if (typeof value === 'string') { return { value, bytes: stringWireBytes(value) }; }
	if (typeof value === 'boolean') { return { value, bytes: value ? 4 : 5 }; }
	if (typeof value === 'number') {
		if (!Number.isFinite(value)) { return wireError(); }
		return { value, bytes: VSBuffer.fromString(JSON.stringify(value)).byteLength };
	}
	if (value instanceof VSBuffer) {
		return { value: VSBuffer.wrap(value.buffer.slice()), bytes: value.byteLength };
	}
	if (!value || typeof value !== 'object' || state.seen.has(value)) { return wireError(); }
	state.seen.add(value);
	try {
		if (Array.isArray(value)) {
			if (Object.getPrototypeOf(value) !== Array.prototype) { return wireError(); }
			const length = arrayLengthDescriptor(value);
			if (length > PARADIS_OFFICE_LIMITS.maxSerializableNodes - state.nodes) { return wireError(); }
			const keys = Reflect.ownKeys(value);
			if (keys.length !== length + 1 || keys.some(key => typeof key !== 'string' || (key !== 'length' && !/^\d+$/.test(key)))) { return wireError(); }
			let bytes = 2 + Math.max(0, length - 1);
			const result: unknown[] = [];
			for (let index = 0; index < length; index++) {
				const child = snapshotWireValue(dataDescriptor(value, String(index)).value, maximumBytes - bytes, state, depth + 1);
				bytes += child.bytes;
				if (bytes > maximumBytes) { return wireError('payloadTooLarge'); }
				result.push(child.value);
			}
			return { value: result, bytes };
		}
		const prototype = Object.getPrototypeOf(value);
		if (prototype !== Object.prototype && prototype !== null) { return wireError(); }
		const keys = Reflect.ownKeys(value);
		if (keys.length > PARADIS_OFFICE_LIMITS.maxSerializableNodes - state.nodes || keys.some(key => typeof key !== 'string')) { return wireError(); }
		let bytes = 2 + Math.max(0, keys.length - 1);
		const result: Record<string, unknown> = {};
		for (const key of keys as string[]) {
			bytes += stringWireBytes(key) + 1;
			if (bytes > maximumBytes) { return wireError('payloadTooLarge'); }
			const child = snapshotWireValue(dataDescriptor(value, key).value, maximumBytes - bytes, state, depth + 1);
			bytes += child.bytes;
			if (bytes > maximumBytes) { return wireError('payloadTooLarge'); }
			Object.defineProperty(result, key, { configurable: true, enumerable: true, writable: true, value: child.value });
		}
		return { value: result, bytes };
	} catch (error) {
		if (error instanceof ParadisOfficeWireError) { throw error; }
		return wireError();
	}
}

function wireEqual(left: unknown, right: unknown): boolean {
	if (left === right) { return true; }
	if (left instanceof VSBuffer && right instanceof VSBuffer) { return left.equals(right); }
	if (!left || !right || typeof left !== 'object' || typeof right !== 'object' || Array.isArray(left) !== Array.isArray(right)) { return false; }
	if (Array.isArray(left) && Array.isArray(right)) { return left.length === right.length && left.every((value, index) => wireEqual(value, right[index])); }
	const leftRecord = left as Record<string, unknown>;
	const rightRecord = right as Record<string, unknown>;
	const keys = Object.keys(leftRecord);
	return keys.length === Object.keys(rightRecord).length && keys.every(key => Object.prototype.hasOwnProperty.call(rightRecord, key) && wireEqual(leftRecord[key], rightRecord[key]));
}

function snapshotWire(value: unknown, maximumBytes: number): WireSnapshot {
	if (!Number.isSafeInteger(maximumBytes) || maximumBytes < 0) { return wireError(); }
	const first = snapshotWireValue(value, maximumBytes, { seen: new Set(), nodes: 0 }, 1);
	const second = snapshotWireValue(value, maximumBytes, { seen: new Set(), nodes: 0 }, 1);
	if (first.bytes > maximumBytes || second.bytes > maximumBytes) { return wireError('payloadTooLarge'); }
	if (first.bytes !== second.bytes || !wireEqual(first.value, second.value)) { return wireError(); }
	return second;
}

function record(value: unknown, required: readonly string[], optional: readonly string[] = []): Record<string, unknown> {
	if (!value || typeof value !== 'object' || Array.isArray(value) || value instanceof VSBuffer) { return wireError(); }
	const candidate = value as Record<string, unknown>;
	const keys = Object.keys(candidate);
	const allowed = new Set([...required, ...optional]);
	if (keys.some(key => !allowed.has(key)) || required.some(key => !Object.prototype.hasOwnProperty.call(candidate, key))) { return wireError(); }
	return candidate;
}

function openRecord(value: unknown, required: readonly string[]): Record<string, unknown> {
	if (!value || typeof value !== 'object' || Array.isArray(value) || value instanceof VSBuffer) { return wireError(); }
	const candidate = value as Record<string, unknown>;
	if (required.some(key => !Object.prototype.hasOwnProperty.call(candidate, key))) { return wireError(); }
	return candidate;
}

function exactKeys(value: Record<string, unknown>, required: readonly string[], optional: readonly string[] = []): void {
	const keys = Object.keys(value);
	const allowed = new Set([...required, ...optional]);
	if (keys.some(key => !allowed.has(key)) || required.some(key => !Object.prototype.hasOwnProperty.call(value, key))) { wireError(); }
}

function array(value: unknown, maximum: number = PARADIS_OFFICE_LIMITS.maxSerializableNodes): readonly unknown[] {
	if (!Array.isArray(value) || value.length > maximum) { return wireError(); }
	return value;
}

function string(value: unknown, maximum = 16 * 1024): string {
	if (typeof value !== 'string' || value.length > maximum) { return wireError(); }
	return value;
}

function nonNegativeInteger(value: unknown): number {
	if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) { return wireError(); }
	return value;
}

function finiteNumber(value: unknown): number {
	if (typeof value !== 'number' || !Number.isFinite(value)) { return wireError(); }
	return value;
}

function boolean(value: unknown): boolean {
	if (typeof value !== 'boolean') { return wireError(); }
	return value;
}

function oneOf<T extends string>(value: unknown, values: readonly T[]): T {
	if (typeof value !== 'string' || !values.includes(value as T)) { return wireError(); }
	return value as T;
}

function optionalString(value: unknown, maximum = 16 * 1024): void {
	if (value !== undefined) { string(value, maximum); }
}

function validateSource(value: unknown): void {
	const source = record(value, ['kind', 'displayName'], ['uri', 'revisionHint', 'side']);
	const kind = oneOf(source.kind, ['file', 'remote', 'gitCommit', 'gitIndex', 'workingTree', 'untitled', 'sideMissing'] as const);
	string(source.displayName, 4096);
	optionalString(source.uri, 16 * 1024);
	optionalString(source.revisionHint, 4096);
	if (source.side !== undefined) { oneOf(source.side, ['original', 'modified'] as const); }
	if (kind === 'sideMissing' && source.uri !== undefined) { wireError(); }
}

function validateHandle(value: unknown): void {
	const handle = record(value, ['kind', 'id']);
	oneOf(handle.kind, ['document', 'comparison'] as const);
	if (!/^[a-f\d]{48}$/.test(string(handle.id, 48))) { wireError(); }
}

function validateAssetId(value: unknown): string {
	const assetId = string(value, 256);
	if (!/^[A-Za-z\d][A-Za-z\d:_-]{0,255}$/.test(assetId) || /(?:^|[:_-])\.\.(?:$|[:_-])|%2f|%5c|file:/i.test(assetId)) { wireError(); }
	return assetId;
}

function validateRange(value: unknown): void {
	const range = array(value, 4);
	if (range.length !== 4) { wireError(); }
	for (const item of range) { nonNegativeInteger(item); }
}

function validatePageRange(value: unknown): void {
	const range = array(value, 2);
	if (range.length !== 2 || nonNegativeInteger(range[0]) < 1 || nonNegativeInteger(range[1]) < nonNegativeInteger(range[0])) { wireError(); }
}

function validateRequest(value: unknown): asserts value is ParadisOfficeRequest {
	const base = openRecord(value, ['version', 'requestId', 'operation']);
	if (base.version !== 1 || !/^[A-Za-z\d][A-Za-z\d._:-]{0,127}$/.test(string(base.requestId, 128))) { wireError(); }
	const operation = oneOf(base.operation, PARADIS_OFFICE_OPERATIONS);
	switch (operation) {
		case 'inspect': case 'open':
			exactKeys(base, ['version', 'requestId', 'operation', 'source']); validateSource(base.source); break;
		case 'getViewport':
			exactKeys(base, ['version', 'requestId', 'operation', 'handle', 'locator', 'range']); validateHandle(base.handle); string(base.locator); validateRange(base.range); break;
		case 'compare':
			exactKeys(base, ['version', 'requestId', 'operation', 'original', 'modified'], ['categories', 'cursor']); validateSource(base.original); validateSource(base.modified);
			if (base.categories !== undefined) { for (const category of array(base.categories, 7)) { oneOf(category, ['content', 'formatting', 'structure', 'annotation', 'revision', 'object', 'security'] satisfies readonly ParadisOfficeChangeCategory[]); } }
			optionalString(base.cursor, PARADIS_OFFICE_LIMITS.maxCursorLength); break;
		case 'search': {
			exactKeys(base, ['version', 'requestId', 'operation', 'handle', 'query'], ['options', 'cursor']); validateHandle(base.handle); string(base.query);
			if (base.options !== undefined) { const options = record(base.options, [], ['matchCase']); if (options.matchCase !== undefined) { boolean(options.matchCase); } }
			optionalString(base.cursor, PARADIS_OFFICE_LIMITS.maxCursorLength); break;
		}
		case 'getRenderableAsset': {
			exactKeys(base, ['version', 'requestId', 'operation', 'handle', 'assetId', 'offset', 'length']); validateHandle(base.handle);
			validateAssetId(base.assetId);
			const offset = nonNegativeInteger(base.offset);
			const length = nonNegativeInteger(base.length);
			if (length > PARADIS_OFFICE_LIMITS.maxAssetRequestBytes || !Number.isSafeInteger(offset + length)) { wireError(); }
			break;
		}
		case 'getPrintModel': {
			exactKeys(base, ['version', 'requestId', 'operation', 'handle', 'options']); validateHandle(base.handle);
			const options = record(base.options, ['includePlaceholders'], ['pageRange']); if (options.includePlaceholders !== true) { wireError(); } if (options.pageRange !== undefined) { validatePageRange(options.pageRange); } break;
		}
		case 'exportPrint':
			exactKeys(base, ['version', 'requestId', 'operation', 'handle', 'format'], ['pageRange']); validateHandle(base.handle); if (base.format !== 'pdf') { wireError(); } if (base.pageRange !== undefined) { validatePageRange(base.pageRange); } break;
		case 'close': case 'cancel':
			exactKeys(base, ['version', 'requestId', 'operation'], ['handle', 'targetRequestId']); if (base.handle !== undefined) { validateHandle(base.handle); } optionalString(base.targetRequestId, 128);
			if (operation === 'close' ? base.handle === undefined || base.targetRequestId !== undefined : base.handle === undefined && base.targetRequestId === undefined) { wireError(); }
			break;
	}
}

export function snapshotParadisOfficeRequest(value: unknown): ParadisOfficeRequest {
	const snapshot = snapshotWire(value, PARADIS_OFFICE_LIMITS.maxSerializedResponseBytes);
	validateRequest(snapshot.value);
	return snapshot.value;
}

export function negotiateParadisOffice(value: unknown): ParadisOfficeNegotiation {
	const snapshot = snapshotWire(value, 1024);
	const request = record(snapshot.value, ['versions']);
	const versions = array(request.versions, 2);
	if (versions.some(version => version !== 0 && version !== 1) || new Set(versions).size !== versions.length) { return wireError(); }
	if (versions.includes(1)) { return { version: 1, channel: PARADIS_OFFICE_CHANNEL, capabilities: PARADIS_OFFICE_OPERATIONS }; }
	if (versions.includes(0)) { return { version: 0, channel: PARADIS_SPREADSHEET_CHANNEL, capabilities: ['parseWorkbook'] }; }
	return wireError();
}

export function snapshotParadisOfficeRestoreState(value: unknown): ParadisOfficeRestoreState {
	const snapshot = snapshotWire(value, PARADIS_OFFICE_LIMITS.maxSerializedResponseBytes);
	const state = openRecord(snapshot.value, ['version', 'mode']);
	if (state.version !== 1) { return wireError(); }
	const mode = oneOf(state.mode, ['document', 'comparison'] as const);
	if (mode === 'document') { exactKeys(state, ['version', 'mode', 'source']); validateSource(state.source); }
	else { exactKeys(state, ['version', 'mode', 'original', 'modified']); validateSource(state.original); validateSource(state.modified); }
	return snapshot.value as ParadisOfficeRestoreState;
}

function validateWarnings(value: unknown): void {
	for (const warningValue of array(value, 4096)) {
		const warning = record(warningValue, ['code', 'message']);
		if (!/^[A-Za-z][A-Za-z\d._-]{0,127}$/.test(string(warning.code, 128))) { wireError(); }
		string(warning.message, 16 * 1024);
	}
}

function validateNumberRecord(value: unknown): void {
	if (!value || typeof value !== 'object' || Array.isArray(value) || value instanceof VSBuffer) { wireError(); }
	const values = value as Record<string, unknown>;
	if (Object.keys(values).length > 128) { wireError(); }
	for (const [key, number] of Object.entries(values)) {
		if (!/^[A-Za-z][A-Za-z\d._-]{0,127}$/.test(key) || finiteNumber(number) < 0) { wireError(); }
	}
}

function validateCompleteness(value: unknown): void {
	const manifest = record(value, ['expectedParts', 'visitedParts', 'parsedParts', 'opaqueParts', 'failedParts', 'omittedParts', 'expectedSemanticUnits', 'visitedSemanticUnits', 'terminal']);
	for (const key of ['expectedParts', 'visitedParts', 'parsedParts', 'opaqueParts', 'failedParts', 'omittedParts', 'expectedSemanticUnits', 'visitedSemanticUnits']) { nonNegativeInteger(manifest[key]); }
	boolean(manifest.terminal);
	if ((manifest.visitedParts as number) > (manifest.expectedParts as number) || (manifest.visitedSemanticUnits as number) > (manifest.expectedSemanticUnits as number)) { wireError(); }
}

function validateRevision(value: unknown): 'document' | 'comparison' {
	const revision = openRecord(value, ['kind']);
	if (revision.kind === 'document') { exactKeys(revision, ['kind', 'sourceRevision']); string(revision.sourceRevision, 4096); return 'document'; }
	if (revision.kind === 'comparison') { exactKeys(revision, ['kind', 'originalRevision', 'modifiedRevision', 'comparisonRevision']); string(revision.originalRevision, 4096); string(revision.modifiedRevision, 4096); string(revision.comparisonRevision, 4096); return 'comparison'; }
	return wireError();
}

function validateFingerprint(value: unknown): void {
	const fingerprint = record(value, ['algorithm', 'value', 'byteLength']);
	if (fingerprint.algorithm !== 'sha256' || !/^[a-f\d]{64}$/i.test(string(fingerprint.value, 64))) { wireError(); }
	nonNegativeInteger(fingerprint.byteLength);
}

function validateInventory(value: unknown): void {
	const inventory = record(value, ['format', 'container', 'parts', 'relationships', 'features', 'security', 'budgetProfile', 'budgetUsage']);
	oneOf(inventory.format, ['xlsx', 'xlsm', 'xltx', 'xltm', 'docx', 'docm', 'dotx', 'dotm', 'zip', 'cfbEncrypted', 'unknown'] as const);
	oneOf(inventory.container, ['opc', 'zip', 'cfb', 'unknown'] as const);
	for (const partValue of array(inventory.parts)) {
		const part = record(partValue, ['id', 'canonicalUri', 'contentType', 'compressedBytes', 'expandedBytes', 'required', 'coverage'], ['rawHash', 'hashCompleteness', 'canonicalHash', 'fingerprint']);
		string(part.id); string(part.canonicalUri); string(part.contentType); nonNegativeInteger(part.compressedBytes); nonNegativeInteger(part.expandedBytes); boolean(part.required);
		const coverage = oneOf(part.coverage, ['parsed', 'partial', 'opaque', 'completeOpaque', 'unsafe', 'failed', 'omittedByBudget'] as const);
		if (part.rawHash !== undefined) { validateFingerprint(part.rawHash); } if (part.canonicalHash !== undefined) { validateFingerprint(part.canonicalHash); } if (part.fingerprint !== undefined) { validateFingerprint(part.fingerprint); }
		if (part.hashCompleteness !== undefined) { oneOf(part.hashCompleteness, ['allBytes', 'incomplete'] as const); }
		if (coverage === 'completeOpaque' && (part.fingerprint === undefined || part.hashCompleteness !== 'allBytes' || part.rawHash !== undefined)) { wireError(); }
		if (coverage === 'parsed' && (part.rawHash === undefined || part.hashCompleteness !== 'allBytes' || part.fingerprint !== undefined)) { wireError(); }
		if (coverage !== 'completeOpaque' && part.fingerprint !== undefined) { wireError(); }
	}
	for (const relationshipValue of array(inventory.relationships)) {
		const relationship = record(relationshipValue, ['id', 'type', 'target', 'targetMode', 'missing', 'cyclic'], ['sourcePartId']);
		string(relationship.id); string(relationship.type); string(relationship.target); optionalString(relationship.sourcePartId); oneOf(relationship.targetMode, ['internal', 'external'] as const); boolean(relationship.missing); boolean(relationship.cyclic);
	}
	for (const featureValue of array(inventory.features)) {
		const feature = record(featureValue, ['kind', 'count', 'partIds', 'safety']);
		string(feature.kind); nonNegativeInteger(feature.count); for (const id of array(feature.partIds)) { string(id); } oneOf(feature.safety, ['safe', 'sanitized', 'metadataOnly', 'blocked'] as const);
	}
	const security = record(inventory.security, ['encrypted', 'hasMacros', 'hasExternalRelationships', 'hasEmbeddedObjects', 'hasProtection', 'hasSignatures']);
	for (const value of Object.values(security)) { boolean(value); }
	oneOf(inventory.budgetProfile, ['desktopLocal', 'remoteMobile', 'browser'] as const);
	const usage = record(inventory.budgetUsage, ['compressedInputBytes', 'expandedBytes', 'entryCount', 'largestPartBytes', 'totalMediaBytes', 'elapsedMilliseconds']);
	for (const value of Object.values(usage)) { nonNegativeInteger(value); }
}

function validateTextFormat(value: unknown): void {
	const format = record(value, [], ['bold', 'italic', 'underline', 'strike', 'foreground', 'background', 'fontFamily', 'fontSize', 'horizontalAlignment']);
	for (const key of ['bold', 'italic', 'strike']) { if (format[key] !== undefined) { boolean(format[key]); } }
	if (format.underline !== undefined) { oneOf(format.underline, ['single', 'double'] as const); }
	for (const key of ['foreground', 'background', 'fontFamily']) { optionalString(format[key], 4096); }
	if (format.fontSize !== undefined) { finiteNumber(format.fontSize); }
	if (format.horizontalAlignment !== undefined) { oneOf(format.horizontalAlignment, ['start', 'center', 'end', 'justify'] as const); }
}

function validateAnchor(value: unknown): void {
	const anchor = record(value, ['partUri', 'semanticPath', 'kind', 'ordinal', 'fingerprint']); string(anchor.partUri); for (const item of array(anchor.semanticPath)) { nonNegativeInteger(item); } string(anchor.kind); nonNegativeInteger(anchor.ordinal); string(anchor.fingerprint);
}

function validatePlaceholder(value: unknown): void {
	const placeholder = record(value, ['nodeId', 'feature', 'reason', 'title'], ['detail', 'fingerprint']); string(placeholder.nodeId); string(placeholder.feature); oneOf(placeholder.reason, ['unsupported', 'unsafe', 'notEvaluated', 'budget', 'noAnchor'] as const); string(placeholder.title); optionalString(placeholder.detail); optionalString(placeholder.fingerprint);
}

function validateTextRuns(value: unknown): void {
	for (const runValue of array(value)) { const run = record(runValue, ['text'], ['format']); string(run.text); if (run.format !== undefined) { validateTextFormat(run.format); } }
}

function validateRenderObject(value: unknown): void {
	const object = record(value, ['nodeId', 'coverage', 'kind'], ['assetId', 'altText', 'bounds', 'anchor']); string(object.nodeId); oneOf(object.coverage, ['rendered', 'approximated', 'placeholder', 'blockedByPolicy', 'noAnchor'] as const); oneOf(object.kind, ['rasterImage', 'sanitizedSvg', 'chart', 'shape', 'math', 'objectPreview'] as const); optionalString(object.assetId, 256); optionalString(object.altText); if (object.anchor !== undefined) { validateAnchor(object.anchor); }
	if (object.bounds !== undefined) { const bounds = record(object.bounds, ['x', 'y', 'width', 'height']); for (const value of Object.values(bounds)) { finiteNumber(value); } }
}

function validateRenderBlock(value: unknown, depth = 0): void {
	if (depth > 32) { wireError(); }
	const block = record(value, ['nodeId', 'coverage', 'kind'], ['runs', 'children', 'level', 'anchor']); string(block.nodeId); oneOf(block.coverage, ['rendered', 'approximated', 'placeholder', 'blockedByPolicy', 'noAnchor'] as const); oneOf(block.kind, ['paragraph', 'heading', 'table', 'tableRow', 'tableCell', 'list', 'listItem', 'section', 'story', 'unknown'] as const); if (block.runs !== undefined) { validateTextRuns(block.runs); } if (block.children !== undefined) { for (const child of array(block.children)) { validateRenderBlock(child, depth + 1); } } if (block.level !== undefined) { nonNegativeInteger(block.level); } if (block.anchor !== undefined) { validateAnchor(block.anchor); }
}

function validateTile(value: unknown): void {
	const tile = record(value, ['locator', 'range', 'cells', 'blocks', 'objects', 'placeholders'], ['side']); string(tile.locator); validateRange(tile.range); if (tile.side !== undefined) { oneOf(tile.side, ['original', 'modified', 'combined'] as const); }
	for (const cellValue of array(tile.cells)) { const cell = record(cellValue, ['nodeId', 'coverage', 'row', 'column', 'text'], ['value', 'format', 'rowSpan', 'columnSpan', 'anchor']); string(cell.nodeId); oneOf(cell.coverage, ['rendered', 'approximated', 'placeholder', 'blockedByPolicy', 'noAnchor'] as const); nonNegativeInteger(cell.row); nonNegativeInteger(cell.column); string(cell.text); if (cell.value !== undefined && !validateOfficeChange({ id: 'v', category: 'content', subject: { kind: 'cell', locator: 'v' }, before: cell.value, after: { kind: 'none' }, certainty: 'exact', sourceParts: [] }).valid) { wireError(); } if (cell.format !== undefined) { validateTextFormat(cell.format); } if (cell.rowSpan !== undefined) { nonNegativeInteger(cell.rowSpan); } if (cell.columnSpan !== undefined) { nonNegativeInteger(cell.columnSpan); } if (cell.anchor !== undefined) { validateAnchor(cell.anchor); } }
	for (const block of array(tile.blocks)) { validateRenderBlock(block); } for (const object of array(tile.objects)) { validateRenderObject(object); } for (const placeholder of array(tile.placeholders)) { validatePlaceholder(placeholder); }
}

function validateSearchResults(value: unknown): void {
	for (const resultValue of array(value)) { const result = record(resultValue, ['id', 'locator', 'preview', 'locationBadge'], ['navigableAnchor', 'side']); string(result.id); string(result.locator); const preview = record(result.preview, ['before', 'match', 'after']); string(preview.before); string(preview.match); string(preview.after); const badge = record(result.locationBadge, ['kind', 'label']); oneOf(badge.kind, ['sheet', 'story', 'object', 'placeholder', 'metadata'] as const); string(badge.label); optionalString(result.navigableAnchor); if (result.side !== undefined) { oneOf(result.side, ['original', 'modified', 'combined'] as const); } }
}

function validatePrintBlock(value: unknown, depth: number): void {
	if (depth > 32) { wireError(); }
	const block = openRecord(value, ['kind', 'nodeId']); string(block.nodeId);
	switch (oneOf(block.kind, ['text', 'container', 'object', 'placeholder'] as const)) {
		case 'text': exactKeys(block, ['kind', 'nodeId', 'runs']); validateTextRuns(block.runs); break;
		case 'container': exactKeys(block, ['kind', 'nodeId', 'role', 'children']); oneOf(block.role, ['section', 'table', 'row', 'cell', 'list'] as const); for (const child of array(block.children)) { validatePrintBlock(child, depth + 1); } break;
		case 'object': exactKeys(block, ['kind', 'nodeId', 'object']); validateRenderObject(block.object); break;
		case 'placeholder': exactKeys(block, ['kind', 'nodeId', 'placeholder']); validatePlaceholder(block.placeholder); break;
	}
}

function validatePrintModel(value: unknown): void {
	const model = record(value, ['title', 'pages', 'approximationWarnings']); string(model.title);
	for (const pageValue of array(model.pages)) { const page = record(pageValue, ['pageNumber', 'widthPoints', 'heightPoints', 'blocks', 'placeholders']); if (nonNegativeInteger(page.pageNumber) < 1) { wireError(); } finiteNumber(page.widthPoints); finiteNumber(page.heightPoints); for (const block of array(page.blocks)) { validatePrintBlock(block, 1); } for (const placeholder of array(page.placeholders)) { validatePlaceholder(placeholder); } }
	validateWarnings(model.approximationWarnings);
}

function validateError(value: unknown): void {
	const error = record(value, ['stage', 'code', 'safeMessage', 'severity', 'retryable', 'recoverable', 'userAction'], ['side', 'part', 'sanitizedCauseCode']);
	const stage = oneOf(error.stage, ['source', 'container', 'format', 'engine', 'transport', 'render', 'diff', 'export'] as const);
	const codes = { source: ['notFound', 'permission', 'changed', 'sideMissing', 'unsupportedScheme'], container: ['invalid', 'encrypted', 'zipBomb', 'limitExceeded'], format: ['unsupported', 'malformed', 'featureUnsupported'], engine: ['libraryMissing', 'versionMismatch', 'engineCrashed'], transport: ['timeout', 'cancelled', 'disconnected', 'payloadTooLarge'], render: ['cspBlocked', 'workerFailed', 'blank', 'outOfMemory'], diff: ['partial', 'truncated', 'stale', 'sideUnavailable'], export: ['printFailed', 'unsupported'] } as const;
	oneOf(error.code, codes[stage]); string(error.safeMessage, 1024); oneOf(error.severity, ['warning', 'error', 'fatal'] as const); boolean(error.retryable); boolean(error.recoverable); oneOf(error.userAction, ['none', 'retry', 'reopen', 'requestAccess', 'chooseAnotherFile', 'reduceDocumentSize', 'useLegacyViewer', 'openExternally', 'reconnect', 'updateClient'] as const); if (error.side !== undefined) { oneOf(error.side, ['original', 'modified'] as const); } optionalString(error.sanitizedCauseCode, 128);
	if (error.part !== undefined) { const part = record(error.part, ['safeId'], ['contentType', 'feature']); if (!/^[A-Za-z][A-Za-z\d._-]{0,63}:[A-Za-z\d][A-Za-z\d._-]{0,127}$/.test(string(part.safeId, 256))) { wireError(); } if (part.contentType !== undefined && !/^[a-z\d][a-z\d.+-]{0,63}\/[a-z\d][a-z\d.+-]{0,127}$/.test(string(part.contentType, 256))) { wireError(); } if (part.feature !== undefined && !/^[A-Za-z][A-Za-z\d._-]{0,127}$/.test(string(part.feature, 128))) { wireError(); } }
}

function projectError(error: ParadisOfficeError): ParadisOfficeError {
	const details: ParadisOfficeErrorDetails = { severity: error.severity, retryable: error.retryable, recoverable: error.recoverable, userAction: error.userAction, ...(error.side ? { side: error.side } : {}), ...(error.part ? { part: error.part } : {}), ...(error.sanitizedCauseCode ? { sanitizedCauseCode: error.sanitizedCauseCode } : {}) };
	switch (error.stage) {
		case 'source': return createParadisOfficeError(error.stage, error.code, details);
		case 'container': return createParadisOfficeError(error.stage, error.code, details);
		case 'format': return createParadisOfficeError(error.stage, error.code, details);
		case 'engine': return createParadisOfficeError(error.stage, error.code, details);
		case 'transport': return createParadisOfficeError(error.stage, error.code, details);
		case 'render': return createParadisOfficeError(error.stage, error.code, details);
		case 'diff': return createParadisOfficeError(error.stage, error.code, details);
		case 'export': return createParadisOfficeError(error.stage, error.code, details);
	}
}

function validateSuccessMeta(response: Record<string, unknown>): void {
	if (response.version !== 1 || response.ok !== true) { wireError(); }
	string(response.requestId, 128); oneOf(response.outcome, ['complete', 'degraded', 'blocked', 'sideMissing', 'cancelled', 'stale', 'failed'] as const); validateWarnings(response.warnings); validateNumberRecord(response.budgetUsage); validateNumberRecord(response.timings);
}

function validateResponse(value: unknown): asserts value is ParadisOfficeResponse {
	const response = openRecord(value, ['version', 'requestId', 'operation', 'ok', 'outcome']);
	if (response.version !== 1 || !/^[A-Za-z\d][A-Za-z\d._:-]{0,127}$/.test(string(response.requestId, 128))) { wireError(); }
	const operation = oneOf(response.operation, PARADIS_OFFICE_OPERATIONS);
	if (response.ok === false) {
		exactKeys(response, ['version', 'requestId', 'operation', 'ok', 'outcome', 'error'], ['revision', 'completeness']); oneOf(response.outcome, ['degraded', 'blocked', 'sideMissing', 'cancelled', 'stale', 'failed'] as const); validateError(response.error); if (response.revision !== undefined) { validateRevision(response.revision); } if (response.completeness !== undefined) { validateCompleteness(response.completeness); } return;
	}
	validateSuccessMeta(response);
	const meta = ['version', 'requestId', 'operation', 'ok', 'outcome', 'warnings', 'budgetUsage', 'timings'];
	if (operation === 'close' || operation === 'cancel') { exactKeys(response, [...meta, 'acknowledged']); if (response.acknowledged !== true) { wireError(); } return; }
	const requiredPayload = operation === 'inspect' ? ['inventory'] : operation === 'open' ? ['handle', 'capabilities'] : operation === 'getViewport' ? ['tile'] : operation === 'compare' ? ['handle', 'changes', 'terminal'] : operation === 'search' ? ['results'] : operation === 'getRenderableAsset' ? ['assetId', 'offset', 'totalLength', 'bytes'] : operation === 'getPrintModel' ? ['printModel'] : ['assetId', 'mime', 'byteLength'];
	const optionalPayload = operation === 'compare' || operation === 'search' ? ['nextCursor'] : [];
	exactKeys(response, [...meta, 'revision', 'completeness', ...requiredPayload], optionalPayload);
	const revisionKind = validateRevision(response.revision); validateCompleteness(response.completeness);
	switch (operation) {
		case 'inspect': if (revisionKind !== 'document') { wireError(); } validateInventory(response.inventory); break;
		case 'open': if (revisionKind !== 'document') { wireError(); } validateHandle(response.handle); for (const capability of array(response.capabilities, 256)) { string(capability, 128); } break;
		case 'getViewport': validateTile(response.tile); break;
		case 'compare': if (revisionKind !== 'comparison') { wireError(); } validateHandle(response.handle); for (const change of array(response.changes)) { if (!validateOfficeChange(change).valid) { wireError(); } } optionalString(response.nextCursor, PARADIS_OFFICE_LIMITS.maxCursorLength); boolean(response.terminal); break;
		case 'search': validateSearchResults(response.results); optionalString(response.nextCursor, PARADIS_OFFICE_LIMITS.maxCursorLength); break;
		case 'getRenderableAsset': { validateAssetId(response.assetId); const offset = nonNegativeInteger(response.offset); const totalLength = nonNegativeInteger(response.totalLength); if (!(response.bytes instanceof VSBuffer)) { wireError(); } const end = offset + response.bytes.byteLength; if (!Number.isSafeInteger(end) || end > totalLength) { wireError(); } break; }
		case 'getPrintModel': validatePrintModel(response.printModel); break;
		case 'exportPrint': validateAssetId(response.assetId); if (response.mime !== 'application/pdf') { wireError(); } nonNegativeInteger(response.byteLength); break;
	}
}

export function snapshotParadisOfficeResponse(value: unknown): ParadisOfficeResponse {
	const snapshot = snapshotWire(value, PARADIS_OFFICE_LIMITS.maxSerializedResponseBytes);
	validateResponse(snapshot.value);
	return snapshot.value.ok ? snapshot.value : { ...snapshot.value, error: projectError(snapshot.value.error) };
}

export function measureParadisOfficeWireBytes(value: unknown): number {
	return snapshotWire(value, PARADIS_OFFICE_LIMITS.maxSerializedResponseBytes).bytes;
}
