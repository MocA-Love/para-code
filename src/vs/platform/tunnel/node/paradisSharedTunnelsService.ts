/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import { disposableTimeout } from '../../../base/common/async.js';
import { Emitter } from '../../../base/common/event.js';
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
 * How long references of a force-closed tunnel wait for the next tunnel to the same host and port.
 * The reforward that closed it forwards again within milliseconds; if it never does (the forward
 * failed, or the window closed in between), the references are dropped so that a later forward of
 * the port does not start with references nobody will release.
 */
export const PARADIS_CARRIED_REFERENCES_TIMEOUT_MS = 30_000;

/**
 * References of a force-closed tunnel that the next tunnel to the same host and port takes over.
 */
interface IParadisCarriedReferences {
	/** How many leases of other windows are still open. */
	count: number;
	/** The generations those leases were handed out under. */
	readonly generations: Set<object>;
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
 *
 * Until the next tunnel arrives, a lease that is released counts the kept references down instead,
 * and the kept references are dropped after {@link PARADIS_CARRIED_REFERENCES_TIMEOUT_MS}.
 *
 * Relies on upstream's `BaseTunnelService.retainOrCreateTunnel` putting a new entry into the ledger
 * synchronously, before it returns (see the upstream merge checklist in NOTES.md).
 */
export class ParadisNodeTunnelService extends TunnelService {

	/** References waiting for the next tunnel, keyed by `host:port`. */
	private readonly _carried = new Map<string, IParadisCarriedReferences>();
	/** Drops each entry of {@link _carried} once it has waited too long. */
	private readonly _carriedTimeouts = this._register(new DisposableMap<string>());
	/** Lease generation of a closed tunnel → generation of the tunnel that took its references over. */
	private readonly _successors = new WeakMap<object, object>();
	private readonly _onDidDropCarriedReferences = this._register(new Emitter<void>());
	/**
	 * Fires when kept references were let go of (released or expired) and none are kept any more, so
	 * the owner can dispose a service that no longer has tunnels.
	 */
	readonly onDidDropCarriedReferences = this._onDidDropCarriedReferences.event;

	constructor(
		private readonly _carriedTimeoutMs: number,
		remoteSocketFactoryService: IRemoteSocketFactoryService,
		logService: ILogService,
		signService: ISignService,
		productService: IProductService,
		configurationService: IConfigurationService,
	) {
		super(remoteSocketFactoryService, logService, signService, productService, configurationService);
	}

	/** Whether some references are still waiting for the next tunnel. */
	get hasCarriedReferences(): boolean {
		return this._carried.size > 0;
	}

	/**
	 * How many leases (one per window that forwards the port) the tunnel to `remoteHost:remotePort`
	 * has, or undefined when there is no such tunnel.
	 */
	referenceCount(remoteHost: string, remotePort: number): number | undefined {
		return this.getTunnelFromMap(remoteHost, remotePort)?.refcount;
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
		const kept = entry.refcount > 0;
		if (kept) {
			// Recorded before closing: the close event fires inside `closeTunnel`, and the owner
			// must already see these references so it does not dispose this service.
			this._keep(key, entry.refcount, entry.generation);
		}
		await this.closeTunnel(remoteHost, remotePort);
		if (kept && this.getTunnelFromMap(remoteHost, remotePort) === entry) {
			// `closeTunnel` looks the host up exactly and missed an alias of it: nothing was closed.
			this._release(key, entry.refcount);
		}
	}

	private _keep(key: string, count: number, generation: object): void {
		const carried = this._carried.get(key);
		if (carried) {
			carried.count += count;
			carried.generations.add(generation);
		} else {
			this._carried.set(key, { count, generations: new Set([generation]) });
		}
		this._carriedTimeouts.set(key, disposableTimeout(() => this._dropAndNotify(key), this._carriedTimeoutMs));
	}

	/**
	 * Takes `count` references back out of what is kept for `key`. The generations stay until the
	 * whole record is dropped: leases of one generation are not counted apart, and a later lease of
	 * the same generation must still be recognised.
	 */
	private _release(key: string, count: number): void {
		const carried = this._carried.get(key);
		if (!carried) {
			return;
		}
		carried.count -= count;
		if (carried.count <= 0) {
			this._dropAndNotify(key);
		}
	}

	private _drop(key: string): void {
		this._carried.delete(key);
		this._carriedTimeouts.deleteAndDispose(key);
	}

	/** {@link _drop} for references nobody takes over: tells the owner once nothing is kept any more. */
	private _dropAndNotify(key: string): void {
		this._drop(key);
		if (this._carried.size === 0) {
			this._onDidDropCarriedReferences.fire();
		}
	}

	protected override retainOrCreateTunnel(addressOrTunnelProvider: IAddressProvider | ITunnelProvider, remoteHost: string, remotePort: number, localHost: string, localPort: number | undefined, elevateIfNeeded: boolean, privacy?: string, protocol?: string): Promise<RemoteTunnel | string | undefined> | undefined {
		const existed = !!this.getTunnelFromMap(remoteHost, remotePort);
		const result = super.retainOrCreateTunnel(addressOrTunnelProvider, remoteHost, remotePort, localHost, localPort, elevateIfNeeded, privacy, protocol);
		const key = carriedKey(remoteHost, remotePort);
		const carried = this._carried.get(key);
		const entry = this.getTunnelFromMap(remoteHost, remotePort);
		if (!existed && carried && entry) {
			this._drop(key);
			entry.refcount += carried.count;
			for (const generation of carried.generations) {
				this._successors.set(generation, entry.generation);
			}
		}
		return result;
	}

	protected override isLeaseOfEntry(entryGeneration: object, leaseGeneration: object): boolean {
		for (const generation of this._generationChain(leaseGeneration)) {
			if (generation === entryGeneration) {
				return true;
			}
		}
		return false;
	}

	protected override onStaleLeaseReleased(remoteHost: string, remotePort: number, leaseGeneration: object): void {
		// A window let go of a force-closed tunnel before the next one took its reference over.
		const key = carriedKey(remoteHost, remotePort);
		const carried = this._carried.get(key);
		if (!carried) {
			return;
		}
		for (const generation of this._generationChain(leaseGeneration)) {
			if (carried.generations.has(generation)) {
				this._release(key, 1);
				return;
			}
		}
	}

	/** The lease's generation followed by those that took its references over, since a tunnel can be reforwarded more than once. */
	private *_generationChain(leaseGeneration: object): Iterable<object> {
		let generation: object | undefined = leaseGeneration;
		while (generation) {
			yield generation;
			generation = this._successors.get(generation);
		}
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
	/** How long a force-closed tunnel's references wait for the next tunnel. Tests shorten it. */
	carriedReferencesTimeoutMs = PARADIS_CARRIED_REFERENCES_TIMEOUT_MS;
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
			const tunnelService = store.add(new ParadisNodeTunnelService(this.carriedReferencesTimeoutMs, this.remoteSocketFactoryService, this.logService, this.signService, this.productService, this.configurationService));
			this._tunnelServices.set(authority, tunnelService);
			this._tunnelServiceStores.set(authority, store);
			store.add(tunnelService.onTunnelClosed(() => this._disposeIfUnused(authority, tunnelService)));
			// A service kept only for references of a force-closed tunnel is not needed once they are
			// released or expire without a next tunnel taking them over.
			store.add(tunnelService.onDidDropCarriedReferences(() => this._disposeIfUnused(authority, tunnelService)));
		}
		return this._tunnelServices.get(authority)!.openTunnel(addressProvider, remoteHost, remotePort, localHost, localPort, elevateIfNeeded, privacy, protocol);
	}

	private async _disposeIfUnused(authority: string, tunnelService: ParadisNodeTunnelService): Promise<void> {
		// Only forget the service this listener belongs to, so a later service for the same
		// authority is never disposed by an older one's last close. A service whose closed
		// tunnel left references for the next one is kept, so that tunnel can take them over.
		if ((await tunnelService.tunnels).length === 0 && !tunnelService.hasCarriedReferences && this._tunnelServices.get(authority) === tunnelService) {
			this._tunnelServices.delete(authority);
			this._tunnelServiceStores.deleteAndDispose(authority);
		}
	}

	/**
	 * How many windows hold the tunnel to `remoteHost:remotePort` for `authority` (each window that
	 * forwards the port holds one reference), or undefined when there is no such tunnel.
	 */
	referenceCount(authority: string, remoteHost: string, remotePort: number): number | undefined {
		return this._tunnelServices.get(authority)?.referenceCount(remoteHost, remotePort);
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
