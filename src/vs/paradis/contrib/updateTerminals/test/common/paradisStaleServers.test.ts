/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import {
	IParadisProcessRow,
	IParadisServerLayout,
	paradisAgentOfArgs,
	paradisCommitOfArgs,
	paradisFindStaleServers,
	paradisCommitsToStop,
	paradisFormatBytes,
	paradisIsOlderBuildDate,
	paradisJudgeStaleServer,
	paradisOnlyOlderBuilds,
	paradisParseEstablishedConnections,
	paradisParseListeningPorts,
	paradisParseEtime,
	paradisParsePsOutput,
	paradisPlanStaleServerNotice,
	paradisRemainingTargets,
	paradisSelectLeftoverRemovingDirs,
	paradisSelectRemovableServerDirs,
	paradisSelfServerFound,
	paradisServerBinRoot,
	paradisServerMainCommit,
	PARADIS_STALE_DIR_MIN_AGE_MS,
} from '../../common/paradisStaleServers.js';

const BIN = '/home/example/.para-code-server/bin';
const CURRENT = 'c'.repeat(40);
const OLD = 'a'.repeat(40);
const OLDER = 'b'.repeat(40);
const ME = 1000;
const SOMEONE_ELSE = 1001;

function row(pid: number, ppid: number, args: string, uid = ME, rssKb = 1024, elapsedSeconds: number | undefined = 3600): IParadisProcessRow {
	return { pid, ppid, uid, elapsedSeconds, rssKb, args };
}

function serverMain(commit: string): string {
	return `${BIN}/${commit}/node ${BIN}/${commit}/out/server-main.js --start-server --host=127.0.0.1`;
}

function ptyHost(commit: string): string {
	return `${BIN}/${commit}/node ${BIN}/${commit}/out/bootstrap-fork --type=ptyHost --logsPath /tmp/logs`;
}

const layout: IParadisServerLayout = { binRoot: BIN, currentCommit: CURRENT, uid: ME, selfPid: 100 };

/**
 * 接続先に、今の版（自分）・自分の古い版・ほかのユーザーの古い版が同時に動いている様子。
 */
function machine(): IParadisProcessRow[] {
	return [
		row(1, 0, '/sbin/init', 0),
		// 今の版（このサーバー自身）とその子
		row(90, 1, `sh ${BIN}/${CURRENT}/bin/para-code-server --start-server`),
		row(100, 90, serverMain(CURRENT)),
		row(101, 100, ptyHost(CURRENT)),
		row(102, 101, '/bin/zsh -l'),
		row(103, 102, '/usr/local/bin/claude'),
		// 自分の古い版
		row(200, 1, serverMain(OLD), ME, 200_000, 27 * 3600),
		row(201, 200, ptyHost(OLD), ME, 50_000),
		row(202, 201, '/bin/zsh -l'),
		row(203, 202, 'node /home/example/.npm/bin/claude --resume'),
		row(204, 203, 'node /home/example/mcp-server.js'),
		row(205, 201, '/bin/bash'),
		row(206, 205, '/usr/local/bin/codex'),
		row(207, 201, '/bin/bash'),
		row(208, 207, 'npm run dev'),
		// 古い pty host が起こした、更新をまたげる常駐とその中のシェル（新しい版が繋ぎ直して使う）
		row(209, 201, `${BIN}/${OLD}/node ${BIN}/${OLD}/out/bootstrap-fork`),
		row(210, 209, '/bin/zsh -l'),
		// 古いサーバーの子孫にほかのユーザーのものが紛れていても触らない
		row(211, 201, '/bin/zsh -l', SOMEONE_ELSE),
		// ほかのユーザーの古い版（同じ置き場所の書き方でも触らない）
		row(300, 1, serverMain(OLDER), SOMEONE_ELSE),
		row(301, 300, ptyHost(OLDER), SOMEONE_ELSE),
		row(302, 301, '/bin/zsh -l', SOMEONE_ELSE),
	];
}

suite('ParadisStaleServers', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	test('reads ps output and its elapsed time format', () => {
		assert.deepStrictEqual([
			paradisParseEtime('05:03'),
			paradisParseEtime('02:05:03'),
			paradisParseEtime('1-02:05:03'),
			paradisParseEtime('junk'),
			paradisParsePsOutput(`  200     1  1000 1-03:00:00 204800 ${serverMain(OLD)}\nnot a row\n    7     1     0      00:01    10 /bin/sh -c x y\n`),
		], [
			303,
			7503,
			93903,
			undefined,
			[
				{ pid: 200, ppid: 1, uid: 1000, elapsedSeconds: 97200, rssKb: 204800, args: serverMain(OLD) },
				{ pid: 7, ppid: 1, uid: 0, elapsedSeconds: 1, rssKb: 10, args: '/bin/sh -c x y' },
			],
		]);
	});

	test('finds where builds live only for the usual bin/<commit> layout', () => {
		assert.deepStrictEqual([
			paradisServerBinRoot(`${BIN}/${CURRENT}`, CURRENT),
			paradisServerBinRoot(`${BIN}/${CURRENT}/`, CURRENT),
			paradisServerBinRoot('/home/example/src/para-code', CURRENT),
			paradisServerBinRoot(`/opt/server/${CURRENT}`, CURRENT),
			paradisServerBinRoot(`${BIN}/${CURRENT}`, undefined),
			paradisServerBinRoot(`${BIN}/dev`, 'dev'),
		], [BIN, BIN, undefined, undefined, undefined, undefined]);
	});

	test('reads the build and the agent from command lines', () => {
		assert.deepStrictEqual([
			paradisCommitOfArgs(serverMain(OLD), BIN),
			paradisCommitOfArgs(`/usr/bin/node ${BIN}/${OLD}/out/server-main.js`, BIN),
			paradisCommitOfArgs(`${BIN}/notacommit/node`, BIN),
			paradisCommitOfArgs('/bin/zsh', BIN),
			paradisAgentOfArgs('/usr/local/bin/claude'),
			paradisAgentOfArgs('node /home/example/.npm/bin/claude --resume'),
			paradisAgentOfArgs('node /x/node_modules/@openai/codex/bin/codex.js'),
			paradisAgentOfArgs('/bin/zsh -l'),
		], [OLD, OLD, undefined, undefined, 'claude', 'claude', 'codex', undefined]);
	});

	suite('what may be stopped', () => {
		test('only this user\'s servers of other builds and their descendants: never the current build, never another user', () => {
			const stale = paradisFindStaleServers(machine(), layout);
			assert.deepStrictEqual(stale.map(server => ({
				commit: server.commit,
				pid: server.pid,
				pids: [...server.pids].sort((a, b) => a - b),
				terminalCount: server.terminalCount,
				claudeCount: server.claudeCount,
				codexCount: server.codexCount,
				elapsedSeconds: server.elapsedSeconds,
			})), [{
				commit: OLD,
				pid: 200,
				// 209・210（更新をまたげる常駐）と 211（ほかのユーザー）は入らない
				pids: [200, 201, 202, 203, 204, 205, 206, 207, 208],
				terminalCount: 3,
				claudeCount: 1,
				codexCount: 1,
				elapsedSeconds: 27 * 3600,
			}]);
		});

		test('touches nothing when only the current build and other users are running', () => {
			const rows = machine().filter(process => process.pid < 200 || process.pid >= 300);
			assert.deepStrictEqual(paradisFindStaleServers(rows, layout), []);
		});

		test('never treats its own process tree as stale, even if it were started from another build\'s folder', () => {
			// 自分の祖先に別の版の server-main がある（あり得ない置き方だが、あっても触らない）
			const rows = [
				row(1, 0, '/sbin/init', 0),
				row(50, 1, serverMain(OLD)),
				row(100, 50, serverMain(CURRENT)),
				row(101, 100, ptyHost(CURRENT)),
			];
			assert.deepStrictEqual(paradisFindStaleServers(rows, layout), []);
		});

		test('kills on the second pass only what is still the same process of the same user, started at the same time', () => {
			const now = 10_000_000;
			const startedAt = now - 3600 * 1000;
			const targets = [
				{ pid: 200, args: serverMain(OLD), startedAtMs: startedAt },
				{ pid: 202, args: '/bin/zsh -l', startedAtMs: startedAt },
				{ pid: 205, args: '/bin/bash', startedAtMs: startedAt },
				{ pid: 206, args: '/bin/bash', startedAtMs: startedAt },
				{ pid: 207, args: '/bin/bash', startedAtMs: undefined },
			];
			const rows = [
				row(200, 1, serverMain(OLD)),
				// pid が別のものに使い回された
				row(202, 1, '/usr/bin/something-else'),
				// 同じ pid・同じ引数でも、ほかのユーザーなら触らない
				row(205, 1, '/bin/bash', SOMEONE_ELSE),
				// 同じ引数でも、始まった時刻が違えば別のプロセス
				row(206, 1, '/bin/bash', ME, 1024, 10),
				// 始まった時刻が分からなければ触らない
				row(207, 1, '/bin/bash'),
			];
			assert.deepStrictEqual(paradisRemainingTargets(targets, rows, ME, now), [200]);
		});

		test('recognises a server only by "<bin>/<sha>/node <bin>/<sha>/out/server-main.js", not by a file viewer or another node', () => {
			const roots = [BIN, '/data/home/example/.para-code-server/bin'];
			assert.deepStrictEqual([
				paradisServerMainCommit(serverMain(OLD), roots),
				paradisServerMainCommit(`less ${BIN}/${OLD}/out/server-main.js`, roots),
				paradisServerMainCommit(`vim ${BIN}/${OLD}/node ${BIN}/${OLD}/out/server-main.js`, roots),
				paradisServerMainCommit(`/usr/bin/node ${BIN}/${OLD}/out/server-main.js`, roots),
				paradisServerMainCommit(`${BIN}/${OLD}/node --inspect ${BIN}/${OLD}/out/server-main.js`, roots),
				paradisServerMainCommit(`${BIN}/${OLD}/node ${BIN}/${CURRENT}/out/server-main.js`, roots),
				// 置き場所の別の書き方（シンボリックリンクの先）でも同じ版として読む
				paradisServerMainCommit(`/data/home/example/.para-code-server/bin/${OLD}/node ${BIN}/${OLD}/out/server-main.js`, roots),
			], [OLD, undefined, undefined, undefined, undefined, undefined, OLD]);
		});

		test('does nothing unless it can see itself as the current build\'s server', () => {
			assert.deepStrictEqual([
				paradisSelfServerFound(machine(), layout),
				paradisSelfServerFound(machine().filter(process => process.pid !== 100), layout),
				paradisSelfServerFound(machine(), { ...layout, selfPid: 200 }),
			], [true, false, false]);
		});

		test('stops only builds older than this one that nobody is connected to', () => {
			const judge = (productDate: string | undefined, established: number[] | undefined, args = serverMain(OLD), currentProductDate: string | 'missing' = '2026-10-01T00:00:00.000Z') => paradisJudgeStaleServer({
				productDate,
				currentProductDate: currentProductDate === 'missing' ? undefined : currentProductDate,
				serverPid: 200,
				serverArgs: args,
				// 200 は 40805 で待ち受ける。established に入れた pid は、その待ち受けポートへの受け側の接続を持つ
				tcp: established === undefined ? undefined : {
					listeningPorts: new Map([[200, new Set([40805])]]),
					established: established.map(pid => ({ pid, localPort: 40805 })),
				},
			});
			assert.deepStrictEqual([
				judge('2026-09-01T00:00:00.000Z', []),
				// 別の PC が先に更新して新しい版で使っているかもしれない
				judge('2026-10-02T00:00:00.000Z', []),
				judge('2026-10-01T00:00:00.000Z', []),
				judge(undefined, []),
				judge('2026-09-01T00:00:00.000Z', [], serverMain(OLD), 'missing'),
				// 別の PC が古い版のままつないでいる
				judge('2026-09-01T00:00:00.000Z', [200]),
				judge('2026-09-01T00:00:00.000Z', [201, 999]),
				// 調べられない環境・ソケットファイルで待ち受けるサーバーは触らない
				judge('2026-09-01T00:00:00.000Z', undefined),
				judge('2026-09-01T00:00:00.000Z', [], `${serverMain(OLD)} --socket-path=/tmp/x.sock`),
			], ['stoppable', 'not-older', 'not-older', 'not-older', 'not-older', 'connected', 'stoppable', 'connection-unknown', 'connection-unknown']);
		});

		test('stops only the builds the notice showed that are still stoppable now', () => {
			assert.deepStrictEqual([
				paradisCommitsToStop([OLD, OLDER], [OLD]),
				paradisCommitsToStop([OLD], [OLDER]),
				paradisCommitsToStop(['../../etc', OLD.toUpperCase()], [OLD]),
				paradisCommitsToStop([], [OLD]),
			], [[OLD], [], [], []]);
		});

		test('counts only inbound connections to the server\'s listening port, not its own outgoing ones', () => {
			const listening = [
				'LISTEN 0      511          127.0.0.1:40805      0.0.0.0:*    users:(("MainThread",pid=759660,fd=60))',
				'LISTEN 0      511          127.0.0.1:41000      0.0.0.0:*    users:(("MainThread",pid=800000,fd=60))',
				'LISTEN 0      128          [::1]:43000          [::]:*       users:(("node",pid=810000,fd=20))',
				'',
			].join('\n');
			const inUse = [
				'0      0      127.0.0.1:40805      127.0.0.1:37912 users:(("MainThread",pid=759660,fd=61))',
				'0      0      127.0.0.1:40805      127.0.0.1:37920 users:(("MainThread",pid=759660,fd=62))',
				'0      0      127.0.0.1:48898      127.0.0.1:21009 users:(("MainThread",pid=759660,fd=70))',
				'',
			].join('\n');
			// 手元のクライアントが居なくなった後も、外へ出ていく接続だけは残っている
			const outgoingOnly = [
				'0      0      127.0.0.1:48898      127.0.0.1:21009 users:(("MainThread",pid=759660,fd=70))',
				'0      0      127.0.0.1:41000      127.0.0.1:50000 users:(("MainThread",pid=800000,fd=61))',
				'',
			].join('\n');
			const judge = (pid: number, established: string) => paradisJudgeStaleServer({
				productDate: '2026-09-01T00:00:00.000Z',
				currentProductDate: '2026-10-01T00:00:00.000Z',
				serverPid: pid,
				serverArgs: serverMain(OLD),
				tcp: { listeningPorts: paradisParseListeningPorts(listening), established: paradisParseEstablishedConnections(established) },
			});
			assert.deepStrictEqual({
				listening: [...paradisParseListeningPorts(listening)].map(([pid, ports]) => [pid, [...ports]]),
				established: paradisParseEstablishedConnections(inUse),
				verdicts: [
					judge(759660, inUse),
					judge(759660, outgoingOnly),
					judge(800000, outgoingOnly),
					// 待ち受けポートが取れないサーバーは、使われているかもしれないので止めない
					judge(999999, outgoingOnly),
				],
			}, {
				listening: [[759660, [40805]], [800000, [41000]], [810000, [43000]]],
				established: [
					{ pid: 759660, localPort: 40805 },
					{ pid: 759660, localPort: 40805 },
					{ pid: 759660, localPort: 48898 },
				],
				verdicts: ['connected', 'stoppable', 'connected', 'connection-unknown'],
			});
		});
	});

	test('removes only build folders nothing runs from, never the current one, never fresh ones, never other files', () => {
		const now = 1_000_000_000;
		const old = now - PARADIS_STALE_DIR_MIN_AGE_MS - 1;
		const unused = 'd'.repeat(40);
		const fresh = 'e'.repeat(40);
		const entries = [
			{ name: CURRENT, isDirectory: true, mtimeMs: old },
			{ name: OLD, isDirectory: true, mtimeMs: old },
			{ name: OLDER, isDirectory: true, mtimeMs: old },
			{ name: unused, isDirectory: true, mtimeMs: old },
			{ name: fresh, isDirectory: true, mtimeMs: now - 1000 },
			{ name: `${unused}.tar.gz`, isDirectory: false, mtimeMs: old },
			{ name: 'f'.repeat(40), isDirectory: false, mtimeMs: old },
			{ name: 'logs', isDirectory: true, mtimeMs: old },
		];
		const afterStop = machine().filter(process => process.pid < 200 || process.pid >= 300);
		assert.deepStrictEqual([
			// OLD は自分の古いサーバー、OLDER はほかのユーザーのサーバーが動いているので消さない
			paradisSelectRemovableServerDirs(entries, machine(), layout, now),
			// 自分の古いサーバーを止めた後なら OLD も消せる（OLDER はほかのユーザーが使っているまま）
			paradisSelectRemovableServerDirs(entries, afterStop, layout, now),
			// 引数に出ていなくても、その版の node が実行中なら消さない
			paradisSelectRemovableServerDirs(entries, afterStop, layout, now, [`${BIN}/${unused}/node`]),
			// 引数が別の書き方（シンボリックリンクの先）でも同じフォルダとして見る
			paradisSelectRemovableServerDirs(entries, [...afterStop, row(400, 1, `/data/bin/${unused}/node x`)], { ...layout, binRootAliases: ['/data/bin'] }, now),
		], [[unused], [OLD, unused], [OLD], [OLD]]);
	});

	test('removes only builds older than this one, and leftovers of an earlier cleanup', () => {
		const dates = new Map<string, string | undefined>([[OLD, '2026-09-01T00:00:00.000Z'], [OLDER, '2026-10-02T00:00:00.000Z'], ['d'.repeat(40), undefined]]);
		assert.deepStrictEqual([
			paradisIsOlderBuildDate('2026-09-01T00:00:00.000Z', '2026-10-01T00:00:00.000Z'),
			paradisIsOlderBuildDate('2026-10-01T00:00:00.000Z', '2026-10-01T00:00:00.000Z'),
			paradisIsOlderBuildDate('not a date', '2026-10-01T00:00:00.000Z'),
			paradisOnlyOlderBuilds([OLD, OLDER, 'd'.repeat(40), 'e'.repeat(40)], dates, '2026-10-01T00:00:00.000Z'),
			paradisOnlyOlderBuilds([OLD], dates, undefined),
			paradisSelectLeftoverRemovingDirs([
				{ name: `.paradis-removing-${OLD}-1700000000000`, isDirectory: true, mtimeMs: 0 },
				{ name: `.paradis-removing-${OLD}-1700000000001`, isDirectory: false, mtimeMs: 0 },
				{ name: '.paradis-removing-../../x-1', isDirectory: true, mtimeMs: 0 },
				{ name: OLD, isDirectory: true, mtimeMs: 0 },
			]),
		], [true, false, false, [OLD], [], [`.paradis-removing-${OLD}-1700000000000`]]);
	});

	test('folds the "cannot reopen" notice into the stale server notice when an old server is still running', () => {
		assert.deepStrictEqual([
			paradisPlanStaleServerNotice({ staleServerCount: 1, strandedShouldReport: true }),
			paradisPlanStaleServerNotice({ staleServerCount: 2, strandedShouldReport: false }),
			paradisPlanStaleServerNotice({ staleServerCount: 0, strandedShouldReport: true }),
			paradisPlanStaleServerNotice({ staleServerCount: 0, strandedShouldReport: false }),
		], ['staleServers', 'staleServers', 'stranded', 'none']);
	});

	test('formats sizes', () => {
		assert.deepStrictEqual([0, 5 * 1024 * 1024, 1.5 * 1024 ** 3, 20.4 * 1024 ** 3].map(paradisFormatBytes), ['0MB', '5MB', '1.5GB', '20GB']);
	});
});
