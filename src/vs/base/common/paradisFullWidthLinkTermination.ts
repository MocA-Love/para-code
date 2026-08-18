/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

// marked (src/vs/base/common/marked/marked.js) の GFM 生URLオートリンク規則
// (`^((?:ftp|https?):\/\/|www\.)(?:[a-zA-Z0-9\-]+\.?)+[^\s<]*`) は末尾を空白か `<` でしか
// 止めないため、CLIエージェント (Claude Code/Codex等) が出す
// `https://example.com/pull/3515（ドラフト）` のように URL の直後へ全角の補足が続く出力を、
// 補足ごと1本のリンクとして拾ってしまう。結果としてリンクを開くと存在しないURL (404) を
// 開くことになる。
//
// エディタの linkComputer.ts (src/vs/editor/common/languages/linkComputer.ts) は
// FORCE_TERMINATION_CHARACTERS に同じ全角文字を含めてこの問題を避けているが、layering上
// base (このファイルが属するレイヤー) から editor を import することはできないため、
// 必要な文字集合だけをここへ複製する (ターミナルの単語区切り修正
// paradisTerminalWordSeparators.contribution.ts が使っている全角文字の集合と同じもの)。

// allow-any-unicode-next-line
const FULL_WIDTH_LINK_TERMINATION_CHARACTERS = '、。｡､，．：；〈「『〔（［｛｢｣｝］）〕』」〉｀～…';

/**
 * href が http(s) の生URLで、直後に全角の区切り文字が続いている場合はそこで切り詰める。
 * 該当しなければ渡された href をそのまま返す。
 */
export function paradisTruncateAtFullWidthLinkTermination(href: string): string {
	if (!/^https?:\/\//i.test(href)) {
		return href;
	}
	for (let i = 0; i < href.length; i++) {
		if (FULL_WIDTH_LINK_TERMINATION_CHARACTERS.includes(href[i])) {
			return href.slice(0, i);
		}
	}
	return href;
}
