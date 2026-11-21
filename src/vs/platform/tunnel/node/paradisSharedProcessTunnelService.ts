/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import { DeferredPromise } from '../../../base/common/async.js';
import { canceled } from '../../../base/common/errors.js';
import { Disposable } from '../../../base/common/lifecycle.js';
import { ILogService } from '../../log/common/log.js';
import { IAddress, IAddressProvider } from '../../remote/common/remoteAgentConnection.js';
import { ISharedProcessTunnel, ISharedProcessTunnelService } from '../../remote/common/sharedProcessTunnelService.js';
import { ISharedTunnelsService, isAllInterfaces, isLocalhost, RemoteTunnel } from '../common/tunnel.js';

/**
 * The addresses of the windows that forward one remote port of one remote authority.
 *
 * The shared process keeps one tunnel per authority and remote port, and the tunnel asks for the
 * address of the remote agent on every connection. This is what it is answered with: the address
 * of the window that sent one last, among the windows that still forward the port.
 * - a window that reconnects sends its new address, which then is the latest.
 * - a window that stops forwarding (the row is closed, or the window closes or reloads) is taken
 *   out, and the latest address of the windows that are left is used.
 * - while none of the windows that are left has sent an address, the answer waits for the first.
 */
export class ParadisTunnelAddressGroup implements IAddressProvider {

	/** Window tunnel id → the address it sent last, with the order it arrived in. */
	private readonly _members = new Map<string, { readonly address: IAddress; readonly order: number } | undefined>();
	private _order = 0;
	/** The address used last before every window left. Nothing should ask any more by then. */
	private _lastAddress: IAddress | undefined;
	private _pending: DeferredPromise<IAddress> | undefined;

	get isEmpty(): boolean {
		return this._members.size === 0;
	}

	add(id: string): void {
		if (!this._members.has(id)) {
			this._members.set(id, undefined);
		}
	}

	setAddress(id: string, address: IAddress): void {
		if (!this._members.has(id)) {
			return;
		}
		this._members.set(id, { address, order: ++this._order });
		this._pending?.complete(address);
		this._pending = undefined;
	}

	remove(id: string): void {
		const current = this._current();
		if (this._members.delete(id) && this._members.size === 0) {
			this._lastAddress = current ?? this._lastAddress;
		}
	}

	getAddress(): Promise<IAddress> {
		const address = this._current() ?? (this._members.size === 0 ? this._lastAddress : undefined);
		if (address) {
			return Promise.resolve(address);
		}
		if (!this._pending) {
			this._pending = new DeferredPromise<IAddress>();
		}
		return this._pending.p;
	}

	private _current(): IAddress | undefined {
		let latest: { readonly address: IAddress; readonly order: number } | undefined;
		for (const member of this._members.values()) {
			if (member && (!latest || member.order > latest.order)) {
				latest = member;
			}
		}
		return latest?.address;
	}
}

/**
 * What one window's tunnel id stands for in the shared process: its lease of the tunnel, and the
 * address provider handed to the tunnel service when the tunnel was asked for.
 *
 * The tunnel service only keeps the provider of the window that created the tunnel, and keeps
 * asking it after that window's lease is gone. So the provider answers from the group of all
 * windows that forward the port, also after it was disposed.
 */
class ParadisTunnelData extends Disposable implements IAddressProvider {

	private readonly _group = new DeferredPromise<ParadisTunnelAddressGroup>();
	groupKey: string | undefined;

	async getAddress(): Promise<IAddress> {
		return (await this._group.p).getAddress();
	}

	join(groupKey: string, group: ParadisTunnelAddressGroup, tunnel: RemoteTunnel): void {
		this.groupKey = groupKey;
		this._group.complete(group);
		this._register(tunnel);
	}
}

/**
 * The shared process's {@link ISharedProcessTunnelService}, with one change: the address a tunnel
 * connects through follows the windows that forward the port (see {@link ParadisTunnelAddressGroup}).
 *
 * With upstream's `SharedProcessTunnelService` (`node/sharedProcessTunnelService.ts`) a tunnel that
 * several windows of the same remote forward keeps the address of the window that forwarded it
 * first. Once that window closes, reloads or reconnects while another window holds the port, the
 * tunnel dials an address that is gone: the row stays in the Ports view and nothing connects.
 *
 * Nothing is closed or forwarded again here; only the address the next connection uses changes.
 *
 * The rest follows upstream's service. It is copied rather than subclassed because its tunnel
 * record (`TunnelData`) and ledger are private there (see the upstream merge checklist in NOTES.md).
 */
export class ParadisSharedProcessTunnelService extends Disposable implements ISharedProcessTunnelService {
	_serviceBrand: undefined;

	private static _lastId = 0;

	private readonly _tunnels: Map<string, ParadisTunnelData> = new Map<string, ParadisTunnelData>();
	private readonly _disposedTunnels: Set<string> = new Set<string>();
	/** One group per authority and remote port, kept while a window forwards the port. */
	private readonly _groups = new Map<string, ParadisTunnelAddressGroup>();

	constructor(
		@ISharedTunnelsService private readonly _tunnelService: ISharedTunnelsService,
		@ILogService private readonly _logService: ILogService,
	) {
		super();
	}

	public override dispose(): void {
		super.dispose();
		this._tunnels.forEach((tunnel) => tunnel.dispose());
	}

	async createTunnel(): Promise<{ id: string }> {
		const id = String(++ParadisSharedProcessTunnelService._lastId);
		return { id };
	}

	async startTunnel(authority: string, id: string, tunnelRemoteHost: string, tunnelRemotePort: number, tunnelLocalHost: string, tunnelLocalPort: number | undefined, elevateIfNeeded: boolean | undefined): Promise<ISharedProcessTunnel> {
		const tunnelData = new ParadisTunnelData();

		const tunnel = await Promise.resolve(this._tunnelService.openTunnel(authority, tunnelData, tunnelRemoteHost, tunnelRemotePort, tunnelLocalHost, tunnelLocalPort, elevateIfNeeded));
		if (!tunnel || (typeof tunnel === 'string')) {
			this._logService.info(`[SharedProcessTunnelService] Could not create a tunnel to ${tunnelRemoteHost}:${tunnelRemotePort} (remote).`);
			tunnelData.dispose();
			throw new Error(`Could not create tunnel`);
		}

		if (this._disposedTunnels.delete(id)) {
			// This tunnel was disposed in the meantime
			tunnelData.dispose();
			await tunnel.dispose();
			throw canceled();
		}

		// Grouped by the host and port of the tunnel that was handed back, which is the one the
		// tunnel service matched this request to (it treats the localhost names as one).
		const groupKey = groupKeyOf(authority, tunnel.tunnelRemoteHost, tunnel.tunnelRemotePort);
		let group = this._groups.get(groupKey);
		if (!group) {
			group = new ParadisTunnelAddressGroup();
			this._groups.set(groupKey, group);
		}
		group.add(id);
		tunnelData.join(groupKey, group, tunnel);
		this._tunnels.set(id, tunnelData);

		this._logService.info(`[SharedProcessTunnelService] Created tunnel ${id}: ${tunnel.localAddress} (local) to ${tunnelRemoteHost}:${tunnelRemotePort} (remote).`);
		const result: ISharedProcessTunnel = {
			tunnelLocalPort: tunnel.tunnelLocalPort,
			localAddress: tunnel.localAddress
		};
		return result;
	}

	async setAddress(id: string, address: IAddress): Promise<void> {
		const groupKey = this._tunnels.get(id)?.groupKey;
		if (groupKey === undefined) {
			return;
		}
		this._groups.get(groupKey)?.setAddress(id, address);
	}

	async destroyTunnel(id: string): Promise<void> {
		const tunnel = this._tunnels.get(id);
		if (tunnel) {
			this._logService.info(`[SharedProcessTunnelService] Disposing tunnel ${id}.`);
			this._tunnels.delete(id);
			const group = tunnel.groupKey !== undefined ? this._groups.get(tunnel.groupKey) : undefined;
			if (group && tunnel.groupKey !== undefined) {
				group.remove(id);
				if (group.isEmpty) {
					this._groups.delete(tunnel.groupKey);
				}
			}
			await tunnel.dispose();
			return;
		}

		// Looks like this tunnel is still starting, mark the id as disposed
		this._disposedTunnels.add(id);
	}
}

function groupKeyOf(authority: string, remoteHost: string, remotePort: number): string {
	const host = isLocalhost(remoteHost) ? 'localhost' : (isAllInterfaces(remoteHost) ? '0.0.0.0' : remoteHost);
	return `${authority}\n${host}:${remotePort}`;
}
