/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { IParadisObserveHost, ParadisBrowserObserver, paradisFormatChanges, paradisObserveOptionsFor, paradisParseListPages, paradisTakeObserveArguments, paradisWithObserveArguments } from '../../node/paradisBrowserObserve.js';
import { paradisObserveCollectFunction, paradisObserveInstallFunction, paradisObserveReadFunction } from '../../node/paradisBrowserObservePageScript.js';

function text(value: string): unknown {
	return { content: [{ type: 'text', text: value }] };
}

function evaluateResult(value: unknown): unknown {
	return text(`Script ran on page and returned:\n\`\`\`json\n${JSON.stringify(value)}\n\`\`\``);
}

const PAGES_ONE = text('## Pages\n1: Orders (http://127.0.0.1/orders) [selected]');
const PAGES_TWO = text('## Pages\n1: Orders (http://127.0.0.1/orders) [selected]\n2: Ticket (http://127.0.0.1/ticket/7)');

interface IFakeHostOptions {
	readonly pages: readonly unknown[];
	readonly collect?: unknown;
	readonly downloads?: readonly ReadonlyMap<string, number>[];
}

function fakeHost(options: IFakeHostOptions): { readonly host: IParadisObserveHost; readonly calls: string[] } {
	const calls: string[] = [];
	let pageCall = 0;
	let downloadCall = 0;
	let clock = 0;
	const host: IParadisObserveHost = {
		evaluate: async source => {
			const kind = source.includes('delete window[N]') ? 'collect' : source.includes('const busy') ? 'read' : 'install';
			calls.push(kind);
			if (kind === 'install') {
				return evaluateResult({ url: 'http://127.0.0.1/orders', title: 'Orders' });
			}
			if (kind === 'read') {
				return evaluateResult({ age: 500, ready: true, busy: false, navigated: false });
			}
			return evaluateResult(options.collect);
		},
		listPages: async () => {
			calls.push('list_pages');
			return options.pages[Math.min(pageCall++, options.pages.length - 1)];
		},
		snapshot: async () => text('## Latest page snapshot\nuid=1_0 RootWebArea'),
		network: () => ({ inflight: 0, quietMs: 500 }),
		tabs: async () => [{ tabId: 't1', url: 'http://127.0.0.1/orders', title: 'Orders', current: true, shared: false }],
		downloads: async () => options.downloads?.[Math.min(downloadCall++, (options.downloads?.length ?? 1) - 1)],
		isCurrent: () => true,
		sleep: async ms => { clock += ms; },
		now: () => clock,
	};
	return { host, calls };
}

suite('Paradis browser observe', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	test('only input and navigation tools are observed, and the added arguments are taken out', () => {
		const both = { settle: true, state: true };
		assert.deepStrictEqual({
			clickBy: paradisObserveOptionsFor('click_by', both),
			download: paradisObserveOptionsFor('download_by_click', both),
			snapshot: paradisObserveOptionsFor('take_snapshot', both),
			off: paradisObserveOptionsFor('click_by', { settle: false, state: false }),
			plain: paradisTakeObserveArguments({ uid: '1_2' }),
			taken: paradisTakeObserveArguments({ uid: '1_2', settle_ms: 99999, observe: 'none' }),
			zero: paradisTakeObserveArguments({ settle_ms: 0 }),
		}, {
			clickBy: { settle: true, state: true },
			download: { settle: false, state: true },
			snapshot: undefined,
			off: undefined,
			plain: { rest: { uid: '1_2' }, settleMs: 2000, observe: 'changes' },
			taken: { rest: { uid: '1_2' }, settleMs: 10000, observe: 'none' },
			zero: { rest: {}, settleMs: 0, observe: 'changes' },
		});
	});

	test('tools/list gets the settle arguments only while the setting is on', () => {
		const tool = { name: 'click', description: 'Clicks.', inputSchema: { type: 'object', properties: { uid: { type: 'string' } } } };
		const on = paradisWithObserveArguments(tool, { settle: true, state: false }) as typeof tool;
		assert.deepStrictEqual({
			off: paradisWithObserveArguments(tool, { settle: false, state: false }) === tool,
			other: paradisWithObserveArguments({ ...tool, name: 'take_snapshot' }, { settle: true, state: true }).name,
			properties: Object.keys(on.inputSchema.properties),
			describes: on.description.includes('waits for the page to settle'),
		}, { off: true, other: 'take_snapshot', properties: ['uid', 'settle_ms', 'observe'], describes: true });
	});

	test('list_pages gives the pages and an open dialog', () => {
		assert.deepStrictEqual({
			two: paradisParseListPages(PAGES_TWO),
			dialog: paradisParseListPages(text('## Pages\n1: A (http://a/) [selected]\n# Open dialog\nconfirm: Approve request #12?.\nCall handle_dialog to handle it before continuing.')),
			error: paradisParseListPages({ content: [{ type: 'text', text: 'boom' }], isError: true }),
		}, {
			two: { pages: [{ index: '1', title: 'Orders', url: 'http://127.0.0.1/orders', selected: true }, { index: '2', title: 'Ticket', url: 'http://127.0.0.1/ticket/7', selected: false }] },
			dialog: { pages: [{ index: '1', title: 'A', url: 'http://a/', selected: true }], dialog: 'confirm: Approve request #12?' },
			error: undefined,
		});
	});

	test('changes are written as short sections, and a new document is reported with its text', () => {
		const settled = { quiet: true, waited: 320, navigated: false };
		assert.deepStrictEqual({
			changes: paradisFormatChanges({ url: 'http://a/', title: 'A' }, { url: 'http://a/#2', title: 'A', added: ['dialog "Cancel?"', '  button "Confirm" [disabled]'], changed: ['cell "Cancelled"'], removed: ['"Loading..."'], focus: 'checkbox "I understand" [not checked]', more: 2 }, settled),
			none: paradisFormatChanges({ url: 'http://a/', title: 'A' }, { url: 'http://a/', title: 'A', added: [], changed: [], removed: [], more: 0 }, { quiet: false, waited: 2000, navigated: false }),
			navigated: paradisFormatChanges({ url: 'http://a/', title: 'A' }, { missing: true, url: 'http://b/', title: 'B', text: 'Welcome' }, { quiet: true, waited: 900, navigated: true }),
		}, {
			changes: '[Page after the action] Settled after 320 ms.\nURL: http://a/ -> http://a/#2\nAppeared:\n- dialog "Cancel?"\n-   button "Confirm" [disabled]\nChanged:\n- cell "Cancelled"\nDisappeared:\n- "Loading..."\nFocus: checkbox "I understand" [not checked]\n(2 more changes not listed; call take_snapshot for the whole page.)',
			none: '[Page after the action] Still changing or loading after 2000 ms (the wait limit); use wait_until if you expect a slower update.\nNo visible change on the page.',
			navigated: '[Page after the action] Settled after 900 ms.\nA new document loaded: http://b/ "B"\nStart of its text: Welcome',
		});
	});

	test('the browser state is reported when it changes and left out when it is the same as last time', async () => {
		const observer = new ParadisBrowserObserver();
		const options = { settle: false, state: true };
		const first = fakeHost({ pages: [PAGES_ONE, PAGES_TWO], downloads: [new Map(), new Map([['a.csv', 10]])] });
		const before1 = await observer.before(first.host, options, 'changes', 2000);
		const report1 = await observer.after(first.host, 'pane', options, before1, 'changes', 2000);
		const second = fakeHost({ pages: [PAGES_TWO, PAGES_TWO], downloads: [new Map([['a.csv', 10]])] });
		const before2 = await observer.before(second.host, options, 'changes', 2000);
		const report2 = await observer.after(second.host, 'pane', options, before2, 'changes', 2000);
		assert.deepStrictEqual({ report1, report2, evaluated: first.calls.filter(call => call !== 'list_pages') }, {
			report1: '[Browser state]\nYour tabs: t1 (current) "Orders" http://127.0.0.1/orders\nPages in this tab\'s browser: pageId 1 (selected) "Orders" http://127.0.0.1/orders; pageId 2 (opened by this action) "Ticket" http://127.0.0.1/ticket/7\nThis action opened a new page. It is not one of your tabs: read it with select_page (pageId) or open its URL with navigate_page / open_browser_tab.\nNew download: a.csv (10 bytes). Read it with read_download.',
			report2: undefined,
			evaluated: [],
		});
	});

	test('the page is not evaluated while a JavaScript dialog is open', async () => {
		const observer = new ParadisBrowserObserver();
		const options = { settle: true, state: false };
		const dialog = text('## Pages\n1: A (http://a/) [selected]\n# Open dialog\nconfirm: Delete?.\nCall handle_dialog to handle it before continuing.');
		const { host, calls } = fakeHost({ pages: [PAGES_ONE, dialog] });
		const before = await observer.before(host, options, 'changes', 2000);
		const report = await observer.after(host, 'pane', options, before, 'changes', 2000);
		assert.deepStrictEqual({ calls, report }, {
			calls: ['list_pages', 'install', 'list_pages'],
			report: 'A JavaScript dialog is open (confirm: Delete?). Handle it with handle_dialog before anything else on this page.',
		});
	});

	test('a settled action reports what the page script collected', async () => {
		const observer = new ParadisBrowserObserver();
		const options = { settle: true, state: false };
		const { host, calls } = fakeHost({ pages: [PAGES_ONE], collect: { url: 'http://127.0.0.1/orders', title: 'Orders', added: ['text "Report ID: RPT-1"'], changed: [], removed: [], more: 0 } });
		const before = await observer.before(host, options, 'changes', 2000);
		const report = await observer.after(host, 'pane', options, before, 'changes', 2000);
		assert.deepStrictEqual({ calls, report }, {
			calls: ['list_pages', 'install', 'list_pages', 'list_pages', 'read', 'list_pages', 'read', 'list_pages', 'read', 'list_pages', 'collect'],
			report: '[Page after the action] Settled after 200 ms.\nAppeared:\n- text "Report ID: RPT-1"',
		});
	});

	test('the page scripts are valid JavaScript', () => {
		const sources = [paradisObserveInstallFunction('__x'), paradisObserveReadFunction('__x'), paradisObserveCollectFunction('__x', 30)];
		assert.deepStrictEqual(sources.map(source => typeof new Function(`return (${source});`)()), ['function', 'function', 'function']);
	});
});
