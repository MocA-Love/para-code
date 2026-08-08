// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import { describe, expect, test } from 'vitest';
import { matchRanges } from './filesSearch.js';

/**
 * ハイライトの分割規則。**PC側の検索と揃っていることを固定する。**
 *
 * `src/vs/paradis/contrib/mobileRelay/node/paradisMobileSearch.ts` は
 *  - ファイル名検索（`paradisSearchFiles`）… `query.toLowerCase()` を `path.toLowerCase()` に
 *    当てる＝**常に大小無視**
 *  - 全文検索（`paradisSearchText`）… ripgrep の `--smart-case`＝クエリに大文字があるときだけ区別
 * という非対称になっている。ここを取り違えると「結果には出るのに色が1文字も付かない」
 * （＝ハイライトが嘘になる）状態が作れるので、両モードの境目をテストで押さえる。
 */
describe('matchRanges', () => {
	test('ファイル名モード（smartCase=false）は大文字を含むクエリでも当たる', () => {
		expect(matchRanges('filesPanel.tsx', 'Panel', false)).toEqual([{ start: 5, end: 10 }]);
		expect(matchRanges('filesPanel.tsx', 'panel', false)).toEqual([{ start: 5, end: 10 }]);
	});

	test('全文モード（smartCase=true）は大文字を含むクエリを区別する', () => {
		expect(matchRanges('const handRotation = 0;', 'handrotation', true)).toEqual([{ start: 6, end: 18 }]);
		expect(matchRanges('const handRotation = 0;', 'HandRotation', true)).toEqual([]);
		expect(matchRanges('const handRotation = 0;', 'handRotation', true)).toEqual([{ start: 6, end: 18 }]);
	});

	test('複数の一致を左から順に返し、空クエリでは何も返さない', () => {
		expect(matchRanges('ab ab ab', 'ab', false)).toEqual([
			{ start: 0, end: 2 }, { start: 3, end: 5 }, { start: 6, end: 8 },
		]);
		expect(matchRanges('ab', '', false)).toEqual([]);
		expect(matchRanges('ab', '   ', false)).toEqual([]);
	});

	test('一致が多すぎる行でも上限で打ち切る（<Text>の子を作りすぎない）', () => {
		expect(matchRanges('a'.repeat(200), 'a', false)).toHaveLength(40);
	});
});
