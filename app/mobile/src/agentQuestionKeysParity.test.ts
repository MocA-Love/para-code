// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

/**
 * `agentQuestionKeys.ts` と PC 側の `paradisAgentQuestionKeys.ts` が同じキー列を作ることを固定する。
 *
 * 2つは同じ規則の写しで、回答APIを持つPCではPC側が、持たない古いPCではモバイル側が使われる。
 * 片方だけ直すと「PCによって回答のずれ方が違う」という再現しにくい形で壊れるため、
 * 「必ず両方直すこと」というコメントに頼らず、実際に突き合わせて落とす。
 *
 * PC側は依存ゼロの純粋関数なので、相対パスでそのまま import できる。
 */

import { describe, expect, it } from 'vitest';
import { agentQuestionKeySequence, agentQuestionNeedsReviewSubmit, type AgentQuestionKeyAnswer, type AgentQuestionShape } from './agentQuestionKeys.js';
import { paradisAgentQuestionKeySequence, paradisAgentQuestionNeedsReviewSubmit } from '../../../src/vs/paradis/contrib/mobileRelay/common/paradisAgentQuestionKeys.js';

/** 質問の形をひととおり（選択肢0〜5個 × 単一/複数選択）。 */
const SHAPES: AgentQuestionShape[] = [0, 1, 2, 3, 4, 5].flatMap(optionCount => [
	{ optionCount, multiSelect: false },
	{ optionCount, multiSelect: true },
]);

/** その形に対して送りうる回答（自由入力は改行・タブ入りも含める）。 */
function answersFor(shape: AgentQuestionShape): AgentQuestionKeyAnswer[] {
	return shape.multiSelect
		? [{ kind: 'multi', indices: [0] }, { kind: 'multi', indices: [2, 0] }, { kind: 'text', optionCount: shape.optionCount, text: 'ab\ncd\tef' }]
		: [{ kind: 'option', index: 0 }, { kind: 'text', optionCount: shape.optionCount, text: ' x\ty ' }];
}

describe('agentQuestionKeys parity with the PC copy', () => {
	it('作るキー列がPC側と1つも違わない', () => {
		const mismatches: string[] = [];
		let compared = 0;
		for (const first of SHAPES) {
			for (const second of SHAPES) {
				for (const firstAnswer of answersFor(first)) {
					for (const secondAnswer of answersFor(second)) {
						for (const questions of [[first], [first, second], [first, second, first]]) {
							const answers = questions.map((_, index) => (index === 0 ? firstAnswer : secondAnswer));
							const mine = agentQuestionKeySequence(questions, answers);
							const theirs = paradisAgentQuestionKeySequence(questions, answers);
							compared++;
							if (JSON.stringify(mine) !== JSON.stringify(theirs)) {
								mismatches.push(JSON.stringify({ questions, answers, mine, theirs }));
							}
						}
					}
				}
			}
		}
		expect(mismatches).toEqual([]);
		expect(compared).toBeGreaterThan(2_000);
	});

	it('確認画面が要るかの判定もPC側と一致する', () => {
		for (const first of SHAPES) {
			for (const second of SHAPES) {
				for (const questions of [[first], [first, second]]) {
					expect(agentQuestionNeedsReviewSubmit(questions)).toBe(paradisAgentQuestionNeedsReviewSubmit(questions));
				}
			}
		}
	});
});
