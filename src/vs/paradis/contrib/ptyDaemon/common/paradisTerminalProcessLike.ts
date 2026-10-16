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

import { IDisposable } from '../../../../base/common/lifecycle.js';
import {
	IProcessReadyWindowsPty,
	IShellLaunchConfig,
	ITerminalChildProcess,
	TerminalShellType,
} from '../../../../platform/terminal/common/terminal.js';

export interface IParadisTerminalProcessLike extends ITerminalChildProcess, IDisposable {
	readonly shellLaunchConfig: IShellLaunchConfig;
	readonly currentTitle: string;
	readonly shellType: TerminalShellType | undefined;
	readonly hasChildProcesses: boolean;
	/** 未確認の数え直し。繋ぎ直したときに前の相手の借金を持ち越さないための口。 */
	clearUnacknowledgedChars(): void;
	getWindowsPty(): IProcessReadyWindowsPty | undefined;

	/**
	 * 常駐が持っている端末か。持っていれば、このプロセス（pty ホスト）が終わっても走り続け、
	 * 次に起きた pty ホストが引き取れる。upstream の `TerminalProcess` には無い（undefined）。
	 */
	readonly paradisHeldByDaemon?: boolean;
	/**
	 * 窓が離れたので、常駐から手を離す。**pty は止めない。**
	 *
	 * 離さないと、常駐は「まだ見られている」と思って 10 万文字で pty を止め、別のサーバー
	 * （更新後の版）も引き取れない。常駐の端末だけが持つ（`paradisDaemonTerminalProcess.ts`）。
	 */
	paradisLetGo?(): Promise<void>;
	/**
	 * 手を離していた端末へ戻る。戻ったら true、手を離していなければ何もせず false。
	 *
	 * 離れている間の出力は画面の直列化へ届いていないので、差分だけを出力として流すか、
	 * `replaceScreen` で新しい直列化を受け取って控え全体で作り直す。呼んだ側は、true が返ったら
	 * 溜めている出力を直列化へ掃き出し、書き終わるのを待ってから窓へ画面を渡すこと。
	 * 別の pty ホストへ移っていた・もう無かったときは終了を伝えてから例外を投げる（繋ぎ直しは
	 * 失敗として扱われる）。
	 */
	paradisComeBack?(replaceScreen: (cols: number, rows: number) => IParadisPtyScreenSink): Promise<boolean>;
}

/** 作り直す画面の書き込み口（`PersistentTerminalProcess` の直列化）。 */
export interface IParadisPtyScreenSink {
	handleResize(cols: number, rows: number): void;
	handleData(data: string): void;
	/** それまでに書いた分が画面に反映されたら解決する。 */
	whenWritten(): Promise<void>;
}

