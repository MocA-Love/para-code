/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

// 「Terminal: Attach to Session」で、残してあるほかのターミナルの猶予を縮めるかどうか。
//
// upstream のこのコマンドは一覧を出す前に `reduceConnectionGraceTime()` を呼び、繋がっていない
// pty を**全部**短い猶予（既定 6 秒）へ移す。upstream で繋がっていない pty は、閉じ損ねたウィンドウの
// 名残なので、片付けを早めて困ることは無い。
//
// Para Code では、繋がっていない pty の多くは**わざと残したもの**。常駐を使っているこの PC では
// 閉じたウィンドウや別のスペースのターミナルが、SSH の接続先では閉じたウィンドウのターミナルが
// （猶予は 24 時間に伸ばしてある。`paradisTerminalGraceTime.ts`）、次に開かれるのを待っている。
// そこで猶予を縮めると、選んだ 1 本以外は 6 秒後に全部終わる。だから、残す仕組みが働いている
// 繋ぎ先では縮めない。縮めなくても、繋がっていない pty は元の猶予で片付く。

import { PARADIS_PTY_DAEMON_ENABLED, PARADIS_PTY_HOST_DAEMON_ENABLED } from './paradisPtyDaemonSettingKey.js';

export interface IParadisSettingReader {
	getValue(key: string): unknown;
}

/**
 * @param remoteAuthority 一覧を出す繋ぎ先。undefined ならこの PC。
 * @param isWindows この PC が Windows か（Windows では常駐を使わない。`paradisPtyHostStarterFactory.ts`）
 */
export function paradisShouldReduceGraceOnAttach(remoteAuthority: string | undefined, configuration: IParadisSettingReader, isWindows: boolean): boolean {
	if (remoteAuthority !== undefined) {
		return false;
	}
	if (isWindows) {
		return true;
	}
	return configuration.getValue(PARADIS_PTY_DAEMON_ENABLED) !== true
		&& configuration.getValue(PARADIS_PTY_HOST_DAEMON_ENABLED) !== true;
}
