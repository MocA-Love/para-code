/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import { Disposable, DisposableMap, DisposableStore } from '../../../base/common/lifecycle.js';
import { IConfigurationService } from '../../configuration/common/configuration.js';
import { ILogService } from '../../log/common/log.js';
import { IProductService } from '../../product/common/productService.js';
import { IAddressProvider } from '../../remote/common/remoteAgentConnection.js';
import { IRemoteSocketFactoryService } from '../../remote/common/remoteSocketFactoryService.js';
import { ISignService } from '../../sign/common/sign.js';
import { ISharedTunnelsService, ITunnelService, RemoteTunnel } from '../common/tunnel.js';
import { TunnelService } from './tunnelService.js';

/**
 * The shared process's {@link ISharedTunnelsService}, with one addition: a tunnel can be closed
 * no matter how many windows still hold a reference to it.
 *
 * The shared process keeps one tunnel per remote authority and remote port. A second window that
 * forwards the same port only bumps the reference count and gets the existing tunnel back, so the
 * tunnel keeps connecting through the address of whichever window created it. When that window is
 * gone (closed, reloaded, crashed or reopened after it stopped responding), the tunnel keeps
 * dialling an address that no longer exists, and stopping and forwarding the port again from the
 * Ports view only drops one reference and hands the same broken tunnel back. The Ports view's
 * "Reforward" command uses {@link forceCloseTunnel} to drop the tunnel for every window first, so
 * the forward that follows creates a fresh tunnel with the address of the window that asked.
 *
 * The rest follows upstream's `SharedTunnelsService` (`node/tunnelService.ts`). It is copied rather
 * than subclassed because the map of per-authority services is private there; the copy also keeps
 * each service's close listener with it, so the listener is released together with the service.
 */
export class ParadisSharedTunnelsService extends Disposable implements ISharedTunnelsService {
	declare readonly _serviceBrand: undefined;
	private readonly _tunnelServices = new Map<string, ITunnelService>();
	/** Each authority's tunnel service together with its close listener. */
	private readonly _tunnelServiceStores = this._register(new DisposableMap<string, DisposableStore>());

	public constructor(
		@IRemoteSocketFactoryService protected readonly remoteSocketFactoryService: IRemoteSocketFactoryService,
		@ILogService protected readonly logService: ILogService,
		@IProductService private readonly productService: IProductService,
		@ISignService private readonly signService: ISignService,
		@IConfigurationService private readonly configurationService: IConfigurationService,
	) {
		super();
	}

	async openTunnel(authority: string, addressProvider: IAddressProvider | undefined, remoteHost: string | undefined, remotePort: number, localHost: string, localPort?: number, elevateIfNeeded?: boolean, privacy?: string, protocol?: string): Promise<RemoteTunnel | string | undefined> {
		this.logService.trace(`ForwardedPorts: (SharedTunnelService) openTunnel request for ${remoteHost}:${remotePort} on local port ${localPort}.`);
		if (!this._tunnelServices.has(authority)) {
			const store = new DisposableStore();
			const tunnelService = store.add(new TunnelService(this.remoteSocketFactoryService, this.logService, this.signService, this.productService, this.configurationService));
			this._tunnelServices.set(authority, tunnelService);
			this._tunnelServiceStores.set(authority, store);
			store.add(tunnelService.onTunnelClosed(async () => {
				// Only forget the service this listener belongs to, so a later service for the same
				// authority is never disposed by an older one's last close.
				if ((await tunnelService.tunnels).length === 0 && this._tunnelServices.get(authority) === tunnelService) {
					this._tunnelServices.delete(authority);
					this._tunnelServiceStores.deleteAndDispose(authority);
				}
			}));
		}
		return this._tunnelServices.get(authority)!.openTunnel(addressProvider, remoteHost, remotePort, localHost, localPort, elevateIfNeeded, privacy, protocol);
	}

	/**
	 * Close the tunnel to `remoteHost:remotePort` for `authority`, regardless of how many windows
	 * hold a reference to it. Resolves to whether there was a tunnel service for the authority.
	 *
	 * References that other windows still hold become no-ops when they are released, because a
	 * lease only counts down the entry of its own generation (`tunnel.ts`). Those windows keep their
	 * row in the Ports view; a new tunnel on the same local port serves them again.
	 */
	async forceCloseTunnel(authority: string, remoteHost: string, remotePort: number): Promise<boolean> {
		const tunnelService = this._tunnelServices.get(authority);
		if (!tunnelService) {
			return false;
		}
		this.logService.info(`[ParadisSharedTunnels] Closing the tunnel to ${remoteHost}:${remotePort} for every window so it can be forwarded again.`);
		await tunnelService.closeTunnel(remoteHost, remotePort);
		return true;
	}
}
