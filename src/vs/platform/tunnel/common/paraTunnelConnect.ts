/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import { ISocket } from '../../../base/parts/ipc/common/ipc.net.js';
import { ILogService } from '../../log/common/log.js';

/**
 * The subset of `PersistentProtocol` that tunnel consumers use. Matches both
 * the real protocol returned by `connectRemoteAgentTunnel` and the protocol-like
 * shape declared by `ITunnelConnectFn`.
 */
export interface IParaTunnelProtocol {
	getSocket(): ISocket;
	dispose(): void;
	acceptDisconnect?(): void;
}

/**
 * How long we wait for a tunnel to the remote agent to be established before
 * treating it as dead.
 *
 * `connectRemoteAgentTunnel` is a single-shot connect that passes
 * `CancellationToken.None`, so nothing below it ever gives up: the handshake
 * waits forever for the remote's control message. If the remote agent accepts
 * the socket but never answers, the caller is left holding an already-accepted
 * local socket that will never carry a byte, which surfaces to the user as an
 * endless spinner instead of an error.
 *
 * What this budget covers is wider than the handshake alone. Three steps inside
 * `connectRemoteAgentTunnel` wait without a bound of their own — resolving the
 * remote's address, opening the socket, and reading the final control message —
 * and only the signing step already has one (10s, in `remoteAgentConnection.ts`).
 * The address step matters most: it awaits the authority resolver, which parks on
 * an unresolved promise while a remote is being re-resolved, so a connection that
 * arrives during a reconnect is charged for the wait.
 *
 * On a settled connection the address is already known and the rest is one socket
 * connect, a signed challenge and a single control message, which finishes well
 * under a second on a healthy link and in a few seconds on a slow one. 20s is far
 * beyond that while still reporting the failure to the user while they are still
 * looking at the page they asked for.
 *
 * The trade-off is deliberate: a request made mid-reconnect that used to succeed
 * after a long wait is now reset instead. That is the behaviour we want here —
 * the alternative is the connection that never answers and never errors, which is
 * what this exists to remove.
 */
export const PARA_TUNNEL_CONNECT_TIMEOUT = 20_000;

/**
 * Error thrown by {@link paraConnectTunnelWithTimeout} when the tunnel handshake
 * does not complete in time.
 */
export class ParaTunnelConnectTimeoutError extends Error {
	constructor(readonly target: string, readonly timeoutMs: number) {
		super(`Timed out after ${timeoutMs}ms establishing a tunnel to ${target}`);
	}
}

/**
 * Run `connect` with an upper bound on how long the tunnel handshake may take.
 *
 * Rejects with a {@link ParaTunnelConnectTimeoutError} once the bound is
 * exceeded so the caller can tear its side down and report a failure. The
 * underlying connect cannot be cancelled, so if it completes late the tunnel it
 * produced is closed here rather than leaked — nobody is left to read from it.
 *
 * Successful connects are unaffected: the timer is cleared as soon as the
 * handshake resolves and the protocol is passed straight through.
 */
export function paraConnectTunnelWithTimeout<T extends IParaTunnelProtocol>(
	connect: () => Promise<T>,
	target: string,
	logService: ILogService,
	timeoutMs: number = PARA_TUNNEL_CONNECT_TIMEOUT
): Promise<T> {
	return new Promise<T>((resolve, reject) => {
		let settled = false;

		const timer = setTimeout(() => {
			settled = true;
			logService.error(`[ParaTunnel] Timed out after ${timeoutMs}ms establishing a tunnel to ${target}. Giving up so the caller reports a connection failure instead of hanging.`);
			reject(new ParaTunnelConnectTimeoutError(target, timeoutMs));
		}, timeoutMs);

		// `connect` is called through a promise so that a synchronous throw is delivered as a
		// rejection here rather than escaping the executor, which would leave the timer running.
		Promise.resolve().then(connect).then(protocol => {
			clearTimeout(timer);
			if (settled) {
				// We already reported a timeout and the caller has torn its side
				// down, so this tunnel has no consumer. Close it instead of
				// leaving it open against the remote agent.
				logService.warn(`[ParaTunnel] Tunnel to ${target} was established after the timeout had already been reported; discarding it.`);
				paraDisposeTunnelProtocol(protocol, target, logService);
				return;
			}
			settled = true;
			resolve(protocol);
		}, err => {
			clearTimeout(timer);
			if (settled) {
				logService.trace(`[ParaTunnel] Tunnel to ${target} failed after the timeout had already been reported.`);
				return;
			}
			settled = true;
			reject(err);
		});
	});
}

/**
 * Close a tunnel protocol nobody is going to use, together with its socket.
 * Disposing the protocol alone leaves the socket open.
 *
 * Same sequence as `safeDisposeProtocolAndSocket` in `remoteAgentConnection.ts`, which is not
 * exported. Note that `acceptDisconnect` only settles this side; the remote is not told, which
 * is why the socket has to be disposed too.
 */
function paraDisposeTunnelProtocol(protocol: IParaTunnelProtocol, target: string, logService: ILogService): void {
	try {
		protocol.acceptDisconnect?.();
		const socket = protocol.getSocket();
		protocol.dispose();
		socket.dispose();
	} catch (err) {
		logService.error(`[ParaTunnel] Failed to close the discarded tunnel to ${target}:`, err);
	}
}
