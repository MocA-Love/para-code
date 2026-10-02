/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import * as sinon from 'sinon';
import { paradisResolveMobileWindowHost } from '../../common/paradisMobileHost.js';
import { PARADIS_MOBILE_USAGE_DEADLINE_MS, paradisMobileUsageErrorReply, paradisMobileUsageNoResponseMessage, paradisWithHostDeadline } from '../../common/paradisMobileHostDeadline.js';

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

	// 接続先の機械の印は sha256 の hex だけを受け取る（接続先の応答は信用しない）。
	test('接続先の機械の印は sha256 の hex のときだけ載せる', () => {
		const hash = 'ab'.repeat(32);
		assert.deepStrictEqual({
			valid: paradisResolveMobileWindowHost('ssh-remote+devbox', 'devbox', hash),
			upper: paradisResolveMobileWindowHost('ssh-remote+devbox', 'devbox', hash.toUpperCase()),
			short: paradisResolveMobileWindowHost('ssh-remote+devbox', 'devbox', 'abc'),
			local: paradisResolveMobileWindowHost(undefined, undefined, hash),
		}, {
			valid: { kind: 'remote', id: 'ssh-remote+devbox', label: 'devbox', machineIdHash: hash },
			upper: { kind: 'remote', id: 'ssh-remote+devbox', label: 'devbox' },
			short: { kind: 'remote', id: 'ssh-remote+devbox', label: 'devbox' },
			local: { kind: 'local', id: 'local' },
		});
	});

	// 使用量の問い合わせを 50 秒で打ち切ったときは code: 'no-response' を付ける。それ以外の失敗は文をそのまま返す。
	test('使用量の打ち切りは no-response として返す', async () => {
		const clock = sinon.useFakeTimers();
		try {
			const pending = paradisWithHostDeadline(new Promise<never>(() => { }), PARADIS_MOBILE_USAGE_DEADLINE_MS).catch(error => error);
			await clock.tickAsync(PARADIS_MOBILE_USAGE_DEADLINE_MS);
			assert.deepStrictEqual({
				timedOut: paradisMobileUsageErrorReply(await pending),
				failed: paradisMobileUsageErrorReply(new Error('boom')),
			}, {
				timedOut: { error: paradisMobileUsageNoResponseMessage(), code: 'no-response' },
				failed: { error: 'Error: boom' },
			});
		} finally {
			clock.restore();
		}
	});
});
