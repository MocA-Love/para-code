/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

// 常駐ターミナルの「引き継ぎ」の記録の形。pty ホストが数え、窓が受け取って Sentry へ送る。
//
// **数えるのは pty ホスト、送るのは窓。** Sentry の SDK が動いているのは Electron の main・
// renderer・shared process だけで、pty ホスト（手元でも SSH 先でも）と REH サーバーには無い。
// SSH 先で起きたことを知る手立てはこれしかないので、pty ホストに数えさせて窓から取りに行く。
//
// 取りに行くと**数えた分は消える**（`paradisTakePtyHandoverReport`）。手元では同じ pty ホストを
// 窓の数だけが見に来るので、消さないと同じ出来事が窓の数だけ送られる。SSH 先でも、同じ接続先へ
// 繋いだ別の PC の窓と二重にならない。
//
// 中身は件数・時間・固定の語だけ。パス・スペース名・題名・画面の中身は入れない。

import { IParadisRelayedFailure } from '../../sentry/common/paradisRelayedDiagnostics.js';
import { ParadisPtyRebuildReason } from './paradisPtyReattachPlan.js';

/** 接続先（REH）でこの記録を出すチャネル。手元では pty ホストへ直接聞く。 */
export const PARADIS_PTY_HANDOVER_CHANNEL = 'paradisPtyHandover';

/** 引き取りを走らせたきっかけ。 */
export type ParadisPtyAdoptTrigger =
	/** pty ホストが起きたとき（今までの唯一の機会）。 */
	| 'startup'
	/** 別の pty ホストが握っていた端末が空いたのを、見回りで見つけた。 */
	| 'poll'
	/** 古い版のサーバーを止めた直後。 */
	| 'stale-stop';

/** 引き取りを1回走らせた結果。 */
export interface IParadisPtyAdoptionRun {
	readonly trigger: ParadisPtyAdoptTrigger;
	/** 常駐に聞けたか。聞けなければ他の数は 0。 */
	readonly reachable: boolean;
	/** 器に載せた本数。 */
	readonly adopted: number;
	/** 別の pty ホストが見ているので残した本数。 */
	readonly foreign: number;
	/** 器を作れずに残した本数。 */
	readonly failed: number;
	/** 載せた本数のうち、すでに終わっていたもの（閉じている間に走り切った）。 */
	readonly finished: number;
	/** 配置を戻せたスペースの数。 */
	readonly layouts: number;
	readonly durationMs: number;
}

/** 戻ってきたときの埋め直しの内訳（`paradisPtyReattachPlan.ts`）。 */
export interface IParadisPtyReattachCounts {
	readonly unchanged: number;
	readonly tail: number;
	readonly rebuild: number;
	/** 戻ってきたら別の pty ホストが見ていた（更新後の版へ移った）。 */
	readonly handedOff: number;
	/** 戻ってきたら常駐にもう無かった。 */
	readonly gone: number;
	/** 常駐と話せなかった。 */
	readonly failed: number;
	readonly tailChars: number;
	readonly rebuildChars: number;
	readonly maxRebuildMs: number;
	readonly rebuildReasons: Readonly<Partial<Record<ParadisPtyRebuildReason, number>>>;
}

/** pty ホストが数えたもの。取りに来るたびに、前回からの分を返す。 */
export interface IParadisPtyHandoverReport {
	readonly protocolVersion: number;
	/** pty ホストが動いている機械（`process.platform`）。SSH 先なら接続先の OS。 */
	readonly platform: string;
	/** いま常駐に繋がっているか。 */
	readonly daemon: boolean;
	/** いま別の pty ホストが見ているので引き取れずにいる本数（前回からの差分ではなく今の値）。 */
	readonly foreignHeld: number;
	readonly adoptions: readonly IParadisPtyAdoptionRun[];
	/** 窓が離れたので常駐から手を離した本数。 */
	readonly letGo: number;
	readonly letGoFailed: number;
	readonly reattach: IParadisPtyReattachCounts;
	/** 猶予切れで終わらせようとしたら別の pty ホストが見ていたので、手を引いた本数。 */
	readonly spared: number;
	/** 手を離している間に終わったので、戻ってくるまで終了を伝えずにおいた本数。 */
	readonly finishedWhileAway: number;
	/**
	 * pty host（手元でも SSH 先でも）で出た明示の報告の種類と件数（`paradisRelayedDiagnostics.ts`）。
	 * 省略可能なのは互換のため: 古い pty host は付けず、古い窓は読まずに捨てる。
	 */
	readonly failures?: readonly IParadisRelayedFailure[];
}

/** 接続先のチャネルの口。手元では同じものを `IPtyService` の省略可能なメソッドとして持つ。 */
export interface IParadisPtyHandoverService {
	/** 前回からの分を受け取る。pty ホストが起きていなければ undefined（起こさない）。 */
	takeReport(): Promise<IParadisPtyHandoverReport | undefined>;
	/** 別の pty ホストが握っていた端末を、空いていれば引き取る。 */
	readopt(trigger: ParadisPtyAdoptTrigger): Promise<IParadisPtyAdoptionRun | undefined>;
}

/** 記録が空か（送るものが無いか）。 */
export function paradisIsEmptyPtyHandoverReport(report: IParadisPtyHandoverReport): boolean {
	const r = report.reattach;
	return report.adoptions.length === 0
		&& (report.failures?.length ?? 0) === 0
		&& report.letGo === 0 && report.letGoFailed === 0
		&& r.unchanged === 0 && r.tail === 0 && r.rebuild === 0 && r.handedOff === 0 && r.gone === 0 && r.failed === 0
		&& report.spared === 0 && report.finishedWhileAway === 0;
}

/** Sentry の span 1本ぶん。属性は件数・時間・固定の語だけ。 */
export interface IParadisPtyHandoverSpan {
	readonly operation: 'adopt' | 'reattach';
	readonly attributes: Record<`safe_${string}`, number | string | boolean>;
}

/**
 * 記録を Sentry の span にする（送るのは窓）。
 *
 * 引き取りは1回ごとに1本、手を離す・戻るは前回からの合計を1本にまとめる。キーと値に Sentry が
 * 消す語（terminal・session・env など）を入れない（`isParadisSentryScrubbedWord`。テストで見張る）。
 */
export function paradisPtyHandoverSpans(report: IParadisPtyHandoverReport, remote: boolean): IParadisPtyHandoverSpan[] {
	const common = {
		safe_protocol: report.protocolVersion,
		safe_host_os: report.platform,
		safe_remote: remote,
		safe_foreign_held: report.foreignHeld,
	};
	const spans: IParadisPtyHandoverSpan[] = report.adoptions.map(run => ({
		operation: 'adopt',
		attributes: {
			...common,
			safe_trigger: run.trigger,
			safe_reachable: run.reachable,
			safe_adopted: run.adopted,
			safe_foreign: run.foreign,
			safe_failed: run.failed,
			safe_finished: run.finished,
			safe_layouts: run.layouts,
			safe_duration_ms: run.durationMs,
		},
	}));
	const r = report.reattach;
	if (report.letGo + report.letGoFailed + r.unchanged + r.tail + r.rebuild + r.handedOff + r.gone + r.failed + report.spared + report.finishedWhileAway > 0) {
		const reasons: Record<`safe_${string}`, number> = {};
		for (const [reason, count] of Object.entries(r.rebuildReasons)) {
			reasons[`safe_rebuild_${reason.replace(/-/g, '_')}`] = count ?? 0;
		}
		spans.push({
			operation: 'reattach',
			attributes: {
				...common,
				safe_let_go: report.letGo,
				safe_let_go_failed: report.letGoFailed,
				safe_unchanged: r.unchanged,
				safe_tail: r.tail,
				safe_tail_chars: r.tailChars,
				safe_rebuild: r.rebuild,
				safe_rebuild_chars: r.rebuildChars,
				safe_rebuild_max_ms: r.maxRebuildMs,
				safe_handed_off: r.handedOff,
				safe_gone: r.gone,
				safe_failed: r.failed,
				safe_spared: report.spared,
				safe_finished_away: report.finishedWhileAway,
				...reasons,
			},
		});
	}
	return spans;
}

/**
 * うまくいかなかったことがあれば、Sentry のメッセージ1件ぶんにまとめる（無ければ undefined）。
 *
 * レート制限は指紋（実質 operation）ごとに 10 分 3 件なので、1 回取りに来た分を1件に畳む。
 */
export function paradisPtyHandoverProblem(report: IParadisPtyHandoverReport): { readonly operation: string; readonly data: Record<`safe_${string}`, number | string | boolean> } | undefined {
	const unreachable = report.adoptions.filter(run => !run.reachable).length;
	const adoptFailed = report.adoptions.reduce((sum, run) => sum + run.failed, 0);
	const problems = unreachable + adoptFailed + report.letGoFailed + report.reattach.failed;
	if (problems === 0) {
		return undefined;
	}
	// 面ごとに operation を分ける。同じ operation だと全部が同じ「10 分 3 件」の枠を取り合う。
	const operation = unreachable > 0 ? 'failed:unreachable' : adoptFailed > 0 ? 'failed:adopt' : report.reattach.failed > 0 ? 'failed:come-back' : 'failed:let-go';
	return {
		operation,
		data: {
			safe_unreachable: unreachable,
			safe_adopt_failed: adoptFailed,
			safe_let_go_failed: report.letGoFailed,
			safe_come_back_failed: report.reattach.failed,
			safe_host_os: report.platform,
			safe_protocol: report.protocolVersion,
		},
	};
}

/** 窓が開いた後で引き取った本数（見回りで見つけたもの）。窓を再読み込みすると表示される。 */
export function paradisPtyLateAdoptions(report: IParadisPtyHandoverReport): number {
	return report.adoptions.filter(run => run.trigger === 'poll').reduce((sum, run) => sum + run.adopted, 0);
}
