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
import type { IShellLaunchConfig } from '../../../../../platform/terminal/common/terminal.js';
import type { IWorkbenchEnvironmentService } from '../../../../../workbench/services/environment/common/environmentService.js';
import type { ITerminalInstance, ITerminalInstanceService } from '../../../../../workbench/contrib/terminal/browser/terminal.js';
import type { IPathService } from '../../../../../workbench/services/path/common/pathService.js';
import { ParadisPaneTokenService } from '../../browser/paradisPaneTokenService.js';
import { paradisRemoteHookSourceId } from '../../common/paradisRemoteHookSource.js';
import type { IParadisCodexLaunchHomeService } from '../../../codexAccounts/browser/paradisCodexLaunchHomeService.js';
import type { IInstantiationService } from '../../../../../platform/instantiation/common/instantiation.js';

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

/** Claude Code の mod の準備（paradisClaudeModEnvironment.ts）。既定では準備ができていない（何も足さない）。 */
function claudeModStub(directory?: string): IInstantiationService {
	return { createInstance: () => ({ pluginDirectory: () => directory, dispose: () => { } }) } as unknown as IInstantiationService;
}

function paneEnvironmentFor(options: { readonly launchHome?: string; readonly remoteAuthority?: string; readonly cwd?: URI; readonly recorded?: Map<string, string | undefined> } = {}): Record<string, string | null | undefined> {
	const service = new ParadisPaneTokenService(
		{ onDidCreateInstance: Event.None } as unknown as ITerminalInstanceService,
		{ appRoot: APP_ROOT, userDataPath: USER_DATA_PATH, execPath: `${APP_ROOT}/Para Code`, remoteAuthority: options.remoteAuthority } as unknown as IWorkbenchEnvironmentService,
		{ userHome: async () => URI.file('/home/test') } as unknown as IPathService,
		codexLaunchHomeStub(options.launchHome, options.recorded),
		claudeModStub(),
	);
	const shellLaunchConfig = { shellIntegrationNonce: PANE_TOKEN, cwd: options.cwd } as IShellLaunchConfig;
	try {
		service.prepareShellLaunchConfig(shellLaunchConfig);
	} finally {
		service.dispose();
	}
	return { ...shellLaunchConfig.env };
}

suite('Paradis pane token service', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	// ペイン専用 app-server（モバイルのライブ連携）はやめたので、ソケットは入れない。para-browser MCP の
	// 識別に要る2つは必ず残す（ここが落ちると全ペインでブラウザ操作が動かなくなる）。POSIX では
	// ランチャーだけを入れ、Codex を共有バックグラウンドサーバーから切り離して起動させる。
	// Windows は実機で確かめるまで何も入れない。
	test('keeps the MCP routing variables and only the launcher, never a pane app-server socket', () => {
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
		assert.deepStrictEqual(paneEnvironmentFor(), expected);
	});

	// SSH の接続先では、置いたランチャー（~/.para-code/bin）だけを入れる。手元が Windows でも同じ。
	// ポートファイルは、この PC の印が作れればこの PC 専用のもの（同じ接続先へ別の PC からも繋いで
	// いるとき、hook をこのペインを開いた PC へ届けるため）。作れなければ共有のもの。
	test('puts only the host launcher on PATH and points the hooks at this PC\'s port file on the host', async () => {
		const remoteEnvironment = async (machineId: string | undefined) => {
			const service = new ParadisPaneTokenService(
				{ onDidCreateInstance: Event.None } as unknown as ITerminalInstanceService,
				{ appRoot: APP_ROOT, userDataPath: USER_DATA_PATH, remoteAuthority: 'ssh-remote+host', machineId } as unknown as IWorkbenchEnvironmentService,
				{ userHome: async () => URI.from({ scheme: Schemas.vscodeRemote, authority: 'ssh-remote+host', path: '/home/test' }) } as unknown as IPathService,
				codexLaunchHomeStub(undefined),
				claudeModStub(),
			);
			try {
				await new Promise(resolve => setTimeout(resolve, 0));
				const shellLaunchConfig = { shellIntegrationNonce: PANE_TOKEN } as IShellLaunchConfig;
				service.prepareShellLaunchConfig(shellLaunchConfig);
				return { ...shellLaunchConfig.env };
			} finally {
				service.dispose();
			}
		};
		const launcher = {
			PATH: '/home/test/.para-code/bin:${env:PATH}',
			VSCODE_PATH_PREFIX: '/home/test/.para-code/bin:',
			PARA_CODE_CODEX_LAUNCHER_DIR: '/home/test/.para-code/bin',
		};
		const sourceId = paradisRemoteHookSourceId('machine-a');
		assert.deepStrictEqual({
			withMachineId: await remoteEnvironment('machine-a'),
			withoutMachineId: await remoteEnvironment(undefined),
			otherMachineDiffers: paradisRemoteHookSourceId('machine-b') !== sourceId,
		}, {
			withMachineId: { PARA_CODE_TERMINAL_PANE_ID: PANE_TOKEN, PARA_CODE_MCP_PORT_FILE: `/home/test/.para-code/ports/${sourceId}.json`, ...launcher },
			withoutMachineId: { PARA_CODE_TERMINAL_PANE_ID: PANE_TOKEN, PARA_CODE_MCP_PORT_FILE: '/home/test/.para-code/paradis-browser-mcp.json', ...launcher },
			otherMachineDiffers: true,
		});
		assert.ok(/^[0-9a-f]{16}$/.test(sourceId ?? ''));
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
			{
				getLaunchHome: () => '/home/test/.codex-2',
				recordPaneHome: (token: string, homePath: string | undefined) => recorded.push([token, homePath]),
			} as unknown as IParadisCodexLaunchHomeService,
			claudeModStub(),
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
				created: { ...paneEnvironmentFor(), CODEX_HOME: '/home/test/.codex-2' },
				restored: { ...paneEnvironmentFor(), CODEX_HOME: '/home/test/.codex-2' },
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

	// Codex のアカウント切替は、新しく開くターミナルへ CODEX_HOME を渡すだけ。既定のホームを選んで
	// いるときは何も足さない（ユーザー自身の CODEX_HOME を潰さない）。SSH の接続先で動くターミナルへ
	// 手元のホームのパスを渡すと存在しない場所を指すので、そこでも渡さない。
	// 選択はウィンドウのマシン（SSH のウィンドウなら接続先）のホームを指すので、そのマシンで動くターミナル
	// にだけ渡す。SSH のウィンドウで手元に開いたターミナルには渡さず、開いたときのホームも覚えない。
	test('passes the selected Codex home only to terminals on the window\'s machine and remembers it per pane', () => {
		const recorded = new Map<string, string | undefined>();
		const selected = paneEnvironmentFor({ launchHome: '/home/test/.codex-2', recorded }).CODEX_HOME;
		const recordedLocal = recorded.get(PANE_TOKEN);
		const remoteRecorded = new Map<string, string | undefined>();
		const remote = paneEnvironmentFor({ launchHome: '/home/test/.codex-2', remoteAuthority: 'ssh-remote+host', recorded: remoteRecorded }).CODEX_HOME;
		const localInRemoteRecorded = new Map<string, string | undefined>();
		const localInRemote = paneEnvironmentFor({ launchHome: '/home/test/.codex-2', remoteAuthority: 'ssh-remote+host', cwd: URI.file('/Users/test/project'), recorded: localInRemoteRecorded }).CODEX_HOME;
		assert.deepStrictEqual({
			selected,
			recordedLocal,
			defaultHome: paneEnvironmentFor({ launchHome: undefined }).CODEX_HOME,
			remote,
			remoteRecorded: remoteRecorded.get(PANE_TOKEN),
			localInRemote,
			localInRemoteRecorded: localInRemoteRecorded.has(PANE_TOKEN),
		}, {
			selected: '/home/test/.codex-2',
			recordedLocal: '/home/test/.codex-2',
			defaultHome: undefined,
			remote: '/home/test/.codex-2',
			remoteRecorded: '/home/test/.codex-2',
			localInRemote: undefined,
			localInRemoteRecorded: false,
		});
	});

	// Claude Code の mod（Claude Mods）は、手元で動くペインにだけ、ユーザーの値の後ろへつないで渡す。
	// 準備が済んでいない（または設定・組織の方針で使えない）ときは何も足さない。
	test('appends the Claude Code mod folder to local terminals only when it is ready', () => {
		const environmentWithMod = (directory: string | undefined, remoteAuthority?: string, explicit?: string) => {
			const service = new ParadisPaneTokenService(
				{ onDidCreateInstance: Event.None } as unknown as ITerminalInstanceService,
				{ appRoot: APP_ROOT, userDataPath: USER_DATA_PATH, execPath: `${APP_ROOT}/Para Code`, remoteAuthority } as unknown as IWorkbenchEnvironmentService,
				{ userHome: async () => URI.file('/home/test') } as unknown as IPathService,
				codexLaunchHomeStub(undefined),
				claudeModStub(directory),
			);
			const shellLaunchConfig = { shellIntegrationNonce: PANE_TOKEN, ...(explicit !== undefined ? { env: { CLAUDE_CODE_PLUGIN_DIRS: explicit } } : {}) } as IShellLaunchConfig;
			try {
				service.prepareShellLaunchConfig(shellLaunchConfig);
			} finally {
				service.dispose();
			}
			return shellLaunchConfig.env?.CLAUDE_CODE_PLUGIN_DIRS;
		};
		const mod = '/home/test/.para-code/claude-mod/0123456789abcdef';
		assert.deepStrictEqual({
			ready: environmentWithMod(mod),
			userValue: environmentWithMod(mod, undefined, '/home/test/my-mod'),
			notReady: environmentWithMod(undefined),
			remote: environmentWithMod(mod, 'ssh-remote+host'),
		}, isWindows ? { ready: undefined, userValue: '/home/test/my-mod', notReady: undefined, remote: undefined } : {
			ready: `\${env:CLAUDE_CODE_PLUGIN_DIRS}:${mod}`,
			userValue: `/home/test/my-mod:${mod}`,
			notReady: undefined,
			remote: undefined,
		});
	});
});
