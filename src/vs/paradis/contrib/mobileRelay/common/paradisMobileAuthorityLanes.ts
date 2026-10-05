/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-PATCH/PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

// shared process の「renderer の権限の列」を、対象ごとの短い列に分けたもの（設計 2.3）。
//
// 以前は全 renderer・全スマホの仕事が 1 本の列（rendererAuthorityChain）に並び、renderer 発のフレームは送信の完了まで
// 列を止めていた。今は鍵（対象）ごとに列を持ち、同じ鍵の仕事だけを積んだ順に 1 つずつ動かす。別の鍵の仕事は待たない。
// 鍵の決め方は呼び手が持つ（例: renderer 1 つ分の IPC の順、ターミナル 1 つへの操作、ウィンドウ 1 つへの要求）。
// 列の中の仕事は短く保つこと（送信の完了や長いネットワーク待ちを列の中で待たない）。

import type { ParadisMobileLinkMetrics } from './paradisMobileLinkMetrics.js';

/** 1 つの鍵に積める仕事の数の上限の既定値。超えた分は {@link ParadisMobileAuthorityLanes.tryRun} が断る。 */
export const PARADIS_MOBILE_AUTHORITY_LANE_MAX_PENDING = 256;

export class ParadisMobileAuthorityLanes {
	/** 鍵ごとの、最後に積んだ仕事が終わる Promise と、まだ終わっていない仕事の数。 */
	private readonly lanes = new Map<string, { tail: Promise<void>; pending: number }>();
	/** 全部の鍵の、まだ終わっていない仕事の数（計測用）。 */
	private total = 0;

	constructor(private readonly metrics?: ParadisMobileLinkMetrics) { }

	/** 今まだ終わっていない仕事の数（全部の鍵）。 */
	get pendingTotal(): number {
		return this.total;
	}

	/** その鍵で、まだ終わっていない仕事の数。 */
	pending(key: string): number {
		return this.lanes.get(key)?.pending ?? 0;
	}

	/** 鍵の列に仕事を積む。同じ鍵の前の仕事が（成否にかかわらず）終わってから動く。 */
	run<T>(key: string, task: () => Promise<T>): Promise<T> {
		const metrics = this.metrics?.enabled === true ? this.metrics : undefined;
		let lane = this.lanes.get(key);
		if (lane === undefined) {
			lane = { tail: Promise.resolve(), pending: 0 };
			this.lanes.set(key, lane);
		}
		if (metrics !== undefined) {
			// 列の深さは、積む時点で前にいる仕事の数（全部の鍵と、同じ鍵）
			metrics.observe('pc.authority.depth', this.total);
			metrics.observe('pc.authority.laneDepth', lane.pending);
		}
		lane.pending++;
		this.total++;
		const enqueuedAt = metrics?.now() ?? 0;
		const owned = lane;
		const run = owned.tail.then(async () => {
			const startedAt = metrics?.now() ?? 0;
			if (metrics !== undefined) {
				metrics.observe('pc.authority.waitMs', startedAt - enqueuedAt);
			}
			try {
				return await task();
			} finally {
				if (metrics !== undefined) {
					metrics.observeSince('pc.authority.runMs', startedAt);
				}
			}
		});
		const tail = run.then(() => undefined, () => undefined).then(() => {
			owned.pending--;
			this.total--;
			if (owned.pending === 0 && this.lanes.get(key) === owned) {
				// 空になった鍵は捨てる（ターミナル・ウィンドウの数だけ増え続けないように）
				this.lanes.delete(key);
			}
		});
		owned.tail = tail;
		return run;
	}

	/**
	 * 同じ鍵に積まれた仕事が上限以上なら積まずに undefined を返す（操作を受理する前に busy を返すため）。
	 * 積めたら {@link run} と同じ。
	 */
	tryRun<T>(key: string, task: () => Promise<T>, maxPending = PARADIS_MOBILE_AUTHORITY_LANE_MAX_PENDING): Promise<T> | undefined {
		if (this.pending(key) >= maxPending) {
			this.metrics?.count('pc.authority.busy');
			return undefined;
		}
		return this.run(key, task);
	}
}
