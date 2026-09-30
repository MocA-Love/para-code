/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import assert from 'assert';
import { Emitter, Event } from '../../../../../base/common/event.js';
import { join } from '../../../../../base/common/path.js';
import { Schemas } from '../../../../../base/common/network.js';
import { isWindows } from '../../../../../base/common/platform.js';
import { URI } from '../../../../../base/common/uri.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { TestConfigurationService } from '../../../../../platform/configuration/test/common/testConfigurationService.js';
import type { IShellLaunchConfig } from '../../../../../platform/terminal/common/terminal.js';
import type { IWorkbenchEnvironmentService } from '../../../../../workbench/services/environment/common/environmentService.js';
import type { ITerminalInstance, ITerminalInstanceService } from '../../../../../workbench/contrib/terminal/browser/terminal.js';
import type { IPathService } from '../../../../../workbench/services/path/common/pathService.js';
import { PARADIS_MOBILE_CODEX_DAEMON_STREAMING_KEY, PARADIS_MOBILE_ENABLED_KEY } from '../../../mobileRelay/common/paradisMobileRelay.js';
import { ParadisPaneTokenService } from '../../browser/paradisPaneTokenService.js';
import type { IParadisCodexLaunchHomeService } from '../../../codexAccounts/browser/paradisCodexLaunchHomeService.js';

const PANE_TOKEN = '12345678-1234-4234-8234-123456789abc';
const USER_DATA_PATH = '/tmp/para-code-user-data';
const APP_ROOT = '/Applications/Para Code.app/Contents/Resources/app';

function codexLaunchHomeStub(launchHome: string | undefined, recorded: Map<string, string | undefined> = new Map()): IParadisCodexLaunchHomeService {
	return {
		getLaunchHome: () => launchHome,
		recordPaneHome: (token: string, homePath: string | undefined) => recorded.set(token, homePath),
		forgetPaneHome: (token: string) => recorded.delete(token),
	} as unknown as IParadisCodexLaunchHomeService;
}

function paneEnvironmentFor(mobileEnabled: unknown, codexLive: unknown, options: { readonly launchHome?: string; readonly remoteAuthority?: string; readonly recorded?: Map<string, string | undefined> } = {}): Record<string, string | null | undefined> {
	const configurationService = new TestConfigurationService();
	configurationService.setUserConfiguration(PARADIS_MOBILE_ENABLED_KEY, mobileEnabled);
	configurationService.setUserConfiguration(PARADIS_MOBILE_CODEX_DAEMON_STREAMING_KEY, codexLive);

	const service = new ParadisPaneTokenService(
		{ onDidCreateInstance: Event.None } as unknown as ITerminalInstanceService,
		{ appRoot: APP_ROOT, userDataPath: USER_DATA_PATH, execPath: `${APP_ROOT}/Para Code`, remoteAuthority: options.remoteAuthority } as unknown as IWorkbenchEnvironmentService,
		{ userHome: async () => URI.file('/home/test') } as unknown as IPathService,
		configurationService,
		codexLaunchHomeStub(options.launchHome, options.recorded),
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
	// ブラウザ操作が動かなくなる）。POSIX ではランチャーだけを入れ、Codex の共有バックグラウンド
	// サーバーの自動起動を止める（ソケットは入れない）。
	test('keeps the MCP routing variables but no pane app-server socket unless mobile live sync is on', () => {
		const launcherDirectory = join(APP_ROOT, 'resources', 'paradis', 'bin');
		const expected = isWindows ? {
			PARA_CODE_TERMINAL_PANE_ID: PANE_TOKEN,
			PARA_CODE_MCP_PORT_FILE: join(USER_DATA_PATH, 'paradis-browser-mcp.json'),
		} : {
			PARA_CODE_TERMINAL_PANE_ID: PANE_TOKEN,
			PARA_CODE_MCP_PORT_FILE: join(USER_DATA_PATH, 'paradis-browser-mcp.json'),
			PATH: `${launcherDirectory}:\${env:PATH}`,
			VSCODE_PATH_PREFIX: `${launcherDirectory}:`,
			PARA_CODE_CODEX_LAUNCHER_DIR: launcherDirectory,
		};
		for (const [mobileEnabled, codexLive] of [[false, false], [false, true], [true, false], [true, 'true'], [true, undefined]]) {
			assert.deepStrictEqual(paneEnvironmentFor(mobileEnabled, codexLive), expected, `mobile=${String(mobileEnabled)} codexLive=${String(codexLive)} でソケットを注入してはいけない`);
		}
	});

	// SSH の接続先では、置いたランチャー（~/.para-code/bin）だけを入れる。手元が Windows でも同じ。
	test('puts only the host launcher on PATH for a remote terminal when the pane app-server is off', async () => {
		const configurationService = new TestConfigurationService();
		const service = new ParadisPaneTokenService(
			{ onDidCreateInstance: Event.None } as unknown as ITerminalInstanceService,
			{ appRoot: APP_ROOT, userDataPath: USER_DATA_PATH, remoteAuthority: 'ssh-remote+host' } as unknown as IWorkbenchEnvironmentService,
			{ userHome: async () => URI.from({ scheme: Schemas.vscodeRemote, authority: 'ssh-remote+host', path: '/home/test' }) } as unknown as IPathService,
			configurationService,
			codexLaunchHomeStub(undefined),
		);
		try {
			await new Promise(resolve => setTimeout(resolve, 0));
			const shellLaunchConfig = { shellIntegrationNonce: PANE_TOKEN } as IShellLaunchConfig;
			service.prepareShellLaunchConfig(shellLaunchConfig);
			assert.deepStrictEqual({ ...shellLaunchConfig.env }, {
				PARA_CODE_TERMINAL_PANE_ID: PANE_TOKEN,
				PARA_CODE_MCP_PORT_FILE: '/home/test/.para-code/paradis-browser-mcp.json',
				PATH: '/home/test/.para-code/bin:${env:PATH}',
				VSCODE_PATH_PREFIX: '/home/test/.para-code/bin:',
				PARA_CODE_CODEX_LAUNCHER_DIR: '/home/test/.para-code/bin',
			});
		} finally {
			service.dispose();
		}
	});

	// アプリを終了→起動し直したとき、終了前に一度も入力されなかったターミナルはバッファが保存されず
	// pty host に蘇らない。復元したタブは attach に失敗し、同じ shellLaunchConfig で新しいシェルを
	// 起こし直す。その shellLaunchConfig にペイントークンが無いと、復元したターミナルだけ
	// hook・通知・ブラウザ共有が効かなかった。新規と同じトークンが入り、登録されるトークンとも
	// 一致することを確かめる。
	test('gives a restored terminal the same pane token env as when it was new, even if attach falls back to a new shell', () => {
		const onDidCreateInstance = new Emitter<ITerminalInstance>();
		// 開いたときの Codex のホームは新しく開いたペインだけ覚える。再接続したペインのプロセスは前回の
		// CODEX_HOME のまま動いているので、いまの選択を記録してはいけない。
		const recorded: [string, string | undefined][] = [];
		const service = new ParadisPaneTokenService(
			{ onDidCreateInstance: onDidCreateInstance.event } as unknown as ITerminalInstanceService,
			{ appRoot: APP_ROOT, userDataPath: USER_DATA_PATH, execPath: `${APP_ROOT}/Para Code` } as unknown as IWorkbenchEnvironmentService,
			{ userHome: async () => URI.file('/home/test') } as unknown as IPathService,
			new TestConfigurationService(),
			{
				getLaunchHome: () => '/home/test/.codex-2',
				recordPaneHome: (token: string, homePath: string | undefined) => recorded.push([token, homePath]),
			} as unknown as IParadisCodexLaunchHomeService,
		);
		try {
			const createdConfig = { shellIntegrationNonce: PANE_TOKEN } as IShellLaunchConfig;
			service.prepareShellLaunchConfig(createdConfig);

			const restoredConfig: IShellLaunchConfig = {
				attachPersistentProcess: { id: 2, shellIntegrationNonce: PANE_TOKEN } as IShellLaunchConfig['attachPersistentProcess'],
			};
			service.prepareShellLaunchConfig(restoredConfig);
			// TerminalInstance は shellIntegrationNonce が無ければ attach 先の nonce を引き継ぐ
			onDidCreateInstance.fire({
				instanceId: 7,
				shellIntegrationNonce: PANE_TOKEN,
				shellLaunchConfig: restoredConfig,
				onDisposed: Event.None,
			} as unknown as ITerminalInstance);

			const revivedToken = 'token-held-by-the-previous-pty';
			const revivedConfig: IShellLaunchConfig = {
				attachPersistentProcess: { id: 3, shellIntegrationNonce: PANE_TOKEN, paradisPaneToken: revivedToken } as IShellLaunchConfig['attachPersistentProcess'],
			};
			service.prepareShellLaunchConfig(revivedConfig);

			assert.deepStrictEqual({
				created: createdConfig.env,
				restored: restoredConfig.env,
				registered: service.getTokenForInstance(7),
				revivedPaneId: revivedConfig.env?.PARA_CODE_TERMINAL_PANE_ID,
				recorded,
			}, {
				created: { ...paneEnvironmentFor(false, false), CODEX_HOME: '/home/test/.codex-2' },
				restored: { ...paneEnvironmentFor(false, false), CODEX_HOME: '/home/test/.codex-2' },
				registered: PANE_TOKEN,
				revivedPaneId: revivedToken,
				// 新しく開いた1回分だけ。再接続した2回（id 2・3）は記録しない
				recorded: [[PANE_TOKEN, '/home/test/.codex-2']],
			});
		} finally {
			service.dispose();
			onDidCreateInstance.dispose();
		}
	});

	test('points Codex at a pane app-server when both mobile settings are on', () => {
		const environment = paneEnvironmentFor(true, true);

		assert.ok(String(environment.PARA_CODE_CODEX_LAUNCHER_DIR ?? '').endsWith(join('resources', 'paradis', 'bin')));
		// ペイン単位の宛先。POSIXはUnixソケット、WindowsはNodeが繋げるws endpointファイル。
		const paneEndpoint = isWindows ? environment.PARA_CODE_CODEX_APP_SERVER_ENDPOINT : environment.PARA_CODE_CODEX_APP_SERVER_SOCKET;
		assert.ok(String(paneEndpoint ?? '').includes(PANE_TOKEN));
	});

	// Codex のアカウント切替は、新しく開くターミナルへ CODEX_HOME を渡すだけ。既定のホームを選んで
	// いるときは何も足さない（ユーザー自身の CODEX_HOME を潰さない）。SSH の接続先で動くターミナルへ
	// 手元のホームのパスを渡すと存在しない場所を指すので、そこでも渡さない。
	test('passes the selected Codex home only to local terminals and remembers it per pane', () => {
		const recorded = new Map<string, string | undefined>();
		assert.deepStrictEqual({
			selected: paneEnvironmentFor(false, false, { launchHome: '/home/test/.codex-2', recorded }).CODEX_HOME,
			recorded: recorded.get(PANE_TOKEN),
			defaultHome: paneEnvironmentFor(false, false, { launchHome: undefined }).CODEX_HOME,
			remote: paneEnvironmentFor(false, false, { launchHome: '/home/test/.codex-2', remoteAuthority: 'ssh-remote+host' }).CODEX_HOME,
		}, {
			selected: '/home/test/.codex-2',
			recorded: '/home/test/.codex-2',
			defaultHome: undefined,
			remote: undefined,
		});
	});
});
