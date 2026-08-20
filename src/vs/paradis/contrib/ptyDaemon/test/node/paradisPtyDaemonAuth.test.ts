/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import {
	ParadisPtyDaemonAuth,
	paradisCreateDaemonToken,
	paradisCreateNonce,
	paradisProofMatches,
	paradisProveDaemonToken,
} from '../../node/paradisPtyDaemonAuth.js';

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
