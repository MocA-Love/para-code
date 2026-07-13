/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-PATCH/PARA-CODE comments)

import { Event } from '../../../../base/common/event.js';
import { Disposable } from '../../../../base/common/lifecycle.js';
import { IPCServer, IServerChannel } from '../../../../base/parts/ipc/common/ipc.js';
import { IParadisMobileWindowLease, ParadisMobileRendererLeaseAuthority } from '../common/paradisMobileWindowLease.js';

/** Electron IPC connection contextを使ってRenderer世代を発行・検証するMain Process channel。 */
export class ParadisMobileWindowLeaseChannel extends Disposable implements IServerChannel<string> {
	private readonly authority = new ParadisMobileRendererLeaseAuthority();

	constructor(server: IPCServer<string>) {
		super();
		for (const connection of server.connections) {
			this.authority.addConnection(connection.ctx, connection);
		}
		this._register(server.onDidAddConnection(connection => this.authority.addConnection(connection.ctx, connection)));
		this._register(server.onDidRemoveConnection(connection => this.authority.removeConnection(connection.ctx, connection)));
	}

	async call<T>(context: string, command: string, arg?: unknown): Promise<T> {
		switch (command) {
			case 'claim':
				return this.authority.claim(context, typeof arg === 'string' ? arg : '') as T;
			case 'validate':
				return this.authority.validate(arg as IParadisMobileWindowLease) as T;
			case 'manifest':
				return this.authority.manifest() as T;
			default:
				throw new Error(`Unknown paradisMobileWindowLease command: ${command}`);
		}
	}

	listen<T>(): Event<T> {
		return Event.None;
	}
}
