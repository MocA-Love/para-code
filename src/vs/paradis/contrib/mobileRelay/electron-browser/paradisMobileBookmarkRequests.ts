/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

// スマホのブラウザ画面のブックマークバー（browser.bookmarks.v1）。PC の内蔵ブラウザのブックマーク
// （アプリ全体で 1 つの保存先、paradisBookmarksService.ts）をそのまま渡す。最初は見て開くだけ。
//
// - fs の `bookmarks` に一覧と favicon を返す（変換は paradisMobileBookmarksPayload）
// - 返したモバイルを 10 分の購読として覚え、ブックマークが変わったら `{ t: 'bookmarksChanged' }` を送る
//   （アプリは受けたら取り直す。同じモバイルが取り直すたびに期限を延ばす）

import { IDisposable, markAsSingleton } from '../../../../base/common/lifecycle.js';
import { IParadisBookmarksService } from '../../browserBookmarks/electron-browser/paradisBookmarksService.js';
import { paradisMobileBookmarksPayload } from '../common/paradisMobileBookmarks.js';
import { registerParadisMobileRequestHandler } from './paradisMobileRequestHandlers.js';

/** 変更を知らせ続ける時間（ms）。アプリはブラウザ画面を開いている間、これより短い間隔で取り直す。 */
const SUBSCRIPTION_TTL_MS = 10 * 60_000;

/** モバイル → 購読の期限と送り先。 */
const subscribers = new Map<string, { expiresAt: number; push: (body: { readonly t: string }) => void }>();
let changeListener: { readonly service: IParadisBookmarksService; readonly listener: IDisposable } | undefined;

/** 期限内の購読者へ「変わった」を送り、期限切れを外す。 */
function notifySubscribers(): void {
	const now = Date.now();
	for (const [mobileId, subscriber] of subscribers) {
		if (subscriber.expiresAt < now) {
			subscribers.delete(mobileId);
		} else {
			subscriber.push({ t: 'bookmarksChanged' });
		}
	}
}

registerParadisMobileRequestHandler('fs', 'bookmarks', {
	handle(accessor, _request, context) {
		const bookmarksService = accessor.get(IParadisBookmarksService);
		context.reply(paradisMobileBookmarksPayload(bookmarksService.nodes, hash => bookmarksService.getFavicon(hash)));
		if (context.mobileId === undefined) {
			return;
		}
		subscribers.set(context.mobileId, { expiresAt: Date.now() + SUBSCRIPTION_TTL_MS, push: body => context.push(body) });
		// サービスはウィンドウ（この Renderer）と同じ寿命のシングルトンなので、最初の要求で 1 回だけ購読する
		// （ウィンドウを閉じればサービスごと消える）。
		if (changeListener?.service === bookmarksService) {
			return;
		}
		changeListener?.listener.dispose();
		changeListener = { service: bookmarksService, listener: markAsSingleton(bookmarksService.onDidChange(notifySubscribers)) };
	},
});
