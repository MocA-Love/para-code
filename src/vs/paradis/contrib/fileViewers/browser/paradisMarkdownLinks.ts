/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

// Markdown ビューアのリンクを開けるようにする。
//
// webview の中でリンクをクリックすると、webview 基盤（pre/index.html）は `#見出し` だけを自分で
// スクロールし、それ以外は `did-click-link` としてホストへ通知するだけで、自分では開かない。
// 開くのは受け取った側（onDidClickLink の購読者）の仕事だが、ビューアには購読者がいなかったため、
// http(s) のリンクも相対パスのファイルも、クリックしても何も起きなかった。
//
// さらに、相対パスのリンクは webview の中で `vscode-webview://<id>/fake.html` を基準に解決されて
// から通知されるので、`../a.md` のような上の階層への参照は通知の時点で失われている。そこで描画時に
// 相対パスの href を文書の場所から解決した絶対 URI（`file:` / `vscode-remote:`）へ書き換えておく。

import { Schemas } from '../../../../base/common/network.js';
import { URI } from '../../../../base/common/uri.js';
import { extractSelection } from '../../../../platform/opener/common/opener.js';
import { resolveParadisMediaUri } from './paradisMarkdownInlineResources.js';

/** クリックされたときに開いてよいスキーム。`command:` などは開かない。 */
const OPENABLE_SCHEMES: ReadonlySet<string> = new Set([Schemas.http, Schemas.https, Schemas.mailto, Schemas.file, Schemas.vscodeRemote]);

/**
 * 相対パス（または `/` 始まりのワークスペース相対パス）のリンクを、開く先の URI に直す。
 * `#見出し` だけのリンクとスキーム付きのリンクは書き換えないので `undefined` を返す。
 */
export function resolveParadisMarkdownLinkTarget(href: string, documentUri: URI, workspaceFolder: URI | undefined): URI | undefined {
	const trimmed = href.trim();
	if (!trimmed || trimmed.startsWith('#') || /^[a-z][a-z0-9+.-]*:/i.test(trimmed) || trimmed.startsWith('//')) {
		return undefined;
	}
	const hashIndex = trimmed.indexOf('#');
	const fragment = hashIndex >= 0 ? trimmed.slice(hashIndex + 1) : '';
	const target = resolveParadisMediaUri(trimmed, documentUri, workspaceFolder);
	if (!target) {
		return undefined;
	}
	let decodedFragment = fragment;
	try {
		decodedFragment = decodeURIComponent(fragment);
	} catch {
		// 壊れたパーセントエンコードはそのまま使う。
	}
	return decodedFragment ? target.with({ fragment: decodedFragment }) : target;
}

/**
 * 木の中の `<a href>` のうち、相対パスのものを絶対 URI へ書き換える。書き換えた数を返す。
 * 属性値を差し替えるだけなので、サニタイズの結果を緩めることはない。
 */
export function rewriteParadisMarkdownLinks(root: Element, documentUri: URI, workspaceFolder: URI | undefined): number {
	let rewritten = 0;
	const stack: Element[] = [root];
	while (stack.length > 0) {
		const node = stack.pop()!;
		if (node.tagName === 'A') {
			const href = node.getAttribute('href');
			const target = href ? resolveParadisMarkdownLinkTarget(href, documentUri, workspaceFolder) : undefined;
			if (target) {
				node.setAttribute('href', target.toString());
				rewritten++;
			}
		}
		const children = node.children;
		for (let index = children.length - 1; index >= 0; index--) {
			stack.push(children[index]);
		}
	}
	return rewritten;
}

/**
 * webview から通知されたリンクを、実際に開く URI に直す。開かないものは `undefined`。
 *
 * ファイルの場合、`#L10` のような行指定はそのまま残し（開く側が選択範囲として解釈する）、
 * それ以外の断片（`#見出し`）は落とす。残すと断片ごとに別のエディタとして開いてしまうため。
 */
export function paradisMarkdownLinkToOpen(link: string): URI | undefined {
	let uri: URI;
	try {
		uri = URI.parse(link);
	} catch {
		return undefined;
	}
	if (!OPENABLE_SCHEMES.has(uri.scheme)) {
		return undefined;
	}
	if (uri.scheme === Schemas.file || uri.scheme === Schemas.vscodeRemote) {
		if (uri.fragment && !extractSelection(uri).selection) {
			return uri.with({ fragment: '' });
		}
	}
	return uri;
}
