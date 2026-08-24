/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import { VSBuffer } from '../../../../base/common/buffer.js';
import type { CancellationToken } from '../../../../base/common/cancellation.js';
import { PARADIS_OFFICE_BUDGET_PROFILES, type ParadisOfficeBudgetProfile, type ParadisOfficeSourceDescriptor } from './paradisOfficeProtocol.js';

export type { ParadisOfficeSourceDescriptor } from './paradisOfficeProtocol.js';

export const PARADIS_OFFICE_SPOOL_CHUNK_BYTES = 2 * 1024 * 1024;
export const PARADIS_OFFICE_UNSEALED_SPOOL_EXPIRY_MILLISECONDS = 2 * 60 * 1000;
export const PARADIS_OFFICE_SPOOL_PER_CLIENT_LIMIT = 2;
export const PARADIS_OFFICE_SPOOL_GLOBAL_LIMIT = 8;

export interface ParadisOfficeSpoolLimits {
	readonly compressedInputBytes: number;
	readonly totalBytes: number;
}

/** Source and aggregate byte admission limits. The aggregate limits bound retained spool bytes. */
export const PARADIS_OFFICE_SPOOL_LIMITS: Readonly<Record<ParadisOfficeBudgetProfile['kind'], ParadisOfficeSpoolLimits>> = {
	desktopLocal: { compressedInputBytes: PARADIS_OFFICE_BUDGET_PROFILES.desktopLocal.compressedInputBytes, totalBytes: 256 * 1024 * 1024 },
	remoteMobile: { compressedInputBytes: PARADIS_OFFICE_BUDGET_PROFILES.remoteMobile.compressedInputBytes, totalBytes: 128 * 1024 * 1024 },
	browser: { compressedInputBytes: PARADIS_OFFICE_BUDGET_PROFILES.browser.compressedInputBytes, totalBytes: 96 * 1024 * 1024 },
};

/** Provider identity fence captured immediately before and after a brokered read. */
export interface ParadisOfficeProviderSnapshot {
	readonly identity: string;
	readonly revision: string;
}

/** Owner-bound opaque capability used while a spool is writable. */
export interface ParadisOfficeWritableSpoolReference {
	readonly id: string;
	readonly ownerId: string;
	readonly nonce: string;
}

/** Owner-bound lease known before a begin response is observed. */
export interface ParadisOfficeSpoolAttempt {
	readonly ownerId: string;
	readonly attemptId: string;
}

export type ParadisOfficeSpoolReference = ParadisOfficeWritableSpoolReference;

export type ParadisOfficeSpoolSourceKind = Extract<ParadisOfficeSourceDescriptor['kind'], 'remote' | 'gitCommit' | 'gitIndex' | 'workingTree' | 'untitled'>;

/** Integrity and provider fence submitted when a writable spool is sealed. */
export interface ParadisOfficeSealRequest {
	readonly sourceKind: ParadisOfficeSpoolSourceKind;
	readonly providerIdentity: string;
	readonly providerRevision: string;
	readonly size: number;
	readonly sha256: string;
	readonly revision: string;
}

/** Serializable capability accepted by the backend only after the spool store seals it. */
export interface ParadisOfficeSealedSpoolReference extends ParadisOfficeWritableSpoolReference, ParadisOfficeSealRequest { }

/** Serializable source routing result. No stream, watcher, file handle, or filesystem path crosses IPC. */
export type ParadisOfficeBackendSource =
	| {
		readonly kind: 'direct';
		readonly backend: 'local' | 'remote';
		readonly protocolVersion: 1;
		readonly descriptor: ParadisOfficeSourceDescriptor;
	}
	| {
		readonly kind: 'spool';
		readonly descriptor: ParadisOfficeSourceDescriptor;
		readonly spool: ParadisOfficeSealedSpoolReference;
	}
	| {
		readonly kind: 'sideMissing';
		readonly descriptor: ParadisOfficeSourceDescriptor;
	};

/** Workbench broker contract. */
export interface IOfficeSourceBroker {
	open(descriptor: ParadisOfficeSourceDescriptor, token: CancellationToken): Promise<ParadisOfficeBackendSource>;
}

/** IPC-capable spool client used by the workbench broker. `open` remains backend-local. */
export interface IOfficeSpoolClient {
	begin(ownerId: string, attemptId?: string): Promise<ParadisOfficeWritableSpoolReference>;
	append(reference: ParadisOfficeWritableSpoolReference, bytes: VSBuffer): Promise<void>;
	seal(reference: ParadisOfficeWritableSpoolReference, request: ParadisOfficeSealRequest): Promise<ParadisOfficeSealedSpoolReference>;
	dispose(reference: ParadisOfficeSpoolReference): Promise<void>;
	disposeAttempt(ownerId: string, attemptId: string): Promise<void>;
}

/** Workbench-owned provider adapter. This interface is local and is never serialized. Adapters should yield bounded buffers; the broker independently snapshots and chunks every yield. */
export interface IOfficeSourceProvider {
	snapshot(descriptor: ParadisOfficeSourceDescriptor): Promise<ParadisOfficeProviderSnapshot>;
	read(descriptor: ParadisOfficeSourceDescriptor, token: CancellationToken): AsyncIterable<VSBuffer>;
}

/** Incremental SHA-256 adapter supplied by the host that owns the provider bytes. */
export interface IOfficeSourceHash {
	update(bytes: VSBuffer): void;
	digest(): string | Promise<string>;
}

/** Minimal expiry abstraction. Production uses RunOnceScheduler; tests inject deterministic time. */
export interface IOfficeSpoolExpiryScheduler {
	schedule(delay: number): void;
	dispose(): void;
}

const sourceKinds: readonly ParadisOfficeSourceDescriptor['kind'][] = ['file', 'remote', 'gitCommit', 'gitIndex', 'workingTree', 'untitled', 'sideMissing'];
const spoolSourceKinds: readonly ParadisOfficeSpoolSourceKind[] = ['remote', 'gitCommit', 'gitIndex', 'workingTree', 'untitled'];
const identifierPattern = /^[A-Za-z\d][A-Za-z\d._:-]{0,255}$/;
const spoolIdPattern = /^[a-f\d]{48}$/;
const spoolNoncePattern = /^[a-f\d]{64}$/;
const sha256Pattern = /^[a-f\d]{64}$/;

interface DataRecord {
	readonly keys: readonly string[];
	readonly values: ReadonlyMap<string, unknown>;
}

function snapshotDataRecord(value: unknown, maximumKeys: number): DataRecord | undefined {
	if (typeof value !== 'object' || value === null || Array.isArray(value)) {
		return undefined;
	}
	try {
		const prototype = Object.getPrototypeOf(value);
		if (prototype !== Object.prototype && prototype !== null) {
			return undefined;
		}
		const ownKeys = Reflect.ownKeys(value);
		if (ownKeys.some(key => typeof key !== 'string')) {
			return undefined;
		}
		const keys = ownKeys as string[];
		if (keys.length > maximumKeys) {
			return undefined;
		}
		const values = new Map<string, unknown>();
		for (const key of keys) {
			const descriptor = Object.getOwnPropertyDescriptor(value, key);
			if (!descriptor?.enumerable || !Object.prototype.hasOwnProperty.call(descriptor, 'value')) {
				return undefined;
			}
			values.set(key, descriptor.value);
		}
		return { keys, values };
	} catch {
		return undefined;
	}
}

function dataRecord(value: unknown, allowedKeys: ReadonlySet<string>): DataRecord | undefined {
	const record = snapshotDataRecord(value, allowedKeys.size);
	return record && record.keys.every(key => allowedKeys.has(key)) ? record : undefined;
}

function dataValue(record: DataRecord, key: string): unknown {
	return record.values.get(key);
}

function isBoundedString(value: unknown, maximumLength: number): value is string {
	return typeof value === 'string' && value.length > 0 && value.length <= maximumLength;
}

function isNonNegativeSafeInteger(value: unknown): value is number {
	return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

function utf8Length(value: string): number {
	return VSBuffer.fromString(value).byteLength;
}

function revisionField(value: string): string {
	return `${utf8Length(value)}:${value}`;
}

/** Builds an unambiguous canonical revision from length-prefixed UTF-8 fields. */
export function buildParadisOfficeSourceRevision(
	kind: ParadisOfficeSpoolSourceKind,
	providerIdentity: string,
	providerRevision: string,
	size: number,
	sha256: string,
): string {
	if (!spoolSourceKinds.includes(kind)
		|| !isBoundedString(providerIdentity, 4096)
		|| !isBoundedString(providerRevision, 4096)
		|| !isNonNegativeSafeInteger(size)
		|| typeof sha256 !== 'string' || !sha256Pattern.test(sha256)) {
		throw new TypeError('Invalid Office source revision fields');
	}
	return `office-source/v1|${revisionField(kind)}|${revisionField(providerIdentity)}|${revisionField(providerRevision)}|${revisionField(String(size))}|${revisionField(sha256)}`;
}

/** Validates and copies an untrusted source descriptor without invoking accessors. */
export function validateParadisOfficeSourceDescriptor(value: unknown): ParadisOfficeSourceDescriptor {
	const record = dataRecord(value, new Set(['kind', 'uri', 'revisionHint', 'displayName', 'side']));
	if (!record) {
		throw new TypeError('Invalid Office source descriptor');
	}
	const kind = dataValue(record, 'kind');
	const uri = dataValue(record, 'uri');
	const revisionHint = dataValue(record, 'revisionHint');
	const displayName = dataValue(record, 'displayName');
	const side = dataValue(record, 'side');
	if (typeof kind !== 'string' || !sourceKinds.includes(kind as ParadisOfficeSourceDescriptor['kind'])
		|| (uri !== undefined && !isBoundedString(uri, 16 * 1024))
		|| (revisionHint !== undefined && !isBoundedString(revisionHint, 4096))
		|| !isBoundedString(displayName, 4096)
		|| (side !== undefined && side !== 'original' && side !== 'modified')) {
		throw new TypeError('Invalid Office source descriptor');
	}
	return {
		kind: kind as ParadisOfficeSourceDescriptor['kind'],
		...(typeof uri === 'string' ? { uri } : {}),
		...(typeof revisionHint === 'string' ? { revisionHint } : {}),
		displayName,
		...(side === 'original' || side === 'modified' ? { side } : {}),
	};
}

/** Validates an owner ID before it participates in quota accounting. */
export function validateParadisOfficeSpoolOwner(value: unknown): string {
	if (typeof value !== 'string' || !identifierPattern.test(value)) {
		throw new TypeError('Invalid Office spool owner');
	}
	return value;
}

/** Validates a pre-response owner-bound begin lease. */
export function validateParadisOfficeSpoolAttempt(ownerId: unknown, attemptId: unknown): ParadisOfficeSpoolAttempt {
	const safeOwnerId = validateParadisOfficeSpoolOwner(ownerId);
	if (typeof attemptId !== 'string' || !identifierPattern.test(attemptId)) {
		throw new TypeError('Invalid Office spool attempt');
	}
	return { ownerId: safeOwnerId, attemptId };
}

/** Reads only the three base capability fields and rejects accessors and unrelated fields. */
export function validateParadisOfficeWritableSpoolReference(value: unknown): ParadisOfficeWritableSpoolReference {
	const record = dataRecord(value, new Set(['id', 'ownerId', 'nonce']));
	if (!record || record.keys.length !== 3) {
		throw new TypeError('Invalid Office spool reference');
	}
	const id = dataValue(record, 'id');
	const ownerId = dataValue(record, 'ownerId');
	const nonce = dataValue(record, 'nonce');
	if (typeof id !== 'string' || !spoolIdPattern.test(id)
		|| typeof ownerId !== 'string' || !identifierPattern.test(ownerId)
		|| typeof nonce !== 'string' || !spoolNoncePattern.test(nonce)) {
		throw new TypeError('Invalid Office spool reference');
	}
	return { id, ownerId, nonce };
}

/** Validates the complete sealed capability shape and returns a fresh copy. */
export function validateParadisOfficeSealedSpoolReference(value: unknown): ParadisOfficeSealedSpoolReference {
	const snapshot = snapshotParadisOfficeSealedSpoolAttempt(value);
	if (!snapshot.sealed) {
		throw new TypeError('Invalid sealed Office spool reference');
	}
	return snapshot.sealed;
}

export interface ParadisOfficeSealedSpoolAttemptSnapshot {
	readonly identity?: ParadisOfficeWritableSpoolReference;
	readonly writable?: ParadisOfficeWritableSpoolReference;
	readonly sealed?: ParadisOfficeSealedSpoolReference;
}

/** Snapshots a full untrusted open capability once, retaining only validated fields. */
export function snapshotParadisOfficeSealedSpoolAttempt(value: unknown): ParadisOfficeSealedSpoolAttemptSnapshot {
	const record = snapshotDataRecord(value, 16);
	if (!record) {
		return {};
	}
	let identity: ParadisOfficeWritableSpoolReference | undefined;
	try {
		identity = validateSpoolIdentityRecord(record);
	} catch {
		return {};
	}
	if (record.keys.length === 3 && record.keys.every(key => key === 'id' || key === 'ownerId' || key === 'nonce')) {
		return { identity, writable: identity };
	}
	const sealedKeys = new Set(['id', 'ownerId', 'nonce', 'sourceKind', 'providerIdentity', 'providerRevision', 'size', 'sha256', 'revision']);
	if (record.keys.length !== sealedKeys.size || !record.keys.every(key => sealedKeys.has(key))) {
		return { identity };
	}
	try {
		return { identity, sealed: { ...identity, ...validateSealRecord(record) } };
	} catch {
		return { identity };
	}
}

const typedArrayPrototype = Object.getPrototypeOf(Uint8Array.prototype) as object;
const typedArrayByteLengthGetter = Object.getOwnPropertyDescriptor(typedArrayPrototype, 'byteLength')?.get;

/** Copies an untrusted VSBuffer without invoking its methods or property getters. */
export function snapshotParadisOfficeBuffer(value: unknown, maximumBytes: number): VSBuffer {
	let exceedsMaximum = false;
	try {
		if (!Number.isSafeInteger(maximumBytes) || maximumBytes < 0 || !(value instanceof VSBuffer)) {
			throw new TypeError('Invalid Office buffer');
		}
		const keys = Reflect.ownKeys(value);
		const bufferDescriptor = Object.getOwnPropertyDescriptor(value, 'buffer');
		const byteLengthDescriptor = Object.getOwnPropertyDescriptor(value, 'byteLength');
		if (keys.length !== 2 || !keys.includes('buffer') || !keys.includes('byteLength')
			|| !bufferDescriptor?.enumerable || !Object.prototype.hasOwnProperty.call(bufferDescriptor, 'value')
			|| !byteLengthDescriptor?.enumerable || !Object.prototype.hasOwnProperty.call(byteLengthDescriptor, 'value')
			|| !(bufferDescriptor.value instanceof Uint8Array) || !ArrayBuffer.isView(bufferDescriptor.value)
			|| typeof byteLengthDescriptor.value !== 'number' || !Number.isSafeInteger(byteLengthDescriptor.value) || byteLengthDescriptor.value < 0
			|| !typedArrayByteLengthGetter) {
			throw new TypeError('Invalid Office buffer');
		}
		const actualLength = typedArrayByteLengthGetter.call(bufferDescriptor.value) as number;
		if (byteLengthDescriptor.value !== actualLength) {
			throw new TypeError('Invalid Office buffer');
		}
		if (actualLength > maximumBytes) {
			exceedsMaximum = true;
			throw new RangeError('Office buffer exceeds limit');
		}
		const result = VSBuffer.alloc(actualLength);
		Uint8Array.prototype.set.call(result.buffer, bufferDescriptor.value);
		if (result.byteLength !== actualLength || typedArrayByteLengthGetter.call(bufferDescriptor.value) !== actualLength) {
			throw new TypeError('Invalid Office buffer');
		}
		return result;
	} catch {
		if (exceedsMaximum) {
			throw new RangeError('Office buffer exceeds limit');
		}
		throw new TypeError('Invalid Office buffer');
	}
}

/** Validates seal metadata independently from a capability. */
export function validateParadisOfficeSealRequest(value: unknown): ParadisOfficeSealRequest {
	const record = dataRecord(value, new Set(['sourceKind', 'providerIdentity', 'providerRevision', 'size', 'sha256', 'revision']));
	if (!record || record.keys.length !== 6) {
		throw new TypeError('Invalid Office spool seal request');
	}
	return validateSealRecord(record);
}

function validateSpoolIdentityRecord(record: DataRecord): ParadisOfficeWritableSpoolReference {
	const id = dataValue(record, 'id');
	const ownerId = dataValue(record, 'ownerId');
	const nonce = dataValue(record, 'nonce');
	if (typeof id !== 'string' || !spoolIdPattern.test(id)
		|| typeof ownerId !== 'string' || !identifierPattern.test(ownerId)
		|| typeof nonce !== 'string' || !spoolNoncePattern.test(nonce)) {
		throw new TypeError('Invalid Office spool reference');
	}
	return { id, ownerId, nonce };
}

function validateSealRecord(record: DataRecord): ParadisOfficeSealRequest {
	const sourceKind = dataValue(record, 'sourceKind');
	const providerIdentity = dataValue(record, 'providerIdentity');
	const providerRevision = dataValue(record, 'providerRevision');
	const size = dataValue(record, 'size');
	const sha256 = dataValue(record, 'sha256');
	const revision = dataValue(record, 'revision');
	if (typeof sourceKind !== 'string' || !spoolSourceKinds.includes(sourceKind as ParadisOfficeSpoolSourceKind)
		|| !isBoundedString(providerIdentity, 4096)
		|| !isBoundedString(providerRevision, 4096)
		|| !isNonNegativeSafeInteger(size)
		|| typeof sha256 !== 'string' || !sha256Pattern.test(sha256)
		|| !isBoundedString(revision, 16 * 1024)) {
		throw new TypeError('Invalid Office spool seal request');
	}
	return {
		sourceKind: sourceKind as ParadisOfficeSpoolSourceKind,
		providerIdentity,
		providerRevision,
		size,
		sha256,
		revision,
	};
}
