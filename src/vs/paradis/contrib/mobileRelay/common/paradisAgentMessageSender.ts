/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import { paradisStripAgentInvisibleCharacters } from './paradisAgentInvisibleText.js';

type SendText = (text: string, execute?: boolean, bracketedPasteMode?: boolean) => Promise<void>;

function delayForTuiPaste(): Promise<void> {
	return new Promise(resolve => setTimeout(resolve, 250));
}

/**
 * TUIの貼付け確定とEnterを分離し、待機中に対象が変わった場合は実行しない。
 * 目に見えない文字は貼る前に落とす（Claude Code はそれがあると Enter で送らず確認を出すため）。
 * Codex 0.163.0 からは、作業中に送った発言が書きかけの応答をその場で打ち切る（`instant_interrupt` が既定。打ち切られた
 * 応答は rollout に残らず、発言は同じターンの 2 つ目の依頼になる。2026-10-16 に実測）。Codex の既定に任せる。
 */
export async function paradisSendAgentMessageToTui(
	text: string,
	sendText: SendText,
	validate: () => Promise<boolean>,
	delay: () => Promise<void> = delayForTuiPaste,
): Promise<{ readonly consumed: boolean; readonly executed: boolean }> {
	if (!(await validate())) { return { consumed: false, executed: false }; }
	await sendText(paradisStripAgentInvisibleCharacters(text), false, true);
	await delay();
	if (!(await validate())) { return { consumed: true, executed: false }; }
	await sendText('\r', false, false);
	return { consumed: true, executed: true };
}
