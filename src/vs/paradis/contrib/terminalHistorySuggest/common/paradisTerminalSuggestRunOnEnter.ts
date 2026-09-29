/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

// 補完の候補を Enter で確定したときに、そのまま実行するか（Q137）。
//
// Para Code は `terminal.integrated.suggest.runOnEnter` の既定を `always` にしている
// （履歴の候補を Enter ですぐ実行するため）。ただ `always` のままだと、パスやフォルダの候補も
// 確定と同時に実行されてしまい、続きを打てない。そこで `always` のときにすぐ実行するのは
// Para Code の履歴の候補だけにし、ほかの候補は入力欄に入れるだけにする。
// `exactMatch` などを選んでいる場合は upstream の判断をそのまま使う。

/** Para Code の履歴の候補を出す提供元の id。候補の `provider` にこの値が入る。 */
export const PARADIS_TERMINAL_HISTORY_PROVIDER_ID = 'para.terminalHistory';

/**
 * 候補を Enter で確定したときに実行するか。
 *
 * @param runOnEnterConfig `terminal.integrated.suggest.runOnEnter` の値
 * @param upstreamDecision upstream が設定から決めた値
 * @param completion 確定した候補
 */
export function paradisResolveRunOnEnter(runOnEnterConfig: string | undefined, upstreamDecision: boolean, completion: { readonly provider: string }): boolean {
	if (runOnEnterConfig === 'always') {
		return completion.provider === PARADIS_TERMINAL_HISTORY_PROVIDER_ID;
	}
	return upstreamDecision;
}
