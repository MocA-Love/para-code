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
	/**
	 * いま抱えているターミナル。**ウィンドウが繋がっているものも含む。**
	 *
	 * `IPtyService.listProcesses()` では答えられない。あちらは `isOrphan` で絞る (繋ぎ直せる
	 * ものを挙げるための API) ので、普通に使っている最中のターミナルは1本も出てこない。
	 */
	readonly terminals: readonly { readonly workspaceName: string }[];
}

export const PARADIS_PTY_DAEMON_AUTH_CHANNEL = 'paradisPtyDaemonAuth';

/**
 * 常駐と、繋ぎに来た側が名乗り合う口。
 *
 * **繋がることは身元の証明にならない。** ソケットの名前は userDataPath とビルドから作っていて、
 * その材料は同じマシンの他のユーザーにも計算できる。作るのに特権も要らず、先に作った側が
 * 持ち主になる。unix では置き場所を 0700 にしてあるので他人はファイルを作れないが、Windows の
 * 名前付きパイプにはその守りが無い。
 *
 * 偽物に繋ぐと何が渡るかというと、`createProcess` の引数にあるターミナルの環境変数一式と、
 * `input` に流れる全打鍵 (sudo のパスワード、ssh のパスフレーズ、貼り付けたトークン) で、
 * 出力の方は好きに捏造される。ソケットの向こうが本物であることを確かめないまま使ってよい
 * 経路ではない。
 *
 * 確かめ方は、共有している秘密 (台帳に 0600 で置いた token) を**流さずに**、知っていることだけを
 * 示し合う。互いに一度ずつ証明するので、偽のサーバーも偽のクライアントも弾ける。
 */
export interface IParadisPtyDaemonAuth {
	/**
	 * 名乗り合う。
	 *
	 * @param nonce 繋ぎに来た側が作る使い捨ての値。毎回変えること（変えないと、一度盗んだ
	 *              やり取りをそのまま繰り返されて通ってしまう）。
	 * @param clientProof 繋ぎに来た側の証明。token を知らなければ作れない。
	 * @returns 常駐の側の証明。呼んだ側はこれを検証してから使うこと。
	 */
	authenticate(nonce: string, clientProof: string): Promise<string>;
}
