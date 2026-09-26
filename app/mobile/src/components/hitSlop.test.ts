// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import { describe, expect, it } from 'vitest';
import { hitSlopToMinimum } from './hitSlop.js';

describe('hitSlopToMinimum', () => {
	it('extends a small control up to the 44pt hit size', () => {
		expect(hitSlopToMinimum(20)).toEqual({ top: 12, bottom: 12, left: 0, right: 0 });
		expect(hitSlopToMinimum(21, 30)).toEqual({ top: 12, bottom: 12, left: 7, right: 7 });
	});

	it('adds nothing when the control is already large enough', () => {
		expect(hitSlopToMinimum(44, 60)).toEqual({ top: 0, bottom: 0, left: 0, right: 0 });
	});
});
