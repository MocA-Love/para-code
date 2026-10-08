/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import * as assert from 'assert';
import { mainWindow } from '../../../../../base/browser/window.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { ParadisCursorOverlayOwnedCommand, paradisBuildCursorOverlayScript } from '../../common/paradisCursorOverlay.js';

/** The generated script keeps its state on the window under this key (the isolated world in the app). */
const STATE_KEY = '__paraCodeAgentCursorOverlay';

interface IPageState {
	readonly h: HTMLElement | null;
	readonly mv: HTMLElement | null;
	readonly lf: HTMLElement | null;
	readonly t: string;
	readonly x: number | null;
	readonly y: number | null;
	readonly sticky: string;
	readonly wt: boolean;
	readonly watch: boolean;
	wat: number;
}

/** Runs the page-side script against this test document, the way the isolated world would. */
function run(command: ParadisCursorOverlayOwnedCommand): unknown {
	return new Function(`return ${paradisBuildCursorOverlayScript(command)};`)();
}

interface IPageGlobal {
	readonly cs: Record<string, IPageState>;
	readonly f: HTMLElement | null;
	readonly ts: HTMLElement | null;
}

/** The cursor of commands without an owner. */
function pageState(): IPageState | undefined {
	return (mainWindow as unknown as Record<string, IPageGlobal | undefined>)[STATE_KEY]?.cs._;
}

function pageGlobal(): IPageGlobal | undefined {
	return (mainWindow as unknown as Record<string, IPageGlobal | undefined>)[STATE_KEY];
}

suite('Paradis Cursor Overlay page script', () => {

	ensureNoDisposablesAreLeakedInTestSuite();

	teardown(() => {
		run({ kind: 'remove' });
		mainWindow.document.documentElement.style.removeProperty('transform');
	});

	test('the cursor joins the top layer above a modal dialog, and stays off a page whose <html> shifts fixed positions', () => {
		const doc = mainWindow.document;
		const dialog = doc.createElement('dialog');
		doc.body.appendChild(dialog);
		dialog.showModal();
		let aboveModal: boolean;
		let traits: unknown;
		try {
			traits = run({ kind: 'move', x: 10, y: 10, label: 'a', durationMs: 0, frames: [{ x: 10, y: 10, r: 0, o: 1 }] });
			aboveModal = pageState()?.h?.matches(':popover-open') === true;
		} finally {
			dialog.close();
			dialog.remove();
		}
		run({ kind: 'remove' });

		doc.documentElement.style.transform = 'translateX(1px)';
		const blocked = run({ kind: 'move', x: 10, y: 10, label: 'a', durationMs: 0, frames: [{ x: 10, y: 10, r: 0, o: 1 }] });
		const drawn = pageState()?.h ?? null;

		assert.deepStrictEqual(
			{ aboveModal, traits: (traits as { blocked?: unknown }).blocked, blocked: (blocked as { blocked?: unknown }).blocked, drawn },
			{ aboveModal: true, traits: false, blocked: true, drawn: null },
		);
	});

	test('moves play keyframes without rewriting the style attribute, and the name tag shows the state', async () => {
		const doc = mainWindow.document;
		const input = doc.createElement('input');
		input.type = 'password';
		doc.body.appendChild(input);
		try {
			run({ kind: 'move', x: 10, y: 10, label: 'Claude', durationMs: 0, frames: [{ x: 10, y: 10, r: 0, o: 1 }] });
			const mover = pageState()!.mv!;
			let styleWrites = 0;
			const observer = new MutationObserver(records => { styleWrites += records.length; });
			observer.observe(mover, { attributes: true, attributeFilter: ['style'] });
			run({ kind: 'move', x: 200, y: 40, label: 'Claude', durationMs: 120, frames: [{ x: 10, y: 10, r: 0, o: 0 }, { x: 120, y: 20, r: 20, o: 0.5 }, { x: 200, y: 40, r: 0, o: 1 }] });
			run({ kind: 'move', x: 300, y: 40, label: 'Claude', durationMs: 120, frames: [{ x: 200, y: 40, r: 0, o: 0 }, { x: 300, y: 40, r: 0, o: 1 }] });
			await Promise.resolve();
			observer.disconnect();
			const animated = mover.getAnimations().some(animation => animation.playState === 'running');
			run({ kind: 'status', label: 'Claude', status: 'script', text: 'Running a script' });
			const scripted = pageState()!.t;
			input.focus();
			run({ kind: 'focus', label: 'Claude', texts: { typing: 'Typing', secret: 'Typing (hidden)', page: 'Typing to the page' } });
			const typed = pageState()!.t;
			assert.deepStrictEqual(
				{ styleWrites, animated, scripted, typed },
				{ styleWrites: 0, animated: true, scripted: 'Claude \u00b7 Running a script', typed: 'Claude \u00b7 Typing (hidden)' },
			);
		} finally {
			input.remove();
		}
	});

	test('a tool state before any cursor leaves no element on the page, and comes back with the first move', () => {
		run({ kind: 'status', label: 'Claude', status: 'script', text: 'Running a script' });
		const before = pageState()?.h ?? null;
		run({ kind: 'move', x: 10, y: 10, label: 'Claude', durationMs: 0, frames: [{ x: 10, y: 10, r: 0, o: 1 }] });
		const shown = pageState()!.t;
		run({ kind: 'status', label: 'Claude', status: 'idle', text: '' });
		assert.deepStrictEqual({ before, shown, after: pageState()!.t }, { before: null, shown: 'Claude \u00b7 Running a script', after: 'Claude' });
	});

	test('a tool state with park shows the cursor at the bottom-right corner, and a reading box frames the element and brings the cursor there', () => {
		run({ kind: 'status', label: 'Claude', status: 'reading', text: 'Reading', park: true });
		const s = pageState()!;
		const parked = { x: s.x, y: s.y, t: s.t, connected: s.h?.isConnected };
		run({ kind: 'status', label: 'Claude', status: 'reading', text: 'Reading', park: true, box: { x: 40, y: 50, width: 100, height: 20 } });
		const framed = { x: s.x, y: s.y, frame: [s.lf?.style.left, s.lf?.style.top, s.lf?.style.width, s.lf?.style.opacity] };
		// Off the screen: no frame move and no cursor move.
		run({ kind: 'status', label: 'Claude', status: 'reading', text: 'Reading', park: true, box: { x: -500, y: -500, width: 10, height: 10 } });
		assert.deepStrictEqual(
			{ parked, framed, offscreen: { x: s.x, y: s.y } },
			{
				parked: { x: Math.max(12, Math.round(mainWindow.innerWidth - 200)), y: Math.max(12, Math.round(mainWindow.innerHeight - 64)), t: 'Claude \u00b7 Reading', connected: true },
				framed: { x: 54, y: 60, frame: ['37px', '47px', '106px', '1'] },
				offscreen: { x: 54, y: 60 },
			},
		);
	});

	test('a restored loading state after a navigation is shown once and does not stick or spin', () => {
		run({ kind: 'status', label: 'Claude', status: 'loading', text: 'Loading', park: true, transient: true, frames: [{ x: 30, y: 40, r: 0, o: 1 }], durationMs: 0 });
		const s = pageState()!;
		assert.deepStrictEqual({ t: s.t, sticky: s.sticky, spinning: s.wt, at: [s.x, s.y] }, { t: 'Claude \u00b7 Loading', sticky: '', spinning: false, at: [30, 40] });
	});

	test('a click made by a script follows the cursor only while the script runs', () => {
		const doc = mainWindow.document;
		const button = doc.createElement('button');
		button.style.cssText = 'position:fixed;left:200px;top:120px;width:40px;height:20px;margin:0;padding:0;border:0';
		doc.body.appendChild(button);
		try {
			run({ kind: 'status', label: 'Claude', status: 'script', text: 'Running', park: true, clickText: 'Clicked by script' });
			button.click();
			const s = pageState()!;
			const followed = { at: [s.x, s.y], t: s.t };
			run({ kind: 'status', label: 'Claude', status: 'idle', text: '' });
			button.style.left = '400px';
			button.dispatchEvent(new MouseEvent('click', { bubbles: true }));
			assert.deepStrictEqual({ followed, after: [s.x, s.y] }, { followed: { at: [214, 130], t: 'Claude \u00b7 Clicked by script' }, after: [214, 130] });
		} finally {
			button.remove();
		}
	});

	test('script clicks are followed only after the script started, only while one cursor watches, and not past the watch limit', () => {
		const doc = mainWindow.document;
		const button = doc.createElement('button');
		button.style.cssText = 'position:fixed;left:200px;top:120px;width:40px;height:20px;margin:0;padding:0;border:0';
		doc.body.appendChild(button);
		const owner = (id: string) => ({ owner: id, color: '#d97757' });
		const at = (id: string) => { const c = pageGlobal()!.cs[id]; return [c.x, c.y]; };
		try {
			run({ kind: 'move', x: 10, y: 10, label: 'A', durationMs: 0, frames: [{ x: 10, y: 10, r: 0, o: 1 }], ...owner('aaaaaaaa') });
			// The page's own click before the script started is not replayed.
			button.click();
			run({ kind: 'status', label: 'A', status: 'script', text: 'Running', park: true, since: Date.now() + 1, ...owner('aaaaaaaa') });
			const notReplayed = at('aaaaaaaa');
			// Two cursors watching: whose click it is cannot be told, so neither moves.
			run({ kind: 'status', label: 'B', status: 'script', text: 'Running', park: true, ...owner('bbbbbbbb') });
			button.click();
			const twoWatching = [at('aaaaaaaa'), at('bbbbbbbb')];
			run({ kind: 'status', label: 'B', status: 'idle', text: '', ...owner('bbbbbbbb') });
			// Past the watch limit (the end never arrived): the page's own clicks are not followed.
			(pageGlobal()!.cs.aaaaaaaa as IPageState).wat = Date.now() - 31_000;
			button.click();
			const expired = at('aaaaaaaa');
			assert.deepStrictEqual({ notReplayed, twoWatching, expired }, { notReplayed: [10, 10], twoWatching: [[10, 10], twoWatching[1]], expired: [10, 10] });
		} finally {
			button.remove();
		}
	});

	test('settling a page in the background only drops the state, and creates nothing on a page without the cursor', () => {
		run({ kind: 'status', label: 'Claude', status: 'idle', text: '', settle: true });
		const nothing = pageGlobal();
		run({ kind: 'status', label: 'Claude', status: 'waiting', text: 'Waiting', park: true });
		const s = pageState()!;
		const host = s.h;
		const at = [s.x, s.y];
		run({ kind: 'status', label: 'Claude', status: 'idle', text: '', settle: true });
		assert.deepStrictEqual(
			{ nothing, t: s.t, sticky: s.sticky, watch: s.watch, spinning: s.wt, sameHost: s.h === host, at: [s.x, s.y] },
			{ nothing: undefined, t: 'Claude', sticky: '', watch: false, spinning: false, sameHost: true, at },
		);
	});

	test('a look frames the element without touching the state on the name tag', () => {
		run({ kind: 'status', label: 'Claude', status: 'waiting', text: 'Waiting', park: true });
		run({ kind: 'look', label: 'Claude', box: { x: 40, y: 50, width: 100, height: 20 } });
		const s = pageState()!;
		run({ kind: 'look', label: 'Claude', box: { x: -900, y: 50, width: 100, height: 20 } });
		assert.deepStrictEqual({ at: [s.x, s.y], t: s.t, sticky: s.sticky, spinning: s.wt }, { at: [54, 60], t: 'Claude \u00b7 Waiting', sticky: 'Waiting', spinning: true });
	});

	test('a snapshot lights only its range, and nothing lights while a capture hides the overlay', async () => {
		const calm = mainWindow.matchMedia('(prefers-reduced-motion: reduce)').matches;
		run({ kind: 'flash', toast: 'Snapshot', rect: { x: 10, y: 20, width: 30, height: 40 } });
		const f = pageGlobal()!.f;
		const lit = f ? [f.style.left, f.style.top, f.style.width, f.style.height] : null;
		const toast = pageGlobal()!.ts?.textContent;
		// The toast lives in a closed shadow root, so the page (and a snapshot of it) does not see its text.
		const pageSees = mainWindow.document.documentElement.textContent?.includes('Snapshot');
		await run({ kind: 'hide' });
		run({ kind: 'flash', toast: 'Again', rect: { x: 10, y: 20, width: 30, height: 40 } });
		assert.deepStrictEqual(
			{ lit, toast, pageSees, whileHidden: [pageGlobal()!.f, pageGlobal()!.ts] },
			{ lit: calm ? null : ['10px', '20px', '30px', '40px'], toast: 'Snapshot', pageSees: false, whileHidden: [null, null] },
		);
	});

	test('two owners on one page get two cursors with their own names, and remove clears both', () => {
		run({ kind: 'move', x: 10, y: 10, label: 'Claude', durationMs: 0, frames: [{ x: 10, y: 10, r: 0, o: 1 }], owner: 'aaaaaaaa', color: '#d97757', mark: 'C' });
		run({ kind: 'move', x: 90, y: 40, label: 'Codex', durationMs: 0, frames: [{ x: 90, y: 40, r: 0, o: 1 }], owner: 'bbbbbbbb', color: '#10a37f', mark: 'X' });
		const cursors = pageGlobal()!.cs;
		const names = Object.keys(cursors).sort().map(id => [id, cursors[id].t, cursors[id].h?.isConnected]);
		run({ kind: 'remove' });
		assert.deepStrictEqual({ names, after: pageGlobal() }, { names: [['aaaaaaaa', 'Claude', true], ['bbbbbbbb', 'Codex', true]], after: undefined });
	});
});
