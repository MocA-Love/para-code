/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import assert from 'assert';
import { VSBuffer } from '../../../../../base/common/buffer.js';
import { CancellationToken, CancellationTokenSource } from '../../../../../base/common/cancellation.js';
import { Emitter, Event } from '../../../../../base/common/event.js';
import { URI } from '../../../../../base/common/uri.js';
import type { IChannel } from '../../../../../base/parts/ipc/common/ipc.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import {
	ParadisOfficeGitSource,
	ParadisOfficeGitSourceError,
	type IParadisOfficeGitByteProvider,
	type IParadisOfficeGitRepository,
	type ParadisOfficeGitRepositorySnapshot,
} from '../../browser/paradisOfficeGitSource.js';
import { ParadisOfficeChannelSpoolClient, ParadisOfficeSourceBroker, ParadisOfficeSourceBrokerError } from '../../browser/paradisOfficeSourceBroker.js';
import { ParadisOfficeRemoteClient, ParadisOfficeRemoteClientError } from '../../browser/paradisOfficeRemoteClient.js';
import { PARADIS_OFFICE_CHANNEL, decodeParadisOfficeWireValue, marshalParadisOfficeResponse, type ParadisOfficeV1Negotiation } from '../../common/paradisOfficeChannel.js';
import { createParadisOfficeError } from '../../common/paradisOfficeErrors.js';
import { type IOfficeSourceBroker, type IOfficeSourceHash, type IOfficeSpoolClient, type ParadisOfficeBackendSource, type ParadisOfficeSealedSpoolReference, type ParadisOfficeSpoolReference, type ParadisOfficeWritableSpoolReference, type ParadisOfficeSealRequest } from '../../common/paradisOfficeSourceBroker.js';
import type { ParadisOfficeRequest, ParadisOfficeResponse, ParadisOfficeSourceDescriptor } from '../../common/paradisOfficeProtocol.js';

const headCommitA = '1111111111111111111111111111111111111111';
const headCommitB = '2222222222222222222222222222222222222222';
const indexChecksumA = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
const indexChecksumB = 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';
const emptySha256 = 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855';
const headSha256 = '9f2e6d33a3717ee826353a404ba4618d1aeeb6879ad7936bce8ed5f46814924d';
const indexSha256 = '3bfc269594ef649228e9a74bab00f042efc91d5acc6fbee31a382e80d42388fe';
const workingSha256 = 'fb04dcb6970e4c3d1873de51fd5a50d7bb46b3383113602665c350ec40b5f990';

function refOf(uriText: string): string {
	const query = JSON.parse(URI.parse(uriText).query) as { readonly ref: string };
	return query.ref;
}

function pathOf(uriText: string): string {
	const resource = URI.parse(uriText);
	if (resource.scheme !== 'git') {
		return resource.path;
	}
	const query = JSON.parse(resource.query) as { readonly path: string };
	return query.path;
}

class TestRepository implements IParadisOfficeGitRepository {
	private readonly changeEmitter = new Emitter<void>();
	readonly onDidChange = this.changeEmitter.event;

	constructor(public snapshot: ParadisOfficeGitRepositorySnapshot) { }

	fireChange(): void {
		this.changeEmitter.fire();
	}

	dispose(): void {
		this.changeEmitter.dispose();
	}
}

class TestBytes implements IParadisOfficeGitByteProvider {
	readonly reads: string[] = [];
	fetches = 0;

	constructor(private readonly values: Record<string, ArrayLike<number>>) { }

	set(key: string, value: ArrayLike<number>): void {
		this.values[key] = value;
	}

	async readFile(resource: URI): Promise<VSBuffer> {
		this.reads.push(resource.toString(true));
		const key = `${resource.scheme}:${pathOf(resource.toString(true))}:${resource.scheme === 'git' ? refOf(resource.toString(true)) : 'working'}`;
		const value = this.values[key];
		if (!value) {
			throw new Error(`/private/repository/${key}`);
		}
		return VSBuffer.wrap(Uint8Array.from(value));
	}

	async fetch(): Promise<void> {
		this.fetches++;
	}
}

function repositorySnapshot(overrides: Partial<ParadisOfficeGitRepositorySnapshot> = {}): ParadisOfficeGitRepositorySnapshot {
	return {
		repositoryRoot: URI.file('/workspace/repo'),
		headCommit: headCommitA,
		indexChecksum: indexChecksumA,
		workingTreeRevision: 'stat:1:10:20:2',
		indexChanges: [{ status: 'modified', path: 'book.xlsx' }],
		workingTreeChanges: [{ status: 'modified', path: 'book.xlsx' }],
		...overrides,
	};
}

const remoteDescriptor: ParadisOfficeSourceDescriptor = {
	kind: 'remote',
	uri: 'vscode-remote://ssh-remote%2Bhost/workspace/book.xlsx',
	revisionHint: 'office-remote-hint:1',
	displayName: 'book.xlsx',
	side: 'modified',
};

const remoteFailedResponse = (requestId: string): ParadisOfficeResponse => ({
	version: 1,
	requestId,
	operation: 'inspect',
	ok: false,
	outcome: 'failed',
	error: createParadisOfficeError('source', 'notFound', { severity: 'error', retryable: false, recoverable: true, userAction: 'retry' }),
});

class RecordingRemoteChannel implements IChannel {
	readonly calls: { readonly command: string; readonly arg: unknown }[] = [];
	constructor(private readonly handler: (command: string, arg: unknown) => unknown | Promise<unknown>) { }
	call<T>(command: string, arg?: unknown): Promise<T> {
		this.calls.push({ command, arg });
		return Promise.resolve(this.handler(command, arg)) as Promise<T>;
	}
	listen<T>(): never { throw new Error('No events'); }
}

class RemoteSpoolClient implements IOfficeSpoolClient {
	readonly disposed: ParadisOfficeSpoolReference[] = [];
	begin(): Promise<ParadisOfficeWritableSpoolReference> { throw new Error('Not used'); }
	claim(): Promise<void> { throw new Error('Not used'); }
	append(): Promise<void> { throw new Error('Not used'); }
	seal(_reference: ParadisOfficeWritableSpoolReference, _request: ParadisOfficeSealRequest): Promise<ParadisOfficeSealedSpoolReference> { throw new Error('Not used'); }
	dispose(reference: ParadisOfficeSpoolReference): Promise<void> { this.disposed.push(reference); return Promise.resolve(); }
	disposeAttempt(): Promise<void> { return Promise.resolve(); }
}

const remoteSpool: ParadisOfficeSealedSpoolReference = {
	id: 'a'.repeat(48), ownerId: 'window:remote', nonce: 'b'.repeat(64), attemptId: '123e4567-e89b-42d3-a456-426614174000',
	sourceKind: 'remote', providerIdentity: 'remote-provider', providerRevision: 'etag:1', size: 4, sha256: 'c'.repeat(64), revision: 'office-source/v1|remote',
};

const localAuthority = { ownerCapability: 'e'.repeat(64), connectionEpoch: 11 };
const v1Capabilities = ['inspect', 'open', 'getViewport', 'compare', 'search', 'getRenderableAsset', 'getPrintModel', 'exportPrint', 'close', 'cancel'] as const;

function localNegotiation() {
	return { version: 1 as const, channel: PARADIS_OFFICE_CHANNEL, capabilities: [...v1Capabilities], ...localAuthority };
}

class RemoteBroker implements IOfficeSourceBroker {
	readonly opened: ParadisOfficeSourceDescriptor[] = [];
	constructor(private readonly result: ParadisOfficeBackendSource) { }
	open(source: ParadisOfficeSourceDescriptor): Promise<ParadisOfficeBackendSource> { this.opened.push(source); return Promise.resolve(this.result); }
}

function remoteInspectRequest(requestId: string): Extract<ParadisOfficeRequest, { readonly operation: 'inspect' }> {
	return { version: 1, requestId, operation: 'inspect', source: remoteDescriptor };
}

suite('ParadisOfficeGitSource', () => {
	ensureNoDisposablesAreLeakedInTestSuite();
	test('maps HEAD to index using the immutable commit and index refs', async () => {
		const repository = new TestRepository(repositorySnapshot());
		const bytes = new TestBytes({
			[`git:/workspace/repo/book.xlsx:${headCommitA}`]: [104, 101, 97, 100],
			'git:/workspace/repo/book.xlsx:': [118, 49],
		});
		const source = new ParadisOfficeGitSource(repository, bytes);

		const comparison = await source.createComparison('headToIndex', 'book.xlsx', CancellationToken.None);

		assert.deepStrictEqual({
			originalKind: comparison.original.descriptor.kind,
			originalRef: refOf(comparison.original.descriptor.uri!),
			originalPath: pathOf(comparison.original.descriptor.uri!),
			originalHash: comparison.original.contentHash,
			modifiedKind: comparison.modified.descriptor.kind,
			modifiedRef: refOf(comparison.modified.descriptor.uri!),
			modifiedPath: pathOf(comparison.modified.descriptor.uri!),
			modifiedHash: comparison.modified.contentHash,
		}, {
			originalKind: 'gitCommit',
			originalRef: headCommitA,
			originalPath: '/workspace/repo/book.xlsx',
			originalHash: headSha256,
			modifiedKind: 'gitIndex',
			modifiedRef: '',
			modifiedPath: '/workspace/repo/book.xlsx',
			modifiedHash: indexSha256,
		});
		assert.ok(comparison.original.descriptor.revisionHint?.includes(headCommitA));
		assert.ok(comparison.modified.descriptor.revisionHint?.includes(indexChecksumA));
		source.dispose();
		repository.dispose();
	});

	test('maps index to the actual working bytes and refreshes on repository status changes', async () => {
		const repository = new TestRepository(repositorySnapshot());
		const bytes = new TestBytes({
			'git:/workspace/repo/book.xlsx:': [118, 49],
			'file:/workspace/repo/book.xlsx:working': [118, 50],
		});
		const source = new ParadisOfficeGitSource(repository, bytes);
		let changes = 0;
		const changeListener = source.onDidChange(() => changes++);

		const before = await source.createComparison('indexToWorking', 'book.xlsx', CancellationToken.None);
		repository.snapshot = repositorySnapshot({ indexChecksum: indexChecksumB, workingTreeRevision: 'stat:1:10:21:2' });
		repository.fireChange();
		const after = await source.createComparison('indexToWorking', 'book.xlsx', CancellationToken.None);

		assert.deepStrictEqual({
			changes,
			originalHash: before.original.contentHash,
			modifiedHash: before.modified.contentHash,
			workingScheme: URI.parse(before.modified.descriptor.uri!).scheme,
			indexRevisionChanged: before.original.descriptor.revisionHint !== after.original.descriptor.revisionHint,
			workingRevisionChanged: before.modified.descriptor.revisionHint !== after.modified.descriptor.revisionHint,
		}, {
			changes: 1,
			originalHash: indexSha256,
			modifiedHash: workingSha256,
			workingScheme: 'file',
			indexRevisionChanged: true,
			workingRevisionChanged: true,
		});
		assert.ok(bytes.reads.some(resource => URI.parse(resource).scheme === 'file'));
		changeListener.dispose();
		source.dispose();
		repository.dispose();
	});

	test('normalizes rename and delete sides without inventing bytes', async () => {
		const repository = new TestRepository(repositorySnapshot({
			indexChanges: [{ status: 'renamed', path: 'renamed.xlsx', originalPath: 'old.xlsx' }],
			workingTreeChanges: [{ status: 'deleted', path: 'renamed.xlsx' }],
		}));
		const bytes = new TestBytes({
			[`git:/workspace/repo/old.xlsx:${headCommitA}`]: [104, 101, 97, 100],
			'git:/workspace/repo/renamed.xlsx:': [118, 49],
		});
		const source = new ParadisOfficeGitSource(repository, bytes);

		const renamed = await source.createComparison('headToIndex', 'renamed.xlsx', CancellationToken.None);
		const deleted = await source.createComparison('indexToWorking', 'renamed.xlsx', CancellationToken.None);

		assert.deepStrictEqual({
			renameOriginalPath: pathOf(renamed.original.descriptor.uri!),
			renameModifiedPath: pathOf(renamed.modified.descriptor.uri!),
			deleteOriginalKind: deleted.original.descriptor.kind,
			deleteModified: deleted.modified,
		}, {
			renameOriginalPath: '/workspace/repo/old.xlsx',
			renameModifiedPath: '/workspace/repo/renamed.xlsx',
			deleteOriginalKind: 'gitIndex',
			deleteModified: {
				descriptor: { kind: 'sideMissing', displayName: 'renamed.xlsx', side: 'modified' },
				byteLength: 0,
				contentHash: emptySha256,
			},
		});
		source.dispose();
		repository.dispose();
	});

	test('keeps an existing commit descriptor immutable after HEAD advances', async () => {
		const repository = new TestRepository(repositorySnapshot({ indexChanges: [{ status: 'modified', path: 'book.xlsx' }], workingTreeChanges: [] }));
		const bytes = new TestBytes({
			[`git:/workspace/repo/book.xlsx:${headCommitA}`]: [104, 101, 97, 100],
			[`git:/workspace/repo/book.xlsx:${headCommitB}`]: [104, 101, 97, 100],
			'git:/workspace/repo/book.xlsx:': [118, 49],
		});
		const source = new ParadisOfficeGitSource(repository, bytes);
		const first = await source.createComparison('headToIndex', 'book.xlsx', CancellationToken.None);
		repository.snapshot = repositorySnapshot({ headCommit: headCommitB, indexChanges: [{ status: 'modified', path: 'book.xlsx' }], workingTreeChanges: [] });
		repository.fireChange();
		const second = await source.createComparison('headToIndex', 'book.xlsx', CancellationToken.None);

		assert.deepStrictEqual({ first: refOf(first.original.descriptor.uri!), retained: refOf(first.original.descriptor.uri!), second: refOf(second.original.descriptor.uri!) }, {
			first: headCommitA,
			retained: headCommitA,
			second: headCommitB,
		});
		source.dispose();
		repository.dispose();
	});

	test('reports LFS pointer oid changes as opaque without fetch and preserves working bytes', async () => {
		const oldPointer = 'version https://git-lfs.github.com/spec/v1\noid sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa\nsize 42\n';
		const newPointer = 'version https://git-lfs.github.com/spec/v1\noid sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb\nsize 43\n';
		const repository = new TestRepository(repositorySnapshot());
		const bytes = new TestBytes({
			[`git:/workspace/repo/book.xlsx:${headCommitA}`]: [...VSBuffer.fromString(oldPointer).buffer],
			'git:/workspace/repo/book.xlsx:': [...VSBuffer.fromString(newPointer).buffer],
			'file:/workspace/repo/book.xlsx:working': [80, 75, 3, 4, 47, 0, 0, 0],
		});
		const source = new ParadisOfficeGitSource(repository, bytes);

		const staged = await source.createComparison('headToIndex', 'book.xlsx', CancellationToken.None);
		const unstaged = await source.createComparison('indexToWorking', 'book.xlsx', CancellationToken.None);

		assert.deepStrictEqual({
			oldLfs: staged.original.lfs,
			newLfs: staged.modified.lfs,
			outcome: staged.outcome,
			workingLfs: unstaged.modified.lfs,
			workingBytes: unstaged.modified.byteLength,
			fetches: bytes.fetches,
		}, {
			oldLfs: { oid: 'a'.repeat(64), size: 42 },
			newLfs: { oid: 'b'.repeat(64), size: 43 },
			outcome: 'degraded',
			workingLfs: undefined,
			workingBytes: 8,
			fetches: 0,
		});
		source.dispose();
		repository.dispose();
	});

	test('rejects a descriptor when raw content changed before a spool attempt', async () => {
		const repository = new TestRepository(repositorySnapshot());
		const bytes = new TestBytes({
			[`git:/workspace/repo/book.xlsx:${headCommitA}`]: [104, 101, 97, 100],
			'git:/workspace/repo/book.xlsx:': [118, 49],
		});
		const source = new ParadisOfficeGitSource(repository, bytes);
		const comparison = await source.createComparison('headToIndex', 'book.xlsx', CancellationToken.None);
		bytes.set('git:/workspace/repo/book.xlsx:', [118, 50]);
		let begins = 0;
		const broker = new ParadisOfficeSourceBroker({
			ownerId: 'window:git',
			platform: 'desktopLocal',
			provider: source,
			spoolClient: {
				begin: async () => { begins++; throw new Error('must not begin'); },
				claim: async () => { },
				append: async () => { },
				seal: async () => { throw new Error('must not seal'); },
				dispose: async () => { },
				disposeAttempt: async () => { },
			},
			createHash: () => { throw new Error('must not hash after stale snapshot'); },
			isRemoteProtocolV1: () => false,
		});

		await assert.rejects(broker.open(comparison.modified.descriptor, CancellationToken.None), error => error instanceof ParadisOfficeSourceBrokerError && error.code === 'stale');
		assert.strictEqual(begins, 0);
		source.dispose();
		repository.dispose();
	});

	test('snapshots repository status and VSBuffer as bounded own data without invoking accessors', async () => {
		let getterCalls = 0;
		const repository = new TestRepository(repositorySnapshot());
		Object.defineProperty(repository, 'snapshot', { configurable: true, get: () => { getterCalls++; throw new Error('/private/repository'); } });
		const source = new ParadisOfficeGitSource(repository, new TestBytes({}));
		await assert.rejects(source.createComparison('headToIndex', 'book.xlsx', CancellationToken.None), error => error instanceof Error && error.message === 'The Git Office source could not be resolved.' && error.stack === '');
		assert.strictEqual(getterCalls, 0);
		source.dispose();
		repository.dispose();

		const oversizedRepository = new TestRepository(repositorySnapshot({ indexChanges: Array.from({ length: 10_001 }, () => ({ status: 'modified', path: 'book.xlsx' })) }));
		const oversizedSource = new ParadisOfficeGitSource(oversizedRepository, new TestBytes({}));
		await assert.rejects(oversizedSource.createComparison('headToIndex', 'book.xlsx', CancellationToken.None), ParadisOfficeGitSourceError);
		oversizedSource.dispose();
		oversizedRepository.dispose();

		const safeRepository = new TestRepository(repositorySnapshot());
		const forgedBytes = new TestBytes({});
		forgedBytes.readFile = async () => new Proxy(VSBuffer.fromString('secret'), { getPrototypeOf: () => { throw new Error('/private/proxy'); } });
		const forgedSource = new ParadisOfficeGitSource(safeRepository, forgedBytes);
		await assert.rejects(forgedSource.createComparison('headToIndex', 'book.xlsx', CancellationToken.None), error => error instanceof Error && error.message === 'The Git Office source could not be resolved.' && error.stack === '');
		forgedSource.dispose();
		safeRepository.dispose();
	});

	test('uses the remote v1 channel and transfers only a descriptor wire envelope', async () => {
		const authority = { ownerCapability: 'd'.repeat(64), connectionEpoch: 7 };
		const remote = new RecordingRemoteChannel((command, arg) => {
			if (command === 'negotiate') {
				return { version: 1, channel: PARADIS_OFFICE_CHANNEL, capabilities: ['inspect', 'open', 'getViewport', 'compare', 'search', 'getRenderableAsset', 'getPrintModel', 'exportPrint', 'close', 'cancel'], ...authority } satisfies ParadisOfficeV1Negotiation;
			}
			const decoded = decodeParadisOfficeWireValue(arg);
			const request = decoded.value as ParadisOfficeRequest;
			assert.deepStrictEqual(decoded.authority, authority);
			assert.deepStrictEqual(request, remoteInspectRequest('remote-v1'));
			assert.strictEqual(JSON.stringify(decoded.value).includes('base64'), false);
			assert.strictEqual(JSON.stringify(decoded.value).includes('UEsD'), false);
			return marshalParadisOfficeResponse(remoteFailedResponse(request.requestId));
		});
		const local = new RecordingRemoteChannel(() => { throw new Error('local channel must not be used'); });
		const broker = new RemoteBroker({ kind: 'direct', backend: 'remote', protocolVersion: 1, descriptor: remoteDescriptor });
		const warnings: string[] = [];
		const client = new ParadisOfficeRemoteClient({
			remoteAgentService: { getConnection: () => ({ remoteAuthority: 'ssh-remote+host', getChannel: (name: string) => { assert.strictEqual(name, PARADIS_OFFICE_CHANNEL); return remote; } }) },
			localChannel: local, sourceBroker: broker, spoolClient: new RemoteSpoolClient(), onWarning: warning => warnings.push(warning),
		});

		const result = await client.request(remoteInspectRequest('remote-v1'), CancellationToken.None);

		assert.deepStrictEqual({ route: result.route, quality: result.quality, warnings: result.warnings, remoteCommands: remote.calls.map(call => call.command), brokerCalls: broker.opened.length }, {
			route: 'remoteV1', quality: 'complete', warnings: [], remoteCommands: ['negotiate', 'request'], brokerCalls: 0,
		});
		assert.deepStrictEqual(warnings, []);
		client.dispose();
	});

	test('falls back to a bounded local spool with a warning on an old remote server', async () => {
		const remote = new RecordingRemoteChannel(() => { throw new Error('/private/server/channel missing secret-token'); });
		const local = new RecordingRemoteChannel((command, arg) => {
			if (command === 'negotiate') {
				return localNegotiation();
			}
			assert.deepStrictEqual(decodeParadisOfficeWireValue(arg).authority, localAuthority);
			if (command === 'source/bind') {
				assert.deepStrictEqual(decodeParadisOfficeWireValue(arg).value, { descriptor: remoteDescriptor, spool: remoteSpool });
				return undefined;
			}
			if (command === 'source/unbind') { return undefined; }
			const request = decodeParadisOfficeWireValue(arg).value as ParadisOfficeRequest;
			return marshalParadisOfficeResponse(remoteFailedResponse(request.requestId));
		});
		const broker = new RemoteBroker({ kind: 'spool', descriptor: remoteDescriptor, spool: remoteSpool });
		const spoolClient = new RemoteSpoolClient();
		const warnings: string[] = [];
		const client = new ParadisOfficeRemoteClient({
			remoteAgentService: { getConnection: () => ({ remoteAuthority: 'ssh-remote+host', getChannel: () => remote }) },
			localChannel: local, sourceBroker: broker, spoolClient, onWarning: warning => warnings.push(warning),
		});

		const result = await client.request(remoteInspectRequest('remote-v0'), CancellationToken.None);

		assert.deepStrictEqual({ route: result.route, quality: result.quality, warnings: result.warnings, localCommands: local.calls.map(call => call.command), brokerCalls: broker.opened.length }, {
			route: 'boundedLocalSpool', quality: 'degraded', warnings: ['office.capability.remoteBackendV0'], localCommands: ['negotiate', 'source/bind', 'request', 'source/unbind'], brokerCalls: 1,
		});
		assert.deepStrictEqual(warnings, ['office.capability.remoteBackendV0']);
		assert.deepStrictEqual(spoolClient.disposed, [remoteSpool]);
		client.dispose();
	});

	test('re-evaluates the platform capability for every new source request', async () => {
		const authority = { ownerCapability: 'd'.repeat(64), connectionEpoch: 7 };
		const remote = new RecordingRemoteChannel((command, arg) => {
			if (command === 'negotiate') { return { version: 1, channel: PARADIS_OFFICE_CHANNEL, capabilities: ['inspect', 'open', 'getViewport', 'compare', 'search', 'getRenderableAsset', 'getPrintModel', 'exportPrint', 'close', 'cancel'], ...authority }; }
			const request = decodeParadisOfficeWireValue(arg).value as ParadisOfficeRequest;
			return marshalParadisOfficeResponse(remoteFailedResponse(request.requestId));
		});
		const local = new RecordingRemoteChannel((command, arg) => {
			if (command === 'negotiate') { return localNegotiation(); }
			if (command === 'source/bind' || command === 'source/unbind') { return undefined; }
			const request = decodeParadisOfficeWireValue(arg).value as ParadisOfficeRequest;
			return marshalParadisOfficeResponse(remoteFailedResponse(request.requestId));
		});
		let enabled = true;
		const client = new ParadisOfficeRemoteClient({
			remoteAgentService: { getConnection: () => ({ remoteAuthority: 'ssh-remote+host', getChannel: () => remote }) }, localChannel: local,
			sourceBroker: new RemoteBroker({ kind: 'spool', descriptor: remoteDescriptor, spool: remoteSpool }), spoolClient: new RemoteSpoolClient(), onWarning: () => { }, isPlatformBackendEnabled: () => enabled,
		});
		assert.strictEqual((await client.request(remoteInspectRequest('enabled'), CancellationToken.None)).route, 'remoteV1');
		enabled = false;
		assert.strictEqual((await client.request(remoteInspectRequest('disabled'), CancellationToken.None)).route, 'boundedLocalSpool');
		assert.deepStrictEqual(remote.calls.map(call => call.command), ['negotiate', 'request']);
		client.dispose();
	});

	test('keeps an existing remote handle on its negotiated route after the capability flips', async () => {
		const authority = { ownerCapability: 'd'.repeat(64), connectionEpoch: 7 };
		const handle = { kind: 'document' as const, id: 'a'.repeat(48) };
		const remote = new RecordingRemoteChannel((command, arg) => {
			if (command === 'negotiate') { return { version: 1, channel: PARADIS_OFFICE_CHANNEL, capabilities: ['inspect', 'open', 'getViewport', 'compare', 'search', 'getRenderableAsset', 'getPrintModel', 'exportPrint', 'close', 'cancel'], ...authority }; }
			const request = decodeParadisOfficeWireValue(arg).value as ParadisOfficeRequest;
			if (request.operation === 'open') {
				return marshalParadisOfficeResponse({ version: 1, requestId: request.requestId, operation: 'open', ok: true, outcome: 'complete', warnings: [], budgetUsage: {}, timings: {}, revision: { kind: 'document', sourceRevision: 'raw-revision' }, completeness: { expectedParts: 0, visitedParts: 0, parsedParts: 0, opaqueParts: 0, failedParts: 0, omittedParts: 0, expectedSemanticUnits: 0, visitedSemanticUnits: 0, terminal: true }, handle, capabilities: [] });
			}
			return marshalParadisOfficeResponse({ ...remoteFailedResponse(request.requestId), operation: request.operation });
		});
		let enabled = true;
		const connection = { remoteAuthority: 'ssh-remote+host', getChannel: () => remote };
		const client = new ParadisOfficeRemoteClient({ remoteAgentService: { getConnection: () => connection }, localChannel: new RecordingRemoteChannel(() => { throw new Error('must stay remote'); }), sourceBroker: new RemoteBroker({ kind: 'direct', backend: 'remote', protocolVersion: 1, descriptor: remoteDescriptor }), spoolClient: new RemoteSpoolClient(), onWarning: () => { }, isPlatformBackendEnabled: () => enabled });
		await client.request({ version: 1, requestId: 'open-existing', operation: 'open', source: remoteDescriptor }, CancellationToken.None);
		enabled = false;
		const existing = await client.request({ version: 1, requestId: 'viewport-existing', operation: 'getViewport', handle, locator: 'page:1', range: [0, 0, 1, 1] }, CancellationToken.None);
		assert.strictEqual(existing.route, 'remoteV1');
		assert.deepStrictEqual(remote.calls.map(call => call.command), ['negotiate', 'request', 'request']);
		client.dispose();
	});

	test('keeps sideMissing order and unbinds an unused comparison spool before the next bind', async () => {
		const remote = new RecordingRemoteChannel(() => { throw new Error('old server'); });
		const bound = new Set<string>();
		const local = new RecordingRemoteChannel((command, arg) => {
			if (command === 'negotiate') { return localNegotiation(); }
			const value = decodeParadisOfficeWireValue(arg).value as { readonly descriptor: ParadisOfficeSourceDescriptor };
			if (command === 'source/bind') {
				const key = JSON.stringify(value.descriptor);
				assert.strictEqual(bound.has(key), false);
				bound.add(key);
				return undefined;
			}
			if (command === 'source/unbind') { bound.delete(JSON.stringify(value.descriptor)); return undefined; }
			const request = value as unknown as ParadisOfficeRequest;
			assert.strictEqual(request.operation, 'compare');
			assert.strictEqual(request.original.kind, 'sideMissing');
			assert.strictEqual(request.modified.kind, 'remote');
			return marshalParadisOfficeResponse({ ...remoteFailedResponse(request.requestId), operation: 'compare' });
		});
		const missing: ParadisOfficeSourceDescriptor = { kind: 'sideMissing', displayName: 'deleted.xlsx', side: 'original' };
		const broker: IOfficeSourceBroker = {
			open: source => Promise.resolve(source.kind === 'sideMissing' ? { kind: 'sideMissing', descriptor: source } : { kind: 'spool', descriptor: source, spool: remoteSpool }),
		};
		const client = new ParadisOfficeRemoteClient({ remoteAgentService: { getConnection: () => ({ remoteAuthority: 'ssh-remote+host', getChannel: () => remote }) }, localChannel: local, sourceBroker: broker, spoolClient: new RemoteSpoolClient(), onWarning: () => { } });
		for (const requestId of ['compare-1', 'compare-2']) {
			await client.request({ version: 1, requestId, operation: 'compare', original: missing, modified: remoteDescriptor }, CancellationToken.None);
		}
		assert.deepStrictEqual(local.calls.map(call => call.command), ['negotiate', 'source/bind', 'request', 'source/unbind', 'negotiate', 'source/bind', 'request', 'source/unbind']);
		assert.strictEqual(bound.size, 0);
		client.dispose();
	});

	test('cleans an owner-bound fallback spool when request publication is cancelled', async () => {
		const remote = new RecordingRemoteChannel(() => { throw new Error('old server'); });
		const requestStarted = new Emitter<void>();
		const local = new RecordingRemoteChannel(command => {
			if (command === 'negotiate') {
				return localNegotiation();
			}
			if (command === 'source/bind') {
				return undefined;
			}
			if (command === 'source/unbind') { return undefined; }
			requestStarted.fire();
			return new Promise(() => { });
		});
		const spoolClient = new RemoteSpoolClient();
		const client = new ParadisOfficeRemoteClient({
			remoteAgentService: { getConnection: () => ({ remoteAuthority: 'ssh-remote+host', getChannel: () => remote }) },
			localChannel: local, sourceBroker: new RemoteBroker({ kind: 'spool', descriptor: remoteDescriptor, spool: remoteSpool }), spoolClient, onWarning: () => { },
		});
		const cancellation = new CancellationTokenSource();
		const started = Event.toPromise(requestStarted.event);
		const pending = client.request(remoteInspectRequest('cancelled'), cancellation.token);
		await started;
		cancellation.cancel();

		await assert.rejects(pending, ParadisOfficeRemoteClientError);
		assert.deepStrictEqual(spoolClient.disposed, [remoteSpool]);
		client.dispose();
		cancellation.dispose();
		requestStarted.dispose();
	});

	test('binds the local negotiation authority to every fallback spool and request command', async () => {
		const remote = new RecordingRemoteChannel(() => { throw new Error('old remote'); });
		const commands: string[] = [];
		const appended: VSBuffer[] = [];
		const local = new RecordingRemoteChannel((command, arg) => {
			commands.push(command);
			if (command === 'negotiate') { return localNegotiation(); }
			const decoded = decodeParadisOfficeWireValue(arg);
			assert.deepStrictEqual(decoded.authority, localAuthority);
			if (command === 'spool/begin') {
				const attemptId = (decoded.value as { readonly attemptId: string }).attemptId;
				return { id: 'a'.repeat(48), ownerId: localAuthority.ownerCapability, nonce: 'b'.repeat(64), attemptId };
			}
			if (command === 'spool/append') {
				appended.push((decoded.value as { readonly bytes: VSBuffer }).bytes.clone());
				return undefined;
			}
			if (command === 'spool/seal') {
				const value = decoded.value as { readonly reference: ParadisOfficeWritableSpoolReference; readonly request: ParadisOfficeSealRequest };
				return { ...value.reference, ...value.request };
			}
			if (command === 'request') {
				const request = decoded.value as ParadisOfficeRequest;
				return marshalParadisOfficeResponse(remoteFailedResponse(request.requestId));
			}
			return undefined;
		});
		const spoolClient = new ParadisOfficeChannelSpoolClient(local);
		const hash: IOfficeSourceHash = { update: () => { }, digest: () => 'bef57ec7f53a6d40beb640a780a639c83bc29ac8a9816f1fc6c5c6dcd93c4721' };
		const broker = new ParadisOfficeSourceBroker({
			ownerId: 'window:pre-negotiation', platform: 'desktopLocal', spoolClient,
			provider: { snapshot: async () => ({ identity: 'remote:file', revision: 'etag:1' }), async *read() { yield VSBuffer.fromString('abcdef'); } },
			createHash: () => hash, isRemoteProtocolV1: () => false,
		});
		const client = new ParadisOfficeRemoteClient({ remoteAgentService: { getConnection: () => ({ remoteAuthority: 'old', getChannel: () => remote }) }, localChannel: local, sourceBroker: broker, spoolClient, onWarning: () => { } });

		const result = await client.request(remoteInspectRequest('authority-fallback'), CancellationToken.None);

		assert.strictEqual(result.route, 'boundedLocalSpool');
		assert.deepStrictEqual(commands, ['negotiate', 'spool/begin', 'spool/claim', 'spool/append', 'spool/seal', 'source/bind', 'request', 'source/unbind', 'spool/dispose']);
		assert.strictEqual(VSBuffer.concat(appended).toString(), 'abcdef');
		client.dispose();
	});

	test('fences cancellation before and after fallback bind and unbinds a late bind', async () => {
		for (const cancellationPoint of ['beforeBindResponse', 'afterBindResponse'] as const) {
			const remote = new RecordingRemoteChannel(() => { throw new Error('old remote'); });
			let resolveBind!: () => void;
			const bindStarted = new Emitter<void>();
			const requestStarted = new Emitter<void>();
			const local = new RecordingRemoteChannel((command, arg) => {
				if (command === 'negotiate') { return localNegotiation(); }
				assert.deepStrictEqual(decodeParadisOfficeWireValue(arg).authority, localAuthority);
				if (command === 'source/bind') { bindStarted.fire(); return new Promise<void>(resolve => resolveBind = resolve); }
				if (command === 'request') { requestStarted.fire(); return new Promise(() => { }); }
				return undefined;
			});
			const cancellation = new CancellationTokenSource();
			const client = new ParadisOfficeRemoteClient({ remoteAgentService: { getConnection: () => ({ remoteAuthority: 'old', getChannel: () => remote }) }, localChannel: local, sourceBroker: new RemoteBroker({ kind: 'spool', descriptor: remoteDescriptor, spool: { ...remoteSpool, ownerId: localAuthority.ownerCapability } }), spoolClient: new RemoteSpoolClient(), onWarning: () => { } });
			const pending = client.request(remoteInspectRequest(`bind-${cancellationPoint}`), cancellation.token);
			await Event.toPromise(bindStarted.event);
			if (cancellationPoint === 'beforeBindResponse') {
				cancellation.cancel();
				await assert.rejects(pending, ParadisOfficeRemoteClientError);
				resolveBind();
				await new Promise(resolve => setTimeout(resolve, 0));
				assert.strictEqual(local.calls.filter(call => call.command === 'source/unbind').length, 2);
			} else {
				resolveBind();
				await Event.toPromise(requestStarted.event);
				cancellation.cancel();
				await assert.rejects(pending, ParadisOfficeRemoteClientError);
				assert.strictEqual(local.calls.filter(call => call.command === 'source/unbind').length, 1);
			}
			client.dispose(); cancellation.dispose(); bindStarted.dispose(); requestStarted.dispose();
		}
	});

	test('does not publish a fallback bind after cancellation is observed at the post-broker fence', async () => {
		const cancellation = new CancellationTokenSource();
		const remote = new RecordingRemoteChannel(() => { throw new Error('old remote'); });
		const local = new RecordingRemoteChannel((command, arg) => {
			if (command === 'negotiate') { return localNegotiation(); }
			assert.deepStrictEqual(decodeParadisOfficeWireValue(arg).authority, localAuthority);
			return undefined;
		});
		const spoolClient = new RemoteSpoolClient();
		const broker: IOfficeSourceBroker = {
			open: async () => {
				cancellation.cancel();
				return { kind: 'spool', descriptor: remoteDescriptor, spool: { ...remoteSpool, ownerId: localAuthority.ownerCapability } };
			},
		};
		const client = new ParadisOfficeRemoteClient({ remoteAgentService: { getConnection: () => ({ remoteAuthority: 'old', getChannel: () => remote }) }, localChannel: local, sourceBroker: broker, spoolClient, onWarning: () => { } });

		await assert.rejects(client.request(remoteInspectRequest('post-broker-cancel'), cancellation.token), ParadisOfficeRemoteClientError);

		assert.strictEqual(local.calls.some(call => call.command === 'source/bind'), false);
		assert.deepStrictEqual(spoolClient.disposed, [{ ...remoteSpool, ownerId: localAuthority.ownerCapability }]);
		client.dispose(); cancellation.dispose();
	});
});
