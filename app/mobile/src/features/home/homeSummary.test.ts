// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import { describe, expect, test, vi } from 'vitest';

// time.ts はフック（useNow）のために react-native を読む。使うのは純粋な formatRelativeTime だけなので差し替える。
vi.mock('../../hooks/useAppIsActive.js', () => ({ useAppIsActive: () => true }));
import { batteryLine, formatCost, pcCardCounts, pcConnectionLine, statScopeNote, totalAttention, totalRunning } from './homeSummary.js';
import { lastSessionSubtitle, parseLastSession } from './lastSession.js';

const pc = (id: string, waiting: number, online = true, running = 0) => ({ id, connection: online ? 'online' : 'offline', pcOnline: online, workspaces: 3, waiting, running });

describe('統計カード', () => {
	test('要対応はつながっている PC だけを足す', () => {
		expect(totalAttention([pc('a', 2), pc('b', 1), pc('c', 5, false)])).toBe(3);
		expect(totalAttention([{ ...pc('a', 2), pcOnline: false }])).toBe(0);
	});

	test('実行中も全 PC の合計で、つながっている PC だけを足す（見ていない PC も含む）', () => {
		expect(totalRunning([pc('a', 0, true, 2), pc('b', 1, true, 3), pc('c', 0, false, 4)])).toBe(5);
		expect(totalRunning([{ ...pc('a', 0, true, 2), pcOnline: false }])).toBe(0);
	});

	test('カードの下の1行は、つながっている台数（2台以上）と未接続の台数を言う', () => {
		expect([
			statScopeNote([pc('a', 0)]),
			statScopeNote([pc('a', 0), pc('b', 0)]),
			statScopeNote([pc('a', 0), pc('b', 0), pc('c', 0, false)]),
			statScopeNote([pc('a', 0), pc('c', 0, false)]),
			statScopeNote([pc('c', 0, false), pc('d', 0, false)]),
			statScopeNote([]),
		]).toEqual([undefined, '2 台の合計', '2 台の合計 · 1 台は未接続', '1 台は未接続', '2 台は未接続', undefined]);
	});

	test('コストは小数2桁、取れていなければダッシュ', () => {
		expect(formatCost(1.5)).toBe('$1.50');
		expect(formatCost(undefined)).toBe('—');
		expect(formatCost(Number.NaN)).toBe('—');
	});
});

describe('PC のカード', () => {
	test('いま見ている PC は状態ごとに数え、0 の状態は出さない', () => {
		const counts = pcCardCounts(pc('a', 1), [
			{ terminalKey: '1', agent: true, agentStatus: 'permission' },
			{ terminalKey: '2', agent: true, agentStatus: 'working' },
			{ terminalKey: '3', agent: true },
			{ terminalKey: '4', agent: true },
			{ terminalKey: '5', agent: false },
			{ terminalKey: '6', agent: true, agentStatus: 'working' },
		], new Set(['6']));
		expect(counts).toEqual({
			spaces: 3,
			agents: 4,
			buckets: [{ bucket: 'waiting', count: 1 }, { bucket: 'working', count: 1 }, { bucket: 'idle', count: 2 }],
		});
	});

	test('見ていない PC は台帳の要約だけ（要対応と実行中。エージェント数は出さない）', () => {
		expect(pcCardCounts(pc('b', 2, true, 3), undefined, new Set())).toEqual({ spaces: 3, agents: undefined, buckets: [{ bucket: 'waiting', count: 2 }, { bucket: 'working', count: 3 }] });
		expect(pcCardCounts(pc('b', 0), undefined, new Set()).buckets).toEqual([]);
	});

	test('接続の一文は、切れているときだけ最後につながっていた時刻を添える', () => {
		const now = Date.UTC(2026, 0, 10, 12);
		expect(pcConnectionLine('connected', now - 10_000, now)).toBe('接続中 · リレー経由');
		expect(pcConnectionLine('connecting', now - 10_000, now)).toBe('接続しています…');
		expect(pcConnectionLine('offline', now - 2 * 60 * 60_000, now)).toBe('オフライン · 2時間前まで接続');
		expect(pcConnectionLine('pcOffline', undefined, now)).toBe('PCオフライン');
		// 資格を拒まれた PC は接続の語と最終接続時刻を出さず、再ペアリングが必要と出す（設定の PC 一覧と同じ文言）
		expect([
			pcConnectionLine('offline', now - 60_000, now, true),
			pcConnectionLine('connecting', undefined, now, true),
			pcConnectionLine('connected', now, now, true),
		]).toEqual(['再ペアリングが必要', '再ペアリングが必要', '接続中 · リレー経由']);
		expect(batteryLine({ level: 81.6, charging: true })).toBe('バッテリー 82%（充電中）');
	});
});

describe('再開カードの記録', () => {
	test('形の正しい値だけを読み戻す', () => {
		const value = { pcId: 'p', spaceId: 's', terminalKey: 't', title: '調査', spaceName: 'alpha', branch: 'main', color: '#abcdef', at: 5 };
		expect(parseLastSession(value)).toEqual(value);
		expect(parseLastSession({ ...value, terminalKey: '', branch: 3 })).toEqual({ pcId: 'p', spaceId: 's', title: '調査', spaceName: 'alpha', color: '#abcdef', at: 5 });
		expect(parseLastSession({ ...value, at: 'x' })).toBeUndefined();
		expect(parseLastSession({ ...value, pcId: undefined })).toBeUndefined();
		expect(parseLastSession(null)).toBeUndefined();
		expect(parseLastSession([value])).toBeUndefined();
	});

	test('下の一文はスペース名とブランチ', () => {
		expect(lastSessionSubtitle({ pcId: 'p', spaceId: 's', title: 't', spaceName: 'alpha', branch: 'main', at: 1 })).toBe('alpha  ·  main');
		expect(lastSessionSubtitle({ pcId: 'p', spaceId: 's', title: 't', spaceName: 'alpha', at: 1 })).toBe('alpha');
	});
});
