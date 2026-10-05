// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import { describe, expect, it } from 'vitest';
import { barIndexAt, isHorizontalScrub, isTap } from './voiceChartGesture.js';

describe('voiceChartGesture', () => {
	it('位置から棒を決め、横が勝った動きだけをなぞりにし、ほとんど動かずに離したらタップにする', () => {
		expect({
			index: [barIndexAt(0, 300, 30), barIndexAt(155, 300, 30), barIndexAt(400, 300, 30), barIndexAt(-5, 300, 30), barIndexAt(10, 0, 30), barIndexAt(10, 300, 0)],
			scrub: [isHorizontalScrub(3, 0), isHorizontalScrub(12, 4), isHorizontalScrub(-12, 2), isHorizontalScrub(10, 20)],
			tap: [isTap(2, 3), isTap(10, 0), isTap(0, 10)],
		}).toEqual({
			index: [0, 15, 29, 0, undefined, undefined],
			scrub: [false, true, true, false],
			tap: [true, false, false],
		});
	});
});
