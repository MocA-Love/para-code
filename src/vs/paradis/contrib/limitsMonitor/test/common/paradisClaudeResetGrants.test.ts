/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { paradisClaudeResetGrantsFacts, paradisParseClaudeResetGrants } from '../../common/paradisClaudeResetGrants.js';
import { IParadisClaudeResetGrant, ParadisClaudeResetKind } from '../../common/paradisLimitsMonitor.js';

suite('Paradis Claude limit resets', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	const now = Date.parse('2026-11-15T03:00:00Z');
	const iso = (days: number) => new Date(now + days * 86_400_000).toISOString();

	// 応答の形は Claude Code 2.1.323 の zod スキーマから復元したもので未確認。形が違えば何も出さない。
	test('reads usable grants and names them like Claude Code, and gives up quietly on other shapes', () => {
		const grants = [
			{ id: 'a', resets_left: 2, ends_at: iso(114), type: 'weekly', gives_back_weekly: true, clears: ['five_hour', 'seven_day_opus'] },
			{ id: 'b', resets_left: 1, ends_at: iso(26), type: 'full', clears: ['five_hour', 'seven_day'] },
			{ id: 'c', resets_left: 1, ends_at: iso(1), type: 'session' },
			{ id: 'd', resets_left: 1, clears: ['seven_day'] },
			{ id: 'e', resets_left: 1, clears: ['five_hour'] },
			{ id: 'f', resets_left: 1, clears: [] },
			// 捨てるもの: 使い切った・止められた・期限切れ・回数が整数でない・知らない種類・clears が文字列でない
			{ id: 'g', resets_left: 0, type: 'full' },
			{ id: 'h', resets_left: 1, type: 'full', paused: true },
			{ id: 'i', resets_left: 1, type: 'full', ends_at: iso(-1) },
			{ id: 'j', resets_left: 1.5, type: 'full' },
			{ id: 'k', resets_left: 1, type: 'monthly' },
			{ id: 'l', resets_left: 1, clears: [1] },
			'not an object',
		];
		assert.deepStrictEqual({
			parsed: paradisParseClaudeResetGrants({ five_hour: {}, cedar_ember: { eligible: true, grants } }, now),
			noBlock: paradisParseClaudeResetGrants({ five_hour: {} }, now),
			blockNotObject: paradisParseClaudeResetGrants({ cedar_ember: [] }, now),
			notObject: paradisParseClaudeResetGrants('x', now),
			ineligible: paradisParseClaudeResetGrants({ cedar_ember: { eligible: false, grants } }, now),
			noGrants: paradisParseClaudeResetGrants({ cedar_ember: { eligible: true } }, now),
		}, {
			parsed: [
				{ kind: 'fable', left: 2, endsAt: Date.parse(iso(114)) },
				{ kind: 'full', left: 1, endsAt: Date.parse(iso(26)) },
				{ kind: 'fiveHour', left: 1, endsAt: Date.parse(iso(1)) },
				{ kind: 'weekly', left: 1 },
				{ kind: 'fiveHour', left: 1 },
				{ kind: 'full', left: 1 },
			],
			noBlock: undefined,
			blockNotObject: undefined,
			notObject: undefined,
			ineligible: [],
			noGrants: [],
		});
	});

	// アプリの usageSummary.test.ts と同じ表（変えるときは両方を直す）。期限は今から何日後か（null は期限なし）。
	interface IFactsRow {
		readonly name: string;
		readonly grants: readonly (readonly [ParadisClaudeResetKind, number, number | null])[];
		readonly expected: { readonly kinds: string; readonly listable: boolean; readonly nextDayOffset?: number; readonly soon: boolean; readonly rows: string };
	}
	const FACTS_TABLE: readonly IFactsRow[] = [
		{ name: '2 種類・先頭は 26 日後', grants: [['fable', 2, 114], ['full', 1, 26]], expected: { kinds: 'fable:2 full:1', listable: true, nextDayOffset: 26, soon: false, rows: 'full:1 fable:2' } },
		{ name: '1 束・2 日後', grants: [['fable', 1, 2]], expected: { kinds: 'fable:1', listable: false, nextDayOffset: 2, soon: true, rows: 'fable:1' } },
		{ name: '同じ種類で期限が 2 つ', grants: [['fable', 3, 114], ['fable', 1, 7]], expected: { kinds: 'fable:4', listable: true, nextDayOffset: 7, soon: true, rows: 'fable:1 fable:3' } },
		{ name: '8 日後は近くない', grants: [['weekly', 1, 8], ['fiveHour', 1, null]], expected: { kinds: 'fiveHour:1 weekly:1', listable: true, nextDayOffset: 8, soon: false, rows: 'weekly:1 fiveHour:1' } },
		{ name: '期限の分からない 1 束', grants: [['full', 1, null]], expected: { kinds: 'full:1', listable: false, soon: false, rows: 'full:1' } },
		{ name: '期限切れだけ', grants: [['full', 1, -1]], expected: { kinds: '', listable: false, soon: false, rows: '' } },
	];

	test('summarizes the grants by the same rules as the mobile app', () => {
		const at = (days: number) => now + days * 86_400_000;
		const actual = FACTS_TABLE.map(row => {
			const grants: IParadisClaudeResetGrant[] = row.grants.map(([kind, left, days]) => ({ kind, left, ...(days !== null ? { endsAt: at(days) } : {}) }));
			const facts = paradisClaudeResetGrantsFacts(grants, now);
			return {
				name: row.name,
				kinds: facts.kinds.map(entry => `${entry.kind}:${entry.count}`).join(' '),
				listable: facts.listable,
				...(facts.nextDayOffset !== undefined ? { nextDayOffset: facts.nextDayOffset } : {}),
				soon: facts.soon,
				rows: facts.rows.map(grant => `${grant.kind}:${grant.left}`).join(' '),
			};
		});
		assert.deepStrictEqual(actual, FACTS_TABLE.map(row => ({ name: row.name, ...row.expected })));
	});
});
