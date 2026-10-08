// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import { describe, expect, test, vi } from 'vitest';

// time.ts はフック（useNow）のために react-native を読む。使うのは純粋な formatRelativeTime だけなので差し替える。
vi.mock('../../hooks/useAppIsActive.js', () => ({ useAppIsActive: () => true }));
import {
	buildAgentsAcrossPcs, createAgentsAcrossBuilder, idleHeaderLabel, parseAgentsAcrossState, unconnectedNote,
	type AgentsAcrossPc, type AgentsAcrossSource,
} from './agentsAcrossPcs.js';
import { totalAttention, totalRunning } from './homeSummary.js';
import type { LastKnownPcSnapshot } from '../../lastKnownPcs.js';
import { summarizeAgentCounts } from '../../pcAgentSources.js';
import type { UpdateTarget } from '../../pcCompat.js';

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

interface PcOptions {
	readonly connection?: string;
	readonly pcOnline?: boolean;
	readonly snapshot?: LastKnownPcSnapshot;
	readonly updateRequired?: UpdateTarget;
}

/** PC の要約。件数は `PcSummary` と同じ関数（summarizeRuntime の件数の部分）で行の元から数える。 */
function pc(id: string, options: PcOptions = {}): AgentsAcrossPc {
	const source = sources[id];
	const counts = summarizeAgentCounts(source?.terminals, source?.archived ?? []);
	return {
		id, name: `PC ${id}`, connection: options.connection ?? 'online', pcOnline: options.pcOnline ?? true, workspaces: 1,
		waiting: counts.waiting, running: counts.running,
		...(options.snapshot !== undefined ? { lastKnown: options.snapshot } : {}),
		...(options.updateRequired !== undefined ? { updateRequired: options.updateRequired } : {}),
	};
}

const pcs = [
	pc('a'),
	pc('b'),
	pc('c', { connection: 'offline', pcOnline: false, snapshot: lastKnown('c', 0, 1) }),
	pc('d', { connection: 'connecting', pcOnline: false }),
	pc('e', { updateRequired: 'pc' }),
	// つながっているが State をまだ受けていない（行の元が無い）。
	pc('f'),
];

function shape(state: 'waiting' | 'running', activePcId: string | undefined) {
	const list = buildAgentsAcrossPcs({ pcs, sources, activePcId, state });
	return {
		counts: list.counts,
		sections: list.sections.map(section => (section.kind === 'live'
			? { pc: section.pcId, active: section.active, rows: section.rows.map(row => `${row.terminal.terminalKey}@${row.space?.name}`) }
			: { pc: section.pcId, idle: idleHeaderLabel(section), last: section.lastKnown?.count ?? null })),
	};
}

describe('全 PC 横断の一覧', () => {
	test('実行中: アーカイブとプレーンなターミナルを除き、スペースの並びで出す。見ている PC が先頭、行の無い PC の段は出さない', () => {
		expect(shape('running', 'b')).toEqual({
			counts: { waiting: 2, running: 2 },
			sections: [
				{ pc: 'a', active: false, rows: ['a3@api', 'a1@docs'] },
				{ pc: 'c', idle: '未接続', last: 1 },
				{ pc: 'd', idle: '接続しています…', last: null },
				{ pc: 'e', idle: 'PC の更新が必要', last: null },
				{ pc: 'f', idle: '受け取っています', last: null },
			],
		});
	});

	test('要対応: 見ている PC を先頭に台帳の順。行を出せない PC は末尾に理由と前回の件数だけ', () => {
		expect(shape('waiting', 'b')).toEqual({
			counts: { waiting: 2, running: 2 },
			sections: [
				{ pc: 'b', active: true, rows: ['b1@api'] },
				{ pc: 'a', active: false, rows: ['a2@api'] },
				{ pc: 'c', idle: '未接続', last: 0 },
				{ pc: 'd', idle: '接続しています…', last: null },
				{ pc: 'e', idle: 'PC の更新が必要', last: null },
				{ pc: 'f', idle: '受け取っています', last: null },
			],
		});
	});

	test('切り替えの件数は、PcSummary と同じ数え方で作ったホームのカードの合計と同じ（つながっている PC だけ）', () => {
		const list = buildAgentsAcrossPcs({ pcs, sources, activePcId: 'a', state: 'waiting' });
		// c（未接続）は State が残っていて数えれば実行中 1 だが、合計にも一覧にも入らない。
		expect({ list: list.counts, cards: { waiting: totalAttention(pcs), running: totalRunning(pcs) }, offlineRunning: pcs[2]?.running })
			.toEqual({ list: { waiting: 2, running: 2 }, cards: { waiting: 2, running: 2 }, offlineRunning: 1 });
	});

	test('組み立て器は、行の元の参照が同じ PC には前回の段を返し、変わった PC だけ作り直す', () => {
		const build = createAgentsAcrossBuilder<Terminal>();
		const first = build({ pcs, sources, activePcId: 'a', state: 'waiting' });
		const changed = { ...sources, b: { spaces, activeWs: 'w1', archived: [], terminals: [term('b1', 'question', 'w1'), term('b3', 'permission', 'w2')] } };
		const second = build({ pcs, sources: changed, activePcId: 'a', state: 'waiting' });
		const live = (list: typeof first, id: string) => list.sections.find(section => section.kind === 'live' && section.pcId === id);
		expect({
			sameA: live(first, 'a') === live(second, 'a'),
			sameB: live(first, 'b') === live(second, 'b'),
			rowsB: second.counts.waiting,
		}).toEqual({ sameA: true, sameB: false, rowsB: 3 });
	});

	test('段の1文と、クエリの読み戻し', () => {
		const list = buildAgentsAcrossPcs({ pcs, sources, activePcId: 'a', state: 'running' });
		const notes = list.sections.flatMap(section => (section.kind === 'unconnected' ? [unconnectedNote(section, 'running', NOW)] : []));
		expect({
			notes,
			states: [parseAgentsAcrossState('running'), parseAgentsAcrossState('waiting'), parseAgentsAcrossState('other'), parseAgentsAcrossState(undefined)],
		}).toEqual({
			notes: [
				'最終確認 2時間前の時点で実行中 1',
				'まだ一覧を受け取っていません。つながると数えます',
				'版が合わないため数えていません。更新すると数えます',
				'PC から一覧を受け取っています',
			],
			states: ['running', 'waiting', 'waiting', 'waiting'],
		});
	});
});
