// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import type { KeyStore } from './store.js';

/**
 * 会話表示（エージェントのタブのチャット）の文字サイズ（設定 → チャット UI →「文字サイズ」）。
 * 計算と保存の形だけを持つ純関数（`chatTextScale.test.ts` で固定）。画面への配り方は
 * `src/ui/chatTextScale.tsx`、選ぶシートは `src/features/settings/chatFontSizeDrawer.tsx`。
 *
 * 値は2種類:
 *  - `'system'`（既定）: OS の文字サイズ（Dynamic Type）にそのまま従う。この設定が入る前と同じ表示
 *  - 百分率（85〜150）: 会話の文字を標準の大きさのこの割合で描く。OS の文字サイズは**かけない**
 *
 * React Native の `Text` / `TextInput` は既定で `allowFontScaling` が有効で、`fontSize` と `lineHeight` に
 * OS の倍率（`useWindowDimensions().fontScale`）を後からかける。百分率を選んだときにそのまま割合をかけると
 * OS の倍率と二重にかかるので、この2つは「割合 ÷ OS の倍率」でかけておき、OS がかけ戻した結果がちょうど
 * 割合になるようにする（`font`）。`letterSpacing`（iOS は OS の倍率をかけない。RN の
 * `RCTAttributedTextUtils.mm`）・アイコン・余白は OS の倍率がかからないので、割合をそのままかける（`layout`）。
 *
 * 会話の部品では `maxFontSizeMultiplier` を使わないこと。OS の倍率に上限がかかると、ここで割り戻した
 * 値と実際にかかる倍率がずれ、選んだ割合より小さく描かれる。
 *
 * この端末の中だけの設定で、PC やスペースごとには持たない（ターミナルの文字サイズと同じ）。
 */
export type ChatFontSize = 'system' | number;

/** シートに並べる割合（%）。100 を挟んで小さい側を細かく、大きい側を粗く刻む。 */
export const CHAT_FONT_SCALE_STEPS: readonly number[] = [85, 90, 100, 110, 120, 135, 150];
export const CHAT_FONT_SCALE_MIN = 85;
export const CHAT_FONT_SCALE_MAX = 150;

export const DEFAULT_CHAT_FONT_SIZE: ChatFontSize = 'system';

/** 保存先のキー（`secureKeyStore`。ほかの端末ローカルの設定と同じ）。 */
export const CHAT_FONT_SIZE_KEY = 'chatFontSize';

/**
 * 保存値や外から来た値を、使える値に直す。
 *  - `'system'` はそのまま
 *  - 数（数字の文字列を含む）は 85〜150 に収めてから、いちばん近い刻みに寄せる（古い版や手で
 *    入れた半端な値でも、シートのどれか1つに印が付くように）
 *  - それ以外（壊れた値・空）は既定
 */
export function normalizeChatFontSize(stored: unknown): ChatFontSize {
	if (stored === 'system') {
		return 'system';
	}
	const value = typeof stored === 'number'
		? stored
		: typeof stored === 'string' && stored.trim().length > 0 ? Number(stored) : Number.NaN;
	if (!Number.isFinite(value)) {
		return DEFAULT_CHAT_FONT_SIZE;
	}
	const clamped = Math.min(CHAT_FONT_SCALE_MAX, Math.max(CHAT_FONT_SCALE_MIN, value));
	let nearest = CHAT_FONT_SCALE_STEPS[0] ?? CHAT_FONT_SCALE_MIN;
	for (const step of CHAT_FONT_SCALE_STEPS) {
		if (Math.abs(step - clamped) < Math.abs(nearest - clamped)) {
			nearest = step;
		}
	}
	return nearest;
}

/** 設定の行・シートに出す呼び名。 */
export function chatFontSizeLabel(size: ChatFontSize): string {
	return size === 'system' ? 'OS に合わせる' : `${size}%`;
}

/** 保存する文字列（`'system'` か割合の数字）。 */
export function serializeChatFontSize(size: ChatFontSize): string {
	return size === 'system' ? 'system' : String(normalizeChatFontSize(size));
}

/** 保存した値を読む。無い・壊れている場合は既定。読めない（Keychain がロック中など）ときは reject。 */
export async function loadChatFontSize(store: Pick<KeyStore, 'getItem'>): Promise<ChatFontSize> {
	const raw = await store.getItem(CHAT_FONT_SIZE_KEY);
	return raw === null ? DEFAULT_CHAT_FONT_SIZE : normalizeChatFontSize(raw);
}

/** 保存する。既定（OS に合わせる）に戻したときは項目ごと消す。 */
export function saveChatFontSize(store: Pick<KeyStore, 'setItem' | 'deleteItem'>, size: ChatFontSize): Promise<void> {
	const normalized = normalizeChatFontSize(size);
	return normalized === DEFAULT_CHAT_FONT_SIZE
		? store.deleteItem(CHAT_FONT_SIZE_KEY)
		: store.setItem(CHAT_FONT_SIZE_KEY, serializeChatFontSize(normalized));
}

/** 会話の部品にかける倍率。 */
export interface ChatTextScale {
	/** `fontSize`・`lineHeight` にかける倍率（OS の倍率で割り戻し済み）。 */
	readonly font: number;
	/** `letterSpacing`・アイコン・余白にかける倍率（見た目の割合そのもの）。 */
	readonly layout: number;
}

/** 何も変えない倍率（OS に合わせる、または 100% で OS も標準のとき）。 */
export const NEUTRAL_CHAT_TEXT_SCALE: ChatTextScale = { font: 1, layout: 1 };

/**
 * 設定と OS の文字の倍率から、会話の部品にかける倍率を決める。
 * `osFontScale` は `useWindowDimensions().fontScale`（取れない・0 以下なら 1 とみなす）。
 */
export function chatTextScaleFor(size: ChatFontSize, osFontScale: number): ChatTextScale {
	const normalized = normalizeChatFontSize(size);
	if (normalized === 'system') {
		return NEUTRAL_CHAT_TEXT_SCALE;
	}
	const layout = normalized / 100;
	const os = Number.isFinite(osFontScale) && osFontScale > 0 ? osFontScale : 1;
	if (layout === 1 && os === 1) {
		return NEUTRAL_CHAT_TEXT_SCALE;
	}
	return { font: layout / os, layout };
}

export function isNeutralChatTextScale(scale: ChatTextScale): boolean {
	return scale.font === 1 && scale.layout === 1;
}

/** 文字の値のうち、OS が後で倍率をかけるもの。 */
const FONT_KEYS: ReadonlySet<string> = new Set(['fontSize', 'lineHeight']);
/** 文字の値のうち、OS が倍率をかけないもの（割合をそのままかける）。 */
const LAYOUT_KEYS: ReadonlySet<string> = new Set(['letterSpacing']);
/**
 * 縦の余白（と、四方まとめた `padding`）。割合の半分だけ広げる・狭める（150% で 125%）。文字ほど広げると
 * 行と行の間が間延びし、縮めると押せる部品が窮屈になるため。横だけの余白は列の幅を食うので変えない。
 */
const SPACING_KEYS: ReadonlySet<string> = new Set(['padding', 'paddingVertical', 'paddingTop', 'paddingBottom', 'marginTop', 'marginBottom', 'marginVertical', 'gap', 'rowGap']);

/** `steps` 分の 1 単位に丸める（100 なら 0.01 単位、2 なら 0.5 単位）。 */
function round(value: number, steps: number): number {
	return Math.round(value * steps) / steps;
}

/**
 * スタイル1つに倍率をかけた写しを作る。数でない値（色・`'auto'` など）と、上の一覧に無いキー
 * （幅・横の余白・角丸・固定の `width`/`height` など）は変えない。`minHeight` も変えない（文字が大きくなれば
 * 中身に合わせて自然に伸び、小さくしたときに押せる大きさ 44pt を割らないため）。`maxHeight` も変えない
 * （入力欄や出力の枠の上限を広げると、小さい iPhone でキーボードを出したときに会話が見えなくなるため）。
 * 固定の大きさのアイコンの台は、部品の側で `scaleChatSize` をかける。
 */
export function scaleChatStyle<S extends object>(style: S, scale: ChatTextScale): S {
	if (isNeutralChatTextScale(scale)) {
		return style;
	}
	const spacing = 1 + (scale.layout - 1) / 2;
	const out: Record<string, unknown> = {};
	for (const [key, value] of Object.entries(style)) {
		if (typeof value !== 'number') {
			out[key] = value;
		} else if (FONT_KEYS.has(key)) {
			out[key] = round(value * scale.font, 100);
		} else if (SPACING_KEYS.has(key)) {
			out[key] = round(value * spacing, 2);
		} else if (LAYOUT_KEYS.has(key)) {
			out[key] = round(value * scale.layout, 100);
		} else {
			out[key] = value;
		}
	}
	return out as S;
}

const sheetCache = new WeakMap<object, Map<string, object>>();

/**
 * `StyleSheet.create` の結果全体に倍率をかける。同じ表と倍率の組は1度だけ作って使い回す
 * （会話の行が何百あっても作り直さない）。倍率が無変化なら元の表をそのまま返す。
 */
export function scaleChatStyles<T extends { readonly [key: string]: object }>(styles: T, scale: ChatTextScale): T {
	if (isNeutralChatTextScale(scale)) {
		return styles;
	}
	const cacheKey = `${scale.font}|${scale.layout}`;
	let byScale = sheetCache.get(styles);
	const cached = byScale?.get(cacheKey);
	if (cached !== undefined) {
		return cached as T;
	}
	const out: Record<string, object> = {};
	for (const [name, style] of Object.entries(styles)) {
		out[name] = scaleChatStyle(style, scale);
	}
	if (byScale === undefined) {
		byScale = new Map();
		sheetCache.set(styles, byScale);
	}
	byScale.set(cacheKey, out);
	return out as T;
}

/** アイコンなど、文字の横に置く固定の大きさ（OS の倍率はかからないので割合をそのままかける）。 */
export function scaleChatSize(value: number, scale: ChatTextScale): number {
	return scale.layout === 1 ? value : Math.round(value * scale.layout);
}
