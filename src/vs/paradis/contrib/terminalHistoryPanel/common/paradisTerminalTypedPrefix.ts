/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

// 履歴の一覧の前方一致に使う「自分で打った文字」を決める。
//
// シェル統合の入力行（promptInputModel の value）は、プロンプトの終わりの印（OSC 633;B / 133;B）を
// 受けた時点のカーソルの列から右を読んでいる。印がプロンプトを描き終える前に届く・描き直しで列が
// ずれる（p10k、右プロンプト、複数行のプロンプト、SSH）と、value にプロンプトの表示が入る。
// zsh-autosuggestions の薄い文字も、色が判定に合わないと value に残る。value をそのまま前方一致に
// 使うと、どの履歴とも一致しない。
//
// そこで、送ったキーから「プロンプトの終わりからカーソルまで」を組み立て、入力行のカーソルより前の
// 部分の末尾と一致したときにそれを使う。キーから組み立てられない操作（Tab の補完、カーソル移動、
// 履歴の呼び出し）の後は、組み立てられていた間に覚えた「入力行の頭に付くプロンプトの残り」を
// 入力行から外して使う。どちらも確かめられなければ undefined（一覧は開かず、↓ はシェルへ）。

import { type IPromptInputModel, PromptInputState } from '../../../../platform/terminal/common/capabilities/commandDetection/promptInputModel.js';
import { PARADIS_EXTERNAL_PROMPT_CHANGE_MS, ParadisTerminalInputKind, paradisClassifyTerminalInput } from './paradisTerminalHistoryNavigation.js';

type PromptModel = Pick<IPromptInputModel, 'state' | 'value' | 'ghostTextIndex' | 'cursorIndex'>;

const BRACKETED_PASTE = /^\x1b\[200~(?<text>[\s\S]*)\x1b\[201~$/;
const PRINTABLE = /^[^\x00-\x1f\x7f]+$/;
const BACKSPACES = /^[\x7f\x08]+$/;
const DELETE_KEYS = /^(?:\x1b\[3~)+$/;

/**
 * 入力行のうちカーソルより前の文字（ゴースト文字を除く）。入力を受けていない・カーソルの位置が
 * 分からないときは undefined。
 */
export function paradisPromptTextBeforeCursor(model: PromptModel): string | undefined {
	if (model.state !== PromptInputState.Input || model.cursorIndex < 0) {
		return undefined;
	}
	const end = model.ghostTextIndex === -1 ? model.cursorIndex : Math.min(model.cursorIndex, model.ghostTextIndex);
	return model.value.substring(0, end);
}

/** 入力行のうちカーソルより後ろの文字（ゴースト文字を除く）。カーソルの位置が分からなければ空。 */
export function paradisPromptTextAfterCursor(model: PromptModel): string {
	if (model.cursorIndex < 0) {
		return '';
	}
	return model.ghostTextIndex === -1 ? model.value.substring(model.cursorIndex) : model.value.substring(model.cursorIndex, Math.max(model.cursorIndex, model.ghostTextIndex));
}

/**
 * 送った 1 回分の入力で、カーソルより前の文字がどう変わるか。文字・貼り付けは足し、Backspace は
 * 末尾を消し、Delete と端末の応答は変えない。Enter・Ctrl+C で空に戻る。Ctrl+U も空にするが、逐次検索の
 * 最中かもしれないので、それまでの文字が分かっているときだけ。それ以外（Tab、カーソル移動、↑↓、
 * Ctrl+W、Ctrl+G（逐次検索を抜けると元の行に戻る）、Esc など、シェルによって結果が変わるもの）は
 * undefined（分からない）。
 */
export function paradisApplyTypedInput(before: string | undefined, data: string): string | undefined {
	const kind = paradisClassifyTerminalInput(data);
	if (kind === ParadisTerminalInputKind.Ignore) {
		return before;
	}
	if (data === '\x07') {
		return undefined;
	}
	if (kind === ParadisTerminalInputKind.Submit) {
		return '';
	}
	if (before === undefined || kind !== ParadisTerminalInputKind.Edit) {
		return undefined;
	}
	if (data === '\x15') {
		return '';
	}
	const pasted = BRACKETED_PASTE.exec(data)?.groups?.text;
	const text = pasted ?? data;
	if (PRINTABLE.test(text)) {
		return before + text;
	}
	if (BACKSPACES.test(data)) {
		const chars = Array.from(before);
		return chars.slice(0, Math.max(0, chars.length - data.length)).join('');
	}
	if (DELETE_KEYS.test(data)) {
		return before;
	}
	return undefined;
}

/**
 * 入力行のカーソルより前の文字 `text` が「プロンプトの残り＋打った文字 `typed`」になっているとき、
 * プロンプトの残りの部分を返す。末尾の空白はシェル統合が詰めることがあるので比べない。
 */
function promptHeadOf(text: string, typed: string): string | undefined {
	if (text.endsWith(typed)) {
		return text.substring(0, text.length - typed.length);
	}
	const trimmedText = text.trimEnd();
	const trimmedTyped = typed.trimEnd();
	return trimmedText.endsWith(trimmedTyped) ? trimmedText.substring(0, trimmedText.length - trimmedTyped.length) : undefined;
}

/**
 * 1 つのターミナルの「自分で打った文字」を追う。キーと入力行の変化を届いた順に渡し、
 * {@link resolve} で今の前方一致の文字を受け取る。時刻は呼び出し側が渡す。
 */
export class ParadisTypedPrefixTracker {
	/** 送ったキーから組み立てた、プロンプトの終わりからカーソルまで。分からなければ undefined。 */
	private _typed: string | undefined;
	/** 入力行の頭に付いているプロンプトの残り（組み立てた文字と一致したときに覚える）。 */
	private _promptHead: string | undefined;
	/** {@link _promptHead} を覚えたときの打った文字。 */
	private _typedAtHead: string | undefined;
	private _lastInputAt = Number.NEGATIVE_INFINITY;
	/** コマンドの実行中（次のプロンプトまで）。打った文字は実行中のプログラムへ行く。 */
	private _commandRunning = false;
	private _inputWhileRunning = false;

	/** xterm.js の `onData`（ユーザーの入力）。 */
	input(data: string, now: number): void {
		if (paradisClassifyTerminalInput(data) === ParadisTerminalInputKind.Ignore) {
			return;
		}
		this._lastInputAt = now;
		if (this._commandRunning) {
			this._inputWhileRunning = true;
			return;
		}
		this._typed = paradisApplyTypedInput(this._typed, data);
	}

	/** Para Code 自身が入力行を `line`（カーソルは末尾）に書き換えた。 */
	wrote(line: string, now: number): void {
		this._lastInputAt = now;
		this._typed = line;
	}

	/**
	 * シェルの入力行が変わった。打った文字と一致していれば、頭に付くプロンプトの残りを覚え直す。
	 * 入力から時間が経っても一致しなければ、入力を通らずに書き換わった（補完の候補の挿入、ファイルの
	 * ドロップなど）ので、組み立てた文字は捨てる。
	 */
	prompt(model: PromptModel, now: number): void {
		const text = paradisPromptTextBeforeCursor(model);
		if (this._typed === undefined || text === undefined) {
			return;
		}
		const head = promptHeadOf(text, this._typed);
		if (head !== undefined) {
			this._promptHead = head;
			this._typedAtHead = this._typed;
		} else if (now - this._lastInputAt > PARADIS_EXTERNAL_PROMPT_CHANGE_MS) {
			this._typed = undefined;
		}
	}

	/** コマンドが実行された。次のプロンプトまで、打った文字は数えない。 */
	commandExecuted(): void {
		this._commandRunning = true;
		this._inputWhileRunning = false;
		this._typed = undefined;
		this._promptHead = undefined;
		this._typedAtHead = undefined;
	}

	/**
	 * 新しいプロンプトが出た。実行中に打った文字はシェルに残っているか分からないので、そのときは
	 * 分からないところから始める。
	 */
	promptStarted(): void {
		const unknown = this._commandRunning && this._inputWhileRunning;
		this._commandRunning = false;
		this._inputWhileRunning = false;
		this._typed = unknown ? undefined : '';
		this._promptHead = undefined;
		this._typedAtHead = undefined;
	}

	/** キーから組み立てた文字があり、カーソルはその末尾にある（カーソルを動かすキーを送っていない）。 */
	get cursorAtEndOfTyped(): boolean {
		return this._typed !== undefined;
	}

	/**
	 * 前方一致に使う文字（プロンプトの終わりからカーソルまで、ゴースト文字を除く）。確かめられなければ
	 * undefined。
	 */
	resolve(model: PromptModel, now: number): string | undefined {
		const text = paradisPromptTextBeforeCursor(model);
		if (text === undefined) {
			return undefined;
		}
		if (this._typed !== undefined) {
			if (promptHeadOf(text, this._typed) !== undefined) {
				return this._typed;
			}
			if (now - this._lastInputAt <= PARADIS_EXTERNAL_PROMPT_CHANGE_MS) {
				// シェルの表示がまだ追いついていないかもしれない。
				return undefined;
			}
			// 入力を通らずに入力行が変わった。入力行から読む。
		}
		const head = this._promptHead;
		if (head === undefined || !text.startsWith(head)) {
			return undefined;
		}
		const typed = text.substring(head.length);
		const known = this._typedAtHead?.trimStart() ?? '';
		const current = typed.trimStart();
		// プロンプトが描き直されて頭の長さが変わると、残りが前に打った文字と繋がらなくなる。
		return current.startsWith(known) || known.startsWith(current) ? typed : undefined;
	}
}
