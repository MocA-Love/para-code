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
	// ウィジェット（App Group の要約ファイル）。古いビルドには無いので optional にしておく。
	widgetStoreAvailable?(): boolean;
	writeWidgetFile?(name: string, contents: string): Promise<void>;
	readWidgetFile?(name: string): Promise<string | null>;
	removeWidgetOutboxEntries?(entriesJson: string): Promise<void>;
	reloadWidgets?(kinds: string[]): void;
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

// --- ホーム画面・ロック画面のウィジェット -------------------------------------------

/** App Group に置くファイル（ネイティブ側が許す名前はこの3つだけ）。 */
export type WidgetFileName = 'widget-snapshot.json' | 'widget-settings.json' | 'widget-outbox.json';

/** ウィジェットの種類（Swift 側の `kind` と一致させる）。 */
export const WIDGET_KINDS = {
	attention: 'ParaCodeAttention',
	agents: 'ParaCodeAgents',
	pcStatus: 'ParaCodePcStatus',
	space: 'ParaCodeSpace',
} as const;

/** App Group が使えるビルドか（ウィジェットの無い古いビルド・Expo Go では false）。 */
export function isWidgetStoreAvailable(): boolean {
	return native?.widgetStoreAvailable?.() ?? false;
}

export async function writeWidgetFile(name: WidgetFileName, contents: string): Promise<void> {
	await native?.writeWidgetFile?.(name, contents);
}

/** 無ければ undefined。 */
export async function readWidgetFile(name: WidgetFileName): Promise<string | undefined> {
	const raw = await native?.readWidgetFile?.(name);
	return raw ?? undefined;
}

/** 積み置き（ウィジェットの「確認済みにする」）から、送り終えたものを消す。 */
export async function removeWidgetOutboxEntries(entries: readonly { pcId: string; key: string }[]): Promise<void> {
	if (entries.length === 0) {
		return;
	}
	await native?.removeWidgetOutboxEntries?.(JSON.stringify(entries));
}

/** ウィジェットを描き直させる（kinds を空にすると全種類）。アプリが前面にいる間は予算に数えられない。 */
export function reloadWidgets(kinds: readonly string[] = []): void {
	native?.reloadWidgets?.([...kinds]);
}
