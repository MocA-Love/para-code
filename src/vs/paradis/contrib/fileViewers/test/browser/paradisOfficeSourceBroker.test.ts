/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import { deepStrictEqual, ok, rejects, strictEqual } from 'assert';
import { VSBuffer } from '../../../../../base/common/buffer.js';
import { CancellationToken, CancellationTokenSource } from '../../../../../base/common/cancellation.js';
import { CancellationError } from '../../../../../base/common/errors.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { ParadisOfficeSourceBroker } from '../../browser/paradisOfficeSourceBroker.js';
import {
	buildParadisOfficeSourceRevision,
	IOfficeSourceHash,
	IOfficeSourceProvider,
	IOfficeSpoolClient,
	PARADIS_OFFICE_SPOOL_CHUNK_BYTES,
	ParadisOfficeProviderSnapshot,
	ParadisOfficeSealRequest,
	ParadisOfficeSourceDescriptor,
	ParadisOfficeSpoolReference,
	ParadisOfficeWritableSpoolReference,
} from '../../common/paradisOfficeSourceBroker.js';

const ownerId = 'window-1';

class TestHash implements IOfficeSourceHash {
	private readonly chunks: string[] = [];

	update(bytes: VSBuffer): void {
		this.chunks.push(bytes.toString());
	}

	digest(): string {
		if (this.chunks.join('') !== 'abcdef') {
			return '0'.repeat(64);
		}
		return 'bef57ec7f53a6d40beb640a780a639c83bc29ac8a9816f1fc6c5c6dcd93c4721';
	}
}

class TestSpoolClient implements IOfficeSpoolClient {
	readonly appended: VSBuffer[] = [];
	readonly disposed: ParadisOfficeSpoolReference[] = [];
	readonly sealed: ParadisOfficeSealRequest[] = [];
	beginCalls = 0;
	failAppend = false;
	failSeal = false;
	sealResultOverride: unknown;
	private readonly writable: ParadisOfficeWritableSpoolReference = { id: 'a'.repeat(48), ownerId, nonce: 'b'.repeat(64) };

	async begin(requestOwnerId: string): Promise<ParadisOfficeWritableSpoolReference> {
		strictEqual(requestOwnerId, ownerId);
		this.beginCalls++;
		return { ...this.writable };
	}

	async append(reference: ParadisOfficeWritableSpoolReference, bytes: VSBuffer): Promise<void> {
		deepStrictEqual(reference, this.writable);
		if (this.failAppend) {
			throw new Error('append failed');
		}
		this.appended.push(bytes.clone());
	}

	async seal(reference: ParadisOfficeWritableSpoolReference, request: ParadisOfficeSealRequest) {
		deepStrictEqual(reference, this.writable);
		if (this.failSeal) {
			throw new Error('seal failed');
		}
		this.sealed.push(request);
		if (this.sealResultOverride !== undefined) {
			return this.sealResultOverride as ReturnType<IOfficeSpoolClient['seal']> extends Promise<infer T> ? T : never;
		}
		return { ...this.writable, ...request };
	}

	async dispose(reference: ParadisOfficeSpoolReference): Promise<void> {
		this.disposed.push({ ...reference });
	}
}

function descriptor(kind: ParadisOfficeSourceDescriptor['kind'], uri?: string): ParadisOfficeSourceDescriptor {
	return { kind, ...(uri ? { uri } : {}), displayName: 'document.docx', revisionHint: 'hint', side: 'modified' };
}

function sourceProvider(
	bytes: readonly VSBuffer[],
	snapshots: readonly ParadisOfficeProviderSnapshot[] = [
		{ identity: 'provider:git', revision: 'etag:1' },
		{ identity: 'provider:git', revision: 'etag:1' },
	],
	onRead?: (index: number) => void,
): IOfficeSourceProvider {
	let snapshotIndex = 0;
	return {
		async snapshot() {
			return snapshots[Math.min(snapshotIndex++, snapshots.length - 1)];
		},
		async *read(_source, _token) {
			for (let index = 0; index < bytes.length; index++) {
				onRead?.(index);
				yield bytes[index];
			}
		},
	};
}

function createBroker(provider: IOfficeSourceProvider, spoolClient = new TestSpoolClient(), remoteV1 = false) {
	return {
		broker: new ParadisOfficeSourceBroker({
			ownerId,
			platform: 'desktopLocal',
			provider,
			spoolClient,
			createHash: () => new TestHash(),
			isRemoteProtocolV1: () => remoteV1,
		}),
		spoolClient,
	};
}

async function rejectsSafeBrokerError(operation: () => Promise<unknown>, code: string): Promise<void> {
	await rejects(operation, (error: unknown) => {
		if (!(error instanceof Error)) {
			return false;
		}
		const serialized = JSON.stringify(error);
		return error.name === 'ParadisOfficeSourceBrokerError'
			&& (error as Error & { code?: string }).code === code
			&& !error.message.includes('/raw/private')
			&& !error.message.includes('secret-token')
			&& !(error.stack ?? '').includes('/Users/magu/')
			&& !(error.stack ?? '').includes('/raw/private')
			&& !(error.stack ?? '').includes('secret-token')
			&& !serialized.includes('/raw/private')
			&& !serialized.includes('secret-token')
			&& !serialized.includes('stack');
	});
}

suite('ParadisOfficeSourceBroker', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	test('routes local files, v1 remote files, and working trees to their byte owner', async () => {
		const local = createBroker(sourceProvider([]));
		const remote = createBroker(sourceProvider([]), new TestSpoolClient(), true);

		deepStrictEqual(await local.broker.open(descriptor('file', 'file:///tmp/document.docx'), CancellationToken.None), {
			kind: 'direct', backend: 'local', protocolVersion: 1, descriptor: descriptor('file', 'file:///tmp/document.docx'),
		});
		deepStrictEqual(await remote.broker.open(descriptor('remote', 'vscode-remote://ssh/file.docx'), CancellationToken.None), {
			kind: 'direct', backend: 'remote', protocolVersion: 1, descriptor: descriptor('remote', 'vscode-remote://ssh/file.docx'),
		});
		deepStrictEqual(await local.broker.open(descriptor('workingTree', 'file:///tmp/document.docx'), CancellationToken.None), {
			kind: 'direct', backend: 'local', protocolVersion: 1, descriptor: descriptor('workingTree', 'file:///tmp/document.docx'),
		});
		deepStrictEqual(await remote.broker.open(descriptor('workingTree', 'vscode-remote://ssh/file.docx'), CancellationToken.None), {
			kind: 'direct', backend: 'remote', protocolVersion: 1, descriptor: descriptor('workingTree', 'vscode-remote://ssh/file.docx'),
		});
		strictEqual(local.spoolClient.beginCalls, 0);
		strictEqual(remote.spoolClient.beginCalls, 0);
	});

	test('returns sideMissing as a normal byte-free backend source', async () => {
		const { broker, spoolClient } = createBroker(sourceProvider([]));
		const source = await broker.open(descriptor('sideMissing'), CancellationToken.None);

		deepStrictEqual(source, { kind: 'sideMissing', descriptor: descriptor('sideMissing') });
		strictEqual(spoolClient.beginCalls, 0);
	});

	test('spools git/index/untitled and old remote sources only from provider-bounded chunks', async () => {
		for (const sourceKind of ['gitCommit', 'gitIndex', 'untitled', 'remote'] as const) {
			const bytes = [VSBuffer.alloc(PARADIS_OFFICE_SPOOL_CHUNK_BYTES), VSBuffer.alloc(PARADIS_OFFICE_SPOOL_CHUNK_BYTES), VSBuffer.alloc(1)];
			for (const chunk of bytes) {
				chunk.buffer.fill(0x61);
			}
			const { broker, spoolClient } = createBroker(sourceProvider(bytes));

			const uri = sourceKind === 'remote' ? 'vscode-remote://old/file.docx' : sourceKind === 'untitled' ? 'untitled:document' : `git:/${sourceKind}`;
			const source = await broker.open(descriptor(sourceKind, uri), CancellationToken.None);

			strictEqual(source.kind, 'spool');
			deepStrictEqual(spoolClient.appended.map(chunk => chunk.byteLength), [PARADIS_OFFICE_SPOOL_CHUNK_BYTES, PARADIS_OFFICE_SPOOL_CHUNK_BYTES, 1]);
		}
	});

	test('splits bounded oversized provider yields into fresh 2 MiB spool chunks', async () => {
		for (const size of [PARADIS_OFFICE_SPOOL_CHUNK_BYTES + 1, 32 * 1024 * 1024]) {
			const spoolClient = new TestSpoolClient();
			const { broker } = createBroker(sourceProvider([VSBuffer.alloc(size)]), spoolClient);

			const source = await broker.open(descriptor('gitCommit', 'git:/doc'), CancellationToken.None);
			strictEqual(source.kind, 'spool');
			strictEqual(spoolClient.appended.reduce((total, chunk) => total + chunk.byteLength, 0), size);
			ok(spoolClient.appended.every(chunk => chunk.byteLength <= PARADIS_OFFICE_SPOOL_CHUNK_BYTES));
		}
	});

	test('seals with an incremental SHA-256 and an ambiguity-free provider revision', async () => {
		const first = VSBuffer.fromString('abc');
		const second = VSBuffer.fromString('def');
		const { broker, spoolClient } = createBroker(sourceProvider([first, second]));

		const source = await broker.open(descriptor('gitCommit', 'git:/document.docx'), CancellationToken.None);
		ok(source.kind === 'spool');
		const expectedHash = 'bef57ec7f53a6d40beb640a780a639c83bc29ac8a9816f1fc6c5c6dcd93c4721';
		const expectedRevision = 'office-source/v1|9:gitCommit|12:provider:git|6:etag:1|1:6|64:' + expectedHash;
		strictEqual(source.spool.sha256, expectedHash);
		strictEqual(source.spool.size, 6);
		strictEqual(source.spool.revision, expectedRevision);
		strictEqual(buildParadisOfficeSourceRevision('gitCommit', 'provider:git', 'etag:1', 6, expectedHash), expectedRevision);
		deepStrictEqual(spoolClient.sealed, [{ sourceKind: 'gitCommit', providerIdentity: 'provider:git', providerRevision: 'etag:1', size: 6, sha256: expectedHash, revision: expectedRevision }]);
	});

	test('discards a spool as stale when provider identity or revision changes during the read', async () => {
		for (const after of [{ identity: 'provider:git', revision: 'etag:2' }, { identity: 'provider:other', revision: 'etag:1' }]) {
			const spoolClient = new TestSpoolClient();
			const { broker } = createBroker(sourceProvider(
				[VSBuffer.fromString('bytes')],
				[{ identity: 'provider:git', revision: 'etag:1' }, after],
			), spoolClient);

			await rejects(() => broker.open(descriptor('gitCommit', 'git:/document.docx'), CancellationToken.None), (error: unknown) => {
				return error instanceof Error && error.name === 'ParadisOfficeSourceBrokerError' && (error as Error & { code?: string }).code === 'stale';
			});
			strictEqual(spoolClient.sealed.length, 0);
			strictEqual(spoolClient.disposed.length, 1);
		}
	});

	test('cleans up immediately on cancellation, read failure, append failure, and seal failure', async () => {
		const cancellation = new CancellationTokenSource();
		const cancelledClient = new TestSpoolClient();
		const cancelled = createBroker(sourceProvider([VSBuffer.fromString('a'), VSBuffer.fromString('b')], undefined, index => {
			if (index === 1) {
				cancellation.cancel();
			}
		}), cancelledClient);
		await rejects(() => cancelled.broker.open(descriptor('untitled', 'untitled:doc'), cancellation.token));
		strictEqual(cancelledClient.disposed.length, 1);
		cancellation.dispose();

		const failingProvider: IOfficeSourceProvider = {
			async snapshot() { return { identity: 'provider:git', revision: 'etag:1' }; },
			async *read() { yield VSBuffer.fromString('a'); throw new Error('read failed'); },
		};
		const readClient = new TestSpoolClient();
		await rejects(() => createBroker(failingProvider, readClient).broker.open(descriptor('gitIndex', 'git:/doc'), CancellationToken.None));
		strictEqual(readClient.disposed.length, 1);

		for (const failure of ['append', 'seal'] as const) {
			const client = new TestSpoolClient();
			client[failure === 'append' ? 'failAppend' : 'failSeal'] = true;
			await rejects(() => createBroker(sourceProvider([VSBuffer.fromString('a')]), client).broker.open(descriptor('gitIndex', 'git:/doc'), CancellationToken.None));
			strictEqual(client.disposed.length, 1);
		}
	});

	test('starts cleanup when cancelled even while the provider read is blocked', async () => {
		let releaseRead!: () => void;
		const blocked = new Promise<void>(resolve => releaseRead = resolve);
		let readStarted = false;
		const provider: IOfficeSourceProvider = {
			async snapshot() { return { identity: 'provider:git', revision: 'etag:1' }; },
			async *read() {
				readStarted = true;
				await blocked;
				yield VSBuffer.fromString('late');
			},
		};
		const cancellation = new CancellationTokenSource();
		const spoolClient = new TestSpoolClient();
		const pending = createBroker(provider, spoolClient).broker.open(descriptor('gitCommit', 'git:/doc'), cancellation.token);
		while (!readStarted) {
			await Promise.resolve();
		}
		cancellation.cancel();
		await Promise.resolve();
		strictEqual(spoolClient.disposed.length, 1);
		releaseRead();
		await rejects(() => pending);
		cancellation.dispose();
	});

	test('validates untrusted descriptors without invoking getters or retaining caller objects', async () => {
		let getterCalls = 0;
		const unsafe = Object.create(null);
		Object.defineProperty(unsafe, 'kind', { enumerable: true, get: () => { getterCalls++; throw new Error('secret'); } });
		const { broker } = createBroker(sourceProvider([]));
		await rejects(() => broker.open(unsafe as ParadisOfficeSourceDescriptor, CancellationToken.None), TypeError);
		strictEqual(getterCalls, 0);

		const input = descriptor('file', 'file:///tmp/document.docx') as { displayName: string } & ParadisOfficeSourceDescriptor;
		const output = await broker.open(input, CancellationToken.None);
		input.displayName = 'mutated';
		strictEqual(output.descriptor.displayName, 'document.docx');
		strictEqual(Object.prototype.hasOwnProperty.call(output, 'path'), false);
		strictEqual(Object.prototype.hasOwnProperty.call(output, 'stream'), false);
	});

	test('snapshots descriptor data properties once to prevent validation/use races', async () => {
		const input = descriptor('file', 'file:///tmp/document.docx');
		let kindReads = 0;
		const unstable = new Proxy(input, {
			getOwnPropertyDescriptor(target, property) {
				const propertyDescriptor = Reflect.getOwnPropertyDescriptor(target, property);
				if (property === 'kind' && propertyDescriptor && ++kindReads > 1) {
					return { ...propertyDescriptor, value: 'sideMissing' };
				}
				return propertyDescriptor;
			},
		});
		const { broker } = createBroker(sourceProvider([]));

		const output = await broker.open(unstable, CancellationToken.None);
		strictEqual(output.kind, 'direct');
		strictEqual(kindReads, 1);
	});

	test('rejects and cleans up malformed or mismatched sealed spool capabilities', async () => {
		const spoolClient = new TestSpoolClient();
		spoolClient.sealResultOverride = {
			id: 'spool-id', ownerId: 'attacker', nonce: 'secret', path: '/raw/spool/path',
		};
		const { broker } = createBroker(sourceProvider([VSBuffer.fromString('abcdef')]), spoolClient);

		await rejectsSafeBrokerError(() => broker.open(descriptor('gitCommit', 'git:/doc'), CancellationToken.None), 'spoolFailure');
		strictEqual(spoolClient.disposed.length, 1);
	});

	test('enforces the exact source-kind URI scheme matrix and sideMissing shape', async () => {
		const invalid: ParadisOfficeSourceDescriptor[] = [
			descriptor('file', 'filex:///tmp/doc.docx'),
			descriptor('file', 'vscode-remote://ssh/doc.docx'),
			descriptor('remote', 'file:///tmp/doc.docx'),
			descriptor('workingTree', 'git:/doc.docx'),
			descriptor('gitCommit', 'untitled:doc'),
			descriptor('gitIndex', 'file:///tmp/doc.docx'),
			descriptor('untitled', 'git:/doc.docx'),
			descriptor('sideMissing', 'file:///tmp/doc.docx'),
			{ kind: 'sideMissing', displayName: 'missing.docx' },
		];
		for (const candidate of invalid) {
			await rejectsSafeBrokerError(() => createBroker(sourceProvider([])).broker.open(candidate, CancellationToken.None), 'unsupportedSource');
		}
	});

	test('accepts direct remote routing only for literal boolean true on a fresh descriptor copy', async () => {
		for (const capability of [false, undefined, 1, 'true', Promise.resolve(true)] as unknown[]) {
			const broker = new ParadisOfficeSourceBroker({
				ownerId,
				platform: 'desktopLocal',
				provider: sourceProvider([]),
				spoolClient: new TestSpoolClient(),
				createHash: () => new TestHash(),
				isRemoteProtocolV1: (() => capability) as unknown as () => boolean,
			});
			if (capability === false) {
				const result = await broker.open(descriptor('remote', 'vscode-remote://ssh/doc.docx'), CancellationToken.None);
				strictEqual(result.kind, 'spool');
			} else {
				await rejectsSafeBrokerError(() => broker.open(descriptor('remote', 'vscode-remote://ssh/doc.docx'), CancellationToken.None), 'providerFailure');
			}
		}

		const input = descriptor('remote', 'vscode-remote://ssh/doc.docx');
		const broker = new ParadisOfficeSourceBroker({
			ownerId,
			platform: 'desktopLocal',
			provider: sourceProvider([]),
			spoolClient: new TestSpoolClient(),
			createHash: () => new TestHash(),
			isRemoteProtocolV1: candidate => {
				strictEqual(candidate === input, false);
				(candidate as { displayName: string }).displayName = 'callback-mutated';
				return true;
			},
		});
		const result = await broker.open(input, CancellationToken.None);
		strictEqual(result.descriptor.displayName, 'document.docx');

		const throwing = new ParadisOfficeSourceBroker({
			ownerId,
			platform: 'desktopLocal',
			provider: sourceProvider([]),
			spoolClient: new TestSpoolClient(),
			createHash: () => new TestHash(),
			isRemoteProtocolV1: () => { throw new Error('/raw/private secret-token'); },
		});
		await rejectsSafeBrokerError(() => throwing.open(input, CancellationToken.None), 'providerFailure');
	});

	test('keeps old-remote workingTree distinct from remote in sealed kind and canonical revision', async () => {
		const remote = await createBroker(sourceProvider([VSBuffer.fromString('abcdef')])).broker.open(
			descriptor('remote', 'vscode-remote://old/doc.docx'), CancellationToken.None);
		const workingTree = await createBroker(sourceProvider([VSBuffer.fromString('abcdef')])).broker.open(
			descriptor('workingTree', 'vscode-remote://old/doc.docx'), CancellationToken.None);
		ok(remote.kind === 'spool');
		ok(workingTree.kind === 'spool');
		strictEqual(remote.spool.sourceKind, 'remote');
		strictEqual(workingTree.spool.sourceKind, 'workingTree');
		strictEqual(remote.spool.revision, 'office-source/v1|6:remote|12:provider:git|6:etag:1|1:6|64:bef57ec7f53a6d40beb640a780a639c83bc29ac8a9816f1fc6c5c6dcd93c4721');
		strictEqual(workingTree.spool.revision, 'office-source/v1|11:workingTree|12:provider:git|6:etag:1|1:6|64:bef57ec7f53a6d40beb640a780a639c83bc29ac8a9816f1fc6c5c6dcd93c4721');
	});

	test('checks provider revision after digest and again after sealing before publish', async () => {
		for (const transition of ['digest', 'seal'] as const) {
			let revision = 'etag:1';
			const provider: IOfficeSourceProvider = {
				async snapshot() { return { identity: 'provider:git', revision }; },
				async *read() { yield VSBuffer.fromString('abcdef'); },
			};
			const spoolClient = new TestSpoolClient();
			if (transition === 'seal') {
				const originalSeal = spoolClient.seal.bind(spoolClient);
				spoolClient.seal = async (reference, request) => {
					const result = await originalSeal(reference, request);
					revision = 'etag:2';
					return result;
				};
			}
			const broker = new ParadisOfficeSourceBroker({
				ownerId,
				platform: 'desktopLocal',
				provider,
				spoolClient,
				createHash: () => ({
					update() { },
					async digest() {
						if (transition === 'digest') {
							revision = 'etag:2';
						}
						return 'bef57ec7f53a6d40beb640a780a639c83bc29ac8a9816f1fc6c5c6dcd93c4721';
					},
				}),
				isRemoteProtocolV1: () => false,
			});

			await rejectsSafeBrokerError(() => broker.open(descriptor('gitCommit', 'git:/doc'), CancellationToken.None), 'stale');
			strictEqual(spoolClient.disposed.length, 1);
			strictEqual(spoolClient.sealed.length, transition === 'digest' ? 0 : 1);
		}
	});

	test('waits for a deferred provider fence and rejects a revision changed while waiting', async () => {
		let snapshotCalls = 0;
		let releaseFence!: () => void;
		const fence = new Promise<void>(resolve => releaseFence = resolve);
		let revision = 'etag:1';
		const provider: IOfficeSourceProvider = {
			async snapshot() {
				snapshotCalls++;
				if (snapshotCalls === 2) {
					await fence;
				}
				return { identity: 'provider:git', revision };
			},
			async *read() { yield VSBuffer.fromString('abcdef'); },
		};
		const pending = createBroker(provider).broker.open(descriptor('gitCommit', 'git:/doc'), CancellationToken.None);
		while (snapshotCalls < 2) {
			await Promise.resolve();
		}
		revision = 'etag:2';
		releaseFence();
		await rejectsSafeBrokerError(() => pending, 'stale');
	});

	test('maps provider, hash, spool, and cleanup exceptions to stable safe broker errors', async () => {
		const secretError = () => new Error('/raw/private secret-token');
		const providerFailures: IOfficeSourceProvider[] = [
			{ async snapshot() { throw secretError(); }, async *read() { } },
			{ async snapshot() { return { identity: 'provider:git', revision: 'etag:1' }; }, async *read() { throw secretError(); } },
		];
		for (const provider of providerFailures) {
			await rejectsSafeBrokerError(() => createBroker(provider).broker.open(descriptor('gitCommit', 'git:/doc'), CancellationToken.None), 'providerFailure');
		}

		for (const failure of ['create', 'update', 'digest', 'invalidDigest'] as const) {
			const broker = new ParadisOfficeSourceBroker({
				ownerId, platform: 'desktopLocal', provider: sourceProvider([VSBuffer.fromString('abcdef')]), spoolClient: new TestSpoolClient(),
				createHash: () => {
					if (failure === 'create') { throw secretError(); }
					return {
						update() { if (failure === 'update') { throw secretError(); } },
						digest() {
							if (failure === 'digest') { return Promise.reject(secretError()); }
							return failure === 'invalidDigest' ? '/raw/private secret-token' : '0'.repeat(64);
						},
					};
				},
				isRemoteProtocolV1: () => false,
			});
			await rejectsSafeBrokerError(() => broker.open(descriptor('gitCommit', 'git:/doc'), CancellationToken.None), 'hashFailure');
		}

		const primaryClient = new TestSpoolClient();
		primaryClient.dispose = async () => { throw secretError(); };
		const failingRead: IOfficeSourceProvider = {
			async snapshot() { return { identity: 'provider:git', revision: 'etag:1' }; },
			async *read() { throw secretError(); },
		};
		await rejectsSafeBrokerError(() => createBroker(failingRead, primaryClient).broker.open(descriptor('gitCommit', 'git:/doc'), CancellationToken.None), 'providerFailure');
	});

	test('rejects malformed writable capabilities returned by begin without leaking dependency data', async () => {
		const spoolClient = new TestSpoolClient();
		spoolClient.begin = async () => ({ id: '/raw/private', ownerId: 'secret-token', nonce: 'bad' });
		await rejectsSafeBrokerError(
			() => createBroker(sourceProvider([VSBuffer.fromString('abcdef')]), spoolClient).broker.open(descriptor('gitCommit', 'git:/doc'), CancellationToken.None),
			'spoolFailure',
		);
	});

	test('disposes an identifiable but non-exact begin capability before returning a safe broker error', async () => {
		const spoolClient = new TestSpoolClient();
		spoolClient.begin = async () => ({ id: 'a'.repeat(48), ownerId, nonce: 'b'.repeat(64), path: '/raw/private/spool' });
		await rejectsSafeBrokerError(
			() => createBroker(sourceProvider([VSBuffer.fromString('abcdef')]), spoolClient).broker.open(descriptor('gitCommit', 'git:/doc'), CancellationToken.None),
			'spoolFailure',
		);
		strictEqual(spoolClient.disposed.length, 1);
	});

	test('normalizes proxy dependency rejections and error stacks without leaking trap data', async () => {
		const trapped = new Proxy({}, {
			getPrototypeOf() { throw new Error('/raw/private secret-token'); },
		});
		const provider: IOfficeSourceProvider = {
			async snapshot() { throw trapped; },
			async *read() { },
		};
		await rejectsSafeBrokerError(() => createBroker(provider).broker.open(descriptor('gitCommit', 'git:/doc'), CancellationToken.None), 'providerFailure');

		const spoolClient = new Proxy(new TestSpoolClient(), {
			get(target, property, receiver) {
				if (property === 'append') { throw new Error('/raw/private secret-token'); }
				return Reflect.get(target, property, receiver);
			},
		});
		await rejectsSafeBrokerError(
			() => createBroker(sourceProvider([VSBuffer.fromString('x')]), spoolClient).broker.open(descriptor('gitCommit', 'git:/doc'), CancellationToken.None),
			'spoolFailure',
		);
	});

	test('stops after a late cancelled iterator result and closes the provider iterator once', async () => {
		let release!: () => void;
		const blocked = new Promise<void>(resolve => release = resolve);
		let nextCalls = 0;
		let returnCalls = 0;
		const iterator: AsyncIterator<VSBuffer> = {
			async next() {
				nextCalls++;
				await blocked;
				return { done: false, value: VSBuffer.fromString('late') };
			},
			async return() {
				returnCalls++;
				return { done: true, value: undefined };
			},
		};
		const provider: IOfficeSourceProvider = {
			async snapshot() { return { identity: 'provider:git', revision: 'etag:1' }; },
			read() { return { [Symbol.asyncIterator]: () => iterator }; },
		};
		const cancellation = new CancellationTokenSource();
		const spoolClient = new TestSpoolClient();
		const pending = createBroker(provider, spoolClient).broker.open(descriptor('gitCommit', 'git:/doc'), cancellation.token);
		while (nextCalls === 0) {
			await Promise.resolve();
		}
		cancellation.cancel();
		release();
		await rejects(pending, error => error instanceof CancellationError);
		strictEqual(spoolClient.appended.length, 0);
		strictEqual(spoolClient.disposed.length, 1);
		strictEqual(returnCalls, 1);
		cancellation.dispose();
	});

	test('does not begin a provider fence or sealing after cancellation during digest', async () => {
		let release!: () => void;
		const blocked = new Promise<void>(resolve => release = resolve);
		let snapshotCalls = 0;
		const provider: IOfficeSourceProvider = {
			async snapshot() { snapshotCalls++; return { identity: 'provider:git', revision: 'etag:1' }; },
			async *read() { yield VSBuffer.fromString('digest'); },
		};
		const cancellation = new CancellationTokenSource();
		const spoolClient = new TestSpoolClient();
		const broker = new ParadisOfficeSourceBroker({
			ownerId, platform: 'desktopLocal', provider, spoolClient,
			createHash: () => ({ update() { }, async digest() { await blocked; return '0'.repeat(64); } }),
			isRemoteProtocolV1: () => false,
		});
		const pending = broker.open(descriptor('gitCommit', 'git:/doc'), cancellation.token);
		while (spoolClient.appended.length === 0) {
			await Promise.resolve();
		}
		cancellation.cancel();
		release();
		await rejects(pending, error => error instanceof CancellationError);
		strictEqual(snapshotCalls, 1);
		strictEqual(spoolClient.sealed.length, 0);
		cancellation.dispose();
	});

	test('gives cancellation precedence to synchronous iterator-result traps without consuming bytes', async () => {
		const cancellation = new CancellationTokenSource();
		const result = new Proxy({ done: false, value: VSBuffer.fromString('late') }, {
			getOwnPropertyDescriptor(target, property) {
				if (property === 'done') { cancellation.cancel(); }
				return Reflect.getOwnPropertyDescriptor(target, property);
			},
		});
		const spoolClient = new TestSpoolClient();
		const provider: IOfficeSourceProvider = {
			async snapshot() { return { identity: 'provider:git', revision: 'etag:1' }; },
			read() { return { [Symbol.asyncIterator]: () => ({ next: async () => result, return: async () => ({ done: true, value: undefined }) }) }; },
		};
		await rejects(createBroker(provider, spoolClient).broker.open(descriptor('gitCommit', 'git:/doc'), cancellation.token), (error: unknown) => {
			return error instanceof CancellationError && (error.stack === '' || error.stack === undefined);
		});
		strictEqual(spoolClient.appended.length, 0);
		cancellation.dispose();
	});

	test('enforces the Task 2 platform compressed-input budget before append', async () => {
		const chunks = new Array(8).fill(undefined).map(() => VSBuffer.alloc(PARADIS_OFFICE_SPOOL_CHUNK_BYTES));
		chunks.push(VSBuffer.alloc(1));
		const spoolClient = new TestSpoolClient();
		const broker = new ParadisOfficeSourceBroker({
			ownerId, platform: 'browser', provider: sourceProvider(chunks), spoolClient, createHash: () => new TestHash(), isRemoteProtocolV1: () => false,
		});
		await rejectsSafeBrokerError(() => broker.open(descriptor('gitCommit', 'git:/doc'), CancellationToken.None), 'sourceTooLarge');
		strictEqual(spoolClient.appended.length, 8);
	});
});
