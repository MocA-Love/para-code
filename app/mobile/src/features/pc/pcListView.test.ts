// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import { describe, expect, test } from 'vitest';
import {
	DEFAULT_PC_LIST_VIEW,
	EMPTY_PC_LIST_VIEW_OF_PC,
	MAX_PC_LIST_VIEW_KEYS,
	effectivePcListFilter,
	parsePcListView,
	pcListViewOf,
	toggleCollapsedKey,
	withPcListView,
	withoutPc,
} from './pcListView.js';

describe('PC の画面の表示条件の保存値', () => {
	test('壊れた値・知らない値は捨てて既定に寄せる', () => {
		expect(parsePcListView(undefined)).toEqual(DEFAULT_PC_LIST_VIEW);
		expect(parsePcListView('x')).toEqual(DEFAULT_PC_LIST_VIEW);
		expect(parsePcListView({
			group: 'weird',
			byPc: {
				pc1: { states: ['waiting', 'nope', 'waiting', 3], spaces: ['w1', '', 'w1'], collapsed: ['space:w2'] },
				pc2: { states: [], spaces: [], collapsed: [] },
				pc3: 'broken',
			},
		})).toEqual({
			group: 'space',
			byPc: { pc1: { states: ['waiting'], spaces: ['w1'], collapsed: ['space:w2'] } },
		});
		expect(parsePcListView({ group: 'state', byPc: [] })).toEqual({ group: 'state', byPc: {} });
	});

	test('保存して読み直すと同じ値に戻る', () => {
		const saved = withPcListView({ ...DEFAULT_PC_LIST_VIEW, group: 'none' }, 'pc1', view => ({ ...view, states: ['working'], spaces: ['w1'], collapsed: ['pinned'] }));
		expect(parsePcListView(JSON.parse(JSON.stringify(saved)))).toEqual(saved);
	});

	test('PC ごとに別に持ち、空になった PC は消す', () => {
		let saved = withPcListView(DEFAULT_PC_LIST_VIEW, 'pc1', view => ({ ...view, states: ['waiting'] }));
		saved = withPcListView(saved, 'pc2', view => ({ ...view, collapsed: ['space:w1'] }));
		expect(pcListViewOf(saved, 'pc1')).toEqual({ states: ['waiting'], spaces: [], collapsed: [] });
		expect(pcListViewOf(saved, 'pc2')).toEqual({ states: [], spaces: [], collapsed: ['space:w1'] });
		expect(pcListViewOf(saved, 'pc3')).toBe(EMPTY_PC_LIST_VIEW_OF_PC);
		expect(pcListViewOf(saved, undefined)).toBe(EMPTY_PC_LIST_VIEW_OF_PC);
		saved = withPcListView(saved, 'pc1', view => ({ ...view, states: [] }));
		expect(Object.keys(saved.byPc)).toEqual(['pc2']);
		expect(Object.keys(withoutPc(saved, 'pc2').byPc)).toEqual([]);
		expect(withoutPc(saved, 'missing')).toBe(saved);
	});

	test('鍵は上限を超えたら古いものから落とす', () => {
		const many = Array.from({ length: MAX_PC_LIST_VIEW_KEYS + 3 }, (_, index) => `space:w${index}`);
		const saved = withPcListView(DEFAULT_PC_LIST_VIEW, 'pc1', view => ({ ...view, collapsed: many }));
		expect(pcListViewOf(saved, 'pc1').collapsed).toEqual(many.slice(3));
	});

	test('段を畳む／開く', () => {
		expect(toggleCollapsedKey([], 'pinned')).toEqual(['pinned']);
		expect(toggleCollapsedKey(['pinned', 'space:w1'], 'pinned')).toEqual(['space:w1']);
	});

	test('閉じられたスペースの条件は画面では外し、スペースが届く前は外さない', () => {
		const view = { states: ['review' as const], spaces: ['w1', 'gone'], collapsed: [] };
		expect(effectivePcListFilter(view, 'abc', ['w1', 'w2'])).toEqual({ states: ['review'], spaces: ['w1'], query: 'abc' });
		expect(effectivePcListFilter(view, '', [])).toEqual({ states: ['review'], spaces: ['w1', 'gone'], query: '' });
	});
});
