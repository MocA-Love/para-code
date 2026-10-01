/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

/**
 * モバイルのブラウザ画面から PC の内蔵ブラウザへ送る特殊キー（browser チャネルの `input` の `kind: 'key'`）。
 *
 * **このファイルは import を持たない。** モバイルアプリ（`app/mobile`）がキーの名前の型を相対パスで直接
 * import する。PC はここに無い名前を送られても何もしない（許可リスト）。
 *
 * 文字は従来どおり `kind: 'text'`（`Input.insertText`）で送る。ここで扱うのは文字を伴わないキーと Enter だけ。
 */

/** 送ってよいキーの名前（DOM の `KeyboardEvent.key` と同じ綴り）。 */
export type ParadisMobileBrowserKey =
	| 'Enter' | 'Backspace' | 'Delete' | 'Tab' | 'Escape'
	| 'ArrowLeft' | 'ArrowUp' | 'ArrowRight' | 'ArrowDown'
	| 'Home' | 'End' | 'PageUp' | 'PageDown';

interface IKeyDefinition {
	readonly code: string;
	readonly windowsVirtualKeyCode: number;
	/** keyDown で生まれる文字。あるキーは `keyDown`、無いキーは `rawKeyDown` で送る。 */
	readonly text?: string;
	/**
	 * macOS の Chromium は、CDP で合成したキーから編集の操作（NSResponder の選択子）を作らないので、
	 * 削除・カーソル移動は `commands` で一緒に渡す必要がある（Playwright と同じ対応表。`insert*` は
	 * `text` と二重に入るので渡さない）。
	 */
	readonly macCommand?: string;
	readonly macShiftCommand?: string;
}

const KEYS: { readonly [K in ParadisMobileBrowserKey]: IKeyDefinition } = {
	Enter: { code: 'Enter', windowsVirtualKeyCode: 13, text: '\r' },
	Backspace: { code: 'Backspace', windowsVirtualKeyCode: 8, macCommand: 'deleteBackward', macShiftCommand: 'deleteBackward' },
	Delete: { code: 'Delete', windowsVirtualKeyCode: 46, macCommand: 'deleteForward', macShiftCommand: 'deleteForward' },
	Tab: { code: 'Tab', windowsVirtualKeyCode: 9 },
	Escape: { code: 'Escape', windowsVirtualKeyCode: 27, macCommand: 'cancelOperation', macShiftCommand: 'cancelOperation' },
	ArrowLeft: { code: 'ArrowLeft', windowsVirtualKeyCode: 37, macCommand: 'moveLeft', macShiftCommand: 'moveLeftAndModifySelection' },
	ArrowUp: { code: 'ArrowUp', windowsVirtualKeyCode: 38, macCommand: 'moveUp', macShiftCommand: 'moveUpAndModifySelection' },
	ArrowRight: { code: 'ArrowRight', windowsVirtualKeyCode: 39, macCommand: 'moveRight', macShiftCommand: 'moveRightAndModifySelection' },
	ArrowDown: { code: 'ArrowDown', windowsVirtualKeyCode: 40, macCommand: 'moveDown', macShiftCommand: 'moveDownAndModifySelection' },
	Home: { code: 'Home', windowsVirtualKeyCode: 36, macCommand: 'scrollToBeginningOfDocument', macShiftCommand: 'moveToBeginningOfDocumentAndModifySelection' },
	End: { code: 'End', windowsVirtualKeyCode: 35, macCommand: 'scrollToEndOfDocument', macShiftCommand: 'moveToEndOfDocumentAndModifySelection' },
	PageUp: { code: 'PageUp', windowsVirtualKeyCode: 33, macCommand: 'scrollPageUp', macShiftCommand: 'pageUpAndModifySelection' },
	PageDown: { code: 'PageDown', windowsVirtualKeyCode: 34, macCommand: 'scrollPageDown', macShiftCommand: 'pageDownAndModifySelection' },
};

/** CDP `Input.dispatchKeyEvent` の引数のうち、ここで組み立てるもの。 */
export interface IParadisBrowserKeyEventParams {
	readonly type: 'keyDown' | 'rawKeyDown' | 'keyUp';
	readonly key: string;
	readonly code: string;
	readonly windowsVirtualKeyCode: number;
	readonly modifiers: number;
	readonly text?: string;
	readonly unmodifiedText?: string;
	readonly commands?: readonly string[];
}

/** CDP の修飾キーのビット（Alt=1, Ctrl=2, Meta=4, Shift=8）のうち Shift。 */
const SHIFT_MODIFIER = 8;

/** 許可リストにある名前か（相手から届いた値の検査に使う）。 */
export function paradisIsMobileBrowserKey(value: unknown): value is ParadisMobileBrowserKey {
	return typeof value === 'string' && Object.prototype.hasOwnProperty.call(KEYS, value);
}

/**
 * 1 回のキーの押し下げを、`Input.dispatchKeyEvent` に順に渡す引数（押す・離す）にする。
 * 許可リストに無い名前なら `undefined`（何も送らない）。`shift` は `true` のときだけ効かせる。
 */
export function paradisMobileBrowserKeyEvents(key: unknown, shift: unknown, mac: boolean): readonly IParadisBrowserKeyEventParams[] | undefined {
	if (!paradisIsMobileBrowserKey(key)) {
		return undefined;
	}
	const definition = KEYS[key];
	const shifted = shift === true;
	const modifiers = shifted ? SHIFT_MODIFIER : 0;
	const command = mac ? (shifted ? definition.macShiftCommand : definition.macCommand) : undefined;
	const base = { key, code: definition.code, windowsVirtualKeyCode: definition.windowsVirtualKeyCode, modifiers };
	const down: IParadisBrowserKeyEventParams = definition.text !== undefined
		? { ...base, type: 'keyDown', text: definition.text, unmodifiedText: definition.text, ...(command !== undefined ? { commands: [command] } : {}) }
		: { ...base, type: 'rawKeyDown', ...(command !== undefined ? { commands: [command] } : {}) };
	return [down, { ...base, type: 'keyUp' }];
}
