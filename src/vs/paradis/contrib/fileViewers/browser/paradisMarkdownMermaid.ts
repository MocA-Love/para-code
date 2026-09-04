/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-PATCH/PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

// Markdown ビューアの Mermaid 対応。```mermaid``` コードブロックを `<pre class="mermaid">`（生テキスト、
// HTML エスケープ済み）に変換する marked 拡張と、vendored mermaid.js（media/mermaid/mermaid.min.js、
// MIT）を webview へ読み込むためのヘルパーをまとめる。実際の SVG 描画は webview 内で mermaid.js 自身が
// 行う（`paradisMarkdownFileEditor.ts` が `allowScripts` を有効にして呼び出す）。

import * as marked from '../../../../base/common/marked/marked.js';
import { escape } from '../../../../base/common/strings.js';
import { URI } from '../../../../base/common/uri.js';
import { FileAccess } from '../../../../base/common/network.js';
import { IFileService } from '../../../../platform/files/common/files.js';

/** vendored mermaid.js の配置ディレクトリ。 */
const MERMAID_MEDIA_ROOT = 'vs/paradis/contrib/fileViewers/browser/media/mermaid' as const;

/** ```mermaid``` コードブロックを図として描画し直すための marked 拡張。 */
export function markedMermaidExtension(): marked.MarkedExtension {
	return {
		renderer: {
			code({ text, lang, escaped }) {
				if (lang?.trim().toLowerCase() !== 'mermaid') {
					// フォールバック（既存のシンタックスハイライト用 renderer）に処理を譲る。
					return false;
				}
				// `markdownDocumentRenderer.ts` 側で mermaid ブロックはハイライトをスキップし生テキストを
				// 返すため、通常は `escaped` は false（未エスケープ）。念のためどちらの経路でも安全に扱う。
				const raw = escaped ? text : escape(text);
				return `<pre class="paradis-mermaid mermaid">${raw}</pre>`;
			},
		},
	};
}

/** レンダリング済み HTML に mermaid ブロックが含まれるか（含まれない文書で mermaid.js を読み込む無駄を避ける）。 */
export function containsParadisMermaidBlock(html: string): boolean {
	return html.includes('class="paradis-mermaid mermaid"');
}

/**
 * Markdown ビューアの webview に入れる CSP。
 *
 * **`script-src` は mermaid を実際に埋め込む文書でだけ許可する。** 許可した場合でも実行できるのは
 * この HTML 自身が埋め込む nonce 付き `<script>`（vendored mermaid.js 本体 + 初期化コード）だけで、
 * Markdown の記述内容や外部ソースからスクリプトを注入する余地は無い。逆に mermaid を含まない文書
 * まで一律に許可すると、その保証の範囲が理由なく広がる。
 */
export function paradisMarkdownCspContent(nonce: string, mermaidEnabled: boolean): string {
	const scriptSrc = mermaidEnabled ? ` script-src 'nonce-${nonce}';` : '';
	return `default-src 'none'; img-src https: data:; media-src https: data:; style-src 'nonce-${nonce}'; font-src https: data:;${scriptSrc}`;
}

/**
 * `<script>` の本文として埋め込むソースを無害化する。中に "</script" という文字列（コメント・
 * 文字列リテラル等）が出てくると、そこで HTML パーサーがタグを閉じてしまい後続が壊れるため
 * `<\/script` に置き換える（実行結果は変わらない。JS の文字列/正規表現リテラル内でも `\/` は
 * 単なる `/` として解釈される）。
 */
export function paradisNeutralizeScriptEnd(source: string): string {
	return source.replace(/<\/script/gi, '<\\/script');
}

let cachedMermaidScript: Promise<string | undefined> | undefined;

/**
 * vendored mermaid.js 本体のソースを読む。webview は Markdown ビューアの方針上ネットワーク／
 * service worker を使わないため、`<script>` タグの内容として直接埋め込む（`src` 参照にしない）。
 * サイズが大きい（約3.5MB）ので、プロセス内で一度読めたら使い回す。
 */
export async function loadParadisMermaidScriptSource(fileService: IFileService): Promise<string | undefined> {
	cachedMermaidScript ??= (async () => {
		try {
			const uri: URI = FileAccess.asFileUri(`${MERMAID_MEDIA_ROOT}/mermaid.min.js`);
			const content = await fileService.readFile(uri);
			// このソースは <script> の本文としてそのまま埋め込むため無害化する。
			return paradisNeutralizeScriptEnd(content.value.toString());
		} catch {
			// 読めなくても Markdown 自体の表示は継続できる（mermaid ブロックだけコードとして残る）。
			return undefined;
		}
	})();
	return cachedMermaidScript;
}
