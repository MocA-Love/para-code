/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-PATCH/PARA-CODE comments)

import { generateUuid } from '../../../../base/common/uuid.js';
import { IParadisMobileDesktopStateV2, IParadisMobileTerminalV2, IParadisMobileWindowStateV2, IParadisMobileWorkspaceV2 } from '../common/paradisMobileRelay.js';

export interface IParadisMobileTerminalOwner {
	readonly windowId: number;
	readonly windowSession: string;
	readonly terminalId: number;
}

export interface IParadisMobileWindowOwner {
	readonly windowId: number;
	readonly windowSession: string;
}

interface IWindowLease {
	readonly session: string;
	readonly state: IParadisMobileWindowStateV2;
}

/**
 * 全 renderer の状態を一つに集約し、terminalKey の所有 renderer を解決する。
 * 数値 terminal id は renderer 内でしか一意でないため、公開 API で単独解決しない。
 */
export class ParadisMobileTerminalRegistry {
	readonly desktopEpoch: string;

	private revision = 0;
	private readonly windows = new Map<number, IWindowLease>();
	private readonly retiredSessions = new Map<number, Set<string>>();
	private readonly owners = new Map<string, IParadisMobileTerminalOwner>();
	private readonly conflicts = new Set<string>();

	constructor(desktopEpoch = generateUuid()) {
		this.desktopEpoch = desktopEpoch;
	}

	syncWindow(windowId: number, windowSession: string, state: IParadisMobileWindowStateV2): IParadisMobileDesktopStateV2 {
		const current = this.windows.get(windowId);
		if (current?.session !== windowSession) {
			if (this.retiredSessions.get(windowId)?.has(windowSession)) {
				return this.desktopState();
			}
			if (current !== undefined) {
				let retired = this.retiredSessions.get(windowId);
				if (retired === undefined) {
					retired = new Set();
					this.retiredSessions.set(windowId, retired);
				}
				retired.add(current.session);
			}
		}
		this.windows.set(windowId, { session: windowSession, state });
		this.rebuildOwners();
		this.revision++;
		return this.desktopState();
	}

	removeWindow(windowId: number, windowSession: string): boolean {
		const current = this.windows.get(windowId);
		if (current?.session !== windowSession) {
			return false;
		}
		this.windows.delete(windowId);
		let retired = this.retiredSessions.get(windowId);
		if (retired === undefined) {
			retired = new Set();
			this.retiredSessions.set(windowId, retired);
		}
		retired.add(windowSession);
		this.rebuildOwners();
		this.revision++;
		return true;
	}

	ownerOf(terminalKey: string): IParadisMobileTerminalOwner | undefined {
		return this.owners.get(terminalKey);
	}

	hasWindow(windowId: number): boolean {
		return this.windows.has(windowId);
	}

	leaseOfWindow(windowId: number): IParadisMobileWindowOwner | undefined {
		const lease = this.windows.get(windowId);
		return lease === undefined ? undefined : { windowId, windowSession: lease.session };
	}

	ownerOfWorkspace(windowId: number, sourceId: string): IParadisMobileWindowOwner | undefined {
		const lease = this.windows.get(windowId);
		return lease?.state.workspaces.some(workspace => workspace.id === sourceId)
			? { windowId, windowSession: lease.session }
			: undefined;
	}

	conflictingTerminalKeys(): string[] {
		return [...this.conflicts].sort();
	}

	desktopState(): IParadisMobileDesktopStateV2 {
		const workspaces: IParadisMobileWorkspaceV2[] = [];
		const terminals: IParadisMobileTerminalV2[] = [];
		let activeWs: string | undefined;
		for (const [windowId, lease] of [...this.windows].sort(([a], [b]) => a - b)) {
			if (activeWs === undefined && lease.state.activeWs !== undefined) {
				activeWs = this.workspaceKey(windowId, lease.state.activeWs);
			}
			for (const workspace of lease.state.workspaces) {
				workspaces.push({
					...workspace,
					id: this.workspaceKey(windowId, workspace.id),
					sourceId: workspace.id,
					windowId,
					...(workspace.parent !== undefined ? { parent: this.workspaceKey(windowId, workspace.parent) } : {}),
				});
			}
			for (const terminal of lease.state.terminals) {
				if (this.conflicts.has(terminal.terminalKey)) {
					continue;
				}
				terminals.push({
					...terminal,
					windowId,
					...(terminal.ws !== undefined ? { ws: this.workspaceKey(windowId, terminal.ws) } : {}),
				});
			}
		}
		return {
			protocolVersion: 2,
			desktopEpoch: this.desktopEpoch,
			revision: this.revision,
			activeWs,
			workspaces,
			terminals,
		};
	}

	private rebuildOwners(): void {
		this.owners.clear();
		this.conflicts.clear();
		for (const [windowId, lease] of this.windows) {
			for (const terminal of lease.state.terminals) {
				if (this.conflicts.has(terminal.terminalKey)) {
					continue;
				}
				const existing = this.owners.get(terminal.terminalKey);
				if (existing !== undefined) {
					this.owners.delete(terminal.terminalKey);
					this.conflicts.add(terminal.terminalKey);
					continue;
				}
				this.owners.set(terminal.terminalKey, { windowId, windowSession: lease.session, terminalId: terminal.id });
			}
		}
	}

	private workspaceKey(windowId: number, workspaceId: string): string {
		return `${windowId}:${workspaceId}`;
	}
}
