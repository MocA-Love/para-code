/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-PATCH/PARA-CODE comments)

export interface IParadisMobilePaneEntry {
	readonly terminalId: number;
	readonly token: string;
	readonly cwd?: string;
	readonly ws?: string;
}

export interface IParadisMobilePaneOwner extends IParadisMobilePaneEntry {
	readonly windowId: number;
	readonly windowSession: string;
	readonly rendererGeneration: number;
}

interface IParadisMobilePaneWindowLease {
	readonly windowSession: string;
	readonly rendererGeneration: number;
	readonly revision: number;
	readonly entries: readonly IParadisMobilePaneEntry[];
}

/** Renderer世代付きのペイン対応表。交代済み世代の遅延sync/disposeは受理しない。 */
export class ParadisMobilePaneRegistry {
	private readonly windows = new Map<number, IParadisMobilePaneWindowLease>();
	private readonly retiredGeneration = new Map<number, number>();
	syncWindow(windowId: number, windowSession: string, rendererGeneration: number, revision: number, entries: readonly IParadisMobilePaneEntry[]): boolean {
		if (!Number.isSafeInteger(revision) || revision <= 0) {
			return false;
		}
		const current = this.windows.get(windowId);
		if (current === undefined && rendererGeneration <= (this.retiredGeneration.get(windowId) ?? -1)) {
			return false;
		}
		if (current !== undefined && (rendererGeneration < current.rendererGeneration
			|| (rendererGeneration === current.rendererGeneration && windowSession !== current.windowSession)
			|| (rendererGeneration === current.rendererGeneration && windowSession === current.windowSession && revision <= current.revision))) {
			return false;
		}
		this.windows.set(windowId, { windowSession, rendererGeneration, revision, entries });
		return true;
	}

	removeWindow(windowId: number, windowSession: string, rendererGeneration: number): boolean {
		const current = this.windows.get(windowId);
		if (current?.windowSession !== windowSession || current.rendererGeneration !== rendererGeneration) {
			return false;
		}
		this.windows.delete(windowId);
		this.retiredGeneration.set(windowId, rendererGeneration);
		return true;
	}

	windowEntries(): readonly (readonly [number, string, number, readonly IParadisMobilePaneEntry[]])[] {
		return [...this.windows].map(([windowId, lease]) => [windowId, lease.windowSession, lease.rendererGeneration, lease.entries] as const);
	}

	ownerOf(token: string, terminalId?: number): IParadisMobilePaneOwner | undefined {
		const owners: IParadisMobilePaneOwner[] = [];
		for (const [windowId, lease] of this.windows) {
			for (const entry of lease.entries) {
				if (entry.token === token && (terminalId === undefined || entry.terminalId === terminalId)) {
					owners.push({ ...entry, windowId, windowSession: lease.windowSession, rendererGeneration: lease.rendererGeneration });
				}
			}
		}
		return owners.length === 1 ? owners[0] : undefined;
	}

	ownerOfTerminal(windowId: number, windowSession: string, rendererGeneration: number, terminalId: number): IParadisMobilePaneOwner | undefined {
		const lease = this.windows.get(windowId);
		if (lease?.windowSession !== windowSession || lease.rendererGeneration !== rendererGeneration) {
			return undefined;
		}
		const entries = lease.entries.filter(entry => entry.terminalId === terminalId);
		return entries.length === 1 ? { ...entries[0], windowId, windowSession, rendererGeneration } : undefined;
	}

	allEntries(): readonly IParadisMobilePaneEntry[] {
		return this.windowEntries().flatMap(([, , , entries]) => entries);
	}
}
