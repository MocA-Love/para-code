/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

// ペインのタブを読む・操作する入口で、接続元がほかのペインの中のプロセスでないかを確かめる決まり（純関数）。
//
// ペインのトークンは環境変数（PARA_CODE_TERMINAL_PANE_ID）で渡すので、同じ利用者のプロセスなら `ps -wwE` で
// ほかのペインのトークンも読める。トークンだけで通すと、ほかのペインのタブ（利用者が共有したログイン済みのページ、
// そのペインが開いたタブ）を読める・操作できる。そこで次の 2 つの入口で、接続を持つプロセスの祖先を調べ、
// 名乗ったペインとは別の（手元の）ペインのシェルの子孫だと分かったら断る:
//   - MCP の `tools/call`（para CLI も同じ口）: ブラウザの道具・内蔵 chrome-devtools-mcp の道具・サイトのメモと手順
//   - CDP ゲートウェイ（`?pane=`、`?tab=`、接続元からの解決のすべて）
// どのペインの子孫でもない（tmux などで端末から切り離したプロセス、WSL・SSH の戻り経路、Para Code が起こした
// chrome-devtools-mcp の子）・確かめが取れないときは、今までどおり通す（今使えている操作を壊さない）。
// したがって、二重の fork などでペインの外へ出たプロセスからのなりすましは塞げない。祖先は PID の表だけでたどる
// （環境変数は子プロセスが書き換えられる）。#1266 の制限するペインの追加の守り（paradisConfinedPaneCaller.ts）と同じ考え。

import type { ParadisPeerKind } from './paradisCdpPeerResolver.js';

/**
 * para-browser の道具のうち、ブラウザのタブに触れないので接続元を確かめずに通すもの（固定の大きさの一覧、
 * ファイルのプレビュー、スペースのメモ）。ここで扱うのはブラウザのタブの分離だけ。
 */
const PARADIS_TOOLS_WITHOUT_CALLER_CHECK: ReadonlySet<string> = new Set([
	'list_viewports', 'preview_file',
	'list_space_notes', 'read_space_note', 'write_space_note', 'add_space_note_task', 'check_space_note_task', 'delete_space_note_task',
]);

/** 道具がどこのものか（呼び出し側が調べて渡す）。 */
export interface IParadisToolOwnership {
	/** para-browser 自身の道具（`TOOLS`）。 */
	readonly local: boolean;
	/** 登録されたプロバイダ（IDE の操作・Bot・モバイルなど）の道具。これらは各自で `classifyCaller` を使う。 */
	readonly provider: boolean;
}

/**
 * この道具の呼び出しで、接続元がほかのペインの中のプロセスでないかを確かめるか。para-browser 自身の道具と、
 * どのプロバイダのものでもない道具（内蔵 chrome-devtools-mcp の道具、サイトのメモ・手順）は確かめる。
 * プロバイダの道具は各自の決まりに任せる。
 */
export function paradisToolNeedsPaneCaller(name: string, ownership: IParadisToolOwnership): boolean {
	if (name.length === 0 || PARADIS_TOOLS_WITHOUT_CALLER_CHECK.has(name)) {
		return false;
	}
	return ownership.local || !ownership.provider;
}

/** 照合に使うペインの 1 件（サーバーが同期で受けたシェルの PID）。 */
export interface IParadisPaneShellOfCaller {
	readonly token: string;
	readonly shellPid: number | undefined;
	/** SSH など接続先のペインなら接続先。このときの `shellPid` は手元のプロセスではないので使わない。 */
	readonly remoteAuthority?: string;
}

/**
 * 名乗ったペイン `claimedPaneToken` 以外の、手元のペインのシェルの PID（重複なし、昇順）。接続元がこのどれかの
 * 子孫なら、ほかのペインの中のプロセスがトークンを名乗ったと分かる。
 */
export function paradisOtherPaneShellPids(claimedPaneToken: string, panes: Iterable<IParadisPaneShellOfCaller>): number[] {
	const claimed = new Set<number>();
	const others = new Set<number>();
	for (const pane of panes) {
		if (pane.remoteAuthority !== undefined || pane.shellPid === undefined || !Number.isSafeInteger(pane.shellPid) || pane.shellPid <= 1) {
			continue;
		}
		(pane.token === claimedPaneToken ? claimed : others).add(pane.shellPid);
	}
	// 同じシェルを名乗ったペインも持つなら（同期の入れ替わりの途中など）、照合から外す
	return [...others].filter(pid => !claimed.has(pid)).sort((a, b) => a - b);
}

/** 照合の結果から、ほかのペインからのなりすましとして断るか。子孫だと分かったときだけ断る。 */
export function paradisIsOtherPaneCaller(kind: ParadisPeerKind): boolean {
	return kind === 'descendant';
}
