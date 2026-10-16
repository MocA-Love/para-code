/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { toErrorMessage } from '../../../../base/common/errorMessage.js';
import { IParadisBindEligibility, isParadisBindingScopeEligibilityError } from '../../workspaceSwitch/common/paradisWorkspaceSwitch.js';

/** A browser page the binding dialog may target, whether or not its page model exists yet. */
export interface IParadisDialogPageCandidate<T> {
	readonly id: string;
	/** The page model, when it already exists. */
	readonly page: T | undefined;
	/** Creates the page model (a restored tab that was never shown has none yet). */
	resolve(): Promise<T | undefined>;
}

/** Whether a page belongs to the current space now, is still being placed, or belongs elsewhere. */
export type ParadisDialogPageStability = 'stable' | 'pending' | 'outOfScope';

export interface IParadisDialogPageResolution<T> {
	readonly exactPageId?: string;
	readonly getKnownCandidate: (pageId: string) => IParadisDialogPageCandidate<T> | undefined;
	readonly initializationBarrier: Promise<void>;
	/** Browser pages on screen, most recently active first. */
	readonly getVisibleCandidates: () => readonly IParadisDialogPageCandidate<T>[];
	/** Every other browser page the user could mean, most recently active first. */
	readonly getContextualCandidates: () => readonly IParadisDialogPageCandidate<T>[];
	readonly getStability: (pageId: string) => ParadisDialogPageStability;
}

/** How a stage of the lookup came up empty. */
export type ParadisDialogPageStageMiss = 'none' | 'pending' | 'outOfScope' | 'unresolved';

/** Why no page was found, stage by stage. Carries no page identity, so it can be reported as is. */
export interface IParadisDialogPageMiss {
	readonly exact: 'none' | 'missing';
	readonly visible: ParadisDialogPageStageMiss;
	readonly contextual: ParadisDialogPageStageMiss;
}

export type ParadisDialogPageResult<T> =
	| { readonly page: T; readonly miss?: undefined }
	| { readonly page?: undefined; readonly miss: IParadisDialogPageMiss };

async function resolveCandidate<T>(candidate: IParadisDialogPageCandidate<T>): Promise<T | undefined> {
	if (candidate.page !== undefined) {
		return candidate.page;
	}
	try {
		return await candidate.resolve();
	} catch {
		return undefined;
	}
}

/**
 * The first candidate that belongs to the current space, with its page model created if needed.
 * Stability is checked again after the wait: a space switch can start while the page is created.
 */
async function resolveFirstStable<T>(
	candidates: readonly IParadisDialogPageCandidate<T>[],
	getStability: (pageId: string) => ParadisDialogPageStability,
): Promise<{ readonly page?: T; readonly miss?: ParadisDialogPageStageMiss }> {
	let pending = false;
	let unresolved = false;
	for (const candidate of candidates) {
		const before = getStability(candidate.id);
		if (before !== 'stable') {
			pending ||= before === 'pending';
			continue;
		}
		const page = await resolveCandidate(candidate);
		const after = getStability(candidate.id);
		if (page !== undefined && after === 'stable') {
			return { page };
		}
		pending ||= after === 'pending';
		unresolved ||= page === undefined;
	}
	return { miss: candidates.length === 0 ? 'none' : pending ? 'pending' : unresolved ? 'unresolved' : 'outOfScope' };
}

/**
 * Picks the page for a binding dialog opened without a page of its own (pane mark, command palette).
 * The page the user is looking at comes first, then the page the pane is already bound to, then the
 * most recently active page of the space. With no browser page on screen the existing binding is used
 * right away; everything else waits for BrowserView initialization.
 */
export async function paradisResolveDialogPage<T>(resolution: IParadisDialogPageResolution<T>): Promise<ParadisDialogPageResult<T>> {
	const exactCandidate = () => resolution.exactPageId !== undefined ? resolution.getKnownCandidate(resolution.exactPageId) : undefined;
	const initialExact = exactCandidate();
	if (initialExact?.page !== undefined && resolution.getVisibleCandidates().length === 0) {
		return { page: initialExact.page };
	}

	await resolution.initializationBarrier;

	const visible = await resolveFirstStable(resolution.getVisibleCandidates(), resolution.getStability);
	if (visible.page !== undefined) {
		return { page: visible.page };
	}
	// The exact model may have appeared while the Main snapshot was converging.
	const exact = exactCandidate();
	const exactPage = exact !== undefined ? await resolveCandidate(exact) : undefined;
	if (exactPage !== undefined) {
		return { page: exactPage };
	}
	const contextual = await resolveFirstStable(resolution.getContextualCandidates(), resolution.getStability);
	if (contextual.page !== undefined) {
		return { page: contextual.page };
	}
	return {
		miss: {
			exact: resolution.exactPageId === undefined ? 'none' : 'missing',
			visible: visible.miss ?? 'none',
			contextual: contextual.miss ?? 'none',
		},
	};
}

/**
 * Picks the page for the share button of a browser editor's toolbar: the editor whose toolbar was
 * clicked. Clicking a toolbar button does not move focus, so the active editor can still be another
 * browser tab; it is used only when the command runs without an editor (a keybinding).
 */
export async function paradisResolveToolbarPage<T>(
	clicked: IParadisDialogPageCandidate<T> | undefined,
	active: IParadisDialogPageCandidate<T> | undefined,
): Promise<ParadisDialogPageResult<T>> {
	const candidate = clicked ?? active;
	const page = candidate !== undefined ? await resolveCandidate(candidate) : undefined;
	return page !== undefined
		? { page }
		: { miss: { exact: 'none', visible: candidate === undefined ? 'none' : 'unresolved', contextual: 'none' } };
}

export type ParadisPaneBindingAction = 'bind' | 'unbind' | 'disabled';

export interface IParadisBindingErrorMessages {
	readonly pending: string;
	readonly differentScope: string;
	readonly generic: (detail: string) => string;
}

/** Converts internal typed scope failures into caller-provided localized UI text. */
export function paradisGetBindingErrorMessage(error: unknown, messages: IParadisBindingErrorMessages): string {
	if (isParadisBindingScopeEligibilityError(error)) {
		return messages[error.reason];
	}
	return messages.generic(toErrorMessage(error));
}

export function paradisGetPaneQuickPickState(eligibility: IParadisBindEligibility | undefined): { readonly pickable: boolean; readonly disabled: boolean } {
	return { pickable: eligibility?.eligible === true, disabled: eligibility?.eligible !== true };
}

export function paradisGetPaneBindingAction(
	bindingPageId: string | undefined,
	currentPageId: string,
	eligibility: IParadisBindEligibility | undefined,
): ParadisPaneBindingAction {
	if (bindingPageId === currentPageId || (bindingPageId !== undefined && eligibility?.eligible === false)) {
		return 'unbind';
	}
	return eligibility?.eligible === true ? 'bind' : 'disabled';
}

/** Dialog-safe async boundary: callers may fire-and-forget this promise without leaking rejection. */
export async function paradisRunDialogBind(bind: () => Promise<boolean>, onError: (error: unknown) => void): Promise<boolean> {
	try {
		return await bind();
	} catch (error) {
		onError(error);
		return false;
	}
}
