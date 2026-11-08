// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import type { GestureResponderEvent } from 'react-native';
import { describe, expect, it } from 'vitest';
import { beginInplaceSelect, isHoldCancel, isOutsideTap, observeInplaceSelectTouchEnd, observeInplaceSelectTouchStart } from './inplaceSelectSession.js';

function touch(pageX: number, pageY: number, timestamp: number): GestureResponderEvent {
	return { nativeEvent: { pageX, pageY, timestamp, touches: [] } } as unknown as GestureResponderEvent;
}

describe('isOutsideTap', () => {
	it('counts a short, still touch as a tap and a drag or a long press as not', () => {
		const start = { pageX: 100, pageY: 100, at: 0 };
		expect([
			isOutsideTap(start, { pageX: 104, pageY: 106, at: 200 }),
			isOutsideTap(start, { pageX: 100, pageY: 140, at: 200 }),
			isOutsideTap(start, { pageX: 100, pageY: 100, at: 900 }),
			isOutsideTap(undefined, { pageX: 100, pageY: 100, at: 10 }),
		]).toEqual([true, false, false, false]);
	});
});

describe('isHoldCancel', () => {
	it('prepares the select view only when the menu took a still, held touch, not when a scroll took it', () => {
		const start = { pageX: 10, pageY: 10, at: 0 };
		expect([
			isHoldCancel(start, undefined, 500),
			isHoldCancel(start, { pageX: 14, pageY: 12 }, 500),
			isHoldCancel(start, { pageX: 10, pageY: 40 }, 500),
			isHoldCancel(start, undefined, 120),
			isHoldCancel(undefined, undefined, 500),
		]).toEqual([true, true, false, false, false]);
	});
});

describe('inplace select session', () => {
	it('closes on a tap outside, keeps open on a tap inside, and allows one session at a time', () => {
		const log: string[] = [];
		const session = (name: string, inside: boolean) => ({
			close: () => log.push(`close ${name}`),
			contains: (_x: number, _y: number, done: (value: boolean) => void) => done(inside),
		});
		const endA = beginInplaceSelect(session('a', true));
		observeInplaceSelectTouchStart(touch(10, 10, 0));
		observeInplaceSelectTouchEnd(touch(10, 10, 100));
		const endB = beginInplaceSelect(session('b', false));
		endA();
		observeInplaceSelectTouchStart(touch(10, 10, 0));
		observeInplaceSelectTouchEnd(touch(10, 60, 100));
		observeInplaceSelectTouchStart(touch(10, 10, 0));
		observeInplaceSelectTouchEnd(touch(10, 10, 100));
		endB();
		observeInplaceSelectTouchStart(touch(10, 10, 0));
		observeInplaceSelectTouchEnd(touch(10, 10, 100));
		expect(log).toEqual(['close a', 'close b']);
	});
});
