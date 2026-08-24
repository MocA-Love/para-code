/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import { createHash, randomBytes } from 'crypto';
import { Event } from '../../../../base/common/event.js';
import { Disposable, DisposableMap, DisposableStore, type IDisposable } from '../../../../base/common/lifecycle.js';
import type { CancellationToken } from '../../../../base/common/cancellation.js';
import type { IPCServer, IServerChannel } from '../../../../base/parts/ipc/common/ipc.js';
import type { IConfigurationService } from '../../../../platform/configuration/common/configuration.js';
import type { RemoteAgentConnectionContext } from '../../../../platform/remote/common/remoteAgentEnvironment.js';
import { PARADIS_OFFICE_CHANNEL, type IParadisOfficeDocumentBackend } from '../common/paradisOfficeChannel.js';
import { ParadisOfficeChannel, type IParadisOfficeConnectionAuthority } from './paradisOfficeChannel.js';
import { ParadisOfficeRemoteBackend } from './paradisOfficeRemoteBackend.js';
import { ParadisSpreadsheetChannel } from './paradisSpreadsheetChannel.js';
import { PARADIS_SPREADSHEET_CHANNEL } from '../common/paradisSpreadsheet.js';

export interface ParadisOfficeServerChannelOptions<TContext> {
	readonly onDidDisconnect?: Event<void>;
	readonly connectionEpoch?: number;
	readonly isPlatformBackendEnabled?: () => boolean;
	readonly createBackend?: (remoteAuthority: string) => IParadisOfficeDocumentBackend;
}

class ParadisOfficeLegacyServerChannel<TContext> implements IServerChannel<TContext> {
	constructor(private readonly channel = new ParadisSpreadsheetChannel()) { }
	listen<T>(_ctx: TContext, event: string): Event<T> { return this.channel.listen(this.owner(_ctx), event); }
	call<T>(_ctx: TContext, command: string, arg?: unknown, _token?: CancellationToken): Promise<T> { return this.channel.call(this.owner(_ctx), command, arg); }
	private owner(_ctx: TContext): string { return 'remote-office-legacy'; }
}

function sameContext(left: RemoteAgentConnectionContext, right: RemoteAgentConnectionContext): boolean {
	return left.remoteAuthority === right.remoteAuthority && left.clientId === right.clientId;
}

function ownerId(context: RemoteAgentConnectionContext): string {
	return `remote:${createHash('sha256').update(context.remoteAuthority).update('\0').update(context.clientId).digest('hex')}`;
}

/** Per-connection wrapper that maps RemoteAgent context to Task 6 owner/epoch capabilities. */
export class ParadisOfficeServerChannel<TContext extends RemoteAgentConnectionContext> extends Disposable implements IServerChannel<TContext> {
	private readonly owner: string;
	private readonly inner: ParadisOfficeChannel;
	private connected = true;

	constructor(private readonly context: TContext, private readonly options: ParadisOfficeServerChannelOptions<TContext> = {}) {
		super();
		this.owner = ownerId(context);
		const epoch = options.connectionEpoch ?? 1;
		const disconnect = this._register(new DisposableStore());
		const disconnectEvent = options.onDidDisconnect ?? Event.None;
		const authority: IParadisOfficeConnectionAuthority = {
			currentEpoch: requestedOwner => this.connected && requestedOwner === this.owner ? epoch : undefined,
			onDidDisconnect: Event.None,
			createCapability: () => randomBytes(32).toString('hex'),
		};
		this.inner = this._register(new ParadisOfficeChannel((options.createBackend ?? (remoteAuthority => new ParadisOfficeRemoteBackend(remoteAuthority)))(context.remoteAuthority), Event.None, undefined, authority));
		disconnect.add(disconnectEvent(() => this.disconnect()));
	}

	listen<T>(_ctx: TContext, _event: string): Event<T> {
		throw new Error('The remote Office channel has no events.');
	}

	call<T>(ctx: TContext, command: string, arg?: unknown): Promise<T> {
		if (!this.connected || !sameContext(ctx, this.context)) {
			return Promise.reject(new Error('The remote Office channel is disconnected.'));
		}
		if (command === 'negotiate' && this.options.isPlatformBackendEnabled?.() === false) {
			return this.inner.call<T>(this.owner, command, { versions: [0] });
		}
		return this.inner.call<T>(this.owner, command, arg);
	}

	override dispose(): void {
		this.disconnect();
		super.dispose();
	}

	private disconnect(): void {
		if (!this.connected) {
			return;
		}
		this.connected = false;
		this.inner.dispose();
	}
}

/** Registers isolated v1 and retained v0 channels for every remote-agent connection. */
export function registerParadisOfficeForServer(server: IPCServer<RemoteAgentConnectionContext>, configurationService?: IConfigurationService): IDisposable {
	const lifecycle = new DisposableStore();
	const channels = lifecycle.add(new DisposableMap<object, DisposableStore>());
	let epoch = 0;
	const addConnection = (connection: (typeof server.connections)[number]): void => {
		channels.deleteAndDispose(connection);
		const store = new DisposableStore();
		const channel = store.add(new ParadisOfficeServerChannel(connection.ctx, {
			connectionEpoch: ++epoch,
			isPlatformBackendEnabled: () => configurationService?.getValue<string>('paradis.officeViewer.engine') !== 'legacy'
				&& configurationService?.getValue<boolean>('paradis.officeViewer.platformBackend') !== false,
		}));
		connection.channelServer.registerChannel(PARADIS_OFFICE_CHANNEL, channel);
		connection.channelServer.registerChannel(PARADIS_SPREADSHEET_CHANNEL, new ParadisOfficeLegacyServerChannel());
		channels.set(connection, store);
	};
	for (const connection of server.connections) {
		addConnection(connection);
	}
	lifecycle.add(server.onDidAddConnection(connection => addConnection(connection)));
	lifecycle.add(server.onDidRemoveConnection(connection => channels.deleteAndDispose(connection)));
	return lifecycle;
}
