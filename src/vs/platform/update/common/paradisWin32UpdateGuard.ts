/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import { Idle, State, StateType, UpdateType } from './update.js';

/**
 * Detects an update feed response that would restart an already-pending overwrite update.
 */
export function shouldStopParadisOverwriteLoop(stateType: StateType, pendingVersion: string | undefined, offeredVersion: string | undefined): boolean {
	return stateType === StateType.Overwriting && !!pendingVersion && pendingVersion === offeredVersion;
}

export interface IParadisOverwriteLoopGuard {
	overwrite: false;
	state: Idle;
	shouldReturn: true;
}

/**
 * Returns the complete state transition for an update response that would restart an overwrite loop.
 */
export function getParadisOverwriteLoopGuard(stateType: StateType, pendingVersion: string | undefined, offeredVersion: string | undefined, updateType: UpdateType, explicit: boolean): IParadisOverwriteLoopGuard | undefined {
	if (!shouldStopParadisOverwriteLoop(stateType, pendingVersion, offeredVersion)) {
		return undefined;
	}

	return {
		overwrite: false,
		state: State.Idle(updateType, undefined, explicit || undefined),
		shouldReturn: true
	};
}
