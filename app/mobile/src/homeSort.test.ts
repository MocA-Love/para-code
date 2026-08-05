// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import { describe, expect, test } from 'vitest';
import {
	DEFAULT_HOME_PREFERENCES, arrangeHomeRows, bucketCounts, parseHomePreferences, reconcileSecondary,
	secondaryCandidates, statusBucket, statusOrder, toggleFilter, type HomeListPreferences, type SortableTerminal,
} from './homeSort.js';

/** ドロワーのワークスペース一覧の並び（w1 → w2 → w3）。 */
const SPACE_INDEX = new Map([['w1', 0], ['w2', 1], ['w3', 2]]);

/**
 * 画面側と同じスペース解決。ws未タグはPC側アクティブスペース（ここではw1）所属として扱う
 * ——この規則を通さないと、行に出ているスペース名と並び順がずれる。
 */
const spaceIndexOf = (row: SortableTerminal) => SPACE_INDEX.get(row.ws ?? 'w1');

const term = (patch: Partial<SortableTerminal> & { terminalKey: string; id: number }): SortableTerminal =>
	({ windowId: 1, title: patch.terminalKey, ...patch });

const rows: SortableTerminal[] = [
	term({ terminalKey: 'k1', id: 1, title: 'cleanup', ws: 'w1', agentStatus: undefined }),
	term({ terminalKey: 'k2', id: 2, title: 'reviewer', ws: 'w3', agentStatus: 'review' }),
	term({ terminalKey: 'k3', id: 3, title: 'Explore', ws: 'w2', agentStatus: 'working' }),
	term({ terminalKey: 'k4', id: 4, title: 'builder', ws: 'w1', agentStatus: 'working' }),
	term({ terminalKey: 'k5', id: 5, title: 'ask', ws: 'w2', agentStatus: 'question' }),
];
const noPins = { spaceIndexOf, isPinned: () => false };
const titlesOf = (list: SortableTerminal[]) => list.map(row => row.title);
const prefs = (patch: Partial<HomeListPreferences>): HomeListPreferences => ({ ...DEFAULT_HOME_PREFERENCES, ...patch });

describe('statusBucket / statusOrder', () => {
	test('質問と応答待ちは同じ「応答待ち」に畳む', () => {
		expect([statusBucket('question'), statusBucket('permission')]).toEqual(['waiting', 'waiting']);
	});

	test('未知のステータスはレビュー扱い（agentRow.tsx のラベルと揃える）', () => {
		expect(statusBucket('review')).toBe('review');
		expect(statusBucket('something-new')).toBe('review');
	});

	test('並びの重みは 応答待ち → 実行中 → レビュー → アイドル', () => {
		expect(['question', 'working', 'review', undefined].map(statusOrder)).toEqual([0, 1, 2, 3]);
	});
});

describe('arrangeHomeRows', () => {
	test('既定（ステータス順・第2キーはスペース順）', () => {
		// 応答待ち(ask) → 実行中はスペース順(builder=w1, Explore=w2) → レビュー → アイドル
		expect(titlesOf(arrangeHomeRows(rows, DEFAULT_HOME_PREFERENCES, noPins)))
			.toEqual(['ask', 'builder', 'Explore', 'reviewer', 'cleanup']);
	});

	test('スペース順にすると、同じスペースの中はステータス順にできる', () => {
		const result = arrangeHomeRows(rows, prefs({ sort: 'space', secondary: 'status' }), noPins);
		// w1: builder(実行中) → cleanup(アイドル) / w2: ask(応答待ち) → Explore(実行中) / w3: reviewer
		expect(titlesOf(result)).toEqual(['builder', 'cleanup', 'ask', 'Explore', 'reviewer']);
	});

	test('ws未タグの行は、画面と同じ解決を通してアクティブスペースの位置に並ぶ', () => {
		// PCのスペース切替中は ws が一時的に落ちる。ここで末尾へ飛ぶと、行には「w1」と
		// 出ているのに一覧の最下段へ移動して見え、押そうとした行が動く事故になる。
		const pending = term({ terminalKey: 'k0', id: 0, title: 'pending', ws: undefined, agentStatus: 'working' });
		const result = arrangeHomeRows([...rows, pending], prefs({ sort: 'space', secondary: 'added' }), noPins);
		// w1 のかたまり（builder, cleanup, pending）の中に入る＝末尾ではない
		expect(titlesOf(result).at(-1)).not.toBe('pending');
		expect(titlesOf(result).slice(0, 3)).toContain('pending');
	});

	test('名前順は日本語混じりでも辞書順になる', () => {
		const mixed = [
			term({ terminalKey: 'a', id: 1, title: '検証', ws: 'w1' }),
			term({ terminalKey: 'b', id: 2, title: 'alpha', ws: 'w1' }),
			term({ terminalKey: 'c', id: 3, title: 'あいさつ', ws: 'w1' }),
		];
		expect(titlesOf(arrangeHomeRows(mixed, prefs({ sort: 'name', secondary: 'added' }), noPins)))
			.toEqual(['alpha', 'あいさつ', '検証']);
	});

	test('title が欠けていても名前順で落ちない（ワイヤ側で型検証されていない）', () => {
		const missing = [
			term({ terminalKey: 'a', id: 1, title: undefined, ws: 'w1' }),
			term({ terminalKey: 'b', id: 2, title: 'alpha', ws: 'w1' }),
		];
		expect(() => arrangeHomeRows(missing, prefs({ sort: 'name', secondary: 'added' }), noPins)).not.toThrow();
	});

	test('ピン留めは並び順に関係なく先頭。切ると通常の並びに戻る', () => {
		const pinned = { spaceIndexOf, isPinned: (row: SortableTerminal) => row.terminalKey === 'k1' };
		expect(titlesOf(arrangeHomeRows(rows, DEFAULT_HOME_PREFERENCES, pinned))[0]).toBe('cleanup');
		expect(titlesOf(arrangeHomeRows(rows, prefs({ pinFirst: false }), pinned))[0]).toBe('ask');
	});

	test('絞り込みは指定したまとまりだけを残す', () => {
		expect(titlesOf(arrangeHomeRows(rows, prefs({ filters: ['working'] }), noPins))).toEqual(['builder', 'Explore']);
		expect(titlesOf(arrangeHomeRows(rows, prefs({ filters: ['working', 'idle'] }), noPins)))
			.toEqual(['builder', 'Explore', 'cleanup']);
		// 空 = 絞り込みなし
		expect(arrangeHomeRows(rows, prefs({ filters: [] }), noPins)).toHaveLength(rows.length);
	});

	test('どのスペースにも解決できない行だけ末尾へ回す', () => {
		const orphanIndex = (row: SortableTerminal) => SPACE_INDEX.get(row.ws ?? '');
		const orphan = term({ terminalKey: 'k9', id: 9, title: 'orphan', ws: 'unknown', agentStatus: 'working' });
		const result = arrangeHomeRows([orphan, ...rows], prefs({ sort: 'space', secondary: 'added' }), { spaceIndexOf: orphanIndex, isPinned: () => false });
		expect(titlesOf(result).at(-1)).toBe('orphan');
	});

	test('追加順はウィンドウごとの連番なので、まずウィンドウで揃える', () => {
		// PC側の id はレンダラーウィンドウごとの連番。別ウィンドウの1本目も id:1 になる。
		const twoWindows = [
			term({ terminalKey: 'w2-first', id: 1, windowId: 2, title: 'second window' }),
			term({ terminalKey: 'w1-second', id: 2, windowId: 1, title: 'first window B' }),
			term({ terminalKey: 'w1-first', id: 1, windowId: 1, title: 'first window A' }),
		];
		expect(titlesOf(arrangeHomeRows(twoWindows, prefs({ sort: 'added', secondary: 'name' }), noPins)))
			.toEqual(['first window A', 'first window B', 'second window']);
	});

	test('id が衝突しても terminalKey で決着するので順序が揺れない', () => {
		// 別ウィンドウの1本目どうしは id も windowId 順以外は同着になりうる。
		const same = [
			term({ terminalKey: 'bbb', id: 1, windowId: 1, title: 'same', ws: 'w1', agentStatus: 'working' }),
			term({ terminalKey: 'aaa', id: 1, windowId: 1, title: 'same', ws: 'w1', agentStatus: 'working' }),
		];
		expect(arrangeHomeRows(same, DEFAULT_HOME_PREFERENCES, noPins).map(r => r.terminalKey)).toEqual(['aaa', 'bbb']);
		// 入力の並びが変わっても（PCのstate再送で配列順は動く）結果は同じ
		expect(arrangeHomeRows([...same].reverse(), DEFAULT_HOME_PREFERENCES, noPins).map(r => r.terminalKey)).toEqual(['aaa', 'bbb']);
	});

	test('元の配列を書き換えない', () => {
		const input = [...rows];
		arrangeHomeRows(input, DEFAULT_HOME_PREFERENCES, noPins);
		expect(input).toEqual(rows);
	});
});

describe('第2キーの整合', () => {
	test('第1キーと同じものは候補に出さない', () => {
		expect(secondaryCandidates('status')).not.toContain('status');
		expect(secondaryCandidates('space')).toEqual(['status', 'name', 'added']);
	});

	test('衝突したときだけ意味のある組み合わせへ寄せる', () => {
		expect(reconcileSecondary('status', 'status')).toBe('space');
		expect(reconcileSecondary('space', 'space')).toBe('status');
		expect(reconcileSecondary('status', 'name')).toBe('name');
	});
});

describe('toggleFilter / bucketCounts', () => {
	test('入っていなければ足し、入っていれば外す', () => {
		expect(toggleFilter([], 'working')).toEqual(['working']);
		expect(toggleFilter(['working', 'idle'], 'working')).toEqual(['idle']);
	});

	test('件数はまとまりごとに数える', () => {
		expect(bucketCounts(rows)).toEqual({ waiting: 1, working: 2, review: 1, idle: 1 });
	});
});

describe('parseHomePreferences', () => {
	test('保存が無い・壊れていれば既定へ', () => {
		expect(parseHomePreferences(undefined)).toEqual(DEFAULT_HOME_PREFERENCES);
		expect(parseHomePreferences('nonsense')).toEqual(DEFAULT_HOME_PREFERENCES);
	});

	test('正しい値はそのまま読み戻す', () => {
		const saved = { sort: 'space', secondary: 'name', filters: ['working'], pinFirst: false };
		expect(parseHomePreferences(saved)).toEqual(saved);
	});

	test('壊れている項目だけ既定へ落とし、他は残す', () => {
		const result = parseHomePreferences({ sort: 'bogus', secondary: 'name', filters: ['working', 'bogus'], pinFirst: 'yes' });
		expect(result).toEqual({ sort: 'status', secondary: 'name', filters: ['working'], pinFirst: true });
	});

	test('保存された第1・第2キーが同じなら整合させる（旧データ対策）', () => {
		expect(parseHomePreferences({ sort: 'space', secondary: 'space' }).secondary).toBe('status');
	});

	test('応答待ちは絞り込みに使えない（一覧に降りてこないので選ぶと必ず空になる）', () => {
		expect(parseHomePreferences({ filters: ['waiting', 'working'] }).filters).toEqual(['working']);
	});
});
