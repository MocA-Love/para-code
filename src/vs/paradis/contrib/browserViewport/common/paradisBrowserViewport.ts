/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

// 内蔵ブラウザの「決まった大きさで表示する」機能の、純粋な部分（UI・サービスに依存しない）。
//
// 大きさの正は upstream の Device Emulation が持つ `IBrowserViewModel.device` だけにしている。
// 名前は保存せず、名前付きの大きさの一覧と (幅, 高さ, モバイルか) を照合して決める。こうしておけば、
// upstream の帯・端のつまみのドラッグ・エージェントの `emulate`（main が CDP の命令を device に
// 畳み込む）・`set_viewport` のどれで変わっても、表示がずれない。

import { IBrowserDeviceProfile } from '../../../../platform/browserView/common/browserView.js';

/** 名前付きの大きさ 1 件。 */
export interface IParadisViewportSize {
	readonly name: string;
	readonly width: number;
	readonly height: number;
	/** タッチ操作・スマホの見た目（pointer: coarse）も一緒に当てるか。 */
	readonly mobile?: boolean;
	readonly deviceScaleFactor?: number;
	readonly userAgent?: string;
}

/** 幅・高さとして受け付ける範囲（upstream の帯の入力欄と同じ上限）。 */
export const PARADIS_VIEWPORT_MIN_DIMENSION = 100;
export const PARADIS_VIEWPORT_MAX_DIMENSION = 9999;

/** 名前の最大長。 */
export const PARADIS_VIEWPORT_NAME_MAX_LENGTH = 40;

/** 保存できる名前付きの大きさの数の上限。 */
export const PARADIS_VIEWPORT_SIZE_LIMIT = 50;

/** 名前付きの大きさの一覧を置くストレージキー（APPLICATION スコープ）。無ければ初期の候補を使う。 */
export const PARADIS_VIEWPORT_SIZES_STORAGE_KEY = 'paradis.browser.viewport.sizes';

/** スペースごとの既定を置くストレージキー（WORKSPACE スコープ。スペースの状態キー → 指定）。 */
export const PARADIS_VIEWPORT_SPACE_DEFAULTS_STORAGE_KEY = 'paradis.browser.viewport.spaceDefaults';

/** 全体の既定の設定キー。値は名前付きの大きさの名前か「幅x高さ」。空ならエディタに合わせる。 */
export const PARADIS_VIEWPORT_DEFAULT_SETTING = 'paradis.browser.viewport.default';

const IPHONE_USER_AGENT = 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1';
const IPAD_USER_AGENT = 'Mozilla/5.0 (iPad; CPU OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1';
const ANDROID_USER_AGENT = 'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Mobile Safari/537.36';

/**
 * 初期の候補。保存した一覧が無いときに使う。スマホの UA・DPR は upstream の Device Emulation の
 * プリセット（browserEditorEmulationFeatures.ts）と同じ値。
 */
export const PARADIS_BUILT_IN_VIEWPORT_SIZES: readonly IParadisViewportSize[] = [
	// allow-any-unicode-next-line
	{ name: 'フル HD', width: 1920, height: 1080 },
	// allow-any-unicode-next-line
	{ name: 'ノート PC', width: 1366, height: 768 },
	{ name: 'MacBook Air', width: 1440, height: 900 },
	{ name: 'HD', width: 1280, height: 720 },
	{ name: 'iPhone 15', width: 390, height: 844, mobile: true, deviceScaleFactor: 3, userAgent: IPHONE_USER_AGENT },
	{ name: 'iPhone SE', width: 375, height: 667, mobile: true, deviceScaleFactor: 2, userAgent: IPHONE_USER_AGENT },
	{ name: 'Pixel 8', width: 412, height: 915, mobile: true, deviceScaleFactor: 2.625, userAgent: ANDROID_USER_AGENT },
	{ name: 'iPad mini', width: 768, height: 1024, mobile: true, deviceScaleFactor: 2, userAgent: IPAD_USER_AGENT },
];

/** 大きさの指定を解決した結果。 */
export type ParadisViewportTarget =
	/** エディタに合わせる（エミュレーションを切る）。 */
	| { readonly kind: 'fit' }
	/** 決まった大きさ。名前付きの大きさから選んだときだけ `name` がある。 */
	| { readonly kind: 'size'; readonly size: IParadisViewportSizeSpec };

/** 当てる大きさ。名前付きの大きさから選んだときだけ名前がある。 */
export type IParadisViewportSizeSpec = Omit<IParadisViewportSize, 'name'> & { readonly name?: string };

/** 「エディタに合わせる」を表す指定の綴り（大小文字は問わない）。空文字も同じ意味。 */
// allow-any-unicode-next-line
const FIT_SPECS: ReadonlySet<string> = new Set(['auto', 'fit', 'editor', 'none', 'reset', '自動', 'エディタに合わせる']);

function normalizeName(name: string): string {
	return name.normalize('NFKC').trim().replace(/\s+/g, ' ').toLowerCase();
}

function clampDimension(value: number): number | undefined {
	if (!Number.isFinite(value)) {
		return undefined;
	}
	const rounded = Math.round(value);
	if (rounded < PARADIS_VIEWPORT_MIN_DIMENSION || rounded > PARADIS_VIEWPORT_MAX_DIMENSION) {
		return undefined;
	}
	return rounded;
}

/**
 * 「1366x768」「1366×768」「1366 * 768」「1366 768」を幅と高さにする。範囲外・形が違えば undefined。
 */
export function paradisParseViewportDimensions(text: string): { readonly width: number; readonly height: number } | undefined {
	// allow-any-unicode-next-line
	const match = /^\s*(?<width>\d{1,5})\s*(?:[x×*,]|\s)\s*(?<height>\d{1,5})\s*$/i.exec(text.normalize('NFKC'));
	if (!match?.groups) {
		return undefined;
	}
	const width = clampDimension(Number(match.groups.width));
	const height = clampDimension(Number(match.groups.height));
	return width !== undefined && height !== undefined ? { width, height } : undefined;
}

/** 名前付きの大きさを名前で探す（前後の空白・大小文字・全角半角は問わない）。 */
export function paradisFindViewportSize(sizes: readonly IParadisViewportSize[], name: string): IParadisViewportSize | undefined {
	const wanted = normalizeName(name);
	return wanted ? sizes.find(size => normalizeName(size.name) === wanted) : undefined;
}

/**
 * 大きさの指定（名前付きの大きさの名前、「幅x高さ」、エディタに合わせる）を解決する。
 * 解決できなければ undefined。名前と「幅x高さ」が両方に読めるときは名前を優先する。
 */
export function paradisResolveViewportSpec(spec: string | undefined, sizes: readonly IParadisViewportSize[]): ParadisViewportTarget | undefined {
	const trimmed = (spec ?? '').trim();
	if (trimmed === '' || FIT_SPECS.has(normalizeName(trimmed))) {
		return { kind: 'fit' };
	}
	const named = paradisFindViewportSize(sizes, trimmed);
	if (named) {
		return { kind: 'size', size: named };
	}
	const dimensions = paradisParseViewportDimensions(trimmed);
	return dimensions ? { kind: 'size', size: dimensions } : undefined;
}

/**
 * 大きさを upstream の device に直す。前の device に足し込まず丸ごと置き換える
 * （スマホからパソコンの大きさへ戻したときに、UA・DPR・タッチが残らないように）。
 */
export function paradisViewportDevice(size: Omit<IParadisViewportSize, 'name'>): IBrowserDeviceProfile {
	return {
		width: size.width,
		height: size.height,
		...(size.mobile ? { mobile: true } : {}),
		...(size.deviceScaleFactor ? { deviceScaleFactor: size.deviceScaleFactor } : {}),
		...(size.userAgent ? { userAgent: size.userAgent } : {}),
	};
}

/** device と同じ (幅, 高さ, モバイルか) の名前付きの大きさ。 */
export function paradisMatchViewportSize(device: IBrowserDeviceProfile | undefined, sizes: readonly IParadisViewportSize[]): IParadisViewportSize | undefined {
	if (!device?.width || !device.height) {
		return undefined;
	}
	return sizes.find(size => size.width === device.width && size.height === device.height && !!size.mobile === !!device.mobile);
}

/** 今の大きさの説明（chip と LLM の両方が使う）。 */
export interface IParadisViewportState {
	/** エディタに合わせているか（device が無い、または幅も高さも決めていない）。 */
	readonly fit: boolean;
	/** 名前付きの大きさに当たるときの名前。 */
	readonly name?: string;
	/** ページの幅・高さ（CSS px）。エディタに合わせていて、まだ測っていないタブでは無い。 */
	readonly width?: number;
	readonly height?: number;
	readonly mobile: boolean;
}

/**
 * device と、エディタに合わせたときの大きさ（測れていれば）から、今の大きさを説明する。
 * 幅だけ・高さだけを決めた device（upstream の端のつまみで片方だけ動かした）では、決めていない側を
 * エディタの大きさで埋める。
 */
export function paradisDescribeViewport(
	device: IBrowserDeviceProfile | undefined,
	sizes: readonly IParadisViewportSize[],
	paneSize: { readonly width: number; readonly height: number } | undefined,
): IParadisViewportState {
	const mobile = !!device?.mobile;
	const fit = !device?.width && !device?.height;
	const width = device?.width || (paneSize ? Math.round(paneSize.width) : undefined);
	const height = device?.height || (paneSize ? Math.round(paneSize.height) : undefined);
	const name = fit ? undefined : paradisMatchViewportSize(device, sizes)?.name;
	return {
		fit,
		...(name !== undefined ? { name } : {}),
		...(width ? { width } : {}),
		...(height ? { height } : {}),
		mobile,
	};
}

/** 「1366×768」。 */
export function paradisFormatViewportDimensions(width: number | undefined, height: number | undefined): string {
	// allow-any-unicode-next-line
	return `${width ?? '-'}×${height ?? '-'}`;
}

/** 保存できる名前か（空・長すぎ・制御文字を含むものは不可）。 */
export function paradisSanitizeViewportName(name: string): string | undefined {
	const cleaned = name.replace(/[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u202a-\u202e\u2066-\u2069\ufeff]/g, ' ').replace(/\s+/g, ' ').trim();
	if (!cleaned || Array.from(cleaned).length > PARADIS_VIEWPORT_NAME_MAX_LENGTH) {
		return undefined;
	}
	// 「1366x768」の形の名前は、名前か大きさかが分からなくなるので受け付けない
	if (paradisParseViewportDimensions(cleaned) || FIT_SPECS.has(normalizeName(cleaned))) {
		return undefined;
	}
	return cleaned;
}

/** ストレージの値（JSON）を名前付きの大きさの一覧にする。壊れていれば undefined（初期の候補を使う）。 */
export function paradisParseViewportSizes(raw: string | undefined): IParadisViewportSize[] | undefined {
	if (!raw) {
		return undefined;
	}
	let parsed: unknown;
	try {
		parsed = JSON.parse(raw);
	} catch {
		return undefined;
	}
	if (!Array.isArray(parsed)) {
		return undefined;
	}
	const sizes: IParadisViewportSize[] = [];
	const seen = new Set<string>();
	for (const entry of parsed) {
		if (!entry || typeof entry !== 'object') {
			continue;
		}
		const value = entry as Record<string, unknown>;
		const name = typeof value.name === 'string' ? paradisSanitizeViewportName(value.name) : undefined;
		const width = typeof value.width === 'number' ? clampDimension(value.width) : undefined;
		const height = typeof value.height === 'number' ? clampDimension(value.height) : undefined;
		if (name === undefined || width === undefined || height === undefined || seen.has(normalizeName(name))) {
			continue;
		}
		seen.add(normalizeName(name));
		const deviceScaleFactor = typeof value.deviceScaleFactor === 'number' && value.deviceScaleFactor > 0 && value.deviceScaleFactor <= 8 ? value.deviceScaleFactor : undefined;
		const userAgent = typeof value.userAgent === 'string' && value.userAgent.trim() ? value.userAgent.trim() : undefined;
		sizes.push({
			name,
			width,
			height,
			...(value.mobile === true ? { mobile: true } : {}),
			...(deviceScaleFactor !== undefined ? { deviceScaleFactor } : {}),
			...(userAgent !== undefined ? { userAgent } : {}),
		});
		if (sizes.length >= PARADIS_VIEWPORT_SIZE_LIMIT) {
			break;
		}
	}
	return sizes;
}

/** スペースごとの既定の表（JSON の object）を読む。 */
export function paradisParseViewportSpaceDefaults(raw: string | undefined): Map<string, string> {
	const result = new Map<string, string>();
	if (!raw) {
		return result;
	}
	try {
		const parsed: unknown = JSON.parse(raw);
		if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
			for (const [key, value] of Object.entries(parsed as Record<string, unknown>)) {
				if (typeof value === 'string') {
					result.set(key, value);
				}
			}
		}
	} catch {
		// 壊れた値は空の表として扱う
	}
	return result;
}

/** どこで決めた既定か。 */
export type ParadisViewportDefaultSource = 'space' | 'parentSpace' | 'global' | 'none';

/**
 * 新しく開いたタブに当てる既定を決める（唯一の判定点）。スペースの指定があればそれを、worktree の
 * スペースで自分の指定が無ければ親（メインツリー）の指定を、どちらも無ければ全体の指定を使う。
 */
export function paradisResolveViewportDefault(
	spaceDefaults: ReadonlyMap<string, string>,
	stateKey: string | undefined,
	parentStateKey: string | undefined,
	globalSpec: string | undefined,
): { readonly spec: string; readonly source: ParadisViewportDefaultSource } {
	if (stateKey !== undefined) {
		const own = spaceDefaults.get(stateKey);
		if (own !== undefined) {
			return { spec: own, source: 'space' };
		}
		if (parentStateKey !== undefined && parentStateKey !== stateKey) {
			const parent = spaceDefaults.get(parentStateKey);
			if (parent !== undefined) {
				return { spec: parent, source: 'parentSpace' };
			}
		}
	}
	const global = (globalSpec ?? '').trim();
	return global ? { spec: global, source: 'global' } : { spec: '', source: 'none' };
}

/** 既定の指定が、その大きさ（名前付きの大きさ・エディタに合わせる）を指しているか。 */
export function paradisViewportSpecMatches(spec: string | undefined, target: ParadisViewportTarget, sizes: readonly IParadisViewportSize[]): boolean {
	const resolved = paradisResolveViewportSpec(spec, sizes);
	if (!resolved || resolved.kind !== target.kind) {
		return false;
	}
	if (resolved.kind === 'fit' || target.kind === 'fit') {
		return true;
	}
	const a = resolved.size;
	const b = target.size;
	const aName = a.name;
	const bName = b.name;
	if (aName !== undefined || bName !== undefined) {
		return aName !== undefined && bName !== undefined && normalizeName(aName) === normalizeName(bName);
	}
	return a.width === b.width && a.height === b.height;
}

// ---------------------------------------------------------------------------------------------
// para-browser（LLM）向けの契約。shared process ⇔ renderer。renderer は構造化した結果だけを返し、
// LLM 向けの英文は shared process 側（paradisAgentBrowserService.ts）が作る。
// ---------------------------------------------------------------------------------------------

/** shared process → renderer のチャネル名。 */
export const PARADIS_BROWSER_VIEWPORT_MCP_CHANNEL = 'paradisBrowserViewportMcp';

export const ParadisViewportMcpMethod = {
	/** 引数なし。{@link IParadisListViewportsResult} を返す。 */
	List: 'listViewports',
	/** 引数は [ペインのトークン, tabId, 指定]。{@link IParadisSetViewportResult} を返す。 */
	Set: 'setViewport',
	/** 引数は [tabId の配列]。tabId → {@link IParadisViewportState} を返す（分からないタブは載らない）。 */
	Describe: 'describeViewports',
	/**
	 * 引数は [ペインのトークン, tabId, 変える前の device（無ければ null）]。エージェントが CDP の命令（emulate など）で
	 * 大きさを変えたことを知らせる（chip の強調とホバーを set_viewport と同じにする）。
	 */
	NoteAgentEmulation: 'noteAgentEmulation',
} as const;

export interface IParadisListViewportsResult {
	readonly sizes: readonly { readonly name: string; readonly width: number; readonly height: number; readonly mobile: boolean }[];
	/** 全体の既定（設定）の指定。空ならエディタに合わせる。 */
	readonly globalDefault: string;
}

export type ParadisSetViewportFailure =
	/** 名前付きの大きさにも「幅x高さ」にも読めない。 */
	| 'unknownViewport'
	/** そのタブが Para Code に無い（閉じた）。 */
	| 'unknownTab'
	/** タブのページをまだ用意できていない。 */
	| 'tabNotReady';

export type IParadisSetViewportResult =
	| { readonly ok: true; readonly previous: IParadisViewportState; readonly viewport: IParadisViewportState }
	| { readonly ok: false; readonly reason: ParadisSetViewportFailure };
