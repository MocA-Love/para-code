/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-PATCH/PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

/**
 * モバイルからの AskUserQuestion 回答を、Claude Code のTUIへ流し込むキー列に変換する。
 *
 * TUI（Claude Code 2.1系）の実挙動は以下の通りで、素朴な「番号 → Enter」では合わない:
 *
 *  - **数字キーは即選択**。ハイライトの移動ではなく、その場で回答が確定する。単一選択の
 *    質問では確定と同時に次の質問へ自動で進むため、続けてEnterを送ると *次の質問* の
 *    先頭選択肢を確定させてしまう（多問で答えが1問ずつずれる原因）
 *  - **自由入力（Other）は入力欄が空のあいだ、数字キーではフォーカスが移るだけ**。
 *    その状態でEnterを送ると空のまま確定を試み、単一選択では質問全体がキャンセルされる。
 *    正しくは「番号 → 本文 → Enter」の順
 *  - **複数選択の質問はEnterでも数字でも次へ進まない**。数字はトグル、Enter/スペースは
 *    フォーカス中の項目のトグルで、前進するには末尾の送信ボタンへTabで移動してEnterが要る。
 *    進めないまま次の答えを送ると、すべて同じ質問に降り注いでチェックが増え続ける
 *  - 単問かつ単一選択のときだけ確認画面が出ない。それ以外は最後に「Review your answers」
 *    が出るので、締めのEnterが1回要る
 *
 * 送信側（PC/モバイル）で同じ列を組み立てられるよう、副作用のない関数だけを置く。
 */

/** 1問ぶんのTUI上の形（キー列の組み立てに要るものだけ）。 */
export interface IParadisAgentQuestionShape {
	/** 「Other」を除いた選択肢の数。 */
	readonly optionCount: number;
	readonly multiSelect: boolean;
}

/** 1問ぶんの回答。モバイルから届くものと同じ形。 */
export type ParadisAgentQuestionAnswer =
	| { readonly kind: 'option'; readonly index: number }
	| { readonly kind: 'multi'; readonly indices: readonly number[] }
	| { readonly kind: 'text'; readonly optionCount: number; readonly text: string };

const ENTER = '\r';
const TAB = '\t';

/**
 * 自由入力の本文をTUIの1行入力に流せる形へ均す。改行はそのまま送ると確定扱いになり、
 * 残りが次の質問へ流れ込むため、空白に潰す。
 */
function flattenText(text: string): string {
	return text.replace(/[\r\n]+/g, ' ').trim();
}

/**
 * 複数選択の質問で、末尾の送信ボタン（Next/Submit）へフォーカスを移すためのTab数。
 * 選択肢＋Otherの行数ぶん送れば、どこから始まっても必ず送信ボタンに届く
 * （送信ボタン上でのTabは何もしないので、多く送っても行き過ぎない）。
 */
function tabsToSubmitButton(optionCount: number): string[] {
	return new Array<string>(optionCount + 1).fill(TAB);
}

/**
 * 回答をキー列にする。`questions` は `answers` と同じ並び（TUIの質問順）で渡す。
 *
 * 返る各要素は「1回ぶんの入力」で、呼び出し側が一定間隔を空けて順に流す前提。
 */
export function paradisAgentQuestionKeySequence(
	questions: readonly IParadisAgentQuestionShape[],
	answers: readonly ParadisAgentQuestionAnswer[],
): string[] {
	const parts: string[] = [];
	for (const [index, answer] of answers.entries()) {
		const question = questions[index];
		if (question === undefined) {
			continue;
		}
		if (answer.kind === 'option') {
			// 数字だけで確定し、次の質問へ自動で進む。Enterは送らない。
			parts.push(String(answer.index + 1));
			continue;
		}
		if (answer.kind === 'multi') {
			// 数字はトグルのみ（フォーカスは動かない）。スペースは「フォーカス中の項目」を
			// トグルしてしまうので送らない。
			for (const optionIndex of [...new Set(answer.indices)].sort((a, b) => a - b)) {
				parts.push(String(optionIndex + 1));
			}
			parts.push(...tabsToSubmitButton(question.optionCount), ENTER);
			continue;
		}
		const text = flattenText(answer.text);
		if (question.multiSelect) {
			// 複数選択のOther行は数字では選べない（数字はトグル）。Tabで入力欄まで移動して
			// 本文を入れると自動で選択され、そこからもう1つTabで送信ボタンへ。
			parts.push(...new Array<string>(question.optionCount).fill(TAB), text, TAB, ENTER);
			continue;
		}
		// 単一選択のOther: 番号でフォーカスを移し、本文を入れてからEnterで確定する。
		parts.push(String(answer.optionCount + 1), text, ENTER);
	}
	if (parts.length > 0 && paradisAgentQuestionNeedsReviewSubmit(questions)) {
		parts.push(ENTER);
	}
	return parts;
}

/**
 * 全問に答えたあと「Review your answers」の確認画面が出るか。
 * 単問かつ単一選択のときだけ、確定と同時に送信されて確認画面を挟まない。
 */
export function paradisAgentQuestionNeedsReviewSubmit(questions: readonly IParadisAgentQuestionShape[]): boolean {
	return !(questions.length === 1 && questions[0]?.multiSelect === false);
}
