/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese test data)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import type { IParadisLimitsAccount } from '../../../limitsMonitor/common/paradisLimitsMonitor.js';
import { ParadisNotificationInboxLedger } from '../../../notificationInbox/common/paradisNotificationInboxLedger.js';
import { IParadisMenuBarAccount, IParadisMenuBarSettings, paradisMenuBarInboxFromSnapshot, paradisMenuBarNeedsUsage, paradisMenuBarSourceKey, paradisReadMenuBarSettings, paradisSanitizeMenuBarReport } from '../../common/paradisMenuBar.js';
import { paradisRenderMenuBarBars, paradisRenderMenuBarMark } from '../../common/paradisMenuBarIcon.js';
import { ParadisMenuBarMenuItem, paradisMenuBarMenuModel } from '../../common/paradisMenuBarModel.js';
import {
	IParadisMenuBarMergedAccount,
	IParadisMenuBarStoredSource,
	paradisMenuBarAccountsFromLimits,
	paradisMenuBarBackText,
	paradisMenuBarStaleMinutes,
	paradisMenuBarTodayCost,
	paradisMenuBarUsageTitle,
	paradisMergeMenuBarUsage,
	paradisSortMenuBarAccounts,
} from '../../common/paradisMenuBarUsage.js';

/** 手元の時刻で作る（テストを走らせる場所のタイムゾーンに依らない）。 */
const NOW = new Date(2026, 9, 16, 14, 32).getTime();
const at = (hours: number, minutes: number, day = 16) => new Date(2026, 9, day, hours, minutes).getTime();

const SETTINGS: IParadisMenuBarSettings = paradisReadMenuBarSettings(true, () => undefined);

function account(provider: 'claude' | 'codex', name: string, five: number | undefined, week: number | undefined, extra: Partial<IParadisMenuBarAccount> = {}): IParadisMenuBarAccount {
	return {
		provider, key: `${provider}|${name}`, name, active: false,
		...(five !== undefined ? { fiveHour: { percent: five, resetsAt: at(16, 0) } } : {}),
		...(week !== undefined ? { sevenDay: { percent: week, resetsAt: at(9, 0, 22) } } : {}),
		...extra,
	};
}

function source(key: string, remote: boolean, fetchedAt: number, accounts: IParadisMenuBarAccount[]): IParadisMenuBarStoredSource {
	return { key, remote, fetchedAt, receivedAt: fetchedAt, accounts };
}

/** Claude 6・Codex 4 のアカウント（手元と SSH の接続先 1 つ）。 */
function manyAccounts(): IParadisMenuBarMergedAccount[] {
	return paradisMergeMenuBarUsage([
		source('local', false, NOW, [
			account('claude', 'work-1', 42, 31, { active: true }),
			account('claude', 'work-2', 12, 20),
			account('claude', 'team-a', 63, 45),
			account('claude', 'personal', 5, 88),
			account('claude', 'work-3', 100, 71, { fiveHour: { percent: 100, resetsAt: at(15, 52) } }),
			account('claude', 'team-b', 30, 50),
			account('codex', 'main', 18, 9, { active: true }),
			account('codex', 'sub-1', 0, 12),
			account('codex', 'sub-2', 24, 40),
			account('codex', 'team-a', 100, 100, { fiveHour: { percent: 100, resetsAt: at(17, 2) }, sevenDay: { percent: 100, resetsAt: at(18, 0, 18) } }),
		]),
	], true);
}

/** メニューの形（種類とラベル）だけを比べやすくする。 */
function shape(items: readonly ParadisMenuBarMenuItem[]): unknown[] {
	return items.map(item => {
		switch (item.kind) {
			case 'separator': return '---';
			case 'submenu': return { submenu: item.label, items: shape(item.items) };
			case 'account': return item.sublabel ? `${item.label} / ${item.sublabel}` : item.label;
			default: return item.label;
		}
	});
}

/** (x, y) の BGRA を [r, g, b, a] で返す。 */
function pixel(bitmap: { width: number; data: Uint8Array }, x: number, y: number): number[] {
	const offset = (y * bitmap.width + x) * 4;
	return [bitmap.data[offset + 2], bitmap.data[offset + 1], bitmap.data[offset], bitmap.data[offset + 3]];
}

suite('Paradis menu bar', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	test('turns the usage panel snapshot into accounts keyed like the mobile total', () => {
		const limits = (overrides: Partial<IParadisLimitsAccount>): IParadisLimitsAccount => ({ provider: 'claude', id: 'x', status: 'ok', ...overrides });
		const snapshot = {
			claude: {
				accounts: [
					limits({ id: 'para-claude:1', email: 'Work-1@Example.com', organizationName: 'Org', active: true, fiveHour: { usedPercent: 42, resetsAt: at(16, 0) }, fetchedAt: NOW }),
					limits({ id: 'para-claude:2', email: 'personal@example.com', sevenDay: { usedPercent: 10 } }),
					// 値の無いアカウント（再ログインが要るなど）は出さない
					limits({ id: 'para-claude:3', email: 'broken@example.com', status: 'relogin_required' }),
				],
			},
			codex: {
				accounts: [
					limits({ provider: 'codex', id: '/home/.codex', homeLabel: '~/.codex', accountId: 'abc', fiveHour: { usedPercent: 18 } }),
					limits({ provider: 'codex', id: '/home/.codex-2', homeLabel: '~/.codex-2', email: 'sub@example.com', fiveHour: { usedPercent: 3 } }),
				],
			},
		};
		assert.deepStrictEqual(paradisMenuBarAccountsFromLimits(snapshot, 'local', false, '/home/.codex-2').map(item => [item.key, item.name, item.active]), [
			['claude|email:work-1@example.com|org:Org', 'Work-1', true],
			['claude|email:personal@example.com|org:', 'personal', false],
			['codex|id:abc', '~/.codex', false],
			['codex|source:local|/home/.codex-2', 'sub', true],
		]);
		// SSH のウィンドウの Claude は接続先でいまログインしているアカウントだけなので、使用中とみなす
		assert.deepStrictEqual(paradisMenuBarAccountsFromLimits({ claude: { accounts: [snapshot.claude.accounts[1]] }, codex: { accounts: [] } }, 'ssh-remote+dev', true, undefined).map(item => item.active), [true]);
	});

	test('merges the same account across this machine and SSH, preferring the newest value and the local active mark', () => {
		const shared = (percent: number, active: boolean) => account('claude', 'work-1', percent, 31, { key: 'claude|email:work-1', active });
		const merged = paradisMergeMenuBarUsage([
			source('local', false, at(14, 0), [shared(40, true), account('codex', 'main', 18, 9, { active: true })]),
			source('ssh-remote+dev', true, at(14, 30), [shared(44, true), account('claude', 'other', 70, 10, { active: true })]),
		], true);
		assert.deepStrictEqual(merged.map(item => [item.name, item.current, item.fiveHour?.percent, item.fetchedAt === at(14, 30)]), [
			['work-1', true, 44, true],
			['other', false, 70, true],
			['main', true, 18, false],
		]);
		// 接続先を合わせない設定では、接続先の値を使わない。手元のウィンドウが無ければ接続先の使用中を使う
		assert.deepStrictEqual(paradisMergeMenuBarUsage([source('ssh-remote+dev', true, NOW, [shared(44, true)])], false), []);
		assert.deepStrictEqual(paradisMergeMenuBarUsage([source('ssh-remote+dev', true, NOW, [shared(44, true)])], true).map(item => item.current), [true]);
	});

	test('orders accounts by the one in use, then the most room, with exhausted ones last', () => {
		const merged = manyAccounts();
		assert.deepStrictEqual({
			claude: paradisSortMenuBarAccounts(merged, 'claude', NOW).map(item => item.name),
			codex: paradisSortMenuBarAccounts(merged, 'codex', NOW).map(item => item.name),
		}, {
			claude: ['work-1', 'work-2', 'team-b', 'team-a', 'personal', 'work-3'],
			codex: ['main', 'sub-1', 'sub-2', 'team-a'],
		});
	});

	test('writes the title from the accounts in use, with the available counts only when asked', () => {
		const merged = manyAccounts();
		const title = (overrides: Partial<IParadisMenuBarSettings>) => paradisMenuBarUsageTitle(merged, { ...SETTINGS, ...overrides }, NOW).map(segment => segment.hot ? `[${segment.text}]` : segment.text).join('  ');
		const near = paradisMergeMenuBarUsage([source('local', false, NOW, [account('claude', 'work-1', 86, 64, { active: true }), account('codex', 'main', 35, 14, { active: true })])], true);
		assert.deepStrictEqual({
			active: title({}),
			available: title({ multipleAccounts: 'available' }),
			both: title({ multipleAccounts: 'both' }),
			weekly: title({ usageWindow: 'sevenDay' }),
			nearLimitQuiet: title({ usageStyle: 'nearLimit' }),
			nearLimit: paradisMenuBarUsageTitle(near, { ...SETTINGS, usageStyle: 'nearLimit' }, NOW).map(segment => segment.text),
			hot: paradisMenuBarUsageTitle(near, SETTINGS, NOW).map(segment => segment.hot),
		}, {
			active: 'C 42%  X 18%',
			available: 'C 4/6  X 3/4',
			both: 'C 42% 4/6  X 18% 3/4',
			weekly: 'C 31%  X 9%',
			nearLimitQuiet: '',
			nearLimit: ['C 86%'],
			hot: [true, false],
		});
	});

	test('marks old values in the title with ~', () => {
		const merged = paradisMergeMenuBarUsage([
			source('local', false, NOW, [account('claude', 'work-1', 42, 31, { active: true, fetchedAt: NOW - 20 * 60_000 }), account('codex', 'main', 18, 9, { active: true })]),
		], true);
		assert.deepStrictEqual(paradisMenuBarUsageTitle(merged, SETTINGS, NOW).map(segment => segment.text), ['C ~42%', 'X 18%']);
	});

	test('asks for the usage only while the menu bar shows it', () => {
		const settings = (iconEnabled: boolean, title: string, menuUsage: boolean) => paradisReadMenuBarSettings(iconEnabled, key => key === 'paradis.menuBar.title' ? title : key === 'paradis.menuBar.menu.usage' ? menuUsage : undefined);
		assert.deepStrictEqual({
			iconOff: paradisMenuBarNeedsUsage(settings(false, 'usage', true)),
			bellOnly: paradisMenuBarNeedsUsage(settings(true, 'attention', false)),
			nothingBeside: paradisMenuBarNeedsUsage(settings(true, 'none', false)),
			beside: paradisMenuBarNeedsUsage(settings(true, 'usage', false)),
			inMenu: paradisMenuBarNeedsUsage(settings(true, 'none', true)),
		}, { iconOff: false, bellOnly: false, nothingBeside: false, beside: true, inMenu: true });
	});

	test('treats the same host opened with and without a user name as one source', () => {
		const hex = (value: string) => [...new TextEncoder().encode(value)].map(byte => byte.toString(16).padStart(2, '0')).join('');
		assert.deepStrictEqual([
			paradisMenuBarSourceKey(undefined),
			paradisMenuBarSourceKey('ssh-remote+dev-server'),
			paradisMenuBarSourceKey('ssh-remote+me@Dev-Server'),
			paradisMenuBarSourceKey(`ssh-remote+${hex(JSON.stringify({ hostName: 'dev-server', user: 'me' }))}`),
			paradisMenuBarSourceKey('ssh-remote+cafe'),
		], ['local', 'ssh-remote+dev-server', 'ssh-remote+dev-server', 'ssh-remote+dev-server', 'ssh-remote+cafe']);
	});

	test('shows the part after @ only for accounts whose names collide', () => {
		const merged = paradisMergeMenuBarUsage([source('local', false, NOW, [
			account('claude', 'work', 42, 31, { key: 'claude|a', domain: 'a.example', active: true }),
			account('claude', 'work', 12, 20, { key: 'claude|b', domain: 'b.example' }),
			account('claude', 'solo', 30, 50, { key: 'claude|c', domain: 'c.example' }),
		])], true);
		const menu = paradisMenuBarMenuModel({ inbox: { attentionCount: 0, blockingCount: 0, items: [], revision: 0 }, working: 0, accounts: merged, cost: undefined, now: NOW }, SETTINGS);
		const submenu = menu.find((item): item is Extract<ParadisMenuBarMenuItem, { kind: 'submenu' }> => item.kind === 'submenu');
		assert.deepStrictEqual(shape(submenu?.items ?? []).slice(0, 3), [
			'work@a.example  5時間 42%・週 31%',
			'work@b.example  5時間 12%・週 20%',
			'solo  5時間 30%・週 50%',
		]);
	});

	test('says when an exhausted account comes back, and how old the values are', () => {
		assert.deepStrictEqual({
			fiveHour: paradisMenuBarBackText({ fiveHour: { percent: 100, resetsAt: at(15, 52) } }, NOW),
			weekLater: paradisMenuBarBackText({ fiveHour: { percent: 100, resetsAt: at(17, 2) }, sevenDay: { percent: 100, resetsAt: at(18, 0, 18) } }, NOW),
			notReached: paradisMenuBarBackText({ fiveHour: { percent: 99, resetsAt: at(15, 52) } }, NOW),
			fresh: paradisMenuBarStaleMinutes(manyAccounts(), NOW),
			stale: paradisMenuBarStaleMinutes(manyAccounts(), NOW + 18 * 60_000),
		}, {
			fiveHour: '15:52 に戻る',
			weekLater: '10/18 18:00 に戻る',
			notReached: undefined,
			fresh: undefined,
			stale: 18,
		});
	});

	test('adds up today\'s cost from today\'s values only', () => {
		const costs = [
			{ sourceKey: 'local', remote: false, usd: 9.1, fetchedAt: at(14, 0) },
			{ sourceKey: 'ssh-remote+dev', label: 'dev-server', remote: true, usd: 2.1, fetchedAt: at(13, 0) },
			{ sourceKey: 'ssh-remote+gpu', label: 'gpu-box', remote: true, usd: 5, fetchedAt: at(23, 0, 15) },
		];
		assert.deepStrictEqual({
			all: paradisMenuBarTodayCost(costs, true, NOW),
			localOnly: paradisMenuBarTodayCost(costs, false, NOW)?.totalUsd,
			none: paradisMenuBarTodayCost([], true, NOW),
		}, {
			all: { totalUsd: 9.1 + 2.1, parts: [{ label: 'この PC', usd: 9.1 }, { label: 'dev-server', usd: 2.1 }] },
			localOnly: 9.1,
			none: undefined,
		});
	});

	test('builds a short menu: accounts in use, then a submenu per service', () => {
		const input = {
			inbox: { attentionCount: 0, blockingCount: 0, items: [], revision: 0 },
			working: 2,
			accounts: manyAccounts(),
			cost: { totalUsd: 12.4, parts: [{ label: 'この PC', usd: 9.1 }, { label: 'dev-server', usd: 3.3 }] },
			now: NOW,
		};
		assert.deepStrictEqual(shape(paradisMenuBarMenuModel(input, SETTINGS)), [
			'要対応はありません',
			'---',
			'使用量',
			'Claude Code  work-1  5時間 42%・週 31%',
			{
				submenu: 'Claude Code（6）', items: [
					'work-1  5時間 42%・週 31%',
					'work-2  5時間 12%・週 20%',
					'team-b  5時間 30%・週 50%',
					'team-a  5時間 63%・週 45%',
					'personal  5時間 5%・週 88%',
					'work-3  5時間 100%・週 71% / 15:52 に戻る',
					'---',
					'アカウントを切り替える…',
				],
			},
			'Codex  main  5時間 18%・週 9%',
			{
				submenu: 'Codex（4）', items: [
					'main  5時間 18%・週 9%',
					'sub-1  5時間 0%・週 12%',
					'sub-2  5時間 24%・週 40%',
					'team-a  5時間 100%・週 100% / 10/18 18:00 に戻る',
					'---',
					'アカウントを切り替える…',
				],
			},
			{ submenu: '今日のコスト $12.40', items: ['この PC  $9.10', 'dev-server  $3.30', '---', 'AI コストを開く'] },
			'---',
			'Para Code を開く',
			'メニューバーの設定…',
		]);
		// 作業中の数は設定でオンにしたときだけ見出しに足す。簡単な表示では戻る時刻を同じ行に書く
		const plain = paradisMenuBarMenuModel(input, { ...SETTINGS, menuWorkingCount: true, plainMenu: true, menuUsage: true });
		const claudeSubmenu = plain.find((item): item is Extract<ParadisMenuBarMenuItem, { kind: 'submenu' }> => item.kind === 'submenu' && item.label.startsWith('Claude'));
		assert.deepStrictEqual({
			header: shape(plain)[0],
			exhausted: shape(claudeSubmenu?.items ?? [])[5],
			withoutUsage: shape(paradisMenuBarMenuModel(input, { ...SETTINGS, menuUsage: false })),
		}, {
			header: '要対応はありません・作業中 2',
			exhausted: 'work-3  5時間 100%・週 71%（15:52 に戻る）',
			withoutUsage: ['要対応はありません', '---', 'Para Code を開く', 'メニューバーの設定…'],
		});
	});

	test('counts the blocking panes apart from the finished ones', () => {
		const ledger = new ParadisNotificationInboxLedger(() => Date.now());
		ledger.setLivePanes('window:1', ['a', 'b', 'c']);
		ledger.record({ kind: 'permission', paneKey: 'a', instanceId: 1, windowId: 1, space: 'api', delivery: 'notified' });
		ledger.record({ kind: 'question', paneKey: 'b', instanceId: 2, windowId: 1, space: 'web-app', delivery: 'notified' });
		ledger.record({ kind: 'review', paneKey: 'c', instanceId: 3, windowId: 1, space: 'docs', delivery: 'notified' });
		const inbox = paradisMenuBarInboxFromSnapshot(ledger.snapshot());
		assert.deepStrictEqual([inbox.attentionCount, inbox.blockingCount, inbox.items.map(item => item.kind)], [3, 2, ['review', 'question', 'permission']]);
	});

	test('drops malformed reports instead of breaking the menu', () => {
		assert.deepStrictEqual(paradisSanitizeMenuBarReport({
			inbox: { attentionCount: -2, blockingCount: 1.5, revision: 4, items: [{ entryId: 1 }, { entryId: 'x', kind: 'review', location: 'l', at: 1 }] },
			working: 'many',
			usage: { key: 'local', fetchedAt: 5, accounts: [{ provider: 'claude', key: 'k', name: 'n', fiveHour: { percent: 140 } }, { provider: 'gemini', key: 'k', name: 'n' }] },
			cost: { sourceKey: 'local', usd: -1, fetchedAt: 1 },
		}), {
			inbox: { attentionCount: 0, blockingCount: 1, items: [{ entryId: 'x', kind: 'review', location: 'l', at: 1 }], revision: 4 },
			working: 0,
			usage: { key: 'local', remote: false, fetchedAt: 5, accounts: [{ provider: 'claude', key: 'k', name: 'n', active: false, fiveHour: { percent: 100 } }] },
		});
		assert.deepStrictEqual(paradisSanitizeMenuBarReport(undefined), { inbox: { attentionCount: 0, blockingCount: 0, items: [], revision: 0 }, working: 0 });
	});

	test('draws the three panes of the mark with gaps, and the bars', () => {
		const black = { r: 0, g: 0, b: 0 };
		const red = { r: 255, g: 0, b: 0 };
		const mark = paradisRenderMenuBarMark(2, black, undefined);
		const dotted = paradisRenderMenuBarMark(2, black, red);
		const bars = paradisRenderMenuBarBars(2, black, undefined, 100, 0);
		assert.deepStrictEqual({
			size: [mark.width, mark.height, bars.width],
			corner: pixel(mark, 0, 0),
			leftPane: pixel(mark, 12, 20),
			backPane: pixel(mark, 20, 10),
			floorPane: pixel(mark, 20, 28),
			// 手前の面と床の面の境目のすき間
			gap: pixel(mark, 17, 24)[3] < 128,
			dot: pixel(dotted, 29, 7),
			upperBarEnd: pixel(bars, 84, 11),
			lowerBarEnd: pixel(bars, 84, 25)[3] < 128,
		}, {
			size: [36, 36, 88],
			corner: [0, 0, 0, 0],
			leftPane: [0, 0, 0, 255],
			backPane: [0, 0, 0, 255],
			floorPane: [0, 0, 0, 255],
			gap: true,
			dot: [255, 0, 0, 255],
			upperBarEnd: [0, 0, 0, 255],
			lowerBarEnd: true,
		});
	});
});
