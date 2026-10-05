/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

/**
 * scm `diff` の応答の上限（設計書 4 章の着手順 12）。
 *
 * 上限が無いと、大きな差分は 1 回の応答が mux の再結合の上限（32MiB）を超えて PC からは送れず、アプリは期限まで
 * 「読み込み中」のまま待つ。全文を作ってから切るのでは PC のメモリと時間を使い切るので、元（git の出力・未追跡の
 * ファイルの読み取り）の段階で絞り、ここでは行の境目で切って `truncated` を付ける。
 */

/** 差分の本文の上限（文字）。スマホで読む量としても十分に大きい。 */
export const PARADIS_MOBILE_DIFF_MAX_CHARS = 2_000_000;

/** 未追跡のファイルを差分の代わりに読むときの上限（バイト）。UTF-8 の 1 文字は 1 バイト以上なので、文字の上限を超えない。 */
export const PARADIS_MOBILE_DIFF_UNTRACKED_READ_BYTES = PARADIS_MOBILE_DIFF_MAX_CHARS;

/** `runGit` が出力の上限で git を止めたときに stderr へ足す文（`paradisWorktreeGitChannel.ts`）。 */
const RUN_GIT_OVERFLOW_PATTERN = /ParadisWorktreeGit: output exceeded the limit/;

/** `runGit` の結果が出力の上限で途中まで（git を止めた）か。 */
export function paradisIsRunGitOutputTruncated(stderr: string): boolean {
	return RUN_GIT_OVERFLOW_PATTERN.test(stderr);
}

/**
 * 差分の本文を上限までに切る。上限を超えたら最後の改行の後ろで切り（行の途中・サロゲートペアの途中で切らない）、
 * `truncated: true` を返す。`alreadyTruncated` は元の段階で切れていた（git を止めた・ファイルの先頭だけ読んだ）印で、
 * そのときは最後の行が途中かもしれないので、改行で終わっていなければ最後の行を落とす。
 */
export function paradisLimitMobileDiff(text: string, alreadyTruncated: boolean, maxChars = PARADIS_MOBILE_DIFF_MAX_CHARS): { readonly diff: string; readonly truncated: boolean } {
	if (text.length <= maxChars && !alreadyTruncated) {
		return { diff: text, truncated: false };
	}
	let cut = text.length > maxChars ? text.slice(0, maxChars) : text;
	if (!cut.endsWith('\n')) {
		const lastNewline = cut.lastIndexOf('\n');
		if (lastNewline >= 0) {
			cut = cut.slice(0, lastNewline + 1);
		} else {
			// 改行の無い 1 行だけが長い。行の途中でも、サロゲートペアの前半を残さずに切る
			const last = cut.charCodeAt(cut.length - 1);
			if (last >= 0xd800 && last <= 0xdbff) {
				cut = cut.slice(0, -1);
			}
		}
	}
	return { diff: cut, truncated: true };
}
