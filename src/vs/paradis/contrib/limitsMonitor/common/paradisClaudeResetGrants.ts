/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

// Claude のリミットリセット（公式の名前は Limit reset。Claude Code の中のコード名は cedar_ember）を読む純関数。
//
// Claude Code 2.1.323 は、リセットの状態を使用量 API にクエリを付けて読んでいる:
//   GET https://api.anthropic.com/api/oauth/usage?cedar_ember=1&skip_spend=1
// 応答の `cedar_ember.grants[]` が種類ごとの束で、`resets_left`（残り）・`ends_at`（期限）・`type`
// （session / weekly / full）・`gives_back_weekly`（true なら Fable リセット）・`clears`（戻す枠）を持つ。
// 形は Claude Code のバイナリの zod スキーマから復元したもので、実際の応答はまだ確かめていない。なので
// ここでは緩く確かめ、ブロックが無い・形が違うときは「取れない」（undefined）にして何も出さない。
// 種類の決め方は Claude Code と同じ（gives_back_weekly → fable、type があればそれ、無ければ clears で決める）。
//
// Para Code は表示だけで、使う操作は持たない（公式は Claude Code での利用を案内していないため）。

import { IParadisClaudeResetGrant, ParadisClaudeResetKind } from './paradisLimitsMonitor.js';
import { paradisParseClaudeResetAt } from './paradisClaudeUsage.js';
import { paradisLimitsCalendarDayOffset } from './paradisLimitsDates.js';

export const PARADIS_CLAUDE_RESET_GRANTS_URL = 'https://api.anthropic.com/api/oauth/usage?cedar_ember=1&skip_spend=1';

/** 受け取る束の数と回数の上限（壊れた応答で表示が崩れないように）。 */
const MAX_GRANTS = 20;
const MAX_RESETS_LEFT = 1000;

/** 期限が近いとみなす日数（Pro の券は配られて数日で切れるので、Codex の「今日・明日」より広くとる）。 */
export const PARADIS_CLAUDE_RESET_SOON_DAYS = 7;

/** 1 行に並べる種類の順。 */
export const PARADIS_CLAUDE_RESET_KIND_ORDER: readonly ParadisClaudeResetKind[] = ['fiveHour', 'weekly', 'fable', 'full'];

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function grantKind(grant: Record<string, unknown>): ParadisClaudeResetKind | undefined {
	if (grant.gives_back_weekly === true) {
		return 'fable';
	}
	switch (grant.type) {
		case 'session': return 'fiveHour';
		case 'weekly': return 'weekly';
		case 'full': return 'full';
	}
	if (grant.type !== undefined && grant.type !== null) {
		// 知らない種類は名前を付けられないので出さない。
		return undefined;
	}
	if (!Array.isArray(grant.clears) || !grant.clears.every(entry => typeof entry === 'string')) {
		return undefined;
	}
	const clears = grant.clears as readonly string[];
	const fiveHour = clears.includes('five_hour');
	const other = clears.some(entry => entry !== 'five_hour');
	return fiveHour && !other ? 'fiveHour' : other && !fiveHour ? 'weekly' : 'full';
}

/**
 * 使用量 API（`?cedar_ember=1`）の応答から、使えるリミットリセットの束を取り出す。
 * - `cedar_ember` のブロックが無い・オブジェクトでない: undefined（取れない。何も出さない）
 * - ブロックはあるが使える束が無い（対象外・使い切った・期限切れ）: 空の配列
 * 残りが 1 以上の整数で、止められて（`paused`）おらず、期限が過ぎていない束だけを残す。
 */
export function paradisParseClaudeResetGrants(data: unknown, now: number): IParadisClaudeResetGrant[] | undefined {
	if (!isRecord(data) || !isRecord(data.cedar_ember)) {
		return undefined;
	}
	const block = data.cedar_ember;
	if (block.eligible === false || !Array.isArray(block.grants)) {
		return [];
	}
	const grants: IParadisClaudeResetGrant[] = [];
	for (const entry of block.grants.slice(0, MAX_GRANTS)) {
		if (!isRecord(entry) || entry.paused === true) {
			continue;
		}
		const left = entry.resets_left;
		if (typeof left !== 'number' || !Number.isInteger(left) || left <= 0) {
			continue;
		}
		const kind = grantKind(entry);
		if (kind === undefined) {
			continue;
		}
		const endsAt = paradisParseClaudeResetAt(entry.ends_at);
		if (endsAt !== undefined && endsAt <= now) {
			continue;
		}
		grants.push({ kind, left: Math.min(left, MAX_RESETS_LEFT), ...(endsAt !== undefined ? { endsAt } : {}) });
	}
	return grants;
}

/** 種類ごとの合計（{@link PARADIS_CLAUDE_RESET_KIND_ORDER} の順。0 の種類は入れない）。 */
export interface IParadisClaudeResetKindCount {
	readonly kind: ParadisClaudeResetKind;
	readonly count: number;
}

/**
 * カードの下の 1 行と一覧の決まり（モバイルの usageSummary.ts の `claudeResetGrantsFacts` と同じ。両方のテストが同じ表で確かめる）。
 * - kinds: 種類ごとの合計
 * - rows: 一覧の行（期限の早い順、期限の分からないものは最後）。期限の過ぎた束は除く
 * - listable: 一覧を開けるか（行が 2 つ以上）。1 つなら 1 行に期限まで書く
 * - nextEndsAt / nextDayOffset: いちばん早い期限と、それが暦の上で何日後か
 * - soon: いちばん早い期限が {@link PARADIS_CLAUDE_RESET_SOON_DAYS} 日以内
 */
export interface IParadisClaudeResetGrantsFacts {
	readonly kinds: readonly IParadisClaudeResetKindCount[];
	readonly rows: readonly IParadisClaudeResetGrant[];
	readonly listable: boolean;
	readonly nextEndsAt?: number;
	readonly nextDayOffset?: number;
	readonly soon: boolean;
}

export function paradisClaudeResetGrantsFacts(grants: readonly IParadisClaudeResetGrant[], now: number): IParadisClaudeResetGrantsFacts {
	const rows = grants
		.filter(grant => grant.left > 0 && (grant.endsAt === undefined || grant.endsAt > now))
		.sort((a, b) => (a.endsAt ?? Number.POSITIVE_INFINITY) - (b.endsAt ?? Number.POSITIVE_INFINITY));
	const kinds = PARADIS_CLAUDE_RESET_KIND_ORDER
		.map(kind => ({ kind, count: rows.filter(row => row.kind === kind).reduce((sum, row) => sum + row.left, 0) }))
		.filter(entry => entry.count > 0);
	const nextEndsAt = rows.find(row => row.endsAt !== undefined)?.endsAt;
	const nextDayOffset = nextEndsAt !== undefined ? paradisLimitsCalendarDayOffset(nextEndsAt, now) : undefined;
	return {
		kinds,
		rows,
		listable: rows.length >= 2,
		...(nextEndsAt !== undefined ? { nextEndsAt, nextDayOffset } : {}),
		soon: nextDayOffset !== undefined && nextDayOffset <= PARADIS_CLAUDE_RESET_SOON_DAYS,
	};
}
