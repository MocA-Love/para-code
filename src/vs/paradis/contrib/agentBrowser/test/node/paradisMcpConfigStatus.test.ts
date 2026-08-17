/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import assert from 'assert';
import { promises as fs } from 'fs';
import { tmpdir } from 'os';
import { join } from '../../../../../base/common/path.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { ParadisMcpSetupController } from '../../node/paradisMcpSetup.js';
import { computeParadisCodexTableRewrite, inspectParadisClaudeMcpJson, inspectParadisCodexMcpToml } from '../../node/paradisMcpConfigStatus.js';
import { paradisCodexMcpTableBody } from '../../common/paradisMcpSetupEncoding.js';

const PORT = 47286;
const SHIM = '/Applications/Para Code.app/Contents/Resources/paradisBrowserMcpShim.js';
const TOKEN_ENV = 'PARA_CODE_TERMINAL_PANE_ID';

suite('Para Browser MCP config status', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	test('inspectParadisClaudeMcpJson detects a shim entry and rejects everything else', () => {
		assert.strictEqual(inspectParadisClaudeMcpJson(JSON.stringify({
			mcpServers: { 'para-browser': { command: 'node', args: [SHIM] } },
		}), PORT), 'configured');
		assert.strictEqual(inspectParadisClaudeMcpJson(JSON.stringify({
			mcpServers: { other: { command: 'node', args: ['/somewhere/other.js'] } },
		}), PORT), 'unconfigured');
		assert.strictEqual(inspectParadisClaudeMcpJson('{ not valid json', PORT), 'unconfigured');
		assert.strictEqual(inspectParadisClaudeMcpJson('{}', PORT), 'unconfigured');
		assert.strictEqual(inspectParadisClaudeMcpJson(JSON.stringify({ mcpServers: [] }), PORT), 'unconfigured');
	});

	test('inspectParadisCodexMcpToml classifies shim, stale chrome-devtools, and absent configs', () => {
		const shimConfig = `[mcp_servers.para-browser]\ncommand = "node"\nargs = ["${SHIM}"]\n`;
		assert.deepStrictEqual(inspectParadisCodexMcpToml(shimConfig, 47286), { state: 'configured' });

		const staleConfig = [
			'[mcp_servers.chrome-devtools-mcp]',
			'command = "npx"',
			'args = ["chrome-devtools-mcp@latest", "--browser-url", "http://127.0.0.1:47834"]',
			'',
		].join('\n');
		assert.deepStrictEqual(inspectParadisCodexMcpToml(staleConfig, 47286), {
			state: 'needsFix', detectedPort: 47834, staleServerName: 'chrome-devtools-mcp',
		});

		// Matching port is not a mismatch, so it is not flagged for fixing.
		assert.deepStrictEqual(inspectParadisCodexMcpToml(staleConfig.replace('47834', '47286'), 47286), { state: 'unconfigured' });
		// Without a known gateway port a mismatch cannot be proven.
		assert.deepStrictEqual(inspectParadisCodexMcpToml(staleConfig, undefined), { state: 'unconfigured' });
		// Empty / unrelated config.
		assert.deepStrictEqual(inspectParadisCodexMcpToml('model = "x"\n', 47286), { state: 'unconfigured' });
	});

	// URL によるポート判定を名前で絞らないと、ユーザーが持っている無関係な HTTP の MCP を
	// 「古いポートの para-browser」と読み、ワンクリック修正がその節を丸ごと私たちの中身へ
	// 置き換えてしまう（取り返しがつかない）。
	test('never mistakes someone else\'s local http MCP server for a stale para-browser', () => {
		const foreign = [
			'[mcp_servers.my-own-tool]',
			'url = "http://127.0.0.1:3333/"',
			'bearer_token_env_var = "MY_TOKEN"',
			'',
		].join('\n');

		assert.deepStrictEqual({
			foreignOnly: inspectParadisCodexMcpToml(foreign, PORT),
			// 私たちの節が正しく設定されていれば、隣に別サーバーが居ても configured のまま。
			withOurs: inspectParadisCodexMcpToml(`${foreign}\n[mcp_servers.para-browser]\nurl = "http://127.0.0.1:${PORT}/"\n`, PORT),
			// 私たちの節が古いポートを指しているときだけ needsFix。
			oursStale: inspectParadisCodexMcpToml(`${foreign}\n[mcp_servers.para-browser]\nurl = "http://127.0.0.1:1234/"\n`, PORT),
		}, {
			foreignOnly: { state: 'unconfigured' },
			withOurs: { state: 'configured' },
			oursStale: { state: 'needsFix', detectedPort: 1234, staleServerName: 'para-browser' },
		});

		// Claude 側も同じ。無関係なエントリで needsFix が永久に消えなくならないこと。
		assert.deepStrictEqual({
			foreignOnly: inspectParadisClaudeMcpJson(JSON.stringify({ mcpServers: { other: { type: 'http', url: 'http://127.0.0.1:3333/' } } }), PORT),
			withOurs: inspectParadisClaudeMcpJson(JSON.stringify({
				mcpServers: { other: { type: 'http', url: 'http://127.0.0.1:3333/' }, 'para-browser': { type: 'http', url: `http://127.0.0.1:${PORT}/` } },
			}), PORT),
		}, { foreignOnly: 'unconfigured', withOurs: 'configured' });
	});

	test('inspectParadisCodexMcpToml reports a surviving stale entry even when a shim entry coexists', () => {
		// W3 regression: a shim entry must NOT hide a remaining stale chrome-devtools entry.
		const mixed = [
			'[mcp_servers.chrome-devtools-mcp]',
			'command = "npx"',
			'args = ["chrome-devtools-mcp", "--browserUrl=http://127.0.0.1:9000"]',
			'',
			'[mcp_servers.para-browser]',
			'command = "node"',
			`args = ["${SHIM}"]`,
			'',
		].join('\n');
		assert.deepStrictEqual(inspectParadisCodexMcpToml(mixed, 47286), {
			state: 'needsFix', detectedPort: 9000, staleServerName: 'chrome-devtools-mcp',
		});
	});

	test('inspectParadisCodexMcpToml keeps returning needsFix until every stale chrome-devtools entry is fixed (W3)', () => {
		const twoStale = [
			'[mcp_servers.chrome-devtools-a]',
			'command = "npx"',
			'args = ["chrome-devtools-mcp", "--browser-url", "http://127.0.0.1:1000"]',
			'',
			'[mcp_servers.chrome-devtools-b]',
			'command = "npx"',
			'args = ["chrome-devtools-mcp", "--browser-url", "http://127.0.0.1:2000"]',
			'',
		].join('\n');
		const first = inspectParadisCodexMcpToml(twoStale, 47286);
		assert.strictEqual(first.state, 'needsFix');
		assert.ok(first.staleServerName !== undefined);
		// After the first table is rewritten to the HTTP method, the second must still be flagged.
		const afterOneFix = computeParadisCodexTableRewrite(twoStale, first.staleServerName, paradisCodexMcpTableBody(PORT));
		assert.ok(afterOneFix !== undefined);
		const second = inspectParadisCodexMcpToml(afterOneFix, 47286);
		assert.strictEqual(second.state, 'needsFix');
		assert.notStrictEqual(second.staleServerName, first.staleServerName);
	});

	test('computeParadisCodexTableRewrite rewrites only the target table and preserves the rest', () => {
		const original = [
			'model = "gpt"',
			'',
			'[mcp_servers.chrome-devtools-mcp]',
			'command = "npx"',
			'args = ["chrome-devtools-mcp@latest", "--browser-url", "http://127.0.0.1:47834"]',
			'',
			'[other]',
			'keep = true',
			'',
		].join('\n');
		const rewritten = computeParadisCodexTableRewrite(original, 'chrome-devtools-mcp', paradisCodexMcpTableBody(PORT));
		assert.ok(rewritten !== undefined);
		assert.ok(!rewritten.includes('47834'));
		assert.ok(rewritten.includes('model = "gpt"'));
		assert.ok(rewritten.includes('[other]'));
		assert.ok(rewritten.includes('keep = true'));
		assert.ok(rewritten.includes('[mcp_servers.chrome-devtools-mcp]'));
		assert.ok(rewritten.includes(`url = "http://127.0.0.1:${PORT}/"`));
		assert.ok(rewritten.includes(`bearer_token_env_var = "${TOKEN_ENV}"`));

		// Absent or ambiguous targets fail closed.
		assert.strictEqual(computeParadisCodexTableRewrite(original, 'missing', paradisCodexMcpTableBody(PORT)), undefined);
	});

	test('controller.status reads the real claude.json and codex config.toml', async () => {
		const directory = await fs.mkdtemp(join(tmpdir(), 'paradis-mcp-status-'));
		try {
			const claudeJsonPath = join(directory, '.claude.json');
			await fs.writeFile(claudeJsonPath, JSON.stringify({ mcpServers: { 'para-browser': { command: 'node', args: [SHIM] } } }));
			await fs.writeFile(join(directory, 'config.toml'), [
				'[mcp_servers.chrome-devtools-mcp]',
				'command = "npx"',
				'args = ["chrome-devtools-mcp", "--browser-url", "http://127.0.0.1:47834"]',
				'',
			].join('\n'));
			const controller = new ParadisMcpSetupController({
				platform: 'darwin',
				resolveShellEnv: async () => ({}),
				findExecutable: async () => undefined,
				runCommand: async () => ({ kind: 'failure', output: '' }),
				codexHome: directory,
				claudeConfigJsonPath: claudeJsonPath,
				log: () => undefined,
			});
			const status = await controller.status(47286);
			assert.strictEqual(status.claude.state, 'configured');
			assert.strictEqual(status.codex.state, 'needsFix');
			assert.strictEqual(status.codex.detectedPort, 47834);
			assert.strictEqual(status.gatewayPort, 47286);
		} finally {
			await fs.rm(directory, { recursive: true, force: true });
		}
	});

	test('controller.status does not fail a large (>1MiB) claude.json (W1)', async () => {
		const directory = await fs.mkdtemp(join(tmpdir(), 'paradis-mcp-bigclaude-'));
		try {
			const claudeJsonPath = join(directory, '.claude.json');
			// Real ~/.claude.json grows past 1MiB with conversation history; pad well beyond it.
			const padding = 'x'.repeat(2 * 1024 * 1024);
			await fs.writeFile(claudeJsonPath, JSON.stringify({
				history: padding,
				mcpServers: { 'para-browser': { command: 'node', args: [SHIM] } },
			}));
			assert.ok((await fs.stat(claudeJsonPath)).size > 1024 * 1024);
			const controller = new ParadisMcpSetupController({
				platform: 'darwin',
				resolveShellEnv: async () => ({}),
				findExecutable: async () => undefined,
				runCommand: async () => ({ kind: 'failure', output: '' }),
				codexHome: directory,
				claudeConfigJsonPath: claudeJsonPath,
				log: () => undefined,
			});
			const status = await controller.status(47286);
			assert.strictEqual(status.claude.failed, undefined);
			assert.strictEqual(status.claude.state, 'configured');
		} finally {
			await fs.rm(directory, { recursive: true, force: true });
		}
	});

	test('controller.status flags codex as manualOnly when a foreign mcp_servers table blocks auto-append (W2)', async () => {
		const directory = await fs.mkdtemp(join(tmpdir(), 'paradis-mcp-manualonly-'));
		try {
			const claudeJsonPath = join(directory, '.claude.json');
			// A chrome-devtools entry that already points at the current gateway port is not "stale",
			// so it classifies as unconfigured — but setupCodex would throw ambiguous on the foreign table.
			await fs.writeFile(join(directory, 'config.toml'), [
				'[mcp_servers.chrome-devtools-mcp]',
				'command = "npx"',
				'args = ["chrome-devtools-mcp", "--browser-url", "http://127.0.0.1:47286"]',
				'',
			].join('\n'));
			const controller = new ParadisMcpSetupController({
				platform: 'darwin',
				resolveShellEnv: async () => ({}),
				findExecutable: async () => undefined,
				runCommand: async () => ({ kind: 'failure', output: '' }),
				codexHome: directory,
				claudeConfigJsonPath: claudeJsonPath,
				log: () => undefined,
			});
			const status = await controller.status(47286);
			assert.strictEqual(status.codex.state, 'unconfigured');
			assert.strictEqual(status.codex.manualOnly, true);
		} finally {
			await fs.rm(directory, { recursive: true, force: true });
		}
	});

	test('controller.fix rewrites a stale codex chrome-devtools entry to the HTTP method', async () => {
		const directory = await fs.mkdtemp(join(tmpdir(), 'paradis-mcp-fix-'));
		try {
			const configPath = join(directory, 'config.toml');
			await fs.writeFile(configPath, [
				'model = "gpt"',
				'[mcp_servers.chrome-devtools-mcp]',
				'command = "npx"',
				'args = ["chrome-devtools-mcp@latest", "--browser-url", "http://127.0.0.1:47834"]',
				'',
			].join('\n'));
			const controller = new ParadisMcpSetupController({
				platform: 'darwin',
				resolveShellEnv: async () => ({}),
				findExecutable: async () => undefined,
				runCommand: async () => ({ kind: 'failure', output: '' }),
				codexHome: directory,
				claudeConfigJsonPath: join(directory, '.claude.json'),
				log: () => undefined,
			});
			const result = await controller.fix('codex', 47286);
			assert.strictEqual(result.servers[0].outcome, 'success');
			const content = await fs.readFile(configPath, 'utf8');
			assert.ok(content.includes(`url = "http://127.0.0.1:${PORT}/"`));
			assert.ok(!content.includes('47834'));
			assert.ok(content.includes('model = "gpt"'));
			// Re-running now sees the HTTP entry and reports it as already configured.
			assert.strictEqual((await controller.fix('codex', 47286)).servers[0].outcome, 'already');
		} finally {
			await fs.rm(directory, { recursive: true, force: true });
		}
	});
});
