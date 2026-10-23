/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import { IDisposable, toDisposable } from '../../../base/common/lifecycle.js';

/** One finished GitHub request from {@link GitHubTransport}, for Para Code's GitHub API Usage dashboard. */
export interface IParadisGithubTransportCall {
	/** `REST`, `GraphQL` or `download`, as GitHubTransport names them. */
	readonly kind: string;
	readonly operation: string;
	readonly durationMs: number;
	/** The error the request failed with; `undefined` when it succeeded. */
	readonly error?: unknown;
}

let hook: ((call: IParadisGithubTransportCall) => void) | undefined;

/**
 * Lets the dashboard in the same process (the shared process) count GitHub requests.
 * Kept in `vs/platform` so the transport does not import from `vs/paradis`.
 */
export function paradisSetGithubTransportCallHook(callback: (call: IParadisGithubTransportCall) => void): IDisposable {
	hook = callback;
	return toDisposable(() => {
		if (hook === callback) {
			hook = undefined;
		}
	});
}

/** Called by GitHubTransport after each request settles. Never throws into the request. */
export function paradisNotifyGithubTransportCall(call: IParadisGithubTransportCall): void {
	try {
		hook?.(call);
	} catch {
		// counting must not break the request
	}
}
