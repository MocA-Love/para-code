/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import { Schemas } from '../../../../base/common/network.js';
import { URI, UriComponents } from '../../../../base/common/uri.js';

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

/**
 * 同じ SSH 先の転送を、いくつの窓が使っているか（shared process の転送の参照の数）を問う。
 * 引数は {@link IParadisPortReforwardReferencesRequest}、戻り値はポートごとの参照の数（分からなければ null）。
 */
export const PARADIS_PORT_REFORWARD_REFERENCES = 'references';

/**
 * 手元の受け口（127.0.0.1）から 1 回つないで、SSH 先まで届くか確かめる。
 * 引数は {@link IParadisPortReforwardProbeRequest}、戻り値は {@link ParadisPortReforwardProbeResult}。
 */
export const PARADIS_PORT_REFORWARD_PROBE = 'probe';

export interface IParadisPortReforwardReferencesRequest {
	readonly authority: string;
	readonly remoteHost: string;
	readonly remotePorts: readonly number[];
}

export interface IParadisPortReforwardProbeRequest {
	readonly authority: string;
	readonly localPort: number;
	readonly remotePort: number;
}

/**
 * 確かめた結果。
 * - `reachable`: SSH 先のポートまで転送を作れた
 * - `reset`: SSH 先へ転送を作れなかった（手元の受け口が接続を切った）
 * - `timeout`: SSH 先へ転送を作るのが時間切れになった、または決めた時間のうちに答えが無かった（詰まっている）
 * - `refused`: 手元の受け口に繋がらなかった
 */
export type ParadisPortReforwardProbeResult = 'reachable' | 'reset' | 'timeout' | 'refused';

function isPort(value: unknown): value is number {
	return typeof value === 'number' && Number.isInteger(value) && value > 0 && value <= 65535;
}

/** 渡ってきた値が {@link IParadisPortReforwardReferencesRequest} の形をしているか。 */
export function isParadisPortReforwardReferencesRequest(value: unknown): value is IParadisPortReforwardReferencesRequest {
	if (!value || typeof value !== 'object') {
		return false;
	}
	const request = value as Partial<IParadisPortReforwardReferencesRequest>;
	return typeof request.authority === 'string' && request.authority.length > 0
		&& typeof request.remoteHost === 'string' && request.remoteHost.length > 0
		&& Array.isArray(request.remotePorts) && request.remotePorts.length > 0 && request.remotePorts.length <= 100 && request.remotePorts.every(isPort);
}

/** 渡ってきた値が {@link IParadisPortReforwardProbeRequest} の形をしているか。 */
export function isParadisPortReforwardProbeRequest(value: unknown): value is IParadisPortReforwardProbeRequest {
	if (!value || typeof value !== 'object') {
		return false;
	}
	const request = value as Partial<IParadisPortReforwardProbeRequest>;
	return typeof request.authority === 'string' && request.authority.length > 0 && isPort(request.localPort) && isPort(request.remotePort);
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

/**
 * 窓の開いているワークスペースから分かる、その窓の接続先。
 * - `remote`: フォルダーかワークスペースのファイルが SSH 先（`vscode-remote`）にある。`authority` がその窓の接続先
 * - `local`: 手元のフォルダー・ワークスペースを開いている（SSH の窓ではない）
 * - `unknown`: フォルダーを開いていない空の窓。SSH の空の窓か手元の空の窓かは、ワークスペースからは分からない
 */
export type ParadisWindowRemote =
	| { readonly kind: 'remote'; readonly authority: string }
	| { readonly kind: 'local' }
	| { readonly kind: 'unknown' };

/**
 * 窓の開いているワークスペース（`INativeHostService.getWindows()` の `workspace`）から、その窓の接続先を判じる。
 *
 * `getWindows()` が返す窓の情報（`IOpenedMainWindow`）には接続先（remoteAuthority）が無いので、
 * ワークスペースの場所から読む。そのため空の窓は `unknown` になる。
 */
export function paradisWindowRemoteOfWorkspace(workspace: unknown): ParadisWindowRemote {
	if (!workspace || typeof workspace !== 'object') {
		return { kind: 'unknown' };
	}
	const { uri, configPath } = workspace as { uri?: UriComponents; configPath?: UriComponents };
	const location = uri ?? configPath;
	if (!location || typeof location !== 'object' || typeof location.scheme !== 'string') {
		return { kind: 'unknown' };
	}
	const resource = URI.revive(location);
	if (resource.scheme === Schemas.vscodeRemote && resource.authority) {
		return { kind: 'remote', authority: resource.authority };
	}
	return { kind: 'local' };
}

/** shared process の接続の ctx（`window:<id>`）から窓の id を取り出す。窓でなければ undefined。 */
export function paradisWindowIdOfContext(ctx: unknown): number | undefined {
	if (typeof ctx !== 'string') {
		return undefined;
	}
	const match = /^window:(?<id>\d+)$/.exec(ctx);
	return match?.groups ? Number(match.groups.id) : undefined;
}
