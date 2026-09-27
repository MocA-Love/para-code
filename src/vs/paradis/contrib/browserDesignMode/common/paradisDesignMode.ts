/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

// 内蔵ブラウザの Design Mode（B1）と Markup（B2）が main / renderer で共有する型と、
// ページから届いた値の検証。
//
// 要素の情報の集め方・予算・秘密値の伏せ方は Orca（stablyai/orca、MIT License、
// Copyright (c) 2026 Lovecast Inc.）の src/shared/browser-grab-types.ts と
// src/main/browser/browser-grab-payload.ts を元にしている。Orca はページの main world で
// 動かしていたが、Para Code では isolated world で動かす（paradisDesignModePageScript.ts）。

import { VSBuffer } from '../../../../base/common/buffer.js';

/** main プロセスの窓口（app.ts で登録する）。 */
export const PARADIS_DESIGN_MODE_CHANNEL = 'paradisDesignMode';

/**
 * 要素選択の仕掛けを動かす isolated world の ID。
 *
 * 0 はページの main world、999 は upstream の preload（browserViewAPI）と fork のエージェント
 * カーソル演出が使う world。ページからも preload からも見えない専用の world にするため、
 * どちらとも違う値にする（Electron が受け付けるのは 1〜536870911）。
 */
export const PARADIS_DESIGN_MODE_WORLD_ID = 20731;

/** ページから受け取る値の上限（Orca の GRAB_BUDGET と同じ値）。 */
export const PARADIS_DESIGN_BUDGET = {
	textSnippetMaxLength: 200,
	nearbyTextEntryMaxLength: 200,
	nearbyTextMaxEntries: 6,
	htmlSnippetMaxLength: 4096,
	selectorMaxLength: 700,
	pathMaxLength: 900,
	commentMaxLength: 2000,
	annotationsMaxPerPage: 20,
	/** 保存する PNG の上限。これを超える画像は保存しない。 */
	imageMaxBytes: 20 * 1024 * 1024,
} as const;

/** 伏せ字にする値の手がかり（Orca の GRAB_SECRET_PATTERNS と同じ）。 */
export const PARADIS_DESIGN_SECRET_PATTERNS: readonly string[] = [
	'access_token',
	'auth_token',
	'api_key',
	'apikey',
	'client_secret',
	'oauth_state',
	'x-amz-',
	'session_id',
	'sessionid',
	'csrf',
	'secret',
	'password',
	'passwd',
];

/**
 * 渡してよい属性名。画面に出ない文字（title・alt・aria-*）はページが見えない指示を置ける
 * 場所なので渡さない（ページ側の仕掛けと同じ規則を main でも守る）。
 */
const SAFE_ATTRIBUTE_NAMES = new Set(['id', 'class', 'name', 'type', 'role', 'href', 'src', 'placeholder', 'for', 'action', 'method']);

/** 取り出す計算済みスタイル。 */
export const PARADIS_DESIGN_STYLE_PROPERTIES = [
	'display', 'position', 'width', 'height', 'margin', 'padding', 'color', 'background-color',
	'border', 'border-radius', 'font-family', 'font-size', 'font-weight', 'line-height', 'text-align', 'z-index',
] as const;

export interface IParadisDesignRect {
	readonly x: number;
	readonly y: number;
	readonly width: number;
	readonly height: number;
}

/** ページで選ばれた要素の情報。すべてページが書き換えられる値なので、指示として扱わないこと。 */
export interface IParadisPickedElement {
	/** クエリとフラグメントを落とした URL。 */
	readonly url: string;
	readonly title: string;
	readonly viewportWidth: number;
	readonly viewportHeight: number;
	readonly tagName: string;
	/** ページ内で一意になるよう組んだ CSS セレクタ。 */
	readonly selector: string;
	/** 人が読むための短い位置（id / role / クラスで組む）。 */
	readonly path: string;
	readonly textSnippet: string;
	readonly htmlSnippet: string;
	readonly accessibleName: string;
	readonly attributes: Readonly<Record<string, string>>;
	readonly styles: Readonly<Record<string, string>>;
	readonly nearbyText: readonly string[];
	/** ビューポート基準（CSS px）。スクリーンショットの切り抜きに使う。 */
	readonly rectViewport: IParadisDesignRect;
	/** 文書基準（CSS px）。ページ上の番号札を置き直すのに使う。 */
	readonly rectPage: IParadisDesignRect;
}

export type ParadisDesignPickResult =
	| { readonly kind: 'picked'; readonly element: IParadisPickedElement }
	| { readonly kind: 'cancelled' };

/** ページ上に出す番号札。 */
export interface IParadisDesignPin {
	readonly label: string;
	readonly selector: string;
	readonly rectPage: IParadisDesignRect;
}

/** main プロセス側の窓口。renderer からは ProxyChannel で呼ぶ。 */
export interface IParadisDesignModeMainService {
	/**
	 * ページに要素選択の仕掛けを入れ直し（番号札も `pins` で置き直す）、ユーザーがクリック
	 * するまで待つ。Esc・{@link cancelPick}・ページ遷移で `cancelled` を返す。
	 */
	pickElement(viewId: string, pins: readonly IParadisDesignPin[]): Promise<ParadisDesignPickResult>;
	cancelPick(viewId: string): Promise<void>;
	/** 番号札を置き直す（空配列で消す）。 */
	setPins(viewId: string, pins: readonly IParadisDesignPin[]): Promise<void>;
	/** PNG を userData 配下（所有者だけが読める場所）へ保存し、絶対パスを返す。 */
	saveImage(png: VSBuffer): Promise<string>;
	/**
	 * このウィンドウが前に始めたまま終わっていない選択を取り消す。renderer の起動時に呼ぶ
	 * （選択中にウィンドウを再読み込みすると、ページに十字カーソルの覆いが残るため）。
	 */
	resetPicks(): Promise<void>;
}

function clampString(value: unknown, max: number): string {
	const text = typeof value === 'string' ? value : '';
	return text.length <= max ? text : `${text.slice(0, max)} (truncated)`;
}

function finiteNumber(value: unknown): number {
	return typeof value === 'number' && Number.isFinite(value) ? value : 0;
}

/** 値に秘密らしい手がかりが含まれるか。 */
export function paradisDesignContainsSecret(value: string): boolean {
	const lower = value.toLowerCase();
	return PARADIS_DESIGN_SECRET_PATTERNS.some(pattern => lower.includes(pattern));
}

/**
 * URL からクエリとフラグメントを落とす。http(s) / file 以外（javascript: 等）は空にする。
 * 解析できない値をそのまま返すと javascript: などが残るので、空へ倒す。
 */
export function paradisDesignSanitizeUrl(value: unknown): string {
	if (typeof value !== 'string' || !value) {
		return '';
	}
	try {
		const url = new URL(value);
		if (url.protocol === 'about:') {
			return url.href === 'about:blank' ? 'about:blank' : '';
		}
		if (url.protocol !== 'http:' && url.protocol !== 'https:' && url.protocol !== 'file:') {
			return '';
		}
		url.search = '';
		url.hash = '';
		return url.href;
	} catch {
		return '';
	}
}

function clampRect(value: unknown): IParadisDesignRect {
	const rect = (value && typeof value === 'object' ? value : {}) as Record<string, unknown>;
	return {
		x: finiteNumber(rect.x),
		y: finiteNumber(rect.y),
		width: Math.max(0, finiteNumber(rect.width)),
		height: Math.max(0, finiteNumber(rect.height)),
	};
}

function secretSafe(value: string): string {
	return value && paradisDesignContainsSecret(value) ? '[redacted]' : value;
}

/**
 * ページから返ってきた値を検証して上限に収める。形が合わなければ undefined。
 *
 * isolated world はページの JS からは触れないが、DOM はページのものなので、要素の中身・属性・
 * テキストはすべてページが決められる。ページ側の script に何か仕込まれても、ここを通った値は
 * 上限と伏せ字の規則を守る（Orca の clampGrabPayload と同じ考え方の二重の守り）。
 */
export function paradisClampPickedElement(raw: unknown): IParadisPickedElement | undefined {
	if (!raw || typeof raw !== 'object') {
		return undefined;
	}
	const value = raw as Record<string, unknown>;
	if (typeof value.tagName !== 'string' || typeof value.selector !== 'string') {
		return undefined;
	}
	const attributes: Record<string, string> = {};
	if (value.attributes && typeof value.attributes === 'object') {
		for (const [key, attribute] of Object.entries(value.attributes as Record<string, unknown>).slice(0, 40)) {
			const name = key.toLowerCase();
			if (!SAFE_ATTRIBUTE_NAMES.has(name)) {
				continue;
			}
			const text = clampString(attribute, 500);
			if (paradisDesignContainsSecret(text)) {
				attributes[name] = '[redacted]';
			} else if (name === 'href' || name === 'src' || name === 'action') {
				attributes[name] = paradisDesignSanitizeUrl(text);
			} else if (name === 'id' && !/^[A-Za-z][A-Za-z0-9_:.-]{0,39}$/.test(text)) {
				// 識別子らしくない id（文章を詰め込んだもの）は渡さない
				continue;
			} else {
				attributes[name] = text;
			}
		}
	}
	const styles: Record<string, string> = {};
	if (value.styles && typeof value.styles === 'object') {
		const rawStyles = value.styles as Record<string, unknown>;
		for (const property of PARADIS_DESIGN_STYLE_PROPERTIES) {
			const style = clampString(rawStyles[property], 300);
			if (style) {
				styles[property] = style;
			}
		}
	}
	const nearbyText = Array.isArray(value.nearbyText)
		? value.nearbyText.slice(0, PARADIS_DESIGN_BUDGET.nearbyTextMaxEntries)
			.map(entry => secretSafe(clampString(entry, PARADIS_DESIGN_BUDGET.nearbyTextEntryMaxLength)))
			.filter(entry => entry.length > 0)
		: [];
	return {
		url: paradisDesignSanitizeUrl(value.url),
		title: clampString(value.title, 300),
		viewportWidth: Math.max(0, finiteNumber(value.viewportWidth)),
		viewportHeight: Math.max(0, finiteNumber(value.viewportHeight)),
		// タグ名は見出しに出すので、英数字とハイフン以外（カスタム要素名に紛れた文）は捨てる
		tagName: /^[a-z][a-z0-9-]{0,49}$/.test(String(value.tagName).toLowerCase()) ? String(value.tagName).toLowerCase() : 'element',
		selector: clampString(value.selector, PARADIS_DESIGN_BUDGET.selectorMaxLength),
		path: secretSafe(clampString(value.path, PARADIS_DESIGN_BUDGET.pathMaxLength)),
		textSnippet: secretSafe(clampString(value.textSnippet, PARADIS_DESIGN_BUDGET.textSnippetMaxLength)),
		htmlSnippet: clampString(value.htmlSnippet, PARADIS_DESIGN_BUDGET.htmlSnippetMaxLength),
		accessibleName: secretSafe(clampString(value.accessibleName, 300)),
		attributes,
		styles,
		nearbyText,
		rectViewport: clampRect(value.rectViewport),
		rectPage: clampRect(value.rectPage),
	};
}

/**
 * スクリーンショットの切り抜き範囲をビューポートの内側へ収める。はみ出しを含めて撮ろうとすると
 * upstream の撮影は失敗するか、ビューポートの外を黒く写す。何も残らなければ undefined。
 */
export function paradisClipRectToViewport(rect: IParadisDesignRect, viewportWidth: number, viewportHeight: number, padding = 4): IParadisDesignRect | undefined {
	const left = Math.max(0, Math.floor(rect.x - padding));
	const top = Math.max(0, Math.floor(rect.y - padding));
	const right = Math.min(viewportWidth, Math.ceil(rect.x + rect.width + padding));
	const bottom = Math.min(viewportHeight, Math.ceil(rect.y + rect.height + padding));
	if (right - left < 2 || bottom - top < 2) {
		return undefined;
	}
	return { x: left, y: top, width: right - left, height: bottom - top };
}

const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

/** 先頭 8 バイトが PNG の署名か。保存する前に main 側で確かめる。 */
export function paradisIsPng(bytes: Uint8Array): boolean {
	if (bytes.length < PNG_SIGNATURE.length) {
		return false;
	}
	return PNG_SIGNATURE.every((byte, index) => bytes[index] === byte);
}
