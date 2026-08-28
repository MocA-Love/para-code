/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

// `browserViewWorkbenchService.getOrCreateLazy()` が新しいビューのセッションを決めるときに
// 1行だけ通す差し替え点。
//
// なぜ DI ではなくモジュールレベルのレジストリなのか:
// upstream の `getOrCreateLazy` は既存シグネチャで、そこへ渡す sessionOptions を作る箇所は
// クラスのメソッド内にある。ここでプロファイル用サービスを DI で注入すると
// `BrowserViewWorkbenchService` のコンストラクタ引数（＝upstream のシグネチャ）を増やすことに
// なり、fork規約（既存シグネチャは変えない）に反する。レジストリなら PARA-PATCH は
// 「1行の関数呼び出し + import」だけで済み、コンフリクト面が最小になる。
//
// 未登録のとき（Agent Sessions ウィンドウ、Web ビルド、テスト）は fallback をそのまま返す。
// つまりこの機能を読み込んでいない環境では upstream と完全に同じ挙動になる。

import type { IBrowserSessionOptions } from '../../../../platform/browserView/common/browserView.js';

/** ビューIDごとにセッションの決め方を差し替える口。 */
export interface IParadisBrowserProfileRouter {
	/**
	 * @param viewId これから作るブラウザビューのID
	 * @param fallback upstream が決めた既定のセッションオプション
	 * @returns 名前付きプロファイルを使うならそのオプション、使わないなら `fallback` そのもの
	 */
	resolveSessionOptions(viewId: string, fallback: IBrowserSessionOptions): IBrowserSessionOptions;
}

let router: IParadisBrowserProfileRouter | undefined;

/**
 * ルーターを登録する。登録は1つだけ（後勝ち）。ウィンドウごとに renderer は別プロセスなので、
 * 1ウィンドウ = 1ルーターになる。
 *
 * @returns 登録を解除する関数（自分がまだ現役のときだけ外す）
 */
export function paradisRegisterBrowserProfileRouter(candidate: IParadisBrowserProfileRouter): () => void {
	router = candidate;
	return () => {
		if (router === candidate) {
			router = undefined;
		}
	};
}

/**
 * upstream から呼ばれる唯一の関数（PARA-PATCH 点）。ルーターが未登録、あるいは例外を投げた
 * 場合は fallback を返す: プロファイルの解決に失敗してもブラウザが開かなくなってはいけない。
 */
export function paradisResolveBrowserSessionOptions(viewId: string, fallback: IBrowserSessionOptions): IBrowserSessionOptions {
	if (!router) {
		return fallback;
	}
	try {
		return router.resolveSessionOptions(viewId, fallback) ?? fallback;
	} catch {
		return fallback;
	}
}
