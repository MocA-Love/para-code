// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import { describe, expect, it } from 'vitest';
import { applyBrowserCursor, browserCursorPoint, EMPTY_BROWSER_CURSORS, pruneBrowserCursors } from './browserCursors.js';

describe('browser cursors', () => {
	it('keeps one cursor per owner, counts presses, shows states, and clears a page on gone', () => {
		let cursors = applyBrowserCursor(EMPTY_BROWSER_CURSORS, { t: 'cursor', targetId: 'T', kind: 'move', ownerId: 'aaaaaaaa', nx: 0.1, ny: 0.2, durationMs: 200, name: 'Claude', mark: 'C', color: '#d97757' }, 0);
		cursors = applyBrowserCursor(cursors, { t: 'cursor', targetId: 'T', kind: 'press', ownerId: 'aaaaaaaa', nx: 0.1, ny: 0.2 }, 10);
		cursors = applyBrowserCursor(cursors, { t: 'cursor', targetId: 'T', kind: 'state', ownerId: 'aaaaaaaa', status: 'script' }, 20);
		cursors = applyBrowserCursor(cursors, { t: 'cursor', targetId: 'T', kind: 'move', ownerId: 'bbbbbbbb', nx: 0.5, ny: 0.5, durationMs: 100, name: 'Codex', mark: 'X', color: '#10a37f' }, 30);
		const before = [...cursors.values()].map(c => ({ owner: c.ownerId, name: c.name, presses: c.presses, status: c.status, durationMs: c.durationMs }));
		const gone = applyBrowserCursor(cursors, { t: 'cursor', targetId: 'T', kind: 'gone' }, 40);
		expect({ before, gone: gone.size, pruned: pruneBrowserCursors(cursors, 70_000).size }).toEqual({
			before: [
				{ owner: 'aaaaaaaa', name: 'Claude', presses: 1, status: 'script', durationMs: 0 },
				// The first move of an owner appears in place.
				{ owner: 'bbbbbbbb', name: 'Codex', presses: 0, status: undefined, durationMs: 0 },
			],
			gone: 0,
			pruned: 0,
		});
	});

	it('places a page point inside the letterboxed video and skips points outside it', () => {
		expect([
			browserCursorPoint(0.5, 0.5, { w: 400, h: 400 }, { w: 800, h: 400 }),
			browserCursorPoint(0, 0, { w: 400, h: 400 }, { w: 800, h: 400 }),
			browserCursorPoint(1.2, 0, { w: 400, h: 400 }, { w: 800, h: 400 }),
			browserCursorPoint(0.5, 0.5, { w: 400, h: 400 }, undefined),
		]).toEqual([{ x: 200, y: 200 }, { x: 0, y: 100 }, undefined, undefined]);
	});
});
