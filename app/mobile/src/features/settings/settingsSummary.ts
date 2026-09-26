// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import type { PcSummary } from '../../appState.js';
import { pcStatusText, shouldShowBattery } from '../../pcStatus.js';
import { formatRelativeTime } from '../../time.js';

/**
 * 設定の行の右に出す要約（純関数。`settingsSummary.test.ts` で固定）。
 * 通知の件数の要約は既存の `src/notificationSettingsSummary.ts`、PC の状態の言い方は `src/pcStatus.ts` を使う。
 */

export type VoiceNotificationStatus = 'idle' | 'connecting' | 'live' | 'reconnecting' | 'unsupported' | 'error';

/**
 * 音声通知の状態。開始していても、つながるまでは「受信中」と言い切らない
 * （旧「通知と音声」画面と同じ区別）。
 */
export function voiceNotificationValue(voice: { readonly desired: boolean; readonly status: VoiceNotificationStatus }): string {
	if (!voice.desired) {
		return 'オフ';
	}
	if (voice.status === 'live') {
		return '受信中';
	}
	return voice.status === 'error' || voice.status === 'unsupported' ? '開始できず' : '接続中';
}

/**
 * 設定 →「PC」の行の補足（モックの「接続中 · macOS 26 · バッテリー 82%」「オフライン · 2時間前まで接続」）。
 * 状態の言い方は既存の `pcStatusText`。つながっているノート PC はバッテリーを、
 * つながっていない PC は最後につながっていた時刻を添える。
 */
export function pcRowHint(pc: PcSummary, active: boolean, now: number): string {
	const parts = [pcStatusText(pc, active)];
	if (shouldShowBattery(pc) && pc.battery !== undefined) {
		parts.push(`バッテリー ${pc.battery.level}%${pc.battery.charging ? '（充電中）' : ''}`);
	} else if (!(pc.connection === 'online' && pc.pcOnline) && pc.lastOnlineAt !== undefined) {
		parts.push(`${formatRelativeTime(pc.lastOnlineAt, now)}まで接続`);
	}
	return parts.join(' · ');
}
