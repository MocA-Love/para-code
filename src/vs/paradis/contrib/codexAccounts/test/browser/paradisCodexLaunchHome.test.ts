/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import assert from 'assert';
import { URI } from '../../../../../base/common/uri.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { paradisTerminalRunsOnWindowHost } from '../../browser/paradisCodexLaunchHomeService.js';

suite('Paradis Codex launch home', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	// 選択はウィンドウのマシンのホームを指すので、別のマシンで動くターミナルへは渡さない。
	test('passes the selection only to terminals that run on the same machine as the window', () => {
		const remote = 'ssh-remote+host';
		const remoteCwd = URI.from({ scheme: 'vscode-remote', authority: remote, path: '/home/example/project' });
		const localCwd = URI.file('/Users/example/project');
		assert.deepStrictEqual({
			localWindow: paradisTerminalRunsOnWindowHost(undefined, undefined),
			localWindowLocalCwd: paradisTerminalRunsOnWindowHost(localCwd, undefined),
			localWindowStringCwd: paradisTerminalRunsOnWindowHost('/tmp', undefined),
			remoteWindow: paradisTerminalRunsOnWindowHost(undefined, remote),
			remoteWindowRemoteCwd: paradisTerminalRunsOnWindowHost(remoteCwd, remote),
			remoteWindowStringCwd: paradisTerminalRunsOnWindowHost('/home/example', remote),
			remoteWindowLocalTerminal: paradisTerminalRunsOnWindowHost(localCwd, remote),
			otherHost: paradisTerminalRunsOnWindowHost(remoteCwd, 'ssh-remote+other'),
		}, {
			localWindow: true,
			localWindowLocalCwd: true,
			localWindowStringCwd: true,
			remoteWindow: true,
			remoteWindowRemoteCwd: true,
			remoteWindowStringCwd: true,
			remoteWindowLocalTerminal: false,
			otherHost: false,
		});
	});
});
