/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

// 薄い常駐の置き場所。
//
// **鍵はビルドではなく protocol の版。** これがこの機能の一行要約でもある。
//
// 前の常駐（`paradisPtyDaemonPaths.ts`）はソケットの名前にビルドを混ぜていた。向こう側に
// `IPtyService`（42メソッド）を丸ごと置いていたので、ビルドが変われば形が変わり得たためで、
// 出会わせないのが唯一の安全策だった。その代償が「更新すると繋ぎ直せない」だった。
//
// いま向こう側にあるのは、VS Code の型を1つも運ばない11個の原始的な操作だけになった。だから
// **同じ protocol の版を話す限り、ビルドが違っても同じ常駐へ繋いでよい**。名前に混ぜるのを
// 版に替えるだけで、更新をまたげるようになる。
//
// 版を上げた更新では、古い常駐は別の名前になり「見えるが繋がらない」状態に戻る。それは
// 互換を壊す変更をしたときだけの話で、そのときは意識して上げる（`paradisPtyProtocol.ts`）。
//
// 置き場所を前の常駐と分けてあるのは、両者が同じ台帳に混ざると状態パネルが互いを「別ビルドの
// 常駐」として並べてしまうため。**別のものは別の場所に置く。**

import { posix, win32 } from '../../../../base/common/path.js';
import { StringSHA1 } from '../../../../base/common/hash.js';
import { PARADIS_PTY_PROTOCOL_VERSION } from './paradisPtyProtocol.js';

/** ソケット名に混ぜるハッシュの長さ。衝突ではなく取り違えを防ぐのが目的なので8文字で足りる。 */
const KEY_LENGTH = 8;

/**
 * `sun_path` に収まる上限。超えると Node.js 24 以降は bind が `EINVAL` で落ちる。
 * `ipc.net.ts` の `safeIpcPathLengths` と同じ値。
 */
const SOCKET_PATH_LIMIT: { readonly [platform: string]: number | undefined } = {
	darwin: 103,
	linux: 107,
};

export type ParadisPtyHostPlatform = 'win32' | 'darwin' | 'linux';

export interface IParadisPtyHostPathInput {
	/** ここより下に置く。プロファイルが違えば常駐も分ける。 */
	readonly stateDir: string;
	readonly platform: ParadisPtyHostPlatform;
}

export interface IParadisPtyHostPaths {
	readonly socketPath: string;
	readonly ledgerDir: string;
	readonly ledgerFile: string;
	/**
	 * ソケットのパスが OS の上限を超えているか。
	 *
	 * **握り潰してはいけない。** 超えていると bind が失敗し、症状は「毎回ターミナルが作り直される」
	 * になるので原因に辿り着けない。超えていたら常駐を諦め、理由をログに残すこと。
	 */
	readonly socketPathTooLong: boolean;
}

function shortKey(value: string): string {
	const sha = new StringSHA1();
	sha.update(value);
	return sha.digest().substring(0, KEY_LENGTH);
}

export function paradisPtyHostPaths(input: IParadisPtyHostPathInput): IParadisPtyHostPaths {
	const path = input.platform === 'win32' ? win32 : posix;
	const scopeKey = shortKey(input.stateDir);
	const ledgerDir = path.join(input.stateDir, 'ptyHost');
	const ledgerFile = path.join(ledgerDir, `v${PARADIS_PTY_PROTOCOL_VERSION}.json`);

	if (input.platform === 'win32') {
		return {
			socketPath: `\\\\.\\pipe\\paracode-${scopeKey}-v${PARADIS_PTY_PROTOCOL_VERSION}-ptyh`,
			ledgerDir,
			ledgerFile,
			socketPathTooLong: false,
		};
	}

	// ソケットは台帳と同じ 0700 のディレクトリに置く。**権限のための配置**であって整理ではない。
	// 向こうにあるのは任意のシェルを起こせる口なので、繋げた時点でそのユーザーとして任意コード
	// 実行になる。`serve()` は chmod も umask 操作もしないため、ソケット自体の権限は umask 任せ
	// (実測 0755)。ディレクトリを 0700 にすれば、権限ビットに関わらず他ユーザーは辿り着けない。
	const socketPath = path.join(ledgerDir, `paracode-${scopeKey}-v${PARADIS_PTY_PROTOCOL_VERSION}.sock`);
	const limit = SOCKET_PATH_LIMIT[input.platform];

	return {
		socketPath,
		ledgerDir,
		ledgerFile,
		socketPathTooLong: typeof limit === 'number' && socketPath.length >= limit,
	};
}
