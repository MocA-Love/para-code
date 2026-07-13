/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

type SendText = (text: string, execute?: boolean, bracketedPasteMode?: boolean) => Promise<void>;

function delayForTuiPaste(): Promise<void> {
	return new Promise(resolve => setTimeout(resolve, 250));
}

/** TUIの貼付け確定とEnterを分離し、待機中に対象が変わった場合は実行しない。 */
export async function paradisSendAgentMessageToTui(
	text: string,
	sendText: SendText,
	validate: () => Promise<boolean>,
	delay: () => Promise<void> = delayForTuiPaste,
): Promise<{ readonly consumed: boolean; readonly executed: boolean }> {
	if (!(await validate())) { return { consumed: false, executed: false }; }
	await sendText(text, false, true);
	await delay();
	if (!(await validate())) { return { consumed: true, executed: false }; }
	await sendText('\r', false, false);
	return { consumed: true, executed: true };
}
