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
	readonly paradisCreateTerminalPaneEnvironment?: (
		existing: Readonly<Record<string, string | null | undefined>> | undefined,
		token: string,
		portFilePath: string,
		codexRuntime?: {
			readonly launcherDirectory: string;
			readonly pathDelimiter: string;
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

	test('adds only the Codex launcher, never a pane app-server socket or endpoint', () => {
		const createEnvironment = (agentBrowser as IParadisGatewayEndpointTestExports).paradisCreateTerminalPaneEnvironment;
		assert.ok(createEnvironment);

		assert.deepStrictEqual(createEnvironment({ PATH: '/usr/bin' }, 'pane-token', '/tmp/port.json', {
			launcherDirectory: '/launcher',
			pathDelimiter: ':',
		}), {
			PATH: '/launcher:/usr/bin',
			VSCODE_PATH_PREFIX: '/launcher:',
			PARA_CODE_TERMINAL_PANE_ID: 'pane-token',
			PARA_CODE_MCP_PORT_FILE: '/tmp/port.json',
			PARA_CODE_CODEX_LAUNCHER_DIR: '/launcher',
		});
		// Windows では node.exe の無い環境でランチャーが本物の codex を探すのに Para Code の exe を使う。
		assert.deepStrictEqual(createEnvironment({ PATH: 'C:\\Windows' }, 'pane-token', 'C:\\port.json', {
			launcherDirectory: 'C:\\launcher',
			nodeExecutablePath: 'C:\\Para Code\\Para Code.exe',
			pathDelimiter: ';',
		}), {
			PATH: 'C:\\launcher;C:\\Windows',
			VSCODE_PATH_PREFIX: 'C:\\launcher;',
			PARA_CODE_TERMINAL_PANE_ID: 'pane-token',
			PARA_CODE_MCP_PORT_FILE: 'C:\\port.json',
			PARA_CODE_CODEX_LAUNCHER_DIR: 'C:\\launcher',
			PARA_CODE_CODEX_LAUNCHER_NODE: 'C:\\Para Code\\Para Code.exe',
		});
	});
});
