/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

// 外部 CLI を起こす fork の node 層(ccusage / rtk / limitsMonitor)が共有する、子プロセスの止め方。
//
// Windows では npm 由来の .cmd/.bat シムを `cmd.exe /d /s /c` でラップして起動している
// (`vs/paradis/common/paradisWindowsScriptShim.ts`)。そのため `ChildProcess` は cmd.exe であり、
// `child.kill()` は cmd.exe しか終わらせない——その先で走っている実体(node / codex 等)は
// 孤児として残り続ける。長く生きるプロセスほど効いてくるので、ツリーごと落とす。

import * as cp from 'child_process';
import { killTree } from '../../base/node/processes.js';

/**
 * 子プロセスを終了させる。Windows ではプロセスツリーごと落とし、失敗したときだけ
 * `child.kill()` へ落とす(既に死んでいる場合もここへ来るが、二重に止めても無害)。
 *
 * `killTree` は Windows で絶対パスの `taskkill.exe` を `/T /F` で叩く既存実装
 * (`vs/base/node/processes.ts`)。`paradisMcpSetup.ts` も同じものを使っている。
 *
 * @param onError 失敗を記録したい呼び出し元向け(ログサービスは層をまたぐのでここでは持たない)
 */
export function paradisKillChildProcessTree(child: cp.ChildProcess, onError?: (error: unknown) => void): void {
	const killDirectly = () => {
		try {
			child.kill();
		} catch (error) {
			onError?.(error);
		}
	};

	const pid = child.pid;
	if (process.platform !== 'win32' || typeof pid !== 'number') {
		killDirectly();
		return;
	}
	// 既に終わっている子へ pid で taskkill を撃つと、Windows が同じ pid を再利用していた場合に
	// 無関係のプロセスツリーを落としうる。窓は極めて狭いが、撃つ必要も無いので撃たない。
	if (child.exitCode !== null || child.signalCode !== null) {
		return;
	}

	killTree(pid, true).catch(error => {
		onError?.(error);
		killDirectly();
	});
}
