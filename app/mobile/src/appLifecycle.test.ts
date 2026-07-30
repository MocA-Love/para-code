// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import { describe, expect, it } from 'vitest';
import {
	connectionActionForAppState,
	shouldRunForegroundWork,
} from './appLifecycle.js';

describe('mobile app lifecycle policy', () => {
	it('suspends the relay only in background and resumes it when active', () => {
		expect(connectionActionForAppState('inactive')).toBe('none');
		expect(connectionActionForAppState('background')).toBe('suspend');
		expect(connectionActionForAppState('active')).toBe('resume');
	});

	it('runs animations and display timers only while active', () => {
		expect(shouldRunForegroundWork('active')).toBe(true);
		expect(shouldRunForegroundWork('inactive')).toBe(false);
		expect(shouldRunForegroundWork('background')).toBe(false);
	});

});
