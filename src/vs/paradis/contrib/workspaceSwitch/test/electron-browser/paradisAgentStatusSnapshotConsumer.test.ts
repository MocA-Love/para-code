/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import * as assert from 'assert';
import { Emitter } from '../../../../../base/common/event.js';
import { toDisposable } from '../../../../../base/common/lifecycle.js';
import { URI } from '../../../../../base/common/uri.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { IParadisPaneTokenService } from '../../../agentBrowser/browser/paradisPaneTokenService.js';
import { IParadisAgentPaneStatus, ParadisAgentStatus } from '../../../agentBrowser/common/paradisAgentBrowser.js';
import { IParadisAgentStatusSnapshotOutcome, IParadisAgentStatusSnapshotService } from '../../../agentBrowser/electron-browser/paradisAgentStatusSnapshotService.js';
import { ParadisAgentStatusSnapshotConsumer } from '../../electron-browser/paradisAgentStatusSnapshotConsumer.js';
import { IParadisAgentStatusStore, IParadisTerminalScopeService, IParadisWorkspaceSwitchService, IParadisWorktree, IParadisWorktreeService, paradisWorktreeStateKey } from '../../common/paradisWorkspaceSwitch.js';

suite('ParadisAgentStatusSnapshotConsumer', () => {
	const store = ensureNoDisposablesAreLeakedInTestSuite();

	test('production consumer subscribes and projects pane status, hook memory, and managed scope', () => {
		const fixture = createFixture();
		fixture.instanceByToken.set('pane-a', 7);
		fixture.scopeByInstance.set(7, { kind: 'managed', stateKey: 'space-a' });

		fixture.producer.publish(success(1, [pane('pane-a', 'working')], ['pane-a']));

		assert.deepStrictEqual(entries(fixture.statusStore.scopeBreakdowns), [['space-a', ['working']]]);
		assert.deepStrictEqual(entries(fixture.statusStore.instanceStatuses), [[7, 'working']]);
		assert.deepStrictEqual([...fixture.statusStore.agentInstanceIds], [7]);
	});

	test('acknowledges only a focused local review in the active scope and omits it from stores', () => {
		const fixture = createFixture();
		fixture.instanceByToken.set('local-review', 1);
		fixture.instanceByToken.set('inactive-review', 2);
		fixture.scopeByInstance.set(1, { kind: 'managed', stateKey: 'space-a' });
		fixture.scopeByInstance.set(2, { kind: 'managed', stateKey: 'space-b' });

		fixture.producer.publish(success(1, [
			pane('local-review', 'review'),
			pane('inactive-review', 'review'),
			pane('cwd-only-review', 'review', '/repos/space-a'),
		], ['local-review', 'inactive-review']));

		assert.deepStrictEqual(fixture.acknowledged, ['local-review']);
		assert.deepStrictEqual(entries(fixture.statusStore.scopeBreakdowns), [
			['space-b', ['review']],
			['space-a', ['review']],
		]);
		assert.deepStrictEqual(entries(fixture.statusStore.instanceStatuses), [[2, 'review']]);
		assert.deepStrictEqual([...fixture.statusStore.agentInstanceIds], [1, 2]);
	});

	test('keeps an active local review visible without acknowledging it while the workbench is unfocused', () => {
		const fixture = createFixture(() => false);
		fixture.instanceByToken.set('local-review', 1);
		fixture.scopeByInstance.set(1, { kind: 'managed', stateKey: 'space-a' });

		fixture.producer.publish(success(1, [pane('local-review', 'review')], ['local-review']));

		assert.deepStrictEqual(fixture.acknowledged, []);
		assert.deepStrictEqual(entries(fixture.statusStore.scopeBreakdowns), [['space-a', ['review']]]);
		assert.deepStrictEqual(entries(fixture.statusStore.instanceStatuses), [[1, 'review']]);
	});

	test('uses longest cwd worktree match and remembers it while a token is temporarily detached', () => {
		const fixture = createFixture();
		const worktree = fixture.worktrees[0];
		const stateKey = paradisWorktreeStateKey(worktree.uri);

		fixture.producer.publish(success(1, [pane('detached', 'working', worktree.uri.fsPath + '/src')], []));
		assert.deepStrictEqual(entries(fixture.statusStore.scopeBreakdowns), [[stateKey, ['working']]]);

		fixture.producer.publish(success(2, [pane('detached', 'permission')], []));
		assert.deepStrictEqual(entries(fixture.statusStore.scopeBreakdowns), [[stateKey, ['permission']]]);
	});

	test('scope switch reprojects the cached snapshot before requesting one fresh snapshot', () => {
		const fixture = createFixture();
		fixture.activeStateKey = 'space-b';
		fixture.instanceByToken.set('pane-a', 1);
		fixture.scopeByInstance.set(1, { kind: 'managed', stateKey: 'space-a' });
		fixture.producer.publish(success(1, [pane('pane-a', 'review')], ['pane-a']));
		assert.deepStrictEqual(fixture.acknowledged, []);

		fixture.activeStateKey = 'space-a';
		fixture.scopeSwitch.fire('space-a');

		assert.deepStrictEqual(fixture.acknowledged, ['pane-a']);
		assert.deepStrictEqual(entries(fixture.statusStore.scopeBreakdowns), []);
		assert.strictEqual(fixture.producer.refreshRequests, 1);
	});

	test('terminal exit completion requests a refresh without mutating the cached snapshot', () => {
		const fixture = createFixture();
		fixture.instanceByToken.set('pane-a', 1);
		fixture.scopeByInstance.set(1, { kind: 'managed', stateKey: 'space-b' });
		fixture.producer.publish(success(1, [pane('pane-a', 'working')], ['pane-a']));

		fixture.consumer.requestRefresh();

		assert.strictEqual(fixture.producer.refreshRequests, 1);
		assert.deepStrictEqual(entries(fixture.statusStore.scopeBreakdowns), [['space-b', ['working']]]);
	});

	test('keeps status through 29 failures, clears on 30, and resets the counter after success', () => {
		const fixture = createFixture();
		fixture.instanceByToken.set('pane-a', 1);
		fixture.scopeByInstance.set(1, { kind: 'managed', stateKey: 'space-b' });
		fixture.producer.publish(success(1, [pane('pane-a', 'working')], ['pane-a']));

		for (let sequence = 2; sequence <= 30; sequence++) {
			fixture.producer.publish(failure(sequence));
		}
		assert.deepStrictEqual(entries(fixture.statusStore.scopeBreakdowns), [['space-b', ['working']]]);

		fixture.producer.publish(failure(31));
		assert.deepStrictEqual(entries(fixture.statusStore.scopeBreakdowns), []);
		assert.deepStrictEqual(entries(fixture.statusStore.instanceStatuses), []);

		fixture.producer.publish(success(32, [pane('pane-a', 'working')], ['pane-a']));
		for (let sequence = 33; sequence <= 61; sequence++) {
			fixture.producer.publish(failure(sequence));
		}
		assert.deepStrictEqual(entries(fixture.statusStore.scopeBreakdowns), [['space-b', ['working']]]);
		assert.strictEqual(fixture.pollErrors.length, 59);
	});

	test('cached scope reprojection does not reset failures or restore a snapshot cleared after 30 failures', () => {
		const fixture = createFixture();
		fixture.instanceByToken.set('pane-a', 1);
		fixture.scopeByInstance.set(1, { kind: 'managed', stateKey: 'space-b' });
		fixture.producer.publish(success(1, [pane('pane-a', 'working')], ['pane-a']));
		for (let sequence = 2; sequence <= 30; sequence++) {
			fixture.producer.publish(failure(sequence));
		}

		fixture.scopeSwitch.fire('space-a');
		assert.deepStrictEqual(entries(fixture.statusStore.scopeBreakdowns), [['space-b', ['working']]]);
		fixture.producer.publish(failure(31));
		assert.deepStrictEqual(entries(fixture.statusStore.scopeBreakdowns), []);

		fixture.scopeSwitch.fire('space-b');
		assert.deepStrictEqual(entries(fixture.statusStore.scopeBreakdowns), []);
		assert.strictEqual(fixture.producer.refreshRequests, 2);
	});

	test('dispose removes producer and scope subscriptions', () => {
		const fixture = createFixture();
		fixture.consumer.dispose();

		fixture.producer.publish(success(1, [pane('late', 'working')], ['late']));
		fixture.scopeSwitch.fire('space-a');
		fixture.consumer.requestRefresh();

		assert.deepStrictEqual(entries(fixture.statusStore.scopeBreakdowns), []);
		assert.strictEqual(fixture.producer.refreshRequests, 0);
	});

	function createFixture(isWindowFocused: () => boolean = () => true) {
		const producer = new TestSnapshotService();
		const scopeSwitch = store.add(new Emitter<string>());
		const instanceByToken = new Map<string, number>();
		const scopeByInstance = new Map<number, ReturnType<IParadisTerminalScopeService['resolveScope']>>();
		const statusStore = new TestStatusStore();
		const acknowledged: string[] = [];
		const pollErrors: unknown[] = [];
		const worktrees: IParadisWorktree[] = [{
			repositoryId: 'space-a',
			name: 'feature',
			uri: URI.file('/repos/space-a/worktrees/feature'),
		}];
		let activeStateKey: string | undefined = 'space-a';
		const workspaceSwitchService = {
			get activeStateKey() { return activeStateKey; },
			repositories: [
				{ id: 'space-a', name: 'Space A', uri: URI.file('/repos/space-a') },
				{ id: 'space-b', name: 'Space B', uri: URI.file('/repos/space-b') },
			],
			onDidSwitchScope: scopeSwitch.event,
		} as unknown as IParadisWorkspaceSwitchService;
		const consumer = store.add(new ParadisAgentStatusSnapshotConsumer({
			snapshotService: producer,
			paneTokenService: {
				getInstanceForToken: token => instanceByToken.get(token),
			} as IParadisPaneTokenService,
			terminalScopeService: {
				resolveScope: instanceId => scopeByInstance.get(instanceId) ?? { kind: 'unscoped' },
			} as IParadisTerminalScopeService,
			workspaceSwitchService,
			worktreeService: {
				getWorktrees: (repositoryId: string) => repositoryId === 'space-a' ? worktrees : [],
			} as unknown as IParadisWorktreeService,
			statusStore,
			acknowledgePaneStatus: token => acknowledged.push(token),
			logPollFailure: error => pollErrors.push(error),
			isWindowFocused,
		}));

		return {
			producer, scopeSwitch, instanceByToken, scopeByInstance, statusStore, acknowledged, pollErrors, worktrees, consumer,
			get activeStateKey() { return activeStateKey; },
			set activeStateKey(value: string | undefined) { activeStateKey = value; },
		};
	}
});

function pane(token: string, status: ParadisAgentStatus, cwd?: string): IParadisAgentPaneStatus {
	return { token, status, changedAt: 1, cwd };
}

function success(sequence: number, paneStatuses: readonly IParadisAgentPaneStatus[], agentHookTokens: readonly string[]): IParadisAgentStatusSnapshotOutcome {
	return { sequence, snapshot: { paneStatuses, agentHookTokens } };
}

function failure(sequence: number): IParadisAgentStatusSnapshotOutcome {
	return { sequence, error: new Error(`failure-${sequence}`) };
}

function entries<K, V>(map: ReadonlyMap<K, V>): [K, V][] {
	return [...map.entries()];
}

class TestSnapshotService implements IParadisAgentStatusSnapshotService {
	declare readonly _serviceBrand: undefined;
	private listener: ((outcome: IParadisAgentStatusSnapshotOutcome) => void) | undefined;
	refreshRequests = 0;

	subscribe(listener: (outcome: IParadisAgentStatusSnapshotOutcome) => void) {
		this.listener = listener;
		return toDisposable(() => {
			if (this.listener === listener) {
				this.listener = undefined;
			}
		});
	}

	requestRefresh(): void {
		this.refreshRequests++;
	}

	publish(outcome: IParadisAgentStatusSnapshotOutcome): void {
		this.listener?.(outcome);
	}
}

class TestStatusStore implements IParadisAgentStatusStore {
	declare readonly _serviceBrand: undefined;
	readonly onDidChangeAgentStatuses = () => toDisposable(() => undefined);
	scopeBreakdowns = new Map<string, readonly ParadisAgentStatus[]>();
	instanceStatuses = new Map<number, ParadisAgentStatus>();
	agentInstanceIds = new Set<number>();

	getScopeStatus(): ParadisAgentStatus | undefined { return undefined; }
	getScopeBreakdown(): readonly ParadisAgentStatus[] { return []; }
	getInstanceStatus(): ParadisAgentStatus | undefined { return undefined; }
	isAgentInstance(): boolean { return false; }
	hasDiscoveredAgentSession(): boolean { return false; }
	setDiscoveredAgentPaneTokens(): void { }
	setScopeBreakdowns(breakdowns: ReadonlyMap<string, readonly ParadisAgentStatus[]>): void {
		this.scopeBreakdowns = new Map(breakdowns);
	}
	setInstanceStates(statuses: Map<number, ParadisAgentStatus>, agentInstanceIds: Set<number>): void {
		this.instanceStatuses = new Map(statuses);
		this.agentInstanceIds = new Set(agentInstanceIds);
	}
}
