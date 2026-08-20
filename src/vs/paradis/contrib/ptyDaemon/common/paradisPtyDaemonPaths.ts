/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

// 常駐ターミナル(pty デーモン)のソケットと台帳の置き場所を決める。
//
// ここが1箇所に集まっていないと困る理由が2つある。
//
// 1つ目。**同じ場所を、まったく別のタイミングで動く3者が計算する**。デーモンを起こす側
//   (main プロセス)、名乗りを上げる側 (デーモン自身)、繋ぎに行く側 (橋渡しプロセス) が、
//   それぞれ独立に同じ文字列へ辿り着かなければならない。ずれると「起こしたのに繋がらない」に
//   なり、しかも失敗の形が「新しいデーモンがもう1つ増える」なので気づきにくい。
//
// 2つ目。**ビルドが違うデーモンは、絶対に混ざってはいけない**。ターミナルの状態は
//   `ptyService` の内部表現でやり取りするので、更新前のデーモンへ更新後のアプリが繋ぐと、
//   合わない形のデータを読むことになる。だからソケットの名前自体にビルドを混ぜて、
//   **新旧が同じ名前に辿り着けないようにする**。混線を検知するのではなく、起こさない。
//
// なお `createStaticIPCHandle` (base/parts/ipc/node/ipc.net.ts) は同じ考え方だが、unix では
// `version.substr(0, 4)` まで切り詰めるため `1.132.0-paracode-71` と `1.132.0-paracode-72` が
// どちらも "1.13" になり区別できない。fork の版はまさにそこで分かれるので、ここで作り直す。

import { posix, win32 } from '../../../../base/common/path.js';
import { StringSHA1 } from '../../../../base/common/hash.js';

/** ソケットのファイル名に混ぜるハッシュの長さ。衝突ではなく取り違えを防ぐのが目的なので8文字で足りる。 */
const KEY_LENGTH = 8;

/**
 * `sun_path` に収まる上限。超えると Node.js 24 以降は bind が `EINVAL` で落ちる
 * (以前は黙って切り詰められていた)。`ipc.net.ts` の `safeIpcPathLengths` と同じ値。
 */
const SOCKET_PATH_LIMIT: { readonly [platform: string]: number | undefined } = {
	darwin: 103,
	linux: 107,
};

export type ParadisDaemonPlatform = 'win32' | 'darwin' | 'linux';

export interface IParadisPtyDaemonPathInput {
	/**
	 * ユーザーデータの場所。プロファイルが違えば常駐も分ける
	 * (別のプロファイルのターミナルへ繋がってしまうと、スペースの取り違えより性質が悪い)。
	 */
	readonly userDataPath: string;
	/** 人が読めるビルドの名前。台帳にそのまま載り、UI にも出る。 */
	readonly buildId: string;
	readonly platform: ParadisDaemonPlatform;
	/** linux の `XDG_RUNTIME_DIR`。無ければ undefined。 */
	readonly xdgRuntimeDir?: string;
}

export interface IParadisPtyDaemonPaths {
	/** 繋ぎ先。unix はソケットファイル、Windows は名前付きパイプ。 */
	readonly socketPath: string;
	/** ビルドを表す短い鍵。ソケット名と台帳のファイル名に使う。 */
	readonly buildKey: string;
	/** 台帳を置くディレクトリ。ビルドを問わず共通で、ここを読めば全部の常駐が分かる。 */
	readonly ledgerDir: string;
	/** このビルドの台帳。 */
	readonly ledgerFile: string;
	/**
	 * ソケットのパスが OS の上限を超えているか。
	 *
	 * ここは**呼び出し側が握り潰してはいけない**。超えていると bind が失敗し、常駐は永久に
	 * 立ち上がらないが、症状は「毎回ターミナルが作り直される」なので原因に辿り着けない。
	 * 超えていたら常駐を諦めて今までどおりの動作へ落とし、理由をログに残すこと。
	 */
	readonly socketPathTooLong: boolean;
}

function shortKey(value: string): string {
	const sha = new StringSHA1();
	sha.update(value);
	return sha.digest().substring(0, KEY_LENGTH);
}

/**
 * 常駐の置き場所を決める。同じ入力からは必ず同じ結果が出る (3者が別々に計算するため)。
 */
export function paradisPtyDaemonPaths(input: IParadisPtyDaemonPathInput): IParadisPtyDaemonPaths {
	const buildKey = shortKey(input.buildId);
	const scopeKey = shortKey(input.userDataPath);
	const path = input.platform === 'win32' ? win32 : posix;
	const ledgerDir = path.join(input.userDataPath, 'ptyDaemon');
	const ledgerFile = path.join(ledgerDir, `${buildKey}.json`);

	if (input.platform === 'win32') {
		// 名前付きパイプに長さの問題は無い。
		return {
			socketPath: `\\\\.\\pipe\\paracode-${scopeKey}-${buildKey}-ptyd`,
			buildKey,
			ledgerDir,
			ledgerFile,
			socketPathTooLong: false,
		};
	}

	// linux は XDG_RUNTIME_DIR を優先する (tmp より寿命と権限がはっきりしている)。macOS には
	// 相当するものが無く、`tmpdir()` が `/var/folders/…` と長いので userDataPath に置く。
	const socketDir = input.platform !== 'darwin' && input.xdgRuntimeDir ? input.xdgRuntimeDir : input.userDataPath;
	const socketPath = path.join(socketDir, `paracode-${scopeKey}-${buildKey}.sock`);
	const limit = SOCKET_PATH_LIMIT[input.platform];

	return {
		socketPath,
		buildKey,
		ledgerDir,
		ledgerFile,
		socketPathTooLong: typeof limit === 'number' && socketPath.length >= limit,
	};
}
