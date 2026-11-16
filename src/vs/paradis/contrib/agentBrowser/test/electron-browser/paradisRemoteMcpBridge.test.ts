/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import assert from 'assert';
import { OperatingSystem } from '../../../../../base/common/platform.js';
import { URI } from '../../../../../base/common/uri.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { IFileService } from '../../../../../platform/files/common/files.js';
import { IRemoteAgentEnvironment } from '../../../../../platform/remote/common/remoteAgentEnvironment.js';
import { paradisAntigravityRemoteMcpServerEntry } from '../../common/paradisMcpSetupEncoding.js';
import { paradisRemoteNativePath, paradisResolveRemoteMcpBridge } from '../../electron-browser/paradisRemoteMcpBridge.js';

const APP_ROOT = URI.from({ scheme: 'vscode-remote', authority: 'ssh-remote+host', path: '/home/example/.para-code-server/bin/abc' });
const SHIM = URI.joinPath(APP_ROOT, 'out', 'vs', 'paradis', 'contrib', 'agentBrowser', 'node', 'paradisBrowserMcpShim.js');

function environment(execPath: string, os: OperatingSystem = OperatingSystem.Linux, appRoot: URI = APP_ROOT): IRemoteAgentEnvironment {
	return { appRoot, execPath, os } as unknown as IRemoteAgentEnvironment;
}

function fileService(existing: readonly URI[]): IFileService {
	return { exists: async (uri: URI) => existing.some(candidate => candidate.toString() === uri.toString()) } as unknown as IFileService;
}

suite('paradisRemoteMcpBridge', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	test('uses the server node and the shim the server ships, and gives up when either is missing', async () => {
		const resolved = await paradisResolveRemoteMcpBridge(async () => environment('/home/example/.para-code-server/bin/abc/node'), fileService([SHIM]));
		assert.deepStrictEqual({
			resolved,
			entry: resolved && paradisAntigravityRemoteMcpServerEntry(resolved),
			oldServer: await paradisResolveRemoteMcpBridge(async () => environment('/home/example/.para-code-server/bin/abc/node'), fileService([])),
			noEnvironment: await paradisResolveRemoteMcpBridge(async () => null, fileService([SHIM])),
			failedEnvironment: await paradisResolveRemoteMcpBridge(async () => { throw new Error('offline'); }, fileService([SHIM])),
		}, {
			resolved: { node: '/home/example/.para-code-server/bin/abc/node', shimPath: SHIM.path },
			entry: { command: '/home/example/.para-code-server/bin/abc/node', args: [SHIM.path, '--para-ssh-tunnel'] },
			oldServer: undefined,
			noEnvironment: undefined,
			failedEnvironment: undefined,
		});
	});

	test('writes the shim path the way the host operating system spells it', () => {
		const windowsShim = URI.from({ scheme: 'vscode-remote', authority: 'ssh-remote+host', path: '/c:/Users/example/.para-code-server/out/shim.js' });
		assert.deepStrictEqual({
			linux: paradisRemoteNativePath(SHIM, OperatingSystem.Linux),
			windows: paradisRemoteNativePath(windowsShim, OperatingSystem.Windows),
		}, {
			linux: SHIM.path,
			windows: 'c:\\Users\\example\\.para-code-server\\out\\shim.js',
		});
	});
});
