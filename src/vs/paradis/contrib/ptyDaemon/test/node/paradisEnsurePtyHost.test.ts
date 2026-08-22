/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

// 常駐へ渡す環境の作り方。
//
// **ここを間違えると、常駐から起きるシェルの足元が変わる。** しかも症状は「なぜかこのコマンドだけ
// 動かない」という、ターミナルの仕組みからは遠い形で出る。

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { paradisPtyHostDaemonEnv } from '../../node/paradisEnsurePtyHost.js';

suite('ParadisEnsurePtyHost', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	test('node として起こす。付け忘れるとアプリとして起動しようとする', () => {
		const env = paradisPtyHostDaemonEnv({}, { VSCODE_ESM_ENTRYPOINT: 'somewhere' });

		assert.deepStrictEqual(
			{ runAsNode: env['ELECTRON_RUN_AS_NODE'], entry: env['VSCODE_ESM_ENTRYPOINT'] },
			// ローカルの実行ファイルは Para Code 本体なので、無いと2つ目のアプリが起きようとする。
			{ runAsNode: '1', entry: 'somewhere' },
		);
	});

	test('親の生死を見て自分を殺す仕掛けは外す。外さないと常駐にならない', () => {
		const env = paradisPtyHostDaemonEnv({ VSCODE_PARENT_PID: '123', VSCODE_PIPE_LOGGING: 'true' }, {});

		assert.deepStrictEqual(
			{ parent: env['VSCODE_PARENT_PID'], logging: env['VSCODE_PIPE_LOGGING'] },
			{ parent: undefined, logging: undefined },
		);
	});

	test('Snap が差し替えた変数は元へ戻す。常駐の先のシェルまで持ち込まない', () => {
		const env = paradisPtyHostDaemonEnv({
			LD_LIBRARY_PATH: '/snap/para-code/current/lib',
			LD_LIBRARY_PATH_VSCODE_SNAP_ORIG: '/usr/lib',
			GTK_PATH: '/snap/para-code/current/gtk',
			GTK_PATH_VSCODE_SNAP_ORIG: '',
		}, {});

		assert.deepStrictEqual(
			{ lib: env['LD_LIBRARY_PATH'], gtk: env['GTK_PATH'], leftovers: Object.keys(env).filter(key => key.endsWith('_VSCODE_SNAP_ORIG')) },
			{
				// 退避してあった元の値へ戻す。
				lib: '/usr/lib',
				// 退避が空なら、Snap に入る前はその変数自体が無かったということ。
				gtk: undefined,
				leftovers: [],
			},
		);
	});
});
