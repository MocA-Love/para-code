/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import * as agentBrowser from '../../common/paradisAgentBrowser.js';

interface IParadisGatewayEndpointTestExports {
	readonly paradisFormatCdpGatewayUrl?: (port: number) => string;
	readonly paradisCodexPaneSocketPath?: (userDataPath: string, token: string) => string | undefined;
	readonly paradisCodexPaneEndpointFilePath?: (userDataPath: string, token: string) => string | undefined;
	readonly paradisCreateTerminalPaneEnvironment?: (
		existing: Readonly<Record<string, string | null | undefined>> | undefined,
		token: string,
		portFilePath: string,
		codexRuntime?: {
			readonly launcherDirectory: string;
			readonly pathDelimiter: string;
			readonly socketPath?: string;
			readonly endpointFilePath?: string;
			readonly nodeExecutablePath?: string;
		},
	) => Record<string, string | null | undefined>;
}

suite('ParadisGatewayEndpoint', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	test('formats only a validated actual gateway port', () => {
		const format = (agentBrowser as IParadisGatewayEndpointTestExports).paradisFormatCdpGatewayUrl;
		assert.ok(format);

		assert.strictEqual(format(54321), 'http://127.0.0.1:54321/cdp');
		for (const invalidPort of [0, -1, 1.5, 65_536, Number.NaN]) {
			assert.throws(() => format(invalidPort), /port/i);
		}
	});

	test('preserves a user-provided CDP URL while adding pane routing variables', () => {
		const createEnvironment = (agentBrowser as IParadisGatewayEndpointTestExports).paradisCreateTerminalPaneEnvironment;
		assert.ok(createEnvironment);

		assert.deepStrictEqual(createEnvironment({
			PARA_CODE_CDP_URL: 'http://user-configured.example/cdp',
			KEEP_ME: 'yes',
		}, 'pane-token', '/tmp/paradis-browser-mcp.json'), {
			PARA_CODE_CDP_URL: 'http://user-configured.example/cdp',
			KEEP_ME: 'yes',
			PARA_CODE_TERMINAL_PANE_ID: 'pane-token',
			PARA_CODE_MCP_PORT_FILE: '/tmp/paradis-browser-mcp.json',
		});
	});

	test('adds a pane-specific Codex launcher and app-server socket without losing PATH state', () => {
		const createEnvironment = (agentBrowser as IParadisGatewayEndpointTestExports).paradisCreateTerminalPaneEnvironment;
		const socketPath = (agentBrowser as IParadisGatewayEndpointTestExports).paradisCodexPaneSocketPath;
		assert.ok(createEnvironment);
		assert.ok(socketPath);

		const token = '12345678-1234-4234-8234-123456789abc';
		assert.strictEqual(socketPath('/Users/test/Library/Application Support/Para Code', token),
			'/Users/test/Library/Application Support/Para Code/pcx/12345678-1234-4234-8234-123456789abc.sock');
		assert.strictEqual(socketPath('/Users/test/Library/Application Support/Para Code', '../escape'), undefined);

		assert.deepStrictEqual(createEnvironment({
			PATH: '/user/bin:/usr/bin',
			VSCODE_PATH_PREFIX: '/existing/prefix:',
			KEEP_ME: 'yes',
		}, token, '/tmp/paradis-browser-mcp.json', {
			launcherDirectory: '/Applications/Para Code.app/Contents/Resources/app/resources/paradis/bin',
			socketPath: '/Users/test/Library/Application Support/Para Code/pcx/pane.sock',
			pathDelimiter: ':',
		}), {
			PATH: '/Applications/Para Code.app/Contents/Resources/app/resources/paradis/bin:/user/bin:/usr/bin',
			VSCODE_PATH_PREFIX: '/Applications/Para Code.app/Contents/Resources/app/resources/paradis/bin:/existing/prefix:',
			KEEP_ME: 'yes',
			PARA_CODE_TERMINAL_PANE_ID: token,
			PARA_CODE_MCP_PORT_FILE: '/tmp/paradis-browser-mcp.json',
			PARA_CODE_CODEX_LAUNCHER_DIR: '/Applications/Para Code.app/Contents/Resources/app/resources/paradis/bin',
			PARA_CODE_CODEX_APP_SERVER_SOCKET: '/Users/test/Library/Application Support/Para Code/pcx/pane.sock',
		});
	});

	test('adds the Windows ws endpoint launcher variables instead of a unix socket', () => {
		const createEnvironment = (agentBrowser as IParadisGatewayEndpointTestExports).paradisCreateTerminalPaneEnvironment;
		const endpointFilePath = (agentBrowser as IParadisGatewayEndpointTestExports).paradisCodexPaneEndpointFilePath;
		assert.ok(createEnvironment);
		assert.ok(endpointFilePath);

		const token = '12345678-1234-4234-8234-123456789abc';
		assert.strictEqual(endpointFilePath('C:\\Users\\test\\AppData\\Roaming\\Para Code', '../escape'), undefined);
		const endpoint = endpointFilePath('C:\\Users\\test\\AppData\\Roaming\\Para Code', token);
		assert.ok(endpoint !== undefined && endpoint.endsWith(`${token}.endpoint.json`));

		assert.deepStrictEqual(createEnvironment({ PATH: 'C:\\user\\bin' }, token, 'C:\\tmp\\paradis-browser-mcp.json', {
			launcherDirectory: 'C:\\Para Code\\resources\\app\\resources\\paradis\\bin',
			endpointFilePath: endpoint,
			nodeExecutablePath: 'C:\\Para Code\\Para Code.exe',
			pathDelimiter: ';',
		}), {
			PATH: `C:\\Para Code\\resources\\app\\resources\\paradis\\bin;C:\\user\\bin`,
			VSCODE_PATH_PREFIX: 'C:\\Para Code\\resources\\app\\resources\\paradis\\bin;',
			PARA_CODE_TERMINAL_PANE_ID: token,
			PARA_CODE_MCP_PORT_FILE: 'C:\\tmp\\paradis-browser-mcp.json',
			PARA_CODE_CODEX_LAUNCHER_DIR: 'C:\\Para Code\\resources\\app\\resources\\paradis\\bin',
			PARA_CODE_CODEX_APP_SERVER_ENDPOINT: endpoint,
			PARA_CODE_CODEX_LAUNCHER_NODE: 'C:\\Para Code\\Para Code.exe',
		});

		// socketとendpointの両方（または両方欠落）は不正としてCodex変数を注入しない。
		assert.deepStrictEqual(createEnvironment(undefined, token, '/tmp/port.json', {
			launcherDirectory: '/launcher',
			socketPath: '/tmp/pcx/pane.sock',
			endpointFilePath: '/tmp/pcx/pane.endpoint.json',
			pathDelimiter: ':',
		}), {
			PARA_CODE_TERMINAL_PANE_ID: token,
			PARA_CODE_MCP_PORT_FILE: '/tmp/port.json',
		});
	});
});
