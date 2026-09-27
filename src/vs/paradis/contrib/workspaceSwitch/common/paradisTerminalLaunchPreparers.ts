/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

// ターミナルを作る直前（PTY を起こす前）に、fork の機能が起動設定へ手を入れるための口。
//
// upstream の `TerminalInstanceService.createInstance` はすべての生成経路が通るチョークポイントで、
// そこにだけ1行の PARA-PATCH を置き、中身はここへ登録した関数に任せる。機能ごとに upstream の
// 行を増やさないためと、「パネルかエディタか」（`target`）を知っているのがそこだけだからである。
//
// 置き場所が workspaceSwitch なのは、upstream のターミナルから fork を import してよい先として
// eslint（`code-import-patterns`）が既に許しているため。使っている機能（共通ターミナルの開始
// フォルダ、スペースごとのシェル履歴）もどちらもスペースの扱いに関わるものである。

import { onUnexpectedError } from '../../../../base/common/errors.js';
import { IDisposable, toDisposable } from '../../../../base/common/lifecycle.js';
import { IShellLaunchConfig, TerminalLocation } from '../../../../platform/terminal/common/terminal.js';

/**
 * 起動設定を書き換える関数。同期で、例外を投げてもターミナルの生成は止めない。
 * `shellLaunchConfig` は upstream が作ったものをそのまま渡すので、上書きしてよいのは
 * 自分の機能が責任を持つ項目（`cwd` が未指定のときの既定値、fork の環境変数など）だけにする。
 */
export type ParadisTerminalLaunchPreparer = (shellLaunchConfig: IShellLaunchConfig, target: TerminalLocation) => void;

const preparers = new Set<ParadisTerminalLaunchPreparer>();

/** 登録した順に呼ばれる。返り値を dispose すると外れる。 */
export function paradisRegisterTerminalLaunchPreparer(preparer: ParadisTerminalLaunchPreparer): IDisposable {
	preparers.add(preparer);
	return toDisposable(() => preparers.delete(preparer));
}

/** `TerminalInstanceService.createInstance` から呼ぶ。1つが失敗しても残りは呼ぶ。 */
export function paradisPrepareTerminalLaunch(shellLaunchConfig: IShellLaunchConfig, target: TerminalLocation): void {
	for (const preparer of [...preparers]) {
		try {
			preparer(shellLaunchConfig, target);
		} catch (error) {
			onUnexpectedError(error);
		}
	}
}
