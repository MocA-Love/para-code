/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import { ok, strictEqual } from 'assert';
import { CancellationTokenSource } from '../../../../../base/common/cancellation.js';
import { Emitter } from '../../../../../base/common/event.js';
import type { IDisposable } from '../../../../../base/common/lifecycle.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { PARADIS_OFFICE_BUDGET_PROFILES } from '../../common/paradisOfficeProtocol.js';
import { OfficeHandleStore } from '../../node/office/paradisOfficeHandleStore.js';
import { OfficeMemoryAccountant, OfficeWorkerHost, type IOfficeWorker } from '../../node/office/paradisOfficeWorkerHost.js';

class LifecycleWorker implements IOfficeWorker {
	private readonly messageEmitter = new Emitter<unknown>();
	private readonly errorEmitter = new Emitter<unknown>();
	private readonly exitEmitter = new Emitter<number>();
	postMessage(_message: unknown): void { }
	terminate(): Promise<number> { this.exitEmitter.fire(1); return Promise.resolve(1); }
	onMessage(listener: (message: unknown) => void): IDisposable { return this.messageEmitter.event(listener); }
	onError(listener: (error: unknown) => void): IDisposable { return this.errorEmitter.event(listener); }
	onExit(listener: (code: number) => void): IDisposable { return this.exitEmitter.event(listener); }
	cancelled(requestId: string): void { this.messageEmitter.fire({ kind: 'cancelled', requestId }); }
}

suite('ParadisOfficeMemory', () => {
	ensureNoDisposablesAreLeakedInTestSuite();
	test('releases real worker, handle, and cache lifecycle state before three forced GCs', async () => {
		const forceGc = (globalThis as typeof globalThis & { readonly gc?: () => void }).gc;
		strictEqual(typeof forceGc, 'function', 'run this harness with --expose-gc');
		const baseline = process.memoryUsage().heapUsed;
		const accountant = new OfficeMemoryAccountant(64 * 1024 * 1024);
		let random = 0;
		const handles = new OfficeHandleStore({ accountant, semanticCacheLimitBytes: 64 * 1024 * 1024, randomBytes: length => new Uint8Array(length).fill(++random) });
		const handle = handles.create('memory-gate', 'document', 'revision', 2 * 1024 * 1024);
		let releasedSnapshots = 0;
		let semanticSnapshot: object | undefined = {
			kind: 'spreadsheet',
			sheets: [{ name: 'Memory Gate', cells: new Uint8Array(3 * 1024 * 1024) }],
		};
		strictEqual(handles.putSemanticSnapshot(handle, 'projection', semanticSnapshot, 3 * 1024 * 1024, () => releasedSnapshots++), true);
		strictEqual(handles.getSemanticSnapshot(handle, 'projection'), semanticSnapshot);
		strictEqual(handles.semanticSnapshotCount, 1);
		semanticSnapshot = undefined;
		const worker = new LifecycleWorker();
		const host = new OfficeWorkerHost({ accountant, createWorker: () => worker, memory: { workerReservationBytes: 4 * 1024 * 1024 } });
		const cancellation = new CancellationTokenSource();
		try {
			const outcome = host.run('parse', 'memory-gate', { kind: 'bytes', bytes: Uint8Array.of(0x50, 0x4b, 0x03, 0x04), revision: 'memory-gate' }, PARADIS_OFFICE_BUDGET_PROFILES.desktopLocal, cancellation.token);
			strictEqual(host.activeWorkerCount, 1);
			strictEqual(accountant.snapshot().workerBytes, 4 * 1024 * 1024);
			cancellation.cancel();
			worker.cancelled('1');
			strictEqual((await outcome).outcome, 'cancelled');
		} finally {
			cancellation.dispose();
			host.dispose();
		}
		strictEqual(handles.close(handle), true);
		handles.dispose();
		for (let cycle = 0; cycle < 3; cycle++) { forceGc!(); }
		const after = process.memoryUsage().heapUsed;
		strictEqual(host.activeWorkerCount, 0);
		strictEqual(handles.size, 0);
		strictEqual(handles.semanticSnapshotCount, 0);
		strictEqual(releasedSnapshots, 1);
		strictEqual(handles.semanticCacheBytes, 0);
		strictEqual(accountant.snapshot().handleBytes, 0);
		strictEqual(accountant.snapshot().workerBytes, 0);
		strictEqual(accountant.snapshot().cacheBytes, 0);
		strictEqual(accountant.snapshot().totalBytes, 0);
		ok(after <= baseline + 20 * 1024 * 1024, `heap=${after} baseline=${baseline}`);
	});
});
