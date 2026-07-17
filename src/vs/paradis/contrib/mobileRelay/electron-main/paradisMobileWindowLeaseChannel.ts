/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-PATCH/PARA-CODE comments)

import { Emitter, Event } from '../../../../base/common/event.js';
import { Disposable } from '../../../../base/common/lifecycle.js';
import { IPCServer, IServerChannel } from '../../../../base/parts/ipc/common/ipc.js';
import { IParadisMobileWindowLease, PARADIS_MOBILE_WINDOW_LEASE_CHANNEL, ParadisMobileRendererLeaseAuthority } from '../common/paradisMobileWindowLease.js';
import { IWindowsMainService } from '../../../../platform/windows/electron-main/windows.js';
import { ILifecycleMainService } from '../../../../platform/lifecycle/electron-main/lifecycleMainService.js';

/** Electron IPC connection contextを使ってRenderer世代を発行・検証するMain Process channel。 */
export class ParadisMobileWindowLeaseChannel extends Disposable implements IServerChannel<string> {
	private readonly authority = new ParadisMobileRendererLeaseAuthority();
	private readonly _onDidChangeManifest = this._register(new Emitter<ReturnType<ParadisMobileRendererLeaseAuthority['manifest']>>());

	constructor(server: IPCServer<string>, windowsMainService: IWindowsMainService, lifecycleMainService?: ILifecycleMainService) {
		super();
		const registerWindow = (window: ReturnType<IWindowsMainService['getWindows']>[number]) => {
			const trackIfWorkbench = () => {
				if (window.config !== undefined && window.config.isSessionsWindow !== true && this.authority.trackWindow(window.id)) {
					this.fireManifest();
				}
			};
			if (window.config !== undefined) {
				trackIfWorkbench();
			} else {
				this._register(Event.once(window.onWillLoad)(trackIfWorkbench));
			}
			this._register(Event.once(Event.any(window.onDidClose, window.onDidDestroy))(() => {
				// アプリ終了中のwindow closeは「windowを本当に閉じた」ではない。ここでmanifestを
				// 空にすると、終了間際のshared processが「complete:true・空」のstateを配信し、
				// モバイル側のワークスペース・端末・エージェント表示が毎回全消去される。
				if (lifecycleMainService?.quitRequested === true) {
					return;
				}
				if (this.authority.destroyWindow(window.id)) {
					this.fireManifest();
				}
			}));
		};
		for (const window of windowsMainService.getWindows()) {
			registerWindow(window);
		}
		const registerConnection = (connection: (typeof server.connections)[number]) => {
			const windowId = /^window:(\d+)$/.exec(connection.ctx)?.[1];
			const window = windowId === undefined ? undefined : windowsMainService.getWindowById(Number(windowId));
			if (window?.config !== undefined && window.config.isSessionsWindow !== true) {
				this.authority.trackWindow(Number(windowId));
			}
			if (this.authority.addConnection(connection.ctx, connection)) {
				this.fireManifest();
			}
			connection.channelServer.registerChannel(PARADIS_MOBILE_WINDOW_LEASE_CHANNEL, {
				call: <T>(_context: string, command: string, arg?: unknown) => this.callForConnection<T>(connection, connection.ctx, command, arg),
				listen: <T>(_context: string, event: string) => this.listen<T>('', event),
			});
		};
		for (const connection of server.connections) {
			registerConnection(connection);
		}
		this._register(server.onDidAddConnection(registerConnection));
		this._register(server.onDidRemoveConnection(connection => {
			if (this.authority.removeConnection(connection.ctx, connection)) {
				this.fireManifest();
			}
		}));
		this._register(windowsMainService.onDidOpenWindow(registerWindow));
	}

	async call<T>(context: string, command: string, arg?: unknown): Promise<T> {
		switch (command) {
			case 'claim':
				return undefined as T;
			case 'validate':
				return this.authority.validate(arg as IParadisMobileWindowLease) as T;
			case 'manifest':
				return this.authority.manifest() as T;
			default:
				throw new Error(`Unknown paradisMobileWindowLease command: ${command}`);
		}
	}

	private async callForConnection<T>(connection: object, context: string, command: string, arg?: unknown): Promise<T> {
		if (command !== 'claim') {
			return this.call(context, command, arg);
		}
		const revision = this.authority.manifestRevision;
		const lease = this.authority.claim(context, connection, typeof arg === 'string' ? arg : '');
		if (this.authority.manifestRevision !== revision) {
			this.fireManifest();
		}
		return lease as T;
	}

	listen<T>(_context: string, event: string): Event<T> {
		return event === 'onDidChangeManifest' ? this._onDidChangeManifest.event as Event<T> : Event.None;
	}

	private fireManifest(): void {
		this._onDidChangeManifest.fire(this.authority.manifest());
	}
}
