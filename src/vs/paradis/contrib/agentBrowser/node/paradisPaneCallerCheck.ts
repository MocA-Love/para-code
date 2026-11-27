/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

// ペインのタブを読む・操作する入口で、接続元が名乗ったペインの中のプロセスかを確かめる決まり（純関数）。
//
// ペインのトークンは環境変数（PARA_CODE_TERMINAL_PANE_ID）で渡すので、同じ利用者のプロセスなら `ps -wwE` で
// ほかのペインのトークンも読める。トークンだけで通すと、ほかのペインのタブ（利用者が共有したログイン済みのページ、
// そのペインが開いたタブ）を読める・操作できる。そこで次の 2 つの入口で、接続を持つプロセスを調べる:
//   - MCP の `tools/call`（para CLI も同じ口）: ブラウザの道具・内蔵 chrome-devtools-mcp の道具は、名乗ったペインの
//     シェルの子孫（SSH の接続先のペインなら Para Code が張った戻り経路の `ssh -R`）からだけ通す
//   - CDP ゲートウェイ（`?pane=`、`?tab=`、接続元からの解決のすべて）: 上に加えて、そのペインのために Para Code が
//     起こした chrome-devtools-mcp の子（シェルの子孫ではない）を通す
// 確かめられないとき（接続元が取れない・ペインのシェルが分からない）は断る。

import type { IParadisPeerExpectation, ParadisPeerKind } from './paradisCdpPeerResolver.js';

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
 * この道具の呼び出しで、接続元が名乗ったペインの中のプロセスかを確かめるか。para-browser 自身の道具と、
 * どのプロバイダのものでもない道具（内蔵 chrome-devtools-mcp の道具、サイトのメモ・手順）は確かめる。
 * プロバイダの道具は各自の決まりに任せる。
 */
export function paradisToolNeedsPaneCaller(name: string, ownership: IParadisToolOwnership): boolean {
	if (name.length === 0 || PARADIS_TOOLS_WITHOUT_CALLER_CHECK.has(name)) {
		return false;
	}
	return ownership.local || !ownership.provider;
}

/** CDP ゲートウェイの照合に使う、ペインの情報。 */
export interface IParadisGatewayPaneShell {
	readonly shellPid: number | undefined;
	/** SSH など接続先のペインなら接続先。このときの `shellPid` は手元のプロセスではないので使わない。 */
	readonly remoteAuthority?: string;
}

/**
 * CDP ゲートウェイの接続元の照合の期待値。手元のペインはシェルの子孫、接続先のペインは戻り経路の `ssh -R`。
 * どちらでも、そのペインのために起こした chrome-devtools-mcp の子（`devtoolsChildPids`）を通す。
 * ペインが分からず子も無ければ undefined（照合せずに断る）。
 */
export function paradisGatewayPeerExpectation(pane: IParadisGatewayPaneShell | undefined, devtoolsChildPids: readonly number[], tunnelPids: readonly number[]): IParadisPeerExpectation | undefined {
	const ancestorPids = new Set<number>(devtoolsChildPids.filter(pid => Number.isSafeInteger(pid) && pid > 1));
	if (pane !== undefined && pane.remoteAuthority === undefined && pane.shellPid !== undefined && Number.isSafeInteger(pane.shellPid) && pane.shellPid > 1) {
		ancestorPids.add(pane.shellPid);
	}
	const tunnels = pane?.remoteAuthority !== undefined ? tunnelPids : [];
	if (ancestorPids.size === 0 && tunnels.length === 0) {
		return undefined;
	}
	return { ancestorPids: [...ancestorPids].sort((a, b) => a - b), tunnelPids: [...tunnels] };
}

/** 照合の結果から、CDP ゲートウェイを使わせるか。`tunnel` は接続先のペインのときだけ。 */
export function paradisGatewayPeerAllowed(kind: ParadisPeerKind, pane: IParadisGatewayPaneShell | undefined): boolean {
	return kind === 'descendant' || (kind === 'tunnel' && pane?.remoteAuthority !== undefined);
}
