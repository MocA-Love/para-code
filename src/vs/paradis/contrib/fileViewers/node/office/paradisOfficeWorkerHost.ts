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
	setCache(bytes: number): void { this.cacheBytes = this.valid(bytes); }
	setHandles(bytes: number): void { this.handleBytes = this.valid(bytes); }
	setSpool(bytes: number): void { this.spoolBytes = this.valid(bytes); }
	setDerivedAssets(bytes: number): void { this.derivedAssetBytes = this.valid(bytes); }
	reserveWorker(bytes: number): boolean { const total = this.total() + this.valid(bytes); if (!safeInteger(total) || total > this.limitBytes) { return false; } this.workerBytes += bytes; return true; }
	releaseWorker(bytes: number): void { bytes = this.valid(bytes); this.workerBytes = Math.max(0, this.workerBytes - bytes); }
	snapshot(): OfficeMemorySnapshot { return { limitBytes: this.limitBytes, workerBytes: this.workerBytes, cacheBytes: this.cacheBytes, handleBytes: this.handleBytes, spoolBytes: this.spoolBytes, derivedAssetBytes: this.derivedAssetBytes, totalBytes: this.total() }; }
	private total(): number { const total = this.workerBytes + this.cacheBytes + this.handleBytes + this.spoolBytes + this.derivedAssetBytes; return safeInteger(total) ? total : Number.MAX_SAFE_INTEGER; }
	private valid(bytes: number): number { if (!safeInteger(bytes)) { throw new TypeError('Invalid Office memory bytes'); } return bytes; }
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
			const job: PendingJob<T> = {
				requestId, operation, ownerId, source: safeSource, budget: safeBudget, token, reservationBytes, queueDeadline: this.deadline(PARADIS_OFFICE_WORKER_QUEUE_MILLISECONDS), operationDeadline: 0, ...(options.workerId ? { workerId: options.workerId } : {}), queuedAt: this.safeNow(), resolve,
				cancellationListener: token.onCancellationRequested(() => this.cancel(job as unknown as PendingJob<object>)), state: 'queued', released: false, terminal: undefined, settled: false, orphaned: false,
			};
			job.queueTimer = this.setTimer(() => this.finish(job as unknown as PendingJob<object>, { outcome: 'blocked', error: 'limitExceeded' }), PARADIS_OFFICE_WORKER_QUEUE_MILLISECONDS);
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
			void job.worker?.terminate();
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
		if (job.queueTimer !== undefined) { this.clearTimer(job.queueTimer); job.queueTimer = undefined; }
		let worker: IOfficeWorker;
		try { worker = this.createWorker(); } catch { this.finish(job, { outcome: 'failed', error: 'engineCrashed' }); return; }
		job.worker = worker;
		job.workerListeners = [
			worker.onMessage(message => this.onWorkerMessage(job, message)),
			worker.onError(() => this.workerStopped(job)),
			worker.onExit(() => this.workerStopped(job)),
		];
		if (job.state === 'finished') { return; }
		job.deadlineTimer = this.setTimer(() => {
			job.terminal = 'blocked';
			this.reap(job, { outcome: 'blocked', error: 'limitExceeded' });
		}, operationDeadline(job.operation, job.budget));
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
		job.cancelTimer = this.setTimer(() => {
			if (job.state !== 'finished') {
				this.reap(job, { outcome: 'cancelled' });
			}
		}, PARADIS_OFFICE_WORKER_CANCEL_GRACE_MILLISECONDS);
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
			if (this.validWorkerResult(job.operation, value)) {
				this.reap(job, { outcome: 'complete', value: value as object });
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
		if (job.deadlineTimer !== undefined) { this.clearTimer(job.deadlineTimer); job.deadlineTimer = undefined; }
		if (job.cancelTimer !== undefined) { this.clearTimer(job.cancelTimer); job.cancelTimer = undefined; }
		if (!job.worker) { this.finish(job, outcome); return; }
		try {
			job.reapTimer = this.setTimer(() => this.orphan(job, outcome), PARADIS_OFFICE_WORKER_CANCEL_GRACE_MILLISECONDS);
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
		if (!job.released) { job.released = true; this.accountant?.releaseWorker(job.reservationBytes); }
		for (const timer of [job.queueTimer, job.deadlineTimer, job.cancelTimer, job.reapTimer]) { try { if (timer !== undefined) { this.clearTimer(timer); } } catch { } }
		try { job.cancellationListener.dispose(); } catch { }
		for (const listener of job.workerListeners ?? []) { try { listener.dispose(); } catch { } }
		if (!job.settled) { job.settled = true; job.resolve(outcome); }
		this.pump();
	}

	private reserve(job: PendingJob<object>): boolean {
		if (this.accountant && !this.accountant.reserveWorker(job.reservationBytes)) { return false; }
		const current = this.memoryUsage();
		const limit = this.memory.limitBytes ?? memoryLimit(job.budget);
		const requested = current + job.reservationBytes;
		if (!safeInteger(requested)) { this.accountant?.releaseWorker(job.reservationBytes); return false; }
		if (requested <= limit) { return true; }
		const required = requested - limit;
		try { this.memory.evictInactiveCache?.(required); } catch { return false; }
		const admitted = this.memoryUsage() + job.reservationBytes <= limit;
		if (!admitted) { this.accountant?.releaseWorker(job.reservationBytes); }
		return admitted;
	}

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

	private validWorkerResult(operation: ParadisOfficeWorkerOperation, value: unknown): value is object {
		// The operation-specific snapshots below use descriptor-only reads and reject all unknown
		// fields. They are the boundary validation for Task 4 inventory objects.
		if (operation === 'parse' || operation === 'diff') { return this.validHandleSummary(operation, value); }
		try {
			if (!value || typeof value !== 'object' || Array.isArray(value) || Object.getPrototypeOf(value) !== Object.prototype || Reflect.ownKeys(value).length !== 1 || !Object.prototype.hasOwnProperty.call(value, 'inventory')) { return false; }
			const inventoryDescriptor = Object.getOwnPropertyDescriptor(value, 'inventory');
			if (!inventoryDescriptor?.enumerable || !Object.prototype.hasOwnProperty.call(inventoryDescriptor, 'value')) { return false; }
		} catch { return false; }
		const inventory = dataField(value, 'inventory');
		return this.validInventory(inventory);
	}

	private validInventory(value: unknown): boolean {
		const allowed = new Set(['format', 'container', 'parts', 'relationships', 'features', 'security', 'budgetProfile', 'budgetUsage', 'outcome', 'completeness', 'warnings']);
		if (!this.exactRecord(value, allowed)) { return false; }
		const format = dataField(value, 'format');
		const container = dataField(value, 'container');
		const outcome = dataField(value, 'outcome');
		const parts = dataField(value, 'parts');
		const relationships = dataField(value, 'relationships');
		const features = dataField(value, 'features');
		if (!['xlsx', 'xlsm', 'docx', 'docm', 'pptx', 'pptm', 'zip', 'unknown'].includes(format as string) || container !== 'opc' || !['complete', 'degraded', 'blocked'].includes(outcome as string) || !Array.isArray(parts) || !Array.isArray(relationships) || !Array.isArray(features)) { return false; }
		const completeness = dataField(value, 'completeness');
		if (!this.exactRecord(completeness, new Set(['expectedParts', 'visitedParts', 'parsedParts', 'opaqueParts', 'failedParts', 'omittedParts', 'expectedSemanticUnits', 'visitedSemanticUnits', 'terminal']))) { return false; }
		const counters = ['expectedParts', 'visitedParts', 'parsedParts', 'opaqueParts', 'failedParts', 'omittedParts', 'expectedSemanticUnits', 'visitedSemanticUnits'].map(name => dataField(completeness, name));
		if (counters.some(counter => !safeInteger(counter)) || dataField(completeness, 'terminal') !== true) { return false; }
		const [expected, visited, parsed, opaque, failed, omitted] = counters as number[];
		if (expected !== visited || visited !== parsed + opaque + failed + omitted) { return false; }
		return parts.every(part => this.validPart(part)) && relationships.every(relationship => this.exactRecord(relationship, new Set(['id', 'sourcePartId', 'type', 'target', 'targetMode', 'missing', 'cyclic'])))
			&& features.every(feature => this.exactRecord(feature, new Set(['kind', 'partIds', 'supported', 'safe'])));
	}

	private validPart(value: unknown): boolean {
		if (!this.exactRecord(value, new Set(['id', 'canonicalUri', 'contentType', 'compressedBytes', 'expandedBytes', 'required', 'coverage', 'rawHash', 'hashCompleteness', 'canonicalHash', 'fingerprint']))) { return false; }
		const coverage = dataField(value, 'coverage');
		if (!['parsed', 'partial', 'opaque', 'completeOpaque', 'unsafe', 'failed', 'omittedByBudget'].includes(coverage as string) || typeof dataField(value, 'id') !== 'string' || typeof dataField(value, 'canonicalUri') !== 'string' || typeof dataField(value, 'contentType') !== 'string' || !safeInteger(dataField(value, 'compressedBytes')) || !safeInteger(dataField(value, 'expandedBytes')) || typeof dataField(value, 'required') !== 'boolean') { return false; }
		if (coverage === 'parsed' || coverage === 'completeOpaque') {
			const hash = dataField(value, coverage === 'parsed' ? 'rawHash' : 'fingerprint');
			return this.exactRecord(hash, new Set(['algorithm', 'value', 'byteLength'])) && dataField(hash, 'algorithm') === 'sha256' && typeof dataField(hash, 'value') === 'string' && /^[a-f\d]{64}$/i.test(dataField(hash, 'value') as string) && safeInteger(dataField(hash, 'byteLength')) && dataField(value, 'hashCompleteness') === 'allBytes';
		}
		return true;
	}

	private validHandleSummary(operation: 'parse' | 'diff', value: unknown): boolean {
		if (!this.exactRecord(value, new Set(['operation', 'handle', 'outcome', 'completeness', 'capabilities', 'changes']))) { return false; }
		const handle = dataField(value, 'handle');
		return dataField(value, 'operation') === operation && this.exactRecord(handle, new Set(['kind', 'id'])) && (dataField(handle, 'kind') === 'document' || dataField(handle, 'kind') === 'comparison') && typeof dataField(handle, 'id') === 'string' && ['complete', 'degraded'].includes(dataField(value, 'outcome') as string) && !!dataField(value, 'completeness');
	}

	private exactRecord(value: unknown, allowed: ReadonlySet<string>): boolean {
		if (!value || typeof value !== 'object' || Array.isArray(value)) { return false; }
		try { const prototype = Object.getPrototypeOf(value); const keys = Reflect.ownKeys(value); return (prototype === Object.prototype || prototype === null) && keys.length > 0 && keys.every(key => typeof key === 'string' && allowed.has(key) && !!Object.getOwnPropertyDescriptor(value, key)?.enumerable && Object.prototype.hasOwnProperty.call(Object.getOwnPropertyDescriptor(value, key), 'value')); } catch { return false; }
	}

	private safeNow(): number {
		try { const value = this.now(); if (!safeInteger(value)) { return this.lastNow; } this.lastNow = Math.max(this.lastNow, value); return this.lastNow; } catch { return this.lastNow; }
	}
	private deadline(delay: number): number { const now = this.safeNow(); const result = now + delay; return safeInteger(result) ? result : 0; }
	private expired(deadline: number): boolean { const now = this.safeNow(); return deadline === 0 || now >= deadline; }
}
