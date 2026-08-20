/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { IParadisPtyDaemonPathInput, paradisPtyDaemonPaths } from '../../common/paradisPtyDaemonPaths.js';

const MAC: IParadisPtyDaemonPathInput = {
	userDataPath: '/Users/example/Library/Application Support/Para Code',
	buildId: '1.132.0-paracode-72',
	platform: 'darwin',
};

suite('ParadisPtyDaemonPaths', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	test('lands on the same place for the same input, and a different one per build and per profile', () => {
		const base = paradisPtyDaemonPaths(MAC);
		const again = paradisPtyDaemonPaths({ ...MAC });
		const nextBuild = paradisPtyDaemonPaths({ ...MAC, buildId: '1.132.0-paracode-73' });
		const otherProfile = paradisPtyDaemonPaths({ ...MAC, userDataPath: '/Users/example/.paracode-alt' });

		assert.deepStrictEqual(
			{
				stable: again.socketPath === base.socketPath,
				// 新旧のビルドが同じソケットへ辿り着かないこと。これが崩れると、更新後のアプリが
				// 更新前の常駐へ繋いで、合わない形の状態を読むことになる。
				separatedByBuild: nextBuild.socketPath !== base.socketPath && nextBuild.ledgerFile !== base.ledgerFile,
				separatedByProfile: otherProfile.socketPath !== base.socketPath,
				// 台帳はビルドを問わず1箇所に集める (ここを読めば全部の常駐が分かる)。
				sharedLedgerDir: nextBuild.ledgerDir === base.ledgerDir,
				withinLimit: base.socketPathTooLong === false,
			},
			{ stable: true, separatedByBuild: true, separatedByProfile: true, sharedLedgerDir: true, withinLimit: true },
		);
	});

	test('uses a named pipe on Windows and XDG_RUNTIME_DIR only where it exists', () => {
		const win = paradisPtyDaemonPaths({ ...MAC, platform: 'win32', userDataPath: 'C:\\Users\\example\\AppData\\Roaming\\Para Code' });
		const linux = paradisPtyDaemonPaths({ ...MAC, platform: 'linux', userDataPath: '/home/example/.config/Para Code', xdgRuntimeDir: '/run/user/1000' });
		const linuxNoXdg = paradisPtyDaemonPaths({ ...MAC, platform: 'linux', userDataPath: '/home/example/.config/Para Code' });
		// macOS には XDG_RUNTIME_DIR に相当するものが無いので、渡されても使わない。
		const macWithXdg = paradisPtyDaemonPaths({ ...MAC, xdgRuntimeDir: '/run/user/1000' });

		assert.deepStrictEqual(
			{
				win: win.socketPath.startsWith('\\\\.\\pipe\\paracode-') && win.socketPath.endsWith('-ptyd'),
				winLedger: win.ledgerFile.startsWith('C:\\Users\\example\\AppData\\Roaming\\Para Code\\ptyDaemon\\'),
				linux: linux.socketPath.startsWith('/run/user/1000/paracode-'),
				linuxNoXdg: linuxNoXdg.socketPath.startsWith('/home/example/.config/Para Code/paracode-'),
				macIgnoresXdg: macWithXdg.socketPath === paradisPtyDaemonPaths(MAC).socketPath,
			},
			{ win: true, winLedger: true, linux: true, linuxNoXdg: true, macIgnoresXdg: true },
		);
	});

	test('reports a socket path that the platform cannot bind', () => {
		// 長い --user-data-dir を渡されると sun_path の上限を超える。超えたまま bind すると
		// Node.js 24 以降は EINVAL で落ちるが、症状は「常駐が立ち上がらない」だけなので、
		// 呼び出し側が今までどおりの動作へ落とせるよう、ここで分かる形にしておく。
		const deep = paradisPtyDaemonPaths({ ...MAC, userDataPath: '/Users/example/' + 'a'.repeat(90) });
		assert.deepStrictEqual(
			{ tooLong: deep.socketPathTooLong, normal: paradisPtyDaemonPaths(MAC).socketPathTooLong },
			{ tooLong: true, normal: false },
		);
	});
});
