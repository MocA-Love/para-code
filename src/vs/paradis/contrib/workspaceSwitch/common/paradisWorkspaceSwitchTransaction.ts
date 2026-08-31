/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

export const PARADIS_WORKSPACE_SWITCH_TRANSACTION_STORAGE_KEY = 'paradis.workspaceSwitch.transaction';

export type ParadisWorkspaceSwitchPhase = 'started' | 'sourceCaptured' | 'targetApplied' | 'foldersCommitted';

export interface IParadisWorkspaceSwitchTransaction {
	readonly version: 1;
	readonly id: string;
	readonly createdAt: number;
	/** Renderer window that owns the live operation. Missing only on journals from older builds. */
	readonly ownerWindowId?: number;
	readonly fromStateKey: string;
	readonly fromUri: string;
	readonly toStateKey: string;
	readonly toUri: string;
	readonly phase: ParadisWorkspaceSwitchPhase;
}

export type ParadisWorkspaceSwitchEndpoint = 'from' | 'to';

/**
 * Selects the only Working Set that is safe to re-apply for an interrupted phase.
 * `undefined` means the journal can be discarded without changing the current UI.
 */
export function paradisWorkspaceSwitchRecoveryEndpoint(
	phase: ParadisWorkspaceSwitchPhase,
	currentEndpoint: ParadisWorkspaceSwitchEndpoint,
): ParadisWorkspaceSwitchEndpoint | undefined {
	switch (phase) {
		case 'started':
			// Source capture has not completed, so neither saved side is known to describe the UI.
			return undefined;
		case 'sourceCaptured':
			// Before target apply, only the captured source is known-good. A target URI here can only
			// come from an unrelated/external folder mutation, so leave its UI untouched.
			return currentEndpoint === 'from' ? 'from' : undefined;
		case 'targetApplied':
		case 'foldersCommitted':
			return currentEndpoint;
	}
}

interface ISerializedWorkspaceSwitchTransactions {
	readonly version: 1;
	readonly entries: readonly IParadisWorkspaceSwitchTransaction[];
}

const PHASES = new Set<ParadisWorkspaceSwitchPhase>(['started', 'sourceCaptured', 'targetApplied', 'foldersCommitted']);
const MAX_ENTRIES = 128;
const MAX_STORAGE_LENGTH = 32_768;
const MAX_FIELD_LENGTH = 4_096;

function isTransaction(value: Partial<IParadisWorkspaceSwitchTransaction>): value is IParadisWorkspaceSwitchTransaction {
	return value.version === 1 && typeof value.id === 'string' && value.id.length > 0 && value.id.length <= MAX_FIELD_LENGTH
		&& typeof value.createdAt === 'number' && Number.isFinite(value.createdAt) && value.createdAt > 0
		&& (value.ownerWindowId === undefined || (typeof value.ownerWindowId === 'number' && Number.isInteger(value.ownerWindowId) && value.ownerWindowId >= 0))
		&& typeof value.fromStateKey === 'string' && value.fromStateKey.length > 0 && value.fromStateKey.length <= MAX_FIELD_LENGTH
		&& typeof value.fromUri === 'string' && value.fromUri.length > 0 && value.fromUri.length <= MAX_FIELD_LENGTH
		&& typeof value.toStateKey === 'string' && value.toStateKey.length > 0 && value.toStateKey.length <= MAX_FIELD_LENGTH
		&& typeof value.toUri === 'string' && value.toUri.length > 0 && value.toUri.length <= MAX_FIELD_LENGTH
		&& PHASES.has(value.phase as ParadisWorkspaceSwitchPhase);
}

export function paradisParseWorkspaceSwitchTransactions(raw: string | undefined): IParadisWorkspaceSwitchTransaction[] {
	if (raw === undefined || raw.length > MAX_STORAGE_LENGTH) {
		return [];
	}
	try {
		const value = JSON.parse(raw) as Partial<ISerializedWorkspaceSwitchTransactions>;
		if (value.version !== 1 || !Array.isArray(value.entries) || value.entries.length > MAX_ENTRIES
			|| !value.entries.every(entry => isTransaction(entry))) {
			return [];
		}
		return [...value.entries];
	} catch {
		return [];
	}
}

export function paradisSerializeWorkspaceSwitchTransactions(transactions: readonly IParadisWorkspaceSwitchTransaction[]): string {
	const entries = transactions.filter(transaction => isTransaction(transaction)).slice(-MAX_ENTRIES);
	let raw = JSON.stringify({ version: 1, entries } satisfies ISerializedWorkspaceSwitchTransactions);
	while (raw.length > MAX_STORAGE_LENGTH && entries.length > 0) {
		entries.shift();
		raw = JSON.stringify({ version: 1, entries } satisfies ISerializedWorkspaceSwitchTransactions);
	}
	return raw;
}
