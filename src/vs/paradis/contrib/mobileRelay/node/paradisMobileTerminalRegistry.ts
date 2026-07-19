/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-PATCH/PARA-CODE comments)

import { generateUuid } from '../../../../base/common/uuid.js';
import { equals as objectsEqual } from '../../../../base/common/objects.js';
import { IParadisMobileDesktopStateV3, IParadisMobileTerminalV3, IParadisMobileWindowStateV2, IParadisMobileWorkspaceV2, PARADIS_MOBILE_PROTOCOL_VERSION } from '../common/paradisMobileRelay.js';
import { IParadisMobileRendererManifest, IParadisMobileWindowLease, IParadisMobileWindowLeaseValidation } from '../common/paradisMobileWindowLease.js';

export interface IParadisMobileTerminalOwner extends IParadisMobileWindowLease {
	readonly terminalId: number;
}

export type IParadisMobileWindowOwner = IParadisMobileWindowLease;

interface IWindowLease {
	readonly windowSession: string;
	readonly rendererGeneration: number;
	readonly authorityManifestRevision: number;
	readonly authorityWindowRevision: number;
	readonly ready: boolean;
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
	private readonly retiredGeneration = new Map<number, number>();
	private readonly owners = new Map<string, IParadisMobileTerminalOwner>();
	private readonly conflicts = new Set<string>();
	private manifest: IParadisMobileRendererManifest = { revision: 0, entries: [] };
	private highestValidatedManifestRevision = 0;
	private fullManifestRevision = 0;
	private readonly observedManifestEntries = new Map<number, { entry: IParadisMobileRendererManifest['entries'][number]; observedAtManifestRevision: number }>();

	constructor(desktopEpoch = generateUuid()) {
		this.desktopEpoch = desktopEpoch;
	}

	syncWindow(windowId: number, windowSession: string, rendererGeneration: number, state: IParadisMobileWindowStateV2, validation?: IParadisMobileWindowLeaseValidation, markReady = true): IParadisMobileDesktopStateV3 {
		const previousDesktopState = this.desktopState();
		if (validation !== undefined) {
			if (!validation.valid || validation.windowRevision === undefined) {
				return this.desktopState();
			}
			const manifestEntry = this.manifest.entries.find(entry => entry.windowId === windowId);
			if (manifestEntry !== undefined && (manifestEntry.windowRevision > validation.windowRevision
				|| (manifestEntry.windowRevision === validation.windowRevision && (!manifestEntry.claimed
					|| manifestEntry.rendererGeneration !== rendererGeneration || manifestEntry.windowSession !== windowSession)))) {
				return this.desktopState();
			}
			this.highestValidatedManifestRevision = Math.max(this.highestValidatedManifestRevision, validation.manifestRevision);
			const observed = this.observedManifestEntries.get(windowId);
			if (observed === undefined || observed.entry.windowRevision <= validation.windowRevision) {
				this.observedManifestEntries.set(windowId, {
					entry: { windowId, windowSession, rendererGeneration, windowRevision: validation.windowRevision, claimed: true },
					observedAtManifestRevision: validation.manifestRevision,
				});
				this.refreshManifestSnapshot();
			}
		}
		const current = this.windows.get(windowId);
		if (current === undefined && rendererGeneration <= (this.retiredGeneration.get(windowId) ?? -1)) {
			return this.desktopState();
		}
		if (current !== undefined && (rendererGeneration < current.rendererGeneration
			|| (rendererGeneration === current.rendererGeneration && windowSession !== current.windowSession))) {
			return this.desktopState();
		}
		this.windows.set(windowId, {
			windowSession,
			rendererGeneration,
			authorityManifestRevision: validation?.manifestRevision ?? 0,
			authorityWindowRevision: validation?.windowRevision ?? 0,
			ready: markReady || (current?.windowSession === windowSession && current.rendererGeneration === rendererGeneration && current.ready),
			state,
		});
		this.rebuildOwners();
		// validation/lease metadataは毎回更新する一方、wire上のrevisionはモバイルから
		// 見えるDesktop Stateが変わった時だけ進める。broadcast自体はservice側で維持し、
		// 新規sessionや送信失敗後の再試行をPhase 2の配送ゲートへ委ねる。
		if (!objectsEqual(previousDesktopState, this.desktopState())) {
			this.revision++;
		}
		return this.desktopState();
	}

	markWindowReady(windowId: number, windowSession: string, rendererGeneration: number): boolean {
		const current = this.windows.get(windowId);
		if (current?.windowSession !== windowSession || current.rendererGeneration !== rendererGeneration) {
			return false;
		}
		if (current.ready) {
			return false;
		}
		this.windows.set(windowId, { ...current, ready: true });
		this.rebuildOwners();
		this.revision++;
		return true;
	}

	removeWindow(windowId: number, windowSession: string, rendererGeneration: number): boolean {
		const current = this.windows.get(windowId);
		if (current?.windowSession !== windowSession || current.rendererGeneration !== rendererGeneration) {
			return false;
		}
		this.windows.delete(windowId);
		this.retiredGeneration.set(windowId, rendererGeneration);
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

	isWindowReady(windowId: number, windowSession: string, rendererGeneration: number): boolean {
		const lease = this.windows.get(windowId);
		return lease?.windowSession === windowSession && lease.rendererGeneration === rendererGeneration && lease.ready;
	}

	leaseOfWindow(windowId: number): IParadisMobileWindowOwner | undefined {
		const lease = this.windows.get(windowId);
		return lease === undefined ? undefined : { windowId, windowSession: lease.windowSession, rendererGeneration: lease.rendererGeneration };
	}

	ownerOfWorkspace(windowId: number, sourceId: string): IParadisMobileWindowOwner | undefined {
		const lease = this.windows.get(windowId);
		return lease?.ready === true && lease.state.workspaces.some(workspace => workspace.id === sourceId)
			? { windowId, windowSession: lease.windowSession, rendererGeneration: lease.rendererGeneration }
			: undefined;
	}

	conflictingTerminalKeys(): string[] {
		return [...this.conflicts].sort();
	}

	isComplete(): boolean {
		// manifest revision 0 = shared process起動直後で、Main authorityのwindow一覧をまだ一度も
		// 観測していない。この間のstateを完全スナップショット扱いすると、PC再起動のたびにモバイルへ
		// 「complete:true・端末0件」が届き、モバイル側キャッシュ（全ワークスペース・端末・
		// エージェント表示）が破壊的に削除される。manifestを観測するまでは部分スナップショットとして
		// 扱い、モバイルに手元の表示を保持させる（全window破棄後の空manifestはrevision>0なので
		// 従来どおりcompleteとなり、モバイル側の掃除は行われる）。
		if (this.manifest.revision === 0) {
			return false;
		}
		return this.fullManifestRevision >= this.highestValidatedManifestRevision && this.manifest.entries.every(entry => entry.claimed
			&& this.windows.get(entry.windowId)?.rendererGeneration === entry.rendererGeneration
			&& this.windows.get(entry.windowId)?.windowSession === entry.windowSession
			&& this.windows.get(entry.windowId)?.ready === true);
	}

	reconcile(manifest: IParadisMobileRendererManifest): readonly IParadisMobileWindowLease[] {
		// full manifest同士は単調にだけ進める。新しいsnapshotで削除済みのwindowを、
		// IPC遅延した古いsnapshotからobservedManifestEntriesへ復活させない。
		if (manifest.revision < this.fullManifestRevision) {
			return [];
		}
		const previousManifest = JSON.stringify(this.manifest);
		this.fullManifestRevision = Math.max(this.fullManifestRevision, manifest.revision);
		const incoming = new Map(manifest.entries.map(entry => [entry.windowId, entry]));
		for (const entry of manifest.entries) {
			const observed = this.observedManifestEntries.get(entry.windowId);
			if (observed === undefined || entry.windowRevision > observed.entry.windowRevision
				|| (entry.windowRevision === observed.entry.windowRevision && manifest.revision >= observed.observedAtManifestRevision)) {
				this.observedManifestEntries.set(entry.windowId, { entry, observedAtManifestRevision: manifest.revision });
			}
		}
		for (const [windowId, observed] of [...this.observedManifestEntries]) {
			if (!incoming.has(windowId) && manifest.revision >= observed.observedAtManifestRevision) {
				this.observedManifestEntries.delete(windowId);
			}
		}
		this.refreshManifestSnapshot();
		const active = new Map(this.manifest.entries.map(entry => [entry.windowId, entry]));
		const removed: IParadisMobileWindowLease[] = [];
		let changed = false;
		for (const [windowId, lease] of this.windows) {
			const entry = active.get(windowId);
			const shouldRemove = entry === undefined
				? this.fullManifestRevision >= lease.authorityManifestRevision
				: entry.windowRevision >= lease.authorityWindowRevision && (!entry.claimed
					|| entry.rendererGeneration !== lease.rendererGeneration || entry.windowSession !== lease.windowSession);
			if (shouldRemove) {
				this.windows.delete(windowId);
				this.retiredGeneration.set(windowId, Math.max(lease.rendererGeneration, this.retiredGeneration.get(windowId) ?? -1));
				removed.push({ windowId, windowSession: lease.windowSession, rendererGeneration: lease.rendererGeneration });
				changed = true;
			}
		}
		if (changed || previousManifest !== JSON.stringify(this.manifest)) {
			this.rebuildOwners();
			this.revision++;
		}
		return removed;
	}

	private refreshManifestSnapshot(): void {
		this.manifest = {
			revision: Math.max(this.manifest.revision, this.fullManifestRevision, this.highestValidatedManifestRevision),
			entries: [...this.observedManifestEntries.values()].map(value => value.entry).sort((a, b) => a.windowId - b.windowId),
		};
	}

	desktopState(): IParadisMobileDesktopStateV3 {
		const workspaces: IParadisMobileWorkspaceV2[] = [];
		const terminals: IParadisMobileTerminalV3[] = [];
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
					rendererGeneration: lease.rendererGeneration,
					...(terminal.ws !== undefined ? { ws: this.workspaceKey(windowId, terminal.ws) } : {}),
				});
			}
		}
		const rendererByWindow = new Map(this.manifest.entries.map(entry => [entry.windowId, {
			windowId: entry.windowId,
			rendererGeneration: entry.rendererGeneration,
			ready: entry.claimed && this.windows.get(entry.windowId)?.rendererGeneration === entry.rendererGeneration
				&& this.windows.get(entry.windowId)?.windowSession === entry.windowSession
				&& this.windows.get(entry.windowId)?.ready === true,
		}]));
		for (const [windowId, lease] of this.windows) {
			if (!rendererByWindow.has(windowId)) {
				rendererByWindow.set(windowId, { windowId, rendererGeneration: lease.rendererGeneration, ready: lease.ready });
			}
		}
		return {
			protocolVersion: PARADIS_MOBILE_PROTOCOL_VERSION,
			desktopEpoch: this.desktopEpoch,
			revision: this.revision,
			complete: this.isComplete(),
			renderers: [...rendererByWindow.values()].sort((a, b) => a.windowId - b.windowId),
			activeWs,
			workspaces,
			terminals,
		};
	}

	private rebuildOwners(): void {
		this.owners.clear();
		this.conflicts.clear();
		for (const [windowId, lease] of this.windows) {
			if (!lease.ready) {
				continue;
			}
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
				this.owners.set(terminal.terminalKey, { windowId, windowSession: lease.windowSession, rendererGeneration: lease.rendererGeneration, terminalId: terminal.id });
			}
		}
	}

	private workspaceKey(windowId: number, workspaceId: string): string {
		return `${windowId}:${workspaceId}`;
	}
}
