/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

// ファイルのビューア（PDF・Markdown・画像）で、開いてから最初に描かれるまでの時間を Sentry へ送る。
//
// 使い方（ビューアのエディタから）:
//   const timing = startParadisViewerOpenTiming('pdf');   // 入力を受け取ったとき（setInput）
//   timing.painted({ safe_pages: 12 });                    // 最初に描けたとき（1 回だけ効く）
//   timing.dispose();                                      // 描く前に別のファイルへ移った・閉じた（送らない）
//
// 送るのは、ウィンドウごと・ビューアの種類ごとに、描けた 1 回目と 2 回目だけ。1 回目は
// ライブラリや webview の準備を含み、2 回目はそれが済んだ後の速さになる。3 回目以降は送らない
// （数を絞り、遅い環境の分布だけを取る）。
//
// Sentry の落とし穴に合わせた書き方:
//  - renderer の Sentry は await を跨ぐと実行中の span を失う。時刻だけ持っておき、描けたところで
//    1 つの span（`para.file-viewers.open-paint`）にまとめて送る（`paradisMobileFileTiming.ts` と同じ形）
//  - 送るのは数値と決まった語だけ。ファイル名・パス・中身は送らない。`values` に渡してよいのも
//    件数・大きさ・真偽だけにすること
//  - attribute の名前に、Sentry のプロジェクト設定でスクラブされる語（token・session・command・
//    terminal・cwd・prompt・env など）を含めない。部分一致で値ごと消える

import { IDisposable } from '../../../../base/common/lifecycle.js';
import { ParadisSpanAttributes, runInParadisSpan } from '../../sentry/common/paradisSentryDiagnostics.js';

/** 測るビューアの種類。 */
export type ParadisViewerOpenKind = 'pdf' | 'markdown' | 'image';

/** 1 件の計測を送る口。テストでは差し替える。 */
export type ParadisViewerOpenRecorder = (attributes: ParadisSpanAttributes) => void;

/** 種類ごとに送る回数（1 回目と 2 回目）。 */
export const PARADIS_VIEWER_OPEN_REPORTED_COUNT = 2;

/** 開いてから描けるまでの 1 回分の計測。`dispose` で取りやめる（送らない）。 */
export interface IParadisViewerOpenTiming extends IDisposable {
	/**
	 * 最初に描けたところで呼ぶ。2 回目以降の呼び出しと、`dispose` の後の呼び出しは何もしない。
	 * `values` には件数・大きさ・真偽だけを入れる（ファイル名・パス・中身は入れない）。
	 */
	painted(values?: ParadisSpanAttributes): void;
}

/** 描けた回数を種類ごとに数える台帳。ウィンドウ（renderer）につき 1 つ。テストでは別に作る。 */
export class ParadisViewerOpenCounter {
	private readonly _counts = new Map<ParadisViewerOpenKind, number>();

	/** 描けた回数を 1 つ進め、何回目かを返す。 */
	next(kind: ParadisViewerOpenKind): number {
		const ordinal = (this._counts.get(kind) ?? 0) + 1;
		this._counts.set(kind, ordinal);
		return ordinal;
	}
}

const sharedCounter = new ParadisViewerOpenCounter();

function recordWithSentry(attributes: ParadisSpanAttributes): void {
	runInParadisSpan('file-viewers', 'open-paint', attributes, () => { });
}

export interface IParadisViewerOpenTimingOptions {
	readonly recorder?: ParadisViewerOpenRecorder;
	readonly counter?: ParadisViewerOpenCounter;
	readonly now?: () => number;
}

/**
 * 開いてから最初に描かれるまでを測り始める。入力を受け取った時点（`setInput`）で呼ぶ。
 *
 * **計測の失敗でビューアを巻き込まないよう、ここも `painted` も投げない。**
 */
export function startParadisViewerOpenTiming(kind: ParadisViewerOpenKind, options: IParadisViewerOpenTimingOptions = {}): IParadisViewerOpenTiming {
	const now = options.now ?? (() => performance.now());
	const recorder = options.recorder ?? recordWithSentry;
	const counter = options.counter ?? sharedCounter;
	const startedAt = now();
	let finished = false;
	return {
		painted(values?: ParadisSpanAttributes): void {
			if (finished) {
				return;
			}
			finished = true;
			try {
				const ordinal = counter.next(kind);
				if (ordinal > PARADIS_VIEWER_OPEN_REPORTED_COUNT) {
					return;
				}
				recorder({
					...values,
					safe_viewer: kind,
					safe_open_ordinal: ordinal,
					safe_paint_ms: Math.max(0, Math.round(now() - startedAt)),
				});
			} catch {
				// 計測は捨ててよい
			}
		},
		dispose(): void {
			finished = true;
		},
	};
}
