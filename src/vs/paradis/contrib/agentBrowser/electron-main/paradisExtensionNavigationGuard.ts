/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

// エージェントが手にしているタブ（共有したタブ・エージェントのタブ・それらの子タブ）を、ブラウザ拡張の
// ページ（chrome-extension://）へ移らせない。CDP ゲートウェイは命令で守るが、ページのスクリプトからの移動
// （`location.href =`、`history.go()`）や、移動の直後に連打された命令との競合は命令では止めきれないので、
// 移動そのものを main で取り消す。
//
// Electron 43.7.7 で実測した取り消し方（2026-10-29）:
//  - ページ・iframe のスクリプトからの移動と、ページからの履歴の移動: `will-frame-navigate` が来るので
//    `preventDefault()` で取り消せる
//  - CDP の `Page.navigate`（iframe 宛てを含む）、`loadURL`、main からの履歴の移動: `will-frame-navigate` は
//    来ない。`did-start-navigation` の後で `webContents.stop()` を呼ぶと取り消せる。イベントの中で直接呼ぶと
//    Electron が落ちたので、次の周回へ回す。iframe の `executeJavaScript('window.stop()')` も落ちた
//  - 転送で拡張のページへ移る場合に備えて、`will-redirect`（取り消せる）と `did-redirect-navigation` も見る
//
// ユーザーがそのタブで拡張のページを開きたいときは、エージェントとの共有を外してから開く（外せば止めない）。

import type { WebContents } from 'electron';
import { paradisIsBrowserExtensionUrl } from '../common/paradisCdpExtensionScope.js';

/** 拡張のページへの移動を止める webContents（エージェントが手にしている間だけ）。 */
const heldByAgent = new WeakSet<WebContents>();
/** 見張りを付けた webContents（付けるのは 1 回だけ）。 */
const watched = new WeakSet<WebContents>();

/** 取り消せる移動のイベント（`will-frame-navigate`・`will-redirect`）の形。 */
interface ICancellableNavigation {
	readonly url: string;
	preventDefault(): void;
}

/** 取り消せない、始まった後の移動のイベント（`did-start-navigation`・`did-redirect-navigation`）の形。 */
interface IStartedNavigation {
	readonly url: string;
	readonly isSameDocument?: boolean;
}

/** 見張りが使う webContents の一部（テストでは偽物を渡す）。 */
export type ParadisGuardedWebContents = Pick<WebContents, 'on' | 'stop' | 'isDestroyed'>;

/**
 * エージェントがタブを手にした（true）・手放した（false）。手にしている間は、そのタブとその中の iframe が
 * 拡張のページへ移るのを取り消す。
 */
export function paradisSetExtensionNavigationGuard(webContents: ParadisGuardedWebContents, held: boolean, schedule: (callback: () => void) => void = callback => setImmediate(callback)): void {
	const key = webContents as WebContents;
	if (held) {
		heldByAgent.add(key);
	} else {
		heldByAgent.delete(key);
	}
	if (!held || watched.has(key)) {
		return;
	}
	watched.add(key);
	const cancel = (details: ICancellableNavigation) => {
		if (heldByAgent.has(key) && paradisIsBrowserExtensionUrl(details.url)) {
			details.preventDefault();
		}
	};
	const stop = (details: IStartedNavigation) => {
		if (heldByAgent.has(key) && details.isSameDocument !== true && paradisIsBrowserExtensionUrl(details.url)) {
			schedule(() => {
				if (!webContents.isDestroyed()) {
					webContents.stop();
				}
			});
		}
	};
	webContents.on('will-frame-navigate', details => cancel(details));
	webContents.on('will-redirect', details => cancel(details));
	webContents.on('did-start-navigation', details => stop(details));
	webContents.on('did-redirect-navigation', details => stop(details));
}
