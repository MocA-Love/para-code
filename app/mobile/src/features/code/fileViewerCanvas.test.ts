// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import { describe, expect, it } from 'vitest';
import { HTML_PAGE_CANVAS, viewerCanvasColor, withDefaultViewport, type ViewerKind, type ViewerMode } from './fileViewerModel.js';

describe('viewerCanvasColor', () => {
	it('gives an HTML preview the browser white canvas and keeps every other view on the dark one', () => {
		const cases: readonly (readonly [ViewerKind, ViewerMode])[] = [['html', 'render'], ['html', 'code'], ['markdown', 'render'], ['other', 'code'], ['spreadsheet', 'render']];
		expect(cases.map(([kind, mode]) => viewerCanvasColor(kind, mode))).toEqual([HTML_PAGE_CANVAS, undefined, undefined, undefined, undefined]);
		expect(HTML_PAGE_CANVAS).toBe('#ffffff');
	});
});

describe('withDefaultViewport', () => {
	it('adds the device-width viewport only when the page has none, and keeps the page own meta', () => {
		const meta = '<meta name="viewport" content="width=device-width, initial-scale=1">';
		expect([
			withDefaultViewport('<!DOCTYPE html><html><head><title>a</title></head><body>x</body></html>'),
			withDefaultViewport('<html lang="ja"><body>x</body></html>'),
			withDefaultViewport('<!doctype html><p>x</p>'),
			withDefaultViewport('<p>x</p>'),
			withDefaultViewport('<html><head><meta name="viewport" content="width=600"></head></html>'),
			withDefaultViewport("<head><META NAME='Viewport' CONTENT='width=device-width'></head>"),
		]).toEqual([
			`<!DOCTYPE html><html><head>${meta}<title>a</title></head><body>x</body></html>`,
			`<html lang="ja"><head>${meta}</head><body>x</body></html>`,
			`<!doctype html>${meta}<p>x</p>`,
			`${meta}<p>x</p>`,
			'<html><head><meta name="viewport" content="width=600"></head></html>',
			"<head><META NAME='Viewport' CONTENT='width=device-width'></head>",
		]);
	});
});
