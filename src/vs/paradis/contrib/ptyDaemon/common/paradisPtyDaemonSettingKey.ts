/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

// 常駐ターミナルの設定キー。
//
// 読む人が main・設定画面・ポップオーバーの3箇所に散るので、文字列はここ1箇所に置く。

/** 常駐を使うかどうか。既定は false（opt-in）。 */
export const PARADIS_PTY_DAEMON_ENABLED = 'paradis.terminal.daemon.enabled';

/**
 * 閉じたときにターミナルを常駐へ残すか。`ask` / `always` / `never`、既定は `ask`。
 *
 * 接続先 (SSH) 側の同じ設定とは**別に持つ**。名前が示すとおり片方は接続先の、もう片方は
 * この PC の話で、1つにまとめると設定名がどちらかの実態と合わなくなる。判断の中身は
 * `vs/paradis/common/paradisTerminalKeepPlan.ts` で共有しているので、挙動は揃う。
 */
export const PARADIS_PTY_DAEMON_KEEP_ALIVE_ON_CLOSE = 'paradis.terminal.daemon.keepAliveOnClose';

/**
 * 更新をまたいで繋ぎ直せる、薄い常駐を使うかどうか。
 *
 * {@link PARADIS_PTY_DAEMON_ENABLED} とは**別の常駐**を指す。あちらはアプリの pty ホスト一式を
 * 常駐にしたもので、ビルドが変わると繋ぎ直せない。こちらは pty だけを持つ薄いもので、
 * 話す言葉の版が同じならビルドが違っても繋ぎ直せる。
 *
 * 別の鍵にしてあるのは、**動いているものを黙って置き換えないため**。実機で確かめられるまで、
 * 選んだ人だけが新しい方を使う。
 */
export const PARADIS_PTY_HOST_DAEMON_ENABLED = 'paradis.terminal.daemon.reattachAcrossUpdates';
