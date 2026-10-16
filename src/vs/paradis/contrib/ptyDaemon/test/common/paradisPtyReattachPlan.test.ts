/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { isParadisSentryScrubbedWord } from '../../../sentry/common/paradisSentryDiagnostics.js';
import { IParadisPtyHandoverReport, paradisIsEmptyPtyHandoverReport, paradisPtyHandoverProblem, paradisPtyHandoverSpans, paradisPtyLateAdoptions } from '../../common/paradisPtyHandover.js';
import { IParadisPtyAttachment } from '../../common/paradisPtyProtocol.js';
import { paradisPlanPtyReattach } from '../../common/paradisPtyReattachPlan.js';

function attachment(frames: { cols: number; rows: number; data: string }[], extra: Partial<IParadisPtyAttachment> = {}): IParadisPtyAttachment {
	return { frames, dropped: false, ...extra };
}

suite('Para pty reattach plan', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	test('離れている間に増えた量で、触らない・差分を流す・作り直すを選ぶ', () => {
		const frames = [{ cols: 80, rows: 24, data: 'old' }, { cols: 100, rows: 30, data: 'abcdef' }];
		assert.deepStrictEqual(
			{
				unchanged: paradisPlanPtyReattach({ written: 9, epoch: 0 }, attachment(frames, { written: 9, epoch: 0 })),
				tail: paradisPlanPtyReattach({ written: 6, epoch: 0 }, attachment(frames, { written: 9, epoch: 0 })),
				// 増えた分が最後のコマ（大きさの変わり目の後）に収まらない。
				spansResize: paradisPlanPtyReattach({ written: 2, epoch: 0 }, attachment(frames, { written: 9, epoch: 0 })),
				// 増えた分が控えに残っている量より多い（先頭が捨てられた）。
				dropped: paradisPlanPtyReattach({ written: 0, epoch: 0 }, attachment(frames, { written: 20, epoch: 0 })),
				cleared: paradisPlanPtyReattach({ written: 6, epoch: 0 }, attachment(frames, { written: 9, epoch: 1 })),
				rewound: paradisPlanPtyReattach({ written: 12, epoch: 0 }, attachment(frames, { written: 9, epoch: 0 })),
				// 古い常駐は量を返さない。
				noCount: paradisPlanPtyReattach({ written: 6, epoch: 0 }, attachment(frames)),
				noMark: paradisPlanPtyReattach(undefined, attachment(frames, { written: 9, epoch: 0 })),
				// 控えの先頭がこぼれていても、増えた分が丸ごと残っていれば差分で足りる。
				tailDespiteDropped: paradisPlanPtyReattach({ written: 7, epoch: 0 }, attachment(frames, { written: 9, epoch: 0, dropped: true })),
			},
			{
				unchanged: { kind: 'unchanged' },
				tail: { kind: 'tail', data: 'def' },
				spansResize: { kind: 'rebuild', reason: 'spans-resize' },
				dropped: { kind: 'rebuild', reason: 'dropped' },
				cleared: { kind: 'rebuild', reason: 'cleared' },
				rewound: { kind: 'rebuild', reason: 'rewound' },
				noCount: { kind: 'rebuild', reason: 'no-count' },
				noMark: { kind: 'rebuild', reason: 'no-mark' },
				tailDespiteDropped: { kind: 'tail', data: 'ef' },
			},
		);
	});
});

suite('Para pty handover report', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	const report: IParadisPtyHandoverReport = {
		protocolVersion: 2,
		platform: 'linux',
		daemon: true,
		foreignHeld: 1,
		adoptions: [
			{ trigger: 'startup', reachable: true, adopted: 2, foreign: 1, failed: 0, finished: 1, layouts: 1, durationMs: 40 },
			{ trigger: 'poll', reachable: true, adopted: 1, foreign: 0, failed: 1, finished: 0, layouts: 1, durationMs: 12 },
		],
		letGo: 3,
		letGoFailed: 0,
		reattach: { unchanged: 1, tail: 1, rebuild: 1, handedOff: 0, gone: 0, failed: 0, tailChars: 10, rebuildChars: 2000, maxRebuildMs: 30, rebuildReasons: { 'spans-resize': 1 } },
		spared: 0,
		finishedWhileAway: 1,
	};

	test('Sentry へ送る span のキーにも固定の値にも、Sentry が消す語を入れない', () => {
		const spans = paradisPtyHandoverSpans(report, true);
		const problem = paradisPtyHandoverProblem(report);
		const scrubbed: string[] = [];
		for (const attributes of [...spans.map(span => span.attributes), problem?.data ?? {}]) {
			for (const [key, value] of Object.entries(attributes)) {
				if (isParadisSentryScrubbedWord(key) || (typeof value === 'string' && isParadisSentryScrubbedWord(value))) {
					scrubbed.push(key);
				}
			}
		}
		assert.deepStrictEqual(
			{ operations: spans.map(span => span.operation), scrubbed, problem: problem?.operation, late: paradisPtyLateAdoptions(report), rebuildReason: spans[2].attributes.safe_rebuild_spans_resize },
			{ operations: ['adopt', 'adopt', 'reattach'], scrubbed: [], problem: 'failed:adopt', late: 1, rebuildReason: 1 },
		);
	});

	test('何も起きていない記録は送らない', () => {
		const empty: IParadisPtyHandoverReport = {
			...report,
			adoptions: [],
			letGo: 0,
			finishedWhileAway: 0,
			reattach: { unchanged: 0, tail: 0, rebuild: 0, handedOff: 0, gone: 0, failed: 0, tailChars: 0, rebuildChars: 0, maxRebuildMs: 0, rebuildReasons: {} },
		};
		assert.deepStrictEqual({ empty: paradisIsEmptyPtyHandoverReport(empty), spans: paradisPtyHandoverSpans(empty, false).length, problem: paradisPtyHandoverProblem(empty) }, { empty: true, spans: 0, problem: undefined });
	});
});
