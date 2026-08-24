/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import { createHash, randomBytes } from 'crypto';
import { RunOnceScheduler } from '../../../../base/common/async.js';
import { VSBuffer } from '../../../../base/common/buffer.js';
import {
	buildParadisOfficeSourceRevision,
	IOfficeSpoolClient,
	IOfficeSpoolExpiryScheduler,
	PARADIS_OFFICE_SPOOL_CHUNK_BYTES,
	PARADIS_OFFICE_SPOOL_GLOBAL_LIMIT,
	PARADIS_OFFICE_SPOOL_LIMITS,
	PARADIS_OFFICE_SPOOL_PER_CLIENT_LIMIT,
	PARADIS_OFFICE_UNSEALED_SPOOL_EXPIRY_MILLISECONDS,
	ParadisOfficeSealRequest,
	ParadisOfficeSealedSpoolReference,
	ParadisOfficeSpoolLimits,
	ParadisOfficeSpoolReference,
	ParadisOfficeWritableSpoolReference,
	snapshotParadisOfficeBuffer,
	snapshotParadisOfficeSealedSpoolAttempt,
	validateParadisOfficeSealRequest,
	validateParadisOfficeSpoolOwner,
	validateParadisOfficeWritableSpoolReference,
} from '../common/paradisOfficeSourceBroker.js';
import type { ParadisOfficeBudgetProfile } from '../common/paradisOfficeProtocol.js';

export type OfficeSpoolStoreErrorCode =
	| 'invalidReference'
	| 'clientQuota'
	| 'globalQuota'
	| 'chunkTooLarge'
	| 'sourceByteQuota'
	| 'globalByteQuota'
	| 'notWritable'
	| 'notSealed'
	| 'integrityMismatch'
	| 'invalidRange'
	| 'invalidChunk'
	| 'initializationFailed'
	| 'randomnessUnavailable';

export class OfficeSpoolStoreError extends Error {
	override readonly name = 'OfficeSpoolStoreError';

	constructor(readonly code: OfficeSpoolStoreErrorCode) {
		super('The Office spool operation was rejected.');
		Object.defineProperty(this, 'stack', { configurable: true, value: '' });
	}
}

export interface OfficeSpoolStoreOptions {
	readonly platform: ParadisOfficeBudgetProfile['kind'];
	readonly limits?: ParadisOfficeSpoolLimits;
	readonly randomBytes?: (length: number) => Uint8Array;
	readonly now?: () => number;
	readonly createExpiryScheduler?: (runner: () => void) => IOfficeSpoolExpiryScheduler;
}

export interface OfficeSpoolOpenedSource {
	readonly size: number;
	readonly sha256: string;
	readonly revision: string;
	read(offset: number, length: number): Promise<VSBuffer>;
}

interface SpoolEntry {
	readonly id: string;
	readonly ownerId: string;
	readonly nonce: string;
	state: 'writable' | 'sealed' | 'opening';
	readonly chunks: VSBuffer[];
	readonly hash: ReturnType<typeof createHash>;
	byteLength: number;
	readonly expiresAt: number;
	readonly expiryScheduler: IOfficeSpoolExpiryScheduler;
	sealed?: ParadisOfficeSealedSpoolReference;
}

function defaultExpiryScheduler(runner: () => void): IOfficeSpoolExpiryScheduler {
	return new RunOnceScheduler(runner, PARADIS_OFFICE_UNSEALED_SPOOL_EXPIRY_MILLISECONDS);
}

function hex(bytes: Uint8Array): string {
	let result = '';
	for (const byte of bytes) {
		result += byte.toString(16).padStart(2, '0');
	}
	return result;
}

function validLimit(value: number): boolean {
	return Number.isSafeInteger(value) && value >= 0;
}

const MAX_RANDOM_ID_ATTEMPTS = 64;

/** Backend-local one-shot sealed spool store. It never exposes a filesystem path. */
export class OfficeSpoolStore implements IOfficeSpoolClient {
	private readonly entries = new Map<string, SpoolEntry>();
	private readonly limits: ParadisOfficeSpoolLimits;
	private readonly random: (length: number) => Uint8Array;
	private readonly now: () => number;
	private readonly createExpiryScheduler: (runner: () => void) => IOfficeSpoolExpiryScheduler;
	private totalBytes = 0;

	constructor(options: OfficeSpoolStoreOptions) {
		const limits = options.limits ?? PARADIS_OFFICE_SPOOL_LIMITS[options.platform];
		if (!limits || !validLimit(limits.compressedInputBytes) || !validLimit(limits.totalBytes)) {
			throw new TypeError('Invalid Office spool limits');
		}
		this.limits = { compressedInputBytes: limits.compressedInputBytes, totalBytes: limits.totalBytes };
		this.random = options.randomBytes ?? (length => randomBytes(length));
		this.now = options.now ?? Date.now;
		this.createExpiryScheduler = options.createExpiryScheduler ?? defaultExpiryScheduler;
	}

	get activeSpoolCount(): number {
		return this.entries.size;
	}

	get byteLength(): number {
		return this.totalBytes;
	}

	async begin(untrustedOwnerId: string): Promise<ParadisOfficeWritableSpoolReference> {
		const ownerId = validateParadisOfficeSpoolOwner(untrustedOwnerId);
		if (this.ownerEntryCount(ownerId) >= PARADIS_OFFICE_SPOOL_PER_CLIENT_LIMIT) {
			throw new OfficeSpoolStoreError('clientQuota');
		}
		if (this.entries.size >= PARADIS_OFFICE_SPOOL_GLOBAL_LIMIT) {
			throw new OfficeSpoolStoreError('globalQuota');
		}

		let id: string | undefined;
		try {
			for (let attempt = 0; attempt < MAX_RANDOM_ID_ATTEMPTS; attempt++) {
				const candidate = hex(this.random(24));
				if (!/^[a-f\d]{48}$/.test(candidate)) {
					throw new OfficeSpoolStoreError('randomnessUnavailable');
				}
				if (!this.entries.has(candidate)) {
					id = candidate;
					break;
				}
			}
		} catch (error) {
			const code = safeStoreErrorCode(error);
			if (code) {
				throw new OfficeSpoolStoreError(code);
			}
			throw new OfficeSpoolStoreError('randomnessUnavailable');
		}
		if (!id) {
			throw new OfficeSpoolStoreError('randomnessUnavailable');
		}
		let nonce: string;
		try {
			nonce = hex(this.random(32));
		} catch {
			throw new OfficeSpoolStoreError('randomnessUnavailable');
		}
		if (!/^[a-f\d]{64}$/.test(nonce)) {
			throw new OfficeSpoolStoreError('randomnessUnavailable');
		}
		const currentTime = this.readCurrentTime();
		const expiresAt = currentTime + PARADIS_OFFICE_UNSEALED_SPOOL_EXPIRY_MILLISECONDS;
		if (!Number.isSafeInteger(expiresAt)) {
			throw new TypeError('Invalid Office spool clock');
		}
		const entryHolder: { entry?: SpoolEntry } = {};
		const expiryScheduler = this.createExpiryScheduler(() => {
			if (entryHolder.entry) {
				this.expire(entryHolder.entry);
			}
		});
		const entry: SpoolEntry = {
			id,
			ownerId,
			nonce,
			state: 'writable',
			chunks: [],
			hash: createHash('sha256'),
			byteLength: 0,
			expiresAt,
			expiryScheduler,
		};
		entryHolder.entry = entry;
		this.entries.set(id, entry);
		try {
			expiryScheduler.schedule(PARADIS_OFFICE_UNSEALED_SPOOL_EXPIRY_MILLISECONDS);
		} catch {
			this.removeEntry(entry);
			throw new OfficeSpoolStoreError('initializationFailed');
		}
		return { id, ownerId, nonce };
	}

	async append(untrustedReference: ParadisOfficeWritableSpoolReference, untrustedBytes: VSBuffer): Promise<void> {
		const reference = validateParadisOfficeWritableSpoolReference(untrustedReference);
		let owned: VSBuffer;
		try {
			owned = snapshotParadisOfficeBuffer(untrustedBytes, PARADIS_OFFICE_SPOOL_CHUNK_BYTES);
		} catch (error) {
			if (isSafeRangeError(error)) {
				throw new OfficeSpoolStoreError('chunkTooLarge');
			}
			throw new OfficeSpoolStoreError('invalidChunk');
		}
		const entry = this.requireEntry(reference, true);
		if (entry.state !== 'writable') {
			throw new OfficeSpoolStoreError('notWritable');
		}
		if (entry.byteLength + owned.byteLength > this.limits.compressedInputBytes) {
			throw new OfficeSpoolStoreError('sourceByteQuota');
		}
		if (this.totalBytes + owned.byteLength > this.limits.totalBytes) {
			throw new OfficeSpoolStoreError('globalByteQuota');
		}
		entry.hash.update(owned.buffer);
		entry.chunks.push(owned);
		entry.byteLength += owned.byteLength;
		this.totalBytes += owned.byteLength;
	}

	async seal(
		untrustedReference: ParadisOfficeWritableSpoolReference,
		untrustedRequest: ParadisOfficeSealRequest,
	): Promise<ParadisOfficeSealedSpoolReference> {
		const reference = validateParadisOfficeWritableSpoolReference(untrustedReference);
		const request = validateParadisOfficeSealRequest(untrustedRequest);
		const entry = this.requireEntry(reference, true);
		if (entry.state !== 'writable') {
			throw new OfficeSpoolStoreError('notWritable');
		}
		const actualHash = entry.hash.digest('hex');
		const actualRevision = buildParadisOfficeSourceRevision(
			request.sourceKind,
			request.providerIdentity,
			request.providerRevision,
			entry.byteLength,
			actualHash,
		);
		if (request.size !== entry.byteLength || request.sha256 !== actualHash || request.revision !== actualRevision) {
			this.removeEntry(entry);
			throw new OfficeSpoolStoreError('integrityMismatch');
		}
		try {
			entry.expiryScheduler.dispose();
		} catch {
			this.removeEntry(entry);
			throw new OfficeSpoolStoreError('initializationFailed');
		}
		entry.sealed = { ...reference, ...request };
		entry.state = 'sealed';
		return { ...entry.sealed };
	}

	async open<T>(untrustedReference: ParadisOfficeSealedSpoolReference, consume: (source: OfficeSpoolOpenedSource) => Promise<T>): Promise<T> {
		const attempt = snapshotParadisOfficeSealedSpoolAttempt(untrustedReference);
		const consumeIsFunction = typeof consume === 'function';
		if (!attempt.identity) {
			throw new TypeError('Invalid sealed Office spool reference');
		}
		const entry = this.requireEntry(attempt.identity);
		if (entry.state === 'writable') {
			throw new OfficeSpoolStoreError('notSealed');
		}
		if (entry.state !== 'sealed' || !entry.sealed) {
			throw new OfficeSpoolStoreError('invalidReference');
		}
		if (!attempt.sealed || !this.sameSealedReference(entry.sealed, attempt.sealed) || !consumeIsFunction) {
			this.removeEntry(entry);
			throw new OfficeSpoolStoreError('invalidReference');
		}
		const sealed = attempt.sealed;
		entry.state = 'opening';
		const source: OfficeSpoolOpenedSource = Object.freeze({
			size: sealed.size,
			sha256: sealed.sha256,
			revision: sealed.revision,
			read: (offset: number, length: number) => this.read(entry, offset, length),
		});
		try {
			return await consume(source);
		} finally {
			this.removeEntry(entry);
		}
	}

	async dispose(untrustedReference: ParadisOfficeSpoolReference): Promise<void> {
		const reference = snapshotParadisOfficeSealedSpoolAttempt(untrustedReference).identity;
		if (!reference) {
			throw new TypeError('Invalid Office spool reference');
		}
		const entry = this.entries.get(reference.id);
		if (!entry) {
			return;
		}
		if (entry.ownerId !== reference.ownerId || entry.nonce !== reference.nonce) {
			throw new OfficeSpoolStoreError('invalidReference');
		}
		this.removeEntry(entry);
	}

	disconnect(untrustedOwnerId: string): void {
		const ownerId = validateParadisOfficeSpoolOwner(untrustedOwnerId);
		for (const entry of [...this.entries.values()]) {
			if (entry.ownerId === ownerId) {
				this.removeEntry(entry);
			}
		}
	}

	/** Backend crash/termination cleanup. */
	disposeAll(): void {
		for (const entry of [...this.entries.values()]) {
			this.removeEntry(entry);
		}
	}

	private ownerEntryCount(ownerId: string): number {
		let count = 0;
		for (const entry of this.entries.values()) {
			if (entry.ownerId === ownerId) {
				count++;
			}
		}
		return count;
	}

	private expire(entry: SpoolEntry): void {
		if (entry.state !== 'writable' || this.entries.get(entry.id) !== entry) {
			return;
		}
		let remaining: number;
		try {
			remaining = entry.expiresAt - this.readCurrentTime();
		} catch {
			this.removeEntry(entry);
			return;
		}
		if (remaining > 0) {
			try {
				entry.expiryScheduler.schedule(remaining);
			} catch {
				this.removeEntry(entry);
			}
			return;
		}
		this.removeEntry(entry);
	}

	private requireEntry(reference: ParadisOfficeWritableSpoolReference, enforceWritableDeadline = false): SpoolEntry {
		const entry = this.entries.get(reference.id);
		if (!entry || entry.ownerId !== reference.ownerId || entry.nonce !== reference.nonce) {
			throw new OfficeSpoolStoreError('invalidReference');
		}
		if (enforceWritableDeadline && entry.state === 'writable' && this.readCurrentTime() >= entry.expiresAt) {
			this.removeEntry(entry);
			throw new OfficeSpoolStoreError('invalidReference');
		}
		return entry;
	}

	private readCurrentTime(): number {
		const value = this.now();
		if (!Number.isSafeInteger(value)) {
			throw new TypeError('Invalid Office spool clock');
		}
		return value;
	}

	private sameSealedReference(expected: ParadisOfficeSealedSpoolReference, actual: ParadisOfficeSealedSpoolReference): boolean {
		return expected.id === actual.id
			&& expected.ownerId === actual.ownerId
			&& expected.nonce === actual.nonce
			&& expected.sourceKind === actual.sourceKind
			&& expected.providerIdentity === actual.providerIdentity
			&& expected.providerRevision === actual.providerRevision
			&& expected.size === actual.size
			&& expected.sha256 === actual.sha256
			&& expected.revision === actual.revision;
	}

	private async read(entry: SpoolEntry, offset: number, length: number): Promise<VSBuffer> {
		if (entry.state !== 'opening'
			|| !Number.isSafeInteger(offset) || offset < 0
			|| !Number.isSafeInteger(length) || length < 0 || length > PARADIS_OFFICE_SPOOL_CHUNK_BYTES
			|| offset + length > entry.byteLength) {
			throw new OfficeSpoolStoreError('invalidRange');
		}
		const result = VSBuffer.alloc(length);
		let sourceStart = 0;
		let resultOffset = 0;
		for (const chunk of entry.chunks) {
			const sourceEnd = sourceStart + chunk.byteLength;
			const copyStart = Math.max(offset, sourceStart);
			const copyEnd = Math.min(offset + length, sourceEnd);
			if (copyEnd > copyStart) {
				result.set(chunk.buffer.subarray(copyStart - sourceStart, copyEnd - sourceStart), resultOffset);
				resultOffset += copyEnd - copyStart;
			}
			sourceStart = sourceEnd;
			if (resultOffset === length) {
				break;
			}
		}
		return result;
	}

	private removeEntry(entry: SpoolEntry): void {
		if (this.entries.get(entry.id) !== entry) {
			return;
		}
		this.entries.delete(entry.id);
		this.totalBytes -= entry.byteLength;
		entry.chunks.length = 0;
		entry.byteLength = 0;
		try {
			entry.expiryScheduler.dispose();
		} catch {
			// Entry ownership and counters are already released.
		}
	}
}

function isSafeRangeError(value: unknown): boolean {
	try {
		return value instanceof RangeError;
	} catch {
		return false;
	}
}

function safeStoreErrorCode(value: unknown): OfficeSpoolStoreErrorCode | undefined {
	try {
		if (!(value instanceof OfficeSpoolStoreError)) {
			return undefined;
		}
		return value.code;
	} catch {
		return undefined;
	}
}
