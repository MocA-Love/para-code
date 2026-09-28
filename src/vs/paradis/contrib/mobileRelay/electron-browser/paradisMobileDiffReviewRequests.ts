/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import { IStorageService, StorageScope, StorageTarget } from '../../../../platform/storage/common/storage.js';
import { paradisParseMobilePorcelainStatus } from '../common/paradisMobileDiffReview.js';
import {
	IParadisMobileReviewSpace,
	PARADIS_MOBILE_REVIEW_STORAGE_KEY,
	paradisApplyMobileReviewMarkChanges,
	paradisMobileReviewSpace,
	paradisParseMobileReviewMarkChanges,
	paradisParseMobileReviewStore,
	paradisPruneMobileReviewSpace,
	paradisSerializeMobileReviewStore,
} from '../common/paradisMobileReviewStore.js';
import { IParadisMobileRequest, IParadisMobileRequestContext, registerParadisMobileRequestHandler } from './paradisMobileRequestHandlers.js';

/**
 * モバイルの差分レビューの「確認済み」を PC に保存する（Orca W2-14、`review.store.v1`）。iPhone と iPad で
 * 同じ進み具合を見られ、アプリを閉じても残る。置き場所はスペースのメモと同じウィンドウの WORKSPACE ストレージ。
 *
 * - `reviewGet { ws }` → `{ t: 'review', ws, marks }`。コミット・破棄されて変更の一覧から消えたファイルの印は外す
 * - `reviewSet { ws, marks: [{ path, identity | null }] }` → 同じ形。印を1件ずつ付ける・外す（全体を送らないので、
 *   別の端末が同時に別のファイルへ付けた印を消さない）
 *
 * 読んでから書くまでは await を挟まない（レンダラーは1本のスレッドなので、これで要求どうしが混ざらない）。
 */

export function paradisReadMobileReviewStore(storage: IStorageService): Map<string, IParadisMobileReviewSpace> {
	return paradisParseMobileReviewStore(storage.get(PARADIS_MOBILE_REVIEW_STORAGE_KEY, StorageScope.WORKSPACE));
}

export function paradisWriteMobileReviewStore(storage: IStorageService, store: ReadonlyMap<string, IParadisMobileReviewSpace>): void {
	storage.store(PARADIS_MOBILE_REVIEW_STORAGE_KEY, paradisSerializeMobileReviewStore(store), StorageScope.WORKSPACE, StorageTarget.MACHINE);
}

/** 応答の本文（`reviewGet` / `reviewSet` 共通）。 */
export function paradisMobileReviewReply(ws: string, space: IParadisMobileReviewSpace): object {
	return { t: 'review', ws, marks: space.marks };
}

/** `ws` が解決できるスペースか確かめる。できなければ応答して undefined。 */
export function paradisRequireReviewWorkspace(request: IParadisMobileRequest, context: IParadisMobileRequestContext): string | undefined {
	if (typeof request.ws !== 'string' || request.ws.length === 0 || context.root === undefined) {
		context.reply({ error: `unknown workspace: ${request.ws ?? ''}` });
		return undefined;
	}
	return request.ws;
}

registerParadisMobileRequestHandler('scm', 'reviewGet', {
	async handle(accessor, request, context) {
		const storage = accessor.get(IStorageService);
		const ws = paradisRequireReviewWorkspace(request, context);
		if (ws === undefined) {
			return;
		}
		const status = await context.runGit(['status', '--porcelain=v1']);
		const store = paradisReadMobileReviewStore(storage);
		let space = paradisMobileReviewSpace(store, ws);
		if (status.code === 0) {
			const pruned = paradisPruneMobileReviewSpace(space, new Set(paradisParseMobilePorcelainStatus(status.stdout).map(file => file.path)));
			if (pruned !== space) {
				space = pruned;
				store.set(ws, space);
				paradisWriteMobileReviewStore(storage, store);
			}
		}
		context.reply(paradisMobileReviewReply(ws, space));
	},
});

registerParadisMobileRequestHandler('scm', 'reviewSet', {
	handle(accessor, request, context) {
		const storage = accessor.get(IStorageService);
		const ws = paradisRequireReviewWorkspace(request, context);
		if (ws === undefined) {
			return;
		}
		const changes = paradisParseMobileReviewMarkChanges(request.marks);
		if (changes === undefined) {
			context.reply({ error: 'invalid marks' });
			return;
		}
		const store = paradisReadMobileReviewStore(storage);
		const space = paradisApplyMobileReviewMarkChanges(paradisMobileReviewSpace(store, ws), changes, Date.now());
		store.set(ws, space);
		paradisWriteMobileReviewStore(storage, store);
		context.reply(paradisMobileReviewReply(ws, space));
	},
});
