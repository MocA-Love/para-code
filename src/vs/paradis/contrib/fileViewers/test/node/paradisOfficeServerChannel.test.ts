/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import assert from 'assert';
import { createHash } from 'crypto';
import { readFile } from 'fs/promises';
import JSZip from 'jszip';
import { VSBuffer } from '../../../../../base/common/buffer.js';
import { CancellationToken, CancellationTokenSource } from '../../../../../base/common/cancellation.js';
import { Emitter, Event } from '../../../../../base/common/event.js';
import { DisposableStore, toDisposable, type IDisposable } from '../../../../../base/common/lifecycle.js';
import { join } from '../../../../../base/common/path.js';
import { URI } from '../../../../../base/common/uri.js';
import { ChannelClient, ChannelServer, type IChannel, type IMessagePassingProtocol } from '../../../../../base/parts/ipc/common/ipc.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
// eslint-disable-next-line local/code-layering, local/code-import-patterns -- This Node integration test intentionally drives the browser fallback client through the real shared-process Task 6 channel.
import { ParadisOfficeGitSource, type IParadisOfficeGitRepository } from '../../browser/paradisOfficeGitSource.js';
// eslint-disable-next-line local/code-layering, local/code-import-patterns -- This Node integration test intentionally drives the browser fallback client through the real shared-process Task 6 channel.
import { ParadisOfficeRemoteClient } from '../../browser/paradisOfficeRemoteClient.js';
// eslint-disable-next-line local/code-layering, local/code-import-patterns -- This Node integration test intentionally drives the browser fallback client through the real shared-process Task 6 channel.
import { ParadisOfficeChannelSpoolClient, ParadisOfficeSourceBroker } from '../../browser/paradisOfficeSourceBroker.js';
import { PARADIS_OFFICE_CHANNEL, decodeParadisOfficeWireValue, marshalParadisOfficeRequest, type IParadisOfficeDocumentBackend, type ParadisOfficeV1Negotiation } from '../../common/paradisOfficeChannel.js';
import { createParadisOfficeError } from '../../common/paradisOfficeErrors.js';
import { buildParadisOfficeSourceRevision } from '../../common/paradisOfficeSourceBroker.js';
import { PARADIS_OFFICE_BUDGET_PROFILES, type ParadisOfficeBudgetProfile, type ParadisOfficeRequest, type ParadisOfficeResponse, type ParadisOfficeSourceDescriptor } from '../../common/paradisOfficeProtocol.js';
import { OfficeHandleStore } from '../../node/office/paradisOfficeHandleStore.js';
import { OfficeWorkerHost, type IOfficeWorker, type OfficeWorkerOutcome, type OfficeWorkerSource, type ParadisOfficeWorkerOperation } from '../../node/office/paradisOfficeWorkerHost.js';
import { LocalParadisOfficeDocumentBackend, ParadisOfficeChannel, ParadisOfficeSpoolTransport, SpoolAwareParadisOfficeSourceResolver } from '../../node/paradisOfficeChannel.js';
import { ParadisOfficeRemoteFileCoordinator, ParadisOfficeRemoteRuntime, ParadisOfficeRemoteSourceResolver, ParadisOfficeRemoteWorkerHost } from '../../node/paradisOfficeRemoteBackend.js';
import { ParadisOfficeServerChannel } from '../../node/paradisOfficeServerChannel.js';
import { OfficeSpoolStore } from '../../node/paradisOfficeSpoolStore.js';

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

function inventory(format: 'docx' | 'xlsx', budgetProfile: ParadisOfficeBudgetProfile['kind'], byteLength: number) {
	return {
		format, container: 'opc', parts: [], relationships: [], features: [],
		security: { encrypted: false, hasMacros: false, hasExternalRelationships: false, hasEmbeddedObjects: false, hasProtection: false, hasSignatures: false },
		budgetProfile, budgetUsage: { compressedInputBytes: byteLength, expandedBytes: 0, entryCount: 0, largestPartBytes: 0, totalMediaBytes: 0, elapsedMilliseconds: 0 },
		outcome: 'complete', completeness: { expectedParts: 0, visitedParts: 0, parsedParts: 0, opaqueParts: 0, failedParts: 0, omittedParts: 0, expectedSemanticUnits: 0, visitedSemanticUnits: 0, terminal: true }, warnings: [],
	} as const;
}

class CapturingWorkerHost extends OfficeWorkerHost {
	readonly sources: Uint8Array[] = [];
	constructor(private readonly format: 'docx' | 'xlsx') { super(); }
	override run<T extends object>(_operation: ParadisOfficeWorkerOperation, _ownerId: string, source: OfficeWorkerSource, budget: ParadisOfficeBudgetProfile, _token: CancellationToken): Promise<OfficeWorkerOutcome<T>> {
		this.sources.push(source.bytes.slice());
		return Promise.resolve({ outcome: 'complete', value: { inventory: inventory(this.format, budget.kind, source.bytes.byteLength) } as T });
	}
}

function fixturePath(name: string): string {
	return join(process.cwd(), 'src/vs/paradis/contrib/fileViewers/test/common/fixtures', name);
}

async function sha256(bytes: Uint8Array): Promise<string> {
	return createHash('sha256').update(bytes).digest('hex');
}

function assertBytesEqual(actual: Uint8Array, expected: Uint8Array): void {
	assert.strictEqual(Buffer.compare(Buffer.from(actual.buffer, actual.byteOffset, actual.byteLength), Buffer.from(expected.buffer, expected.byteOffset, expected.byteLength)), 0);
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

	test('carries actual Office packages unchanged through Git, authority-fenced spool IPC, remote resolution, and worker input', async function () {
		this.timeout(30_000);
		for (const [fixtureName, format] of [['task2-drawing-line.docx', 'docx'], ['task2-diagonal-border.xlsx', 'xlsx']] as const) {
			const sourceBytes = new Uint8Array(await readFile(fixturePath(fixtureName)));
			const expectedSha256 = await sha256(sourceBytes);
			const archive = await JSZip.loadAsync(sourceBytes);
			const contentTypes = await archive.file('[Content_Types].xml')!.async('string');
			if (format === 'docx') {
				const relationships = await archive.file('word/_rels/document.xml.rels')!.async('string');
				const document = await archive.file('word/document.xml')!.async('string');
				assert.ok(contentTypes.includes('wordprocessingml.document.main+xml'));
				assert.ok(contentTypes.includes('Extension="png"'));
				assert.ok(relationships.includes('relationships/image') && relationships.includes('Target="/media/image.png"'));
				assert.ok(archive.file('media/image.png'));
				assert.match(document, /<wp:anchor\b/);
				assert.match(document, /<wps:wsp>/);
				assert.match(document, /<a:xfrm rot="2700000">/);
				assert.match(document, /<a:ln\b/);
			} else {
				const styles = await archive.file('xl/styles.xml')!.async('string');
				const sheet = await archive.file('xl/worksheets/sheet1.xml')!.async('string');
				assert.ok(contentTypes.includes('spreadsheetml.sheet.main+xml'));
				assert.match(styles, /<x:border diagonalUp="1" diagonalDown="1">/);
				assert.match(styles, /<x:diagonal style="medium">/);
				assert.match(sheet, /<x:c r="A1" s="1"/);
			}

			const repository: IParadisOfficeGitRepository = {
				snapshot: {
					repositoryRoot: URI.file('/office-fixture-repository'), headCommit: '1'.repeat(40), indexChecksum: 'a'.repeat(64), workingTreeRevision: 'fixture-event:1',
					indexChanges: [{ status: 'modified', path: fixtureName }], workingTreeChanges: [],
				},
				onDidChange: Event.None,
				dispose: () => { },
			};
			const gitSource = new ParadisOfficeGitSource(repository, { readFile: async () => VSBuffer.wrap(sourceBytes.slice()) });
			const comparison = await gitSource.createComparison('headToIndex', fixtureName, CancellationToken.None);
			assert.strictEqual(comparison.modified.contentHash, expectedSha256);

			const disposables = new DisposableStore();
			const [clientProtocol, serverProtocol] = createProtocolPair();
			disposables.add(clientProtocol); disposables.add(serverProtocol);
			const channelClient = disposables.add(new ChannelClient(clientProtocol));
			const channelServer = disposables.add(new ChannelServer(serverProtocol, `window:fixture-${format}`));
			const store = new OfficeSpoolStore({ platform: 'desktopLocal' });
			const spoolResolver = new SpoolAwareParadisOfficeSourceResolver(store);
			let openedBytes: Uint8Array | undefined;
			const captureResolver = {
				resolve: async (ownerId: string, descriptor: ParadisOfficeSourceDescriptor, token: CancellationToken) => {
					const resolved = await spoolResolver.resolve(ownerId, descriptor, token);
					openedBytes = resolved.bytes.slice();
					return resolved;
				},
			};
			const localWorkers = new CapturingWorkerHost(format);
			const backend = new LocalParadisOfficeDocumentBackend(captureResolver, localWorkers, new OfficeHandleStore());
			let epoch = 1;
			let capabilitySequence = 0;
			const channel = disposables.add(new ParadisOfficeChannel(backend, Event.None, new ParadisOfficeSpoolTransport(store, spoolResolver), {
				currentEpoch: ownerId => ownerId === `window:fixture-${format}` ? epoch : undefined,
				onDidDisconnect: Event.None,
				createCapability: () => (++capabilitySequence).toString(16).padStart(64, '0'),
			}));
			channelServer.registerChannel(PARADIS_OFFICE_CHANNEL, channel);
			const wire = channelClient.getChannel(PARADIS_OFFICE_CHANNEL);
			const commandLog: { readonly command: string; readonly authority?: { readonly ownerCapability: string; readonly connectionEpoch: number }; readonly bytes?: VSBuffer; readonly value?: unknown }[] = [];
			const recordingWire: IChannel = {
				call: async (command, arg, token) => {
					if (command !== 'negotiate') {
						const decoded = decodeParadisOfficeWireValue(arg);
						const bytes = command === 'spool/append' ? (decoded.value as { readonly bytes: VSBuffer }).bytes.clone() : undefined;
						commandLog.push({ command, authority: decoded.authority, ...(bytes ? { bytes } : {}), value: decoded.value });
					}
					return wire.call(command, arg, token);
				},
				listen: (event, arg) => wire.listen(event, arg),
			};
			const spoolClient = new ParadisOfficeChannelSpoolClient(recordingWire);
			const broker = new ParadisOfficeSourceBroker({
				ownerId: 'window:before-negotiation', platform: 'desktopLocal', provider: gitSource, spoolClient,
				createHash: () => { const hash = createHash('sha256'); return { update: bytes => hash.update(bytes.buffer), digest: () => hash.digest('hex') }; },
				isRemoteProtocolV1: () => false,
			});
			const oldRemote: IChannel = { call: () => Promise.reject(new Error('old remote')), listen: () => { throw new Error('No events'); } };
			const connection = { remoteAuthority: 'old-remote', getChannel: () => oldRemote };
			const remoteClient = new ParadisOfficeRemoteClient({ remoteAgentService: { getConnection: () => connection }, localChannel: recordingWire, sourceBroker: broker, spoolClient, onWarning: () => { } });

			const result = await remoteClient.request({ version: 1, requestId: `fixture-${format}`, operation: 'open', source: comparison.modified.descriptor }, CancellationToken.None);

			assert.strictEqual(result.route, 'boundedLocalSpool');
			assert.strictEqual(result.response.ok, true);
			const appendCommands = commandLog.filter(entry => entry.command === 'spool/append');
			assert.strictEqual(appendCommands[0].bytes!.byteLength, 2 * 1024 * 1024);
			const spooledBytes = VSBuffer.concat(appendCommands.map(entry => entry.bytes!)).buffer;
			const sealValue = commandLog.find(entry => entry.command === 'spool/seal')!.value as { readonly request: { readonly sha256: string } };
			const negotiatedAuthority = commandLog[0].authority;
			assert.ok(negotiatedAuthority);
			assert.ok(commandLog.every(entry => entry.authority?.ownerCapability === negotiatedAuthority.ownerCapability && entry.authority.connectionEpoch === negotiatedAuthority.connectionEpoch));
			assertBytesEqual(spooledBytes, sourceBytes);
			assert.strictEqual(sealValue.request.sha256, expectedSha256);
			assertBytesEqual(openedBytes!, sourceBytes);
			assertBytesEqual(localWorkers.sources[0], sourceBytes);

			const remoteResolver = new ParadisOfficeRemoteSourceResolver('ssh-remote+fixture', {
				openFile: async () => ({
					stat: async () => ({ dev: 7, ino: 11, ctimeMs: 13, mtimeMs: 17, size: openedBytes!.byteLength, isFile: () => true }),
					read: async (buffer, offset, length, position) => { const bytesRead = Math.max(0, Math.min(length, openedBytes!.byteLength - position)); buffer.set(openedBytes!.subarray(position, position + bytesRead), offset); return { bytesRead }; },
					close: async () => { },
				}),
			});
			const remoteResolved = await remoteResolver.resolve(`remote:fixture-${format}`, { kind: 'remote', uri: `vscode-remote://ssh-remote%2Bfixture/workspace/${fixtureName}`, displayName: fixtureName }, CancellationToken.None);
			const remoteWorkers = new CapturingWorkerHost(format);
			assert.strictEqual((await remoteWorkers.run('inspect', `remote:fixture-${format}`, remoteResolved, PARADIS_OFFICE_BUDGET_PROFILES.remoteMobile, CancellationToken.None)).outcome, 'complete');
			for (const bytes of [spooledBytes, openedBytes!, localWorkers.sources[0], remoteResolved.bytes, remoteWorkers.sources[0]]) {
				assert.strictEqual(await sha256(bytes), expectedSha256);
				assertBytesEqual(bytes, sourceBytes);
			}

			const newRemoteAuthority = { ownerCapability: 'd'.repeat(64), connectionEpoch: 7 };
			await assert.rejects(wire.call('source/unbind', marshalParadisOfficeRequest({ version: 1, requestId: 'wrong-shape', operation: 'inspect', source: comparison.modified.descriptor }, newRemoteAuthority)));
			epoch = 2;
			const nextNegotiation = await wire.call<ParadisOfficeV1Negotiation>('negotiate', { versions: [1] });
			await assert.rejects(wire.call('request', marshalParadisOfficeRequest({ version: 1, requestId: 'replay', operation: 'inspect', source: comparison.modified.descriptor }, negotiatedAuthority)));
			assert.notStrictEqual(nextNegotiation.ownerCapability, negotiatedAuthority.ownerCapability);

			if (format === 'docx') {
				const nextAuthority = { ownerCapability: nextNegotiation.ownerCapability!, connectionEpoch: nextNegotiation.connectionEpoch! };
				for (const [raceIndex, race] of ['before', 'after'].entries()) {
					const attemptId = `${raceIndex + 3}23e4567-e89b-42d3-a456-426614174000`;
					const preparationClient = new ParadisOfficeChannelSpoolClient(wire, nextAuthority);
					const writable = await preparationClient.begin(nextAuthority.ownerCapability, attemptId);
					await preparationClient.claim(writable, attemptId);
					for (let offset = 0; offset < sourceBytes.byteLength; offset += 2 * 1024 * 1024) {
						await preparationClient.append(writable, VSBuffer.wrap(sourceBytes.slice(offset, Math.min(offset + 2 * 1024 * 1024, sourceBytes.byteLength))));
					}
					const spool = await preparationClient.seal(writable, { sourceKind: 'gitIndex', providerIdentity: 'fixture:cancel', providerRevision: race, size: sourceBytes.byteLength, sha256: expectedSha256, revision: buildParadisOfficeSourceRevision('gitIndex', 'fixture:cancel', race, sourceBytes.byteLength, expectedSha256) });
					let releaseBind!: () => void;
					const bindGate = new Promise<void>(resolve => releaseBind = resolve);
					const bindStarted = new Emitter<void>();
					let unbindCalls = 0;
					const delayedWire: IChannel = {
						async call<T>(command: string, arg?: unknown, token?: CancellationToken): Promise<T> {
							if (command === 'source/unbind') { unbindCalls++; }
							if (command !== 'source/bind') { return wire.call<T>(command, arg, token); }
							if (race === 'before') {
								bindStarted.fire();
								await bindGate;
								return wire.call<T>(command, arg, CancellationToken.None);
							}
							const result = await wire.call<T>(command, arg, CancellationToken.None);
							bindStarted.fire();
							await bindGate;
							return result;
						},
						listen: (event, arg) => wire.listen(event, arg),
					};
					const cancellation = new CancellationTokenSource();
					const raceClient = new ParadisOfficeRemoteClient({
						remoteAgentService: { getConnection: () => connection }, localChannel: delayedWire,
						sourceBroker: { open: async () => ({ kind: 'spool', descriptor: comparison.modified.descriptor, spool }) },
						spoolClient: new ParadisOfficeChannelSpoolClient(delayedWire), onWarning: () => { },
					});
					const started = Event.toPromise(bindStarted.event);
					const pendingRace = raceClient.request({ version: 1, requestId: `bind-${race}`, operation: 'inspect', source: comparison.modified.descriptor }, cancellation.token);
					await started;
					cancellation.cancel();
					await assert.rejects(pendingRace);
					releaseBind();
					for (let index = 0; index < 100 && unbindCalls < 2; index++) { await new Promise(resolve => setTimeout(resolve, 0)); }
					assert.strictEqual(unbindCalls, 2);
					raceClient.dispose(); cancellation.dispose(); bindStarted.dispose();
				}
			}

			remoteClient.dispose(); remoteWorkers.dispose(); localWorkers.dispose(); gitSource.dispose(); disposables.dispose(); store.disposeAll();
		}
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
