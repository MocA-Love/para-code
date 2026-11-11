/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { paradisAntigravityNeedsSignIn, paradisParseAntigravityUsage } from '../../common/paradisAntigravityUsage.js';

/** agy 1.5.6 の `agy -p "/usage" --output-format json` の出力（2026-11-12 に実測した形。値はそのまま、個人の値は出ない）。 */
export const PARADIS_ANTIGRAVITY_USAGE_SAMPLE = JSON.stringify({
	conversation_id: '',
	status: 'SUCCESS',
	response: 'Gemini Models\tWeekly Limit Remaining\t91%\t2026-11-18T16:44:24Z\nClaude and GPT models\tWeekly Limit Remaining\t100%\t2026-11-18T20:55:15Z\n',
	duration_seconds: 0,
	num_turns: 0,
	usage: { input_tokens: 0, output_tokens: 0, thinking_tokens: 0, cache_read_tokens: 0, total_tokens: 0 },
	command: {
		name: 'usage',
		data: {
			description: 'Within each group, models share a weekly limit. Quota is consumed proportionally to the cost of the tokens. Thus, limits will last longer with shorter tasks or using more cost-effective models. Your weekly limit is tied directly to your individual tier.',
			groups: [
				{
					name: 'Gemini Models',
					description: 'Models within this group: Gemini Flash, Gemini Pro',
					buckets: [{ id: 'gemini-weekly', name: 'Weekly Limit Remaining', description: 'You have used some of your weekly limit, it will fully refresh in 6 days, 19 hours.', window: 'weekly', remaining_fraction: 0.913214385509491, reset_time: '2026-11-18T16:44:24Z' }],
				},
				{
					name: 'Claude and GPT models',
					description: 'Models within this group: Claude Opus, Claude Sonnet, GPT-OSS',
					buckets: [{ id: '3p-weekly', name: 'Weekly Limit Remaining', window: 'weekly', remaining_fraction: 1, reset_time: '2026-11-18T20:55:15Z' }],
				},
			],
		},
	},
});

/** サインインしていない HOME で動かしたときの出力（ログインの URL は省いた）。 */
export const PARADIS_ANTIGRAVITY_SIGNED_OUT_STDOUT = JSON.stringify({ conversation_id: '', status: 'ERROR', response: '', error: 'authentication failed or timed out', duration_seconds: 0, num_turns: 0, finished_reason: 'error' });
export const PARADIS_ANTIGRAVITY_SIGNED_OUT_STDERR = 'Authentication required. Please visit the URL to log in:\n  https://accounts.google.com/o/oauth2/auth?...\n\nWaiting for authentication (timeout 60s)...\n';

suite('Paradis Antigravity usage parsing', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	test('reads the two weekly groups of the real output into named windows', () => {
		assert.deepStrictEqual(paradisParseAntigravityUsage(PARADIS_ANTIGRAVITY_USAGE_SAMPLE + '\n', ''), {
			kind: 'ok',
			windows: [
				{ usedPercent: 8.7, label: 'Gemini', resetsAt: Date.parse('2026-11-18T16:44:24Z') },
				{ usedPercent: 0, label: 'Claude・GPT', resetsAt: Date.parse('2026-11-18T20:55:15Z') },
			],
		});
	});

	test('treats a bucket without remaining_fraction as used up, drops disabled ones and names unknown ones by their group', () => {
		const output = JSON.stringify({
			status: 'SUCCESS',
			command: {
				name: 'usage', data: {
					groups: [
						// 0 は項目ごと省かれる
						{ name: 'Gemini Models', buckets: [{ id: 'gemini-weekly', window: 'weekly', reset_time: '2026-11-18T16:44:24Z' }] },
						{ name: 'Claude and GPT models', buckets: [{ id: '3p-weekly', window: 'weekly', remaining_fraction: 0.5, reset_time: '2026-11-18T20:55:15Z', disabled: true }] },
						{ name: 'Future Models', buckets: [{ id: 'future-daily', window: 'daily', remaining_fraction: 0.25 }, { id: 'no-values' }] },
					],
				},
			},
		});
		// 前後に JSON ではない行が混じっても読む
		assert.deepStrictEqual(paradisParseAntigravityUsage(`Checking for updates...\n${output}\n`, ''), {
			kind: 'ok',
			windows: [
				{ usedPercent: 100, label: 'Gemini', resetsAt: Date.parse('2026-11-18T16:44:24Z') },
				{ usedPercent: 75, label: 'Future Models' },
			],
		});
	});

	test('tells signing in apart from other failures', () => {
		assert.deepStrictEqual({
			signedOut: paradisParseAntigravityUsage(PARADIS_ANTIGRAVITY_SIGNED_OUT_STDOUT, PARADIS_ANTIGRAVITY_SIGNED_OUT_STDERR),
			// 止めたので stdout が空のまま
			stoppedWhileWaiting: paradisParseAntigravityUsage('', PARADIS_ANTIGRAVITY_SIGNED_OUT_STDERR),
			errorOnly: paradisParseAntigravityUsage(PARADIS_ANTIGRAVITY_SIGNED_OUT_STDOUT, ''),
			failed: paradisParseAntigravityUsage(JSON.stringify({ status: 'ERROR', error: 'quota service unavailable' }), ''),
			notJson: paradisParseAntigravityUsage('panic: something went wrong', ''),
			otherCommand: paradisParseAntigravityUsage(JSON.stringify({ status: 'SUCCESS', command: { name: 'credits', data: {} } }), ''),
			// 値が出ていれば、ログインの文が混じっていても値を使う
			valueWins: paradisParseAntigravityUsage(PARADIS_ANTIGRAVITY_USAGE_SAMPLE, PARADIS_ANTIGRAVITY_SIGNED_OUT_STDERR).kind,
			needsSignIn: [paradisAntigravityNeedsSignIn('', PARADIS_ANTIGRAVITY_SIGNED_OUT_STDERR), paradisAntigravityNeedsSignIn(PARADIS_ANTIGRAVITY_USAGE_SAMPLE, '')],
		}, {
			signedOut: { kind: 'signed_out' },
			stoppedWhileWaiting: { kind: 'signed_out' },
			errorOnly: { kind: 'signed_out' },
			failed: { kind: 'error', detail: 'agy /usage failed: quota service unavailable' },
			notJson: { kind: 'error', detail: 'agy did not print JSON for /usage' },
			otherCommand: { kind: 'error', detail: 'agy /usage printed an unexpected shape' },
			valueWins: 'ok',
			needsSignIn: [true, false],
		});
	});
});
