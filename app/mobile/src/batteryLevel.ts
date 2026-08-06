// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

/**
 * PCのバッテリー残量を「見せ方の段階」へ落とす判定。
 *
 * 表示は3段階で、境目は充電しているかどうかで変わる:
 * - `low`  … 10%以下。充電していても赤のまま（まだ危険域にいることを隠さない）
 * - `ok`   … 充電中なら80%超、充電していないなら20%超
 * - `warn` … その間
 *
 * 充電中は「まだ十分に戻っていない」状態が長いので、緑になる境目を高めに置いている。
 * 稲妻（充電中の印）はこの段階と無関係に常に同じ色で出す。色は残量だけを表し、
 * 充電しているかどうかはアイコンの有無だけが表す、という切り分けにしている。
 *
 * 純関数として切り出しているのは、実機のバッテリーを減らさずに境目をテストで固定するため。
 * 見た目は `components/batteryGauge.tsx` に切り出してあり、ドロワー上部のPCカード・設定のPC一覧・
 * PC詳細が同じ判定と同じ見た目を使う。ロック画面（Live Activity）のSwift側も同じ境目にしてある。
 */
export type BatteryLevelClass = 'ok' | 'warn' | 'low';

/** 充電中でも赤のままにする残量の上限（%）。 */
export const BATTERY_LOW_MAX = 10;
/** 充電していないときに緑になる残量の下限（%、これ自体は含まない）。 */
export const BATTERY_OK_MIN_DISCHARGING = 20;
/** 充電中に緑になる残量の下限（%、これ自体は含まない）。 */
export const BATTERY_OK_MIN_CHARGING = 80;

export function batteryLevelClass(level: number, charging: boolean): BatteryLevelClass {
	if (level <= BATTERY_LOW_MAX) {
		return 'low';
	}
	return level > (charging ? BATTERY_OK_MIN_CHARGING : BATTERY_OK_MIN_DISCHARGING) ? 'ok' : 'warn';
}
