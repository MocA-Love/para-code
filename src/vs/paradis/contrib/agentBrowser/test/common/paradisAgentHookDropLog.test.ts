/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { PARADIS_HOOK_DROP_MAX_COUNTER_KEYS, ParadisAgentHookDropCounter, paradisFormatHookDropLog, paradisHookDropPaneKey, paradisHookTranscriptTail, paradisSanitizeHookEventForLog, paradisShouldEmitHookDropLog } from '../../common/paradisAgentHookDropLog.js';

suite('paradisAgentHookDropLog', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	test('emits on the first drop and whenever the count reaches a power of two', () => {
		const counts = [0, 1, 2, 3, 4, 5, 7, 8, 9, 1024, 1025, -1, 1.5];
		assert.deepStrictEqual(counts.map(paradisShouldEmitHookDropLog), [false, true, true, false, true, false, false, true, false, true, false, false, false]);
	});

	test('counts per pane and reason, and totals per reason across panes', () => {
		const counter = new ParadisAgentHookDropCounter();
		const results = [
			counter.note('pane-a', 'origin-transcript-mismatch'),
			counter.note('pane-a', 'origin-transcript-mismatch'),
			counter.note('pane-a', 'origin-transcript-mismatch'),
			counter.note('pane-b', 'origin-transcript-mismatch'),
			counter.note('pane-a', 'ingress-exited-pane'),
		];
		assert.deepStrictEqual(results, [
			{ paneCount: 1, reasonTotal: 1, emit: true },
			{ paneCount: 2, reasonTotal: 2, emit: true },
			{ paneCount: 3, reasonTotal: 3, emit: false },
			{ paneCount: 1, reasonTotal: 4, emit: true },
			{ paneCount: 1, reasonTotal: 1, emit: true },
		]);
	});

	test('forgets the oldest pane and reason pair beyond the key limit', () => {
		const counter = new ParadisAgentHookDropCounter();
		counter.note('pane-0', 'ingress-exited-pane');
		counter.note('pane-1', 'ingress-exited-pane');
		counter.note('pane-1', 'ingress-exited-pane');
		for (let i = 2; i < PARADIS_HOOK_DROP_MAX_COUNTER_KEYS; i++) {
			counter.note(`pane-${i}`, 'ingress-exited-pane');
		}
		// 上限 + 1 個目のキーで、一番古く数えた pane-0 だけが追い出される（pane-1 は残る）
		counter.note('pane-new', 'ingress-exited-pane');
		assert.deepStrictEqual([
			counter.note('pane-1', 'ingress-exited-pane').paneCount,
			counter.note('pane-0', 'ingress-exited-pane').paneCount,
		], [3, 1]);
	});

	test('counts unknown tokens under one key so changing the token does not defeat throttling', () => {
		const counter = new ParadisAgentHookDropCounter();
		let fingerprinted = 0;
		const keyOf = (known: boolean, token: string) => paradisHookDropPaneKey(known, () => { fingerprinted++; return `fp-${token}`; });
		const results = ['a', 'b', 'c'].map(token => counter.note(keyOf(false, token), 'ingress-unknown-pane'));
		assert.deepStrictEqual([
			results.map(result => [result.paneCount, result.emit]),
			keyOf(true, 'x'),
			fingerprinted,
		], [[[1, true], [2, true], [3, false]], 'fp-x', 1]);
	});

	test('logs only the tail of the transcript file name and a sanitized event name', () => {
		assert.deepStrictEqual([
			paradisHookTranscriptTail('/home/user/.claude/projects/-repo/11111111-1111-1111-1111-1234567890ab.jsonl'),
			paradisHookTranscriptTail('C:\\Users\\user\\.codex\\sessions\\rollout-2026-07-16T16-06-01-abc.jsonl'),
			paradisHookTranscriptTail(undefined),
			paradisSanitizeHookEventForLog('UserPromptSubmit'),
			paradisSanitizeHookEventForLog('Stop\n<x>'),
			paradisSanitizeHookEventForLog(null),
		], ['~7890ab', '~01-abc', '-', 'UserPromptSubmit', 'Stop??x?', '-']);
	});

	test('formats one line without the full transcript path', () => {
		const line = paradisFormatHookDropLog({
			reason: 'origin-transcript-mismatch', pane: '0123456789ab', event: 'UserPromptSubmit', side: 'remote', pid: 'stripped',
			identityLoss: 'no-pid', ownerPinnedBy: 'transcript',
			transcriptPath: '/home/user/.claude/projects/-repo/22222222-2222-2222-2222-222222bbbbbb.jsonl',
			ownerTranscriptPath: '/home/user/.claude/projects/-repo/11111111-1111-1111-1111-111111aaaaaa.jsonl',
			ownerIdleMs: 812_400,
		}, 8, 40);
		assert.strictEqual(line, 'agent-hook dropped reason=origin-transcript-mismatch pane=0123456789ab event=UserPromptSubmit side=remote pid=stripped identity=no-pid owner=transcript tx=~bbbbbb ownerTx=~aaaaaa ownerIdle=812s n=8 total=40');
	});
});
