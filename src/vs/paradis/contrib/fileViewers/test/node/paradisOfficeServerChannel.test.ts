/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import assert from 'assert';
import { createHash } from 'crypto';
import { VSBuffer } from '../../../../../base/common/buffer.js';
import { CancellationToken, CancellationTokenSource } from '../../../../../base/common/cancellation.js';
import { Emitter } from '../../../../../base/common/event.js';
import { toDisposable, type IDisposable } from '../../../../../base/common/lifecycle.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { PARADIS_OFFICE_CHANNEL, marshalParadisOfficeRequest, type IParadisOfficeDocumentBackend, type ParadisOfficeV1Negotiation } from '../../common/paradisOfficeChannel.js';
import { createParadisOfficeError } from '../../common/paradisOfficeErrors.js';
import { buildParadisOfficeSourceRevision } from '../../common/paradisOfficeSourceBroker.js';
import { PARADIS_OFFICE_BUDGET_PROFILES, type ParadisOfficeRequest, type ParadisOfficeResponse, type ParadisOfficeSourceDescriptor } from '../../common/paradisOfficeProtocol.js';
import type { IOfficeWorker } from '../../node/office/paradisOfficeWorkerHost.js';
import { ParadisOfficeSpoolTransport, SpoolAwareParadisOfficeSourceResolver } from '../../node/paradisOfficeChannel.js';
import { ParadisOfficeRemoteFileCoordinator, ParadisOfficeRemoteRuntime, ParadisOfficeRemoteSourceResolver, ParadisOfficeRemoteWorkerHost } from '../../node/paradisOfficeRemoteBackend.js';
import { ParadisOfficeServerChannel } from '../../node/paradisOfficeServerChannel.js';
import { OfficeSpoolStore } from '../../node/paradisOfficeSpoolStore.js';
import { buildOpcFixture } from '../common/paradisOfficeFixture.js';

const remoteDescriptor: ParadisOfficeSourceDescriptor = {
	kind: 'remote',
	uri: 'vscode-remote://ssh-remote%2Bhost/workspace/book.xlsx',
	revisionHint: 'office-remote-hint:1',
	displayName: 'book.xlsx',
	side: 'modified',
};

function remoteInspectRequest(requestId: string): Extract<ParadisOfficeRequest, { readonly operation: 'inspect' }> {
	return { version: 1, requestId, operation: 'inspect', source: remoteDescriptor };
}

function failedResponse(request: ParadisOfficeRequest): ParadisOfficeResponse {
	return {
		version: 1,
		requestId: request.requestId,
		operation: request.operation,
		ok: false,
		outcome: 'failed',
		error: createParadisOfficeError('source', 'notFound', { severity: 'error', retryable: false, recoverable: true, userAction: 'retry' }),
	};
}

function backend(): IParadisOfficeDocumentBackend {
	const fail = (_ownerId: string, request: ParadisOfficeRequest) => Promise.resolve(failedResponse(request));
	return {
		inspect: fail,
		open: fail,
		getViewport: fail,
		compare: fail,
		search: fail,
		getRenderableAsset: fail,
		getPrintModel: fail,
		exportPrint: fail,
		close: fail,
		cancel: fail,
		disconnect: () => { },
	};
}

suite('ParadisOfficeServerChannel', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	test('resolves same-authority remote files into immutable raw worker bytes', async () => {
		const sourceBytes = Uint8Array.from([80, 75, 3, 4]);
		let openedPath: string | undefined;
		let closed = 0;
		const stat = { dev: 1, ino: 2, ctimeMs: 3, mtimeMs: 4, size: sourceBytes.byteLength, isFile: () => true };
		const resolver = new ParadisOfficeRemoteSourceResolver('ssh-remote+host', {
			openFile: async path => {
				openedPath = path;
				return {
					stat: async () => stat,
					read: async (buffer, offset, length, position) => {
						const bytesRead = Math.max(0, Math.min(length, sourceBytes.byteLength - position));
						buffer.set(sourceBytes.subarray(position, position + bytesRead), offset);
						return { bytesRead };
					},
					close: async () => { closed++; },
				};
			},
		});

		const resolved = await resolver.resolve('remote:owner', remoteDescriptor, CancellationToken.None);

		assert.deepStrictEqual({ openedPath, kind: resolved.kind, bytes: [...resolved.bytes], closed }, {
			openedPath: '/workspace/book.xlsx', kind: 'bytes', bytes: [...sourceBytes], closed: 1,
		});
		assert.ok(resolved.revision.includes('ssh-remote+host'));
		assert.ok(resolved.revision.includes('office-remote-hint:1'));
		assert.ok(resolved.revision.endsWith('9:1:2:3:4:4|64:8dcc7e601606217f3b754766511182a916b17e9a26a94c9d887104eba92e9bb2'));

		await assert.rejects(
			resolver.resolve('remote:owner', { ...remoteDescriptor, uri: 'vscode-remote://another-host/workspace/book.xlsx' }, CancellationToken.None),
			error => error instanceof Error && error.message === 'The Office source could not be resolved.' && error.stack === '',
		);
	});

	test('uses canonical remote paths and rejects query, fragment, dot, NUL, backslash, and cross-authority forms', async () => {
		const opened: string[] = [];
		const resolver = new ParadisOfficeRemoteSourceResolver('ssh-remote+host', {
			openFile: async path => {
				opened.push(path);
				return { stat: async () => ({ dev: 1, ino: 1, ctimeMs: 1, mtimeMs: 1, size: 0, isFile: () => true }), read: async () => ({ bytesRead: 0 }), close: async () => { } };
			}
		});
		await resolver.resolve('remote:uri', { ...remoteDescriptor, uri: 'vscode-remote://ssh-remote%2Bhost/C:/Office/book.xlsx' }, CancellationToken.None);
		assert.strictEqual(opened.length, 1);
		for (const uri of [
			'vscode-remote://ssh-remote%2Bhost/workspace/book.xlsx?token=secret',
			'vscode-remote://ssh-remote%2Bhost/workspace/book.xlsx#fragment',
			'vscode-remote://ssh-remote%2Bhost/workspace/../book.xlsx',
			'vscode-remote://ssh-remote%2Bhost/workspace/%00book.xlsx',
			'vscode-remote://ssh-remote%2Bhost/workspace\\book.xlsx',
			'vscode-remote://other/workspace/book.xlsx',
		]) {
			await assert.rejects(resolver.resolve('remote:uri', { ...remoteDescriptor, uri }, CancellationToken.None), error => error instanceof Error && error.message === 'The Office source could not be resolved.' && error.stack === '');
		}
		assert.strictEqual(opened.length, 1);
	});

	test('injects exact remoteMobile limits and shares the eight-file admission ledger', async () => {
		class Worker implements IOfficeWorker {
			readonly messages: unknown[] = [];
			private readonly message = new Emitter<unknown>();
			postMessage(value: unknown): void { this.messages.push(value); }
			terminate(): Promise<number> { return Promise.resolve(0); }
			onMessage(listener: (message: unknown) => void): IDisposable { return this.message.event(listener); }
			onError(): IDisposable { return toDisposable(() => { }); }
			onExit(): IDisposable { return toDisposable(() => { }); }
			emit(value: unknown): void { this.message.fire(value); }
		}
		const worker = new Worker();
		const timers: number[] = [];
		const host = new ParadisOfficeRemoteWorkerHost({ createWorker: () => worker, setTimeout: (_runner, delay) => { timers.push(delay); return delay; }, clearTimeout: () => { }, memory: { workerReservationBytes: 1 } });
		const cancellation = new CancellationTokenSource();
		const exactBytes = new Uint8Array(PARADIS_OFFICE_BUDGET_PROFILES.remoteMobile.compressedInputBytes);
		const pending = host.run('inspect', 'remote:budget', { kind: 'bytes', bytes: exactBytes, revision: 'raw-sha' }, PARADIS_OFFICE_BUDGET_PROFILES.desktopLocal, cancellation.token);
		const message = worker.messages[0] as { readonly requestId: string; readonly budget: typeof PARADIS_OFFICE_BUDGET_PROFILES.remoteMobile; readonly source: { readonly bytes: Uint8Array } };
		assert.deepStrictEqual(message.budget, PARADIS_OFFICE_BUDGET_PROFILES.remoteMobile);
		assert.strictEqual(message.budget.expandedBytes, 128 * 1024 * 1024);
		assert.strictEqual(message.budget.entryCount, 10_000);
		assert.strictEqual(message.budget.xmlPartBytes, 32 * 1024 * 1024);
		assert.strictEqual(message.source.bytes.byteLength, 20 * 1024 * 1024);
		assert.ok(timers.includes(PARADIS_OFFICE_BUDGET_PROFILES.remoteMobile.inspectMilliseconds));
		worker.emit({ kind: 'cancelled', requestId: message.requestId });
		assert.deepStrictEqual(await pending, { outcome: 'cancelled' });
		assert.deepStrictEqual(await host.run('inspect', 'remote:budget', { kind: 'bytes', bytes: new Uint8Array(PARADIS_OFFICE_BUDGET_PROFILES.remoteMobile.compressedInputBytes + 1), revision: 'too-large' }, PARADIS_OFFICE_BUDGET_PROFILES.desktopLocal, CancellationToken.None), { outcome: 'failed', error: 'engineCrashed' });
		const fixture = await buildOpcFixture({
			parts: [['/xl/workbook.xml', '<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"/>'], ['/xl/drawings/drawing1.xml', '<xdr:wsDr xmlns:xdr="http://schemas.openxmlformats.org/drawingml/2006/spreadsheetDrawing" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"><xdr:cxnSp><xdr:spPr><a:xfrm flipV="1"><a:off x="0" y="0"/><a:ext cx="1" cy="1"/></a:xfrm><a:ln/></xdr:spPr></xdr:cxnSp></xdr:wsDr>']],
			relationships: [{ id: 'rId1', type: 'http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument', target: 'xl/workbook.xml' }],
		});
		const fixtureResolver = new ParadisOfficeRemoteSourceResolver('ssh-remote+host', {
			openFile: async () => ({
				stat: async () => ({ dev: 2, ino: 3, ctimeMs: 4, mtimeMs: 5, size: fixture.byteLength, isFile: () => true }),
				read: async (buffer, offset, length, position) => { const bytesRead = Math.max(0, Math.min(length, fixture.byteLength - position)); buffer.set(fixture.subarray(position, position + bytesRead), offset); return { bytesRead }; }, close: async () => { },
			})
		});
		const resolvedFixture = await fixtureResolver.resolve('remote:fixture', remoteDescriptor, CancellationToken.None);
		const fixturePending = host.run('inspect', 'remote:fixture', resolvedFixture, PARADIS_OFFICE_BUDGET_PROFILES.desktopLocal, cancellation.token);
		const fixtureMessage = worker.messages[1] as { readonly requestId: string; readonly source: { readonly bytes: Uint8Array } };
		assert.deepStrictEqual([...fixtureMessage.source.bytes], [...fixture]);
		worker.emit({ kind: 'cancelled', requestId: fixtureMessage.requestId });
		assert.deepStrictEqual(await fixturePending, { outcome: 'cancelled' });
		host.dispose();
		cancellation.dispose();

		const files = new ParadisOfficeRemoteFileCoordinator();
		for (let index = 0; index < 8; index++) { files.acquire(`remote:connection-${Math.floor(index / 4)}-owner-${index}`); }
		assert.throws(() => files.acquire('remote:connection-2-owner-9'), error => error instanceof Error && error.message === 'The Office source could not be resolved.');
		for (let index = 0; index < 8; index++) { files.release(`remote:connection-${Math.floor(index / 4)}-owner-${index}`); }
		const runtime = new ParadisOfficeRemoteRuntime();
		const firstConnection = runtime.createBackend('ssh-remote+host');
		const secondConnection = runtime.createBackend('ssh-remote+other');
		assert.strictEqual(runtime.accountant.reserveWorker(384 * 1024 * 1024), true);
		assert.strictEqual(runtime.accountant.reserveWorker(384 * 1024 * 1024), true);
		assert.strictEqual(runtime.accountant.reserveWorker(1), false);
		runtime.accountant.releaseWorker(768 * 1024 * 1024);
		firstConnection.disconnect('remote:first');
		secondConnection.disconnect('remote:second');
		runtime.dispose();
	});

	test('unbinds an unused owner descriptor exactly and permits the next request binding', async () => {
		const owner = 'window:remote-fallback';
		const store = new OfficeSpoolStore({ platform: 'desktopLocal' });
		const resolver = new SpoolAwareParadisOfficeSourceResolver(store);
		const transport = new ParadisOfficeSpoolTransport(store, resolver);
		const descriptor = { kind: 'untitled' as const, displayName: 'drawing.xlsx', revisionHint: 'raw-revision', side: 'modified' as const };
		const createSpool = async (attemptId: string) => {
			const bytes = VSBuffer.fromString('raw-DrawingML-diagonal');
			const sha256 = createHash('sha256').update(bytes.buffer).digest('hex');
			const reference = await store.begin(owner, attemptId);
			await store.claim(reference, attemptId);
			await store.append(reference, bytes);
			return store.seal(reference, { sourceKind: 'untitled', providerIdentity: 'fixture', providerRevision: attemptId, size: bytes.byteLength, sha256, revision: buildParadisOfficeSourceRevision('untitled', 'fixture', attemptId, bytes.byteLength, sha256) });
		};
		const first = await createSpool('123e4567-e89b-42d3-a456-426614174000');
		await transport.call(owner, 'source/bind', { descriptor, spool: first });
		await transport.call(owner, 'source/unbind', { descriptor, spool: first });
		await transport.call(owner, 'source/unbind', { descriptor, spool: first });
		assert.strictEqual(store.activeSpoolCount, 0);
		const second = await createSpool('223e4567-e89b-42d3-a456-426614174000');
		await transport.call(owner, 'source/bind', { descriptor, spool: second });
		await assert.rejects(transport.call(owner, 'source/unbind', { descriptor, spool: first }));
		await transport.call(owner, 'source/unbind', { descriptor });
		assert.strictEqual(store.activeSpoolCount, 0);
		store.disposeAll();
	});

	test('binds negotiation authority to one connection epoch and cleans up on disconnect', async () => {
		const disconnected = new Emitter<void>();
		const context = { remoteAuthority: 'ssh-remote+host', clientId: 'client-a' };
		let backendDisconnects = 0;
		const serverBackend = backend();
		serverBackend.disconnect = () => { backendDisconnects++; };
		const channel = new ParadisOfficeServerChannel(context, {
			onDidDisconnect: disconnected.event,
			connectionEpoch: 42,
			createBackend: authority => {
				assert.strictEqual(authority, context.remoteAuthority);
				return serverBackend;
			},
		});

		const negotiation = await channel.call<ParadisOfficeV1Negotiation>(context, 'negotiate', { versions: [1] });
		assert.deepStrictEqual({ version: negotiation.version, channel: negotiation.channel, epoch: negotiation.connectionEpoch, capabilityLength: negotiation.ownerCapability?.length }, {
			version: 1, channel: PARADIS_OFFICE_CHANNEL, epoch: 42, capabilityLength: 64,
		});
		disconnected.fire();
		await assert.rejects(channel.call(context, 'negotiate', { versions: [1] }), /disconnected/);
		assert.strictEqual(backendDisconnects, 1);
		channel.dispose();
		disconnected.dispose();
	});

	test('forwards the exact cancellation token and rechecks new-source capability without breaking handle operations', async () => {
		const context = { remoteAuthority: 'ssh-remote+host', clientId: 'client-token' };
		let enabled = true;
		let receivedToken: CancellationToken | undefined;
		let closeCalls = 0;
		const serverBackend = backend();
		serverBackend.inspect = (_owner, request, token) => {
			receivedToken = token;
			return new Promise(resolve => {
				const listener = token.onCancellationRequested(() => { listener.dispose(); resolve(failedResponse(request)); });
			});
		};
		serverBackend.open = (_owner, request, token) => { receivedToken = token; return Promise.resolve({ version: 1, requestId: request.requestId, operation: 'open', ok: true, outcome: 'complete', warnings: [], budgetUsage: {}, timings: {}, revision: { kind: 'document', sourceRevision: 'immutable-raw-revision' }, completeness: { expectedParts: 0, visitedParts: 0, parsedParts: 0, opaqueParts: 0, failedParts: 0, omittedParts: 0, expectedSemanticUnits: 0, visitedSemanticUnits: 0, terminal: true }, handle: { kind: 'document', id: 'a'.repeat(48) }, capabilities: [] }); };
		serverBackend.close = (_owner, request, token) => { receivedToken = token; closeCalls++; return Promise.resolve({ version: 1, requestId: request.requestId, operation: 'close', ok: true, outcome: 'complete', warnings: [], budgetUsage: {}, timings: {}, acknowledged: true }); };
		const channel = new ParadisOfficeServerChannel(context, { connectionEpoch: 9, createBackend: () => serverBackend, isPlatformBackendEnabled: () => enabled });
		const negotiation = await channel.call<ParadisOfficeV1Negotiation>(context, 'negotiate', { versions: [1] });
		const authority = { ownerCapability: negotiation.ownerCapability!, connectionEpoch: negotiation.connectionEpoch! };
		const cancellation = new CancellationTokenSource();
		const pendingInspect = channel.call(context, 'request', marshalParadisOfficeRequest(remoteInspectRequest('token-forward'), authority), cancellation.token);
		while (!receivedToken) { await Promise.resolve(); }
		cancellation.cancel();
		await pendingInspect;
		assert.strictEqual(receivedToken.isCancellationRequested, true);
		await channel.call(context, 'request', marshalParadisOfficeRequest({ version: 1, requestId: 'create-handle', operation: 'open', source: remoteDescriptor }, authority), CancellationToken.None);
		enabled = false;
		await assert.rejects(channel.call(context, 'request', marshalParadisOfficeRequest(remoteInspectRequest('disabled-source'), authority), CancellationToken.None), /disabled|rejected/);
		const close = { version: 1 as const, requestId: 'existing-handle', operation: 'close' as const, handle: { kind: 'document' as const, id: 'a'.repeat(48) } };
		await channel.call(context, 'request', marshalParadisOfficeRequest(close, authority), CancellationToken.None);
		assert.strictEqual(closeCalls, 1);
		cancellation.dispose();
		channel.dispose();
	});
});
