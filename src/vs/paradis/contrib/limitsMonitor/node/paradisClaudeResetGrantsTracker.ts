/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

// Claude のリミットリセットの読み取りを、アカウントごとに間を空けて行う（手元の paradisClaudeAccountService.ts と
// 接続先の paradisClaudeHostUsage.ts が使う）。
//
//  - 使用量が取れたとき（同じトークン）にだけ呼ばれ、前の読み取りから {@link PARADIS_CLAUDE_RESET_GRANTS_INTERVAL_MS}
//    経っていれば 1 回読む。使用量の取得の間隔（最短 3 分）より必ず少ない回数になる
//  - 失敗（429・401・通信の失敗・形が違う）は使用量の状態に一切触れない。前に読めた束はそのまま見せ、
//    429 のときは長めに空ける
//  - ログには件数と種類だけを出す（トークン・メール・応答本文・束の ID は出さない）。同じ内容は繰り返さない

import { ILogService } from '../../../../platform/log/common/log.js';
import { IParadisClaudeResetGrant } from '../common/paradisLimitsMonitor.js';
import { IParadisClaudeOAuthClient } from './paradisClaudeOAuthClient.js';

/** 読み取りの間隔。券は日単位でしか変わらない。 */
export const PARADIS_CLAUDE_RESET_GRANTS_INTERVAL_MS = 30 * 60_000;
/** 429 を受けたときに空ける最短の時間。 */
const RATE_LIMITED_WAIT_MS = 60 * 60_000;

interface IGrantsEntry {
	grants?: readonly IParadisClaudeResetGrant[];
	nextAt: number;
	/** 最後にログへ出した内容（同じなら繰り返さない）。 */
	logged?: string;
}

export class ParadisClaudeResetGrantsTracker {

	private readonly entries = new Map<string, IGrantsEntry>();

	constructor(
		private readonly oauth: IParadisClaudeOAuthClient,
		private readonly logService: ILogService,
		private readonly logPrefix: string,
		private readonly now: () => number,
	) { }

	/**
	 * 使用量が取れた直後に呼ぶ。間隔が来ていれば読み、来ていなければ何もしない。例外は投げない。
	 * @param key アカウントの鍵（別のアカウントの束を混ぜないよう、アカウントが変わったら鍵も変わること）
	 */
	async refreshIfDue(key: string, accessToken: string): Promise<void> {
		const now = this.now();
		const entry = this.entries.get(key) ?? { nextAt: 0 };
		if (now < entry.nextAt) {
			return;
		}
		// 読み取りの途中に次の使用量の取得が来ても、二重に読まない。
		entry.nextAt = now + PARADIS_CLAUDE_RESET_GRANTS_INTERVAL_MS;
		this.entries.set(key, entry);
		let summary: string;
		try {
			const result = await this.oauth.fetchResetGrants(accessToken);
			if (this.entries.get(key) !== entry) {
				// 読んでいる間にアカウントが外された。
				return;
			}
			switch (result.kind) {
				case 'ok':
					entry.grants = result.grants;
					summary = result.grants === undefined
						? 'the response has no cedar_ember block'
						: `${result.grants.length} grant(s)${result.grants.length > 0 ? ` (${result.grants.map(grant => `${grant.kind} x${grant.left}`).join(', ')})` : ''}`;
					break;
				case 'http':
					if (result.status === 429) {
						entry.nextAt = now + Math.max(RATE_LIMITED_WAIT_MS, (result.retryAfterS ?? 0) * 1000);
					}
					summary = `HTTP ${result.status}`;
					break;
				case 'network':
					summary = 'could not reach the usage API';
					break;
			}
		} catch (error) {
			summary = `unexpected failure: ${(error as Error).message}`;
		}
		if (entry.logged !== summary) {
			entry.logged = summary;
			this.logService.info(`${this.logPrefix} limit resets: ${summary}`);
		}
	}

	/** 前に読めた束（期限の過ぎたものは除く）。読めていなければ undefined。 */
	get(key: string): readonly IParadisClaudeResetGrant[] | undefined {
		const grants = this.entries.get(key)?.grants;
		if (grants === undefined) {
			return undefined;
		}
		const now = this.now();
		return grants.filter(grant => grant.endsAt === undefined || grant.endsAt > now);
	}

	/** そのアカウントの束を捨てる（一覧から外れた・別のアカウントにログインし直した）。 */
	delete(key: string): void {
		this.entries.delete(key);
	}

	/** `keys` に無いアカウントの束を捨てる。 */
	retain(keys: ReadonlySet<string>): void {
		for (const key of [...this.entries.keys()]) {
			if (!keys.has(key)) {
				this.entries.delete(key);
			}
		}
	}
}
