/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

// 常駐ターミナルの設定キー。
//
// 読む人が main・設定画面・ポップオーバーの3箇所に散るので、文字列はここ1箇所に置く。

/**
 * 前の常駐（アプリの pty ホスト一式を常駐にする方式）のスイッチだった鍵。
 *
 * 2026-11-22（q.html Q681）にスイッチを {@link PARADIS_PTY_HOST_DAEMON_ENABLED} の 1 つに寄せ、設定画面から消した。
 * settings.json に `true` を書いたままの人のターミナルが、更新した途端に残らなくなるのを避けるため、
 * この PC では `true` を {@link PARADIS_PTY_HOST_DAEMON_ENABLED} のオンとして読む（{@link paradisLocalPtyHostDaemonEnabled}）。
 * 前の方式そのものはもう選ばれない。接続先（SSH）にはもともと読み手が居ないので、そちらでは読まない。
 */
export const PARADIS_PTY_DAEMON_LEGACY_ENABLED = 'paradis.terminal.daemon.enabled';

/**
 * 閉じたときにターミナルを常駐へ残すか。`ask` / `always` / `never`、既定は `ask`。
 *
 * 接続先 (SSH) 側の同じ設定とは**別に持つ**。名前が示すとおり片方は接続先の、もう片方は
 * この PC の話で、1つにまとめると設定名がどちらかの実態と合わなくなる。判断の中身は
 * `vs/paradis/common/paradisTerminalKeepPlan.ts` で共有しているので、挙動は揃う。
 */
export const PARADIS_PTY_DAEMON_KEEP_ALIVE_ON_CLOSE = 'paradis.terminal.daemon.keepAliveOnClose';

/**
 * ターミナルを常駐で動かすかどうか。既定は false（opt-in）。常駐は pty だけを持つ薄いもので、
 * 話す言葉の版が同じならビルドが違っても（更新をまたいでも）繋ぎ直せる。
 *
 * この PC の読み手は、この鍵をじかに読まずに {@link paradisLocalPtyHostDaemonEnabled} を通す
 * （前の鍵 {@link PARADIS_PTY_DAEMON_LEGACY_ENABLED} を書いたままの人を拾うため）。
 */
export const PARADIS_PTY_HOST_DAEMON_ENABLED = 'paradis.terminal.daemon.reattachAcrossUpdates';

/**
 * 常駐を使っている間、ターミナルの画面を定期的にディスクへ保存し、PC を再起動した後に戻すか。
 * 既定は true。画面と環境変数に含まれる秘密情報が最大30日ディスクに残るので、止められるようにしてある
 * （`paradisTerminalScreens.ts`）。
 */
export const PARADIS_PTY_DAEMON_SAVE_SCREENS = 'paradis.terminal.daemon.saveScreens';

/**
 * この PC でターミナルを常駐で動かす設定になっているか。
 *
 * **この PC の読み手は必ずここを通す。** main が常駐を選んだのに、状態や終了時の判断が別の読み方で
 * 「無効」と答えると、終了時にターミナルが全部畳まれる。
 */
export function paradisLocalPtyHostDaemonEnabled(configurationService: { getValue(key: string): unknown }): boolean {
	return configurationService.getValue(PARADIS_PTY_HOST_DAEMON_ENABLED) === true
		|| configurationService.getValue(PARADIS_PTY_DAEMON_LEGACY_ENABLED) === true;
}

/** {@link paradisLocalPtyHostDaemonEnabled} の答えが変わりうる設定の変更か。 */
export function paradisAffectsLocalPtyHostDaemon(event: { affectsConfiguration(key: string): boolean }): boolean {
	return event.affectsConfiguration(PARADIS_PTY_HOST_DAEMON_ENABLED) || event.affectsConfiguration(PARADIS_PTY_DAEMON_LEGACY_ENABLED);
}
