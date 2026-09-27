/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

// ターミナル（エージェントの TUI かシェル）へ、プログラムから安全に文字を送る部品。
// IDE 操作ツール（O1）が使い、定期実行（O3）などエージェントへ指示を入れる機能からも使えるよう
// ここに切り出している。決まり:
//  - 制御文字は落とす（paradisAgentIdeSanitizeInput）。改行だけ残す
//  - 貼り付けの囲み（bracketed paste）を受け付けない相手へ複数行は送らない（行ごとに実行されるため）
//  - Enter は貼り付けと分け、間に `validate` で相手がまだ送ってよい状態かを確かめる
//    （許可待ち・質問に変わっていたら Enter を送らない）

import type { ITerminalInstance } from '../../../../workbench/contrib/terminal/browser/terminal.js';
import { paradisSendAgentMessageToTui } from '../../mobileRelay/common/paradisAgentMessageSender.js';
import { paradisAgentIdeSanitizeInput } from '../common/paradisAgentIde.js';

export type ParadisTerminalInputOutcome =
	| { readonly kind: 'sent'; readonly pressedEnter: boolean }
	/** 複数行を、貼り付けの囲みを受け付けない相手へ送ろうとした（何も送っていない）。 */
	| { readonly kind: 'multilineRefused' }
	/** 送る前に `validate` が偽になった（何も送っていない）。 */
	| { readonly kind: 'invalidBeforeSend' }
	/** 文字は入れたが、Enter の前に `validate` が偽になった（Enter は送っていない）。 */
	| { readonly kind: 'typedButNotSubmitted' };

/**
 * ターミナルへ文字を送る。`pressEnter` は呼び出し側が必ず決める（既定値を持たせない）。
 * @param validate 送る直前と Enter の直前に呼ぶ。偽なら送らない。
 */
export async function paradisSendTextToTerminal(
	instance: Pick<ITerminalInstance, 'sendText' | 'xterm'>,
	text: string,
	pressEnter: boolean,
	validate: () => Promise<boolean>,
): Promise<ParadisTerminalInputOutcome> {
	const sanitized = paradisAgentIdeSanitizeInput(text);
	if (sanitized.includes('\n') && instance.xterm?.raw.modes.bracketedPasteMode !== true) {
		return { kind: 'multilineRefused' };
	}
	const sendText = (value: string, execute?: boolean, bracketedPasteMode?: boolean) => instance.sendText(value, execute ?? false, bracketedPasteMode);
	if (!pressEnter) {
		if (!(await validate())) {
			return { kind: 'invalidBeforeSend' };
		}
		await sendText(sanitized, false, true);
		return { kind: 'sent', pressedEnter: false };
	}
	if (sanitized.length === 0) {
		if (!(await validate())) {
			return { kind: 'invalidBeforeSend' };
		}
		await sendText('\r', false, false);
		return { kind: 'sent', pressedEnter: true };
	}
	const outcome = await paradisSendAgentMessageToTui(sanitized, sendText, validate);
	if (outcome.executed) {
		return { kind: 'sent', pressedEnter: true };
	}
	return outcome.consumed ? { kind: 'typedButNotSubmitted' } : { kind: 'invalidBeforeSend' };
}
