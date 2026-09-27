/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

// スペースごとのシェル履歴（Q40 案A）の設定と、保存先の決め方。
//
// Orca (https://github.com/stablyai/orca, MIT) の `terminalScopeHistoryByWorktree` と同じ考え方で、
// スペースごとに履歴ファイルを分ける。zsh / bash は HISTFILE を、fish はセッション名
// （`fish_history`）を切り替える。切り替え自体はシェル統合スクリプトが、ユーザーの rc を読み終えた
// 後に行う（先に設定すると ~/.zshrc の `HISTFILE=` に負ける）。

import { StringSHA1 } from '../../../../base/common/hash.js';

/** スペースごとのシェル履歴を使うか。 */
export const PARADIS_TERMINAL_SPACE_HISTORY_ENABLED = 'paradis.terminal.historyPerSpace.enabled';

/**
 * 履歴を置くフォルダ。シェル統合スクリプトが読み、zsh は `zsh_history`、bash は `bash_history` を
 * この下に作る。読んだら unset するので、そのシェルから起動した子プロセスには残らない。
 */
export const PARADIS_SPACE_HISTORY_DIR_ENV = 'PARA_CODE_SPACE_HISTORY_DIR';

/** fish のセッション名に使う識別子（英数字のみ）。fish は履歴の場所を変えられないため別に渡す。 */
export const PARADIS_SPACE_HISTORY_ID_ENV = 'PARA_CODE_SPACE_HISTORY_ID';

/** userData（接続先では `~/.para-code`）の下のフォルダ名。 */
export const PARADIS_SPACE_HISTORY_FOLDER = 'terminal-history';

/** fish のセッション名の接頭辞。`~/.local/share/fish/<接頭辞><id>_history` に書かれる。 */
export const PARADIS_FISH_HISTORY_SESSION_PREFIX = 'paracode_';

/**
 * スペースの stateKey から、履歴の識別子を作る。
 *
 * stateKey はリポジトリなら UUID、worktree なら `worktree:<uri>` で、そのままではファイル名にも
 * fish のセッション名（英数字と `_` だけ）にも使えない。同じ stateKey からは常に同じ値になる。
 */
export function paradisSpaceHistoryId(stateKey: string): string {
	const sha = new StringSHA1();
	sha.update(stateKey);
	return sha.digest().slice(0, 16);
}

/** 履歴フォルダのパス。`base` は userData（接続先では `~/.para-code`）の下の `terminal-history`。 */
export function paradisSpaceHistoryDirectory(base: string, historyId: string, separator: '/' | '\\'): string {
	const trimmed = base.endsWith('/') || base.endsWith('\\') ? base.slice(0, -1) : base;
	return `${trimmed}${separator}${historyId}`;
}

/** fish が書く履歴ファイルの名前（fish のデータフォルダの中）。 */
export function paradisFishHistoryFileName(historyId: string): string {
	return `${PARADIS_FISH_HISTORY_SESSION_PREFIX}${historyId}_history`;
}
