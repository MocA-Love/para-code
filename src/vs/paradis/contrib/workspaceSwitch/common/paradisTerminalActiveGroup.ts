/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import { paradisTerminalIdentityNonce } from '../../mobileRelay/common/paradisTerminalPersistence.js';

const VERSION = 1;
const MAX_SCOPES = 4096;
const MAX_STORAGE_LENGTH = 262_144;

interface ISerializedTerminalActiveGroupState {
	readonly version: number;
	readonly entries: readonly { readonly stateKey: string; readonly groupIdentity: string }[];
}

/** A group identity that is stable across pty host restarts and independent of pane order. */
export function paradisTerminalGroupIdentity(instances: readonly { readonly shellIntegrationNonce: string }[]): string | undefined {
	const nonces: string[] = [];
	for (const instance of instances) {
		const nonce = paradisTerminalIdentityNonce(instance.shellIntegrationNonce);
		if (nonce === undefined) {
			return undefined;
		}
		nonces.push(nonce);
	}
	if (nonces.length === 0 || new Set(nonces).size !== nonces.length) {
		return undefined;
	}
	return JSON.stringify(nonces.sort());
}

export function paradisParseTerminalActiveGroups(raw: string | undefined): Map<string, string> {
	if (raw === undefined || raw.length > MAX_STORAGE_LENGTH) {
		return new Map();
	}
	try {
		const parsed = JSON.parse(raw) as Partial<ISerializedTerminalActiveGroupState>;
		if (parsed.version !== VERSION || !Array.isArray(parsed.entries) || parsed.entries.length > MAX_SCOPES) {
			return new Map();
		}
		const result = new Map<string, string>();
		for (const entry of parsed.entries) {
			if (!entry || typeof entry.stateKey !== 'string' || entry.stateKey.length === 0
				|| typeof entry.groupIdentity !== 'string' || entry.groupIdentity.length === 0
				|| result.has(entry.stateKey)) {
				return new Map();
			}
			result.set(entry.stateKey, entry.groupIdentity);
		}
		return result;
	} catch {
		return new Map();
	}
}

export function paradisSerializeTerminalActiveGroups(groups: ReadonlyMap<string, string>): string | undefined {
	if (groups.size > MAX_SCOPES) {
		return undefined;
	}
	const raw = JSON.stringify({
		version: VERSION,
		entries: [...groups].map(([stateKey, groupIdentity]) => ({ stateKey, groupIdentity })),
	} satisfies ISerializedTerminalActiveGroupState);
	return raw.length <= MAX_STORAGE_LENGTH ? raw : undefined;
}

/** Applies one window-owned scope update to the latest shared storage snapshot. */
export function paradisUpdateTerminalActiveGroup(
	raw: string | undefined,
	stateKey: string,
	groupIdentity: string | undefined,
): string | undefined {
	const groups = paradisParseTerminalActiveGroups(raw);
	if (groupIdentity === undefined) {
		groups.delete(stateKey);
	} else {
		groups.set(stateKey, groupIdentity);
	}
	return paradisSerializeTerminalActiveGroups(groups);
}
