// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

/** React Native AppState のうち、本アプリが扱うライフサイクル状態。 */
export type MobileAppState = 'active' | 'inactive' | 'background' | 'unknown' | 'extension';

export type RelayLifecycleAction = 'resume' | 'suspend' | 'none';

/** inactive は短いシステムUI表示でも発生するため、完全な background だけ接続を止める。 */
export function connectionActionForAppState(state: MobileAppState): RelayLifecycleAction {
	if (state === 'active') {
		return 'resume';
	}
	if (state === 'background') {
		return 'suspend';
	}
	return 'none';
}

export function shouldRunForegroundWork(state: MobileAppState): boolean {
	return state === 'active';
}

/** WebSocketを維持するactive/inactiveだけローカルバナー化し、backgroundはAPNsへ一本化する。 */
export function shouldPresentForegroundNotification(
	state: MobileAppState,
	payloadAt: number,
	now: number,
	maxAgeMs: number,
): boolean {
	return (state === 'active' || state === 'inactive') && now - payloadAt <= maxAgeMs;
}
