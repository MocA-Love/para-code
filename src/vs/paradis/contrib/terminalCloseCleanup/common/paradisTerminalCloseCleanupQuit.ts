/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

// 「Para Code を終了するときは、閉じたターミナルの裏のプロセスを止めない」（W2-32 / Q136）の印。
//
// 設定の説明どおり、止めるのはタブやウィンドウでターミナルを閉じたときだけにする。終了のときも
// ウィンドウはターミナルを 1 本ずつ閉じる（`shutdown`）ので、pty ホストの側からは区別が付かない。
// そこでウィンドウが終了を決めた時点で、この印を pty ホストへ立てさせる（`paradisSetAppQuitting`）。
// 止めるかどうかを決めるのは pty ホストの中（アプリの中の器と、常駐へ頼む器の両方）なので、印も
// pty ホストのプロセスに 1 つだけ置く。
//
// 印は立てたまま放っておかない。終了が取り消されたウィンドウは下ろしに来るが、下ろしに来ない
// 場合がある（別のウィンドウが取り消した・ウィンドウが落ちた・pty ホスト一式を常駐にしていて
// アプリより長く生きる）。そのため一定時間で自然に切れる。切れた後は今までどおり止める側に戻る。

/** 印が効いている時間。終了を決めてから各ターミナルが閉じられるまでに収まる長さにしてある。 */
export const PARADIS_CLOSE_CLEANUP_QUIT_HOLD_MS = 2 * 60 * 1000;

/** 終了中かどうか。pty ホストのプロセスに 1 つ（{@link paradisCloseCleanupQuitGate}）。 */
export class ParadisCloseCleanupQuitGate {

	private quittingSince: number | undefined;

	constructor(private readonly now: () => number = Date.now) { }

	/** 終了が決まった（true）・取り消された（false）。 */
	set(quitting: boolean): void {
		this.quittingSince = quitting ? this.now() : undefined;
	}

	/** いま終了中か。印を立ててから {@link PARADIS_CLOSE_CLEANUP_QUIT_HOLD_MS} を過ぎたら終了中ではない。 */
	isQuitting(): boolean {
		return this.quittingSince !== undefined && this.now() - this.quittingSince < PARADIS_CLOSE_CLEANUP_QUIT_HOLD_MS;
	}
}

/** このプロセスの印。 */
export const paradisCloseCleanupQuitGate = new ParadisCloseCleanupQuitGate();

/**
 * いま閉じられたターミナルの裏のプロセスを止めるか。
 *
 * @param configured 設定と OS から決まる値（`paradisShouldStopBackgroundOnClose`）。
 */
export function paradisShouldStopDescendantsNow(configured: boolean, gate: ParadisCloseCleanupQuitGate = paradisCloseCleanupQuitGate): boolean {
	return configured && !gate.isQuitting();
}

/**
 * この閉じ方でアプリが終了するか。
 *
 * QUIT に加えて、macOS 以外で最後の 1 枚のウィンドウを閉じた CLOSE もアプリの終了になる
 * （upstream の `terminalService._shouldReviveProcesses` と同じ見方）。
 */
export function paradisShutdownQuitsApp(input: { readonly isQuit: boolean; readonly isClose: boolean; readonly windowCount: number | undefined; readonly isMacintosh: boolean }): boolean {
	return input.isQuit || (input.isClose && !input.isMacintosh && input.windowCount === 1);
}
