/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import assert from 'assert';
import { URI } from '../../../../../base/common/uri.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { IShellLaunchConfig, TerminalLocation } from '../../../../../platform/terminal/common/terminal.js';
import { paradisIsIdleEmptyShell, paradisIsTerminalSharedPanelEnabled, paradisResolveSharedPanelCwd, paradisShouldApplySharedPanelCwd } from '../../common/paradisTerminalSharedPanel.js';

suite('paradisTerminalSharedPanel', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	test('resolves the start folder from the setting, relative to the home folder of the connected machine', () => {
		const localHome = URI.file('/Users/example');
		const remoteHome = URI.from({ scheme: 'vscode-remote', authority: 'ssh-remote+host', path: '/home/example' });
		const resolve = (configured: unknown, home: URI) => paradisResolveSharedPanelCwd(configured, home).toString();

		assert.deepStrictEqual({
			empty: resolve('', localHome),
			unset: resolve(undefined, localHome),
			tilde: resolve('~', localHome),
			tildeChild: resolve('~/projects', localHome),
			absolute: resolve('/opt/work', localHome),
			relative: resolve('projects/demo', localHome),
			remoteAbsolute: resolve('/srv/app', remoteHome),
			remoteTildeChild: resolve('~/src', remoteHome),
		}, {
			empty: 'file:///Users/example',
			unset: 'file:///Users/example',
			tilde: 'file:///Users/example',
			tildeChild: 'file:///Users/example/projects',
			absolute: 'file:///opt/work',
			relative: 'file:///Users/example/projects/demo',
			remoteAbsolute: 'vscode-remote://ssh-remote%2Bhost/srv/app',
			remoteTildeChild: 'vscode-remote://ssh-remote%2Bhost/home/example/src',
		});
	});

	test('only fills the start folder of a new panel shell that nobody placed yet', () => {
		const applies = (config: IShellLaunchConfig, target = TerminalLocation.Panel) => paradisShouldApplySharedPanelCwd(config, target);
		assert.deepStrictEqual({
			newPanelShell: applies({}),
			editorShell: applies({}, TerminalLocation.Editor),
			explicitCwd: applies({ cwd: '/tmp' }),
			task: applies({ type: 'Task' }),
			extension: applies({ isExtensionOwnedTerminal: true }),
			feature: applies({ isFeatureTerminal: true }),
			hidden: applies({ hideFromUser: true }),
			enabledByDefault: paradisIsTerminalSharedPanelEnabled(undefined),
			disabled: paradisIsTerminalSharedPanelEnabled(false),
		}, {
			newPanelShell: true,
			editorShell: false,
			explicitCwd: false,
			task: false,
			extension: false,
			feature: false,
			hidden: false,
			enabledByDefault: true,
			disabled: false,
		});
	});

	// 閉じると戻せないので、どれか1つでも「使われた」「分からない」なら閉じない。
	test('treats only a never-used, idle, plain shell as an empty shell to close', () => {
		const idle = { hasShellIntegration: true, hasChildProcesses: false, commandCount: 0, isExecuting: false, hasPendingInput: false, title: 'zsh' };
		assert.deepStrictEqual({
			idle: paradisIsIdleEmptyShell(idle),
			windowsShell: paradisIsIdleEmptyShell({ ...idle, title: 'pwsh.exe' }),
			noShellIntegration: paradisIsIdleEmptyShell({ ...idle, hasShellIntegration: false }),
			childProcess: paradisIsIdleEmptyShell({ ...idle, hasChildProcesses: true }),
			ranCommands: paradisIsIdleEmptyShell({ ...idle, commandCount: 1 }),
			executing: paradisIsIdleEmptyShell({ ...idle, isExecuting: true }),
			typing: paradisIsIdleEmptyShell({ ...idle, hasPendingInput: true }),
			// 繋ぎ直した直後は子プロセスが「無し」に見えるので、見出しでも確かめる。
			agentTitle: paradisIsIdleEmptyShell({ ...idle, title: 'Fix the login flow' }),
			renamed: paradisIsIdleEmptyShell({ ...idle, title: 'server' }),
		}, {
			idle: true,
			windowsShell: true,
			noShellIntegration: false,
			childProcess: false,
			ranCommands: false,
			executing: false,
			typing: false,
			agentTitle: false,
			renamed: false,
		});
	});
});
