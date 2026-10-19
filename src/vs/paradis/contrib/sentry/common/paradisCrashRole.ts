/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

// Node として動かす子プロセス（ELECTRON_RUN_AS_NODE）に「何のプロセスか」の印を付ける。
//
// こうした子が落ちると、crashpad の minidump には Electron の注記（`ptype: node`・pid）しか残らず、
// pty の常駐なのか、ペインごとの chrome-devtools-mcp なのか、拡張の tsserver なのかが分からない
// （Sentry の PARA-CODE-DESKTOP-5F。累計 36 件のメモリ不足がどれのものか決められなかった）。
// 子の中で `process.crashReporter.addExtraParameter` を呼ぶと、同じ注記の並びに載る。
//
// 呼ぶのは子の側でなければならない（注記はプロセスごと）。入口のスクリプトに手を入れずに済むよう、
// Node の `--import` に data: URL で1行を渡し、入口より先に走らせる。新しいファイルを同梱しないので、
// 配布版でだけ見つからない、という形の失敗が起きない（Electron 43 の配布版で、Node モードでも
// `--import data:` と `addExtraParameter` が動くことを確かめてある）。
//
// 読む側は main の beforeSend（`paradisMinidumpModules.ts` で dmp から読み、`para.process_role` の
// タグにする）。読むのは下の一覧にある名前だけで、それ以外は捨てる。

/** 注記の名前。crashpad の注記名は 39 字まで。 */
export const PARADIS_CRASH_ROLE_ANNOTATION = 'para_role';

/** 印を付ける子プロセス。増やすときはここに足す（読む側はこの一覧に無い値を捨てる）。 */
export type ParadisCrashRole =
	/** 更新をまたいで繋ぎ直せる薄い常駐（`paradis.terminal.daemon.reattachAcrossUpdates`）。 */
	| 'pty-host-daemon'
	/** pty host を丸ごと外に出す常駐（`paradis.terminal.daemon.enabled`）。 */
	| 'pty-daemon'
	/** ペインごとの chrome-devtools-mcp。 */
	| 'devtools-mcp';

const KNOWN_ROLES: ReadonlySet<string> = new Set<ParadisCrashRole>(['pty-host-daemon', 'pty-daemon', 'devtools-mcp']);

/** 注記から読んだ値が、こちらの付けた印か。 */
export function paradisIsCrashRole(value: string): value is ParadisCrashRole {
	return KNOWN_ROLES.has(value);
}

/**
 * 子プロセスの引数の先頭（入口のスクリプトより前）に足す Node の引数。
 *
 * Electron の外（SSH 先の素の node）では crashpad が無いので何も足さない。`process.crashReporter` が
 * 無い・呼べないときも子の起動は止めない（中で例外を握る）。
 */
export function paradisCrashRoleNodeArgs(role: ParadisCrashRole, inElectron: boolean): string[] {
	if (!inElectron) {
		return [];
	}
	const code = `try{process.crashReporter?.addExtraParameter(${JSON.stringify(PARADIS_CRASH_ROLE_ANNOTATION)},${JSON.stringify(role)})}catch{}`;
	return ['--import', `data:text/javascript,${encodeURIComponent(code)}`];
}
