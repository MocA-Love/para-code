/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-PATCH/PARA-CODE comments)

import { IChannel } from '../../../../base/parts/ipc/common/ipc.js';

export const PARADIS_MOBILE_WINDOW_LEASE_CHANNEL = 'paradisMobileWindowLease';

/** Electron Mainが発行する、workbench Renderer接続の単調世代付きlease。 */
export interface IParadisMobileWindowLease {
	readonly windowId: number;
	readonly windowSession: string;
	readonly rendererGeneration: number;
}

/** モバイル機能をclaim済みのactive Renderer一覧。 */
export type IParadisMobileRendererManifestEntry = IParadisMobileWindowLease;

interface IActiveRendererConnection {
	readonly connection: object;
	readonly rendererGeneration: number;
	windowSession?: string;
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
	private readonly active = new Map<number, IActiveRendererConnection>();

	addConnection(context: string, connection: object): void {
		const windowId = windowIdFromContext(context);
		if (windowId === undefined) {
			return;
		}
		this.active.set(windowId, { connection, rendererGeneration: ++this.nextGeneration });
	}

	removeConnection(context: string, connection: object): void {
		const windowId = windowIdFromContext(context);
		if (windowId !== undefined && this.active.get(windowId)?.connection === connection) {
			this.active.delete(windowId);
		}
	}

	claim(context: string, windowSession: string): IParadisMobileWindowLease | undefined {
		const windowId = windowIdFromContext(context);
		const active = windowId === undefined ? undefined : this.active.get(windowId);
		if (windowId === undefined || active === undefined || windowSession.length === 0) {
			return undefined;
		}
		if (active.windowSession !== undefined && active.windowSession !== windowSession) {
			return undefined;
		}
		active.windowSession = windowSession;
		return { windowId, windowSession, rendererGeneration: active.rendererGeneration };
	}

	validate(lease: IParadisMobileWindowLease): boolean {
		const active = this.active.get(lease.windowId);
		return active?.rendererGeneration === lease.rendererGeneration && active.windowSession === lease.windowSession;
	}

	manifest(): IParadisMobileRendererManifestEntry[] {
		return [...this.active.entries()]
			.filter(([, active]) => active.windowSession !== undefined)
			.sort(([a], [b]) => a - b)
			.map(([windowId, active]) => ({
				windowId,
				rendererGeneration: active.rendererGeneration,
				windowSession: active.windowSession!,
			}));
	}
}

/** Renderer/Shared Process双方からMain authority channelを呼ぶ小さなclient。 */
export class ParadisMobileWindowLeaseClient {
	constructor(private readonly channel: IChannel) { }

	claim(windowSession: string): Promise<IParadisMobileWindowLease | undefined> {
		return this.channel.call('claim', windowSession);
	}

	validate(lease: IParadisMobileWindowLease): Promise<boolean> {
		return this.channel.call('validate', lease);
	}

	manifest(): Promise<IParadisMobileRendererManifestEntry[]> {
		return this.channel.call('manifest');
	}
}
