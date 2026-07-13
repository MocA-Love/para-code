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
}

interface IParadisMobilePaneWindowLease {
	readonly windowSession: string;
	readonly entries: readonly IParadisMobilePaneEntry[];
}

/** Renderer世代付きのペイン対応表。交代済み世代の遅延sync/disposeは受理しない。 */
export class ParadisMobilePaneRegistry {
	private readonly windows = new Map<number, IParadisMobilePaneWindowLease>();
	private readonly retiredSessions = new Map<number, Set<string>>();

	syncWindow(windowId: number, windowSession: string, entries: readonly IParadisMobilePaneEntry[]): boolean {
		const current = this.windows.get(windowId);
		if (current?.windowSession !== windowSession) {
			if (this.retiredSessions.get(windowId)?.has(windowSession)) {
				return false;
			}
			if (current !== undefined) {
				this.retire(windowId, current.windowSession);
			}
		}
		this.windows.set(windowId, { windowSession, entries });
		return true;
	}

	removeWindow(windowId: number, windowSession: string): boolean {
		if (this.windows.get(windowId)?.windowSession !== windowSession) {
			return false;
		}
		this.windows.delete(windowId);
		this.retire(windowId, windowSession);
		return true;
	}

	windowEntries(): readonly (readonly [number, string, readonly IParadisMobilePaneEntry[]])[] {
		return [...this.windows].map(([windowId, lease]) => [windowId, lease.windowSession, lease.entries] as const);
	}

	ownerOf(token: string, terminalId?: number): IParadisMobilePaneOwner | undefined {
		const owners: IParadisMobilePaneOwner[] = [];
		for (const [windowId, lease] of this.windows) {
			for (const entry of lease.entries) {
				if (entry.token === token && (terminalId === undefined || entry.terminalId === terminalId)) {
					owners.push({ ...entry, windowId, windowSession: lease.windowSession });
				}
			}
		}
		return owners.length === 1 ? owners[0] : undefined;
	}

	allEntries(): readonly IParadisMobilePaneEntry[] {
		return this.windowEntries().flatMap(([, , entries]) => entries);
	}

	private retire(windowId: number, windowSession: string): void {
		let retired = this.retiredSessions.get(windowId);
		if (retired === undefined) {
			retired = new Set();
			this.retiredSessions.set(windowId, retired);
		}
		retired.add(windowSession);
	}
}
