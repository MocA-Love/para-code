// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import { describe, expect, it } from 'vitest';
import { effortSliderGestureBehavior } from './effortSliderBehavior.js';

describe('effortSliderGestureBehavior', () => {
	it('keeps an active horizontal drag instead of yielding it to the surrounding ScrollView', () => {
		expect(effortSliderGestureBehavior(false, 4)).toEqual({ enabled: true, allowTermination: false });
	});

	it('does not capture a gesture when disabled or when only one effort exists', () => {
		expect(effortSliderGestureBehavior(true, 4).enabled).toBe(false);
		expect(effortSliderGestureBehavior(false, 1).enabled).toBe(false);
	});
});
