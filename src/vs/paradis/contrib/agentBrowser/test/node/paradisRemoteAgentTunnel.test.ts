/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as assert from 'assert';
import { promises as fs } from 'fs';
import { tmpdir } from 'os';
import { join } from '../../../../../base/common/path.js';
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

	/** `-O` の要求だけ「成功して終了」を返す偽 ssh（戻り経路の常駐プロセスは生かしたまま）。 */
	function fakeSshWithControl() {
		const calls: string[][] = [];
		const spawn = (args: string[]) => {
			calls.push(args);
			const handlers = new Map<string, (code: number) => void>();
			const child = {
				stderr: { on: () => { } },
				on: (event: string, handler: (code: number) => void) => { handlers.set(event, handler); },
				kill: () => { }
			} as unknown as ChildProcess;
			if (args.includes('-O')) {
				queueMicrotask(() => handlers.get('exit')?.(0));
			}
			return child;
		};
		return { calls, spawn };
	}

	test('rides the tunnel already open instead of dialling once per pane', async () => {
		const ssh = fakeSshWithControl();
		const dir = await fs.mkdtemp(join(tmpdir(), 'paradis-codex-sock-'));
		const tunnels = new ParadisRemoteAgentTunnels(nullLog, ssh.spawn, dir);
		try {
			tunnels.ensure('ssh-remote+paradis-pc', 47286);
			tunnels.syncSocketForwards('window:1', 'ssh-remote+paradis-pc', new Map([[join(dir, 'a.sock'), '/home/u/.para-code/pcx/a.sock']]));
			await new Promise<void>(resolve => queueMicrotask(resolve));

			const connections = ssh.calls.filter(args => !args.includes('-O'));
			assert.deepStrictEqual({
				// ペインが増えても新しい接続は起こさない。増えるのは制御要求だけ
				connections: connections.length,
				master: connections[0].includes('-M'),
				forwarded: ssh.calls.filter(args => args.includes('-O')).map(args => args.slice(args.indexOf('-O'))),
			}, {
				connections: 1,
				master: true,
				forwarded: [['-O', 'forward', '-L', `${join(dir, 'a.sock')}:/home/u/.para-code/pcx/a.sock`, 'paradis-pc']],
			});
		} finally {
			tunnels.dispose();
			await fs.rm(dir, { recursive: true, force: true });
		}
	});

	test('leaves another window\'s forwards alone when one window drops its own', async () => {
		const ssh = fakeSshWithControl();
		const dir = await fs.mkdtemp(join(tmpdir(), 'paradis-codex-sock-'));
		const tunnels = new ParadisRemoteAgentTunnels(nullLog, ssh.spawn, dir);
		try {
			const a = join(dir, 'a.sock');
			const b = join(dir, 'b.sock');
			tunnels.ensure('ssh-remote+paradis-pc', 47286);
			tunnels.syncSocketForwards('window:1', 'ssh-remote+paradis-pc', new Map([[a, '/home/u/.para-code/pcx/a.sock']]));
			tunnels.syncSocketForwards('window:2', 'ssh-remote+paradis-pc', new Map([[b, '/home/u/.para-code/pcx/b.sock']]));
			await new Promise<void>(resolve => queueMicrotask(resolve));

			// 2枚目のウィンドウがペインを閉じても、1枚目の転送は生きていなければならない
			tunnels.syncSocketForwards('window:2', 'ssh-remote+paradis-pc', new Map());
			await new Promise<void>(resolve => queueMicrotask(resolve));

			assert.deepStrictEqual(
				ssh.calls.filter(args => args.includes('cancel')).map(args => args[args.indexOf('-L') + 1]),
				[`${b}:/home/u/.para-code/pcx/b.sock`],
			);
		} finally {
			tunnels.dispose();
			await fs.rm(dir, { recursive: true, force: true });
		}
	});

	test('does not forward anything when no tunnel is open', async () => {
		const ssh = fakeSshWithControl();
		const dir = await fs.mkdtemp(join(tmpdir(), 'paradis-codex-sock-'));
		const tunnels = new ParadisRemoteAgentTunnels(nullLog, ssh.spawn, dir);
		try {
			// 戻り経路が設定で切られている／まだ張れていない状態。勝手に ssh を起こさない
			tunnels.syncSocketForwards('window:1', 'ssh-remote+paradis-pc', new Map([[join(dir, 'a.sock'), '/home/u/.para-code/pcx/a.sock']]));
			assert.deepStrictEqual(ssh.calls, []);
		} finally {
			tunnels.dispose();
			await fs.rm(dir, { recursive: true, force: true });
		}
	});
});
