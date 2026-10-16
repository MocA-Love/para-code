/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

// メニューの中身の組み立て。Electron に依存しない形で作り、main で MenuItem に写す（テストのため）。
//
// 作業中のエージェントの行は出さない（数が多いと読み切れないため）。設定でオンにしたときだけ、
// 見出しに作業中の数を足す。使用量は使用中のアカウントを 1 行ずつ出し、アカウントが複数あるサービスは
// 全アカウントをサブメニューへ分ける。各行は「名前  5時間 n%・週 n%」と行の頭の 2 本のバーだけにし、
// 上限に達したときだけ戻る時刻を添える。

import { fromNow } from '../../../../base/common/date.js';
import { localize } from '../../../../nls.js';
import { paradisInboxKindLabel, ParadisInboxKind } from '../../notificationInbox/common/paradisNotificationInbox.js';
import { IParadisMenuBarInbox, IParadisMenuBarSettings, ParadisMenuBarProvider } from './paradisMenuBar.js';
import {
	IParadisMenuBarMergedAccount,
	IParadisMenuBarTodayCost,
	PARADIS_MENU_BAR_PROVIDERS,
	paradisMenuBarAccountLine,
	paradisMenuBarBackText,
	paradisMenuBarFormatUsd,
	paradisMenuBarPercent,
	paradisMenuBarStaleMinutes,
	paradisSortMenuBarAccounts,
} from './paradisMenuBarUsage.js';

export type ParadisMenuBarAction = 'openUsagePanel' | 'openCostDashboard' | 'openApp' | 'openSettings';

export type ParadisMenuBarMenuItem =
	| { readonly kind: 'header'; readonly label: string }
	| { readonly kind: 'entry'; readonly label: string; readonly entryId: string; readonly attention: ParadisInboxKind }
	/** アカウントの行。押すと使用量パネルを開く。`bars` は行の頭の 2 本のバー（5 時間・週）。 */
	| { readonly kind: 'account'; readonly label: string; readonly sublabel?: string; readonly bars: { readonly fiveHour?: number; readonly sevenDay?: number } }
	| { readonly kind: 'submenu'; readonly label: string; readonly items: readonly ParadisMenuBarMenuItem[] }
	/** 押せない情報の行。 */
	| { readonly kind: 'info'; readonly label: string }
	| { readonly kind: 'action'; readonly label: string; readonly action: ParadisMenuBarAction }
	| { readonly kind: 'separator' };

export interface IParadisMenuBarMenuInput {
	readonly inbox: IParadisMenuBarInbox;
	/** 全ウィンドウの作業中のペインの数。 */
	readonly working: number;
	readonly accounts: readonly IParadisMenuBarMergedAccount[];
	readonly cost: IParadisMenuBarTodayCost | undefined;
	readonly now: number;
}

const PROVIDER_LABEL: Readonly<Record<ParadisMenuBarProvider, string>> = { claude: 'Claude Code', codex: 'Codex' };

function accountItem(account: IParadisMenuBarMergedAccount, withProvider: boolean, plain: boolean, now: number): ParadisMenuBarMenuItem {
	const line = paradisMenuBarAccountLine(account, now);
	const head = withProvider ? `${PROVIDER_LABEL[account.provider]}  ${account.name}` : account.name;
	const back = paradisMenuBarBackText(account, now);
	// 2 行目を使わない表示では、戻る時刻を同じ行の後ろに付ける
	const label = plain && back ? `${head}  ${line}（${back}）` : `${head}  ${line}`;
	const bars = {
		...(account.fiveHour ? { fiveHour: paradisMenuBarPercent(account.fiveHour, now) ?? 0 } : {}),
		...(account.sevenDay ? { sevenDay: paradisMenuBarPercent(account.sevenDay, now) ?? 0 } : {}),
	};
	return !plain && back ? { kind: 'account', label, sublabel: back, bars } : { kind: 'account', label, bars };
}

function usageItems(input: IParadisMenuBarMenuInput, plain: boolean): ParadisMenuBarMenuItem[] {
	const items: ParadisMenuBarMenuItem[] = [];
	for (const provider of PARADIS_MENU_BAR_PROVIDERS) {
		const sorted = paradisSortMenuBarAccounts(input.accounts, provider, input.now);
		if (sorted.length === 0) {
			continue;
		}
		// 使用中が分からない（その出どころのウィンドウが無い）ときは、余裕の多いものを先頭に出す
		items.push(accountItem(sorted[0], true, plain, input.now));
		if (sorted.length > 1) {
			items.push({
				kind: 'submenu',
				label: localize('paradis.menuBar.accountsSubmenu', "{0}（{1}）", PROVIDER_LABEL[provider], sorted.length),
				items: [
					...sorted.map(account => accountItem(account, false, plain, input.now)),
					{ kind: 'separator' },
					{ kind: 'action', label: localize('paradis.menuBar.switchAccount', "アカウントを切り替える…"), action: 'openUsagePanel' },
				],
			});
		}
	}
	if (items.length === 0 && !input.cost) {
		return [];
	}
	const stale = paradisMenuBarStaleMinutes(input.accounts, input.now);
	const header = stale !== undefined
		? localize('paradis.menuBar.usageStale', "使用量（{0} 分前の値）", stale)
		: localize('paradis.menuBar.usage', "使用量");
	const result: ParadisMenuBarMenuItem[] = [{ kind: 'separator' }, { kind: 'header', label: header }, ...items];
	if (input.cost) {
		const label = localize('paradis.menuBar.todayCost', "今日のコスト {0}", paradisMenuBarFormatUsd(input.cost.totalUsd));
		result.push(input.cost.parts.length > 1
			? {
				kind: 'submenu', label, items: [
					...input.cost.parts.map(part => ({ kind: 'info' as const, label: `${part.label}  ${paradisMenuBarFormatUsd(part.usd)}` })),
					{ kind: 'separator' },
					{ kind: 'action', label: localize('paradis.menuBar.openCost', "AI コストを開く"), action: 'openCostDashboard' },
				],
			}
			: { kind: 'action', label, action: 'openCostDashboard' });
	}
	return result;
}

export function paradisMenuBarMenuModel(input: IParadisMenuBarMenuInput, settings: Pick<IParadisMenuBarSettings, 'menuUsage' | 'menuWorkingCount' | 'plainMenu'>): ParadisMenuBarMenuItem[] {
	const attention = input.inbox.attentionCount;
	let header = attention > 0
		? localize('paradis.menuBar.attention', "要対応 {0} 件", attention)
		: localize('paradis.menuBar.noAttention', "要対応はありません");
	if (settings.menuWorkingCount && input.working > 0) {
		header = localize('paradis.menuBar.attentionWorking', "{0}・作業中 {1}", header, input.working);
	}
	const menu: ParadisMenuBarMenuItem[] = [{ kind: 'header', label: header }];
	for (const item of input.inbox.items) {
		menu.push({
			kind: 'entry',
			entryId: item.entryId,
			attention: item.kind,
			label: localize('paradis.menuBar.entry', "{0}  {1}（{2}）", paradisInboxKindLabel(item.kind), item.location, fromNow(item.at, true)),
		});
	}
	if (settings.menuUsage) {
		menu.push(...usageItems(input, settings.plainMenu));
	}
	menu.push(
		{ kind: 'separator' },
		{ kind: 'action', label: localize('paradis.menuBar.openApp', "Para Code を開く"), action: 'openApp' },
		{ kind: 'action', label: localize('paradis.menuBar.openSettings', "メニューバーの設定…"), action: 'openSettings' },
	);
	return menu;
}
