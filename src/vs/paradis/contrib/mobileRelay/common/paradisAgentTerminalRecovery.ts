/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import { Event } from '../../../../base/common/event.js';
import { Disposable, DisposableMap, DisposableStore, IDisposable, MutableDisposable } from '../../../../base/common/lifecycle.js';
import { ICommandDetectionCapability, TerminalCapability } from '../../../../platform/terminal/common/capabilities/capabilities.js';

export interface IParadisAgentRecoveryTerminal {
	readonly instanceId: number;
	readonly isDisposed: boolean;
	readonly onDisposed: (listener: () => void) => IDisposable;
	readonly capabilities: {
		get(capability: TerminalCapability.CommandDetection): ICommandDetectionCapability | undefined;
		readonly onDidAddCommandDetectionCapability: Event<ICommandDetectionCapability>;
		readonly onDidRemoveCommandDetectionCapability: Event<void>;
	};
}

export interface IParadisAgentTerminalRecoveryCallbacks<T extends IParadisAgentRecoveryTerminal> {
	/** exact reverse-authority key。未割当や逆引き不一致時はundefined。 */
	readonly getAuthorityKey: (instance: T) => string | undefined;
	readonly onCommandExecuted: (instance: T, commandLine: string) => void;
	readonly onCommandFinished: (instance: T, commandLine: string) => void;
}

interface IRecoveredCommand {
	readonly authorityKey: string;
	readonly capability: ICommandDetectionCapability;
	readonly commandLine: string;
}

class ParadisTrackedAgentTerminal<T extends IParadisAgentRecoveryTerminal> extends Disposable {
	private readonly commandDetectionListeners = this._register(new MutableDisposable<DisposableStore>());
	private commandDetection: ICommandDetectionCapability | undefined;
	private recoveredCommand: IRecoveredCommand | undefined;

	constructor(
		readonly instance: T,
		private readonly callbacks: IParadisAgentTerminalRecoveryCallbacks<T>,
		private readonly onDisposed: () => void,
	) {
		super();
		this._register(instance.capabilities.onDidAddCommandDetectionCapability(capability => this.attach(capability)));
		this._register(instance.capabilities.onDidRemoveCommandDetectionCapability(() => this.attach(undefined)));
		this._register(instance.onDisposed(() => this.onDisposed()));
		this.attach(instance.capabilities.get(TerminalCapability.CommandDetection));
	}

	recoverExecutingCommand(): void {
		const capability = this.commandDetection;
		const commandLine = capability?.executingCommand;
		const authorityKey = this.callbacks.getAuthorityKey(this.instance);
		if (capability === undefined || commandLine === undefined || authorityKey === undefined) {
			return;
		}
		const recovered = this.recoveredCommand;
		if (recovered?.capability === capability
			&& recovered.authorityKey === authorityKey
			&& recovered.commandLine === commandLine) {
			return;
		}
		this.recoveredCommand = { authorityKey, capability, commandLine };
		this.callbacks.onCommandExecuted(this.instance, commandLine);
	}

	private attach(capability: ICommandDetectionCapability | undefined): void {
		if (this.commandDetection === capability) {
			this.recoverExecutingCommand();
			return;
		}
		this.commandDetection = capability;
		this.recoveredCommand = undefined;
		if (capability === undefined) {
			this.commandDetectionListeners.clear();
			return;
		}
		const listeners = new DisposableStore();
		listeners.add(capability.onCommandExecuted(command => {
			const commandLine = command.command ?? '';
			const authorityKey = this.callbacks.getAuthorityKey(this.instance);
			if (authorityKey !== undefined) {
				this.recoveredCommand = { authorityKey, capability, commandLine };
			}
			this.callbacks.onCommandExecuted(this.instance, commandLine);
		}));
		listeners.add(capability.onCommandFinished(command => this.callbacks.onCommandFinished(this.instance, command.command ?? '')));
		this.commandDetectionListeners.value = listeners;
		this.recoverExecutingCommand();
	}
}

/**
 * 表示中・背景・panel park・editor parkを含むexact authority集合へ直接収束する。
 * 汎用terminalService capability eventの初期集合に依存せず、instance/capabilityごとの購読を一つに保つ。
 */
export class ParadisAgentTerminalRecoveryTracker<T extends IParadisAgentRecoveryTerminal> extends Disposable {
	private readonly tracked = this._register(new DisposableMap<number, ParadisTrackedAgentTerminal<T>>());

	constructor(
		private readonly getLiveAuthoritativeTerminals: () => readonly T[],
		private readonly callbacks: IParadisAgentTerminalRecoveryCallbacks<T>,
	) {
		super();
		this.reconcile();
	}

	get trackedCount(): number { return this.tracked.size; }

	reconcile(): void {
		const live = new Map<number, T>();
		for (const instance of this.getLiveAuthoritativeTerminals()) {
			if (!instance.isDisposed && !live.has(instance.instanceId)) {
				live.set(instance.instanceId, instance);
			}
		}

		for (const [instanceId, tracked] of [...this.tracked]) {
			if (live.get(instanceId) !== tracked.instance) {
				this.tracked.deleteAndDispose(instanceId);
			}
		}

		for (const [instanceId, instance] of live) {
			let tracked = this.tracked.get(instanceId);
			if (tracked === undefined) {
				tracked = new ParadisTrackedAgentTerminal(instance, this.callbacks, () => {
					if (this.tracked.get(instanceId)?.instance === instance) {
						this.tracked.deleteAndDispose(instanceId);
					}
				});
				this.tracked.set(instanceId, tracked);
			}
			tracked.recoverExecutingCommand();
		}
	}
}
