/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import * as assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { PARADIS_CURSOR_WAIT_BUDGET_MS, ParadisCursorPacingLedger, paradisCursorStatusForTool } from '../../node/paradisCursorPacing.js';

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
