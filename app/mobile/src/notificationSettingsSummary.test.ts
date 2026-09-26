// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import { describe, expect, test } from 'vitest';
import { countEnabledNotificationSettings, notificationSettingsSummary, type NotificationSettingsState } from './notificationSettingsSummary.js';

const allOn: NotificationSettingsState = { agentDone: true, agentQuestion: true, notifyOtherPcs: true, voice: true };

describe('notificationSettingsSummary', () => {
	test('通知が届くほうに働く4つを数える', () => {
		expect(countEnabledNotificationSettings(allOn)).toBe(4);
		expect(notificationSettingsSummary({ ...allOn, voice: false, notifyOtherPcs: false })).toBe('2 件オン');
	});

	test('音声通知の開始も1件として数える', () => {
		const withoutVoice = { ...allOn, voice: false };
		expect(countEnabledNotificationSettings(allOn) - countEnabledNotificationSettings(withoutVoice)).toBe(1);
	});

	test('抑制のスイッチ（PC で作業中は鳴らさない）は数に入れない', () => {
		// 型に無い値を渡しても数え方が変わらない（呼び出し側が画面の状態を丸ごと渡しても増えない）。
		const withSuppression = { ...allOn, suppressWhenPcFocused: true };
		expect(countEnabledNotificationSettings(withSuppression)).toBe(4);
	});

	test('すべてオフのときは件数ではなくそう書く', () => {
		expect(notificationSettingsSummary({ agentDone: false, agentQuestion: false, notifyOtherPcs: false, voice: false })).toBe('すべてオフ');
	});
});
