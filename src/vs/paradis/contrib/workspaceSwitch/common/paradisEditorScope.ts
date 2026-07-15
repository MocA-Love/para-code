/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { URI } from '../../../../base/common/uri.js';
import { createDecorator } from '../../../../platform/instantiation/common/instantiation.js';
import { EditorInput } from '../../../../workbench/common/editor/editorInput.js';
import { IEditorPart } from '../../../../workbench/services/editor/common/editorGroupsService.js';
import { IWorkingCopyIdentifier } from '../../../../workbench/services/workingCopy/common/workingCopy.js';

const PARADIS_WORKING_COPY_OWNER_LEDGER_VERSION = 1;

export const IParadisEditorScopeService = createDecorator<IParadisEditorScopeService>('paradisEditorScopeService');

export interface IParadisEditorScopeService {
	readonly _serviceBrand: undefined;

	readonly activeStateKey: string | undefined;
	readonly isSwitching: boolean;

	captureScope(stateKey: string, saveSerializedState: (excludedEditors: readonly EditorInput[]) => void): void;
	captureAuxiliaryPartOnClose(stateKey: string, part: IEditorPart): void;
	restoreScope(stateKey: string): Promise<void>;
	beginSwitch(): void;
	commitSwitch(stateKey: string, uri: URI): Promise<void>;
	rollbackSwitch(stateKey: string | undefined, uri: URI | undefined): Promise<void>;
	leaveManagedWorkspace(): Promise<void>;
	correctActiveScope(previousStateKey: string | undefined, stateKey: string, uri: URI): Promise<void>;
	restoreBackups(): Promise<void>;
	hasLiveState(stateKey: string): boolean;
	hasRetirementData(stateKey: string): Promise<boolean>;
	prepareScopeRetirement(stateKey: string): Promise<boolean>;
	cancelScopeRetirement(stateKey: string): void;
	retireScope(stateKey: string): Promise<boolean>;
}

interface ISerializedWorkingCopyOwnerEntry {
	readonly resource: string;
	readonly typeId: string;
	readonly stateKey: string;
}

interface ISerializedWorkingCopyOwnerLedger {
	readonly version: number;
	readonly entries: readonly ISerializedWorkingCopyOwnerEntry[];
}

export const enum ParadisWorkingCopyOwnerLedgerLoadState {
	Missing,
	Valid,
	Corrupt
}

export interface IParadisWorkingCopyOwnerLedgerLoadResult {
	readonly state: ParadisWorkingCopyOwnerLedgerLoadState;
	readonly ledger: ParadisWorkingCopyOwnerLedger;
}

function workingCopyIdentifierKey(identifier: IWorkingCopyIdentifier): string {
	return JSON.stringify([identifier.resource.toString(), identifier.typeId]);
}

function isSerializedEntry(candidate: unknown): candidate is ISerializedWorkingCopyOwnerEntry {
	if (!candidate || typeof candidate !== 'object') {
		return false;
	}

	const entry = candidate as Partial<ISerializedWorkingCopyOwnerEntry>;
	return typeof entry.resource === 'string'
		&& typeof entry.typeId === 'string'
		&& typeof entry.stateKey === 'string'
		&& entry.stateKey.length > 0;
}

/**
 * Versioned pure state for assigning Working Copy backup identifiers to Para
 * Code space keys. Parsing failures intentionally produce an empty, corrupt
 * ledger so callers can defer restoration instead of guessing an owner.
 */
export class ParadisWorkingCopyOwnerLedger {

	static load(raw: string | undefined): IParadisWorkingCopyOwnerLedgerLoadResult {
		if (raw === undefined) {
			return { state: ParadisWorkingCopyOwnerLedgerLoadState.Missing, ledger: new ParadisWorkingCopyOwnerLedger() };
		}

		try {
			const candidate = JSON.parse(raw) as Partial<ISerializedWorkingCopyOwnerLedger>;
			if (candidate.version !== PARADIS_WORKING_COPY_OWNER_LEDGER_VERSION || !Array.isArray(candidate.entries) || !candidate.entries.every(isSerializedEntry)) {
				return { state: ParadisWorkingCopyOwnerLedgerLoadState.Corrupt, ledger: new ParadisWorkingCopyOwnerLedger() };
			}

			return {
				state: ParadisWorkingCopyOwnerLedgerLoadState.Valid,
				ledger: new ParadisWorkingCopyOwnerLedger(candidate.entries)
			};
		} catch {
			return { state: ParadisWorkingCopyOwnerLedgerLoadState.Corrupt, ledger: new ParadisWorkingCopyOwnerLedger() };
		}
	}

	private readonly owners = new Map<string, { readonly identifier: IWorkingCopyIdentifier; stateKey: string }>();

	private constructor(entries: readonly ISerializedWorkingCopyOwnerEntry[] = []) {
		for (const entry of entries) {
			const identifier = { resource: URI.parse(entry.resource), typeId: entry.typeId };
			this.owners.set(workingCopyIdentifierKey(identifier), { identifier, stateKey: entry.stateKey });
		}
	}

	get entries(): readonly { readonly identifier: IWorkingCopyIdentifier; readonly stateKey: string }[] {
		return [...this.owners.values()];
	}

	ownerOf(identifier: IWorkingCopyIdentifier): string | undefined {
		return this.owners.get(workingCopyIdentifierKey(identifier))?.stateKey;
	}

	assign(identifier: IWorkingCopyIdentifier, stateKey: string): void {
		this.owners.set(workingCopyIdentifierKey(identifier), {
			identifier: { resource: identifier.resource, typeId: identifier.typeId },
			stateKey
		});
	}

	rekey(previousStateKey: string, nextStateKey: string): void {
		if (previousStateKey === nextStateKey) {
			return;
		}

		for (const entry of this.owners.values()) {
			if (entry.stateKey === previousStateKey) {
				entry.stateKey = nextStateKey;
			}
		}
	}

	retire(stateKey: string): readonly IWorkingCopyIdentifier[] {
		const retired: IWorkingCopyIdentifier[] = [];
		for (const [key, entry] of this.owners) {
			if (entry.stateKey === stateKey) {
				retired.push(entry.identifier);
				this.owners.delete(key);
			}
		}

		return retired;
	}

	serialize(): string {
		const serialized: ISerializedWorkingCopyOwnerLedger = {
			version: PARADIS_WORKING_COPY_OWNER_LEDGER_VERSION,
			entries: [...this.owners.values()].map(entry => ({
				resource: entry.identifier.resource.toString(),
				typeId: entry.identifier.typeId,
				stateKey: entry.stateKey
			}))
		};

		return JSON.stringify(serialized);
	}
}
