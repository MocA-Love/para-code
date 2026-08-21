/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

// `PersistentTerminalProcess` が抱える相手の形。
//
// upstream はここに具象クラス `TerminalProcess` を書いている。pty をこのプロセスの中で持つのが
// 前提だったので当然だが、**常駐に持たせる実装を差し込む余地が無い**。
//
// 中身を読むと、求めているのは `ITerminalChildProcess` に6つ足しただけだと分かる。だから
// 具象クラスではなくこの形で受けるようにすれば、`TerminalProcess` もそのまま通り、常駐版も
// 通る。`ptyService.ts` への変更は**引数の型1行**で済む。
//
// 足りない6つがどれも「pty を持っている側が知っていること」なのは偶然ではない。常駐版では、
// そのうち `currentTitle` だけが常駐から文字列で届き、残りはこちら側で作れる
// (`paradisPtyProtocol.ts` の冒頭)。

import {
	IProcessReadyWindowsPty,
	IShellLaunchConfig,
	ITerminalChildProcess,
	TerminalShellType,
} from '../../../../platform/terminal/common/terminal.js';

export interface IParadisTerminalProcessLike extends ITerminalChildProcess {
	readonly shellLaunchConfig: IShellLaunchConfig;
	readonly currentTitle: string;
	readonly shellType: TerminalShellType | undefined;
	readonly hasChildProcesses: boolean;
	/** 未確認の数え直し。繋ぎ直したときに前の相手の借金を持ち越さないための口。 */
	clearUnacknowledgedChars(): void;
	getWindowsPty(): IProcessReadyWindowsPty | undefined;
}
