/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import assert from 'assert';
import { promises as fs } from 'fs';
import { tmpdir } from 'os';
import { Event } from '../../../../../base/common/event.js';
import { join } from '../../../../../base/common/path.js';
import { connect, serve } from '../../../../../base/parts/ipc/node/ipc.net.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { PARADIS_PTY_DAEMON_AUTH_CHANNEL } from '../../common/paradisPtyDaemonControl.js';
import {
	ParadisPtyDaemonAuth,
	paradisAuthenticateDaemonWithin,
	paradisCheckDaemonAt,
	paradisCreateDaemonToken,
	paradisCreateNonce,
	paradisProofMatches,
	paradisProveDaemonToken,
} from '../../node/paradisPtyDaemonAuth.js';
import { paradisDaemonRecordFile, paradisWriteDaemonRecord } from '../../node/paradisPtyDaemonLedger.js';

suite('ParadisPtyDaemonAuth', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	test('lets the real daemon answer and nobody else', async () => {
		const token = paradisCreateDaemonToken();
		const daemon = new ParadisPtyDaemonAuth(token);
		const nonce = paradisCreateNonce();

		const answer = await daemon.authenticate(nonce, paradisProveDaemonToken(token, 'client', nonce));

		// 身元を知らない相手は、こちらの証明を照合できないので断る。
		const impostor = new ParadisPtyDaemonAuth(paradisCreateDaemonToken());
		let impostorRefused = false;
		try {
			await impostor.authenticate(nonce, paradisProveDaemonToken(token, 'client', nonce));
		} catch {
			impostorRefused = true;
		}

		assert.deepStrictEqual(
			{
				// 呼んだ側は、返ってきた証明を自分でも作れて初めて相手を信じる。
				daemonProved: paradisProofMatches(paradisProveDaemonToken(token, 'daemon', nonce), answer),
				// 身元そのものは流れない。
				tokenNotLeaked: !answer.includes(token),
				impostorRefused,
			},
			{ daemonProved: true, tokenNotLeaked: true, impostorRefused: true },
		);
	});

	test('will not take a proof meant for the other direction', async () => {
		// 向きを分けていないと、常駐が返した証明をそのまま次の接続でクライアントの証明として
		// 使い回せる（偽物が本物へ一度繋いで答えをもらい、それを別の相手に見せる）。
		const token = paradisCreateDaemonToken();
		const daemon = new ParadisPtyDaemonAuth(token);
		const nonce = paradisCreateNonce();
		const daemonProof = paradisProveDaemonToken(token, 'daemon', nonce);

		let replayRefused = false;
		try {
			await daemon.authenticate(nonce, daemonProof);
		} catch {
			replayRefused = true;
		}

		assert.deepStrictEqual(
			{
				replayRefused,
				differentPerDirection: paradisProveDaemonToken(token, 'client', nonce) !== daemonProof,
				differentPerNonce: paradisProveDaemonToken(token, 'client', paradisCreateNonce()) !== paradisProveDaemonToken(token, 'client', nonce),
			},
			{ replayRefused: true, differentPerDirection: true, differentPerNonce: true },
		);
	});

	test('rejects malformed proofs without comparing them', () => {
		const expected = paradisProveDaemonToken(paradisCreateDaemonToken(), 'daemon', 'n');
		assert.deepStrictEqual(
			{
				// 長さが違うものを時間の差が出ない比較に渡すと例外になるので、先に弾く。
				short: paradisProofMatches(expected, expected.slice(0, -1)),
				notAString: paradisProofMatches(expected, 42),
				missing: paradisProofMatches(expected, undefined),
				same: paradisProofMatches(expected, expected),
			},
			{ short: false, notAString: false, missing: false, same: true },
		);
	});
});

// 受理した接続ぶんの `Protocol` は `IPCServer` が畳まないので、リーク検査は外してある
// (`paradisEnsurePtyHost.test.ts` と同じ理由)。
// eslint-disable-next-line local/code-ensure-no-disposables-leak-in-test
suite('ParadisPtyDaemonAuth with a deadline', () => {
	test('接続を受けるだけで名乗りに答えない常駐は、期限で諦めて断られたのとは分けて返す', async function () {
		this.timeout(10_000);
		const dir = await fs.mkdtemp(join(tmpdir(), 'paradis-pty-auth-'));
		const socketPath = join(dir, 'pty.sock');
		const token = paradisCreateDaemonToken();
		const auth = new ParadisPtyDaemonAuth(token);
		// `stuck` のあいだは固まった常駐の代わり。接続は受けるが、名乗り（合言葉）に答えない。
		let stuck = true;
		const server = await serve(socketPath);
		server.registerChannel(PARADIS_PTY_DAEMON_AUTH_CHANNEL, {
			call: <T>(_ctx: string, _command: string, arg?: unknown): Promise<T> => {
				const [nonce, proof] = arg as [string, string];
				return (stuck ? new Promise(() => { }) : auth.authenticate(nonce, proof)) as Promise<T>;
			},
			listen: () => Event.None,
		});
		const client = await connect(socketPath, 'test');
		try {
			await paradisWriteDaemonRecord(paradisDaemonRecordFile(dir, 'test'), { pid: process.pid, socketPath, buildId: 'test', buildKey: 'test', startedAt: 1, token });
			const startedAt = Date.now();
			const stuckWithin = await paradisAuthenticateDaemonWithin(client, token, 100);
			const stuckAt = await paradisCheckDaemonAt(socketPath, dir, 100);
			const gaveUpQuickly = Date.now() - startedAt < 2_000;
			stuck = false;
			assert.deepStrictEqual({
				stuckWithin,
				stuckAt,
				gaveUpQuickly,
				answeredWithin: await paradisAuthenticateDaemonWithin(client, token, 2_000),
				answeredAt: await paradisCheckDaemonAt(socketPath, dir, 2_000),
				impostorAt: await paradisCheckDaemonAt(socketPath, join(dir, 'no-ledger'), 2_000),
				nobodyListening: await paradisCheckDaemonAt(join(dir, 'missing.sock'), dir, 2_000),
			}, {
				stuckWithin: 'timeout',
				stuckAt: 'timeout',
				gaveUpQuickly: true,
				answeredWithin: 'genuine',
				answeredAt: 'genuine',
				impostorAt: 'refused',
				nobodyListening: 'refused',
			});
		} finally {
			client.dispose();
			server.dispose();
			await fs.rm(dir, { recursive: true, force: true });
		}
	});
});
