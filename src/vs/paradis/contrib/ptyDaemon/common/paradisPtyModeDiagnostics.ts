/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

// ターミナルのプロセスをどこで飼うことにしたかを、main が決めた時点で Sentry へ 1 件送る（q.html Q611）。
//
// `para.ptyHandover.*` は引き継ぎ（reattachAcrossUpdates）を使う人からしか届かず、`para.pty-daemon.startup-revive` は
// どちらの常駐か分からない。起動ごとのこの 1 件（`para.ptyDaemon.mode`）で、旧い常駐（enabled）だけを使う起動と
// 引き継ぎの起動の数を分けて数えられる。決めたのは main の起動の途中で、Sentry の読み込みより前なので、
// 送るのは読み込みの後になる（paradisSentryDiagnostics.ts の `pendingUsageSpans`）。
//
// キーと値に `terminal` を入れない（Sentry のプロジェクト設定が値ごと消す）。

import { ParadisSpanAttributes, recordParadisUsageSpan } from '../../sentry/common/paradisSentryDiagnostics.js';
import { paradisUsageSwitch } from '../../sentry/common/paradisUsageTally.js';

/** 実際に選んだ飼い方。`handover` は更新をまたいで繋ぎ直す薄い常駐、`daemon` は旧い常駐、`in_app` はアプリの中。 */
export type ParadisPtyHostingMode = 'handover' | 'daemon' | 'in_app';

/** 常駐を使う設定なのにアプリの中へ倒した理由。 */
export type ParadisPtyHostingFallback = 'none' | 'windows' | 'path_too_long';

export function paradisPtyModeAttributes(mode: ParadisPtyHostingMode, fallback: ParadisPtyHostingFallback, settings: { readonly daemonEnabled: boolean; readonly reattachAcrossUpdates: boolean }): ParadisSpanAttributes {
	return {
		safe_pty_mode: mode,
		safe_pty_fallback: fallback,
		safe_set_daemon_enabled: paradisUsageSwitch(settings.daemonEnabled),
		safe_set_reattach: paradisUsageSwitch(settings.reattachAcrossUpdates),
	};
}

export function recordParadisPtyMode(attributes: ParadisSpanAttributes): void {
	recordParadisUsageSpan('ptyDaemon', 'mode', attributes);
}
