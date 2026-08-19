/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-PATCH/PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import { Event } from '../../../../base/common/event.js';
import { createDecorator } from '../../../../platform/instantiation/common/instantiation.js';

/** ブラウザ一覧ウィンドウのタイル1枚分。 */
export interface IParadisBrowserLiveEntry {
	/** ブラウザビューのID (= エディタ入力のID、共有バインディングの pageId)。 */
	readonly viewId: string;
	readonly title: string;
	readonly url: string;
	/** favicon の URL (data URI のこともある)。取得前は undefined。 */
	readonly favicon: string | undefined;
	readonly loading: boolean;
	/** 読み込みに失敗しているときの説明。正常なら undefined。 */
	readonly errorText: string | undefined;
	/**
	 * エディタ上で実際に描かれているか。隠れているタブは再描画が起きないため、
	 * サムネの取得間隔を落とす判断に使う。
	 */
	readonly visible: boolean;
	/** このページを共有しているエージェントの表示名 (重複なし)。共有していなければ空。 */
	readonly agents: readonly string[];
	/** エディタの並び順 (グループ順 → グループ内の順)。「タブの並び」ソートの基準。 */
	readonly order: number;
}

/** タイトルバーのボタンが出すバッジの材料。 */
export interface IParadisBrowserLiveSummary {
	/** 開いている内蔵ブラウザの総数。 */
	readonly total: number;
	/** そのうちエージェントへ共有中の数。1以上ならバッジを強調する。 */
	readonly shared: number;
}

export type ParadisBrowserLiveSort = 'editor' | 'title' | 'shared';

/**
 * サムネの更新頻度。
 *
 * 映像は「見えているビューのスクリーンショットを繰り返し撮る」ことで作っている。
 * 撮る回数がそのまま負荷になるので、頻度はユーザーが選べるようにしてある。
 */
export type ParadisBrowserLiveCadence = 'off' | 'normal' | 'smooth';

export interface IParadisBrowserLiveViewState {
	columns: number;
	/** 共有中のページだけに絞る。 */
	sharedOnly: boolean;
	sort: ParadisBrowserLiveSort;
	cadence: ParadisBrowserLiveCadence;
}

export const PARADIS_BROWSER_LIVE_MIN_COLUMNS = 1;
export const PARADIS_BROWSER_LIVE_MAX_COLUMNS = 6;
export const PARADIS_BROWSER_LIVE_DEFAULT_COLUMNS = 3;

const SORTS: readonly ParadisBrowserLiveSort[] = ['editor', 'title', 'shared'];
const CADENCES: readonly ParadisBrowserLiveCadence[] = ['off', 'normal', 'smooth'];

export function paradisClampBrowserLiveColumns(value: number): number {
	if (!Number.isFinite(value)) {
		return PARADIS_BROWSER_LIVE_DEFAULT_COLUMNS;
	}
	return Math.min(PARADIS_BROWSER_LIVE_MAX_COLUMNS, Math.max(PARADIS_BROWSER_LIVE_MIN_COLUMNS, Math.round(value)));
}

export function paradisDefaultBrowserLiveViewState(): IParadisBrowserLiveViewState {
	return {
		columns: PARADIS_BROWSER_LIVE_DEFAULT_COLUMNS,
		sharedOnly: false,
		sort: 'editor',
		cadence: 'normal',
	};
}

/** 保存済みビュー状態を読み戻す。壊れた値・未知の値は既定へ落とす (例外は投げない)。 */
export function paradisParseBrowserLiveViewState(raw: string | undefined): IParadisBrowserLiveViewState {
	const state = paradisDefaultBrowserLiveViewState();
	if (!raw) {
		return state;
	}
	let parsed: Record<string, unknown>;
	try {
		const value: unknown = JSON.parse(raw);
		if (!value || typeof value !== 'object') {
			return state;
		}
		parsed = value as Record<string, unknown>;
	} catch {
		return state;
	}

	if (typeof parsed.columns === 'number') {
		state.columns = paradisClampBrowserLiveColumns(parsed.columns);
	}
	state.sharedOnly = parsed.sharedOnly === true;
	if (typeof parsed.sort === 'string' && (SORTS as readonly string[]).includes(parsed.sort)) {
		state.sort = parsed.sort as ParadisBrowserLiveSort;
	}
	if (typeof parsed.cadence === 'string' && (CADENCES as readonly string[]).includes(parsed.cadence)) {
		state.cadence = parsed.cadence as ParadisBrowserLiveCadence;
	}
	return state;
}

export function paradisSerializeBrowserLiveViewState(state: IParadisBrowserLiveViewState): string {
	return JSON.stringify(state);
}

export function paradisFilterBrowserLiveEntries(entries: readonly IParadisBrowserLiveEntry[], state: IParadisBrowserLiveViewState): IParadisBrowserLiveEntry[] {
	return entries.filter(entry => !state.sharedOnly || entry.agents.length > 0);
}

/**
 * 並び替え。既定は「タブの並び」で、エディタで見えている順とタイルの順を一致させる
 * (一覧とタブを見比べたときに探し直さずに済む)。
 */
export function paradisSortBrowserLiveEntries(entries: readonly IParadisBrowserLiveEntry[], state: IParadisBrowserLiveViewState): IParadisBrowserLiveEntry[] {
	const sorted = [...entries];
	sorted.sort((a, b) => {
		switch (state.sort) {
			case 'title': {
				const byTitle = paradisBrowserLiveDisplayTitle(a).localeCompare(paradisBrowserLiveDisplayTitle(b));
				return byTitle !== 0 ? byTitle : a.order - b.order;
			}
			case 'shared': {
				// 共有中を先頭へ寄せ、その中はタブの並びを保つ (同じ状態のものが入れ替わらない)。
				const byShared = (b.agents.length > 0 ? 1 : 0) - (a.agents.length > 0 ? 1 : 0);
				return byShared !== 0 ? byShared : a.order - b.order;
			}
			case 'editor':
			default:
				return a.order - b.order;
		}
	});
	return sorted;
}

export function paradisSummarizeBrowserLiveEntries(entries: readonly IParadisBrowserLiveEntry[]): IParadisBrowserLiveSummary {
	let shared = 0;
	for (const entry of entries) {
		if (entry.agents.length > 0) {
			shared++;
		}
	}
	return { total: entries.length, shared };
}

/**
 * タイルの見出し。タイトルが未取得のページ (開いた直後・about:blank) では URL を使う。
 * どちらも無いときだけ「新しいタブ」に落とす。
 */
export function paradisBrowserLiveDisplayTitle(entry: Pick<IParadisBrowserLiveEntry, 'title' | 'url'>): string {
	const title = entry.title.trim();
	if (title) {
		return title;
	}
	const url = paradisBrowserLiveDisplayUrl(entry.url);
	// allow-any-unicode-next-line
	return url || '新しいタブ';
}

/**
 * URL を1行で読める形に整える。
 *
 * スキームと `www.` を落として末尾のスラッシュを削るだけ。長い URL の切り詰めは CSS
 * (text-overflow) に任せる —— 文字数で切ると、末尾のクエリだけが違うページを見分けられなくなる。
 */
export function paradisBrowserLiveDisplayUrl(url: string): string {
	const trimmed = url.trim();
	if (!trimmed || trimmed === 'about:blank') {
		return '';
	}
	let rest = trimmed;
	for (const scheme of ['https://', 'http://']) {
		if (rest.startsWith(scheme)) {
			rest = rest.slice(scheme.length);
			break;
		}
	}
	if (rest.startsWith('www.')) {
		rest = rest.slice(4);
	}
	if (rest.length > 1 && rest.endsWith('/')) {
		rest = rest.slice(0, -1);
	}
	return rest;
}

/** サムネを撮るかどうかの判断材料。 */
export interface IParadisBrowserLiveCaptureTarget {
	/** エディタ上で実際に描かれているか。 */
	readonly visible: boolean;
	/** エージェントへ共有中か。 */
	readonly shared: boolean;
}

/**
 * 次のサムネ取得までの待ち時間 (ms)。0 は「撮らない」。
 *
 * 隠れているタブは再描画が起きないので、撮っても絵は変わらない。そのうえ撮影のたびに
 * main 側で可視化のキックと1フレームぶんのペイント待ちが走り (browserViewScreenshot.ts の
 * prepareBrowserViewScreenshotCapture)、撮影はビューごとに直列化されているため、
 * エージェント自身のスクリーンショットまで後ろに並ばされる。
 *
 * そこで隠れているタブは原則「最後の1枚を出したまま撮らない」。例外はエージェントへ共有中の
 * ページだけで、これは画面に出ていなくても中身が動くので低頻度で追う。
 */
export function paradisBrowserLiveCaptureDelayMs(cadence: ParadisBrowserLiveCadence, target: IParadisBrowserLiveCaptureTarget): number {
	if (cadence === 'off') {
		return 0;
	}
	if (!target.visible) {
		return target.shared ? 5000 : 0;
	}
	return cadence === 'smooth' ? 350 : 1000;
}

/**
 * 取得に失敗し続けたときの待ち時間 (ms)。
 *
 * 失敗はページ側の事情 (破棄途中・巨大なビューポート・撮影の輻輳) で起きるので、
 * 同じ頻度で叩き続けても復帰しない。連続失敗ごとに間隔を倍にし、8倍で頭打ちにする
 * (最短 1 秒始まりなので、実際の上限は 8 秒。30 秒の上限は base が大きい場合の保険)。
 */
export function paradisBrowserLiveRetryDelayMs(baseDelayMs: number, consecutiveFailures: number): number {
	const factor = Math.min(8, Math.pow(2, Math.max(0, consecutiveFailures - 1)));
	return Math.min(30_000, Math.max(1000, baseDelayMs) * factor);
}

export const IParadisBrowserLiveWindowService = createDecorator<IParadisBrowserLiveWindowService>('paradisBrowserLiveWindowService');

/**
 * 内蔵ブラウザのライブ一覧ウィンドウ (別ウィンドウ) を管理するサービス。
 * ウィンドウを開いていない間もサマリだけは更新し続ける (タイトルバーのバッジのため)。
 */
export interface IParadisBrowserLiveWindowService {
	readonly _serviceBrand: undefined;
	readonly onDidChangeSummary: Event<void>;
	readonly summary: IParadisBrowserLiveSummary;
	/** 開いていなければ開き、開いていれば前面に出す。 */
	open(): Promise<void>;
}
