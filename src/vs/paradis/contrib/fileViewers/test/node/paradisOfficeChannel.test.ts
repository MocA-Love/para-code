/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import * as assert from 'assert';
import { createHash } from 'crypto';
import { mkdtemp, rm, writeFile } from 'fs/promises';
import { tmpdir } from 'os';
import { VSBuffer } from '../../../../../base/common/buffer.js';
import { CancellationToken, CancellationTokenSource } from '../../../../../base/common/cancellation.js';
import { Emitter, Event } from '../../../../../base/common/event.js';
import { DisposableStore } from '../../../../../base/common/lifecycle.js';
import { join } from '../../../../../base/common/path.js';
import { BufferWriter, ChannelClient, ChannelServer, IPCClient, IPCServer, serialize, type IMessagePassingProtocol } from '../../../../../base/parts/ipc/common/ipc.js';
import { URI } from '../../../../../base/common/uri.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { createParadisOfficeError } from '../../common/paradisOfficeErrors.js';
import { buildParadisOfficeSourceRevision } from '../../common/paradisOfficeSourceBroker.js';
import {
	PARADIS_OFFICE_CHANNEL,
	PARADIS_OFFICE_MAX_IPC_BYTES,
	PARADIS_OFFICE_MAX_SPOOL_APPEND_METADATA_BYTES,
	PARADIS_OFFICE_WIRE_ENVELOPE,
	ParadisOfficeWireError,
	decodeParadisOfficeWireValue,
	measureParadisOfficeWireBytes,
	marshalParadisOfficeRequest,
	marshalParadisOfficeSpoolAppend,
	marshalParadisOfficeWireValue,
	measureParadisOfficeIpcWireBytes,
	snapshotParadisOfficeRequest,
	snapshotParadisOfficeResponse,
	snapshotParadisOfficeRestoreState,
	validateParadisOfficeAssetRange,
	unmarshalParadisOfficeResponse,
	unmarshalParadisOfficeWireValue,
	type IParadisOfficeDocumentBackend,
	type ParadisOfficeCancelRequest,
	type ParadisOfficeCloseRequest,
	type ParadisOfficeWireAuthority,
	type ParadisOfficeWireDecodeObserver,
} from '../../common/paradisOfficeChannel.js';
import { PARADIS_OFFICE_LIMITS, type ParadisOfficeChangeCategory, type ParadisOfficeRequest, type ParadisOfficeResponse } from '../../common/paradisOfficeProtocol.js';
import { LocalParadisOfficeDocumentBackend, LocalParadisOfficeSourceResolver, PARADIS_OFFICE_ACTIVE_REQUEST_LIMIT, PARADIS_OFFICE_CONTROL_REQUEST_LIMIT, PARADIS_OFFICE_FILE_GLOBAL_LIMIT, PARADIS_OFFICE_FILE_PER_OWNER_LIMIT, PARADIS_OFFICE_FILE_READ_CHUNK_BYTES, ParadisOfficeChannel, ParadisOfficeChannelError, ParadisOfficeSourceResolutionError, ParadisOfficeSpoolTransport, SpoolAwareParadisOfficeSourceResolver, buildParadisOfficeFileRevision, registerParadisOffice, type IParadisOfficeFileHandle } from '../../node/paradisOfficeChannel.js';
import { OfficeSpoolStore } from '../../node/paradisOfficeSpoolStore.js';
import { OfficeMemoryAccountant } from '../../node/office/paradisOfficeWorkerHost.js';
import { buildOpcFixture } from '../common/paradisOfficeFixture.js';

const documentHandle = { kind: 'document' as const, id: 'a'.repeat(48) };
const comparisonHandle = { kind: 'comparison' as const, id: 'b'.repeat(48) };
const source = { kind: 'file' as const, uri: 'file:///safe/document.docx', displayName: 'document.docx', revisionHint: 'hint-1' };
const completeness = { expectedParts: 1, visitedParts: 1, parsedParts: 1, opaqueParts: 0, failedParts: 0, omittedParts: 0, expectedSemanticUnits: 1, visitedSemanticUnits: 1, terminal: true };

class QueueProtocol implements IMessagePassingProtocol {
	private buffering = true;
	private readonly buffered: VSBuffer[] = [];
	private readonly emitter = new Emitter<VSBuffer>({ onDidAddFirstListener: () => { this.buffering = false; for (const buffer of this.buffered.splice(0)) { this.emitter.fire(buffer); } }, onDidRemoveLastListener: () => this.buffering = true });
	readonly onMessage = this.emitter.event;
	other!: QueueProtocol;
	send(buffer: VSBuffer): void { if (this.other.buffering) { this.other.buffered.push(buffer); } else { this.other.emitter.fire(buffer); } }
	dispose(): void { this.emitter.dispose(); }
}

function createProtocolPair(): readonly [QueueProtocol, QueueProtocol] {
	const client = new QueueProtocol();
	const server = new QueueProtocol();
	client.other = server;
	server.other = client;
	return [client, server];
}

function independentlySerializedIpcBytes(value: unknown): number {
	const writer = new BufferWriter();
	try { serialize(writer, value); return writer.buffer.byteLength; } finally { writer.dispose(); }
}

class FakeOfficeFileHandle implements IParadisOfficeFileHandle {
	readonly readLengths: number[] = [];
	closed = 0;
	statCount = 0;
	constructor(private readonly content: Uint8Array, private readonly declaredSize = content.byteLength, private readonly onRead?: (position: number) => void, private readonly readError?: unknown) { }
	stat(): Promise<{ readonly dev: number; readonly ino: number; readonly ctimeMs: number; readonly mtimeMs: number; readonly size: number; isFile(): boolean }> {
		this.statCount++;
		return Promise.resolve({ dev: 7, ino: 11, ctimeMs: 1.25, mtimeMs: 2.75, size: this.declaredSize, isFile: () => true });
	}
	async read(buffer: Uint8Array, offset: number, length: number, position: number): Promise<{ readonly bytesRead: number }> {
		this.readLengths.push(length);
		this.onRead?.(position);
		if (this.readError) { throw this.readError; }
		const available = Math.max(0, Math.min(length, this.content.byteLength - position));
		buffer.set(this.content.subarray(position, position + available), offset);
		return { bytesRead: available };
	}
	close(): Promise<void> { this.closed++; return Promise.resolve(); }
}

function failure(request: ParadisOfficeRequest): ParadisOfficeResponse {
	return {
		version: 1, requestId: request.requestId, operation: request.operation, ok: false, outcome: 'failed',
		error: createParadisOfficeError('engine', 'engineCrashed', { severity: 'error', retryable: true, recoverable: true, userAction: 'retry' }),
	};
}

function openResponse(requestId: string): Extract<ParadisOfficeResponse, { readonly ok: true; readonly operation: 'open' }> {
	return {
		version: 1, requestId, operation: 'open', ok: true, outcome: 'complete', warnings: [], budgetUsage: {}, timings: {},
		revision: { kind: 'document', sourceRevision: 'document-revision-1' }, completeness,
		handle: documentHandle, capabilities: [],
	};
}

function compareResponse(requestId: string): Extract<ParadisOfficeResponse, { readonly ok: true; readonly operation: 'compare' }> {
	return {
		version: 1, requestId, operation: 'compare', ok: true, outcome: 'complete', warnings: [], budgetUsage: {}, timings: {},
		revision: { kind: 'comparison', originalRevision: 'original-1', modifiedRevision: 'modified-1', comparisonRevision: 'comparison-1' }, completeness,
		handle: comparisonHandle, changes: [], terminal: true,
	};
}

function fillResponseToSemanticLimit<T extends ParadisOfficeResponse>(response: T): T {
	const warnings = Array.from({ length: 132 }, (_, index) => ({ code: `wire${index}`, message: '' }));
	const result = { ...response, warnings };
	let remaining = PARADIS_OFFICE_LIMITS.maxSerializedResponseBytes - measureParadisOfficeWireBytes(result);
	for (const warning of warnings) { const count = Math.min(16 * 1024, remaining); warning.message = 'x'.repeat(count); remaining -= count; }
	assert.strictEqual(remaining, 0);
	assert.strictEqual(measureParadisOfficeWireBytes(result), PARADIS_OFFICE_LIMITS.maxSerializedResponseBytes);
	return result as T;
}

class RecordingBackend implements IParadisOfficeDocumentBackend {
	readonly calls: { readonly ownerId: string; readonly operation: string }[] = [];
	readonly disconnected: string[] = [];
	responses = new Map<ParadisOfficeRequest['operation'], (request: ParadisOfficeRequest, token: CancellationToken) => ParadisOfficeResponse | Promise<ParadisOfficeResponse>>();

	constructor() {
		for (const operation of ['inspect', 'open', 'getViewport', 'compare', 'search', 'getRenderableAsset', 'getPrintModel', 'exportPrint', 'close', 'cancel'] as const) {
			this.responses.set(operation, failure);
		}
		this.responses.set('open', request => openResponse(request.requestId));
		this.responses.set('compare', request => compareResponse(request.requestId));
	}

	private execute(ownerId: string, request: ParadisOfficeRequest, token: CancellationToken): Promise<unknown> {
		this.calls.push({ ownerId, operation: request.operation });
		return Promise.resolve(this.responses.get(request.operation)!(request, token));
	}

	inspect(ownerId: string, request: Extract<ParadisOfficeRequest, { operation: 'inspect' }>, token: CancellationToken): Promise<unknown> { return this.execute(ownerId, request, token); }
	open(ownerId: string, request: Extract<ParadisOfficeRequest, { operation: 'open' }>, token: CancellationToken): Promise<unknown> { return this.execute(ownerId, request, token); }
	getViewport(ownerId: string, request: Extract<ParadisOfficeRequest, { operation: 'getViewport' }>, token: CancellationToken): Promise<unknown> { return this.execute(ownerId, request, token); }
	compare(ownerId: string, request: Extract<ParadisOfficeRequest, { operation: 'compare' }>, token: CancellationToken): Promise<unknown> { return this.execute(ownerId, request, token); }
	search(ownerId: string, request: Extract<ParadisOfficeRequest, { operation: 'search' }>, token: CancellationToken): Promise<unknown> { return this.execute(ownerId, request, token); }
	getRenderableAsset(ownerId: string, request: Extract<ParadisOfficeRequest, { operation: 'getRenderableAsset' }>, token: CancellationToken): Promise<unknown> { return this.execute(ownerId, request, token); }
	getPrintModel(ownerId: string, request: Extract<ParadisOfficeRequest, { operation: 'getPrintModel' }>, token: CancellationToken): Promise<unknown> { return this.execute(ownerId, request, token); }
	exportPrint(ownerId: string, request: Extract<ParadisOfficeRequest, { operation: 'exportPrint' }>, token: CancellationToken): Promise<unknown> { return this.execute(ownerId, request, token); }
	close(ownerId: string, request: ParadisOfficeCloseRequest, token: CancellationToken): Promise<unknown> { return this.execute(ownerId, request, token); }
	cancel(ownerId: string, request: ParadisOfficeCancelRequest, token: CancellationToken): Promise<unknown> { return this.execute(ownerId, request, token); }

	disconnect(ownerId: string): void { this.disconnected.push(ownerId); }
}

function request(operation: ParadisOfficeRequest['operation'], requestId: string): ParadisOfficeRequest {
	switch (operation) {
		case 'inspect': return { version: 1, requestId, operation, source };
		case 'open': return { version: 1, requestId, operation, source };
		case 'getViewport': return { version: 1, requestId, operation, handle: documentHandle, locator: 'sheet:1', range: [0, 0, 1, 1] };
		case 'compare': return { version: 1, requestId, operation, original: { ...source, side: 'original' }, modified: { ...source, side: 'modified' } };
		case 'search': return { version: 1, requestId, operation, handle: documentHandle, query: 'needle' };
		case 'getRenderableAsset': return { version: 1, requestId, operation, handle: documentHandle, assetId: 'asset_safe-1', offset: 0, length: 1 };
		case 'getPrintModel': return { version: 1, requestId, operation, handle: documentHandle, options: { includePlaceholders: true } };
		case 'exportPrint': return { version: 1, requestId, operation, handle: documentHandle, format: 'pdf' };
		case 'close': return { version: 1, requestId, operation, handle: documentHandle };
		case 'cancel': return { version: 1, requestId, operation, targetRequestId: 'target-1' };
	}
}

suite('ParadisOfficeChannel', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	test('publishes the dedicated v1 name and negotiates v1 or the retained v0 channel', async () => {
		assert.strictEqual(PARADIS_OFFICE_CHANNEL, 'officeDocument/v1');
		const channel = new ParadisOfficeChannel(new RecordingBackend());
		assert.deepStrictEqual(await channel.call('window:1', 'negotiate', { versions: [0, 1] }), {
			version: 1, channel: 'officeDocument/v1', capabilities: ['inspect', 'open', 'getViewport', 'compare', 'search', 'getRenderableAsset', 'getPrintModel', 'exportPrint', 'close', 'cancel'],
		});
		assert.deepStrictEqual(await channel.call('window:1', 'negotiate', { versions: [0] }), {
			version: 0, channel: 'paradisSpreadsheet', capabilities: ['parseWorkbook'],
		});
		await assert.rejects(channel.call('window:1', 'negotiate', { versions: [1], extra: true }), ParadisOfficeChannelError);
		channel.dispose();
	});

	test('dispatches every Task 2 operation without changing the response union', async () => {
		const backend = new RecordingBackend();
		const channel = new ParadisOfficeChannel(backend);
		await channel.call('window:1', 'request', request('open', 'open-1'));
		for (const [index, operation] of ['inspect', 'getViewport', 'compare', 'search', 'getRenderableAsset', 'getPrintModel', 'exportPrint', 'close'].entries()) {
			await channel.call('window:1', 'request', request(operation as ParadisOfficeRequest['operation'], `request-${index}`));
		}
		assert.deepStrictEqual(backend.calls.map(call => call.operation), ['open', 'inspect', 'getViewport', 'compare', 'search', 'getRenderableAsset', 'getPrintModel', 'exportPrint', 'close']);
		channel.dispose();
	});

	test('rejects forged owners, duplicate active request IDs, cross-owner handles, and revision mismatches', async () => {
		const backend = new RecordingBackend();
		let release!: (response: ParadisOfficeResponse) => void;
		backend.responses.set('inspect', () => new Promise<ParadisOfficeResponse>(resolve => release = resolve));
		const channel = new ParadisOfficeChannel(backend);
		await assert.rejects(channel.call('../window', 'request', request('inspect', 'owner-1')), ParadisOfficeChannelError);
		const pending = channel.call('window:1', 'request', request('inspect', 'same-id'));
		await assert.rejects(channel.call('window:1', 'request', request('inspect', 'same-id')), ParadisOfficeChannelError);
		release(failure(request('inspect', 'same-id')));
		await pending;
		await channel.call('window:1', 'request', request('open', 'open-1'));
		await assert.rejects(channel.call('window:2', 'request', request('getViewport', 'foreign-1')), ParadisOfficeChannelError);
		backend.responses.set('getViewport', request => ({ ...failure(request), revision: { kind: 'document', sourceRevision: 'wrong-revision' } } as ParadisOfficeResponse));
		const mismatch = await channel.call<ParadisOfficeResponse>('window:1', 'request', request('getViewport', 'revision-1'));
		assert.strictEqual(mismatch.ok, false);
		if (mismatch.ok) { throw new Error('Expected safe revision failure'); }
		assert.strictEqual(mismatch.error.code, 'engineCrashed');
		channel.dispose();
	});

	test('allows exactly 2MiB asset ranges and rejects path-like assets and the plus-one range', () => {
		const exactRequest = snapshotParadisOfficeRequest({ ...request('getRenderableAsset', 'asset-1'), length: PARADIS_OFFICE_LIMITS.maxAssetRequestBytes });
		assert.strictEqual(exactRequest.operation === 'getRenderableAsset' && exactRequest.length, PARADIS_OFFICE_LIMITS.maxAssetRequestBytes);
		assert.throws(() => snapshotParadisOfficeRequest({ ...request('getRenderableAsset', 'asset-2'), length: PARADIS_OFFICE_LIMITS.maxAssetRequestBytes + 1 }), ParadisOfficeWireError);
		for (const assetId of ['../secret', '/absolute', 'C:\\secret', 'file:///secret', '%2fsecret', 'asset.safe']) {
			assert.throws(() => snapshotParadisOfficeRequest({ ...request('getRenderableAsset', 'asset-3'), assetId }), ParadisOfficeWireError);
		}
	});

	test('binds positive asset ranges and responses and rejects path-like render asset IDs', async () => {
		assert.deepStrictEqual(validateParadisOfficeAssetRange(5, 7), { offset: 5, length: 7, end: 12 });
		assert.throws(() => validateParadisOfficeAssetRange(0, 0), ParadisOfficeWireError);
		assert.throws(() => snapshotParadisOfficeResponse({
			version: 1, requestId: 'tile-path-1', operation: 'getViewport', ok: true, outcome: 'complete', warnings: [], budgetUsage: {}, timings: {},
			revision: { kind: 'document', sourceRevision: 'document-revision-1' }, completeness,
			tile: { locator: 'sheet:1', range: [0, 0, 1, 1], cells: [], blocks: [], objects: [{ nodeId: 'o1', coverage: 'rendered', kind: 'rasterImage', assetId: '../private' }], placeholders: [] },
		}), ParadisOfficeWireError);
		const backend = new RecordingBackend();
		const channel = new ParadisOfficeChannel(backend);
		await channel.call('window:asset-bind', 'request', request('open', 'asset-bind-open'));
		const assetRequest = { ...request('getRenderableAsset', 'asset-bind-1'), length: 4 } as Extract<ParadisOfficeRequest, { readonly operation: 'getRenderableAsset' }>;
		const assetResponse = (requestId: string, assetId = 'asset_safe-1', offset = 0, length = 4): ParadisOfficeResponse => ({ version: 1, requestId, operation: 'getRenderableAsset', ok: true, outcome: 'complete', warnings: [], budgetUsage: {}, timings: {}, revision: { kind: 'document', sourceRevision: 'document-revision-1' }, completeness, assetId, offset, totalLength: 10, bytes: VSBuffer.alloc(length) });
		backend.responses.set('getRenderableAsset', request => assetResponse(request.requestId, 'other_asset'));
		assert.strictEqual((await channel.call<ParadisOfficeResponse>('window:asset-bind', 'request', assetRequest)).ok, false);
		backend.responses.set('getRenderableAsset', request => assetResponse(request.requestId, 'asset_safe-1', 1));
		assert.strictEqual((await channel.call<ParadisOfficeResponse>('window:asset-bind', 'request', { ...assetRequest, requestId: 'asset-bind-2' })).ok, false);
		backend.responses.set('getRenderableAsset', request => assetResponse(request.requestId, 'asset_safe-1', 0, 3));
		assert.strictEqual((await channel.call<ParadisOfficeResponse>('window:asset-bind', 'request', { ...assetRequest, requestId: 'asset-bind-3' })).ok, true);
		backend.responses.set('getRenderableAsset', request => assetResponse(request.requestId, 'asset_safe-1', 0, 0));
		assert.strictEqual((await channel.call<ParadisOfficeResponse>('window:asset-bind', 'request', { ...assetRequest, requestId: 'asset-bind-4' })).ok, false);
		backend.responses.set('getRenderableAsset', request => assetResponse(request.requestId, 'asset_safe-1', 10, 0));
		assert.strictEqual((await channel.call<ParadisOfficeResponse>('window:asset-bind', 'request', { ...assetRequest, requestId: 'asset-bind-5', offset: 10 })).ok, true);
		channel.dispose();
	});

	test('enforces the exact 2MiB response boundary and maps an oversized backend result safely', async () => {
		const base: ParadisOfficeResponse = {
			version: 1, requestId: 'asset-response', operation: 'getRenderableAsset', ok: true, outcome: 'complete', warnings: [], budgetUsage: {}, timings: {},
			revision: { kind: 'document', sourceRevision: 'document-revision-1' }, completeness,
			assetId: 'asset_safe-1', offset: 0, totalLength: PARADIS_OFFICE_LIMITS.maxSerializedResponseBytes, bytes: VSBuffer.alloc(0),
		};
		const overhead = VSBuffer.fromString(JSON.stringify({ ...base, bytes: '' })).byteLength - 2;
		assert.strictEqual(overhead, 471);
		assert.strictEqual(measureParadisOfficeWireBytes(base), overhead);
		const exact = { ...base, bytes: VSBuffer.alloc(PARADIS_OFFICE_LIMITS.maxSerializedResponseBytes - overhead) };
		assert.strictEqual(measureParadisOfficeWireBytes(exact), PARADIS_OFFICE_LIMITS.maxSerializedResponseBytes);
		assert.strictEqual(snapshotParadisOfficeResponse(exact).ok, true);
		assert.throws(() => snapshotParadisOfficeResponse({ ...exact, bytes: VSBuffer.alloc(exact.bytes.byteLength + 1) }), (error: unknown) => error instanceof ParadisOfficeWireError && error.code === 'payloadTooLarge');
		const backend = new RecordingBackend();
		const channel = new ParadisOfficeChannel(backend);
		await channel.call('window:1', 'request', request('open', 'open-size-1'));
		backend.responses.set('getRenderableAsset', request => ({ ...base, requestId: request.requestId, bytes: VSBuffer.alloc(PARADIS_OFFICE_LIMITS.maxSerializedResponseBytes) }));
		const oversized = await channel.call<ParadisOfficeResponse>('window:1', 'request', request('getRenderableAsset', 'asset-size-1'));
		assert.strictEqual(oversized.ok, false);
		if (oversized.ok) { throw new Error('Expected an oversized Office response failure'); }
		assert.strictEqual(oversized.error.code, 'payloadTooLarge');
		channel.dispose();
	});

	test('round-trips nested buffers through real ChannelClient and ChannelServer framing', async () => {
		const disposables = new DisposableStore();
		const [clientProtocol, serverProtocol] = createProtocolPair();
		disposables.add(clientProtocol);
		disposables.add(serverProtocol);
		const client = disposables.add(new ChannelClient(clientProtocol));
		const server = disposables.add(new ChannelServer(serverProtocol, 'window:ipc'));
		const backend = new RecordingBackend();
		const store = new OfficeSpoolStore({ platform: 'desktopLocal' });
		const resolver = new SpoolAwareParadisOfficeSourceResolver(store);
		const officeChannel = disposables.add(new ParadisOfficeChannel(backend, Event.None, new ParadisOfficeSpoolTransport(store, resolver)));
		server.registerChannel(PARADIS_OFFICE_CHANNEL, officeChannel);
		const wire = client.getChannel(PARADIS_OFFICE_CHANNEL);
		const attemptId = '123e4567-e89b-42d3-a456-426614174000';
		const reference = await wire.call<{ readonly id: string; readonly ownerId: string; readonly nonce: string; readonly attemptId: string }>('spool/begin', { attemptId });
		await wire.call('spool/claim', { reference, attemptId });
		const spoolBytes = VSBuffer.fromByteArray([0, 1, 2, 255]);
		await wire.call('spool/append', marshalParadisOfficeSpoolAppend({ reference, bytes: spoolBytes }));
		assert.strictEqual(store.byteLength, 4);
		const exactRawChunk = VSBuffer.alloc(PARADIS_OFFICE_LIMITS.maxAssetRequestBytes);
		await wire.call('spool/append', marshalParadisOfficeSpoolAppend({ reference, bytes: exactRawChunk }));
		assert.strictEqual(store.byteLength, PARADIS_OFFICE_LIMITS.maxAssetRequestBytes + 4);
		assert.throws(() => marshalParadisOfficeSpoolAppend({ reference, bytes: VSBuffer.alloc(PARADIS_OFFICE_LIMITS.maxAssetRequestBytes + 1) }), (error: unknown) => error instanceof ParadisOfficeWireError && error.code === 'payloadTooLarge');
		const exactAppendEnvelope = marshalParadisOfficeSpoolAppend({ reference, bytes: exactRawChunk });
		assert.ok(independentlySerializedIpcBytes(exactAppendEnvelope) - exactRawChunk.byteLength <= PARADIS_OFFICE_MAX_SPOOL_APPEND_METADATA_BYTES);

		await unmarshalParadisOfficeResponse(await wire.call('request', marshalParadisOfficeRequest(request('open', 'ipc-open-1'))));
		const responseBase: ParadisOfficeResponse = {
			version: 1, requestId: 'ipc-asset-1', operation: 'getRenderableAsset', ok: true, outcome: 'complete', warnings: [], budgetUsage: {}, timings: {},
			revision: { kind: 'document', sourceRevision: 'document-revision-1' }, completeness,
			assetId: 'asset_safe-1', offset: 0, totalLength: 4, bytes: VSBuffer.fromByteArray([9, 8, 7, 6]),
		};
		backend.responses.set('getRenderableAsset', request => ({ ...responseBase, requestId: request.requestId }));
		const asset = await unmarshalParadisOfficeResponse(await wire.call('request', marshalParadisOfficeRequest({ ...request('getRenderableAsset', 'ipc-asset-1'), length: 4 })));
		assert.strictEqual(asset.ok, true);
		if (!asset.ok || asset.operation !== 'getRenderableAsset') { throw new Error('Expected an asset response'); }
		assert.deepStrictEqual([...asset.bytes.buffer], [9, 8, 7, 6]);

		const semanticOverhead = measureParadisOfficeWireBytes({ ...responseBase, bytes: VSBuffer.alloc(0), totalLength: PARADIS_OFFICE_LIMITS.maxSerializedResponseBytes });
		const semanticExact = { ...responseBase, totalLength: PARADIS_OFFICE_LIMITS.maxSerializedResponseBytes, bytes: VSBuffer.alloc(PARADIS_OFFICE_LIMITS.maxSerializedResponseBytes - semanticOverhead) };
		assert.strictEqual(measureParadisOfficeWireBytes(semanticExact), PARADIS_OFFICE_LIMITS.maxSerializedResponseBytes);
		assert.throws(() => marshalParadisOfficeWireValue(semanticExact), (error: unknown) => error instanceof ParadisOfficeWireError && error.code === 'payloadTooLarge');
		let low = 0;
		let high = PARADIS_OFFICE_LIMITS.maxSerializedResponseBytes - semanticOverhead;
		while (low < high) {
			const candidate = Math.ceil((low + high) / 2);
			try {
				const envelope = marshalParadisOfficeWireValue({ ...responseBase, totalLength: PARADIS_OFFICE_LIMITS.maxSerializedResponseBytes, bytes: VSBuffer.alloc(candidate) });
				if (independentlySerializedIpcBytes(envelope) <= PARADIS_OFFICE_MAX_IPC_BYTES) { low = candidate; } else { high = candidate - 1; }
			} catch { high = candidate - 1; }
		}
		const exactEnvelope = marshalParadisOfficeWireValue({ ...responseBase, totalLength: PARADIS_OFFICE_LIMITS.maxSerializedResponseBytes, bytes: VSBuffer.alloc(low) });
		assert.strictEqual(independentlySerializedIpcBytes(exactEnvelope), PARADIS_OFFICE_MAX_IPC_BYTES);
		assert.strictEqual(measureParadisOfficeIpcWireBytes(exactEnvelope), PARADIS_OFFICE_MAX_IPC_BYTES);
		assert.throws(() => marshalParadisOfficeWireValue({ ...responseBase, totalLength: PARADIS_OFFICE_LIMITS.maxSerializedResponseBytes, bytes: VSBuffer.alloc(low + 1) }), (error: unknown) => error instanceof ParadisOfficeWireError && error.code === 'payloadTooLarge');
		backend.responses.set('getRenderableAsset', request => ({ ...responseBase, requestId: request.requestId, totalLength: PARADIS_OFFICE_LIMITS.maxSerializedResponseBytes, bytes: VSBuffer.alloc(low) }));
		const exact = await unmarshalParadisOfficeResponse(await wire.call('request', marshalParadisOfficeRequest({ ...request('getRenderableAsset', 'ipc-exact-1'), length: PARADIS_OFFICE_LIMITS.maxAssetRequestBytes })));
		assert.strictEqual(exact.ok, true);
		backend.responses.set('getRenderableAsset', request => ({ ...responseBase, requestId: request.requestId, totalLength: PARADIS_OFFICE_LIMITS.maxSerializedResponseBytes, bytes: VSBuffer.alloc(low + 1) }));
		const plusOne = await unmarshalParadisOfficeResponse(await wire.call('request', marshalParadisOfficeRequest({ ...request('getRenderableAsset', 'ipc-plus-one-1'), length: PARADIS_OFFICE_LIMITS.maxAssetRequestBytes })));
		assert.strictEqual(plusOne.ok, false);
		if (plusOne.ok) { throw new Error('Expected payloadTooLarge'); }
		assert.strictEqual(plusOne.error.code, 'payloadTooLarge');
		disposables.dispose();
		store.disposeAll();
	});

	test('owns binary bytes across marshal source and received-envelope mutations', () => {
		const sourceBytes = VSBuffer.wrap(Buffer.from([1, 2, 3]));
		const envelope = marshalParadisOfficeWireValue({ bytes: sourceBytes });
		sourceBytes.buffer[0] = 9;
		const received = unmarshalParadisOfficeWireValue(envelope) as { readonly bytes: VSBuffer };
		assert.deepStrictEqual([...received.bytes.buffer], [1, 2, 3]);
		const envelopeBuffer = envelope.find(value => value instanceof VSBuffer);
		if (!(envelopeBuffer instanceof VSBuffer)) { throw new Error('Expected envelope buffer'); }
		envelopeBuffer.buffer[1] = 8;
		assert.deepStrictEqual([...received.bytes.buffer], [1, 2, 3]);
	});

	test('rejects obvious wire excess before BufferWriter measurement or binary copying', () => {
		let exactMeasurements = 0;
		let bufferCopies = 0;
		const observer: ParadisOfficeWireDecodeObserver = { onBeforeExactMeasure: () => exactMeasurements++, onBeforeBufferCopy: () => bufferCopies++ };
		const oversizedHeader = [PARADIS_OFFICE_WIRE_ENVELOPE, 'x'.repeat(PARADIS_OFFICE_MAX_IPC_BYTES + 1)] as const;
		assert.throws(() => decodeParadisOfficeWireValue(oversizedHeader, observer), (error: unknown) => error instanceof ParadisOfficeWireError && error.code === 'payloadTooLarge');
		const rawLength = PARADIS_OFFICE_LIMITS.maxAssetRequestBytes + 1;
		const header = JSON.stringify({ version: 1, transfer: 'spoolAppend', bufferLengths: [rawLength], payload: { reference: { id: 'a'.repeat(48), ownerId: 'owner', nonce: 'b'.repeat(64), attemptId: '123e4567-e89b-42d3-a456-426614174000' }, bytes: { $paradisOfficeBuffer: 0 } } });
		assert.throws(() => decodeParadisOfficeWireValue([PARADIS_OFFICE_WIRE_ENVELOPE, header, VSBuffer.alloc(rawLength)], observer), (error: unknown) => error instanceof ParadisOfficeWireError && error.code === 'payloadTooLarge');
		assert.strictEqual(exactMeasurements, 0);
		assert.strictEqual(bufferCopies, 0);
		const valid = marshalParadisOfficeWireValue({ bytes: VSBuffer.fromByteArray([1]) });
		decodeParadisOfficeWireValue(valid, observer);
		assert.strictEqual(exactMeasurements, 1);
		assert.strictEqual(bufferCopies, 1);
	});

	test('fences connection epochs, owner capabilities, and active-entry identity across reconnect ABA', async () => {
		const disconnects = new Emitter<{ readonly ownerId: string; readonly epoch: number }>();
		let epoch = 1;
		let capabilityIndex = 0;
		const authority = {
			currentEpoch: (_ownerId: string) => epoch,
			onDidDisconnect: disconnects.event,
			createCapability: () => (++capabilityIndex).toString(16).padStart(64, '0'),
		};
		const backend = new RecordingBackend();
		const releases: ((response: ParadisOfficeResponse) => void)[] = [];
		backend.responses.set('open', () => new Promise<ParadisOfficeResponse>(resolve => releases.push(resolve)));
		const channel = new ParadisOfficeChannel(backend, Event.None, undefined, authority);
		const ownerId = 'window:epoch';
		const firstNegotiation = await channel.call<{ readonly ownerCapability: string; readonly connectionEpoch: number }>(ownerId, 'negotiate', { versions: [1] });
		const firstAuthority: ParadisOfficeWireAuthority = { ownerCapability: firstNegotiation.ownerCapability, connectionEpoch: firstNegotiation.connectionEpoch };
		const oldRequest = channel.call(ownerId, 'request', marshalParadisOfficeRequest(request('open', 'epoch-open-1'), firstAuthority));
		assert.strictEqual(releases.length, 1);

		epoch = 2;
		disconnects.fire({ ownerId, epoch: 1 });
		const secondNegotiation = await channel.call<{ readonly ownerCapability: string; readonly connectionEpoch: number }>(ownerId, 'negotiate', { versions: [1] });
		const secondAuthority: ParadisOfficeWireAuthority = { ownerCapability: secondNegotiation.ownerCapability, connectionEpoch: secondNegotiation.connectionEpoch };
		disconnects.fire({ ownerId, epoch: 1 });
		const newRequest = channel.call(ownerId, 'request', marshalParadisOfficeRequest(request('open', 'epoch-open-1'), secondAuthority));
		assert.strictEqual(releases.length, 2);
		releases[0](openResponse('epoch-open-1'));
		const stale = await unmarshalParadisOfficeResponse(await oldRequest);
		assert.strictEqual(stale.ok, false);
		await assert.rejects(channel.call(ownerId, 'request', marshalParadisOfficeRequest(request('open', 'epoch-open-1'), secondAuthority)), ParadisOfficeChannelError);
		releases[1](openResponse('epoch-open-1'));
		const fresh = await unmarshalParadisOfficeResponse(await newRequest);
		assert.strictEqual(fresh.ok, true);
		assert.strictEqual(backend.calls.filter(call => call.operation === 'close').length, 1);
		channel.dispose();
		disconnects.dispose();
	});

	test('binds shared-process channels to concrete connections when the same ctx overlaps', async () => {
		const disposables = new DisposableStore();
		const connections = disposables.add(new Emitter<{ readonly protocol: IMessagePassingProtocol; readonly onDidClientDisconnect: Event<void> }>());
		const server = disposables.add(new IPCServer<string>(connections.event));
		const backend = new RecordingBackend();
		disposables.add(registerParadisOffice(server, backend));
		const createConnection = () => {
			const [clientProtocol, serverProtocol] = createProtocolPair();
			disposables.add(clientProtocol); disposables.add(serverProtocol);
			const disconnect = disposables.add(new Emitter<void>());
			connections.fire({ protocol: serverProtocol, onDidClientDisconnect: disconnect.event });
			const client = disposables.add(new IPCClient(clientProtocol, 'window:overlap'));
			return { client, disconnect };
		};
		const oldConnection = createConnection();
		const oldWire = oldConnection.client.getChannel(PARADIS_OFFICE_CHANNEL);
		const oldNegotiation = await oldWire.call<{ readonly ownerCapability: string; readonly connectionEpoch: number }>('negotiate', { versions: [1] });
		const newConnection = createConnection();
		const newWire = newConnection.client.getChannel(PARADIS_OFFICE_CHANNEL);
		const newNegotiation = await newWire.call<{ readonly ownerCapability: string; readonly connectionEpoch: number }>('negotiate', { versions: [1] });
		assert.notStrictEqual(oldNegotiation.ownerCapability, newNegotiation.ownerCapability);
		const newAuthority = { ownerCapability: newNegotiation.ownerCapability, connectionEpoch: newNegotiation.connectionEpoch };
		await assert.rejects(oldWire.call('request', marshalParadisOfficeRequest(request('open', 'overlap-forged-1'), newAuthority)));
		oldConnection.disconnect.fire();
		const opened = await unmarshalParadisOfficeResponse(await newWire.call('request', marshalParadisOfficeRequest(request('open', 'overlap-open-1'), newAuthority)));
		assert.strictEqual(opened.ok, true);
		disposables.dispose();
	});

	test('disconnects the old resource owner when late handle validation or close cleanup fails', async () => {
		const disconnects = new Emitter<{ readonly ownerId: string; readonly epoch: number }>();
		let epoch = 1;
		const authority = { currentEpoch: (_ownerId: string) => epoch, onDidDisconnect: disconnects.event, createCapability: () => 'd'.repeat(64) };
		const backend = new RecordingBackend();
		const releases: ((response: ParadisOfficeResponse) => void)[] = [];
		backend.responses.set('open', () => new Promise<ParadisOfficeResponse>(resolve => releases.push(resolve)));
		backend.responses.set('close', () => Promise.reject(new Error('/private/close failure')));
		const channel = new ParadisOfficeChannel(backend, Event.None, undefined, authority);
		const negotiation = await channel.call<{ readonly ownerCapability: string; readonly connectionEpoch: number }>('window:late-cleanup', 'negotiate', { versions: [1] });
		const wireAuthority = { ownerCapability: negotiation.ownerCapability, connectionEpoch: negotiation.connectionEpoch };
		const invalidPending = channel.call('window:late-cleanup', 'request', marshalParadisOfficeRequest(request('open', 'late-invalid-1'), wireAuthority));
		const closePending = channel.call('window:late-cleanup', 'request', marshalParadisOfficeRequest(request('open', 'late-close-1'), wireAuthority));
		epoch = 2;
		disconnects.fire({ ownerId: 'window:late-cleanup', epoch: 1 });
		releases[0]({ ...openResponse('late-invalid-1'), privatePath: '/private/late.docx' } as ParadisOfficeResponse);
		releases[1](openResponse('late-close-1'));
		await unmarshalParadisOfficeResponse(await invalidPending);
		await unmarshalParadisOfficeResponse(await closePending);
		assert.strictEqual(backend.disconnected.filter(ownerId => ownerId === 'd'.repeat(64)).length, 3);
		channel.dispose();
		disconnects.dispose();
	});

	test('requires late close acknowledgements to match the original request ID', async () => {
		const disconnects = new Emitter<{ readonly ownerId: string; readonly epoch: number }>();
		let epoch = 1;
		const authority = { currentEpoch: (_ownerId: string) => epoch, onDidDisconnect: disconnects.event, createCapability: () => 'e'.repeat(64) };
		const backend = new RecordingBackend();
		let release!: (response: ParadisOfficeResponse) => void;
		backend.responses.set('open', () => new Promise<ParadisOfficeResponse>(resolve => release = resolve));
		backend.responses.set('close', () => Promise.resolve({ version: 1, requestId: 'wrong-close-id', operation: 'close', ok: true, outcome: 'complete', warnings: [], budgetUsage: {}, timings: {}, acknowledged: true }));
		const channel = new ParadisOfficeChannel(backend, Event.None, undefined, authority);
		const negotiation = await channel.call<{ readonly ownerCapability: string; readonly connectionEpoch: number }>('window:late-wrong-id', 'negotiate', { versions: [1] });
		const pending = channel.call('window:late-wrong-id', 'request', marshalParadisOfficeRequest(request('open', 'late-wrong-id-1'), { ownerCapability: negotiation.ownerCapability, connectionEpoch: negotiation.connectionEpoch }));
		epoch = 2;
		disconnects.fire({ ownerId: 'window:late-wrong-id', epoch: 1 });
		release(openResponse('late-wrong-id-1'));
		await unmarshalParadisOfficeResponse(await pending);
		assert.strictEqual(backend.disconnected.filter(ownerId => ownerId === 'e'.repeat(64)).length, 2);
		channel.dispose();
		disconnects.dispose();
	});

	test('accepts every exact success variant and rejects missing or nested extra fields', () => {
		const meta = { version: 1 as const, requestId: 'variant-1', ok: true as const, outcome: 'complete' as const, warnings: [], budgetUsage: {}, timings: {}, revision: { kind: 'document' as const, sourceRevision: 'document-revision-1' }, completeness };
		const inventory = { format: 'docx' as const, container: 'opc' as const, parts: [], relationships: [], features: [], security: { encrypted: false, hasMacros: false, hasExternalRelationships: false, hasEmbeddedObjects: false, hasProtection: false, hasSignatures: false }, budgetProfile: 'desktopLocal' as const, budgetUsage: { compressedInputBytes: 0, expandedBytes: 0, entryCount: 0, largestPartBytes: 0, totalMediaBytes: 0, elapsedMilliseconds: 0 } };
		const variants: ParadisOfficeResponse[] = [
			{ ...meta, operation: 'inspect', inventory },
			openResponse('variant-open'),
			{ ...meta, operation: 'getViewport', tile: { locator: 'sheet:1', range: [0, 0, 1, 1], cells: [], blocks: [], objects: [], placeholders: [] } },
			compareResponse('variant-compare'),
			{ ...meta, operation: 'search', results: [] },
			{ ...meta, operation: 'getRenderableAsset', assetId: 'asset_safe-1', offset: 0, totalLength: 1, bytes: VSBuffer.fromByteArray([1]) },
			{ ...meta, operation: 'getPrintModel', printModel: { title: 'Safe', pages: [], approximationWarnings: [] } },
			{ ...meta, operation: 'exportPrint', assetId: 'print_pdf', mime: 'application/pdf', byteLength: 0 },
			{ version: 1, requestId: 'variant-close', operation: 'close', ok: true, outcome: 'complete', warnings: [], budgetUsage: {}, timings: {}, acknowledged: true },
			{ version: 1, requestId: 'variant-cancel', operation: 'cancel', ok: true, outcome: 'complete', warnings: [], budgetUsage: {}, timings: {}, acknowledged: true },
		];
		assert.deepStrictEqual(variants.map(variant => snapshotParadisOfficeResponse(variant).operation), ['inspect', 'open', 'getViewport', 'compare', 'search', 'getRenderableAsset', 'getPrintModel', 'exportPrint', 'close', 'cancel']);
		assert.throws(() => snapshotParadisOfficeResponse({ ...meta, operation: 'search', results: [{ id: 'r', locator: 'l', preview: { before: '', match: '', after: '', path: '/secret' }, locationBadge: { kind: 'sheet', label: 'Sheet' } }] }), ParadisOfficeWireError);
		const missingWarnings = { ...openResponse('missing-warnings') } as Record<string, unknown>;
		delete missingWarnings.warnings;
		assert.throws(() => snapshotParadisOfficeResponse(missingWarnings), ParadisOfficeWireError);
	});

	test('commits handles and cursors only after response marshal succeeds', async () => {
		const backend = new RecordingBackend();
		backend.responses.set('close', request => Promise.resolve({ version: 1, requestId: request.requestId, operation: 'close', ok: true, outcome: 'complete', warnings: [], budgetUsage: {}, timings: {}, acknowledged: true }));
		const channel = new ParadisOfficeChannel(backend);
		const compareRequest = request('compare', 'wire-compare-1');
		for (let index = 0; index < 4; index++) {
			if (index < 2) { backend.responses.set('open', request => fillResponseToSemanticLimit({ ...openResponse(request.requestId), handle: { kind: 'document', id: (index + 1).toString(16).repeat(48) } })); }
			else { backend.responses.set('compare', request => fillResponseToSemanticLimit({ ...compareResponse(request.requestId), handle: { kind: 'comparison', id: (index + 1).toString(16).repeat(48) }, nextCursor: `overflow-cursor-${index}` })); }
			const operationRequest = index < 2 ? request('open', `wire-open-${index}`) : { ...compareRequest, requestId: `wire-compare-${index}` };
			const result = await unmarshalParadisOfficeResponse(await channel.call('window:wire-commit', 'request', marshalParadisOfficeRequest(operationRequest)));
			assert.strictEqual(result.ok, false);
			if (result.ok) { throw new Error('Expected wire overflow'); }
			assert.strictEqual(result.error.code, 'payloadTooLarge');
		}
		assert.strictEqual(backend.calls.filter(call => call.operation === 'close').length, 4);
		await assert.rejects(channel.call('window:wire-commit', 'request', marshalParadisOfficeRequest({ ...compareRequest, requestId: 'wire-cursor-replay', cursor: 'overflow-cursor-3' })), ParadisOfficeChannelError);
		backend.responses.set('open', request => ({ ...openResponse(request.requestId), handle: { kind: 'document', id: 'f'.repeat(48) } }));
		const valid = await unmarshalParadisOfficeResponse(await channel.call('window:wire-commit', 'request', marshalParadisOfficeRequest(request('open', 'wire-valid-open'))));
		assert.strictEqual(valid.ok, true);
		channel.dispose();
	});

	test('rejects oversized, sparse, shared, symbol, accessor, and unstable request data before dispatch', async () => {
		const backend = new RecordingBackend();
		const channel = new ParadisOfficeChannel(backend);
		const sparse: ParadisOfficeChangeCategory[] = [];
		sparse.length = 1;
		const shared = { ...source };
		const symbolRequest = { ...request('inspect', 'symbol-1'), [Symbol('private')]: true };
		for (const value of [
			{ ...request('inspect', 'extra-1'), extra: true },
			{ ...request('search', 'large-1'), query: 'x'.repeat(PARADIS_OFFICE_LIMITS.maxSerializedResponseBytes) },
			{ ...request('compare', 'sparse-1'), categories: sparse },
			{ version: 1, requestId: 'shared-1', operation: 'compare', original: shared, modified: shared },
			symbolRequest,
			Object.defineProperty({ version: 1, requestId: 'getter-1', operation: 'inspect' }, 'source', { enumerable: true, get: () => source }),
		]) {
			await assert.rejects(channel.call('window:1', 'request', value), ParadisOfficeChannelError);
		}
		assert.deepStrictEqual(backend.calls, []);
		channel.dispose();
	});

	test('binds compare cursors to the owner and exact source descriptors', async () => {
		const backend = new RecordingBackend();
		backend.responses.set('compare', request => ({ ...compareResponse(request.requestId), nextCursor: 'cursor-safe-1' }));
		const channel = new ParadisOfficeChannel(backend);
		const first = request('compare', 'compare-1');
		await channel.call('window:1', 'request', first);
		await channel.call('window:1', 'request', { ...first, requestId: 'compare-2', cursor: 'cursor-safe-1' });
		await assert.rejects(channel.call('window:2', 'request', { ...first, requestId: 'compare-3', cursor: 'cursor-safe-1' }), ParadisOfficeChannelError);
		await assert.rejects(channel.call('window:1', 'request', { ...first, requestId: 'compare-4', modified: { ...source, revisionHint: 'changed' }, cursor: 'cursor-safe-1' }), ParadisOfficeChannelError);
		backend.responses.set('compare', request => ({ ...compareResponse(request.requestId), revision: { kind: 'comparison', originalRevision: 'original-1', modifiedRevision: 'modified-2', comparisonRevision: 'comparison-2' } }));
		const staleCursor = await channel.call<ParadisOfficeResponse>('window:1', 'request', { ...first, requestId: 'compare-5', cursor: 'cursor-safe-1' });
		assert.strictEqual(staleCursor.ok, false);
		channel.dispose();
	});

	test('binds operation handle kinds and cursors to one comparison handle with atomic close cleanup', async () => {
		assert.throws(() => snapshotParadisOfficeResponse({ ...openResponse('wrong-open-kind'), handle: comparisonHandle }), ParadisOfficeWireError);
		assert.throws(() => snapshotParadisOfficeResponse({ ...compareResponse('wrong-compare-kind'), handle: documentHandle }), ParadisOfficeWireError);
		const backend = new RecordingBackend();
		backend.responses.set('compare', request => ({ ...compareResponse(request.requestId), nextCursor: 'comparison-cursor-1' }));
		const channel = new ParadisOfficeChannel(backend);
		const initial = request('compare', 'cursor-handle-1');
		const opened = await channel.call<ParadisOfficeResponse>('window:cursor-handle', 'request', initial);
		assert.strictEqual(opened.ok, true);
		backend.responses.set('compare', request => ({ ...compareResponse(request.requestId), handle: { kind: 'comparison', id: 'c'.repeat(48) } }));
		const switched = await channel.call<ParadisOfficeResponse>('window:cursor-handle', 'request', { ...initial, requestId: 'cursor-handle-2', cursor: 'comparison-cursor-1' });
		assert.strictEqual(switched.ok, false);
		backend.responses.set('close', request => ({ version: 1, requestId: request.requestId, operation: 'close', ok: true, outcome: 'complete', warnings: [], budgetUsage: {}, timings: {}, acknowledged: true }));
		await channel.call('window:cursor-handle', 'request', { version: 1, requestId: 'cursor-close-1', operation: 'close', handle: comparisonHandle });
		await assert.rejects(channel.call('window:cursor-handle', 'request', { ...initial, requestId: 'cursor-handle-3', cursor: 'comparison-cursor-1' }), ParadisOfficeChannelError);
		channel.dispose();

		const quotaBackend = new RecordingBackend();
		const quotaReleases: { readonly requestId: string; readonly resolve: (response: ParadisOfficeResponse) => void }[] = [];
		quotaBackend.responses.set('open', request => new Promise<ParadisOfficeResponse>(resolve => quotaReleases.push({ requestId: request.requestId, resolve })));
		const quotaChannel = new ParadisOfficeChannel(quotaBackend);
		const admitted = Array.from({ length: 4 }, (_, index) => quotaChannel.call('window:handle-quota', 'request', request('open', `quota-open-${index}`)));
		const overflow = quotaChannel.call('window:handle-quota', 'request', request('open', 'quota-open-overflow'));
		for (let index = 0; index < quotaReleases.length; index++) { quotaReleases[index].resolve({ ...openResponse(quotaReleases[index].requestId), handle: { kind: 'document', id: (index + 1).toString(16).repeat(48) } }); }
		const results = await Promise.allSettled([...admitted, overflow]);
		assert.strictEqual(quotaReleases.length, 4);
		assert.strictEqual(results.at(-1)?.status, 'rejected');
		quotaChannel.dispose();
	});

	test('restores only descriptor state and rejects handles, streams, accessors, extras, and unstable proxies', () => {
		assert.deepStrictEqual(snapshotParadisOfficeRestoreState({ version: 1, mode: 'document', source }), { version: 1, mode: 'document', source });
		for (const value of [
			{ version: 1, mode: 'document', source, handle: documentHandle },
			{ version: 1, mode: 'document', source: { ...source, stream: {} } },
			Object.defineProperty({ version: 1, mode: 'document' }, 'source', { enumerable: true, get: () => source }),
		]) {
			assert.throws(() => snapshotParadisOfficeRestoreState(value), ParadisOfficeWireError);
		}
		let reads = 0;
		const unstable = new Proxy({ version: 1, mode: 'document', source }, {
			getOwnPropertyDescriptor(target, property) {
				if (property === 'mode') { return { configurable: true, enumerable: true, writable: true, value: ++reads % 2 ? 'document' : 'comparison' }; }
				return Object.getOwnPropertyDescriptor(target, property);
			},
		});
		assert.throws(() => snapshotParadisOfficeRestoreState(unstable), ParadisOfficeWireError);
	});

	test('rejects extra or private response fields without retaining path or stack', () => {
		const response = openResponse('open-private') as ParadisOfficeResponse & { path?: string; stack?: string };
		response.path = '/secret/document.docx';
		response.stack = 'private stack';
		assert.throws(() => snapshotParadisOfficeResponse(response), (error: unknown) => {
			assert.ok(error instanceof ParadisOfficeWireError);
			assert.strictEqual(error.message.includes('/secret'), false);
			assert.strictEqual(error.stack, '');
			return true;
		});
		const malicious = failure(request('inspect', 'safe-error-1'));
		if (malicious.ok) { throw new Error('Expected failure fixture'); }
		const projected = snapshotParadisOfficeResponse({ ...malicious, error: { ...malicious.error, safeMessage: '/secret/document.docx private stack' } });
		assert.strictEqual(projected.ok, false);
		if (projected.ok) { throw new Error('Expected projected failure'); }
		assert.strictEqual(projected.error.safeMessage, 'The Office processing engine stopped unexpectedly.');
	});

	test('cancels only the owner request and cleans handles and work on disconnect', async () => {
		const backend = new RecordingBackend();
		const disconnect = new Emitter<string>();
		const channel = new ParadisOfficeChannel(backend, disconnect.event);
		await channel.call('window:1', 'request', request('open', 'open-1'));
		let cancelled = false;
		backend.responses.set('inspect', (request, token) => new Promise<ParadisOfficeResponse>(resolve => {
			const listener = token.onCancellationRequested(() => { cancelled = true; listener.dispose(); resolve(failure(request)); });
		}));
		const pending = channel.call('window:1', 'request', request('inspect', 'target-1'));
		await channel.call('window:1', 'request', request('cancel', 'cancel-1'));
		await pending;
		let handleCancelled = false;
		backend.responses.set('getViewport', (request, token) => new Promise<ParadisOfficeResponse>(resolve => {
			const listener = token.onCancellationRequested(() => { handleCancelled = true; listener.dispose(); resolve(failure(request)); });
		}));
		const viewport = channel.call('window:1', 'request', request('getViewport', 'viewport-1'));
		await channel.call('window:1', 'request', { version: 1, requestId: 'cancel-2', operation: 'cancel', handle: documentHandle });
		await viewport;
		disconnect.fire('window:1');
		assert.deepStrictEqual(backend.disconnected, ['window:1']);
		assert.strictEqual(cancelled, true);
		assert.strictEqual(handleCancelled, true);
		channel.dispose();
		disconnect.dispose();
	});

	test('rejects empty cursors and targets while reserving control capacity at the active limit', async () => {
		assert.throws(() => snapshotParadisOfficeRequest({ ...request('compare', 'empty-cursor-1'), cursor: '' }), ParadisOfficeWireError);
		assert.throws(() => snapshotParadisOfficeRequest({ ...request('search', 'empty-cursor-2'), cursor: '' }), ParadisOfficeWireError);
		assert.throws(() => snapshotParadisOfficeRequest({ version: 1, requestId: 'empty-target-1', operation: 'cancel', targetRequestId: '' }), ParadisOfficeWireError);
		const backend = new RecordingBackend();
		const releases: ((response: ParadisOfficeResponse) => void)[] = [];
		backend.responses.set('inspect', () => new Promise<ParadisOfficeResponse>(resolve => releases.push(resolve)));
		const channel = new ParadisOfficeChannel(backend);
		await channel.call('window:control-limit', 'request', request('open', 'control-open-1'));
		const pending = Array.from({ length: PARADIS_OFFICE_ACTIVE_REQUEST_LIMIT }, (_, index) => channel.call('window:control-limit', 'request', request('inspect', `active-${index}`)));
		assert.strictEqual(releases.length, PARADIS_OFFICE_ACTIVE_REQUEST_LIMIT);
		await channel.call('window:control-limit', 'request', { version: 1, requestId: 'control-cancel-1', operation: 'cancel', targetRequestId: 'active-0' });
		await channel.call('window:control-limit', 'request', { version: 1, requestId: 'control-close-1', operation: 'close', handle: documentHandle });
		for (let index = 0; index < releases.length; index++) { releases[index](failure(request('inspect', `active-${index}`))); }
		await Promise.all(pending);
		assert.deepStrictEqual(backend.calls.slice(-2).map(call => call.operation), ['cancel', 'close']);
		channel.dispose();
	});

	test('bounds delayed close and cancel control entries at an exact per-owner limit', async () => {
		const backend = new RecordingBackend();
		let releaseTarget!: (response: ParadisOfficeResponse) => void;
		backend.responses.set('inspect', request => new Promise<ParadisOfficeResponse>(resolve => releaseTarget = resolve));
		const controlReleases: { readonly requestId: string; readonly resolve: (response: ParadisOfficeResponse) => void }[] = [];
		backend.responses.set('cancel', request => new Promise<ParadisOfficeResponse>(resolve => controlReleases.push({ requestId: request.requestId, resolve })));
		const channel = new ParadisOfficeChannel(backend);
		const target = channel.call('window:control-bounded', 'request', request('inspect', 'control-target-1'));
		const controls = Array.from({ length: PARADIS_OFFICE_CONTROL_REQUEST_LIMIT }, (_, index) => channel.call('window:control-bounded', 'request', { version: 1, requestId: `bounded-cancel-${index}`, operation: 'cancel', targetRequestId: 'control-target-1' }));
		const overflow = channel.call('window:control-bounded', 'request', { version: 1, requestId: 'bounded-cancel-overflow', operation: 'cancel', targetRequestId: 'control-target-1' });
		for (const pending of controlReleases) { pending.resolve({ version: 1, requestId: pending.requestId, operation: 'cancel', ok: true, outcome: 'complete', warnings: [], budgetUsage: {}, timings: {}, acknowledged: true }); }
		releaseTarget(failure(request('inspect', 'control-target-1')));
		const results = await Promise.allSettled([...controls, overflow]);
		assert.strictEqual(controlReleases.length, PARADIS_OFFICE_CONTROL_REQUEST_LIMIT);
		assert.strictEqual(results.at(-1)?.status, 'rejected');
		await target;
		channel.dispose();
	});

	test('resolves a local descriptor to bytes and runs package inspection only in the worker', async () => {
		const directory = await mkdtemp(join(tmpdir(), 'paradis-office-channel-'));
		const file = join(directory, 'document.docx');
		try {
			const bytes = await buildOpcFixture({
				parts: [['/word/document.xml', '<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body/></w:document>']],
				relationships: [{ id: 'rId1', type: 'http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument', target: 'word/document.xml' }],
			});
			await writeFile(file, bytes);
			const channel = new ParadisOfficeChannel();
			const response = await channel.call<ParadisOfficeResponse>('window:local', 'request', { version: 1, requestId: 'local-open-1', operation: 'open', source: { kind: 'file', uri: URI.file(file).toString(), displayName: 'document.docx' } });
			assert.strictEqual(response.ok, true, JSON.stringify(response));
			assert.strictEqual(response.operation, 'open');
			if (!response.ok || response.operation !== 'open') { throw new Error('Expected local Office open response'); }
			assert.match(response.revision.sourceRevision, /^office-file-v1:file:[a-f\d]{64}:/);
			assert.strictEqual(response.revision.sourceRevision.includes(directory), false);
			await channel.call('window:local', 'request', { version: 1, requestId: 'local-close-1', operation: 'close', handle: response.handle });
			channel.dispose();
		} finally { await rm(directory, { recursive: true, force: true }); }
	});

	test('streams fixed local file bytes with mutation probes, cancellation, sanitized errors, and FD admission', async () => {
		const descriptor = { kind: 'file' as const, uri: 'file:///private/source.docx', displayName: 'source.docx' };
		const content = new Uint8Array(PARADIS_OFFICE_FILE_READ_CHUNK_BYTES + 3).fill(7);
		const stableHandle = new FakeOfficeFileHandle(content);
		const stableResolver = new LocalParadisOfficeSourceResolver({ openFile: async () => stableHandle });
		const stable = await stableResolver.resolve('window:stable', descriptor, CancellationToken.None);
		assert.deepStrictEqual(stable.bytes, content);
		assert.ok(stableHandle.readLengths.every(length => length <= PARADIS_OFFICE_FILE_READ_CHUNK_BYTES));
		assert.strictEqual(stableHandle.readLengths.at(-1), 1);
		assert.strictEqual(stableHandle.closed, 1);
		assert.strictEqual(stable.revision.includes('/private/'), false);

		const growing = new FakeOfficeFileHandle(new Uint8Array([1, 2, 3, 4]), 3);
		await assert.rejects(new LocalParadisOfficeSourceResolver({ openFile: async () => growing }).resolve('window:grow', descriptor, CancellationToken.None), (error: unknown) => error instanceof ParadisOfficeSourceResolutionError && error.code === 'changed');
		const truncated = new FakeOfficeFileHandle(new Uint8Array([1, 2]), 3);
		await assert.rejects(new LocalParadisOfficeSourceResolver({ openFile: async () => truncated }).resolve('window:truncate', descriptor, CancellationToken.None), (error: unknown) => error instanceof ParadisOfficeSourceResolutionError && error.code === 'changed');
		const cancellation = new CancellationTokenSource();
		const cancelled = new FakeOfficeFileHandle(new Uint8Array([1, 2, 3]), 3, () => cancellation.cancel());
		await assert.rejects(new LocalParadisOfficeSourceResolver({ openFile: async () => cancelled }).resolve('window:cancel', descriptor, cancellation.token), (error: unknown) => error instanceof ParadisOfficeSourceResolutionError && error.code === 'changed');
		cancellation.dispose();
		const raw = new Error('/private/source.docx raw failure');
		const broken = new FakeOfficeFileHandle(new Uint8Array([1]), 1, undefined, raw);
		await assert.rejects(new LocalParadisOfficeSourceResolver({ openFile: async () => broken }).resolve('window:raw', descriptor, CancellationToken.None), (error: unknown) => error instanceof ParadisOfficeSourceResolutionError && error.message.includes('/private/') === false && error.stack === '');

		const ownerReleases: ((handle: IParadisOfficeFileHandle) => void)[] = [];
		const ownerResolver = new LocalParadisOfficeSourceResolver({ openFile: () => new Promise<IParadisOfficeFileHandle>(resolve => ownerReleases.push(resolve)) });
		const ownerPending = Array.from({ length: PARADIS_OFFICE_FILE_PER_OWNER_LIMIT }, (_, index) => ownerResolver.resolve('window:fd-owner', { ...descriptor, displayName: `owner-${index}` }, CancellationToken.None));
		await assert.rejects(ownerResolver.resolve('window:fd-owner', descriptor, CancellationToken.None), (error: unknown) => error instanceof ParadisOfficeSourceResolutionError && error.code === 'limitExceeded');
		for (const release of ownerReleases) { release(new FakeOfficeFileHandle(new Uint8Array())); }
		await Promise.all(ownerPending);

		const globalReleases: ((handle: IParadisOfficeFileHandle) => void)[] = [];
		const globalResolver = new LocalParadisOfficeSourceResolver({ openFile: () => new Promise<IParadisOfficeFileHandle>(resolve => globalReleases.push(resolve)) });
		const globalPending = Array.from({ length: PARADIS_OFFICE_FILE_GLOBAL_LIMIT }, (_, index) => globalResolver.resolve(`window:fd-${index}`, descriptor, CancellationToken.None));
		await assert.rejects(globalResolver.resolve('window:fd-overflow', descriptor, CancellationToken.None), (error: unknown) => error instanceof ParadisOfficeSourceResolutionError && error.code === 'limitExceeded');
		for (const release of globalReleases) { release(new FakeOfficeFileHandle(new Uint8Array())); }
		await Promise.all(globalPending);
	});

	test('builds non-path-bearing file revisions from kind, canonical identity, full stat identity, size, and content hash', () => {
		const stat = { dev: 7, ino: 11, ctimeMs: 1.25, mtimeMs: 2.75, size: 3, isFile: () => true };
		const sha256 = 'a'.repeat(64);
		const fileRevision = buildParadisOfficeFileRevision('file', URI.file('/private/a.docx'), stat, sha256);
		const otherPath = buildParadisOfficeFileRevision('file', URI.file('/private/b.docx'), stat, sha256);
		const workingTree = buildParadisOfficeFileRevision('workingTree', URI.file('/private/a.docx'), stat, sha256);
		assert.notStrictEqual(fileRevision, otherPath);
		assert.notStrictEqual(fileRevision, workingTree);
		assert.ok(fileRevision.includes(':7:11:1.25:2.75:3:'));
		assert.strictEqual(fileRevision.includes('/private/'), false);
	});

	test('uploads a Task 3 sealed spool and resolves only descriptor state into Task 5 worker bytes', async () => {
		const store = new OfficeSpoolStore({ platform: 'desktopLocal' });
		const resolver = new SpoolAwareParadisOfficeSourceResolver(store);
		const channel = new ParadisOfficeChannel(new LocalParadisOfficeDocumentBackend(resolver), Event.None, new ParadisOfficeSpoolTransport(store, resolver));
		const ownerId = 'window:spool';
		const attemptId = '123e4567-e89b-42d3-a456-426614174000';
		const reference = await channel.call<{ readonly id: string; readonly ownerId: string; readonly nonce: string; readonly attemptId: string }>(ownerId, 'spool/begin', { attemptId });
		await channel.call(ownerId, 'spool/claim', { reference, attemptId });
		const bytes = await buildOpcFixture({
			parts: [['/word/document.xml', '<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body/></w:document>']],
			relationships: [{ id: 'rId1', type: 'http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument', target: 'word/document.xml' }],
		});
		await channel.call(ownerId, 'spool/append', { reference, bytes: VSBuffer.wrap(bytes) });
		const sha256 = createHash('sha256').update(bytes).digest('hex');
		const sealRequest = { sourceKind: 'untitled' as const, providerIdentity: 'working-copy:1', providerRevision: 'version:1', size: bytes.byteLength, sha256, revision: buildParadisOfficeSourceRevision('untitled', 'working-copy:1', 'version:1', bytes.byteLength, sha256) };
		const spool = await channel.call(ownerId, 'spool/seal', { reference, request: sealRequest });
		const descriptor = { kind: 'untitled' as const, displayName: 'Untitled-1', revisionHint: sealRequest.revision };
		await channel.call(ownerId, 'source/bind', { descriptor, spool });
		const response = await channel.call<ParadisOfficeResponse>(ownerId, 'request', { version: 1, requestId: 'spool-open-1', operation: 'open', source: descriptor });
		assert.strictEqual(response.ok, true);
		assert.strictEqual(store.byteLength, 0);
		channel.dispose();
		store.disposeAll();
	});

	test('maps sideMissing sources to the sideMissing outcome without treating them as engine failures', async () => {
		const channel = new ParadisOfficeChannel(new LocalParadisOfficeDocumentBackend());
		const missing = { kind: 'sideMissing' as const, displayName: 'Deleted document', side: 'original' as const };
		const inspect = await channel.call<ParadisOfficeResponse>('window:missing', 'request', { version: 1, requestId: 'missing-inspect-1', operation: 'inspect', source: missing });
		assert.strictEqual(inspect.ok, false);
		assert.strictEqual(inspect.outcome, 'sideMissing');
		const compare = await channel.call<ParadisOfficeResponse>('window:missing', 'request', { version: 1, requestId: 'missing-compare-1', operation: 'compare', original: missing, modified: { ...source, side: 'modified' } });
		assert.strictEqual(compare.ok, false);
		assert.strictEqual(compare.outcome, 'sideMissing');
		channel.dispose();
	});

	test('exposes exact owner-bound spool disposeAttempt without cross-owner cleanup', async () => {
		const store = new OfficeSpoolStore({ platform: 'desktopLocal' });
		const resolver = new SpoolAwareParadisOfficeSourceResolver(store);
		const channel = new ParadisOfficeChannel(new RecordingBackend(), Event.None, new ParadisOfficeSpoolTransport(store, resolver));
		const attemptId = '223e4567-e89b-42d3-a456-426614174000';
		await channel.call('window:attempt-owner', 'spool/begin', { attemptId });
		assert.strictEqual(store.activeSpoolCount, 1);
		await channel.call('window:attempt-other', 'spool/disposeAttempt', { attemptId });
		assert.strictEqual(store.activeSpoolCount, 1);
		await assert.rejects(channel.call('window:attempt-owner', 'spool/disposeAttempt', { attemptId: attemptId.toUpperCase() }), ParadisOfficeChannelError);
		await assert.rejects(channel.call('window:attempt-owner', 'spool/disposeAttempt', { attemptId, extra: true }), ParadisOfficeChannelError);
		await channel.call('window:attempt-owner', 'spool/disposeAttempt', { attemptId });
		assert.strictEqual(store.activeSpoolCount, 0);
		channel.dispose();
		store.disposeAll();
	});

	test('admits spool bytes before append and synchronizes accounting after every failure', async () => {
		const ownerId = 'window:spool-accounting';
		const attemptId = '323e4567-e89b-42d3-a456-426614174000';
		const accountant = new OfficeMemoryAccountant(5);
		accountant.setHandles(5);
		const store = new OfficeSpoolStore({ platform: 'desktopLocal' });
		const resolver = new SpoolAwareParadisOfficeSourceResolver(store);
		const channel = new ParadisOfficeChannel(new RecordingBackend(), Event.None, new ParadisOfficeSpoolTransport(store, resolver, accountant));
		const reference = await channel.call<{ readonly id: string; readonly ownerId: string; readonly nonce: string; readonly attemptId: string }>(ownerId, 'spool/begin', { attemptId });
		await channel.call(ownerId, 'spool/claim', { reference, attemptId });
		await assert.rejects(channel.call(ownerId, 'spool/append', marshalParadisOfficeSpoolAppend({ reference, bytes: VSBuffer.fromByteArray([1]) })), ParadisOfficeChannelError);
		assert.strictEqual(store.activeSpoolCount, 1);
		assert.strictEqual(store.byteLength, 0);
		assert.strictEqual(accountant.snapshot().spoolBytes, 0);
		accountant.setHandles(0);
		await channel.call(ownerId, 'spool/append', marshalParadisOfficeSpoolAppend({ reference, bytes: VSBuffer.fromByteArray([1]) }));
		assert.strictEqual(accountant.snapshot().spoolBytes, 1);
		const invalidSeal = { sourceKind: 'untitled' as const, providerIdentity: 'working-copy:accounting', providerRevision: 'version:1', size: 1, sha256: '0'.repeat(64), revision: '0'.repeat(64) };
		await assert.rejects(channel.call(ownerId, 'spool/seal', { reference, request: invalidSeal }), ParadisOfficeChannelError);
		assert.strictEqual(store.byteLength, 0);
		assert.strictEqual(accountant.snapshot().spoolBytes, 0);
		channel.dispose();
		store.disposeAll();
	});
});
