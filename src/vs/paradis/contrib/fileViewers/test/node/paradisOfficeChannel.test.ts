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
import { CancellationToken } from '../../../../../base/common/cancellation.js';
import { Emitter, Event } from '../../../../../base/common/event.js';
import { join } from '../../../../../base/common/path.js';
import { URI } from '../../../../../base/common/uri.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { createParadisOfficeError } from '../../common/paradisOfficeErrors.js';
import { buildParadisOfficeSourceRevision } from '../../common/paradisOfficeSourceBroker.js';
import {
	PARADIS_OFFICE_CHANNEL,
	ParadisOfficeWireError,
	measureParadisOfficeWireBytes,
	snapshotParadisOfficeRequest,
	snapshotParadisOfficeResponse,
	snapshotParadisOfficeRestoreState,
	type IParadisOfficeDocumentBackend,
	type ParadisOfficeCancelRequest,
	type ParadisOfficeCloseRequest,
} from '../../common/paradisOfficeChannel.js';
import { PARADIS_OFFICE_LIMITS, type ParadisOfficeChangeCategory, type ParadisOfficeRequest, type ParadisOfficeResponse } from '../../common/paradisOfficeProtocol.js';
import { LocalParadisOfficeDocumentBackend, ParadisOfficeChannel, ParadisOfficeChannelError, ParadisOfficeSpoolTransport, SpoolAwareParadisOfficeSourceResolver } from '../../node/paradisOfficeChannel.js';
import { OfficeSpoolStore } from '../../node/paradisOfficeSpoolStore.js';
import { buildOpcFixture } from '../common/paradisOfficeFixture.js';

const documentHandle = { kind: 'document' as const, id: 'a'.repeat(48) };
const comparisonHandle = { kind: 'comparison' as const, id: 'b'.repeat(48) };
const source = { kind: 'file' as const, uri: 'file:///safe/document.docx', displayName: 'document.docx', revisionHint: 'hint-1' };
const completeness = { expectedParts: 1, visitedParts: 1, parsedParts: 1, opaqueParts: 0, failedParts: 0, omittedParts: 0, expectedSemanticUnits: 1, visitedSemanticUnits: 1, terminal: true };

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
			assert.match(response.revision.sourceRevision, /^file:[a-f\d]{64}:/);
			await channel.call('window:local', 'request', { version: 1, requestId: 'local-close-1', operation: 'close', handle: response.handle });
			channel.dispose();
		} finally { await rm(directory, { recursive: true, force: true }); }
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
});
