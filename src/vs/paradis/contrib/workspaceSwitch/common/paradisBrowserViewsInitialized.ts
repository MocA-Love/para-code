/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-PATCH/PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import { DeferredPromise } from '../../../../base/common/async.js';
import { IDisposable, toDisposable } from '../../../../base/common/lifecycle.js';

/**
 * `IBrowserViewWorkbenchService.whenInitialized`（fork の待ち合わせ）を、upstream 1.141 の「最初のスナップショットを
 * 受け取った」約束から作る。拒否しない約束で、スナップショットを受け取れば true、受け取る前に持ち主が破棄されれば false。
 *
 * upstream 1.141 はスナップショットと以後の作成を、窓ごとの順序付きストリーム（`onDynamicBrowserViewEvent`）の中で
 * 送るようになった。スナップショットは購読と同じ流れで届くので、以前の `getBrowserViews()` のような「取りに行って
 * 失敗する」一時的な失敗は無く、fork が以前の待ち合わせでしていたリトライは要らない（届くまで待つ）。
 * `ready` が拒否されるのは、届いたスナップショットからモデルを作る処理が例外を投げたときだけで、同じスナップショット
 * をもう一度処理しても同じ例外になる。このときは false にして、受け手（paradisBrowserScope など）に初期化を
 * 信用させない。
 */
export function paradisWhenBrowserViewsInitialized(ready: Promise<void>): { readonly whenInitialized: Promise<boolean>; readonly lifetime: IDisposable } {
	const initialized = new DeferredPromise<boolean>();
	ready.then(() => initialized.complete(true), () => initialized.complete(false));
	return {
		whenInitialized: initialized.p,
		lifetime: toDisposable(() => void initialized.complete(false)),
	};
}
