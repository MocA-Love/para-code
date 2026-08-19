/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-PATCH/PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import { Event } from '../../../../base/common/event.js';
import { createDecorator } from '../../../../platform/instantiation/common/instantiation.js';
import { ParadisBindingScope } from '../../workspaceSwitch/common/paradisWorkspaceSwitch.js';

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
	/** 所属スペースの状態キー。どのスペースにも属さないページでは undefined。 */
	readonly stateKey: string | undefined;
	/** スペースの表示名 (「リポジトリ / worktree」)。解決できなければ空。 */
	readonly spaceName: string;
	/** スペース色 (hex)。未設定・未解決では undefined。 */
	readonly spaceColor: string | undefined;
	/** いま開いているスペースのページか。閉じる操作を許すかの判断にも使う。 */
	readonly inActiveSpace: boolean;
}

/**
 * タイトルバーのボタンが出すバッジと、ツールバーのチップの材料。
 *
 * バッジは「いま開いているスペースのタイトルバー」に出るので、基準も今のスペースにする
 * (一覧の中身は全スペースだが、バッジまで全スペース合計にすると、1タブしか開いていない
 * スペースで大きな数字が出て、切り替えても動かない)。全体の数は補足として別に持つ。
 */
export interface IParadisBrowserLiveSummary {
	/** いま開いているスペースのページ数。 */
	readonly total: number;
	/** そのうちエージェントへ共有中の数。1以上ならバッジを強調する。 */
	readonly shared: number;
	/** 他のスペースを含めた総数。 */
	readonly totalAll: number;
	/** 他のスペースを含めた共有中の数。 */
	readonly sharedAll: number;
}

export type ParadisBrowserLiveSort = 'editor' | 'title' | 'shared' | 'space';

/** タイルの束ね方。スペースをまたいで並ぶので、既定はスペースごとにまとめる。 */
export type ParadisBrowserLiveGroup = 'space' | 'none';

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
	/**
	 * いま開いているスペースのページだけに絞る。
	 *
	 * {@link spaces} と違い、切り替えに追従する (「手元のぶんだけ見る」という意図を保つ)。
	 */
	activeSpaceOnly: boolean;
	/** 表示するスペースの状態キー。undefined = すべて。 */
	spaces: string[] | undefined;
	/** 一覧から外したページ (ビューID)。閉じるのとは違い、タブはそのまま残る。 */
	hidden: string[];
	sort: ParadisBrowserLiveSort;
	group: ParadisBrowserLiveGroup;
	cadence: ParadisBrowserLiveCadence;
}

function stringArray(value: unknown): string[] | undefined {
	return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : undefined;
}

export const PARADIS_BROWSER_LIVE_MIN_COLUMNS = 1;
export const PARADIS_BROWSER_LIVE_MAX_COLUMNS = 6;
export const PARADIS_BROWSER_LIVE_DEFAULT_COLUMNS = 3;

const SORTS: readonly ParadisBrowserLiveSort[] = ['editor', 'title', 'shared', 'space'];
const GROUPS: readonly ParadisBrowserLiveGroup[] = ['space', 'none'];
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
		activeSpaceOnly: false,
		spaces: undefined,
		hidden: [],
		sort: 'editor',
		group: 'space',
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
	state.activeSpaceOnly = parsed.activeSpaceOnly === true;
	const spaces = stringArray(parsed.spaces);
	state.spaces = spaces && spaces.length > 0 ? spaces : undefined;
	state.hidden = stringArray(parsed.hidden) ?? [];
	if (typeof parsed.sort === 'string' && (SORTS as readonly string[]).includes(parsed.sort)) {
		state.sort = parsed.sort as ParadisBrowserLiveSort;
	}
	if (typeof parsed.group === 'string' && (GROUPS as readonly string[]).includes(parsed.group)) {
		state.group = parsed.group as ParadisBrowserLiveGroup;
	}
	if (typeof parsed.cadence === 'string' && (CADENCES as readonly string[]).includes(parsed.cadence)) {
		state.cadence = parsed.cadence as ParadisBrowserLiveCadence;
	}
	return state;
}

export function paradisSerializeBrowserLiveViewState(state: IParadisBrowserLiveViewState): string {
	return JSON.stringify(state);
}

/** 絞り込みが1つでも効いているか (状況バーを出す条件)。 */
export function paradisHasBrowserLiveFilter(state: IParadisBrowserLiveViewState): boolean {
	return state.sharedOnly || state.activeSpaceOnly || state.spaces !== undefined || state.hidden.length > 0;
}

export function paradisFilterBrowserLiveEntries(entries: readonly IParadisBrowserLiveEntry[], state: IParadisBrowserLiveViewState): IParadisBrowserLiveEntry[] {
	const hidden = new Set(state.hidden);
	const spaces = state.spaces ? new Set(state.spaces) : undefined;
	return entries.filter(entry => {
		if (hidden.has(entry.viewId)) {
			return false;
		}
		if (state.sharedOnly && entry.agents.length === 0) {
			return false;
		}
		if (state.activeSpaceOnly && !entry.inActiveSpace) {
			return false;
		}
		if (spaces && !spaces.has(entry.stateKey ?? '')) {
			return false;
		}
		return true;
	});
}

/**
 * 並び替え。
 *
 * どの並びでも、いま開いているスペースのページを先に置く。一覧には全スペースのページが
 * 並ぶので、手元のタブが他スペースのタブに埋もれると探し直しになるため。
 * 既定の「タブの並び」は、その中でエディタのタブ順と一致させる。
 */
export function paradisSortBrowserLiveEntries(entries: readonly IParadisBrowserLiveEntry[], state: IParadisBrowserLiveViewState): IParadisBrowserLiveEntry[] {
	const sorted = [...entries];
	sorted.sort((a, b) => {
		const byActive = (b.inActiveSpace ? 1 : 0) - (a.inActiveSpace ? 1 : 0);
		if (byActive !== 0) {
			return byActive;
		}
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
			case 'space': {
				const bySpace = a.spaceName.localeCompare(b.spaceName);
				return bySpace !== 0 ? bySpace : a.order - b.order;
			}
			case 'editor':
			default:
				return a.order - b.order;
		}
	});
	return sorted;
}

export interface IParadisBrowserLiveGroupResult {
	readonly key: string;
	readonly label: string;
	readonly color: string | undefined;
	readonly entries: readonly IParadisBrowserLiveEntry[];
}

/**
 * グループ化。並び替え済みの配列を受け取り、順序を保ったまま束ねる
 * (グループの出現順は、グループ内の先頭要素が元の並びで先に来る順)。
 */
export function paradisGroupBrowserLiveEntries(
	entries: readonly IParadisBrowserLiveEntry[],
	state: IParadisBrowserLiveViewState,
	unknownSpaceLabel: string,
): IParadisBrowserLiveGroupResult[] {
	if (state.group === 'none') {
		return [{ key: '', label: '', color: undefined, entries }];
	}
	const groups = new Map<string, { label: string; color: string | undefined; entries: IParadisBrowserLiveEntry[] }>();
	for (const entry of entries) {
		const key = entry.stateKey ?? '';
		let group = groups.get(key);
		if (!group) {
			group = { label: entry.spaceName || unknownSpaceLabel, color: entry.spaceColor, entries: [] };
			groups.set(key, group);
		}
		group.entries.push(entry);
	}
	return [...groups].map(([key, group]) => ({ key, label: group.label, color: group.color, entries: group.entries }));
}

export function paradisSummarizeBrowserLiveEntries(entries: readonly IParadisBrowserLiveEntry[]): IParadisBrowserLiveSummary {
	let total = 0;
	let shared = 0;
	let sharedAll = 0;
	for (const entry of entries) {
		const isShared = entry.agents.length > 0;
		if (isShared) {
			sharedAll++;
		}
		if (entry.inActiveSpace) {
			total++;
			if (isShared) {
				shared++;
			}
		}
	}
	return { total, shared, totalAll: entries.length, sharedAll };
}

/**
 * そのページを「手元のスペースのもの」として扱ってよいか。
 *
 * スコープには 'pending' (所属がまだ分からない) がある。ウィンドウをリロードすると他スペースの
 * ページが恒久的に pending のまま残ることがあるため、pending を手元扱いすると別スペースのタブに
 * 閉じる・再読み込みが出てしまう (どちらもそのスペースの復元と台帳に触れる)。
 * 分からないものは手元ではない、に倒す。
 */
export function paradisBrowserLiveInActiveSpace(scope: ParadisBindingScope, activeStateKey: string | undefined): boolean {
	return scope.kind === 'unscoped' || (scope.kind === 'managed' && scope.stateKey === activeStateKey);
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

/** サムネイルの表示枠と、その中に描かれている画像の実寸。 */
export interface IParadisBrowserLiveCoverBox {
	readonly boxWidth: number;
	readonly boxHeight: number;
	readonly frameWidth: number;
	readonly frameHeight: number;
}

/**
 * 画像の中の割合座標 (0..1) を、表示枠の中の px へ直す。
 *
 * サムネイルは `object-fit: cover` + `object-position: top center` で描いていて、枠と画像の
 * 縦横比が違えば左右か下がはみ出して切られる。素直に「割合 × 枠の大きさ」で置くと、
 * 切られた分だけカーソルがずれる (16:10 のタイルに 16:9 のページを映すと横に、縦長のペインでは
 * 縦に大きくずれる)。切り取られて見えていない位置なら undefined を返す。
 */
export function paradisBrowserLiveCoverPoint(nx: number, ny: number, box: IParadisBrowserLiveCoverBox): { readonly x: number; readonly y: number } | undefined {
	if (box.frameWidth <= 0 || box.frameHeight <= 0 || box.boxWidth <= 0 || box.boxHeight <= 0) {
		return undefined;
	}
	// cover は「枠を覆う最小の倍率」。はみ出した側が切られる。
	const scale = Math.max(box.boxWidth / box.frameWidth, box.boxHeight / box.frameHeight);
	const width = box.frameWidth * scale;
	const height = box.frameHeight * scale;
	// object-position: top center —— 横は中央寄せ、縦は上端合わせ。
	const x = (box.boxWidth - width) / 2 + nx * width;
	const y = ny * height;
	if (x < 0 || y < 0 || x > box.boxWidth || y > box.boxHeight) {
		return undefined;
	}
	return { x, y };
}

/** サムネを撮るかどうかの判断材料。 */
export interface IParadisBrowserLiveCaptureTarget {
	/** エディタ上で実際に描かれているか (他のタブの裏・他スペースのページでは false)。 */
	readonly visible: boolean;
}

/**
 * 次のサムネ取得までの待ち時間 (ms)。0 は「撮らない」(更新頻度が「止める」のときだけ)。
 *
 * 画面に出ていないページも追いかける —— 一覧の目的が「いまどのページがどうなっているかを
 * 別ウィンドウで見張ること」なので、裏のタブや他スペースのページこそ見たい対象になる。
 *
 * ただし裏のページは撮影のたびに main 側で可視化のキックと1フレームぶんのペイント待ちが走り
 * (browserViewScreenshot.ts の prepareBrowserViewScreenshotCapture)、撮影はビューごとに
 * 直列化されているため、エージェント自身のスクリーンショットを待たせる。前面のタブより
 * 間隔を空けるのはそのため。負荷が気になる場合は更新頻度そのものを下げられる。
 */
export function paradisBrowserLiveCaptureDelayMs(cadence: ParadisBrowserLiveCadence, target: IParadisBrowserLiveCaptureTarget): number {
	if (cadence === 'off') {
		return 0;
	}
	if (target.visible) {
		return cadence === 'smooth' ? 350 : 1000;
	}
	return cadence === 'smooth' ? 1000 : 2500;
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
