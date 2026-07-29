// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import { describe, expect, it } from 'vitest';
import { agentQuestionKeySequence } from './agentQuestionKeys.js';

const DOWN = '\u001b[B';
const single = (optionCount: number) => ({ optionCount, multiSelect: false });
const multi = (optionCount: number) => ({ optionCount, multiSelect: true });

describe('agentQuestionKeySequence', () => {
	it('単問の単一選択は番号だけで確定する（Enterを足すと次の入力欄へ落ちる）', () => {
		expect(agentQuestionKeySequence([single(3)], [{ kind: 'option', index: 1 }])).toEqual(['2']);
	});

	it('多問の単一選択は番号だけを並べ、最後に確認画面のEnterを1つ足す', () => {
		expect(agentQuestionKeySequence(
			[single(2), single(4)],
			[{ kind: 'option', index: 0 }, { kind: 'option', index: 3 }],
		)).toEqual(['1', '4', '\r']);
	});

	it('単一選択の自由入力は 番号→本文→Enter の順（先にEnterを送ると空のまま取り消される）', () => {
		expect(agentQuestionKeySequence(
			[single(2)],
			[{ kind: 'text', optionCount: 2, text: '  独自の案  ' }],
		)).toEqual(['3', '独自の案', '\r']);
	});

	it('自由入力の改行は空白へ潰す（そのまま送ると途中で確定して残りが次の質問へ流れる）', () => {
		expect(agentQuestionKeySequence(
			[single(1)],
			[{ kind: 'text', optionCount: 1, text: '一行目\n二行目' }],
		)).toEqual(['2', '一行目 二行目', '\r']);
	});

	it('複数選択は番号でトグルし、下矢印で送信ボタンまで降りてEnterで次へ進む', () => {
		expect(agentQuestionKeySequence(
			[multi(3)],
			[{ kind: 'multi', indices: [2, 0] }],
		)).toEqual(['1', '3', DOWN, DOWN, DOWN, DOWN, '\r', '\r']);
	});

	it('複数選択の自由入力は下矢印で入力欄まで降りてから本文を入れる', () => {
		expect(agentQuestionKeySequence(
			[multi(2)],
			[{ kind: 'text', optionCount: 2, text: 'その他の案' }],
		)).toEqual([DOWN, DOWN, 'その他の案', DOWN, '\r', '\r']);
	});

	it('先頭が複数選択でも、次の質問のキーが同じ質問に降らないよう送信ボタンを踏んでから進む', () => {
		expect(agentQuestionKeySequence(
			[multi(2), single(3)],
			[{ kind: 'multi', indices: [1] }, { kind: 'option', index: 2 }],
		)).toEqual(['2', DOWN, DOWN, DOWN, '\r', '3', '\r']);
	});

	it('質問より多い回答は無視する（選択肢が入れ替わった時に番号だけ流し込まない）', () => {
		expect(agentQuestionKeySequence(
			[single(2)],
			[{ kind: 'option', index: 0 }, { kind: 'option', index: 1 }],
		)).toEqual(['1']);
	});

	it('回答が無ければ何も送らない', () => {
		expect(agentQuestionKeySequence([single(2)], [])).toEqual([]);
	});

	// これが今回の回帰そのもの。列のどこにもタブが現れてはいけない。キーとして送れば
	// 「次の質問へ切り替え」になるのはもちろん、**自由入力の本文に混ざっていても同じ**
	// （本文は bracketed paste で包まずそのまま流れ、TUI が打鍵に分解する）。
	it('列のどこにもタブを出さない（キーでも本文でもtabs:nextとして食われる）', () => {
		const parts = agentQuestionKeySequence([multi(1), multi(4), single(3), multi(2)], [
			{ kind: 'multi', indices: [0] },
			{ kind: 'text', optionCount: 4, text: 'タブ\tを含む回答' },
			{ kind: 'text', optionCount: 3, text: 'タブ\tを含む回答' },
			{ kind: 'multi', indices: [1] },
		]);
		expect(parts.filter(part => part.includes('\t'))).toEqual([]);
		// 本文は失われず、タブが空白に置き換わって残る。
		expect(parts.filter(part => part.startsWith('タブ'))).toEqual(['タブ を含む回答', 'タブ を含む回答']);
	});
});
