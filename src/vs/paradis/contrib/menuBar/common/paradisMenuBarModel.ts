/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

// メニューの中身の組み立て。Electron に依存しない形で作り、main で MenuItem に写す（テストのため）。
//
// 作業中のエージェントの行は出さない（数が多いと読み切れないため）。設定でオンにしたときだけ、
// 見出しに作業中の数を足す。使用量はサービスごとに 1 行（使用中のアカウント）にし、アカウントが複数ある
// サービスはその行をサブメニューにして全アカウントを並べる。行の 1 行目は名前だけ、2 行目（sublabel）に
// 「5時間 n%・週 n%」と、上限に達したときだけ戻る時刻を出す（簡単な表示では 1 行に書く）。見出しは
// macOS の区切り見出しにする。アイコンの横に出すものと数える枠、SSH の接続先の分を合わせるかは、
// メニューのチェックの項目で選べる（Q537 の 45 A）。

import { fromNow } from '../../../../base/common/date.js';
import { localize } from '../../../../nls.js';
import { paradisInboxKindLabel, ParadisInboxKind } from '../../notificationInbox/common/paradisNotificationInbox.js';
import {
	IParadisMenuBarInbox,
	IParadisMenuBarSettings,
	PARADIS_MENU_BAR_INCLUDE_REMOTE_SETTING,
	PARADIS_MENU_BAR_TITLE_SETTING,
	PARADIS_MENU_BAR_USAGE_STYLE_SETTING,
	PARADIS_MENU_BAR_USAGE_WINDOW_SETTING,
	ParadisMenuBarProvider,
} from './paradisMenuBar.js';
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
	/** `sublabel` と `bars` は、サービスの行をサブメニューにしたとき（アカウントが複数）の 2 行目と行の頭のバー。 */
	| { readonly kind: 'submenu'; readonly label: string; readonly sublabel?: string; readonly bars?: { readonly fiveHour?: number; readonly sevenDay?: number }; readonly items: readonly ParadisMenuBarMenuItem[] }
	/** 設定を選ぶチェックの項目。`radio` は同じ設定の中の 1 つ、そうでなければオン/オフ。押すと `value` を書く。 */
	| { readonly kind: 'choice'; readonly label: string; readonly checked: boolean; readonly radio: boolean; readonly key: string; readonly value: string | boolean }
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

/**
 * @param sameNames そのサービスで表示名が重なっている名前。重なっているものだけ @ の後ろも出して見分ける
 */
interface IParadisMenuBarAccountRow {
	/** 1 行目（サービスと名前）。 */
	readonly head: string;
	/** 2 行目（使用率と、上限に達したときだけ戻る時刻）。 */
	readonly detail: string;
	readonly bars: { readonly fiveHour?: number; readonly sevenDay?: number };
}

function accountRow(account: IParadisMenuBarMergedAccount, withProvider: boolean, plain: boolean, sameNames: ReadonlySet<string>, now: number): IParadisMenuBarAccountRow {
	const line = paradisMenuBarAccountLine(account, now);
	const name = sameNames.has(account.name) && account.domain ? `${account.name}@${account.domain}` : account.name;
	const back = paradisMenuBarBackText(account, now);
	return {
		head: withProvider ? `${PROVIDER_LABEL[account.provider]}  ${name}` : name,
		// 2 行目を使わない表示では、戻る時刻を括弧で後ろに付ける
		detail: !back ? line : plain ? `${line}（${back}）` : localize('paradis.menuBar.accountSublabelBack', "{0}・{1}", line, back),
		bars: {
			...(account.fiveHour ? { fiveHour: paradisMenuBarPercent(account.fiveHour, now) ?? 0 } : {}),
			...(account.sevenDay ? { sevenDay: paradisMenuBarPercent(account.sevenDay, now) ?? 0 } : {}),
		},
	};
}

/**
 * 1 行目は名前だけにし、数字は 2 行目（sublabel）にそろえる（メニューの文字は等幅ではないので、1 行に並べると
 * 行ごとに数字の位置がずれる）。簡単な表示では 2 行目を使わず同じ行の後ろに付ける。
 */
function accountItem(row: IParadisMenuBarAccountRow, plain: boolean): ParadisMenuBarMenuItem {
	return plain
		? { kind: 'account', label: `${row.head}  ${row.detail}`, bars: row.bars }
		: { kind: 'account', label: row.head, sublabel: row.detail, bars: row.bars };
}

function usageItems(input: IParadisMenuBarMenuInput, plain: boolean): ParadisMenuBarMenuItem[] {
	const items: ParadisMenuBarMenuItem[] = [];
	for (const provider of PARADIS_MENU_BAR_PROVIDERS) {
		const sorted = paradisSortMenuBarAccounts(input.accounts, provider, input.now);
		if (sorted.length === 0) {
			continue;
		}
		const seen = new Set<string>();
		const sameNames = new Set(sorted.map(account => account.name).filter(name => seen.has(name) || !seen.add(name)));
		// 使用中が分からない（その出どころのウィンドウが無い）ときは、余裕の多いものを先頭に出す
		const first = accountRow(sorted[0], true, plain, sameNames, input.now);
		if (sorted.length === 1) {
			items.push(accountItem(first, plain));
			continue;
		}
		// アカウントが複数あるサービスは、使用中のアカウントの行そのものをサブメニューにする（同じ行が 2 回出ないように）
		const head = localize('paradis.menuBar.accountsSubmenu', "{0}（{1}）", first.head, sorted.length);
		items.push({
			kind: 'submenu',
			...(plain ? { label: `${head}  ${first.detail}` } : { label: head, sublabel: first.detail }),
			bars: first.bars,
			items: [
				...sorted.map(account => accountItem(accountRow(account, false, plain, sameNames, input.now), plain)),
				{ kind: 'separator' },
				{ kind: 'action', label: localize('paradis.menuBar.switchAccount', "アカウントを切り替える…"), action: 'openUsagePanel' },
			],
		});
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

export function paradisMenuBarMenuModel(input: IParadisMenuBarMenuInput, settings: Pick<IParadisMenuBarSettings, 'menuUsage' | 'menuWorkingCount' | 'plainMenu' | 'title' | 'usageStyle' | 'usageWindow' | 'includeRemote'>): ParadisMenuBarMenuItem[] {
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
		{ kind: 'submenu', label: localize('paradis.menuBar.displaySubmenu', "アイコンの横に出すもの"), items: displayChoices(settings) },
		{ kind: 'action', label: localize('paradis.menuBar.openSettings', "メニューバーの設定…"), action: 'openSettings' },
	);
	return menu;
}

function radio<T extends string>(key: string, current: T, value: T, label: string): ParadisMenuBarMenuItem {
	return { kind: 'choice', label, checked: current === value, radio: true, key, value };
}

/** アイコンの横に出すもの・使用量の出し方・数える枠・SSH の接続先の分を、メニューのチェックで選ぶ。 */
function displayChoices(settings: Pick<IParadisMenuBarSettings, 'title' | 'usageStyle' | 'usageWindow' | 'includeRemote'>): ParadisMenuBarMenuItem[] {
	return [
		radio(PARADIS_MENU_BAR_TITLE_SETTING, settings.title, 'usage', localize('paradis.menuBar.choice.titleUsage', "使用量")),
		radio(PARADIS_MENU_BAR_TITLE_SETTING, settings.title, 'attention', localize('paradis.menuBar.choice.titleAttention', "許可待ちと質問の数")),
		radio(PARADIS_MENU_BAR_TITLE_SETTING, settings.title, 'none', localize('paradis.menuBar.choice.titleNone', "なし")),
		{ kind: 'separator' },
		{ kind: 'header', label: localize('paradis.menuBar.choice.styleHeader', "使用量の出し方") },
		radio(PARADIS_MENU_BAR_USAGE_STYLE_SETTING, settings.usageStyle, 'text', localize('paradis.menuBar.choice.styleText', "数字")),
		radio(PARADIS_MENU_BAR_USAGE_STYLE_SETTING, settings.usageStyle, 'bars', localize('paradis.menuBar.choice.styleBars', "細いバー 2 本")),
		radio(PARADIS_MENU_BAR_USAGE_STYLE_SETTING, settings.usageStyle, 'ring', localize('paradis.menuBar.choice.styleRing', "マークを囲む輪")),
		radio(PARADIS_MENU_BAR_USAGE_STYLE_SETTING, settings.usageStyle, 'nearLimit', localize('paradis.menuBar.choice.styleNearLimit', "上限に近いときだけ数字")),
		{ kind: 'separator' },
		{ kind: 'header', label: localize('paradis.menuBar.choice.windowHeader', "数える枠") },
		radio(PARADIS_MENU_BAR_USAGE_WINDOW_SETTING, settings.usageWindow, 'fiveHour', localize('paradis.menuBar.choice.windowFiveHour', "5 時間の枠")),
		radio(PARADIS_MENU_BAR_USAGE_WINDOW_SETTING, settings.usageWindow, 'sevenDay', localize('paradis.menuBar.choice.windowSevenDay', "週の枠")),
		radio(PARADIS_MENU_BAR_USAGE_WINDOW_SETTING, settings.usageWindow, 'higher', localize('paradis.menuBar.choice.windowHigher', "5 時間と週の多い方")),
		{ kind: 'separator' },
		{ kind: 'choice', label: localize('paradis.menuBar.choice.includeRemote', "SSH の接続先の分も合わせる"), checked: settings.includeRemote, radio: false, key: PARADIS_MENU_BAR_INCLUDE_REMOTE_SETTING, value: !settings.includeRemote },
	];
}
