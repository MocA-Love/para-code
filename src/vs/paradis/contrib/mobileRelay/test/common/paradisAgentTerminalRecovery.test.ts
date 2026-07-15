/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese test comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import assert from 'assert';
import { Emitter } from '../../../../../base/common/event.js';
import { toDisposable } from '../../../../../base/common/lifecycle.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { ICommandDetectionCapability, ITerminalCommand, TerminalCapability } from '../../../../../platform/terminal/common/capabilities/capabilities.js';
import { ParadisAgentCommandDeliveryCoordinator } from '../../common/paradisAgentCommandLifecycle.js';
import { IParadisAgentRecoveryTerminal, ParadisAgentTerminalRecoveryTracker } from '../../common/paradisAgentTerminalRecovery.js';

suite('ParadisAgentTerminalRecoveryTracker', () => {
	const store = ensureNoDisposablesAreLeakedInTestSuite();

	test('recovers a parked agent and delivers finish then the same command restart without duplicate subscriptions', async () => {
		const terminal = store.add(new TestRecoveryTerminal(7));
		const capability = store.add(new TestCommandDetectionCapability('codex'));
		terminal.addCommandDetection(capability as unknown as ICommandDetectionCapability);
		const tokenByInstance = new Map([[7, 'pane-7']]);
		const instanceByToken = new Map([['pane-7', 7]]);
		const starts: number[] = [];
		const finishes: number[] = [];
		const coordinator = store.add(new ParadisAgentCommandDeliveryCoordinator({
			syncRegistry: async () => { },
			onProvisionalChange: () => { },
			onGenerationEnded: () => { },
		}));
		const tracker = store.add(new ParadisAgentTerminalRecoveryTracker(
			() => instanceByToken.get('pane-7') === terminal.instanceId ? [terminal] : [],
			{
				getAuthorityKey: instance => tokenByInstance.get(instance.instanceId),
				onCommandExecuted: (_instance, commandLine) => coordinator.start('pane-7', commandLine, async generation => {
					starts.push(generation);
					return 'accepted';
				}),
				onCommandFinished: (_instance, commandLine) => coordinator.finish('pane-7', commandLine, async generation => {
					finishes.push(generation);
					return 'accepted';
				}),
			},
		));

		await coordinator.whenIdle('pane-7');
		assert.deepStrictEqual(starts, [1], 'parked initial executing command is recovered');
		tracker.reconcile();
		tracker.reconcile();
		assert.strictEqual(capability.executedListenerCount, 1);
		assert.strictEqual(capability.finishedListenerCount, 1);

		capability.finish('codex');
		await coordinator.whenIdle('pane-7');
		capability.execute('codex');
		await coordinator.whenIdle('pane-7');

		assert.deepStrictEqual(finishes, [1]);
		assert.deepStrictEqual(starts, [1, 2]);
		assert.strictEqual(tracker.trackedCount, 1);
	});

	test('converges when token and command detection arrive in either order and retires lost authority', () => {
		const terminal = store.add(new TestRecoveryTerminal(9));
		const capability = store.add(new TestCommandDetectionCapability('claude'));
		let authoritative = false;
		const commands: string[] = [];
		const tracker = store.add(new ParadisAgentTerminalRecoveryTracker(
			() => authoritative ? [terminal] : [],
			{
				getAuthorityKey: () => authoritative ? 'pane-9' : undefined,
				onCommandExecuted: (_instance, commandLine) => commands.push(commandLine),
				onCommandFinished: () => { },
			},
		));

		terminal.addCommandDetection(capability as unknown as ICommandDetectionCapability);
		authoritative = true;
		tracker.reconcile();
		assert.deepStrictEqual(commands, ['claude']);
		assert.strictEqual(tracker.trackedCount, 1);

		authoritative = false;
		tracker.reconcile();
		assert.strictEqual(tracker.trackedCount, 0);
		assert.strictEqual(capability.executedListenerCount, 0);
	});
});

class TestRecoveryTerminal implements IParadisAgentRecoveryTerminal {
	private readonly onDisposedEmitter = this._store.add(new Emitter<void>());
	readonly onDisposed = this.onDisposedEmitter.event;
	private readonly addedEmitter = this._store.add(new Emitter<ICommandDetectionCapability>());
	private readonly removedEmitter = this._store.add(new Emitter<void>());
	private commandDetection: ICommandDetectionCapability | undefined;
	readonly capabilities = {
		get: (_capability: TerminalCapability.CommandDetection) => this.commandDetection,
		onDidAddCommandDetectionCapability: this.addedEmitter.event,
		onDidRemoveCommandDetectionCapability: this.removedEmitter.event,
	};
	isDisposed = false;

	constructor(readonly instanceId: number, private readonly _store = new DisposableTestStore()) { }

	addCommandDetection(capability: ICommandDetectionCapability): void {
		this.commandDetection = capability;
		this.addedEmitter.fire(capability);
	}

	dispose(): void {
		if (!this.isDisposed) {
			this.isDisposed = true;
			this.onDisposedEmitter.fire();
			this._store.dispose();
		}
	}
}

class TestCommandDetectionCapability implements Pick<ICommandDetectionCapability, 'executingCommand' | 'onCommandExecuted' | 'onCommandFinished'> {
	private readonly executedEmitter = this._store.add(new Emitter<ITerminalCommand>());
	private readonly finishedEmitter = this._store.add(new Emitter<ITerminalCommand>());
	private _executedListenerCount = 0;
	private _finishedListenerCount = 0;
	readonly onCommandExecuted = this.countedEvent(this.executedEmitter, () => this._executedListenerCount++, () => this._executedListenerCount--);
	readonly onCommandFinished = this.countedEvent(this.finishedEmitter, () => this._finishedListenerCount++, () => this._finishedListenerCount--);

	constructor(public executingCommand: string | undefined, private readonly _store = new DisposableTestStore()) { }

	get executedListenerCount(): number { return this._executedListenerCount; }
	get finishedListenerCount(): number { return this._finishedListenerCount; }

	execute(command: string): void {
		this.executingCommand = command;
		this.executedEmitter.fire({ command } as ITerminalCommand);
	}

	finish(command: string): void {
		this.executingCommand = undefined;
		this.finishedEmitter.fire({ command } as ITerminalCommand);
	}

	private countedEvent<T>(emitter: Emitter<T>, onAdd: () => void, onRemove: () => void): Emitter<T>['event'] {
		return (listener, thisArgs) => {
			onAdd();
			const subscription = emitter.event(listener, thisArgs);
			return toDisposable(() => {
				subscription.dispose();
				onRemove();
			});
		};
	}

	dispose(): void { this._store.dispose(); }
}

class DisposableTestStore {
	private readonly values: { dispose(): void }[] = [];
	add<T extends { dispose(): void }>(value: T): T { this.values.push(value); return value; }
	dispose(): void { for (const value of this.values.splice(0)) { value.dispose(); } }
}
