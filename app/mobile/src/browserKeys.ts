// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

/**
 * ブラウザ画面の文字入力で使うキーの定義と、「入力欄で何をしたら PC へ何を送るか」の対応。
 *
 * 画面（`components/browserKeyInput.tsx`）から切り離してあるのは、送る内容をテストで固定するため。
 * キーの名前の許可リストは PC と同じ型（`paradisMobileBrowserKeys.ts`）を使う。PC はそこに無い名前を捨てる。
 */

import type { ParadisMobileBrowserKey } from '../../../src/vs/paradis/contrib/mobileRelay/common/paradisMobileBrowserKeys.js';

export type BrowserKeyName = ParadisMobileBrowserKey;

/** browser チャネルの `input`（PC の `paradisMobileBrowserMirror.ts` の `BrowserInbound` と一致）。 */
export interface BrowserInput {
	readonly kind: 'tap' | 'scroll' | 'back' | 'forward' | 'reload' | 'text' | 'navigate' | 'key';
	/** tap / scroll: 映像に対する正規化座標（0..1）。 */
	readonly nx?: number;
	readonly ny?: number;
	/** scroll: 正規化したスクロール量（正で下・右）。 */
	readonly dy?: number;
	readonly dx?: number;
	readonly text?: string;
	readonly url?: string;
	/** key: 特殊キー。PC が `browser.keys.v1` を広告しているときだけ送る。 */
	readonly key?: BrowserKeyName;
	/** key: Shift を押しながら。 */
	readonly shift?: true;
}

export interface BrowserKeyDef {
	readonly id: string;
	/** キーに出す文字。 */
	readonly label: string;
	readonly accessibilityLabel: string;
	readonly key: BrowserKeyName;
	readonly shift?: true;
	/** 押し続けるとリピートするか（矢印と ⌫）。 */
	readonly repeat: boolean;
}

function key(id: string, label: string, accessibilityLabel: string, name: BrowserKeyName, opts: { shift?: true; repeat?: boolean } = {}): BrowserKeyDef {
	return { id, label, accessibilityLabel, key: name, repeat: opts.repeat === true, ...(opts.shift ? { shift: true } : {}) };
}

/** キー行に並べる順。並びはターミナルのキー行（Esc・Tab・⇧Tab・矢印・⌫）に揃え、最後に Enter を置く。 */
export const BROWSER_ACCESSORY_KEYS: readonly BrowserKeyDef[] = [
	key('esc', 'Esc', 'エスケープ', 'Escape'),
	key('tab', 'Tab', 'タブ', 'Tab'),
	key('shiftTab', '⇧Tab', 'シフトタブ', 'Tab', { shift: true }),
	key('up', '↑', '上', 'ArrowUp', { repeat: true }),
	key('down', '↓', '下', 'ArrowDown', { repeat: true }),
	key('left', '←', '左', 'ArrowLeft', { repeat: true }),
	key('right', '→', '右', 'ArrowRight', { repeat: true }),
	key('backspace', '⌫', '1文字削除', 'Backspace', { repeat: true }),
	key('enter', '⏎', 'Enter', 'Enter'),
];

/** そのキーを押したときに送る入力。 */
export function browserKeyInput(def: Pick<BrowserKeyDef, 'key' | 'shift'>): BrowserInput {
	return { kind: 'key', key: def.key, ...(def.shift ? { shift: true } : {}) };
}

/**
 * 入力欄で Return を押したときに送るもの。
 *
 * 文字があれば文字だけを送る（Enter は付けない。検索欄なら続けてもう一度 Return で Enter になる）。
 * 空なら Enter を送る。特殊キーを受けない古い PC では空の Return は何もしない（`undefined`）。
 * 日本語の変換中の Return は OS が確定に使うので、ここへは来ない。
 */
export function browserSubmitInput(text: string, keysSupported: boolean): BrowserInput | undefined {
	if (text.length > 0) {
		return { kind: 'text', text };
	}
	return keysSupported ? browserKeyInput({ key: 'Enter' }) : undefined;
}

/** 入力欄が空のときの ⌫ は、ページの側の 1 文字を消す（特殊キーを受けない PC では何もしない）。 */
export function browserEmptyBackspaceInput(keysSupported: boolean): BrowserInput | undefined {
	return keysSupported ? browserKeyInput({ key: 'Backspace' }) : undefined;
}
