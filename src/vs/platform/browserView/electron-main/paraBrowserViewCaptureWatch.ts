/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

/**
 * BrowserView のスクリーンショット（ライブウィンドウのタイルなど）を撮る直前の知らせ。
 *
 * 長く隠れたタブを凍結する処理（vs/paradis/contrib/browserFreeze）が、誰かが見ているタブを止めない・止めていたら
 * 撮る前に起こすために使う。platform から vs/paradis を読み込まないよう、知らせの受け口だけをここに置く。
 */
const lastCaptureAt = new WeakMap<object, number>();
const listeners = new Set<(view: object) => void>();

/** BrowserView.captureScreenshot の始めに呼ぶ。 */
export function paraNoteBrowserViewCapture(view: object): void {
	lastCaptureAt.set(view, Date.now());
	for (const listener of listeners) {
		try {
			listener(view);
		} catch {
			// 知らせを受ける側の失敗で撮影を止めない
		}
	}
}

/** そのビューを最後に撮り始めた時刻（ミリ秒）。撮っていなければ undefined。 */
export function paraBrowserViewLastCaptureAt(view: object): number | undefined {
	return lastCaptureAt.get(view);
}

/** 撮る直前に呼ばれる処理を登録する。戻り値を呼ぶと外れる。 */
export function paraOnWillCaptureBrowserView(listener: (view: object) => void): () => void {
	listeners.add(listener);
	return () => listeners.delete(listener);
}
