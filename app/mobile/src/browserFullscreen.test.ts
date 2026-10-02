// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import { describe, expect, test } from 'vitest';
import { BROWSER_FULLSCREEN_OFF, landscapeAllowed, nextBrowserFullscreen, selectionForScope, sidebarForFullscreen, type BrowserFullscreenEvent, type BrowserFullscreenState } from './browserFullscreen.js';

function run(events: readonly BrowserFullscreenEvent[], tablet = false): { state: BrowserFullscreenState; landscape: boolean }[] {
	let state = BROWSER_FULLSCREEN_OFF;
	return events.map(event => {
		state = nextBrowserFullscreen(state, event);
		return { state, landscape: landscapeAllowed(state, tablet) };
	});
}

const device = (orientation: 'portrait' | 'landscape' | 'other', tablet = false): BrowserFullscreenEvent => ({ kind: 'device', orientation, tablet });

describe('browser fullscreen', () => {
	test('横に倒して入ったら、縦に戻すと抜ける（表を上に向けても変わらない）', () => {
		expect(run([device('portrait'), device('landscape'), device('other'), device('portrait')])).toEqual([
			{ state: { fullscreen: false, via: undefined }, landscape: false },
			{ state: { fullscreen: true, via: 'tilt' }, landscape: true },
			{ state: { fullscreen: true, via: 'tilt' }, landscape: true },
			{ state: { fullscreen: false, via: undefined }, landscape: false },
		]);
	});

	test('ボタンで入ったら、縦に戻しても抜けず、ボタンか画面を離れたときに抜ける', () => {
		expect(run([{ kind: 'toggle' }, device('landscape'), device('portrait'), { kind: 'toggle' }, { kind: 'toggle' }, { kind: 'exit' }]).map(step => step.state)).toEqual([
			{ fullscreen: true, via: 'button' },
			{ fullscreen: true, via: 'button' },
			{ fullscreen: true, via: 'button' },
			{ fullscreen: false, via: undefined },
			{ fullscreen: true, via: 'button' },
			{ fullscreen: false, via: undefined },
		]);
	});

	test('iPad は端末の向きで出し入れせず、横向きの許可も変えない', () => {
		expect(run([device('landscape', true), { kind: 'toggle' }, device('portrait', true)], true)).toEqual([
			{ state: { fullscreen: false, via: undefined }, landscape: false },
			{ state: { fullscreen: true, via: 'button' }, landscape: false },
			{ state: { fullscreen: true, via: 'button' }, landscape: false },
		]);
	});

	test('iPad の左の列は全画面の間だけ畳み、抜けたら自分で畳んだときだけ戻す', () => {
		expect([
			sidebarForFullscreen(true, true, false, false),
			sidebarForFullscreen(false, true, true, true),
			// もともと畳んでいたら触らない・戻さない
			sidebarForFullscreen(true, true, true, false),
			sidebarForFullscreen(false, true, true, false),
			// iPhone（狭い幅）では畳まない
			sidebarForFullscreen(true, false, false, false),
		]).toEqual([
			{ set: true, collapsedByFullscreen: true },
			{ set: false, collapsedByFullscreen: false },
			{ set: undefined, collapsedByFullscreen: false },
			{ set: undefined, collapsedByFullscreen: false },
			{ set: undefined, collapsedByFullscreen: false },
		]);
	});

	test('前回の選択は同じスペースのものだけ使う', () => {
		type Selection = { readonly targetId: string; readonly scopeKey?: string };
		const selection: Selection = { targetId: 't1', scopeKey: '1:repo' };
		const unscoped: Selection = { targetId: 't0' };
		expect([
			selectionForScope(selection, '1:repo'),
			selectionForScope(selection, '1:worktree'),
			selectionForScope(unscoped, '1:repo'),
			selectionForScope(unscoped, undefined),
			selectionForScope<Selection>(undefined, '1:repo'),
		]).toEqual([selection, undefined, undefined, unscoped, undefined]);
	});
});
