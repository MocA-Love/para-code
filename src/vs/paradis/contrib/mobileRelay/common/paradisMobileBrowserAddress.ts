/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

// モバイルのブラウザ画面のアドレス欄の生の文字（browser の入力 `open`、browser.page.v1）を、
// 開く URL に直す。URL か検索かの判定は PC のアドレスバーと同じ `resolveAddressBarInputType`、
// 検索エンジンは設定 `workbench.browser.searchEngine` に任せる。開くのは http(s) だけ。

import { BROWSER_SEARCH_ENGINES, BROWSER_SEARCH_NONE, BrowserSearchEngineId, buildSearchUrl, resolveAddressBarInputType } from '../../../../workbench/contrib/browserView/common/browserSearch.js';
import { PARADIS_MOBILE_BROWSER_INPUT_TEXT_MAX } from './paradisMobileBrowserProtocol.js';

/** 設定の値を検索エンジンに直す。未設定・知らない値は Google（Para Code の既定）、`none` は検索しない。 */
export function paradisMobileBrowserSearchEngine(setting: unknown): BrowserSearchEngineId | undefined {
	if (setting === BROWSER_SEARCH_NONE) {
		return undefined;
	}
	return BROWSER_SEARCH_ENGINES.find(engine => engine.id === setting)?.id ?? BrowserSearchEngineId.Google;
}

function isLocalHost(host: string): boolean {
	const name = host.toLowerCase();
	return name === 'localhost'
		|| name.endsWith('.localhost')
		|| name.endsWith('.local')
		|| name.startsWith('[')
		|| /^\d{1,3}(?:\.\d{1,3}){3}$/.test(name)
		|| !name.includes('.');
}

/** スキームの無い URL らしい文字に http(s) を付ける。手元のホスト（localhost・IP・`.local`・ドットの無い名前）は http。 */
function withScheme(text: string): string | undefined {
	if (/^https?:\/\//i.test(text)) {
		return text;
	}
	// http(s) 以外のスキームは開かない（`localhost:3000` のようにコロンの後が数字ならホストとポート）。
	if (/^[a-z][a-z0-9+.-]*:(?!\d)/i.test(text)) {
		return undefined;
	}
	const authority = /^[^/?#]*/.exec(text)?.[0] ?? '';
	const host = authority.replace(/^[^@]*@/, '').replace(/:\d+$/, '');
	return `${isLocalHost(host) ? 'http' : 'https'}://${text}`;
}

function httpUrl(candidate: string | undefined): string | undefined {
	if (candidate === undefined) {
		return undefined;
	}
	try {
		const parsed = new URL(candidate);
		return (parsed.protocol === 'http:' || parsed.protocol === 'https:') && parsed.host.length > 0 ? parsed.href : undefined;
	} catch {
		return undefined;
	}
}

/**
 * アドレス欄の文字を開く URL にする。開けない（空・http(s) 以外・検索しない設定の検索語）なら `undefined`。
 *
 * - `url` と判定したもの → スキームを補って開く
 * - `unknown`（単語やドットの無いホスト名） → 検索エンジンがあれば検索、無ければ URL として開く
 * - `query` → 検索エンジンがあれば検索、無ければ開かない
 */
export function paradisResolveMobileBrowserAddress(rawText: unknown, searchEngineSetting: unknown): string | undefined {
	if (typeof rawText !== 'string' || rawText.length > PARADIS_MOBILE_BROWSER_INPUT_TEXT_MAX || /[\u0000-\u001f\u007f]/.test(rawText)) {
		return undefined;
	}
	const text = rawText.trim();
	const engine = paradisMobileBrowserSearchEngine(searchEngineSetting);
	switch (resolveAddressBarInputType(text)) {
		case 'empty':
			return undefined;
		case 'url':
			return httpUrl(withScheme(text));
		case 'query':
			return engine !== undefined ? buildSearchUrl(text, engine) : undefined;
		default:
			return engine !== undefined ? buildSearchUrl(text, engine) : httpUrl(withScheme(text));
	}
}
