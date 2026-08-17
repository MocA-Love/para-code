/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import assert from 'assert';
import { Event } from '../../../../../base/common/event.js';
import { join } from '../../../../../base/common/path.js';
import { isWindows } from '../../../../../base/common/platform.js';
import { URI } from '../../../../../base/common/uri.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { TestConfigurationService } from '../../../../../platform/configuration/test/common/testConfigurationService.js';
import type { IShellLaunchConfig } from '../../../../../platform/terminal/common/terminal.js';
import type { IWorkbenchEnvironmentService } from '../../../../../workbench/services/environment/common/environmentService.js';
import type { ITerminalInstanceService } from '../../../../../workbench/contrib/terminal/browser/terminal.js';
import type { IPathService } from '../../../../../workbench/services/path/common/pathService.js';
import { PARADIS_MOBILE_CODEX_DAEMON_STREAMING_KEY, PARADIS_MOBILE_ENABLED_KEY } from '../../../mobileRelay/common/paradisMobileRelay.js';
import { ParadisPaneTokenService } from '../../browser/paradisPaneTokenService.js';

const PANE_TOKEN = '12345678-1234-4234-8234-123456789abc';
const USER_DATA_PATH = '/tmp/para-code-user-data';
const APP_ROOT = '/Applications/Para Code.app/Contents/Resources/app';

function paneEnvironmentFor(mobileEnabled: unknown, codexLive: unknown): Record<string, string | null | undefined> {
	const configurationService = new TestConfigurationService();
	configurationService.setUserConfiguration(PARADIS_MOBILE_ENABLED_KEY, mobileEnabled);
	configurationService.setUserConfiguration(PARADIS_MOBILE_CODEX_DAEMON_STREAMING_KEY, codexLive);

	const service = new ParadisPaneTokenService(
		{ onDidCreateInstance: Event.None } as unknown as ITerminalInstanceService,
		{ appRoot: APP_ROOT, userDataPath: USER_DATA_PATH, execPath: `${APP_ROOT}/Para Code` } as unknown as IWorkbenchEnvironmentService,
		{ userHome: async () => URI.file('/home/test') } as unknown as IPathService,
		configurationService,
	);
	const shellLaunchConfig = { shellIntegrationNonce: PANE_TOKEN } as IShellLaunchConfig;
	try {
		service.prepareShellLaunchConfig(shellLaunchConfig);
	} finally {
		service.dispose();
	}
	return { ...shellLaunchConfig.env };
}

suite('Paradis pane token service', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	// ペイン専用 app-server はターミナルごとに1プロセス立ち、その下でMCPが丸ごと起動し直される。
	// 立てる価値があるのはモバイルのライブ連携を使うときだけなので、読み手と同じ条件で判定する。
	// 立てないときも para-browser MCP の識別に要る2つは必ず残す（ここが落ちると全ペインで
	// ブラウザ操作が動かなくなる）。
	test('keeps the MCP routing variables but no Codex launcher unless mobile live sync is on', () => {
		for (const [mobileEnabled, codexLive] of [[false, false], [false, true], [true, false], [true, 'true'], [true, undefined]]) {
			assert.deepStrictEqual(paneEnvironmentFor(mobileEnabled, codexLive), {
				PARA_CODE_TERMINAL_PANE_ID: PANE_TOKEN,
				PARA_CODE_MCP_PORT_FILE: join(USER_DATA_PATH, 'paradis-browser-mcp.json'),
			}, `mobile=${String(mobileEnabled)} codexLive=${String(codexLive)} でランチャーを注入してはいけない`);
		}
	});

	test('points Codex at a pane app-server when both mobile settings are on', () => {
		const environment = paneEnvironmentFor(true, true);

		assert.ok(String(environment['PARA_CODE_CODEX_LAUNCHER_DIR'] ?? '').endsWith(join('resources', 'paradis', 'bin')));
		// ペイン単位の宛先。POSIXはUnixソケット、WindowsはNodeが繋げるws endpointファイル。
		const paneEndpoint = isWindows ? environment['PARA_CODE_CODEX_APP_SERVER_ENDPOINT'] : environment['PARA_CODE_CODEX_APP_SERVER_SOCKET'];
		assert.ok(String(paneEndpoint ?? '').includes(PANE_TOKEN));
	});
});
