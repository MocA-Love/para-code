/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

// 子プロセス（GPU・ユーティリティ・レンダラー）が落ちたことを、どれが・なぜ落ちたのかが分かる形で
// Sentry に残す。
//
// Sentry のネイティブクラッシュ（minidump）は `process.type: main` として届くだけで、落ちたのが
// 本体なのか内部プロセスなのかも分からない。実際、本体は動き続けているのに `__abort_with_payload`
// （dyld がライブラリを解決できずに起動時点で中断するパターン）が1日に数回積み上がっており、
// スタックが全てシステムフレームなので、どのプロセスの話なのかを絞り込む手がかりが無かった。
// Electron はこの2つのイベントで「種別・名前・理由・終了コード」を渡してくれるので、それを
// 併せて送ることで minidump 側と突き合わせられるようにする。

import { app } from 'electron';
import { reportParadisDiagnosticError } from '../common/paradisSentryDiagnostics.js';
import { registerParadisProcessGoneDiagnosticListeners } from '../common/paradisProcessGone.js';

/** 起動からの経過。更新の適用直後（＝ディスク上の実行ファイルが差し替わった後）かの判断に使う。 */
function uptimeMs(): number {
	return Math.round(process.uptime() * 1000);
}

/**
 * 子プロセスとレンダラーの異常終了を Sentry へ送るようにする。
 *
 * `app.on` は ready の前後どちらでも登録でき、Sentry の初期化を待たない（初期化前に落ちた分は
 * {@link reportParadisDiagnosticError} が黙って捨てる）。同じ理由で同じプロセスが落ち続けても
 * レート制限（10分3件）で頭打ちになる。
 */
export function registerParadisProcessGoneDiagnostics(): void {
	registerParadisProcessGoneDiagnosticListeners(app, reportParadisDiagnosticError, uptimeMs);
}
