/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

// 起動時の起こし直し（revive）が済むまで、エディタのターミナルの繋ぎ直しを待たせる門。
//
// PC を再起動した後は、常駐が抱えていたターミナルはもう無く、保存した画面から起こし直す
// （`paradisTerminalScreens.contribution.ts`）。起こし直しは `getTerminalLayoutInfo` の中で走るが、
// エディタのタブの復元はそれと並んで走り、先に `attachToRevivedProcess` が呼ばれる。そのときは
// まだ旧い番号から新しい番号への対応が無いので、旧い番号のまま繋ぎに行って失敗し、空のシェルが
// 起きる。直後に同じタブの画面が起こし直されるが、もう誰も繋ぎに来ないので、画面は戻らず、
// 起こし直した側は誰にも見えないまま pty ホストに残る（2026-10 の実機ログで、再起動の 4 回とも
// 1〜5 本がこうなっていた）。保存した画面を読むのに main への問い合わせを挟むぶん、upstream より
// 起こし直しが遅く、競争に負けやすい。
//
// そこで、起こし直しが済む（`open`）まで繋ぎ直しを待たせる。起こし直しが一度も呼ばれない構成
// （永続セッションを切っている等）で待ち続けないよう、門を作ってから一定時間で勝手に開く。開いた
// 後に来た呼び出しは待たない（ウィンドウを開いた後のスペースの切り替えなどを遅くしない）。

/** 門を作ってから、起こし直しを待つ上限。常駐の起動待ち（最大 6 秒）と起こし直しそのものの分。 */
export const PARADIS_REVIVE_GATE_LIMIT_MS = 10_000;

export class ParadisReviveGate {

	private _open = false;
	private readonly _waiters: (() => void)[] = [];
	private readonly _deadline: number;

	constructor(
		private readonly _limitMs: number = PARADIS_REVIVE_GATE_LIMIT_MS,
		private readonly _now: () => number = Date.now,
		private readonly _setTimeout: (callback: () => void, ms: number) => unknown = (callback, ms) => setTimeout(callback, ms),
	) {
		this._deadline = this._now() + this._limitMs;
	}

	get isOpen(): boolean {
		return this._open;
	}

	/** 起こし直しが済んだ（起こすものが無かった場合を含む）。何度呼んでもよい。 */
	open(): void {
		if (this._open) {
			return;
		}
		this._open = true;
		for (const waiter of this._waiters.splice(0)) {
			waiter();
		}
	}

	/**
	 * 起こし直しを走らせ、どう終わっても（途中で投げても）門を開ける。開け忘れると、エディタの
	 * タブが上限まで待たされる。
	 */
	async openAfter<T>(revive: () => Promise<T>): Promise<T> {
		try {
			return await revive();
		} finally {
			this.open();
		}
	}

	/**
	 * 起こし直しが済むまで待つ。上限を過ぎたら待たずに返る。
	 * @returns 上限で打ち切ったなら true（呼び出し側は従来どおり繋ぎに行く）
	 */
	async whenOpen(): Promise<boolean> {
		if (this._open) {
			return false;
		}
		const remaining = this._deadline - this._now();
		if (remaining <= 0) {
			return true;
		}
		return new Promise<boolean>(resolve => {
			let settled = false;
			this._waiters.push(() => {
				if (!settled) {
					settled = true;
					resolve(false);
				}
			});
			this._setTimeout(() => {
				if (!settled) {
					settled = true;
					resolve(true);
				}
			}, remaining);
		});
	}
}
