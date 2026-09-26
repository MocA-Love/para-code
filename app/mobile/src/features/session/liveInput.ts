// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

/**
 * ターミナルのライブ入力（打った文字をそのまま PC へ送る）の差分計算。画面から切り離した純関数。
 *
 * 見えない入力欄に溜まっていく文字列と、前回までに見た文字列を比べて、送る分だけを出す:
 *  - 伸びた分（前回の続きに文字が足された）: 足された分を送る
 *  - 縮んだ分（⌫）: ここでは送らない。⌫ は `onKeyPress` の DEL で送る（空の入力欄でも届くように）
 *  - 途中の置き換え（自動修正・候補の選択など）: 送らない。PC 側と食い違うので捨てる
 *
 * 入力欄を空に戻すのは変更イベントの外（Enter・フォーカスが外れたとき）で行う。RN 0.86 の iOS では
 * 変更イベントの中の `clear()` がネイティブ側で捨てられる（イベントの数え方が食い違う）ため。
 * 空に戻す指示のあとも、ネイティブ側で捨てられた可能性を考えて `clearing` で両方を受け付ける。
 *
 * iOS のスマート句読点（' → ’、-- → —）は ASCII に戻してから比べる。日本語入力（外付けキーボードの
 * IME）の変換途中の文字は ASCII でないので送らない。変換の最初のローマ字（k・ky など）は変換が
 * 始まるまで区別できず送ってしまうので、かなに置き換わった時点で送った分だけ DEL で取り消す。
 */

/** 見えない入力欄の状態。 */
export interface LiveInputState {
	/** 前回見た入力欄の文字列（スマート句読点を ASCII に戻したもの）。 */
	readonly text: string;
	/** `text` の各文字（UTF-16 単位）を PC へ送ったか（'1' 送った / '0' 送っていない）。 */
	readonly sent: string;
	/** 入力欄を空に戻す指示を出した直後か（ネイティブ側で捨てられていれば前の文字列が続いて届く）。 */
	readonly clearing: boolean;
}

export const LIVE_INPUT_EMPTY: LiveInputState = { text: '', sent: '', clearing: false };

/** ライブ入力で起きたこと。 */
export type LiveInputEvent =
	| { readonly kind: 'change'; readonly text: string }
	| { readonly kind: 'key'; readonly key: string }
	| { readonly kind: 'submit' }
	/** 入力欄を空に戻す指示を出した（`clear()` を呼んだ）。 */
	| { readonly kind: 'cleared' };

export interface LiveInputStep {
	readonly state: LiveInputState;
	/** PC へ順に送るもの（文字・DEL・CR）。 */
	readonly send: readonly string[];
}

export const LIVE_DEL = '\u007f';
export const LIVE_ENTER = '\r';

const SMART_PUNCTUATION: ReadonlyArray<readonly [RegExp, string]> = [
	[/[‘’‚‛]/g, '\''],
	[/[“”„‟]/g, '"'],
	// スマートダッシュは「--」を「—」に置き換える。
	[/[—–]/g, '--'],
	[/…/g, '...'],
];

/** iOS のスマート句読点を、打ったとおりの ASCII に戻す。 */
export function normalizeLiveText(text: string): string {
	return SMART_PUNCTUATION.reduce((value, [pattern, ascii]) => value.replace(pattern, ascii), text);
}

/** そのまま送ってよい文字だけか（印字できる ASCII とタブ）。 */
function isSendable(text: string): boolean {
	return /^[\x20-\x7E\t]*$/.test(text);
}

function commonPrefixLength(a: string, b: string): number {
	const max = Math.min(a.length, b.length);
	let i = 0;
	while (i < max && a.charCodeAt(i) === b.charCodeAt(i)) {
		i++;
	}
	return i;
}

function countSent(flags: string): number {
	let count = 0;
	for (const flag of flags) {
		if (flag === '1') {
			count++;
		}
	}
	return count;
}

function onChange(state: LiveInputState, raw: string): LiveInputStep {
	const next = normalizeLiveText(raw);
	// 空に戻す指示のあとに届いた文字列: 前の文字列の続きなら指示は捨てられている、そうでなければ空になった。
	const base = state.clearing && !(next.length > state.text.length && next.startsWith(state.text))
		? LIVE_INPUT_EMPTY
		: state;
	const prefix = commonPrefixLength(base.text, next);
	const removedFlags = base.sent.slice(prefix);
	const added = next.slice(prefix);
	const keptFlags = base.sent.slice(0, prefix);
	const sendable = isSendable(added);

	if (removedFlags.length === 0) {
		// 伸びた分。ASCII でなければ変換途中（または変換した結果）なので送らない。
		return {
			state: { text: next, sent: keptFlags + (sendable ? '1' : '0').repeat(added.length), clearing: false },
			send: sendable && added.length > 0 ? [added] : [],
		};
	}
	if (added.length === 0) {
		// 縮んだ分。DEL は onKeyPress で送っている。
		return { state: { text: next, sent: keptFlags, clearing: false }, send: [] };
	}
	// 途中の置き換え。送らない。ただし日本語の変換が始まった（ローマ字がかなに置き換わった）ときは、
	// 先に送ってしまったローマ字を DEL で取り消す。
	const undo = sendable ? 0 : countSent(removedFlags);
	return {
		state: { text: next, sent: keptFlags + '0'.repeat(added.length), clearing: false },
		send: undo > 0 ? [LIVE_DEL.repeat(undo)] : [],
	};
}

/** ライブ入力の1つの出来事を受けて、次の状態と PC へ送るものを返す。 */
export function liveInputStep(state: LiveInputState, event: LiveInputEvent): LiveInputStep {
	switch (event.kind) {
		case 'change':
			return onChange(state, event.text);
		case 'key': {
			if (event.key !== 'Backspace') {
				return { state, send: [] };
			}
			// 送っていない文字（変換途中のかな）を消す ⌫ は PC へ送らない。空の入力欄での ⌫ は送る。
			const last = state.clearing ? undefined : state.sent.at(-1);
			return { state, send: last === '0' ? [] : [LIVE_DEL] };
		}
		case 'submit':
			return { state, send: [LIVE_ENTER] };
		case 'cleared':
			return { state: { ...state, clearing: true }, send: [] };
	}
}
