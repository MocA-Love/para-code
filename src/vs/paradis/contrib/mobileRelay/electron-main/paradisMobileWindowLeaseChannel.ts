/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-PATCH/PARA-CODE comments)

import { Emitter, Event } from '../../../../base/common/event.js';
import { Disposable } from '../../../../base/common/lifecycle.js';
import { IPCServer, IServerChannel } from '../../../../base/parts/ipc/common/ipc.js';
import { IParadisMobileWindowLease, ParadisMobileRendererLeaseAuthority } from '../common/paradisMobileWindowLease.js';
import { IWindowsMainService } from '../../../../platform/windows/electron-main/windows.js';

/** Electron IPC connection contextを使ってRenderer世代を発行・検証するMain Process channel。 */
export class ParadisMobileWindowLeaseChannel extends Disposable implements IServerChannel<string> {
	private readonly authority = new ParadisMobileRendererLeaseAuthority();
	private readonly _onDidChangeManifest = this._register(new Emitter<ReturnType<ParadisMobileRendererLeaseAuthority['manifest']>>());

	constructor(server: IPCServer<string>, windowsMainService: IWindowsMainService) {
		super();
		for (const connection of server.connections) {
			this.authority.addConnection(connection.ctx, connection);
		}
		this._register(server.onDidAddConnection(connection => {
			if (this.authority.addConnection(connection.ctx, connection)) {
				this.fireManifest();
			}
		}));
		this._register(server.onDidRemoveConnection(connection => {
			if (this.authority.removeConnection(connection.ctx, connection)) {
				this.fireManifest();
			}
		}));
		this._register(windowsMainService.onDidDestroyWindow(window => {
			if (this.authority.destroyWindow(window.id)) {
				this.fireManifest();
			}
		}));
	}

	async call<T>(context: string, command: string, arg?: unknown): Promise<T> {
		switch (command) {
			case 'claim': {
				const revision = this.authority.manifestRevision;
				const lease = this.authority.claim(context, typeof arg === 'string' ? arg : '');
				if (this.authority.manifestRevision !== revision) {
					this.fireManifest();
				}
				return lease as T;
			}
			case 'validate':
				return this.authority.validate(arg as IParadisMobileWindowLease) as T;
			case 'manifest':
				return this.authority.manifest() as T;
			default:
				throw new Error(`Unknown paradisMobileWindowLease command: ${command}`);
		}
	}

	listen<T>(_context: string, event: string): Event<T> {
		return event === 'onDidChangeManifest' ? this._onDidChangeManifest.event as Event<T> : Event.None;
	}

	private fireManifest(): void {
		this._onDidChangeManifest.fire(this.authority.manifest());
	}
}
