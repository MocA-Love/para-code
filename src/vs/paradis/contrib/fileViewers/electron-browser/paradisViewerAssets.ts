/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

// PDF / Word ビューアが読むもの（同梱ライブラリと文書そのもの）を、ローカルサーバの URL に直す。
//
// なぜ必要か:
// この2つは pdf.js / docx-preview 本体も文書も `asWebviewUri` で取りに行っており、その解決は
// webview の service worker が担っている。service worker は origin に登録があるとナビゲーションを
// worker の起動完了まで待たせることがあり、実機では60秒止まるのを観測した。Markdown と HTML は
// 既にその経路から降りたが、**この2つは白紙検知すら持たないので、止まっても黙って待つだけ**に
// なっている（いちばん気づかれにくい）。
//
// pdf.js は日本語 PDF の CMap や標準フォントを「実行中に必要な分だけ」取りに行くので、HTML と同じ
// 理由で埋め込みでは解決できない。HTML 用に立てたローカルサーバをそのまま使う。
//
// 手元のファイルだけを対象にする理由:
// ライブラリはアプリの中（＝常に手元）にあるが、文書が SSH 先にある場合は配信元が2つに割れる。
// 効果のわりに壊せる範囲が広いので、リモートの文書は従来どおり service worker に任せる。

import { raceTimeout } from '../../../../base/common/async.js';
import { basename, dirname } from '../../../../base/common/resources.js';
import { Schemas } from '../../../../base/common/network.js';
import { URI } from '../../../../base/common/uri.js';
import { ISharedProcessService } from '../../../../platform/ipc/electron-browser/services.js';
import { paradisPreviewUrl } from '../common/paradisHtmlPreview.js';
import { paradisMountLocalPreview } from './paradisHtmlPreviewClient.js';

/**
 * 配信サーバへの問い合わせに許す時間。
 *
 * `ISharedProcessService.getChannel().call()` は shared process が上がるまで**期限なしで待つ**。
 * 上がってこない・再起動中だと解決も棄却もしないので、そのまま待つと「60秒待ちを潰す変更が、
 * 無制限に待つ経路を新設する」ことになる。時間切れは「載せられなかった」として従来経路へ倒す。
 */
const PARADIS_PREVIEW_MOUNT_TIMEOUT_MS = 3_000;

/** 期限つきで載せる。載せられなければ `undefined`（呼び出し側は従来経路へ倒す）。 */
async function mountWithDeadline(sharedProcessService: ISharedProcessService, directory: URI): Promise<string | undefined> {
	try {
		const located = await raceTimeout(paradisMountLocalPreview(sharedProcessService, directory), PARADIS_PREVIEW_MOUNT_TIMEOUT_MS);
		return located ? paradisPreviewUrl(located.mount, located.port) : undefined;
	} catch {
		return undefined;
	}
}

/**
 * 同梱ライブラリの置き場を返す。末尾に `/` は付けない（呼び出し側が `${libBase}/x.js` と繋ぐため）。
 *
 * ライブラリはアプリの中にあるので**ペインにつき一度**決めればよい。
 */
export async function resolveParadisViewerLibBase(
	sharedProcessService: ISharedProcessService,
	libRoot: URI,
): Promise<string | undefined> {
	const url = await mountWithDeadline(sharedProcessService, libRoot);
	return url?.replace(/\/$/, '');
}

/**
 * 表示する文書の URL を返す。
 *
 * **入力ごとに解決すること。** ペインは別のファイルを開くときも使い回されるので、最初の1件で
 * 焼き付けると2件目に1件目が表示される。手元のファイル以外は `undefined`（従来経路へ）。
 */
export async function resolveParadisViewerDocumentUrl(
	sharedProcessService: ISharedProcessService,
	documentResource: URI,
): Promise<string | undefined> {
	if (documentResource.scheme !== Schemas.file) {
		return undefined;
	}
	const folder = await mountWithDeadline(sharedProcessService, dirname(documentResource));
	// URL 組み立ては「フォルダー」を想定して末尾に `/` を足すので、ファイル名を足して整える。
	return folder ? `${folder}${encodeURIComponent(basename(documentResource))}` : undefined;
}

/**
 * CSP に書くための origin 一覧（重複を除いてスペース区切り）。
 *
 * `http://127.0.0.1:*` と書くと**他のプロセスが立てたローカルサーバまで許可**してしまうので、
 * 実際に使う URL のポートだけを許す。
 */
export function paradisPreviewOrigins(...urls: readonly string[]): string {
	const origins = new Set<string>();
	for (const url of urls) {
		if (url.startsWith('http://127.0.0.1:')) {
			try {
				origins.add(new URL(url).origin);
			} catch {
				// 組み立てに失敗した URL は CSP へも書かない（従来経路で描画される）。
			}
		}
	}
	return [...origins].join(' ');
}
