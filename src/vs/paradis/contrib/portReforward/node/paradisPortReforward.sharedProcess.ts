/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import { Event } from '../../../../base/common/event.js';
import { IServerChannel } from '../../../../base/parts/ipc/common/ipc.js';
import { ILogService } from '../../../../platform/log/common/log.js';
import { INativeHostService } from '../../../../platform/native/common/native.js';
import { ISharedTunnelsService } from '../../../../platform/tunnel/common/tunnel.js';
import { ParadisSharedTunnelsService } from '../../../../platform/tunnel/node/paradisSharedTunnelsService.js';
import { ParadisSharedProcessContributions } from '../../../common/paradisProcessContributions.js';
import { isParadisPortReforwardCloseRequest, PARADIS_PORT_REFORWARD_CHANNEL, PARADIS_PORT_REFORWARD_FORCE_CLOSE, paradisWindowIdOfContext, paradisWorkspaceRemoteAuthority } from '../common/paradisPortReforward.js';

/** 呼んだ窓が開いているワークスペースを引くところ。`INativeHostService.getWindows` のうち、使う部分だけ。 */
export interface IParadisWindowWorkspaces {
	getWindows(options: { includeAuxiliaryWindows: false }): Promise<ReadonlyArray<{ readonly id: number; readonly workspace?: unknown }>>;
}

/** ポートパネルの「張り直す」から、shared process の転送を全部の窓の分まとめて閉じるチャネル。 */
export class ParadisPortReforwardChannel<TContext> implements IServerChannel<TContext> {

	constructor(
		private readonly _tunnels: ISharedTunnelsService,
		private readonly _windows: IParadisWindowWorkspaces,
		private readonly _logService: ILogService,
	) { }

	/**
	 * 送られた接続先が、呼んだ窓のものか確かめる。別の SSH 先の転送を、関係の無い窓から閉じさせない。
	 * 窓のワークスペースが SSH 先にあれば、その authority と一致しなければ断る。空の SSH の窓のように
	 * ワークスペースから接続先が分からない窓は、確かめようがないので通す（閉じるのは転送だけで、
	 * 張り直しで戻る）。
	 */
	private async _isCallersAuthority(ctx: TContext, authority: string): Promise<boolean> {
		const windowId = paradisWindowIdOfContext(ctx);
		if (windowId === undefined) {
			return false;
		}
		const window = (await this._windows.getWindows({ includeAuxiliaryWindows: false })).find(candidate => candidate.id === windowId);
		if (!window) {
			return false;
		}
		const windowAuthority = paradisWorkspaceRemoteAuthority(window.workspace);
		return windowAuthority === undefined || windowAuthority === authority;
	}

	listen<T>(_ctx: TContext, event: string): Event<T> {
		throw new Error(`Event not found: ${event}`);
	}

	async call<T>(ctx: TContext, command: string, arg?: unknown): Promise<T> {
		if (command !== PARADIS_PORT_REFORWARD_FORCE_CLOSE) {
			throw new Error(`Method not found: ${command}`);
		}
		if (!isParadisPortReforwardCloseRequest(arg)) {
			throw new Error('Invalid reforward request');
		}
		if (!await this._isCallersAuthority(ctx, arg.authority)) {
			this._logService.warn(`[ParadisPortReforward] Refused to close a tunnel of ${arg.authority}: it is not the remote of the window that asked.`);
			throw new Error('The remote is not the one of the calling window');
		}
		if (!(this._tunnels instanceof ParadisSharedTunnelsService)) {
			// 差し替えが外れている（upstream の取り込みで sharedProcessMain.ts の PARA-PATCH が落ちた等）。
			// 窓の側で閉じて転送し直すだけでも、別の窓が参照を持っていなければ戻るので、投げずに「閉じなかった」と返す
			this._logService.warn('[ParadisPortReforward] The shared tunnels service is not the fork one; only the window side is forwarded again.');
			return false as T;
		}
		return await this._tunnels.forceCloseTunnel(arg.authority, arg.remoteHost, arg.remotePort) as T;
	}
}

ParadisSharedProcessContributions.register(PARADIS_PORT_REFORWARD_CHANNEL, ({ server, accessor }) => {
	server.registerChannel(PARADIS_PORT_REFORWARD_CHANNEL, new ParadisPortReforwardChannel<string>(accessor.get(ISharedTunnelsService), accessor.get(INativeHostService), accessor.get(ILogService)));
});
