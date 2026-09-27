/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

// 常駐ターミナルの仕組みがプロセス間で受け渡す環境変数のうち、**シェルへ渡してはいけないもの**。
//
// これらは「どこに常駐を置くか」「自分は常駐として起きたのか」を伝えるためだけの値で、
// シェルやその子には意味が無い。それどころか、シェルに残っていると**そこから起動した別の
// Para Code（開発版など）が同じ値を継ぎ**、製品版の常駐に自分のターミナルを作りに行く
// （2026-09-27 に実際に起きた。製品版のターミナルで `./scripts/code.sh` を叩いた開発版が、
// 製品版の `~/Library/Application Support/Para Code` の常駐へ繋いだ）。
//
// ペイントークン（`PARA_CODE_TERMINAL_PANE_ID`）や MCP のポートファイル
// （`PARA_CODE_MCP_PORT_FILE`）のように、シェルの中のエージェントが読むために入れているものは
// ここに**入れない**。

import { IProcessEnvironment } from '../../../../base/common/platform.js';
import { PARADIS_PTY_DAEMON_BUILD_ID, PARADIS_PTY_DAEMON_BUILD_KEY, PARADIS_PTY_DAEMON_LEDGER, PARADIS_PTY_DAEMON_SOCKET } from './paradisPtyDaemonEnv.js';
import { PARADIS_PTY_HOST_STATE_DIR } from './paradisPtyHostPaths.js';

/** シェルへ渡さない、常駐ターミナルの内部用の環境変数。 */
export const PARADIS_PTY_SHELL_EXCLUDED_ENV_KEYS: readonly string[] = [
	PARADIS_PTY_HOST_STATE_DIR,
	PARADIS_PTY_DAEMON_SOCKET,
	PARADIS_PTY_DAEMON_LEDGER,
	PARADIS_PTY_DAEMON_BUILD_ID,
	PARADIS_PTY_DAEMON_BUILD_KEY,
];

/**
 * シェルへ渡す環境から内部用の変数を除いたものを返す。
 *
 * 含まれていなければ受け取ったものをそのまま返す（ほとんどの場合はこちら）。含まれていれば
 * 写しを作って除く。**受け取ったものは書き換えない**: 呼び出し側はこれを永続ターミナルの
 * 起動情報として持ち続けることがある。
 */
export function paradisWithoutPtyDaemonEnv(env: IProcessEnvironment): IProcessEnvironment {
	if (!PARADIS_PTY_SHELL_EXCLUDED_ENV_KEYS.some(key => Object.prototype.hasOwnProperty.call(env, key))) {
		return env;
	}
	const copy: IProcessEnvironment = { ...env };
	for (const key of PARADIS_PTY_SHELL_EXCLUDED_ENV_KEYS) {
		delete copy[key];
	}
	return copy;
}

/**
 * 受け継いだ内部用の変数を `env` から**その場で**消す。消した名前を返す。
 *
 * main プロセスが起動時に呼ぶ。Para Code のターミナルから起動された別の Para Code
 * （開発版など）は、親のシェルに残っていた値を `process.env` に持ったまま起きることがある。
 * それを放っておくと、main が起こす pty ホスト・拡張ホスト・shared process のすべてへ流れ、
 * 自分のものではない常駐へ繋ぎに行く。main 自身はこれらの値を読まない（必要な値は起こす
 * 瞬間にだけ渡す）ので、最初に消してしまってよい。
 */
export function paradisDeletePtyDaemonEnv(env: { [key: string]: string | undefined }): readonly string[] {
	const removed: string[] = [];
	for (const key of PARADIS_PTY_SHELL_EXCLUDED_ENV_KEYS) {
		if (Object.prototype.hasOwnProperty.call(env, key)) {
			delete env[key];
			removed.push(key);
		}
	}
	return removed;
}
