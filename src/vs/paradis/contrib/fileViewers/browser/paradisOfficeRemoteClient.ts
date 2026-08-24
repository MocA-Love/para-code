/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import type { CancellationToken } from '../../../../base/common/cancellation.js';
import { Disposable, type IDisposable } from '../../../../base/common/lifecycle.js';
import { URI } from '../../../../base/common/uri.js';
import type { IChannel } from '../../../../base/parts/ipc/common/ipc.js';
import {
	PARADIS_OFFICE_CHANNEL,
	PARADIS_OFFICE_OPERATIONS,
	marshalParadisOfficeRequest,
	marshalParadisOfficeWireValue,
	unmarshalParadisOfficeResponse,
	type ParadisOfficeV1Negotiation,
	type ParadisOfficeWireAuthority,
} from '../common/paradisOfficeChannel.js';
import type { IOfficeSourceBroker, IOfficeSpoolClient, ParadisOfficeBackendSource, ParadisOfficeSealedSpoolReference } from '../common/paradisOfficeSourceBroker.js';
import type { ParadisOfficeRequest, ParadisOfficeResponse, ParadisOfficeSourceDescriptor } from '../common/paradisOfficeProtocol.js';

export interface IParadisOfficeRemoteConnection {
	readonly remoteAuthority: string;
	getChannel(channelName: string): IChannel;
}

export interface IParadisOfficeRemoteAgentService {
	getConnection(): IParadisOfficeRemoteConnection | null;
}

export interface ParadisOfficeRemoteClientOptions {
	readonly remoteAgentService: IParadisOfficeRemoteAgentService;
	readonly localChannel: IChannel;
	readonly sourceBroker: IOfficeSourceBroker;
	readonly spoolClient: IOfficeSpoolClient;
	readonly onWarning: (warning: string) => void;
	readonly isPlatformBackendEnabled?: () => boolean;
}

export interface ParadisOfficeRemoteRequestResult {
	readonly route: 'remoteV1' | 'boundedLocalSpool';
	readonly quality: 'complete' | 'degraded';
	readonly warnings: readonly string[];
	readonly response: ParadisOfficeResponse;
}

interface RemoteRoute {
	readonly connection: IParadisOfficeRemoteConnection;
	readonly channel: IChannel;
	readonly kind: 'remoteV1' | 'boundedLocalSpool';
	readonly authority?: ParadisOfficeWireAuthority;
}

export class ParadisOfficeRemoteClientError extends Error {
	override readonly name = 'ParadisOfficeRemoteClientError';

	constructor(readonly code: 'noConnection' | 'negotiationFailed' | 'sourceFailed' | 'cancelled' | 'transportFailed') {
		super('The remote Office source could not be opened safely.');
		Object.defineProperty(this, 'stack', { configurable: true, value: '' });
	}
}

function isV1Negotiation(value: unknown): value is ParadisOfficeV1Negotiation {
	if (!value || typeof value !== 'object' || Array.isArray(value)) {
		return false;
	}
	try {
		if (Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null) {
			return false;
		}
		const keys = Reflect.ownKeys(value);
		const hasAuthority = keys.includes('ownerCapability') || keys.includes('connectionEpoch');
		const expectedKeys = hasAuthority ? ['version', 'channel', 'capabilities', 'ownerCapability', 'connectionEpoch'] : ['version', 'channel', 'capabilities'];
		if (keys.length !== expectedKeys.length || keys.some(key => typeof key !== 'string' || !expectedKeys.includes(key))) {
			return false;
		}
		const field = (key: string): unknown => {
			const descriptor = Object.getOwnPropertyDescriptor(value, key);
			return descriptor?.enumerable && Object.prototype.hasOwnProperty.call(descriptor, 'value') ? descriptor.value : undefined;
		};
		const capabilities = field('capabilities');
		if (!Array.isArray(capabilities) || Object.getPrototypeOf(capabilities) !== Array.prototype || capabilities.length !== PARADIS_OFFICE_OPERATIONS.length
			|| Reflect.ownKeys(capabilities).length !== PARADIS_OFFICE_OPERATIONS.length + 1
			|| !PARADIS_OFFICE_OPERATIONS.every((operation, index) => Object.getOwnPropertyDescriptor(capabilities, String(index))?.value === operation)) {
			return false;
		}
		const ownerCapability = field('ownerCapability');
		const connectionEpoch = field('connectionEpoch');
		return field('version') === 1 && field('channel') === PARADIS_OFFICE_CHANNEL
			&& (!hasAuthority || typeof ownerCapability === 'string' && /^[a-f\d]{64}$/.test(ownerCapability)
				&& typeof connectionEpoch === 'number' && Number.isSafeInteger(connectionEpoch) && connectionEpoch > 0);
	} catch {
		return false;
	}
}

function requestSources(request: ParadisOfficeRequest): readonly ParadisOfficeSourceDescriptor[] {
	switch (request.operation) {
		case 'inspect':
		case 'open':
			return [request.source];
		case 'compare':
			return [request.original, request.modified];
		default:
			return [];
	}
}

function withSources(request: ParadisOfficeRequest, sources: readonly ParadisOfficeSourceDescriptor[]): ParadisOfficeRequest {
	switch (request.operation) {
		case 'inspect':
		case 'open':
			return { ...request, source: sources[0] };
		case 'compare':
			return { ...request, original: sources[0], modified: sources[1] };
		default:
			return request;
	}
}

function safeDispose(disposable: IDisposable): void {
	try {
		disposable.dispose();
	} catch {
		// Cleanup must not expose dependency failures.
	}
}

/** Selects the remote Task 6 channel or a local Task 3 bounded-spool fallback. */
export class ParadisOfficeRemoteClient extends Disposable {
	private route: RemoteRoute | undefined;
	private readonly handleRoutes = new Map<string, RemoteRoute>();
	private disposed = false;
	private readonly pendingSpools = new Set<ParadisOfficeSealedSpoolReference>();
	private readonly spoolDescriptors = new Map<ParadisOfficeSealedSpoolReference, ParadisOfficeSourceDescriptor>();

	constructor(private readonly options: ParadisOfficeRemoteClientOptions) {
		super();
	}

	async request(request: ParadisOfficeRequest, token: CancellationToken): Promise<ParadisOfficeRemoteRequestResult> {
		if (this.disposed || token.isCancellationRequested) {
			throw new ParadisOfficeRemoteClientError('cancelled');
		}
		let route: RemoteRoute;
		try {
			route = await this.resolveRoute(token, requestSources(request).length > 0, request);
		} catch (error) {
			if (error instanceof ParadisOfficeRemoteClientError) {
				throw error;
			}
			throw new ParadisOfficeRemoteClientError(token.isCancellationRequested ? 'cancelled' : 'transportFailed');
		}
		const spools: ParadisOfficeSealedSpoolReference[] = [];
		try {
			const routedRequest = route.kind === 'remoteV1' ? this.validateDirectRemoteRequest(request, route.connection) : await this.prepareLocalFallback(request, spools, token);
			const response = await this.callCancellable(route.channel, 'request', marshalParadisOfficeRequest(routedRequest, route.authority), token);
			const parsed = unmarshalParadisOfficeResponse(response);
			this.rememberHandleRoute(parsed, route, request);
			const warnings = route.kind === 'remoteV1' ? [] : ['office.capability.remoteBackendV0'];
			return { route: route.kind, quality: route.kind === 'remoteV1' ? 'complete' : 'degraded', warnings, response: parsed };
		} catch (error) {
			if (error instanceof ParadisOfficeRemoteClientError) {
				throw error;
			}
			throw new ParadisOfficeRemoteClientError(token.isCancellationRequested ? 'cancelled' : 'transportFailed');
		} finally {
			await this.cleanupSpools(spools);
		}
	}

	override dispose(): void {
		if (this.disposed) {
			return;
		}
		this.disposed = true;
		void this.cleanupSpools([...this.pendingSpools]);
		this.route = undefined;
		super.dispose();
	}

	private async resolveRoute(token: CancellationToken, sourceCreating: boolean, request: ParadisOfficeRequest): Promise<RemoteRoute> {
		let connection: IParadisOfficeRemoteConnection | null;
		try {
			connection = this.options.remoteAgentService.getConnection();
		} catch {
			throw new ParadisOfficeRemoteClientError('transportFailed');
		}
		if (!connection) {
			throw new ParadisOfficeRemoteClientError('noConnection');
		}
		const handleRoute = this.routeForHandle(request);
		if (!sourceCreating && handleRoute?.connection === connection) {
			return handleRoute;
		}
		if (!sourceCreating && this.route?.connection === connection) {
			return this.route;
		}
		if (token.isCancellationRequested) {
			throw new ParadisOfficeRemoteClientError('cancelled');
		}
		let remoteChannel: IChannel | undefined;
		try {
			if (sourceCreating && this.options.isPlatformBackendEnabled?.() === false) {
				throw new Error('platform backend disabled');
			}
			remoteChannel = connection.getChannel(PARADIS_OFFICE_CHANNEL);
			const negotiation = await this.callCancellable(remoteChannel, 'negotiate', { versions: [1, 0] }, token);
			if (isV1Negotiation(negotiation) && negotiation.ownerCapability && negotiation.connectionEpoch) {
				const authority = { ownerCapability: negotiation.ownerCapability, connectionEpoch: negotiation.connectionEpoch };
				return this.route = { connection, channel: remoteChannel, kind: 'remoteV1', authority };
			}
		} catch {
			if (token.isCancellationRequested) {
				throw new ParadisOfficeRemoteClientError('cancelled');
			}
		}
		let localNegotiation: unknown;
		try {
			localNegotiation = await this.callCancellable(this.options.localChannel, 'negotiate', { versions: [1] }, token);
		} catch {
			throw new ParadisOfficeRemoteClientError(token.isCancellationRequested ? 'cancelled' : 'negotiationFailed');
		}
		if (!isV1Negotiation(localNegotiation)) {
			throw new ParadisOfficeRemoteClientError('negotiationFailed');
		}
		try {
			this.options.onWarning('office.capability.remoteBackendV0');
		} catch {
			// Warning delivery cannot expose UI extension failures or prevent the safe fallback.
		}
		return this.route = { connection, channel: this.options.localChannel, kind: 'boundedLocalSpool' };
	}

	private validateDirectRemoteRequest(request: ParadisOfficeRequest, connection: IParadisOfficeRemoteConnection): ParadisOfficeRequest {
		for (const source of requestSources(request)) {
			if (source.kind === 'sideMissing') {
				continue;
			}
			if ((source.kind !== 'remote' && source.kind !== 'workingTree') || !source.uri) {
				throw new ParadisOfficeRemoteClientError('sourceFailed');
			}
			let resource: URI;
			try {
				resource = URI.parse(source.uri, true);
			} catch {
				throw new ParadisOfficeRemoteClientError('sourceFailed');
			}
			if (resource.scheme !== 'vscode-remote' || resource.authority !== connection.remoteAuthority) {
				throw new ParadisOfficeRemoteClientError('sourceFailed');
			}
		}
		return request;
	}

	private async prepareLocalFallback(request: ParadisOfficeRequest, spools: ParadisOfficeSealedSpoolReference[], token: CancellationToken): Promise<ParadisOfficeRequest> {
		const sources: ParadisOfficeSourceDescriptor[] = [];
		for (const source of requestSources(request)) {
			if (token.isCancellationRequested) {
				throw new ParadisOfficeRemoteClientError('cancelled');
			}
			let backendSource: ParadisOfficeBackendSource;
			try {
				backendSource = await this.options.sourceBroker.open(source, token);
			} catch {
				throw new ParadisOfficeRemoteClientError(token.isCancellationRequested ? 'cancelled' : 'sourceFailed');
			}
			if (backendSource.kind === 'sideMissing') {
				sources.push(backendSource.descriptor);
				continue;
			}
			if (backendSource.kind !== 'spool' || backendSource.spool.ownerId.length < 1) {
				throw new ParadisOfficeRemoteClientError('sourceFailed');
			}
			spools.push(backendSource.spool);
			this.pendingSpools.add(backendSource.spool);
			this.spoolDescriptors.set(backendSource.spool, backendSource.descriptor);
			await this.callCancellable(this.options.localChannel, 'source/bind', marshalParadisOfficeWireValue({ descriptor: backendSource.descriptor, spool: backendSource.spool }), token);
			sources.push(backendSource.descriptor);
		}
		return withSources(request, sources);
	}

	private async callCancellable(channel: IChannel, command: string, arg: unknown, token: CancellationToken): Promise<unknown> {
		if (token.isCancellationRequested) {
			throw new ParadisOfficeRemoteClientError('cancelled');
		}
		let listener: IDisposable | undefined;
		const cancelled = new Promise<never>((_resolve, reject) => {
			listener = token.onCancellationRequested(() => reject(new ParadisOfficeRemoteClientError('cancelled')));
		});
		try {
			return await Promise.race([channel.call(command, arg, token), cancelled]);
		} finally {
			if (listener) {
				safeDispose(listener);
			}
		}
	}

	private async cleanupSpools(spools: readonly ParadisOfficeSealedSpoolReference[]): Promise<void> {
		for (const spool of spools) {
			const descriptor = this.spoolDescriptors.get(spool);
			this.pendingSpools.delete(spool);
			this.spoolDescriptors.delete(spool);
			if (descriptor) {
				try {
					await this.options.localChannel.call('source/unbind', marshalParadisOfficeWireValue({ descriptor, spool }));
				} catch {
					// A consumed binding is already absent; cleanup is deliberately idempotent.
				}
			}
			try {
				await this.options.spoolClient.dispose(spool);
			} catch {
				// Owner-bound cleanup is best effort; raw errors are never surfaced.
			}
		}
	}

	private routeForHandle(request: ParadisOfficeRequest): RemoteRoute | undefined {
		switch (request.operation) {
			case 'getViewport': case 'search': case 'getRenderableAsset': case 'getPrintModel': case 'exportPrint':
				return this.handleRoutes.get(`${request.handle.kind}:${request.handle.id}`);
			case 'close': case 'cancel':
				return request.handle ? this.handleRoutes.get(`${request.handle.kind}:${request.handle.id}`) : undefined;
			default: return undefined;
		}
	}

	private rememberHandleRoute(response: ParadisOfficeResponse, route: RemoteRoute, request: ParadisOfficeRequest): void {
		if (response.ok && (response.operation === 'open' || response.operation === 'compare')) {
			this.handleRoutes.set(`${response.handle.kind}:${response.handle.id}`, route);
		}
		if (response.ok && request.operation === 'close' && request.handle) {
			this.handleRoutes.delete(`${request.handle.kind}:${request.handle.id}`);
		}
	}
}
