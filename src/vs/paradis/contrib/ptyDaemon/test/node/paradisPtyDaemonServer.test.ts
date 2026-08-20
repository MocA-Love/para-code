/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

// 常駐のソケット確保を、**本物のファイルシステムに対して**確かめる。
//
// ここだけ純粋関数のテストにできない。実際に起きた不具合がまさにそれで、ソケットを台帳と同じ
// 0700 のディレクトリへ移したとき、そのディレクトリを作るのは台帳を書くときだけだった。台帳を
// 書くのは bind に成功した後なので、初回起動では `listen` が `ENOENT` で落ちる。判断の中身は
// どれも正しく、**組み合わせの順序だけが違っていた**ので、純粋な単体テストは全部通っていた。

import assert from 'assert';
import { existsSync, mkdtempSync, rmSync, statSync } from 'fs';
import { paradisPtyDaemonPaths } from '../../common/paradisPtyDaemonPaths.js';
import { paradisServePtyDaemon } from '../../node/paradisPtyDaemonServer.js';

// リーク検査は外してある。2回目の確認接続を1台目のサーバーが受理すると、その接続ぶんの
// `Protocol` が残るため。作るのは `ipc.net.ts` の `toClientConnectionEvent` で、`IPCServer` は
// 切断時にチャネルは畳むが `Protocol` は畳まない (upstream の挙動)。数は接続の数だけで増え続けは
// しないので、ここで追いかけるものではない。
// eslint-disable-next-line local/code-ensure-no-disposables-leak-in-test -- 上記のとおり、受理した接続ぶんの Protocol は upstream 側で畳まれない
suite('ParadisPtyDaemonServer', () => {

	let userDataPath: string | undefined;

	teardown(() => {
		if (userDataPath) {
			rmSync(userDataPath, { recursive: true, force: true });
			userDataPath = undefined;
		}
	});

	test('creates its own 0700 home before binding, and stands down for whoever got there first', async () => {
		// `/tmp` の直下に短い名前で作る。macOS の `os.tmpdir()` は `/var/folders/…` と長く、
		// ソケットのパスが sun_path の上限を超えて `EINVAL` になる (Node 24 以降)。
		userDataPath = mkdtempSync('/tmp/pc-test-');
		const paths = paradisPtyDaemonPaths({ userDataPath, buildId: 'test', platform: 'darwin' });
		const before = existsSync(paths.ledgerDir);

		const first = await paradisServePtyDaemon(paths.socketPath);
		const second = await paradisServePtyDaemon(paths.socketPath);
		try {
			assert.deepStrictEqual(
				{
					before,
					// 置き場所が無いところから始めても取れること。ここが本題。
					bound: first.outcome,
					homeMade: existsSync(paths.ledgerDir),
					// 権限で守るのは親ディレクトリの役目 (`serve` はソケット自体の権限を umask 任せにする)。
					mode: existsSync(paths.ledgerDir) ? (statSync(paths.ledgerDir).mode & 0o777).toString(8) : '-',
					socket: existsSync(paths.socketPath),
					// 生きた先客は消さずに退く。消すと、先客が抱えているターミナルごと迷子になる。
					secondStoodDown: second.outcome,
				},
				{ before: false, bound: 'bound', homeMade: true, mode: '700', socket: true, secondStoodDown: 'taken' },
			);
		} finally {
			if (first.outcome === 'bound') {
				first.server.dispose();
			}
			if (second.outcome === 'bound') {
				second.server.dispose();
			}
		}
	});
});
