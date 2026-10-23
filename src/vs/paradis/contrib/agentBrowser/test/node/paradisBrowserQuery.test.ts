/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { IParadisBrowserQueryCall, ParadisBrowserQuery, paradisBuildQueryFunction, paradisLookedAtRect, paradisNearMissHints, paradisParseQueryLocator } from '../../node/paradisBrowserQuery.js';
import { PARADIS_BROWSER_QUERY_PAGE_SCRIPT } from '../../common/paradisBrowserQueryPageScript.js';
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
	readonly deadlines: (number | undefined)[] = [];
	current = true;
	readonly looks: unknown[] = [];

	constructor(private readonly answers: unknown[], private readonly stepMs = 1000) { }

	call(): IParadisBrowserQueryCall {
		return {
			evaluate: async (source, uids, deadlineMs) => {
				this.deadlines.push(deadlineMs);
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
		// Claude Code は 120 秒を超えた呼び出しを裏に回すので、上限は 100 秒（q.html Q395）
		const tooLong = await syntax.query().call(syntax.call(), 'wait_until', { selector: '.toast', timeout_seconds: 120 });
		assert.deepStrictEqual({
			timedOut: [isError(timedOut), textOf(timedOut).startsWith('Timed out after 3s waiting for visible selector ".toast" (3 checks)'), textOf(timedOut).includes('"matched": 2')],
			broken: [isError(broken), syntax.calls.length],
			nothing: isError(nothing),
			tooLong: [isError(tooLong), textOf(tooLong), syntax.calls.length],
		}, {
			timedOut: [true, true, true],
			broken: [true, 1],
			nothing: true,
			tooLong: [true, '"timeout_seconds" must be a number from 0.5 to 100.', 1],
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
			missing: [isError(missing), textOf(missing).startsWith('Not found: reached the end of the page after 0 scroll step(s)'), end.calls.map(call => [call.spec.mode, call.spec.checkOnly])],
		}, {
			found: [false, 'Found after 2 scroll step(s) (800px) in div.list, and scrolled it into view.'],
			missing: [true, true, [['scroll', false], ['scroll', true], ['scrollMiss', undefined]]],
		});
	});

	// q.html Q379 の 5: 目的が始めの位置より上にあると、下の端で失敗していた。見つからないときは位置を戻し、理由を添える
	test('scroll_to searches again from the start when it began below it, scrolls back when nothing matches, and says why', async () => {
		const above = new FakePage([
			returned({ found: false, moved: 0, before: 900, max: 900, extent: 1500, container: 'div.list' }),
			returned({ found: false, moved: 0, extent: 1500, container: 'div.list' }),
			returned({ found: false, reset: true, before: 900, container: 'div.list' }),
			returned({ found: true, matched: 1, element: { tag: 'li', text: 'Row 1' }, container: 'div.list' }),
		]);
		const found = await above.query().call(above.call(), 'scroll_to', { text: 'Row 1' });
		const nowhere = new FakePage([
			returned({ found: false, moved: 400, before: 400, position: 800, max: 800, extent: 1200, container: 'div.list' }),
			returned({ found: false, moved: 0, before: 800, position: 800, max: 800, extent: 1200, container: 'div.list' }),
			returned({ found: false, moved: 0, extent: 1200, container: 'div.list' }),
			returned({ found: false, reset: true, before: 800, container: 'div.list' }),
			returned({ found: false, moved: 400, before: 0, position: 400, max: 800, extent: 1200, container: 'div.list' }),
			returned({ found: false, moved: 0, extent: 1200, container: 'div.list' }),
			returned({ restored: true, container: 'div.list' }),
			returned({ inField: { count: 1, first: { tag: 'input', name: 'Company' } }, collapsed: { count: 2, names: ['Details', 'More'] }, otherContainers: ['div.side'] }),
		]);
		const missing = await nowhere.query().call(nowhere.call(), 'scroll_to', { text: 'Acme' });
		const growing = new FakePage([
			returned({ found: false, moved: 0, before: 0, max: 0, extent: 600, container: 'div.list' }),
			returned({ found: false, moved: 0, extent: 900, container: 'div.list' }),
			returned({ found: true, matched: 1, element: { tag: 'li' }, container: 'div.list' }),
		]);
		const grown = await growing.query().call(growing.call(), 'scroll_to', { text: 'Row 30' });
		assert.deepStrictEqual({
			found: [isError(found), textOf(found).split('\n')[0], above.calls.map(call => [call.spec.checkOnly ?? null, call.spec.reset ?? null, call.spec.resetTo ?? null])],
			missing: [isError(missing), nowhere.calls.map(call => call.spec.mode === 'scrollMiss' ? 'scrollMiss' : call.spec.restoreTo !== undefined ? `restore ${call.spec.restoreTo} if still at ${call.spec.expectAt} in ${call.spec.expectContainer}` : call.spec.reset ? `reset ${call.spec.resetTo}` : call.spec.checkOnly ? 'check' : 'step')],
			missingText: textOf(missing).split('\n'),
			grown: [isError(grown), growing.calls.length],
		}, {
			found: [false, 'Found after 0 scroll step(s) (0px) in div.list after searching again from the start, and scrolled it into view.', [[false, null, null], [true, null, null], [null, true, 'start'], [false, null, null]]],
			missing: [true, ['step', 'step', 'check', 'reset start', 'step', 'check', 'restore 400 if still at 400 in div.list', 'scrollMiss']],
			missingText: [
				'Not found: searched all of div.list (from where it was to the end, then from the start back to where it was) in 2 scroll step(s) (800px), and scrolled it back to where it was.',
				'- "text" matches the text of elements, not what is typed or selected in a form field, and 1 form field holds it (for example {"tag":"input","name":"Company"}). Find the field by role and name instead.',
				'- 2 collapsed control(s) (aria-expanded="false") are on the page, for example "Details", "More". The element may be inside a section that is not rendered until it is expanded.',
				'- Other scrollable areas: div.side. Give one as "container" if the wrong area was scrolled.',
				'- div.list was searched over its whole scrollable range, so no element matching text "Acme" is in this area of the screen now. It may be on another page or tab, appear only after an action (a tab, a filter, a search), or be in another scrollable area.',
			],
			grown: [false, 3],
		});
	});

	// q.html Q379 の 4: ページが評価に答えないと 180 秒（puppeteer の既定）待ち、そのタブの後続も止めていた
	test('a page that does not answer is given up after the slice plus ten seconds, and wait_until keeps checking until its own timeout', async () => {
		const unresponsive = failed('PARA_BROWSER_PAGE_UNRESPONSIVE: the page did not answer within 11000 ms.');
		const recovering = new FakePage([unresponsive, unresponsive, returned({ met: true, matched: 1, visible: 1 })], 11000);
		const met = await recovering.query().call(recovering.call(), 'wait_until', { text: 'Saved', timeout_seconds: 30 });
		const stuck = new FakePage([unresponsive], 11000);
		const timedOut = await stuck.query().call(stuck.call(), 'wait_until', { text: 'Saved', timeout_seconds: 20 });
		const reading = new FakePage([unresponsive]);
		const read = await reading.query().call(reading.call(), 'get_text', {});
		const lateStart = new FakePage([returned({ paraLate: true })]);
		const late = await lateStart.query().call(lateStart.call(), 'inspect_element', { selector: 'p' });
		assert.deepStrictEqual({
			met: [isError(met), textOf(met).startsWith('Condition met after'), recovering.deadlines],
			timedOut: [isError(timedOut), stuck.calls.length, textOf(timedOut).includes('the page did not answer within 11 s')],
			read: [isError(read), textOf(read).startsWith('PARA_BROWSER_PAGE_UNRESPONSIVE: the page did not answer within 10 s'), reading.deadlines],
			late: [isError(late), textOf(late).startsWith('PARA_BROWSER_PAGE_UNRESPONSIVE')],
		}, {
			met: [false, true, [11000, 11000, 11000]],
			timedOut: [true, 2, true],
			read: [true, true, [10000]],
			late: [true, true],
		});
	});

	test('the page function does nothing when it starts after its last start time, but a page with a faked clock still runs it', async () => {
		/** ページの関数を、その中から見える Date と performance を差し替えて動かす（このテストの大域は変えない）。 */
		const runWith = (notAfter: number, clock: { readonly date: number; readonly monotonic: number }) => {
			const source = paradisBuildQueryFunction({ mode: 'wait', sliceMs: 0, intervalMs: 50 }, 0, undefined, notAfter);
			const run = new Function('Date', 'performance', 'location', `return (${source});`)({ now: () => clock.date }, { timeOrigin: clock.monotonic, now: () => 0 }, { href: 'about:blank' }) as () => Promise<Record<string, unknown>>;
			return run();
		};
		const now = Date.now();
		const day = 24 * 60 * 60 * 1000;
		assert.deepStrictEqual({
			late: await runWith(now - 1000, { date: now, monotonic: now }),
			// fake timers・MockDate で Date だけが未来（q.html Q379 のレビュー）
			futureDate: await runWith(now + 8000, { date: now + 2 * day, monotonic: now }),
			// どちらの時計も 1 日より先なら信じない
			futureClocks: await runWith(now + 8000, { date: now + 2 * day, monotonic: now + 2 * day }),
		}, {
			late: { paraLate: true },
			futureDate: { met: true, url: 'about:blank' },
			futureClocks: { met: true, url: 'about:blank' },
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

	// q.html Q448 の ③: 時間切れの後にページを 1 回だけ読み、待っていたものに近い候補を添える。待ち方・回数は変えない
	test('wait_until adds close matches after a timeout without a match, and says when the matches are not visible', async () => {
		const waiting = returned({ met: false, matched: 0, visible: 0 });
		const near = returned({ near: { candidates: [{ role: 'button', name: 'Save draft', text: 'Save draft' }, { text: 'Saved' }] } });
		const page = new FakePage([waiting, waiting, waiting, near]);
		const timedOut = await page.query().call(page.call(), 'wait_until', { text: 'Save drafts', timeout_seconds: 3 });
		const hidden = new FakePage([returned({ met: false, matched: 2, visible: 0 })]);
		const notVisible = await hidden.query().call(hidden.call(), 'wait_until', { selector: '.toast', timeout_seconds: 2 });
		const lines = textOf(timedOut).split('\n');
		assert.deepStrictEqual({
			first: lines[0],
			hints: lines.slice(lines.indexOf('}') + 1),
			modes: page.calls.map(call => call.spec.mode),
			nearDeadline: page.deadlines[3],
			notVisible: [hidden.calls.map(call => call.spec.mode), textOf(notVisible).split('\n').pop()],
		}, {
			first: 'Timed out after 3s waiting for visible text "Save drafts" (3 checks).',
			hints: [
				'- Close matches visible on the page now (give one of these as the locator):',
				'  {"role":"button","name":"Save draft"} or {"text":"Save draft"}',
				'  {"text":"Saved"}',
			],
			modes: ['wait', 'wait', 'wait', 'nearMiss'],
			nearDeadline: 3000,
			notVisible: [['wait', 'wait'], '- 2 element(s) match, but none is visible (hidden, zero size or not rendered yet). Use state "attached" to wait for it in the DOM, or check why with inspect_element.'],
		});
	});

	// q.html Q448 の ④: 候補は 5 件まで、1 件 80 文字まで。selector は当たらない部分と似たもの
	test('close matches are capped, cut, and explain a selector that matches nothing', () => {
		const many = paradisNearMissHints({ candidates: Array.from({ length: 8 }, (_, index) => ({ text: `Row ${index} ${'y'.repeat(300)}` })) }, { text: 'Row 9' });
		const selector = paradisNearMissHints({ missingParts: ['#save-btn'], similar: [{ instead: '#save-btn', selector: '#save-button', count: 1 }], lastPart: { part: '.row', count: 3 }, crossOriginFrames: 2 }, { selector: '#list #save-btn' });
		const nothing = paradisNearMissHints({ candidates: [], roleCount: 0 }, { role: 'button', name: 'Send' });
		assert.deepStrictEqual({
			many: [many.length, Math.max(...many.slice(1).map(line => line.length))],
			selector,
			nothing,
		}, {
			many: [6, 2 + JSON.stringify({ text: 'x'.repeat(200) }).length],
			selector: [
				'- Nothing on the page has "#save-btn", so the selector matches nothing.',
				'- Similar ones that are on the page: "#save-button" (1 element(s)) instead of "#save-btn".',
				'- Its last part ".row" alone matches 3 element(s); the parts before it rule them out.',
				'- The page has 2 cross-origin iframe(s), which cannot be searched; the element may be inside one (take_snapshot shows their content).',
			],
			nothing: [
				'- No element with role "button" is in the searched area.',
				'- Nothing visible on the page has a text or name close to "Send", so it is probably not on this screen (yet).',
			],
		});
	});

	test('get_text adds close matches when nothing matches, and scroll_to says "not in this area" only after searching all of it', async () => {
		const page = new FakePage([returned({ matched: 0, returned: 0, total: 0, part: '', near: { candidates: [{ text: 'Total: 1,200' }] } })]);
		const read = await page.query().call(page.call(), 'get_text', { text: 'Totals' });
		const limited = new FakePage([returned({ found: false, moved: 400, before: 0, position: 400, max: 4000, extent: 4400, container: 'div.list' }), returned({ found: false, moved: 0, container: 'div.list' }), returned({})]);
		const cut = await limited.query().call(limited.call(), 'scroll_to', { text: 'Row 999', max_steps: 1 });
		assert.deepStrictEqual({
			read: [isError(read), textOf(read).split('\n')],
			cut: [isError(cut), textOf(cut).includes('whole scrollable range')],
		}, {
			read: [true, [
				'No element matches text "Totals". Check with take_snapshot, or wait for it with wait_until.',
				'- Close matches visible on the page now (give one of these as the locator):',
				'  {"text":"Total: 1,200"}',
			]],
			cut: [true, false],
		});
	});

	test('a change of the shared page stops the tool', async () => {
		const page = new FakePage([returned({ met: false })]);
		page.current = false;
		const result = await page.query().call(page.call(), 'wait_until', { selector: '.a' });
		assert.deepStrictEqual([isError(result), textOf(result).startsWith('PARA_BROWSER_RETRYABLE')], [true, true]);
	});
});
