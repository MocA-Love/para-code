/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

// コードのブロックをコピーするとき、行頭のタブを元に戻す。
//
// marked は字句解析の前に、全部の行の行頭のタブ（行頭の空白に続くタブの並び）を空白 4 つずつに広げる
// （src/vs/base/common/marked/marked.js の `blockTokens`）。そのためプレビューのコードはタブが空白になって
// いて、画面の文字をそのままコピーすると Makefile や Go のコードが壊れる。本家の Markdown プレビューも同じ。
//
// 広げても行の数は変わらないので、元の文書の行とコードのブロックの中身の行を突き合わせ、対応する元の行から
// 中身の部分を切り出す。中身の行は、元の行からリストの字下げや引用の `> ` を外し、行頭のタブを広げたもの
// （引用やリストの中は、外した後でもう一度広げる）になっている。突き合わせられない・同じ見た目で元が違う
// ブロックがある、などで決まらないときは、画面の文字のままにする（壊れた文字は渡さない）。

/** marked が渡すコードのブロック（文書の順）。 */
export interface IParadisMarkdownCodeSource {
	/** 中身（行頭のタブを広げた後の、画面に出る文字）。 */
	readonly text: string;
	/** ``` や ~~~ で囲んだブロック（字下げだけのブロックは字下げ自体がタブのことがあるので戻さない）。 */
	readonly fenced: boolean;
}

const LEADING_TABS = /^( *)(\t+)/;
const TAB_COLUMNS = 4;
const OPENING_FENCE = /(`{3,}|~{3,})/;
/** 中身の前に付く物（字下げ・引用の `>`）だけでできているか。 */
const CONTAINER_PREFIX = /^[ \t>]*$/;

/** marked と同じ規則で、行頭の空白に続くタブの並びを空白 4 つずつに広げる。 */
function expandLeadingTabs(line: string): string {
	return line.replace(LEADING_TABS, (_, spaces: string, tabs: string) => spaces + ' '.repeat(TAB_COLUMNS * tabs.length));
}

/**
 * 元の行 `source` から、画面の中身の行 `content` に当たる部分を切り出す。字下げと引用の印だけを外し、残りの
 * 行頭のタブを広げると `content` になる位置を探す。無ければ `undefined`。
 */
function originalSuffix(source: string, content: string): string | undefined {
	for (let index = 0; index <= source.length; index++) {
		if (!CONTAINER_PREFIX.test(source.slice(0, index))) {
			return undefined;
		}
		const rest = source.slice(index);
		if (expandLeadingTabs(rest) === content) {
			return rest;
		}
	}
	return undefined;
}

/**
 * 画面に出るコードの中身から、元の文書に書いたままの中身への対応を作る。元と見た目が同じもの（タブの無いもの）と、
 * 同じ見た目で元が違うもの（どれか決められない）は入れない。
 */
export function paradisRecoverMarkdownCodeSources(markdown: string, codes: readonly IParadisMarkdownCodeSource[]): Map<string, string> {
	const sourceLines = markdown.replace(/\r\n|\r/g, '\n').split('\n');
	if (!sourceLines.some(line => line.includes('\t'))) {
		return new Map();
	}
	const found = new Map<string, string | undefined>();
	let cursor = 0;
	for (const code of codes) {
		if (!code.fenced) {
			continue;
		}
		const contentLines = code.text.split('\n');
		let original: string | undefined;
		for (let start = Math.max(cursor, 1); start + contentLines.length <= sourceLines.length; start++) {
			if (!OPENING_FENCE.test(sourceLines[start - 1])) {
				continue;
			}
			const lines = contentLines.map((line, offset) => originalSuffix(sourceLines[start + offset], line));
			if (lines.every(line => line !== undefined)) {
				original = lines.join('\n');
				cursor = start + contentLines.length + 1;
				break;
			}
		}
		// 同じ見た目で元が違う（または元が分からない）ブロックがあれば、どちらとも決めない。
		found.set(code.text, found.has(code.text) && found.get(code.text) !== original ? undefined : original);
	}
	const result = new Map<string, string>();
	for (const [text, original] of found) {
		if (original !== undefined && original !== text) {
			result.set(text, original);
		}
	}
	return result;
}
