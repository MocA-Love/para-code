/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import assert from 'assert';
import * as net from 'net';
import { DeferredPromise } from '../../../../base/common/async.js';
import { Disposable, IDisposable } from '../../../../base/common/lifecycle.js';
import { VSBuffer } from '../../../../base/common/buffer.js';
import { ISocket, SocketCloseEvent, SocketDiagnosticsEventType } from '../../../../base/parts/ipc/common/ipc.net.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../base/test/common/utils.js';
import { NullLogService } from '../../../log/common/log.js';
import { IAddress, IConnectionOptions } from '../../../remote/common/remoteAgentConnection.js';
import { IRemoteSocketFactoryService } from '../../../remote/common/remoteSocketFactoryService.js';
import { IMessage, ISignService } from '../../../sign/common/sign.js';
import { IParaTunnelProtocol, ParaTunnelConnectTimeoutError, paraConnectTunnelWithTimeout } from '../../common/paraTunnelConnect.js';
import { NodeRemoteTunnel } from '../../node/tunnelService.js';

/**
 * A do-nothing {@link ISocket} that only records whether it was disposed, so a
 * test can tell that a discarded tunnel was actually closed.
 */
class RecordingSocket implements ISocket {
	public disposed = false;

	onData(_listener: (e: VSBuffer) => void): IDisposable { return Disposable.None; }
	onClose(_listener: (e: SocketCloseEvent) => void): IDisposable { return Disposable.None; }
	onEnd(_listener: () => void): IDisposable { return Disposable.None; }
	write(_buffer: VSBuffer): void { }
	end(): void { }
	async drain(): Promise<void> { }
	traceSocketEvent(_type: SocketDiagnosticsEventType): void { }
	dispose(): void { this.disposed = true; }
}

class RecordingProtocol implements IParaTunnelProtocol {
	public disposed = false;
	public readonly socket = new RecordingSocket();

	getSocket(): ISocket { return this.socket; }
	dispose(): void { this.disposed = true; }
}

suite('paraConnectTunnelWithTimeout', () => {

	ensureNoDisposablesAreLeakedInTestSuite();

	const logService = new NullLogService();

	test('passes a successful connect straight through', async () => {
		const protocol = new RecordingProtocol();
		const result = await paraConnectTunnelWithTimeout(async () => protocol, 'localhost:3000', logService, 5000);

		assert.deepStrictEqual(
			{ result: result === protocol, disposed: protocol.disposed, socketDisposed: protocol.socket.disposed },
			{ result: true, disposed: false, socketDisposed: false }
		);
	});

	test('passes a connect failure through unchanged', async () => {
		const failure = new Error('remote refused');
		const err = await paraConnectTunnelWithTimeout(() => Promise.reject(failure), 'localhost:3000', logService, 5000)
			.then(() => undefined, e => e);

		assert.strictEqual(err, failure);
	});

	test('rejects when the handshake never completes, and closes a tunnel that arrives late', async () => {
		const pending = new DeferredPromise<RecordingProtocol>();
		const err = await paraConnectTunnelWithTimeout(() => pending.p, 'localhost:3000', logService, 1)
			.then(() => undefined, e => e);

		assert.ok(err instanceof ParaTunnelConnectTimeoutError, `expected a timeout error, got ${err}`);

		// The connect cannot be cancelled, so completing it after the fact must
		// close the tunnel rather than leak it: nobody is left to read from it.
		const protocol = new RecordingProtocol();
		pending.complete(protocol);
		await pending.p;
		await new Promise<void>(resolve => setTimeout(resolve, 0));

		assert.deepStrictEqual(
			{ disposed: protocol.disposed, socketDisposed: protocol.socket.disposed },
			{ disposed: true, socketDisposed: true }
		);
	});

	test('a late failure after a reported timeout does not throw again', async () => {
		const pending = new DeferredPromise<RecordingProtocol>();
		await paraConnectTunnelWithTimeout(() => pending.p, 'localhost:3000', logService, 1).then(() => undefined, () => undefined);

		pending.error(new Error('remote refused, eventually'));
		await pending.p.then(() => undefined, () => undefined);
	});
});

suite('NodeRemoteTunnel', () => {

	ensureNoDisposablesAreLeakedInTestSuite();

	const logService = new NullLogService();

	/**
	 * Connection options whose address can never be resolved, so the tunnel
	 * handshake started by `_onConnection` rejects immediately. The socket
	 * factory and sign service are never reached.
	 */
	function failingConnectionOptions(): IConnectionOptions {
		const remoteSocketFactoryService: IRemoteSocketFactoryService = {
			_serviceBrand: undefined,
			connect() { throw new Error('should not be reached'); },
			register() { throw new Error('should not be reached'); },
		};
		const signService: ISignService = {
			_serviceBrand: undefined,
			async createNewMessage(value: string): Promise<IMessage> { return { id: 'test', data: value }; },
			async validate(): Promise<boolean> { return true; },
			async sign(value: string): Promise<string> { return value; },
		};
		return {
			commit: undefined,
			quality: undefined,
			addressProvider: { getAddress: (): Promise<IAddress> => Promise.reject(new Error('no remote agent')) },
			remoteSocketFactoryService,
			signService,
			logService,
			ipcLogger: null,
		};
	}

	test('a failing handshake resets the already-accepted local socket', async () => {
		const tunnel = new NodeRemoteTunnel(failingConnectionOptions(), '127.0.0.1', '127.0.0.1', 45123);
		try {
			await tunnel.waitForReady();

			const client = net.createConnection({ host: '127.0.0.1', port: tunnel.tunnelLocalPort });
			// Send a request first, the way a browser would, so the socket is in
			// the state the bug actually strands: bytes sent, nothing read back.
			client.on('connect', () => client.write('GET /graphql HTTP/1.1\r\nHost: localhost\r\n\r\n'));

			let errorCode: string | undefined;
			client.on('error', (err: NodeJS.ErrnoException) => { errorCode = err.code; });

			// Without the fix the server accepts the connection and then abandons
			// it, so this never settles and the test times out.
			const hadError = await new Promise<boolean>(resolve => client.once('close', resolve));

			// The client must see a *failure*, not a silent close: a plain FIN
			// reads as an empty response and sends the user hunting in their own
			// server, and a browser only fires `did-fail-load` on an actual error.
			assert.deepStrictEqual({ hadError, errorCode }, { hadError: true, errorCode: 'ECONNRESET' });
		} finally {
			await tunnel.dispose();
		}
	});
});
