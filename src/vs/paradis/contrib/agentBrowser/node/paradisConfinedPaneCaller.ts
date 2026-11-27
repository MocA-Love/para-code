/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

// 制限するペイン（Bot のペインなど）の中のプロセスが、ほかのペインのトークンを名乗って para-browser の道具を呼んだかを見分ける。
// トークンは環境変数で渡すので、同じ利用者のプロセスは `ps -wwE` でほかのペインのトークンを読める。Bot の制限を持つ道具
// （IDE の操作・Bot の管理・定期実行・ask_human）は、名乗ったペインのシェルの子孫かを確かめてから動く（classifyCaller）ので
// 盗んだトークンでは通らないが、確かめない道具もある。そこで、接続元の祖先に制限するペインのシェルがあり、名乗ったトークンが
// そのペインのものでなければ、呼び出しごと断る。祖先はシェルの PID の表だけでたどる（環境変数は子プロセスが書き換えられる）。
//
// 確かめられないとき（接続元が取れない・シェルの PID が分からない・SSH などの接続先のペイン）は断らない（今の動きのまま）。
// 祖先を切る（二重の fork で launchd の子になる）と見分けられないので、これは Bot の制限そのものではなく、確かめない道具への
// 追加の守りとして扱う。

import type { ParadisPeerKind } from './paradisCdpPeerResolver.js';
import type { IParadisMcpConfinedPanes } from '../common/paradisMcpToolProvider.js';

/** 照合に使うペインの 1 件（サーバーが同期で受けたシェルの PID）。 */
export interface IParadisConfinedPaneShell {
	readonly token: string;
	readonly shellPid: number;
	/** SSH など接続先のペインなら接続先。このときの `shellPid` は手元のプロセスではないので使わない。 */
	readonly remoteAuthority?: string;
}

export const PARADIS_CONFINED_PANE_IMPERSONATION_MESSAGE = 'This call came from a process inside a Para Code bot\'s terminal but used another terminal\'s identity (PARA_CODE_TERMINAL_PANE_ID). Para Code refuses it. Call the tools from your own terminal without changing that variable.';

/**
 * 名乗ったトークン `claimedToken` 以外の、制限するペインの手元のシェルの PID（重複なし、昇順）。
 * 制限するペインが無ければ空。
 */
export async function paradisConfinedShellPids(claimedToken: string, panes: Iterable<IParadisConfinedPaneShell>, sources: readonly IParadisMcpConfinedPanes[]): Promise<number[]> {
	if (sources.length === 0) {
		return [];
	}
	const pids = new Set<number>();
	for (const pane of panes) {
		if (pane.token === claimedToken || pane.remoteAuthority !== undefined || !Number.isSafeInteger(pane.shellPid) || pane.shellPid <= 1) {
			continue;
		}
		for (const source of sources) {
			if (await source.isConfined(pane.token)) {
				pids.add(pane.shellPid);
				break;
			}
		}
	}
	return [...pids].sort((a, b) => a - b);
}

/**
 * 接続元が、名乗ったトークン以外の制限するペインのシェルの子孫か。`classify` は接続元を `ancestorPids` と照合する
 * （paradisClassifyPeer）。子孫と確かめられたときだけ true（確かめられなければ false＝今の動きのまま）。
 */
export async function paradisCallerIsFromConfinedPane(
	claimedToken: string,
	panes: Iterable<IParadisConfinedPaneShell>,
	sources: readonly IParadisMcpConfinedPanes[],
	classify: (ancestorPids: readonly number[]) => Promise<ParadisPeerKind>,
): Promise<boolean> {
	const pids = await paradisConfinedShellPids(claimedToken, panes, sources);
	if (pids.length === 0) {
		return false;
	}
	try {
		return await classify(pids) === 'descendant';
	} catch {
		return false;
	}
}
