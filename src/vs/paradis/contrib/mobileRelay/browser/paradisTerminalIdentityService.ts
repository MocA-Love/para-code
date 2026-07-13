/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-PATCH/PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import { Emitter, Event } from '../../../../base/common/event.js';
import { Disposable, DisposableMap, IDisposable } from '../../../../base/common/lifecycle.js';
import { generateUuid } from '../../../../base/common/uuid.js';
import { InstantiationType, registerSingleton } from '../../../../platform/instantiation/common/extensions.js';
import { createDecorator, IInstantiationService } from '../../../../platform/instantiation/common/instantiation.js';
import { IShellLaunchConfig } from '../../../../platform/terminal/common/terminal.js';
import { ITerminalInstance, ITerminalInstanceService } from '../../../../workbench/contrib/terminal/browser/terminal.js';
import { terminalKeyFromShellIntegrationNonce } from '../common/paradisTerminalPersistence.js';

export const IParadisTerminalIdentityService = createDecorator<IParadisTerminalIdentityService>('paradisTerminalIdentityService');

export interface IParadisTerminalIdentityService {
	readonly _serviceBrand: undefined;
	readonly onDidChange: Event<void>;
	prepareShellLaunchConfig(shellLaunchConfig: IShellLaunchConfig): void;
	getTerminalKey(instanceId: number): string | undefined;
	getInstanceId(terminalKey: string): number | undefined;
}

class ParadisTerminalIdentityService extends Disposable implements IParadisTerminalIdentityService {
	declare readonly _serviceBrand: undefined;

	private readonly _onDidChange = this._register(new Emitter<void>());
	readonly onDidChange: Event<void> = this._onDidChange.event;

	private readonly keyByInstanceId = new Map<number, string>();
	private readonly instanceIdByKey = new Map<string, number>();
	private readonly instanceListeners = this._register(new DisposableMap<number, IDisposable>());

	constructor(
		@ITerminalInstanceService terminalInstanceService: ITerminalInstanceService,
	) {
		super();
		this._register(terminalInstanceService.onDidCreateInstance(instance => this.handleInstanceCreated(instance)));
	}

	prepareShellLaunchConfig(shellLaunchConfig: IShellLaunchConfig): void {
		if (shellLaunchConfig.attachPersistentProcess === undefined && shellLaunchConfig.shellIntegrationNonce === undefined) {
			shellLaunchConfig.shellIntegrationNonce = generateUuid();
		}
	}

	getTerminalKey(instanceId: number): string | undefined {
		return this.keyByInstanceId.get(instanceId);
	}

	getInstanceId(terminalKey: string): number | undefined {
		return this.instanceIdByKey.get(terminalKey);
	}

	private handleInstanceCreated(instance: ITerminalInstance): void {
		this.registerInstance(instance, terminalKeyFromShellIntegrationNonce(instance.shellIntegrationNonce));
	}

	private registerInstance(instance: ITerminalInstance, terminalKey: string): void {
		const existingInstanceId = this.instanceIdByKey.get(terminalKey);
		if (existingInstanceId !== undefined && existingInstanceId !== instance.instanceId) {
			return;
		}
		this.keyByInstanceId.set(instance.instanceId, terminalKey);
		this.instanceIdByKey.set(terminalKey, instance.instanceId);
		this.instanceListeners.set(instance.instanceId, instance.onDisposed(() => {
			this.keyByInstanceId.delete(instance.instanceId);
			if (this.instanceIdByKey.get(terminalKey) === instance.instanceId) {
				this.instanceIdByKey.delete(terminalKey);
			}
			this.instanceListeners.deleteAndDispose(instance.instanceId);
			this._onDidChange.fire();
		}));
		this._onDidChange.fire();
	}
}

registerSingleton(IParadisTerminalIdentityService, ParadisTerminalIdentityService, InstantiationType.Delayed);

/** 全ターミナル生成の直前に service を初期化し、生成予定 config へキーを予約する。 */
export function paradisPrepareTerminalIdentity(instantiationService: IInstantiationService, shellLaunchConfig: IShellLaunchConfig): void {
	try {
		instantiationService.invokeFunction(accessor => accessor.get(IParadisTerminalIdentityService).prepareShellLaunchConfig(shellLaunchConfig));
	} catch {
		// identity 初期化失敗でターミナル生成自体を止めない。
	}
}
