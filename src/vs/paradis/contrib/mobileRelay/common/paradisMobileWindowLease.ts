/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-PATCH/PARA-CODE comments)

import { Event } from '../../../../base/common/event.js';
import { IChannel } from '../../../../base/parts/ipc/common/ipc.js';

export const PARADIS_MOBILE_WINDOW_LEASE_CHANNEL = 'paradisMobileWindowLease';

/** Electron Mainが発行する、workbench Renderer接続の単調世代付きlease。 */
export interface IParadisMobileWindowLease {
	readonly windowId: number;
	readonly windowSession: string;
	readonly rendererGeneration: number;
}

/** Main authorityが返す、既知mobile windowのRenderer同期barrier。 */
export interface IParadisMobileRendererManifestEntry {
	readonly windowId: number;
	readonly rendererGeneration: number;
	readonly windowRevision: number;
	readonly claimed: boolean;
	readonly windowSession?: string;
}

/** manifest RPC/eventの単調snapshot。 */
export interface IParadisMobileRendererManifest {
	readonly revision: number;
	readonly entries: readonly IParadisMobileRendererManifestEntry[];
}

/** validateと同じ瞬間に観測したauthority revision。 */
export interface IParadisMobileWindowLeaseValidation {
	readonly valid: boolean;
	readonly manifestRevision: number;
	readonly windowRevision: number | undefined;
}

interface IActiveRendererConnection {
	readonly connection: object;
	readonly rendererGeneration: number;
	windowSession?: string;
	windowRevision: number;
}

interface IPendingRendererConnection {
	readonly rendererGeneration: number;
	readonly windowRevision: number;
}

function windowIdFromContext(context: string): number | undefined {
	const match = /^window:(\d+)$/.exec(context);
	if (match === null) {
		return undefined;
	}
	const windowId = Number(match[1]);
	return Number.isSafeInteger(windowId) ? windowId : undefined;
}

/**
 * Electron Main process lifetimeのRenderer世代権威。IPC固有処理を含めず、逆順/reconnectを
 * node unit testで検証できる形にしている。
 */
export class ParadisMobileRendererLeaseAuthority {
	private nextGeneration = 0;
	private revision = 0;
	private readonly active = new Map<number, IActiveRendererConnection>();
	private readonly pending = new Map<number, IPendingRendererConnection>();
	/** 実workbench windowだけを追跡し、mobile contributionを持たない特殊windowを除外する。 */
	private readonly tracked = new Set<number>();

	get manifestRevision(): number { return this.revision; }

	/** 実workbench windowをRenderer claim前からmanifest barrierへ登録する。 */
	trackWindow(windowId: number): boolean {
		if (!Number.isSafeInteger(windowId) || this.tracked.has(windowId)) {
			return false;
		}
		this.tracked.add(windowId);
		const active = this.active.get(windowId);
		if (active !== undefined) {
			active.windowRevision = this.bumpRevision();
		} else {
			this.pending.set(windowId, { rendererGeneration: ++this.nextGeneration, windowRevision: this.bumpRevision() });
		}
		return true;
	}

	addConnection(context: string, connection: object): boolean {
		const windowId = windowIdFromContext(context);
		if (windowId === undefined) {
			return false;
		}
		const windowRevision = this.tracked.has(windowId) ? this.bumpRevision() : 0;
		this.active.set(windowId, { connection, rendererGeneration: ++this.nextGeneration, windowRevision });
		this.pending.delete(windowId);
		return this.tracked.has(windowId);
	}

	removeConnection(context: string, connection: object): boolean {
		const windowId = windowIdFromContext(context);
		if (windowId !== undefined && this.active.get(windowId)?.connection === connection) {
			this.active.delete(windowId);
			if (this.tracked.has(windowId)) {
				this.pending.set(windowId, { rendererGeneration: ++this.nextGeneration, windowRevision: this.bumpRevision() });
				return true;
			}
		}
		return false;
	}

	/** 実windowの破棄だけがreload待ちbarrierをmanifestから除去する。 */
	destroyWindow(windowId: number): boolean {
		this.active.delete(windowId);
		this.pending.delete(windowId);
		if (!this.tracked.delete(windowId)) {
			return false;
		}
		this.bumpRevision();
		return true;
	}

	claim(context: string, connection: object, windowSession: string): IParadisMobileWindowLease | undefined {
		const windowId = windowIdFromContext(context);
		const active = windowId === undefined ? undefined : this.active.get(windowId);
		if (windowId === undefined || active === undefined || active.connection !== connection || !this.tracked.has(windowId) || windowSession.length === 0) {
			return undefined;
		}
		if (active.windowSession !== undefined && active.windowSession !== windowSession) {
			return undefined;
		}
		if (active.windowSession === undefined) {
			active.windowSession = windowSession;
			active.windowRevision = this.bumpRevision();
		}
		return { windowId, windowSession, rendererGeneration: active.rendererGeneration };
	}

	validate(lease: IParadisMobileWindowLease): IParadisMobileWindowLeaseValidation {
		const active = this.active.get(lease.windowId);
		return {
			valid: active?.rendererGeneration === lease.rendererGeneration && active.windowSession === lease.windowSession,
			manifestRevision: this.revision,
			windowRevision: active?.windowRevision,
		};
	}

	manifest(): IParadisMobileRendererManifest {
		const entries: IParadisMobileRendererManifestEntry[] = [];
		for (const windowId of [...this.tracked].sort((a, b) => a - b)) {
			const active = this.active.get(windowId);
			if (active !== undefined) {
				entries.push({
					windowId,
					rendererGeneration: active.rendererGeneration,
					windowRevision: active.windowRevision,
					claimed: active.windowSession !== undefined,
					...(active.windowSession !== undefined ? { windowSession: active.windowSession } : {}),
				});
				continue;
			}
			const pending = this.pending.get(windowId);
			if (pending !== undefined) {
				entries.push({ windowId, rendererGeneration: pending.rendererGeneration, windowRevision: pending.windowRevision, claimed: false });
			}
		}
		return { revision: this.revision, entries };
	}

	private bumpRevision(): number {
		return ++this.revision;
	}
}

/** Renderer/Shared Process双方からMain authority channelを呼ぶ小さなclient。 */
export class ParadisMobileWindowLeaseClient {
	readonly onDidChangeManifest: Event<IParadisMobileRendererManifest>;

	constructor(private readonly channel: IChannel) {
		this.onDidChangeManifest = channel.listen('onDidChangeManifest');
	}

	claim(windowSession: string): Promise<IParadisMobileWindowLease | undefined> {
		return this.channel.call('claim', windowSession);
	}

	validate(lease: IParadisMobileWindowLease): Promise<IParadisMobileWindowLeaseValidation> {
		return this.channel.call('validate', lease);
	}

	manifest(): Promise<IParadisMobileRendererManifest> {
		return this.channel.call('manifest');
	}
}
