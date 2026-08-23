/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import { createHash } from 'crypto';
import { deepStrictEqual, doesNotThrow, ok, rejects, strictEqual } from 'assert';
import { VSBuffer } from '../../../../../base/common/buffer.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import {
	buildParadisOfficeSourceRevision,
	IOfficeSpoolExpiryScheduler,
	PARADIS_OFFICE_SPOOL_CHUNK_BYTES,
	PARADIS_OFFICE_SPOOL_LIMITS,
	ParadisOfficeSealRequest,
	ParadisOfficeSpoolReference,
} from '../../common/paradisOfficeSourceBroker.js';
import { OfficeSpoolStore } from '../../node/paradisOfficeSpoolStore.js';

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
});
