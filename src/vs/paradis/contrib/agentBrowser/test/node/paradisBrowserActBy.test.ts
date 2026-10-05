/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { IParadisCdpInputDispatchResult } from '../../common/paradisAgentBrowser.js';
import { IParadisBrowserActCall, ParadisBrowserActBy } from '../../node/paradisBrowserActBy.js';
import { PARADIS_BROWSER_QUERY_PAGE_SCRIPT } from '../../node/paradisBrowserQueryPageScript.js';
import { PARADIS_BROWSER_ACT_TOOL_NAMES, PARADIS_MCP_BROWSER_ACT_TOOLS } from '../../node/paradisBrowserQueryTools.js';

interface IResult {
	readonly content: readonly { readonly text: string }[];
	readonly isError?: boolean;
}

function textOf(result: unknown): string {
	return (result as IResult).content[0].text;
}

function isError(result: unknown): boolean {
	return (result as IResult).isError === true;
}

function returned(value: unknown): unknown {
	return { content: [{ type: 'text', text: `Script ran on page and returned:\n\`\`\`json\n${JSON.stringify(value)}\n\`\`\`` }] };
}

/** Answers evaluate_script from a list (by mode) and records the input that was sent. */
class FakePage {
	readonly modes: string[] = [];
	readonly sent: string[] = [];
	refusal: string | undefined;

	constructor(private readonly answers: Record<string, unknown[]>) { }

	call(): IParadisBrowserActCall {
		return {
			evaluate: async source => {
				const rest = source.slice(source.indexOf(PARADIS_BROWSER_QUERY_PAGE_SCRIPT) + PARADIS_BROWSER_QUERY_PAGE_SCRIPT.length);
				const spec = JSON.parse(/^\)\((?<spec>\{.*?\}), \[/s.exec(rest)!.groups!.spec) as { mode: string };
				this.modes.push(spec.mode);
				const list = this.answers[spec.mode];
				return returned(list.length > 1 ? list.shift() : list[0]);
			},
			dispatch: async (method, params): Promise<IParadisCdpInputDispatchResult> => {
				if (this.refusal !== undefined) {
					return { status: 'retryable', message: this.refusal };
				}
				this.sent.push(method === 'Input.dispatchMouseEvent' ? `${params.type}@${params.x},${params.y}${params.clickCount ? `#${params.clickCount}` : ''}` : method === 'Input.insertText' ? `insert:${params.text}` : `${params.type}:${params.key}`);
				return { status: 'success', result: {} };
			},
			isCurrent: () => true,
		};
	}
}

const button = { matched: 1, element: { tag: 'button', name: 'Save' }, kind: 'other', visible: true, enabled: true, x: 50, y: 20 };
const field = { matched: 1, element: { tag: 'input', name: 'Email' }, kind: 'text', visible: true, enabled: true, readOnly: false, value: 'old', x: 100, y: 40 };

suite('paradisBrowserActBy (shared process)', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	test('every tool name has exactly one definition', () => {
		assert.deepStrictEqual(PARADIS_MCP_BROWSER_ACT_TOOLS.map(tool => tool.name), [...PARADIS_BROWSER_ACT_TOOL_NAMES]);
	});

	test('click_by finds the element and clicks its center with trusted mouse input', async () => {
		const page = new FakePage({ locate: [button] });
		const result = await new ParadisBrowserActBy(() => 'ref').call(page.call(), 'click_by', { role: 'button', name: 'Save', double: true });
		assert.deepStrictEqual({ error: isError(result), first: textOf(result).split('\n')[0], sent: page.sent }, {
			error: false,
			first: 'Double-clicked at (50, 20).',
			sent: ['mouseMoved@50,20', 'mousePressed@50,20#1', 'mouseReleased@50,20#1', 'mousePressed@50,20#2', 'mouseReleased@50,20#2'],
		});
	});

	test('click_by sends nothing and explains why when the element is covered, disabled or missing', async () => {
		const covered = new FakePage({ locate: [{ ...button, problem: 'covered', coveredBy: { tag: 'div', classes: ['modal'] } }] });
		const disabled = new FakePage({ locate: [{ ...button, enabled: false }] });
		const missing = new FakePage({ locate: [{ matched: 0 }] });
		const actBy = new ParadisBrowserActBy(() => 'ref');
		const results = [
			await actBy.call(covered.call(), 'click_by', { text: 'Save' }),
			await actBy.call(disabled.call(), 'click_by', { text: 'Save' }),
			await actBy.call(missing.call(), 'click_by', { text: 'Save' }),
		];
		assert.deepStrictEqual({
			errors: results.map(isError),
			reasons: results.map(result => /covered|disabled|no element matches/.exec(textOf(result))?.[0]),
			coveredBy: textOf(results[0]).includes('"classes":["modal"]'),
			sent: [...covered.sent, ...disabled.sent, ...missing.sent],
		}, {
			errors: [true, true, true],
			reasons: ['covered', 'disabled', 'no element matches'],
			coveredBy: true,
			sent: [],
		});
	});

	test('fill_by selects the old content and inserts the text, then reports the value', async () => {
		const page = new FakePage({ locate: [field], focusField: [{ focused: true, value: 'old', empty: false }], readField: [{ value: 'new@example.com' }] });
		const result = await new ParadisBrowserActBy(() => 'ref').call(page.call(), 'fill_by', { role: 'textbox', name: 'Email', value: 'new@example.com', submit: true });
		assert.deepStrictEqual({ error: isError(result), lines: textOf(result).split('\n').slice(0, 2), modes: page.modes, sent: page.sent }, {
			error: false,
			lines: ['Selected the old content and inserted the text as trusted input, then pressed Enter.', 'Value now: "new@example.com"'],
			modes: ['locate', 'focusField', 'readField'],
			sent: ['insert:new@example.com', 'keyDown:Enter', 'keyUp:Enter'],
		});
	});

	test('fill_by clicks a field that does not take focus from a script, and clears with Backspace', async () => {
		const page = new FakePage({ locate: [field], focusField: [{ focused: false, value: 'old', empty: false }, { focused: true, value: 'old', empty: false }], readField: [{ value: '' }] });
		const result = await new ParadisBrowserActBy(() => 'ref').call(page.call(), 'fill_by', { selector: 'input', value: '' });
		assert.deepStrictEqual({ error: isError(result), sent: page.sent }, {
			error: false,
			sent: ['mouseMoved@100,40', 'mousePressed@100,40#1', 'mouseReleased@100,40#1', 'rawKeyDown:Backspace', 'keyUp:Backspace'],
		});
	});

	test('fill_by clicks a checkbox only when its state has to change, and refuses a value it cannot set', async () => {
		const checkbox = { ...field, kind: 'checkbox', value: 'false' };
		const change = new FakePage({ locate: [checkbox], readField: [{ value: 'true' }] });
		const same = new FakePage({ locate: [checkbox], readField: [{ value: 'false' }] });
		const wrong = new FakePage({ locate: [checkbox] });
		const actBy = new ParadisBrowserActBy(() => 'ref');
		const results = [
			await actBy.call(change.call(), 'fill_by', { selector: '#agree', value: 'true' }),
			await actBy.call(same.call(), 'fill_by', { selector: '#agree', value: 'false' }),
			await actBy.call(wrong.call(), 'fill_by', { selector: '#agree', value: 'yes' }),
		];
		assert.deepStrictEqual({ errors: results.map(isError), sent: [change.sent.length, same.sent.length, wrong.sent.length] }, {
			errors: [false, false, true],
			sent: [3, 0, 0],
		});
	});

	test('a refusal of the input path is returned as the reason', async () => {
		const page = new FakePage({ locate: [button] });
		page.refusal = 'the user is using this page';
		const result = await new ParadisBrowserActBy(() => 'ref').call(page.call(), 'click_by', { text: 'Save' });
		assert.deepStrictEqual([isError(result), textOf(result)], [true, 'click_by found the element but the click was not completed: the user is using this page']);
	});
});
