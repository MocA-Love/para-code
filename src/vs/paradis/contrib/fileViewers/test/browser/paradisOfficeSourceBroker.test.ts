/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import { deepStrictEqual, ok, rejects, strictEqual } from 'assert';
import { VSBuffer } from '../../../../../base/common/buffer.js';
import { CancellationToken, CancellationTokenSource } from '../../../../../base/common/cancellation.js';
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

	test('spools git/index/untitled and old remote sources in chunks no larger than 2 MiB', async () => {
		for (const sourceKind of ['gitCommit', 'gitIndex', 'untitled', 'remote'] as const) {
			const bytes = VSBuffer.alloc(PARADIS_OFFICE_SPOOL_CHUNK_BYTES * 2 + 1);
			bytes.buffer.fill(0x61);
			const { broker, spoolClient } = createBroker(sourceProvider([bytes]));

			const source = await broker.open(descriptor(sourceKind, sourceKind === 'remote' ? 'vscode-remote://old/file.docx' : `git:/${sourceKind}`), CancellationToken.None);

			strictEqual(source.kind, 'spool');
			deepStrictEqual(spoolClient.appended.map(chunk => chunk.byteLength), [PARADIS_OFFICE_SPOOL_CHUNK_BYTES, PARADIS_OFFICE_SPOOL_CHUNK_BYTES, 1]);
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
		const provider: IOfficeSourceProvider = {
			async snapshot() { return { identity: 'provider:git', revision: 'etag:1' }; },
			async *read() {
				await blocked;
				yield VSBuffer.fromString('late');
			},
		};
		const cancellation = new CancellationTokenSource();
		const spoolClient = new TestSpoolClient();
		const pending = createBroker(provider, spoolClient).broker.open(descriptor('gitCommit', 'git:/doc'), cancellation.token);
		while (spoolClient.beginCalls === 0) {
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

		await rejects(() => broker.open(descriptor('gitCommit', 'git:/doc'), CancellationToken.None), TypeError);
		strictEqual(spoolClient.disposed.length, 1);
	});
});
