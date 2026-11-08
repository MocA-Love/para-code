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
import { ISharedTunnelsService, ITunnelProvider, RemoteTunnel } from '../common/tunnel.js';
import { TunnelService } from './tunnelService.js';

/**
 * References of a force-closed tunnel that the next tunnel to the same host and port takes over.
 */
interface IParadisCarriedReferences {
	/** How many leases of other windows were still open when the tunnel was closed. */
	readonly count: number;
	/** The generations those leases were handed out under. */
	readonly generations: readonly object[];
}

/**
 * The per-authority tunnel service of {@link ParadisSharedTunnelsService}.
 *
 * A forced close drops the tunnel while other windows still hold leases on it. Those windows still
 * use the port (their Ports view keeps the row), so the tunnel that the reforwarding window opens
 * next takes their references over: its reference count starts with theirs, and their leases,
 * although handed out under the closed tunnel's generation, count it down when they are released.
 * The tunnel therefore stays up while any of those windows still holds the port, and closes once
 * the last one lets go, as if it had never been closed.
 */
export class ParadisNodeTunnelService extends TunnelService {

	/** References waiting for the next tunnel, keyed by `host:port`. */
	private readonly _carried = new Map<string, IParadisCarriedReferences>();
	/** Lease generation of a closed tunnel → generation of the tunnel that took its references over. */
	private readonly _successors = new WeakMap<object, object>();

	/** Whether some references are still waiting for the next tunnel. */
	get hasCarriedReferences(): boolean {
		return this._carried.size > 0;
	}

	/**
	 * Close the tunnel regardless of its reference count, keeping the references that are still
	 * open for the next tunnel to the same host and port.
	 */
	async forceCloseTunnel(remoteHost: string, remotePort: number): Promise<void> {
		const entry = this.getTunnelFromMap(remoteHost, remotePort);
		if (!entry) {
			return;
		}
		const key = carriedKey(remoteHost, remotePort);
		const earlier = this._carried.get(key);
		if (entry.refcount > 0) {
			// Recorded before closing: the close event fires inside `closeTunnel`, and the owner
			// must already see these references so it does not dispose this service.
			this._carried.set(key, {
				count: entry.refcount + (earlier?.count ?? 0),
				generations: [entry.generation, ...(earlier?.generations ?? [])],
			});
		}
		await this.closeTunnel(remoteHost, remotePort);
		if (this.getTunnelFromMap(remoteHost, remotePort) === entry) {
			// `closeTunnel` looks the host up exactly and missed an alias of it: nothing was closed.
			if (earlier) {
				this._carried.set(key, earlier);
			} else {
				this._carried.delete(key);
			}
		}
	}

	protected override retainOrCreateTunnel(addressOrTunnelProvider: IAddressProvider | ITunnelProvider, remoteHost: string, remotePort: number, localHost: string, localPort: number | undefined, elevateIfNeeded: boolean, privacy?: string, protocol?: string): Promise<RemoteTunnel | string | undefined> | undefined {
		const existed = !!this.getTunnelFromMap(remoteHost, remotePort);
		const result = super.retainOrCreateTunnel(addressOrTunnelProvider, remoteHost, remotePort, localHost, localPort, elevateIfNeeded, privacy, protocol);
		const key = carriedKey(remoteHost, remotePort);
		const carried = this._carried.get(key);
		const entry = this.getTunnelFromMap(remoteHost, remotePort);
		if (!existed && carried && entry) {
			this._carried.delete(key);
			entry.refcount += carried.count;
			for (const generation of carried.generations) {
				this._successors.set(generation, entry.generation);
			}
		}
		return result;
	}

	protected override isLeaseOfEntry(entryGeneration: object, leaseGeneration: object): boolean {
		// Follow the chain, since a tunnel can be reforwarded more than once.
		let generation: object | undefined = leaseGeneration;
		while (generation) {
			if (generation === entryGeneration) {
				return true;
			}
			generation = this._successors.get(generation);
		}
		return false;
	}
}

function carriedKey(remoteHost: string, remotePort: number): string {
	return `${remoteHost}:${remotePort}`;
}

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
	private readonly _tunnelServices = new Map<string, ParadisNodeTunnelService>();
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
			const tunnelService = store.add(new ParadisNodeTunnelService(this.remoteSocketFactoryService, this.logService, this.signService, this.productService, this.configurationService));
			this._tunnelServices.set(authority, tunnelService);
			this._tunnelServiceStores.set(authority, store);
			store.add(tunnelService.onTunnelClosed(async () => {
				// Only forget the service this listener belongs to, so a later service for the same
				// authority is never disposed by an older one's last close. A service whose closed
				// tunnel left references for the next one is kept, so that tunnel can take them over.
				if ((await tunnelService.tunnels).length === 0 && !tunnelService.hasCarriedReferences && this._tunnelServices.get(authority) === tunnelService) {
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
	 * References that other windows still hold are handed to the next tunnel to the same host and
	 * port (see {@link ParadisNodeTunnelService}). Those windows keep their row in the Ports view;
	 * the new tunnel on the same local port serves them again, and stays up until they let go.
	 */
	async forceCloseTunnel(authority: string, remoteHost: string, remotePort: number): Promise<boolean> {
		const tunnelService = this._tunnelServices.get(authority);
		if (!tunnelService) {
			return false;
		}
		this.logService.info(`[ParadisSharedTunnels] Closing the tunnel to ${remoteHost}:${remotePort} for every window so it can be forwarded again.`);
		await tunnelService.forceCloseTunnel(remoteHost, remotePort);
		return true;
	}
}
