/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

// スペース切り替え中の入力ゲート（`paradisTerminalInputGate.ts`）を、xterm の IME パッチ
// （TM16、`build/npm/paradisXtermImePatch.ts`）が足した入力経路にも効かせる。
//
// ゲートはキーボード入力を xterm の custom key handler で止めている。素の xterm では、IME を
// 通らない文字は keydown 側で送られるので `input` イベントの処理には届かない。ところが IME パッチは
// `input` イベントの処理の先頭で「IME が飲み込んだ keydown の確定」を送る経路
// （CompositionHelper.input → _claimImeKeydownCommit）を足しているため、切り替えの直前に IME で
// 打っていると、ゲート中でも1文字届くことがある（Enter は keydown 側で止まるので実行はされない）。
//
// そこで、ゲートが立っている間は xterm の要素のキャプチャ段階で `input` を止め、テキストエリアに
// 残った文字も捨てる（残すと、パッチの遅延処理がゲートが外れた後に送ってしまう）。

import type { Terminal as RawXtermTerminal } from '@xterm/xterm';
import { addDisposableListener } from '../../../../base/browser/dom.js';
import { Disposable } from '../../../../base/common/lifecycle.js';
import { ITerminalContribution, IXtermTerminal } from '../../../../workbench/contrib/terminal/browser/terminal.js';
import { registerTerminalContribution } from '../../../../workbench/contrib/terminal/browser/terminalExtensions.js';
import { paradisIsTerminalInputBlocked } from '../../workspaceSwitch/browser/paradisTerminalInputGate.js';

class ParadisTerminalImeInputGateContribution extends Disposable implements ITerminalContribution {

	static readonly ID = 'terminal.paradisImeInputGate';

	xtermOpen(xterm: IXtermTerminal & { raw: RawXtermTerminal }): void {
		const element = xterm.raw.element;
		if (!element) {
			return;
		}
		this._register(addDisposableListener(element, 'input', event => {
			if (!paradisIsTerminalInputBlocked()) {
				return;
			}
			event.stopImmediatePropagation();
			const textarea = xterm.raw.textarea;
			if (textarea) {
				textarea.value = '';
			}
		}, true));
	}
}

registerTerminalContribution(ParadisTerminalImeInputGateContribution.ID, ParadisTerminalImeInputGateContribution);
