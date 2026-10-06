/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

// シェルの入力欄が空かどうかの判定（純関数）。
//
// upstream の `PromptInputModel` は入力の始まりから行末までを読むので、zsh の右プロンプト（RPROMPT）が
// `value` に入る（`promptInputModel.test.ts` もその仕様）。`value.trim()` だけで空を判定すると、右プロンプトを
// 出しているシェルでは入力欄が空でも「空でない」と読んでしまう。upstream は変えず、ここで読み替える。
//
// 判定の順:
//  1. `value` が空白だけなら空（従来どおり）
//  2. 右プロンプトの開始列と終わりの列が分かる（OSC 633;H / 633;I）とき: カーソルが入力の始まりにあり、入力の
//     始まりから右プロンプトの手前まで空白だけで、`value` が右プロンプトの終わりより先へ続いていなければ空
//     （zsh の続きの行は `\n` なしで `value` に足されることがあるので、右プロンプトの後ろも見る）
//  3. 分からないとき: プロンプトが出た直後（まだ何も打っていない時点）の `value` を基準として覚えておき、
//     カーソルが入力の始まりにあって、今の `value` が基準と同じなら空
//  4. どれでも決めきれないときは空でない（呼び出し側が断る側へ倒れる）

import { isEmojiImprecise, isFullWidthCharacter } from '../../../../base/common/strings.js';

/** 判定に使う入力欄の様子。 */
export interface IParadisPromptInputSnapshot {
	/** `IPromptInputModel.value`。右プロンプトを含むことがある。 */
	readonly value: string;
	/** `IPromptInputModel.cursorIndex`。入力の始まりが 0。 */
	readonly cursorIndex: number;
	/** 入力の始まりの列（`ICurrentPartialCommand.commandStartX`）。 */
	readonly commandStartX: number | undefined;
	/** 右プロンプトの開始列（`ICurrentPartialCommand.commandRightPromptStartX`）。OSC 633;H が来たときだけ分かる。 */
	readonly rightPromptStartX: number | undefined;
	/** 右プロンプトの終わりの列（`ICurrentPartialCommand.commandRightPromptEndX`）。OSC 633;I が来たときだけ分かる。 */
	readonly rightPromptEndX: number | undefined;
	/** プロンプトが出た直後の `value`（{@link paradisNextPromptBaseline}）。覚えていなければ undefined。 */
	readonly baseline: string | undefined;
}

/**
 * 入力欄が空かどうか。決めきれないときは false（空でない）を返す。
 */
export function paradisIsPromptInputEmpty(snapshot: IParadisPromptInputSnapshot): boolean {
	const { value, cursorIndex, commandStartX, rightPromptStartX, rightPromptEndX, baseline } = snapshot;
	if (value.trim().length === 0) {
		return true;
	}
	// 右プロンプトは 1 行目の右端にだけ出る。複数行の入力やカーソルが先頭にない状態は読み替えない。
	if (cursorIndex !== 0 || value.includes('\n')) {
		return false;
	}
	if (commandStartX !== undefined && rightPromptStartX !== undefined && rightPromptEndX !== undefined && commandStartX < rightPromptStartX && rightPromptStartX <= rightPromptEndX) {
		// `value` は 1 文字 1 セルとは限らない（全角）が、入力が無ければ間はすべて 1 セル 1 文字の空白になる。
		// 全角の入力があれば間のどこかに空白でない文字が入るので、空と読み違えない。
		// 右プロンプトから後ろはセル幅で数える（全角の右プロンプトを文字数で数えると、後ろに続く入力を見落とす）。
		const gap = rightPromptStartX - commandStartX;
		return value.substring(0, gap).trim().length === 0
			&& paradisCellWidth(value.substring(gap).trimEnd()) <= rightPromptEndX - rightPromptStartX
			// 基準があれば重ねて照合する（右プロンプト末尾の空白や少なく数える文字の分だけ後ろの入力を見逃さない）
			&& (baseline === undefined || value === baseline);
	}
	return baseline !== undefined && value === baseline;
}

/** 端末で占めるセル数の見積もり。全角・絵文字は 2 と数える（多めに数えると断る側へ倒れる）。 */
function paradisCellWidth(text: string): number {
	let width = 0;
	for (const character of text) {
		const codePoint = character.codePointAt(0) ?? 0;
		width += isFullWidthCharacter(codePoint) || isEmojiImprecise(codePoint) ? 2 : 1;
	}
	return width;
}

/** プロンプトが出た直後の `value` を覚える状態。 */
export interface IParadisPromptBaseline {
	/** 基準の `value`。まだ取れていなければ undefined。 */
	readonly value: string | undefined;
	/** 入力が始まったら true。以後この行では基準を取り直さない。 */
	readonly frozen: boolean;
}

/** プロンプトが出たとき（`onDidStartInput`）の状態。 */
export const PARADIS_PROMPT_BASELINE_START: IParadisPromptBaseline = { value: undefined, frozen: false };

/**
 * 入力欄が変わったとき（`onDidChangeInput`）に基準を更新する。
 *
 * 基準にしてよいのは「カーソルが入力の始まりにあり、空白から始まる 1 行」だけ。右プロンプトは入力の始まりから
 * 空白を挟んだ右端に描かれるのでこの形になり、打った文字が画面に出るとカーソルが先頭から動くのでこの形にならない。
 * 打った文字が出たら固定し、以後は取り直さない（消して元に戻せば基準と一致して空と読める）。
 *
 * 何も打つ前なら、ウィンドウ幅の変更やテーマの非同期な再描画で右プロンプトの位置・中身が変わっても取り直す。
 * 打った後に変わった場合は取り直さないので基準と一致せず、空でないと読む（断る側）。
 */
export function paradisNextPromptBaseline(previous: IParadisPromptBaseline, state: { readonly value: string; readonly cursorIndex: number }): IParadisPromptBaseline {
	if (previous.frozen || state.value.trim().length === 0) {
		return previous;
	}
	if (state.cursorIndex === 0 && /^\s/.test(state.value) && !state.value.includes('\n')) {
		return previous.value === state.value ? previous : { value: state.value, frozen: false };
	}
	return { value: previous.value, frozen: true };
}
