/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

// ポートパネルの「張り直す」が shared process に頼むことの取り決め。
//
// shared process の転送は SSH 先とリモートのポートごとに 1 本で、同じポートを転送した窓どうしで
// 共有される。最初に作った窓の宛先を持ち続けるので、その窓が居なくなると、残った窓が「転送を停止」
// してから転送し直しても、同じ壊れた転送が返る。張り直すときは、窓の側で閉じた後に shared process で
// 全部の窓の分をまとめて閉じ、それから同じ手元のポートで転送し直す。

/** shared process のチャネル名。 */
export const PARADIS_PORT_REFORWARD_CHANNEL = 'paradisPortReforward';

/** 全部の窓の分をまとめて閉じる。引数は {@link IParadisPortReforwardCloseRequest}、戻り値は閉じに行ったか。 */
export const PARADIS_PORT_REFORWARD_FORCE_CLOSE = 'forceClose';

export interface IParadisPortReforwardCloseRequest {
	readonly authority: string;
	readonly remoteHost: string;
	readonly remotePort: number;
}

/** 渡ってきた値が {@link IParadisPortReforwardCloseRequest} の形をしているか。 */
export function isParadisPortReforwardCloseRequest(value: unknown): value is IParadisPortReforwardCloseRequest {
	if (!value || typeof value !== 'object') {
		return false;
	}
	const request = value as Partial<IParadisPortReforwardCloseRequest>;
	return typeof request.authority === 'string' && request.authority.length > 0
		&& typeof request.remoteHost === 'string' && request.remoteHost.length > 0
		&& typeof request.remotePort === 'number' && Number.isInteger(request.remotePort) && request.remotePort > 0 && request.remotePort <= 65535;
}
