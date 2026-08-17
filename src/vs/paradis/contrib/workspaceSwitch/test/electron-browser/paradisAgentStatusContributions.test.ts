/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import * as assert from 'assert';
import { mainWindow } from '../../../../../base/browser/window.js';
import { DeferredPromise } from '../../../../../base/common/async.js';
import { Emitter, Event } from '../../../../../base/common/event.js';
import { DisposableStore, toDisposable } from '../../../../../base/common/lifecycle.js';
import { URI } from '../../../../../base/common/uri.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { ISharedProcessService } from '../../../../../platform/ipc/electron-browser/services.js';
import { ITerminalInstance, ITerminalInstanceService, ITerminalService } from '../../../../../workbench/contrib/terminal/browser/terminal.js';
import { ILifecycleService } from '../../../../../workbench/services/lifecycle/common/lifecycle.js';
import { IParadisPaneTokenService } from '../../../agentBrowser/browser/paradisPaneTokenService.js';
import { IParadisAgentStatusSnapshot, PARADIS_AGENT_BROWSER_CHANNEL } from '../../../agentBrowser/common/paradisAgentBrowser.js';
import { IParadisAgentStatusSnapshotOutcome, IParadisAgentStatusSnapshotService } from '../../../agentBrowser/electron-browser/paradisAgentStatusSnapshotService.js';
import { IParadisNotificationsSettingsService } from '../../../notifications/browser/paradisNotificationsSettings.js';
import { PARADIS_NOTIFICATIONS_CHANNEL } from '../../../notifications/common/paradisNotifications.js';
import { ParadisNotificationTrigger } from '../../../notifications/electron-browser/paradisNotificationTrigger.contribution.js';
import { ParadisAgentStatusPoller } from '../../electron-browser/paradisAgentStatus.contribution.js';
import { IParadisAgentStatusStore, IParadisTerminalScopeService, IParadisWorkspaceSwitchService, IParadisWorktreeService } from '../../common/paradisWorkspaceSwitch.js';

suite('Paradis agent status contribution wiring', () => {
	const store = ensureNoDisposablesAreLeakedInTestSuite();

	test('fans one snapshot into actual notification and status contributions and refreshes after real terminal exits', async () => {
		forceFocusedDocument(store);
		const producer = new MultiListenerSnapshotService();
		const exitOne = new DeferredPromise<void>();
		const exitTwo = new DeferredPromise<void>();
		const acknowledgementTokens: string[] = [];
		const terminalExitTokens: string[] = [];
		let notificationTransitionAttempts = 0;
		const sharedProcessService = {
			getChannel: (name: string) => {
				if (name === PARADIS_NOTIFICATIONS_CHANNEL) {
					return { listen: () => Event.None, call: async () => undefined };
				}
				assert.strictEqual(name, PARADIS_AGENT_BROWSER_CHANNEL);
				return {
					call: <T>(command: string, args?: readonly unknown[]) => {
						const token = args?.[0] as string | undefined;
						if (command === 'acknowledgePaneStatus') {
							acknowledgementTokens.push(token!);
							return Promise.resolve(undefined) as Promise<T>;
						}
						assert.strictEqual(command, 'notifyTerminalExit');
						terminalExitTokens.push(token!);
						return (token === 'terminal-one' ? exitOne.p : exitTwo.p) as Promise<T>;
					},
				};
			},
		} as unknown as ISharedProcessService;
		const paneTokenService = {
			onDidChange: Event.None,
			getTokenForInstance: (instanceId: number) => instanceId === 1 ? 'terminal-one' : 'terminal-two',
			getInstanceForToken: (token: string) => token === 'terminal-one' ? 1 : token === 'terminal-two' ? 2 : undefined,
		} as unknown as IParadisPaneTokenService;
		const terminalScopeService = {
			getStateKeyForInstance: () => 'space-a',
			resolveScope: () => ({ kind: 'managed', stateKey: 'space-a' }),
		} as unknown as IParadisTerminalScopeService;
		const workspaceSwitchService = {
			activeStateKey: 'space-a',
			repositories: [{ id: 'space-a', name: 'Space A', uri: URI.file('/repos/space-a') }],
			onDidSwitchScope: Event.None,
		} as unknown as IParadisWorkspaceSwitchService;
		const worktreeService = { getWorktrees: () => [] } as unknown as IParadisWorktreeService;
		const statusStore = new TestStatusStore();
		const terminalOne = createTerminal(1);
		const terminalTwo = createTerminal(2);
		store.add(terminalOne.disposables);
		store.add(terminalTwo.disposables);
		const terminalService = { instances: [terminalOne.instance, terminalTwo.instance] } as unknown as ITerminalService;
		const settingsService = {
			onDidChange: Event.None,
			getNotifyWhileFocused: () => {
				notificationTransitionAttempts++;
				return false;
			},
		} as unknown as IParadisNotificationsSettingsService;
		const logService = { trace: () => undefined, warn: () => undefined } as never;

		const notificationContribution = store.add(new ParadisNotificationTrigger(
			sharedProcessService,
			paneTokenService,
			terminalScopeService,
			workspaceSwitchService,
			worktreeService,
			{} as never,
			settingsService,
			{} as never,
			terminalService,
			{} as never,
			{ notify: () => undefined } as never,
			logService,
			producer,
		));
		const statusContribution = store.add(new ParadisAgentStatusPoller(
			sharedProcessService,
			paneTokenService,
			terminalScopeService,
			workspaceSwitchService,
			worktreeService,
			statusStore,
			logService,
			terminalService,
			{ onDidCreateInstance: Event.None } as unknown as ITerminalInstanceService,
			{ onWillShutdown: Event.None } as unknown as ILifecycleService,
			producer,
		));

		const sharedSnapshot: IParadisAgentStatusSnapshot = {
			paneStatuses: [{ token: 'terminal-one', status: 'review', changedAt: 1 }],
			agentHookTokens: ['terminal-one'],
		};
		producer.publish({ sequence: 1, snapshot: sharedSnapshot });
		producer.publish({ sequence: 2, snapshot: sharedSnapshot });

		assert.strictEqual(notificationTransitionAttempts, 1);
		assert.deepStrictEqual(acknowledgementTokens, ['terminal-one', 'terminal-one']);

		terminalOne.exit.fire();
		assert.deepStrictEqual(terminalExitTokens, ['terminal-one']);
		exitOne.complete(undefined);
		await flushAsync();
		assert.strictEqual(producer.refreshRequests, 1);

		terminalTwo.exit.fire();
		assert.deepStrictEqual(terminalExitTokens, ['terminal-one', 'terminal-two']);
		statusContribution.dispose();
		exitTwo.complete(undefined);
		await flushAsync();
		assert.strictEqual(producer.refreshRequests, 1);

		notificationContribution.dispose();
	});
});

function createTerminal(instanceId: number): { readonly instance: ITerminalInstance; readonly exit: Emitter<void>; readonly disposables: DisposableStore } {
	const disposables = new DisposableStore();
	const exit = disposables.add(new Emitter<void>());
	const disposed = disposables.add(new Emitter<void>());
	return {
		instance: { instanceId, onExit: exit.event, onDisposed: disposed.event } as unknown as ITerminalInstance,
		exit,
		disposables,
	};
}

function forceFocusedDocument(store: { add<T extends { dispose(): void }>(disposable: T): T }): void {
	const document = mainWindow.document;
	const hiddenDescriptor = Object.getOwnPropertyDescriptor(document, 'hidden');
	const hasFocusDescriptor = Object.getOwnPropertyDescriptor(document, 'hasFocus');
	Object.defineProperty(document, 'hidden', { configurable: true, value: false });
	Object.defineProperty(document, 'hasFocus', { configurable: true, value: () => true });
	store.add(toDisposable(() => {
		if (hiddenDescriptor) {
			Object.defineProperty(document, 'hidden', hiddenDescriptor);
		} else {
			delete (document as { hidden?: boolean }).hidden;
		}
		if (hasFocusDescriptor) {
			Object.defineProperty(document, 'hasFocus', hasFocusDescriptor);
		} else {
			delete (document as { hasFocus?: () => boolean }).hasFocus;
		}
	}));
}

async function flushAsync(): Promise<void> {
	await Promise.resolve();
	await Promise.resolve();
}

class MultiListenerSnapshotService implements IParadisAgentStatusSnapshotService {
	declare readonly _serviceBrand: undefined;
	private readonly listeners = new Set<(outcome: IParadisAgentStatusSnapshotOutcome) => void>();
	refreshRequests = 0;

	subscribe(listener: (outcome: IParadisAgentStatusSnapshotOutcome) => void) {
		this.listeners.add(listener);
		return toDisposable(() => this.listeners.delete(listener));
	}

	requestRefresh(): void {
		this.refreshRequests++;
	}

	publish(outcome: IParadisAgentStatusSnapshotOutcome): void {
		for (const listener of [...this.listeners]) {
			listener(outcome);
		}
	}
}

class TestStatusStore implements IParadisAgentStatusStore {
	declare readonly _serviceBrand: undefined;
	readonly onDidChangeAgentStatuses = Event.None;
	getScopeStatus() { return undefined; }
	getScopeBreakdown() { return []; }
	getInstanceStatus() { return undefined; }
	isAgentInstance() { return false; }
	hasDiscoveredAgentSession() { return false; }
	setDiscoveredAgentPaneTokens(): void { }
	setScopeBreakdowns(): void { }
	setInstanceStates(): void { }
}
