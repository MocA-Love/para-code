// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import { describe, expect, test } from 'vitest';
import { PAIRING_REJECTED_LABEL, isPairingRejected, pcStatusText, shouldShowBattery } from './pcStatus.js';
import type { PcSummary } from './appState.js';

function pc(overrides: Partial<PcSummary> = {}): PcSummary {
	return {
		id: 'pc1', name: 'Para Code', hue: 0,
		connection: 'online', pcOnline: true, pairingRejected: false,
		workspaces: 3, terminals: 5, waiting: 0, running: 0, lastOnlineAt: 1,
		battery: { level: 62, charging: false },
		...overrides,
	};
}

/**
 * 「繋がっているか」と「向こうでPara Codeが動いているか」を混ぜないことが本質。
 * 一緒くたに『オフライン』と出すと、PCが落ちているのか電波が無いのか分からなくなる。
 */
describe('pcStatusText', () => {
	test('接続状態の組み合わせをそれぞれ別の言葉で出す', () => {
		expect([
			pcStatusText(pc(), true),
			pcStatusText(pc(), false),
			pcStatusText(pc({ pcOnline: false }), false),
			pcStatusText(pc({ connection: 'handshaking', pcOnline: false }), false),
			pcStatusText(pc({ connection: 'connecting', pcOnline: false }), false),
			pcStatusText(pc({ connection: 'offline', pcOnline: false }), false),
			pcStatusText(pc({ connection: 'offline', pcOnline: false, pairingRejected: true }), true),
			pcStatusText(pc({ connection: 'connecting', pcOnline: false, pairingRejected: true }), false),
		]).toStrictEqual([
			'接続中 · 使用中',
			'待機中',
			'PCオフライン',
			'PCオフライン',
			'接続しています…',
			'オフライン',
			// リレーが資格を拒んだPCは、待っても直らないので「オフライン」と並べない
			'再ペアリングが必要 · 使用中',
			'再ペアリングが必要',
		]);
	});

	test('見ていないPCで待っている件数は添えるが、使用中のPCには出さない', () => {
		expect([pcStatusText(pc({ waiting: 2 }), false), pcStatusText(pc({ waiting: 2 }), true)])
			.toStrictEqual(['待機中 · 要対応 2件', '接続中 · 使用中']);
	});
});

describe('isPairingRejected', () => {
	test('資格を拒まれていて、いまも繋がっていないときだけ再ペアリングが必要と見なす', () => {
		expect([
			isPairingRejected(pc({ connection: 'offline', pcOnline: false, pairingRejected: true })),
			isPairingRejected(pc({ connection: 'connecting', pcOnline: false, pairingRejected: true })),
			// 繋がった（拒否は解けている。印が落ちる前の1回の描画でも「接続中」を優先する）
			isPairingRejected(pc({ connection: 'online', pcOnline: true, pairingRejected: true })),
			isPairingRejected(pc({ connection: 'offline', pcOnline: false, pairingRejected: false })),
		]).toStrictEqual([true, true, false, false]);
		expect(PAIRING_REJECTED_LABEL).toBe('再ペアリングが必要');
	});
});

describe('shouldShowBattery', () => {
	test('繋がっていないPCの残量は出さない（最後に見えた古い値のため）', () => {
		expect([
			shouldShowBattery(pc()),
			shouldShowBattery(pc({ pcOnline: false })),
			shouldShowBattery(pc({ connection: 'offline', pcOnline: false })),
			shouldShowBattery(pc({ battery: undefined })),
		]).toStrictEqual([true, false, false, false]);
	});
});
