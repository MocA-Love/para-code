/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.
// Portions adapted from stablyai/orca (MIT, commit 4642bc00): src/main/browser/extensions/browser-extension-action-state.ts, src/main/browser/extensions/browser-extension-popup-geometry.ts, src/shared/browser-extension-toolbar-types.ts

// chrome.action（ツールバーのボタン）の状態と、ポップアップを置く位置の計算（P5）。main と renderer の両方から
// 読む純粋な部分。
//
// Chrome の決まり: タブを指定して設定した値は、そのタブでだけ全体の値より優先する。null で消すと全体の値に
// 戻り、全体の値を消すと manifest の値に戻る。タブが別の文書へ移ると、そのタブの値は消える。

/** RGBA（各 0〜255）。 */
export type ParadisActionColor = readonly [number, number, number, number];

/** ボタンの絵: manifest と同じ形（大きさ → 拡張機能の中のパス）か、ImageData から作った PNG の data URL。 */
export type ParadisActionIcon =
	| { readonly kind: 'path'; readonly paths: Readonly<Record<string, string>> }
	| { readonly kind: 'data'; readonly dataUrl: string };

/** あるタブで見えるボタンの状態。 */
export interface IParadisActionDetails {
	readonly title: string;
	/** 拡張機能の中のパス。'' なら押すと action.onClicked を出す。 */
	readonly popup: string;
	readonly badgeText: string;
	readonly badgeBackgroundColor: ParadisActionColor | null;
	readonly badgeTextColor: ParadisActionColor | null;
	readonly enabled: boolean;
	readonly icon: ParadisActionIcon | null;
}

type Overrides = { -readonly [Key in keyof IParadisActionDetails]?: IParadisActionDetails[Key] };

/** 拡張機能 1 つの、1 つのセッションでのボタンの状態。 */
export class ParadisBrowserExtensionActionState {

	private readonly _global: Overrides = {};
	private readonly _byTab = new Map<number, Overrides>();

	constructor(private readonly _defaults: IParadisActionDetails) { }

	get(tabId?: number): IParadisActionDetails {
		const tab = tabId === undefined ? undefined : this._byTab.get(tabId);
		return { ...this._defaults, ...this._global, ...tab };
	}

	/** null で消す: タブの値は全体の値へ、全体の値は manifest の値へ戻る。 */
	set<Key extends keyof IParadisActionDetails>(key: Key, value: IParadisActionDetails[Key] | null, tabId?: number): void {
		const target = tabId === undefined ? this._global : this._tabOverrides(tabId);
		if (value === null) {
			delete target[key];
		} else {
			target[key] = value;
		}
		if (tabId !== undefined && Object.keys(target).length === 0) {
			this._byTab.delete(tabId);
		}
	}

	/** タブの値を消す（別の文書へ移った・閉じた）。値があったかを返す（描き直すかの判断に使う）。 */
	forgetTab(tabId: number): boolean {
		return this._byTab.delete(tabId);
	}

	private _tabOverrides(tabId: number): Overrides {
		let overrides = this._byTab.get(tabId);
		if (!overrides) {
			overrides = {};
			this._byTab.set(tabId, overrides);
		}
		return overrides;
	}
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
	return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

/** manifest の書き方の絵（1 つのパスか、大きさ → パス）。 */
export function paradisActionIconFromPathSpec(spec: unknown): ParadisActionIcon | null {
	if (typeof spec === 'string' && spec.length > 0) {
		return { kind: 'path', paths: { '16': spec } };
	}
	const record = asRecord(spec);
	if (!record) {
		return null;
	}
	const paths = Object.fromEntries(Object.entries(record).filter((entry): entry is [string, string] => typeof entry[1] === 'string' && entry[1].length > 0));
	return Object.keys(paths).length > 0 ? { kind: 'path', paths } : null;
}

/** manifest の action（MV3）・browser_action（MV2）から決まる、初めの状態。 */
export function paradisReadManifestActionDefaults(manifest: Record<string, unknown> | undefined, extensionName: string): IParadisActionDetails {
	const action = asRecord(manifest?.action) ?? asRecord(manifest?.browser_action);
	const title = action?.default_title;
	const popup = action?.default_popup;
	return {
		title: typeof title === 'string' && title.length > 0 ? title : extensionName,
		popup: typeof popup === 'string' ? popup.replace(/^\/+/, '') : '',
		badgeText: '',
		badgeBackgroundColor: null,
		badgeTextColor: null,
		enabled: true,
		icon: paradisActionIconFromPathSpec(action?.default_icon) ?? paradisActionIconFromPathSpec(manifest?.icons),
	};
}

const HEX_COLOR = /^#(?<hex>[0-9a-f]{3,4}|[0-9a-f]{6}|[0-9a-f]{8})$/i;
const RGB_COLOR = /^rgba?\(\s*(?<red>[\d.]+)\s*,\s*(?<green>[\d.]+)\s*,\s*(?<blue>[\d.]+)\s*(?:,\s*(?<alpha>[\d.]+)\s*)?\)$/i;

function clampByte(value: number): number {
	return Math.max(0, Math.min(255, Math.round(value)));
}

/** chrome.action と同じく、ColorArray か、16 進・rgb()・rgba() の文字を受ける。読めなければ undefined。 */
export function paradisParseActionColor(input: unknown): ParadisActionColor | undefined {
	if (Array.isArray(input)) {
		if (input.length !== 4 || !input.every(part => typeof part === 'number' && Number.isFinite(part))) {
			return undefined;
		}
		const [red, green, blue, alpha] = input.map(clampByte);
		return [red, green, blue, alpha];
	}
	if (typeof input !== 'string') {
		return undefined;
	}
	const text = input.trim();
	const hex = HEX_COLOR.exec(text)?.groups?.hex;
	if (hex) {
		const full = hex.length <= 4 ? hex.split('').map(digit => digit + digit).join('') : hex;
		const parts = (full.match(/../g) ?? []).map(pair => Number.parseInt(pair, 16));
		return [parts[0], parts[1], parts[2], parts[3] ?? 255];
	}
	const rgb = RGB_COLOR.exec(text)?.groups;
	if (rgb) {
		const alpha = rgb.alpha === undefined ? 1 : Number(rgb.alpha);
		return [clampByte(Number(rgb.red)), clampByte(Number(rgb.green)), clampByte(Number(rgb.blue)), clampByte(alpha * 255)];
	}
	return undefined;
}

/** CSS の色（拡張機能が決めた色だけをバッジに塗る。決めていなければテーマの色）。 */
export function paradisActionColorToCss(color: ParadisActionColor | null): string | undefined {
	if (!color) {
		return undefined;
	}
	const [red, green, blue, alpha] = color;
	return `rgba(${red}, ${green}, ${blue}, ${Number((alpha / 255).toFixed(3))})`;
}

// --- ポップアップの位置 ---

/** 画面・ウィンドウの中の四角（ピクセル）。 */
export interface IParadisRect {
	readonly x: number;
	readonly y: number;
	readonly width: number;
	readonly height: number;
}

/** 大きさ。 */
export interface IParadisSize {
	readonly width: number;
	readonly height: number;
}

/** Chrome のポップアップの大きさの範囲。 */
export const PARADIS_ACTION_POPUP_MIN: IParadisSize = { width: 25, height: 25 };
export const PARADIS_ACTION_POPUP_MAX: IParadisSize = { width: 800, height: 600 };
const ANCHOR_GAP_PX = 2;

/** ページの大きさを Chrome の範囲に収める。 */
export function paradisClampActionPopupSize(size: IParadisSize): IParadisSize {
	const clamp = (value: number, min: number, max: number) => Math.round(Math.min(max, Math.max(min, Number.isFinite(value) ? value : min)));
	return {
		width: clamp(size.width, PARADIS_ACTION_POPUP_MIN.width, PARADIS_ACTION_POPUP_MAX.width),
		height: clamp(size.height, PARADIS_ACTION_POPUP_MIN.height, PARADIS_ACTION_POPUP_MAX.height),
	};
}

/** ウィンドウの中の CSS の四角（ボタンの位置）を、画面の座標にする（ウィンドウの中身の位置と拡大率から）。 */
export function paradisAnchorToScreen(anchor: IParadisRect, contentBounds: IParadisRect, zoomFactor: number): IParadisRect {
	return {
		x: Math.round(contentBounds.x + anchor.x * zoomFactor),
		y: Math.round(contentBounds.y + anchor.y * zoomFactor),
		width: Math.round(anchor.width * zoomFactor),
		height: Math.round(anchor.height * zoomFactor),
	};
}

/**
 * ボタンの下に、右端をそろえて置く（Chrome のツールバーの吹き出し）。作業領域からはみ出さないようにし、
 * 下に入らなければボタンの上に出す。
 */
export function paradisPlaceActionPopup(anchor: IParadisRect, size: IParadisSize, workArea: IParadisRect): IParadisRect {
	const workRight = workArea.x + workArea.width;
	const workBottom = workArea.y + workArea.height;
	const x = Math.max(workArea.x, Math.min(anchor.x + anchor.width - size.width, workRight - size.width));
	const below = anchor.y + anchor.height + ANCHOR_GAP_PX;
	const above = anchor.y - ANCHOR_GAP_PX - size.height;
	const y = below + size.height <= workBottom || above < workArea.y
		? Math.max(workArea.y, Math.min(below, workBottom - size.height))
		: above;
	return { x, y, width: size.width, height: size.height };
}

/** ボタンの位置として受け取ってよい四角か（renderer から来る値を確かめる）。 */
export function paradisIsAnchorRect(value: unknown): value is IParadisRect {
	const record = asRecord(value);
	return !!record && ['x', 'y', 'width', 'height'].every(key => typeof record[key] === 'number' && Number.isFinite(record[key] as number) && Math.abs(record[key] as number) < 100_000)
		&& (record.width as number) >= 0 && (record.height as number) >= 0;
}
