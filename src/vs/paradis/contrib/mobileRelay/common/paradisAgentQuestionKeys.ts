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
 *    フォーカス中の項目のトグルで、前進するには末尾の送信ボタンへ移動してEnterが要る。
 *    進めないまま次の答えを送ると、すべて同じ質問に降り注いでチェックが増え続ける
 *  - **送信ボタンへの移動にTabは使えない**。TUIはTabを「次の質問へのタブ切り替え」に
 *    割り当てていて（`{context:"Tabs", bindings:{tab:"tabs:next", right:"tabs:next", ...}}`）、
 *    そちらが選択肢リスト側のフォーカス移動より先に食う。実機（2.1.220）で、4選択肢の質問へ
 *    Tabを5回送ると Q1→Q2→確認画面 まで飛び、締めのEnterが未回答のまま送信を叩いた。
 *    下矢印にはこの割り当てが無いので、そちらで送信ボタンまで降りる
 *  - 単問かつ単一選択のときだけ確認画面が出ない。それ以外は最後に「Review your answers」
 *    が出るので、締めのEnterが1回要る
 *
 * 送信側（PC/モバイル）で同じ列を組み立てられるよう、副作用のない関数だけを置く。
 * この段取りは Claude Code 2.1.220 の TUI に**生バイトを PTY へ書き込んで**実測したもので、
 * 注入の形式（`\u001b[B` をそのまま流す）まで本番と同じ条件で確かめてある。行の並びが前提なので、
 * **Claude Code を更新したら測り直すこと**。前提が崩れると、行き過ぎた Enter がチャットを開き、
 * 以降の回答キーがそのままエージェントへのメッセージとして送られる。
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
const DOWN = '\u001b[B';

/**
 * 自由入力の本文をTUIの1行入力に流せる形へ均す。
 *
 * 潰すのは改行だけではない。本文は bracketed paste で包まずそのまま PTY へ流れ、TUI は届いた
 * チャンクを打鍵に分解するので、**制御文字はキーとして食われる**:
 *  - 改行はその場で確定扱いになり、残りが次の質問へ流れ込む
 *  - タブは `tabs:next`（次の質問へのタブ切り替え）に割り当てられている。PCからコピーした
 *    コードを貼ると普通に混入するので、これがいちばん踏みやすい
 *  - ESC はエスケープシーケンスの開始として解釈され、後続の文字次第で矢印やキャンセルに化ける
 * どれも「本文の途中から別の質問へ答えが降り始める」形で壊れるため、まとめて空白にする。
 */
function flattenText(text: string): string {
	return text.replace(/[\u0000-\u001f\u007f]+/g, ' ').trim();
}

/**
 * 選択肢の並びの末尾にある Other（自由入力）行まで降りるための下矢印。
 *
 * 起点が0行目であることに依存している。質問が出た直後のフォーカスは常に先頭の選択肢で、
 * 数字キーはトグルするだけでフォーカスを動かさない（どちらも実機 2.1.220 で確認）。
 */
function downsToOtherRow(optionCount: number): string[] {
	return new Array<string>(optionCount).fill(DOWN);
}

/**
 * 送信ボタン（Next/Submit）まで降りるための下矢印。Other 行のちょうど1つ下にある。
 *
 * Tab と違い**多く送ると行き過ぎる**（送信ボタンの先に「Chat about this」があり、そこで
 * Enter を送るとチャットが開く。以降のキーは入力欄へ流れ込み、最後の Enter で混ざった文字列が
 * エージェントへ送信されてしまう）ので、過不足の無い数でなければならない。
 */
function downsToSubmitButton(optionCount: number): string[] {
	return [...downsToOtherRow(optionCount), DOWN];
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
			parts.push(...downsToSubmitButton(question.optionCount), ENTER);
			continue;
		}
		const text = flattenText(answer.text);
		if (question.multiSelect) {
			// 複数選択のOther行は数字では選べない（数字はトグル）。下矢印で入力欄まで降りて
			// 本文を入れると自動で選択され、そこからもう1つ下で送信ボタンへ。
			parts.push(...downsToOtherRow(question.optionCount), text, DOWN, ENTER);
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
