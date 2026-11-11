/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import assert from 'assert';
import * as fs from 'fs';
import { tmpdir } from 'os';
import { join } from '../../../../../base/common/path.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { NullLogService } from '../../../../../platform/log/common/log.js';
import { IParadisRunAgentCliOptions, IParadisRunAgentCliResult } from '../../../../node/paradisAgentCli.js';
import { ParadisAntigravityUsageFetcher, paradisCreateAntigravityWorkDir } from '../../node/paradisAntigravityUsage.js';
import { PARADIS_ANTIGRAVITY_SIGNED_OUT_STDERR, PARADIS_ANTIGRAVITY_USAGE_SAMPLE } from '../common/paradisAntigravityUsage.test.js';

const HOME = '/home/example';
const MINUTE = 60_000;

interface IHarness {
	readonly fetcher: ParadisAntigravityUsageFetcher;
	/** agy を起こした回数と、渡した引数・打ち切り・止める条件。 */
	readonly runs: { readonly args: readonly string[]; readonly timeoutMs: number; readonly cwd: string | undefined; readonly stops: boolean }[];
	/** 次に agy が返すもの（関数なら例外を投げる）。 */
	next: IParadisRunAgentCliResult | Error;
	now: number;
	stamp: string;
	/** token のファイルがあるか。 */
	hasToken: boolean;
	/** 作業フォルダを消した回数。 */
	disposedWorkDirs: number;
}

function harness(installed = true): IHarness {
	const state: Omit<IHarness, 'fetcher'> = {
		runs: [],
		next: { stdout: PARADIS_ANTIGRAVITY_USAGE_SAMPLE, stderr: '', exitCode: 0 },
		now: Date.parse('2026-11-12T00:00:00Z'),
		stamp: 'a',
		hasToken: true,
		disposedWorkDirs: 0,
	};
	const result = state as IHarness;
	(result as { fetcher: ParadisAntigravityUsageFetcher }).fetcher = new ParadisAntigravityUsageFetcher(new NullLogService(), async () => ({ PATH: '/usr/bin', PARA_CODE_PANE_TOKEN: 'secret' }), {
		homedir: () => HOME,
		now: () => result.now,
		resolveCommand: async env => {
			// ペインに結び付く変数は外してから探す
			assert.strictEqual(env.PARA_CODE_PANE_TOKEN, undefined);
			return installed ? '/usr/bin/agy' : undefined;
		},
		runCli: async (_command: string, args: readonly string[], options: IParadisRunAgentCliOptions) => {
			result.runs.push({ args, timeoutMs: options.timeoutMs, cwd: options.cwd, stops: options.stopWhen?.('', PARADIS_ANTIGRAVITY_SIGNED_OUT_STDERR) === true });
			if (result.next instanceof Error) {
				throw result.next;
			}
			return result.next;
		},
		signInStamp: async () => result.stamp,
		hasSignInToken: async geminiDir => {
			assert.strictEqual(geminiDir, '/home/example/.gemini');
			return result.hasToken;
		},
		workDir: async () => ({ path: '/tmp/para-code-agy-usage-x', dispose: async () => { result.disposedWorkDirs++; } }),
	});
	return result;
}

suite('Paradis Antigravity usage fetcher', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	test('does not show Antigravity at all when agy is not installed', async () => {
		const h = harness(false);
		assert.deepStrictEqual({ snapshot: await h.fetcher.fetch(false), runs: h.runs.length }, { snapshot: undefined, runs: 0 });
	});

	test('reads the usage, then reuses it for five minutes unless the user refreshes', async () => {
		const h = harness();
		const first = await h.fetcher.fetch(false);
		h.now += 4 * MINUTE;
		await h.fetcher.fetch(false);
		const runsWithinInterval = h.runs.length;
		h.now += 2 * MINUTE;
		await h.fetcher.fetch(false);
		await h.fetcher.fetch(true);
		assert.deepStrictEqual({ first, runsWithinInterval, runs: h.runs, disposedWorkDirs: h.disposedWorkDirs }, {
			first: {
				accounts: [{
					provider: 'antigravity', id: '/home/example/.gemini', homeLabel: '~/.gemini', active: true, status: 'ok',
					fetchedAt: Date.parse('2026-11-12T00:00:00Z'),
					scoped: [
						{ usedPercent: 8.7, label: 'Gemini', resetsAt: Date.parse('2026-11-18T16:44:24Z') },
						{ usedPercent: 0, label: 'Claude・GPT', resetsAt: Date.parse('2026-11-18T20:55:15Z') },
					],
				}],
			},
			runsWithinInterval: 1,
			runs: [1, 2, 3].map(() => ({ args: ['-p', '/usage', '--output-format', 'json'], timeoutMs: 20_000, cwd: '/tmp/para-code-agy-usage-x', stops: true })),
			// 作業フォルダは毎回消す
			disposedWorkDirs: 3,
		});
	});

	test('hides Antigravity while signed out and does not start agy again until the sign-in changes or the user refreshes', async () => {
		const h = harness();
		h.next = { stdout: '', stderr: PARADIS_ANTIGRAVITY_SIGNED_OUT_STDERR, exitCode: null, stopped: true };
		const signedOut = await h.fetcher.fetch(false);
		// 時間がたっても取り直さない
		h.now += 24 * 60 * MINUTE;
		await h.fetcher.fetch(false);
		const runsWhileWaiting = h.runs.length;
		// 手動の更新では取り直す
		await h.fetcher.fetch(true);
		const runsAfterRefresh = h.runs.length;
		h.now += 6 * MINUTE;
		h.stamp = 'b';
		h.next = { stdout: PARADIS_ANTIGRAVITY_USAGE_SAMPLE, stderr: '', exitCode: 0 };
		const afterSignIn = await h.fetcher.fetch(false);
		assert.deepStrictEqual({ signedOut, runsWhileWaiting, runsAfterRefresh, afterSignIn: afterSignIn?.accounts[0].status, runs: h.runs.length }, {
			signedOut: undefined,
			runsWhileWaiting: 1,
			runsAfterRefresh: 2,
			afterSignIn: 'ok',
			runs: 3,
		});
	});

	test('keeps the last value as a previous value when a run fails, and waits ten minutes before trying again', async () => {
		const h = harness();
		await h.fetcher.fetch(false);
		h.now += 5 * MINUTE;
		h.next = new Error('/usr/bin/agy timed out after 20000ms');
		// 失敗の文には実行ファイルの絶対パスを出さない
		const failed = await h.fetcher.fetch(false);
		h.now += 9 * MINUTE;
		await h.fetcher.fetch(false);
		const runsInCooldown = h.runs.length;

		const fresh = harness();
		fresh.next = { stdout: 'panic: boom', stderr: '', exitCode: 2 };
		const failedWithoutValue = await fresh.fetcher.fetch(false);
		assert.deepStrictEqual({ failed: failed?.accounts[0], runsInCooldown, failedWithoutValue }, {
			failed: {
				provider: 'antigravity', id: '/home/example/.gemini', homeLabel: '~/.gemini', active: true,
				status: 'unavailable', unavailableReason: 'not_fetched', statusDetail: 'agy timed out after 20000ms',
				fetchedAt: Date.parse('2026-11-12T00:00:00Z'),
				scoped: [
					{ usedPercent: 8.7, label: 'Gemini', resetsAt: Date.parse('2026-11-18T16:44:24Z') },
					{ usedPercent: 0, label: 'Claude・GPT', resetsAt: Date.parse('2026-11-18T20:55:15Z') },
				],
			},
			runsInCooldown: 2,
			failedWithoutValue: { accounts: [{ provider: 'antigravity', id: '/home/example/.gemini', homeLabel: '~/.gemini', active: true, status: 'error', statusDetail: 'agy did not print JSON for /usage' }] },
		});
	});

	test('does not start agy automatically before any sign-in, but does on a manual refresh and keeps going after it worked', async () => {
		const h = harness();
		h.hasToken = false;
		const automatic = await h.fetcher.fetch(false);
		const runsWithoutToken = h.runs.length;
		// 手動の更新では起こす（token を OS のキーリングに置く環境）
		const manual = await h.fetcher.fetch(true);
		h.now += 5 * MINUTE;
		await h.fetcher.fetch(false);
		assert.deepStrictEqual({ automatic, runsWithoutToken, manual: manual?.accounts[0].status, runs: h.runs.length }, {
			automatic: undefined,
			runsWithoutToken: 0,
			manual: 'ok',
			// 一度取れた後は、token のファイルが無くても自動で取り続ける
			runs: 2,
		});
	});

	test('does not show an empty column when agy reports no windows', async () => {
		const h = harness();
		h.next = { stdout: JSON.stringify({ status: 'SUCCESS', command: { name: 'usage', data: { groups: [] } } }), stderr: '', exitCode: 0 };
		assert.deepStrictEqual(await h.fetcher.fetch(false), undefined);
	});

	test('runs agy in a new private folder each time and removes it afterwards', async () => {
		const parent = fs.mkdtempSync(join(tmpdir(), 'paradis-agy-workdir-test-'));
		try {
			const first = await paradisCreateAntigravityWorkDir(parent);
			const second = await paradisCreateAntigravityWorkDir(parent);
			const mode = fs.statSync(first.path).mode & 0o777;
			const distinct = first.path !== second.path;
			await first.dispose();
			await second.dispose();
			assert.deepStrictEqual({ mode: process.platform === 'win32' ? 0o700 : mode, distinct, left: fs.readdirSync(parent) }, { mode: 0o700, distinct: true, left: [] });
		} finally {
			fs.rmSync(parent, { recursive: true, force: true });
		}
	});

	test('runs agy only once for requests that arrive while it is running', async () => {
		const h = harness();
		const [a, b] = await Promise.all([h.fetcher.fetch(false), h.fetcher.fetch(true)]);
		assert.deepStrictEqual({ same: a?.accounts[0] === b?.accounts[0], runs: h.runs.length }, { same: true, runs: 1 });
	});
});
