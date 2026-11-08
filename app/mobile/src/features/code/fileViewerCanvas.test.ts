// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import { describe, expect, it } from 'vitest';
import { HTML_PAGE_CANVAS, viewerCanvasColor, type ViewerKind, type ViewerMode } from './fileViewerModel.js';

describe('viewerCanvasColor', () => {
	it('gives an HTML preview the browser white canvas and keeps every other view on the dark one', () => {
		const cases: readonly (readonly [ViewerKind, ViewerMode])[] = [['html', 'render'], ['html', 'code'], ['markdown', 'render'], ['other', 'code'], ['spreadsheet', 'render']];
		expect(cases.map(([kind, mode]) => viewerCanvasColor(kind, mode))).toEqual([HTML_PAGE_CANVAS, undefined, undefined, undefined, undefined]);
		expect(HTML_PAGE_CANVAS).toBe('#ffffff');
	});
});
