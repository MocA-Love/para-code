/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import { createHash } from 'crypto';
import { deepStrictEqual, doesNotThrow, ok, rejects, strictEqual } from 'assert';
import { VSBuffer } from '../../../../../base/common/buffer.js';
import { CancellationToken, CancellationTokenSource } from '../../../../../base/common/cancellation.js';
import { CancellationError } from '../../../../../base/common/errors.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
// eslint-disable-next-line local/code-layering, local/code-import-patterns -- This Node integration test intentionally exercises the browser broker's IPC client contract against the backend store.
import { ParadisOfficeSourceBroker } from '../../browser/paradisOfficeSourceBroker.js';
import {
	buildParadisOfficeSourceRevision,
	IOfficeSourceProvider,
	IOfficeSpoolExpiryScheduler,
	PARADIS_OFFICE_SPOOL_CHUNK_BYTES,
	PARADIS_OFFICE_SPOOL_LIMITS,
	ParadisOfficeSealRequest,
	ParadisOfficeSpoolReference,
} from '../../common/paradisOfficeSourceBroker.js';
import { OfficeSpoolStore, OfficeSpoolStoreError } from '../../node/paradisOfficeSpoolStore.js';

const ownerA = 'window-a';
const ownerB = 'window-b';

class ManualExpiryScheduler implements IOfficeSpoolExpiryScheduler {
	disposed = false;
	scheduledDelay: number | undefined;

	constructor(private readonly runner: () => void) { }

	schedule(delay: number): void {
		this.scheduledDelay = delay;
	}

	dispose(): void {
		this.disposed = true;
	}

	run(): void {
		this.runner();
	}
}

function sha256(bytes: Uint8Array | string): string {
	return createHash('sha256').update(bytes).digest('hex');
}

function sealRequest(bytes: Uint8Array | string, sourceKind: 'gitCommit' | 'gitIndex' | 'untitled' | 'remote' = 'gitCommit'): ParadisOfficeSealRequest {
	const byteLength = typeof bytes === 'string' ? VSBuffer.fromString(bytes).byteLength : bytes.byteLength;
	const hash = sha256(bytes);
	return {
		sourceKind,
		providerIdentity: 'provider:git',
		providerRevision: 'etag:1',
		size: byteLength,
		sha256: hash,
		revision: buildParadisOfficeSourceRevision(sourceKind, 'provider:git', 'etag:1', byteLength, hash),
	};
}

async function appendAndSeal(store: OfficeSpoolStore, ownerId: string, value: string) {
	const reference = await store.begin(ownerId);
	await store.append(reference, VSBuffer.fromString(value));
	return store.seal(reference, sealRequest(value));
}

suite('OfficeSpoolStore', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	test('uses owner-bound opaque CSPRNG references and rejects wrong owner or nonce without leaking them', async () => {
		let randomValue = 0;
		const store = new OfficeSpoolStore({
			platform: 'desktopLocal',
			randomBytes: length => new Uint8Array(length).fill(++randomValue),
		});
		const reference = await store.begin(ownerA);
		ok(/^[a-f\d]{48}$/.test(reference.id));
		ok(/^[a-f\d]{64}$/.test(reference.nonce));
		const wrongOwner = { ...reference, ownerId: ownerB };
		const wrongNonce = { ...reference, nonce: 'f'.repeat(64) };

		for (const candidate of [wrongOwner, wrongNonce]) {
			await rejects(() => store.append(candidate, VSBuffer.fromString('x')), (error: unknown) => {
				return error instanceof Error
					&& error.name === 'OfficeSpoolStoreError'
					&& (error as Error & { code?: string }).code === 'invalidReference'
					&& !error.message.includes(reference.id)
					&& !error.message.includes(reference.nonce)
					&& !error.message.includes(ownerA);
			});
		}
		await store.dispose(reference);
		store.disposeAll();
	});

	test('enforces per-client two-spool and global eight-spool boundaries', async () => {
		const store = new OfficeSpoolStore({ platform: 'desktopLocal' });
		const first = await store.begin(ownerA);
		const second = await store.begin(ownerA);
		await rejects(() => store.begin(ownerA), (error: unknown) => error instanceof Error && (error as Error & { code?: string }).code === 'clientQuota');

		const references = [first, second];
		for (let index = 0; index < 6; index++) {
			references.push(await store.begin(`window-${index}`));
		}
		await rejects(() => store.begin('window-overflow'), (error: unknown) => error instanceof Error && (error as Error & { code?: string }).code === 'globalQuota');
		for (const reference of references) {
			await store.dispose(reference);
		}
		store.disposeAll();
	});

	test('accepts a 2 MiB chunk and rejects 2 MiB plus one before retaining caller bytes', async () => {
		const store = new OfficeSpoolStore({ platform: 'desktopLocal' });
		const reference = await store.begin(ownerA);
		const exact = VSBuffer.alloc(PARADIS_OFFICE_SPOOL_CHUNK_BYTES);
		exact.buffer.fill(0x61);
		await store.append(reference, exact);
		exact.buffer[0] = 0x7a;
		await rejects(() => store.append(reference, VSBuffer.alloc(PARADIS_OFFICE_SPOOL_CHUNK_BYTES + 1)), (error: unknown) => {
			return error instanceof Error && (error as Error & { code?: string }).code === 'chunkTooLarge';
		});

		const sealed = await store.seal(reference, sealRequest(new Uint8Array(PARADIS_OFFICE_SPOOL_CHUNK_BYTES).fill(0x61)));
		await store.open(sealed, async source => {
			const firstRead = await source.read(0, 1);
			strictEqual(firstRead.buffer[0], 0x61);
		});
		store.disposeAll();
	});

	test('enforces platform compressed-input and aggregate byte budgets at exact and plus-one boundaries', async () => {
		deepStrictEqual(PARADIS_OFFICE_SPOOL_LIMITS, {
			desktopLocal: { compressedInputBytes: 32 * 1024 * 1024, totalBytes: 256 * 1024 * 1024 },
			remoteMobile: { compressedInputBytes: 20 * 1024 * 1024, totalBytes: 128 * 1024 * 1024 },
			browser: { compressedInputBytes: 16 * 1024 * 1024, totalBytes: 96 * 1024 * 1024 },
		});
		const store = new OfficeSpoolStore({
			platform: 'desktopLocal',
			limits: { compressedInputBytes: 4, totalBytes: 6 },
		});
		const first = await store.begin(ownerA);
		await store.append(first, VSBuffer.alloc(4));
		await rejects(() => store.append(first, VSBuffer.alloc(1)), (error: unknown) => error instanceof Error && (error as Error & { code?: string }).code === 'sourceByteQuota');

		const second = await store.begin(ownerA);
		await store.append(second, VSBuffer.alloc(2));
		strictEqual(store.byteLength, 6);
		const third = await store.begin(ownerB);
		await rejects(() => store.append(third, VSBuffer.alloc(1)), (error: unknown) => error instanceof Error && (error as Error & { code?: string }).code === 'globalByteQuota');
		store.disposeAll();

		const remoteStore = new OfficeSpoolStore({ platform: 'remoteMobile' });
		const remoteReference = await remoteStore.begin(ownerA);
		const chunk = VSBuffer.alloc(PARADIS_OFFICE_SPOOL_CHUNK_BYTES);
		for (let index = 0; index < 10; index++) {
			await remoteStore.append(remoteReference, chunk);
		}
		await rejects(() => remoteStore.append(remoteReference, VSBuffer.alloc(1)), (error: unknown) => {
			return error instanceof Error && (error as Error & { code?: string }).code === 'sourceByteQuota';
		});
		remoteStore.disposeAll();
	});

	test('snapshots injected byte limits so caller mutation cannot bypass quota', async () => {
		const limits = { compressedInputBytes: 1, totalBytes: 1 };
		const store = new OfficeSpoolStore({ platform: 'desktopLocal', limits });
		limits.compressedInputBytes = 2;
		limits.totalBytes = 2;
		const reference = await store.begin(ownerA);
		await store.append(reference, VSBuffer.alloc(1));
		await rejects(() => store.append(reference, VSBuffer.alloc(1)), (error: unknown) => {
			return error instanceof Error && (error as Error & { code?: string }).code === 'sourceByteQuota';
		});
		store.disposeAll();
	});

	test('expires only unsealed spools after two minutes using an injected clock and scheduler', async () => {
		let now = 1_000;
		const schedulers: ManualExpiryScheduler[] = [];
		const store = new OfficeSpoolStore({
			platform: 'desktopLocal',
			now: () => now,
			createExpiryScheduler: runner => {
				const scheduler = new ManualExpiryScheduler(runner);
				schedulers.push(scheduler);
				return scheduler;
			},
		});
		const unsealed = await store.begin(ownerA);
		const sealed = await appendAndSeal(store, ownerB, 'sealed');
		strictEqual(schedulers[0].scheduledDelay, 120_000);
		now += 119_999;
		schedulers[0].run();
		await store.append(unsealed, VSBuffer.fromString('still alive'));
		now += 1;
		schedulers[0].run();
		await rejects(() => store.append(unsealed, VSBuffer.fromString('expired')));
		await store.open(sealed, async source => strictEqual((await source.read(0, 6)).toString(), 'sealed'));
		store.disposeAll();
	});

	test('enforces append/seal/open state transitions and verifies size, SHA-256, and revision', async () => {
		const store = new OfficeSpoolStore({ platform: 'desktopLocal' });
		const reference = await store.begin(ownerA);
		await rejects(() => store.open(reference as ParadisOfficeSpoolReference & ParadisOfficeSealRequest, async () => undefined), (error: unknown) => error instanceof Error && (error as Error & { code?: string }).code === 'notSealed');
		await store.append(reference, VSBuffer.fromString('abc'));
		await rejects(() => store.seal(reference, { ...sealRequest('abc'), size: 4 }), (error: unknown) => error instanceof Error && (error as Error & { code?: string }).code === 'integrityMismatch');

		const next = await store.begin(ownerA);
		await store.append(next, VSBuffer.fromString('abc'));
		const sealed = await store.seal(next, sealRequest('abc'));
		await rejects(() => store.append(next, VSBuffer.fromString('d')), (error: unknown) => error instanceof Error && (error as Error & { code?: string }).code === 'notWritable');
		await rejects(() => store.seal(next, sealRequest('abc')), (error: unknown) => error instanceof Error && (error as Error & { code?: string }).code === 'notWritable');
		strictEqual(sealed.sha256, sha256('abc'));
		strictEqual(sealed.size, 3);
		strictEqual(sealed.revision, buildParadisOfficeSourceRevision('gitCommit', 'provider:git', 'etag:1', 3, sha256('abc')));
		store.disposeAll();
	});

	test('returns independent read buffers so caller mutation cannot change sealed content', async () => {
		const store = new OfficeSpoolStore({ platform: 'desktopLocal' });
		const sealed = await appendAndSeal(store, ownerA, 'immutable');
		await store.open(sealed, async source => {
			const first = await source.read(0, 9);
			first.buffer.fill(0x78);
			const second = await source.read(0, 9);
			strictEqual(second.toString(), 'immutable');
			await rejects(() => source.read(0, PARADIS_OFFICE_SPOOL_CHUNK_BYTES + 1));
		});
		store.disposeAll();
	});

	test('cleans up idempotently after open success/failure, disconnect, and backend crash', async () => {
		const store = new OfficeSpoolStore({ platform: 'desktopLocal' });
		const success = await appendAndSeal(store, ownerA, 'success');
		await store.open(success, async source => strictEqual((await source.read(0, 7)).toString(), 'success'));
		await rejects(() => store.open(success, async () => undefined));

		const failure = await appendAndSeal(store, ownerA, 'failure');
		await rejects(() => store.open(failure, async () => { throw new Error('backend open failed'); }));
		await rejects(() => store.open(failure, async () => undefined));

		await store.begin(ownerA);
		await store.begin(ownerB);
		store.disconnect(ownerA);
		strictEqual(store.activeSpoolCount, 1);
		store.disposeAll();
		strictEqual(store.activeSpoolCount, 0);
		strictEqual(store.byteLength, 0);
		doesNotThrow(() => store.disposeAll());
	});

	test('validates malformed public inputs without invoking accessors or exposing paths/getters/secrets', async () => {
		let getterCalls = 0;
		const unsafe = Object.create(null);
		Object.defineProperty(unsafe, 'id', { enumerable: true, get: () => { getterCalls++; throw new Error('/raw/path secret=token'); } });
		const store = new OfficeSpoolStore({ platform: 'desktopLocal' });
		await rejects(() => store.append(unsafe, VSBuffer.fromString('x')), TypeError);
		strictEqual(getterCalls, 0);

		const sealed = await appendAndSeal(store, ownerA, 'safe');
		deepStrictEqual(Object.keys(sealed).sort(), ['id', 'nonce', 'ownerId', 'providerIdentity', 'providerRevision', 'revision', 'sha256', 'size', 'sourceKind']);
		strictEqual(Object.prototype.hasOwnProperty.call(sealed, 'path'), false);
		strictEqual(Object.prototype.hasOwnProperty.call(sealed, 'bytes'), false);
		strictEqual(Object.prototype.hasOwnProperty.call(sealed, 'stream'), false);
		store.disposeAll();
	});

	test('cleans sealed bytes and quota after every authenticated open-attempt failure', async () => {
		for (const failure of ['mismatch', 'extraField', 'nonFunction'] as const) {
			const store = new OfficeSpoolStore({ platform: 'desktopLocal' });
			const sealed = await appendAndSeal(store, ownerA, failure);
			const candidate = failure === 'mismatch'
				? { ...sealed, size: sealed.size + 1 }
				: failure === 'extraField'
					? { ...sealed, path: '/raw/private/spool' }
					: sealed;
			await rejects(() => store.open(candidate as typeof sealed, (failure === 'nonFunction' ? undefined : async () => undefined) as never));
			strictEqual(store.activeSpoolCount, 0);
			strictEqual(store.byteLength, 0);
			await store.begin(ownerA);
			await store.begin(ownerA);
			store.disposeAll();
		}

		const store = new OfficeSpoolStore({ platform: 'desktopLocal' });
		const sealed = await appendAndSeal(store, ownerA, 'victim');
		await rejects(() => store.open({ ...sealed, nonce: 'f'.repeat(64) }, async () => undefined));
		strictEqual(store.activeSpoolCount, 1);
		await store.open(sealed, async source => strictEqual((await source.read(0, 6)).toString(), 'victim'));
	});

	test('enforces the unsealed hard deadline synchronously even when the scheduler has not fired', async () => {
		let now = 10_000;
		const store = new OfficeSpoolStore({
			platform: 'desktopLocal',
			now: () => now,
			createExpiryScheduler: runner => new ManualExpiryScheduler(runner),
		});
		const reference = await store.begin(ownerA);
		now += 119_999;
		await store.append(reference, VSBuffer.fromString('a'));
		now += 1;
		await rejects(() => store.seal(reference, sealRequest('a')), (error: unknown) => {
			return error instanceof Error && (error as Error & { code?: string }).code === 'invalidReference';
		});
		strictEqual(store.activeSpoolCount, 0);
		strictEqual(store.byteLength, 0);
	});

	test('snapshots reentrant reference, buffer, seal, and open inputs before entry lookup', async () => {
		for (const operation of ['reference', 'buffer', 'seal', 'open'] as const) {
			const store = new OfficeSpoolStore({ platform: 'desktopLocal' });
			const reference = await store.begin(ownerA);
			if (operation === 'reference') {
				const candidate = new Proxy(reference, {
					getOwnPropertyDescriptor(target, property) {
						if (property === 'nonce') { void store.dispose(reference); }
						return Reflect.getOwnPropertyDescriptor(target, property);
					},
				});
				await rejects(() => store.append(candidate, VSBuffer.fromString('x')));
			} else if (operation === 'buffer') {
				const bytes = new Proxy(VSBuffer.fromString('x'), {
					getOwnPropertyDescriptor(target, property) {
						if (property === 'buffer') { void store.dispose(reference); }
						return Reflect.getOwnPropertyDescriptor(target, property);
					},
				});
				await rejects(() => store.append(reference, bytes));
			} else if (operation === 'seal') {
				await store.append(reference, VSBuffer.fromString('x'));
				const request = sealRequest('x');
				const candidate = new Proxy(request, {
					getOwnPropertyDescriptor(target, property) {
						if (property === 'sourceKind') { void store.dispose(reference); }
						return Reflect.getOwnPropertyDescriptor(target, property);
					},
				});
				await rejects(() => store.seal(reference, candidate));
			} else {
				await store.append(reference, VSBuffer.fromString('x'));
				const sealed = await store.seal(reference, sealRequest('x'));
				const candidate = new Proxy(sealed, {
					getOwnPropertyDescriptor(target, property) {
						if (property === 'providerIdentity') { void store.dispose(sealed); }
						return Reflect.getOwnPropertyDescriptor(target, property);
					},
				});
				await rejects(() => store.open(candidate, async () => undefined));
			}
			strictEqual(store.activeSpoolCount, 0);
			strictEqual(store.byteLength, 0);
		}
	});

	test('rejects concurrent open, append, and seal transitions without retaining a second consumer', async () => {
		const store = new OfficeSpoolStore({ platform: 'desktopLocal' });
		const sealed = await appendAndSeal(store, ownerA, 'concurrent');
		let release!: () => void;
		const blocked = new Promise<void>(resolve => release = resolve);
		const opening = store.open(sealed, async source => {
			strictEqual((await source.read(0, 10)).toString(), 'concurrent');
			await blocked;
		});
		await rejects(() => store.open(sealed, async () => undefined));
		await rejects(() => store.append(sealed, VSBuffer.fromString('x')));
		await rejects(() => store.seal(sealed, sealRequest('concurrent')));
		release();
		await opening;
		strictEqual(store.activeSpoolCount, 0);
	});

	test('rolls back begin when scheduling fails and bounds random collision attempts', async () => {
		const schedulerFailure = new OfficeSpoolStore({
			platform: 'desktopLocal',
			createExpiryScheduler: () => ({ schedule() { throw new Error('/raw/private'); }, dispose() { } }),
		});
		await rejects(() => schedulerFailure.begin(ownerA));
		strictEqual(schedulerFailure.activeSpoolCount, 0);

		let randomCalls = 0;
		const collisionStore = new OfficeSpoolStore({
			platform: 'desktopLocal',
			randomBytes: length => {
				randomCalls++;
				if (randomCalls > 66) { throw new Error('collision sentinel'); }
				return new Uint8Array(length).fill(1);
			},
		});
		await collisionStore.begin(ownerA);
		await rejects(() => collisionStore.begin(ownerB), (error: unknown) => {
			return error instanceof Error && error.name === 'OfficeSpoolStoreError';
		});
		ok(randomCalls <= 66);
		collisionStore.disposeAll();
	});

	test('normalizes proxy buffer traps and reschedule/dispose failures while releasing quota', async () => {
		const store = new OfficeSpoolStore({ platform: 'desktopLocal' });
		const reference = await store.begin(ownerA);
		const trapped = new Proxy(VSBuffer.fromString('x'), {
			getPrototypeOf() { throw new Error('/raw/private secret-token'); },
		});
		await rejects(() => store.append(reference, trapped), (error: unknown) => {
			return error instanceof Error
				&& error.name === 'OfficeSpoolStoreError'
				&& !(error.stack ?? '').includes('/Users/magu/')
				&& !(error.stack ?? '').includes('/raw/private')
				&& !(error.stack ?? '').includes('secret-token');
		});
		await store.dispose(reference);

		let now = 1_000;
		const scheduler = new ManualExpiryScheduler(() => undefined);
		let scheduleCalls = 0;
		scheduler.schedule = () => {
			scheduleCalls++;
			if (scheduleCalls > 1) { throw new Error('/raw/private secret-token'); }
		};
		const rescheduleStore = new OfficeSpoolStore({
			platform: 'desktopLocal', now: () => now, createExpiryScheduler: runner => {
				(scheduler as unknown as { runner: () => void }).runner = runner;
				return scheduler;
			},
		});
		const expiring = await rescheduleStore.begin(ownerA);
		now += 1;
		scheduler.run();
		strictEqual(rescheduleStore.activeSpoolCount, 0);
		strictEqual(rescheduleStore.byteLength, 0);
		await rejects(() => rescheduleStore.append(expiring, VSBuffer.fromString('x')));

		const disposeFailureStore = new OfficeSpoolStore({
			platform: 'desktopLocal', createExpiryScheduler: runner => ({ schedule() { }, dispose() { throw new Error('/raw/private secret-token'); } }),
		});
		const sealing = await disposeFailureStore.begin(ownerA);
		await disposeFailureStore.append(sealing, VSBuffer.fromString('x'));
		await rejects(() => disposeFailureStore.seal(sealing, sealRequest('x')), (error: unknown) => {
			return error instanceof Error && error.name === 'OfficeSpoolStoreError' && !(error.stack ?? '').includes('/raw/private');
		});
		strictEqual(disposeFailureStore.activeSpoolCount, 0);
		await disposeFailureStore.begin(ownerA);
		disposeFailureStore.disposeAll();
	});

	test('rejects non-finite clock values without creating an entry', async () => {
		for (const value of [Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY]) {
			const store = new OfficeSpoolStore({ platform: 'desktopLocal', now: () => value });
			await rejects(() => store.begin(ownerA), TypeError);
			strictEqual(store.activeSpoolCount, 0);
		}
	});

	test('normalizes arbitrary runtime store error codes without exposing a stack', () => {
		const error = new (OfficeSpoolStoreError as unknown as new (code: string) => Error & { code: string })('/raw/private secret-token');
		strictEqual(error.code, 'invalidReference');
		strictEqual(error.message, 'The Office spool operation was rejected.');
		strictEqual(error.stack, '');
	});

	test('runs the real broker and real spool store end to end and reuses quota after open', async () => {
		const store = new OfficeSpoolStore({ platform: 'desktopLocal' });
		const provider: IOfficeSourceProvider = {
			async snapshot() { return { identity: 'provider:real', revision: 'etag:real' }; },
			async *read() { yield VSBuffer.fromString('real-bytes'); },
		};
		const broker = new ParadisOfficeSourceBroker({
			ownerId: ownerA,
			platform: 'desktopLocal',
			provider,
			spoolClient: store,
			createHash: () => {
				const hash = createHash('sha256');
				return { update: bytes => { hash.update(bytes.buffer); }, digest: () => hash.digest('hex') };
			},
			isRemoteProtocolV1: () => false,
		});
		const source = await broker.open({ kind: 'gitCommit', uri: 'git:/doc', displayName: 'doc.docx' }, CancellationToken.None);
		ok(source.kind === 'spool');
		await store.open(source.spool, async opened => strictEqual((await opened.read(0, 10)).toString(), 'real-bytes'));
		strictEqual(store.activeSpoolCount, 0);
		await store.begin(ownerA);
		await store.begin(ownerA);
		store.disposeAll();
	});

	test('releases a real spool and closes a late iterator without consuming its cancelled result', async () => {
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
		const store = new OfficeSpoolStore({ platform: 'desktopLocal' });
		const broker = new ParadisOfficeSourceBroker({
			ownerId: ownerA,
			platform: 'desktopLocal',
			provider: {
				async snapshot() { return { identity: 'provider:real', revision: 'etag:real' }; },
				read() { return { [Symbol.asyncIterator]: () => iterator }; },
			},
			spoolClient: store,
			createHash: () => {
				const hash = createHash('sha256');
				return { update: bytes => { hash.update(bytes.buffer); }, digest: () => hash.digest('hex') };
			},
			isRemoteProtocolV1: () => false,
		});
		const cancellation = new CancellationTokenSource();
		const pending = broker.open({ kind: 'gitCommit', uri: 'git:/doc', displayName: 'doc.docx' }, cancellation.token);
		while (nextCalls === 0) {
			await Promise.resolve();
		}
		cancellation.cancel();
		release();
		await rejects(pending, error => error instanceof CancellationError);
		strictEqual(returnCalls, 1);
		strictEqual(store.activeSpoolCount, 0);
		strictEqual(store.byteLength, 0);
		cancellation.dispose();
	});
});
