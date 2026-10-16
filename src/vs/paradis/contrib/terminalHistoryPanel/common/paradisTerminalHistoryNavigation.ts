/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

// ↓ で履歴の一覧を開いてよいかの判定（Q372）。
//
// ↓ はシェルの「次の履歴」と同じキーなので、シェルの ↑ で履歴を遡っている間は一覧を開かずに
// シェルへ渡す必要がある（以前はここで一覧が開き、遡った後に戻れなかった）。シェルが今どの
// 履歴を出しているかは Para Code からは見えないため、ターミナルへ送った入力の流れとプロンプトの
// 中身から「遡り中」か「自分で打った」かを推測する。判定はすべてここの純関数に置く。
//
// 迷ったときは「遡り中かもしれない」側に倒す（↓ をシェルへ渡す）。一覧を開き損ねても文字を打てば
// 開けるが、遡りの ↓ を奪うと元に戻せないため。

import { type IPromptInputModel } from '../../../../platform/terminal/common/capabilities/commandDetection/promptInputModel.js';
import { paradisIsTerminalPromptSuggestEligible } from '../../terminalHistorySuggest/common/paradisTerminalSuggestEligibility.js';

/** ターミナルへ送られた入力 1 回分の種類。 */
export const enum ParadisTerminalInputKind {
	/** シェルの履歴を 1 つ遡るキー（↑、Ctrl+P）。 */
	HistoryPrevious = 'historyPrevious',
	/** シェルの履歴を 1 つ新しい方へ進めるキー（↓、Ctrl+N）。 */
	HistoryNext = 'historyNext',
	/** 入力行を確定・破棄するキー（Enter、Ctrl+C、Ctrl+G）。 */
	Submit = 'submit',
	/** 入力行を自分で変えるもの（文字、貼り付け、Backspace、Ctrl+U など）。 */
	Edit = 'edit',
	/** カーソルを動かすだけのキー（←→、Home・End、Ctrl+A・E・B・F、Alt+B・F、Ctrl・Alt+←→）。入力行は変えない。 */
	Cursor = 'cursor',
	/** シェルの履歴の逐次検索（Ctrl+R、Ctrl+S）。 */
	Search = 'search',
	/** Esc 単独（zsh・bash の vi モードではコマンドモードに入る）。 */
	Escape = 'escape',
	/** ターミナルが自動で返す応答（フォーカスの通知、マウス、DA・CPR など）。人の操作ではない。 */
	Ignore = 'ignore',
}

const HISTORY_PREVIOUS = new Set(['\x1b[A', '\x1bOA', '\x10']);
const HISTORY_NEXT = new Set(['\x1b[B', '\x1bOB', '\x0e']);
/** カーソルを動かすだけの並び 1 つ分（先頭に一致させる）。 */
const CURSOR_SEQUENCE = /^(?:\x1b\[(?:1;\d+)?[CDHF]|\x1bO[CDHF]|\x1b\[[1478]~|[\x01\x02\x05\x06]|\x1b[bf]|\x1b\x1b\[[CD])/;

/**
 * xterm.js の `onData` に流れる 1 回分のデータを分類する。キーの自動リピートで同じキーが
 * まとめて届くこともあるので、同じ並びの繰り返しも同じ種類として扱う。
 */
export function paradisClassifyTerminalInput(data: string): ParadisTerminalInputKind {
	if (data.length === 0) {
		return ParadisTerminalInputKind.Ignore;
	}
	if (isRepeatOf(data, HISTORY_PREVIOUS)) {
		return ParadisTerminalInputKind.HistoryPrevious;
	}
	if (isRepeatOf(data, HISTORY_NEXT)) {
		return ParadisTerminalInputKind.HistoryNext;
	}
	if (data === '\r' || data === '\n' || data === '\r\n' || data === '\x03' || data === '\x07') {
		return ParadisTerminalInputKind.Submit;
	}
	if (data === '\x12' || data === '\x13') {
		return ParadisTerminalInputKind.Search;
	}
	if (data === '\x1b') {
		return ParadisTerminalInputKind.Escape;
	}
	if (isTerminalReply(data)) {
		return ParadisTerminalInputKind.Ignore;
	}
	if (isCursorOnly(data)) {
		return ParadisTerminalInputKind.Cursor;
	}
	return ParadisTerminalInputKind.Edit;
}

function isRepeatOf(data: string, sequences: ReadonlySet<string>): boolean {
	for (const sequence of sequences) {
		if (data.length % sequence.length === 0 && data === sequence.repeat(data.length / sequence.length)) {
			return true;
		}
	}
	return false;
}

function isCursorOnly(data: string): boolean {
	let rest = data;
	while (rest.length > 0) {
		const match = CURSOR_SEQUENCE.exec(rest);
		if (!match) {
			return false;
		}
		rest = rest.substring(match[0].length);
	}
	return true;
}

/** フォーカスの通知、マウスの報告、端末の問い合わせへの応答（DA・CPR・DSR・XTVERSION・OSC）。 */
function isTerminalReply(data: string): boolean {
	return data === '\x1b[I'
		|| data === '\x1b[O'
		|| /^\x1b\[<\d+;\d+;\d+[Mm]$/.test(data)
		|| (data.startsWith('\x1b[M') && data.length === 6)
		|| /^\x1b\[[?>=]?[\d;]*[cRn]$/.test(data)
		|| /^\x1bP[\s\S]*\x1b\\$/.test(data)
		|| /^\x1b\][\s\S]*(\x07|\x1b\\)$/.test(data);
}

/** vi のコマンドモードで履歴を遡る・進めるキーと、入力モードへ戻るキー。 */
const VI_HISTORY_PREVIOUS = new Set(['k', '-']);
const VI_HISTORY_NEXT = new Set(['j', '+']);
const VI_INSERT = new Set(['i', 'a', 'I', 'A', 's', 'S', 'c', 'C', 'o', 'O', 'R']);

/** 「遡り中」の推測。 */
export interface IParadisHistoryNavigationState {
	/** シェルの履歴を遡っている最中か（そうかもしれないときも true）。 */
	readonly navigating: boolean;
	/**
	 * 遡り始める前の入力行（シェルは最新を越えるとこの行に戻す）。逐次検索・vi のコマンドモード・
	 * 外からの書き換えの後は分からないので undefined（文字を打つまで遡り中のまま）。
	 */
	readonly lineBeforeNavigation: string | undefined;
	/** 最後に送った履歴のキー。 */
	readonly lastMove: 'previous' | 'next' | undefined;
	/** シェルの逐次検索（Ctrl+R）の最中か。打った文字は検索語なので、入力行の編集と見なさない。 */
	readonly searching: boolean;
	/** Esc の後（vi のコマンドモードかもしれない）。文字は編集ではなくコマンド。 */
	readonly viCommand: boolean;
}

export const PARADIS_INITIAL_NAVIGATION_STATE: IParadisHistoryNavigationState = Object.freeze({ navigating: false, lineBeforeNavigation: undefined, lastMove: undefined, searching: false, viCommand: false });

/** 入力行が分からない遡り（逐次検索・vi・外からの書き換え）。 */
const UNKNOWN_NAVIGATION: IParadisHistoryNavigationState = Object.freeze({ navigating: true, lineBeforeNavigation: undefined, lastMove: undefined, searching: false, viCommand: false });

export type ParadisHistoryNavigationEvent =
	/** ユーザーの入力（xterm.js の `onData`）をシェルへ送った。`promptText` は送る直前の入力行（ゴースト文字を除く）。 */
	| { readonly kind: 'input'; readonly data: string; readonly promptText: string }
	/** ユーザーの入力を通らずに入力行が変わった（モバイルからの送信など）。 */
	| { readonly kind: 'external' }
	/** コマンドが実行された・終わった・新しいプロンプトが出た。 */
	| { readonly kind: 'reset' };

/**
 * 推測を 1 歩進める。
 *
 * - ↑（Ctrl+P）をシェルへ送ったら遡り中。遡る前の入力行を覚えておく。遡り中の ↓ はシェルへ渡したまま
 * - 文字・貼り付け・Backspace・Ctrl+U などで入力行を自分で変えたら、遡りは終わり（呼び出した行を
 *   編集し始めたら、その行は「自分で打った」もの）。カーソルを動かすだけのキーでは終わらない
 * - Ctrl+R の逐次検索の間は、打った文字は検索語。←→・↑↓・Esc で検索を抜けても、呼び出した行が残るので遡り中
 * - Esc の後は vi のコマンドモードかもしれない。k・j は履歴の移動、i・a などで入力に戻る
 * - ユーザーの入力を通らずに入力行が変わったら、遡り中かもしれない側に倒す
 * - Enter・Ctrl+C・Ctrl+G、コマンドの実行・終了で初めに戻す
 *
 * 遡りが「遡る前の行に戻って終わった」かどうかは、↓ を押した時点の入力行で
 * {@link paradisCanOpenHistoryPanel} が確かめる（シェルの描き直しは分かれて届くことがあり、途中の
 * 入力行で決めると誤るため）。
 */
export function paradisNextNavigationState(state: IParadisHistoryNavigationState, event: ParadisHistoryNavigationEvent): IParadisHistoryNavigationState {
	switch (event.kind) {
		case 'reset':
			return PARADIS_INITIAL_NAVIGATION_STATE;
		case 'external':
			return { ...UNKNOWN_NAVIGATION, viCommand: state.viCommand };
		case 'input':
			break;
	}
	const kind = paradisClassifyTerminalInput(event.data);
	if (kind === ParadisTerminalInputKind.Ignore) {
		return state;
	}
	if (kind === ParadisTerminalInputKind.Submit) {
		return PARADIS_INITIAL_NAVIGATION_STATE;
	}
	if (kind === ParadisTerminalInputKind.Search) {
		return { ...UNKNOWN_NAVIGATION, searching: true };
	}
	if (state.searching) {
		// 検索語の入力は検索のまま。ほかのキーは検索を抜け、見つけた行が入力行に残る。
		return kind === ParadisTerminalInputKind.Edit ? state : UNKNOWN_NAVIGATION;
	}
	if (kind === ParadisTerminalInputKind.Escape) {
		return { ...UNKNOWN_NAVIGATION, viCommand: true };
	}
	if (state.viCommand) {
		if (kind === ParadisTerminalInputKind.Edit && VI_INSERT.has(event.data)) {
			return UNKNOWN_NAVIGATION;
		}
		const move = kind === ParadisTerminalInputKind.HistoryPrevious || VI_HISTORY_PREVIOUS.has(event.data) ? 'previous'
			: kind === ParadisTerminalInputKind.HistoryNext || VI_HISTORY_NEXT.has(event.data) ? 'next'
				: state.lastMove;
		return move === state.lastMove ? state : { ...state, lastMove: move };
	}
	switch (kind) {
		case ParadisTerminalInputKind.HistoryPrevious:
			return state.navigating
				? (state.lastMove === 'previous' ? state : { ...state, lastMove: 'previous' })
				: { ...PARADIS_INITIAL_NAVIGATION_STATE, navigating: true, lineBeforeNavigation: event.promptText, lastMove: 'previous' };
		case ParadisTerminalInputKind.HistoryNext:
			return state.navigating ? (state.lastMove === 'next' ? state : { ...state, lastMove: 'next' }) : state;
		case ParadisTerminalInputKind.Cursor:
			return state;
		default:
			return state === PARADIS_INITIAL_NAVIGATION_STATE ? state : PARADIS_INITIAL_NAVIGATION_STATE;
	}
}

/** 入力行の文字（ゴースト文字を除く）。 */
export function paradisPromptTextWithoutGhost(model: Pick<IPromptInputModel, 'value' | 'ghostTextIndex'>): string {
	return model.ghostTextIndex === -1 ? model.value : model.value.substring(0, model.ghostTextIndex);
}

/**
 * 遡りが終わったと見てよいか。遡る前の行が分かっていて空でなく、最後に ↓ で進め、今の入力行が
 * 遡る前の行と同じとき（シェルは最新を越えると遡る前の行に戻す）。
 */
function hasReturnedFromNavigation(state: IParadisHistoryNavigationState, promptText: string): boolean {
	return !state.searching
		&& !state.viCommand
		&& state.lastMove === 'next'
		&& state.lineBeforeNavigation !== undefined
		&& state.lineBeforeNavigation.length > 0
		&& promptText === state.lineBeforeNavigation;
}

/**
 * ↓ で履歴の一覧を開いてよいか。自分で打った文字があり（ゴースト文字は数えない）、遡り中でなく、
 * コマンドの実行中でも IME の変換中でもなく、カーソルが複数行の入力の最後の行にあるときだけ開く
 * （途中の行の ↓ はシェルのカーソル移動）。↓ を押した時点の入力行で確かめる。
 */
export function paradisCanOpenHistoryPanel(
	state: IParadisHistoryNavigationState,
	model: Pick<IPromptInputModel, 'state' | 'value' | 'ghostTextIndex' | 'cursorIndex'>,
	executingCommand: string | undefined,
	isComposing: boolean,
): boolean {
	if (isComposing || !paradisIsTerminalPromptSuggestEligible(model, executingCommand)) {
		return false;
	}
	const text = paradisPromptTextWithoutGhost(model);
	if (text.indexOf('\n', Math.max(0, model.cursorIndex)) !== -1) {
		return false;
	}
	return !state.navigating || hasReturnedFromNavigation(state, text);
}

/** ユーザーの入力からこれだけ経って入力行が変わったら、外からの書き換えと見なす（ミリ秒）。 */
export const PARADIS_EXTERNAL_PROMPT_CHANGE_MS = 1_500;

/**
 * ↑↓ の入力と、遅れて届くシェルの入力行（シェル統合の promptInputModel）を突き合わせて、↓ で一覧を
 * 開けるかを答える。ターミナル 1 つにつき 1 つ。時刻は呼び出し側が渡す。
 */
export class ParadisHistoryNavigationTracker {
	private _state: IParadisHistoryNavigationState = PARADIS_INITIAL_NAVIGATION_STATE;
	private _lastInputAt = Number.NEGATIVE_INFINITY;
	private _promptText = '';

	get state(): IParadisHistoryNavigationState {
		return this._state;
	}

	/** xterm.js の `onData`（ユーザーの入力）。`promptText` は送る直前の入力行（ゴースト文字を除く）。 */
	input(data: string, promptText: string, now: number): void {
		if (paradisClassifyTerminalInput(data) !== ParadisTerminalInputKind.Ignore) {
			this._lastInputAt = now;
		}
		this._state = paradisNextNavigationState(this._state, { kind: 'input', data, promptText });
	}

	/**
	 * Para Code 自身が入力行を書き換えた（一覧から入れた）。打った文字と同じ扱いにする。
	 */
	wrote(now: number): void {
		this._lastInputAt = now;
		this._state = PARADIS_INITIAL_NAVIGATION_STATE;
	}

	/** シェルの入力行が変わった（ゴースト文字を除く）。 */
	prompt(promptText: string, now: number): void {
		const previous = this._promptText;
		this._promptText = promptText;
		if (promptText.length > 0 && promptText !== previous && now - this._lastInputAt > PARADIS_EXTERNAL_PROMPT_CHANGE_MS) {
			this._state = paradisNextNavigationState(this._state, { kind: 'external' });
		}
	}

	/** コマンドが実行された・終わった。 */
	reset(): void {
		this._state = paradisNextNavigationState(this._state, { kind: 'reset' });
		this._promptText = '';
	}

	canOpen(model: Pick<IPromptInputModel, 'state' | 'value' | 'ghostTextIndex' | 'cursorIndex'>, executingCommand: string | undefined, isComposing: boolean): boolean {
		return paradisCanOpenHistoryPanel(this._state, model, executingCommand, isComposing);
	}
}
