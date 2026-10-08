// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import { describe, expect, test, vi } from 'vitest';

// time.ts はフック（useNow）のために react-native を読む。使うのは純粋な formatRelativeTime だけなので差し替える。
vi.mock('../../hooks/useAppIsActive.js', () => ({ useAppIsActive: () => true }));
import { buildAgentsAcrossPcs, parseAgentsAcrossState, unconnectedNote, type AgentsAcrossPc, type AgentsAcrossSource } from './agentsAcrossPcs.js';
import { totalAttention, totalRunning } from './homeSummary.js';
import type { LastKnownPcSnapshot } from '../../lastKnownPcs.js';

interface Terminal {
	readonly terminalKey: string;
	readonly id: number;
	readonly windowId: number;
	readonly title: string;
	readonly ws?: string;
	readonly agent?: boolean;
	readonly agentStatus?: string;
}

const term = (terminalKey: string, agentStatus: string | undefined, ws: string, agent = true): Terminal => ({
	terminalKey, id: 1, windowId: 1, title: terminalKey, ws, agent, ...(agentStatus !== undefined ? { agentStatus } : {}),
});

const NOW = Date.UTC(2026, 9, 9, 12);

const lastKnown = (pcId: string, waiting: number, working: number): LastKnownPcSnapshot => ({
	pcId, savedAt: NOW - 2 * 60 * 60 * 1000,
	spaces: [{ name: 'repo', terminals: waiting + working, waiting, working, review: 0, idle: 0 }],
});

const pc = (id: string, online: boolean, waiting: number, running: number, snapshot?: LastKnownPcSnapshot): AgentsAcrossPc => ({
	id, name: `PC ${id}`, connection: online ? 'online' : 'offline', pcOnline: online, workspaces: 1, waiting, running,
	...(snapshot !== undefined ? { lastKnown: snapshot } : {}),
});

const spaces = [{ id: 'w1', name: 'api' }, { id: 'w2', name: 'docs', branch: 'main' }];

const sources: Record<string, AgentsAcrossSource<Terminal>> = {
	a: {
		// スペースの並び（w1 → w2）で並べ直されることを見るため、w2 を先に置く。
		terminals: [term('a1', 'working', 'w2'), term('a2', 'permission', 'w1'), term('a3', 'working', 'w1'), term('a4', 'working', 'w1'), term('a5', 'working', 'w1', false)],
		spaces, activeWs: 'w1', archived: ['a4'],
	},
	b: {
		terminals: [term('b1', 'question', 'w1'), term('b2', 'review', 'w1')],
		spaces, activeWs: 'w1', archived: [],
	},
	// つながっていない PC に残っている State は使わない。
	c: { terminals: [term('c1', 'working', 'w1')], spaces, activeWs: 'w1', archived: [] },
};

const pcs = [pc('a', true, 1, 2), pc('b', true, 1, 0), pc('c', false, 0, 1, lastKnown('c', 0, 1)), pc('d', false, 0, 0)];

function shape(state: 'waiting' | 'running', activePcId: string | undefined) {
	const list = buildAgentsAcrossPcs({ pcs, sources, activePcId, state });
	return {
		counts: list.counts,
		sections: list.sections.map(section => (section.kind === 'live'
			? { pc: section.pcId, active: section.active, rows: section.rows.map(row => `${row.terminal.terminalKey}@${row.space?.name}`) }
			: { pc: section.pcId, unconnected: section.lastKnown?.count ?? null })),
	};
}

describe('全 PC 横断の一覧', () => {
	test('実行中: アーカイブとプレーンなターミナルを除き、スペースの並びで出す。見ている PC が先頭、行の無い PC の段は出さない', () => {
		expect(shape('running', 'b')).toEqual({
			counts: { waiting: 2, running: 2 },
			sections: [
				{ pc: 'a', active: false, rows: ['a3@api', 'a1@docs'] },
				{ pc: 'c', unconnected: 1 },
				{ pc: 'd', unconnected: null },
			],
		});
	});

	test('要対応: 見ている PC を先頭に台帳の順。つながっていない PC は末尾に前回の件数だけ', () => {
		expect(shape('waiting', 'b')).toEqual({
			counts: { waiting: 2, running: 2 },
			sections: [
				{ pc: 'b', active: true, rows: ['b1@api'] },
				{ pc: 'a', active: false, rows: ['a2@api'] },
				{ pc: 'c', unconnected: 0 },
				{ pc: 'd', unconnected: null },
			],
		});
	});

	test('切り替えの件数はホームのカードの合計と同じ（つながっている PC だけ）', () => {
		const list = buildAgentsAcrossPcs({ pcs, sources, activePcId: 'a', state: 'waiting' });
		expect(list.counts).toEqual({ waiting: totalAttention(pcs), running: totalRunning(pcs) });
	});

	test('State をまだ受けていない PC は行を出さない', () => {
		const list = buildAgentsAcrossPcs({ pcs: [pc('x', true, 0, 0)], sources: {}, activePcId: 'x', state: 'running' });
		expect(list).toEqual({ sections: [], counts: { waiting: 0, running: 0 } });
	});

	test('未接続の段の1文と、クエリの読み戻し', () => {
		const list = buildAgentsAcrossPcs({ pcs, sources, activePcId: 'a', state: 'running' });
		const notes = list.sections.flatMap(section => (section.kind === 'unconnected' ? [unconnectedNote(section, 'running', NOW)] : []));
		expect({
			notes,
			states: [parseAgentsAcrossState('running'), parseAgentsAcrossState('waiting'), parseAgentsAcrossState('other'), parseAgentsAcrossState(undefined)],
		}).toEqual({
			notes: ['最終確認 2時間前の時点で実行中 1', 'まだ一覧を受け取っていません。つながると数えます'],
			states: ['running', 'waiting', 'waiting', 'waiting'],
		});
	});
});
