/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

// メニューバー（macOS）・通知領域（Windows）の Para Code のアイコンの設定と、renderer と main の間の契約。
//
// アイコンは main が持つ（Electron の Tray は main でしか作れない）。中身は各ウィンドウ（renderer）が
// 送る: 通知の台帳から読んだ要対応の一覧、そのウィンドウのペインのうち作業中の数、そのウィンドウが
// 取った使用量（手元のウィンドウは手元の値、SSH のウィンドウは接続先の値）と今日のコスト。
// main は受け取った使用量を出どころごとに覚え、ウィンドウを閉じた後も古さを添えて出す。

import { IParadisInboxSnapshot, paradisInboxAttentionEntries, paradisInboxEntryLocation, ParadisInboxKind } from '../../notificationInbox/common/paradisNotificationInbox.js';

export const PARADIS_MENU_BAR_CHANNEL = 'paradisMenuBar';
/** 「設定 (Para Code)」ダイアログの「メニューバー」の節。 */
export const PARADIS_MENU_BAR_SETTINGS_SECTION_ID = 'psd-sec-menubar';

// ---- 設定 ------------------------------------------------------------------------------------

/** アイコンを出すか。前の版の通知の受信箱の設定をそのまま使う（既定オフ）。 */
export { PARADIS_NOTIFICATION_MENU_BAR_SETTING as PARADIS_MENU_BAR_ICON_SETTING } from '../../notificationInbox/common/paradisNotificationInbox.js';

/** アイコンの横に出すもの。 */
export const PARADIS_MENU_BAR_TITLE_SETTING = 'paradis.menuBar.title';
export type ParadisMenuBarTitle = 'usage' | 'attention' | 'none';
const TITLES: readonly ParadisMenuBarTitle[] = ['usage', 'attention', 'none'];

/** 使用量の出し方。 */
export const PARADIS_MENU_BAR_USAGE_STYLE_SETTING = 'paradis.menuBar.usageStyle';
export type ParadisMenuBarUsageStyle = 'text' | 'bars' | 'ring' | 'nearLimit';
const USAGE_STYLES: readonly ParadisMenuBarUsageStyle[] = ['text', 'bars', 'ring', 'nearLimit'];

/** 横に出す枠。 */
export const PARADIS_MENU_BAR_USAGE_WINDOW_SETTING = 'paradis.menuBar.usageWindow';
export type ParadisMenuBarUsageWindow = 'fiveHour' | 'sevenDay' | 'higher';
const USAGE_WINDOWS: readonly ParadisMenuBarUsageWindow[] = ['fiveHour', 'sevenDay', 'higher'];

/** アカウントが複数あるときに横へ出すもの。 */
export const PARADIS_MENU_BAR_MULTIPLE_ACCOUNTS_SETTING = 'paradis.menuBar.multipleAccounts';
export type ParadisMenuBarMultipleAccounts = 'active' | 'available' | 'both';
const MULTIPLE_ACCOUNTS: readonly ParadisMenuBarMultipleAccounts[] = ['active', 'available', 'both'];

/** 開いている SSH の接続先の使用量も合わせるか。 */
export const PARADIS_MENU_BAR_INCLUDE_REMOTE_SETTING = 'paradis.menuBar.includeRemote';
/** メニューに使用量と今日のコストを出すか。 */
export const PARADIS_MENU_BAR_MENU_USAGE_SETTING = 'paradis.menuBar.menu.usage';
/** メニューの見出しに作業中のエージェントの数を足すか（行は出さない）。 */
export const PARADIS_MENU_BAR_MENU_WORKING_COUNT_SETTING = 'paradis.menuBar.menu.workingCount';
/**
 * 行の 2 行目・行の頭の画像・文字の色を使わない簡単な表示にする。macOS の版によってメニューの
 * 2 行目や横長の画像が崩れたときの逃げ道。
 */
export const PARADIS_MENU_BAR_PLAIN_MENU_SETTING = 'paradis.menuBar.plainMenu';

export interface IParadisMenuBarSettings {
	readonly iconEnabled: boolean;
	readonly title: ParadisMenuBarTitle;
	readonly usageStyle: ParadisMenuBarUsageStyle;
	readonly usageWindow: ParadisMenuBarUsageWindow;
	readonly multipleAccounts: ParadisMenuBarMultipleAccounts;
	readonly includeRemote: boolean;
	readonly menuUsage: boolean;
	readonly menuWorkingCount: boolean;
	readonly plainMenu: boolean;
}

function pick<T extends string>(value: unknown, allowed: readonly T[], fallback: T): T {
	return typeof value === 'string' && (allowed as readonly string[]).includes(value) ? value as T : fallback;
}

/** 設定を読む。壊れた値は既定に戻す。 */
export function paradisReadMenuBarSettings(iconEnabled: boolean, get: (key: string) => unknown): IParadisMenuBarSettings {
	return {
		iconEnabled,
		title: pick(get(PARADIS_MENU_BAR_TITLE_SETTING), TITLES, 'usage'),
		usageStyle: pick(get(PARADIS_MENU_BAR_USAGE_STYLE_SETTING), USAGE_STYLES, 'text'),
		usageWindow: pick(get(PARADIS_MENU_BAR_USAGE_WINDOW_SETTING), USAGE_WINDOWS, 'fiveHour'),
		multipleAccounts: pick(get(PARADIS_MENU_BAR_MULTIPLE_ACCOUNTS_SETTING), MULTIPLE_ACCOUNTS, 'active'),
		includeRemote: get(PARADIS_MENU_BAR_INCLUDE_REMOTE_SETTING) !== false,
		menuUsage: get(PARADIS_MENU_BAR_MENU_USAGE_SETTING) !== false,
		menuWorkingCount: get(PARADIS_MENU_BAR_MENU_WORKING_COUNT_SETTING) === true,
		plainMenu: get(PARADIS_MENU_BAR_PLAIN_MENU_SETTING) === true,
	};
}

/**
 * 使用量を取りに行く必要があるか。横にもメニューにも出さない（ベルだけの）ときは取らない。
 * タイトルバーの使用量の設定（`paradis.limitsMonitor.enabled`）とは独立で、そちらがオフでも
 * ここがオンなら取りに行く（設定の説明にもそう書いてある）。
 */
export function paradisMenuBarNeedsUsage(settings: IParadisMenuBarSettings): boolean {
	return settings.iconEnabled && (settings.title === 'usage' || settings.menuUsage);
}

// ---- renderer から main へ送るもの --------------------------------------------------------------

/** メニューに出す要対応の件数の上限。 */
export const PARADIS_MENU_BAR_ATTENTION_LIMIT = 5;

export interface IParadisMenuBarAttentionItem {
	readonly entryId: string;
	readonly kind: ParadisInboxKind;
	readonly location: string;
	readonly at: number;
}

/** 通知の台帳から読んだ要対応（全ウィンドウ共通）。 */
export interface IParadisMenuBarInbox {
	/** 要対応のペイン数（完了の確認待ちを含む）。 */
	readonly attentionCount: number;
	/** そのうち許可待ちと質問のペイン数（エージェントが止まっているもの）。 */
	readonly blockingCount: number;
	readonly items: readonly IParadisMenuBarAttentionItem[];
	/** もとにした台帳のスナップショットの番号（古いものを捨てるため）。 */
	readonly revision: number;
}

export interface IParadisMenuBarWindowUsage {
	/** 0〜100。 */
	readonly percent: number;
	/** epoch ms。 */
	readonly resetsAt?: number;
}

export type ParadisMenuBarProvider = 'claude' | 'codex';

/** アカウント 1 つ。 */
export interface IParadisMenuBarAccount {
	readonly provider: ParadisMenuBarProvider;
	/**
	 * 出どころをまたいで同じアカウントを束ねる鍵（モバイル版の合計と同じ規則）。Claude はメールと組織、
	 * Codex は account_id のハッシュ。分からないときは出どころと ID から作る（束ねない）。
	 */
	readonly key: string;
	/** 表示名（メールの @ より前など）。 */
	readonly name: string;
	/** メールの @ より後ろ。表示名が同じアカウントが並んだときだけ見分けに添える。 */
	readonly domain?: string;
	/** その出どころで、いま使っているアカウントか。 */
	readonly active: boolean;
	readonly fiveHour?: IParadisMenuBarWindowUsage;
	readonly sevenDay?: IParadisMenuBarWindowUsage;
	/** 値を取れた時刻（epoch ms）。 */
	readonly fetchedAt?: number;
}

/** 1 つのウィンドウが取った使用量。手元のウィンドウは手元の値、SSH のウィンドウは接続先の値。 */
export interface IParadisMenuBarUsageSource {
	/** 'local' か、接続先の authority。 */
	readonly key: string;
	readonly label?: string;
	readonly remote: boolean;
	/** 取り終えた時刻（epoch ms）。 */
	readonly fetchedAt: number;
	readonly accounts: readonly IParadisMenuBarAccount[];
}

/** 1 つの出どころの今日のコスト。 */
export interface IParadisMenuBarCost {
	readonly sourceKey: string;
	readonly label?: string;
	readonly remote: boolean;
	readonly usd: number;
	readonly fetchedAt: number;
}

/** 1 つのウィンドウが main へ送る中身。 */
export interface IParadisMenuBarReport {
	readonly inbox: IParadisMenuBarInbox;
	/** このウィンドウのペインのうち、作業中のもの。 */
	readonly working: number;
	readonly usage?: IParadisMenuBarUsageSource;
	readonly cost?: IParadisMenuBarCost;
}

/**
 * メニューで押されたもの。`windowId` は main が選んだ「これを処理するウィンドウ」（最後に使っていた
 * ウィンドウ）。全ウィンドウに届くので、自分宛てのものだけを処理する。
 */
export type ParadisMenuBarRequest =
	| { readonly type: 'reveal'; readonly windowId: number; readonly entryId: string }
	| { readonly type: 'openUsagePanel'; readonly windowId: number }
	| { readonly type: 'openCostDashboard'; readonly windowId: number }
	| { readonly type: 'openSettings'; readonly windowId: number };

/**
 * ウィンドウの出どころの鍵。手元は 'local'。接続先は同じホストを `host` と `user@host`（や
 * Remote-SSH の 16 進の JSON の形）で開いても 1 つになるよう、ユーザー名を外して小文字にそろえる
 * （今日のコストを二重に足さないため）。
 */
export function paradisMenuBarSourceKey(remoteAuthority: string | undefined): string {
	if (!remoteAuthority) {
		return 'local';
	}
	const plus = remoteAuthority.indexOf('+');
	if (plus < 0) {
		return remoteAuthority.toLowerCase();
	}
	const kind = remoteAuthority.slice(0, plus);
	let host = remoteAuthority.slice(plus + 1);
	if (/^(?:[0-9a-f]{2})+$/i.test(host)) {
		try {
			const decoded = JSON.parse(new TextDecoder().decode(new Uint8Array(host.match(/../g)!.map(pair => parseInt(pair, 16)))));
			if (typeof decoded?.hostName === 'string') {
				host = decoded.hostName;
			}
		} catch {
			// 16 進に見えるだけのホスト名
		}
	}
	host = host.slice(host.lastIndexOf('@') + 1);
	return `${kind}+${host}`.toLowerCase();
}

export function paradisMenuBarInboxFromSnapshot(snapshot: IParadisInboxSnapshot): IParadisMenuBarInbox {
	const entries = paradisInboxAttentionEntries(snapshot, Number.POSITIVE_INFINITY);
	return {
		attentionCount: snapshot.attentionPaneCount,
		blockingCount: entries.filter(entry => entry.kind !== 'review').length,
		revision: snapshot.revision,
		items: entries.slice(0, PARADIS_MENU_BAR_ATTENTION_LIMIT).map(entry => ({
			entryId: entry.id,
			kind: entry.kind,
			location: paradisInboxEntryLocation(entry),
			at: entry.at,
		})),
	};
}

// ---- 受け取った値を検める（形が崩れていてもメニューを壊さない） --------------------------------------

const MAX_ACCOUNTS = 50;
const MAX_TEXT = 200;

function record(value: unknown): Record<string, unknown> {
	return value !== null && typeof value === 'object' ? value as Record<string, unknown> : {};
}

function finite(value: unknown): number | undefined {
	return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function text(value: unknown): string | undefined {
	return typeof value === 'string' && value.length > 0 ? value.slice(0, MAX_TEXT) : undefined;
}

function sanitizeWindow(value: unknown): IParadisMenuBarWindowUsage | undefined {
	const input = record(value);
	const percent = finite(input.percent);
	if (percent === undefined) {
		return undefined;
	}
	const resetsAt = finite(input.resetsAt);
	const clamped = Math.max(0, Math.min(100, percent));
	return resetsAt !== undefined ? { percent: clamped, resetsAt } : { percent: clamped };
}

function sanitizeAccount(value: unknown): IParadisMenuBarAccount | undefined {
	const input = record(value);
	const provider = input.provider === 'claude' || input.provider === 'codex' ? input.provider : undefined;
	const key = text(input.key);
	const name = text(input.name);
	if (!provider || !key || !name) {
		return undefined;
	}
	const domain = text(input.domain);
	const fiveHour = sanitizeWindow(input.fiveHour);
	const sevenDay = sanitizeWindow(input.sevenDay);
	const fetchedAt = finite(input.fetchedAt);
	return {
		provider, key, name,
		...(domain ? { domain } : {}),
		active: input.active === true,
		...(fiveHour ? { fiveHour } : {}),
		...(sevenDay ? { sevenDay } : {}),
		...(fetchedAt !== undefined ? { fetchedAt } : {}),
	};
}

function sanitizeUsage(value: unknown): IParadisMenuBarUsageSource | undefined {
	const input = record(value);
	const key = text(input.key);
	const fetchedAt = finite(input.fetchedAt);
	if (!key || fetchedAt === undefined || !Array.isArray(input.accounts)) {
		return undefined;
	}
	const label = text(input.label);
	const accounts = input.accounts.slice(0, MAX_ACCOUNTS).map(sanitizeAccount).filter((account): account is IParadisMenuBarAccount => account !== undefined);
	return { key, ...(label ? { label } : {}), remote: input.remote === true, fetchedAt, accounts };
}

function sanitizeCost(value: unknown): IParadisMenuBarCost | undefined {
	const input = record(value);
	const sourceKey = text(input.sourceKey);
	const usd = finite(input.usd);
	const fetchedAt = finite(input.fetchedAt);
	if (!sourceKey || usd === undefined || usd < 0 || fetchedAt === undefined) {
		return undefined;
	}
	const label = text(input.label);
	return { sourceKey, ...(label ? { label } : {}), remote: input.remote === true, usd, fetchedAt };
}

function sanitizeInbox(value: unknown): IParadisMenuBarInbox {
	const input = record(value);
	const items: IParadisMenuBarAttentionItem[] = [];
	if (Array.isArray(input.items)) {
		for (const raw of input.items.slice(0, PARADIS_MENU_BAR_ATTENTION_LIMIT)) {
			const item = record(raw);
			if (typeof item.entryId === 'string' && (item.kind === 'review' || item.kind === 'permission' || item.kind === 'question')
				&& typeof item.location === 'string' && typeof item.at === 'number') {
				items.push({ entryId: item.entryId, kind: item.kind, location: item.location.slice(0, MAX_TEXT), at: item.at });
			}
		}
	}
	const count = (raw: unknown) => {
		const number = finite(raw);
		return number !== undefined && number > 0 ? Math.floor(number) : 0;
	};
	return { attentionCount: count(input.attentionCount), blockingCount: count(input.blockingCount), items, revision: finite(input.revision) ?? 0 };
}

export function paradisSanitizeMenuBarReport(value: unknown): IParadisMenuBarReport {
	const input = record(value);
	const working = finite(input.working);
	const usage = sanitizeUsage(input.usage);
	const cost = sanitizeCost(input.cost);
	return {
		inbox: sanitizeInbox(input.inbox),
		working: working !== undefined && working > 0 ? Math.floor(working) : 0,
		...(usage ? { usage } : {}),
		...(cost ? { cost } : {}),
	};
}
