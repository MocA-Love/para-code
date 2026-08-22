/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

// 配置を常駐へ預ける側の入り口。`ptyService.ts` から1行で呼べる形にしてある。
//
// 常駐を使っていないときは**何もしない**。使っていない機能のために、配置を書くたびに
// 余計なことが起きるのは避ける。

import { ISetTerminalLayoutInfoArgs } from '../../../../platform/terminal/common/terminalProcess.js';
import { paradisEncodeLayout } from './paradisTerminalLayout.js';
import { paradisHandleOf, paradisPtyDaemonConnection } from './paradisTerminalProcessFactory.js';

/**
 * 配置を常駐へ預ける。
 *
 * 失敗は飲む。配置が預けられなかったことを、配置を変えられないことにしない。
 */
export function paradisRememberLayout(args: ISetTerminalLayoutInfoArgs): void {
	const connection = paradisPtyDaemonConnection();
	if (!connection) {
		return;
	}
	const encoded = paradisEncodeLayout(args, paradisHandleOf);
	// **常駐の端末が1本も無いなら、空として送って忘れさせる。** そうしないと、常駐が持つ配置は
	// 増える一方になる（スペースを消しても常駐はそれを知らない）。`{"tabs":[]}` をそのまま
	// 送っても「中身の無い配置」として残り続けるだけなので、**掃除の合図は空文字にする**。
	const holdsNothing = JSON.parse(encoded).tabs.length === 0;
	connection.host.setLayout(args.workspaceId, holdsNothing ? '' : encoded).catch(() => { });
}
