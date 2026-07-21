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
	readonly paradisCreateTerminalPaneEnvironment?: (
		existing: Readonly<Record<string, string | null | undefined>> | undefined,
		token: string,
		portFilePath: string,
		codexRuntime?: {
			readonly launcherDirectory: string;
			readonly socketPath: string;
			readonly pathDelimiter: string;
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
});
