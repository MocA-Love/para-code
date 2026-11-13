/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import assert from 'assert';
import { EventEmitter } from 'events';
import { promises as fs } from 'fs';
import { tmpdir } from 'os';
import { DeferredPromise } from '../../../../../base/common/async.js';
import { Emitter, Event } from '../../../../../base/common/event.js';
import { DisposableStore } from '../../../../../base/common/lifecycle.js';
import { join } from '../../../../../base/common/path.js';
import { IChannel, IChannelClient } from '../../../../../base/parts/ipc/common/ipc.js';
import { serve } from '../../../../../base/parts/ipc/node/ipc.net.js';
import { IEnvironmentMainService } from '../../../../../platform/environment/electron-main/environmentMainService.js';
import { ILifecycleMainService } from '../../../../../platform/lifecycle/electron-main/lifecycleMainService.js';
import { NullLogService } from '../../../../../platform/log/common/log.js';
import { IPtyHostConnection, IPtyHostStarter } from '../../../../../platform/terminal/node/ptyHost.js';
import { PARADIS_PTY_DAEMON_AUTH_CHANNEL } from '../../common/paradisPtyDaemonControl.js';
import { ParadisDaemonPtyHostStarter, ParadisPtyHostIpc } from '../../electron-main/paradisDaemonPtyHostStarter.js';
import { paradisUnresponsiveMarkFile } from '../../node/paradisEnsurePtyHost.js';
import { paradisDaemonRecordFile, paradisWriteDaemonRecord } from '../../node/paradisPtyDaemonLedger.js';

const CHANNEL = 'vscode:createPtyHostMessageChannel';

/** アプリの中の pty ホストの代わり。どの ipc を購読したかと、start() の回数を記録する。 */
class FakeInAppStarter implements IPtyHostStarter {
	starts = 0;
	readonly windowRequests: string[] = [];
	private readonly listener = (_event: unknown, nonce: string) => {
		this.windowRequests.push(nonce);
		this.onWindowRequest();
	};

	constructor(private readonly ipc: EventEmitter, private readonly onWindowRequest: () => void) {
		ipc.on(CHANNEL, this.listener);
	}

	start(): IPtyHostConnection {
		this.starts++;
		const client: IChannelClient = {
			getChannel: <T extends IChannel>() => ({ call: () => Promise.resolve('in-app'), listen: () => Event.None }) as unknown as T,
		};
		return { client, store: new DisposableStore(), onDidProcessExit: Event.None };
	}

	dispose(): void {
		this.ipc.removeListener(CHANNEL, this.listener);
	}
}

// 受理した接続ぶんの `Protocol` は `IPCServer` が畳まないので、リーク検査は外してある
// (`paradisEnsurePtyHost.test.ts` と同じ理由)。
// eslint-disable-next-line local/code-ensure-no-disposables-leak-in-test
suite('ParadisDaemonPtyHostStarter handshake', () => {
	test('名乗りに答えない常駐には期限で見切りを付け、印を残してアプリの中で動かす。立て直しも窓の要求も同じ常駐へは戻さない', async function () {
		this.timeout(10_000);
		const dir = await fs.mkdtemp(join(tmpdir(), 'paradis-daemon-starter-'));
		const paths = { socketPath: join(dir, 'pty.sock'), buildKey: 'test-key', ledgerDir: dir, ledgerFile: join(dir, 'test-key.json'), socketPathTooLong: false };
		// 固まった常駐の代わり。接続は受けるが、名乗り（合言葉）に答えない。
		const server = await serve(paths.socketPath);
		server.registerChannel(PARADIS_PTY_DAEMON_AUTH_CHANNEL, { call: () => new Promise(() => { }), listen: () => Event.None });
		const ipc = new EventEmitter();
		let inApp: FakeInAppStarter | undefined;
		const windowAnswered = new DeferredPromise<void>();
		const starter = new ParadisDaemonPtyHostStarter(
			{ graceTime: 60_000, shortGraceTime: 6_000, scrollback: 100 },
			paths,
			'test-build',
			Object.create(null) as IEnvironmentMainService,
			{ onWillShutdown: new Emitter<void>().event } as unknown as ILifecycleMainService,
			new NullLogService(),
			ipc as unknown as ParadisPtyHostIpc,
			{
				handshakeTimeout: 200,
				createInApp: via => {
					inApp = new FakeInAppStarter(via as unknown as EventEmitter, () => windowAnswered.complete());
					return inApp;
				},
			},
		);
		const connections: IPtyHostConnection[] = [];
		try {
			await paradisWriteDaemonRecord(paradisDaemonRecordFile(dir, 'test-key'), { pid: process.pid, socketPath: paths.socketPath, buildId: 'test-build', buildKey: 'test-key', startedAt: 1234, token: 'token' });
			const first = starter.start();
			connections.push(first);
			const firstAnswer = await first.client.getChannel('any').call('any');
			// 窓の要求は、常駐への橋ではなくアプリの中の pty ホストへ回る
			ipc.emit(CHANNEL, { sender: { isDestroyed: () => false } }, 'window-nonce');
			await windowAnswered.p;
			// `PtyHostService` の立て直し。同じ固まった常駐へは繋ぎ直さない
			const second = starter.start();
			connections.push(second);
			const secondAnswer = await second.client.getChannel('any').call('any');
			assert.deepStrictEqual({
				firstAnswer,
				secondAnswer,
				inAppStarts: inApp?.starts,
				windowRequests: inApp?.windowRequests.slice(),
				mark: JSON.parse(await fs.readFile(paradisUnresponsiveMarkFile(paths), 'utf8')),
			}, {
				firstAnswer: 'in-app',
				secondAnswer: 'in-app',
				inAppStarts: 2,
				windowRequests: ['window-nonce'],
				mark: { pid: process.pid, startedAt: 1234 },
			});
		} finally {
			connections.forEach(connection => connection.store.dispose());
			starter.dispose();
			server.dispose();
			await fs.rm(dir, { recursive: true, force: true });
		}
	});
});
