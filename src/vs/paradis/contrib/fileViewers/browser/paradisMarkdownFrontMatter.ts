/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-PATCH/PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

// Markdown ビューア用の YAML フロントマター処理。標準 Markdown プレビュー
// （extensions/markdown-language-features の yamlPreamble プラグイン）と同じ
// `markdown.preview.frontMatter` 設定（hide / codeBlock / table）に従って表示を出し分ける。
//
// 標準拡張は npm の `yaml` パッケージでパースするが、workbench core からは利用できないため、
// table スタイルはフロントマターで頻出する形だけを扱う最小のサブセットパーサで実現する
// （トップレベルの `key: scalar`、`key:` + リスト、`key:` + ネスト、`key: |` ブロックスカラー）。
// サブセットで安全に解釈できない内容は誤表示を避けて codeBlock 表示にフォールバックする。
// このため標準拡張の「不正 YAML はエラー表示」挙動とは意図的に異なる。

import { escape } from '../../../../base/common/strings.js';

export type ParadisFrontMatterStyle = 'hide' | 'codeBlock' | 'table';

const MARKER = '---';

/**
 * フロントマターの処理結果。`markdown` を marked に渡し、`htmlPrefix` をレンダリング結果
 * （sanitizer 通過後）の先頭に連結する。`htmlPrefix` は本モジュールが全てエスケープ済み。
 */
export interface IParadisFrontMatterResult {
	readonly markdown: string;
	readonly htmlPrefix: string;
}

/**
 * ドキュメント先頭の YAML フロントマターを設定スタイルに応じて処理する。
 * フロントマターが無ければ入力をそのまま返す。
 */
export function applyParadisFrontMatter(text: string, style: ParadisFrontMatterStyle): IParadisFrontMatterResult {
	const extracted = extractParadisFrontMatter(text);
	if (!extracted) {
		return { markdown: text, htmlPrefix: '' };
	}

	switch (style) {
		case 'hide':
			return { markdown: extracted.body, htmlPrefix: '' };
		case 'table': {
			const table = renderFrontMatterTable(extracted.content);
			if (table !== undefined) {
				return { markdown: extracted.body, htmlPrefix: table };
			}
			// サブセットパーサで解釈できない構造は codeBlock 表示へフォールバック。
			return { markdown: asYamlCodeBlock(extracted.content) + extracted.body, htmlPrefix: '' };
		}
		case 'codeBlock':
		default:
			return { markdown: asYamlCodeBlock(extracted.content) + extracted.body, htmlPrefix: '' };
	}
}

/**
 * 先頭行が `---`、かつ後続に行頭 `---` の閉じ行があるときだけフロントマターとして分離する
 * （標準拡張の markdown-it ルールと同じ条件。閉じが無い・先頭以外は通常の Markdown 扱い）。
 */
export function extractParadisFrontMatter(text: string): { readonly content: string; readonly body: string } | undefined {
	// BOM は検出の妨げになるだけなので判定前に除去する（本文には残す必要がない）。
	const src = text.charCodeAt(0) === 0xFEFF ? text.substring(1) : text;
	const lines = src.split('\n');
	if (stripTrailingWs(lines[0]) !== MARKER) {
		return undefined;
	}
	for (let i = 1; i < lines.length; i++) {
		if (stripTrailingWs(lines[i]) === MARKER) {
			return {
				content: lines.slice(1, i).join('\n'),
				body: lines.slice(i + 1).join('\n'),
			};
		}
	}
	return undefined;
}

function stripTrailingWs(line: string): string {
	return line.replace(/[ \t\r]+$/, '');
}

/** フロントマター本体を YAML のフェンス付きコードブロックとして Markdown 先頭へ差し込む文字列にする。 */
function asYamlCodeBlock(content: string): string {
	// 内容にバッククォート連続が含まれていてもフェンスが壊れないよう、常に一段長いフェンスを使う。
	const longestRun = content.match(/`+/g)?.reduce((max, run) => Math.max(max, run.length), 0) ?? 0;
	const fence = '`'.repeat(Math.max(3, longestRun + 1));
	return `${fence}yaml\n${content}\n${fence}\n\n`;
}

interface IFrontMatterEntry {
	readonly key: string;
	readonly valueHtml: string;
}

/**
 * フロントマターを key/value テーブルの HTML にする。サブセットパーサで
 * 安全に解釈できない行があれば undefined を返す（呼出元が codeBlock へフォールバック）。
 *
 * 生成 HTML は sanitizer を通さず webview へ直接埋め込まれる。`escape()` は `<>&` のみ
 * エスケープする（引用符はしない）ため、動的値は必ずテキストコンテキストにのみ置くこと。
 * HTML 属性値へ動的値を入れる場合は引用符のエスケープを別途行わないと XSS になる。
 */
function renderFrontMatterTable(content: string): string | undefined {
	const entries = parseTopLevelEntries(content);
	if (!entries) {
		return undefined;
	}
	if (!entries.length) {
		return '';
	}
	const rows = entries.map(e => `<tr><th>${escape(e.key)}</th><td>${e.valueHtml}</td></tr>`).join('');
	return `<table class="frontmatter"><tbody>${rows}</tbody></table>\n`;
}

const TOP_LEVEL_KEY_RE = /^(?<key>[^\s#'"][^:]*|'[^']*'|"[^"]*"):(?<rest>\s.*|)$/;

function parseTopLevelEntries(content: string): IFrontMatterEntry[] | undefined {
	const lines = content.split('\n').map(stripTrailingWs);
	const entries: IFrontMatterEntry[] = [];
	let i = 0;
	while (i < lines.length) {
		const line = lines[i];
		if (!line || line.startsWith('#')) {
			i++;
			continue;
		}
		if (/^\s/.test(line)) {
			// キー行に属さない行頭インデント（不正な構造）。
			return undefined;
		}
		const match = TOP_LEVEL_KEY_RE.exec(line);
		if (!match?.groups) {
			return undefined;
		}
		const key = unquoteScalar(match.groups.key);
		const inline = match.groups.rest.trim();

		// 後続のインデント行（このキーに属するネスト内容）をまとめて取り出す。
		const nested: string[] = [];
		let j = i + 1;
		for (; j < lines.length; j++) {
			if (lines[j] && !/^\s/.test(lines[j])) {
				break;
			}
			nested.push(lines[j]);
		}
		// 末尾の空行はネスト内容に含めない。
		while (nested.length && !nested[nested.length - 1]) {
			nested.pop();
		}

		const valueHtml = renderEntryValue(inline, nested);
		if (valueHtml === undefined) {
			return undefined;
		}
		entries.push({ key, valueHtml });
		i = j;
	}
	return entries;
}

function renderEntryValue(inline: string, nested: readonly string[]): string | undefined {
	// ブロックスカラー（`key: |` / `key: >`）: ネスト行をデデントしてそのまま表示する。
	if (/^[|>][+-]?$/.test(inline)) {
		return escape(dedent(nested).join(inline.startsWith('|') ? '\n' : ' '));
	}
	if (inline) {
		if (nested.length) {
			// インライン値とネスト内容の同居は YAML として不正か、コメント等の解釈が必要。
			return undefined;
		}
		return escape(unquoteScalar(inline));
	}
	if (!nested.length) {
		return '';
	}
	const listItems = tryParseList(nested);
	if (listItems) {
		return `<ul>${listItems.map(item => `<li>${escape(item)}</li>`).join('')}</ul>`;
	}
	// ネストしたマッピング等は生の YAML をコードとして見せる（標準拡張の yaml.stringify 表示に相当）。
	return `<code>${escape(dedent(nested).join('\n'))}</code>`;
}

/** ネスト行が全て `- <scalar>` のリストならスカラー配列として返す。 */
function tryParseList(nested: readonly string[]): string[] | undefined {
	const items: string[] = [];
	for (const line of nested) {
		if (!line) {
			continue;
		}
		const match = /^\s*-\s+(?<item>\S.*)$/.exec(line);
		if (!match?.groups) {
			return undefined;
		}
		items.push(unquoteScalar(match.groups.item.trim()));
	}
	return items;
}

function dedent(lines: readonly string[]): string[] {
	let minIndent = Infinity;
	for (const line of lines) {
		if (!line) {
			continue;
		}
		minIndent = Math.min(minIndent, /^[ \t]*/.exec(line)![0].length);
	}
	if (!isFinite(minIndent)) {
		return [...lines];
	}
	return lines.map(line => line.substring(minIndent));
}

/** 単純な引用符付きスカラーを剥がす（複雑なエスケープは含まれたまま表示する）。 */
function unquoteScalar(value: string): string {
	if (value.length >= 2 && value.startsWith('"') && value.endsWith('"')) {
		return value.substring(1, value.length - 1).replace(/\\(["\\])/g, '$1');
	}
	if (value.length >= 2 && value.startsWith(`'`) && value.endsWith(`'`)) {
		return value.substring(1, value.length - 1).replace(/''/g, `'`);
	}
	return value;
}

/**
 * フロントマター表示用の追加 CSS（標準 Markdown プレビュー media/markdown.css の
 * frontmatter スタイルに準拠。webview 内へエクスポートされるテーマ変数を参照する）。
 */
export const PARADIS_FRONTMATTER_STYLES = `
table.frontmatter {
	margin-bottom: 16px;
	border-collapse: collapse;
}

table.frontmatter th,
table.frontmatter td {
	padding: 6px 13px;
	border: 1px solid var(--vscode-widget-border, rgba(127, 127, 127, 0.35));
	text-align: left;
	vertical-align: top;
}

table.frontmatter th {
	font-weight: 600;
	white-space: nowrap;
}

table.frontmatter td > ul {
	margin: 0;
	padding-left: 1.2em;
}

table.frontmatter td > code {
	white-space: pre-wrap;
}
`;
