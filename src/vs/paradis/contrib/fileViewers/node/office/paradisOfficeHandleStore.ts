/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import { randomBytes } from 'crypto';
import { RunOnceScheduler } from '../../../../../base/common/async.js';
import type { ParadisOfficeHandleRef } from '../../common/paradisOfficeProtocol.js';
import type { OfficeMemoryAccountant } from './paradisOfficeWorkerHost.js';

export const PARADIS_OFFICE_HANDLE_PER_CLIENT_LIMIT = 4;
export const PARADIS_OFFICE_HANDLE_IDLE_MILLISECONDS = 10 * 60 * 1000;
export const PARADIS_OFFICE_SEMANTIC_CACHE_LIMIT_BYTES = 512 * 1024 * 1024;

export interface IOfficeHandleTimer {
	schedule(delay: number): void;
	dispose(): void;
}

export interface OfficeHandleStoreOptions {
	readonly now?: () => number;
	readonly randomBytes?: (length: number) => Uint8Array;
	readonly setTimeout?: (runner: () => void, delay: number) => unknown;
	readonly clearTimeout?: (handle: unknown) => void;
	readonly createIdleTimer?: (runner: () => void) => IOfficeHandleTimer;
	readonly semanticCacheLimitBytes?: number;
	readonly accountant?: OfficeMemoryAccountant;
}

export type OfficeHandleCapability = ParadisOfficeHandleRef & {
	readonly ownerId: string;
	readonly nonce: string;
};

export interface OfficeHandleRecord {
	readonly kind: ParadisOfficeHandleRef['kind'];
	readonly sourceRevision: string;
	readonly memoryBytes: number;
	readonly workerId?: string;
	readonly active: boolean;
}

export type OfficeHandleStoreErrorCode = 'invalidInput' | 'quotaExceeded' | 'randomnessUnavailable';

export class OfficeHandleStoreError extends Error {
	override readonly name = 'OfficeHandleStoreError';

	constructor(readonly code: OfficeHandleStoreErrorCode) {
		super('The Office handle operation was rejected.');
		Object.defineProperty(this, 'stack', { configurable: true, value: '' });
	}
}

interface StoredHandle extends Omit<OfficeHandleRecord, 'active'> {
	readonly id: string;
	readonly ownerId: string;
	readonly nonce: string;
	readonly timer: IOfficeHandleTimer;
	lastUsed: number;
	idleDeadline: number;
	active: boolean;
}

interface StoredCache {
	readonly id: string;
	readonly bytes: number;
	lastUsed: number;
	active: boolean;
}

const ownerPattern = /^[A-Za-z\d][A-Za-z\d._:-]{0,255}$/;
const revisionPattern = /^[\x20-\x7e]{1,4096}$/;
const hexPattern = /^[a-f\d]+$/;
const maxRandomAttempts = 64;

function isSafeInteger(value: unknown): value is number {
	return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

function randomHex(random: (length: number) => Uint8Array, length: number): string {
	const bytes = random(length);
	if (!(bytes instanceof Uint8Array) || bytes.byteLength !== length) {
		throw new OfficeHandleStoreError('randomnessUnavailable');
	}
	let result = '';
	for (const byte of bytes) {
		result += byte.toString(16).padStart(2, '0');
	}
	return result;
}

function defaultIdleTimer(runner: () => void): IOfficeHandleTimer {
	return new RunOnceScheduler(runner, PARADIS_OFFICE_HANDLE_IDLE_MILLISECONDS);
}

function callbackIdleTimer(runner: () => void, setTimer: (runner: () => void, delay: number) => unknown, clearTimer: (handle: unknown) => void): IOfficeHandleTimer {
	let handle: unknown;
	return {
		schedule(delay: number): void {
			if (handle !== undefined) { clearTimer(handle); }
			handle = setTimer(() => { handle = undefined; runner(); }, delay);
		},
		dispose(): void {
			if (handle !== undefined) { clearTimer(handle); handle = undefined; }
		},
	};
}

/** Owner-bound, process-local Office handle registry. Capabilities are never reconstructable from serialized handle IDs. */
export class OfficeHandleStore {
	private readonly handles = new Map<string, StoredHandle>();
	private readonly cache = new Map<string, StoredCache>();
	private readonly now: () => number;
	private readonly random: (length: number) => Uint8Array;
	private readonly createIdleTimer: (runner: () => void) => IOfficeHandleTimer;
	private readonly semanticCacheLimitBytes: number;
	private readonly accountant: OfficeMemoryAccountant | undefined;
	private cacheBytes = 0;

	constructor(options: OfficeHandleStoreOptions = {}) {
		this.now = options.now ?? Date.now;
		this.random = options.randomBytes ?? (length => randomBytes(length));
		this.createIdleTimer = options.createIdleTimer
			?? (options.setTimeout && options.clearTimeout ? runner => callbackIdleTimer(runner, options.setTimeout!, options.clearTimeout!) : defaultIdleTimer);
		this.semanticCacheLimitBytes = options.semanticCacheLimitBytes ?? PARADIS_OFFICE_SEMANTIC_CACHE_LIMIT_BYTES;
		this.accountant = options.accountant;
		if (!isSafeInteger(this.semanticCacheLimitBytes)) {
			throw new OfficeHandleStoreError('invalidInput');
		}
	}

	get size(): number { return this.handles.size; }
	get semanticCacheBytes(): number { return this.cacheBytes; }

	create(ownerId: string, kind: ParadisOfficeHandleRef['kind'], sourceRevision: string, memoryBytes: number, workerId?: string): OfficeHandleCapability {
		if (!ownerPattern.test(ownerId) || (kind !== 'document' && kind !== 'comparison') || !revisionPattern.test(sourceRevision) || !isSafeInteger(memoryBytes)
			|| (workerId !== undefined && !ownerPattern.test(workerId))) {
			throw new OfficeHandleStoreError('invalidInput');
		}
		if (this.ownerCount(ownerId) >= PARADIS_OFFICE_HANDLE_PER_CLIENT_LIMIT) {
			throw new OfficeHandleStoreError('quotaExceeded');
		}
		let id: string | undefined;
		try {
			for (let attempt = 0; attempt < maxRandomAttempts; attempt++) {
				const candidate = randomHex(this.random, 24);
				if (!hexPattern.test(candidate) || candidate.length !== 48) {
					throw new OfficeHandleStoreError('randomnessUnavailable');
				}
				if (!this.handles.has(candidate)) {
					id = candidate;
					break;
				}
			}
		} catch (error) {
			throw error instanceof OfficeHandleStoreError ? error : new OfficeHandleStoreError('randomnessUnavailable');
		}
		if (!id) {
			throw new OfficeHandleStoreError('randomnessUnavailable');
		}
		let nonce: string | undefined;
		try {
			for (let attempt = 0; attempt < maxRandomAttempts; attempt++) {
				const candidate = randomHex(this.random, 32);
				if (hexPattern.test(candidate) && candidate.length === 64 && ![...this.handles.values()].some(entry => entry.nonce === candidate)) {
					nonce = candidate;
					break;
				}
			}
		} catch {
			throw new OfficeHandleStoreError('randomnessUnavailable');
		}
		if (!nonce) {
			throw new OfficeHandleStoreError('randomnessUnavailable');
		}
		const holder: { entry?: StoredHandle } = {};
		let timer: IOfficeHandleTimer;
		try {
			timer = this.createIdleTimer(() => holder.entry && this.remove(holder.entry));
		} catch {
			throw new OfficeHandleStoreError('invalidInput');
		}
		const createdAt = this.safeNow();
		const entry: StoredHandle = { id, ownerId, nonce, kind, sourceRevision, memoryBytes, workerId, active: false, lastUsed: createdAt, idleDeadline: createdAt + PARADIS_OFFICE_HANDLE_IDLE_MILLISECONDS, timer };
		holder.entry = entry;
		this.handles.set(id, entry);
		this.syncAccountant();
		try {
			timer.schedule(PARADIS_OFFICE_HANDLE_IDLE_MILLISECONDS);
		} catch {
			this.remove(entry);
			throw new OfficeHandleStoreError('invalidInput');
		}
		return { id, ownerId, nonce, kind };
	}

	get(capability: OfficeHandleCapability): OfficeHandleRecord | undefined {
		const entry = this.entryFor(capability);
		if (!entry) {
			return undefined;
		}
		if (this.expired(entry)) { this.remove(entry); return undefined; }
		this.touch(entry);
		return { kind: entry.kind, sourceRevision: entry.sourceRevision, memoryBytes: entry.memoryBytes, ...(entry.workerId ? { workerId: entry.workerId } : {}), active: entry.active };
	}

	setActive(capability: OfficeHandleCapability, active: boolean): boolean {
		const entry = this.entryFor(capability);
		if (!entry || typeof active !== 'boolean') {
			return false;
		}
		if (this.expired(entry)) { this.remove(entry); return false; }
		entry.active = active;
		this.touch(entry);
		return true;
	}

	close(capability: OfficeHandleCapability): boolean {
		const entry = this.entryFor(capability);
		if (!entry) {
			return false;
		}
		this.remove(entry);
		return true;
	}

	closeOwner(ownerId: string): void {
		if (!ownerPattern.test(ownerId)) { return; }
		for (const entry of [...this.handles.values()]) {
			if (entry.ownerId === ownerId) { this.remove(entry); }
		}
	}

	invalidateRevision(sourceRevision: string): void {
		if (!revisionPattern.test(sourceRevision)) { return; }
		for (const entry of [...this.handles.values()]) {
			if (entry.sourceRevision === sourceRevision) { this.remove(entry); }
		}
	}

	invalidateWorker(workerId: string): void {
		if (!ownerPattern.test(workerId)) { return; }
		for (const entry of [...this.handles.values()]) {
			if (entry.workerId === workerId) { this.remove(entry); }
		}
	}

	onEditorDispose(ownerId: string): void { this.closeOwner(ownerId); }
	onWindowClose(ownerId: string): void { this.closeOwner(ownerId); }
	onRendererCrash(ownerId: string): void { this.closeOwner(ownerId); }
	onRemoteDisconnect(ownerId: string): void { this.closeOwner(ownerId); }

	/** Adds or updates cache accounting and evicts inactive LRU entries before exceeding the fixed cache budget. */
	putSemanticCache(id: string, bytes: number, active = false): boolean {
		if (!ownerPattern.test(id) || !isSafeInteger(bytes) || typeof active !== 'boolean') { return false; }
		const previous = this.cache.get(id);
		if (previous) { this.cacheBytes -= previous.bytes; this.cache.delete(id); }
		this.evictInactiveCache(Math.max(0, bytes - (this.semanticCacheLimitBytes - this.cacheBytes)));
		if (bytes > this.semanticCacheLimitBytes - this.cacheBytes) { this.syncAccountant(); return false; }
		this.cache.set(id, { id, bytes, active, lastUsed: this.safeNow() });
		this.cacheBytes += bytes;
		this.syncAccountant();
		return true;
	}

	setSemanticCacheActive(id: string, active: boolean): boolean {
		const cache = this.cache.get(id);
		if (!cache || typeof active !== 'boolean') { return false; }
		cache.active = active;
		cache.lastUsed = this.safeNow();
		return true;
	}

	evictInactiveCache(requiredBytes = 0): number {
		if (!isSafeInteger(requiredBytes)) { return 0; }
		let released = 0;
		for (const entry of [...this.cache.values()].filter(value => !value.active).sort((a, b) => a.lastUsed - b.lastUsed)) {
			if (released >= requiredBytes && this.cacheBytes <= this.semanticCacheLimitBytes) { break; }
			this.cache.delete(entry.id);
			this.cacheBytes -= entry.bytes;
			released += entry.bytes;
		}
		this.syncAccountant();
		return released;
	}

	/** Releases least-recently-used non-active handles under memory pressure. */
	evictInactiveHandles(requiredBytes = 0): number {
		if (!isSafeInteger(requiredBytes)) { return 0; }
		let released = 0;
		for (const entry of [...this.handles.values()].filter(value => !value.active).sort((a, b) => a.lastUsed - b.lastUsed)) {
			if (released >= requiredBytes) { break; }
			released += entry.memoryBytes;
			this.remove(entry);
		}
		return released;
	}

	dispose(): void {
		for (const entry of [...this.handles.values()]) { this.remove(entry); }
		this.cache.clear();
		this.cacheBytes = 0;
		this.syncAccountant();
	}

	private ownerCount(ownerId: string): number {
		let count = 0;
		for (const entry of this.handles.values()) { if (entry.ownerId === ownerId) { count++; } }
		return count;
	}

	private entryFor(value: OfficeHandleCapability): StoredHandle | undefined {
		if (!value || typeof value !== 'object') { return undefined; }
		try {
			const descriptor = Object.getOwnPropertyDescriptor(value, 'id');
			const ownerDescriptor = Object.getOwnPropertyDescriptor(value, 'ownerId');
			const nonceDescriptor = Object.getOwnPropertyDescriptor(value, 'nonce');
			const kindDescriptor = Object.getOwnPropertyDescriptor(value, 'kind');
			if (!descriptor || !ownerDescriptor || !nonceDescriptor || !kindDescriptor
				|| !Object.prototype.hasOwnProperty.call(descriptor, 'value') || !Object.prototype.hasOwnProperty.call(ownerDescriptor, 'value')
				|| !Object.prototype.hasOwnProperty.call(nonceDescriptor, 'value') || !Object.prototype.hasOwnProperty.call(kindDescriptor, 'value')
				|| typeof descriptor.value !== 'string' || typeof ownerDescriptor.value !== 'string' || typeof nonceDescriptor.value !== 'string' || (kindDescriptor.value !== 'document' && kindDescriptor.value !== 'comparison')) {
				return undefined;
			}
			const entry = this.handles.get(descriptor.value);
			return entry && entry.ownerId === ownerDescriptor.value && entry.nonce === nonceDescriptor.value && entry.kind === kindDescriptor.value ? entry : undefined;
		} catch {
			return undefined;
		}
	}

	private touch(entry: StoredHandle): void {
		entry.lastUsed = this.safeNow();
		entry.idleDeadline = entry.lastUsed + PARADIS_OFFICE_HANDLE_IDLE_MILLISECONDS;
		entry.timer.schedule(PARADIS_OFFICE_HANDLE_IDLE_MILLISECONDS);
	}

	private remove(entry: StoredHandle): void {
		if (this.handles.get(entry.id) !== entry) { return; }
		this.handles.delete(entry.id);
		entry.timer.dispose();
		this.syncAccountant();
	}

	private safeNow(): number {
		try {
			const value = this.now();
			return isSafeInteger(value) ? value : 0;
		} catch {
			return 0;
		}
	}
	private expired(entry: StoredHandle): boolean { return !Number.isSafeInteger(entry.idleDeadline) || this.safeNow() >= entry.idleDeadline; }
	private syncAccountant(): void {
		this.accountant?.setCache(this.cacheBytes);
		this.accountant?.setHandles([...this.handles.values()].reduce((total, entry) => total + entry.memoryBytes, 0));
	}
}
