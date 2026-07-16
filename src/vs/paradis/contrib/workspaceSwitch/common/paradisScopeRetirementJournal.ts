/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

const PARADIS_SCOPE_RETIREMENT_JOURNAL_VERSION = 1;

export interface IParadisScopeRetirementJournalEntry {
	readonly id: string;
	readonly stateKeys: readonly string[];
	readonly repositoryId?: string;
	readonly eventsPending: boolean;
	readonly repositoryPending: boolean;
	readonly pendingStateKeys: readonly string[];
}

interface ISerializedParadisScopeRetirementJournal {
	readonly version: number;
	readonly entries: readonly IParadisScopeRetirementJournalEntry[];
}

export const enum ParadisScopeRetirementJournalLoadState {
	Missing,
	Valid,
	Corrupt
}

export interface IParadisScopeRetirementJournalLoadResult {
	readonly state: ParadisScopeRetirementJournalLoadState;
	readonly journal: ParadisScopeRetirementJournal;
}

function isNonEmptyString(candidate: unknown): candidate is string {
	return typeof candidate === 'string' && candidate.length > 0;
}

function isSerializedEntry(candidate: unknown): candidate is IParadisScopeRetirementJournalEntry {
	if (!candidate || typeof candidate !== 'object') {
		return false;
	}
	const entry = candidate as Partial<IParadisScopeRetirementJournalEntry>;
	if (!isNonEmptyString(entry.id)
		|| !Array.isArray(entry.stateKeys)
		|| entry.stateKeys.length === 0
		|| !entry.stateKeys.every(isNonEmptyString)
		|| new Set(entry.stateKeys).size !== entry.stateKeys.length
		|| (entry.repositoryId !== undefined && !isNonEmptyString(entry.repositoryId))
		|| typeof entry.eventsPending !== 'boolean'
		|| typeof entry.repositoryPending !== 'boolean'
		|| !Array.isArray(entry.pendingStateKeys)
		|| !entry.pendingStateKeys.every(isNonEmptyString)
		|| new Set(entry.pendingStateKeys).size !== entry.pendingStateKeys.length) {
		return false;
	}
	const stateKeys = new Set(entry.stateKeys);
	return entry.pendingStateKeys.every(stateKey => stateKeys.has(stateKey))
		&& (!entry.repositoryPending || entry.repositoryId !== undefined);
}

/** Durable state machine for completing an approved scope retirement after a crash. */
export class ParadisScopeRetirementJournal {

	static load(raw: string | undefined): IParadisScopeRetirementJournalLoadResult {
		if (raw === undefined) {
			return { state: ParadisScopeRetirementJournalLoadState.Missing, journal: new ParadisScopeRetirementJournal() };
		}
		try {
			const serialized = JSON.parse(raw) as Partial<ISerializedParadisScopeRetirementJournal>;
			if (serialized.version !== PARADIS_SCOPE_RETIREMENT_JOURNAL_VERSION
				|| !Array.isArray(serialized.entries)
				|| !serialized.entries.every(isSerializedEntry)
				|| new Set(serialized.entries.map(entry => entry.id)).size !== serialized.entries.length) {
				throw new Error('Invalid Para Code scope retirement journal');
			}
			return { state: ParadisScopeRetirementJournalLoadState.Valid, journal: new ParadisScopeRetirementJournal(serialized.entries) };
		} catch {
			return { state: ParadisScopeRetirementJournalLoadState.Corrupt, journal: new ParadisScopeRetirementJournal() };
		}
	}

	private readonly transactions = new Map<string, IParadisScopeRetirementJournalEntry>();

	private constructor(entries: readonly IParadisScopeRetirementJournalEntry[] = []) {
		for (const entry of entries) {
			this.transactions.set(entry.id, this.copyEntry(entry));
		}
	}

	get entries(): readonly IParadisScopeRetirementJournalEntry[] {
		return [...this.transactions.values()].map(entry => this.copyEntry(entry));
	}

	get pendingStateKeys(): readonly string[] {
		return [...new Set([...this.transactions.values()].flatMap(entry => entry.pendingStateKeys))];
	}

	stage(id: string, stateKeys: readonly string[], repositoryId?: string): void {
		if (!isNonEmptyString(id)
			|| stateKeys.length === 0
			|| stateKeys.some(stateKey => !isNonEmptyString(stateKey))
			|| (repositoryId !== undefined && !isNonEmptyString(repositoryId))
			|| this.transactions.has(id)) {
			throw new Error('Invalid or duplicate Para Code scope retirement transaction');
		}
		const uniqueStateKeys = [...new Set(stateKeys)];
		this.transactions.set(id, {
			id,
			stateKeys: uniqueStateKeys,
			repositoryId,
			eventsPending: true,
			repositoryPending: repositoryId !== undefined,
			pendingStateKeys: uniqueStateKeys
		});
	}

	abort(id: string): void {
		this.transactions.delete(id);
	}

	completeEvents(id: string): void {
		const entry = this.transactions.get(id);
		if (!entry) {
			return;
		}
		this.update({ ...entry, eventsPending: false });
	}

	completeRepository(repositoryId: string): void {
		for (const entry of [...this.transactions.values()]) {
			if (entry.repositoryId === repositoryId) {
				this.update({ ...entry, repositoryPending: false });
			}
		}
	}

	acknowledgeStateKey(stateKey: string): void {
		for (const entry of [...this.transactions.values()]) {
			if (entry.pendingStateKeys.includes(stateKey)) {
				this.update({ ...entry, pendingStateKeys: entry.pendingStateKeys.filter(candidate => candidate !== stateKey) });
			}
		}
	}

	serialize(): string {
		const serialized: ISerializedParadisScopeRetirementJournal = {
			version: PARADIS_SCOPE_RETIREMENT_JOURNAL_VERSION,
			entries: this.entries
		};
		return JSON.stringify(serialized);
	}

	private update(entry: IParadisScopeRetirementJournalEntry): void {
		if (!entry.eventsPending && !entry.repositoryPending && entry.pendingStateKeys.length === 0) {
			this.transactions.delete(entry.id);
		} else {
			this.transactions.set(entry.id, this.copyEntry(entry));
		}
	}

	private copyEntry(entry: IParadisScopeRetirementJournalEntry): IParadisScopeRetirementJournalEntry {
		return {
			...entry,
			stateKeys: [...entry.stateKeys],
			pendingStateKeys: [...entry.pendingStateKeys]
		};
	}
}
