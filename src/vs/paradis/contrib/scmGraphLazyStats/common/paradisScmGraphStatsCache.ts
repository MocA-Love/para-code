/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-PATCH/PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

// ソース管理のグラフのホバーに出す「変更量」(ファイル数・挿入・削除) を、ホバーを出したコミットの
// 1 件だけ数えるためのキャッシュ。本家は履歴の 1 ページ (既定 50 件) を読むたびに全件を
// `git log --shortstat` で数えていて、大きいリポジトリでは 1 回に数十秒かかっていた。
//
// - 数え終わった結果はコミットごとに持つ (コミットの中身は変わらないので消さなくてよい)。件数に上限を付け、
//   古いものから捨てる。
// - 同じコミットへの問い合わせが同時に来たら、git への問い合わせを 1 本にまとめる。
// - 待っている人が全員いなくなったら (ホバーが消えたら) 問い合わせを取り消し、遅れて届いた結果は捨てる。
// - 失敗・タイムアウトは undefined を返し、キャッシュしない (次にホバーしたときにまた数える)。

import { raceCancellation, raceTimeout } from '../../../../base/common/async.js';
import { CancellationToken, CancellationTokenSource } from '../../../../base/common/cancellation.js';

/** 1 コミットの変更量。本家の `ISCMHistoryItemStatistics` と同じ形。 */
export interface IParadisScmGraphStats {
	readonly files: number;
	readonly insertions: number;
	readonly deletions: number;
}

/** 1 コミットを数える関数。取り消されたら undefined を返してよい。 */
export type ParadisScmGraphStatsResolver = (token: CancellationToken) => Promise<IParadisScmGraphStats | undefined>;

interface IInflightRequest {
	readonly promise: Promise<IParadisScmGraphStats | undefined>;
	readonly source: CancellationTokenSource;
	waiters: number;
}

export const PARADIS_SCM_GRAPH_STATS_MAX_ENTRIES = 500;
export const PARADIS_SCM_GRAPH_STATS_TIMEOUT_MS = 10_000;

/**
 * 変更量のキャッシュと、同じコミットへの同時の問い合わせの取りまとめ。
 */
export class ParadisScmGraphStatsCache {

	private readonly entries = new Map<string, IParadisScmGraphStats>();
	private readonly inflight = new Map<string, IInflightRequest>();

	constructor(
		private readonly maxEntries: number = PARADIS_SCM_GRAPH_STATS_MAX_ENTRIES,
		private readonly timeoutMs: number = PARADIS_SCM_GRAPH_STATS_TIMEOUT_MS,
	) { }

	/** 数え終わった結果があれば返す (使ったものを新しい側へ移す)。 */
	get(key: string): IParadisScmGraphStats | undefined {
		const stats = this.entries.get(key);
		if (stats !== undefined) {
			this.entries.delete(key);
			this.entries.set(key, stats);
		}
		return stats;
	}

	/**
	 * 結果を返す。キャッシュに無ければ数える。同じ key の問い合わせが走っていれば相乗りする。
	 * `token` が取り消されたら、この呼び出しはすぐ undefined を返す。待っている呼び出しが 0 になったら
	 * 問い合わせ自体を取り消し、その結果はキャッシュしない。
	 */
	async request(key: string, resolve: ParadisScmGraphStatsResolver, token: CancellationToken): Promise<IParadisScmGraphStats | undefined> {
		const cached = this.get(key);
		if (cached !== undefined) {
			return cached;
		}
		if (token.isCancellationRequested) {
			return undefined;
		}

		let request = this.inflight.get(key);
		if (request === undefined) {
			request = this.start(key, resolve);
		}
		request.waiters++;

		const current = request;
		const listener = token.onCancellationRequested(() => this.leave(key, current));
		try {
			return await raceCancellation(current.promise, token);
		} finally {
			listener.dispose();
			if (!token.isCancellationRequested) {
				this.leave(key, current);
			}
		}
	}

	private start(key: string, resolve: ParadisScmGraphStatsResolver): IInflightRequest {
		const source = new CancellationTokenSource();
		const promise = (async () => {
			try {
				const stats = await raceTimeout(resolve(source.token), this.timeoutMs, () => source.cancel());
				if (stats === undefined || source.token.isCancellationRequested) {
					return undefined;
				}
				this.remember(key, stats);
				return stats;
			} catch {
				return undefined;
			} finally {
				if (this.inflight.get(key)?.source === source) {
					this.inflight.delete(key);
				}
				source.dispose();
			}
		})();
		const request: IInflightRequest = { promise, source, waiters: 0 };
		this.inflight.set(key, request);
		return request;
	}

	private leave(key: string, request: IInflightRequest): void {
		request.waiters--;
		if (request.waiters <= 0 && this.inflight.get(key) === request) {
			this.inflight.delete(key);
			request.source.cancel();
		}
	}

	private remember(key: string, stats: IParadisScmGraphStats): void {
		this.entries.delete(key);
		this.entries.set(key, stats);
		while (this.entries.size > this.maxEntries) {
			const oldest = this.entries.keys().next().value;
			if (oldest === undefined) {
				break;
			}
			this.entries.delete(oldest);
		}
	}
}

/** 変更が 1 つも無い (空のコミットなど) ときは、本家と同じく数字の行を出さない。 */
export function paradisHasScmGraphStats(stats: IParadisScmGraphStats | undefined): stats is IParadisScmGraphStats {
	return stats !== undefined && (stats.files > 0 || stats.insertions > 0 || stats.deletions > 0);
}
