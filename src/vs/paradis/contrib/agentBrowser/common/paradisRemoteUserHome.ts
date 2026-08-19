/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import { Schemas } from '../../../../base/common/network.js';
import { URI } from '../../../../base/common/uri.js';

/**
 * 「接続先のホーム」を、本当に接続先のものだと確かめてから返す。解決できていなければ undefined。
 *
 * `IPathService.userHome()` は接続先の環境が取れないと**黙って手元のホームを返す**
 * （`pathService.ts` の `env?.userHome ?? localUserHome`）。接続先へ置くもの・書くものの
 * 宛先にこれをそのまま使うと、解決できていない間だけ書き先が手元にすり替わる。
 *
 * 実際に踏んだ（2026-08-19）: 接続先へのサーバー導入に失敗して環境が解決できないまま、
 * ssh -R だけは張れて番号が取れたため、手元の `~/.claude.json` と `~/.codex/config.toml` の
 * para-browser が接続先の番号を指すよう書き換わり、手元のエージェントから MCP へ繋がらなく
 * なった。接続先の番号は接続先の 127.0.0.1 でしか意味を持たないので、宛先を取り違えた時点で
 * 必ず壊れる。「接続中かどうか」ではなく「今このホームが接続先を指しているか」で判定すること。
 *
 * @param remoteAuthority このウィンドウの接続先（`IWorkbenchEnvironmentService.remoteAuthority`）。
 * @param userHome `IPathService.userHome()` の結果。
 */
export function paradisRemoteUserHome(remoteAuthority: string | undefined, userHome: URI): URI | undefined {
	if (remoteAuthority === undefined
		|| userHome.scheme !== Schemas.vscodeRemote
		// 接続先の環境は、こちらが送った authority をそのまま焼き込んだ URI で返ってくる
		// （`uriTransformer.ts` の transformOutgoing）。別物なら接続先のホームではない
		|| userHome.authority.toLowerCase() !== remoteAuthority.toLowerCase()
	) {
		return undefined;
	}
	return userHome;
}
