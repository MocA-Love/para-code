/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import { localize } from '../../../nls.js';

/**
 * Which forwarded ports the Ports view brings back when a remote window opens again.
 *
 * Upstream stores every tunnel of the window and reopens it, including tunnels the
 * Ports view never asked for: the HTML preview's 127.0.0.1 server, terminal links,
 * OAuth redirect targets and webview port mappings call `ITunnelService.openTunnel`
 * directly, and `TunnelModel` records them as "User Forwarded". Once restored nobody
 * closes them, so ephemeral ports pile up in the view.
 *
 * `tunnelModel.ts` calls into this file from three places (all marked PARA-PATCH):
 * - tunnels it did not open itself get {@link paradisImplicitTunnelSource}, which uses the
 *   extension kind. The model's restore only updates tunnels of that kind and never
 *   reopens them, so they work now and are gone the next time the window opens.
 * - when saving, {@link paradisMarkExplicitTunnelRecords} marks the other records, so the
 *   restore can tell them from records saved before this change.
 * - before restoring, {@link paradisTunnelsToRestore} drops implicit records, and drops
 *   unmarked (old) records of ephemeral remote ports that are not known to be listening.
 *   Old records cannot tell an implicit tunnel from a forwarded one; once the window saves
 *   again, every record it keeps is marked, so this cleanup happens once.
 *
 * Tunnels forwarded through `IRemoteExplorerService.forward` (the Ports view, CSV import,
 * MCP tools, port reforwarding) keep their kind and are restored as before.
 */

/**
 * First port of the range the remote OS hands out on `listen(0)`. Linux uses
 * 32768-60999 and macOS 49152-65535, so 32768 covers both.
 */
export const PARADIS_EPHEMERAL_PORT_START = 32768;

/**
 * The `source` of a tunnel record (`TunnelModel`'s `{ source, description }`), with the
 * fork's marker for tunnels the Ports view did not open.
 */
export interface IParadisTunnelSourceLike<TKind> {
	readonly source: TKind;
	readonly description: string;
	readonly paradisImplicit?: boolean;
}

/**
 * Source for a tunnel the window opened without the Ports view (preview, link, OAuth
 * redirect, webview). `extensionKind` is `TunnelSource.Extension`; it is passed in so this
 * file does not import `tunnelModel.ts`, which imports this file.
 */
export function paradisImplicitTunnelSource<TKind>(extensionKind: TKind): IParadisTunnelSourceLike<TKind> {
	return {
		source: extensionKind,
		// allow-any-unicode-next-line
		description: localize('paradisTunnelRestore.implicitSource', "プレビュー・リンクの転送"),
		paradisImplicit: true,
	};
}

/**
 * Whether the record was saved for a tunnel the Ports view did not open.
 */
export function paradisIsImplicitTunnelSource(source: IParadisTunnelSourceLike<unknown> | undefined): boolean {
	return source?.paradisImplicit === true;
}

/**
 * Whether the remote port is in the range the OS assigns to `listen(0)`.
 */
export function paradisIsEphemeralPort(port: number): boolean {
	return port >= PARADIS_EPHEMERAL_PORT_START;
}

/**
 * Marker on a stored record saved by a Para Code that records implicit tunnels with
 * {@link paradisImplicitTunnelSource}.
 */
interface IParadisMarkedTunnelRecord {
	paradisExplicit?: boolean;
}

/**
 * Marks the records about to be saved, except implicit ones. Mutates the records.
 */
export function paradisMarkExplicitTunnelRecords(records: readonly { readonly source: IParadisTunnelSourceLike<unknown> }[]): void {
	for (const record of records) {
		if (!paradisIsImplicitTunnelSource(record.source)) {
			(record as IParadisMarkedTunnelRecord).paradisExplicit = true;
		}
	}
}

/**
 * Picks the stored tunnel records the window should restore.
 *
 * - Records of implicit tunnels are dropped. Dropping them (instead of letting the model
 *   keep them as unrestored extension tunnels) also keeps their old local port from being
 *   reused when the same remote port is forwarded later.
 * - Marked records (saved after this change) are restored whatever their port.
 * - Unmarked records saved before this change mark preview and link tunnels as "User
 *   Forwarded", so those whose remote port is ephemeral are dropped unless the remote
 *   port is known to be listening. Fixed ports such as 21004 or 3000 are restored.
 * - Extension records are left to the model, which only updates them.
 *
 * Dropped records disappear from storage the next time the model saves its tunnels.
 */
export function paradisTunnelsToRestore<TKind, T extends { readonly remoteHost: string; readonly remotePort: number; readonly source: IParadisTunnelSourceLike<TKind> }>(
	tunnels: readonly T[],
	extensionKind: TKind,
	isListening: (host: string, port: number) => boolean
): T[] {
	return tunnels.filter(tunnel => {
		if (paradisIsImplicitTunnelSource(tunnel.source)) {
			return false;
		}
		if (tunnel.source.source === extensionKind || (tunnel as IParadisMarkedTunnelRecord).paradisExplicit === true) {
			return true;
		}
		return !paradisIsEphemeralPort(tunnel.remotePort) || isListening(tunnel.remoteHost, tunnel.remotePort);
	});
}
