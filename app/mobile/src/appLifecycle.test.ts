// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import { describe, expect, it } from 'vitest';
import {
	connectionActionForAppState,
	shouldPresentForegroundNotification,
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

	it('shows a fresh socket notification until the app reaches background', () => {
		const now = 100_000;
		expect(shouldPresentForegroundNotification('active', now - 1_000, now, 60_000)).toBe(true);
		expect(shouldPresentForegroundNotification('background', now - 1_000, now, 60_000)).toBe(false);
		// inactive中はソケットを維持するため、この短い遷移境界の通知はローカル表示する。
		expect(shouldPresentForegroundNotification('inactive', now - 1_000, now, 60_000)).toBe(true);
		expect(shouldPresentForegroundNotification('active', now - 60_001, now, 60_000)).toBe(false);
	});
});
