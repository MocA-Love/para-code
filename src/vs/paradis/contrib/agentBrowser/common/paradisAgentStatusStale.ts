/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

/** Stop後のバックグラウンド補正が取り残された場合だけ完了へ降格するまでの時間。 */
const PARADIS_BACKGROUND_COMPLETION_STALE_MS = 15 * 60 * 1000;

/** 長時間の通常ツールを除外し、取り残されたバックグラウンド補正だけを降格する。 */
export function paradisShouldSweepStaleWorkingStatus(status: string, backgroundCompletionFallback: boolean | undefined, changedAt: number, now: number): boolean {
	return status === 'working' && backgroundCompletionFallback === true && now - changedAt > PARADIS_BACKGROUND_COMPLETION_STALE_MS;
}
