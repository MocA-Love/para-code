/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import { Worker } from 'worker_threads';
import type { CancellationToken } from '../../../../../base/common/cancellation.js';
import type { IDisposable } from '../../../../../base/common/lifecycle.js';
import {
	PARADIS_OFFICE_BUDGET_PROFILES,
	type ParadisOfficeBudgetProfile,
	validateOfficeChange,
} from '../../common/paradisOfficeProtocol.js';

export const PARADIS_OFFICE_WORKER_CANCEL_GRACE_MILLISECONDS = 250;
export const PARADIS_OFFICE_WORKER_QUEUE_MILLISECONDS = 30_000;
export const PARADIS_OFFICE_WORKER_PER_CLIENT_LIMIT = 2;
export const PARADIS_OFFICE_WORKER_GLOBAL_LIMIT = 4;

export interface IOfficeWorker {
	postMessage(message: unknown, transfer?: readonly ArrayBuffer[]): void;
	terminate(): Promise<number>;
	onMessage(listener: (message: unknown) => void): IDisposable;
	onError(listener: (error: unknown) => void): IDisposable;
	onExit(listener: (code: number) => void): IDisposable;
}

export type ParadisOfficeWorkerOperation = 'inspect' | 'parse' | 'diff';
/** Transferred bytes are accepted only as plain data; the host still never parses them. */
/**
 * Worker-ready bounded bytes. SourceBroker/SpoolStore resolution belongs to Task 6; descriptors,
 * spool capabilities, filesystem paths, and streams must never reach this host or worker.
 */
export interface OfficeWorkerBytesSource {
	readonly kind: 'bytes';
	readonly bytes: Uint8Array;
	readonly revision: string;
}
export type OfficeWorkerSource = OfficeWorkerBytesSource;
export type OfficeWorkerOutcome<T> =
	| { readonly outcome: 'complete'; readonly value: T }
	| { readonly outcome: 'cancelled' }
	| { readonly outcome: 'blocked'; readonly error: 'limitExceeded' }
	| { readonly outcome: 'failed'; readonly error: 'engineCrashed' };

export interface OfficeWorkerHostMemory {
	readonly limitBytes?: number;
	readonly workerReservationBytes?: number;
	readonly cacheBytes?: () => number;
	readonly spoolBytes?: () => number;
	readonly derivedAssetBytes?: () => number;
	/** Evicts inactive semantic cache before a worker reservation is denied. */
	readonly evictInactiveCache?: (requiredBytes: number) => number;
}

export interface OfficeWorkerHostOptions {
	readonly createWorker?: () => IOfficeWorker;
	readonly now?: () => number;
	readonly setTimeout?: (runner: () => void, delay: number) => unknown;
	readonly clearTimeout?: (handle: unknown) => void;
	readonly memory?: OfficeWorkerHostMemory;
	/** Invalidates only handles owned by a worker that failed unexpectedly. */
	readonly onWorkerCrashed?: (workerId: string) => void;
	readonly accountant?: OfficeMemoryAccountant;
}

export interface OfficeMemorySnapshot { readonly limitBytes: number; readonly workerBytes: number; readonly cacheBytes: number; readonly handleBytes: number; readonly spoolBytes: number; readonly derivedAssetBytes: number; readonly totalBytes: number }
/** Shared safe-integer memory ledger. Task 3/6 own spool and asset updates; workers own reservations. */
export class OfficeMemoryAccountant {
	private workerBytes = 0;
	private cacheBytes = 0;
	private handleBytes = 0;
	private spoolBytes = 0;
	private derivedAssetBytes = 0;
	constructor(readonly limitBytes: number) { if (!safeInteger(limitBytes)) { throw new TypeError('Invalid Office memory limit'); } }
	trySetCache(bytes: number): boolean { return this.trySet('cacheBytes', bytes); }
	trySetSpool(bytes: number): boolean { return this.trySet('spoolBytes', bytes); }
	trySetDerivedAssets(bytes: number): boolean { return this.trySet('derivedAssetBytes', bytes); }
	setCache(bytes: number): void { if (!this.trySetCache(bytes)) { throw new RangeError('Office memory limit exceeded'); } }
	setHandles(bytes: number): void { if (!this.trySet('handleBytes', bytes)) { throw new RangeError('Office memory limit exceeded'); } }
	reserveHandles(bytes: number): boolean { bytes = this.valid(bytes); const total = this.total() + bytes; if (!safeInteger(total) || total > this.limitBytes) { return false; } this.handleBytes += bytes; return true; }
	releaseHandles(bytes: number): void { bytes = this.valid(bytes); this.handleBytes = Math.max(0, this.handleBytes - bytes); }
	setSpool(bytes: number): void { if (!this.trySetSpool(bytes)) { throw new RangeError('Office memory limit exceeded'); } }
	setDerivedAssets(bytes: number): void { if (!this.trySetDerivedAssets(bytes)) { throw new RangeError('Office memory limit exceeded'); } }
	reserveWorker(bytes: number): boolean { const total = this.total() + this.valid(bytes); if (!safeInteger(total) || total > this.limitBytes) { return false; } this.workerBytes += bytes; return true; }
	releaseWorker(bytes: number): void { bytes = this.valid(bytes); this.workerBytes = Math.max(0, this.workerBytes - bytes); }
	snapshot(): OfficeMemorySnapshot { return { limitBytes: this.limitBytes, workerBytes: this.workerBytes, cacheBytes: this.cacheBytes, handleBytes: this.handleBytes, spoolBytes: this.spoolBytes, derivedAssetBytes: this.derivedAssetBytes, totalBytes: this.total() }; }
	private total(): number { const total = this.workerBytes + this.cacheBytes + this.handleBytes + this.spoolBytes + this.derivedAssetBytes; return safeInteger(total) ? total : Number.MAX_SAFE_INTEGER; }
	private valid(bytes: number): number { if (!safeInteger(bytes)) { throw new TypeError('Invalid Office memory bytes'); } return bytes; }
	private trySet(category: 'cacheBytes' | 'handleBytes' | 'spoolBytes' | 'derivedAssetBytes', bytes: number): boolean {
		bytes = this.valid(bytes);
		const total = this.total() - this[category] + bytes;
		if (!safeInteger(total) || total > this.limitBytes) { return false; }
		this[category] = bytes;
		return true;
	}
}

interface OfficeWorkerMessageRun {
	readonly kind: 'run';
	readonly requestId: string;
	readonly operation: ParadisOfficeWorkerOperation;
	readonly source: OfficeWorkerSource;
	readonly budget: ParadisOfficeBudgetProfile;
}

interface PendingJob<T> {
	readonly requestId: string;
	readonly operation: ParadisOfficeWorkerOperation;
	readonly ownerId: string;
	readonly source: OfficeWorkerSource;
	readonly budget: ParadisOfficeBudgetProfile;
	readonly token: CancellationToken;
	readonly reservationBytes: number;
	readonly queueDeadline: number;
	operationDeadline: number;
	readonly workerId?: string;
	readonly queuedAt: number;
	readonly resolve: (outcome: OfficeWorkerOutcome<T>) => void;
	readonly cancellationListener: IDisposable;
	queueTimer?: unknown;
	deadlineTimer?: unknown;
	cancelTimer?: unknown;
	reapTimer?: unknown;
	pendingOutcome?: OfficeWorkerOutcome<T>;
	settled: boolean;
	orphaned: boolean;
	worker?: IOfficeWorker;
	workerListeners?: readonly IDisposable[];
	state: 'queued' | 'running' | 'cancelling' | 'finished';
	released: boolean;
	reservationHeld: boolean;
	terminal: 'cancelled' | 'blocked' | 'failed' | undefined;
}

const ownerPattern = /^[A-Za-z\d][A-Za-z\d._:-]{0,255}$/;
const operations: readonly ParadisOfficeWorkerOperation[] = ['inspect', 'parse', 'diff'];
const maxSafe = Number.MAX_SAFE_INTEGER;

function safeInteger(value: unknown): value is number {
	return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

function memoryLimit(profile: ParadisOfficeBudgetProfile): number {
	switch (profile.kind) {
		case 'desktopLocal': return 1_280 * 1024 * 1024;
		case 'remoteMobile': return 768 * 1024 * 1024;
		case 'browser': return 512 * 1024 * 1024;
	}
}

function operationDeadline(operation: ParadisOfficeWorkerOperation, profile: ParadisOfficeBudgetProfile): number {
	return operation === 'inspect' ? profile.inspectMilliseconds : operation === 'parse' ? profile.semanticParseMilliseconds : profile.diffMilliseconds;
}

function defaultWorker(): IOfficeWorker {
	const worker = new Worker(new URL('./paradisOfficeWorkerMain.js', import.meta.url), {
		resourceLimits: { maxOldGenerationSizeMb: 384, maxYoungGenerationSizeMb: 32, stackSizeMb: 8 },
	});
	return {
		postMessage(message: unknown, transfer?: readonly ArrayBuffer[]): void { worker.postMessage(message, transfer); },
		terminate: () => worker.terminate(),
		onMessage: listener => {
			worker.on('message', listener);
			return { dispose: () => worker.off('message', listener) };
		},
		onError: listener => {
			const callback = (error: Error) => listener(error);
			worker.on('error', callback);
			return { dispose: () => worker.off('error', callback) };
		},
		onExit: listener => {
			worker.on('exit', listener);
			return { dispose: () => worker.off('exit', listener) };
		},
	};
}

function dataField(value: unknown, name: string): unknown {
	if (!value || typeof value !== 'object' || Array.isArray(value)) { return undefined; }
	try {
		const prototype = Object.getPrototypeOf(value);
		if (prototype !== Object.prototype && prototype !== null) { return undefined; }
		const descriptor = Object.getOwnPropertyDescriptor(value, name);
		return descriptor?.enumerable && Object.prototype.hasOwnProperty.call(descriptor, 'value') ? descriptor.value : undefined;
	} catch {
		return undefined;
	}
}

const workerProjectionDepth = 32;
const workerProjectionNodes = 65_536;
const workerProjectionBytes = 2 * 1024 * 1024;

/** Descriptor-only projector for the untrusted worker boundary. It deliberately creates every
 * returned value so validation cannot retain a worker object, a getter, a Proxy, or a shared DAG. */
class WorkerResultProjector {
	private readonly seen = new Set<object>();
	private nodes = 0;
	constructor(private readonly permitSharedInput = false) { }

	project(operation: ParadisOfficeWorkerOperation, value: unknown): object | undefined {
		const result = this.projectOnce(operation, value);
		// A descriptor trap can mutate after an apparently valid pass. Repeat the bounded read
		// before publishing; no value from either confirmation is retained.
		const confirmation = new WorkerResultProjector(this.permitSharedInput).projectOnce(operation, value);
		if (!result || !confirmation || !this.equal(result, confirmation)) { return undefined; }
		return result;
	}

	private equal(left: unknown, right: unknown): boolean {
		if (left === right || (typeof left === 'number' && typeof right === 'number' && Number.isNaN(left) && Number.isNaN(right))) { return true; }
		if (!left || !right || typeof left !== 'object' || typeof right !== 'object' || Array.isArray(left) !== Array.isArray(right)) { return false; }
		if (Array.isArray(left) && Array.isArray(right)) { return left.length === right.length && left.every((value, index) => this.equal(value, right[index])); }
		const leftRecord = left as Record<string, unknown>;
		const rightRecord = right as Record<string, unknown>;
		const keys = Object.keys(leftRecord);
		return keys.length === Object.keys(rightRecord).length && keys.every(key => Object.prototype.hasOwnProperty.call(rightRecord, key) && this.equal(leftRecord[key], rightRecord[key]));
	}

	private projectOnce(operation: ParadisOfficeWorkerOperation, value: unknown): object | undefined {
		try {
			const result = operation === 'inspect' ? this.inspectResult(value, 1) : this.summary(operation, value, 1);
			if (this.jsonBytes(result) > workerProjectionBytes) { return undefined; }
			return result;
		} catch {
			return undefined;
		}
	}

	private consume(depth: number): void {
		if (depth > workerProjectionDepth || ++this.nodes > workerProjectionNodes) { throw new TypeError('Office worker projection limit'); }
	}

	private jsonBytes(value: unknown): number {
		const addString = (text: string, current: number): number => {
			let bytes = current + 2;
			for (let index = 0; index < text.length; index++) {
				const code = text.charCodeAt(index);
				if (code === 0x22 || code === 0x5c || code === 0x08 || code === 0x09 || code === 0x0a || code === 0x0c || code === 0x0d) { bytes += 2; }
				else if (code <= 0x1f || (code >= 0xdc00 && code <= 0xdfff)) { bytes += 6; }
				else if (code >= 0xd800 && code <= 0xdbff) { const low = text.charCodeAt(index + 1); if (low >= 0xdc00 && low <= 0xdfff) { bytes += 4; index++; } else { bytes += 6; } }
				else if (code <= 0x7f) { bytes++; } else if (code <= 0x7ff) { bytes += 2; } else { bytes += 3; }
				if (bytes > workerProjectionBytes) { return bytes; }
			}
			return bytes;
		};
		const work: unknown[] = [value];
		let bytes = 0;
		while (work.length) {
			const item = work.pop();
			if (item === null) { bytes += 4; } else if (typeof item === 'string') { bytes = addString(item, bytes); } else if (typeof item === 'boolean') { bytes += item ? 4 : 5; } else if (typeof item === 'number') { bytes += String(item).length; }
			else if (Array.isArray(item)) { bytes += 2 + Math.max(0, item.length - 1); for (let index = item.length - 1; index >= 0; index--) { work.push(item[index]); } }
			else if (item && typeof item === 'object') { const entries = Object.entries(item); bytes += 2 + Math.max(0, entries.length - 1); for (let index = entries.length - 1; index >= 0; index--) { const [key, child] = entries[index]; bytes = addString(key, bytes) + 1; work.push(child); } }
			else { return workerProjectionBytes + 1; }
			if (bytes > workerProjectionBytes) { return bytes; }
		}
		return bytes;
	}

	private record(value: unknown, required: readonly string[], optional: readonly string[], depth: number): ReadonlyMap<string, unknown> {
		this.consume(depth);
		if (!value || typeof value !== 'object' || Array.isArray(value) || (!this.permitSharedInput && this.seen.has(value))) { throw new TypeError('Office worker record'); }
		this.seen.add(value);
		const prototype = Object.getPrototypeOf(value);
		if (prototype !== Object.prototype && prototype !== null) { throw new TypeError('Office worker record prototype'); }
		const allowed = new Set([...required, ...optional]);
		const keys = Reflect.ownKeys(value);
		if (keys.length !== required.length + [...optional].filter(key => Object.prototype.hasOwnProperty.call(value, key)).length) { throw new TypeError('Office worker record keys'); }
		const result = new Map<string, unknown>();
		for (const key of keys) {
			if (typeof key !== 'string' || !allowed.has(key)) { throw new TypeError('Office worker record key'); }
			const descriptor = Object.getOwnPropertyDescriptor(value, key);
			if (!descriptor?.enumerable || !Object.prototype.hasOwnProperty.call(descriptor, 'value')) { throw new TypeError('Office worker accessor'); }
			if (descriptor.value === undefined && !optional.includes(key)) { throw new TypeError('Office worker undefined'); }
			if (descriptor.value !== undefined) { result.set(key, descriptor.value); }
		}
		if (required.some(key => !result.has(key))) { throw new TypeError('Office worker required key'); }
		return result;
	}

	private array<T>(value: unknown, depth: number, project: (item: unknown) => T): readonly T[] {
		this.consume(depth);
		if (!Array.isArray(value) || (!this.permitSharedInput && this.seen.has(value))) { throw new TypeError('Office worker array'); }
		this.seen.add(value);
		const length = Object.getOwnPropertyDescriptor(value, 'length')?.value;
		if (!safeInteger(length) || length > workerProjectionNodes - this.nodes || Reflect.ownKeys(value).length !== length + 1) { throw new TypeError('Office worker array length'); }
		const result: T[] = [];
		for (let index = 0; index < length; index++) {
			const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
			if (!descriptor?.enumerable || !Object.prototype.hasOwnProperty.call(descriptor, 'value') || descriptor.value === undefined) { throw new TypeError('Office worker array item'); }
			result.push(project(descriptor.value));
		}
		return result;
	}

	private string(value: unknown, depth: number): string { this.consume(depth); if (typeof value !== 'string') { throw new TypeError('Office worker string'); } return value; }
	private bool(value: unknown, depth: number): boolean { this.consume(depth); if (typeof value !== 'boolean') { throw new TypeError('Office worker boolean'); } return value; }
	private integer(value: unknown, depth: number): number { this.consume(depth); if (!safeInteger(value)) { throw new TypeError('Office worker integer'); } return value; }
	private oneOf<T extends string>(value: unknown, values: readonly T[], depth: number): T { const string = this.string(value, depth); if (!values.includes(string as T)) { throw new TypeError('Office worker enum'); } return string as T; }

	private inspectResult(value: unknown, depth: number): object {
		const fields = this.record(value, ['inventory'], [], depth);
		return { inventory: this.inventory(fields.get('inventory'), depth + 1) };
	}

	private inventory(value: unknown, depth: number): object {
		const fields = this.record(value, ['format', 'container', 'parts', 'relationships', 'features', 'security', 'budgetProfile', 'budgetUsage', 'outcome', 'completeness', 'warnings'], [], depth);
		const parts = this.array(fields.get('parts'), depth + 1, part => this.part(part, depth + 2));
		const relationships = this.array(fields.get('relationships'), depth + 1, relationship => this.relationship(relationship, depth + 2));
		const features = this.array(fields.get('features'), depth + 1, feature => this.feature(feature, depth + 2));
		const security = this.security(fields.get('security'), depth + 1);
		const completeness = this.completeness(fields.get('completeness'), depth + 1, parts);
		const outcome = this.oneOf(fields.get('outcome'), ['complete', 'degraded', 'blocked'], depth + 1);
		if (!this.coherentOutcome(outcome, parts, relationships)) { throw new TypeError('Office worker outcome'); }
		return {
			format: this.oneOf(fields.get('format'), ['xlsx', 'xlsm', 'xltx', 'xltm', 'docx', 'docm', 'dotx', 'dotm', 'zip', 'cfbEncrypted', 'unknown'], depth + 1),
			container: this.oneOf(fields.get('container'), ['opc', 'zip', 'cfb', 'unknown'], depth + 1), parts, relationships, features, security,
			budgetProfile: this.oneOf(fields.get('budgetProfile'), ['desktopLocal', 'remoteMobile', 'browser'], depth + 1),
			budgetUsage: this.budgetUsage(fields.get('budgetUsage'), depth + 1), outcome, completeness,
			warnings: this.array(fields.get('warnings'), depth + 1, warning => this.warning(warning, depth + 2)),
		};
	}

	private part(value: unknown, depth: number): object {
		const fields = this.record(value, ['id', 'canonicalUri', 'contentType', 'compressedBytes', 'expandedBytes', 'required', 'coverage'], ['rawHash', 'hashCompleteness', 'canonicalHash', 'fingerprint'], depth);
		const coverage = this.oneOf(fields.get('coverage'), ['parsed', 'partial', 'opaque', 'completeOpaque', 'unsafe', 'failed', 'omittedByBudget'], depth + 1);
		if ((coverage === 'completeOpaque' && fields.has('rawHash')) || (coverage !== 'completeOpaque' && fields.has('fingerprint'))) { throw new TypeError('Office worker part hash shape'); }
		const result: Record<string, unknown> = {
			id: this.string(fields.get('id'), depth + 1), canonicalUri: this.string(fields.get('canonicalUri'), depth + 1), contentType: this.string(fields.get('contentType'), depth + 1),
			compressedBytes: this.integer(fields.get('compressedBytes'), depth + 1), expandedBytes: this.integer(fields.get('expandedBytes'), depth + 1), required: this.bool(fields.get('required'), depth + 1), coverage,
		};
		if (fields.has('rawHash')) { result.rawHash = this.fingerprint(fields.get('rawHash'), depth + 1); }
		if (fields.has('hashCompleteness')) { result.hashCompleteness = this.oneOf(fields.get('hashCompleteness'), ['allBytes', 'incomplete'], depth + 1); }
		if (fields.has('canonicalHash')) { result.canonicalHash = this.fingerprint(fields.get('canonicalHash'), depth + 1); }
		if (fields.has('fingerprint')) { result.fingerprint = this.fingerprint(fields.get('fingerprint'), depth + 1); }
		if ((coverage === 'parsed' && (!result.rawHash || result.hashCompleteness !== 'allBytes')) || (coverage === 'completeOpaque' && (!result.fingerprint || result.hashCompleteness !== 'allBytes'))) { throw new TypeError('Office worker part proof'); }
		return result;
	}

	private fingerprint(value: unknown, depth: number): object {
		const fields = this.record(value, ['algorithm', 'value', 'byteLength'], [], depth);
		const fingerprint = this.string(fields.get('value'), depth + 1);
		if (!/^[a-f\d]{64}$/i.test(fingerprint)) { throw new TypeError('Office worker fingerprint'); }
		return { algorithm: this.oneOf(fields.get('algorithm'), ['sha256'], depth + 1), value: fingerprint, byteLength: this.integer(fields.get('byteLength'), depth + 1) };
	}

	private relationship(value: unknown, depth: number): object {
		const fields = this.record(value, ['id', 'type', 'target', 'targetMode', 'missing', 'cyclic'], ['sourcePartId'], depth);
		const result: Record<string, unknown> = { id: this.string(fields.get('id'), depth + 1), type: this.string(fields.get('type'), depth + 1), target: this.string(fields.get('target'), depth + 1), targetMode: this.oneOf(fields.get('targetMode'), ['internal', 'external'], depth + 1), missing: this.bool(fields.get('missing'), depth + 1), cyclic: this.bool(fields.get('cyclic'), depth + 1) };
		if (fields.has('sourcePartId')) { result.sourcePartId = this.string(fields.get('sourcePartId'), depth + 1); }
		return result;
	}

	private feature(value: unknown, depth: number): object {
		const fields = this.record(value, ['kind', 'count', 'partIds', 'safety'], [], depth);
		return { kind: this.string(fields.get('kind'), depth + 1), count: this.integer(fields.get('count'), depth + 1), partIds: this.array(fields.get('partIds'), depth + 1, partId => this.string(partId, depth + 2)), safety: this.oneOf(fields.get('safety'), ['safe', 'sanitized', 'metadataOnly', 'blocked'], depth + 1) };
	}

	private security(value: unknown, depth: number): object {
		const fields = this.record(value, ['encrypted', 'hasMacros', 'hasExternalRelationships', 'hasEmbeddedObjects', 'hasProtection', 'hasSignatures'], [], depth);
		return { encrypted: this.bool(fields.get('encrypted'), depth + 1), hasMacros: this.bool(fields.get('hasMacros'), depth + 1), hasExternalRelationships: this.bool(fields.get('hasExternalRelationships'), depth + 1), hasEmbeddedObjects: this.bool(fields.get('hasEmbeddedObjects'), depth + 1), hasProtection: this.bool(fields.get('hasProtection'), depth + 1), hasSignatures: this.bool(fields.get('hasSignatures'), depth + 1) };
	}

	private budgetUsage(value: unknown, depth: number): object {
		const fields = this.record(value, ['compressedInputBytes', 'expandedBytes', 'entryCount', 'largestPartBytes', 'totalMediaBytes', 'elapsedMilliseconds'], [], depth);
		return { compressedInputBytes: this.integer(fields.get('compressedInputBytes'), depth + 1), expandedBytes: this.integer(fields.get('expandedBytes'), depth + 1), entryCount: this.integer(fields.get('entryCount'), depth + 1), largestPartBytes: this.integer(fields.get('largestPartBytes'), depth + 1), totalMediaBytes: this.integer(fields.get('totalMediaBytes'), depth + 1), elapsedMilliseconds: this.integer(fields.get('elapsedMilliseconds'), depth + 1) };
	}

	private completeness(value: unknown, depth: number, parts?: readonly object[]): object {
		const names = ['expectedParts', 'visitedParts', 'parsedParts', 'opaqueParts', 'failedParts', 'omittedParts', 'expectedSemanticUnits', 'visitedSemanticUnits', 'terminal'] as const;
		const fields = this.record(value, names, [], depth);
		const result = { expectedParts: this.integer(fields.get('expectedParts'), depth + 1), visitedParts: this.integer(fields.get('visitedParts'), depth + 1), parsedParts: this.integer(fields.get('parsedParts'), depth + 1), opaqueParts: this.integer(fields.get('opaqueParts'), depth + 1), failedParts: this.integer(fields.get('failedParts'), depth + 1), omittedParts: this.integer(fields.get('omittedParts'), depth + 1), expectedSemanticUnits: this.integer(fields.get('expectedSemanticUnits'), depth + 1), visitedSemanticUnits: this.integer(fields.get('visitedSemanticUnits'), depth + 1), terminal: this.bool(fields.get('terminal'), depth + 1) };
		if (!result.terminal || result.expectedParts !== result.visitedParts || result.visitedParts !== result.parsedParts + result.opaqueParts + result.failedParts + result.omittedParts || result.expectedSemanticUnits !== result.visitedSemanticUnits) { throw new TypeError('Office worker completeness'); }
		if (parts && result.expectedParts !== parts.length) { throw new TypeError('Office worker parts completeness'); }
		return result;
	}

	private warning(value: unknown, depth: number): object {
		const fields = this.record(value, ['code', 'message'], [], depth);
		const code = this.string(fields.get('code'), depth + 1);
		const message = this.string(fields.get('message'), depth + 1);
		if (code.length > 256 || message.length > 4096) { throw new TypeError('Office worker warning'); }
		return { code, message };
	}

	private coherentOutcome(outcome: string, parts: readonly object[], relationships: readonly object[]): boolean {
		const partStatus = parts.map(part => part as { coverage: string; required: boolean });
		const blocked = partStatus.some(part => part.required && (part.coverage === 'failed' || part.coverage === 'omittedByBudget')) || relationships.some(relationship => {
			const value = relationship as { missing: boolean; sourcePartId?: string };
			return value.missing && value.sourcePartId === undefined;
		});
		const degraded = partStatus.some(part => part.coverage !== 'parsed' && part.coverage !== 'completeOpaque') || relationships.some(relationship => (relationship as { missing: boolean }).missing);
		return outcome === 'blocked' ? blocked : outcome === 'degraded' ? !blocked && degraded : !blocked && !degraded;
	}

	private summary(operation: 'parse' | 'diff', value: unknown, depth: number): object {
		const fields = this.record(value, ['operation', 'handle', 'outcome', 'completeness', 'capabilities', 'changes'], [], depth);
		const handle = this.record(fields.get('handle'), ['kind', 'id'], [], depth + 1);
		const changes = this.array(fields.get('changes'), depth + 1, change => this.change(change, depth + 2));
		const handleKind = this.oneOf(handle.get('kind'), [operation === 'parse' ? 'document' : 'comparison'], depth + 2);
		return { operation: this.oneOf(fields.get('operation'), [operation], depth + 1), handle: { kind: handleKind, id: this.string(handle.get('id'), depth + 2) }, outcome: this.oneOf(fields.get('outcome'), ['complete', 'degraded'], depth + 1), completeness: this.completeness(fields.get('completeness'), depth + 1), capabilities: this.array(fields.get('capabilities'), depth + 1, capability => this.string(capability, depth + 2)), changes };
	}

	private change(value: unknown, depth: number): object {
		const fields = this.record(value, ['id', 'category', 'subject', 'before', 'after', 'certainty', 'sourceParts'], ['navigableAnchor'], depth);
		const subject = this.record(fields.get('subject'), ['kind', 'locator'], [], depth + 1);
		const result: Record<string, unknown> = { id: this.string(fields.get('id'), depth + 1), category: this.oneOf(fields.get('category'), ['content', 'formatting', 'structure', 'annotation', 'revision', 'object', 'security'], depth + 1), subject: { kind: this.string(subject.get('kind'), depth + 2), locator: this.string(subject.get('locator'), depth + 2) }, before: this.changeValue(fields.get('before'), depth + 1), after: this.changeValue(fields.get('after'), depth + 1), certainty: this.oneOf(fields.get('certainty'), ['exact', 'normalized', 'heuristic', 'ambiguous', 'opaque', 'degraded'], depth + 1), sourceParts: this.array(fields.get('sourceParts'), depth + 1, part => this.string(part, depth + 2)) };
		if (fields.has('navigableAnchor')) { result.navigableAnchor = this.string(fields.get('navigableAnchor'), depth + 1); }
		if (!validateOfficeChange(result).valid) { throw new TypeError('Office worker change'); }
		return result;
	}

	private changeValue(value: unknown, depth: number): object {
		const fields = this.record(value, ['kind'], ['valueType', 'value', 'items', 'fields', 'algorithm', 'byteLength'], depth);
		const kind = this.oneOf(fields.get('kind'), ['none', 'scalar', 'list', 'record', 'fingerprint'], depth + 1);
		if (kind === 'none') { if (fields.size !== 1) { throw new TypeError('Office worker change none'); } return { kind }; }
		if (kind === 'scalar') { if (fields.size !== 3) { throw new TypeError('Office worker change scalar'); } const valueType = this.oneOf(fields.get('valueType'), ['text', 'number', 'boolean', 'null'], depth + 1); const scalar = fields.get('value'); if ((valueType === 'text' || valueType === 'number') ? typeof scalar !== 'string' : valueType === 'boolean' ? typeof scalar !== 'boolean' : scalar !== null) { throw new TypeError('Office worker scalar'); } this.consume(depth + 1); return { kind, valueType, value: scalar }; }
		if (kind === 'list') { if (fields.size !== 2) { throw new TypeError('Office worker change list'); } return { kind, items: this.array(fields.get('items'), depth + 1, item => this.changeValue(item, depth + 2)) }; }
		if (kind === 'record') { if (fields.size !== 2) { throw new TypeError('Office worker change record'); } return { kind, fields: this.array(fields.get('fields'), depth + 1, field => { const item = this.record(field, ['name', 'value'], [], depth + 2); return { name: this.string(item.get('name'), depth + 3), value: this.changeValue(item.get('value'), depth + 3) }; }) }; }
		if (fields.size !== 4) { throw new TypeError('Office worker change fingerprint'); }
		return { kind, ...this.fingerprint({ algorithm: fields.get('algorithm'), value: fields.get('value'), byteLength: fields.get('byteLength') }, depth + 1) };
	}
}

export function projectOfficeWorkerResult(operation: ParadisOfficeWorkerOperation, value: unknown, permitSharedInput = false): object | undefined {
	return new WorkerResultProjector(permitSharedInput).project(operation, value);
}

/** Bounded Node worker orchestrator. The shared process never parses untrusted Office bytes. */
export class OfficeWorkerHost {
	private readonly createWorker: () => IOfficeWorker;
	private readonly now: () => number;
	private readonly setTimer: (runner: () => void, delay: number) => unknown;
	private readonly clearTimer: (handle: unknown) => void;
	private readonly memory: OfficeWorkerHostMemory;
	private readonly onWorkerCrashed: (workerId: string) => void;
	private readonly accountant: OfficeMemoryAccountant | undefined;
	private readonly pending: PendingJob<object>[] = [];
	private readonly active = new Set<PendingJob<object>>();
	private requestSequence = 0;
	private lastNow = 0;
	private disposed = false;

	constructor(options: OfficeWorkerHostOptions = {}) {
		this.createWorker = options.createWorker ?? defaultWorker;
		this.now = options.now ?? Date.now;
		this.setTimer = options.setTimeout ?? ((runner, delay) => setTimeout(runner, delay));
		this.clearTimer = options.clearTimeout ?? (handle => clearTimeout(handle as ReturnType<typeof setTimeout>));
		this.memory = options.memory ?? {};
		this.onWorkerCrashed = options.onWorkerCrashed ?? (() => { });
		this.accountant = options.accountant;
	}

	get activeWorkerCount(): number { return this.active.size; }
	get queuedWorkerCount(): number { return this.pending.length; }

	run<T extends object>(operation: ParadisOfficeWorkerOperation, ownerId: string, source: OfficeWorkerSource, budget: ParadisOfficeBudgetProfile, token: CancellationToken, options: { readonly reservationBytes?: number; readonly workerId?: string } = {}): Promise<OfficeWorkerOutcome<T>> {
		let safeSource: OfficeWorkerSource;
		const safeBudget = this.canonicalBudget(budget);
		if (this.disposed || !operations.includes(operation) || !ownerPattern.test(ownerId) || !token || typeof token.isCancellationRequested !== 'boolean' || typeof token.onCancellationRequested !== 'function' || !safeBudget) {
			return Promise.resolve({ outcome: 'failed', error: 'engineCrashed' });
		}
		try { safeSource = this.validateSource(source, safeBudget); } catch { return Promise.resolve({ outcome: 'failed', error: 'engineCrashed' }); }
		const reservationBytes = options.reservationBytes ?? this.memory.workerReservationBytes ?? 384 * 1024 * 1024;
		if (!safeInteger(reservationBytes) || (options.workerId !== undefined && !ownerPattern.test(options.workerId))) { return Promise.resolve({ outcome: 'blocked', error: 'limitExceeded' }); }
		if (token.isCancellationRequested) { return Promise.resolve({ outcome: 'cancelled' }); }
		return new Promise<OfficeWorkerOutcome<T>>(resolve => {
			const requestId = String(++this.requestSequence);
			const holder: { job?: PendingJob<T> } = {};
			let cancelledBeforeJob = false;
			let cancellationListener: IDisposable;
			try {
				cancellationListener = token.onCancellationRequested(() => {
					if (holder.job) { this.cancel(holder.job as unknown as PendingJob<object>); } else { cancelledBeforeJob = true; }
				});
			} catch {
				resolve({ outcome: 'failed', error: 'engineCrashed' });
				return;
			}
			const job: PendingJob<T> = {
				requestId, operation, ownerId, source: safeSource, budget: safeBudget, token, reservationBytes, queueDeadline: this.deadline(PARADIS_OFFICE_WORKER_QUEUE_MILLISECONDS), operationDeadline: 0, ...(options.workerId ? { workerId: options.workerId } : {}), queuedAt: this.safeNow(), resolve,
				cancellationListener, state: 'queued', released: false, reservationHeld: false, terminal: undefined, settled: false, orphaned: false,
			};
			holder.job = job;
			if (cancelledBeforeJob || token.isCancellationRequested) { this.finish(job as unknown as PendingJob<object>, { outcome: 'cancelled' }); return; }
			let timer: unknown;
			try { timer = this.setTimer(() => this.finish(job as unknown as PendingJob<object>, { outcome: 'blocked', error: 'limitExceeded' }), PARADIS_OFFICE_WORKER_QUEUE_MILLISECONDS); } catch { this.finish(job as unknown as PendingJob<object>, { outcome: 'failed', error: 'engineCrashed' }); return; }
			if (job.state === 'finished') { try { this.clearTimer(timer); } catch { } return; }
			job.queueTimer = timer;
			this.pending.push(job as unknown as PendingJob<object>);
			this.pump();
		});
	}

	dispose(): void {
		if (this.disposed) { return; }
		this.disposed = true;
		for (const job of [...this.pending, ...this.active]) {
			job.terminal = 'cancelled';
			this.finish(job, { outcome: 'cancelled' });
			try { void job.worker?.terminate().catch(() => { }); } catch { }
		}
	}

	private pump(): void {
		if (this.disposed) { return; }
		for (let index = 0; index < this.pending.length && this.active.size < PARADIS_OFFICE_WORKER_GLOBAL_LIMIT;) {
			const job = this.pending[index];
			if (job.state !== 'queued') { this.pending.splice(index, 1); continue; }
			if (this.expired(job.queueDeadline)) { this.finish(job, { outcome: 'blocked', error: 'limitExceeded' }); continue; }
			if (job.token.isCancellationRequested) { this.finish(job, { outcome: 'cancelled' }); continue; }
			if (this.activeForOwner(job.ownerId) >= PARADIS_OFFICE_WORKER_PER_CLIENT_LIMIT) { index++; continue; }
			if (!this.reserve(job)) {
				if (!this.canEverReserve(job)) { this.finish(job, { outcome: 'blocked', error: 'limitExceeded' }); continue; }
				index++;
				continue;
			}
			this.pending.splice(index, 1);
			this.start(job);
		}
	}

	private start(job: PendingJob<object>): void {
		if (this.expired(job.queueDeadline)) { this.finish(job, { outcome: 'blocked', error: 'limitExceeded' }); return; }
		job.operationDeadline = this.deadline(operationDeadline(job.operation, job.budget));
		job.state = 'running';
		this.active.add(job);
		if (job.queueTimer !== undefined) { try { this.clearTimer(job.queueTimer); } catch { } job.queueTimer = undefined; }
		let worker: IOfficeWorker;
		try { worker = this.createWorker(); } catch { this.finish(job, { outcome: 'failed', error: 'engineCrashed' }); return; }
		job.worker = worker;
		const listeners: IDisposable[] = [];
		try {
			listeners.push(worker.onMessage(message => this.onWorkerMessage(job, message)));
			if (this.cannotStart(job)) { for (const listener of listeners) { try { listener.dispose(); } catch { } } return; }
			listeners.push(worker.onError(() => this.workerStopped(job)));
			if (this.cannotStart(job)) { for (const listener of listeners) { try { listener.dispose(); } catch { } } return; }
			listeners.push(worker.onExit(() => this.workerStopped(job)));
			if (this.cannotStart(job)) { for (const listener of listeners) { try { listener.dispose(); } catch { } } return; }
			job.workerListeners = listeners;
		} catch {
			job.workerListeners = listeners;
			this.reap(job, { outcome: 'failed', error: 'engineCrashed' });
			return;
		}
		if (this.cannotStart(job)) { return; }
		let deadlineTimer: unknown;
		try {
			deadlineTimer = this.setTimer(() => {
				job.terminal = 'blocked';
				this.reap(job, { outcome: 'blocked', error: 'limitExceeded' });
			}, operationDeadline(job.operation, job.budget));
		} catch { this.reap(job, { outcome: 'failed', error: 'engineCrashed' }); return; }
		if (this.cannotStart(job)) { try { this.clearTimer(deadlineTimer); } catch { } return; }
		job.deadlineTimer = deadlineTimer;
		try {
			const message: OfficeWorkerMessageRun = { kind: 'run', requestId: job.requestId, operation: job.operation, source: job.source, budget: job.budget };
			worker.postMessage(message);
		} catch {
			this.workerStopped(job);
		}
	}

	private cancel(job: PendingJob<object>): void {
		if (job.state === 'finished') { return; }
		if (job.state === 'queued') { this.finish(job, { outcome: 'cancelled' }); return; }
		if (job.state === 'cancelling') { return; }
		job.state = 'cancelling';
		job.terminal = 'cancelled';
		try { job.worker?.postMessage({ kind: 'cancel', requestId: job.requestId }); } catch { }
		let cancelTimer: unknown;
		try {
			cancelTimer = this.setTimer(() => {
				if (job.state !== 'finished') {
					this.reap(job, { outcome: 'cancelled' });
				}
			}, PARADIS_OFFICE_WORKER_CANCEL_GRACE_MILLISECONDS);
		} catch { this.reap(job, { outcome: 'cancelled' }); }
		if (this.isFinished(job) || job.pendingOutcome) { try { this.clearTimer(cancelTimer); } catch { } return; }
		job.cancelTimer = cancelTimer;
	}

	private onWorkerMessage(job: PendingJob<object>, message: unknown): void {
		if (job.state === 'finished' || dataField(message, 'requestId') !== job.requestId) { return; }
		if (job.token.isCancellationRequested) { this.reap(job, { outcome: 'cancelled' }); return; }
		if (this.expired(job.operationDeadline)) { this.reap(job, { outcome: 'blocked', error: 'limitExceeded' }); return; }
		const kind = dataField(message, 'kind');
		if (kind === 'cancelled') { this.reap(job, { outcome: 'cancelled' }); return; }
		if (kind === 'limitExceeded') { this.reap(job, { outcome: 'blocked', error: 'limitExceeded' }); return; }
		if (kind === 'result' && job.state === 'running') {
			const value = dataField(message, 'value');
			const snapshot = this.snapshotWorkerResult(job.operation, value);
			if (snapshot) {
				this.reap(job, { outcome: 'complete', value: snapshot });
			} else {
				this.reap(job, { outcome: 'failed', error: 'engineCrashed' });
			}
			return;
		}
		if (kind === 'failure') { this.reap(job, { outcome: 'failed', error: 'engineCrashed' }); }
	}

	private workerStopped(job: PendingJob<object>): void {
		if (job.state === 'finished') { return; }
		if (job.pendingOutcome) { this.finish(job, job.pendingOutcome); return; }
		if (job.token.isCancellationRequested) { this.reap(job, { outcome: 'cancelled' }); return; }
		if (this.expired(job.operationDeadline)) { this.reap(job, { outcome: 'blocked', error: 'limitExceeded' }); return; }
		if (job.terminal === 'cancelled' || job.state === 'cancelling') { this.finish(job, { outcome: 'cancelled' }); }
		else if (job.terminal === 'blocked') { this.finish(job, { outcome: 'blocked', error: 'limitExceeded' }); }
		else {
			try { this.onWorkerCrashed(job.workerId ?? job.requestId); } catch { }
			this.finish(job, { outcome: 'failed', error: 'engineCrashed' });
		}
	}

	private reap(job: PendingJob<object>, outcome: OfficeWorkerOutcome<object>): void {
		if (job.state === 'finished' || job.pendingOutcome) { return; }
		job.pendingOutcome = outcome;
		if (job.deadlineTimer !== undefined) { try { this.clearTimer(job.deadlineTimer); } catch { } job.deadlineTimer = undefined; }
		if (job.cancelTimer !== undefined) { try { this.clearTimer(job.cancelTimer); } catch { } job.cancelTimer = undefined; }
		if (!job.worker) { this.finish(job, outcome); return; }
		let reapTimer: unknown;
		try {
			reapTimer = this.setTimer(() => this.orphan(job, outcome), PARADIS_OFFICE_WORKER_CANCEL_GRACE_MILLISECONDS);
			if (this.isFinished(job) || job.orphaned) { try { this.clearTimer(reapTimer); } catch { } } else { job.reapTimer = reapTimer; }
			const termination = job.worker.terminate();
			void Promise.resolve(termination).then(
				() => this.finish(job, outcome),
				() => this.orphan(job, outcome),
			);
		} catch {
			this.orphan(job, outcome);
		}
	}

	private orphan(job: PendingJob<object>, outcome: OfficeWorkerOutcome<object>): void {
		if (job.state === 'finished' || job.settled) { return; }
		job.orphaned = true;
		job.settled = true;
		try { job.cancellationListener.dispose(); } catch { }
		job.resolve(outcome);
	}

	private finish(job: PendingJob<object>, outcome: OfficeWorkerOutcome<object>): void {
		if (job.state === 'finished') { return; }
		job.state = 'finished';
		const queuedIndex = this.pending.indexOf(job);
		if (queuedIndex >= 0) { this.pending.splice(queuedIndex, 1); }
		this.active.delete(job);
		if (job.reservationHeld && !job.released) { job.released = true; job.reservationHeld = false; this.accountant?.releaseWorker(job.reservationBytes); }
		for (const timer of [job.queueTimer, job.deadlineTimer, job.cancelTimer, job.reapTimer]) { try { if (timer !== undefined) { this.clearTimer(timer); } } catch { } }
		try { job.cancellationListener.dispose(); } catch { }
		for (const listener of job.workerListeners ?? []) { try { listener.dispose(); } catch { } }
		if (!job.settled) { job.settled = true; job.resolve(outcome); }
		this.pump();
	}

	private reserve(job: PendingJob<object>): boolean {
		let reserved = false;
		let admitted = false;
		try {
			if (this.accountant) {
				const before = this.accountant.snapshot();
				const requested = before.totalBytes + job.reservationBytes;
				if (!safeInteger(requested)) { return false; }
				const deficit = Math.max(0, requested - before.limitBytes);
				if (deficit > 0) { this.memory.evictInactiveCache?.(deficit); }
				if (!this.accountant.reserveWorker(job.reservationBytes)) { return false; }
				reserved = true;
				job.reservationHeld = true;
			}
			const current = this.memoryUsage();
			const limit = this.memory.limitBytes ?? memoryLimit(job.budget);
			const requested = current + job.reservationBytes;
			if (!safeInteger(requested)) { return false; }
			if (requested > limit) {
				this.memory.evictInactiveCache?.(requested - limit);
				const afterEviction = this.memoryUsage() + job.reservationBytes;
				if (!safeInteger(afterEviction) || afterEviction > limit) { return false; }
			}
			admitted = true;
			return true;
		} catch {
			return false;
		} finally {
			if (reserved && !admitted) { job.reservationHeld = false; this.accountant?.releaseWorker(job.reservationBytes); }
		}
	}

	private cannotStart(job: PendingJob<object>): boolean { return job.state === 'finished' || !!job.pendingOutcome || job.state === 'cancelling' || job.orphaned; }
	private isFinished(job: PendingJob<object>): boolean { return job.state === 'finished'; }

	private canEverReserve(job: PendingJob<object>): boolean {
		const limit = this.memory.limitBytes ?? memoryLimit(job.budget);
		return job.reservationBytes <= limit && this.memoryUsage() <= limit;
	}

	private memoryUsage(): number {
		try {
			const usage = (this.memory.cacheBytes?.() ?? 0) + (this.memory.spoolBytes?.() ?? 0) + (this.memory.derivedAssetBytes?.() ?? 0)
				+ [...this.active].reduce((total, job) => total + job.reservationBytes, 0);
			return safeInteger(usage) ? usage : maxSafe;
		} catch { return maxSafe; }
	}

	private activeForOwner(ownerId: string): number {
		let count = 0;
		for (const job of this.active) { if (job.ownerId === ownerId) { count++; } }
		return count;
	}

	private canonicalBudget(value: unknown): ParadisOfficeBudgetProfile | undefined {
		const kind = dataField(value, 'kind');
		return kind === 'desktopLocal' || kind === 'remoteMobile' || kind === 'browser' ? PARADIS_OFFICE_BUDGET_PROFILES[kind] : undefined;
	}

	private validateSource(value: OfficeWorkerSource, budget: ParadisOfficeBudgetProfile): OfficeWorkerSource {
		if (dataField(value, 'kind') !== 'bytes') { throw new TypeError('Invalid Office worker source'); }
		const bytes = dataField(value, 'bytes');
		const revision = dataField(value, 'revision');
		if (!(bytes instanceof Uint8Array) || !Number.isSafeInteger(bytes.byteLength) || bytes.byteLength > budget.compressedInputBytes || typeof revision !== 'string' || revision.length === 0 || revision.length > 4096) {
			throw new TypeError('Invalid Office worker bytes');
		}
		return { kind: 'bytes', bytes: bytes.slice(), revision };
	}

	/** Returns a fresh plain-data boundary object; no worker-owned object crosses into host state. */
	private snapshotWorkerResult(operation: ParadisOfficeWorkerOperation, value: unknown): object | undefined {
		return new WorkerResultProjector().project(operation, value);
	}

	private safeNow(): number {
		try { const value = this.now(); if (!safeInteger(value)) { return this.lastNow; } this.lastNow = Math.max(this.lastNow, value); return this.lastNow; } catch { return this.lastNow; }
	}
	private deadline(delay: number): number { const now = this.safeNow(); const result = now + delay; return safeInteger(result) ? result : 0; }
	private expired(deadline: number): boolean { const now = this.safeNow(); return deadline === 0 || now >= deadline; }
}
