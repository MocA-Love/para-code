/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

// Para Code が止まっている間の完了を控えから流し直したペイン（W2-20）。「確認待ち」の印は出すが、
// 完了の通知（デスクトップの音・モバイルのプッシュ）は出さない。状態のスナップショットを配る側が、
// 受け手へ配る前にここを書き換えるので、受け手はいつも同じ回の値を読む。

import { IParadisAgentPaneStatus } from '../common/paradisAgentBrowser.js';

let quietPanes: ReadonlySet<string> = new Set();

/** スナップショットを受け手へ配る直前に呼ぶ。 */
export function paradisRememberQuietReplayedPanes(statuses: readonly IParadisAgentPaneStatus[]): void {
	quietPanes = new Set(statuses.filter(status => status.quiet === true && status.status === 'review').map(status => status.token));
}

/** そのペインの「確認待ち」は、流し直したもの（鳴らさない）か。 */
export function paradisIsQuietReplayedPane(token: string | undefined): boolean {
	return token !== undefined && quietPanes.has(token);
}
