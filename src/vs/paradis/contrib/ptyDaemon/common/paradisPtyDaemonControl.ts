/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

// 常駐ターミナルを外から止めるための口。
//
// **なぜ pid で殺さないのか。** 最初は台帳に書いた pid へ `SIGTERM` を送っていた。これは
// 攻撃者が居なくても壊れる。常駐が異常終了 (クラッシュ・強制終了・電源断) すると台帳を片付ける
// 経路を通らないので record が残り、OS は pid を使い回す。PC を再起動すれば番号は若い方から
// 振り直されるので、残った record の pid は**高い確率で無関係の生きたプロセスを指す**。
// `process.kill(pid, 0)` が答えるのは「その番号が存在するか」だけで「それが我々の常駐か」では
// ないため、画面には「動作中」と出て、ユーザーが「停止」を押すと進行中のビルドや ssh-agent が
// 落ちる。
//
// 繋がるかどうかは、それ自体が身元の証明になる。ソケットの名前にはビルドと userDataPath が
// 入っていて、その名前で待ち受けていて、しかもこの口に答えられるものは我々の常駐しかない。
// だから**繋いで頼む**。繋がらなければ、それは `paradisJudgeUnreachableDaemon` が言うとおり
// 「何も分からない相手」なので、殺さずに置いておく。
//
// この口を分けてあるのは、`IPtyService` に「自分を終わらせる」を足したくないため。あちらは
// ターミナルの面倒を見るもので、プロセスの寿命はここが持つ。

export const PARADIS_PTY_DAEMON_CONTROL_CHANNEL = 'paradisPtyDaemonControl';

/** 常駐が自分について答えられること。 */
export interface IParadisPtyDaemonControl {
	/** 身元と抱えているもの。繋がった時点で身元は証明されているので、確認用ではなく表示用。 */
	describe(): Promise<IParadisPtyDaemonDescription>;
	/**
	 * 片付けて終わる。抱えているターミナルは全部失われる。
	 *
	 * 返事を待たないこと。常駐は台帳とソケットを消してから `process.exit` するので、
	 * 呼び出しの返事が返る保証がない (返る前に接続が切れる)。
	 */
	shutdown(): Promise<void>;
}

export interface IParadisPtyDaemonDescription {
	readonly pid: number;
	readonly buildId: string;
	readonly startedAt: number;
	readonly terminalCount: number;
}
