/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

// renderer から、ビューアが読むファイルを配るサーバへフォルダーを載せるクライアント。
//
// 手元のファイルは shared process のサーバへ、SSH 先のファイルはリモートサーバの同じチャネルへ
// 載せる。リモートの場合、webview から見えるのはリモートの port ではないので、ポート転送で手元に
// 開いた口を使う（`ITunnelService.openTunnel`。webview のポートマッピングが使っているのと同じ経路）。
// 転送は**ビューアのペインが持つ**。`openTunnel` は同じ相手なら既存の口を返すが、そのたびに
// 参照数を増やす作りなので、描画のたびに呼ぶと数え上がって二度と閉じられなくなる。ペインごとに
// 1本だけ張り、ペインが捨てられるときに閉じる。
//
// ここが投げたら、呼び出し側は従来の service worker 経路へ戻すこと。**最悪でも今までどおりに
// 戻るだけ**、という形を保つ。

import { Disposable } from '../../../../base/common/lifecycle.js';
import { URI } from '../../../../base/common/uri.js';
import { ISharedProcessService } from '../../../../platform/ipc/electron-browser/services.js';
import { IRemoteAuthorityResolverService } from '../../../../platform/remote/common/remoteAuthorityResolver.js';
import { getRemoteTunnelGeneration, ITunnelService, RemoteTunnel } from '../../../../platform/tunnel/common/tunnel.js';
import { IRemoteAgentService } from '../../../../workbench/services/remote/common/remoteAgentService.js';
import { IParadisPreviewMount, PARADIS_HTML_PREVIEW_CHANNEL } from '../common/paradisHtmlPreview.js';

/** 載せた結果と、webview から実際に叩けるポート。 */
export interface IParadisPreviewLocation {
	readonly mount: IParadisPreviewMount;
	readonly port: number;
}

/** 手元のフォルダーを shared process のサーバへ載せる。 */
export async function paradisMountLocalPreview(
	sharedProcessService: ISharedProcessService,
	directory: URI,
): Promise<IParadisPreviewLocation> {
	const mount = await sharedProcessService.getChannel(PARADIS_HTML_PREVIEW_CHANNEL)
		.call<IParadisPreviewMount>('mount', [directory.fsPath]);
	return { mount, port: mount.port };
}

/**
 * SSH 先のフォルダーをリモートサーバへ載せ、手元へ転送したポートを返す係。
 *
 * ビューアのペインが1つずつ持ち、ペインと一緒に捨てる。捨てると転送も閉じる。
 */
export class ParadisRemotePreviewMounter extends Disposable {

	/** リモートのポートごとの転送。同じポートへ二重に張らない。 */
	private readonly _tunnels = new Map<number, Promise<RemoteTunnel>>();
	private _disposed = false;

	constructor(
		private readonly _remoteAgentService: IRemoteAgentService,
		private readonly _remoteAuthorityResolverService: IRemoteAuthorityResolverService,
		private readonly _tunnelService: ITunnelService,
	) {
		super();
		// 転送はユーザーからも見えていて、Ports ビューの「転送を停止」で閉じられる。閉じられた
		// ものを持ち続けると、死んだ転送のポートを指したまま二度と張り直さない。旧 entry の close
		// は新しい同一 port entry の生成後に遅れて届き得るので、generation があれば現在 Promise と
		// 両方を照合する。custom/legacy service の port-only event は従来どおりに扱う。
		this._register(this._tunnelService.onTunnelClosed(({ port, generation }) => {
			const current = this._tunnels.get(port);
			if (!current) {
				return;
			}
			if (generation === undefined) {
				this._tunnels.delete(port);
				return;
			}
			current.then(tunnel => {
				if (this._tunnels.get(port) === current && getRemoteTunnelGeneration(tunnel) === generation) {
					this._tunnels.delete(port);
				}
			}, () => { });
		}));
	}

	/** 載せられなければ投げる。呼び出し側は従来の service worker 経路へ戻すこと。 */
	async mount(directory: URI): Promise<IParadisPreviewLocation> {
		const connection = this._remoteAgentService.getConnection();
		if (!connection) {
			throw new Error('No remote connection for the preview server');
		}
		// リモート側では `path` がそのマシンのファイルパスになる。`fsPath` はこちらの OS の流儀で
		// 変換してしまうので使わない（Windows から Linux へ繋いだときに壊れる）。
		const mount = await connection.getChannel(PARADIS_HTML_PREVIEW_CHANNEL)
			.call<IParadisPreviewMount>('mount', [directory.path]);

		let tunnelPromise = this._tunnels.get(mount.port);
		if (!tunnelPromise) {
			tunnelPromise = this._openTunnel(connection.remoteAuthority, mount.port);
			// 失敗を覚え込まないよう、投げた時点で台帳から外す（次の描画でやり直せる）。
			tunnelPromise.catch(() => {
				if (this._tunnels.get(mount.port) === tunnelPromise) {
					this._tunnels.delete(mount.port);
				}
			});
			this._tunnels.set(mount.port, tunnelPromise);
			if (this._disposed) {
				// 台帳へ載せる前に `dispose()` が走り終えていた＝この転送は誰も閉じない。
				// **ここでだけ**自分で閉じる。載せたあとに捨てられたぶんは `dispose()` が拾うので、
				// 待ち明けに改めて閉じると、同じポートを持つ別のペインの参照まで減らしてしまう。
				this._tunnels.delete(mount.port);
				tunnelPromise.then(tunnel => tunnel.dispose(), () => { });
				throw new Error('The preview pane was closed while forwarding the remote port');
			}
		}

		const tunnel = await tunnelPromise;
		return { mount, port: tunnel.tunnelLocalPort ?? portOfAddress(tunnel.localAddress) };
	}

	override dispose(): void {
		this._disposed = true;
		for (const tunnelPromise of this._tunnels.values()) {
			// 参照数を戻す。失敗しても捨てる側は何もできないので握る。
			tunnelPromise.then(tunnel => tunnel.dispose(), () => { });
		}
		this._tunnels.clear();
		super.dispose();
	}

	private async _openTunnel(authority: string, remotePort: number): Promise<RemoteTunnel> {
		const resolved = await this._remoteAuthorityResolverService.resolveAuthority(authority);
		const tunnelOrError = await this._tunnelService.openTunnel(
			{ getAddress: async () => resolved.authority },
			'127.0.0.1',
			remotePort,
			// **手元側の bind 先を明示する。** 省くと `remote.localPortHost` の設定次第で
			// 0.0.0.0 に開き、SSH 先のフォルダーが LAN から読めるようになる。
			'127.0.0.1');
		if (!tunnelOrError || typeof tunnelOrError === 'string') {
			// 文字列が返るのは「張れなかった理由」。
			throw new Error(`Could not forward the remote preview port: ${tunnelOrError ?? 'no tunnel'}`);
		}
		const tunnel = tunnelOrError;
		let transferred = false;
		try {
			// **明示しただけでは足りない。** トンネルは (リモートのホスト, ポート) だけで使い回され、
			// 手元の bind 先はキーに入らない。`remote.autoForwardPorts`（既定 on）が先に同じポートを
			// 0.0.0.0 で張っていれば、こちらの指定は黙って無視されて既存のものが返る。**返ってきた
			// 実際の bind 先を確かめ、ループバックでなければ使わない**（従来経路へ倒す）。
			if (!isLoopbackAddress(tunnel.localAddress)) {
				throw new Error('The remote preview port was forwarded to ' + tunnel.localAddress + ', which is not loopback');
			}
			transferred = true;
			return tunnel;
		} finally {
			if (!transferred) {
				await tunnel.dispose();
			}
		}
	}
}

/** `127.0.0.1:1234` 形式が手元だけに開いているか。 */
function isLoopbackAddress(localAddress: string): boolean {
	const host = localAddress.replace(/:\d+$/, '').replace(/^\[|\]$/g, '');
	return host === '127.0.0.1' || host === 'localhost' || host === '::1';
}

/** `127.0.0.1:1234` 形式からポートだけ取り出す。取れなければ投げる。 */
function portOfAddress(localAddress: string): number {
	const port = Number(localAddress.split(':').pop());
	if (!Number.isInteger(port) || port <= 0) {
		throw new Error(`Could not read the forwarded port from ${localAddress}`);
	}
	return port;
}
