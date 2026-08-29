/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import assert from 'assert';
import * as sinon from 'sinon';
import { DeferredPromise, timeout } from '../../../../base/common/async.js';
import { Emitter } from '../../../../base/common/event.js';
import { DisposableStore, IDisposable, toDisposable } from '../../../../base/common/lifecycle.js';
import { NullLogService } from '../../../log/common/log.js';
import { IProductService } from '../../../product/common/productService.js';
import { IReconnectConstants, IShellLaunchConfig, ITerminalProcessOptions, TitleEventSource } from '../../common/terminal.js';
import { PtyService } from '../../node/ptyService.js';
import { paradisAdoptionSettled, paradisAwaitAdoption, paradisForgetHandle, paradisRememberHandle, paradisUsePtyDaemon } from '../../../../paradis/contrib/ptyDaemon/node/paradisTerminalProcessFactory.js';

/**
 * Covers taking a terminal back from the daemon that kept it running across an app update, from the
 * point of view of the window that wants to reattach to it.
 *
 * Adoption hands the terminal a *new* persistent process id, exactly as reviving one does. The
 * window, restoring an editor tab, only knows the id it was given generations ago plus the shell
 * integration nonce, and asks the pty host to translate. Two things have to hold for that to work,
 * and neither one is enough on its own:
 *
 *  1. adoption has to register the translation, and
 *  2. the question has to be answered *after* adoption, not while it is still running.
 *
 * With either missing, the window gives up and launches a fresh shell, while the process that was
 * just taken back sits in the pty host with nobody attached to it — alive, invisible, and counted by
 * the daemon. That is the state this suite exists to keep from coming back.
 */
// eslint-disable-next-line local/code-ensure-no-disposables-leak-in-test -- see the note on `store` below
suite('Para Code adopted pty reattach', () => {
	/**
	 * A plain store rather than `ensureNoDisposablesAreLeakedInTestSuite`.
	 *
	 * `PtyService.createProcess` leaks by construction upstream: `XtermSerializer` builds a
	 * `ShellIntegrationAddon` it never registers, and the six event subscriptions wired up around the
	 * new terminal are never held onto. None of that is reachable from here, and none of it is ours,
	 * so the tracker would only ever report upstream's bookkeeping. What this suite is for is the
	 * reattach path, not disposal.
	 */
	let store: DisposableStore;
	setup(() => { store = new DisposableStore(); });
	teardown(() => store.dispose());

	const RECONNECT: IReconnectConstants = { graceTime: 0, shortGraceTime: 0, scrollback: 100 };
	const PRODUCT = { quality: 'stable' } as IProductService;
	const SHELL: IShellLaunchConfig = { executable: '/bin/zsh', args: [], env: {} };
	const HANDLE = 7;
	const PID = 4242;
	const TITLE = 'codex';
	/** The id the restored tab remembers. Deliberately not the one adoption hands out. */
	const OLD_ID = 31;

	const EMPTY_DETAILS = {
		pid: -1, title: '', titleSource: TitleEventSource.Process, cwd: '/', isOrphan: false,
		icon: undefined, color: undefined, fixedDimensions: undefined, environmentVariableCollections: undefined,
		reconnectionProperties: undefined, waitOnExit: undefined, hideFromUser: false, isFeatureTerminal: false,
		type: undefined, hasChildProcesses: false, tabActions: undefined,
	};

	function options(nonce: string): ITerminalProcessOptions {
		return {
			shellIntegration: { enabled: true, suggestEnabled: false, nonce },
			windowsUseConptyDll: false,
			environmentVariableCollections: undefined,
			workspaceFolder: undefined,
			isScreenReaderOptimized: false,
		};
	}

	/**
	 * Stand a daemon connection up so `createProcess` builds a daemon-backed terminal rather than
	 * spawning a real shell. Nothing here is ever asked to do anything: the adopted terminal only
	 * talks to the daemon once a window opens it, which is exactly the state under test.
	 */
	function useDaemon(): { readonly layouts: string[] } {
		const layouts: string[] = [];
		const host = {
			onDidChangeData: store.add(new Emitter<never>()).event,
			onDidChangeTitle: store.add(new Emitter<never>()).event,
			onDidExit: store.add(new Emitter<never>()).event,
			setLayout: async (_workspaceId: string, encoded: string) => { layouts.push(encoded); },
		} as never;
		paradisUsePtyDaemon({ host, client: { onDidDispose: store.add(new Emitter<void>()).event } as never, viewer: 'viewer' });
		store.add(toDisposable(() => paradisUsePtyDaemon(undefined)));
		return { layouts };
	}

	/**
	 * A pty host built from the prototype rather than the constructor.
	 *
	 * `PtyService` cannot be constructed under the leak tracker: `_traceEvent` subscribes to all nine
	 * of its events and never releases those listeners, so every instance leaks nine disposables by
	 * construction. That is upstream's, not ours, and the sibling suite
	 * (`paradisRevivedPtyIdentity.test.ts`) already answers it the same way. The methods under test
	 * are the real ones — only the fields they read are supplied here.
	 */
	function service(): PtyService {
		const pty = Object.create(PtyService.prototype) as PtyService;
		const state = pty as unknown as Record<string, unknown>;
		state._lastPtyId = 0;
		state._ptys = new Map();
		state._revivedPtyIdMap = new Map();
		state._revivedPtyOldIdByNewId = new Map();
		state._paradisRevivedNewIdByNonce = new Map();
		state._paradisAdoptedNonces = new Set();
		state._workspaceLayoutInfos = new Map();
		state._contributions = [];
		state._logService = new NullLogService();
		state._productService = PRODUCT;
		state._reconnectConstants = RECONNECT;
		for (const name of ['_onProcessData', '_onProcessReplay', '_onProcessReady', '_onProcessExit', '_onProcessOrphanQuestion', '_onDidChangeProperty']) {
			state[name] = store.add(new Emitter<unknown>());
		}
		// `@traceRpc` wraps every RPC method and reads this before the call goes through; the real
		// property is a getter, so it has to be defined rather than assigned.
		Object.defineProperty(pty, 'traceRpcArgs', { value: { logService: state._logService, simulatedLatency: 0 } });
		return pty;
	}

	async function adopt(pty: PtyService, nonce: string, target?: { handle?: number; pid?: number; title?: string; exited?: { code: number | undefined } }): Promise<number> {
		const id = await pty.createProcess(
			SHELL, '/', 80, 24, '11', {}, {}, options(nonce), true, 'ws', 'para',
			undefined, undefined,
			{ handle: target?.handle ?? HANDLE, pid: target?.pid ?? PID, title: target?.title ?? TITLE, exited: target?.exited },
		);
		// Adoption registers the daemon handle alongside the new id; without it nothing downstream can
		// tell a daemon-held terminal from an ordinary one.
		paradisRememberHandle(id, target?.handle ?? HANDLE);
		store.add(toDisposable(() => paradisForgetHandle(id)));
		// In the running host the terminal takes itself down when the pty exits; here nothing ever
		// exits, so hand both halves to the store.
		const held = (pty as unknown as { _ptys: Map<number, IDisposable & { _terminalProcess: IDisposable }> })._ptys.get(id)!;
		store.add(held);
		store.add(held._terminalProcess);
		return id;
	}

	/** Upstream's other way of making a terminal: start a shell from a saved screenful. */
	function revive(pty: PtyService, nonce: string): Promise<void> {
		return pty.reviveTerminalProcesses('ws', [{
			id: OLD_ID,
			shellLaunchConfig: SHELL,
			processDetails: { ...EMPTY_DETAILS, id: OLD_ID, workspaceId: 'ws', workspaceName: 'para', shellIntegrationNonce: nonce },
			processLaunchConfig: { env: {}, executableEnv: {}, options: options(nonce) },
			unicodeVersion: '11',
			replayEvent: { events: [{ cols: 80, rows: 24, data: 'saved screen' }], commands: { commands: [], isWindowsPty: false, hasRichCommandDetection: false, promptInputModel: undefined } },
			timestamp: 0,
		}], 'en');
	}

	teardown(() => {
		paradisAwaitAdoption(undefined);
	});

	test('a tab restored across an update finds the terminal that was taken back', async () => {
		useDaemon();
		const pty = service();
		const newId = await adopt(pty, 'nonce-of-the-tab');

		// This is the whole reattach path in one call: the tab asks with the id it remembers and the
		// nonce it recorded, and gets back the id the terminal has now.
		const resolved = await pty.getRevivedPtyNewId('ws', OLD_ID, 'nonce-of-the-tab');

		assert.deepStrictEqual({ resolved, newId }, { resolved: newId, newId });
	});

	test('reattach questions are not answered while terminals are still being taken back', async () => {
		useDaemon();
		const pty = service();
		const adopting = new DeferredPromise<void>();
		paradisAwaitAdoption(adopting.p);

		// Every entry point a reconnecting window uses. Answering any of them early answers "there is
		// no such terminal", and upstream turns that into a brand new shell.
		const asked = [
			pty.getRevivedPtyNewId('ws', OLD_ID, 'nonce-of-the-tab'),
			pty.listProcesses(),
			pty.attachToProcess(OLD_ID).then(() => undefined, () => undefined),
		];
		const settled = asked.map(() => false);
		asked.forEach((promise, index) => void promise.then(() => { settled[index] = true; }));
		await timeout(0);
		const beforeAdoption = [...settled];

		adopting.complete();
		await Promise.all(asked);

		assert.deepStrictEqual(
			{ beforeAdoption, afterAdoption: settled },
			{ beforeAdoption: [false, false, false], afterAdoption: [true, true, true] },
		);
	});

	test('when two held terminals share a nonce, the one that kept running wins', async () => {
		// A failed reconnect leaves the daemon holding both: upstream relaunches the tab when attach
		// fails, and the replacement keeps the instance's nonce. Measured on a real daemon — twenty
		// pairs of it — so this is the state the fix actually lands in.
		useDaemon();
		const pty = service();
		const original = await adopt(pty, 'nonce-of-the-tab', { handle: 3, pid: PID, title: 'codex' });
		const replacement = await adopt(pty, 'nonce-of-the-tab', { handle: 47, pid: 84115, title: 'zsh' });

		const resolved = await pty.getRevivedPtyNewId('ws', OLD_ID, 'nonce-of-the-tab');

		// The empty shell is the one we are willing to lose.
		assert.deepStrictEqual({ resolved, original, replacement }, { resolved: original, original, replacement });
	});

	test('a revived shell does not take the tab away from the process that never stopped', async () => {
		// Both write the same table. A revive can land either side of adoption, so order cannot be
		// what decides between a process that kept running and a shell restarted from a saved screen.
		useDaemon();
		const pty = service();
		const adopted = await adopt(pty, 'nonce-of-the-tab');
		await revive(pty, 'nonce-of-the-tab');

		const resolved = await pty.getRevivedPtyNewId('ws', OLD_ID, 'nonce-of-the-tab');

		assert.deepStrictEqual({ resolved, adopted }, { resolved: adopted, adopted });
	});

	test('a layout that leaves out a terminal the daemon holds is not taken as the whole picture', async () => {
		// A window re-seeds the layout it saved before the update, in ids from a pty host that no
		// longer exists. Those ids are small integers from a counter that restarts, so they land on
		// today's terminals by coincidence — which is why "does it name anything we know" is not a
		// usable test, and "does it account for what the daemon holds" is.
		const daemon = useDaemon();
		const pty = service();
		const adopted = await adopt(pty, 'nonce-of-the-tab');
		const restored = { workspaceId: 'ws', tabs: [{ isActive: true, activePersistentProcessId: adopted, terminals: [{ relativeSize: 1, terminal: adopted }] }], background: [] };
		await pty.setTerminalLayoutInfo(restored);
		const afterRestore = [...daemon.layouts];

		await pty.setTerminalLayoutInfo({ workspaceId: 'ws', tabs: [{ isActive: true, activePersistentProcessId: OLD_ID, terminals: [{ relativeSize: 1, terminal: OLD_ID }] }], background: [] });
		const kept = (pty as unknown as { _workspaceLayoutInfos: Map<string, unknown> })._workspaceLayoutInfos.get('ws');

		// An empty layout is what tells the daemon to forget the one it keeps, so the second call must
		// leave no trace at all — in memory or on the daemon.
		assert.deepStrictEqual({ kept, told: daemon.layouts }, { kept: restored, told: afterRestore });
	});

	test('taking terminals back records the layout here without handing it to the daemon', async () => {
		// What adoption passes back is the daemon's own layout with every terminal it could not take
		// back dropped from it. Writing that over the original turns "we could not reach it this time"
		// into "it was never there", and no later launch can undo that.
		const daemon = useDaemon();
		const pty = service();
		const adopted = await adopt(pty, 'nonce-of-the-tab');
		const restored = { workspaceId: 'ws', tabs: [{ isActive: true, activePersistentProcessId: adopted, terminals: [{ relativeSize: 1, terminal: adopted }] }], background: [] };

		pty.paradisSetTerminalLayoutInfo(restored);

		assert.deepStrictEqual(
			{ kept: (pty as unknown as { _workspaceLayoutInfos: Map<string, unknown> })._workspaceLayoutInfos.get('ws'), told: daemon.layouts },
			{ kept: restored, told: [] },
		);
	});

	test('a window that restored nothing does not make the daemon forget what it holds', async () => {
		// Taking the terminals back can run past its deadline, and then the window comes up with none
		// of them and saves an empty layout. Recording that erases the only durable record of where
		// the running processes belong, on this launch and every later one.
		const daemon = useDaemon();
		const pty = service();
		await adopt(pty, 'nonce-of-the-tab');

		await pty.setTerminalLayoutInfo({ workspaceId: 'ws', tabs: [], background: [] });

		assert.deepStrictEqual(
			{ kept: (pty as unknown as { _workspaceLayoutInfos: Map<string, unknown> })._workspaceLayoutInfos.get('ws'), told: daemon.layouts },
			{ kept: undefined, told: [] },
		);
	});

	test('a window emptying its layout is recorded when the daemon holds nothing here', async () => {
		// With nothing held, an empty layout is simply a window saying its terminals are gone — and
		// dropping that would leave a layout nobody can ever clear.
		const daemon = useDaemon();
		const pty = service();
		const empty = { workspaceId: 'ws', tabs: [], background: [] };
		await pty.setTerminalLayoutInfo(empty);

		assert.deepStrictEqual(
			{ kept: (pty as unknown as { _workspaceLayoutInfos: Map<string, unknown> })._workspaceLayoutInfos.get('ws'), told: daemon.layouts },
			{ kept: empty, told: [''] },
		);
	});

	test('giving up on adoption gives up for good rather than costing every later call', async () => {
		const adopting = new DeferredPromise<void>();
		paradisAwaitAdoption(adopting.p);
		const clock = sinon.useFakeTimers({ shouldAdvanceTime: true });
		store.add(toDisposable(() => clock.restore()));

		const first = paradisAdoptionSettled();
		await clock.tickAsync(3_000);
		await first;

		// The daemon never answered. Waiting again cannot make it answer, and a pty host lives for
		// days — so the second call must not pay the timeout again.
		const before = Date.now();
		await paradisAdoptionSettled();
		const waitedAgain = Date.now() - before;

		assert.deepStrictEqual({ waitedAgain: waitedAgain < 50 }, { waitedAgain: true });
	});

	test('a terminal that was taken back can be told apart before anyone opens it', async () => {
		useDaemon();
		const pty = service();
		const newId = await adopt(pty, 'nonce-of-the-tab');

		// `listProcesses` copies these two straight out, but calling it here would sit on the four
		// second orphan barrier waiting for a renderer that does not exist in this test.
		const held = (pty as unknown as { _ptys: Map<number, { pid: number; title: string }> })._ptys.get(newId);

		// Without this, every terminal held by the daemon lists itself as pid -1 with no title, and
		// the one list that shows them is the list someone reads to pick one out.
		assert.deepStrictEqual({ pid: held?.pid, title: held?.title }, { pid: PID, title: TITLE });
	});
});
