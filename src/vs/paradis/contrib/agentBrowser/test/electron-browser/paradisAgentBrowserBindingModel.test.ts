/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as assert from 'assert';
import { DeferredPromise } from '../../../../../base/common/async.js';
import { Emitter } from '../../../../../base/common/event.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { ISharedProcessService } from '../../../../../platform/ipc/electron-browser/services.js';
import { IBrowserViewModel, IBrowserViewWorkbenchService } from '../../../../../workbench/contrib/browserView/common/browserView.js';
import { ITerminalGroupService, ITerminalService } from '../../../../../workbench/contrib/terminal/browser/terminal.js';
import { IParadisPaneTokenService } from '../../browser/paradisPaneTokenService.js';
import { IParadisCommitBindResult, IParadisPaneBinding, IParadisPrepareBindRequest, IParadisPrepareBindResult } from '../../common/paradisAgentBrowser.js';
import { IParadisAgentBrowserAuthoritySyncService } from '../../electron-browser/paradisAgentBrowserAuthoritySyncService.js';
import { ParadisAgentBrowserBindingModel } from '../../electron-browser/paradisAgentBrowserBindingModel.js';
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

suite('ParadisAgentBrowserBindingModel transactions', () => {
	const store = ensureNoDisposablesAreLeakedInTestSuite();

	function createFixture(options?: {
		prepare?: (request: IParadisPrepareBindRequest) => Promise<IParadisPrepareBindResult>;
		commit?: (ticketId: string, request: IParadisPrepareBindRequest) => Promise<IParadisCommitBindResult>;
		listBindings?: () => Promise<IParadisPaneBinding[]>;
		hasPaneTokens?: boolean;
	}) {
		const terminalScopeChanged = store.add(new Emitter<{ instanceId: number; scope?: unknown }>());
		const browserScopeChanged = store.add(new Emitter<{ viewId: string; scope?: unknown }>());
		const browserViewsChanged = store.add(new Emitter<void>());
		const paneTokensChanged = store.add(new Emitter<void>());
		const terminalInstancesChanged = store.add(new Emitter<void>());
		const terminalTitlesChanged = store.add(new Emitter<unknown>());
		const instance = { instanceId: 1, title: 'shell', isDisposed: false, processId: 101 };
		const secondInstance = { instanceId: 2, title: 'shell', isDisposed: false, processId: 102 };
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
					case 'listSeenTokens': return [] as T;
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
		const bindingModel = store.add(new ParadisAgentBrowserBindingModel(
			{ getChannel: () => channel } as unknown as ISharedProcessService,
			{
				instances: [instance, secondInstance], onDidChangeInstances: terminalInstancesChanged.event,
				onAnyInstanceTitleChange: terminalTitlesChanged.event,
			} as unknown as ITerminalService,
			{ paradisParkedGroups: [] } as unknown as ITerminalGroupService,
			{
				getTokenForInstance: (instanceId: number) => instanceId === 1 ? 'token' : instanceId === 2 ? 'token-b' : undefined,
				getInstanceForToken: (token: string) => token === 'token' ? 1 : token === 'token-b' ? 2 : undefined,
				listPaneTokens: () => options?.hasPaneTokens === false
					? []
					: [{ instanceId: 1, token: 'token' }, { instanceId: 2, token: 'token-b' }],
				onDidChange: paneTokensChanged.event,
			} as unknown as IParadisPaneTokenService,
			{
				getKnownBrowserViews: () => knownBrowserViews,
				onDidChangeBrowserViews: browserViewsChanged.event,
			} as unknown as IBrowserViewWorkbenchService,
			{
				get revision() { return terminalRevision; },
				resolveScope: () => terminalScope,
				onDidChangeStableScope: terminalScopeChanged.event,
			} as unknown as IParadisTerminalScopeService,
			{
				get revision() { return browserRevision; },
				resolveScope: () => browserScope,
				onDidChangeStableScope: browserScopeChanged.event,
			} as unknown as IParadisBrowserScopeService,
			authoritySyncService,
		));

		return {
			bindingModel, model, order, commands, sharingCalls, terminalScopeChanged, browserScopeChanged,
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
		await reads[1].complete([binding(2)]);
		await newerRefresh;
		await reads[0].complete([binding(1)]);
		await new Promise<void>(resolve => setTimeout(resolve, 0));

		assert.strictEqual(fixture.bindingModel.getBindingForToken('token')?.generation, 2);
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
