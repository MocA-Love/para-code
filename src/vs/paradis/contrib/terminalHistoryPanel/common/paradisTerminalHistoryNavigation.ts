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

import { type IPromptInputModel } from '../../../../platform/terminal/common/capabilities/commandDetection/promptInputModel.js';
import { paradisIsTerminalPromptSuggestEligible } from '../../terminalHistorySuggest/common/paradisTerminalSuggestEligibility.js';

/** ターミナルへ送られた入力 1 回分の種類。 */
export const enum ParadisTerminalInputKind {
	/** シェルの履歴を 1 つ遡るキー（↑、Ctrl+P）。 */
	HistoryPrevious = 'historyPrevious',
	/** シェルの履歴を 1 つ新しい方へ進めるキー（↓、Ctrl+N）。 */
	HistoryNext = 'historyNext',
	/** 入力行を確定・破棄するキー（Enter、Ctrl+C）。 */
	Submit = 'submit',
	/** 入力行を自分で変えるもの（文字、貼り付け、Backspace、Ctrl+U、←→ など）。 */
	Edit = 'edit',
	/** ターミナルが自動で返す応答（フォーカスの通知、マウス、DA・CPR など）。人の操作ではない。 */
	Ignore = 'ignore',
}

const HISTORY_PREVIOUS = new Set(['\x1b[A', '\x1bOA', '\x10']);
const HISTORY_NEXT = new Set(['\x1b[B', '\x1bOB', '\x0e']);

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
	if (data === '\r' || data === '\n' || data === '\r\n' || data === '\x03') {
		return ParadisTerminalInputKind.Submit;
	}
	if (isTerminalReply(data)) {
		return ParadisTerminalInputKind.Ignore;
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

/** 「遡り中」の推測。 */
export interface IParadisHistoryNavigationState {
	/** シェルの ↑ で履歴を遡っている最中か。 */
	readonly navigating: boolean;
	/** 遡り始める前の入力行（シェルは最新を越えるとこの行に戻す）。 */
	readonly lineBeforeNavigation: string | undefined;
	/** 最後に送った履歴のキー。 */
	readonly lastMove: 'previous' | 'next' | undefined;
}

export const PARADIS_INITIAL_NAVIGATION_STATE: IParadisHistoryNavigationState = Object.freeze({ navigating: false, lineBeforeNavigation: undefined, lastMove: undefined });

export type ParadisHistoryNavigationEvent =
	/** ユーザーの入力をシェルへ送った。`promptText` は送る直前の入力行（ゴースト文字を除く）。 */
	| { readonly kind: 'input'; readonly input: ParadisTerminalInputKind; readonly promptText: string }
	/** シェルが入力行を書き換えた（シェル統合が読み取った新しい入力行。ゴースト文字を除く）。 */
	| { readonly kind: 'prompt'; readonly promptText: string }
	/** コマンドが実行された・終わった・新しいプロンプトが出た。 */
	| { readonly kind: 'reset' };

/**
 * 推測を 1 歩進める。
 *
 * - 空でも打った後でも、↑（Ctrl+P）をシェルへ送ったら遡り中。遡る前の入力行を覚えておく
 * - 遡り中の ↓ はシェルへ渡したまま（遡り中のまま）。入力行が遡る前の行に戻ったら遡りは終わり
 *   （シェルは最新を越えると遡る前の行を戻す）
 * - 文字・貼り付け・Backspace・Ctrl+U・←→ などで入力行を自分で変えたら、遡りは終わり
 *   （呼び出した行を編集し始めたら、その行は「自分で打った」もの）
 * - Enter・Ctrl+C、コマンドの実行・終了で初めに戻す
 */
export function paradisNextNavigationState(state: IParadisHistoryNavigationState, event: ParadisHistoryNavigationEvent): IParadisHistoryNavigationState {
	switch (event.kind) {
		case 'reset':
			return PARADIS_INITIAL_NAVIGATION_STATE;
		case 'prompt':
			if (state.navigating && state.lastMove === 'next' && event.promptText === state.lineBeforeNavigation) {
				return PARADIS_INITIAL_NAVIGATION_STATE;
			}
			return state;
		case 'input':
			switch (event.input) {
				case ParadisTerminalInputKind.HistoryPrevious:
					return state.navigating
						? (state.lastMove === 'previous' ? state : { ...state, lastMove: 'previous' })
						: { navigating: true, lineBeforeNavigation: event.promptText, lastMove: 'previous' };
				case ParadisTerminalInputKind.HistoryNext:
					return state.navigating ? (state.lastMove === 'next' ? state : { ...state, lastMove: 'next' }) : state;
				case ParadisTerminalInputKind.Submit:
				case ParadisTerminalInputKind.Edit:
					return state === PARADIS_INITIAL_NAVIGATION_STATE ? state : PARADIS_INITIAL_NAVIGATION_STATE;
				case ParadisTerminalInputKind.Ignore:
					return state;
			}
	}
}

/** 入力行の文字（ゴースト文字を除く）。 */
export function paradisPromptTextWithoutGhost(model: Pick<IPromptInputModel, 'value' | 'ghostTextIndex'>): string {
	return model.ghostTextIndex === -1 ? model.value : model.value.substring(0, model.ghostTextIndex);
}

/**
 * ↓ で履歴の一覧を開いてよいか。自分で打った文字があり（ゴースト文字は数えない）、遡り中でなく、
 * コマンドの実行中でも IME の変換中でもないときだけ開く。
 */
export function paradisCanOpenHistoryPanel(
	state: IParadisHistoryNavigationState,
	model: Pick<IPromptInputModel, 'state' | 'value' | 'ghostTextIndex'>,
	executingCommand: string | undefined,
	isComposing: boolean,
): boolean {
	return !state.navigating && !isComposing && paradisIsTerminalPromptSuggestEligible(model, executingCommand);
}
