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

/** インメモリの偽ファイルシステム。SSH接続先の `IFileService` を模す。 */
function fakeFileService(initial: Record<string, string> = {}) {
	const files = new Map<string, string>(Object.entries(initial));
	const written: Array<{ readonly uri: string; readonly content: string }> = [];
	const service = {
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
});
