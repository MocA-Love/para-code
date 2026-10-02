// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

/**
 * ブラウザのページの入力欄と、こちらの文字入力（キーボード）の対応（案A）。
 *
 * - 映像のタップで PC のページの欄にフォーカスが入ったら（PC の `focus` の通知の `fromTap`）、自動で開く。
 *   欄に入っている文字を入力欄に入れ、直したぶんを `replace`（欄の中身を全部置き換える）で送る
 * - `replace` には欄の番号（`fieldId`）を付ける。PC はその欄にフォーカスがあるときだけ置き換える
 * - 欄が替わったら（別の欄をタップした・ページがフォーカスを動かした）、直しかけの文字は捨てて新しい欄に合わせる
 *   （前の欄のための文字で、新しい欄の中身を丸ごと置き換えないため）
 * - contenteditable は中身を受け取らず、文字を足す方式（書式・リンク・画像を消さないため）
 * - 自動で開いたものは、PC の欄からフォーカスが外れたら閉じる（直しかけの文字があれば閉じない）
 * - 手動のボタンで開いたものは、PC の知らせでは閉じない
 * - 開いている間に同じ欄の中身が変わったら（ページが書き換えた・こちらが送った）、直していなければ追従する
 *
 * Return・送るボタンは「中身が欄と同じなら Enter、違えば置き換え」。複数行の欄（textarea・contenteditable）では
 * Return は改行で、送るのは送るボタンだけ。
 */

import type { IParadisMobileBrowserFocus, ParadisMobileBrowserFieldKind } from '../../../src/vs/paradis/contrib/mobileRelay/common/paradisMobileBrowserProtocol.js';
import { browserSubmitInput, type BrowserInput } from './browserKeys.js';

export interface BrowserKeyboardState {
	readonly open: boolean;
	/** PC の知らせで開いたか（手動のボタンなら false）。 */
	readonly auto: boolean;
	/** 入力欄の文字。 */
	readonly text: string;
	/** PC の欄に入っていると分かっている文字。`undefined` は分からない（手動・古い PC・長すぎて切れた・contenteditable）。 */
	readonly baseline: string | undefined;
	/** 置き換えを送る前の基準（PC に断られたら戻す）。 */
	readonly previousBaseline?: string | undefined;
	/** いま向き合っている PC の欄。 */
	readonly field: ParadisMobileBrowserFieldKind | undefined;
	/** その欄の番号（`replace` に付ける）。 */
	readonly fieldId: number | undefined;
	readonly secret: boolean;
	/** PC に入力を断られた理由（入力欄の見出しに出す。次に送るか欄が替わると消す）。 */
	readonly notice: 'field-changed' | 'too-long' | undefined;
	/** 最後に読んだ通知の番号（古い通知を捨てる）。 */
	readonly seq: number;
	readonly targetId: string | undefined;
}

export const BROWSER_KEYBOARD_CLOSED: BrowserKeyboardState = {
	open: false, auto: false, text: '', baseline: undefined, field: undefined, fieldId: undefined, secret: false, notice: undefined, seq: -1, targetId: undefined,
};

export type BrowserKeyboardEvent =
	| { readonly kind: 'focus'; readonly focus: IParadisMobileBrowserFocus }
	| { readonly kind: 'open' }
	| { readonly kind: 'close' }
	| { readonly kind: 'text'; readonly text: string }
	/** 送った（`replace` なら欄の中身がその文字になった前提で基準を進める）。 */
	| { readonly kind: 'sent'; readonly input: BrowserInput }
	/** PC が入力を断った（`inputRejected`）。 */
	| { readonly kind: 'rejected'; readonly input: 'replace' | 'text' | 'open'; readonly reason: 'field-changed' | 'too-long' }
	/** ミラーのページが変わった。 */
	| { readonly kind: 'target'; readonly targetId: string | undefined }
	/** ミラーを張り直した（PC の通知の番号が 1 からやり直しになる）。 */
	| { readonly kind: 'restart' };

/** 欄の中身として分かっているもの。パスワードは空から、contenteditable と切れたものは分からない。 */
function knownValue(focus: IParadisMobileBrowserFocus): string | undefined {
	if (focus.secret === true) {
		return '';
	}
	return focus.field === 'contenteditable' || focus.truncated === true ? undefined : focus.value;
}

function unedited(state: BrowserKeyboardState): boolean {
	return state.baseline === undefined ? state.text.length === 0 : state.text === state.baseline;
}

/** 複数行で直す欄か（Return は改行。送るのは送るボタン）。 */
export function browserKeyboardMultiline(state: BrowserKeyboardState): boolean {
	return state.field === 'textarea' || state.field === 'contenteditable';
}

export function nextBrowserKeyboard(state: BrowserKeyboardState, event: BrowserKeyboardEvent): BrowserKeyboardState {
	switch (event.kind) {
		case 'open':
			return state.open ? state : { ...state, open: true, auto: false, text: '', baseline: undefined, field: undefined, fieldId: undefined, secret: false, notice: undefined };
		case 'close':
			return { ...BROWSER_KEYBOARD_CLOSED, seq: state.seq, targetId: state.targetId };
		case 'text':
			return state.open ? { ...state, text: event.text } : state;
		case 'restart':
			return { ...BROWSER_KEYBOARD_CLOSED, targetId: state.targetId };
		case 'target':
			return event.targetId === state.targetId ? state : { ...BROWSER_KEYBOARD_CLOSED, targetId: event.targetId };
		case 'sent': {
			if (event.input.kind === 'replace' && event.input.text !== undefined) {
				return { ...state, previousBaseline: state.baseline, baseline: event.input.text, notice: undefined };
			}
			if (event.input.kind === 'text' && state.baseline === undefined) {
				// 欄の中身が分からないまま足した（手動・古い PC・contenteditable）。入力欄は空に戻す（今までと同じ）。
				return { ...state, text: '', notice: undefined };
			}
			return { ...state, notice: undefined };
		}
		case 'rejected':
			// 置き換えを断られたら、基準を送る前に戻す（欄の中身は変わっていない）。
			return event.input === 'replace'
				? { ...state, baseline: state.previousBaseline, previousBaseline: undefined, notice: event.reason }
				: { ...state, notice: event.reason };
		case 'focus': {
			const focus = event.focus;
			if (state.targetId !== undefined && focus.targetId !== state.targetId) {
				return state;
			}
			if (focus.seq <= state.seq) {
				return state;
			}
			const seq = focus.seq;
			if (!focus.focused) {
				// 自動で開いたものだけ閉じる。直しかけの文字（基準と違う）があれば残す。
				if (state.open && state.auto && unedited(state)) {
					return { ...BROWSER_KEYBOARD_CLOSED, seq, targetId: focus.targetId };
				}
				return { ...state, seq, targetId: focus.targetId, field: undefined, fieldId: undefined };
			}
			const value = knownValue(focus);
			// 欄が替わった（番号が違う・番号が分からない欄から移った）。前の欄のための文字は持ち越さない。
			const sameField = state.field !== undefined && focus.fieldId !== undefined && state.fieldId === focus.fieldId;
			const fieldState = {
				field: focus.field,
				fieldId: focus.fieldId,
				secret: focus.secret === true,
				seq,
				targetId: focus.targetId,
			};
			if (focus.fromTap === true) {
				// タップで入った（同じ欄をもう一度押したときも来る）。同じ欄で直しかけなら上書きしない。
				const keepEdits = state.open && sameField && !unedited(state);
				return {
					...state,
					...fieldState,
					open: true,
					auto: state.open ? state.auto : true,
					text: keepEdits ? state.text : value ?? '',
					baseline: value,
					previousBaseline: undefined,
					notice: sameField ? state.notice : undefined,
				};
			}
			if (!state.open) {
				// タップ以外（ページが自分でフォーカスした・PC で操作した）では開かない。
				return { ...state, seq, targetId: focus.targetId };
			}
			if (!sameField) {
				// 開いている間にページがフォーカスを動かした（OTP の自動送り・autofocus など）。新しい欄に合わせ直す。
				return { ...state, ...fieldState, text: value ?? '', baseline: value, previousBaseline: undefined, notice: undefined };
			}
			// 同じ欄の中身の変化。直していなければ追従する。
			return {
				...state,
				...fieldState,
				text: unedited(state) && value !== undefined ? value : state.text,
				baseline: value,
			};
		}
	}
}

/**
 * Return・送るボタンで送るもの。
 *
 * PC の欄と向き合っていて（`replace` を受ける PC）中身と番号が分かっているなら、同じ中身は Enter、違えば
 * その欄の置き換え。それ以外（手動・古い PC・中身が分からない・contenteditable）は今までどおり、文字があれば
 * 足し、空なら Enter。
 */
export function browserKeyboardSubmit(state: BrowserKeyboardState, keysSupported: boolean, replaceSupported: boolean): BrowserInput | undefined {
	if (replaceSupported && state.field !== undefined && state.fieldId !== undefined && state.baseline !== undefined) {
		if (state.text === state.baseline) {
			return keysSupported ? { kind: 'key', key: 'Enter' } : undefined;
		}
		return { kind: 'replace', text: state.text, fieldId: state.fieldId };
	}
	return browserSubmitInput(state.text, keysSupported);
}

/** 入力欄の見出し（何を直しているか）。 */
export function browserKeyboardPlaceholder(state: BrowserKeyboardState): string {
	if (state.secret) {
		return 'パスワードを入力…';
	}
	return state.field !== undefined && state.baseline === undefined ? '欄に足す文字…' : 'ページに入力…';
}

/** PC に断られた理由の文。 */
export function browserKeyboardNotice(state: BrowserKeyboardState): string | undefined {
	switch (state.notice) {
		case 'field-changed':
			return 'ページの欄が替わったため送りませんでした';
		case 'too-long':
			return '長すぎるため送りませんでした';
		default:
			return undefined;
	}
}

const INPUT_TYPE_LABELS: { readonly [type: string]: string } = {
	search: '検索',
	email: 'メール',
	url: 'URL',
	tel: '電話番号',
	number: '数字',
	password: 'パスワード',
	text: '文字',
};

/** 文字入力の見出しの行（いま向き合っている PC の欄）。欄と向き合っていなければ `undefined`。 */
export function browserFieldCaption(state: BrowserKeyboardState, inputType: string | undefined): string | undefined {
	if (state.field === undefined) {
		return undefined;
	}
	const kind = state.secret
		? 'パスワード'
		: state.field === 'textarea' ? '複数行の欄'
			: state.field === 'contenteditable' ? '編集できる領域'
				: INPUT_TYPE_LABELS[(inputType ?? 'text').toLowerCase()] ?? '文字';
	const typeNote = state.field === 'text' && inputType !== undefined ? `（type=${inputType.toLowerCase()}）` : '';
	const detail = state.secret
		? '中身は受け取りません'
		: state.field === 'contenteditable' ? '書式を残すため、打った文字を足します'
			: state.baseline === undefined ? '長いので、打った文字を足します' : `入力済み ${[...state.baseline].length} 文字`;
	return `ページの欄: ${kind}${typeNote} · ${detail}`;
}
