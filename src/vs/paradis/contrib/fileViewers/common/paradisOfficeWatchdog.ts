/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

// Office ビューア(Word/Excel の単体・差分の4面)が「描き終わったと報告してこない」ことを検知する時計。
//
// なぜ必要か: paradisOfficeRecovery.ts の状態機械は `rendered` を受け取って初めて次へ進む。
// 描画側がそもそも一度も答えてこない経路(共有プロセスの解析が返らない、webview の script が
// 起動しない、差分の注釈が届かず描画関数まで到達しない等)は状態機械の外側にあり、`loading` の
// まま誰も何もしない。実際 Word の差分は「読み込み中…」で永久に止まり得た。
//
// 状態機械そのものにタイマーを持たせないのは、あちらが「mobile からも import できる純粋な reducer」
// である制約を守るため。時間の管理だけをこちら側に置き、発火したら `renderTimedOut` を投げてもらう。

import { Disposable } from '../../../../base/common/lifecycle.js';

/** 描き終わりの報告を待つ基本の上限。claim 済みの surface なら通常は1秒未満で返る。 */
export const PARADIS_OFFICE_RENDER_TIMEOUT_MS = 10_000;

/** 待ち時間を1段延ばす文書の大きさ。Word/Excel は解析だけで数秒かかる大きさが普通にある。 */
const PARADIS_OFFICE_LARGE_DOCUMENT_BYTES = 4 * 1024 * 1024;

/** 待ち時間の上限。ここまで待って何も届かなければ、大きさの問題ではないと判断する。 */
export const PARADIS_OFFICE_MAX_RENDER_TIMEOUT_MS = 60_000;

/**
 * 文書を読み出して解析し終わるのを待つ上限。
 *
 * **こちらは大きさで伸ばせない**。読み出す前は何バイトあるか分からないし（それを知るために
 * stat を足すと、経路ごとに新しい失敗の仕方が増える）、Excel の解析は共有プロセス側で走るので
 * renderer からは進捗も見えない。「遅い」ではなく「二度と返ってこない」だけを捕まえたいので、
 * 実測で最も遅かった解析（行数の多いブックで25秒台）に十分な余裕を足した固定値にする。
 */
export const PARADIS_OFFICE_SOURCE_TIMEOUT_MS = 60_000;

/**
 * 文書の大きさに応じた待ち時間を返す。
 *
 * 固定の待ち時間にすると、巨大な .xlsx を正常に解析している最中を「返ってこない」と誤判定して
 * 作り直してしまい、かえって表示が遅くなる（作り直すほど遅くなる悪循環になる）。差分ビューアは
 * 左右2文書を読むので、**合算したバイト数**を渡すこと。
 */
export function paradisOfficeRenderTimeout(totalBytes: number): number {
	const extraChunks = Math.floor(Math.max(0, totalBytes) / PARADIS_OFFICE_LARGE_DOCUMENT_BYTES);
	return Math.min(PARADIS_OFFICE_RENDER_TIMEOUT_MS * (1 + extraChunks), PARADIS_OFFICE_MAX_RENDER_TIMEOUT_MS);
}

/** 発火時に渡される、そのとき待っていた世代と実際の経過。 */
export interface IParadisOfficeRenderTimeoutEvent {
	readonly generation: number;
	readonly elapsedMilliseconds: number;
	readonly budgetMilliseconds: number;
	readonly totalBytes: number;
}

/**
 * 世代ごとに1本だけ動く描画の見張り。
 *
 * `arm` は前の見張りを必ず捨ててから張り直すので、読み直しが重なっても時計が増えることはない。
 * `disarm` は成功・失敗・キャンセル・入力の切り替え・破棄のすべてで呼ぶこと。**呼び忘れると、
 * 既に描き終わった画面を作り直しにいく**（見張りの発火は状態機械側の世代照合で無視されるが、
 * 世代が一致する経路では実際に作り直しが走る）。
 */
export class ParadisOfficeRenderWatchdog extends Disposable {

	private handle: number | undefined;
	private armedGeneration: number | undefined;
	private armedAt = 0;
	private armedBytes = 0;

	constructor(
		private readonly onTimeout: (event: IParadisOfficeRenderTimeoutEvent) => void,
		private readonly schedule: (handler: () => void, delay: number) => number = ((handler, delay) => setTimeout(handler, delay) as unknown as number),
		private readonly cancel: (handle: number) => void = (handle => clearTimeout(handle)),
		private readonly now: () => number = Date.now,
	) {
		super();
		this._register({ dispose: () => this.disarm() });
	}

	/** いま待っている世代（何も待っていなければ undefined）。 */
	get pendingGeneration(): number | undefined {
		return this.armedGeneration;
	}

	/**
	 * 文書の読み出し・解析が返ってくるのを待ち始める。大きさが分からない区間なので固定の予算。
	 */
	armSource(generation: number): void {
		this.armWithBudget(generation, PARADIS_OFFICE_SOURCE_TIMEOUT_MS, 0);
	}

	/**
	 * `generation` の描き終わりを待ち始める。`totalBytes` は差分なら左右の合算。
	 */
	armRender(generation: number, totalBytes: number): void {
		this.armWithBudget(generation, paradisOfficeRenderTimeout(totalBytes), totalBytes);
	}

	private armWithBudget(generation: number, budget: number, totalBytes: number): void {
		this.disarm();
		this.armedGeneration = generation;
		this.armedAt = this.now();
		this.armedBytes = Math.max(0, totalBytes);
		this.handle = this.schedule(() => {
			// 発火した時点で見張りは終わり。ここで畳んでおかないと、コールバックが投げる
			// `renderTimedOut` から始まる作り直しの中で `disarm` されて、次の `arm` を消してしまう。
			const event: IParadisOfficeRenderTimeoutEvent = {
				generation,
				elapsedMilliseconds: this.now() - this.armedAt,
				budgetMilliseconds: budget,
				totalBytes: this.armedBytes,
			};
			this.handle = undefined;
			this.armedGeneration = undefined;
			this.onTimeout(event);
		}, budget);
	}

	/** 待つのをやめる。何も待っていなければ何もしない。 */
	disarm(): void {
		if (this.handle !== undefined) {
			this.cancel(this.handle);
			this.handle = undefined;
		}
		this.armedGeneration = undefined;
	}
}
