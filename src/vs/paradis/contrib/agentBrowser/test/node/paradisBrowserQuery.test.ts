/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { IParadisBrowserQueryCall, ParadisBrowserQuery, paradisBuildQueryFunction, paradisLookedAtRect, paradisParseQueryLocator } from '../../node/paradisBrowserQuery.js';
import { PARADIS_BROWSER_QUERY_PAGE_SCRIPT } from '../../node/paradisBrowserQueryPageScript.js';
import { PARADIS_BROWSER_QUERY_TOOL_NAMES, PARADIS_MCP_BROWSER_QUERY_TOOLS } from '../../node/paradisBrowserQueryTools.js';

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

function failed(message: string): unknown {
	return { content: [{ type: 'text', text: message }], isError: true };
}

/** Answers evaluate_script from a list and advances a fake clock by `stepMs` per call. */
class FakePage {
	now = 0;
	readonly calls: { readonly spec: Record<string, unknown>; readonly uids: readonly string[] }[] = [];
	current = true;
	readonly looks: unknown[] = [];

	constructor(private readonly answers: unknown[], private readonly stepMs = 1000) { }

	call(): IParadisBrowserQueryCall {
		return {
			evaluate: async (source, uids) => {
				const rest = source.slice(source.indexOf(PARADIS_BROWSER_QUERY_PAGE_SCRIPT) + PARADIS_BROWSER_QUERY_PAGE_SCRIPT.length);
				const json = /^\)\((?<spec>\{.*?\}), \[/s.exec(rest)?.groups?.spec;
				this.calls.push({ spec: json ? JSON.parse(json) : {}, uids });
				this.now += this.stepMs;
				return this.answers.length > 1 ? this.answers.shift() : this.answers[0];
			},
			isCurrent: () => this.current,
			noteLook: rect => { this.looks.push(rect); },
		};
	}

	query(): ParadisBrowserQuery {
		return new ParadisBrowserQuery(async () => { this.now += 100; }, () => this.now);
	}
}

suite('paradisBrowserQuery (shared process)', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	test('every tool name has exactly one definition', () => {
		assert.deepStrictEqual(PARADIS_MCP_BROWSER_QUERY_TOOLS.map(tool => tool.name), [...PARADIS_BROWSER_QUERY_TOOL_NAMES]);
	});

	test('the page function is valid JavaScript with and without a predicate', () => {
		const parse = (source: string) => {
			try {
				new Function(`return (${source});`);
				return 'ok';
			} catch (error) {
				return String(error);
			}
		};
		assert.deepStrictEqual([
			parse(paradisBuildQueryFunction({ mode: 'wait', selector: '.a' }, 0)),
			parse(paradisBuildQueryFunction({ mode: 'text', targetIndex: 0 }, 1, '() => window.ready // trailing comment')),
		], ['ok', 'ok']);
	});

	test('a predicate that never settles ends the check at the end of its slice', async () => {
		const source = paradisBuildQueryFunction({ mode: 'wait', sliceMs: 100, intervalMs: 50 }, 0, '() => new Promise(() => { })');
		const run = new Function('location', `return (${source});`)({ href: 'about:blank' }) as () => Promise<Record<string, unknown>>;
		const result = await run();
		assert.deepStrictEqual({ met: result.met, predicateError: result.predicateError }, { met: false, predicateError: 'the predicate did not settle within this check' });
	});

	test('locators: uid alone, role needs a name only with role, within needs something to search', () => {
		assert.deepStrictEqual([
			paradisParseQueryLocator({ uid: '1_2' }),
			paradisParseQueryLocator({ role: 'button', name: 'Save', within_uid: '1_1', exact: true }),
			(paradisParseQueryLocator({ name: 'Save' }) as { error?: string }).error !== undefined,
			(paradisParseQueryLocator({ uid: '1_2', selector: '.a' }) as { error?: string }).error !== undefined,
			(paradisParseQueryLocator({ within: '.list' }) as { error?: string }).error !== undefined,
		], [
			{ spec: { targetIndex: 0 }, uids: ['1_2'], given: true },
			{ spec: { role: 'button', name: 'Save', exact: true, withinIndex: 0 }, uids: ['1_1'], given: true },
			true,
			true,
			true,
		]);
	});

	test('wait_until checks in short slices, keeps waiting across a navigation, and returns the element', async () => {
		const element = { tag: 'div', text: 'Saved', visible: true };
		const page = new FakePage([
			returned({ met: false, matched: 0, visible: 0 }),
			failed('Execution context was destroyed, most likely because of a navigation.'),
			returned({ met: true, matched: 1, visible: 1, element }),
		]);
		const result = await page.query().call(page.call(), 'wait_until', { text: 'Saved', timeout_seconds: 30, interval_ms: 100 });
		assert.deepStrictEqual({
			error: isError(result),
			met: textOf(result).startsWith('Condition met after'),
			specs: page.calls.map(call => [call.spec.mode, call.spec.state, call.spec.sliceMs, call.spec.intervalMs, call.spec.text]),
		}, {
			error: false,
			met: true,
			specs: [['wait', 'visible', 1000, 100, 'Saved'], ['wait', 'visible', 1000, 100, 'Saved'], ['wait', 'visible', 1000, 100, 'Saved']],
		});
	});

	test('wait_until times out with the last thing it saw, and stops at errors that waiting cannot fix', async () => {
		const page = new FakePage([returned({ met: false, matched: 2, visible: 0 })]);
		const timedOut = await page.query().call(page.call(), 'wait_until', { selector: '.toast', timeout_seconds: 3 });
		const syntax = new FakePage([failed('SyntaxError: Unexpected token')]);
		const broken = await syntax.query().call(syntax.call(), 'wait_until', { predicate: '() => (' });
		const nothing = await syntax.query().call(syntax.call(), 'wait_until', {});
		assert.deepStrictEqual({
			timedOut: [isError(timedOut), textOf(timedOut).startsWith('Timed out after 3s waiting for visible selector ".toast" (3 checks)'), textOf(timedOut).includes('"matched": 2')],
			broken: [isError(broken), syntax.calls.length],
			nothing: isError(nothing),
		}, {
			timedOut: [true, true, true],
			broken: [true, 1],
			nothing: true,
		});
	});

	test('get_text returns a part and tells the offset of the next one', async () => {
		const page = new FakePage([returned({ matched: 3, returned: 1, total: 9000, part: 'a'.repeat(4001), element: { tag: 'p' } })]);
		const result = await page.query().call(page.call(), 'get_text', { selector: 'p' });
		const notFound = new FakePage([returned({ matched: 0, returned: 0, total: 0, part: '' })]);
		const missing = await notFound.query().call(notFound.call(), 'get_text', { selector: 'p' });
		assert.deepStrictEqual({
			spec: page.calls[0].spec,
			head: textOf(result).split('\n').slice(0, 2),
			length: textOf(result).split('\n\n')[1].length,
			missing: isError(missing),
		}, {
			spec: { selector: 'p', mode: 'text', all: false, offset: 0, maxChars: 4001 },
			head: ['3 element(s) matched. Element: {"tag":"p"}', 'Showing characters 0-4000 of 9000. Call get_text again with "offset": 4000 for the next part.'],
			length: 4000,
			missing: true,
		});
	});

	test('inspect_element passes the uid and the styles, and explains a missing index', async () => {
		const page = new FakePage([returned({ matched: 1, element: { tag: 'button' }, pointer: { center: 'self' } })]);
		const result = await page.query().call(page.call(), 'inspect_element', { uid: '4_2', styles: ['z-index'] });
		const short = new FakePage([returned({ matched: 1, notFound: true })]);
		const missing = await short.query().call(short.call(), 'inspect_element', { selector: 'li', index: 3 });
		assert.deepStrictEqual({
			call: [page.calls[0].spec, page.calls[0].uids],
			ok: !isError(result),
			missing: textOf(missing),
		}, {
			call: [{ targetIndex: 0, mode: 'inspect', styles: ['z-index'], index: 0 }, ['4_2']],
			ok: true,
			missing: 'Only 1 element(s) match, so there is no index 3.',
		});
	});

	test('scroll_to steps until the element shows up, and stops at the end of the list', async () => {
		const page = new FakePage([
			returned({ found: false, moved: 400, container: 'div.list' }),
			returned({ found: false, moved: 400, container: 'div.list' }),
			returned({ found: true, matched: 1, element: { tag: 'li', text: 'Row 80' }, container: 'div.list' }),
		]);
		const found = await page.query().call(page.call(), 'scroll_to', { text: 'Row 80', container: '.list' });
		const end = new FakePage([returned({ found: false, moved: 0, container: 'the page' })]);
		const missing = await end.query().call(end.call(), 'scroll_to', { text: 'Row 999' });
		assert.deepStrictEqual({
			found: [isError(found), textOf(found).split('\n')[0]],
			missing: [isError(missing), textOf(missing).startsWith('Not found: reached the end of the page after 0 scroll step(s)'), end.calls.map(call => call.spec.checkOnly)],
		}, {
			found: [false, 'Found after 2 scroll step(s) (800px) in div.list, and scrolled it into view.'],
			missing: [true, true, [false, true]],
		});
	});

	test('the element a tool looks at is shown to the cursor, but not one inside an iframe', async () => {
		const rect = { x: 10, y: 20, width: 30, height: 40 };
		const text = new FakePage([returned({ matched: 1, returned: 1, total: 2, part: 'hi', element: { tag: 'p', rect } })]);
		await text.query().call(text.call(), 'get_text', { selector: 'p' });
		const whole = new FakePage([returned({ matched: 1, returned: 1, total: 2, part: 'hi', element: { tag: 'body', rect } })]);
		await whole.query().call(whole.call(), 'get_text', {});
		const inspect = new FakePage([returned({ matched: 1, element: { tag: 'button' }, rect: { ...rect, right: 40, bottom: 60 } })]);
		await inspect.query().call(inspect.call(), 'inspect_element', { selector: 'button' });
		const empty = new FakePage([returned({ matched: 1, element: { tag: 'i', rect: { x: 0, y: 0, width: 0, height: 0 } }, rect: { x: 0, y: 0, width: 0, height: 0 } })]);
		await empty.query().call(empty.call(), 'inspect_element', { selector: 'i' });
		assert.deepStrictEqual({
			text: text.looks, whole: whole.looks, inspect: inspect.looks, empty: empty.looks,
			inspectInFrame: paradisLookedAtRect({ rect, inMainFrame: false }),
			elementInFrame: paradisLookedAtRect({ element: { rect, inIframe: true } }),
			locatedInFrame: paradisLookedAtRect({ element: { rect }, problem: 'iframe' }),
		}, { text: [rect], whole: [], inspect: [rect], empty: [], inspectInFrame: undefined, elementInFrame: undefined, locatedInFrame: undefined });
	});

	test('wait_until with network_idle_ms waits until the shared tab has been quiet for long enough', async () => {
		const page = new FakePage([returned({ met: true })], 100);
		const snapshots = [
			{ inflight: 2, quietMs: 0, pendingUrls: ['https://example.com/api'], longLived: 0 },
			{ inflight: 0, quietMs: 200, pendingUrls: [], longLived: 0 },
			{ inflight: 0, quietMs: 600, pendingUrls: [], longLived: 1 },
		];
		const call = { ...page.call(), networkActivity: () => snapshots.length > 1 ? snapshots.shift() : snapshots[0] };
		const result = await page.query().call(call, 'wait_until', { network_idle_ms: 500 });
		const quiet = new FakePage([returned({ met: true })], 100);
		const never = await quiet.query().call({ ...quiet.call(), networkActivity: () => ({ inflight: 1, quietMs: 0, pendingUrls: ['https://example.com/slow'], longLived: 0 }) }, 'wait_until', { network_idle_ms: 500, timeout_seconds: 1 });
		assert.deepStrictEqual({
			error: isError(result),
			checks: page.calls.length,
			network: JSON.parse(textOf(result).split('\n').slice(1).join('\n')).network,
			timedOut: [isError(never), textOf(never).includes('1 request(s) in flight (https://example.com/slow)')],
			needsIdle: isError(await page.query().call(page.call(), 'wait_until', { network_idle_max_inflight: 2 })),
		}, {
			error: false,
			checks: 3,
			network: { inflight: 0, quietMs: 600, longLivedIgnored: 1 },
			timedOut: [true, true],
			needsIdle: true,
		});
	});

	test('a change of the shared page stops the tool', async () => {
		const page = new FakePage([returned({ met: false })]);
		page.current = false;
		const result = await page.query().call(page.call(), 'wait_until', { selector: '.a' });
		assert.deepStrictEqual([isError(result), textOf(result).startsWith('PARA_BROWSER_RETRYABLE')], [true, true]);
	});
});
