/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

/** Dependency-free serializable value so mobile can consume the reducer without importing workbench types. */
export type ParadisOfficeRecoverySerializableData =
	| null | boolean | number | string
	| readonly ParadisOfficeRecoverySerializableData[]
	| { readonly [key: string]: ParadisOfficeRecoverySerializableData };

/** Structural copy of the public source identity. It intentionally omits all runtime handles. */
export interface ParadisOfficeRecoverySourceDescriptor {
	readonly kind: 'file' | 'remote' | 'gitCommit' | 'gitIndex' | 'workingTree' | 'untitled' | 'sideMissing';
	readonly uri?: string;
	readonly revisionHint?: string;
	readonly displayName: string;
	readonly side?: 'original' | 'modified';
}

export interface ParadisOfficeRecoveryBlankError {
	readonly stage: 'render';
	readonly code: 'blank';
	readonly safeMessage: 'The Office renderer produced no visible content.';
	readonly severity: 'error';
	readonly retryable: true;
	readonly recoverable: true;
	readonly userAction: 'retry';
}

/** Serializable source identity for one document or comparison. Runtime handles stay in the platform adapter. */
export type ParadisOfficeRecoverySource =
	| { readonly mode: 'document'; readonly source: ParadisOfficeRecoverySourceDescriptor }
	| { readonly mode: 'comparison'; readonly original: ParadisOfficeRecoverySourceDescriptor; readonly modified: ParadisOfficeRecoverySourceDescriptor };

/** Last recoverable viewer identity. It deliberately contains no EditorInput, watcher, stream, or webview handle. */
export interface IParadisOfficeRecoverySnapshot {
	readonly source: ParadisOfficeRecoverySource;
	readonly viewState: Readonly<Record<string, ParadisOfficeRecoverySerializableData>>;
}

export type ParadisOfficeRecoveryPhase = 'idle' | 'loading' | 'ready' | 'waitingForSource' | 'failed';

/** Pure recovery state. `generation` fences every asynchronous platform completion. */
export interface IParadisOfficeRecoveryState {
	readonly phase: ParadisOfficeRecoveryPhase;
	readonly generation: number;
	readonly retryCount: 0 | 1 | 2;
	readonly pendingWatch: boolean;
	readonly active?: IParadisOfficeRecoverySnapshot;
	readonly committed?: IParadisOfficeRecoverySnapshot;
	readonly error?: ParadisOfficeRecoveryBlankError;
}

export type ParadisOfficeRecoveryEvent =
	| { readonly type: 'rendered'; readonly generation: number; readonly hasExpectedRoot: boolean }
	/**
	 * The render budget elapsed without any `rendered` observation for this generation.
	 *
	 * Without this the reducer only ever advances when a render reports back, so a surface whose
	 * renderer never answers at all stays in `loading` forever and no effect is ever produced.
	 * A timeout escalates exactly like a blank render, so the bounded retry ladder is shared.
	 */
	| { readonly type: 'renderTimedOut'; readonly generation: number }
	| { readonly type: 'cancelled'; readonly generation: number }
	| { readonly type: 'sourceUnavailable'; readonly generation: number }
	| { readonly type: 'watchChanged' }
	| { readonly type: 'retry' };

export type ParadisOfficeRecoveryEffect =
	| { readonly type: 'load'; readonly generation: number }
	| { readonly type: 'remount'; readonly generation: number }
	| { readonly type: 'recreate'; readonly generation: number }
	| { readonly type: 'restore'; readonly generation: number; readonly snapshot: IParadisOfficeRecoverySnapshot }
	| {
		readonly type: 'showError';
		readonly generation: number;
		readonly code: 'render.blank';
		readonly actions: readonly ['retry', 'openExternally'];
	};

export interface IParadisOfficeRecoveryTransition {
	readonly state: IParadisOfficeRecoveryState;
	readonly effects: readonly ParadisOfficeRecoveryEffect[];
}

export function createParadisOfficeRecoveryState(): IParadisOfficeRecoveryState {
	return { phase: 'idle', generation: 0, retryCount: 0, pendingWatch: false };
}

/** Starts a new input epoch while retaining the last committed snapshot for cancel/failure restoration. */
export function beginParadisOfficeRecovery(state: IParadisOfficeRecoveryState, active: IParadisOfficeRecoverySnapshot): IParadisOfficeRecoveryTransition {
	const generation = state.generation + 1;
	return {
		state: {
			phase: 'loading', generation, retryCount: 0, pendingWatch: false, active,
			...(state.committed ? { committed: state.committed } : {}),
		},
		effects: [{ type: 'load', generation }],
	};
}

function noEffect(state: IParadisOfficeRecoveryState): IParadisOfficeRecoveryTransition {
	return { state, effects: [] };
}

function blankError(): ParadisOfficeRecoveryBlankError {
	return {
		stage: 'render', code: 'blank', safeMessage: 'The Office renderer produced no visible content.',
		severity: 'error', retryable: true, recoverable: true, userAction: 'retry',
	};
}

/**
 * Advances the bounded retry ladder for a generation that produced no usable render.
 *
 * The first failure remounts the already parsed snapshot. The second recreates the isolated
 * surface. A third never retries: it exposes the stable `render.blank` result and explicit actions.
 * A blank render and an elapsed render budget share this ladder — both mean the same thing to the
 * user (nothing readable is on screen) and neither is worth an unbounded number of attempts.
 */
function escalateFailedRender(state: IParadisOfficeRecoveryState & { readonly active: IParadisOfficeRecoverySnapshot }): IParadisOfficeRecoveryTransition {
	if (state.retryCount === 0) {
		const generation = state.generation + 1;
		return {
			state: {
				phase: 'loading', generation, retryCount: 1, pendingWatch: state.pendingWatch, active: state.active,
				...(state.committed ? { committed: state.committed } : {}),
			},
			effects: [{ type: 'remount', generation }],
		};
	}
	if (state.retryCount === 1) {
		const generation = state.generation + 1;
		return {
			state: {
				phase: 'loading', generation, retryCount: 2, pendingWatch: state.pendingWatch, active: state.active,
				...(state.committed ? { committed: state.committed } : {}),
			},
			effects: [{ type: 'recreate', generation }],
		};
	}
	return {
		state: {
			phase: 'failed', generation: state.generation, retryCount: 2, pendingWatch: false, active: state.active,
			...(state.committed ? { committed: state.committed } : {}), error: blankError(),
		},
		effects: [{ type: 'showError', generation: state.generation, code: 'render.blank', actions: ['retry', 'openExternally'] }],
	};
}

/**
 * Reduces lifecycle observations into bounded, platform-neutral effects.
 *
 * The first blank remounts the already parsed snapshot. The second recreates the isolated surface.
 * A third blank never retries: it exposes the stable `render.blank` result and explicit actions.
 */
export function reduceParadisOfficeRecovery(state: IParadisOfficeRecoveryState, event: ParadisOfficeRecoveryEvent): IParadisOfficeRecoveryTransition {
	switch (event.type) {
		case 'rendered': {
			if (event.generation !== state.generation || state.phase !== 'loading' || !state.active) {
				return noEffect(state);
			}
			if (event.hasExpectedRoot) {
				if (state.pendingWatch) {
					const generation = state.generation + 1;
					return {
						state: { phase: 'loading', generation, retryCount: 0, pendingWatch: false, active: state.active, committed: state.active },
						effects: [{ type: 'load', generation }],
					};
				}
				return {
					state: { phase: 'ready', generation: state.generation, retryCount: 0, pendingWatch: false, active: state.active, committed: state.active },
					effects: [],
				};
			}
			return escalateFailedRender({ ...state, active: state.active });
		}
		case 'renderTimedOut': {
			if (event.generation !== state.generation || state.phase !== 'loading' || !state.active) {
				return noEffect(state);
			}
			return escalateFailedRender({ ...state, active: state.active });
		}
		case 'cancelled': {
			if (event.generation !== state.generation) {
				return noEffect(state);
			}
			const generation = state.generation + 1;
			if (!state.committed) {
				return { state: { phase: 'idle', generation, retryCount: 0, pendingWatch: false }, effects: [] };
			}
			return {
				state: { phase: 'ready', generation, retryCount: 0, pendingWatch: false, active: state.committed, committed: state.committed },
				effects: [{ type: 'restore', generation, snapshot: state.committed }],
			};
		}
		case 'sourceUnavailable': {
			if (event.generation !== state.generation || state.phase !== 'loading') {
				return noEffect(state);
			}
			if (state.pendingWatch && state.active) {
				const generation = state.generation + 1;
				return {
					state: {
						phase: 'loading', generation, retryCount: 0, pendingWatch: false, active: state.active,
						...(state.committed ? { committed: state.committed } : {}),
					},
					effects: [{ type: 'load', generation }],
				};
			}
			if (!state.committed) {
				return {
					state: {
						phase: 'waitingForSource', generation: state.generation, retryCount: 0, pendingWatch: false,
						...(state.active ? { active: state.active } : {}),
					},
					effects: [],
				};
			}
			return {
				state: { phase: 'waitingForSource', generation: state.generation, retryCount: 0, pendingWatch: false, active: state.committed, committed: state.committed },
				effects: [{ type: 'restore', generation: state.generation, snapshot: state.committed }],
			};
		}
		case 'watchChanged': {
			if (!state.active) {
				return noEffect(state);
			}
			if (state.phase === 'loading') {
				return state.pendingWatch ? noEffect(state) : noEffect({ ...state, pendingWatch: true });
			}
			const generation = state.generation + 1;
			return {
				state: {
					phase: 'loading', generation, retryCount: 0, pendingWatch: false, active: state.active,
					...(state.committed ? { committed: state.committed } : {}),
				},
				effects: [{ type: 'load', generation }],
			};
		}
		case 'retry': {
			if (!state.active || state.phase !== 'failed') {
				return noEffect(state);
			}
			const generation = state.generation + 1;
			return {
				state: {
					phase: 'loading', generation, retryCount: 0, pendingWatch: false, active: state.active,
					...(state.committed ? { committed: state.committed } : {}),
				},
				effects: [{ type: 'load', generation }],
			};
		}
	}
}
