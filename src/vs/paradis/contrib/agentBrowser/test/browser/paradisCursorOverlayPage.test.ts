/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import * as assert from 'assert';
import { mainWindow } from '../../../../../base/browser/window.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { PARADIS_CLAUDE_LOGO_PATH, PARADIS_CODEX_LOGO_PATH } from '../../../../common/paradisAgentLogoPaths.js';
import { IParadisCursorOverlayTuning, PARADIS_CURSOR_OVERLAY_MISSING, PARADIS_CURSOR_OVERLAY_TUNING, ParadisCursorOverlayOwnedCommand, paradisBuildCursorOverlayCall, paradisBuildCursorOverlayScript } from '../../common/paradisCursorOverlay.js';

/** The generated script keeps its state on the window under this key (the isolated world in the app). */
const STATE_KEY = '__paraCodeAgentCursorOverlay';

/** The scroll listener keeps its state under this key. */
const SCROLLS_KEY = '__paraCodeAgentCursorScrolls';

interface IPageState {
	readonly h: HTMLElement | null;
	readonly mv: HTMLElement | null;
	readonly lf: HTMLElement | null;
	readonly mk: HTMLElement | null;
	/** The name tag, the CLI mark at its start, and the waiting ring inside it. */
	readonly lb: HTMLElement | null;
	readonly lm: HTMLElement | null;
	readonly rg: HTMLElement | null;
	/** The arrow (rotates with the motion). */
	readonly gl: HTMLElement | null;
	readonly t: string;
	readonly x: number | null;
	readonly y: number | null;
	readonly sticky: string;
	readonly wt: boolean;
	readonly watch: boolean;
	readonly bars: readonly IPageBar[] | null;
	readonly ll: boolean;
	wat: number;
}

/** A pseudo scrollbar the page script draws (q.html Q574). */
interface IPageBar {
	readonly el: HTMLElement;
	readonly root: HTMLElement;
	readonly v: number;
}

/** The body is kept on the window under this key once it has been sent. */
const RUNNER_KEY = '__paraCodeAgentCursorOverlayRun';

/** Runs the page-side script against this test document, the way the isolated world would (the short call, and the full script where the body is missing). */
function run(command: ParadisCursorOverlayOwnedCommand, tuning?: IParadisCursorOverlayTuning): unknown {
	const result = new Function(`return ${paradisBuildCursorOverlayCall(command, tuning)};`)();
	return result === PARADIS_CURSOR_OVERLAY_MISSING ? new Function(`return ${paradisBuildCursorOverlayScript(command, tuning)};`)() : result;
}

/** Scrolls count as stopped after 5 ms, and a script's late scroll after its end is 5 ms at most. */
const QUICK: IParadisCursorOverlayTuning = { ...PARADIS_CURSOR_OVERLAY_TUNING, scrollSettleMs: 5, scrollLateMs: 5 };

/** Waits well past the quick settle time (the scroll timers are real timers on the page). */
const SETTLED_MS = 60;

function sleep(ms: number): Promise<void> {
	return new Promise(resolve => setTimeout(resolve, ms));
}

/** A fixed scroll box at 100,50 (200 x 100) with tall content. */
function scrollBox(overflow = 'auto'): HTMLElement {
	const box = mainWindow.document.createElement('div');
	box.style.cssText = `position:fixed;left:100px;top:50px;width:200px;height:100px;overflow:${overflow};margin:0;padding:0;border:0`;
	const content = mainWindow.document.createElement('div');
	content.style.cssText = 'width:200px;height:3000px';
	box.appendChild(content);
	mainWindow.document.body.appendChild(box);
	return box;
}

/** Moves the box the way a script would, and tells the listener now instead of on the next frame. */
function scrollBoxBy(box: HTMLElement, y: number): void {
	box.scrollTop += y;
	box.dispatchEvent(new Event('scroll'));
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

/** The scroll listener's state (placed once per document). */
function pageScrolls(): { readonly runs: readonly unknown[] } | undefined {
	return (mainWindow as unknown as Record<string, { readonly runs: readonly unknown[] } | undefined>)[SCROLLS_KEY];
}

function pageGlobal(): IPageGlobal | undefined {
	return (mainWindow as unknown as Record<string, IPageGlobal | undefined>)[STATE_KEY];
}

suite('Paradis Cursor Overlay page script', () => {

	ensureNoDisposablesAreLeakedInTestSuite();

	teardown(() => {
		run({ kind: 'remove' });
		mainWindow.document.documentElement.style.removeProperty('transform');
		delete (mainWindow as unknown as Record<string, unknown>)[RUNNER_KEY];
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

	test('a script scroll draws a pseudo scrollbar on the box while it moves, and once it stops brings the cursor beside the thumb with the total, even after the script returned', async () => {
		const box = scrollBox();
		try {
			run({ kind: 'status', label: 'Claude', status: 'script', text: 'Running', park: true, scrollText: 'Scrolled {0}' }, QUICK);
			const parked = [pageState()!.x, pageState()!.y];
			// A smooth scroll arrives as several events: one bar follows it, the cursor waits for the stop.
			scrollBoxBy(box, 300);
			scrollBoxBy(box, 200);
			const s = pageState()!;
			const whileMoving = { at: [s.x, s.y], bars: s.bars?.length };
			run({ kind: 'status', label: 'Claude', status: 'idle', text: '' }, QUICK);
			await sleep(SETTLED_MS);
			// Where the real scrollbar is: over its gutter when it takes room, else inside the right edge.
			const gutter = 200 - box.clientWidth;
			const barX = Math.round(gutter > 0 ? 100 + box.clientWidth + (gutter - 7) / 2 : 100 + 200 - 7 - 2);
			const bar = s.bars?.[0];
			assert.deepStrictEqual(
				{ whileMoving, bars: s.bars?.length, onBox: bar?.el === box, left: bar?.root.style.left, top: bar?.root.style.top, value: bar?.v, x: s.x, labelLeft: s.ll, t: s.t, arrow: s.mk?.style.opacity },
				{ whileMoving: { at: parked, bars: 1 }, bars: 1, onBox: true, left: `${barX}px`, top: '52px', value: 500, x: barX - 25, labelLeft: true, t: 'Claude \u00b7 Scrolled 500px', arrow: '0' },
			);
		} finally {
			box.remove();
		}
	});

	test('a box the user cannot scroll (overflow: hidden) gets the arrow at its edge instead of a scrollbar', async () => {
		const box = scrollBox('hidden');
		try {
			run({ kind: 'status', label: 'Claude', status: 'script', text: 'Running', park: true, scrollText: 'Scrolled {0}' }, QUICK);
			scrollBoxBy(box, 300);
			await sleep(SETTLED_MS);
			const s = pageState()!;
			assert.deepStrictEqual(
				{ bars: s.bars?.length, at: [s.x, s.y], t: s.t, arrow: s.mk?.textContent },
				{ bars: 0, at: [200, 132], t: 'Claude \u00b7 Scrolled 300px', arrow: '\u2193' },
			);
		} finally {
			box.remove();
		}
	});

	test('a wheel, a key outside a field and scroll_to each show the scrollbar with their own words, and only scrolls that start while their window is open', async () => {
		const box = scrollBox();
		const text = () => pageState()!.t;
		// The next stopped scroll is shown without the gap the cursor keeps between script clicks.
		const quick: IParadisCursorOverlayTuning = { ...QUICK, scriptClickGapMs: 5 };
		try {
			run({ kind: 'move', x: 150, y: 80, label: 'Claude', durationMs: 0, frames: [{ x: 150, y: 80, r: 0, o: 1 }] }, quick);
			run({ kind: 'wheel', label: 'Claude', dx: 0, dy: 120, text: 'Scroll', scrollText: 'Wheel {0}' }, quick);
			const marked = pageState()!.mk?.style.opacity;
			scrollBoxBy(box, 120);
			await sleep(SETTLED_MS);
			const wheel = text();
			run({ kind: 'focus', label: 'Claude', texts: { typing: 'Typing', secret: 'Secret', page: 'Key' }, key: 'PageDown', scrollText: 'Key {0}' }, quick);
			scrollBoxBy(box, 80);
			await sleep(SETTLED_MS);
			const key = text();
			run({ kind: 'status', label: 'Claude', status: 'scroll', text: 'Scroll', park: true, scrollText: 'Find {0}' }, quick);
			scrollBoxBy(box, 40);
			await sleep(SETTLED_MS);
			const find = text();
			run({ kind: 'status', label: 'Claude', status: 'idle', text: '' }, quick);
			// Long after the last input, a scroll of the page's own is not shown.
			await sleep(quick.scrollInputMs + SETTLED_MS);
			scrollBoxBy(box, 40);
			const pending = pageScrolls()?.runs.length;
			assert.deepStrictEqual({ marked, wheel, key, find, pending }, { marked: '0', wheel: 'Claude \u00b7 Wheel 120px', key: 'Claude \u00b7 Key 80px', find: 'Claude \u00b7 Find 40px', pending: 0 });
		} finally {
			box.remove();
		}
	});

	test('inside the window of an agent wheel, a scroll right after a later input of the user is the user\'s', async () => {
		const box = scrollBox();
		// The agent's own wheel arrives within 20 ms of its notice; a later trusted input is the user's.
		const quick: IParadisCursorOverlayTuning = { ...QUICK, scrollInputSlackMs: 20, scriptClickGapMs: 5 };
		const scrolls = () => (mainWindow as unknown as Record<string, { user: number }>)[SCROLLS_KEY];
		try {
			run({ kind: 'move', x: 150, y: 80, label: 'Claude', durationMs: 0, frames: [{ x: 150, y: 80, r: 0, o: 1 }] }, quick);
			run({ kind: 'wheel', label: 'Claude', dx: 0, dy: 120, text: 'Scroll', scrollText: 'Wheel {0}' }, quick);
			// The agent's wheel (trusted, right after the notice): still the agent's.
			scrolls().user = Date.now();
			scrollBoxBy(box, 120);
			await sleep(SETTLED_MS);
			const agent = { t: pageState()!.t, value: pageState()!.bars?.[0]?.v };
			// The user wheels later, while the window is still open: the bar and the name tag stay where the agent left them.
			scrolls().user = Date.now();
			scrollBoxBy(box, 60);
			await sleep(SETTLED_MS);
			const user = { t: pageState()!.t, value: pageState()!.bars?.[0]?.v };
			assert.deepStrictEqual({ agent, user }, { agent: { t: 'Claude \u00b7 Wheel 120px', value: 120 }, user: { t: 'Claude \u00b7 Wheel 120px', value: 120 } });
		} finally {
			box.remove();
		}
	});

	test('scrolls before the script, after it ended, or with two cursors watching are not followed, and none is even read while nobody watches', async () => {
		const box = scrollBox();
		const owner = (id: string) => ({ owner: id, color: '#d97757' });
		const at = (id: string) => { const c = pageGlobal()!.cs[id]; return [c.x, c.y]; };
		try {
			run({ kind: 'move', x: 10, y: 10, label: 'A', durationMs: 0, frames: [{ x: 10, y: 10, r: 0, o: 1 }], ...owner('aaaaaaaa') }, QUICK);
			// The page scrolls on its own before the script starts.
			scrollBoxBy(box, 100);
			run({ kind: 'status', label: 'A', status: 'script', text: 'Running', park: true, since: Date.now() + 1, scrollText: 'Scrolled {0}', ...owner('aaaaaaaa') }, QUICK);
			await sleep(SETTLED_MS);
			const before = at('aaaaaaaa');
			// Two cursors watching: whose scroll it is cannot be told.
			run({ kind: 'status', label: 'B', status: 'script', text: 'Running', park: true, scrollText: 'Scrolled {0}', ...owner('bbbbbbbb') }, QUICK);
			scrollBoxBy(box, 100);
			await sleep(SETTLED_MS);
			const two = at('aaaaaaaa');
			run({ kind: 'status', label: 'B', status: 'idle', text: '', ...owner('bbbbbbbb') }, QUICK);
			run({ kind: 'status', label: 'A', status: 'idle', text: '', ...owner('aaaaaaaa') }, QUICK);
			// After the script ended (later than a scroll of its own could still arrive): the listener does nothing.
			await sleep(SETTLED_MS);
			scrollBoxBy(box, 100);
			const pending = pageScrolls()?.runs.length;
			await sleep(SETTLED_MS);
			assert.deepStrictEqual({ before, two, pending, after: at('aaaaaaaa') }, { before: [10, 10], two: [10, 10], pending: 0, after: [10, 10] });
		} finally {
			box.remove();
		}
	});

	test('scroll_to shows the arrow of the direction it searches, and a plain scroll mark without one', () => {
		run({ kind: 'status', label: 'Claude', status: 'scroll', text: 'Scroll', park: true, direction: 'up' });
		const up = pageState()!.mk?.textContent;
		run({ kind: 'status', label: 'Claude', status: 'scroll', text: 'Scroll', park: true });
		assert.deepStrictEqual({ up, plain: pageState()!.mk?.textContent }, { up: '\u2191', plain: '\u2195' });
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

	test('the name tag shows the Claude and Codex logos of the usage panel, keeps the letter for other CLIs, and nothing without a mark', () => {
		const owners = [['aaaaaaaa', 'C'], ['bbbbbbbb', 'X'], ['cccccccc', 'O'], ['dddddddd', '']];
		for (const [owner, mark] of owners) {
			run({ kind: 'move', x: 10, y: 10, label: 'Agent', durationMs: 0, frames: [{ x: 10, y: 10, r: 0, o: 1 }], owner, color: '#5b8cff', mark });
		}
		const cursors = pageGlobal()!.cs;
		const marks = owners.map(([owner]) => {
			const lm = cursors[owner].lm!;
			return { logo: lm.querySelector('path')?.getAttribute('d') ?? null, text: lm.textContent, display: lm.style.display };
		});
		assert.deepStrictEqual(marks, [
			{ logo: PARADIS_CLAUDE_LOGO_PATH, text: '', display: 'inline-flex' },
			{ logo: PARADIS_CODEX_LOGO_PATH, text: '', display: 'inline-flex' },
			{ logo: null, text: 'O', display: 'inline-flex' },
			{ logo: null, text: '', display: 'none' },
		]);
	});

	test('waiting turns the ring inside the name tag after the mark without dimming the arrow, and the next input stops it', () => {
		run({ kind: 'move', x: 40, y: 40, label: 'Claude', durationMs: 0, frames: [{ x: 40, y: 40, r: 0, o: 1 }], mark: 'C' });
		run({ kind: 'status', label: 'Claude', status: 'waiting', text: 'Waiting' });
		const s = pageState()!;
		const waiting = { inTag: s.rg?.parentElement === s.lb, after: s.rg?.previousElementSibling === s.lm, ring: s.rg?.style.display, arrow: s.gl ? mainWindow.getComputedStyle(s.gl).opacity : null };
		run({ kind: 'move', x: 60, y: 40, label: 'Claude', durationMs: 0, frames: [{ x: 60, y: 40, r: 0, o: 1 }], mark: 'C' });
		assert.deepStrictEqual({ waiting, done: s.rg?.style.display }, { waiting: { inTag: true, after: true, ring: 'inline-block', arrow: '1' }, done: 'none' });
	});

	test('near the right and bottom edges the name tag moves to the inner side of the tip, and comes back away from them', () => {
		const width = Math.min(mainWindow.innerWidth, mainWindow.document.documentElement.clientWidth);
		const height = Math.min(mainWindow.innerHeight, mainWindow.document.documentElement.clientHeight);
		const at = (x: number, y: number) => {
			run({ kind: 'move', x, y, label: 'Claude', durationMs: 0, frames: [{ x, y, r: 0, o: 1 }], mark: 'C' });
			const lb = pageState()!.lb!;
			return [lb.style.left, lb.style.right, lb.style.top, lb.style.bottom];
		};
		const corner = at(width - 5, height - 5);
		const right = at(width - 5, 40);
		const bottom = at(40, height - 5);
		const middle = at(40, 40);
		assert.deepStrictEqual({ corner, right, bottom, middle }, {
			corner: ['auto', '10px', 'auto', '6px'],
			right: ['auto', '10px', '22px', 'auto'],
			bottom: ['18px', 'auto', 'auto', '6px'],
			middle: ['18px', 'auto', '22px', 'auto'],
		});
	});
});
