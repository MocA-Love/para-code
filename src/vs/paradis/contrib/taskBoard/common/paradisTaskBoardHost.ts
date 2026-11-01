/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import { createDecorator } from '../../../../platform/instantiation/common/instantiation.js';

/*
 * 同梱のタスクボードを開く口（main プロセス）。ボードのサーバー（resources/paradis/taskboard/server/main.mjs）を
 * 子プロセスとして起こし、専用のウィンドウで開く。サーバーはアプリに 1 つで、ウィンドウを閉じても止めない
 * （工程は進み続ける）。止めるのはアプリの終了時と stop()。
 */

export const PARADIS_TASK_BOARD_HOST_CHANNEL = 'paradisTaskBoardHost';

/** ボードを開けなかった理由。 */
export type ParadisTaskBoardOpenFailure =
	/** 配布物にボードが入っていない（ソースから動かしていて、まだビルドしていない等）。 */
	| 'not-bundled'
	/** 同じリポジトリを、ほかのボード（手で起動したもの）が開いている。 */
	| 'repo-busy'
	/** サーバーが起動しなかった。 */
	| 'start-failed';

export type ParadisTaskBoardOpenResult =
	/**
	 * `board`: 動いているボードの pid と、接続口へ送る起動ごとの鍵。開いた窓が shared process の接続口へ登録する
	 * （main から shared process へ直接登録する fork の口が無いため。画面は判定の側なので、鍵を渡してよい）。
	 */
	| { readonly ok: true; readonly board?: { readonly pid: number; readonly key: string } }
	| { readonly ok: false; readonly reason: ParadisTaskBoardOpenFailure; readonly message?: string };

export interface IParadisTaskBoardHost {
	/** ボードを開く。動いていなければ `repoPath` のリポジトリで起こす。動いていれば、そのウィンドウを前に出す。 */
	open(repoPath: string): Promise<ParadisTaskBoardOpenResult>;
	/** ボードのサーバーとウィンドウを止める。 */
	stop(): Promise<void>;
}

export const IParadisTaskBoardHostService = createDecorator<IParadisTaskBoardHostService>('paradisTaskBoardHostService');

export interface IParadisTaskBoardHostService extends IParadisTaskBoardHost {
	readonly _serviceBrand: undefined;
}

/** サーバーとの IPC（app/taskboard/server/main.ts の `--embedded`）。 */
export type ParadisTaskBoardServerMessage =
	| { readonly type: 'ready'; readonly port: number; readonly repo: string | undefined }
	| { readonly type: 'failed'; readonly reason: 'busy' | 'error'; readonly message: string };

/** 同梱のボードが優先して使うポート（手で起動するボードの既定 4870 と分ける。画面の設定はポートごとに残る）。 */
export const PARADIS_TASK_BOARD_EMBEDDED_PORT = 4871;
