/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import assert from 'assert';
import { promises as fs } from 'fs';
import { tmpdir } from 'os';
import { join } from '../../../../../base/common/path.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { PARADIS_CODEX_HOOK_EVENTS, paradisManagedAgentHookCommand } from '../../../agentBrowser/common/paradisAgentHooks.js';
import { paradisMergeAgentHooksJson } from '../../../agentBrowser/node/paradisAgentHooksSetup.js';
import {
	paradisCodexHookTrustHash,
	paradisCodexTomlFingerprint,
	paradisGrantCodexHookTrustFile,
	paradisInspectCodexHookTrustFile,
	paradisListManagedCodexHookTrustEntries,
	paradisReadCodexHookTrustedHashes,
	paradisUpsertCodexHookTrust,
} from '../../node/paradisCodexHookTrustFile.js';

const MANAGED = paradisManagedAgentHookCommand();

suite('ParadisCodexHookTrustFile', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	// 期待値は codex-cli 0.159.3 の `codex app-server` の `hooks/list` が返した currentHash（2026-10-03 に
	// 一時 CODEX_HOME で実測）と、codex-rs/config/src/fingerprint_tests.rs の固定値。Codex の計算が変わったら
	// ここが落ちる（そのときは Codex に合わせて計算を直す）。
	test('computes the same hashes as Codex', () => {
		assert.deepStrictEqual({
			fingerprint: paradisCodexTomlFingerprint({ rows: [{ z: 2, a: 1 }, { z: 4, a: 3 }], nested: { z: 'text', a: true } }),
			stop: paradisCodexHookTrustHash('stop', undefined, { command: MANAGED }),
			// matcher を持てないイベントの matcher は省く
			stopWithMatcher: paradisCodexHookTrustHash('stop', 'ignored', { command: MANAGED }),
			sessionStart: paradisCodexHookTrustHash('session_start', undefined, { command: MANAGED }),
			// Interrupt は既定 1 秒。Para Code は 3 秒を書く
			interrupt: paradisCodexHookTrustHash('interrupt', undefined, { command: MANAGED, timeout: 3 }),
			interruptDefault: paradisCodexHookTrustHash('interrupt', 'ignored', { command: MANAGED }),
			sessionEndClamped: paradisCodexHookTrustHash('session_end', undefined, { command: MANAGED, timeout: 10 }),
			userHook: paradisCodexHookTrustHash('pre_tool_use', 'Bash', { command: 'echo "日本語" \\ x', timeout: 30, async: true, statusMessage: 'checking' }),
		}, {
			fingerprint: 'sha256:a5e4c8fbdbc75d185b0f2b5291bfb2de10e8c523d6c89248876fd78a97c83176',
			stop: 'sha256:406b79e1853a6f136569d230cf037fbfffb824696d85db4a754c707a78f1110a',
			stopWithMatcher: 'sha256:406b79e1853a6f136569d230cf037fbfffb824696d85db4a754c707a78f1110a',
			sessionStart: 'sha256:a0315398f38851f0dd48fcdb2cad4d8d84f4981ee42c0f34434ee2a72c12c02d',
			interrupt: 'sha256:d6d7aa86ba216bbe152efa9202cfabcfeb07ec71c3b77493a9078342dd53064d',
			interruptDefault: 'sha256:ca89a9c750a9570b48dd40b2cf7ea7212a60aacc6d890a693756627fb51643f0',
			sessionEndClamped: 'sha256:d3c254dd4a7baad6f6a4ed8af8ceea043accba782e3ccf7817c487f3e32304ee',
			userHook: 'sha256:c3ffc854e2ad0a611495709ace01aca5409532f470d7dedd4b5d407ec0f77654',
		});
	});

	test('lists only the hooks Para Code installed, keyed by their position', () => {
		const hooksJson = JSON.stringify({
			hooks: {
				Stop: [{ hooks: [{ type: 'command', command: '/tmp/user.sh' }, { type: 'command', command: MANAGED }] }],
				Interrupt: [{ hooks: [{ type: 'command', command: MANAGED, timeout: 3 }] }],
				NotACodexEvent: [{ hooks: [{ type: 'command', command: MANAGED }] }],
			},
		});
		assert.deepStrictEqual(paradisListManagedCodexHookTrustEntries(hooksJson, '/home/u/.codex/hooks.json', MANAGED), [
			{ key: '/home/u/.codex/hooks.json:stop:0:1', eventName: 'Stop', hash: 'sha256:406b79e1853a6f136569d230cf037fbfffb824696d85db4a754c707a78f1110a' },
			{ key: '/home/u/.codex/hooks.json:interrupt:0:0', eventName: 'Interrupt', hash: 'sha256:d6d7aa86ba216bbe152efa9202cfabcfeb07ec71c3b77493a9078342dd53064d' },
		]);
		assert.strictEqual(paradisListManagedCodexHookTrustEntries('{ not json', '/x', MANAGED), undefined);
	});

	test('updates only the trusted_hash lines and keeps everything else in config.toml', () => {
		const source = [
			'# settings',
			'model = "gpt-5"',
			'',
			'[hooks.state."/h/hooks.json:stop:0:0"]',
			'enabled = false',
			'  trusted_hash = "sha256:old" # comment',
			'',
			'[hooks.state."/h/hooks.json:session_start:0:0"]',
			'enabled = true',
			'',
			'[mcp_servers.foo]',
			'command = """',
			'[hooks.state."not a header"]',
			'"""',
			'',
		].join('\n');
		const updated = paradisUpsertCodexHookTrust(source, [
			{ key: '/h/hooks.json:stop:0:0', eventName: 'Stop', hash: 'sha256:new-stop' },
			{ key: '/h/hooks.json:session_start:0:0', eventName: 'SessionStart', hash: 'sha256:new-start' },
			{ key: '/h/hooks.json:interrupt:0:0', eventName: 'Interrupt', hash: 'sha256:new-interrupt' },
		]);
		assert.strictEqual(updated, [
			'# settings',
			'model = "gpt-5"',
			'',
			'[hooks.state."/h/hooks.json:stop:0:0"]',
			'enabled = false',
			'  trusted_hash = "sha256:new-stop"',
			'',
			'[hooks.state."/h/hooks.json:session_start:0:0"]',
			'trusted_hash = "sha256:new-start"',
			'enabled = true',
			'',
			'[mcp_servers.foo]',
			'command = """',
			'[hooks.state."not a header"]',
			'"""',
			'',
			'[hooks.state."/h/hooks.json:interrupt:0:0"]',
			'trusted_hash = "sha256:new-interrupt"',
			'',
		].join('\n'));
		// 2 回目は何も変えない
		assert.strictEqual(paradisUpsertCodexHookTrust(updated!, [
			{ key: '/h/hooks.json:stop:0:0', eventName: 'Stop', hash: 'sha256:new-stop' },
		]), updated);
		assert.deepStrictEqual([...paradisReadCodexHookTrustedHashes(updated!) ?? []], [
			['/h/hooks.json:stop:0:0', 'sha256:new-stop'],
			['/h/hooks.json:session_start:0:0', 'sha256:new-start'],
			['/h/hooks.json:interrupt:0:0', 'sha256:new-interrupt'],
		]);
	});

	// 節を足すと同じ表を二重に定義しかねない書き方では、Codex が設定ごと読めなくなるので何も書かない
	// Codex（toml_edit）は鍵ごとの節の前に、中身の無い `[hooks.state]` の見出しを 1 つ書く（実際の
	// config.toml の形）。それは受け入れ、直下に代入があるときだけ拒む
	test('accepts the empty hooks.state header Codex writes and keeps CRLF line endings', () => {
		const entry = [
			{ key: '/h/hooks.json:stop:0:0', eventName: 'Stop', hash: 'sha256:new-stop' },
			{ key: '/h/hooks.json:interrupt:0:0', eventName: 'Interrupt', hash: 'sha256:new-interrupt' },
		];
		const codexWritten = [
			'model = "gpt-5"',
			'',
			'[hooks.state]',
			'',
			'[hooks.state."/h/hooks.json:stop:0:0"]',
			'trusted_hash = "sha256:old"',
			'',
		];
		assert.deepStrictEqual({
			lf: paradisUpsertCodexHookTrust(codexWritten.join('\n'), entry),
			crlf: paradisUpsertCodexHookTrust(codexWritten.join('\r\n'), entry),
		}, {
			lf: [
				'model = "gpt-5"',
				'',
				'[hooks.state]',
				'',
				'[hooks.state."/h/hooks.json:stop:0:0"]',
				'trusted_hash = "sha256:new-stop"',
				'',
				'[hooks.state."/h/hooks.json:interrupt:0:0"]',
				'trusted_hash = "sha256:new-interrupt"',
				'',
			].join('\n'),
			crlf: [
				'model = "gpt-5"',
				'',
				'[hooks.state]',
				'',
				'[hooks.state."/h/hooks.json:stop:0:0"]',
				'trusted_hash = "sha256:new-stop"',
				'',
				'[hooks.state."/h/hooks.json:interrupt:0:0"]',
				'trusted_hash = "sha256:new-interrupt"',
				'',
			].join('\r\n'),
		});
	});

	// 節を足すと同じ表を二重に定義しかねない書き方では、Codex が設定ごと読めなくなるので何も書かない
	test('refuses to edit hooks.state written in a form that a new table could collide with', () => {
		const entry = [{ key: '/h/hooks.json:stop:0:0', eventName: 'Stop', hash: 'sha256:x' }];
		assert.deepStrictEqual([
			'[hooks.state]\n"/h/hooks.json:stop:0:0" = { trusted_hash = "a" }\n',
			'[hooks.state]\n[hooks.state]\n',
			'hooks = { state = {} }\n',
			'hooks.state."/h/hooks.json:stop:0:0".trusted_hash = "a"\n',
			'[hooks]\nstate = {}\n',
			'[hooks]\nstate."/h/hooks.json:stop:0:0".enabled = true\n',
			'[hooks.state."/h/hooks.json:stop:0:0"]\nfoo.bar = 1\n',
			'[hooks.state."a"]\n[hooks.state."a"]\n',
			'[[hooks.state]]\n',
			'x = """\nunterminated\n',
		].map(source => paradisUpsertCodexHookTrust(source, entry)), Array(10).fill(undefined));
		// hooks の下のほかの表（TOML で書いた hook）は足しても衝突しない
		assert.ok(paradisUpsertCodexHookTrust('[[hooks.Stop]]\n[[hooks.Stop.hooks]]\ntype = "command"\ncommand = "x"\n', entry)?.endsWith('[hooks.state."/h/hooks.json:stop:0:0"]\ntrusted_hash = "sha256:x"\n'));
	});

	test('trusts the installed hooks in a Codex home, keeps the file mode and leaves user hooks alone', async function () {
		if (process.platform === 'win32') {
			this.skip();
		}
		const root = await fs.realpath(await fs.mkdtemp(join(tmpdir(), 'paradis-codex-trust-file-')));
		try {
			const hooksPath = join(root, 'hooks.json');
			const configPath = join(root, 'config.toml');
			await fs.writeFile(hooksPath, paradisMergeAgentHooksJson(JSON.stringify({ hooks: { Stop: [{ hooks: [{ type: 'command', command: '/tmp/user.sh' }] }] } }), PARADIS_CODEX_HOOK_EVENTS)!);
			await fs.writeFile(configPath, `model = "gpt-5"\n\n[hooks.state."${root}/hooks.json:stop:0:0"]\ntrusted_hash = "sha256:user"\n`);
			await fs.chmod(configPath, 0o640);

			const before = await paradisInspectCodexHookTrustFile(root, MANAGED);
			const granted = await paradisGrantCodexHookTrustFile(root, MANAGED);
			const after = await paradisInspectCodexHookTrustFile(root, MANAGED);
			const again = await paradisGrantCodexHookTrustFile(root, MANAGED);
			const config = await fs.readFile(configPath, 'utf8');

			assert.deepStrictEqual({
				pendingBefore: before.pending.length,
				managed: before.managedCount,
				outcome: granted.outcome,
				granted: [...granted.grantedEvents].sort(),
				pendingAfter: after.pending.length,
				again: again.outcome,
				mode: ((await fs.stat(configPath)).mode & 0o777).toString(8),
				keepsUserTrust: config.includes(`[hooks.state."${root}/hooks.json:stop:0:0"]\ntrusted_hash = "sha256:user"\n`),
				keepsModel: config.startsWith('model = "gpt-5"\n'),
				backedUp: await fs.access(`${configPath}.paradis.bak`).then(() => true, () => false),
			}, {
				pendingBefore: PARADIS_CODEX_HOOK_EVENTS.length,
				managed: PARADIS_CODEX_HOOK_EVENTS.length,
				outcome: 'granted',
				granted: PARADIS_CODEX_HOOK_EVENTS.map(event => event.eventName).sort(),
				pendingAfter: 0,
				again: 'already-trusted',
				mode: '640',
				keepsUserTrust: true,
				keepsModel: true,
				backedUp: true,
			});
		} finally {
			await fs.rm(root, { recursive: true, force: true });
		}
	});
});
