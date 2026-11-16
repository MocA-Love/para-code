/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import assert from 'assert';
import { VSBuffer } from '../../../../../base/common/buffer.js';
import { URI } from '../../../../../base/common/uri.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { FileOperationError, FileOperationResult, IFileService } from '../../../../../platform/files/common/files.js';
import { ParadisRemoteMcpSetupController } from '../../electron-browser/paradisRemoteMcpSetup.js';

const HOME = URI.file('/home/example');
const REMOTE_BRIDGE = { node: '/home/example/.para-code-server/bin/abc/node', shimPath: '/home/example/.para-code-server/bin/abc/out/vs/paradis/contrib/agentBrowser/node/paradisBrowserMcpShim.js' };

/** インメモリの偽ファイルシステム。SSH接続先の `IFileService` を模す。 */
function fakeFileService(initial: Record<string, string> = {}, directories: readonly URI[] = []) {
	const files = new Map<string, string>(Object.entries(initial));
	const written: Array<{ readonly uri: string; readonly content: string }> = [];
	const service = {
		stat: async (uri: URI) => {
			if (directories.some(directory => directory.toString() === uri.toString())) {
				return { isDirectory: true };
			}
			throw new FileOperationError('ENOENT', FileOperationResult.FILE_NOT_FOUND);
		},
		readFile: async (uri: URI) => {
			const content = files.get(uri.toString());
			if (content === undefined) {
				// 本物の IFileService と同じく、無いファイルは FILE_NOT_FOUND を投げる
				throw new FileOperationError('ENOENT', FileOperationResult.FILE_NOT_FOUND);
			}
			return { value: VSBuffer.fromString(content) };
		},
		writeFile: async (uri: URI, content: VSBuffer) => {
			files.set(uri.toString(), content.toString());
			written.push({ uri: uri.toString(), content: content.toString() });
		},
	} as unknown as IFileService;
	return { service, files, written };
}

suite('ParadisRemoteMcpSetupController', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	test('reports unconfigured when neither config file exists', async () => {
		const { service } = fakeFileService();
		const controller = new ParadisRemoteMcpSetupController(service, async () => HOME, async () => 51234);

		const status = await controller.status();

		assert.deepStrictEqual(status, {
			claude: { cli: 'claude', state: 'unconfigured' },
			codex: { cli: 'codex', state: 'unconfigured' },
			gatewayPort: 51234,
		});
	});

	test('registers para-browser for Antigravity CLI on the host as the server bridge, keeping its other servers', async () => {
		const configDir = URI.joinPath(HOME, '.gemini', 'config');
		const configFile = URI.joinPath(configDir, 'mcp_config.json');
		const { service, written } = fakeFileService({
			[configFile.toString()]: JSON.stringify({ mcpServers: { other: { command: 'other' }, 'para-browser': { serverUrl: 'http://127.0.0.1:1/mcp', disabled: true } } }),
		}, [configDir]);
		const controller = new ParadisRemoteMcpSetupController(service, async () => HOME, async () => undefined, async () => REMOTE_BRIDGE);

		const before = await controller.status();
		const result = await controller.fix('antigravity');
		const after = await controller.status();

		assert.deepStrictEqual({
			before: before.antigravity,
			outcome: result.servers.map(server => server.outcome),
			written: written.map(entry => ({ uri: entry.uri, content: JSON.parse(entry.content) })),
			after: after.antigravity,
		}, {
			before: { cli: 'antigravity', state: 'needsFix' },
			outcome: ['success'],
			written: [{
				uri: configFile.toString(),
				content: { mcpServers: { other: { command: 'other' }, 'para-browser': { command: REMOTE_BRIDGE.node, args: [REMOTE_BRIDGE.shimPath, '--para-ssh-tunnel'] } } },
			}],
			after: { cli: 'antigravity', state: 'configured', configPath: configFile.path },
		});
	});

	test('leaves Antigravity CLI on the host out when the host does not use agy or its server has no bridge', async () => {
		const configDir = URI.joinPath(HOME, '.gemini', 'config');
		const withoutAgy = new ParadisRemoteMcpSetupController(fakeFileService().service, async () => HOME, async () => 51234, async () => REMOTE_BRIDGE);
		const oldServer = fakeFileService({}, [configDir]);
		const withoutBridge = new ParadisRemoteMcpSetupController(oldServer.service, async () => HOME, async () => 51234, async () => undefined);

		const fix = await withoutBridge.fix('antigravity');

		assert.deepStrictEqual({
			withoutAgy: (await withoutAgy.status()).antigravity,
			withoutBridge: (await withoutBridge.status()).antigravity,
			fix: { cliAvailable: fix.cliAvailable, outcome: fix.servers.map(server => server.outcome) },
			written: oldServer.written,
		}, {
			withoutAgy: undefined,
			withoutBridge: undefined,
			fix: { cliAvailable: true, outcome: ['error'] },
			written: [],
		});
	});

	test('detects a stale port and needsFix without touching files, using the remote home path', async () => {
		const { service, written } = fakeFileService({
			[URI.joinPath(HOME, '.claude.json').toString()]: JSON.stringify({
				mcpServers: { 'para-browser': { type: 'http', url: 'http://127.0.0.1:9999/', headers: {} } },
			}),
		});
		const controller = new ParadisRemoteMcpSetupController(service, async () => HOME, async () => 51234);

		const status = await controller.status();

		assert.strictEqual(status.claude.state, 'needsFix');
		assert.deepStrictEqual(written, []);
	});

	test('fixClaude merges the remote .claude.json in place, preserving unrelated settings', async () => {
		const claudeJsonUri = URI.joinPath(HOME, '.claude.json');
		const { service, files } = fakeFileService({
			[claudeJsonUri.toString()]: JSON.stringify({ model: 'keep-me', mcpServers: { other: { command: 'keep' } } }),
		});
		const controller = new ParadisRemoteMcpSetupController(service, async () => HOME, async () => 51234);

		const result = await controller.fix('claude');

		assert.strictEqual(result.servers[0].outcome, 'success');
		assert.strictEqual(result.target, claudeJsonUri.path);
		const written = JSON.parse(files.get(claudeJsonUri.toString())!);
		assert.deepStrictEqual(written, {
			model: 'keep-me',
			mcpServers: {
				other: { command: 'keep' },
				'para-browser': {
					type: 'http',
					url: 'http://127.0.0.1:51234/',
					headers: { Authorization: 'Bearer ${PARA_CODE_TERMINAL_PANE_ID}' },
					timeout: 300000,
				},
			},
		});
	});

	test('fixCodex writes a fresh config.toml when none exists yet', async () => {
		const { service, files } = fakeFileService();
		const controller = new ParadisRemoteMcpSetupController(service, async () => HOME, async () => 51234);

		const result = await controller.fix('codex');

		assert.strictEqual(result.servers[0].outcome, 'success');
		const written = files.get(URI.joinPath(HOME, '.codex', 'config.toml').toString());
		assert.ok(written?.includes('[mcp_servers.para-browser]'));
		assert.ok(written?.includes('http://127.0.0.1:51234/'));
	});

	test('fixCodex rewrites only the stale chrome-devtools table in place instead of appending a new one', async () => {
		const configUri = URI.joinPath(HOME, '.codex', 'config.toml');
		const original = [
			'[mcp_servers.chrome-devtools]',
			'command = "npx"',
			'args = ["chrome-devtools-mcp", "--browser-url", "http://127.0.0.1:9999"]',
			'',
		].join('\n');
		const { service, files } = fakeFileService({ [configUri.toString()]: original });
		const controller = new ParadisRemoteMcpSetupController(service, async () => HOME, async () => 51234);

		const result = await controller.fix('codex');

		assert.strictEqual(result.servers[0].server, 'chrome-devtools');
		assert.strictEqual(result.servers[0].outcome, 'success');
		const written = files.get(configUri.toString())!;
		assert.ok(written.includes('[mcp_servers.chrome-devtools]'));
		assert.ok(written.includes('http://127.0.0.1:51234/'));
		assert.ok(!written.includes('9999'));
		// para-browser の節を新しく足してはいない（既存の節を書き換えただけ）
		assert.ok(!written.includes('[mcp_servers.para-browser]'));
	});

	test('does not overwrite a config file that exists but fails to read (e.g. a permission error, not ENOENT)', async () => {
		const service = {
			readFile: async () => { throw new Error('EACCES'); },
			writeFile: async (uri: URI) => written.push(uri.toString()),
		} as unknown as IFileService;
		const written: string[] = [];
		const controller = new ParadisRemoteMcpSetupController(service, async () => HOME, async () => 51234);

		const [status, fixResult] = await Promise.all([controller.status(), controller.fix('claude')]);

		assert.strictEqual(status.claude.failed, true);
		assert.strictEqual(fixResult.servers[0].outcome, 'error');
		assert.deepStrictEqual(written, []);
	});

	test('reports an error without writing anything when the return tunnel port is unavailable', async () => {
		const { service, written } = fakeFileService();
		const controller = new ParadisRemoteMcpSetupController(service, async () => HOME, async () => undefined);

		const result = await controller.fix('claude');

		assert.strictEqual(result.servers[0].outcome, 'error');
		assert.deepStrictEqual(written, []);
	});

	// 接続先の環境が解決できていないときに手元のホームで代用すると、接続先の番号を手元の
	// 設定へ焼き込んでしまう（実際に踏んだ）。読むのも書くのもしないことを固定する
	test('reads and writes nothing when the host home is not resolved yet', async () => {
		const { service, files, written } = fakeFileService();
		const controller = new ParadisRemoteMcpSetupController(service, async () => undefined, async () => 51234);

		const [status, fixResult] = await Promise.all([controller.status(), controller.fix('claude')]);

		assert.deepStrictEqual(status, {
			claude: { cli: 'claude', state: 'unconfigured', failed: true },
			codex: { cli: 'codex', state: 'unconfigured', failed: true },
			gatewayPort: 51234,
		});
		assert.strictEqual(fixResult.servers[0].outcome, 'error');
		assert.deepStrictEqual(written, []);
		assert.strictEqual(files.size, 0);
	});
});
