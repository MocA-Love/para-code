/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

// SSH の接続先に置く hook の宛先を、接続元の PC ごとに分ける。
//
// 接続先の notify スクリプトは、ポートファイル（戻りトンネルが接続先で受け取った番号）を読んで
// hook を送る。ポートファイルが接続先に1つしか無いと、同じ接続先へ2台の PC から繋いだとき、後から
// 繋いだ PC の番号で上書きされ、先に繋いだ PC のペインの hook まで後の PC へ届く（トークンを知らない
// ので捨てられ、先の PC では状態表示が止まる）。PC ごとのポートファイルを `ports/<印>.json` に置き、
// ペインの env（`PARA_CODE_MCP_PORT_FILE`）でどれを読むかを教える。共有の 1 つも書き続けるので、
// この仕組みを知らない古い notify スクリプトもこれまでどおり動く。

import { stringHash } from '../../../../base/common/hash.js';

/** 接続先の `~/.para-code` の中で、PC ごとのポートファイルを置くディレクトリ名。 */
export const PARADIS_REMOTE_HOOK_PORTS_DIR_NAME = 'ports';

/** 印の形（16 桁の小文字 16 進数）。notify スクリプトの側でも同じ形だけを受け付ける。 */
export const PARADIS_REMOTE_HOOK_SOURCE_ID_PATTERN = /^[0-9a-f]{16}$/;

function hex32(value: number): string {
	return (value >>> 0).toString(16).padStart(8, '0');
}

/**
 * この PC の印。Electron の machineId（既にハッシュ済みの値）をもう一度混ぜてから縮める。
 * machineId をそのまま接続先のファイル名にしない（接続先の他の利用者から見える場所に置くため）。
 *
 * @returns 組み立てられない（machineId が無い：Web など）ときは undefined。呼び出し側は共有の
 *   ポートファイルを使う
 */
export function paradisRemoteHookSourceId(machineId: string | undefined): string | undefined {
	if (typeof machineId !== 'string' || machineId.length === 0) {
		return undefined;
	}
	const seed = `para-code-remote-hook-source:${machineId}`;
	return hex32(stringHash(seed, 0x5bd1e995)) + hex32(stringHash(seed, 0x27d4eb2f));
}

/** 接続先の `~/.para-code`（末尾の `/` 無し）から、その PC のポートファイルのパスを作る。 */
export function paradisRemoteHookPortFilePath(remoteParaCodeDirectory: string, sourceId: string): string {
	return `${remoteParaCodeDirectory}/${PARADIS_REMOTE_HOOK_PORTS_DIR_NAME}/${sourceId}.json`;
}
