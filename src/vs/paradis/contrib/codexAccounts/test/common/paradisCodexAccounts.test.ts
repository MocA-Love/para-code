/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-PATCH/PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { IParadisCodexAccountsState, paradisCalendarDayOffset, paradisCodexChosenCreditStillAvailable, paradisCodexLaunchHomeFor, paradisCodexResetCreditRows, paradisCodexResetSummary, paradisLooksLikeRunningCodex, paradisSelectedCodexHome } from '../../common/paradisCodexAccounts.js';

suite('Paradis Codex accounts (common)', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	const homes: IParadisCodexAccountsState['homes'] = [
		{ homePath: '/u/.codex', label: '~/.codex', isDefault: true, signedIn: true },
		{ homePath: '/u/.codex-2', label: '~/.codex-2', isDefault: false, signedIn: true },
	];

	test('only passes CODEX_HOME for a selected, still existing, non-default home', () => {
		assert.deepStrictEqual([
			paradisCodexLaunchHomeFor({ homes, selection: { revision: 0 } }),
			paradisCodexLaunchHomeFor({ homes, selection: { homePath: '/u/.codex-2', revision: 1 } }),
			// 選んだアカウントが消された → 既定へ戻る
			paradisCodexLaunchHomeFor({ homes, selection: { homePath: '/u/.codex-9', revision: 2 } }),
			paradisSelectedCodexHome({ homes, selection: { homePath: '/u/.codex-9', revision: 2 } })?.homePath,
		], [undefined, '/u/.codex-2', undefined, '/u/.codex']);
	});

	test('recognizes a running Codex from the command line or the process name', () => {
		assert.deepStrictEqual([
			paradisLooksLikeRunningCodex('codex resume --last', 'zsh'),
			paradisLooksLikeRunningCodex('/opt/homebrew/bin/codex', undefined),
			paradisLooksLikeRunningCodex('npx codex-helper', 'node'),
			paradisLooksLikeRunningCodex('git status', 'codex'),
			paradisLooksLikeRunningCodex(undefined, 'codex'),
			paradisLooksLikeRunningCodex(undefined, 'zsh'),
		], [true, true, false, false, true, false]);
	});

	// 明細は上限付きで返ることがあり、残り回数と件数が合わないことがある。
	test('lists reset credits by expiry and fills in what the details do not cover', () => {
		const expires = (expiresAt: number | undefined, id?: string) => ({ status: 'available' as const, expiresAt, ...(id !== undefined ? { id } : {}) });
		assert.deepStrictEqual({
			none: paradisCodexResetCreditRows({ availableCount: 0, credits: [] }),
			noDetails: paradisCodexResetCreditRows({ availableCount: 3 }),
			sortedWithNoExpiryLast: paradisCodexResetCreditRows({ availableCount: 3, credits: [expires(undefined, 'c'), expires(30, 'b'), expires(10, 'a')] }),
			fewerDetails: paradisCodexResetCreditRows({ availableCount: 4, credits: [expires(20), { status: 'redeemed', expiresAt: 5 }] }),
			moreDetails: paradisCodexResetCreditRows({ availableCount: 1, credits: [expires(20, 'late'), expires(10, 'early')] }),
		}, {
			none: [],
			noDetails: [{ kind: 'unknown', count: 3 }],
			sortedWithNoExpiryLast: [{ kind: 'dated', expiresAt: 10, id: 'a' }, { kind: 'dated', expiresAt: 30, id: 'b' }, { kind: 'noExpiry', id: 'c' }],
			fewerDetails: [{ kind: 'dated', expiresAt: 20 }, { kind: 'unknown', count: 3 }],
			moreDetails: [{ kind: 'dated', expiresAt: 10, id: 'early' }],
		});
	});

	test('counts calendar days in local time', () => {
		const now = new Date(2026, 9, 4, 23, 30).getTime();
		assert.deepStrictEqual([
			paradisCalendarDayOffset(new Date(2026, 9, 4, 0, 5).getTime(), now),
			paradisCalendarDayOffset(new Date(2026, 9, 5, 0, 5).getTime(), now),
			paradisCalendarDayOffset(new Date(2026, 10, 1, 18, 30).getTime(), now),
			paradisCalendarDayOffset(new Date(2026, 9, 3, 23, 0).getTime(), now),
		], [0, 1, 28, -1]);
	});

	// アプリの usageSummary.test.ts と PC の paradisCodexAccounts.test.ts で同じ表（変えるときは両方を直す）。
	// 時刻は [月, 日, 時, 分]（端末の時刻）で、今は 2026-10-04 09:00。credits の null は期限の無いもの。
	interface IResetSummaryRow {
		readonly name: string;
		readonly availableCount: number;
		readonly nextExpiresAt?: readonly number[];
		readonly credits?: readonly (readonly number[] | null)[];
		readonly expected: { readonly count: number; readonly listable: boolean; readonly next?: readonly number[]; readonly nextDayOffset?: number; readonly hasNoExpiry: boolean };
	}
	const RESET_SUMMARY_TABLE: readonly IResetSummaryRow[] = [
		{ name: '残り 4 回・先頭は今日', availableCount: 4, credits: [[10, 11, 9, 0], [10, 4, 11, 12], null, [10, 25, 18, 30]], expected: { count: 4, listable: true, next: [10, 4, 11, 12], nextDayOffset: 0, hasNoExpiry: true } },
		{ name: '残り 2 回・明細なし（古い PC）', availableCount: 2, nextExpiresAt: [10, 5, 8, 0], expected: { count: 2, listable: false, next: [10, 5, 8, 0], nextDayOffset: 1, hasNoExpiry: false } },
		{ name: '残り 1 回・期限あり', availableCount: 1, credits: [[10, 20, 21, 45]], expected: { count: 1, listable: false, next: [10, 20, 21, 45], nextDayOffset: 16, hasNoExpiry: false } },
		{ name: '残り 1 回・期限なし', availableCount: 1, credits: [null], expected: { count: 1, listable: false, hasNoExpiry: true } },
		{ name: '残り 3 回・明細が足りない', availableCount: 3, credits: [[10, 9, 8, 0]], expected: { count: 3, listable: true, next: [10, 9, 8, 0], nextDayOffset: 5, hasNoExpiry: false } },
		{ name: '残り 2 回・すべて期限なし', availableCount: 2, credits: [null, null], expected: { count: 2, listable: true, hasNoExpiry: true } },
		{ name: '残りなし', availableCount: 0, credits: [], expected: { count: 0, listable: false, hasNoExpiry: false } },
	];
	const tableNow = new Date(2026, 9, 4, 9, 0).getTime();
	const tableAt = (time: readonly number[]) => new Date(2026, time[0]! - 1, time[1]!, time[2]!, time[3]!).getTime();
	const tableExpected = RESET_SUMMARY_TABLE.map(row => ({
		name: row.name,
		count: row.expected.count,
		listable: row.expected.listable,
		...(row.expected.next !== undefined ? { nextExpiresAt: tableAt(row.expected.next), nextDayOffset: row.expected.nextDayOffset } : {}),
		hasNoExpiry: row.expected.hasNoExpiry,
	}));

	// メーターの下の1行の決まりがモバイルと揃っていることを、同じ表で確かめる。
	test('summarizes the reset credits by the same rules as the mobile app', () => {
		const actual = RESET_SUMMARY_TABLE.map(row => ({
			name: row.name,
			...paradisCodexResetSummary({
				availableCount: row.availableCount,
				...(row.nextExpiresAt !== undefined ? { nextExpiresAt: tableAt(row.nextExpiresAt) } : {}),
				...(row.credits !== undefined ? { credits: row.credits.map(time => ({ status: 'available' as const, ...(time !== null ? { expiresAt: tableAt(time) } : {}) })) } : {}),
			}, tableNow),
		}));
		assert.deepStrictEqual(actual, tableExpected);
	});

	test('tells when the chosen credit is still available after consuming', () => {
		const credits = { availableCount: 2, credits: [{ id: 'a', status: 'available' as const }, { id: 'b', status: 'redeemed' as const }] };
		assert.deepStrictEqual([
			paradisCodexChosenCreditStillAvailable(credits, 'a'),
			paradisCodexChosenCreditStillAvailable(credits, 'b'),
			paradisCodexChosenCreditStillAvailable(credits, undefined),
			paradisCodexChosenCreditStillAvailable({ availableCount: 2 }, 'a'),
			paradisCodexChosenCreditStillAvailable(undefined, 'a'),
		], [true, false, false, false, false]);
	});
});
