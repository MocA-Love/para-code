/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

// fork独自ビューア（Markdown / HTML / PDF / Word / Excel）が使う webview の origin を配る。
//
// 何を直しているのか:
// `createWebviewOverlay` に origin を渡さないと `WebviewElement` が毎回 `generateUuid()` で
// 新しい origin を作る。origin は webview の service worker の登録スコープなので、**ビューアを
// 開くたびに新しい登録が1つ増え、二度と消えない**（実機のプロファイルで381件）。upstream の
// 多消費側（notebook / webviewView / chatOutputRenderer）は `WebviewOriginStore` で origin を
// 永続化・再利用していて、こちらだけ抜けていた。
//
// なぜ viewType だけをキーにしないのか:
// notebook は viewType ごとに1つの origin を使い回す（同種を同時に開けば origin を共有する）。
// しかしビューア側は `paradisRenderedFileEditor.ts` の健全性シグナルを **origin で自分宛かを
// 照合** している。同じ種類のビューアを2つ開くと互いのシグナルを拾い、白紙検知のウォッチドッグが
// 誤って解除される。
//
// そこで viewType に加えて「いま生きていない最小のスロット番号」をキーに混ぜる。登録数は
// 「同時に開いた最大数」で頭打ちになり（開き直しでは増えない）、同時に生きている origin は
// 必ず相異なる。
//
// ただしこの「相異なる」は **同じウィンドウの中でだけ** 成り立つ。スロットの台帳はレンダラー
// ローカルなので、ウィンドウが2つあれば両方が同じ番号を配る。いまはシグナルの中継
// （`paradisWebviewSignals.ts` のモジュールスコープ Emitter）も同じくレンダラーローカルで、
// 他ウィンドウのシグナルは届かないため実害は無い。**中継を IPC 越しにウィンドウ横断へ広げると
// この前提が壊れる**ので、そのときはスロットにウィンドウ固有の識別子を混ぜること。
//
// もう1つの但し書き: origin の台帳（`WebviewOriginStore` → `Memento`）は起動時に一度読んで
// 全体を上書き保存する作りなので、複数ウィンドウが同時に新しいスロットを作ると後勝ちで
// 片方の記録が消える。その場合だけ次の起動で origin が採り直され、登録が少しずつ増える。

import { IDisposable } from '../../../../base/common/lifecycle.js';
import { IStorageService } from '../../../../platform/storage/common/storage.js';
import { WebviewOriginStore } from '../../../../workbench/contrib/webview/browser/webview.js';

/** 貸し出した origin。`dispose()` でスロットを返す（返さないと登録が増え続ける）。 */
export interface IParadisWebviewOriginLease extends IDisposable {
	readonly origin: string;
}

/**
 * origin の貸し出し元。スロットの使用状況はビューアのインスタンスをまたいで共有する必要が
 * あるので、プロセスにつき1つだけ持つ（`webviewViewPane.ts` の origin store と同じ持ち方）。
 */
export class ParadisWebviewOriginPool {

	private static _shared: ParadisWebviewOriginPool | undefined;

	/** ビューアから使う共有インスタンス。最初の呼び出しの storage service に紐づく。 */
	static getShared(storageService: IStorageService): ParadisWebviewOriginPool {
		ParadisWebviewOriginPool._shared ??= new ParadisWebviewOriginPool(storageService);
		return ParadisWebviewOriginPool._shared;
	}

	private readonly _store: WebviewOriginStore;
	/** viewType ごとの使用中スロット番号。 */
	private readonly _inUse = new Map<string, Set<number>>();

	constructor(storageService: IStorageService) {
		this._store = new WebviewOriginStore('paradis.fileViewers.origins', storageService);
	}

	/**
	 * `viewType` 用の origin を1つ借りる。同時に借りている間は必ず別々の origin になり、
	 * 返したスロットは次の貸し出しで再利用される（＝service worker の登録が増えない）。
	 */
	acquire(viewType: string): IParadisWebviewOriginLease {
		let slots = this._inUse.get(viewType);
		if (slots === undefined) {
			slots = new Set<number>();
			this._inUse.set(viewType, slots);
		}
		const inUse = slots;
		let slot = 0;
		while (inUse.has(slot)) {
			slot++;
		}
		inUse.add(slot);
		// 二重 dispose で、あとから同じスロットを借りた別のビューアの分まで解放しないようにする。
		let released = false;
		return {
			origin: this._store.getOrigin(viewType, String(slot)),
			dispose: () => {
				if (!released) {
					released = true;
					inUse.delete(slot);
				}
			},
		};
	}
}
