/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import { ILogService } from '../../log/common/log.js';

/**
 * The loop that brings the saved forwarded ports back when a remote window opens again.
 *
 * Upstream's loop in `TunnelModel.restoreForwarded` has two weak spots:
 * - a tunnel that throws while it is forwarded ends the loop. The tunnels after it are not
 *   restored, and the model never reports the restore as complete, so every later forward of
 *   that window waits forever.
 * - every restored tunnel schedules a save of the tunnels forwarded so far. When the rest of the
 *   loop takes longer than the save's delay, the saved list is replaced by that partial list, and
 *   a window that goes away before the loop ends has lost the tunnels that were still to come.
 *
 * `tunnelModel.ts` calls into this file from two places (both marked PARA-PATCH): the loop runs
 * through {@link paradisRestoreTunnelsOneByOne}, and the save asks
 * {@link paradisDeferTunnelStoreWhileRestoring} whether it has to wait.
 *
 * What is saved once the loop is done is what upstream saves: the tunnels that are forwarded
 * then. A tunnel that could not be restored is not kept in the saved list.
 */

interface IParadisTunnelRestoreState {
	/** How many restore loops of the owner are running (the model restores again when the saved value changes). */
	running: number;
	/** Whether a save was asked for, and put off, while a loop was running. */
	storeDeferred: boolean;
}

const restoreStates = new WeakMap<object, IParadisTunnelRestoreState>();

/**
 * Whether `owner` is restoring its tunnels, in which case the caller must not save now. The save
 * is remembered and asked for again when the restore is done.
 */
export function paradisDeferTunnelStoreWhileRestoring(owner: object): boolean {
	const state = restoreStates.get(owner);
	if (!state) {
		return false;
	}
	state.storeDeferred = true;
	return true;
}

/**
 * Restores `tunnels` one after the other. A tunnel that fails is logged and skipped. Saves that
 * `owner` puts off through {@link paradisDeferTunnelStoreWhileRestoring} in the meantime are made
 * up for by one call of `store` when the last running restore of `owner` is done.
 */
export async function paradisRestoreTunnelsOneByOne<T extends { readonly remoteHost: string; readonly remotePort: number }>(owner: object, tunnels: readonly T[], restoreOne: (tunnel: T) => Promise<void>, logService: ILogService, store: () => void): Promise<void> {
	let state = restoreStates.get(owner);
	if (!state) {
		state = { running: 0, storeDeferred: false };
		restoreStates.set(owner, state);
	}
	state.running++;
	try {
		for (const tunnel of tunnels) {
			try {
				await restoreOne(tunnel);
			} catch (error) {
				logService.warn(`ForwardedPorts: (TunnelModel) could not restore ${tunnel.remoteHost}:${tunnel.remotePort}, continuing with the next port.`, error);
			}
		}
	} finally {
		state.running--;
		if (state.running === 0) {
			restoreStates.delete(owner);
			if (state.storeDeferred) {
				store();
			}
		}
	}
}
