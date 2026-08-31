/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import { deepStrictEqual, rejects, strictEqual } from 'assert';
import { DeferredPromise } from '../../../../base/common/async.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../base/test/common/utils.js';
import { ILogService, NullLogService } from '../../../log/common/log.js';
import { PARADIS_UNRESOLVABLE_PTY_ID } from '../../common/terminal.js';
import { PtyService } from '../../node/ptyService.js';

/**
 * Covers how a restored editor tab is matched back onto a terminal. A persistent process id only
 * means something within the session that handed it out — the pty host restarts its counter at 0, so
 * the ids of one session name different terminals in the next and the two ranges overlap. These
 * cases are what stops a restored tab from attaching to somebody else's terminal.
 */
suite('Para Code revived pty identity', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	/**
	 * Drives `getRevivedPtyNewId` against a hand-built pty host state: `live` is what the host has
	 * right now (id → nonce), `revived` is what a revive in this host produced (nonce → new id).
	 */
	async function resolve(options: {
		readonly live: ReadonlyMap<number, string>;
		readonly revived?: ReadonlyMap<string, number>;
		readonly id: number;
		readonly nonce?: string;
	}): Promise<number | undefined> {
		const service = Object.create(PtyService.prototype) as PtyService;
		const state = service as unknown as {
			_ptys: Map<number, { processLaunchOptions: { options: { shellIntegration: { nonce: string } } } }>;
			_paradisRevivedNewIdByNonce: Map<string, number>;
			_revivedPtyIdMap: Map<string, unknown>;
			_logService: ILogService;
		};
		state._ptys = new Map([...options.live].map(([id, nonce]) => [id, { processLaunchOptions: { options: { shellIntegration: { nonce } } } }]));
		state._paradisRevivedNewIdByNonce = new Map(options.revived ?? []);
		state._revivedPtyIdMap = new Map();
		// `@traceRpc` wraps every RPC method and reads these before the call goes through; the real
		// property is a getter, so it has to be defined rather than assigned.
		state._logService = new NullLogService();
		Object.defineProperty(service, 'traceRpcArgs', { value: { logService: state._logService, simulatedLatency: 0 } });
		return service.getRevivedPtyNewId('workspace', options.id, options.nonce);
	}

	test('a revived terminal is found by nonce, whatever id the tab remembers', async () => {
		// The tab remembers id 5 from the session that was revived; that number now belongs to another
		// terminal, and the one it means was handed id 2.
		const resolved = await resolve({
			live: new Map([[2, 'nonce-of-the-tab'], [5, 'nonce-of-someone-else']]),
			revived: new Map([['nonce-of-the-tab', 2]]),
			id: 5,
			nonce: 'nonce-of-the-tab',
		});

		deepStrictEqual(resolved, 2);
	});

	test('a window reload keeps using the id, since no revive came in between', async () => {
		// `undefined` means "no correction", which makes the caller attach to the id it asked with.
		const resolved = await resolve({
			live: new Map([[7, 'nonce-of-the-tab']]),
			id: 7,
			nonce: 'nonce-of-the-tab',
		});

		deepStrictEqual(resolved, undefined);
	});

	test('an id that belongs to another terminal is refused rather than stolen', async () => {
		const resolved = await resolve({
			live: new Map([[5, 'nonce-of-someone-else']]),
			id: 5,
			nonce: 'nonce-of-the-tab',
		});

		deepStrictEqual(resolved, PARADIS_UNRESOLVABLE_PTY_ID);
	});

	test('an id with no terminal behind it is left to fail on attach', async () => {
		// Nothing to steal, and upstream already answers a failed attach with a fresh shell.
		const resolved = await resolve({
			live: new Map(),
			id: 84,
			nonce: 'nonce-of-the-tab',
		});

		deepStrictEqual(resolved, undefined);
	});

	test('a stale revive entry does not outvote the terminal that holds the id now', async () => {
		// The revived terminal has since been closed and its id reused by an unrelated one.
		const resolved = await resolve({
			live: new Map([[2, 'nonce-of-someone-else'], [5, 'nonce-of-the-tab']]),
			revived: new Map([['nonce-of-the-tab', 2]]),
			id: 5,
			nonce: 'nonce-of-the-tab',
		});

		deepStrictEqual(resolved, undefined);
	});

	test('without a nonce nothing changes for callers that cannot supply one', async () => {
		const resolved = await resolve({
			live: new Map([[5, 'nonce-of-someone-else']]),
			id: 5,
		});

		deepStrictEqual(resolved, undefined);
	});

	test('only one renderer can claim the same orphan snapshot', async () => {
		const service = Object.create(PtyService.prototype) as PtyService;
		const orphanCheck = new DeferredPromise<boolean>();
		let attachCount = 0;
		const state = service as unknown as {
			_ptys: Map<number, {
				workspaceId: string;
				processLaunchOptions: { options: { shellIntegration: { nonce: string } } };
				isOrphaned(): Promise<boolean>;
				attach(): Promise<void>;
			}>;
			_paradisRevivedNewIdByNonce: Map<string, number>;
			_revivedPtyIdMap: Map<string, unknown>;
			_paradisOrphanAttachClaims: Map<number, number>;
			_logService: ILogService;
		};
		state._ptys = new Map([[7, {
			workspaceId: 'workspace',
			processLaunchOptions: { options: { shellIntegration: { nonce: 'nonce-a' } } },
			isOrphaned: () => orphanCheck.p,
			attach: async () => { attachCount++; },
		}]]);
		state._paradisRevivedNewIdByNonce = new Map([['nonce-a', 7]]);
		state._revivedPtyIdMap = new Map();
		state._paradisOrphanAttachClaims = new Map();
		state._logService = new NullLogService();
		Object.defineProperty(service, 'traceRpcArgs', { value: { logService: state._logService, simulatedLatency: 0 } });

		const first = service.paradisClaimAndAttachToProcess('workspace', 7, 'nonce-a');
		await Promise.resolve();
		await rejects(service.paradisClaimAndAttachToProcess('workspace', 7, 'nonce-a'), /already being attached/);
		orphanCheck.complete(true);

		strictEqual(await first, 7);
		strictEqual(attachCount, 1);
	});
});
