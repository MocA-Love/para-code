// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import { describe, expect, test } from 'vitest';
import { pcStatusText, shouldShowBattery } from './pcStatus.js';
import type { PcSummary } from './appState.js';

function pc(overrides: Partial<PcSummary> = {}): PcSummary {
	return {
		id: 'pc1', name: 'Para Code', hue: 0,
		connection: 'online', pcOnline: true,
		workspaces: 3, terminals: 5, waiting: 0, lastOnlineAt: 1,
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
		]).toStrictEqual([
			'接続中 · 使用中',
			'待機中',
			'PCオフライン',
			'PCオフライン',
			'接続しています…',
			'オフライン',
		]);
	});

	test('見ていないPCで待っている件数は添えるが、使用中のPCには出さない', () => {
		expect([pcStatusText(pc({ waiting: 2 }), false), pcStatusText(pc({ waiting: 2 }), true)])
			.toStrictEqual(['待機中 · 応答待ち 2件', '接続中 · 使用中']);
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
