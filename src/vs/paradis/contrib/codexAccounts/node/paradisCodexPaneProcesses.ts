/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-PATCH/PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

// ターミナルのシェルの下で Codex が動いているかを、プロセス表で見分ける（shared process）。
//
// アカウントを切り替えたとき「前のアカウントのまま動いている Codex」を数えるのに使う。画面側の
// シェル統合（実行中のコマンド）とプロセス名だけでは、次の場合に取りこぼす。
// - 再読み込みの後に再接続したペイン（実行中のコマンドが残っていない）
// - npm 版の codex（前面のプロセス名は `node`）
// - `echo …; codex` のように、行の先頭が codex でない
// プロセスの起動行の判定は、hook の所有者の判定と同じ `paradisHookAgentKindFromCommandLine` を使う
// （`node …/bin/codex.js`・vendor の本体・Para Code のランチャーを Codex と判定する）。

import { IParadisHookProcessInfo, paradisHookAgentKindFromCommandLine } from '../../agentBrowser/node/paradisAgentHookOwnership.js';

/** シェルの下をたどる深さの上限（tmux・ラッパーを挟んでも届く程度）。 */
const MAX_DEPTH = 12;
/** 1回に調べるシェルの数の上限。 */
export const PARADIS_CODEX_PANE_SHELLS_MAX = 500;

/**
 * `shellPids` のうち、子孫のどこかで Codex が動いているシェルの pid を返す（渡した順）。
 * プロセス表が取れなければ空（呼び出し側は画面側の判定だけで数える）。
 */
export function paradisShellsRunningCodex(shellPids: readonly number[], snapshot: ReadonlyMap<number, IParadisHookProcessInfo> | undefined): number[] {
	if (snapshot === undefined) {
		return [];
	}
	const children = new Map<number, number[]>();
	for (const info of snapshot.values()) {
		if (info.ppid === undefined || info.ppid === info.pid) {
			continue;
		}
		let list = children.get(info.ppid);
		if (list === undefined) {
			list = [];
			children.set(info.ppid, list);
		}
		list.push(info.pid);
	}
	const isCodex = (pid: number) => {
		const command = snapshot.get(pid)?.command;
		return command !== undefined && paradisHookAgentKindFromCommandLine(command) === 'codex';
	};
	const result: number[] = [];
	for (const shellPid of shellPids) {
		const seen = new Set<number>([shellPid]);
		let frontier = children.get(shellPid) ?? [];
		let found = false;
		for (let depth = 0; depth < MAX_DEPTH && frontier.length > 0 && !found; depth++) {
			const next: number[] = [];
			for (const pid of frontier) {
				if (seen.has(pid)) {
					continue;
				}
				seen.add(pid);
				if (isCodex(pid)) {
					found = true;
					break;
				}
				next.push(...(children.get(pid) ?? []));
			}
			frontier = next;
		}
		if (found) {
			result.push(shellPid);
		}
	}
	return result;
}
