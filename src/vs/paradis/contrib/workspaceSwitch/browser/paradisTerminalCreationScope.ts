/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import { IDisposable, toDisposable } from '../../../../base/common/lifecycle.js';

const PARADIS_TERMINAL_CREATION_SCOPE_MAX_LENGTH = 4_096;
const terminalCreationScopes = new WeakMap<object, string>();

interface IParadisTerminalCreationScopeProviderRegistration {
	readonly provider: () => string | undefined;
}

let currentProvider: IParadisTerminalCreationScopeProviderRegistration | undefined;

function parseTerminalCreationScopeLease(value: unknown): string | undefined {
	return typeof value === 'string'
		&& value.length > 0
		&& value.length <= PARADIS_TERMINAL_CREATION_SCOPE_MAX_LENGTH
		&& !/[\u0000-\u001f\u007f]/.test(value)
		? value
		: undefined;
}

/** Register the renderer-local authority used at terminal creation entry points. */
export function paradisRegisterTerminalCreationScopeProvider(provider: () => string | undefined): IDisposable {
	const registration = { provider };
	currentProvider = registration;
	return toDisposable(() => {
		if (currentProvider === registration) {
			currentProvider = undefined;
		}
	});
}

/** Prefer a validated propagated lease; otherwise capture the current renderer scope synchronously. */
export function paradisCaptureTerminalCreationScopeLease(propagatedValue: unknown): string | undefined {
	const propagated = parseTerminalCreationScopeLease(propagatedValue);
	if (propagated !== undefined) {
		return propagated;
	}
	try {
		return parseTerminalCreationScopeLease(currentProvider?.provider());
	} catch {
		return undefined;
	}
}

/** Associate the current creation lease with a launch config without exposing it on the config. */
export function paradisSetTerminalCreationScopeLease(shellLaunchConfig: object, lease: string | undefined): void {
	const parsed = parseTerminalCreationScopeLease(lease);
	if (parsed === undefined) {
		terminalCreationScopes.delete(shellLaunchConfig);
		return;
	}
	terminalCreationScopes.set(shellLaunchConfig, parsed);
}

/** Peek the scope associated with this config. Intended for diagnostics and tests. */
export function paradisGetTerminalCreationScopeLease(shellLaunchConfig: object): string | undefined {
	return terminalCreationScopes.get(shellLaunchConfig);
}

/** Consume the scope after the synchronously-created terminal instance has observed it. */
export function paradisTakeTerminalCreationScopeLease(shellLaunchConfig: object): string | undefined {
	const scope = terminalCreationScopes.get(shellLaunchConfig);
	terminalCreationScopes.delete(shellLaunchConfig);
	return scope;
}
