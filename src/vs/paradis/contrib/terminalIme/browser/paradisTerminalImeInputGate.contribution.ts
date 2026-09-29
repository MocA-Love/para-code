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
// そこで、ゲートが立っている間は次のように止める（どれも xterm の要素のキャプチャ段階で、
// xterm のテキストエリアに届く前に `stopImmediatePropagation` する）。
//
// - `input`: IME パッチの経路を止め、テキストエリアに残った文字も捨てる（残すと、パッチの遅延
//   処理がゲートが外れた後に送ってしまう）
// - ゲート中に始まった変換（`compositionstart` / `update` / `end`）: 丸ごと xterm に見せない。
//   変換の確定で文字を送る経路（素の xterm にもある）もこれで止まる。xterm は変換が始まったこと
//   自体を知らないので、変換の状態が食い違うことは無い。確定したときにテキストエリアを空にする
// - ゲートが立つ前から続いている変換: 途中で止めると xterm が「変換中」のまま残り、以後の入力が
//   すべて変換扱いになるので、そのまま通す（確定した文字は届きうるが、Enter は keydown 側で
//   止まるので実行はされない）

import type { Terminal as RawXtermTerminal } from '@xterm/xterm';
import { addDisposableListener } from '../../../../base/browser/dom.js';
import { Disposable } from '../../../../base/common/lifecycle.js';
import { ITerminalContribution, IXtermTerminal } from '../../../../workbench/contrib/terminal/browser/terminal.js';
import { registerTerminalContribution } from '../../../../workbench/contrib/terminal/browser/terminalExtensions.js';
import { paradisIsTerminalInputBlocked } from '../../workspaceSwitch/browser/paradisTerminalInputGate.js';

export class ParadisTerminalImeInputGateContribution extends Disposable implements ITerminalContribution {

	static readonly ID = 'terminal.paradisImeInputGate';

	/** ゲート中に始まり、xterm へ見せずにいる変換があるか。 */
	private _swallowingComposition = false;
	/** ゲートの外で始まり、xterm へそのまま通している変換があるか。 */
	private _passingComposition = false;

	xtermOpen(xterm: IXtermTerminal & { raw: RawXtermTerminal }): void {
		const element = xterm.raw.element;
		if (!element) {
			return;
		}
		const clearTextarea = () => {
			const textarea = xterm.raw.textarea;
			if (textarea) {
				textarea.value = '';
			}
		};
		this._register(addDisposableListener(element, 'compositionstart', event => {
			// 新しい変換が始まったなら、前の変換は終わっている。前の変換の `compositionend` が
			// 届かなかった（フォーカスが移った等）ときに、その状態を持ち越さない。持ち越すと、
			// ゲートの外で始まった変換の `update` と `end` まで xterm へ届かず、xterm が
			// 「変換中」のまま固まる。
			if (paradisIsTerminalInputBlocked()) {
				this._swallowingComposition = true;
				this._passingComposition = false;
				event.stopImmediatePropagation();
			} else {
				this._swallowingComposition = false;
				this._passingComposition = true;
			}
		}, true));
		this._register(addDisposableListener(element, 'compositionupdate', event => {
			if (this._swallowingComposition) {
				event.stopImmediatePropagation();
			}
		}, true));
		this._register(addDisposableListener(element, 'compositionend', event => {
			if (this._swallowingComposition) {
				this._swallowingComposition = false;
				event.stopImmediatePropagation();
				clearTextarea();
			}
			this._passingComposition = false;
		}, true));
		this._register(addDisposableListener(element, 'input', event => {
			if (this._swallowingComposition || (paradisIsTerminalInputBlocked() && !this._passingComposition)) {
				event.stopImmediatePropagation();
				if (!this._swallowingComposition) {
					clearTextarea();
				}
			}
		}, true));
	}
}

registerTerminalContribution(ParadisTerminalImeInputGateContribution.ID, ParadisTerminalImeInputGateContribution);
