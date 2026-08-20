/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

// 常駐ターミナル(pty デーモン)へ渡す設定。
//
// 渡す側 (デーモンを起こす main プロセス) と受け取る側 (デーモン自身) を同じファイルに置いて
// ある。環境変数は名前を間違えても誰も怒らず、`undefined` として静かに素通りするので、
// **文字列を2箇所に書かない**ことだけが取り違えを防ぐ手段になる。
//
// このうち `PARADIS_PTY_DAEMON_SOCKET` が入っているかどうかが、`ptyHostMain.ts` にとっての
// 「自分は常駐として起きたのか、アプリの中の pty host として起きたのか」の判定でもある。

import { IParadisPtyDaemonPaths } from './paradisPtyDaemonPaths.js';

export const PARADIS_PTY_DAEMON_SOCKET = 'PARADIS_PTY_DAEMON_SOCKET';
export const PARADIS_PTY_DAEMON_LEDGER = 'PARADIS_PTY_DAEMON_LEDGER';
export const PARADIS_PTY_DAEMON_BUILD_ID = 'PARADIS_PTY_DAEMON_BUILD_ID';
export const PARADIS_PTY_DAEMON_BUILD_KEY = 'PARADIS_PTY_DAEMON_BUILD_KEY';

export interface IParadisPtyDaemonEnv {
	readonly socketPath: string;
	readonly ledgerFile: string;
	readonly buildId: string;
	readonly buildKey: string;
}

/**
 * 常駐として起きたのかを判定し、必要な設定を取り出す。
 *
 * 1つでも欠けていれば undefined を返す。中途半端に起きた常駐は、台帳に名乗れないまま
 * ソケットだけ握る (＝誰にも見つけられないゾンビになる) ので、揃っていないなら常駐にしない。
 */
export function paradisReadPtyDaemonEnv(env: { readonly [key: string]: string | undefined }): IParadisPtyDaemonEnv | undefined {
	const socketPath = env[PARADIS_PTY_DAEMON_SOCKET];
	const ledgerFile = env[PARADIS_PTY_DAEMON_LEDGER];
	const buildId = env[PARADIS_PTY_DAEMON_BUILD_ID];
	const buildKey = env[PARADIS_PTY_DAEMON_BUILD_KEY];
	if (!socketPath || !ledgerFile || !buildId || !buildKey) {
		return undefined;
	}
	return { socketPath, ledgerFile, buildId, buildKey };
}

/** 起こす側が渡す環境変数。{@link paradisReadPtyDaemonEnv} と対になっている。 */
export function paradisPtyDaemonEnv(paths: IParadisPtyDaemonPaths, buildId: string): { readonly [key: string]: string } {
	return {
		[PARADIS_PTY_DAEMON_SOCKET]: paths.socketPath,
		[PARADIS_PTY_DAEMON_LEDGER]: paths.ledgerFile,
		[PARADIS_PTY_DAEMON_BUILD_ID]: buildId,
		[PARADIS_PTY_DAEMON_BUILD_KEY]: paths.buildKey,
	};
}
