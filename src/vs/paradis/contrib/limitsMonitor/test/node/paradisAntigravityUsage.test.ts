/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { NullLogService } from '../../../../../platform/log/common/log.js';
import { IParadisRunAgentCliOptions, IParadisRunAgentCliResult } from '../../../../node/paradisAgentCli.js';
import { ParadisAntigravityUsageFetcher } from '../../node/paradisAntigravityUsage.js';
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
}

function harness(installed = true): IHarness {
	const state: Omit<IHarness, 'fetcher'> = {
		runs: [],
		next: { stdout: PARADIS_ANTIGRAVITY_USAGE_SAMPLE, stderr: '', exitCode: 0 },
		now: Date.parse('2026-11-12T00:00:00Z'),
		stamp: 'a',
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
		workDir: async () => '/tmp/para-code-agy-usage',
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
		assert.deepStrictEqual({ first, runsWithinInterval, runs: h.runs }, {
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
			runs: [1, 2, 3].map(() => ({ args: ['-p', '/usage', '--output-format', 'json'], timeoutMs: 20_000, cwd: '/tmp/para-code-agy-usage', stops: true })),
		});
	});

	test('asks to sign in and waits until the sign-in changes or ten minutes pass', async () => {
		const h = harness();
		h.next = { stdout: '', stderr: PARADIS_ANTIGRAVITY_SIGNED_OUT_STDERR, exitCode: null, stopped: true };
		const signedOut = await h.fetcher.fetch(false);
		h.now += 6 * MINUTE;
		await h.fetcher.fetch(false);
		const runsWhileWaiting = h.runs.length;
		h.stamp = 'b';
		h.next = { stdout: PARADIS_ANTIGRAVITY_USAGE_SAMPLE, stderr: '', exitCode: 0 };
		const afterSignIn = await h.fetcher.fetch(false);
		assert.deepStrictEqual({ signedOut, runsWhileWaiting, afterSignIn: afterSignIn?.accounts[0].status, runs: h.runs.length }, {
			signedOut: { accounts: [{ provider: 'antigravity', id: '/home/example/.gemini', homeLabel: '~/.gemini', active: true, status: 'relogin_required', statusDetail: 'Antigravity CLI is not signed in' }] },
			runsWhileWaiting: 1,
			afterSignIn: 'ok',
			runs: 2,
		});
	});

	test('keeps the last value as a previous value when a run fails, and waits ten minutes before trying again', async () => {
		const h = harness();
		await h.fetcher.fetch(false);
		h.now += 5 * MINUTE;
		h.next = new Error('/usr/bin/agy timed out after 20000ms');
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
				status: 'unavailable', unavailableReason: 'not_fetched', statusDetail: '/usr/bin/agy timed out after 20000ms',
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

	test('runs agy only once for requests that arrive while it is running', async () => {
		const h = harness();
		const [a, b] = await Promise.all([h.fetcher.fetch(false), h.fetcher.fetch(true)]);
		assert.deepStrictEqual({ same: a?.accounts[0] === b?.accounts[0], runs: h.runs.length }, { same: true, runs: 1 });
	});
});
