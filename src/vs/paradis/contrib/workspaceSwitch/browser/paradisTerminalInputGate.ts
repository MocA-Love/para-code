/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import { IDisposable } from '../../../../base/common/lifecycle.js';

/**
 * スペース切り替えの最中だけ、**人間がその場で打った入力**をターミナルへ流さないためのゲート。
 *
 * 切り替えが遅い環境 (SSH 越しなど) では、ユーザーが「もう切り替わった」と思って入力を始めた
 * 時点でまだ前のスペースの端末が見えていることがある。そのまま Enter を押すと、前のスペースの
 * 作業ディレクトリでコマンドが走る。取り返しがつかない事故になり得るので、**混ざっている間は
 * 押した文字を捨てる**（キューに貯めて後から流すと、行き先が確定していないので同じ事故になる）。
 *
 * **止めてよいのは「人間の意思で発生した入力」だけ。**
 *
 * ここを `xterm` の `onData` で止めてはいけない。`onData` は `CoreService.triggerDataEvent()` の
 * 唯一の出口で、**端末がアプリへ返す自動応答も同じ経路を通る**: DA1/DA2/DA3、DSR/CPR、
 * XTVERSION、DECRQM、サイズ報告、kitty keyboard 照会、OSC の色照会、フォーカス in/out 報告。
 * ここをまとめて捨てると、毎プロンプトで CPR を投げる構成 (powerlevel10k 等) や起動時に機能照会
 * する TUI が最大20秒固まり、機能を「無し」と誤検出したまま以後ずっと続く。フォーカス報告は
 * エッジトリガなので、1回落とすとアプリ側の状態が**恒久的にずれる**。
 *
 * そこで入口ごとに止める:
 * - キーボード → `terminalInstance.ts` の `attachCustomKeyEventHandler`（既存の `_isExiting`
 *   ガードと同じ位置・同じ返し方）。**Enter もここを通るので、文字が多少漏れてもコマンドは
 *   実行されない**——これが防ぎたかった事故の本体。
 * - ペースト → `terminal.clipboard.contribution.ts` の `_paste()`（`xterm.raw.paste()` の手前）。
 *
 * 残る隙間は、keydown を伴わない挿入（絵文字ピッカーや一部の IME 確定）だけ。xterm の
 * `_inputEvent` は custom key handler を見ないため素通りする。ただし通常のキー入力は
 * `_keyDownSeen` が立つので `_inputEvent` の条件（`!ev.composed || !this._keyDownSeen`）に
 * 掛からず届かない。**文字が数個混じり得るだけで、実行はされない**ので許容する。
 *
 * 状態はモジュールスコープに置く。ゲートは「このレンダラーの全ターミナル」に一斉に効かせたい
 * もので、端末インスタンスやウィンドウごとに持たせる意味がない。
 */

/**
 * ゲートを自動で降ろすまでの時間。
 *
 * **この保険を外してはいけない。** 切り替えが永久にハングして解除側へ到達できなくなると、
 * このレンダラーの全ウィンドウの全ターミナルが入力不能になる。ゲートを立てた側の
 * `try/finally` は「例外」しか救えず、「終わらない」は救えないので、時間で必ず降ろす。
 */
export const PARADIS_TERMINAL_INPUT_GATE_TIMEOUT_MS = 20_000;

export interface IParadisTerminalInputGateOptions {
	/** 自動解除が発火したときに呼ばれる。呼び出し側でログを出すための口。 */
	readonly onAutoRelease?: () => void;
	/** 自動解除までの時間の上書き。テスト専用。 */
	readonly timeoutMs?: number;
}

/**
 * 世代。**切り替えが並走しうるので、単なる真偽値にはできない。**
 *
 * Sequencer のスロットを時間で手放すと切り替え #1 と #2 が重なる。このとき #1 の後始末が
 * 素朴に「降ろす」と、**まだ走っている #2 のゲートまで開けてしまい**、#2 は最後まで無防備に
 * なる（防ぎたかった事故がそのまま起きる）。そこで「今ゲートを握っているのは誰か」を持ち、
 * **自分が現役のときだけ**降ろす。
 */
let generation = 0;
let activeGeneration: number | undefined;
let autoReleaseTimer: ReturnType<typeof setTimeout> | undefined;

/** ターミナルへの人間の入力を今捨てるべきか。 */
export function paradisIsTerminalInputBlocked(): boolean {
	return activeGeneration !== undefined;
}

/**
 * ゲートを立て、**それを降ろすためのハンドル**を返す。
 *
 * 返り値の `dispose()` は、自分より新しい要求に追い越されていれば何もしない。解除側を
 * 複数箇所（正常終了の `finally`、ウォッチドッグ）から呼べるようにするため、二重呼び出しも無害。
 */
export function paradisBlockTerminalInput(options?: IParadisTerminalInputGateOptions): IDisposable {
	const mine = ++generation;
	activeGeneration = mine;

	// 先行世代のタイマーは捨てて、この世代の分を張り直す。残すと、先行世代の締め切りで
	// 現役のゲートが落ちる。
	if (autoReleaseTimer !== undefined) {
		clearTimeout(autoReleaseTimer);
	}
	const onAutoRelease = options?.onAutoRelease;
	autoReleaseTimer = setTimeout(() => {
		autoReleaseTimer = undefined;
		if (activeGeneration !== mine) {
			return;
		}
		activeGeneration = undefined;
		onAutoRelease?.();
	}, options?.timeoutMs ?? PARADIS_TERMINAL_INPUT_GATE_TIMEOUT_MS);

	// **`toDisposable` は使わない。** これは所有する資源ではなく「自分の番を降りる」ための札で、
	// 寿命は切り替え1回に閉じている (DisposableStore に預ける相手がいない)。`toDisposable` で
	// 作るとリーク検知の追跡対象になり、自動解除で降りた回は誰も dispose しないため、テストが
	// 実害のないリークとして落ちる。
	return {
		dispose: () => {
			if (activeGeneration !== mine) {
				return;
			}
			activeGeneration = undefined;
			if (autoReleaseTimer !== undefined) {
				clearTimeout(autoReleaseTimer);
				autoReleaseTimer = undefined;
			}
		}
	};
}

/**
 * テスト用の後始末。**製品コードから呼ばないこと** (現役の世代ごと開けてしまうため)。
 * テストが落ちた回に `blocked` が最大20秒 (実時間) 他の suite へ漏れるのを防ぐ。
 */
export function paradisResetTerminalInputGateForTest(): void {
	activeGeneration = undefined;
	if (autoReleaseTimer !== undefined) {
		clearTimeout(autoReleaseTimer);
		autoReleaseTimer = undefined;
	}
}
