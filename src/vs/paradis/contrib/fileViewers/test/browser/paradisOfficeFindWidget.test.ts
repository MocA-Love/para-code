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
import { ParadisOfficeFindWidget } from '../../browser/paradisOfficeFindWidget.js';
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
			{ anchor: 'cell:Sheet 1:A1', badge: 'Sheet 1 · Formatted', match: 'needle' },
			{ anchor: 'cell:Sheet 1:A1', badge: 'Sheet 1 · Raw', match: 'needle' },
			{ anchor: 'cell:Sheet 1:A1', badge: 'Sheet 1 · Formula', match: 'needle' },
			{ anchor: 'cell:Sheet 1:A1', badge: 'Sheet 1 · Comment', match: 'needle' },
			{ anchor: 'cell:Sheet 1:A1', badge: 'Sheet 1 · Link', match: 'needle' },
			{ anchor: 'cell:Sheet 1:A1', badge: 'Sheet 1 · Alternative Text', match: 'needle' },
			{ anchor: 'cell:Sheet 1:A1', badge: 'Sheet 1 · Placeholder', match: 'needle' },
			{ anchor: 'cell:Sheet 1:A1', badge: 'Sheet 1 · Story', match: 'needle' },
			{ anchor: 'cell:Sheet 1:A1', badge: 'Sheet 1 · Hidden', match: 'needle' },
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
		await new Promise(resolve => mainWindow.setTimeout(resolve, 0));

		strictEqual(document.activeElement, input);
		strictEqual(host.querySelector('[aria-live="polite"]')?.textContent, '1 of 2');
		strictEqual(host.querySelector('.paradis-office-find-current')?.textContent, '<b>Sheet 1</b>: <img src=x needle onerror=alert(1)>');
		strictEqual(host.querySelector('img'), null);
		deepStrictEqual(navigated, ['Sheet 1!A1|cell:Sheet 1:A1']);

		input.dispatchEvent(new KeyboardEvent('keydown', { key: 'F3', bubbles: true }));
		await new Promise(resolve => mainWindow.setTimeout(resolve, 0));
		deepStrictEqual(navigated, [
			'Sheet 1!A1|cell:Sheet 1:A1',
			'story:header:/word/header1.xml:default|word-node-2',
		]);
		strictEqual(host.querySelector('[aria-live="polite"]')?.textContent, '2 of 2');

		input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
		strictEqual(widget.isVisible(), false);
		strictEqual(document.activeElement, previous);
	});

	test('shows an explicit unavailable state instead of invoking a transport fallback', () => {
		const host = mainWindow.document.createElement('div');
		mainWindow.document.body.appendChild(host);
		store.add({ dispose: () => host.remove() });
		const widget = store.add(new ParadisOfficeFindWidget(host, { unavailableMessage: 'Search is unavailable for this adapter.' }));

		widget.reveal();

		strictEqual(host.querySelector<HTMLInputElement>('input[type="search"]')?.disabled, true);
		strictEqual(host.querySelector('[aria-live="polite"]')?.textContent, 'Search is unavailable for this adapter.');
		strictEqual(mainWindow.document.activeElement?.getAttribute('aria-label'), 'Close');
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
});
