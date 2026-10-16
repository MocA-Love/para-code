/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

// 手を離した端末へ同じ pty ホストが戻ってきたとき、画面をどう埋め直すかの判断（純粋な部分）。
//
// なぜ手を離すのか: 窓を閉じても pty ホストが端末を見たままだと、常駐は「まだ誰かが見ている」と
// 思い、誰も受け取ったと言わないので 10 万文字で pty を止める。しかも別のサーバー（更新後の版）が
// 引き取れない。だから窓が離れたら pty ホストも常駐から手を離す（`paradisDaemonTerminalProcess.ts`）。
//
// 代わりに、離れている間の出力は pty ホストの画面（`PersistentTerminalProcess` の直列化）へ
// 届かない。戻ってきたときに埋め直す必要があり、その埋め方を3つに分ける:
//
//  - `unchanged`: 離れている間に何も出ていない。いちばん多い（窓の再読み込み）
//  - `tail`: 増えた分が控えの最後のコマに収まっている。その分だけを流す
//  - `rebuild`: それ以外（控えを消された・こぼれた・大きさが変わった・古い常駐で量が分からない）。
//    控え全体で画面を作り直す
//
// 差分で済ませる理由は量。控えは1本で最大 10MB あり、再読み込みのたびに全部を作り直すと
// 端末の本数ぶん待たされる。

import { IParadisPtyAttachment } from './paradisPtyProtocol.js';

/** 手を離した時点で、こちらが受け取り終えていた量。 */
export interface IParadisPtyLetGoMark {
	/** 控えへ書かれた総量のうち、受け取り終えていた分（`IParadisPtyAttachment.written` と同じ数え方）。 */
	readonly written: number;
	readonly epoch: number | undefined;
}

export type ParadisPtyReattachPlan =
	| { readonly kind: 'unchanged' }
	| { readonly kind: 'tail'; readonly data: string }
	| { readonly kind: 'rebuild'; readonly reason: ParadisPtyRebuildReason };

/** 作り直す理由。Sentry へ送るので固定の短い語にする（スクラブ語を含めない）。 */
export type ParadisPtyRebuildReason =
	/** 古い常駐で、書かれた量が返ってこない。 */
	| 'no-count'
	/** 手を離した時点の量が分からない（繋いだときに量が返ってこなかった）。 */
	| 'no-mark'
	/** 控えが消された（世代が変わった）。 */
	| 'cleared'
	/** 量が巻き戻っている。控えを消されたのと同じ扱い。 */
	| 'rewound'
	/** 離れている間に古い出力がこぼれた。 */
	| 'dropped'
	/** 増えた分が最後のコマに収まっていない（大きさが変わった、または量が多い）。 */
	| 'spans-resize';

/**
 * 戻ってきたときの埋め直し方を決める。
 *
 * @param mark 手を離した時点の量。分からなければ undefined。
 * @param attachment 戻ってきたときに常駐が返したもの。
 */
export function paradisPlanPtyReattach(mark: IParadisPtyLetGoMark | undefined, attachment: IParadisPtyAttachment): ParadisPtyReattachPlan {
	if (attachment.written === undefined) {
		return { kind: 'rebuild', reason: 'no-count' };
	}
	if (mark === undefined) {
		return { kind: 'rebuild', reason: 'no-mark' };
	}
	if (mark.epoch !== attachment.epoch) {
		return { kind: 'rebuild', reason: 'cleared' };
	}
	const grown = attachment.written - mark.written;
	if (grown < 0) {
		return { kind: 'rebuild', reason: 'rewound' };
	}
	if (grown === 0) {
		return { kind: 'unchanged' };
	}
	// 控えは大きさの変わり目で区切られている。最後のコマに収まっていれば、離れている間に
	// 大きさは変わっていない（変わっていれば新しいコマが始まっている）ので、末尾をそのまま流せる。
	// `attachment.dropped` は見ない。あれは控えの**先頭**が捨てられたかで、末尾が丸ごと残って
	// いるならこちらの画面に欠けは無い（見ていた間の分は受け取り済み）。
	const last = attachment.frames.at(-1);
	if (last !== undefined && grown <= last.data.length) {
		return { kind: 'tail', data: last.data.slice(last.data.length - grown) };
	}
	const retained = attachment.frames.reduce((sum, frame) => sum + frame.data.length, 0);
	return { kind: 'rebuild', reason: grown > retained ? 'dropped' : 'spans-resize' };
}
