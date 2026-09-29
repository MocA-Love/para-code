/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-PATCH/PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import { paradisApprovalOptionKey, paradisParseApprovalOptionChoice, paradisParseApprovalOptions } from './paradisAgentApprovalOptions.js';

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
 *
 * **2026-08-06に Claude Code 2.1.223 で測り直した**: 数字キーの規則そのものは 2.1.220 から
 * 変わっていない（単一選択は数字だけで確定し、次の質問へ自動で進む）。ただし
 * **質問が描かれてから選択肢リストがキーボードフォーカスを取るまでに隙間があり、
 * そこへ届いたキーは入力欄へ吸われて消える**（待たずに送ると入力欄に文字が残るだけで質問は
 * 動かず、3秒待った同じキーはそのまま通った）。注入側は先頭の打鍵の前に画面を確かめる
 * （paradisMobileWorkspaceProvider の waitForInteractionTarget）。
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

/**
 * 許可の確認（Claude Code の「Do you want to proceed?」、Codex の承認プロンプト）への回答をキー列にする。
 *
 * Claude は `1`（Yes）で許可、Esc で拒否。`1` だけを送り、Enter は送らない: Claude Code 2.1.283 の許可画面は
 * 数字キーで即確定するので、後から送った Enter が次の入力に漏れ、次に出た同じ内容の許可を確定した
 * （フェーズ6の実機確認 NG-2）。以前はモバイルだけ `1` の後に Enter も送っていたが、デスクトップのチャット表示と
 * 揃えた（Orca の `mobile-native-chat-permission-send.ts` も `1` だけ）。`confirmWithEnter: true` は、
 * 数字で確定しない版のための逃げ道として残す（今は使っていない）。
 *
 * Codex は `y` で許可。拒否のキーは版で違う: codex-cli 0.155.1 の画面は
 * `3. No, and tell Codex what to do differently (esc)` で Esc、それより前の版は `d`。画面の文字が
 * 渡されれば、選択肢の行の末尾の `(…)` から選ぶ（{@link paradisCodexApprovalDenyKey}）。
 *
 * モバイルとデスクトップのチャット表示が同じ関数を使う（Codex の app-server 経由の承認は
 * キーではなく構造化された回答で返すので、ここは通らない）。
 */
export function paradisAgentApprovalKeySequence(agent: 'claude' | 'codex', choice: 'yes' | 'no' | `opt:${number}`, options?: { readonly screen?: string; readonly confirmWithEnter?: boolean }): string[] {
	// 画面の番号付きの選択肢から選んだ回答（W2-21）。Claude は数字 1 文字だけ（Enter は付けない）。
	// Codex は画面の行末の近道が要るので、画面が無い・読めない・近道の無い行なら空（呼び出し側は断る）。
	const optionNumber = choice === 'yes' || choice === 'no' ? undefined : paradisParseApprovalOptionChoice(choice);
	if (choice !== 'yes' && choice !== 'no') {
		if (optionNumber === undefined) {
			return [];
		}
		if (agent === 'claude') {
			return [String(optionNumber)];
		}
		const option = options?.screen !== undefined ? paradisParseApprovalOptions(options.screen)?.find(candidate => candidate.n === optionNumber) : undefined;
		const key = option !== undefined ? paradisApprovalOptionKey('codex', option) : undefined;
		return key !== undefined ? [key] : [];
	}
	if (agent === 'codex') {
		return [choice === 'yes' ? 'y' : paradisCodexApprovalDenyKey(options?.screen)];
	}
	if (choice === 'no') {
		return ['\u001b'];
	}
	return options?.confirmWithEnter === true ? ['1', ENTER] : ['1'];
}

/**
 * 拒否の選択肢の行（`No, …` で始まり、行末に近道 `(esc)` / `(d)` / `(n)` がある）。行頭の枠（古い Codex の `▌` を含む）・選択の印・番号の後に
 * `No` が来るものだけ（承認の画面の上に残る会話の文、例えば `No match (a)` を拾わない）。
 */
const DENY_OPTION_LINE = /^[\s│┃|▌]*(?:[❯›>▶]\s*)?(?:[1-9][.)]\s+)?No\b.*\((?<key>esc|[a-z])\)\s*[│┃|]?\s*$/;

/**
 * Codex の承認の画面から、拒否のキーを選ぶ。画面の下にある番号付きの選択肢の並びから `No, …` の行の近道を読む。
 * 並びとして読めなければ、下から探して最初の拒否の選択肢の行（承認の画面は画面のいちばん下に出る）。
 * 画面が無い・読めないときは、以前からの `d`。
 */
export function paradisCodexApprovalDenyKey(screen: string | undefined): string {
	if (screen !== undefined) {
		const option = paradisParseApprovalOptions(screen)?.find(candidate => /^No\b/.test(candidate.label) && candidate.shortcut !== undefined);
		const optionKey = option !== undefined ? paradisApprovalOptionKey('codex', option) : undefined;
		if (optionKey !== undefined) {
			return optionKey;
		}
		for (const line of screen.split('\n').reverse()) {
			const key = DENY_OPTION_LINE.exec(line)?.groups?.key;
			if (key !== undefined) {
				return key === 'esc' ? '\u001b' : key;
			}
		}
	}
	return 'd';
}
