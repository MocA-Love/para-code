/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import * as assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import {
	ParadisSentryRateLimiter,
	paradisClassifySentryEvent,
	paradisSanitizeSentryEvent,
	paradisSanitizeSentryText,
	paradisSentryFingerprint,
} from '../../common/paradisSentryCommon.js';
import { paradisRedactSecrets } from '../../../../common/paradisSecretRedaction.js';

suite('ParadisSentryCommon', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	test('redacts credentials, environment values, user paths, and URL parameters', () => {
		const input = [
			'Authorization: Bearer secret-token',
			'OPENAI_API_KEY=sk-sensitive',
			'/Users/alice/projects/private/file.ts',
			'C:\\Users\\Alice\\workspace\\private\\file.ts',
			'https://example.test/path?token=secret#fragment',
		].join('\n');

		const sanitized = paradisSanitizeSentryText(input);

		assert.ok(!sanitized.includes('secret-token'));
		assert.ok(!sanitized.includes('sk-sensitive'));
		assert.ok(!sanitized.includes('alice'));
		assert.ok(!sanitized.includes('Alice'));
		assert.ok(!sanitized.includes('?token='));
		assert.ok(!sanitized.includes('#fragment'));
		assert.ok(sanitized.includes('Authorization: [Filtered] [Filtered]'));
		assert.ok(sanitized.includes('OPENAI_API_KEY=[Filtered]'));
		assert.ok(sanitized.includes('~/projects/private/file.ts'));
	});

	test('redacts identity and secret shapes in every form they arrive in, and keeps what an investigation needs', () => {
		const rows = [
			// Windows のパス: 二重の区切り（JSON の中）と `/` の区切り
			'open C:\\\\Users\\\\Alice\\\\repo\\\\a.ts',
			'open C:/Users/Alice/repo/a.ts',
			// WSL のパス（UNC）: 一重・二重の区切りと、`/` に直したもの
			'open \\\\wsl.localhost\\Ubuntu\\home\\alice\\repo\\a.ts',
			'open \\\\\\\\wsl$\\\\Ubuntu\\\\home\\\\alice\\\\x.ts',
			'open //wsl.localhost/Ubuntu/home/alice/repo/a.ts',
			'open /mnt/c/Users/alice/a.ts',
			// `=` の無いトークン・Basic 認証
			'push failed: ghp_abcdefghijklmnopqrstuvwxyz0123456789',
			'key sk-ant-api03-abcdefghijklmnopqrstuv rejected',
			'Authorization: Basic dXNlcjpwYXNzd29yZA==',
			// メールアドレスと SSH の宛先
			'mail alice.smith@mail.example.test failed',
			'fetch git@github.com:org/repo.git failed',
			// ホームの外のパス（ファイル名と `out/vs/...` から先は残す）
			`ENOENT: no such file or directory, open '/Volumes/SSD/clients/acme/report.xlsx'`,
			'at x (/Volumes/SSD/para-code/out/vs/paradis/contrib/a.js:12:3)',
			`EACCES: permission denied, open '/Volumes/My Passport/clients/acme/report.xlsx'`,
			`ENOENT: no such file or directory, scandir "D:\\My Folder\\acme\\docs"`,
			'D:\\work\\acme\\src\\x.ts:4:2',
			'file:///D:/work/acme/a.ts',
			// SSH の接続先
			'vscode-remote://ssh-remote+prod-db.internal/home/alice/x.ts',
			'vscode-remote://ssh-remote%2Bprod-db.internal/srv/app',
			// 残すもの
			`ENOENT: no such file or directory, open '/home/alice/x/package.json'`,
			'SyntaxError: Unexpected token } in JSON at position 4',
			'file-viewers',
			'at paradisWorktreeGitChannel.ts:1269:7',
			'app:///out/vs/paradis/contrib/sentry/common/paradisSentryCommon.js:12:3',
			'C:\\Program Files\\Para Code\\resources\\app\\out\\main.js',
			'node:internal/fs/promises:12',
			'typescript@5.4.2 @sentry/core@8.1.0',
			'https://github.com/org/repo/pull/1?token=x#fragment',
			// コンテナの接続先（hex を戻すとホームのパスが読める）
			'vscode-remote://dev-container+7b22686f737450617468223a222f55736572732f616c696365227d/workspaces/app',
			'vscode-remote://attached-container+7b22636f6e7461696e65724e616d65223a22617070227d/app',
			// キー名に token / basic を含むだけの語と、秘密ではない値は残す
			'cancellationToken: undefined',
			'tokenizer: textmate',
			'SyntaxError: Unexpected token: }',
			'Basic authentication failed',
			'Bearer authentication is required',
		];

		assert.deepStrictEqual(rows.map(row => [row, paradisSanitizeSentryText(row)]), [
			['open C:\\\\Users\\\\Alice\\\\repo\\\\a.ts', 'open ~\\\\repo\\\\a.ts'],
			['open C:/Users/Alice/repo/a.ts', 'open ~/repo/a.ts'],
			['open \\\\wsl.localhost\\Ubuntu\\home\\alice\\repo\\a.ts', 'open ~\\repo\\a.ts'],
			['open \\\\\\\\wsl$\\\\Ubuntu\\\\home\\\\alice\\\\x.ts', 'open ~\\\\x.ts'],
			['open //wsl.localhost/Ubuntu/home/alice/repo/a.ts', 'open ~/repo/a.ts'],
			['open /mnt/c/Users/alice/a.ts', 'open [path]/a.ts'],
			['push failed: ghp_abcdefghijklmnopqrstuvwxyz0123456789', 'push failed: [Filtered]'],
			['key sk-ant-api03-abcdefghijklmnopqrstuv rejected', 'key [Filtered] rejected'],
			['Authorization: Basic dXNlcjpwYXNzd29yZA==', 'Authorization: [Filtered] [Filtered]'],
			['mail alice.smith@mail.example.test failed', 'mail [email] failed'],
			['fetch git@github.com:org/repo.git failed', 'fetch [email]:org/repo.git failed'],
			[`ENOENT: no such file or directory, open '/Volumes/SSD/clients/acme/report.xlsx'`, `ENOENT: no such file or directory, open '[path]/report.xlsx'`],
			['at x (/Volumes/SSD/para-code/out/vs/paradis/contrib/a.js:12:3)', 'at x ([path]/out/vs/paradis/contrib/a.js:12:3)'],
			[`EACCES: permission denied, open '/Volumes/My Passport/clients/acme/report.xlsx'`, `EACCES: permission denied, open '[path]/report.xlsx'`],
			[`ENOENT: no such file or directory, scandir "D:\\My Folder\\acme\\docs"`, `ENOENT: no such file or directory, scandir "[path]/docs"`],
			['D:\\work\\acme\\src\\x.ts:4:2', '[path]/x.ts:4:2'],
			['file:///D:/work/acme/a.ts', 'file:///[path]/a.ts'],
			['vscode-remote://ssh-remote+prod-db.internal/home/alice/x.ts', 'vscode-remote://ssh-remote+[host]~/x.ts'],
			['vscode-remote://ssh-remote%2Bprod-db.internal/srv/app', 'vscode-remote://ssh-remote%2B[host]/srv/app'],
			[`ENOENT: no such file or directory, open '/home/alice/x/package.json'`, `ENOENT: no such file or directory, open '~/x/package.json'`],
			['SyntaxError: Unexpected token } in JSON at position 4', 'SyntaxError: Unexpected token } in JSON at position 4'],
			['file-viewers', 'file-viewers'],
			['at paradisWorktreeGitChannel.ts:1269:7', 'at paradisWorktreeGitChannel.ts:1269:7'],
			['app:///out/vs/paradis/contrib/sentry/common/paradisSentryCommon.js:12:3', 'app:///out/vs/paradis/contrib/sentry/common/paradisSentryCommon.js:12:3'],
			['C:\\Program Files\\Para Code\\resources\\app\\out\\main.js', 'C:\\Program Files\\Para Code\\resources\\app\\out\\main.js'],
			['node:internal/fs/promises:12', 'node:internal/fs/promises:12'],
			['typescript@5.4.2 @sentry/core@8.1.0', 'typescript@5.4.2 @sentry/core@8.1.0'],
			['https://github.com/org/repo/pull/1?token=x#fragment', 'https://github.com/org/repo/pull/1'],
			['vscode-remote://dev-container+7b22686f737450617468223a222f55736572732f616c696365227d/workspaces/app', 'vscode-remote://dev-container+[host]/workspaces/app'],
			['vscode-remote://attached-container+7b22636f6e7461696e65724e616d65223a22617070227d/app', 'vscode-remote://attached-container+[host]/app'],
			['cancellationToken: undefined', 'cancellationToken: undefined'],
			['tokenizer: textmate', 'tokenizer: textmate'],
			['SyntaxError: Unexpected token: }', 'SyntaxError: Unexpected token: }'],
			['Basic authentication failed', 'Basic authentication failed'],
			['Bearer authentication is required', 'Bearer authentication is required'],
		]);
	});

	test('cuts long text before redacting it and keeps the time proportional to the length', () => {
		// `.` や `-` が細かく続く空白の無い文は、繰り返しに上限の無い規則だと読み始めの位置ごとに末尾まで読み直す
		const texts = ['a.', 'a-', 'a.b-', 'x.token', 'mysql ', 'sk-', 'a.b@c', 'a://'].map(unit => unit.repeat(Math.ceil(100_000 / unit.length)).slice(0, 100_000));
		const started = Date.now();
		const sanitized = texts.map(text => paradisSanitizeSentryText(text));
		texts.forEach(text => paradisRedactSecrets(text));
		const elapsed = Date.now() - started;
		// 2,000 字の境目にかかった値も、切る前の形で伏せる
		const cut = [`${'x'.repeat(1_990)} ghp_abcdefghijklmnopqrstuvwxyz0123456789`, `${'x'.repeat(1_995)} alice@example.test`].map(text => paradisSanitizeSentryText(text));
		const credential = 'c'.repeat(300);

		assert.deepStrictEqual({
			fast: elapsed < 2_000,
			bounded: sanitized.every(text => text.length <= 2_001),
			cut,
			longCredential: [paradisSanitizeSentryText(`git://user:${credential}@example.com/repo`), paradisRedactSecrets(`git://user:${credential}@example.com/repo`)],
		}, {
			fast: true,
			bounded: true,
			cut: [`${'x'.repeat(1_990)} [Filtered`.slice(0, 2_000) + '…', `${'x'.repeat(1_995)} [ema…`],
			longCredential: ['git://[Filtered]@example.com/repo', 'git://***@example.com/repo'],
		});
	});

	test('applies the same rules to tags, breadcrumbs and automatically captured error text', () => {
		const event = paradisSanitizeSentryEvent({
			tags: { 'para.feature': 'file-viewers', unsafe: 'mail alice@example.test' },
			breadcrumbs: [{ category: 'para.workspace', message: 'open \\\\wsl.localhost\\Ubuntu\\home\\alice\\repo' }],
			exception: { values: [{ type: 'Error', value: 'clone ghp_abcdefghijklmnopqrstuvwxyz0123456789 from ssh-remote+prod-db failed' }] },
		});

		assert.deepStrictEqual([event.tags, event.breadcrumbs?.map(breadcrumb => breadcrumb.message), event.exception?.values?.[0].value], [
			{ 'para.feature': 'file-viewers', unsafe: 'mail [email]' },
			['open ~\\repo'],
			'clone [Filtered] from ssh-remote+[host] failed',
		]);
	});

	test('redacts the host and path of files opened directly over SSH', () => {
		assert.strictEqual(
			paradisSanitizeSentryText(`Unable to read file 'paradis-sftp://prod-db/var/lib/app.db' (Unavailable)`),
			`Unable to read file 'paradis-sftp://[Filtered]' (Unavailable)`,
		);
	});

	test('keeps diagnostic tags and stack shape while removing private event payloads', () => {
		const event = paradisSanitizeSentryEvent({
			message: 'failed at /home/alice/work/private.ts with token=secret',
			logentry: { message: 'failed at /Users/alice/private.ts', params: ['secret'] },
			user: { id: 'alice', email: 'alice@example.test' },
			request: { url: 'https://example.test/private?token=secret', headers: { authorization: 'Bearer secret' } },
			tags: { 'para.scope': 'owned', 'para.feature': 'terminal', unsafe: 'Bearer secret' },
			extra: { command: 'cat private.txt', safe_count: 4 },
			exception: {
				values: [{
					type: 'Error',
					value: 'failed for /Users/alice/private.txt',
					stacktrace: {
						frames: [{
							filename: '/Applications/Para Code.app/Contents/Resources/app/out/main.js',
							abs_path: '/Applications/Para Code.app/Contents/Resources/app/out/main.js',
							function: 'startTerminal',
						}],
					},
				}],
			},
			threads: {
				values: [{
					stacktrace: {
						frames: [{ filename: '/Users/alice/private.ts', abs_path: '/Users/alice/private.ts' }],
					},
				}],
			},
		});

		assert.strictEqual(event.user, undefined);
		assert.strictEqual(event.request, undefined);
		assert.deepStrictEqual(event.extra, { safe_count: 4 });
		assert.strictEqual(event.tags?.['para.scope'], 'owned');
		// The sanitizer intentionally keeps the credential label and filters only the
		// secret itself (same shape as `OPENAI_API_KEY=[Filtered]` asserted above).
		assert.strictEqual(event.tags?.unsafe, 'Bearer [Filtered]');
		assert.strictEqual(event.exception?.values?.[0].stacktrace?.frames?.[0].abs_path, 'app:///out/main.js');
		assert.ok(!String(event.message).includes('alice'));
		assert.ok(!String(event.logentry?.message).includes('alice'));
		assert.strictEqual(event.logentry?.params, undefined);
		assert.ok(!String(event.threads?.values[0].stacktrace?.frames?.[0].filename).includes('alice'));
	});

	test('keeps only safe extra fields from an event containing private process details', () => {
		const sanitized = paradisSanitizeSentryEvent({
			message: 'utility process 4312 failed at /Users/alice/private/main.ts while calling https://api.example.test/v1/run?token=secret#fragment',
			request: { url: 'https://api.example.test/v1/run?token=secret', headers: { authorization: 'Bearer secret-token' } },
			server_name: 'alices-macbook-pro.local',
			extra: {
				process_type: 'utility',
				duration_ms: 42,
				safe_count: 3,
				path: '/Users/alice/private/main.ts',
				query: 'token=secret',
				token: 'secret-token',
				OPENAI_API_KEY: 'sk-sensitive',
				process_pid: 4312,
				process_command_line: '/usr/local/bin/node --token=secret',
				environment: { HOME: '/Users/alice', OPENAI_API_KEY: 'sk-sensitive' },
			},
		});

		assert.deepStrictEqual({
			message: sanitized.message,
			request: sanitized.request,
			serverName: sanitized.server_name,
			extra: sanitized.extra,
		}, {
			message: 'utility process 4312 failed at ~/private/main.ts while calling https://api.example.test/v1/run',
			request: undefined,
			serverName: undefined,
			extra: { process_type: 'utility', duration_ms: 42, safe_count: 3 },
		});
	});

	test('limits one fingerprint to three events per ten-minute window and reports suppression', () => {
		let now = 1_000;
		const limiter = new ParadisSentryRateLimiter(() => now);

		assert.deepStrictEqual(limiter.consume('same'), { allowed: true, suppressed: 0 });
		assert.deepStrictEqual(limiter.consume('same'), { allowed: true, suppressed: 0 });
		assert.deepStrictEqual(limiter.consume('same'), { allowed: true, suppressed: 0 });
		assert.deepStrictEqual(limiter.consume('same'), { allowed: false, suppressed: 1 });
		assert.deepStrictEqual(limiter.consume('same'), { allowed: false, suppressed: 2 });

		now += 10 * 60 * 1_000;
		assert.deepStrictEqual(limiter.consume('same'), { allowed: true, suppressed: 2 });
	});

	test('forgets the least recently used fingerprints past its capacity', () => {
		const limiter = new ParadisSentryRateLimiter(() => 1_000, 2);
		limiter.consume('a');
		limiter.consume('a');
		limiter.consume('a');
		limiter.consume('b');
		// Touching `a` again keeps it; `b` is now the oldest and goes when `c` arrives.
		assert.deepStrictEqual(limiter.consume('a'), { allowed: false, suppressed: 1 });
		limiter.consume('c');
		assert.deepStrictEqual({
			a: limiter.consume('a'),
			b: limiter.consume('b'),
		}, {
			a: { allowed: false, suppressed: 2 },
			b: { allowed: true, suppressed: 0 },
		});
	});

	test('keys an explicit report on its innermost own frame, so the kept Node and dependency frames do not re-key it', () => {
		const tags = { 'para.scope': 'owned', 'para.feature': 'f', 'para.operation': 'o', 'para.error_name': 'Error' };
		const ownOnly = paradisSentryFingerprint({
			tags,
			exception: { values: [{ type: 'Error', stacktrace: { frames: [{ filename: 'app:///out/vs/a.js', function: 'outer' }, { filename: 'app:///out/vs/b.js', function: 'inner' }] } }] },
		});
		const withForeign = paradisSentryFingerprint({
			tags,
			exception: {
				values: [{
					type: 'Error', stacktrace: {
						frames: [
							{ filename: 'app:///out/vs/a.js', function: 'outer' },
							{ filename: 'app:///out/vs/b.js', function: 'inner' },
							{ filename: 'app:///node_modules/ws/lib/websocket.js', function: 'send' },
							{ filename: 'node:internal/stream_base_commons', function: 'afterWriteDispatched' },
						],
					},
				}],
			},
		});
		const foreignOnly = (messageHash: string) => paradisSentryFingerprint({
			tags: { ...tags, 'para.error_message_hash': messageHash },
			exception: { values: [{ type: 'Error', stacktrace: { frames: [{ filename: 'node:internal/stream_base_commons', function: 'afterWriteDispatched' }] } }] },
		});
		// An own frame decides the key on its own; the message hash does not join it.
		const ownWithHash = paradisSentryFingerprint({
			tags: { ...tags, 'para.error_message_hash': 'aaaaaaaa' },
			exception: { values: [{ type: 'Error', stacktrace: { frames: [{ filename: 'app:///out/vs/b.js', function: 'inner' }, { filename: 'node:internal/timers', function: 'listOnTimeout' }] } }] },
		});
		// Automatic captures keep keying on the innermost frame, whatever it is.
		const automatic = paradisSentryFingerprint({
			tags: { 'para.scope': 'owned', 'para.feature': 'f', 'para.operation': 'o' },
			exception: { values: [{ type: 'Error', stacktrace: { frames: [{ filename: 'app:///out/vs/b.js', function: 'inner' }, { filename: 'node:internal/timers', function: 'listOnTimeout' }] } }] },
		});
		assert.deepStrictEqual({ ownOnly, withForeign, foreignOnly: [foreignOnly('aaaaaaaa'), foreignOnly('bbbbbbbb')], ownWithHash, automatic }, {
			ownOnly: 'owned|f|o|Error|app:///out/vs/b.js|inner|Error',
			withForeign: 'owned|f|o|Error|app:///out/vs/b.js|inner|Error',
			// Only foreign frames: two different messages must not share one key.
			foreignOnly: [
				'owned|f|o|Error|node:internal/stream_base_commons|afterWriteDispatched|Error|aaaaaaaa',
				'owned|f|o|Error|node:internal/stream_base_commons|afterWriteDispatched|Error|bbbbbbbb',
			],
			ownWithHash: 'owned|f|o|Error|app:///out/vs/b.js|inner|Error',
			automatic: 'owned|f|o|Error|node:internal/timers|listOnTimeout',
		});
	});

	test('keeps the same key across releases, whose bundles rename classes and functions and whose SSH server folder is named after the commit', () => {
		const key = (filename: string, functionName: string) => paradisSentryFingerprint({
			tags: { 'para.scope': 'owned', 'para.feature': 'f', 'para.operation': 'o', 'para.error_name': 'Error' },
			exception: { values: [{ type: 'Error', stacktrace: { frames: [{ filename, function: functionName }] } }] },
		});
		const shared = 'app:///out/vs/code/electron-utility/sharedProcess/sharedProcessMain.js';
		const remote = (commit: string) => `~/.para-code-server/bin/${commit}/out/vs/platform/terminal/node/ptyHostMain.js`;
		assert.deepStrictEqual({
			method: [key(shared, 'TT._reportToolResultError'), key(shared, 'S0._reportToolResultError')],
			bareMinified: [key(shared, 'r4e'), key(shared, 'L')],
			named: key(shared, 'connectRelay'),
			remote: [key(remote('4c5d2509dca713be9f12f7e6a72447b29a8ac7ff'), 'N._throwIfNoPty'), key(remote('0fc790f9ef3f32fe135a4e44e487bf303df4b956'), 'N._throwIfNoPty')],
		}, {
			method: [`owned|f|o|Error|${shared}|_reportToolResultError|Error`, `owned|f|o|Error|${shared}|_reportToolResultError|Error`],
			bareMinified: [`owned|f|o|Error|${shared}|minified|Error`, `owned|f|o|Error|${shared}|minified|Error`],
			named: `owned|f|o|Error|${shared}|connectRelay|Error`,
			remote: [
				'owned|f|o|Error|~/.para-code-server/bin/<commit>/out/vs/platform/terminal/node/ptyHostMain.js|_throwIfNoPty|Error',
				'owned|f|o|Error|~/.para-code-server/bin/<commit>/out/vs/platform/terminal/node/ptyHostMain.js|_throwIfNoPty|Error',
			],
		});
	});

	test('adds the message hash to the key of a minified bare function, so different functions in one bundle do not share an issue', () => {
		const shared = 'app:///out/vs/code/electron-utility/sharedProcess/sharedProcessMain.js';
		const key = (functionName: string, messageHash: string) => paradisSentryFingerprint({
			tags: { 'para.scope': 'owned', 'para.feature': 'f', 'para.operation': 'o', 'para.error_name': 'TypeError', 'para.error_message_hash': messageHash },
			exception: { values: [{ type: 'Error', stacktrace: { frames: [{ filename: shared, function: functionName }] } }] },
		});
		assert.deepStrictEqual({
			minified: [key('r4e', 'aaaaaaaa'), key('L', 'bbbbbbbb')],
			named: [key('connectRelay', 'aaaaaaaa'), key('connectRelay', 'bbbbbbbb')],
		}, {
			minified: [`owned|f|o|Error|${shared}|minified|TypeError|aaaaaaaa`, `owned|f|o|Error|${shared}|minified|TypeError|bbbbbbbb`],
			named: [`owned|f|o|Error|${shared}|connectRelay|TypeError`, `owned|f|o|Error|${shared}|connectRelay|TypeError`],
		});
	});

	test('adds the message hash to the key of a method name that many classes share, so their errors do not share an issue', () => {
		const shared = 'app:///out/vs/code/electron-utility/sharedProcess/sharedProcessMain.js';
		const key = (functionName: string, messageHash: string) => paradisSentryFingerprint({
			tags: { 'para.scope': 'owned', 'para.feature': 'f', 'para.operation': 'o', 'para.error_name': 'TypeError', 'para.error_message_hash': messageHash },
			exception: { values: [{ type: 'Error', stacktrace: { frames: [{ filename: shared, function: functionName }] } }] },
		});
		assert.deepStrictEqual({
			common: [key('TT.dispose', 'aaaaaaaa'), key('S0.dispose', 'bbbbbbbb')],
			uncommon: [key('TT._reportToolResultError', 'aaaaaaaa'), key('S0._reportToolResultError', 'bbbbbbbb')],
		}, {
			common: [`owned|f|o|Error|${shared}|dispose|TypeError|aaaaaaaa`, `owned|f|o|Error|${shared}|dispose|TypeError|bbbbbbbb`],
			uncommon: [`owned|f|o|Error|${shared}|_reportToolResultError|TypeError`, `owned|f|o|Error|${shared}|_reportToolResultError|TypeError`],
		});
	});

	test('builds a stable fingerprint from scope, feature, operation, exception type, and top frame', () => {
		const first = paradisSentryFingerprint({
			tags: { 'para.scope': 'owned', 'para.feature': 'codex-app-server', 'para.operation': 'connect' },
			exception: {
				values: [{
					type: 'TimeoutError',
					value: 'first message',
					stacktrace: { frames: [{ filename: 'app:///out/unrelated.js' }, { filename: 'app:///out/connection.js', function: 'connect' }] },
				}],
			},
		});
		const second = paradisSentryFingerprint({
			tags: { 'para.scope': 'owned', 'para.feature': 'codex-app-server', 'para.operation': 'connect' },
			exception: {
				values: [{
					type: 'TimeoutError',
					value: 'different message',
					stacktrace: { frames: [{ filename: 'app:///out/unrelated.js' }, { filename: 'app:///out/connection.js', function: 'connect' }] },
				}],
			},
		});

		assert.strictEqual(first, second);
		assert.ok(first.includes('codex-app-server'));
		assert.ok(first.includes('connection.js'));
	});

	test('splits explicit reports by the original error name and leaves untagged events unchanged', () => {
		const explicit = (errorName: string) => paradisSentryFingerprint({
			tags: { 'para.scope': 'patched', 'para.feature': 'unhandled-error', 'para.operation': 'on-unexpected-error', 'para.error_name': errorName },
			exception: { values: [{ type: 'Error', value: 'Para Code diagnostic: unhandled-error.on-unexpected-error' }] },
		});
		const untagged = paradisSentryFingerprint({
			tags: { 'para.scope': 'owned', 'para.feature': 'x', 'para.operation': 'y' },
			exception: { values: [{ type: 'Error', value: 'auto' }] },
		});
		assert.deepStrictEqual([explicit('TypeError'), explicit('ListenerLeakError'), untagged], [
			'patched|unhandled-error|on-unexpected-error|Error|unknown|unknown|TypeError',
			'patched|unhandled-error|on-unexpected-error|Error|unknown|unknown|ListenerLeakError',
			'owned|x|y|Error|unknown|unknown',
		]);
	});

	test('classifies automatic errors only when their stack enters Para Code-owned source', () => {
		assert.strictEqual(paradisClassifySentryEvent({
			exception: {
				values: [{
					stacktrace: {
						frames: [{ filename: 'app:///out/vs/paradis/contrib/mobileRelay/node/client.js' }],
					},
				}],
			},
		}), 'owned');
		assert.strictEqual(paradisClassifySentryEvent({
			exception: {
				values: [{
					stacktrace: {
						frames: [{ filename: 'app:///out/vs/workbench/browser/workbench.js' }],
					},
				}],
			},
		}), undefined);
		assert.strictEqual(paradisClassifySentryEvent({
			tags: { 'para.scope': 'patched' },
			exception: {
				values: [{
					stacktrace: {
						frames: [{ filename: 'app:///out/vs/workbench/browser/workbench.js' }],
					},
				}],
			},
		}), 'patched');
		assert.strictEqual(paradisClassifySentryEvent({
			debug_meta: { images: [{ code_file: 'Para Code Framework' }] },
		}), 'unknown');
		// The SDK attaches a `sourcemap` debug image to every JavaScript event, so it must not be
		// mistaken for a native crash image — otherwise upstream errors bypass the scope filter.
		assert.strictEqual(paradisClassifySentryEvent({
			exception: {
				values: [{
					stacktrace: {
						frames: [{ filename: 'app:///out/vs/workbench/browser/workbench.js' }],
					},
				}],
			},
			debug_meta: { images: [{ type: 'sourcemap', code_file: 'app:///out/main.js' }] },
		}), undefined);
		// Native crashes are marked on the event itself and must survive, even though the SDK
		// attaches the same sourcemap image to them.
		assert.strictEqual(paradisClassifySentryEvent({
			platform: 'native',
			debug_meta: { images: [{ type: 'sourcemap', code_file: 'app:///out/main.js' }] },
		}), 'unknown');
		assert.strictEqual(paradisClassifySentryEvent({
			tags: { 'event.environment': 'native' },
		}), 'unknown');
		assert.strictEqual(paradisClassifySentryEvent({
			debug_meta: { images: [{ type: 'sourcemap' }, { type: 'macho', code_file: 'Para Code Framework' }] },
		}), 'unknown');
	});

	// macOS の crashpad ハンドラは Mach 例外ポート越しに子プロセスへ継承されるため、統合ターミナル
	// から起動しただけの無関係なプログラムのクラッシュが Para Code のクラッシュとして届く。
	test('drops native crashes from processes that merely inherited the crash handler', () => {
		// 実地の例: Homebrew の ffplay が dylib を読めず dyld が abort した minidump。
		assert.strictEqual(paradisClassifySentryEvent({
			platform: 'native',
			exception: {
				values: [{
					stacktrace: {
						frames: [
							{ package: '/opt/homebrew/Cellar/opus/1.6.1/lib/libopus.0.dylib' },
							{ package: '/usr/lib/dyld', function: '__abort_with_payload' },
						],
					},
				}],
			},
		}), undefined);
	});

	test('attributes a minidump by its executable, counting any Codex CLI binary as ours', () => {
		const classify = (executable: string) => paradisClassifySentryEvent({ platform: 'native' }, executable);
		assert.deepStrictEqual([
			'/opt/homebrew/Caskroom/codex/0.155.1/codex-aarch64-apple-darwin',
			'/opt/homebrew/bin/codex',
			'C:\\Users\\a\\AppData\\Local\\codex\\codex.exe',
			'/Applications/Para Code.app/Contents/MacOS/Para Code',
			'/opt/homebrew/Cellar/node/24.1.0/bin/node',
			'/usr/local/bin/my-codex',
			'/usr/local/bin/codexfoo',
		].map(classify), ['unknown', 'unknown', 'unknown', 'unknown', undefined, undefined, undefined]);
	});

	test('keeps native crashes from the app itself and from the Codex app-server we spawn', () => {
		assert.strictEqual(paradisClassifySentryEvent({
			platform: 'native',
			exception: {
				values: [{
					stacktrace: {
						frames: [{ package: '/Applications/Para Code.app/Contents/Frameworks/Electron Framework.framework/Versions/A/Electron Framework' }],
					},
				}],
			},
		}), 'unknown');
		// Codex app-server は自分で起動した子プロセス。その abort は endpoint-not-ready の説明になる。
		assert.strictEqual(paradisClassifySentryEvent({
			platform: 'native',
			exception: {
				values: [{
					stacktrace: {
						frames: [
							{ package: '~/.npm-global/lib/node_modules/@openai/codex/node_modules/@openai/codex-darwin-arm64/vendor/aarch64-apple-darwin/bin/codex' },
							{ package: '/usr/lib/system/libsystem_c.dylib', function: 'abort' },
						],
					},
				}],
			},
		}), 'unknown');
		// スレッド側にしか手掛かりが無い形（exception が合成されるケース）でも同じ判定になる。
		assert.strictEqual(paradisClassifySentryEvent({
			platform: 'native',
			threads: {
				values: [{ stacktrace: { frames: [{ package: 'C:\\Program Files\\Para Code\\Para Code.exe' }] } }],
			},
		}), 'unknown');
	});

	test('keeps diagnostic-only extras and drops everything else', () => {
		const sanitized = paradisSanitizeSentryEvent({
			extra: {
				close_code: 1006,
				safe_close_reason: 'superseded',
				cwd: '/Users/example/secret-project',
			},
		});

		assert.deepStrictEqual(sanitized.extra, { close_code: 1006, safe_close_reason: 'superseded' });
	});

	test('keeps safe_ span attributes that collide with the unsafe-key list', () => {
		// span attribute の置き場は `contexts.trace.data`。ここが否定リストだけで濾されていた頃は
		// `safe_terminal_editors` が `terminal` に一致して黙って捨てられ、スペース切り替えの
		// 計装が本番で一度も値を出せていなかった。名前だけで落とさないことを固定する。
		const sanitized = paradisSanitizeSentryEvent({
			contexts: {
				trace: {
					data: {
						safe_terminal_editors: 3,
						safe_path_count: 2,
						safe_session_count: 1,
						cwd: '/Users/example/secret-project',
						terminal: 'zsh -lc secret',
					},
				},
			},
		});

		assert.deepStrictEqual(sanitized.contexts?.trace?.data, {
			safe_terminal_editors: 3,
			safe_path_count: 2,
			safe_session_count: 1,
		});
	});

	test('still scrubs values of safe_ context keys that carry text', () => {
		// `safe_` は「呼び出し側がユーザー内容を含まないと宣言した」印でしかないので、
		// 宣言を信じて値を素通りさせない。
		const sanitized = paradisSanitizeSentryEvent({
			contexts: { 'para.relay': { safe_detail: 'failed for /Users/alice/private.txt' } },
		});

		assert.strictEqual(sanitized.contexts?.['para.relay']?.safe_detail, 'failed for ~/private.txt');
	});
});
