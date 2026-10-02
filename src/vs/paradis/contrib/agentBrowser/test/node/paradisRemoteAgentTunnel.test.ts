/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.


import * as assert from 'assert';
import * as sinon from 'sinon';
import type { ChildProcess } from 'child_process';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import type { ILogService } from '../../../../../platform/log/common/log.js';
import { computeCandidateRemotePort, ParadisRemoteAgentTunnels, paradisShellQuote, paradisSshHostFromAuthority } from '../../node/paradisRemoteAgentTunnel.js';

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
	// 実装のハンドラは同期的に次の start() を呼びうる（retryImmediately 経路）。その中で
	// 同じイベントへ新しいハンドラが登録されるので、走査中の配列そのものではなく
	// スナップショットを回す（でないと、その場で登録された次世代のハンドラまで巻き込んで
	// 発火してしまい、1回の emit のつもりが2試行分を同時に進めてしまう）
	const emit = (event: string, arg?: unknown) => {
		for (const handler of [...(handlers.get(event) ?? [])]) {
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
		/** 決定的候補が他の誰かに使われていて弾かれたことを stderr へ書くのを模す。 */
		emitFixedPortTaken: (port: number) => emit('stderr:data', Buffer.from(`remote port forwarding failed for listen port ${port}\n`)),
		/** 決定的候補で張れたことを LogLevel=DEBUG1 の出力として模す。 */
		emitFixedPortSuccess: (port: number) => emit('stderr:data', Buffer.from(`debug1: remote forward success for: listen ${port}, connect 127.0.0.1:47286\n`)),
		/** 'error'（spawn 失敗など）や 'close' を模す。実際の ssh は spawn 失敗時 'exit' を出さないことがある。 */
		emit,
	};
}

/** 呼び出しごとに独立した偽の子プロセス。'stderr:data'/'close'/'exit' を後から起こせる。 */
function fakeControlChild() {
	const handlers = new Map<string, Array<(arg?: unknown) => void>>();
	let killed = 0;
	const on = (event: string, handler: (arg?: unknown) => void) => {
		handlers.set(event, [...(handlers.get(event) ?? []), handler]);
	};
	const child = {
		stderr: { on: (event: string, handler: (chunk: Buffer) => void) => { if (event === 'data') { on('stderr:data', handler as (arg?: unknown) => void); } } },
		stdout: { on: () => { } },
		on,
		kill: () => { killed++; }
	} as unknown as ChildProcess;
	return {
		child,
		get killed() { return killed; },
		emit: (event: string, arg?: unknown) => {
			for (const handler of [...(handlers.get(event) ?? [])]) {
				handler(arg);
			}
		},
	};
}

/**
 * `fakeSsh()` は単一の子プロセスを使い回すため、close → 張り直しを何度もまたぐテストには
 * 使えない（古い試行の 'close'/'stderr' ハンドラが積み上がったまま残り、1回の emit で全部の
 * 試行が同時に反応してしまう）。呼び出しごとに独立した子プロセスを返す spawn を使う。
 */
function fakeSshPerCall() {
	const calls: string[][] = [];
	const children: Array<ReturnType<typeof fakeControlChild>> = [];
	const spawn = (args: string[]) => {
		calls.push(args);
		const entry = fakeControlChild();
		children.push(entry);
		return entry.child;
	};
	const latest = () => children[children.length - 1];
	return {
		calls,
		spawn,
		emitAllocatedPort: (port: number) => latest().emit('stderr:data', Buffer.from(`Allocated port ${port} for remote forward to 127.0.0.1:47286\n`)),
		emitFixedPortTaken: (port: number) => latest().emit('stderr:data', Buffer.from(`remote port forwarding failed for listen port ${port}\n`)),
		emitFixedPortSuccess: (port: number) => latest().emit('stderr:data', Buffer.from(`debug1: remote forward success for: listen ${port}, connect 127.0.0.1:47286\n`)),
		/** 最後に起こした試行を終了させる。 */
		closeLatest: (code: number | null) => latest().emit('close', code),
		/** それぞれの試行が実際に kill されたか（確認が来ないまま時間切れになった、等）。 */
		get killedCounts() { return children.map(c => c.killed); },
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

	test('opens one tunnel per host with a deterministic preferred remote port, and shares the resolved port with later callers', async () => {
		const ssh = fakeSsh();
		const tunnels = new ParadisRemoteAgentTunnels(nullLog, ssh.spawn);
		try {
			const preferredPort = computeCandidateRemotePort('dev-pc');
			const first = tunnels.ensure('ssh-remote+dev-pc', 47286);
			const second = tunnels.ensure('ssh-remote+dev-pc', 47286);
			ssh.emitFixedPortSuccess(preferredPort);

			assert.deepStrictEqual(
				{
					first: await first,
					second: await second,
					spawnCount: ssh.calls.length,
					args: ssh.calls[0],
					authorities: tunnels.authorities
				},
				{
					// 同じユーザー・同じホストなら毎回同じ番号になる決定的候補が、両方の呼び出しへ返る
					first: preferredPort,
					second: preferredPort,
					spawnCount: 1,
					args: [
						'-N',
						'-R', `${preferredPort}:127.0.0.1:47286`,
						'-o', 'ControlPath=none',
						'-o', 'BatchMode=yes',
						'-o', 'ExitOnForwardFailure=yes',
						'-o', 'LogLevel=DEBUG1',
						'-o', 'ServerAliveInterval=30',
						'-o', 'ServerAliveCountMax=3',
						'dev-pc'
					],
					authorities: ['ssh-remote+dev-pc']
				}
			);
			// 番号が既に分かっていれば、以後の呼び出しは新しく ssh を起こさない
			assert.strictEqual(await tunnels.ensure('ssh-remote+dev-pc', 47286), preferredPort);
			assert.strictEqual(ssh.calls.length, 1);
		} finally {
			tunnels.dispose();
		}
	});

	test('falls back to a dynamic remote port when the preferred one is taken, without spending a retry', async () => {
		const ssh = fakeSsh();
		const tunnels = new ParadisRemoteAgentTunnels(nullLog, ssh.spawn);
		try {
			const preferredPort = computeCandidateRemotePort('dev-pc');
			const first = tunnels.ensure('ssh-remote+dev-pc', 47286);
			// 誰か（別ユーザー・別プロセス）が先に候補ポートを取っていた
			ssh.emitFixedPortTaken(preferredPort);
			ssh.emit('close', 255); // ExitOnForwardFailure=yes によりこの直後にプロセスが終了する
			ssh.emitAllocatedPort(51234); // 動的割当てへ切り替えた2回目の試行が sshd に選んでもらった番号

			assert.deepStrictEqual(
				{
					resolved: await first,
					spawnCount: ssh.calls.length,
					firstListenArg: ssh.calls[0][ssh.calls[0].indexOf('-R') + 1],
					firstLogLevel: ssh.calls[0].find(arg => arg.startsWith('LogLevel=')),
					secondListenArg: ssh.calls[1][ssh.calls[1].indexOf('-R') + 1],
					secondLogLevel: ssh.calls[1].find(arg => arg.startsWith('LogLevel=')),
				},
				{
					resolved: 51234,
					// 待ち時間を置かず、リトライ回数も消費せずに即座に張り直す
					spawnCount: 2,
					firstListenArg: `${preferredPort}:127.0.0.1:47286`,
					firstLogLevel: 'LogLevel=DEBUG1',
					secondListenArg: '0:127.0.0.1:47286',
					secondLogLevel: 'LogLevel=INFO',
				}
			);
		} finally {
			tunnels.dispose();
		}
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

		const preferredPort = computeCandidateRemotePort('dev-pc');
		const first = tunnels.ensure('ssh-remote+dev-pc', 47286);
		ssh.emitFixedPortSuccess(preferredPort);
		assert.strictEqual(await first, preferredPort);

		ssh.emit('error', new Error('connection reset'));
		ssh.emit('close', null);

		// 死んだ番号をそのまま返してはいけない。再試行が決着するまで待たせるのが正しい
		// （'close' を購読していないと remotePort が古いまま残り、ここが即 preferredPort に解決される）
		const sentinel = Symbol('still-pending');
		const after = tunnels.ensure('ssh-remote+dev-pc', 47286);
		const raced = await Promise.race([after, Promise.resolve(sentinel)]);
		assert.strictEqual(raced, sentinel);
		tunnels.dispose();
	});

	test('gives up after MAX_RETRIES attempts when neither success nor failure is ever confirmed, then tries the preferred port again once the cooldown passes', async () => {
		// CRITICAL レグレッションテスト: 到達不能なホストや認証待ちが長引く構成では、
		// 成功・失敗どちらの信号も来ないまま時間切れになりうる。かつての実装は
		// 「一定時間エラーが来なければ張れたとみなす」推定をしていたため、この状況で
		// 存在しないトンネルの番号を配り続け、exhausted に到達できなくなっていた
		// Date も fake にする: EXHAUSTED_RETRY_COOLDOWN_MS の判定が Date.now() ベースなので、
		// setTimeout だけ進めても「クールダウン明け」に実時間ではまだ到達しない
		const clock = sinon.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
		const ssh = fakeSshPerCall();
		const tunnels = new ParadisRemoteAgentTunnels(nullLog, ssh.spawn);
		try {
			const preferredPort = computeCandidateRemotePort('dev-pc');
			const pending = tunnels.ensure('ssh-remote+dev-pc', 47286);

			// 初回 + MAX_RETRIES(3) 回の再試行。それぞれ確認が来ないまま ALLOCATION_TIMEOUT_MS で
			// 実装自身が kill し、close を経て RETRY_DELAY_MS 後に次を試す
			// （kill は実装がタイマーの中で行う。ここでの close は「kill されたプロセスが実際に
			// 終了した」ことを模しているだけで、テストが代わりに殺しているのではない）
			for (let attempt = 0; attempt < 4; attempt++) {
				await clock.tickAsync(10_000); // ALLOCATION_TIMEOUT_MS
				ssh.closeLatest(null);
				if (attempt < 3) {
					await clock.tickAsync(5_000); // RETRY_DELAY_MS
				}
			}

			assert.deepStrictEqual(
				{
					resolved: await pending,
					spawnCount: ssh.calls.length,
					// 全試行がタイムアウト経由で実際に kill されたこと（推定で「張れた」ことにして
					// child を放置していないこと）を確認する
					killedCounts: ssh.killedCounts,
					listenArgs: ssh.calls.map(args => args[args.indexOf('-R') + 1]),
				},
				{
					resolved: undefined,
					spawnCount: 4,
					killedCounts: [1, 1, 1, 1],
					listenArgs: [
						// 1回目は決定的候補を試す
						`${preferredPort}:127.0.0.1:47286`,
						// 確認が一度も取れなかったので、以後は動的割当てへ逃がす（固定候補の正の確認
						// 信号が構造的に得られない相手に、候補を延々と試し続けて張れないままにしない）
						'0:127.0.0.1:47286',
						'0:127.0.0.1:47286',
						'0:127.0.0.1:47286',
					],
				}
			);

			// 十分に間を置けば、また決定的候補から試す（諦めた状態のまま止まらない）
			await clock.tickAsync(30_001); // EXHAUSTED_RETRY_COOLDOWN_MS ちょうどの境界で揺れないよう1ms余分に進める
			tunnels.ensure('ssh-remote+dev-pc', 47286);
			assert.strictEqual(ssh.calls[4][ssh.calls[4].indexOf('-R') + 1], `${preferredPort}:127.0.0.1:47286`);
		} finally {
			tunnels.dispose();
			clock.restore();
		}
	});

	test('stops preferring the deterministic port after it is taken, but tries it again after a later normal disconnect', async () => {
		// 一時的に候補ポートが埋まっていただけの可能性があるので、動的割当てへの切り替えを
		// 引きずらない。次に正常に張れてから通常に切断したときは、また候補から試す
		const clock = sinon.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
		const ssh = fakeSshPerCall();
		const tunnels = new ParadisRemoteAgentTunnels(nullLog, ssh.spawn);
		try {
			const preferredPort = computeCandidateRemotePort('dev-pc');
			const first = tunnels.ensure('ssh-remote+dev-pc', 47286);
			ssh.emitFixedPortTaken(preferredPort); // 1回目: 弾かれる → 待たずに2回目が始まる
			ssh.closeLatest(255);
			ssh.emitAllocatedPort(51234); // 2回目: 動的割当てで成功
			assert.strictEqual(await first, 51234);

			// 正常に張れていた経路の、ありふれた切断（弾かれたのではない）
			ssh.closeLatest(null);
			await clock.tickAsync(5_000); // RETRY_DELAY_MS
			ssh.emitFixedPortSuccess(preferredPort); // 3回目: また候補から試して、今度は空いていた

			assert.deepStrictEqual(
				ssh.calls.map(args => args[args.indexOf('-R') + 1]),
				[
					`${preferredPort}:127.0.0.1:47286`,
					'0:127.0.0.1:47286',
					`${preferredPort}:127.0.0.1:47286`,
				]
			);
		} finally {
			tunnels.dispose();
			clock.restore();
		}
	});

	test('keeps the tunnel up until the last window that asked for it lets go', async () => {
		// 同じホストへ2枚開いているとき、1枚閉じただけで畳むと残った側の hook が黙って死ぬ
		const ssh = fakeSsh();
		const tunnels = new ParadisRemoteAgentTunnels(nullLog, ssh.spawn);

		const first = tunnels.ensure('ssh-remote+dev-pc', 47286, 'window:1');
		const second = tunnels.ensure('ssh-remote+dev-pc', 47286, 'window:2');
		ssh.emitFixedPortSuccess(computeCandidateRemotePort('dev-pc'));
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

	test('lets go of the tunnels a destroyed window owned without waiting for its goodbye', async () => {
		// 閉じる知らせはウィンドウの dispose から投げっぱなしなので、クラッシュでは届かない
		const ssh = fakeSsh();
		const tunnels = new ParadisRemoteAgentTunnels(nullLog, ssh.spawn);
		const first = tunnels.ensure('ssh-remote+dev-pc', 47286, 'window:1');
		ssh.emitFixedPortSuccess(computeCandidateRemotePort('dev-pc'));
		await first;

		tunnels.releaseWindow('window:1');

		assert.deepStrictEqual({ killed: ssh.killed, authorities: [...tunnels.authorities] }, { killed: 1, authorities: [] });
		tunnels.dispose();
	});
});

suite('computeCandidateRemotePort', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	test('is deterministic for the same host, and falls within the candidate range', () => {
		const first = computeCandidateRemotePort('dev-pc');
		const second = computeCandidateRemotePort('dev-pc');
		assert.strictEqual(first, second);
		assert.ok(Number.isInteger(first) && first >= 20_000 && first < 32_768, `expected ${first} to be an integer within [20000, 32768)`);
	});

	test('differs across hosts', () => {
		// SHA-256 に基づくのでハッシュ衝突は理論上ありうるが、テスト用の固定文字列同士では
		// 起きない。混ぜ込む値（ユーザー名・ホスト名・接続先ホスト）が反映されていることの目安
		assert.notStrictEqual(computeCandidateRemotePort('dev-pc'), computeCandidateRemotePort('other-host'));
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
