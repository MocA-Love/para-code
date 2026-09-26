// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

/**
 * ターミナル画面のアクセサリキー行（Esc / Tab / Ctrl / 矢印 …）の定義と、
 * 「どのキーを押したら何を送るか」の対応。
 *
 * 画面（`terminalKeyRow.tsx`）から切り離してあるのは、送るバイト列を WebView や実機を
 * 使わずにテストで固定するため。送信そのものは既存の `sendInput` / `sendArrowKey` を使う。
 */

export type TerminalArrowKey = 'up' | 'down' | 'left' | 'right';

export type TerminalKeyId =
	| 'esc' | 'tab' | 'shiftTab' | 'ctrl'
	| 'ctrlC' | 'ctrlD' | 'ctrlR' | 'ctrlL'
	| 'up' | 'down' | 'left' | 'right' | 'backspace'
	| 'home' | 'end'
	| 'pipe' | 'slash' | 'tilde';

export interface TerminalKeyDef {
	readonly id: TerminalKeyId;
	/** キーに出す文字。 */
	readonly label: string;
	readonly accessibilityLabel: string;
	/** 押し続けるとリピートするか（矢印と ⌫）。 */
	readonly repeat: boolean;
	/** 押すと実行中の処理を止める・入力を閉じるなど、取り消しの効かないキー（文字を赤くする）。 */
	readonly danger: boolean;
}

function key(id: TerminalKeyId, label: string, accessibilityLabel: string, opts: { repeat?: boolean; danger?: boolean } = {}): TerminalKeyDef {
	return { id, label, accessibilityLabel, repeat: opts.repeat === true, danger: opts.danger === true };
}

/** キー行に並べる順。よく使うもの（中断・補完・履歴）を左に寄せる。 */
export const TERMINAL_ACCESSORY_KEYS: readonly TerminalKeyDef[] = [
	key('esc', 'Esc', 'エスケープ'),
	key('tab', 'Tab', 'タブ'),
	key('shiftTab', '⇧Tab', 'シフトタブ'),
	key('ctrl', 'Ctrl', 'コントロール'),
	key('ctrlC', '^C', 'コントロール C（中断）', { danger: true }),
	key('ctrlD', '^D', 'コントロール D（入力の終わり）', { danger: true }),
	key('ctrlR', '^R', 'コントロール R（履歴検索）'),
	key('ctrlL', '^L', 'コントロール L（画面を消去）'),
	key('up', '↑', '上', { repeat: true }),
	key('down', '↓', '下', { repeat: true }),
	key('left', '←', '左', { repeat: true }),
	key('right', '→', '右', { repeat: true }),
	key('backspace', '⌫', '1文字削除', { repeat: true }),
	key('home', 'Home', '行頭'),
	key('end', 'End', '行末'),
	key('pipe', '|', '縦棒'),
	key('slash', '/', 'スラッシュ'),
	key('tilde', '~', 'チルダ'),
];

/** 押し続けてからリピートが始まるまで（長押しの判定時間）。 */
export const TERMINAL_KEY_REPEAT_DELAY_MS = 400;
/** リピートの間隔。 */
export const TERMINAL_KEY_REPEAT_INTERVAL_MS = 80;
/**
 * 1回の押し続けで送る上限。入力は PC へ届くまで端末内のアウトボックス（上限256件）に
 * 積まれるので、通信が詰まっている間に押し続けても本来の入力まで止めないよう歯止めを掛ける。
 */
export const TERMINAL_KEY_REPEAT_MAX = 50;

/**
 * キーを押したときにすること。
 * - `arrow`: 修飾なしの矢印。PC 側が端末のモード（application cursor keys）に合わせて
 *   シーケンスを決める既存の `sendArrowKey` で送る
 * - `bytes`: そのまま `sendInput` で送るバイト列
 * - `toggleCtrl`: Ctrl の押しっぱなしを切り替える（何も送らない）
 */
export type TerminalKeyAction =
	| { readonly kind: 'arrow'; readonly key: TerminalArrowKey }
	| { readonly kind: 'bytes'; readonly data: string }
	| { readonly kind: 'toggleCtrl' };

/** xterm の修飾付きカーソルキー（CSI 1;5 x）の末尾文字。 */
const CSI_FINAL: Record<TerminalArrowKey | 'home' | 'end', string> = {
	up: 'A', down: 'B', right: 'C', left: 'D', home: 'H', end: 'F',
};

/**
 * Ctrl と組み合わせた1文字を制御文字にする。対応が無い文字は `undefined`。
 *
 * 英字は大小を問わず 0x01〜0x1a（Ctrl+A〜Ctrl+Z）。記号・数字は xterm / VT220 の慣習
 * （Ctrl+@ ＝ NUL、Ctrl+[ ＝ ESC、Ctrl+\ ＝ FS、Ctrl+] ＝ GS、Ctrl+^ ＝ RS、Ctrl+_ ＝ US、
 * Ctrl+? ＝ DEL、数字の 2〜8 はその並び）に合わせる。`|` `~` `/` は同じキーの別の面として扱う。
 */
export function controlCharFor(ch: string): string | undefined {
	if (ch.length !== 1) {
		return undefined;
	}
	const code = ch.charCodeAt(0);
	if ((code >= 0x41 && code <= 0x5a) || (code >= 0x61 && code <= 0x7a)) {
		return String.fromCharCode(code & 0x1f);
	}
	switch (ch) {
		case '@': case ' ': case '2': return '\u0000';
		case '[': case '3': return '\u001b';
		case '\\': case '|': case '4': return '\u001c';
		case ']': case '5': return '\u001d';
		case '^': case '~': case '6': return '\u001e';
		case '_': case '/': case '7': return '\u001f';
		case '?': case '8': return '\u007f';
		default: return undefined;
	}
}

/**
 * キーを押したときの動作を決める。`ctrl` は Ctrl の押しっぱなしが点いているか。
 *
 * Ctrl が効くのは矢印・Home/End（xterm の `CSI 1;5 x`）と記号キー（制御文字）だけ。
 * Esc・Tab・^C などはそれ自体が完結したキーなので、Ctrl が点いていても同じものを送る
 * （呼び出し側はどのキーを押しても Ctrl を解除する）。
 */
export function terminalKeyAction(id: TerminalKeyId, ctrl: boolean): TerminalKeyAction {
	switch (id) {
		case 'ctrl': return { kind: 'toggleCtrl' };
		case 'esc': return { kind: 'bytes', data: '\u001b' };
		case 'tab': return { kind: 'bytes', data: '\t' };
		case 'shiftTab': return { kind: 'bytes', data: '\u001b[Z' };
		case 'ctrlC': return { kind: 'bytes', data: '\u0003' };
		case 'ctrlD': return { kind: 'bytes', data: '\u0004' };
		case 'ctrlR': return { kind: 'bytes', data: '\u0012' };
		case 'ctrlL': return { kind: 'bytes', data: '\u000c' };
		case 'backspace': return { kind: 'bytes', data: '\u007f' };
		case 'up': case 'down': case 'left': case 'right':
			return ctrl ? { kind: 'bytes', data: `\u001b[1;5${CSI_FINAL[id]}` } : { kind: 'arrow', key: id };
		case 'home': case 'end':
			return { kind: 'bytes', data: ctrl ? `\u001b[1;5${CSI_FINAL[id]}` : `\u001b[${CSI_FINAL[id]}` };
		case 'pipe': return charKey('|', ctrl);
		case 'slash': return charKey('/', ctrl);
		case 'tilde': return charKey('~', ctrl);
	}
}

function charKey(ch: string, ctrl: boolean): TerminalKeyAction {
	return { kind: 'bytes', data: (ctrl ? controlCharFor(ch) : undefined) ?? ch };
}

/**
 * Ctrl が点いている間に入力欄の文字が変わったときの扱い。
 * - `control`: 1文字だけ打たれ、それが制御文字にできる → その制御文字を送り、入力欄には足さない
 * - `text`: それ以外 → 入力欄の変更をそのまま受け入れる。`release` なら Ctrl を消す
 *   （1文字打ったが制御文字にできない場合。次のキーで Ctrl が効き続けると意図しない送信になる）
 *
 * 削除・貼り付け・変換の確定のように「1文字の追加」でない変更は Ctrl を残す。
 */
export type CtrlLatchedTextResult =
	| { readonly kind: 'control'; readonly data: string }
	| { readonly kind: 'text'; readonly release: boolean };

export function ctrlLatchedTextInput(previous: string, next: string): CtrlLatchedTextResult {
	if (next.length !== previous.length + 1) {
		return { kind: 'text', release: false };
	}
	let at = 0;
	while (at < previous.length && previous[at] === next[at]) {
		at++;
	}
	if (next.slice(0, at) + next.slice(at + 1) !== previous) {
		return { kind: 'text', release: false };
	}
	const data = controlCharFor(next.charAt(at));
	return data !== undefined ? { kind: 'control', data } : { kind: 'text', release: true };
}

/**
 * 送信ボタンを押したときに送るもの。
 * - 入力が空: Enter 単独（TUI の確認プロンプトの決定や、Enter なしで流したコマンドの実行に使う）
 * - 入力あり: テキスト。`enterless`（Enter なしで入力）なら末尾に Enter を付けない
 */
export type TerminalSubmitPlan =
	| { readonly kind: 'enter' }
	| { readonly kind: 'text'; readonly text: string; readonly execute: boolean };

export function terminalSubmitPlan(input: string, enterless: boolean): TerminalSubmitPlan {
	return input === '' ? { kind: 'enter' } : { kind: 'text', text: input, execute: !enterless };
}

/** 送信ボタンの記号。Enter が押される送信は「⏎」、入力欄に流すだけの送信は「↑」。 */
export function terminalSubmitIcon(input: string, enterless: boolean): 'arrow-up' | 'return-down-back' {
	return input !== '' && enterless ? 'arrow-up' : 'return-down-back';
}
