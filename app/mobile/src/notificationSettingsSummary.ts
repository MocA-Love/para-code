// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

/**
 * 設定トップの「通知と音声」の行の右に出す要約。開かなくても、いくつオンになっているかが分かるようにする。
 * 数えるのは「通知が届く」ほうに働くもの（通知の種類のスイッチ・他のPCへの通知・音声通知の開始）の4つ。
 *
 * **「PC で作業中は鳴らさない」（suppressWhenPcFocused）は数えない。** あれは通知を減らす側のスイッチで、
 * オンにすると通知は届きにくくなる。「オン」の数に混ぜると、抑制をオンにしただけで件数が増え、
 * 通知が増えたように読めてしまう。
 */
export interface NotificationSettingsState {
	readonly agentDone: boolean;
	readonly agentQuestion: boolean;
	readonly notifyOtherPcs: boolean;
	/** 音声通知を開始しているか（`voiceNotifications.desired`）。 */
	readonly voice: boolean;
}

export function countEnabledNotificationSettings(state: NotificationSettingsState): number {
	return [state.agentDone, state.agentQuestion, state.notifyOtherPcs, state.voice]
		.filter(Boolean).length;
}

export function notificationSettingsSummary(state: NotificationSettingsState): string {
	const count = countEnabledNotificationSettings(state);
	return count === 0 ? 'すべてオフ' : `${count} 件オン`;
}
