/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode.

// Windows 上で npm が生成する .cmd / .bat シムを child_process 系 API の shell 指定なしで
// 起動すると、CVE-2024-27980 対策が入った Node.js（20.12.2+ / 21.7.3+ / 22+。Electron 同梱
// Node を含む。2024-07 の CVE-2024-36138 で対象拡張子がさらに広がっている）では
// EINVAL で失敗する。旧 Node の「libuv が .cmd/.bat を検知して cmd.exe へ委譲する」挙動は
// 撤去済みであり、起動したい側が自前で cmd.exe ラップを行う必要がある。
//
// このモジュールは「解決済みのコマンド + 引数」から cmd.exe /d /s /c 形式の起動構成を
// 作る共通ヘルパーを提供する。ccusage・limitsMonitor・rtk・MCP セットアップ・hook プローブ
// など、fork が node 層で外部 CLI を execFile/spawn する箇所の共通経路とする。
// shell:true による文字列連結は使わない（引数は配列のまま渡し、クォートはここで完結させる）。

/** Windows のスクリプトシム拡張子(.cmd/.bat)。大文字小文字を区別しない。 */
const WINDOWS_SCRIPT_SHIM_EXTENSION_PATTERN = /\.(?:cmd|bat)$/i;

/**
 * 与えられたコマンドパス(または名前)が Windows のバッチシムかどうか。
 * `.exe` や素のコマンド名は対象外。
 */
export function paradisIsWindowsScriptShim(commandPath: string): boolean {
	return WINDOWS_SCRIPT_SHIM_EXTENSION_PATTERN.test(commandPath);
}

/** cmd.exe が見つからないということは基本的に無いためのフォールバック。 */
export const PARADIS_DEFAULT_WINDOWS_SHELL = 'cmd.exe';

export interface IParadisWindowsScriptShimInvocation {
	/** spawn/execFile の第1引数に渡す実行ファイル（cmd.exe）。 */
	readonly file: string;
	/** spawn/execFile の第2引数に渡す argv。 */
	readonly args: string[];
}

/**
 * Windows の引数クォート（MSVCRT 規約）。Node.js child_process 内部と同じ規則で、
 * 空白・タブ・引用符を含む要素だけを引用し、埋め込み引用符とその直前の連続バックスラッシュを
 * バックスラッシュでエスケープする。cmd.exe 自体はこの規約を解釈しないが、最終的に
 * CreateProcess → CRT 経由で argv 再構築される子プロセス側（node スクリプト等）で
 * 正しく分割されるようにするためのもの。
 */
function windowsQuoteArgument(argument: string): string {
	if (argument.length === 0) {
		// 空の引数が消えないように(libuv / CPython と同じ扱い)
		return '""';
	}
	if (!/[\s"]/.test(argument)) {
		return argument;
	}
	let escaped = '"';
	let pendingBackslashes = 0;
	for (let index = 0; index < argument.length; index++) {
		const char = argument[index];
		if (char === '\\') {
			pendingBackslashes++;
			continue;
		}
		if (char === '"') {
			// 引用符の直前に並んでいたバックスラッシュはすべて2倍し、さらに \" を足す
			escaped += '\\'.repeat(pendingBackslashes * 2 + 1);
			pendingBackslashes = 0;
			escaped += '"';
			continue;
		}
		escaped += '\\'.repeat(pendingBackslashes);
		pendingBackslashes = 0;
		escaped += char;
	}
	// 文末に連続するバックスラッシュも引用符の直前扱いなので2倍する
	escaped += '\\'.repeat(pendingBackslashes * 2);
	return `${escaped}"`;
}

/**
 * 解決済みコマンドが .cmd/.bat シムなら、`<comspec> /d /s /v:off /c "<quoted command line>"`
 * 形式の起動構成へ変換する。それ以外の場合は undefined を返す（呼び出し元は元の構成を
 * そのまま使う）。
 *
 * 戻り値を spawn/execFile へ渡す際は必ず `windowsVerbatimArguments: true` を併せて指定すること
 * （libuv による再クォートを防ぎ、ここで組み立てたコマンドラインをそのまま通すため）。
 *
 * `/c` 直後の一重引用符は cmd.exe の古い挙動（先頭と末尾の引用符だけ剥ぐ）で剥がれるため、
 * 中身をもう一重丸ごと引用している。これは node-pty 経由の `claude setup-token` 起動で
 * 実機検証済みの組み立てと同じ形式。
 */
export function paradisWrapWindowsScriptShim(
	command: string,
	args: readonly string[],
	comspec: string = PARADIS_DEFAULT_WINDOWS_SHELL,
): IParadisWindowsScriptShimInvocation | undefined {
	if (!paradisIsWindowsScriptShim(command)) {
		return undefined;
	}
	const commandLine = [command, ...args].map(windowsQuoteArgument).join(' ');
	// /v:off で遅延環境変数展開を無効化し、システム設定が DelayedExpansion=1 の環境でも
	// 引数中の `!` が破損しないようにする(node-pty 経由の claude setup-token 起動と同じ指定)。
	return { file: comspec, args: ['/d', '/s', '/v:off', '/c', `"${commandLine}"`] };
}
