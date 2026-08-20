/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { paradisResolveMobileWindowHost } from '../../common/paradisMobileHost.js';

/**
 * モバイルの「接続先セグメント」向けに、ウィンドウの remoteAuthority からホスト識別子を決める。
 */
suite('ParadisMobileHost', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	test('remoteAuthority未指定はlocalを返す', () => {
		assert.deepStrictEqual(paradisResolveMobileWindowHost(undefined, undefined), { kind: 'local', id: 'local' });
	});

	test('remoteAuthorityはidとして小文字化する（同一ホストの束ね用の安定キー）', () => {
		const host = paradisResolveMobileWindowHost('SSH-Remote+MyServer', 'MyServer');
		assert.strictEqual(host.kind, 'remote');
		assert.strictEqual(host.id, 'ssh-remote+myserver');
	});

	test('hostLabelが渡されればそのまま使う（フォーマッタ登録済み）', () => {
		const host = paradisResolveMobileWindowHost('ssh-remote+myserver', 'myserver.example.com');
		assert.strictEqual(host.label, 'myserver.example.com');
	});

	test('hostLabel未指定時は authority の接頭辞（xxx-remote+）を落として使う（フォーマッタ未到着時のフォールバック）', () => {
		const host = paradisResolveMobileWindowHost('ssh-remote+myserver', undefined);
		assert.strictEqual(host.label, 'myserver');
	});

	test('接頭辞が無いauthorityはそのままlabelにする', () => {
		const host = paradisResolveMobileWindowHost('wsl-ubuntu', undefined);
		assert.strictEqual(host.label, 'wsl-ubuntu');
	});
});
