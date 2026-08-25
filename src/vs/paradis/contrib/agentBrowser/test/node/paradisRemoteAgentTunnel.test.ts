/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as assert from 'assert';
import { promises as fs } from 'fs';
import { tmpdir } from 'os';
import * as sinon from 'sinon';
import { join } from '../../../../../base/common/path.js';
import type { ChildProcess } from 'child_process';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import type { ILogService } from '../../../../../platform/log/common/log.js';
import { ParadisRemoteAgentTunnels, paradisShellQuote, paradisSshHostFromAuthority } from '../../node/paradisRemoteAgentTunnel.js';

const nullLog = {
	trace: () => { }, debug: () => { }, info: () => { }, warn: () => { }, error: () => { }
} as unknown as ILogService;

/** spawn の代わり。渡された引数を記録し、'error'/'close'/stderr を後から起こせる偽プロセス。 */
function fakeSsh() {
	const calls: string[][] = [];
	let killed = 0;
	const handlers = new Map<string, Array<(arg?: unknown) => void>>();
	const on = (event: string, handler: (arg?: unknown) => void) => {
		const list = handlers.get(event) ?? [];
		list.push(handler);
		handlers.set(event, list);
	};
	const emit = (event: string, arg?: unknown) => {
		for (const handler of handlers.get(event) ?? []) {
			handler(arg);
		}
	};
	const child = {
		stderr: { on: (event: string, handler: (chunk: Buffer) => void) => { if (event === 'data') { on('stderr:data', handler as (arg?: unknown) => void); } } },
		on,
		kill: () => { killed++; }
	} as unknown as ChildProcess;
	return {
		calls,
		get killed() { return killed; },
		spawn: (args: string[]) => { calls.push(args); return child; },
		/** 実際の ssh が動的ポートの割り当てを stderr へ書くのを模す。 */
		emitAllocatedPort: (port: number) => emit('stderr:data', Buffer.from(`Allocated port ${port} for remote forward to 127.0.0.1:47286\n`)),
		/** 'error'（spawn 失敗など）や 'close' を模す。実際の ssh は spawn 失敗時 'exit' を出さないことがある。 */
		emit,
	};
}

suite('ParadisRemoteAgentTunnel', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	test('only accepts ssh authorities and rejects anything that could reach the ssh argv', () => {
		assert.deepStrictEqual(
			[
				paradisSshHostFromAuthority('ssh-remote+dev-pc'),
				paradisSshHostFromAuthority('ssh-remote+user@host.local:22'),
				paradisSshHostFromAuthority('wsl+Ubuntu'),
				paradisSshHostFromAuthority('ssh-remote+-oProxyCommand=touch /tmp/pwned'),
				paradisSshHostFromAuthority('ssh-remote+host with space'),
				paradisSshHostFromAuthority('ssh-remote+'),
				paradisSshHostFromAuthority('noseparator'),
				paradisSshHostFromAuthority(undefined),
			],
			[
				'dev-pc',
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

	test('opens one tunnel per host with a dynamic remote port, and shares the resolved port with later callers', async () => {
		const ssh = fakeSsh();
		const tunnels = new ParadisRemoteAgentTunnels(nullLog, ssh.spawn);

		const first = tunnels.ensure('ssh-remote+dev-pc', 47286);
		const second = tunnels.ensure('ssh-remote+dev-pc', 47286);
		ssh.emitAllocatedPort(51234);

		assert.deepStrictEqual(
			{
				first: await first,
				second: await second,
				spawnCount: ssh.calls.length,
				args: ssh.calls[0],
				authorities: tunnels.authorities
			},
			{
				// 固定番号ではなく、接続先の sshd に選ばせた番号（同じホストへの他ユーザーの
				// 接続と衝突しない）が両方の呼び出しへ返る
				first: 51234,
				second: 51234,
				spawnCount: 1,
				args: [
					'-N',
					'-R', '0:127.0.0.1:47286',
					'-o', 'BatchMode=yes',
					'-o', 'ExitOnForwardFailure=yes',
					'-o', 'LogLevel=INFO',
					'-o', 'ServerAliveInterval=30',
					'-o', 'ServerAliveCountMax=3',
					'dev-pc'
				],
				authorities: ['ssh-remote+dev-pc']
			}
		);
		// 番号が既に分かっていれば、以後の呼び出しは新しく ssh を起こさない
		assert.strictEqual(await tunnels.ensure('ssh-remote+dev-pc', 47286), 51234);
		assert.strictEqual(ssh.calls.length, 1);
		tunnels.dispose();
	});

	test('does not start anything for a non-ssh host or an unusable port', async () => {
		const ssh = fakeSsh();
		const tunnels = new ParadisRemoteAgentTunnels(nullLog, ssh.spawn);

		assert.deepStrictEqual(
			{
				wsl: await tunnels.ensure('wsl+Ubuntu', 47286),
				zeroPort: await tunnels.ensure('ssh-remote+dev-pc', 0),
				hugePort: await tunnels.ensure('ssh-remote+dev-pc', 70000),
				spawnCount: ssh.calls.length
			},
			{ wsl: undefined, zeroPort: undefined, hugePort: undefined, spawnCount: 0 }
		);
		tunnels.dispose();
	});

	test('closing kills the process, forgets the host, and settles a still-pending caller', async () => {
		const ssh = fakeSsh();
		const tunnels = new ParadisRemoteAgentTunnels(nullLog, ssh.spawn);
		const pending = tunnels.ensure('ssh-remote+dev-pc', 47286);

		tunnels.close('ssh-remote+dev-pc');

		assert.deepStrictEqual(
			{ killed: ssh.killed, authorities: tunnels.authorities, resolved: await pending },
			{ killed: 1, authorities: [], resolved: undefined }
		);
		tunnels.dispose();
	});

	test('settles the pending caller and marks the destination exhausted when spawn throws synchronously', async () => {
		const calls: string[][] = [];
		const throwingSpawn = (args: string[]) => { calls.push(args); throw new Error('spawn boom'); };
		const tunnels = new ParadisRemoteAgentTunnels(nullLog, throwingSpawn);

		assert.strictEqual(await tunnels.ensure('ssh-remote+dev-pc', 47286), undefined);
		// 使い切った直後はクールダウン中。新しく spawn を試さずに即 undefined を返す
		assert.strictEqual(await tunnels.ensure('ssh-remote+dev-pc', 47286), undefined);
		assert.strictEqual(calls.length, 1);
		tunnels.dispose();
	});

	test('drops the resolved port and retries on a close event, even though exit never fires', async () => {
		// 実際の ssh は spawn 失敗や切断で 'error' は出すが 'exit' は出さないことがある
		// （'close' は必ず出る）。'exit' だけを見ていると、死んだ番号がそのまま配られ続ける
		const ssh = fakeSsh();
		const tunnels = new ParadisRemoteAgentTunnels(nullLog, ssh.spawn);

		const first = tunnels.ensure('ssh-remote+dev-pc', 47286);
		ssh.emitAllocatedPort(51234);
		assert.strictEqual(await first, 51234);

		ssh.emit('error', new Error('connection reset'));
		ssh.emit('close', null);

		// 死んだ番号をそのまま返してはいけない。再試行が決着するまで待たせるのが正しい
		// （'close' を購読していないと remotePort が古いまま残り、ここが即 51234 に解決される）
		const sentinel = Symbol('still-pending');
		const after = tunnels.ensure('ssh-remote+dev-pc', 47286);
		const raced = await Promise.race([after, Promise.resolve(sentinel)]);
		assert.strictEqual(raced, sentinel);
		tunnels.dispose();
	});

	/** 呼び出しごとに独立した偽の子プロセス。'stderr:data'/'close'/'exit' を後から起こせる。 */
	function fakeControlChild() {
		const handlers = new Map<string, Array<(arg?: unknown) => void>>();
		const on = (event: string, handler: (arg?: unknown) => void) => {
			handlers.set(event, [...(handlers.get(event) ?? []), handler]);
		};
		const child = {
			stderr: { on: (event: string, handler: (chunk: Buffer) => void) => { if (event === 'data') { on('stderr:data', handler as (arg?: unknown) => void); } } },
			stdout: { on: () => { } },
			on,
			kill: () => { }
		} as unknown as ChildProcess;
		return {
			child,
			emit: (event: string, arg?: unknown) => {
				for (const handler of [...(handlers.get(event) ?? [])]) {
					handler(arg);
				}
			},
		};
	}

	/**
	 * `-O` の要求だけ「成功して終了」を返す偽 ssh（戻り経路の常駐プロセスは生かしたまま）。
	 * @param options.deferForwardExit `-O` の返事を自動で返さず、`settleControlRequests()` を待つ
	 */
	function fakeSshWithControl(options?: { readonly deferForwardExit?: boolean }) {
		const calls: string[][] = [];
		const masters: Array<ReturnType<typeof fakeControlChild>> = [];
		const pendingControlExits: Array<() => void> = [];
		const spawn = (args: string[]) => {
			calls.push(args);
			const entry = fakeControlChild();
			if (args.includes('-O')) {
				const settle = () => entry.emit('exit', 0);
				if (options?.deferForwardExit === true) {
					pendingControlExits.push(settle);
				} else {
					queueMicrotask(settle);
				}
			} else {
				masters.push(entry);
			}
			return entry.child;
		};
		return {
			calls,
			spawn,
			/** 実際の ssh が動的ポートの割り当てを stderr へ書くのを模す（最後に起こしたマスター）。 */
			allocatePort: (port: number) => masters[masters.length - 1]
				.emit('stderr:data', Buffer.from(`Allocated port ${port} for remote forward to 127.0.0.1:47286\n`)),
			/** マスターが落ちたことを模す（切断・鍵の失効など）。 */
			closeMaster: () => masters[masters.length - 1].emit('close', 1),
			/** 溜めておいた `-O` の返事をまとめて返す。 */
			settleControlRequests: () => {
				for (const settle of pendingControlExits.splice(0)) {
					settle();
				}
			},
		};
	}

	test('rides the tunnel already open instead of dialling once per pane', async () => {
		const ssh = fakeSshWithControl();
		const dir = await fs.mkdtemp(join(tmpdir(), 'paradis-codex-sock-'));
		const tunnels = new ParadisRemoteAgentTunnels(nullLog, ssh.spawn, dir);
		try {
			tunnels.ensure('ssh-remote+dev-pc', 47286);
			tunnels.syncSocketForwards('window:1', 'ssh-remote+dev-pc', new Map([[join(dir, 'a.sock'), '/home/u/.para-code/pcx/a.sock']]));
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
				forwarded: [['-O', 'forward', '-L', `${join(dir, 'a.sock')}:/home/u/.para-code/pcx/a.sock`, 'dev-pc']],
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
			tunnels.ensure('ssh-remote+dev-pc', 47286);
			tunnels.syncSocketForwards('window:1', 'ssh-remote+dev-pc', new Map([[a, '/home/u/.para-code/pcx/a.sock']]));
			tunnels.syncSocketForwards('window:2', 'ssh-remote+dev-pc', new Map([[b, '/home/u/.para-code/pcx/b.sock']]));
			await new Promise<void>(resolve => queueMicrotask(resolve));

			// 2枚目のウィンドウがペインを閉じても、1枚目の転送は生きていなければならない
			tunnels.syncSocketForwards('window:2', 'ssh-remote+dev-pc', new Map());
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
			tunnels.syncSocketForwards('window:1', 'ssh-remote+dev-pc', new Map([[join(dir, 'a.sock'), '/home/u/.para-code/pcx/a.sock']]));
			assert.deepStrictEqual(ssh.calls, []);
		} finally {
			tunnels.dispose();
			await fs.rm(dir, { recursive: true, force: true });
		}
	});

	test('keeps the tunnel up until the last window that asked for it lets go', async () => {
		// 同じホストへ2枚開いているとき、1枚閉じただけで畳むと残った側の hook が黙って死ぬ
		const ssh = fakeSsh();
		const tunnels = new ParadisRemoteAgentTunnels(nullLog, ssh.spawn);

		const first = tunnels.ensure('ssh-remote+dev-pc', 47286, 'window:1');
		const second = tunnels.ensure('ssh-remote+dev-pc', 47286, 'window:2');
		ssh.emitAllocatedPort(51234);
		await Promise.all([first, second]);

		tunnels.close('ssh-remote+dev-pc', 'window:1');
		const afterFirst = { killed: ssh.killed, authorities: [...tunnels.authorities] };
		tunnels.close('ssh-remote+dev-pc', 'window:2');

		assert.deepStrictEqual(
			{ afterFirst, afterLast: { killed: ssh.killed, authorities: [...tunnels.authorities] }, spawnCount: ssh.calls.length },
			{
				afterFirst: { killed: 0, authorities: ['ssh-remote+dev-pc'] },
				afterLast: { killed: 1, authorities: [] },
				spawnCount: 1,
			}
		);
		tunnels.dispose();
	});

	test('re-opens the Codex socket forwards after the ssh master is replaced', async () => {
		// 新しいマスターは旧マスターの `-L` を何も引き継いでいない。希望一覧の差分を基準にすると
		// 「前回と同じ希望」で差分ゼロになり、誰も張り直さないままペインが黙って死ぬ
		const clock = sinon.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
		const ssh = fakeSshWithControl();
		const dir = await fs.mkdtemp(join(tmpdir(), 'paradis-codex-sock-'));
		const tunnels = new ParadisRemoteAgentTunnels(nullLog, ssh.spawn, dir);
		try {
			const a = join(dir, 'a.sock');
			tunnels.ensure('ssh-remote+dev-pc', 47286, 'window:1');
			ssh.allocatePort(51234);
			tunnels.syncSocketForwards('window:1', 'ssh-remote+dev-pc', new Map([[a, '/home/u/.para-code/pcx/a.sock']]));
			await new Promise<void>(resolve => queueMicrotask(resolve));
			const beforeReconnect = ssh.calls.filter(args => args.includes('forward')).length;

			ssh.closeMaster();
			clock.tick(5000); // 張り直しまでの待ち時間
			ssh.allocatePort(51235);
			await new Promise<void>(resolve => queueMicrotask(resolve));

			assert.deepStrictEqual({
				beforeReconnect,
				afterReconnect: ssh.calls.filter(args => args.includes('forward')).map(args => args[args.indexOf('-L') + 1]),
				masters: ssh.calls.filter(args => args.includes('-M')).length,
			}, {
				beforeReconnect: 1,
				afterReconnect: [`${a}:/home/u/.para-code/pcx/a.sock`, `${a}:/home/u/.para-code/pcx/a.sock`],
				masters: 2,
			});
		} finally {
			tunnels.dispose();
			clock.restore();
			await fs.rm(dir, { recursive: true, force: true });
		}
	});

	test('cancels a forward whose reply lands after the pane that wanted it went away', async () => {
		// 返事待ちの転送は「張れている一覧」にまだ載っていないため、取り下げループから漏れる
		const ssh = fakeSshWithControl({ deferForwardExit: true });
		const dir = await fs.mkdtemp(join(tmpdir(), 'paradis-codex-sock-'));
		const tunnels = new ParadisRemoteAgentTunnels(nullLog, ssh.spawn, dir);
		try {
			const a = join(dir, 'a.sock');
			tunnels.ensure('ssh-remote+dev-pc', 47286, 'window:1');
			tunnels.syncSocketForwards('window:1', 'ssh-remote+dev-pc', new Map([[a, '/home/u/.para-code/pcx/a.sock']]));
			tunnels.syncSocketForwards('window:1', 'ssh-remote+dev-pc', new Map());
			ssh.settleControlRequests();

			assert.deepStrictEqual(
				ssh.calls.filter(args => args.includes('cancel')).map(args => args[args.indexOf('-L') + 1]),
				[`${a}:/home/u/.para-code/pcx/a.sock`],
			);
		} finally {
			// 溜めたままの `-O` は打ち切り待ちのタイマーを抱えている。返事を返して片付ける
			ssh.settleControlRequests();
			tunnels.dispose();
			await fs.rm(dir, { recursive: true, force: true });
		}
	});

	test('lets go of everything a destroyed window owned without waiting for its goodbye', async () => {
		// 取り下げの知らせはウィンドウの dispose から投げっぱなしなので、クラッシュでは届かない。
		// 残ったままだと、次に同じホストへ繋いだ別のウィンドウが死んだペインのソケットまで張り直す
		const ssh = fakeSshWithControl();
		const dir = await fs.mkdtemp(join(tmpdir(), 'paradis-codex-sock-'));
		const tunnels = new ParadisRemoteAgentTunnels(nullLog, ssh.spawn, dir);
		try {
			const a = join(dir, 'a.sock');
			tunnels.ensure('ssh-remote+dev-pc', 47286, 'window:1');
			ssh.allocatePort(51234);
			tunnels.syncSocketForwards('window:1', 'ssh-remote+dev-pc', new Map([[a, '/home/u/.para-code/pcx/a.sock']]));
			await new Promise<void>(resolve => queueMicrotask(resolve));

			tunnels.releaseWindow('window:1');
			tunnels.ensure('ssh-remote+dev-pc', 47286, 'window:2');
			ssh.allocatePort(51235);
			await new Promise<void>(resolve => queueMicrotask(resolve));

			assert.deepStrictEqual({
				cancelled: ssh.calls.filter(args => args.includes('cancel')).map(args => args[args.indexOf('-L') + 1]),
				forwards: ssh.calls.filter(args => args.includes('forward')).length,
				authorities: [...tunnels.authorities],
			}, {
				cancelled: [`${a}:/home/u/.para-code/pcx/a.sock`],
				// 死んだウィンドウの希望は消えているので、新しいウィンドウの接続では張り直されない
				forwards: 1,
				authorities: ['ssh-remote+dev-pc'],
			});
		} finally {
			tunnels.dispose();
			await fs.rm(dir, { recursive: true, force: true });
		}
	});
});

suite('paradisShellQuote', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	test('wraps values so the login shell on the host treats them as one word', () => {
		// ssh はホスト名より後ろの引数を空白で繋いで送り、接続先の sshd がログインシェルへ渡す。
		// argv へ分けても単語分割は防げないので、ここでクォートしないとスペース入りのホームで壊れる
		assert.deepStrictEqual(
			[
				paradisShellQuote('/Users/john doe/.para-code/notify-v1.sh'),
				paradisShellQuote(`/tmp/it's here/x`),
				paradisShellQuote('/tmp/$(touch pwned);rm -rf ~'),
			],
			[
				`'/Users/john doe/.para-code/notify-v1.sh'`,
				`'/tmp/it'\\''s here/x'`,
				`'/tmp/$(touch pwned);rm -rf ~'`,
			]
		);
	});
});
