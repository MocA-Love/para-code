/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { paradisDeletePtyDaemonEnv, paradisWithoutPtyDaemonEnv } from '../../common/paradisPtyEnvHygiene.js';

suite('ParadisPtyEnvHygiene', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	test('常駐の内部用の変数だけをシェルの環境から落とし、ペイントークンなどは残す', () => {
		const env = {
			PATH: '/usr/bin',
			PARADIS_PTY_HOST_STATE_DIR: '/Users/example/Library/Application Support/Para Code',
			PARADIS_PTY_DAEMON_SOCKET: '/tmp/s.sock',
			PARADIS_PTY_DAEMON_LEDGER: '/tmp/ledger.json',
			PARADIS_PTY_DAEMON_BUILD_ID: 'id',
			PARADIS_PTY_DAEMON_BUILD_KEY: 'key',
			PARA_CODE_TERMINAL_PANE_ID: 'pane-token',
			PARA_CODE_MCP_PORT_FILE: '/tmp/port.json',
		};
		const result = paradisWithoutPtyDaemonEnv(env);
		assert.deepStrictEqual({ result, originalKept: Object.keys(env).length }, {
			result: {
				PATH: '/usr/bin',
				PARA_CODE_TERMINAL_PANE_ID: 'pane-token',
				PARA_CODE_MCP_PORT_FILE: '/tmp/port.json',
			},
			// 受け取ったものは書き換えない（永続ターミナルの起動情報として持ち続けられるため）
			originalKept: 8,
		});
	});

	test('内部用の変数が無ければ写しを作らずそのまま返す', () => {
		const env = { PATH: '/usr/bin' };
		assert.strictEqual(paradisWithoutPtyDaemonEnv(env), env);
	});

	test('main が受け継いだ内部用の変数はその場で消し、消した名前を返す', () => {
		const env: { [key: string]: string | undefined } = {
			PATH: '/usr/bin',
			PARADIS_PTY_HOST_STATE_DIR: '/Users/example/Library/Application Support/Para Code',
			PARADIS_PTY_DAEMON_SOCKET: '/tmp/s.sock',
			PARA_CODE_TERMINAL_PANE_ID: 'pane-token',
		};
		const removed = paradisDeletePtyDaemonEnv(env);
		const removedAgain = paradisDeletePtyDaemonEnv(env);
		assert.deepStrictEqual({ removed, removedAgain, env }, {
			removed: ['PARADIS_PTY_HOST_STATE_DIR', 'PARADIS_PTY_DAEMON_SOCKET'],
			removedAgain: [],
			env: { PATH: '/usr/bin', PARA_CODE_TERMINAL_PANE_ID: 'pane-token' },
		});
	});
});
