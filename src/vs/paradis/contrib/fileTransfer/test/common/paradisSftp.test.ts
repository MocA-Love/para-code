/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-PATCH/PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import {
	paradisDirectTargetFor,
	paradisIsSafeSftpEntryName,
	paradisSftpFailureMessage,
	paradisSftpFailureReasonOf,
	paradisSftpIdleMs,
	paradisSftpUri,
	paradisSshConfigFromFile,
	paradisSshConfigFromSshG,
	paradisSshIncludePatterns,
	PARADIS_DEFAULT_GLOBAL_KNOWN_HOSTS,
	PARADIS_DEFAULT_IDENTITY_FILES,
	PARADIS_DEFAULT_USER_KNOWN_HOSTS,
} from '../../common/paradisSftp.js';

suite('Paradis file transfer - direct SSH (common)', () => {

	ensureNoDisposablesAreLeakedInTestSuite();

	test('ssh -G の出力から、鍵ファイル・IdentitiesOnly・ProxyCommand・HostKeyAlias を読む', () => {
		const stdout = [
			'host para-server',
			'user deploy',
			'hostname 203.0.113.10',
			'port 2222',
			'identityfile ~/.ssh/para_ed25519',
			'identityfile ~/.ssh/id_rsa',
			'identitiesonly yes',
			'identityagent none',
			'proxycommand none',
			'proxyjump none',
			'hostkeyalias para-alias',
			'stricthostkeychecking ask',
		].join('\n');
		const config = paradisSshConfigFromSshG('para-server', stdout, { userKnownHostsFiles: ['~/.ssh/known_hosts'], globalKnownHostsFiles: [] });
		assert.deepStrictEqual(config, {
			alias: 'para-server',
			hostname: '203.0.113.10',
			port: 2222,
			user: 'deploy',
			identityFiles: ['~/.ssh/para_ed25519', '~/.ssh/id_rsa'],
			identitiesOnly: true,
			identityAgent: 'none',
			proxyCommand: undefined,
			proxyJump: undefined,
			hostKeyAlias: 'para-alias',
			userKnownHostsFiles: ['~/.ssh/known_hosts'],
			globalKnownHostsFiles: [],
		});
	});

	test('ssh -G の出力に ProxyJump があれば拾う（段階 1 では断る印）', () => {
		const config = paradisSshConfigFromSshG('inner', 'hostname 10.0.0.5\nport 22\nuser me\nproxyjump bastion\nproxycommand ssh -W %h:%p gw\n');
		assert.deepStrictEqual({ proxyJump: config.proxyJump, proxyCommand: config.proxyCommand, identitiesOnly: config.identitiesOnly }, { proxyJump: 'bastion', proxyCommand: 'ssh -W %h:%p gw', identitiesOnly: false });
	});

	test('~/.ssh/config を自前で読むとき、最初に出てきた値が勝ち、IdentityFile は積み上がる', () => {
		const lines = [
			'# comment',
			'Host para-server',
			'  HostName 198.51.100.7',
			'  User admin',
			'  IdentityFile ~/.ssh/para_key',
			'  IdentitiesOnly yes',
			'Match host other',
			'  User wrong',
			'Host *.internal !para-server',
			'  User nobody',
			'Host *',
			'  User fallback',
			'  Port 2200',
			'  IdentityFile ~/.ssh/common_key',
			'  HostKeyAlias none',
		];
		assert.deepStrictEqual(paradisSshConfigFromFile('para-server', lines, 'local'), {
			alias: 'para-server',
			hostname: '198.51.100.7',
			port: 2200,
			user: 'admin',
			identityFiles: ['~/.ssh/para_key', '~/.ssh/common_key'],
			identitiesOnly: true,
			identityAgent: undefined,
			proxyCommand: undefined,
			proxyJump: undefined,
			hostKeyAlias: undefined,
			userKnownHostsFiles: PARADIS_DEFAULT_USER_KNOWN_HOSTS,
			globalKnownHostsFiles: PARADIS_DEFAULT_GLOBAL_KNOWN_HOSTS,
		});
	});

	test('~/.ssh/config に無い別名は既定値（名前そのもの・22・手元のユーザー・既定の鍵）', () => {
		const config = paradisSshConfigFromFile('plain', ['Host other', '  User x', 'Host !plain *', '  ProxyJump gw'], 'local');
		assert.deepStrictEqual({ hostname: config.hostname, port: config.port, user: config.user, identityFiles: config.identityFiles, proxyJump: config.proxyJump }, { hostname: 'plain', port: 22, user: 'local', identityFiles: PARADIS_DEFAULT_IDENTITY_FILES, proxyJump: undefined });
	});

	test('Include の行を見分ける', () => {
		assert.deepStrictEqual([
			paradisSshIncludePatterns('Include ~/.ssh/config.d/* "other file"'),
			paradisSshIncludePatterns('  include=conf.d/a'),
			paradisSshIncludePatterns('Host include'),
		], [['~/.ssh/config.d/*', 'other file'], ['conf.d/a'], undefined]);
	});

	test('このウィンドウの接続先なら今の接続を使い、それ以外は SSH を直接張る', () => {
		assert.deepStrictEqual([
			paradisDirectTargetFor('dev', 'ssh-remote+dev'),
			paradisDirectTargetFor('dev', 'ssh-remote+staging'),
			paradisDirectTargetFor('dev', undefined),
			paradisDirectTargetFor(' dev ', 'ssh-remote+dev'),
			paradisDirectTargetFor('dev', 'wsl+dev'),
		], ['window', 'sftp', 'sftp', 'window', 'sftp']);
	});

	test('失敗の理由はメッセージに名前だけを入れて運び、読み戻せる', () => {
		assert.deepStrictEqual([
			paradisSftpFailureReasonOf(new Error(paradisSftpFailureMessage('hostKeyUnknown'))),
			paradisSftpFailureReasonOf(new Error(`wrapped: ${paradisSftpFailureMessage('authUnsupported')}`)),
			paradisSftpFailureReasonOf(new Error('paradis-sftp:unheard')),
			paradisSftpFailureReasonOf(new Error('ENOENT')),
		], ['hostKeyUnknown', 'authUnsupported', 'other', undefined]);
	});

	test('保持時間の設定は 30〜3600 秒に収める', () => {
		assert.deepStrictEqual([paradisSftpIdleMs(undefined), paradisSftpIdleMs(5), paradisSftpIdleMs(120), paradisSftpIdleMs(99999)], [300_000, 30_000, 120_000, 3_600_000]);
	});

	test('接続先が返した名前のうち、送り先の外を指しうるものは受け付けない', () => {
		assert.deepStrictEqual(['a.txt', '.env', '..', '.', '', '../../.zshrc', 'a/b', 'a\\b', 'a\0b', '..hidden'].map(paradisIsSafeSftpEntryName),
			[true, true, false, false, false, false, false, false, false, true]);
	});

	test('URI は別名を authority、接続先の絶対パスを path にする', () => {
		assert.strictEqual(paradisSftpUri('para-server', '/home/me').toString(), 'paradis-sftp://para-server/home/me');
	});
});
