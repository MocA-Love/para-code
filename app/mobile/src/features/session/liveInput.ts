// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

/**
 * ターミナルのライブ入力（打った文字をそのまま PC へ送る）の差分計算。画面から切り離した純関数。
 *
 * 見えない入力欄の文字列を PC のプロンプトへ**写す**（Orca の terminal-live-preedit-mirror.ts に倣った）。
 * PC へ送った分（`sent`）と入力欄を比べ、食い違った末尾を DEL で消して、足りない分を送る。
 * 自動修正や候補の選択で途中が置き換わっても、PC 側は入力欄と同じになる。
 *
 * **入力欄は空に戻さない。** Enter で送ったところまでを `offset`（コードポイント数）として覚え、
 * それより後ろだけを写す。以前は Enter とフォーカスが外れたときに `clear()` していたが、RN 0.86 の
 * iOS は変更イベントの数え方次第で `clear()` を黙って捨てるため、「空になったか」を文字列の長さと
 * 前方一致で推し量るしかなく、捨てられた後の ⌫ で前の行を丸ごと送り直したり、前の行で始まる
 * 文字列を一度に入れると後ろだけ送ったりしていた。
 *
 * 日本語などの変換（IME）で**変換中の文字は送らない**。どこまでが変換中かは入力欄が知っている
 * （iOS の marked text。RN にパッチを当てて変更イベントの `isComposing` で受け取る。
 * `app/patches/react-native@0.86.0.patch`）。文字の種類では決めない（中国語のピンインのように
 * 変換中でも ASCII のことがあり、確定した日本語や絵文字は ASCII でなくても送るべきだから）。
 *  - 変換中（composing: true）: 送った分と一致しない末尾は全部「変換中」として持っておく
 *  - 変換していない（composing: false）: 全部写す
 *  - 分からない（composing: undefined。パッチの無いネイティブ）: 末尾の ASCII でない続きを変換中と
 *    みなす。止まったままなら画面側が 300ms 後に `flush` で送る（HELD_PREEDIT_COMMIT_DELAY_MS）
 *
 * ⌫ は入力欄が縮んだ分として変更イベントで写す。Enter で送った後の部分まで縮んだら、縮んだ数だけ
 * DEL を送る（新しいプロンプトで ⌫ を押したのと同じ）。入力欄が空のときの ⌫ だけは変更イベントが
 * 来ないので、`onKeyPress` で DEL を送る。
 *
 * DEL はコードポイント1つにつき1つ送る。zsh の行編集はコードポイント単位で消す（2026-09-28 に
 * `zsh -f` で確認: 👍🏽 は ⌫ 1回で 👍 が残る）。Claude Code の入力欄は書記素単位で消すので、
 * 複数のコードポイントからなる絵文字をそこで消すと、手前の文字まで消えうる（両立できないので
 * シェルに合わせている）。
 *
 * iOS のスマート句読点（' → ’、-- → —）と全角スペースは ASCII に戻してから比べる。
 */

/** 見えない入力欄の状態。 */
export interface LiveInputState {
	/** 前回見た入力欄の文字列（スマート句読点などを ASCII に戻したもの）。 */
	readonly text: string;
	/** Enter で送り終えたところ（`text` の先頭からのコードポイント数）。これより後ろを写す。 */
	readonly offset: number;
	/** `offset` より後ろのうち PC へ送った先頭部分（PC のプロンプトにいま載っているはずのもの）。 */
	readonly sent: string;
	/** 変換中として送らずに持っている末尾。 */
	readonly held: string;
}

export const LIVE_INPUT_EMPTY: LiveInputState = { text: '', offset: 0, sent: '', held: '' };

/** 変換中かどうかが分からない環境で、止まった末尾を送るまでの待ち時間。 */
export const HELD_PREEDIT_COMMIT_DELAY_MS = 300;

/** ライブ入力で起きたこと。 */
export type LiveInputEvent =
	/** 入力欄が変わった。`composing` は入力欄に変換中の範囲があるか（分からなければ undefined）。 */
	| { readonly kind: 'change'; readonly text: string; readonly composing?: boolean }
	| { readonly kind: 'key'; readonly key: string }
	| { readonly kind: 'submit' }
	/** 持っている末尾を送る（変換中かどうか分からないまま止まったとき・フォーカスが外れたとき）。 */
	| { readonly kind: 'flush' };

export interface LiveInputStep {
	readonly state: LiveInputState;
	/** PC へ順に送るもの（文字・DEL の並び・CR）。 */
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
	// 日本語キーボードの空白は、変換していないと全角スペースになる。
	[/\u3000/g, ' '],
];

/** iOS のスマート句読点を、打ったとおりの ASCII に戻す。 */
export function normalizeLiveText(text: string): string {
	return SMART_PUNCTUATION.reduce((value, [pattern, ascii]) => value.replace(pattern, ascii), text);
}

const LAST_ASCII_CODE_POINT = 0x7f;

function commonPrefixLength(a: readonly string[], b: readonly string[]): number {
	let i = 0;
	while (i < a.length && i < b.length && a[i] === b[i]) {
		i++;
	}
	return i;
}

/** 入力欄の末尾のうち、変換中として送らずに持つ長さ（コードポイント数）。 */
function heldLength(field: readonly string[], stable: number, composing: boolean | undefined): number {
	if (composing !== undefined) {
		return composing ? field.length - stable : 0;
	}
	let held = 0;
	while (held < field.length && (field[field.length - 1 - held]?.codePointAt(0) ?? 0) > LAST_ASCII_CODE_POINT) {
		held++;
	}
	// 送り済みの部分まで遡って持つと、それを DEL で消して打ち直すことになる。
	return Math.min(held, field.length - stable);
}

/**
 * 入力欄を PC へ写す1歩。数えるのはコードポイント単位（絵文字のサロゲートペアを割らない。
 * シェルの ⌫ も1文字＝1コードポイントで消す）。
 */
function mirror(sent: string, text: string, commitHeld: boolean, composing: boolean | undefined): { readonly sent: string; readonly held: string; readonly send: string[] } {
	const field = Array.from(text);
	const sentPoints = Array.from(sent);
	const stable = commonPrefixLength(sentPoints, field);
	const held = commitHeld ? 0 : heldLength(field, stable, composing);
	const target = field.slice(0, field.length - held);
	const kept = Math.min(stable, target.length);
	const erase = sentPoints.length - kept;
	const append = target.slice(kept).join('');
	const send: string[] = [];
	if (erase > 0) {
		send.push(LIVE_DEL.repeat(erase));
	}
	if (append.length > 0) {
		send.push(append);
	}
	return { sent: target.join(''), held: field.slice(field.length - held).join(''), send };
}

function onChange(state: LiveInputState, raw: string, composing: boolean | undefined): LiveInputStep {
	const next = normalizeLiveText(raw);
	const field = Array.from(next);
	const previous = Array.from(state.text);
	// Enter で送った部分まで書き換わった・縮んだ（⌫ で前の行へ食い込んだ）。PC ではもう新しい
	// プロンプトなので、食い込んだ数だけ DEL を送り、そこから写し直す。
	const intact = commonPrefixLength(previous.slice(0, state.offset), field);
	if (intact < state.offset) {
		const step = mirror('', field.slice(intact).join(''), false, composing);
		return {
			state: { text: next, offset: intact, sent: step.sent, held: step.held },
			send: [LIVE_DEL.repeat(state.offset - intact), ...step.send],
		};
	}
	const step = mirror(state.sent, field.slice(state.offset).join(''), false, composing);
	return { state: { text: next, offset: state.offset, sent: step.sent, held: step.held }, send: step.send };
}

/** 持っている末尾も含めて全部写す（Enter の前・止まった変換・フォーカスが外れたとき）。 */
function commit(state: LiveInputState): LiveInputStep {
	const step = mirror(state.sent, Array.from(state.text).slice(state.offset).join(''), true, false);
	return { state: { ...state, sent: step.sent, held: '' }, send: step.send };
}

/** ライブ入力の1つの出来事を受けて、次の状態と PC へ送るものを返す。 */
export function liveInputStep(state: LiveInputState, event: LiveInputEvent): LiveInputStep {
	switch (event.kind) {
		case 'change':
			return onChange(state, event.text, event.composing);
		case 'key': {
			if (event.key !== 'Backspace') {
				return { state, send: [] };
			}
			// 入力欄に文字があれば、縮んだ分は変更イベントで写す（変換中の文字を消す ⌫ は PC へ届かない）。
			// 空の入力欄の ⌫ は変更イベントが来ないので、ここで送る。
			return { state, send: state.text.length === 0 ? [LIVE_DEL] : [] };
		}
		case 'submit': {
			const flushed = commit(state);
			return {
				state: { text: flushed.state.text, offset: Array.from(flushed.state.text).length, sent: '', held: '' },
				send: [...flushed.send, LIVE_ENTER],
			};
		}
		case 'flush':
			return commit(state);
	}
}
