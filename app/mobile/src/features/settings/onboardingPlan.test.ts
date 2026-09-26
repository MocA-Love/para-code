// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import { describe, expect, it } from 'vitest';
import { normalizePermissionState, onboardingSteps, parseOnboardingSteps, parseSessionView } from './onboardingPlan.js';

describe('onboardingSteps', () => {
	it('何も決めていなければ、開き方 → 通知 の順に聞く', () => {
		expect(onboardingSteps({ sessionViewChosen: false, notificationPermission: 'undetermined', notificationsAnswered: false }))
			.toEqual(['session-view', 'notifications']);
	});

	it('開き方を選んだことがあれば聞かない', () => {
		expect(onboardingSteps({ sessionViewChosen: true, notificationPermission: 'undetermined', notificationsAnswered: false }))
			.toEqual(['notifications']);
	});

	it('OS に許可・拒否を済ませていれば通知は聞かない', () => {
		expect(onboardingSteps({ sessionViewChosen: false, notificationPermission: 'granted', notificationsAnswered: false }))
			.toEqual(['session-view']);
		expect(onboardingSteps({ sessionViewChosen: false, notificationPermission: 'denied', notificationsAnswered: false }))
			.toEqual(['session-view']);
	});

	it('「あとで」を選んだことがあれば、まだ OS に聞いていなくても二度は聞かない', () => {
		expect(onboardingSteps({ sessionViewChosen: true, notificationPermission: 'undetermined', notificationsAnswered: true }))
			.toEqual([]);
	});
});

describe('parseSessionView', () => {
	it('保存した値だけを読み戻す', () => {
		expect(parseSessionView('chat')).toBe('chat');
		expect(parseSessionView('terminal')).toBe('terminal');
		expect(parseSessionView('grid')).toBeUndefined();
		expect(parseSessionView(null)).toBeUndefined();
		expect(parseSessionView(undefined)).toBeUndefined();
	});
});

describe('normalizePermissionState', () => {
	it('知らない値は拒否側に倒す', () => {
		expect(normalizePermissionState('granted')).toBe('granted');
		expect(normalizePermissionState('undetermined')).toBe('undetermined');
		expect(normalizePermissionState('denied')).toBe('denied');
		expect(normalizePermissionState('provisional')).toBe('denied');
		expect(normalizePermissionState(undefined)).toBe('denied');
	});
});

describe('parseOnboardingSteps', () => {
	it('聞く順に並べ直し、重複と知らない値を捨てる', () => {
		expect(parseOnboardingSteps('notifications,session-view,notifications,other')).toEqual(['session-view', 'notifications']);
		expect(parseOnboardingSteps(['notifications'])).toEqual(['notifications']);
	});

	it('渡されていない・読めるものが無ければ undefined', () => {
		expect(parseOnboardingSteps(undefined)).toBeUndefined();
		expect(parseOnboardingSteps('')).toBeUndefined();
		expect(parseOnboardingSteps('other')).toBeUndefined();
	});
});
