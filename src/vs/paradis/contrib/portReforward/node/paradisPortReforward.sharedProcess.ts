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
import { isParadisPortReforwardCloseRequest, isParadisPortReforwardProbeRequest, isParadisPortReforwardReferencesRequest, PARADIS_PORT_REFORWARD_CHANNEL, PARADIS_PORT_REFORWARD_FORCE_CLOSE, PARADIS_PORT_REFORWARD_PROBE, PARADIS_PORT_REFORWARD_REFERENCES, ParadisPortReforwardProbeResult, paradisWindowIdOfContext, paradisWindowRemoteOfWorkspace } from '../common/paradisPortReforward.js';
import { paradisProbeLocalForward } from './paradisPortReforwardProbe.js';

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
		private readonly _probe: (localPort: number, remotePort: number) => Promise<ParadisPortReforwardProbeResult> = (localPort, remotePort) => paradisProbeLocalForward(localPort, remotePort),
	) { }

	/**
	 * 送られた接続先が、呼んだ窓のものか確かめる。別の SSH 先の転送を、関係の無い窓から閉じさせない。
	 *
	 * `getWindows()` の窓の情報には接続先（remoteAuthority）が無いので、窓が開いているワークスペースの場所で判じる。
	 * SSH 先のワークスペースならその authority と一致するときだけ、手元のワークスペースなら断る。フォルダーを
	 * 開いていない空の窓は、SSH の空の窓か手元の空の窓か分からないので通す（手元の窓の「張り直す」は接続先が
	 * 無いのでここを呼ばない。閉じるのは転送だけで、張り直しで戻る）。
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
		const remote = paradisWindowRemoteOfWorkspace(window.workspace);
		switch (remote.kind) {
			case 'remote': return remote.authority === authority;
			case 'local': return false;
			case 'unknown': return true;
		}
	}

	listen<T>(_ctx: TContext, event: string): Event<T> {
		throw new Error(`Event not found: ${event}`);
	}

	async call<T>(ctx: TContext, command: string, arg?: unknown): Promise<T> {
		switch (command) {
			case PARADIS_PORT_REFORWARD_FORCE_CLOSE: return await this._forceClose(ctx, arg) as T;
			case PARADIS_PORT_REFORWARD_REFERENCES: return await this._references(ctx, arg) as T;
			case PARADIS_PORT_REFORWARD_PROBE: return await this._probeLocal(ctx, arg) as T;
		}
		throw new Error(`Method not found: ${command}`);
	}

	/**
	 * 転送ごとに、shared process の参照の数（その転送を使っている窓の数）を返す。数が分からなければ null
	 * （その SSH 先の転送が無い、差し替えが外れている）。
	 */
	private async _references(ctx: TContext, arg: unknown): Promise<(number | null)[]> {
		if (!isParadisPortReforwardReferencesRequest(arg)) {
			throw new Error('Invalid references request');
		}
		if (!await this._isCallersAuthority(ctx, arg.authority)) {
			throw new Error('The remote is not the one of the calling window');
		}
		const tunnels = this._tunnels;
		if (!(tunnels instanceof ParadisSharedTunnelsService)) {
			return arg.remotePorts.map(() => null);
		}
		return arg.remotePorts.map(port => tunnels.referenceCount(arg.authority, arg.remoteHost, port) ?? null);
	}

	/** 手元の受け口から 1 回つないで確かめる。手元の 127.0.0.1 にしかつながない。 */
	private async _probeLocal(ctx: TContext, arg: unknown): Promise<ParadisPortReforwardProbeResult> {
		if (!isParadisPortReforwardProbeRequest(arg)) {
			throw new Error('Invalid probe request');
		}
		if (!await this._isCallersAuthority(ctx, arg.authority)) {
			throw new Error('The remote is not the one of the calling window');
		}
		// 手元の受け口が fork の転送の台帳に無ければ、handshake の結果は届かない。待って「繋がらない」と言わない
		if (!(this._tunnels instanceof ParadisSharedTunnelsService) || this._tunnels.referenceCount(arg.authority, 'localhost', arg.remotePort) === undefined) {
			return 'untested';
		}
		return this._probe(arg.localPort, arg.remotePort);
	}

	private async _forceClose(ctx: TContext, arg: unknown): Promise<boolean> {
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
			return false;
		}
		return await this._tunnels.forceCloseTunnel(arg.authority, arg.remoteHost, arg.remotePort);
	}
}

ParadisSharedProcessContributions.register(PARADIS_PORT_REFORWARD_CHANNEL, ({ server, accessor }) => {
	server.registerChannel(PARADIS_PORT_REFORWARD_CHANNEL, new ParadisPortReforwardChannel<string>(accessor.get(ISharedTunnelsService), accessor.get(INativeHostService), accessor.get(ILogService)));
});
