/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import { generateUuid } from '../../../../base/common/uuid.js';

const PARADIS_AUXILIARY_WINDOW_SCOPE_LEDGER_VERSION = 1;

interface ISerializedAuxiliaryWindowScopeEntry {
	readonly id: string;
	readonly stateKey: string;
	readonly groupIds: readonly number[];
}

interface ISerializedAuxiliaryWindowScopeLedger {
	readonly version: number;
	readonly entries: readonly ISerializedAuxiliaryWindowScopeEntry[];
}

export const enum ParadisAuxiliaryWindowScopeLedgerLoadState {
	Missing,
	Valid,
	Corrupt
}

export interface IParadisAuxiliaryWindowScopeLedgerLoadResult {
	readonly state: ParadisAuxiliaryWindowScopeLedgerLoadState;
	readonly ledger: ParadisAuxiliaryWindowScopeLedger;
}

function isSerializedEntry(candidate: unknown): candidate is ISerializedAuxiliaryWindowScopeEntry {
	if (!candidate || typeof candidate !== 'object') {
		return false;
	}

	const entry = candidate as Partial<ISerializedAuxiliaryWindowScopeEntry>;
	return typeof entry.id === 'string'
		&& entry.id.length > 0
		&& typeof entry.stateKey === 'string'
		&& entry.stateKey.length > 0
		&& Array.isArray(entry.groupIds)
		&& entry.groupIds.every(groupId => Number.isInteger(groupId) && groupId >= 0);
}

/**
 * Persistent authority for auxiliary editor windows. Window ids are deliberately
 * excluded because they are renderer-session local; stable editor group ids are
 * used to reconcile a restored window with its creating Para Code space.
 */
export class ParadisAuxiliaryWindowScopeLedger {

	static load(raw: string | undefined): IParadisAuxiliaryWindowScopeLedgerLoadResult {
		if (raw === undefined) {
			return { state: ParadisAuxiliaryWindowScopeLedgerLoadState.Missing, ledger: new ParadisAuxiliaryWindowScopeLedger() };
		}

		try {
			const candidate = JSON.parse(raw) as Partial<ISerializedAuxiliaryWindowScopeLedger>;
			if (candidate.version !== PARADIS_AUXILIARY_WINDOW_SCOPE_LEDGER_VERSION
				|| !Array.isArray(candidate.entries)
				|| !candidate.entries.every(isSerializedEntry)
				|| new Set(candidate.entries.map(entry => entry.id)).size !== candidate.entries.length) {
				return { state: ParadisAuxiliaryWindowScopeLedgerLoadState.Corrupt, ledger: new ParadisAuxiliaryWindowScopeLedger() };
			}

			return {
				state: ParadisAuxiliaryWindowScopeLedgerLoadState.Valid,
				ledger: new ParadisAuxiliaryWindowScopeLedger(candidate.entries)
			};
		} catch {
			return { state: ParadisAuxiliaryWindowScopeLedgerLoadState.Corrupt, ledger: new ParadisAuxiliaryWindowScopeLedger() };
		}
	}

	private readonly entries = new Map<string, ISerializedAuxiliaryWindowScopeEntry>();

	constructor(entries: readonly ISerializedAuxiliaryWindowScopeEntry[] = []) {
		for (const entry of entries) {
			this.entries.set(entry.id, { ...entry, groupIds: [...new Set(entry.groupIds)] });
		}
	}

	create(stateKey: string, groupIds: readonly number[]): string {
		const id = generateUuid();
		this.entries.set(id, { id, stateKey, groupIds: [...new Set(groupIds)] });
		return id;
	}

	updateGroups(entryId: string, groupIds: readonly number[]): void {
		const entry = this.entries.get(entryId);
		if (!entry) {
			return;
		}
		this.entries.set(entryId, { ...entry, groupIds: [...new Set(groupIds)] });
	}

	match(groupIds: readonly number[]): { readonly id: string; readonly stateKey: string } | undefined {
		const liveGroupIds = new Set(groupIds);
		const matches = [...this.entries.values()].filter(entry => entry.groupIds.some(groupId => liveGroupIds.has(groupId)));
		const stateKeys = new Set(matches.map(entry => entry.stateKey));
		return matches.length === 1 && stateKeys.size === 1
			? { id: matches[0].id, stateKey: matches[0].stateKey }
			: undefined;
	}

	resolve(groupIds: readonly number[]): string | undefined {
		return this.match(groupIds)?.stateKey;
	}

	retire(stateKey: string): string[] {
		const retired: string[] = [];
		for (const [entryId, entry] of this.entries) {
			if (entry.stateKey === stateKey) {
				this.entries.delete(entryId);
				retired.push(entryId);
			}
		}
		return retired;
	}

	delete(entryId: string): void {
		this.entries.delete(entryId);
	}

	serialize(): string {
		const state: ISerializedAuxiliaryWindowScopeLedger = {
			version: PARADIS_AUXILIARY_WINDOW_SCOPE_LEDGER_VERSION,
			entries: [...this.entries.values()]
		};
		return JSON.stringify(state);
	}
}
