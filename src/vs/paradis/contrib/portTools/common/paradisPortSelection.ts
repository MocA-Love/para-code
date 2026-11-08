/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

// 片付けと番号の揃え直しで対象にする転送の決め方。ポートパネルの「…」のダイアログ（paradisPortPanelActions.contribution.ts）と
// para-browser MCP の clean_up_port_forwards（paradisPortToolsChannel.ts）が同じ決め方を使う。
//
// - 動いていない転送: 利用者（プレビュー・リンクを含む）が張り、SSH 先の localhost のポートで、今は listen しているプロセスが無いもの。
//   既定で外すのは 32768 以上のエフェメラル帯だけ（決まった番号はサーバーを止めているだけのことが多い）。ダイアログでは
//   決まった番号も一覧に出してチェックを外しておき、MCP ではエフェメラル帯だけを対象にする
// - 番号のずれ: 手元とリモートの番号が違う転送。拡張（HTML プレビューなど）の転送は持ち主が手元の番号を覚えているので除く

import { isLocalhost } from '../../../../platform/tunnel/common/tunnel.js';
import { Tunnel, TunnelSource } from '../../../../workbench/services/remote/common/tunnelModel.js';
import { PARADIS_PORT_TOOLS_EPHEMERAL_MIN_PORT } from './paradisPortTools.js';

/** エフェメラル帯（{@link PARADIS_PORT_TOOLS_EPHEMERAL_MIN_PORT} 以上）の番号か。 */
export function paradisIsEphemeralPort(port: number): boolean {
	return port >= PARADIS_PORT_TOOLS_EPHEMERAL_MIN_PORT;
}

function closeableLocalhost(tunnel: Tunnel): boolean {
	return tunnel.closeable !== false && isLocalhost(tunnel.remoteHost);
}

/** 利用者が張り、今は listen しているプロセスが無い転送（番号の帯は問わない）。 */
export function paradisNotListeningUserForwards(forwarded: readonly Tunnel[]): Tunnel[] {
	return forwarded.filter(tunnel => closeableLocalhost(tunnel) && tunnel.source.source === TunnelSource.User && tunnel.hasRunningProcess !== true);
}

/** 片付けで既定で外す転送（動いていない転送のうちエフェメラル帯のもの）。 */
export function paradisDefaultCleanUpForwards(forwarded: readonly Tunnel[]): Tunnel[] {
	return paradisNotListeningUserForwards(forwarded).filter(tunnel => paradisIsEphemeralPort(tunnel.remotePort));
}

/** 手元とリモートの番号が違う転送（拡張の転送は除く）。 */
export function paradisMismatchedForwards(forwarded: readonly Tunnel[]): Tunnel[] {
	return forwarded.filter(tunnel => closeableLocalhost(tunnel) && tunnel.source.source !== TunnelSource.Extension && tunnel.localPort !== undefined && tunnel.localPort !== tunnel.remotePort);
}

/**
 * 設定 `remote.localPortHost` の値が、手元の受け口を 127.0.0.1 にするものか（未設定・localhost）。allInterfaces の窓では
 * 0.0.0.0 で受けてしまい、SSH 先のサーバーが LAN から見えるので、道具・CSV の取り込み・番号の揃え直しでは張らない。
 */
export function paradisPortLocalHostAllowed(value: unknown): boolean {
	return value === undefined || value === null || value === '' || value === 'localhost';
}

/** 手元のアドレス（`127.0.0.1:21004`・`localhost:21004`・`[::1]:21004`・URL）がループバックか。張った後の確かめに使う。 */
export function paradisIsLoopbackLocalAddress(address: string): boolean {
	let host: string;
	if (address.includes('://')) {
		try {
			host = new URL(address).hostname;
		} catch {
			return false;
		}
	} else {
		const match = /^(?<host>\[[^\]]+\]|[^:]+|[0-9a-fA-F:]+?)(?::\d+)?$/.exec(address);
		host = match?.groups?.host ?? '';
	}
	host = host.replace(/^\[|\]$/g, '');
	return isLocalhost(host) || /^127(?:\.\d{1,3}){3}$/.test(host);
}
