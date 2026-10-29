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
//  - CDP の `Page.navigate`、`loadURL`、main からの履歴の移動: `will-frame-navigate` は
//    来ない。`did-start-navigation` の後で `webContents.stop()` を呼ぶと取り消せる（`stop()` はタブ全体の読み込みを
//    止めるので、ページそのものの移動のときだけ。iframe 宛ての CDP の移動はゲートウェイが断る）。イベントの中で直接呼ぶと
//    Electron が落ちたので、次の周回へ回す。iframe の `executeJavaScript('window.stop()')` も落ちた
//  - 転送で拡張のページへ移る場合に備えて、`will-redirect`（取り消せる）と `did-redirect-navigation` も見る
//
// - window.open で拡張のページを開くのは、upstream の browserView.ts の window.open の処理で開く前に断る
//   （PARA-PATCH 1 行、台帳は platform/browserView/common/paradisExtensionPageHold.ts）。開いた子タブにも作られた時から
//   見張りを付ける（転送で拡張のページへ移る場合）
//
// ユーザーがそのタブで拡張のページを開きたいときは、エージェントとの共有を外してから開く（外せば止めない）。止めたときは
// タブの上で知らせる。

import type { WebContents } from 'electron';
import { paradisIsBrowserExtensionUrl, paradisIsExtensionPageHeld, paradisNoteExtensionPageBlocked, paradisSetExtensionPageBlockedListener, paradisSetExtensionPageHold } from '../../../../platform/browserView/common/paradisExtensionPageHold.js';

/** 見張りを付けた webContents（付けるのは 1 回だけ）。 */
const watched = new WeakSet<object>();
/** 利用者へ知らせた時刻（同じタブで続けて止めたときに知らせを重ねない）。 */
const lastNotifiedAt = new WeakMap<object, number>();
/** 同じタブで知らせを重ねない間隔。 */
const NOTIFY_INTERVAL_MS = 5_000;

/** 取り消せる移動のイベント（`will-frame-navigate`・`will-redirect`）の形。 */
interface ICancellableNavigation {
	readonly url: string;
	preventDefault(): void;
}

/** 取り消せない、始まった後の移動のイベント（`did-start-navigation`・`did-redirect-navigation`）の形。 */
interface IStartedNavigation {
	readonly url: string;
	readonly isMainFrame?: boolean;
	readonly isSameDocument?: boolean;
}

/** 見張りが使う webContents の一部（テストでは偽物を渡す）。 */
export type ParadisGuardedWebContents = Pick<WebContents, 'on' | 'stop' | 'isDestroyed'>;

export interface IParadisExtensionNavigationGuardOptions {
	/** `webContents.stop()` を呼ぶ時（既定は次の周回）。 */
	readonly schedule?: (callback: () => void) => void;
	/** 止めたことを利用者へ知らせる（同じタブでは {@link NOTIFY_INTERVAL_MS} に 1 回まで）。 */
	readonly onBlocked?: () => void;
	/** 今の時刻（テスト用）。 */
	readonly now?: () => number;
}

/**
 * エージェントがタブを手にした（true）・手放した（false）。手にしている間は、そのタブとその中の iframe が
 * 拡張のページへ移るのを取り消す。
 */
export function paradisSetExtensionNavigationGuard(webContents: ParadisGuardedWebContents, held: boolean, options: IParadisExtensionNavigationGuardOptions = {}): void {
	paradisSetExtensionPageHold(webContents, held);
	if (options.onBlocked) {
		const onBlocked = options.onBlocked;
		const now = options.now ?? Date.now;
		paradisSetExtensionPageBlockedListener(webContents, () => {
			const at = now();
			const last = lastNotifiedAt.get(webContents);
			if (last === undefined || at - last >= NOTIFY_INTERVAL_MS) {
				lastNotifiedAt.set(webContents, at);
				onBlocked();
			}
		});
	}
	if (!held || watched.has(webContents)) {
		return;
	}
	watched.add(webContents);
	const schedule = options.schedule ?? (callback => setImmediate(callback));
	const cancel = (details: ICancellableNavigation) => {
		if (paradisIsExtensionPageHeld(webContents) && paradisIsBrowserExtensionUrl(details.url)) {
			details.preventDefault();
			paradisNoteExtensionPageBlocked(webContents);
		}
	};
	const stop = (details: IStartedNavigation) => {
		// iframe は `will-frame-navigate` で取り消せる。`stop()` はタブ全体の読み込み（画像など）も止めるので、
		// ページそのものの移動のときだけ使う
		if (paradisIsExtensionPageHeld(webContents) && details.isMainFrame !== false && details.isSameDocument !== true && paradisIsBrowserExtensionUrl(details.url)) {
			paradisNoteExtensionPageBlocked(webContents);
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

/**
 * エージェントが手にしているタブから開いた子タブ（window.open・target=_blank）に、作られた時から見張りを付ける。
 * 子タブはエージェントへの共有が後から届くので、それを待たずに止める（転送で拡張のページへ移る場合など）。
 */
export function paradisGuardChildWebContents(child: ParadisGuardedWebContents, opener: object, options: IParadisExtensionNavigationGuardOptions = {}): void {
	if (paradisIsExtensionPageHeld(opener)) {
		paradisSetExtensionNavigationGuard(child, true, options);
	}
}

/** タブが今ブラウザ拡張のページを表示しているか（読めなければ false）。 */
export function paradisShowsExtensionPage(webContents: unknown): boolean {
	try {
		const getURL = (webContents as { getURL?: () => string } | undefined)?.getURL;
		return typeof getURL === 'function' && paradisIsBrowserExtensionUrl(getURL.call(webContents));
	} catch {
		return false;
	}
}
