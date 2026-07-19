// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import { requireOptionalNativeModule } from 'expo-modules-core';

/** Live Activity の表示状態（Swift側 ParaCodeActivityAttributes.ContentState と一致させる）。 */
export interface LiveActivityAgentRow {
	name: string;
	ws: string;
	status: 'waiting' | 'running';
}

export interface LiveActivityState {
	waitingCount: number;
	runningCount: number;
	agents: LiveActivityAgentRow[];
	questionPreview?: string;
	/** PC本体のバッテリー（旧PCでは未配信。undefinedならピル非表示）。levelは0〜100。 */
	battery?: { level: number; charging: boolean };
}

interface NativeModuleShape {
	isSupported(): boolean;
	startOrUpdate(pcName: string, stateJson: string): Promise<void>;
	end(): Promise<void>;
}

// Expo Go 等ネイティブモジュールが無い環境では null（全APIがno-opになる）。
const native = requireOptionalNativeModule<NativeModuleShape>('ParaLiveActivity');

export function isLiveActivitySupported(): boolean {
	return native?.isSupported() ?? false;
}

/** Activityが無ければ開始、あれば状態を更新する。 */
export async function startOrUpdateLiveActivity(pcName: string, state: LiveActivityState): Promise<void> {
	await native?.startOrUpdate(pcName, JSON.stringify(state));
}

/** すべてのActivityを即時終了する。 */
export async function endLiveActivity(): Promise<void> {
	await native?.end();
}
