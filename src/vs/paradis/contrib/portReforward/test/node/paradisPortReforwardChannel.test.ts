/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import assert from 'assert';
import { URI } from '../../../../../base/common/uri.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { NullLogService } from '../../../../../platform/log/common/log.js';
import { ISharedTunnelsService } from '../../../../../platform/tunnel/common/tunnel.js';
import { ParadisSharedTunnelsService } from '../../../../../platform/tunnel/node/paradisSharedTunnelsService.js';
import { PARADIS_PORT_REFORWARD_FORCE_CLOSE } from '../../common/paradisPortReforward.js';
import { IParadisWindowWorkspaces, ParadisPortReforwardChannel } from '../../node/paradisPortReforward.sharedProcess.js';

suite('ParadisPortReforwardChannel', () => {

	ensureNoDisposablesAreLeakedInTestSuite();

	/** Stands in for the fork service and records what it was asked to close. */
	function createTunnels(closed: string[]): ISharedTunnelsService {
		const tunnels = Object.create(ParadisSharedTunnelsService.prototype) as ParadisSharedTunnelsService;
		tunnels.forceCloseTunnel = async (authority, remoteHost, remotePort) => {
			closed.push(`${authority} ${remoteHost}:${remotePort}`);
			return true;
		};
		return tunnels;
	}

	const windows: IParadisWindowWorkspaces = {
		getWindows: async () => [
			{ id: 1, workspace: { id: 'a', uri: URI.from({ scheme: 'vscode-remote', authority: 'ssh-remote+box', path: '/home/user/project' }) } },
			{ id: 2, workspace: { id: 'b', configPath: URI.from({ scheme: 'vscode-remote', authority: 'ssh-remote+other', path: '/home/user/x.code-workspace' }).toJSON() } },
			{ id: 3, workspace: { id: 'empty' } },
			{ id: 4, workspace: { id: 'c', uri: URI.file('/home/user/local-project') } },
		],
	};

	async function callFrom(ctx: string, authority: string): Promise<string> {
		const closed: string[] = [];
		const channel = new ParadisPortReforwardChannel<string>(createTunnels(closed), windows, new NullLogService());
		try {
			await channel.call(ctx, PARADIS_PORT_REFORWARD_FORCE_CLOSE, { authority, remoteHost: 'localhost', remotePort: 3000 });
			return closed.join(', ') || 'nothing closed';
		} catch (err) {
			return `refused: ${(err as Error).message}`;
		}
	}

	test('closes only for the remote of the window that asked', async () => {
		assert.deepStrictEqual(
			{
				ownRemote: await callFrom('window:1', 'ssh-remote+box'),
				otherRemote: await callFrom('window:1', 'ssh-remote+other'),
				ownRemoteFromWorkspaceFile: await callFrom('window:2', 'ssh-remote+other'),
				emptyWindow: await callFrom('window:3', 'ssh-remote+box'),
				unknownWindow: await callFrom('window:9', 'ssh-remote+box'),
				localWindow: await callFrom('window:4', 'ssh-remote+box'),
				notAWindow: await callFrom('main', 'ssh-remote+box'),
			},
			{
				ownRemote: 'ssh-remote+box localhost:3000',
				otherRemote: 'refused: The remote is not the one of the calling window',
				ownRemoteFromWorkspaceFile: 'ssh-remote+other localhost:3000',
				emptyWindow: 'ssh-remote+box localhost:3000',
				unknownWindow: 'refused: The remote is not the one of the calling window',
				localWindow: 'refused: The remote is not the one of the calling window',
				notAWindow: 'refused: The remote is not the one of the calling window',
			}
		);
	});
});
