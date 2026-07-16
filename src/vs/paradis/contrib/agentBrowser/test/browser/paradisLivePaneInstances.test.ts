/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import assert from 'assert';
import { Emitter } from '../../../../../base/common/event.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import type { ITerminalGroupService, ITerminalInstance, ITerminalService } from '../../../../../workbench/contrib/terminal/browser/terminal.js';
import type { IParadisPaneTokenService } from '../../browser/paradisPaneTokenService.js';
import { ParadisPaneProcessReadyTracker, paradisCollectAllTerminalInstances, paradisCollectLivePaneInstances, paradisCreatePaneShellManifestEntries, paradisListCurrentPaneTokens } from '../../browser/paradisLivePaneInstances.js';
import { ParadisTerminalInstanceRetirementTracker, ParadisTerminalStableScopeTracker, paradisResolveTerminalBindingScope } from '../../../workspaceSwitch/common/paradisWorkspaceSwitch.js';

function terminal(instanceId: number, title: string, processId?: number): ITerminalInstance {
	return { instanceId, title, processId } as ITerminalInstance;
}

function tokenService(
	tokenByInstanceId: ReadonlyMap<number, string>,
	instanceIdByToken: ReadonlyMap<string, number>,
): IParadisPaneTokenService {
	return {
		getTokenForInstance: instanceId => tokenByInstanceId.get(instanceId),
		getInstanceForToken: token => instanceIdByToken.get(token),
	} as IParadisPaneTokenService;
}

suite('Paradis live pane instances', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	test('collects normal, editor, background, parked panel, and parked editor instances once', () => {
		const normal = terminal(1, 'normal', 101);
		const editor = terminal(2, 'editor', 102);
		const background = terminal(3, 'background', 103);
		const parkedPanel = terminal(4, 'parked panel', 104);
		const parkedEditor = terminal(5, 'parked editor', 105);
		const tokens = new Map([[1, 'one'], [2, 'two'], [3, 'three'], [4, 'four'], [5, 'five']]);

		const result = paradisCollectLivePaneInstances(
			{ instances: [normal, editor, background] } as unknown as ITerminalService,
			{ paradisParkedGroups: [{ terminalInstances: [normal, parkedPanel] }] } as unknown as ITerminalGroupService,
			tokenService(tokens, new Map([...tokens].map(([instanceId, token]) => [token, instanceId]))),
			[editor, parkedEditor],
		);

		assert.deepStrictEqual(result.map(({ instance, token }) => [instance.instanceId, token]), [
			[1, 'one'],
			[2, 'two'],
			[3, 'three'],
			[4, 'four'],
			[5, 'five'],
		]);
	});

	test('collects inactive-space terminals without requiring the concrete terminal group service class', () => {
		const active = terminal(6, 'active');
		const parkedPanel = terminal(7, 'parked panel');
		const parkedEditor = terminal(8, 'parked editor');
		const result = paradisCollectAllTerminalInstances(
			{ instances: [active] },
			{ paradisParkedGroups: [{ terminalInstances: [parkedPanel] }] } as unknown as Pick<ITerminalGroupService, 'paradisParkedGroups'>,
			[parkedEditor]
		);

		assert.deepStrictEqual(result.map(instance => instance.instanceId), [6, 7, 8]);
	});

	test('keeps only the current instance when detach and reattach temporarily share a token', () => {
		const oldInstance = terminal(10, 'old');
		const currentInstance = terminal(11, 'current');
		const service = tokenService(
			new Map([[10, 'shared-token'], [11, 'shared-token']]),
			new Map([['shared-token', 11]]),
		);

		const result = paradisCollectLivePaneInstances(
			{ instances: [oldInstance] } as unknown as ITerminalService,
			{ paradisParkedGroups: [{ terminalInstances: [oldInstance, currentInstance] }] } as unknown as ITerminalGroupService,
			service,
			[currentInstance],
		);

		assert.deepStrictEqual(result.map(({ instance }) => instance.instanceId), [11]);
	});

	test('retains a live token whose shell PID is not ready yet', () => {
		const pidless = terminal(20, 'pidless');
		const service = tokenService(new Map([[20, 'pidless-token']]), new Map([['pidless-token', 20]]));

		const result = paradisCollectLivePaneInstances(
			{ instances: [] } as unknown as ITerminalService,
			{ paradisParkedGroups: [] } as unknown as ITerminalGroupService,
			service,
			[pidless],
		);

		assert.strictEqual(result.length, 1);
		assert.strictEqual(result[0].instance.processId, undefined);
		assert.strictEqual(result[0].token, 'pidless-token');
	});

	test('lists pane tokens from the reverse-map current authority', () => {
		const result = paradisListCurrentPaneTokens(
			new Map([[10, 'shared-token'], [11, 'shared-token'], [12, 'other-token']]),
			new Map([['shared-token', 11], ['other-token', 12]]),
		);

		assert.deepStrictEqual(result, [
			{ instanceId: 11, token: 'shared-token' },
			{ instanceId: 12, token: 'other-token' },
		]);
	});

	test('upgrades a PIDless manifest entry after processReady without duplicate subscriptions', async () => {
		let resolveProcessReady!: () => void;
		const processReady = new Promise<void>(resolve => resolveProcessReady = resolve);
		const instance = { instanceId: 30, title: 'starting', processId: undefined as number | undefined, processReady };
		const pane = { instance: instance as unknown as ITerminalInstance, token: 'starting-token' };
		const tracker = new ParadisPaneProcessReadyTracker();
		let settled = 0;

		assert.deepStrictEqual(paradisCreatePaneShellManifestEntries([{ instanceId: 30, token: 'starting-token' }], [pane]), [
			{ token: 'starting-token' },
		]);
		tracker.track(instance, () => settled++);
		tracker.track(instance, () => settled++);
		resolveProcessReady();
		await processReady;
		await Promise.resolve();

		assert.strictEqual(settled, 1);
		instance.processId = 3030;
		assert.deepStrictEqual(paradisCreatePaneShellManifestEntries([{ instanceId: 30, token: 'starting-token' }], [pane]), [
			{ token: 'starting-token', shellPid: 3030 },
		]);
		tracker.track(instance, () => settled++);
		assert.strictEqual(settled, 1, 'a resolved instance with a PID must not be subscribed again');
		tracker.dispose();
	});
});

suite('Paradis terminal binding scope', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	test('prefers the live instance scope over group and active-scope fallbacks', () => {
		assert.deepStrictEqual(paradisResolveTerminalBindingScope({
			isSwitching: false,
			isTerminalConnected: true,
			isManagedWorkspace: true,
			recordedStateKey: 'scope:original',
			groupStateKey: 'scope:recreated-group',
			parkedEditorStateKey: undefined,
			isLiveInstance: true,
			activeStateKey: 'scope:active',
		}), { kind: 'managed', stateKey: 'scope:original' });
	});

	test('returns pending while a workspace switch or terminal reconnect is unresolved', () => {
		assert.deepStrictEqual(paradisResolveTerminalBindingScope({
			isSwitching: true,
			isTerminalConnected: true,
			isManagedWorkspace: true,
			recordedStateKey: 'scope:old',
			isLiveInstance: true,
			activeStateKey: 'scope:new',
		}), { kind: 'pending' });
		assert.deepStrictEqual(paradisResolveTerminalBindingScope({
			isSwitching: false,
			isTerminalConnected: false,
			isManagedWorkspace: true,
			recordedStateKey: 'scope:old',
			isLiveInstance: true,
			activeStateKey: 'scope:old',
		}), { kind: 'pending' });
		assert.deepStrictEqual(paradisResolveTerminalBindingScope({
			isSwitching: false,
			isTerminalConnected: true,
			isIdentityReady: false,
			isManagedWorkspace: true,
			isLiveInstance: true,
			activeStateKey: 'scope:creation-candidate',
		}), { kind: 'pending' });
	});

	test('distinguishes managed, unmanaged, and unknown stable terminals', () => {
		assert.deepStrictEqual(paradisResolveTerminalBindingScope({
			isSwitching: false,
			isTerminalConnected: true,
			isManagedWorkspace: true,
			parkedEditorStateKey: 'scope:parked',
			isLiveInstance: true,
		}), { kind: 'managed', stateKey: 'scope:parked' });
		assert.deepStrictEqual(paradisResolveTerminalBindingScope({
			isSwitching: false,
			isTerminalConnected: true,
			isManagedWorkspace: false,
			isLiveInstance: true,
			activeStateKey: undefined,
		}), { kind: 'unscoped' });
		assert.deepStrictEqual(paradisResolveTerminalBindingScope({
			isSwitching: false,
			isTerminalConnected: true,
			isManagedWorkspace: true,
			isLiveInstance: true,
			activeStateKey: undefined,
		}), { kind: 'pending' });
		assert.deepStrictEqual(paradisResolveTerminalBindingScope({
			isSwitching: false,
			isTerminalConnected: true,
			isManagedWorkspace: true,
			recordedStateKey: 'scope:disposed',
			isLiveInstance: false,
			activeStateKey: undefined,
		}), { kind: 'pending' });
	});

	test('increments revision only for stable semantic scope changes', () => {
		const tracker = new ParadisTerminalStableScopeTracker();
		const changes: unknown[] = [];
		const listener = tracker.onDidChange(event => changes.push(event));

		tracker.observe(1, { kind: 'pending' });
		tracker.observe(1, { kind: 'managed', stateKey: 'scope:a' });
		tracker.observe(1, { kind: 'managed', stateKey: 'scope:a' });
		tracker.observe(1, { kind: 'pending' });
		tracker.observe(1, { kind: 'managed', stateKey: 'scope:b' });

		assert.strictEqual(tracker.revision, 2);
		assert.deepStrictEqual(changes, [
			{ instanceId: 1, previousScope: undefined, scope: { kind: 'managed', stateKey: 'scope:a' }, revision: 1 },
			{ instanceId: 1, previousScope: { kind: 'managed', stateKey: 'scope:a' }, scope: { kind: 'managed', stateKey: 'scope:b' }, revision: 2 },
		]);

		listener.dispose();
		tracker.dispose();
	});

	test('retires a stable scope and advances revision exactly once on actual instance disposal', () => {
		const stableScopes = new ParadisTerminalStableScopeTracker();
		const retirements = new ParadisTerminalInstanceRetirementTracker();
		const onDisposed = new Emitter<void>();
		const changes: unknown[] = [];
		const listener = stableScopes.onDidChange(event => changes.push(event));
		const instance = { instanceId: 40, onDisposed: onDisposed.event };
		const retire = (instanceId: number): void => stableScopes.retire(instanceId);

		stableScopes.observe(40, { kind: 'managed', stateKey: 'scope:live' });
		retirements.track(instance, retire);
		retirements.track(instance, retire);
		onDisposed.fire();
		retirements.track(instance, retire);
		onDisposed.fire();

		assert.strictEqual(stableScopes.revision, 2);
		assert.deepStrictEqual(changes, [
			{ instanceId: 40, previousScope: undefined, scope: { kind: 'managed', stateKey: 'scope:live' }, revision: 1 },
			{ instanceId: 40, previousScope: { kind: 'managed', stateKey: 'scope:live' }, scope: undefined, revision: 2 },
		]);

		const replacementDisposed = new Emitter<void>();
		const replacement = { instanceId: 40, onDisposed: replacementDisposed.event };
		stableScopes.observe(40, { kind: 'managed', stateKey: 'scope:replacement' });
		retirements.track(replacement, retire);
		replacementDisposed.fire();
		assert.strictEqual(stableScopes.revision, 4, 'a distinct replacement object may reuse an instanceId without being mistaken for the retired object');

		listener.dispose();
		onDisposed.dispose();
		replacementDisposed.dispose();
		retirements.dispose();
		stableScopes.dispose();
	});
});
