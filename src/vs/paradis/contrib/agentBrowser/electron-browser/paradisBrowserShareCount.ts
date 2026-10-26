/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

// 内蔵ブラウザのツールバーの共有のボタンに出す数。ボタンの描画（paradisBrowserShareButton.ts）と、エディタごとの
// 共有中の context key（paradisBrowserShareState.ts）が同じ数え方を使う。CSS を読み込まないよう、ボタンとは別のファイルに置く。

import { BrowserViewSharingState } from '../../../../workbench/contrib/browserView/common/browserView.js';
import { IParadisPageShare } from './paradisAgentBrowserBindingModel.js';

/**
 * ボタンと一覧に出すもの。para-browser の台帳のペインと、Copilot だけと共有しているか（台帳に無いのに共有の印が付いて
 * いる。台帳にペインがあるときは、印はそのために付いたものとして数えない）。
 */
export interface IParadisShareButtonEntries {
	readonly shares: readonly IParadisPageShare[];
	readonly copilot: boolean;
}

/** ページの共有と共有の印から、ボタンと一覧に出すものを作る。 */
export function paradisShareButtonEntries(shares: readonly IParadisPageShare[], sharingState: BrowserViewSharingState | undefined): IParadisShareButtonEntries {
	return { shares, copilot: shares.length === 0 && sharingState === BrowserViewSharingState.Shared };
}

/** ボタンに出す数。 */
export function paradisShareButtonCount(entries: IParadisShareButtonEntries): number {
	return entries.shares.length + (entries.copilot ? 1 : 0);
}
