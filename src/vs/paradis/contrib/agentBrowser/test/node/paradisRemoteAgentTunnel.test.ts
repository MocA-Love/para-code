/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as assert from 'assert';
import type { ChildProcess } from 'child_process';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import type { ILogService } from '../../../../../platform/log/common/log.js';
import { ParadisRemoteAgentTunnels, paradisSshHostFromAuthority } from '../../node/paradisRemoteAgentTunnel.js';

const nullLog = {
	trace: () => { }, debug: () => { }, info: () => { }, warn: () => { }, error: () => { }
} as unknown as ILogService;

/** spawn の代わり。渡された引数を記録するだけの、後始末の要らない偽プロセス。 */
function fakeSsh() {
	const calls: string[][] = [];
	let killed = 0;
	const child = {
		stderr: { on: () => { } },
		on: () => { },
		kill: () => { killed++; }
	} as unknown as ChildProcess;
	return {
		calls,
		get killed() { return killed; },
		spawn: (args: string[]) => { calls.push(args); return child; }
	};
}

suite('ParadisRemoteAgentTunnel', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	test('only accepts ssh authorities and rejects anything that could reach the ssh argv', () => {
		assert.deepStrictEqual(
			[
				paradisSshHostFromAuthority('ssh-remote+paradis-pc'),
				paradisSshHostFromAuthority('ssh-remote+user@host.local:22'),
				paradisSshHostFromAuthority('wsl+Ubuntu'),
				paradisSshHostFromAuthority('ssh-remote+-oProxyCommand=touch /tmp/pwned'),
				paradisSshHostFromAuthority('ssh-remote+host with space'),
				paradisSshHostFromAuthority('ssh-remote+'),
				paradisSshHostFromAuthority('noseparator'),
				paradisSshHostFromAuthority(undefined),
			],
			[
				'paradis-pc',
				'user@host.local:22',
				undefined,
				undefined,
				undefined,
				undefined,
				undefined,
				undefined,
			]
		);
	});

	test('opens one tunnel per host and does not stack a second one', () => {
		const ssh = fakeSsh();
		const tunnels = new ParadisRemoteAgentTunnels(nullLog, ssh.spawn);

		const first = tunnels.ensure('ssh-remote+paradis-pc', 47286);
		const second = tunnels.ensure('ssh-remote+paradis-pc', 47286);

		assert.deepStrictEqual(
			{
				first,
				second,
				spawnCount: ssh.calls.length,
				args: ssh.calls[0],
				authorities: tunnels.authorities
			},
			{
				first: true,
				second: true,
				spawnCount: 1,
				args: [
					'-N',
					'-R', '47286:127.0.0.1:47286',
					'-o', 'BatchMode=yes',
					'-o', 'ExitOnForwardFailure=yes',
					'-o', 'ServerAliveInterval=30',
					'-o', 'ServerAliveCountMax=3',
					'paradis-pc'
				],
				authorities: ['ssh-remote+paradis-pc']
			}
		);
		tunnels.dispose();
	});

	test('does not start anything for a non-ssh host or an unusable port', () => {
		const ssh = fakeSsh();
		const tunnels = new ParadisRemoteAgentTunnels(nullLog, ssh.spawn);

		assert.deepStrictEqual(
			{
				wsl: tunnels.ensure('wsl+Ubuntu', 47286),
				zeroPort: tunnels.ensure('ssh-remote+paradis-pc', 0),
				hugePort: tunnels.ensure('ssh-remote+paradis-pc', 70000),
				spawnCount: ssh.calls.length
			},
			{ wsl: false, zeroPort: false, hugePort: false, spawnCount: 0 }
		);
		tunnels.dispose();
	});

	test('closing kills the process and forgets the host', () => {
		const ssh = fakeSsh();
		const tunnels = new ParadisRemoteAgentTunnels(nullLog, ssh.spawn);
		tunnels.ensure('ssh-remote+paradis-pc', 47286);

		tunnels.close('ssh-remote+paradis-pc');

		assert.deepStrictEqual(
			{ killed: ssh.killed, authorities: tunnels.authorities },
			{ killed: 1, authorities: [] }
		);
		tunnels.dispose();
	});
});
