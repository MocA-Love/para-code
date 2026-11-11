/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

// 転送 1 本の張り直し。ポートパネルの「張り直す」（paradisPortReforward.contribution.ts）と、para-browser MCP の
// ポートの転送の道具（portTools/electron-browser/paradisPortToolsChannel.ts）が使う。
//
// (1) この窓の転送を閉じ、(2) shared process で全部の窓の分をまとめて閉じ、(3) 手元のポート・名前・公開範囲を
// 保ったまま転送し直す。(2) が無いと、同じ SSH 先の別の窓が参照を持っている間は shared process が古い転送を返し続ける。

import { localize } from '../../../../nls.js';
import { ISharedProcessService } from '../../../../platform/ipc/electron-browser/services.js';
import { ILogService } from '../../../../platform/log/common/log.js';
import { IRemoteExplorerService } from '../../../../workbench/services/remote/common/remoteExplorerService.js';
import { Tunnel, TunnelCloseReason, TunnelProperties } from '../../../../workbench/services/remote/common/tunnelModel.js';
import { IParadisPortReforwardCloseRequest, IParadisPortReforwardProbeRequest, IParadisPortReforwardReferencesRequest, PARADIS_PORT_REFORWARD_CHANNEL, PARADIS_PORT_REFORWARD_FORCE_CLOSE, PARADIS_PORT_REFORWARD_PROBE, PARADIS_PORT_REFORWARD_REFERENCES, ParadisPortReforwardProbeResult } from '../common/paradisPortReforward.js';

/** 張り直しに使うサービス。`ServicesAccessor` は `await` の後では使えないので、先に取り出しておく。 */
export interface IParadisReforwardServices {
	readonly remoteExplorerService: IRemoteExplorerService;
	readonly sharedProcessService: ISharedProcessService;
	readonly authority: string | undefined;
	readonly logService: ILogService;
}

/**
 * 1 本を張り直す。張れたら undefined、張れなければ理由を返す。
 * @param localPort 手元のポートをこの番号に変えて張り直す。省略すると今の手元のポートのまま
 */
export async function paradisReforwardTunnel({ remoteExplorerService, sharedProcessService, authority, logService }: IParadisReforwardServices, tunnel: Tunnel, localPort?: number): Promise<string | undefined> {
	const remote = { host: tunnel.remoteHost, port: tunnel.remotePort };
	const properties: TunnelProperties = {
		remote,
		local: localPort ?? tunnel.localPort,
		name: tunnel.name,
		source: tunnel.source,
		privacy: tunnel.privacy,
	};

	await remoteExplorerService.close(remote, TunnelCloseReason.Other);
	if (authority) {
		const request: IParadisPortReforwardCloseRequest = { authority, remoteHost: remote.host, remotePort: remote.port };
		try {
			await sharedProcessService.getChannel(PARADIS_PORT_REFORWARD_CHANNEL).call<boolean>(PARADIS_PORT_REFORWARD_FORCE_CLOSE, request);
		} catch (err) {
			// 閉じられなくても、この窓の分は転送し直す（別の窓が参照を持っていなければそれで戻る）
			logService.warn(`[ParadisPortReforward] Could not close the shared tunnel to ${remote.host}:${remote.port} for every window:`, err);
		}
	}

	const result = await remoteExplorerService.forward(properties);
	if (!result) {
		return localize('paradisPortReforward.noTunnel', "転送を作れませんでした");
	}
	if (typeof result === 'string') {
		return result;
	}
	return undefined;
}

/**
 * 転送ごとに、shared process でその転送を使っている窓の数（この窓を含む）を問う。
 * 数が分からなければ（問えなかった・その転送が shared process に無い）その件は undefined。
 */
export async function paradisReforwardReferenceCounts({ sharedProcessService, authority, logService }: Omit<IParadisReforwardServices, 'remoteExplorerService'>, remoteHost: string, remotePorts: readonly number[]): Promise<readonly (number | undefined)[]> {
	if (!authority || remotePorts.length === 0) {
		return remotePorts.map(() => undefined);
	}
	const request: IParadisPortReforwardReferencesRequest = { authority, remoteHost, remotePorts };
	try {
		const counts = await sharedProcessService.getChannel(PARADIS_PORT_REFORWARD_CHANNEL).call<(number | null)[]>(PARADIS_PORT_REFORWARD_REFERENCES, request);
		return remotePorts.map((_, index) => typeof counts[index] === 'number' ? counts[index] : undefined);
	} catch (err) {
		logService.warn('[ParadisPortReforward] Could not ask how many windows use the forwards:', err);
		return remotePorts.map(() => undefined);
	}
}

/** 手元の受け口から 1 回つないで、SSH 先まで届くか確かめる。確かめられなければ undefined。 */
export async function paradisProbeReforwardedPort({ sharedProcessService, authority, logService }: Omit<IParadisReforwardServices, 'remoteExplorerService'>, localPort: number, remotePort: number): Promise<ParadisPortReforwardProbeResult | undefined> {
	if (!authority) {
		return undefined;
	}
	const request: IParadisPortReforwardProbeRequest = { authority, localPort, remotePort };
	try {
		return await sharedProcessService.getChannel(PARADIS_PORT_REFORWARD_CHANNEL).call<ParadisPortReforwardProbeResult>(PARADIS_PORT_REFORWARD_PROBE, request);
	} catch (err) {
		logService.warn(`[ParadisPortReforward] Could not test the forward on local port ${localPort}:`, err);
		return undefined;
	}
}
