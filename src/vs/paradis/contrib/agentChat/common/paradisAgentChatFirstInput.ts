/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

// 会話がまだ見つからないペイン（最初の指示なしで起こした Bot の会話）へ、最初の 1 文を送るときの待ち。
// Claude Code も Codex も最初の発言まで会話の記録を作らないので、チャット表示は会話を待つ間も入力欄から送れるようにし、
// 送るのはエージェントの入力欄の準備ができてから（TUI が前面にいて、貼り付けのモードを有効にした後）にする。

/** 準備を待つ上限。 */
export const PARADIS_AGENT_FIRST_INPUT_TIMEOUT_MS = 60_000;
/** 準備を見直す間隔。 */
const POLL_MS = 250;

/** エージェントの入力欄が最初の 1 文を受け取れるか（前面がエージェントで、TUI が貼り付けのモードを有効にした）。 */
export function paradisAgentReadyForFirstInput(foreground: 'agent' | 'shell' | 'unknown', bracketedPasteMode: boolean): boolean {
	return foreground === 'agent' && bracketedPasteMode;
}

/**
 * 準備ができるまで待つ。準備ができたら true、前面がシェルに戻った（エージェントが終わった）・時間切れ・やめたら false。
 * `wait` はテストで差し替える。
 */
export async function paradisWaitForAgentFirstInput(
	probe: () => { readonly foreground: 'agent' | 'shell' | 'unknown'; readonly bracketedPasteMode: boolean } | undefined,
	timeoutMs = PARADIS_AGENT_FIRST_INPUT_TIMEOUT_MS,
	wait: (ms: number) => Promise<void> = ms => new Promise(resolve => setTimeout(resolve, ms)),
): Promise<boolean> {
	let waited = 0;
	// 起動の直後はまだシェルが前面のことがあるので、シェルで諦めるのは一度エージェントが前面に出た後だけ
	let sawAgent = false;
	while (waited <= timeoutMs) {
		const state = probe();
		if (state === undefined) {
			return false;
		}
		if (paradisAgentReadyForFirstInput(state.foreground, state.bracketedPasteMode)) {
			return true;
		}
		if (state.foreground === 'agent') {
			sawAgent = true;
		} else if (state.foreground === 'shell' && sawAgent) {
			return false;
		}
		await wait(POLL_MS);
		waited += POLL_MS;
	}
	return false;
}
