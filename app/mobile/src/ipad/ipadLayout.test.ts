// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import { describe, expect, test } from 'vitest';
import {
	DOCK_DEFAULT_WIDTH,
	SIDEBAR_DEFAULT_WIDTH,
	canDockPanel,
	clampSidebarWidth,
	dockWidthFor,
	sidebarWidthFor,
	listColumnsFor,
} from './ipadLayout.js';

describe('clampSidebarWidth', () => {
	test('280〜560 に収め、整数に丸める', () => {
		expect([100, 280, 333.6, 560, 900].map(clampSidebarWidth)).toEqual([280, 280, 334, 560, 560]);
	});

	test('壊れた値は既定の 340 に戻す', () => {
		expect([Number.NaN, Number.POSITIVE_INFINITY].map(clampSidebarWidth)).toEqual([SIDEBAR_DEFAULT_WIDTH, SIDEBAR_DEFAULT_WIDTH]);
	});
});

describe('sidebarWidthFor', () => {
	test('横向き（1210pt）では保存した幅のまま', () => {
		expect(sidebarWidthFor(560, 1210)).toBe(560);
	});

	test('縦向き（834pt）で広げすぎていたら、詳細の列に 320pt 残す', () => {
		expect(sidebarWidthFor(560, 834)).toBe(514);
	});

	test('狭い器でも下限の 280 は割らない・幅が測れていなければ保存した値', () => {
		expect(sidebarWidthFor(560, 700)).toBe(380);
		expect(sidebarWidthFor(340, 500)).toBe(280);
		expect(sidebarWidthFor(400, 0)).toBe(400);
	});
});

describe('canDockPanel', () => {
	test('詳細の列が 640pt 以上のときだけドックする', () => {
		expect([639, 640, 870].map(width => canDockPanel(true, width))).toEqual([false, true, true]);
	});

	test('1列（compact）では幅があってもドックしない', () => {
		expect(canDockPanel(false, 1000)).toBe(false);
	});

	test('iPad Pro 11 の横向き全画面（1210pt）で左の列が既定幅ならドックできる', () => {
		expect(canDockPanel(true, 1210 - SIDEBAR_DEFAULT_WIDTH)).toBe(true);
	});

	test('縦向き全画面（834pt）では左の列を隠したときだけドックできる', () => {
		expect(canDockPanel(true, 834 - SIDEBAR_DEFAULT_WIDTH)).toBe(false);
		expect(canDockPanel(true, 834)).toBe(true);
	});
});

describe('dockWidthFor', () => {
	test('保存した幅を 280〜560 に収める', () => {
		expect([100, 400, 900].map(saved => dockWidthFor(saved, 2000))).toEqual([280, 400, 560]);
	});

	test('会話の側に 360pt 残るよう頭を押さえる', () => {
		expect(dockWidthFor(560, 870)).toBe(510);
		expect(870 - dockWidthFor(560, 870)).toBe(360);
	});

	test('壊れた値は既定の 340', () => {
		expect(dockWidthFor(Number.NaN, 2000)).toBe(DOCK_DEFAULT_WIDTH);
	});
});

describe('listColumnsFor', () => {
	test('本文が十分広いときだけ2列にする', () => {
		expect([400, 500, 839, 840, 1026].map(listColumnsFor)).toEqual([1, 1, 1, 2, 2]);
	});
});
