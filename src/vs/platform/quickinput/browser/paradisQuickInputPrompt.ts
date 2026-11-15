/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

// 一覧の無い入力（InputBox）の説明文から、本家が後ろに足す「('Enter' を押して確認するか 'Escape' を押して取り消します)」と、
// prompt が無いときの「'Enter' を押して入力を確認するか…」を外す（Q653 の案 B）。中央のパレットでは Enter・Esc が下端の
// ヒントの帯（vs/paradis の paradisQuickInputLook.ts）にあり、説明文と重複するため。
// 本家の quickInput.ts の QuickInput.update（説明文を描く所）から PARA-PATCH 1 点で呼ぶ。update は show の後にも毎回走るので、
// anchor・ignoreFocusOut を prompt より後に入れる呼び出し側でも判定がずれない。validation のエラーは本家どおり先に勝つ。
// ヒントの帯は workbench の contribution が付けるので、帯を付ける側が旗を立てる（standalone のエディタや帯の無い窓では
// 本家の文言のまま）。ここは vs/paradis を import しない。

import { IDisposable, toDisposable } from '../../../base/common/lifecycle.js';
import { IInputBox, IQuickInput, QuickInputType } from '../common/quickInput.js';
import { paradisIsCenteredQuickInputPlacement } from './paradisQuickInputLayout.js';

let keyHintsPresent = false;

/** 中央のパレットに Enter・Esc のヒントの帯を付けることを知らせる（帯を付ける contribution が起動時に呼ぶ）。 */
export function paradisSetQuickInputKeyHintsPresent(): IDisposable {
	keyHintsPresent = true;
	return toDisposable(() => keyHintsPresent = false);
}

/**
 * 説明文に出す既定の文言（validation のエラーが無いとき）。中央の InputBox でヒントの帯があるときは prompt だけ
 * （prompt が無ければ説明文は空）、それ以外は本家の文言 `upstream` を返す。
 */
export function paradisQuickInputNoValidationMessage(input: IQuickInput, upstream: string | undefined): string | undefined {
	if (!keyHintsPresent || input.type !== QuickInputType.InputBox || !paradisIsCenteredQuickInputPlacement(input)) {
		return upstream;
	}
	return (input as IInputBox).prompt || undefined;
}
