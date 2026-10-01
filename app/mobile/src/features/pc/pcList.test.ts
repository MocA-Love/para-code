// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import { describe, expect, test } from 'vitest';
import { DEFAULT_HOME_PREFERENCES } from '../../homeSort.js';
import {
	EMPTY_PC_LIST_FILTER,
	archivedTerminals,
	buildPcList,
	filterCount,
	resolveTerminalSpace,
	toggleValue,
	withSort,
	type BuildPcListInput,
	type PcListTerminal,
} from './pcList.js';

const spaces = [
	{ id: 'w1', name: 'alpha', branch: 'main' },
	{ id: 'w2', name: 'beta', branch: 'feat/login' },
	{ id: 'w3', name: 'gamma' },
];

function term(terminalKey: string, ws: string | undefined, agentStatus: string | undefined, title = terminalKey, id = 1, agent = true): PcListTerminal & { ws?: string } {
	return { terminalKey, id, windowId: 1, title, agent, agentStatus, ...(ws !== undefined ? { ws } : {}) };
}

function input(overrides: Partial<BuildPcListInput<PcListTerminal>> = {}): BuildPcListInput<PcListTerminal> {
	return {
		terminals: [],
		spaces,
		activeWs: 'w1',
		archivedKeys: new Set(),
		pinnedKeys: new Set(),
		preferences: DEFAULT_HOME_PREFERENCES,
		group: 'none',
		filter: EMPTY_PC_LIST_FILTER,
		...overrides,
	};
}

const keys = (rows: readonly { terminal: PcListTerminal }[]) => rows.map(row => row.terminal.terminalKey);

describe('並び（既定はエージェントの状態）', () => {
	test('要対応 → 実行中 → 未確認 → 待機 の順に並ぶ', () => {
		const sections = buildPcList(input({
			terminals: [term('idle', 'w1', undefined), term('review', 'w1', 'review'), term('question', 'w1', 'question'), term('working', 'w1', 'working'), term('permission', 'w2', 'permission')],
		}));
		expect(sections).toHaveLength(1);
		expect(sections[0]?.title).toBeUndefined();
		expect(keys(sections[0]?.rows ?? [])).toEqual(['question', 'permission', 'working', 'review', 'idle']);
	});

	test('名前順に変えると、第2キーは状態順へ寄せられて名前で並ぶ', () => {
		const preferences = withSort(DEFAULT_HOME_PREFERENCES, 'name');
		expect(preferences.sort).toBe('name');
		expect(preferences.secondary).toBe('space');
		const sections = buildPcList(input({ preferences, terminals: [term('b', 'w1', 'working', 'いろは'), term('a', 'w1', undefined, 'あいう')] }));
		expect(keys(sections[0]?.rows ?? [])).toEqual(['a', 'b']);
	});

	test('スペースを第1キーにすると第2キーが同じ値にならない', () => {
		expect(withSort({ ...DEFAULT_HOME_PREFERENCES, secondary: 'space' }, 'space').secondary).toBe('status');
	});
});

describe('グループ化', () => {
	test('状態で分けると、行のある段だけが要対応 → 実行中 → 未確認 → 待機 の順で出る', () => {
		const sections = buildPcList(input({ group: 'state', terminals: [term('i', 'w1', undefined), term('p', 'w1', 'permission'), term('w', 'w2', 'working')] }));
		expect(sections.map(section => section.title)).toEqual(['要対応', '実行中', '待機']);
		expect(sections.map(section => section.bucket)).toEqual(['waiting', 'working', 'idle']);
	});

	test('スペースで分けると PC から届いた順で、ターミナルの無いスペースも空の段として残る', () => {
		const sections = buildPcList(input({ group: 'space', terminals: [term('b1', 'w2', 'working'), term('a1', 'w1', undefined), term('a2', 'w1', 'question')] }));
		expect(sections.map(section => section.key)).toEqual(['space:w1', 'space:w2', 'space:w3']);
		expect(keys(sections[0]?.rows ?? [])).toEqual(['a2', 'a1']);
		expect(sections[2]?.emptySpace).toBe(true);
		expect(sections[2]?.rows).toEqual([]);
	});

	test('絞り込み中は空のスペースの段を出さない', () => {
		const sections = buildPcList(input({ group: 'space', filter: { ...EMPTY_PC_LIST_FILTER, states: ['working'] }, terminals: [term('b1', 'w2', 'working'), term('a1', 'w1', undefined)] }));
		expect(sections.map(section => section.key)).toEqual(['space:w2']);
	});

	test('ws の無いターミナルは PC 側のアクティブなスペースに属する', () => {
		const sections = buildPcList(input({ group: 'space', activeWs: 'w2', terminals: [term('x', undefined, 'working')] }));
		expect(sections.find(section => section.key === 'space:w2')?.rows.map(row => row.terminal.terminalKey)).toEqual(['x']);
		expect(resolveTerminalSpace({}, spaces, undefined)?.id).toBe('w1');
	});

	test('ピン留めは先頭の段に集まり、他の段には出ない', () => {
		const sections = buildPcList(input({
			group: 'space',
			pinnedKeys: new Set(['a1']),
			terminals: [term('a1', 'w1', undefined), term('a2', 'w1', 'working')],
		}));
		expect(sections[0]?.kind).toBe('pinned');
		expect(keys(sections[0]?.rows ?? [])).toEqual(['a1']);
		expect(sections[0]?.rows[0]?.pinned).toBe(true);
		expect(keys(sections[1]?.rows ?? [])).toEqual(['a2']);
		// ピン留めの行が残っているので、そのスペースは空の段扱いにしない
		expect(sections[1]?.emptySpace).toBeUndefined();
	});

	test('グループなしでピン留めがあると、残りの段に見出しが付く', () => {
		const sections = buildPcList(input({ pinnedKeys: new Set(['a']), terminals: [term('a', 'w1', undefined), term('b', 'w1', undefined)] }));
		expect(sections.map(section => section.title)).toEqual(['ピン留め', 'エージェント']);
	});
});

describe('絞り込み・検索・アーカイブ', () => {
	test('状態とスペースの両方で絞れる', () => {
		const sections = buildPcList(input({
			filter: { kind: 'all', states: ['working', 'waiting'], spaces: ['w2'], query: '' },
			terminals: [term('a', 'w1', 'working'), term('b', 'w2', 'working'), term('c', 'w2', undefined), term('d', 'w2', 'permission')],
		}));
		expect(keys(sections[0]?.rows ?? [])).toEqual(['d', 'b']);
	});

	test('検索は名前・スペース名・ブランチの部分一致（大文字小文字を区別しない）', () => {
		const terminals = [term('a', 'w1', undefined, 'Claude 調査'), term('b', 'w2', undefined, 'shell')];
		expect(keys(buildPcList(input({ terminals, filter: { ...EMPTY_PC_LIST_FILTER, query: 'claude' } }))[0]?.rows ?? [])).toEqual(['a']);
		expect(keys(buildPcList(input({ terminals, filter: { ...EMPTY_PC_LIST_FILTER, query: 'LOGIN' } }))[0]?.rows ?? [])).toEqual(['b']);
		expect(buildPcList(input({ terminals, filter: { ...EMPTY_PC_LIST_FILTER, query: 'none' } }))).toEqual([]);
	});

	test('種類で、エージェントだけ・ふつうのターミナルだけに絞れる', () => {
		const terminals = [term('a', 'w1', 'working'), term('b', 'w1', undefined, 'zsh', 2, false), term('c', 'w2', undefined)];
		const rows = (kind: 'all' | 'agent' | 'terminal') => keys(buildPcList(input({ terminals, filter: { ...EMPTY_PC_LIST_FILTER, kind } }))[0]?.rows ?? []);
		expect({ all: rows('all'), agent: rows('agent'), terminal: rows('terminal') }).toEqual({ all: ['a', 'b', 'c'], agent: ['a', 'c'], terminal: ['b'] });
	});

	test('状態はエージェントにだけ効く（待機を選んでもふつうのターミナルは混ざらない・ターミナルだけのときは状態を見ない）', () => {
		const terminals = [term('a', 'w1', undefined), term('b', 'w1', undefined, 'zsh', 2, false), term('c', 'w1', 'working')];
		const rows = (kind: 'all' | 'terminal') => keys(buildPcList(input({ terminals, filter: { ...EMPTY_PC_LIST_FILTER, kind, states: ['idle'] } }))[0]?.rows ?? []);
		expect({ all: rows('all'), terminal: rows('terminal') }).toEqual({ all: ['a'], terminal: ['b'] });
	});

	test('PC から agent の無い形で届くターミナルもターミナルとして扱い、状態のグループでは最後の「ターミナル」の段に入る', () => {
		const plain: PcListTerminal & { ws?: string } = { terminalKey: 'p', id: 3, windowId: 1, title: 'zsh', ws: 'w1' };
		const terminals = [term('a', 'w1', undefined), plain, term('c', 'w1', 'working')];
		const kindRows = keys(buildPcList(input({ terminals, filter: { ...EMPTY_PC_LIST_FILTER, kind: 'terminal' } }))[0]?.rows ?? []);
		const grouped = buildPcList(input({ terminals, group: 'state' })).map(section => [section.title, keys(section.rows)]);
		expect({ kindRows, grouped }).toEqual({ kindRows: ['p'], grouped: [['実行中', ['c']], ['待機', ['a']], ['ターミナル', ['p']]] });
	});

	test('ターミナルだけのときは、残っている状態の選択を件数に数えない', () => {
		expect([
			filterCount({ kind: 'all', states: ['idle'], spaces: ['w1'] }),
			filterCount({ kind: 'terminal', states: ['idle'], spaces: ['w1'] }),
		]).toEqual([2, 1]);
	});

	test('種類を絞っている間は、ターミナルの無いスペースの空の段を出さない', () => {
		const sections = buildPcList(input({ group: 'space', terminals: [term('a', 'w1', undefined)], filter: { ...EMPTY_PC_LIST_FILTER, kind: 'agent' } }));
		expect(sections.map(section => section.key)).toEqual(['space:w1']);
	});

	test('アーカイブしたものは一覧に出ず、アーカイブの一覧にだけ出る', () => {
		const terminals = [term('a', 'w1', undefined), term('b', 'w1', 'working')];
		const archivedKeys = new Set(['a']);
		expect(keys(buildPcList(input({ terminals, archivedKeys }))[0]?.rows ?? [])).toEqual(['b']);
		expect(archivedTerminals(terminals, archivedKeys).map(t => t.terminalKey)).toEqual(['a']);
	});

	test('絞り込みの数と選択の出し入れ', () => {
		expect(filterCount({ kind: 'all', states: ['working'], spaces: ['w1', 'w2'] })).toBe(3);
		expect(toggleValue(['a', 'b'], 'a')).toEqual(['b']);
		expect(toggleValue(['a'], 'b')).toEqual(['a', 'b']);
	});
});
