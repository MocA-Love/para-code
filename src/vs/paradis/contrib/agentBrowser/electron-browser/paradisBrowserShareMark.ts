/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import { BrowserViewSharingState } from '../../../../workbench/contrib/browserView/common/browserView.js';

/**
 * ページの共有の印（upstream の agent audience）が外されたかどうか。`Available` だけを「外された」と読む。
 * `Unavailable` は Copilot のチャットが一時的に使えない（起動の途中・拡張機能の再起動）だけで印は残っており、
 * `BlockedByNetworkPolicy` はネットワークの制限で、どちらも共有や許可を外す理由にしない（ネットワークの制限は
 * バインディングモデルが別に外す）。
 */
export function paradisIsShareMarkRemoved(state: BrowserViewSharingState): boolean {
	return state === BrowserViewSharingState.Available;
}
