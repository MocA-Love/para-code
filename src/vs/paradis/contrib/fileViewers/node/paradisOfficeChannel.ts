/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import { createHash } from 'crypto';
import { open, type FileHandle } from 'fs/promises';
import { VSBuffer } from '../../../../base/common/buffer.js';
import { CancellationToken, CancellationTokenSource } from '../../../../base/common/cancellation.js';
import { Event } from '../../../../base/common/event.js';
import { Disposable, IDisposable } from '../../../../base/common/lifecycle.js';
import { URI } from '../../../../base/common/uri.js';
import { IPCServer, IServerChannel } from '../../../../base/parts/ipc/common/ipc.js';
import {
	PARADIS_OFFICE_CHANNEL,
	ParadisOfficeWireError,
	negotiateParadisOffice,
	snapshotParadisOfficeRequest,
	snapshotParadisOfficeResponse,
	type IParadisOfficeDocumentBackend,
	type ParadisOfficeCancelRequest,
	type ParadisOfficeCloseRequest,
	type ParadisOfficeControlRequest,
} from '../common/paradisOfficeChannel.js';
import { createParadisOfficeError } from '../common/paradisOfficeErrors.js';
import {
	type ParadisOfficeSealedSpoolReference,
	snapshotParadisOfficeSealedSpoolAttempt,
	validateParadisOfficeSealRequest,
	validateParadisOfficeSealedSpoolReference,
	validateParadisOfficeSourceDescriptor,
	validateParadisOfficeSpoolAttempt,
	validateParadisOfficeWritableSpoolReference,
} from '../common/paradisOfficeSourceBroker.js';
import {
	PARADIS_OFFICE_BUDGET_PROFILES,
	type ParadisOfficeCompletenessManifest,
	type ParadisOfficeHandleRef,
	type ParadisOfficeRequest,
	type ParadisOfficeResponse,
	type ParadisOfficeRevision,
	type ParadisOfficeSourceDescriptor,
} from '../common/paradisOfficeProtocol.js';
import type { ParadisOfficePackageInventory } from '../common/office/paradisOfficePackageCore.js';
import { OfficeHandleStore, PARADIS_OFFICE_HANDLE_PER_CLIENT_LIMIT, type OfficeHandleCapability } from './office/paradisOfficeHandleStore.js';
import { OfficeMemoryAccountant, OfficeWorkerHost, type OfficeWorkerBytesSource, type OfficeWorkerOutcome } from './office/paradisOfficeWorkerHost.js';
import { OfficeSpoolStore } from './paradisOfficeSpoolStore.js';

const ownerPattern = /^[A-Za-z\d][A-Za-z\d._:-]{0,255}$/;
const maxActiveRequestsPerOwner = 128;

export class ParadisOfficeChannelError extends Error {
	override readonly name = 'ParadisOfficeChannelError';
	constructor() {
		super('The Office document channel request was rejected.');
		Object.defineProperty(this, 'stack', { configurable: true, value: '' });
	}
}

class ParadisOfficeSourceResolutionError extends Error {
	override readonly name = 'ParadisOfficeSourceResolutionError';
	constructor(readonly code: 'notFound' | 'permission' | 'changed' | 'limitExceeded' | 'unsupportedScheme') { super('The Office source could not be resolved.'); Object.defineProperty(this, 'stack', { configurable: true, value: '' }); }
}

export interface IParadisOfficeChannelSourceResolver {
	resolve(ownerId: string, descriptor: ParadisOfficeSourceDescriptor, token: CancellationToken): Promise<OfficeWorkerBytesSource>;
}

interface StoredHandleBinding {
	readonly ownerId: string;
	readonly revision: ParadisOfficeRevision;
}

interface StoredCursorBinding {
	readonly ownerId: string;
	readonly operation: 'compare' | 'search';
	readonly subject: string;
	readonly revision: ParadisOfficeRevision;
}

interface ActiveChannelRequest {
	readonly cancellation: CancellationTokenSource;
	readonly handle?: ParadisOfficeHandleRef;
}

function channelError(): never { throw new ParadisOfficeChannelError(); }

function dataField(value: unknown, name: string): unknown {
	if (!value || typeof value !== 'object' || Array.isArray(value)) { return undefined; }
	try {
		const descriptor = Object.getOwnPropertyDescriptor(value, name);
		return descriptor?.enumerable && Object.prototype.hasOwnProperty.call(descriptor, 'value') ? descriptor.value : undefined;
	} catch { return undefined; }
}

function isOfficeResponse(value: OfficeWorkerBytesSource | ParadisOfficeResponse): value is ParadisOfficeResponse {
	return dataField(value, 'version') === 1;
}

function responseRevision(response: ParadisOfficeResponse): ParadisOfficeRevision | undefined {
	if (!response.ok) { return response.revision; }
	switch (response.operation) {
		case 'close': case 'cancel': return undefined;
		default: return response.revision;
	}
}

function sourceFailure(request: ParadisOfficeRequest, stage: 'source' | 'container' | 'engine' | 'format' | 'transport', code: 'notFound' | 'permission' | 'changed' | 'sideMissing' | 'unsupportedScheme' | 'limitExceeded' | 'engineCrashed' | 'featureUnsupported' | 'cancelled' | 'payloadTooLarge'): ParadisOfficeResponse {
	const details = { severity: 'error' as const, retryable: code === 'changed' || code === 'engineCrashed' || code === 'cancelled', recoverable: true, userAction: code === 'permission' ? 'requestAccess' as const : code === 'unsupportedScheme' || code === 'featureUnsupported' ? 'useLegacyViewer' as const : code === 'limitExceeded' ? 'reduceDocumentSize' as const : 'retry' as const };
	let error;
	switch (stage) {
		case 'source': error = createParadisOfficeError(stage, code as 'notFound', details); break;
		case 'container': error = createParadisOfficeError(stage, code as 'limitExceeded', details); break;
		case 'engine': error = createParadisOfficeError(stage, code as 'engineCrashed', details); break;
		case 'format': error = createParadisOfficeError(stage, code as 'featureUnsupported', details); break;
		case 'transport': error = createParadisOfficeError(stage, code as 'cancelled' | 'payloadTooLarge', details); break;
	}
	return { version: 1, requestId: request.requestId, operation: request.operation, ok: false, outcome: code === 'cancelled' ? 'cancelled' : code === 'changed' ? 'stale' : code === 'limitExceeded' || code === 'payloadTooLarge' ? 'blocked' : 'failed', error };
}

function acknowledged(request: ParadisOfficeControlRequest): ParadisOfficeResponse {
	return { version: 1, requestId: request.requestId, operation: request.operation, ok: true, outcome: 'complete', warnings: [], budgetUsage: {}, timings: {}, acknowledged: true };
}

function snapshotFileRevision(size: number, modified: number, sha256: string): string {
	return `file:${sha256}:${size}:${Math.trunc(modified)}`;
}

/** Local resolver. It reads bounded bytes asynchronously and never sends a URI/path into a worker. */
export class LocalParadisOfficeSourceResolver implements IParadisOfficeChannelSourceResolver {
	async resolve(_ownerId: string, descriptor: ParadisOfficeSourceDescriptor, token: CancellationToken): Promise<OfficeWorkerBytesSource> {
		if ((descriptor.kind !== 'file' && descriptor.kind !== 'workingTree') || !descriptor.uri) { throw new ParadisOfficeSourceResolutionError('unsupportedScheme'); }
		let resource: URI;
		try { resource = URI.parse(descriptor.uri, true); } catch { throw new ParadisOfficeSourceResolutionError('unsupportedScheme'); }
		if (resource.scheme !== 'file' || token.isCancellationRequested) { throw new ParadisOfficeSourceResolutionError('unsupportedScheme'); }
		let handle: FileHandle | undefined;
		try {
			handle = await open(resource.fsPath, 'r');
			const before = await handle.stat();
			if (!before.isFile() || !Number.isSafeInteger(before.size) || before.size < 0) { throw new ParadisOfficeSourceResolutionError('unsupportedScheme'); }
			if (before.size > PARADIS_OFFICE_BUDGET_PROFILES.desktopLocal.compressedInputBytes) { throw new ParadisOfficeSourceResolutionError('limitExceeded'); }
			if (token.isCancellationRequested) { throw new ParadisOfficeSourceResolutionError('changed'); }
			const content = await handle.readFile();
			if (content.byteLength !== before.size || token.isCancellationRequested) { throw new ParadisOfficeSourceResolutionError('changed'); }
			const after = await handle.stat();
			if (before.dev !== after.dev || before.ino !== after.ino || before.size !== after.size || before.mtimeMs !== after.mtimeMs || before.ctimeMs !== after.ctimeMs || token.isCancellationRequested) { throw new ParadisOfficeSourceResolutionError('changed'); }
			const sha256 = createHash('sha256').update(content).digest('hex');
			return { kind: 'bytes', bytes: new Uint8Array(content), revision: snapshotFileRevision(content.byteLength, after.mtimeMs, sha256) };
		} catch (error) {
			if (error instanceof ParadisOfficeSourceResolutionError) { throw error; }
			const code = dataField(error, 'code');
			if (code === 'ENOENT') { throw new ParadisOfficeSourceResolutionError('notFound'); }
			if (code === 'EACCES' || code === 'EPERM') { throw new ParadisOfficeSourceResolutionError('permission'); }
			throw new ParadisOfficeSourceResolutionError('unsupportedScheme');
		} finally { try { await handle?.close(); } catch { } }
	}
}

function descriptorKey(ownerId: string, descriptor: ParadisOfficeSourceDescriptor): string {
	return JSON.stringify([ownerId, descriptor.kind, descriptor.uri ?? null, descriptor.revisionHint ?? null, descriptor.displayName, descriptor.side ?? null]);
}

/** Resolves a one-shot Task 3 sealed spool to Task 5 bytes without serializing the capability to a worker. */
export class SpoolAwareParadisOfficeSourceResolver extends LocalParadisOfficeSourceResolver {
	private readonly bound = new Map<string, ParadisOfficeSealedSpoolReference>();
	constructor(private readonly store: OfficeSpoolStore, private readonly onStoreChange: () => void = () => { }) { super(); }

	bind(ownerId: string, descriptorValue: unknown, spoolValue: unknown): void {
		const descriptor = validateParadisOfficeSourceDescriptor(descriptorValue);
		const spool = validateParadisOfficeSealedSpoolReference(spoolValue);
		if (spool.ownerId !== ownerId || spool.sourceKind !== descriptor.kind) { channelError(); }
		const key = descriptorKey(ownerId, descriptor);
		if (this.bound.has(key)) { channelError(); }
		this.bound.set(key, spool);
	}

	override async resolve(ownerId: string, descriptor: ParadisOfficeSourceDescriptor, token: CancellationToken): Promise<OfficeWorkerBytesSource> {
		const key = descriptorKey(ownerId, descriptor);
		const spool = this.bound.get(key);
		if (!spool) { return super.resolve(ownerId, descriptor, token); }
		this.bound.delete(key);
		try {
			return await this.store.open(spool, async opened => {
				if (token.isCancellationRequested || opened.size > PARADIS_OFFICE_BUDGET_PROFILES.desktopLocal.compressedInputBytes) { channelError(); }
				const bytes = new Uint8Array(opened.size);
				for (let offset = 0; offset < opened.size;) {
					if (token.isCancellationRequested) { channelError(); }
					const length = Math.min(2 * 1024 * 1024, opened.size - offset);
					const chunk = await opened.read(offset, length);
					if (chunk.byteLength !== length) { channelError(); }
					bytes.set(chunk.buffer, offset);
					offset += length;
				}
				return { kind: 'bytes', bytes, revision: opened.revision };
			});
		} finally { this.onStoreChange(); }
	}

	disconnect(ownerId: string): void { for (const [key, spool] of [...this.bound]) { if (spool.ownerId === ownerId) { this.bound.delete(key); void this.store.dispose(spool).catch(() => { }); } } }
}

function exactTransportRecord(value: unknown, keys: readonly string[]): ReadonlyMap<string, unknown> {
	const snapshot = (): ReadonlyMap<string, unknown> => {
		if (!value || typeof value !== 'object' || Array.isArray(value) || Object.getPrototypeOf(value) !== Object.prototype) { channelError(); }
		const ownKeys = Reflect.ownKeys(value);
		if (ownKeys.length !== keys.length || ownKeys.some(key => typeof key !== 'string' || !keys.includes(key))) { channelError(); }
		const result = new Map<string, unknown>();
		for (const key of keys) { const descriptor = Object.getOwnPropertyDescriptor(value, key); if (!descriptor?.enumerable || !Object.prototype.hasOwnProperty.call(descriptor, 'value')) { channelError(); } result.set(key, descriptor.value); }
		return result;
	};
	try {
		const first = snapshot();
		const second = snapshot();
		if (keys.some(key => first.get(key) !== second.get(key))) { channelError(); }
		return second;
	} catch { return channelError(); }
}

/** Exact internal upload commands consumed by the workbench SourceBroker. */
export class ParadisOfficeSpoolTransport {
	constructor(private readonly store: OfficeSpoolStore, private readonly resolver: SpoolAwareParadisOfficeSourceResolver, private readonly accountant?: OfficeMemoryAccountant) { }

	async call(ownerId: string, command: string, value: unknown): Promise<unknown> {
		switch (command) {
			case 'spool/begin': { const fields = exactTransportRecord(value, ['attemptId']); const attempt = validateParadisOfficeSpoolAttempt(ownerId, fields.get('attemptId')); return this.store.begin(ownerId, attempt.attemptId); }
			case 'spool/claim': { const fields = exactTransportRecord(value, ['reference', 'attemptId']); const reference = validateParadisOfficeWritableSpoolReference(fields.get('reference')); if (reference.ownerId !== ownerId) { channelError(); } const attempt = validateParadisOfficeSpoolAttempt(ownerId, fields.get('attemptId')); await this.store.claim(reference, attempt.attemptId); return undefined; }
			case 'spool/append': { const fields = exactTransportRecord(value, ['reference', 'bytes']); const reference = validateParadisOfficeWritableSpoolReference(fields.get('reference')); const bytes = fields.get('bytes'); if (reference.ownerId !== ownerId || !(bytes instanceof VSBuffer)) { channelError(); } await this.store.append(reference, bytes); if (!this.syncSpool()) { await this.store.dispose(reference); this.syncSpool(); channelError(); } return undefined; }
			case 'spool/seal': { const fields = exactTransportRecord(value, ['reference', 'request']); const reference = validateParadisOfficeWritableSpoolReference(fields.get('reference')); if (reference.ownerId !== ownerId) { channelError(); } const request = validateParadisOfficeSealRequest(fields.get('request')); const sealed = await this.store.seal(reference, request); if (!this.syncSpool()) { await this.store.dispose(sealed); this.syncSpool(); channelError(); } return sealed; }
			case 'spool/dispose': { const fields = exactTransportRecord(value, ['reference']); const reference = snapshotParadisOfficeSealedSpoolAttempt(fields.get('reference')).identity; if (!reference || reference.ownerId !== ownerId) { channelError(); } await this.store.dispose(reference); this.syncSpool(); return undefined; }
			case 'source/bind': { const fields = exactTransportRecord(value, ['descriptor', 'spool']); this.resolver.bind(ownerId, fields.get('descriptor'), fields.get('spool')); return undefined; }
			default: channelError();
		}
	}

	disconnect(ownerId: string): void { this.resolver.disconnect(ownerId); try { this.store.disconnect(ownerId); } catch { } this.syncSpool(); }
	private syncSpool(): boolean { try { return this.accountant?.trySetSpool(this.store.byteLength) ?? true; } catch { return false; } }
}

function inventoryFromOutcome(outcome: OfficeWorkerOutcome<object>): ParadisOfficePackageInventory | undefined {
	if (outcome.outcome !== 'complete') { return undefined; }
	const inventory = dataField(outcome.value, 'inventory');
	return inventory && typeof inventory === 'object' ? inventory as ParadisOfficePackageInventory : undefined;
}

function publicInventory(inventory: ParadisOfficePackageInventory) {
	return { format: inventory.format, container: inventory.container, parts: inventory.parts, relationships: inventory.relationships, features: inventory.features, security: inventory.security, budgetProfile: inventory.budgetProfile, budgetUsage: inventory.budgetUsage };
}

function combineCompleteness(left: ParadisOfficeCompletenessManifest, right: ParadisOfficeCompletenessManifest): ParadisOfficeCompletenessManifest {
	return {
		expectedParts: left.expectedParts + right.expectedParts, visitedParts: left.visitedParts + right.visitedParts,
		parsedParts: left.parsedParts + right.parsedParts, opaqueParts: left.opaqueParts + right.opaqueParts,
		failedParts: left.failedParts + right.failedParts, omittedParts: left.omittedParts + right.omittedParts,
		expectedSemanticUnits: left.expectedSemanticUnits + right.expectedSemanticUnits, visitedSemanticUnits: left.visitedSemanticUnits + right.visitedSemanticUnits,
		terminal: left.terminal && right.terminal,
	};
}

/** Minimal local backend. Semantic adapters replace its safe unsupported operations in later tasks. */
export class LocalParadisOfficeDocumentBackend implements IParadisOfficeDocumentBackend {
	private readonly capabilities = new Map<string, OfficeHandleCapability>();

	constructor(
		private readonly resolver: IParadisOfficeChannelSourceResolver = new LocalParadisOfficeSourceResolver(),
		private readonly workers = new OfficeWorkerHost(),
		private readonly handles = new OfficeHandleStore(),
	) { }

	async inspect(ownerId: string, request: Extract<ParadisOfficeRequest, { readonly operation: 'inspect' }>, token: CancellationToken): Promise<unknown> {
		const resolved = await this.resolve(ownerId, request, request.source, token);
		if (isOfficeResponse(resolved)) { return resolved; }
		const outcome = await this.workers.run<object>('inspect', ownerId, resolved, PARADIS_OFFICE_BUDGET_PROFILES.desktopLocal, token);
		const inventory = inventoryFromOutcome(outcome);
		if (!inventory) { return this.workerFailure(request, outcome); }
		return { version: 1, requestId: request.requestId, operation: 'inspect', ok: true, outcome: inventory.outcome, warnings: inventory.warnings, budgetUsage: { ...inventory.budgetUsage }, timings: { total: inventory.budgetUsage.elapsedMilliseconds }, revision: { kind: 'document', sourceRevision: resolved.revision }, completeness: inventory.completeness, inventory: publicInventory(inventory) };
	}

	async open(ownerId: string, request: Extract<ParadisOfficeRequest, { readonly operation: 'open' }>, token: CancellationToken): Promise<unknown> {
		const resolved = await this.resolve(ownerId, request, request.source, token);
		if (isOfficeResponse(resolved)) { return resolved; }
		const outcome = await this.workers.run<object>('inspect', ownerId, resolved, PARADIS_OFFICE_BUDGET_PROFILES.desktopLocal, token);
		const inventory = inventoryFromOutcome(outcome);
		if (!inventory) { return this.workerFailure(request, outcome); }
		const capability = this.handles.create(ownerId, 'document', resolved.revision, resolved.bytes.byteLength);
		this.capabilities.set(this.capabilityKey(ownerId, capability), capability);
		return { version: 1, requestId: request.requestId, operation: 'open', ok: true, outcome: inventory.outcome, warnings: inventory.warnings, budgetUsage: { ...inventory.budgetUsage }, timings: { total: inventory.budgetUsage.elapsedMilliseconds }, revision: { kind: 'document', sourceRevision: resolved.revision }, completeness: inventory.completeness, handle: { kind: 'document', id: capability.id }, capabilities: [] };
	}

	async compare(ownerId: string, request: Extract<ParadisOfficeRequest, { readonly operation: 'compare' }>, token: CancellationToken): Promise<unknown> {
		const original = await this.resolve(ownerId, request, request.original, token);
		if (isOfficeResponse(original)) { return original; }
		const modified = await this.resolve(ownerId, request, request.modified, token);
		if (isOfficeResponse(modified)) { return modified; }
		const [originalOutcome, modifiedOutcome] = await Promise.all([
			this.workers.run<object>('inspect', ownerId, original, PARADIS_OFFICE_BUDGET_PROFILES.desktopLocal, token),
			this.workers.run<object>('inspect', ownerId, modified, PARADIS_OFFICE_BUDGET_PROFILES.desktopLocal, token),
		]);
		const originalInventory = inventoryFromOutcome(originalOutcome);
		const modifiedInventory = inventoryFromOutcome(modifiedOutcome);
		if (!originalInventory) { return this.workerFailure(request, originalOutcome); }
		if (!modifiedInventory) { return this.workerFailure(request, modifiedOutcome); }
		const comparisonRevision = createHash('sha256').update(original.revision).update('\0').update(modified.revision).digest('hex');
		const capability = this.handles.create(ownerId, 'comparison', comparisonRevision, original.bytes.byteLength + modified.bytes.byteLength);
		this.capabilities.set(this.capabilityKey(ownerId, capability), capability);
		return { version: 1, requestId: request.requestId, operation: 'compare', ok: true, outcome: 'degraded', warnings: [{ code: 'semanticComparisonPending', message: 'Semantic comparison is not available for this adapter.' }], budgetUsage: {}, timings: {}, revision: { kind: 'comparison', originalRevision: original.revision, modifiedRevision: modified.revision, comparisonRevision }, completeness: combineCompleteness(originalInventory.completeness, modifiedInventory.completeness), handle: { kind: 'comparison', id: capability.id }, changes: [], terminal: true };
	}

	getViewport(_ownerId: string, request: Extract<ParadisOfficeRequest, { readonly operation: 'getViewport' }>, _token: CancellationToken): Promise<unknown> { return Promise.resolve(sourceFailure(request, 'format', 'featureUnsupported')); }
	search(_ownerId: string, request: Extract<ParadisOfficeRequest, { readonly operation: 'search' }>, _token: CancellationToken): Promise<unknown> { return Promise.resolve(sourceFailure(request, 'format', 'featureUnsupported')); }
	getRenderableAsset(_ownerId: string, request: Extract<ParadisOfficeRequest, { readonly operation: 'getRenderableAsset' }>, _token: CancellationToken): Promise<unknown> { return Promise.resolve(sourceFailure(request, 'format', 'featureUnsupported')); }
	getPrintModel(_ownerId: string, request: Extract<ParadisOfficeRequest, { readonly operation: 'getPrintModel' }>, _token: CancellationToken): Promise<unknown> { return Promise.resolve(sourceFailure(request, 'format', 'featureUnsupported')); }
	exportPrint(_ownerId: string, request: Extract<ParadisOfficeRequest, { readonly operation: 'exportPrint' }>, _token: CancellationToken): Promise<unknown> { return Promise.resolve(sourceFailure(request, 'format', 'featureUnsupported')); }

	close(ownerId: string, request: ParadisOfficeCloseRequest, _token: CancellationToken): Promise<unknown> {
		if (request.handle) {
			const key = this.capabilityKey(ownerId, request.handle);
			const capability = this.capabilities.get(key);
			if (!capability || !this.handles.close(capability)) { return Promise.resolve(sourceFailure(request, 'transport', 'cancelled')); }
			this.capabilities.delete(key);
		}
		return Promise.resolve(acknowledged(request));
	}

	cancel(_ownerId: string, request: ParadisOfficeCancelRequest, _token: CancellationToken): Promise<unknown> { return Promise.resolve(acknowledged(request)); }

	disconnect(ownerId: string): void {
		this.handles.onWindowClose(ownerId);
		for (const key of [...this.capabilities.keys()]) { if (key.startsWith(`${ownerId}\0`)) { this.capabilities.delete(key); } }
	}

	private async resolve(ownerId: string, request: ParadisOfficeRequest, descriptor: ParadisOfficeSourceDescriptor, token: CancellationToken): Promise<OfficeWorkerBytesSource | ParadisOfficeResponse> {
		if (descriptor.kind === 'sideMissing') { return sourceFailure(request, 'source', 'sideMissing'); }
		try { return await this.resolver.resolve(ownerId, descriptor, token); } catch (error) {
			if (token.isCancellationRequested) { return sourceFailure(request, 'transport', 'cancelled'); }
			if (error instanceof ParadisOfficeSourceResolutionError) {
				if (error.code === 'limitExceeded') { return sourceFailure(request, 'container', 'limitExceeded'); }
				return sourceFailure(request, 'source', error.code);
			}
			return sourceFailure(request, 'source', 'unsupportedScheme');
		}
	}

	private workerFailure(request: ParadisOfficeRequest, outcome: OfficeWorkerOutcome<object>): ParadisOfficeResponse {
		return outcome.outcome === 'cancelled' ? sourceFailure(request, 'transport', 'cancelled') : outcome.outcome === 'blocked' ? sourceFailure(request, 'container', 'limitExceeded') : sourceFailure(request, 'engine', 'engineCrashed');
	}

	private capabilityKey(ownerId: string, handle: ParadisOfficeHandleRef): string { return `${ownerId}\0${handle.kind}:${handle.id}`; }
}

/** Exact v1 transport with owner/request/handle/revision/cursor fences. */
export class ParadisOfficeChannel extends Disposable implements IServerChannel<string> {
	private readonly active = new Map<string, ActiveChannelRequest>();
	private readonly handles = new Map<string, StoredHandleBinding>();
	private readonly cursors = new Map<string, StoredCursorBinding>();
	private readonly knownOwners = new Set<string>();

	constructor(private readonly backend: IParadisOfficeDocumentBackend = new LocalParadisOfficeDocumentBackend(), onDidDisconnect: Event<string> = Event.None, private readonly spoolTransport?: ParadisOfficeSpoolTransport) {
		super();
		this._register(onDidDisconnect(ownerId => this.disconnect(ownerId)));
	}

	listen<T>(_ctx: string, event: string): Event<T> { throw new ParadisOfficeChannelError(); }

	async call<T>(ctx: string, command: string, arg?: unknown, cancellationToken: CancellationToken = CancellationToken.None): Promise<T> {
		if (!ownerPattern.test(ctx)) { return channelError(); }
		this.knownOwners.add(ctx);
		if (command === 'negotiate') {
			try { return negotiateParadisOffice(arg) as T; } catch { return channelError(); }
		}
		if (command.startsWith('spool/') || command === 'source/bind') {
			if (!this.spoolTransport) { return channelError(); }
			try { return await this.spoolTransport.call(ctx, command, arg) as T; } catch { return channelError(); }
		}
		if (command !== 'request') { return channelError(); }
		let request: ParadisOfficeRequest;
		try { request = snapshotParadisOfficeRequest(arg); } catch { return channelError(); }
		this.validateRequestBinding(ctx, request);
		const activeKey = this.requestKey(ctx, request.requestId);
		if (this.active.has(activeKey) || this.activeForOwner(ctx) >= maxActiveRequestsPerOwner) { return channelError(); }
		if (request.operation === 'cancel' && request.targetRequestId) {
			const target = this.active.get(this.requestKey(ctx, request.targetRequestId));
			if (!target) { return channelError(); }
			try { target.cancellation.cancel(); } catch { return channelError(); }
		}
		if ((request.operation === 'close' || request.operation === 'cancel') && request.handle) { this.cancelHandleRequests(ctx, request.handle); }
		let source: CancellationTokenSource;
		try { source = new CancellationTokenSource(cancellationToken); } catch { return channelError(); }
		const requestHandle = this.requestHandle(request);
		this.active.set(activeKey, { cancellation: source, ...(requestHandle ? { handle: requestHandle } : {}) });
		try {
			let raw: unknown;
			try { raw = await this.dispatch(ctx, request, source.token); }
			catch { return sourceFailure(request, source.token.isCancellationRequested ? 'transport' : 'engine', source.token.isCancellationRequested ? 'cancelled' : 'engineCrashed') as T; }
			let response: ParadisOfficeResponse;
			try { response = snapshotParadisOfficeResponse(raw); }
			catch (error) { this.disconnect(ctx); return (error instanceof ParadisOfficeWireError && error.code === 'payloadTooLarge' ? sourceFailure(request, 'transport', 'payloadTooLarge') : sourceFailure(request, 'engine', 'engineCrashed')) as T; }
			try { this.validateResponseBinding(ctx, request, response); }
			catch { this.disconnect(ctx); return sourceFailure(request, 'engine', 'engineCrashed') as T; }
			return response as T;
		} finally {
			this.active.delete(activeKey);
			try { source.dispose(); } catch { }
		}
	}

	override dispose(): void {
		for (const active of this.active.values()) { try { active.cancellation.cancel(); } catch { } try { active.cancellation.dispose(); } catch { } }
		this.active.clear();
		for (const owner of [...this.knownOwners]) { this.disconnect(owner); }
		this.handles.clear(); this.cursors.clear();
		super.dispose();
	}

	private dispatch(ownerId: string, request: ParadisOfficeRequest, token: CancellationToken): Promise<unknown> {
		switch (request.operation) {
			case 'inspect': return this.backend.inspect(ownerId, request, token);
			case 'open': return this.backend.open(ownerId, request, token);
			case 'getViewport': return this.backend.getViewport(ownerId, request, token);
			case 'compare': return this.backend.compare(ownerId, request, token);
			case 'search': return this.backend.search(ownerId, request, token);
			case 'getRenderableAsset': return this.backend.getRenderableAsset(ownerId, request, token);
			case 'getPrintModel': return this.backend.getPrintModel(ownerId, request, token);
			case 'exportPrint': return this.backend.exportPrint(ownerId, request, token);
			case 'close': return this.backend.close(ownerId, request as ParadisOfficeCloseRequest, token);
			case 'cancel': return this.backend.cancel(ownerId, request as ParadisOfficeCancelRequest, token);
		}
	}

	private validateRequestBinding(ownerId: string, request: ParadisOfficeRequest): void {
		if ((request.operation === 'open' || (request.operation === 'compare' && request.cursor === undefined)) && this.handleCount(ownerId) >= PARADIS_OFFICE_HANDLE_PER_CLIENT_LIMIT) { channelError(); }
		const handle = this.requestHandle(request);
		if (handle) {
			const binding = this.handles.get(this.handleKey(handle));
			if (!binding || binding.ownerId !== ownerId) { channelError(); }
		}
		if ((request.operation === 'compare' || request.operation === 'search') && request.cursor) {
			const binding = this.cursors.get(request.cursor);
			const subject = request.operation === 'search' ? this.handleKey(request.handle) : this.compareSubject(request);
			if (!binding || binding.ownerId !== ownerId || binding.operation !== request.operation || binding.subject !== subject) { channelError(); }
		}
	}

	private validateResponseBinding(ownerId: string, request: ParadisOfficeRequest, response: ParadisOfficeResponse): void {
		if (response.requestId !== request.requestId || response.operation !== request.operation || response.version !== 1) { channelError(); }
		const requestHandle = this.requestHandle(request);
		const revision = responseRevision(response);
		if ((request.operation === 'compare' || request.operation === 'search') && request.cursor) {
			const cursor = this.cursors.get(request.cursor);
			if (!cursor || !revision || !this.sameRevision(cursor.revision, revision)) { channelError(); }
		}
		if (requestHandle && revision) {
			const binding = this.handles.get(this.handleKey(requestHandle));
			if (!binding || !this.sameRevision(binding.revision, revision)) { channelError(); }
		}
		if (response.ok && (response.operation === 'open' || response.operation === 'compare')) {
			const key = this.handleKey(response.handle);
			const existing = this.handles.get(key);
			if (existing && (request.operation !== 'compare' || request.cursor === undefined || existing.ownerId !== ownerId || !this.sameRevision(existing.revision, response.revision))) { channelError(); }
			this.handles.set(key, { ownerId, revision: response.revision });
		}
		if (response.ok && response.operation === 'close' && requestHandle) {
			const subject = this.handleKey(requestHandle);
			this.handles.delete(subject);
			for (const [key, binding] of [...this.cursors]) { if (binding.ownerId === ownerId && binding.subject === subject) { this.cursors.delete(key); } }
		}
		if (response.ok && (response.operation === 'compare' || response.operation === 'search') && response.nextCursor) {
			let subject: string;
			if (response.operation === 'search' && request.operation === 'search') { subject = this.handleKey(request.handle); }
			else if (response.operation === 'compare' && request.operation === 'compare') { subject = this.compareSubject(request); }
			else { channelError(); }
			this.evictOwnerCursorIfNeeded(ownerId);
			this.cursors.set(response.nextCursor, { ownerId, operation: response.operation, subject, revision: response.revision });
		}
	}

	private disconnect(ownerId: string): void {
		if (!ownerPattern.test(ownerId)) { return; }
		for (const [key, active] of [...this.active]) { if (key.startsWith(`${ownerId}\0`)) { try { active.cancellation.cancel(); } catch { } try { active.cancellation.dispose(); } catch { } this.active.delete(key); } }
		for (const [key, binding] of [...this.handles]) { if (binding.ownerId === ownerId) { this.handles.delete(key); } }
		for (const [key, binding] of [...this.cursors]) { if (binding.ownerId === ownerId) { this.cursors.delete(key); } }
		this.knownOwners.delete(ownerId);
		try { this.spoolTransport?.disconnect(ownerId); } catch { }
		try { this.backend.disconnect(ownerId); } catch { }
	}

	private activeForOwner(ownerId: string): number { let count = 0; for (const key of this.active.keys()) { if (key.startsWith(`${ownerId}\0`)) { count++; } } return count; }
	private cancelHandleRequests(ownerId: string, handle: ParadisOfficeHandleRef): void { const handleKey = this.handleKey(handle); for (const [key, active] of this.active) { if (key.startsWith(`${ownerId}\0`) && active.handle && this.handleKey(active.handle) === handleKey) { try { active.cancellation.cancel(); } catch { } } } }
	private handleCount(ownerId: string): number { let count = 0; for (const binding of this.handles.values()) { if (binding.ownerId === ownerId) { count++; } } return count; }
	private evictOwnerCursorIfNeeded(ownerId: string): void { let count = 0; let oldest: string | undefined; for (const [key, binding] of this.cursors) { if (binding.ownerId !== ownerId) { continue; } count++; oldest ??= key; } if (count >= 256 && oldest) { this.cursors.delete(oldest); } }
	private requestKey(ownerId: string, requestId: string): string { return `${ownerId}\0${requestId}`; }
	private handleKey(handle: ParadisOfficeHandleRef): string { return `${handle.kind}:${handle.id}`; }
	private requestHandle(request: ParadisOfficeRequest): ParadisOfficeHandleRef | undefined {
		switch (request.operation) {
			case 'getViewport': case 'search': case 'getRenderableAsset': case 'getPrintModel': case 'exportPrint': return request.handle;
			case 'close': case 'cancel': return request.handle;
			default: return undefined;
		}
	}
	private compareSubject(request: Extract<ParadisOfficeRequest, { readonly operation: 'compare' }>): string { return JSON.stringify([this.sourceSubject(request.original), this.sourceSubject(request.modified), request.categories ?? []]); }
	private sourceSubject(source: ParadisOfficeSourceDescriptor): readonly unknown[] { return [source.kind, source.uri ?? null, source.revisionHint ?? null, source.displayName, source.side ?? null]; }
	private sameRevision(left: ParadisOfficeRevision, right: ParadisOfficeRevision): boolean { return left.kind === right.kind && (left.kind === 'document' ? left.sourceRevision === (right as Extract<ParadisOfficeRevision, { readonly kind: 'document' }>).sourceRevision : left.originalRevision === (right as Extract<ParadisOfficeRevision, { readonly kind: 'comparison' }>).originalRevision && left.modifiedRevision === (right as Extract<ParadisOfficeRevision, { readonly kind: 'comparison' }>).modifiedRevision && left.comparisonRevision === (right as Extract<ParadisOfficeRevision, { readonly kind: 'comparison' }>).comparisonRevision); }
}

export function registerParadisOffice(server: IPCServer<string>, backend?: IParadisOfficeDocumentBackend): IDisposable {
	let channelBackend: IParadisOfficeDocumentBackend;
	let transport: ParadisOfficeSpoolTransport | undefined;
	if (backend) { channelBackend = backend; }
	else {
		const accountant = new OfficeMemoryAccountant(1_280 * 1024 * 1024);
		const store = new OfficeSpoolStore({ platform: 'desktopLocal' });
		const resolver = new SpoolAwareParadisOfficeSourceResolver(store, () => { accountant.trySetSpool(store.byteLength); });
		const handles = new OfficeHandleStore({ accountant });
		const workers = new OfficeWorkerHost({ accountant, onWorkerCrashed: workerId => handles.invalidateWorker(workerId) });
		channelBackend = new LocalParadisOfficeDocumentBackend(resolver, workers, handles);
		transport = new ParadisOfficeSpoolTransport(store, resolver, accountant);
	}
	const channel = new ParadisOfficeChannel(channelBackend, Event.map(server.onDidRemoveConnection, connection => connection.ctx), transport);
	server.registerChannel(PARADIS_OFFICE_CHANNEL, channel);
	return channel;
}
