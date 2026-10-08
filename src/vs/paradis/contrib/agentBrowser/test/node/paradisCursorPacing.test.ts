/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import * as assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { PARADIS_CURSOR_WAIT_BUDGET_MS, ParadisCursorPacingLedger, paradisCursorStatusForTool, paradisToolCursorRunKey, paradisWithToolCursorStatus } from '../../node/paradisCursorPacing.js';
import { paradisAttachSnapshotRootRect } from '../../node/paradisDevtoolsToolAdjustments.js';

const MOVE = JSON.stringify({ type: 'mouseMoved', x: 1, y: 2 });
const PRESS = JSON.stringify({ type: 'mousePressed', x: 1, y: 2, button: 'left', clickCount: 1 });

suite('Paradis cursor pacing', () => {

	ensureNoDisposablesAreLeakedInTestSuite();

	test('moves inside a click never wait, hovers wait once per call, and input outside a tool call is left alone', () => {
		const ledger = new ParadisCursorPacingLedger();
		const outside = ledger.ticketFor('pane', 'Input.dispatchMouseEvent', MOVE)?.pacing;

		const click = ledger.begin('pane', 'click', { uid: '1' });
		const clickMove = ledger.ticketFor('pane', 'Input.dispatchMouseEvent', MOVE)?.pacing;
		const clickPress = ledger.ticketFor('pane', 'Input.dispatchMouseEvent', PRESS)?.pacing;
		const key = ledger.ticketFor('pane', 'Input.dispatchKeyEvent', JSON.stringify({ type: 'keyDown', key: 'mouseMoved' }))?.pacing;
		click.dispose();

		const split = ledger.begin('pane', 'mouse_action', { action: 'move', x: 1, y: 2, steps: 5 });
		const firstStep = ledger.ticketFor('pane', 'Input.dispatchMouseEvent', MOVE)?.pacing;
		const secondStep = ledger.ticketFor('pane', 'Input.dispatchMouseEvent', MOVE)?.pacing;
		split.dispose();

		const down = ledger.begin('pane', 'mouse_action', { action: 'down', x: 1, y: 2 });
		const downMove = ledger.ticketFor('pane', 'Input.dispatchMouseEvent', MOVE)?.pacing;
		down.dispose();

		assert.deepStrictEqual(
			{ outside, clickMove, clickPress, key, firstStep, secondStep, downMove, after: ledger.ticketFor('pane', 'Input.dispatchMouseEvent', MOVE) },
			{
				outside: undefined,
				clickMove: { pressFollows: true },
				clickPress: undefined,
				key: undefined,
				firstStep: { maxWaitMs: PARADIS_CURSOR_WAIT_BUDGET_MS },
				secondStep: { maxWaitMs: 0 },
				downMove: { pressFollows: true },
				after: undefined,
			},
		);
	});

	test('tools without input name what they do on the cursor', () => {
		const tools = ['evaluate_script', 'navigate_page', 'wait_until', 'take_snapshot', 'get_text', 'inspect_element', 'list_console_messages', 'list_network_requests', 'scroll_to', 'take_screenshot', 'list_pages', 'click'];
		assert.deepStrictEqual(Object.fromEntries(tools.map(tool => [tool, paradisCursorStatusForTool(tool)])), {
			evaluate_script: 'script', navigate_page: 'loading', wait_until: 'waiting', take_snapshot: 'reading', get_text: 'reading', inspect_element: 'reading',
			list_console_messages: 'reading', list_network_requests: 'reading', scroll_to: 'scroll', take_screenshot: undefined, list_pages: undefined, click: undefined,
		});
	});

	test('a tool states its work at the start and clears it at the end, once the last one on the page ends', async () => {
		const runs = new Map<string, number>();
		const first: unknown[] = [];
		const second: unknown[] = [];
		let finishFirst!: () => void;
		const running = paradisWithToolCursorStatus('evaluate_script', runs, 'page', note => first.push(note), () => new Promise<string>(resolve => { finishFirst = () => resolve('done'); }), () => 42);
		await paradisWithToolCursorStatus('wait_until', runs, 'page', note => second.push(note), async () => 'waited');
		finishFirst();
		const result = await running;
		// The end of a failed tool still clears the state.
		const failed: unknown[] = [];
		await assert.rejects(paradisWithToolCursorStatus('get_text', runs, 'other', note => failed.push(note), async () => { throw new Error('boom'); }));
		const plain: unknown[] = [];
		await paradisWithToolCursorStatus('click', runs, 'page', note => plain.push(note), async () => 'clicked');
		assert.deepStrictEqual({ result, first, second, failed, plain, runs: [...runs] }, {
			result: 'done',
			first: [{ status: 'script', since: 42 }, { status: 'idle' }],
			second: [{ status: 'waiting' }],
			failed: [{ status: 'reading' }, { status: 'idle' }],
			plain: [],
			runs: [],
		});
	});

	test('take_snapshot lights the root the proxy measured, or the whole page, but nothing when it failed', async () => {
		const runs = new Map<string, number>();
		const rect = { x: 1, y: 2, width: 30, height: 40 };
		const taken = { content: [{ type: 'text', text: '## Latest page snapshot\nuid=1_3 dialog' }] };
		paradisAttachSnapshotRootRect(taken, rect);
		const notes: unknown[] = [];
		const result = await paradisWithToolCursorStatus('take_snapshot', runs, 'page', note => notes.push(note), async () => taken);
		const plainNotes: unknown[] = [];
		await paradisWithToolCursorStatus('take_snapshot', runs, 'page', note => plainNotes.push(note), async () => ({ content: [{ type: 'text', text: '## Latest page snapshot\nuid=1_0 page' }] }));
		const failedNotes: unknown[] = [];
		await paradisWithToolCursorStatus('take_snapshot', runs, 'page', note => failedNotes.push(note), async () => ({ content: [{ type: 'text', text: 'No page' }], isError: true }));
		assert.deepStrictEqual({ result, notes, plainNotes, failedNotes }, {
			result: { content: [{ type: 'text', text: '## Latest page snapshot\nuid=1_3 dialog' }] },
			notes: [{ status: 'reading' }, { flash: true, rect }, { status: 'idle' }],
			plainNotes: [{ status: 'reading' }, { flash: true }, { status: 'idle' }],
			failedNotes: [{ status: 'reading' }, { status: 'idle' }],
		});
	});

	test('a tool that moved to another tab mid-way still sends its end to the page it started on', async () => {
		const runs = new Map<string, number>();
		const onA: unknown[] = [];
		const onB: unknown[] = [];
		let finishA!: () => void;
		// evaluate_script starts on tab A; the pane's current tab changes to B, where wait_until starts and ends.
		const onTabA = paradisWithToolCursorStatus('evaluate_script', runs, paradisToolCursorRunKey('pane', 'view-a'), note => onA.push(note), () => new Promise<void>(resolve => { finishA = resolve; }), () => 7);
		const onTabB = paradisWithToolCursorStatus('wait_until', runs, paradisToolCursorRunKey('pane', 'view-b'), note => onB.push(note), () => new Promise<void>(resolve => setTimeout(resolve, 0)));
		finishA();
		await Promise.all([onTabA, onTabB]);
		assert.deepStrictEqual({ onA, onB, runs: [...runs] }, { onA: [{ status: 'script', since: 7 }, { status: 'idle' }], onB: [{ status: 'waiting' }, { status: 'idle' }], runs: [] });
	});

	test('run_steps shares one wait budget across its steps', () => {
		const ledger = new ParadisCursorPacingLedger();
		const steps = ledger.begin('pane', 'run_steps', {});
		const remaining: (number | undefined)[] = [];
		for (let i = 0; i < 3; i++) {
			const hover = ledger.begin('pane', 'hover', { uid: String(i) });
			const ticket = ledger.ticketFor('pane', 'Input.dispatchMouseEvent', MOVE);
			remaining.push(ticket?.pacing.maxWaitMs);
			ticket?.settle(250);
			hover.dispose();
		}
		// Another pane has its own budget.
		const other = ledger.begin('other', 'hover', {});
		const otherBudget = ledger.ticketFor('other', 'Input.dispatchMouseEvent', MOVE)?.pacing.maxWaitMs;
		other.dispose();
		steps.dispose();

		assert.deepStrictEqual({ remaining, otherBudget }, { remaining: [600, 350, 100], otherBudget: PARADIS_CURSOR_WAIT_BUDGET_MS });
	});
});
