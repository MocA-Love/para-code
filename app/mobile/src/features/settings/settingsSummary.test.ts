// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import { describe, expect, it, vi } from 'vitest';

// time.ts がフックのために react-native を読む（vitest は Flow 構文を読めない）。純関数だけを使うので差し替える。
vi.mock('../../hooks/useAppIsActive.js', () => ({ useAppIsActive: () => true }));
import type { PcSummary } from '../../appState.js';
import { pcRowHint, voiceNotificationValue } from './settingsSummary.js';

const NOW = new Date(2026, 8, 26, 12, 0, 0).getTime();

function pc(overrides: Partial<PcSummary> = {}): PcSummary {
	return {
		id: 'pc-1', name: 'PC', hue: 0, connection: 'online', pcOnline: true, pairingRejected: false,
		workspaces: 0, terminals: 0, waiting: 0, running: 0, lastOnlineAt: undefined, battery: undefined,
		...overrides,
	};
}

describe('voiceNotificationValue', () => {
	it('開始していなければオフ', () => {
		expect(voiceNotificationValue({ desired: false, status: 'live' })).toBe('オフ');
	});

	it('つながるまでは受信中と言い切らない', () => {
		expect(voiceNotificationValue({ desired: true, status: 'connecting' })).toBe('接続中');
		expect(voiceNotificationValue({ desired: true, status: 'reconnecting' })).toBe('接続中');
		expect(voiceNotificationValue({ desired: true, status: 'live' })).toBe('受信中');
	});

	it('始められなかったことを伝える', () => {
		expect(voiceNotificationValue({ desired: true, status: 'error' })).toBe('開始できず');
		expect(voiceNotificationValue({ desired: true, status: 'unsupported' })).toBe('開始できず');
	});
});

describe('pcRowHint', () => {
	it('つながっているノート PC はバッテリーを添える', () => {
		expect(pcRowHint(pc({ battery: { level: 82, charging: false } }), true, NOW)).toBe('接続中 · 使用中 · バッテリー 82%');
		expect(pcRowHint(pc({ battery: { level: 40, charging: true } }), false, NOW)).toBe('待機中 · バッテリー 40%（充電中）');
	});

	it('つながっていない PC は最後につながっていた時刻を添える', () => {
		expect(pcRowHint(pc({ connection: 'offline', pcOnline: false, lastOnlineAt: NOW - 2 * 3_600_000 }), false, NOW)).toBe('オフライン · 2時間前まで接続');
		// 資格を拒まれた PC は再ペアリングしかないので、最終接続時刻は付けない
		expect(pcRowHint(pc({ connection: 'offline', pcOnline: false, pairingRejected: true, lastOnlineAt: NOW - 2 * 3_600_000 }), false, NOW)).toBe('再ペアリングが必要');
	});

	it('つながっていない PC の古いバッテリーは出さない', () => {
		expect(pcRowHint(pc({ connection: 'offline', pcOnline: false, battery: { level: 82, charging: false } }), false, NOW)).toBe('オフライン');
	});
});
