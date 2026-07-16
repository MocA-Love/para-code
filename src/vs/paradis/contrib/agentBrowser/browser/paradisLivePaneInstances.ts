/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import { Disposable } from '../../../../base/common/lifecycle.js';
import type { ITerminalGroupService, ITerminalInstance, ITerminalService } from '../../../../workbench/contrib/terminal/browser/terminal.js';
import { paradisListParkedTerminalEditorInstances } from '../../workspaceSwitch/browser/paradisTerminalEditorPark.js';
import type { IParadisPaneTokenService } from './paradisPaneTokenService.js';

export interface IParadisLivePaneInstance {
	readonly instance: ITerminalInstance;
	readonly token: string;
}

/** Lists visible and parked terminal instances without depending on a concrete group service implementation. */
export function paradisCollectAllTerminalInstances(
	terminalService: Pick<ITerminalService, 'instances'>,
	terminalGroupService: Pick<ITerminalGroupService, 'paradisParkedGroups'>,
	parkedEditorInstances: readonly ITerminalInstance[] = paradisListParkedTerminalEditorInstances(),
): ITerminalInstance[] {
	const result: ITerminalInstance[] = [];
	const seenInstanceIds = new Set<number>();
	const add = (instance: ITerminalInstance): void => {
		if (!instance.isDisposed && !seenInstanceIds.has(instance.instanceId)) {
			seenInstanceIds.add(instance.instanceId);
			result.push(instance);
		}
	};
	for (const instance of terminalService.instances) {
		add(instance);
	}
	for (const group of terminalGroupService.paradisParkedGroups ?? []) {
		for (const instance of group.terminalInstances) {
			add(instance);
		}
	}
	for (const instance of parkedEditorInstances) {
		add(instance);
	}
	return result;
}

export function paradisCollectLivePaneInstances(
	terminalService: Pick<ITerminalService, 'instances'>,
	terminalGroupService: Pick<ITerminalGroupService, 'paradisParkedGroups'>,
	paneTokenService: Pick<IParadisPaneTokenService, 'getTokenForInstance' | 'getInstanceForToken'>,
	parkedEditorInstances: readonly ITerminalInstance[] = paradisListParkedTerminalEditorInstances(),
): IParadisLivePaneInstance[] {
	const result: IParadisLivePaneInstance[] = [];
	const seenTokens = new Set<string>();
	const add = (instance: ITerminalInstance): void => {
		const token = paneTokenService.getTokenForInstance(instance.instanceId);
		if (!token || paneTokenService.getInstanceForToken(token) !== instance.instanceId || seenTokens.has(token)) {
			return;
		}
		seenTokens.add(token);
		result.push({ instance, token });
	};

	for (const instance of paradisCollectAllTerminalInstances(terminalService, terminalGroupService, parkedEditorInstances)) {
		add(instance);
	}
	return result;
}

export function paradisListCurrentPaneTokens(
	tokenByInstanceId: ReadonlyMap<number, string>,
	instanceIdByToken: ReadonlyMap<string, number>,
): readonly { readonly instanceId: number; readonly token: string }[] {
	const result: { instanceId: number; token: string }[] = [];
	for (const [token, instanceId] of instanceIdByToken) {
		if (tokenByInstanceId.get(instanceId) === token) {
			result.push({ instanceId, token });
		}
	}
	return result;
}

export function paradisCreatePaneShellManifestEntries(
	paneTokens: readonly { readonly instanceId: number; readonly token: string }[],
	livePanes: readonly IParadisLivePaneInstance[],
): readonly { readonly token: string; readonly shellPid?: number }[] {
	const entriesByToken = new Map<string, { token: string; shellPid?: number }>(paneTokens.map(({ token }) => [token, { token }]));
	for (const { instance, token } of livePanes) {
		const shellPid = instance.processId;
		if (entriesByToken.has(token) && typeof shellPid === 'number' && shellPid > 0) {
			entriesByToken.set(token, { token, shellPid });
		}
	}
	return [...entriesByToken.values()];
}

export interface IParadisProcessReadyInstance {
	readonly processId?: number;
	readonly processReady?: Promise<void>;
}

export class ParadisPaneProcessReadyTracker extends Disposable {
	private readonly _pendingByInstance = new WeakMap<IParadisProcessReadyInstance, Promise<void>>();
	private _isDisposed = false;

	track(instance: IParadisProcessReadyInstance, onSettled: () => void): void {
		if (this._isDisposed || (typeof instance.processId === 'number' && instance.processId > 0)) {
			return;
		}
		const processReady = instance.processReady;
		if (!processReady || this._pendingByInstance.get(instance) === processReady) {
			return;
		}
		this._pendingByInstance.set(instance, processReady);
		void processReady.then(
			() => this._settle(instance, processReady, onSettled),
			() => this._settle(instance, processReady, onSettled),
		);
	}

	private _settle(instance: IParadisProcessReadyInstance, processReady: Promise<void>, onSettled: () => void): void {
		if (this._pendingByInstance.get(instance) !== processReady) {
			return;
		}
		this._pendingByInstance.delete(instance);
		if (!this._isDisposed) {
			onSettled();
		}
	}

	override dispose(): void {
		this._isDisposed = true;
		super.dispose();
	}
}
