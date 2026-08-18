// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

/**
 * 復帰直後、state がまだ届いていない間に来たフレームを一時的に預かるキュー。
 *
 * これまでは state 到着前のフレームを handleFrame の冒頭で無条件に捨てていたため、復帰時は
 * 「state を要求 → 返信を待つ → attach を送る → 中身が返る」の2往復が必要だった。attach を
 * state と同じフラッシュで先に送れば1往復で済むが、その応答は state より先に着きうる。
 * そこで届いた順に預かっておき、state を適用した直後に同じ順序で流し直す。
 *
 * **上限に達した場合は再生してはいけない。** 途中が欠けたまま繋ぐと、画面は一見更新されて
 * いるのに実際には抜けがある状態になり、しかもそれが分からない。溢れたときは預かりを全部
 * 捨てて `overflowed` を返し、呼び出し側に一括再購読へ倒してもらう。
 *
 * 上限のうち件数と時間は既存の実装値そのもの、バイトだけは独自の値:
 * - 件数 200: PC側 agent snapshot の送信上限 `SNAPSHOT_SEND_LIMIT` と同じ
 * - 時間 15秒: PC側 `deferAttach` のタイムアウト。これを過ぎるとPC側が既に諦めている
 * - バイト 512KiB: 対応する既存値は無い（`MAX_TERM_BUFFER` は表示文字数で単位が違う）。
 *   agent の全量スナップショットは理論上 200件×6000文字まで膨らむため、**epoch が変わった
 *   直後などに全量が飛ぶと超えて再購読へ倒れることがある**。そこは1往復に戻るだけで壊れない
 *   ので、まず保持メモリ側を優先した。実測が取れたら見直す。
 */

import type { Frame } from '@para/protocol';

/**
 * 預かる対象のチャネル。要求と応答が1対1で対応する系（fs / scm / browser など）は
 * 取りこぼしても再要求で回復するので預からない。
 */
const RESUMABLE_CHANNELS: ReadonlySet<string> = new Set(['agent', 'term', 'notify']);

export const RESUME_BUFFER_MAX_BYTES = 512 * 1024;
export const RESUME_BUFFER_MAX_FRAMES = 200;
export const RESUME_BUFFER_TTL_MS = 15_000;

export interface ResumeFrameDrain {
	/** 再生するフレーム（届いた順）。`overflowed` のときは必ず空。 */
	readonly frames: readonly Frame[];
	/** 取りこぼしがあった。**true なら再生せず、購読をやり直すこと。** */
	readonly overflowed: boolean;
}

export class ResumeFrameBuffer {
	private entries: { readonly frame: Frame; readonly at: number; readonly bytes: number }[] = [];
	private bytes = 0;
	private overflowed = false;

	/** `now` を差し替えられるのは、TTL の境目を実時間を待たずに検証するため。 */
	constructor(private readonly now: () => number = Date.now) { }

	/**
	 * フレームを預かる。対象外のチャネルは黙って捨てる（要求と応答が1対1で対応する系は
	 * 取りこぼしても再要求で回復するため）。上限に達した時点で預かりを全部捨て、以降は
	 * `drain()` が `overflowed` を返すまで何も溜めない。
	 */
	push(frame: Frame): void {
		if (!RESUMABLE_CHANNELS.has(frame.ch) || this.overflowed) {
			return;
		}
		const bytes = frame.payload.byteLength;
		if (this.entries.length + 1 > RESUME_BUFFER_MAX_FRAMES || this.bytes + bytes > RESUME_BUFFER_MAX_BYTES) {
			this.entries = [];
			this.bytes = 0;
			this.overflowed = true;
			return;
		}
		this.entries.push({ frame, at: this.now(), bytes });
		this.bytes += bytes;
	}

	/** 預かっていたぶんを取り出して空にする。取り出した側は必ず `overflowed` を見ること。 */
	drain(): ResumeFrameDrain {
		const now = this.now();
		// 古すぎるフレームは、その先に届いたぶんとの連続性も保証できない。1件でも期限切れが
		// あれば全体を捨てて再購読へ倒す（部分的に流すと欠けたまま繋がる）。
		const expired = this.entries.some(entry => now - entry.at > RESUME_BUFFER_TTL_MS);
		const overflowed = this.overflowed || expired;
		const frames = overflowed ? [] : this.entries.map(entry => entry.frame);
		this.clear();
		return { frames, overflowed };
	}

	/** 預かりを破棄する（溢れの記録ごと捨てる）。 */
	clear(): void {
		this.entries = [];
		this.bytes = 0;
		this.overflowed = false;
	}

	/** 預かっている件数（テストと診断用）。 */
	get size(): number {
		return this.entries.length;
	}
}
