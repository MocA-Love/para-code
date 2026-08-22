/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

// 停止の依頼が**本当に届くか**を、本物のソケット相手に確かめる。
//
// 実機で「停止を押しても何も起きない」が出た。原因は要求を送った直後に同じ tick で接続を
// 畳んでいたことで、`ChannelClient` は dispose のときに進行中の要求を取り消すため、送られる前に
// 消えていた。判断はどれも正しく、**順序だけ**が違っていたので、純粋な単体テストでは捕まらない。

import assert from 'assert';
import { mkdtempSync, rmSync } from 'fs';
import { join } from '../../../../../base/common/path.js';
import { DisposableStore } from '../../../../../base/common/lifecycle.js';
import { ProxyChannel } from '../../../../../base/parts/ipc/common/ipc.js';
import { serve } from '../../../../../base/parts/ipc/node/ipc.net.js';
import { PARADIS_PTY_DAEMON_AUTH_CHANNEL, PARADIS_PTY_DAEMON_CONTROL_CHANNEL } from '../../common/paradisPtyDaemonControl.js';
import { ParadisPtyDaemonAuth, paradisCreateDaemonToken } from '../../node/paradisPtyDaemonAuth.js';
import { paradisAskDaemonToStop } from '../../node/paradisPtyDaemonStop.js';

// 受理した接続ぶんの `Protocol` は `IPCServer` が畳まないので、リーク検査は外してある
// (`paradisPtyDaemonServer.test.ts` と同じ理由)。
// eslint-disable-next-line local/code-ensure-no-disposables-leak-in-test
suite('ParadisPtyDaemonStop', () => {

	let dir: string | undefined;
	const store = new DisposableStore();

	teardown(() => {
		store.clear();
		if (dir) {
			rmSync(dir, { recursive: true, force: true });
			dir = undefined;
		}
	});

	test('actually delivers the request, and refuses anyone who cannot name themselves', async () => {
		// macOS の `os.tmpdir()` は長く、ソケットのパスが sun_path の上限を超える。
		dir = mkdtempSync('/tmp/pc-stop-');
		const socketPath = join(dir, 's.sock');
		const token = paradisCreateDaemonToken();

		const asked: string[] = [];
		const server = await serve(socketPath);
		store.add(server);
		server.registerChannel(PARADIS_PTY_DAEMON_AUTH_CHANNEL, ProxyChannel.fromService(new ParadisPtyDaemonAuth(token), store));
		server.registerChannel(PARADIS_PTY_DAEMON_CONTROL_CHANNEL, ProxyChannel.fromService({
			async describe() { throw new Error('not used here'); },
			async shutdown() { asked.push('shutdown'); },
		}, store));

		// **これが本題。** 以前はここで 0 件だった（要求を送る前に接続を畳んでいた）。
		const delivered = await paradisAskDaemonToStop(socketPath, token);
		const deliveredCount = asked.length;

		// 身元を知らない相手には頼まない。頼んでしまうと、その名前を持っているのが誰なのか
		// 分からないまま止めに行くことになる。
		const wrongToken = await paradisAskDaemonToStop(socketPath, paradisCreateDaemonToken());

		// 誰も待ち受けていない名前。片付けようとしない。
		const missing = await paradisAskDaemonToStop(join(dir, 'nobody.sock'), token);

		assert.deepStrictEqual(
			{ delivered, deliveredCount, wrongToken, missing, askedAfterAll: asked.length },
			{ delivered: 'stopped', deliveredCount: 1, wrongToken: 'not-ours', missing: 'unreachable', askedAfterAll: 1 },
		);
	});
});
