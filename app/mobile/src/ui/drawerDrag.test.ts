// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import { describe, expect, test } from 'vitest';
import {
	DISMISS_DISTANCE,
	DISMISS_VELOCITY,
	FALLBACK_FADE_DISTANCE,
	MIN_FADE_DISTANCE,
	RUBBER_BAND,
	backdropFadeDistance,
	dragOffset,
	shouldDismissDrag,
	shouldGrabContent,
	shouldGrabHandle,
	shouldGrabHeader,
} from './drawerDrag.js';

describe('dragOffset', () => {
	test('下へは指と同じだけ動く', () => {
		expect(dragOffset(0)).toBe(0);
		expect(dragOffset(57)).toBe(57);
	});

	test('上へはゴムのように少しだけ動く', () => {
		expect(dragOffset(-40)).toBe(-40 * RUBBER_BAND);
		expect(Math.abs(dragOffset(-40))).toBeLessThan(40);
	});
});

describe('shouldDismissDrag', () => {
	test('一定距離を超えて離すと閉じる', () => {
		expect(shouldDismissDrag(DISMISS_DISTANCE + 1, 0)).toBe(true);
	});

	test('距離が足りず遅ければ元へ戻る', () => {
		expect(shouldDismissDrag(DISMISS_DISTANCE, 0)).toBe(false);
		expect(shouldDismissDrag(30, DISMISS_VELOCITY)).toBe(false);
	});

	test('短くても下へ速く払えば閉じる', () => {
		expect(shouldDismissDrag(20, DISMISS_VELOCITY + 0.1)).toBe(true);
	});

	test('上へ引いた位置で離したときは、速さが下向きでも閉じない', () => {
		expect(shouldDismissDrag(-10, DISMISS_VELOCITY + 1)).toBe(false);
	});
});

describe('掴む判定', () => {
	test('つまみは上下どちらの縦移動でも掴み、横移動では掴まない', () => {
		expect(shouldGrabHandle(0, 6)).toBe(true);
		expect(shouldGrabHandle(0, -6)).toBe(true);
		expect(shouldGrabHandle(0, 3)).toBe(false);
		expect(shouldGrabHandle(20, 10)).toBe(false);
	});

	test('見出しは中身が上端にあって下へ引いたときだけ掴む', () => {
		expect(shouldGrabHeader(0, 0, 6)).toBe(true);
		expect(shouldGrabHeader(0, 0, -6)).toBe(false);
		expect(shouldGrabHeader(40, 0, 6)).toBe(false);
		expect(shouldGrabHeader(0, 10, 6)).toBe(false);
	});

	test('中身は上端までスクロールしていて、下へ少し大きく引いたときだけ掴む', () => {
		expect(shouldGrabContent(0, 0, 10)).toBe(true);
		expect(shouldGrabContent(0, 0, 6)).toBe(false);
		expect(shouldGrabContent(12, 0, 10)).toBe(false);
		expect(shouldGrabContent(0, 0, -10)).toBe(false);
	});
});

describe('backdropFadeDistance', () => {
	test('測る前は既定の距離を使う', () => {
		expect(backdropFadeDistance(0)).toBe(FALLBACK_FADE_DISTANCE);
		expect(backdropFadeDistance(Number.NaN)).toBe(FALLBACK_FADE_DISTANCE);
	});

	test('シートの高さぶん下げたら幕が消える（低すぎるシートは下限まで広げる）', () => {
		expect(backdropFadeDistance(420)).toBe(420);
		expect(backdropFadeDistance(60)).toBe(MIN_FADE_DISTANCE);
	});
});
