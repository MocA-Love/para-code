/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

// 常駐に「いま何を抱えているか」を聞けることを、本物のソケット相手に確かめる。
//
// 実機で状態パネルが最初の一瞬の値のまま何時間も凍った。原因は、話し相手 (`ProxyChannel` の
// `Proxy`) を `async` 関数の戻り値にしていたこと。`Proxy` は `then` にも関数を返すので
// `Promise` が thenable と見なして `then(resolve, reject)` を呼び、関数2つを引数に持つ呼び出しが
// 常駐へ送られて直列化が落ちる。**`resolve` も `reject` も呼ばれない**ので待ちは永久に解けず、
// 例外は待っている側の try/catch に入らない。だから「静かに凍る」形になった。
//
// ここで見張るのは2つ。聞けること (聞けなければ本数が出ない) と、返ってくる入れ物が
// thenable でないこと (thenable に戻した瞬間、また同じ凍り方をする)。

import assert from 'assert';
import { mkdtempSync, rmSync } from 'fs';
import { raceTimeout } from '../../../../../base/common/async.js';
import { DisposableStore } from '../../../../../base/common/lifecycle.js';
import { join } from '../../../../../base/common/path.js';
import { ProxyChannel } from '../../../../../base/parts/ipc/common/ipc.js';
import { serve } from '../../../../../base/parts/ipc/node/ipc.net.js';
import { PARADIS_PTY_DAEMON_AUTH_CHANNEL, PARADIS_PTY_DAEMON_CONTROL_CHANNEL } from '../../common/paradisPtyDaemonControl.js';
import { ParadisPtyDaemonAuth, paradisCreateDaemonToken } from '../../node/paradisPtyDaemonAuth.js';
import { paradisOpenDaemonControl } from '../../node/paradisPtyDaemonControlClient.js';

/** 待ち続けたら失敗させる。凍る不具合を「遅い」で見逃さないため、テスト側の上限より短くする。 */
const ANSWER_TIMEOUT = 5_000;

// 受理した接続ぶんの `Protocol` は `IPCServer` が畳まないので、リーク検査は外してある
// (`paradisPtyDaemonStop.test.ts` と同じ理由)。
// eslint-disable-next-line local/code-ensure-no-disposables-leak-in-test
suite('ParadisPtyDaemonControlClient', () => {

	let dir: string | undefined;
	const store = new DisposableStore();

	teardown(() => {
		store.clear();
		if (dir) {
			rmSync(dir, { recursive: true, force: true });
			dir = undefined;
		}
	});

	test('asks the daemon what it holds, and hands back something that is not a thenable', async () => {
		// macOS の `os.tmpdir()` は長く、ソケットのパスが sun_path の上限を超える。
		dir = mkdtempSync('/tmp/pc-ctl-');
		const socketPath = join(dir, 's.sock');
		const token = paradisCreateDaemonToken();

		const server = await serve(socketPath);
		store.add(server);
		server.registerChannel(PARADIS_PTY_DAEMON_AUTH_CHANNEL, ProxyChannel.fromService(new ParadisPtyDaemonAuth(token), store));
		server.registerChannel(PARADIS_PTY_DAEMON_CONTROL_CHANNEL, ProxyChannel.fromService({
			async describe() {
				return {
					pid: 4321,
					buildId: 'test-build',
					startedAt: 1,
					terminals: [{ workspaceName: 'one' }, { workspaceName: 'two' }],
				};
			},
			async shutdown() { throw new Error('not used here'); },
		}, store));

		const opened = await paradisOpenDaemonControl(socketPath, token);

		// **これが本題。** `then` を読んで関数が返る値は、`await` した時点でその呼び出しが
		// 常駐へ送られ、返事は永久に来ない。
		//
		// 読み取りで確かめるのは、`Proxy` に対しては `in` も `Object.hasOwn` も **false を返す**
		// から。危ないのは所有していることではなく、聞かれたら関数を返すこと。`Promise` も
		// まさにこの読み取りで thenable かどうかを決める。
		const thenable = typeof (opened as { then?: unknown }).then === 'function';
		const described = opened.ok ? await raceTimeout(opened.control.describe(), ANSWER_TIMEOUT) : undefined;
		if (opened.ok) {
			opened.client.dispose();
		}

		// 身元を名乗れない相手には口を開かない。繋がることは身元の証明にならない。
		const wrongToken = await paradisOpenDaemonControl(socketPath, paradisCreateDaemonToken());

		// 誰も待ち受けていない名前。
		const missing = await paradisOpenDaemonControl(join(dir, 'nobody.sock'), token);

		assert.deepStrictEqual(
			{
				opened: opened.ok,
				thenable,
				terminals: described?.terminals.map(terminal => terminal.workspaceName),
				wrongToken: wrongToken.ok ? 'opened' : wrongToken.reason,
				missing: missing.ok ? 'opened' : missing.reason,
			},
			{
				opened: true,
				thenable: false,
				terminals: ['one', 'two'],
				wrongToken: 'not-ours',
				missing: 'unreachable',
			},
		);
	});
});
