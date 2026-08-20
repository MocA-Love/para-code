/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import {
	IParadisPtyDaemonRecord,
	PARADIS_DAEMON_BIND_LOCK_TIMEOUT,
	PARADIS_DAEMON_IDLE_TIMEOUT,
	PARADIS_DAEMON_TERMINAL_GRACE_TIME,
	ParadisDaemonAction,
	paradisJudgeForeignDaemon,
	paradisIsBindLockStale,
	paradisJudgeUnreachableDaemon,
	paradisParseBindLock,
	paradisParseDaemonRecord,
	paradisProbeDaemonRecord,
	paradisShouldDaemonExit,
} from '../../common/paradisPtyDaemonPolicy.js';

const OWN = 'aaaa1111';
const RECORD: IParadisPtyDaemonRecord = {
	pid: 4321,
	socketPath: '/tmp/paracode-x.sock',
	buildId: '1.132.0-paracode-72',
	buildKey: OWN,
	startedAt: 1_000,
	token: 'deadbeef',
};

suite('ParadisPtyDaemonPolicy', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	test('decides what to do with a ledger entry before connecting to it', () => {
		assert.deepStrictEqual(
			{
				gone: paradisProbeDaemonRecord(RECORD, OWN, false),
				sameBuild: paradisProbeDaemonRecord(RECORD, OWN, true),
				otherBuild: paradisProbeDaemonRecord({ ...RECORD, buildKey: 'bbbb2222' }, OWN, true),
			},
			{
				gone: ParadisDaemonAction.Discard,
				sameBuild: ParadisDaemonAction.Adopt,
				otherBuild: ParadisDaemonAction.Inspect,
			},
		);
	});

	test('never disposes of a daemon whose contents are unknown or in use', () => {
		assert.deepStrictEqual(
			{
				// 何も抱えていないと確認できた古いビルドだけ、黙って片付ける。
				emptyForeign: paradisJudgeForeignDaemon(0),
				// 更新前に残したターミナルはここに居る。殺すのは「更新したら作業が消えた」と同じ。
				busyForeign: paradisJudgeForeignDaemon(1),
				// 生きているのに応答しない。何が起きているか分からないので触らない。
				aliveButSilent: paradisJudgeUnreachableDaemon(true),
				// pid も居ない。ただの残骸。
				rubble: paradisJudgeUnreachableDaemon(false),
			},
			{
				emptyForeign: ParadisDaemonAction.Reap,
				busyForeign: ParadisDaemonAction.Surface,
				aliveButSilent: ParadisDaemonAction.Surface,
				rubble: ParadisDaemonAction.Discard,
			},
		);
	});

	test('waits longer while holding terminals, but never forever', () => {
		const now = 1_000_000_000;
		const idle = { terminalCount: 0, clientCount: 0, idleSince: now - PARADIS_DAEMON_IDLE_TIMEOUT };
		assert.deepStrictEqual(
			{
				// 繋がっている間は終わらない。抱えているかどうかに関わらず。
				stillConnected: paradisShouldDaemonExit({ ...idle, clientCount: 1 }, now),
				withinTimeout: paradisShouldDaemonExit({ ...idle, idleSince: now - PARADIS_DAEMON_IDLE_TIMEOUT + 1 }, now),
				timedOut: paradisShouldDaemonExit(idle, now),
				// 一度も繋がれないまま放置された常駐 (アプリが起動直後に落ちた場合) も拾う。
				neverConnected: paradisShouldDaemonExit({ terminalCount: 0, clientCount: 0, idleSince: 0 }, now),
				// 抱えていれば長く待つが、
				holdingWithinGrace: paradisShouldDaemonExit({ ...idle, terminalCount: 1 }, now),
				// 待ち切ったら終わる。ここを「抱えている間は終わらない」にすると、アプリが
				// 正常に終わらなかったとき (detach が届かず猶予タイマーも回らない) に、誰も
				// 繋いでいない常駐が永久に居座る。
				holdingPastGrace: paradisShouldDaemonExit(
					{ terminalCount: 1, clientCount: 0, idleSince: now - PARADIS_DAEMON_TERMINAL_GRACE_TIME },
					now,
				),
			},
			{
				stillConnected: false,
				withinTimeout: false,
				timedOut: true,
				neverConnected: true,
				holdingWithinGrace: false,
				holdingPastGrace: true,
			},
		);
	});

	test('lets one daemon at a time clear a stale socket', () => {
		const now = 1_000_000;
		const fresh = { pid: 4321, createdAt: now };
		assert.deepStrictEqual(
			{
				// 掃除中の相手が居るなら待つ。ここを緩めると、相手が置いたばかりのソケットを
				// 消して自分の物を置き、相手は誰からも届かないソケットで待ち続けることになる。
				held: paradisIsBindLockStale(fresh, true, now),
				// 札を持ったまま死んだ跡は無視してよい。
				holderGone: paradisIsBindLockStale(fresh, false, now),
				// 生きていても長すぎるなら無視する (固まっている相手に永久に待たされない)。
				tooOld: paradisIsBindLockStale({ ...fresh, createdAt: now - PARADIS_DAEMON_BIND_LOCK_TIMEOUT }, true, now),
				// 書きかけで死んだ札。
				unreadable: paradisIsBindLockStale(undefined, false, now),
			},
			{ held: false, holderGone: true, tooOld: true, unreadable: true },
		);
	});

	test('reads a half-written bind lock without throwing', () => {
		assert.deepStrictEqual(
			{
				good: paradisParseBindLock({ pid: 12, createdAt: 34 }),
				badPid: paradisParseBindLock({ pid: 0, createdAt: 34 }),
				missing: paradisParseBindLock({ pid: 12 }),
				notAnObject: paradisParseBindLock('{"pid":12}'),
			},
			{ good: { pid: 12, createdAt: 34 }, badPid: undefined, missing: undefined, notAnObject: undefined },
		);
	});

	test('reads a half-written ledger without throwing', () => {
		assert.deepStrictEqual(
			{
				good: paradisParseDaemonRecord({ ...RECORD }),
				missingField: paradisParseDaemonRecord({ ...RECORD, socketPath: undefined }),
				emptyBuild: paradisParseDaemonRecord({ ...RECORD, buildId: '' }),
				badPid: paradisParseDaemonRecord({ ...RECORD, pid: 0 }),
				// 身元の無い台帳は受け付けない。「確かめられないが使う」経路を作らないため。
				noToken: paradisParseDaemonRecord({ ...RECORD, token: undefined }),
				notAnObject: paradisParseDaemonRecord('{"pid":1}'),
				nothing: paradisParseDaemonRecord(null),
			},
			{
				good: RECORD,
				missingField: undefined,
				emptyBuild: undefined,
				badPid: undefined,
				noToken: undefined,
				notAnObject: undefined,
				nothing: undefined,
			},
		);
	});
});
