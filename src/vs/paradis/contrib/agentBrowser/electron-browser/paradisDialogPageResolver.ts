/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { toErrorMessage } from '../../../../base/common/errorMessage.js';
import { IParadisBindEligibility, isParadisBindingScopeEligibilityError } from '../../workspaceSwitch/common/paradisWorkspaceSwitch.js';

export interface IParadisDialogPageResolution<T> {
	readonly exactPageId?: string;
	readonly getKnownPage: (pageId: string) => T | undefined;
	readonly initializationBarrier: Promise<void>;
	readonly getActivePage: () => T | undefined;
	readonly getContextualPage: () => T | undefined;
	/** Rejects stale active pages and transient pending pages from non-exact fallback. */
	readonly isStableContextualPage?: (page: T) => boolean;
}

/** exact binding is available immediately; only fallback waits for BrowserView initialization. */
export async function paradisResolveDialogPage<T>(resolution: IParadisDialogPageResolution<T>): Promise<T | undefined> {
	if (resolution.exactPageId !== undefined) {
		const exact = resolution.getKnownPage(resolution.exactPageId);
		if (exact !== undefined) {
			return exact;
		}
	}

	await resolution.initializationBarrier;

	// The exact model may have appeared while the Main snapshot was converging. It retains
	// priority over active/contextual fallback.
	if (resolution.exactPageId !== undefined) {
		const exact = resolution.getKnownPage(resolution.exactPageId);
		if (exact !== undefined) {
			return exact;
		}
	}
	const isStableContextualPage = resolution.isStableContextualPage ?? (() => true);
	const activePage = resolution.getActivePage();
	if (activePage !== undefined && isStableContextualPage(activePage)) {
		return activePage;
	}
	const contextualPage = resolution.getContextualPage();
	return contextualPage !== undefined && isStableContextualPage(contextualPage) ? contextualPage : undefined;
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
