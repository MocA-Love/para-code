/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import { deepStrictEqual, ok, rejects, strictEqual } from 'assert';
import { mainWindow } from '../../../../../base/browser/window.js';
import { CancellationToken } from '../../../../../base/common/cancellation.js';
import { CancellationError } from '../../../../../base/common/errors.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { PARADIS_OFFICE_FIND_INPUT_DELAY, ParadisOfficeFindWidget } from '../../browser/paradisOfficeFindWidget.js';
import {
	ParadisOfficeSearchError,
	ParadisOfficeSemanticSearch,
	type ParadisOfficeSearchHandle,
	type ParadisOfficeSearchPage,
	type ParadisOfficeSearchSnapshot,
} from '../../common/paradisOfficeSearch.js';

const handle: ParadisOfficeSearchHandle = Object.freeze({ ownerId: 'owner-a', handleId: 'document-a' });

function snapshot(revision: string, fields: ParadisOfficeSearchSnapshot['items'][number]['fields']): ParadisOfficeSearchSnapshot {
	return {
		...handle,
		revision,
		items: [{
			id: 'item-1',
			locator: 'Sheet 1!A1',
			locationBadge: { kind: 'sheet', label: 'Sheet 1' },
			navigableAnchor: 'cell:Sheet 1:A1',
			fields,
		}],
	};
}

suite('ParadisOfficeFindWidget', () => {
	const store = ensureNoDisposablesAreLeakedInTestSuite();

	test('searches every safe semantic projection without deriving locations from geometry', async () => {
		const search = new ParadisOfficeSemanticSearch(snapshot('revision-1', [
			{ kind: 'formatted', text: 'needle formatted' },
			{ kind: 'raw', text: 'needle raw' },
			{ kind: 'formula', text: 'needle formula' },
			{ kind: 'comment', text: 'needle comment' },
			{ kind: 'link', text: 'needle link' },
			{ kind: 'alternativeText', text: 'needle alt' },
			{ kind: 'placeholder', text: 'needle placeholder' },
			{ kind: 'story', text: 'needle story' },
			{ kind: 'hidden', text: 'needle hidden' },
		]));

		const page = await search.search(handle, { text: 'needle' });

		deepStrictEqual(page.results.map(result => ({
			anchor: result.navigableAnchor,
			badge: result.locationBadge.label,
			match: result.preview.match,
		})), [
			{ anchor: 'cell:Sheet 1:A1', badge: 'Sheet 1 · 表示テキスト', match: 'needle' },
			{ anchor: 'cell:Sheet 1:A1', badge: 'Sheet 1 · 生データ', match: 'needle' },
			{ anchor: 'cell:Sheet 1:A1', badge: 'Sheet 1 · 数式', match: 'needle' },
			{ anchor: 'cell:Sheet 1:A1', badge: 'Sheet 1 · コメント', match: 'needle' },
			{ anchor: 'cell:Sheet 1:A1', badge: 'Sheet 1 · リンク', match: 'needle' },
			{ anchor: 'cell:Sheet 1:A1', badge: 'Sheet 1 · 代替テキスト', match: 'needle' },
			{ anchor: 'cell:Sheet 1:A1', badge: 'Sheet 1 · 代替表示', match: 'needle' },
			{ anchor: 'cell:Sheet 1:A1', badge: 'Sheet 1 · 文書パーツ', match: 'needle' },
			{ anchor: 'cell:Sheet 1:A1', badge: 'Sheet 1 · 非表示', match: 'needle' },
		]);
	});

	test('normalizes NFC and applies the match-case option', async () => {
		const search = new ParadisOfficeSemanticSearch(snapshot('revision-1', [{ kind: 'story', text: 'Cafe\u0301 Alpha ς İA' }]));

		const folded = await search.search(handle, { text: 'CAFÉ' });
		const exact = await search.search(handle, { text: 'CAFÉ', matchCase: true });
		const sigma = await search.search(handle, { text: 'Σ' });
		const afterDottedI = await search.search(handle, { text: 'A' });

		deepStrictEqual({
			folded: folded.results.map(result => result.preview.match),
			exact: exact.results.length,
			sigma: sigma.results.map(result => result.preview.match),
			afterDottedI: afterDottedI.results.at(-1)?.preview.match,
		}, {
			folded: ['Café'],
			exact: 0,
			sigma: ['ς'],
			afterDottedI: 'A',
		});
	});

	test('caps results at 10,000 and returns fixed 200-result pages', async () => {
		const items: ParadisOfficeSearchSnapshot['items'] = Array.from({ length: 10_001 }, (_, index) => ({
			id: `item-${index}`,
			locator: `Sheet 1!A${index + 1}`,
			locationBadge: { kind: 'sheet' as const, label: 'Sheet 1' },
			navigableAnchor: `cell:Sheet 1:A${index + 1}`,
			fields: [{ kind: 'formatted' as const, text: 'match' }],
		}));
		const search = new ParadisOfficeSemanticSearch({ ...handle, revision: 'revision-1', items });

		const first = await search.search(handle, { text: 'match' });
		const second = await search.search(handle, { text: 'match' }, first.nextCursor);

		deepStrictEqual({
			first: first.results.length,
			second: second.results.length,
			total: first.total,
			capped: first.capped,
			firstId: first.results[0].id,
			secondId: second.results[0].id,
		}, {
			first: 200,
			second: 200,
			total: 10_000,
			capped: true,
			firstId: 'item-0:formatted:0',
			secondId: 'item-200:formatted:0',
		});
	});

	test('keeps cursors opaque, owner-bound, single-use, and revision-fenced', async () => {
		const fields = Array.from({ length: 201 }, (_, index) => ({ kind: 'formatted' as const, text: `match ${index}` }));
		const search = new ParadisOfficeSemanticSearch(snapshot('revision-secret', fields), { cursorFactory: () => 'opaque-cursor' });
		const first = await search.search(handle, { text: 'match' });
		strictEqual(first.nextCursor, 'opaque-cursor');
		strictEqual(first.nextCursor?.includes('owner-a'), false);
		strictEqual(first.nextCursor?.includes('document-a'), false);
		strictEqual(first.nextCursor?.includes('revision-secret'), false);

		await search.search(handle, { text: 'match' }, first.nextCursor);
		await rejects(search.search(handle, { text: 'match' }, first.nextCursor), (error: unknown) => error instanceof ParadisOfficeSearchError && error.code === 'invalidCursor');

		const other = new ParadisOfficeSemanticSearch({ ...snapshot('revision-secret', fields), ownerId: 'owner-b' });
		await rejects(other.search({ ownerId: 'owner-b', handleId: 'document-a' }, { text: 'match' }, first.nextCursor), (error: unknown) => error instanceof ParadisOfficeSearchError && error.code === 'invalidCursor');

		const revised = new ParadisOfficeSemanticSearch(snapshot('revision-1', fields));
		const revisedFirst = await revised.search(handle, { text: 'match' });
		revised.update(snapshot('revision-2', fields));
		await rejects(revised.search(handle, { text: 'match' }, revisedFirst.nextCursor), (error: unknown) => error instanceof ParadisOfficeSearchError && error.code === 'invalidCursor');
	});

	test('stops on cancellation or deadline', async () => {
		const cancelled = new ParadisOfficeSemanticSearch(snapshot('revision-1', [{ kind: 'formatted', text: 'match' }]));
		await rejects(cancelled.search(handle, { text: 'match' }, undefined, CancellationToken.Cancelled), CancellationError);

		let now = 0;
		const deadline = new ParadisOfficeSemanticSearch(snapshot('revision-1', [{ kind: 'formatted', text: 'match' }]), { now: () => ++now, maximumDurationMs: 0 });
		await rejects(deadline.search(handle, { text: 'match' }), (error: unknown) => error instanceof ParadisOfficeSearchError && error.code === 'deadline');
	});

	test('rejects stateful and unsafe records without disclosing their values', () => {
		const accessor = { ...snapshot('revision-1', [{ kind: 'formatted', text: 'match' }]) };
		Object.defineProperty(accessor.items[0], 'fields', { enumerable: true, get: () => [{ kind: 'formatted', text: 'private' }] });
		let accessorError: unknown;
		try {
			new ParadisOfficeSemanticSearch(accessor);
		} catch (error) {
			accessorError = error;
		}
		ok(accessorError instanceof ParadisOfficeSearchError);
		strictEqual(accessorError.code, 'invalidInput');

		const proxy = new Proxy(snapshot('private-revision', [{ kind: 'formatted', text: 'private-value' }]), {
			ownKeys: () => { throw new Error('private-proxy-value'); },
		});
		let proxyError: unknown;
		try {
			new ParadisOfficeSemanticSearch(proxy);
		} catch (error) {
			proxyError = error;
		}
		ok(proxyError instanceof ParadisOfficeSearchError);
		strictEqual(String(proxyError).includes('private'), false);

		const unsafe = snapshot('revision-1', [{ kind: 'macroBinary' as 'formatted', text: 'macro-secret' }]);
		let unsafeError: unknown;
		try {
			new ParadisOfficeSemanticSearch(unsafe);
		} catch (error) {
			unsafeError = error;
		}
		ok(unsafeError instanceof ParadisOfficeSearchError);
		strictEqual(String(unsafeError).includes('macro-secret'), false);
	});

	test('bounds aggregate searchable fields before retaining a snapshot', () => {
		const fields = Array.from({ length: 256 }, () => ({ kind: 'formatted' as const, text: '' }));
		const items = Array.from({ length: 391 }, (_, index) => ({
			id: `item-${index}`,
			locator: `item:${index}`,
			locationBadge: { kind: 'story' as const, label: 'Body' },
			fields,
		}));

		let error: unknown;
		try {
			new ParadisOfficeSemanticSearch({ ...handle, revision: 'revision-1', items });
		} catch (candidate) {
			error = candidate;
		}
		ok(error instanceof ParadisOfficeSearchError);
		strictEqual(error.code, 'invalidInput');
	});

	test('uses safe DOM, aria-live, logical navigation, paging, and find focus rules', async () => {
		const document = mainWindow.document;
		const host = document.createElement('div');
		const previous = document.createElement('button');
		previous.textContent = 'previous';
		document.body.append(previous, host);
		store.add({ dispose: () => { previous.remove(); host.remove(); } });
		previous.focus();

		const pages: ParadisOfficeSearchPage[] = [{
			results: [{
				id: 'first', locator: 'Sheet 1!A1', navigableAnchor: 'cell:Sheet 1:A1',
				preview: { before: '<img src=x ', match: 'needle', after: ' onerror=alert(1)>' },
				locationBadge: { kind: 'sheet', label: '<b>Sheet 1</b>' },
			}],
			nextCursor: 'next-page', total: 2, capped: false,
		}, {
			results: [{
				id: 'second', locator: 'story:header:/word/header1.xml:default', navigableAnchor: 'word-node-2',
				preview: { before: '', match: 'needle', after: '' },
				locationBadge: { kind: 'story', label: 'Header' },
			}],
			total: 2, capped: false,
		}];
		const navigated: string[] = [];
		const widget = store.add(new ParadisOfficeFindWidget(host, {
			search: async (_query, cursor) => cursor ? pages[1] : pages[0],
			onNavigate: result => navigated.push(`${result.locator}|${result.navigableAnchor}`),
		}));

		host.dispatchEvent(new KeyboardEvent('keydown', { key: 'f', ctrlKey: true, bubbles: true }));
		strictEqual(widget.isVisible(), true);
		const input = host.querySelector<HTMLInputElement>('input[type="search"]')!;
		input.value = 'needle';
		input.dispatchEvent(new Event('input', { bubbles: true }));
		await new Promise(resolve => mainWindow.setTimeout(resolve, PARADIS_OFFICE_FIND_INPUT_DELAY));
		await new Promise(resolve => mainWindow.setTimeout(resolve, 0));

		strictEqual(document.activeElement, input);
		strictEqual(host.querySelector('[aria-live="polite"]')?.textContent, '2 件中 1 件目');
		strictEqual(host.querySelector('.paradis-office-find-current')?.textContent, '<b>Sheet 1</b>: <img src=x needle onerror=alert(1)>');
		strictEqual(host.querySelector('img'), null);
		deepStrictEqual(navigated, ['Sheet 1!A1|cell:Sheet 1:A1']);

		input.dispatchEvent(new KeyboardEvent('keydown', { key: 'F3', bubbles: true }));
		await new Promise(resolve => mainWindow.setTimeout(resolve, 0));
		deepStrictEqual(navigated, [
			'Sheet 1!A1|cell:Sheet 1:A1',
			'story:header:/word/header1.xml:default|word-node-2',
		]);
		strictEqual(host.querySelector('[aria-live="polite"]')?.textContent, '2 件中 2 件目');

		input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
		strictEqual(widget.isVisible(), false);
		strictEqual(document.activeElement, previous);
	});

	test('leaves Enter on its buttons to the button instead of finding the next match', async () => {
		const host = mainWindow.document.createElement('div');
		mainWindow.document.body.appendChild(host);
		store.add({ dispose: () => host.remove() });
		const navigated: string[] = [];
		const widget = store.add(new ParadisOfficeFindWidget(host, {
			search: async () => ({
				results: ['a', 'b'].map(id => ({ id, locator: id, navigableAnchor: id, preview: { before: '', match: 'needle', after: '' }, locationBadge: { kind: 'sheet' as const, label: id } })),
				total: 2, capped: false,
			}),
			onNavigate: result => navigated.push(result.id),
		}));
		widget.reveal('needle');
		await new Promise(resolve => mainWindow.setTimeout(resolve, 0));
		const matchCase = host.querySelector<HTMLElement>('.codicon-case-sensitive')!.closest('button')!;
		matchCase.focus();
		matchCase.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
		await new Promise(resolve => mainWindow.setTimeout(resolve, 0));
		deepStrictEqual(navigated, ['a']);
	});

	test('searches again with match case when the case toggle is switched', async () => {
		const host = mainWindow.document.createElement('div');
		mainWindow.document.body.appendChild(host);
		store.add({ dispose: () => host.remove() });
		const queries: { readonly text: string; readonly matchCase: boolean }[] = [];
		const widget = store.add(new ParadisOfficeFindWidget(host, {
			search: async query => {
				queries.push({ text: query.text, matchCase: query.matchCase });
				return { results: [], total: 0, capped: false };
			},
		}));
		widget.reveal('Needle');
		await new Promise(resolve => mainWindow.setTimeout(resolve, 0));
		const toggle = host.querySelector<HTMLElement>('.paradis-office-find-input .codicon-case-sensitive')!.closest('button')!;
		toggle.click();
		await new Promise(resolve => mainWindow.setTimeout(resolve, 0));
		toggle.click();
		await new Promise(resolve => mainWindow.setTimeout(resolve, 0));

		deepStrictEqual({ queries, checked: toggle.getAttribute('aria-pressed') }, {
			queries: [
				{ text: 'Needle', matchCase: false },
				{ text: 'Needle', matchCase: true },
				{ text: 'Needle', matchCase: false },
			],
			checked: 'false',
		});
	});

	test('searches once after typing stops, and Enter searches the typed text without waiting', async () => {
		const host = mainWindow.document.createElement('div');
		mainWindow.document.body.appendChild(host);
		store.add({ dispose: () => host.remove() });
		const queries: string[] = [];
		const navigated: string[] = [];
		store.add(new ParadisOfficeFindWidget(host, {
			search: async query => {
				queries.push(query.text);
				return { results: [{ id: query.text, locator: query.text, navigableAnchor: query.text, preview: { before: '', match: query.text, after: '' }, locationBadge: { kind: 'sheet' as const, label: query.text } }], total: 1, capped: false };
			},
			onNavigate: result => navigated.push(result.id),
		}));
		host.dispatchEvent(new KeyboardEvent('keydown', { key: 'f', ctrlKey: true, bubbles: true }));
		const input = host.querySelector<HTMLInputElement>('input[type="search"]')!;
		for (const text of ['n', 'ne', 'nee']) {
			input.value = text;
			input.dispatchEvent(new Event('input', { bubbles: true }));
		}
		await new Promise(resolve => mainWindow.setTimeout(resolve, PARADIS_OFFICE_FIND_INPUT_DELAY));
		await new Promise(resolve => mainWindow.setTimeout(resolve, 0));
		input.value = 'need';
		input.dispatchEvent(new Event('input', { bubbles: true }));
		input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
		await new Promise(resolve => mainWindow.setTimeout(resolve, 0));
		const beforeDelay = { queries: [...queries], navigated: [...navigated] };
		await new Promise(resolve => mainWindow.setTimeout(resolve, PARADIS_OFFICE_FIND_INPUT_DELAY));

		deepStrictEqual({ beforeDelay, queries, navigated }, {
			beforeDelay: { queries: ['nee', 'need'], navigated: ['nee', 'need'] },
			queries: ['nee', 'need'],
			navigated: ['nee', 'need'],
		});
	});

	test('Shift+Enter while typing is pending searches the typed text and moves to the last match', async () => {
		const host = mainWindow.document.createElement('div');
		mainWindow.document.body.appendChild(host);
		store.add({ dispose: () => host.remove() });
		const queries: string[] = [];
		const navigated: string[] = [];
		const result = (id: string) => ({ id, locator: id, navigableAnchor: id, preview: { before: '', match: id, after: '' }, locationBadge: { kind: 'sheet' as const, label: id } });
		store.add(new ParadisOfficeFindWidget(host, {
			search: async query => {
				queries.push(query.text);
				return { results: [result(`${query.text}-1`), result(`${query.text}-2`), result(`${query.text}-3`)], total: 3, capped: false };
			},
			onNavigate: navigatedResult => navigated.push(navigatedResult.id),
		}));
		host.dispatchEvent(new KeyboardEvent('keydown', { key: 'f', ctrlKey: true, bubbles: true }));
		const input = host.querySelector<HTMLInputElement>('input[type="search"]')!;
		input.value = 'need';
		input.dispatchEvent(new Event('input', { bubbles: true }));
		input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', shiftKey: true, bubbles: true }));
		await new Promise(resolve => mainWindow.setTimeout(resolve, 0));
		await new Promise(resolve => mainWindow.setTimeout(resolve, PARADIS_OFFICE_FIND_INPUT_DELAY));

		deepStrictEqual({ queries, navigated }, { queries: ['need'], navigated: ['need-3'] });
	});

	test('shows an explicit unavailable state instead of invoking a transport fallback', () => {
		const host = mainWindow.document.createElement('div');
		mainWindow.document.body.appendChild(host);
		store.add({ dispose: () => host.remove() });
		const widget = store.add(new ParadisOfficeFindWidget(host, { unavailableMessage: 'Search is unavailable for this adapter.' }));

		widget.reveal();

		strictEqual(host.querySelector<HTMLInputElement>('input[type="search"]')?.disabled, true);
		strictEqual(host.querySelector('[aria-live="polite"]')?.textContent, 'Search is unavailable for this adapter.');
		strictEqual(mainWindow.document.activeElement?.getAttribute('aria-label'), '閉じる');
	});

	test('accepts forwarded find keys only for the active external surface', () => {
		const host = mainWindow.document.createElement('div');
		const externalSurface = mainWindow.document.createElement('div');
		mainWindow.document.body.append(host, externalSurface);
		store.add({ dispose: () => { host.remove(); externalSurface.remove(); } });
		let active = false;
		const widget = store.add(new ParadisOfficeFindWidget(host, {
			search: async () => ({ results: [], total: 0, capped: false }),
			isActive: () => active,
		}));

		externalSurface.dispatchEvent(new KeyboardEvent('keydown', { key: 'f', ctrlKey: true, bubbles: true }));
		strictEqual(widget.isVisible(), false);
		active = true;
		externalSurface.dispatchEvent(new KeyboardEvent('keydown', { key: 'f', ctrlKey: true, bubbles: true }));
		strictEqual(widget.isVisible(), true);
	});
	test('moves beside the change panel in a wide pane and below it in a narrow one', () => {
		const host = mainWindow.document.createElement('div');
		host.style.cssText = 'position: relative; width: 1000px; height: 600px;';
		mainWindow.document.body.appendChild(host);
		store.add({ dispose: () => host.remove() });
		const widget = store.add(new ParadisOfficeFindWidget(host, {}));
		const panel = mainWindow.document.createElement('div');
		panel.style.cssText = 'position: absolute; top: 40px; right: 8px; width: 360px; height: 200px; display: none;';
		host.appendChild(panel);
		widget.avoidOverlapWith(panel);
		const element = host.querySelector<HTMLElement>('.paradis-office-find-widget')!;
		const place = () => [element.style.right, element.style.top, element.style.maxWidth];
		const hidden = place();
		panel.style.display = 'block';
		widget.avoidOverlapWith(panel);
		const wide = place();
		host.style.width = '780px';
		widget.avoidOverlapWith(panel);
		const justWideEnough = place();
		host.style.width = '600px';
		widget.avoidOverlapWith(panel);
		const narrow = place();
		deepStrictEqual({ hidden, wide, justWideEnough, narrow }, {
			hidden: ['', '', ''],
			wide: ['376px', '', '616px'],
			justWideEnough: ['376px', '', '396px'],
			narrow: ['', '248px', ''],
		});
	});
	test('avoids whichever of several panels is open (the change panel or the data validation panel)', () => {
		const host = mainWindow.document.createElement('div');
		host.style.cssText = 'position: relative; width: 1000px; height: 600px;';
		mainWindow.document.body.appendChild(host);
		store.add({ dispose: () => host.remove() });
		const widget = store.add(new ParadisOfficeFindWidget(host, {}));
		const panel = (top: number, width: number) => {
			const element = mainWindow.document.createElement('div');
			element.style.cssText = `position: absolute; top: ${top}px; right: 8px; width: ${width}px; height: 200px; display: none;`;
			host.appendChild(element);
			return element;
		};
		const changes = panel(40, 360);
		const validation = panel(40, 300);
		const element = host.querySelector<HTMLElement>('.paradis-office-find-widget')!;
		const place = () => [element.style.right, element.style.top, element.style.maxWidth];
		widget.avoidOverlapWith(changes, validation);
		const none = place();
		validation.style.display = 'block';
		widget.avoidOverlapWith(changes, validation);
		const validationOpen = place();
		validation.style.display = 'none';
		changes.style.display = 'block';
		widget.avoidOverlapWith(changes, validation);
		const changesOpen = place();
		deepStrictEqual({ none, validationOpen, changesOpen }, {
			none: ['', '', ''],
			validationOpen: ['316px', '', '676px'],
			changesOpen: ['376px', '', '616px'],
		});
	});
});
