/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as assert from 'assert';
import { DeferredPromise } from '../../../../../base/common/async.js';
import { Emitter } from '../../../../../base/common/event.js';
import { DisposableStore } from '../../../../../base/common/lifecycle.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { ISharedProcessService } from '../../../../../platform/ipc/electron-browser/services.js';
import { IBrowserViewModel, IBrowserViewWorkbenchService } from '../../../../../workbench/contrib/browserView/common/browserView.js';
import { ITerminalGroupService, ITerminalInstance, ITerminalService } from '../../../../../workbench/contrib/terminal/browser/terminal.js';
import { IParadisPaneTokenService } from '../../browser/paradisPaneTokenService.js';
import { IParadisCommitBindResult, IParadisPaneBinding, IParadisPrepareBindRequest, IParadisPrepareBindResult } from '../../common/paradisAgentBrowser.js';
import { IParadisAgentBrowserAuthoritySyncService } from '../../electron-browser/paradisAgentBrowserAuthoritySyncService.js';
import { IParadisAgentBrowserBindingModelOptions, IParadisAgentBrowserBindingPollTimer, ParadisAgentBrowserBindingModel, ParadisAgentBrowserBindingPoller, ParadisAgentBrowserBindingTokenRefreshCoalescer } from '../../electron-browser/paradisAgentBrowserBindingModel.js';
import { IParadisBrowserScopeService, IParadisTerminalScopeService, ParadisBindingScope } from '../../../workspaceSwitch/common/paradisWorkspaceSwitch.js';

async function eventually(predicate: () => boolean): Promise<void> {
	for (let attempt = 0; attempt < 100; attempt++) {
		if (predicate()) {
			return;
		}
		await new Promise<void>(resolve => setTimeout(resolve, 0));
	}
	assert.fail('condition was not reached');
}

const nextTask = () => new Promise<void>(resolve => setTimeout(resolve, 0));

class DeterministicPollTimer implements IParadisAgentBrowserBindingPollTimer {
	private now = 0;
	private nextHandle = 1;
	private readonly entries = new Map<number, { deadline: number; callback: () => void }>();
	fireCount = 0;
	setCallCount = 0;

	set(callback: () => void, delayMs: number): unknown {
		this.setCallCount++;
		const handle = this.nextHandle++;
		this.entries.set(handle, { deadline: this.now + delayMs, callback });
		return handle;
	}

	clear(handle: unknown): void {
		this.entries.delete(handle as number);
	}

	advance(ms: number): void {
		const target = this.now + ms;
		for (let next = this.nextDue(target); next; next = this.nextDue(target)) {
			this.now = next.deadline;
			this.entries.delete(next.handle);
			this.fireCount++;
			next.callback();
		}
		this.now = target;
	}

	private nextDue(target: number): { handle: number; deadline: number; callback: () => void } | undefined {
		return [...this.entries].map(([handle, entry]) => ({ handle, ...entry }))
			.filter(entry => entry.deadline <= target)
			.sort((left, right) => left.deadline - right.deadline || left.handle - right.handle)[0];
	}

	get pendingHandleCount(): number {
		return this.entries.size;
	}

	get nextDelay(): number | undefined {
		const deadline = Math.min(...[...this.entries.values()].map(entry => entry.deadline));
		return Number.isFinite(deadline) ? deadline - this.now : undefined;
	}
}

function deferredQueue<T>() {
	const reads: DeferredPromise<T>[] = [];
	return {
		reads,
		read: () => {
			const read = new DeferredPromise<T>();
			reads.push(read);
			return read.p;
		},
		complete: async (index: number, value: T) => {
			assert.ok(reads[index]);
			await reads[index].complete(value);
		},
		reject: async (index: number, error: Error) => {
			assert.ok(reads[index]);
			await reads[index].error(error);
		},
	};
}

const bindingListCommands = (commands: readonly { command: string }[]) =>
	commands.filter(call => call.command === 'listBindings' || call.command === 'listSeenTokens').map(call => call.command);

suite('ParadisAgentBrowserBindingModel transactions', () => {
	const store = ensureNoDisposablesAreLeakedInTestSuite();

	function createFixture(options?: {
		prepare?: (request: IParadisPrepareBindRequest) => Promise<IParadisPrepareBindResult>;
		commit?: (ticketId: string, request: IParadisPrepareBindRequest) => Promise<IParadisCommitBindResult>;
		listBindings?: () => Promise<IParadisPaneBinding[]>;
		listSeenTokens?: () => Promise<string[]>;
		hasPaneTokens?: boolean;
		pollTimer?: DeterministicPollTimer;
		tokenRefreshTimer?: DeterministicPollTimer;
		store?: DisposableStore;
	}) {
		const fixtureStore = options?.store ?? store;
		const terminalScopeChanged = fixtureStore.add(new Emitter<{ instanceId: number; scope?: unknown }>());
		const browserScopeChanged = fixtureStore.add(new Emitter<{ viewId: string; scope?: unknown }>());
		const browserViewsChanged = fixtureStore.add(new Emitter<void>());
		const paneTokensChanged = fixtureStore.add(new Emitter<void>());
		const terminalInstancesChanged = fixtureStore.add(new Emitter<void>());
		const terminalTitlesChanged = fixtureStore.add(new Emitter<ITerminalInstance>());
		const instance = { instanceId: 1, title: 'shell', isDisposed: false, processId: 101 } as ITerminalInstance;
		const secondInstance = { instanceId: 2, title: 'shell', isDisposed: false, processId: 102 } as ITerminalInstance;
		const paneTokens = new Map<number, string>(options?.hasPaneTokens === false ? [] : [[1, 'token'], [2, 'token-b']]);
		let terminalScope: ParadisBindingScope = { kind: 'managed', stateKey: 'space-a' };
		let browserScope: ParadisBindingScope = { kind: 'managed', stateKey: 'space-a' };
		let terminalRevision = 1;
		let browserRevision = 1;
		let acceptedRevision = 10;
		const order: string[] = [];
		const commands: Array<{ command: string; args: unknown[] }> = [];
		const sharingCalls: boolean[] = [];
		let backendBindings: IParadisPaneBinding[] = [];
		let nextTicketId = 1;
		const requestsByTicketId = new Map<string, IParadisPrepareBindRequest>();
		const model = {
			id: 'view-a', url: 'https://example.test', title: 'Example',
			setSharedWithAgent: async (shared: boolean) => {
				sharingCalls.push(shared);
				order.push(`share:${shared}`);
				return true;
			},
		} as unknown as IBrowserViewModel;
		const knownBrowserViews = new Map([['view-a', { model }]]);

		const channel = {
			call: async <T>(command: string, args: unknown[] = []) => {
				commands.push({ command, args });
				switch (command) {
					case 'listBindings': return [...(await (options?.listBindings?.() ?? Promise.resolve(backendBindings)))] as T;
					case 'listSeenTokens': return await (options?.listSeenTokens?.() ?? Promise.resolve([])) as T;
					case 'prepareBind': {
						order.push('prepare');
						const request = args[0] as IParadisPrepareBindRequest;
						const prepared = await (options?.prepare?.(request) ?? Promise.resolve({
							ticketId: `ticket-${nextTicketId++}`, expiresAt: Date.now() + 10_000,
							revision: request.revision, scope: { kind: 'managed', stateKey: 'space-a' },
						}));
						requestsByTicketId.set(prepared.ticketId, request);
						return prepared as T;
					}
					case 'commitBind': {
						order.push('commit');
						const ticketId = (args[0] as { ticketId: string }).ticketId;
						const request = requestsByTicketId.get(ticketId);
						if (!request) {
							throw new Error(`missing prepare request for ${ticketId}`);
						}
						const result = await (options?.commit?.(ticketId, request) ?? Promise.resolve({
							committed: true as const,
							binding: {
								token: request.token, pageId: request.viewId, pageInfo: { url: model.url, title: model.title },
								generation: 2, boundAt: 2, scope: { kind: 'managed' as const, stateKey: 'space-a' },
							},
						}));
						backendBindings = [...backendBindings.filter(binding => binding.token !== result.binding.token), result.binding];
						return result as T;
					}
					case 'abortBind':
						order.push('abort');
						return { aborted: true } as T;
					case 'unbindIfCurrent': {
						order.push('unbind');
						const [token, generation] = args as [string, number];
						const before = backendBindings.length;
						backendBindings = backendBindings.filter(binding => binding.token !== token || binding.generation !== generation);
						return (backendBindings.length !== before) as T;
					}
					case 'unbind': {
						order.push('unbind');
						const token = args[0] as string;
						backendBindings = backendBindings.filter(binding => binding.token !== token);
						return true as T;
					}
					default: throw new Error(`unexpected command: ${command}`);
				}
			},
		};
		const authoritySyncService = {
			get acceptedRevision() { return acceptedRevision; },
			isFrozen: false,
			syncNow: async () => {
				order.push('sync');
				return acceptedRevision;
			},
		} as IParadisAgentBrowserAuthoritySyncService;
		const sharedProcessService = { getChannel: () => channel } as unknown as ISharedProcessService;
		const terminalService = {
			instances: [instance, secondInstance], onDidChangeInstances: terminalInstancesChanged.event,
			onAnyInstanceTitleChange: terminalTitlesChanged.event,
		} as unknown as ITerminalService;
		const terminalGroupService = { paradisParkedGroups: [] } as unknown as ITerminalGroupService;
		const paneTokenService = {
			getTokenForInstance: (instanceId: number) => paneTokens.get(instanceId),
			getInstanceForToken: (token: string) => [...paneTokens].find(([, candidate]) => candidate === token)?.[0],
			listPaneTokens: () => [...paneTokens].map(([instanceId, token]) => ({ instanceId, token })),
			onDidChange: paneTokensChanged.event,
		} as unknown as IParadisPaneTokenService;
		const browserViewWorkbenchService = {
			getKnownBrowserViews: () => knownBrowserViews,
			onDidChangeBrowserViews: browserViewsChanged.event,
		} as unknown as IBrowserViewWorkbenchService;
		const terminalScopeService = {
			get revision() { return terminalRevision; },
			resolveScope: () => terminalScope,
			onDidChangeStableScope: terminalScopeChanged.event,
		} as unknown as IParadisTerminalScopeService;
		const browserScopeService = {
			get revision() { return browserRevision; },
			resolveScope: () => browserScope,
			onDidChangeStableScope: browserScopeChanged.event,
		} as unknown as IParadisBrowserScopeService;
		const pollTimer = options?.pollTimer;
		const tokenRefreshTimer = options?.tokenRefreshTimer;
		const modelOptions: IParadisAgentBrowserBindingModelOptions | undefined = pollTimer || tokenRefreshTimer ? {
			pollTimerFactory: pollTimer ? () => pollTimer : undefined,
			tokenRefreshTimerFactory: tokenRefreshTimer ? () => tokenRefreshTimer : undefined,
		} : undefined;
		const bindingModel = fixtureStore.add(new ParadisAgentBrowserBindingModel(modelOptions,
			sharedProcessService, terminalService, terminalGroupService, paneTokenService,
			browserViewWorkbenchService, terminalScopeService, browserScopeService, authoritySyncService));
		let changeCount = 0;
		fixtureStore.add(bindingModel.onDidChange(() => changeCount++));

		return {
			bindingModel, model, order, commands, sharingCalls, terminalScopeChanged, browserScopeChanged,
			paneTokens, paneTokensChanged, terminalTitlesChanged, instances: { first: instance, second: secondInstance },
			get changeCount() { return changeCount; },
			resetChangeCount: () => changeCount = 0,
			set terminalScope(value: ParadisBindingScope) { terminalScope = value; terminalRevision++; },
			set browserScope(value: ParadisBindingScope) { browserScope = value; browserRevision++; },
			set acceptedRevision(value: number) { acceptedRevision = value; },
			set backendBindings(value: IParadisPaneBinding[]) { backendBindings = value; },
			get backendBindings() { return backendBindings; },
		};
	}

	function binding(generation: number = 1): IParadisPaneBinding {
		return {
			token: 'token', pageId: 'view-a', pageInfo: { url: 'https://example.test', title: 'Example' },
			generation, boundAt: 1, scope: { kind: 'managed', stateKey: 'space-a' },
		};
	}

	function bindingRow(token: string, pageId: string, generation: number): IParadisPaneBinding {
		return {
			token,
			pageId,
			pageInfo: { url: `https://${pageId}.test`, title: pageId },
			generation,
			boundAt: generation,
			scope: { kind: 'managed', stateKey: 'space-a' },
		};
	}

	test('polls clean idle twice and fast state twenty times per minute', () => {
		for (const [idle, expected] of [[true, 2], [false, 20]] as const) {
			const timer = new DeterministicPollTimer();
			let refreshes = 0;
			const poller = new ParadisAgentBrowserBindingPoller(() => refreshes++, () => idle, timer);
			try {
				poller.start();
				refreshes = 0;
				timer.advance(60_000);
				assert.deepStrictEqual({ refreshes, fires: timer.fireCount }, { refreshes: expected, fires: expected });
			} finally {
				poller.dispose();
				assert.strictEqual(timer.pendingHandleCount, 0);
			}
		}
	});

	test('moves an idle deadline to the fast cadence when state changes', () => {
		const timer = new DeterministicPollTimer();
		let idle = true;
		const poller = new ParadisAgentBrowserBindingPoller(() => undefined, () => idle, timer);
		try {
			poller.start();
			assert.strictEqual(timer.nextDelay, 30_000);
			idle = false;
			poller.stateChanged();
			assert.deepStrictEqual({ delay: timer.nextDelay, pending: timer.pendingHandleCount }, { delay: 3_000, pending: 1 });
		} finally {
			poller.dispose();
			assert.strictEqual(timer.pendingHandleCount, 0);
		}
	});

	test('moves a fast deadline to the idle cadence when state changes', () => {
		const timer = new DeterministicPollTimer();
		let idle = false;
		const poller = new ParadisAgentBrowserBindingPoller(() => undefined, () => idle, timer);
		try {
			poller.start();
			assert.strictEqual(timer.nextDelay, 3_000);
			idle = true;
			poller.stateChanged();
			assert.deepStrictEqual({ delay: timer.nextDelay, pending: timer.pendingHandleCount }, { delay: 30_000, pending: 1 });
		} finally {
			poller.dispose();
			assert.strictEqual(timer.pendingHandleCount, 0);
		}
	});

	test('does not postpone a deadline for same-cadence state changes', () => {
		const timer = new DeterministicPollTimer();
		const poller = new ParadisAgentBrowserBindingPoller(() => undefined, () => false, timer);
		try {
			poller.start();
			timer.advance(1_000);
			for (let event = 0; event < 100; event++) {
				poller.stateChanged();
			}
			assert.deepStrictEqual({ delay: timer.nextDelay, sets: timer.setCallCount }, { delay: 2_000, sets: 1 });
		} finally {
			poller.dispose();
			assert.strictEqual(timer.pendingHandleCount, 0);
		}
	});

	test('keeps one handle when refresh synchronously changes poll state or throws', () => {
		for (const action of ['stateChanged', 'throw'] as const) {
			const timer = new DeterministicPollTimer();
			const poller = new ParadisAgentBrowserBindingPoller(() => {
				if (action === 'stateChanged') {
					poller.stateChanged();
				} else {
					throw new Error('sync refresh');
				}
			}, () => false, timer);
			try {
				if (action === 'throw') {
					assert.throws(() => poller.start(), /sync refresh/);
				} else {
					poller.start();
				}
				assert.strictEqual(timer.pendingHandleCount, 1);
				if (action === 'stateChanged') {
					timer.advance(3_000);
					assert.strictEqual(timer.pendingHandleCount, 1);
				}
			} finally {
				poller.dispose();
				assert.strictEqual(timer.pendingHandleCount, 0);
			}
		}
	});

	test('synchronous refresh disposal leaves no poll handle', () => {
		const timer = new DeterministicPollTimer();
		let requests = 0;
		const poller = new ParadisAgentBrowserBindingPoller(() => {
			if (++requests === 2) {
				poller.dispose();
			}
		}, () => false, timer);
		poller.start();
		assert.strictEqual(timer.pendingHandleCount, 1);
		timer.advance(3_000);
		assert.strictEqual(timer.pendingHandleCount, 0);
	});

	test('coalesces one hundred schedule calls into one zero millisecond dispatch', () => {
		const timer = new DeterministicPollTimer();
		let dispatches = 0;
		const coalescer = new ParadisAgentBrowserBindingTokenRefreshCoalescer(() => dispatches++, timer);
		try {
			for (let event = 0; event < 100; event++) {
				coalescer.schedule();
			}
			assert.deepStrictEqual(
				{ sets: timer.setCallCount, pending: timer.pendingHandleCount, dispatches },
				{ sets: 1, pending: 1, dispatches: 0 },
			);
			timer.advance(0);
			assert.deepStrictEqual({ pending: timer.pendingHandleCount, dispatches }, { pending: 0, dispatches: 1 });
		} finally {
			coalescer.dispose();
			assert.strictEqual(timer.pendingHandleCount, 0);
		}
	});

	test('cancels a pending coalesced refresh on disposal', () => {
		const timer = new DeterministicPollTimer();
		let dispatches = 0;
		const coalescer = new ParadisAgentBrowserBindingTokenRefreshCoalescer(() => dispatches++, timer);
		coalescer.schedule();
		coalescer.dispose();
		timer.advance(0);
		assert.deepStrictEqual({ sets: timer.setCallCount, pending: timer.pendingHandleCount, dispatches }, { sets: 1, pending: 0, dispatches: 0 });
	});

	test('disposes the injected model poll timer', () => {
		const fixtureStore = new DisposableStore();
		const pollTimer = new DeterministicPollTimer();
		try {
			createFixture({ pollTimer, store: fixtureStore });
			assert.strictEqual(pollTimer.pendingHandleCount, 1);
		} finally {
			fixtureStore.dispose();
			assert.strictEqual(pollTimer.pendingHandleCount, 0);
		}
	});

	test('fires title changes only for terminal instances that currently own pane tokens', async () => {
		const fixtureStore = new DisposableStore();
		try {
			const fixture = createFixture({ store: fixtureStore, pollTimer: new DeterministicPollTimer() });
			await nextTask();
			fixture.resetChangeCount();
			fixture.paneTokens.delete(fixture.instances.second.instanceId);
			fixture.terminalTitlesChanged.fire(fixture.instances.second);
			await new Promise<void>(resolve => setTimeout(resolve, 120));
			assert.strictEqual(fixture.changeCount, 0);
			fixture.terminalTitlesChanged.fire(fixture.instances.first);
			await new Promise<void>(resolve => setTimeout(resolve, 120));
			assert.strictEqual(fixture.changeCount, 1);
		} finally {
			fixtureStore.dispose();
		}
	});

	test('keeps pane token add and remove notifications independent of title filtering', async () => {
		const fixtureStore = new DisposableStore();
		try {
			const fixture = createFixture({ store: fixtureStore, pollTimer: new DeterministicPollTimer() });
			await nextTask();
			fixture.resetChangeCount();
			fixture.paneTokens.delete(fixture.instances.second.instanceId);
			fixture.paneTokensChanged.fire();
			await new Promise<void>(resolve => setTimeout(resolve, 120));
			assert.strictEqual(fixture.changeCount, 1);
			fixture.resetChangeCount();
			fixture.paneTokens.set(fixture.instances.second.instanceId, 'token-b');
			fixture.paneTokensChanged.fire();
			await new Promise<void>(resolve => setTimeout(resolve, 120));
			assert.strictEqual(fixture.changeCount, 1);
		} finally {
			fixtureStore.dispose();
		}
	});

	test('uses only sync, prepare, and commit after page sharing', async () => {
		const fixture = createFixture();
		await fixture.bindingModel.refresh();
		fixture.order.length = 0;
		fixture.commands.length = 0;

		assert.strictEqual(await fixture.bindingModel.bindPageToPane(fixture.model, 'token'), true);

		assert.deepStrictEqual(fixture.order.slice(0, 4), ['share:true', 'sync', 'prepare', 'commit']);
		assert.strictEqual(fixture.commands.some(call => call.command === 'bind'), false);
		const prepare = fixture.commands.find(call => call.command === 'prepareBind');
		assert.deepStrictEqual(prepare?.args, [{
			revision: 10, token: 'token', viewId: 'view-a',
			pageInfo: { url: 'https://example.test', title: 'Example' },
		}]);
	});

	test('serializes bind operations for the same token', async () => {
		const fixture = createFixture();
		const firstShare = new DeferredPromise<boolean>();
		let shareCalls = 0;
		(fixture.model as { setSharedWithAgent(shared: boolean): Promise<boolean> }).setSharedWithAgent = async shared => {
			if (!shared) {
				return true;
			}
			shareCalls++;
			return shareCalls === 1 ? firstShare.p : true;
		};

		const first = fixture.bindingModel.bindPageToPane(fixture.model, 'token');
		const second = fixture.bindingModel.bindPageToPane(fixture.model, 'token');
		await eventually(() => shareCalls === 1);
		assert.strictEqual(shareCalls, 1);
		await firstShare.complete(true);
		assert.deepStrictEqual(await Promise.all([first, second]), [true, true]);
		assert.strictEqual(shareCalls, 2);
	});

	test('does not let an older refresh response overwrite a newer binding snapshot', async () => {
		const reads: DeferredPromise<IParadisPaneBinding[]>[] = [];
		const fixture = createFixture({
			listBindings: () => {
				const read = new DeferredPromise<IParadisPaneBinding[]>();
				reads.push(read);
				return read.p;
			},
		});
		await eventually(() => reads.length === 1);

		const newerRefresh = fixture.bindingModel.refresh();
		await eventually(() => reads.length === 2);
		const newest = bindingRow('token', 'view-a', 2);
		await reads[1].complete([newest]);
		await newerRefresh;
		await reads[0].complete([binding(1)]);
		await new Promise<void>(resolve => setTimeout(resolve, 0));

		assert.deepStrictEqual({
			getter: fixture.bindingModel.bindings[0] === newest,
			token: fixture.bindingModel.getBindingForToken('token') === newest,
			page: fixture.bindingModel.getBindingsForPage('view-a')[0] === newest,
			generation: fixture.bindingModel.getBindingForToken('token')?.generation,
		}, { getter: true, token: true, page: true, generation: 2 });
	});

	test('preserves first duplicate, page order, row identity, and fresh page arrays', async () => {
		const fixture = createFixture();
		const first = bindingRow('duplicate', 'page-a', 1);
		const middle = bindingRow('middle', 'page-b', 2);
		const lastDuplicate = bindingRow('duplicate', 'page-a', 3);
		const tail = bindingRow('tail', 'page-a', 4);
		fixture.backendBindings = [first, middle, lastDuplicate, tail];
		await fixture.bindingModel.refresh();
		const firstPageRead = fixture.bindingModel.getBindingsForPage('page-a');
		firstPageRead.splice(0, firstPageRead.length);
		const secondPageRead = fixture.bindingModel.getBindingsForPage('page-a');
		assert.deepStrictEqual({
			duplicateGeneration: fixture.bindingModel.getBindingForToken('duplicate')?.generation,
			pageGenerations: secondPageRead.map(row => row.generation),
			getterIdentity: fixture.bindingModel.bindings[0] === first,
			tokenIdentity: fixture.bindingModel.getBindingForToken('duplicate') === first,
			pageIdentities: secondPageRead.map((row, index) => row === [first, lastDuplicate, tail][index]),
			freshArray: secondPageRead !== firstPageRead,
		}, {
			duplicateGeneration: 1,
			pageGenerations: [1, 3, 4],
			getterIdentity: true,
			tokenIdentity: true,
			pageIdentities: [true, true, true],
			freshArray: true,
		});
	});

	test('does not reread binding keys during indexed lookups or pane descriptor assembly', async () => {
		let tokenAccesses = 0;
		let pageAccesses = 0;
		const rows = Array.from({ length: 1_000 }, (_, index) => {
			const token = `token-${index}`;
			const pageId = `page-${index % 500}`;
			const row = bindingRow(token, pageId, index + 1);
			Object.defineProperties(row, {
				token: { enumerable: true, get: () => { tokenAccesses++; return token; } },
				pageId: { enumerable: true, get: () => { pageAccesses++; return pageId; } },
			});
			return row;
		});
		const fixture = createFixture({ listBindings: async () => rows });
		fixture.paneTokens.set(1, 'token-0');
		fixture.paneTokens.set(2, 'token-1');
		await eventually(() => fixture.bindingModel.bindings.length === 1_000);
		tokenAccesses = 0;
		pageAccesses = 0;
		for (let lookup = 0; lookup < 10_000; lookup++) {
			assert.strictEqual(fixture.bindingModel.getBindingForToken(`token-${lookup % 1_000}`), rows[lookup % 1_000]);
			assert.strictEqual(fixture.bindingModel.getBindingsForPage(`page-${lookup % 500}`).length, 2);
			fixture.bindingModel.getPanes();
		}
		assert.deepStrictEqual({ tokenAccesses, pageAccesses }, { tokenAccesses: 0, pageAccesses: 0 });
	});

	test('coalesces one hundred pane token events into one binding-list pair', async () => {
		const fixtureStore = new DisposableStore();
		const pollTimer = new DeterministicPollTimer();
		const tokenTimer = new DeterministicPollTimer();
		try {
			const fixture = createFixture({ pollTimer, tokenRefreshTimer: tokenTimer, store: fixtureStore });
			await eventually(() => bindingListCommands(fixture.commands).length === 2);
			fixture.commands.length = 0;
			for (let event = 0; event < 100; event++) {
				fixture.paneTokensChanged.fire();
			}
			assert.deepStrictEqual({ sets: tokenTimer.setCallCount, pending: tokenTimer.pendingHandleCount }, { sets: 1, pending: 1 });
			tokenTimer.advance(0);
			await nextTask();
			assert.deepStrictEqual(bindingListCommands(fixture.commands), ['listBindings', 'listSeenTokens']);
			assert.strictEqual(tokenTimer.pendingHandleCount, 0);
		} finally {
			fixtureStore.dispose();
			assert.deepStrictEqual({ poll: pollTimer.pendingHandleCount, token: tokenTimer.pendingHandleCount }, { poll: 0, token: 0 });
		}
	});

	test('refreshes at zero milliseconds and switches idle polling to fast when a token appears', async () => {
		const fixtureStore = new DisposableStore();
		const pollTimer = new DeterministicPollTimer();
		const tokenTimer = new DeterministicPollTimer();
		try {
			const fixture = createFixture({ hasPaneTokens: false, pollTimer, tokenRefreshTimer: tokenTimer, store: fixtureStore });
			await nextTask();
			assert.deepStrictEqual({ commands: bindingListCommands(fixture.commands), delay: pollTimer.nextDelay }, { commands: [], delay: 30_000 });
			fixture.paneTokens.set(fixture.instances.first.instanceId, 'token');
			fixture.paneTokensChanged.fire();
			assert.deepStrictEqual({ pollDelay: pollTimer.nextDelay, tokenDelay: tokenTimer.nextDelay }, { pollDelay: 3_000, tokenDelay: 0 });
			tokenTimer.advance(0);
			await nextTask();
			assert.deepStrictEqual(bindingListCommands(fixture.commands), ['listBindings', 'listSeenTokens']);
		} finally {
			fixtureStore.dispose();
			assert.deepStrictEqual({ poll: pollTimer.pendingHandleCount, token: tokenTimer.pendingHandleCount }, { poll: 0, token: 0 });
		}
	});

	test('keeps fast cadence until a token removal refresh adopts an empty snapshot', async () => {
		const bindingReads = deferredQueue<IParadisPaneBinding[]>();
		const fixtureStore = new DisposableStore();
		const pollTimer = new DeterministicPollTimer();
		const tokenTimer = new DeterministicPollTimer();
		try {
			const fixture = createFixture({
				listBindings: bindingReads.read,
				pollTimer,
				tokenRefreshTimer: tokenTimer,
				store: fixtureStore,
			});
			await eventually(() => bindingReads.reads.length === 1);
			await bindingReads.complete(0, [binding()]);
			await eventually(() => fixture.bindingModel.bindings.length === 1);
			fixture.paneTokens.clear();
			fixture.paneTokensChanged.fire();
			assert.strictEqual(tokenTimer.pendingHandleCount, 1);
			tokenTimer.advance(0);
			await eventually(() => bindingReads.reads.length === 2);
			assert.strictEqual(pollTimer.nextDelay, 3_000);
			await bindingReads.complete(1, []);
			await eventually(() => fixture.bindingModel.bindings.length === 0);
			assert.strictEqual(pollTimer.nextDelay, 30_000);
		} finally {
			fixtureStore.dispose();
			assert.deepStrictEqual({ poll: pollTimer.pendingHandleCount, token: tokenTimer.pendingHandleCount }, { poll: 0, token: 0 });
		}

		const seenStore = new DisposableStore();
		const seenPollTimer = new DeterministicPollTimer();
		const seenTokenTimer = new DeterministicPollTimer();
		let seenTokens = ['seen-token'];
		try {
			const fixture = createFixture({
				listSeenTokens: async () => seenTokens,
				pollTimer: seenPollTimer,
				tokenRefreshTimer: seenTokenTimer,
				store: seenStore,
			});
			await eventually(() => bindingListCommands(fixture.commands).length === 2);
			await nextTask();
			fixture.paneTokens.clear();
			fixture.paneTokensChanged.fire();
			assert.strictEqual(seenPollTimer.nextDelay, 3_000);
			seenTokens = [];
			seenTokenTimer.advance(0);
			await nextTask();
			assert.strictEqual(seenPollTimer.nextDelay, 30_000);
		} finally {
			seenStore.dispose();
			assert.deepStrictEqual({ poll: seenPollTimer.pendingHandleCount, token: seenTokenTimer.pendingHandleCount }, { poll: 0, token: 0 });
		}
	});

	test('does not single-flight token, force, and poll refreshes', async () => {
		const bindingReads = deferredQueue<IParadisPaneBinding[]>();
		const fixtureStore = new DisposableStore();
		const pollTimer = new DeterministicPollTimer();
		const tokenTimer = new DeterministicPollTimer();
		try {
			const fixture = createFixture({ listBindings: bindingReads.read, pollTimer, tokenRefreshTimer: tokenTimer, store: fixtureStore });
			await eventually(() => bindingReads.reads.length === 1);
			await bindingReads.complete(0, []);
			await nextTask();
			fixture.commands.length = 0;
			fixture.paneTokensChanged.fire();
			assert.strictEqual(tokenTimer.pendingHandleCount, 1);
			tokenTimer.advance(0);
			await eventually(() => bindingReads.reads.length === 2);
			const forceRefresh = fixture.bindingModel.unbindToken('missing-token');
			await eventually(() => bindingReads.reads.length === 3);
			pollTimer.advance(3_000);
			await eventually(() => bindingReads.reads.length === 4);
			assert.deepStrictEqual(bindingListCommands(fixture.commands), [
				'listBindings', 'listSeenTokens',
				'listBindings', 'listSeenTokens',
				'listBindings', 'listSeenTokens',
			]);
			await Promise.all([
				bindingReads.complete(1, []),
				bindingReads.complete(2, []),
				bindingReads.complete(3, []),
			]);
			await forceRefresh;
			await nextTask();
		} finally {
			fixtureStore.dispose();
			assert.deepStrictEqual({ poll: pollTimer.pendingHandleCount, token: tokenTimer.pendingHandleCount }, { poll: 0, token: 0 });
		}
	});

	test('retries a failed force read after three seconds before returning to idle', async () => {
		const bindingReads = deferredQueue<IParadisPaneBinding[]>();
		const fixtureStore = new DisposableStore();
		const pollTimer = new DeterministicPollTimer();
		try {
			const fixture = createFixture({ hasPaneTokens: false, listBindings: bindingReads.read, pollTimer, store: fixtureStore });
			await nextTask();
			fixture.commands.length = 0;
			const forceRefresh = fixture.bindingModel.unbindToken('missing-token');
			await eventually(() => bindingReads.reads.length === 1);
			await bindingReads.reject(0, new Error('authority unavailable'));
			await forceRefresh;
			assert.strictEqual(pollTimer.nextDelay, 3_000);
			pollTimer.advance(3_000);
			await eventually(() => bindingReads.reads.length === 2);
			assert.deepStrictEqual(bindingListCommands(fixture.commands), [
				'listBindings', 'listSeenTokens', 'listBindings', 'listSeenTokens',
			]);
			await bindingReads.complete(1, []);
			await nextTask();
			assert.strictEqual(pollTimer.nextDelay, 30_000);
		} finally {
			fixtureStore.dispose();
			assert.strictEqual(pollTimer.pendingHandleCount, 0);
		}
	});

	test('ignores an older rejection after a newer success', async () => {
		const bindingReads = deferredQueue<IParadisPaneBinding[]>();
		const fixtureStore = new DisposableStore();
		const pollTimer = new DeterministicPollTimer();
		try {
			const fixture = createFixture({ listBindings: bindingReads.read, pollTimer, store: fixtureStore });
			await eventually(() => bindingReads.reads.length === 1);
			await bindingReads.complete(0, []);
			await nextTask();
			const older = fixture.bindingModel.refresh();
			const newer = fixture.bindingModel.refresh();
			await eventually(() => bindingReads.reads.length === 3);
			fixture.paneTokens.clear();
			await bindingReads.complete(2, []);
			await newer;
			const before = {
				changeCount: fixture.changeCount,
				delay: pollTimer.nextDelay,
				pending: pollTimer.pendingHandleCount,
				sets: pollTimer.setCallCount,
			};
			await bindingReads.reject(1, new Error('older failed'));
			await older;
			assert.deepStrictEqual({
				changeCount: fixture.changeCount,
				delay: pollTimer.nextDelay,
				pending: pollTimer.pendingHandleCount,
				sets: pollTimer.setCallCount,
			}, before);
		} finally {
			fixtureStore.dispose();
			assert.strictEqual(pollTimer.pendingHandleCount, 0);
		}
	});

	test('does not let an older success clear a newer retry requirement', async () => {
		const bindingReads = deferredQueue<IParadisPaneBinding[]>();
		const fixtureStore = new DisposableStore();
		const pollTimer = new DeterministicPollTimer();
		try {
			const fixture = createFixture({ listBindings: bindingReads.read, pollTimer, store: fixtureStore });
			await eventually(() => bindingReads.reads.length === 1);
			await bindingReads.complete(0, []);
			await nextTask();
			const older = fixture.bindingModel.refresh();
			const newer = fixture.bindingModel.refresh();
			await eventually(() => bindingReads.reads.length === 3);
			fixture.paneTokens.clear();
			await bindingReads.reject(2, new Error('newer failed'));
			await newer;
			await bindingReads.complete(1, []);
			await older;
			assert.strictEqual(pollTimer.nextDelay, 3_000);
			fixture.commands.length = 0;
			pollTimer.advance(3_000);
			await nextTask();
			assert.strictEqual(bindingReads.reads.length, 4);
			assert.deepStrictEqual(bindingListCommands(fixture.commands), ['listBindings', 'listSeenTokens']);
			await bindingReads.complete(3, []);
			await nextTask();
		} finally {
			fixtureStore.dispose();
			assert.strictEqual(pollTimer.pendingHandleCount, 0);
		}
	});

	test('does not publish a late refresh resolve after disposal', async () => {
		const bindingReads = deferredQueue<IParadisPaneBinding[]>();
		const seenReads = deferredQueue<string[]>();
		const fixtureStore = new DisposableStore();
		const pollTimer = new DeterministicPollTimer();
		const fixture = createFixture({
			listBindings: bindingReads.read,
			listSeenTokens: seenReads.read,
			pollTimer,
			store: fixtureStore,
		});
		await eventually(() => bindingReads.reads.length === 1 && seenReads.reads.length === 1);
		const before = {
			bindings: fixture.bindingModel.bindings,
			binding: fixture.bindingModel.getBindingForToken('token'),
			changeCount: fixture.changeCount,
		};
		fixtureStore.dispose();
		await Promise.all([
			bindingReads.complete(0, [binding(91)]),
			seenReads.complete(0, ['token']),
		]);
		await nextTask();
		assert.deepStrictEqual({
			bindings: fixture.bindingModel.bindings,
			binding: fixture.bindingModel.getBindingForToken('token'),
			changeCount: fixture.changeCount,
			pending: pollTimer.pendingHandleCount,
		}, { ...before, pending: 0 });
	});

	test('does not recreate retry timers after a late refresh rejection', async () => {
		const bindingReads = deferredQueue<IParadisPaneBinding[]>();
		const fixtureStore = new DisposableStore();
		const pollTimer = new DeterministicPollTimer();
		const fixture = createFixture({ hasPaneTokens: false, listBindings: bindingReads.read, pollTimer, store: fixtureStore });
		await nextTask();
		const forceRefresh = fixture.bindingModel.unbindToken('missing-token');
		await eventually(() => bindingReads.reads.length === 1);
		fixtureStore.dispose();
		await bindingReads.reject(0, new Error('late rejection'));
		await forceRefresh;
		await nextTask();
		fixture.commands.length = 0;
		const postDisposeRefresh = fixture.bindingModel.refresh();
		await nextTask();
		const commandsAfterDisposal = bindingListCommands(fixture.commands);
		if (bindingReads.reads.length === 2) {
			await bindingReads.complete(1, []);
		}
		await postDisposeRefresh;
		assert.deepStrictEqual({
			changeCount: fixture.changeCount,
			pending: pollTimer.pendingHandleCount,
			commands: commandsAfterDisposal,
		}, { changeCount: 0, pending: 0, commands: [] });
	});

	test('cancels a pending zero millisecond token refresh on disposal', async () => {
		const fixtureStore = new DisposableStore();
		const pollTimer = new DeterministicPollTimer();
		const tokenTimer = new DeterministicPollTimer();
		const fixture = createFixture({ hasPaneTokens: false, pollTimer, tokenRefreshTimer: tokenTimer, store: fixtureStore });
		await nextTask();
		fixture.commands.length = 0;
		fixture.paneTokens.set(fixture.instances.first.instanceId, 'token');
		fixture.paneTokensChanged.fire();
		assert.strictEqual(tokenTimer.pendingHandleCount, 1);
		fixtureStore.dispose();
		assert.deepStrictEqual({ poll: pollTimer.pendingHandleCount, token: tokenTimer.pendingHandleCount }, { poll: 0, token: 0 });
		tokenTimer.advance(0);
		await nextTask();
		assert.deepStrictEqual(bindingListCommands(fixture.commands), []);
	});

	test('rolls back only a definite pre-commit failure after a fresh empty binding read', async () => {
		const fixture = createFixture({ prepare: async () => { throw new Error('prepare failed'); } });

		await assert.rejects(fixture.bindingModel.bindPageToPane(fixture.model, 'token'), /prepare failed/);

		assert.deepStrictEqual(fixture.sharingCalls, [true, false]);
		assert.ok(fixture.commands.some(call => call.command === 'listBindings'));
		assert.strictEqual(fixture.commands.some(call => call.command === 'commitBind'), false);
	});

	test('does not roll sharing back when the required fresh binding read fails', async () => {
		const fixture = createFixture({
			prepare: async () => { throw new Error('prepare failed'); },
			listBindings: async () => { throw new Error('refresh failed'); },
		});

		await assert.rejects(fixture.bindingModel.bindPageToPane(fixture.model, 'token'), /prepare failed/);

		assert.deepStrictEqual(fixture.sharingCalls, [true]);
	});

	test('rechecks scope after sharing and rolls back before prepare when it becomes pending', async () => {
		const fixture = createFixture();
		(fixture.model as { setSharedWithAgent(shared: boolean): Promise<boolean> }).setSharedWithAgent = async shared => {
			fixture.sharingCalls.push(shared);
			if (shared) {
				fixture.terminalScope = { kind: 'pending' };
			}
			return true;
		};

		await assert.rejects(fixture.bindingModel.bindPageToPane(fixture.model, 'token'), /pending/);

		assert.deepStrictEqual(fixture.sharingCalls, [true, false]);
		assert.strictEqual(fixture.commands.some(call => call.command === 'prepareBind'), false);
	});

	test('keeps sharing after a pre-commit failure when a fresh same-page binding exists', async () => {
		const fixture = createFixture({ prepare: async () => { throw new Error('prepare failed'); } });
		fixture.backendBindings = [binding()];

		await assert.rejects(fixture.bindingModel.bindPageToPane(fixture.model, 'token'), /prepare failed/);

		assert.deepStrictEqual(fixture.sharingCalls, [true]);
	});

	test('treats a rejected commit response as outcome unknown and never rolls sharing back', async () => {
		const fixture = createFixture({ commit: async () => { throw new Error('commit response lost'); } });

		await assert.rejects(fixture.bindingModel.bindPageToPane(fixture.model, 'token'), /commit response lost/);

		assert.deepStrictEqual(fixture.sharingCalls, [true]);
		assert.ok(fixture.commands.some(call => call.command === 'commitBind'));
	});

	test('refreshes a backend-committed binding after the commit response is lost', async () => {
		const fixture = createFixture({
			commit: async () => {
				fixture.backendBindings = [binding(12)];
				throw new Error('commit response lost');
			},
		});

		await assert.rejects(fixture.bindingModel.bindPageToPane(fixture.model, 'token'), /commit response lost/);

		assert.strictEqual(fixture.bindingModel.getBindingForToken('token')?.generation, 12);
		assert.deepStrictEqual(fixture.sharingCalls, [true]);
	});

	test('manual unbindToken cannot overtake an in-flight bind for the same token', async () => {
		const fixture = createFixture();
		const share = new DeferredPromise<boolean>();
		(fixture.model as { setSharedWithAgent(shared: boolean): Promise<boolean> }).setSharedWithAgent = async shared => {
			fixture.order.push(`share:${shared}`);
			return shared ? share.p : true;
		};

		const bind = fixture.bindingModel.bindPageToPane(fixture.model, 'token');
		await eventually(() => fixture.order.includes('share:true'));
		const unbind = fixture.bindingModel.unbindToken('token');
		await new Promise<void>(resolve => setTimeout(resolve, 0));
		assert.strictEqual(fixture.order.includes('unbind'), false);

		await share.complete(true);
		await bind;
		await unbind;
		assert.ok(fixture.order.indexOf('commit') < fixture.order.indexOf('unbind'));
	});

	test('manual unbindToken releases an outcome-unknown page after authority reads recover', async () => {
		let failBindingReads = false;
		let backendSnapshot: IParadisPaneBinding[] = [];
		const fixture = createFixture({
			listBindings: async () => {
				if (failBindingReads) {
					throw new Error('refresh unavailable');
				}
				return backendSnapshot;
			},
			commit: async () => {
				backendSnapshot = [binding(14)];
				fixture.backendBindings = backendSnapshot;
				failBindingReads = true;
				throw new Error('commit response lost');
			},
		});

		await assert.rejects(fixture.bindingModel.bindPageToPane(fixture.model, 'token'), /commit response lost/);
		await fixture.bindingModel.unbindToken('token');
		assert.deepStrictEqual(fixture.sharingCalls, [true]);
		assert.deepStrictEqual(fixture.backendBindings, []);

		backendSnapshot = [];
		failBindingReads = false;
		await fixture.bindingModel.refresh();
		await eventually(() => fixture.sharingCalls.includes(false));

		assert.deepStrictEqual(fixture.sharingCalls, [true, false]);
	});

	test('keeps pending unshare recovery fast until sharing cleanup succeeds', async () => {
		const fixtureStore = new DisposableStore();
		const pollTimer = new DeterministicPollTimer();
		let failBindingReads = false;
		let rejectUnshare = true;
		let backendSnapshot: IParadisPaneBinding[] = [];
		try {
			const fixture = createFixture({
				pollTimer,
				store: fixtureStore,
				listBindings: async () => {
					if (failBindingReads) {
						throw new Error('refresh unavailable');
					}
					return backendSnapshot;
				},
				commit: async () => {
					backendSnapshot = [binding(61)];
					fixture.backendBindings = backendSnapshot;
					failBindingReads = true;
					throw new Error('commit response lost');
				},
			});
			await assert.rejects(fixture.bindingModel.bindPageToPane(fixture.model, 'token'), /commit response lost/);
			await fixture.bindingModel.unbindToken('token');
			fixture.paneTokens.clear();
			assert.strictEqual(pollTimer.nextDelay, 3_000);

			failBindingReads = false;
			pollTimer.advance(3_000);
			await eventually(() => fixture.bindingModel.bindings.length === 1);
			assert.strictEqual(pollTimer.nextDelay, 3_000);

			(fixture.model as { setSharedWithAgent(shared: boolean): Promise<boolean> }).setSharedWithAgent = async shared => {
				fixture.sharingCalls.push(shared);
				if (!shared && rejectUnshare) {
					throw new Error('sharing cleanup failed');
				}
				return true;
			};
			backendSnapshot = [];
			pollTimer.advance(3_000);
			await eventually(() => fixture.sharingCalls.filter(shared => !shared).length === 1);
			assert.strictEqual(pollTimer.nextDelay, 3_000);

			rejectUnshare = false;
			pollTimer.advance(3_000);
			await eventually(() => fixture.sharingCalls.filter(shared => !shared).length === 2);
			await nextTask();
			assert.strictEqual(pollTimer.nextDelay, 30_000);
		} finally {
			fixtureStore.dispose();
			assert.strictEqual(pollTimer.pendingHandleCount, 0);
		}
	});

	test('manual unbindPage cannot overtake an in-flight rebind for the same token', async () => {
		const fixture = createFixture();
		fixture.backendBindings = [binding(1)];
		await fixture.bindingModel.refresh();
		const share = new DeferredPromise<boolean>();
		(fixture.model as { setSharedWithAgent(shared: boolean): Promise<boolean> }).setSharedWithAgent = async shared => {
			fixture.order.push(`share:${shared}`);
			return shared ? share.p : true;
		};
		fixture.order.length = 0;

		const bind = fixture.bindingModel.bindPageToPane(fixture.model, 'token');
		await eventually(() => fixture.order.includes('share:true'));
		const unbind = fixture.bindingModel.unbindPage(fixture.model);
		await new Promise<void>(resolve => setTimeout(resolve, 0));
		assert.strictEqual(fixture.order.includes('unbind'), false);

		await share.complete(true);
		await bind;
		assert.strictEqual(await unbind, 1);
		assert.ok(fixture.order.indexOf('commit') < fixture.order.indexOf('unbind'));
	});

	test('manual unbindPage queues behind an initial bind before it reaches the binding cache', async () => {
		const fixture = createFixture();
		const share = new DeferredPromise<boolean>();
		(fixture.model as { setSharedWithAgent(shared: boolean): Promise<boolean> }).setSharedWithAgent = async shared => {
			fixture.order.push(`share:${shared}`);
			return shared ? share.p : true;
		};

		const bind = fixture.bindingModel.bindPageToPane(fixture.model, 'token');
		await eventually(() => fixture.order.includes('share:true'));
		const unbind = fixture.bindingModel.unbindPage(fixture.model);
		await new Promise<void>(resolve => setTimeout(resolve, 0));
		assert.strictEqual(fixture.order.includes('unbind'), false);

		await share.complete(true);
		await bind;
		assert.strictEqual(await unbind, 1);
		assert.ok(fixture.order.indexOf('commit') < fixture.order.indexOf('unbind'));
		assert.deepStrictEqual(fixture.backendBindings, []);
	});

	test('manual unbindPage retains a token shared by consecutive queued binds', async () => {
		let prepareCalls = 0;
		const fixture = createFixture({
			prepare: async request => {
				prepareCalls++;
				if (prepareCalls === 1) {
					throw new Error('first prepare failed');
				}
				return {
					ticketId: 'ticket-second', expiresAt: Date.now() + 10_000,
					revision: request.revision, scope: { kind: 'managed', stateKey: 'space-a' },
				};
			},
		});
		const secondShare = new DeferredPromise<boolean>();
		let shareCalls = 0;
		(fixture.model as { setSharedWithAgent(shared: boolean): Promise<boolean> }).setSharedWithAgent = async shared => {
			fixture.order.push(`share:${shared}`);
			if (!shared) {
				return true;
			}
			shareCalls++;
			return shareCalls === 2 ? secondShare.p : true;
		};

		const firstBind = fixture.bindingModel.bindPageToPane(fixture.model, 'token');
		const secondBind = fixture.bindingModel.bindPageToPane(fixture.model, 'token');
		await assert.rejects(firstBind, /first prepare failed/);
		await eventually(() => shareCalls === 2);
		const unbind = fixture.bindingModel.unbindPage(fixture.model);
		await secondShare.complete(true);

		assert.strictEqual(await secondBind, true);
		assert.strictEqual(await unbind, 1);
		assert.deepStrictEqual(fixture.backendBindings, []);
	});

	test('manual unbindPage keeps sharing when an outcome-unknown token cannot be verified', async () => {
		let failBindingReads = false;
		const fixture = createFixture({
			listBindings: async () => {
				if (failBindingReads) {
					throw new Error('refresh unavailable');
				}
				return [];
			},
			commit: async () => {
				fixture.backendBindings = [binding(13)];
				failBindingReads = true;
				throw new Error('commit response lost');
			},
		});
		await fixture.bindingModel.refresh();

		await assert.rejects(fixture.bindingModel.bindPageToPane(fixture.model, 'token'), /commit response lost/);
		assert.strictEqual(fixture.bindingModel.getBindingForToken('token'), undefined);
		await assert.rejects(fixture.bindingModel.unbindPage(fixture.model), /PARA_BROWSER_RETRYABLE/);

		assert.deepStrictEqual(fixture.backendBindings.map(candidate => candidate.generation), [13]);
		assert.deepStrictEqual(fixture.sharingCalls, [true]);
	});

	test('manual unbindPage cannot delete an outcome-unknown rebind to a different page', async () => {
		let failBindingReads = false;
		let backendSnapshot: IParadisPaneBinding[] = [];
		const fixture = createFixture({
			listBindings: async () => {
				if (failBindingReads) {
					throw new Error('refresh unavailable');
				}
				return backendSnapshot;
			},
			commit: async (_ticketId, request) => {
				const rebound: IParadisPaneBinding = {
					token: request.token, pageId: request.viewId,
					pageInfo: { url: 'https://other.test', title: 'Other' },
					generation: 22, boundAt: 22,
					scope: { kind: 'managed', stateKey: 'space-a' },
				};
				backendSnapshot = [rebound];
				fixture.backendBindings = [rebound];
				failBindingReads = true;
				throw new Error('commit response lost');
			},
		});
		backendSnapshot = [binding(21)];
		fixture.backendBindings = backendSnapshot;
		await fixture.bindingModel.refresh();
		const otherModel = {
			id: 'view-b', url: 'https://other.test', title: 'Other',
			setSharedWithAgent: async () => true,
		} as unknown as IBrowserViewModel;

		await assert.rejects(fixture.bindingModel.bindPageToPane(otherModel, 'token'), /commit response lost/);
		await assert.rejects(fixture.bindingModel.unbindPage(fixture.model), /PARA_BROWSER_RETRYABLE/);

		assert.deepStrictEqual(fixture.backendBindings.map(candidate => [candidate.pageId, candidate.generation]), [['view-b', 22]]);
		assert.deepStrictEqual(
			fixture.commands.filter(call => call.command === 'unbindIfCurrent').at(-1)?.args,
			['token', 21],
		);
	});

	test('manual unbindPage cannot delete a later outcome-unknown rebind from an older page marker', async () => {
		let failBindingReads = false;
		let commitCount = 0;
		const fixture = createFixture({
			listBindings: async () => {
				if (failBindingReads) {
					throw new Error('refresh unavailable');
				}
				return [];
			},
			commit: async (_ticketId, request) => {
				commitCount++;
				const rebound: IParadisPaneBinding = {
					token: request.token, pageId: request.viewId,
					pageInfo: { url: request.viewId === 'view-a' ? 'https://example.test' : 'https://other.test', title: 'Page' },
					generation: 30 + commitCount, boundAt: 30 + commitCount,
					scope: { kind: 'managed', stateKey: 'space-a' },
				};
				fixture.backendBindings = [rebound];
				failBindingReads = true;
				throw new Error(`commit response ${commitCount} lost`);
			},
		});
		await fixture.bindingModel.refresh();
		const otherModel = {
			id: 'view-b', url: 'https://other.test', title: 'Other',
			setSharedWithAgent: async () => true,
		} as unknown as IBrowserViewModel;

		await assert.rejects(fixture.bindingModel.bindPageToPane(fixture.model, 'token'), /commit response 1 lost/);
		await assert.rejects(fixture.bindingModel.bindPageToPane(otherModel, 'token'), /commit response 2 lost/);
		await assert.rejects(fixture.bindingModel.unbindPage(fixture.model), /PARA_BROWSER_RETRYABLE/);

		assert.deepStrictEqual(fixture.backendBindings.map(candidate => [candidate.pageId, candidate.generation]), [['view-b', 32]]);
		assert.strictEqual(fixture.commands.some(call => call.command === 'unbind'), false);
	});

	test('manual unbindPage includes same-page bindings discovered only by its fresh snapshot', async () => {
		const initialRead = new DeferredPromise<IParadisPaneBinding[]>();
		let reads = 0;
		const fixture = createFixture({
			listBindings: async () => {
				reads++;
				if (reads === 1) {
					return initialRead.p;
				}
				return reads === 2 ? [binding(41)] : [];
			},
		});
		fixture.backendBindings = [binding(41)];

		assert.strictEqual(await fixture.bindingModel.unbindPage(fixture.model), 1);
		await initialRead.complete([]);

		assert.deepStrictEqual(fixture.backendBindings, []);
		assert.deepStrictEqual(fixture.sharingCalls, [false]);
	});

	test('manual unbindPage forces an authority read before terminal tokens are restored', async () => {
		const fixture = createFixture({ hasPaneTokens: false });
		fixture.backendBindings = [binding(42)];
		await new Promise<void>(resolve => setTimeout(resolve, 0));
		assert.strictEqual(fixture.bindingModel.getBindingForToken('token'), undefined);

		assert.strictEqual(await fixture.bindingModel.unbindPage(fixture.model), 1);

		assert.deepStrictEqual(fixture.backendBindings, []);
		assert.deepStrictEqual(fixture.sharingCalls, [false]);
		assert.ok(fixture.commands.some(call => call.command === 'listBindings'));
	});

	test('serializes bind sharing mutations for different tokens on the same page', async () => {
		const firstPrepare = new DeferredPromise<IParadisPrepareBindResult>();
		const secondPrepare = new DeferredPromise<IParadisPrepareBindResult>();
		let firstPrepareStarted = false;
		let secondPrepareStarted = false;
		const fixture = createFixture({
			prepare: request => {
				if (request.token === 'token') {
					firstPrepareStarted = true;
					return firstPrepare.p;
				}
				secondPrepareStarted = true;
				return secondPrepare.p;
			},
		});

		const firstBind = fixture.bindingModel.bindPageToPane(fixture.model, 'token');
		await eventually(() => firstPrepareStarted);
		const secondBind = fixture.bindingModel.bindPageToPane(fixture.model, 'token-b');
		await new Promise<void>(resolve => setTimeout(resolve, 0));
		const firstRejected = assert.rejects(firstBind, /first prepare failed/);
		await firstPrepare.error(new Error('first prepare failed'));
		await firstRejected;
		await eventually(() => secondPrepareStarted);
		await secondPrepare.complete({
			ticketId: 'ticket-b', expiresAt: Date.now() + 10_000,
			revision: 10, scope: { kind: 'managed', stateKey: 'space-a' },
		});

		assert.strictEqual(await secondBind, true);
		assert.deepStrictEqual(fixture.sharingCalls, [true, false, true]);
		assert.deepStrictEqual(fixture.backendBindings.map(candidate => candidate.token), ['token-b']);
	});

	test('serializes binding mutations even when their cached pages and tokens do not overlap', async () => {
		const fixture = createFixture();
		const firstShare = new DeferredPromise<boolean>();
		(fixture.model as { setSharedWithAgent(shared: boolean): Promise<boolean> }).setSharedWithAgent = async shared => {
			fixture.order.push(`share-a:${shared}`);
			return shared ? firstShare.p : true;
		};
		let secondShareCalls = 0;
		const otherModel = {
			id: 'view-b', url: 'https://other.test', title: 'Other',
			setSharedWithAgent: async () => {
				secondShareCalls++;
				return true;
			},
		} as unknown as IBrowserViewModel;

		const firstBind = fixture.bindingModel.bindPageToPane(fixture.model, 'token');
		await eventually(() => fixture.order.includes('share-a:true'));
		const secondBind = fixture.bindingModel.bindPageToPane(otherModel, 'token-b');
		await new Promise<void>(resolve => setTimeout(resolve, 0));
		assert.strictEqual(secondShareCalls, 0);

		await firstShare.complete(true);
		assert.deepStrictEqual(await Promise.all([firstBind, secondBind]), [true, true]);
		assert.strictEqual(secondShareCalls, 1);
	});

	test('aborts a prepared ticket when scope or accepted revision changes before commit', async () => {
		const fixture = createFixture({
			prepare: async request => {
				fixture.terminalScope = { kind: 'managed', stateKey: 'space-b' };
				fixture.acceptedRevision = request.revision + 1;
				return {
					ticketId: 'ticket-drift', expiresAt: Date.now() + 10_000,
					revision: request.revision, scope: { kind: 'managed', stateKey: 'space-a' },
				};
			},
		});

		await assert.rejects(fixture.bindingModel.bindPageToPane(fixture.model, 'token'));

		assert.ok(fixture.commands.some(call => call.command === 'abortBind'));
		assert.strictEqual(fixture.commands.some(call => call.command === 'commitBind'), false);
		assert.deepStrictEqual(fixture.sharingCalls, [true, false]);
	});

	test('conditionally unbinds only a saved generation on real terminal or browser stable scope drift', async () => {
		const fixture = createFixture();
		fixture.backendBindings = [binding(7)];
		await fixture.bindingModel.refresh();
		fixture.commands.length = 0;

		fixture.terminalScope = { kind: 'pending' };
		fixture.terminalScopeChanged.fire({ instanceId: 1 });
		await new Promise<void>(resolve => setTimeout(resolve, 0));
		assert.strictEqual(fixture.commands.some(call => call.command === 'unbindIfCurrent'), false);

		fixture.terminalScope = { kind: 'managed', stateKey: 'space-b' };
		fixture.terminalScopeChanged.fire({ instanceId: 1 });
		await eventually(() => fixture.commands.some(call => call.command === 'unbindIfCurrent'));
		assert.deepStrictEqual(fixture.commands.find(call => call.command === 'unbindIfCurrent')?.args, ['token', 7]);

		fixture.backendBindings = [binding(8)];
		await fixture.bindingModel.refresh();
		fixture.commands.length = 0;
		fixture.terminalScope = { kind: 'managed', stateKey: 'space-a' };
		fixture.browserScope = { kind: 'managed', stateKey: 'space-b' };
		fixture.browserScopeChanged.fire({ viewId: 'view-a' });
		await eventually(() => fixture.commands.some(call => call.command === 'unbindIfCurrent'));
		assert.deepStrictEqual(fixture.commands.find(call => call.command === 'unbindIfCurrent')?.args, ['token', 8]);
	});

	test('refreshes and releases stale page sharing when authority retired the generation first', async () => {
		const fixture = createFixture();
		fixture.backendBindings = [binding(9)];
		await fixture.bindingModel.refresh();
		fixture.backendBindings = [];
		fixture.commands.length = 0;

		fixture.terminalScope = { kind: 'managed', stateKey: 'space-b' };
		fixture.terminalScopeChanged.fire({ instanceId: 1 });
		await eventually(() => fixture.sharingCalls.includes(false));

		assert.deepStrictEqual(fixture.commands.find(call => call.command === 'unbindIfCurrent')?.args, ['token', 9]);
		assert.deepStrictEqual(fixture.sharingCalls, [false]);
	});
});
