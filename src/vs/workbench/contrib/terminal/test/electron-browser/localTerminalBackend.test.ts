/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { deepStrictEqual } from 'assert';
import { DeferredPromise } from '../../../../../base/common/async.js';
import { Event } from '../../../../../base/common/event.js';
import { upcastPartial } from '../../../../../base/test/common/mock.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { TestInstantiationService } from '../../../../../platform/instantiation/test/common/instantiationServiceMock.js';
import { NullLogService } from '../../../../../platform/log/common/log.js';
import { ILocalPtyService, ITerminalChildProcess, ITerminalLogService } from '../../../../../platform/terminal/common/terminal.js';
import { IWorkspaceContextService } from '../../../../../platform/workspace/common/workspace.js';
import { TestContextService } from '../../../../test/common/workbenchTestServices.js';
import { LocalPty } from '../../electron-browser/localPty.js';
import { LocalTerminalBackend } from '../../electron-browser/localTerminalBackend.js';
// PARA-PATCH: the fork's backend also depends on the remote agent service (see openParadisReviveGate)
import { IRemoteAgentService } from '../../../../services/remote/common/remoteAgentService.js';

suite('LocalTerminalBackend', () => {
	const store = ensureNoDisposablesAreLeakedInTestSuite();

	test('attachToRevivedProcess only falls back to the original process when it still has the saved pid', async () => {
		const livePids = new Map([[1, 101], [2, 202], [3, 303]]);
		const revivedIds = new Map([[7, 1], [2, 2], [8, 5]]);
		const attachRequests: [id: number, pid: number | undefined][] = [];

		const instantiationService = store.add(new TestInstantiationService());
		instantiationService.stub(IWorkspaceContextService, new TestContextService());
		instantiationService.stub(ITerminalLogService, new NullLogService());
		instantiationService.stub(ILocalPtyService, upcastPartial<ILocalPtyService>({
			onPtyHostExit: Event.None,
			onPtyHostStart: Event.None,
			onPtyHostUnresponsive: Event.None,
			onPtyHostResponsive: Event.None,
			onPtyHostRequestResolveVariables: Event.None,
			getRevivedPtyNewId: async (_workspaceId: string, id: number) => revivedIds.get(id),
			attachToProcess: async (id: number, pid?: number) => {
				attachRequests.push([id, pid]);
				const livePid = livePids.get(id);
				if (livePid === undefined) {
					throw new Error(`Could not find pty ${id} on pty host`);
				}
				if (pid !== undefined && pid !== livePid) {
					throw new Error(`Pty ${id} has pid ${livePid}, expected ${pid}`);
				}
			}
		}));
		instantiationService.stub(IRemoteAgentService, upcastPartial<IRemoteAgentService>({ getConnection: () => null })); // PARA-PATCH: see openParadisReviveGate
		const backend = store.add(instantiationService.createInstance(LocalTerminalBackend));
		// Treat the pty host as connected so requests go to the local pty service stub
		const connected = new DeferredPromise<void>();
		await connected.complete();
		Reflect.set(backend, '_directProxyClientEventually', connected);
		openParadisReviveGate(backend); // PARA-PATCH: see openParadisReviveGate

		async function attach(attachToProcess: () => Promise<ITerminalChildProcess | undefined>) {
			attachRequests.length = 0;
			const pty = await attachToProcess();
			if (pty instanceof LocalPty) {
				store.add(pty);
			}
			return { attachedId: pty?.id, requests: [...attachRequests] };
		}

		deepStrictEqual({
			revivedWithNewId: await attach(() => backend.attachToRevivedProcess(7, 7007)),
			revivedWithSameId: await attach(() => backend.attachToRevivedProcess(2, 2002)),
			revivedButMissing: await attach(() => backend.attachToRevivedProcess(8, 8008)),
			originalWithSavedPid: await attach(() => backend.attachToRevivedProcess(3, 303)),
			originalWithOtherPid: await attach(() => backend.attachToRevivedProcess(3, 9009)),
			originalWithUnknownPid: await attach(() => backend.attachToRevivedProcess(3, 0)),
			originalWithNegativePid: await attach(() => backend.attachToRevivedProcess(3, -1)),
			originalMissing: await attach(() => backend.attachToRevivedProcess(4, 404)),
			attachById: await attach(() => backend.attachToProcess(3)),
		}, {
			revivedWithNewId: { attachedId: 1, requests: [[1, undefined]] },
			revivedWithSameId: { attachedId: 2, requests: [[2, undefined]] },
			revivedButMissing: { attachedId: undefined, requests: [[5, undefined]] },
			originalWithSavedPid: { attachedId: 3, requests: [[3, 303]] },
			originalWithOtherPid: { attachedId: undefined, requests: [[3, 9009]] },
			originalWithUnknownPid: { attachedId: 3, requests: [[3, undefined]] },
			originalWithNegativePid: { attachedId: 3, requests: [[3, undefined]] },
			originalMissing: { attachedId: undefined, requests: [[4, 404]] },
			attachById: { attachedId: 3, requests: [[3, undefined]] },
		});
	});

	// PARA-PATCH: a valid shell integration nonce decides which terminal a restored tab means, so the
	// saved pid is not checked then: a terminal a pty daemon took back may report a different pid.
	test('attachToRevivedProcess checks the saved pid only when there is no valid nonce', async () => {
		const livePids = new Map([[3, 303]]);
		const nonceById = new Map([[3, 'nonce-3']]);
		const attachRequests: [id: number, pid: number | undefined][] = [];

		const instantiationService = store.add(new TestInstantiationService());
		instantiationService.stub(IWorkspaceContextService, new TestContextService());
		instantiationService.stub(ITerminalLogService, new NullLogService());
		instantiationService.stub(IRemoteAgentService, upcastPartial<IRemoteAgentService>({ getConnection: () => null }));
		instantiationService.stub(ILocalPtyService, upcastPartial<ILocalPtyService>({
			onPtyHostExit: Event.None,
			onPtyHostStart: Event.None,
			onPtyHostUnresponsive: Event.None,
			onPtyHostResponsive: Event.None,
			onPtyHostRequestResolveVariables: Event.None,
			// Same answers as PtyService: `undefined` when the id still carries the nonce, an id that
			// cannot exist when it names another terminal.
			getRevivedPtyNewId: async (_workspaceId: string, id: number, nonce?: string) => !nonce || nonceById.get(id) === nonce ? undefined : -1,
			attachToProcess: async (id: number, pid?: number) => {
				attachRequests.push([id, pid]);
				const livePid = livePids.get(id);
				if (livePid === undefined) {
					throw new Error(`Could not find pty ${id} on pty host`);
				}
				if (pid !== undefined && pid !== livePid) {
					throw new Error(`Pty ${id} has pid ${livePid}, expected ${pid}`);
				}
			}
		}));
		const backend = store.add(instantiationService.createInstance(LocalTerminalBackend));
		const connected = new DeferredPromise<void>();
		await connected.complete();
		Reflect.set(backend, '_directProxyClientEventually', connected);
		openParadisReviveGate(backend);

		async function attach(attachToProcess: () => Promise<ITerminalChildProcess | undefined>) {
			attachRequests.length = 0;
			const pty = await attachToProcess();
			if (pty instanceof LocalPty) {
				store.add(pty);
			}
			return { attachedId: pty?.id, requests: [...attachRequests] };
		}

		deepStrictEqual({
			nonceMatchesOtherPid: await attach(() => backend.attachToRevivedProcess(3, 9009, 'nonce-3')),
			nonceNamesAnotherTerminal: await attach(() => backend.attachToRevivedProcess(3, 303, 'nonce-other')),
			invalidNonceOtherPid: await attach(() => backend.attachToRevivedProcess(3, 9009, '')),
		}, {
			nonceMatchesOtherPid: { attachedId: 3, requests: [[3, undefined]] },
			nonceNamesAnotherTerminal: { attachedId: undefined, requests: [[-1, undefined]] },
			invalidNonceOtherPid: { attachedId: undefined, requests: [[3, 9009]] },
		});
	});
});

/** PARA-PATCH: the fork's backend holds editor tabs until the startup revive is done; these tests have none. */
function openParadisReviveGate(backend: LocalTerminalBackend): void {
	(Reflect.get(backend, '_paradisReviveGate') as { open(): void }).open();
}
