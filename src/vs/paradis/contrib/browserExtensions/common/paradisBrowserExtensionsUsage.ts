/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

// 内蔵ブラウザの Chrome 拡張機能（paradis.browser.extensions.enabled・allowWhileShared）が働いているかを Sentry で
// 読めるようにする（q.html Q611）。main の拡張機能の処理が回数を数え、30 分ごとに `para.browserExtensions.usage` の
// 1 件にまとめる（paradisUsageTally.ts。main は span runner を持たないので、集計の送り口だけを使う）。
//
// 送るのは決まった語の回数と、入れている拡張機能の数の帯だけ。拡張機能の ID・名前・URL・エラーの文は送らない。

import { paradisIsExtensionUiAllowedWhileHeld } from '../../../../platform/browserView/common/paradisExtensionPageHold.js';
import { IParadisUsageClock, ParadisUsageSender, ParadisUsageTally, paradisUsageBand, paradisUsageSwitch } from '../../sentry/common/paradisUsageTally.js';

/** まとめて送る間隔。 */
export const PARADIS_BROWSER_EXTENSIONS_USAGE_INTERVAL_MS = 30 * 60_000;

/** 拡張機能 1 つの読み込みの結末。 */
export type ParadisExtensionLoadOutcome =
	| 'ok'
	/** 写しに詰め物を書けなかった。 */
	| 'prepare_failed'
	/** 読み込んだ拡張機能の ID が台帳と違った。 */
	| 'id_mismatch'
	/** Electron の loadExtension か、その後の準備で例外。 */
	| 'error';

/** ボタンを押してポップアップを出そうとした結末。 */
export type ParadisExtensionPopupOutcome =
	| 'opened'
	/** ボタンの位置が、タブを出しているのと別のウィンドウから来た（「no window」）。 */
	| 'no_window_other'
	/** そのウィンドウが見つからない（「no window」）。 */
	| 'no_window_missing'
	/** ポップアップの読み込みに失敗した。 */
	| 'load_failed';

/** 回数を数えて送る係（main に 1 つ）。どのメソッドも例外を外へ出さない。 */
export class ParadisBrowserExtensionsUsage {

	private enabled = false;
	private readonly tally: ParadisUsageTally;

	/** @param send 送り口（テスト用。既定は Sentry）。 */
	constructor(send?: ParadisUsageSender, clock?: IParadisUsageClock) {
		this.tally = new ParadisUsageTally({
			feature: 'browserExtensions',
			operation: 'usage',
			intervalMs: PARADIS_BROWSER_EXTENSIONS_USAGE_INTERVAL_MS,
			settings: () => this.settings(),
			send,
			clock,
		});
	}

	flush(): void {
		this.tally.flush();
	}

	/** 設定 `enabled`（main が起動時に 1 回読む値）。 */
	setEnabled(enabled: boolean): void {
		this.enabled = enabled;
	}

	settings(): Record<string, 'on' | 'off'> {
		return {
			enabled: paradisUsageSwitch(this.enabled),
			allow_while_shared: paradisUsageSwitch(paradisIsExtensionUiAllowedWhileHeld()),
		};
	}

	/** 1 つのセッションへ、有効な拡張機能をまとめて読み込み始めた。`count` は入れる予定の数。 */
	noteLoadAll(count: number): void {
		this.tally.add('load_runs');
		this.tally.add(`ext_count_${paradisUsageBand(count, [0, 1, 3, 10])}`);
	}

	noteLoad(outcome: ParadisExtensionLoadOutcome): void {
		this.tally.add(`load_${outcome}`);
	}

	/** 拡張機能の背景の処理（service worker）を起こせなかった。`scriptError` は worker の評価のエラーが理由か。 */
	noteWorkerStartFailed(scriptError: boolean): void {
		this.tally.add('worker_start_failed');
		if (scriptError) {
			this.tally.add('worker_start_failed_script');
		}
	}

	/** ポップアップ。`shared` はエージェントと共有中のタブで出したか。 */
	notePopup(outcome: ParadisExtensionPopupOutcome, shared: boolean): void {
		this.tally.add(`popup_${outcome}`);
		if (outcome === 'opened' && shared) {
			this.tally.add('popup_on_shared');
		}
	}

	/** サイドパネル。`shared` は共有中のタブの隣に出した（allowWhileShared がオン）か。 */
	noteSidePanel(outcome: 'opened' | 'refused_shared', shared: boolean): void {
		this.tally.add(`side_panel_${outcome}`);
		if (outcome === 'opened' && shared) {
			this.tally.add('side_panel_on_shared');
		}
	}
}

let usage: ParadisBrowserExtensionsUsage | undefined;

/** main の 1 つの係。 */
export function paradisBrowserExtensionsUsage(): ParadisBrowserExtensionsUsage {
	usage ??= new ParadisBrowserExtensionsUsage();
	return usage;
}
