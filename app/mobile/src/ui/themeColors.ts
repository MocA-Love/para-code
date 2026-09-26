// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import { colorChoices, colors, status, withAlpha } from '../theme.js';

/**
 * 設定 → 色（利用者が場所ごとに「主役の色」を変える）の純粋な関数。保存と画面への配布は
 * `themeColorsStore.ts`、設定の画面は `app/settings/colors.tsx`。
 *
 * 変えられるのは次の3か所だけ。状態の色（要対応・実行中・未確認・待機・接続・メーター）、差分、
 * ブランドの色、端末の地、灰色の選択中（タブの下線・スイッチ・チップ）は変えない。
 *
 * | 場所 | 当たるもの |
 * |---|---|
 * | `primary` 主ボタン | 主ボタン・右下の＋・コミット・確認済みにする・メモのチェック・QR の四隅・承認の許可 |
 * | `bubble` 自分の発言と送信 | 会話の吹き出し・送信ボタン |
 * | `accent` 選択の印・リンク | チェック・選択中の回答・リンク・検索の一致・文字の選択色 |
 */

export type ThemeColorSlot = 'primary' | 'bubble' | 'accent';

export const THEME_COLOR_SLOTS: readonly ThemeColorSlot[] = ['primary', 'bubble', 'accent'];

/** 利用者が変えた色だけを持つ（無い場所は既定）。値は小文字の `#rrggbb`。 */
export type ThemeColorSettings = Readonly<Partial<Record<ThemeColorSlot, string>>>;

/** 既定の色（今の見た目と同じ）。 */
export const DEFAULT_THEME_COLORS: Readonly<Record<ThemeColorSlot, string>> = {
	primary: colors.primary,
	bubble: colors.text,
	accent: colors.accent,
};

/** 設定の行の名前と説明（モックの案1）。 */
export const THEME_COLOR_SLOT_LABELS: Readonly<Record<ThemeColorSlot, { readonly name: string; readonly description: string }>> = {
	primary: { name: '主ボタン', description: '起動・保存・コミット・右下の＋・許可' },
	bubble: { name: '自分の発言と送信', description: '会話の吹き出し・送信ボタン' },
	accent: { name: '選択の印・リンク', description: 'チェック・選択中の回答・リンク・検索の一致' },
};

/** 画面が使う色（場所ごとの色と、その上に載せる文字の色）。 */
export interface ThemeColors {
	/** 主ボタンの地。 */
	readonly primary: string;
	/** 主ボタンの上の文字・アイコン。 */
	readonly onPrimary: string;
	/** 主ボタンを押している間の地（右下の＋）。 */
	readonly primaryPressed: string;
	/** 自分の発言の吹き出し・送信ボタンの地。 */
	readonly bubble: string;
	/** 吹き出しの文字・送信ボタンの矢印。 */
	readonly onBubble: string;
	/** 選択の印・リンク・検索の一致の文字。 */
	readonly accent: string;
	/** accent で塗った面の上の文字。 */
	readonly onAccent: string;
	/** accent を薄く敷く地（選択中の選択肢・検索の一致など）。 */
	readonly accentWash: string;
}

/** accent を薄く敷くときの不透明度（theme の accentWash と同じ）。 */
const WASH_OPACITY = 0.12;
/** 押している間は、上の文字の色へこれだけ寄せる（既定の白 #f5f5f5 → 本文色 #e0e0e0 になる量）。 */
const PRESSED_MIX = 0.09;
/** 状態の色とこれより近い（RGB の距離）と、見分けにくいと警告する。 */
const STATUS_NEAR_DISTANCE = 70;
/** 画面の地とのコントラスト比がこれ未満だと、見えにくいと警告する。 */
const MIN_BACKGROUND_CONTRAST = 1.5;

/** 見分けられないと困る状態の色（モックの STATUS）。 */
const STATUS_COLORS: readonly { readonly name: string; readonly hex: string }[] = [
	{ name: `${status.attention.label}の赤`, hex: status.attention.color },
	{ name: `${status.running.label}の黄`, hex: status.running.color },
	{ name: `${status.review.label}の緑`, hex: status.review.color },
];

const HEX_PATTERN = /^#[0-9a-fA-F]{6}$/;

/** `#rrggbb` の形か。 */
export function isHexColor(value: string): boolean {
	return HEX_PATTERN.test(value);
}

/**
 * 入力欄の文字を色にする（`#` は省いてもよい。前後の空白は落とす）。色にならなければ undefined。
 * 返す値は小文字の `#rrggbb`。
 */
export function parseHexInput(text: string): string | undefined {
	const trimmed = text.trim();
	const withHash = trimmed.startsWith('#') ? trimmed : `#${trimmed}`;
	return isHexColor(withHash) ? withHash.toLowerCase() : undefined;
}

function channels(hex: string): readonly [number, number, number] {
	const value = hex.replace('#', '');
	return [
		parseInt(value.slice(0, 2), 16),
		parseInt(value.slice(2, 4), 16),
		parseInt(value.slice(4, 6), 16),
	];
}

function toHex(rgb: readonly [number, number, number]): string {
	return `#${rgb.map(c => Math.round(Math.min(255, Math.max(0, c))).toString(16).padStart(2, '0')).join('')}`;
}

/** WCAG の相対輝度（0〜1）。 */
export function relativeLuminance(hex: string): number {
	const [r, g, b] = channels(hex).map(c => {
		const x = c / 255;
		return x <= 0.03928 ? x / 12.92 : ((x + 0.055) / 1.055) ** 2.4;
	});
	return 0.2126 * (r ?? 0) + 0.7152 * (g ?? 0) + 0.0722 * (b ?? 0);
}

/** WCAG のコントラスト比（1〜21）。 */
export function contrastRatio(a: string, b: string): number {
	const la = relativeLuminance(a);
	const lb = relativeLuminance(b);
	const [hi, lo] = la >= lb ? [la, lb] : [lb, la];
	return (hi + 0.05) / (lo + 0.05);
}

/** 色の上に載せる文字の色（黒＝画面の地の色か白の、コントラストの高い方）。 */
export function textColorOn(hex: string): string {
	return contrastRatio(hex, colors.bg) >= contrastRatio(hex, colors.onDarkFill) ? colors.bg : colors.onDarkFill;
}

/** 上の文字が黒か白か（画面の説明用）。 */
export function textToneOn(hex: string): 'dark' | 'light' {
	return textColorOn(hex) === colors.bg ? 'dark' : 'light';
}

/** 2色を混ぜる（`amount` が 0 なら `from`、1 なら `to`）。 */
function mix(from: string, to: string, amount: number): string {
	const a = channels(from);
	const b = channels(to);
	return toHex([
		a[0] + (b[0] - a[0]) * amount,
		a[1] + (b[1] - a[1]) * amount,
		a[2] + (b[2] - a[2]) * amount,
	]);
}

/** 押している間の地（上の文字の色へ少し寄せる。明るい色は暗く、暗い色は明るくなる）。 */
export function pressedColorOf(hex: string): string {
	return mix(hex, textColorOn(hex), PRESSED_MIX);
}

/** テーマの色（検証済みの hex）に不透明度を足す。 */
export function tintOf(hex: string, opacity: number): string {
	return withAlpha(hex, opacity) ?? hex;
}

function distance(a: string, b: string): number {
	const p = channels(a);
	const q = channels(b);
	return Math.hypot(p[0] - q[0], p[1] - q[1], p[2] - q[2]);
}

/** 色を選んだときの注意（保存はできる）。無ければ空。 */
export function colorWarnings(hex: string): readonly string[] {
	const out: string[] = [];
	const near = STATUS_COLORS.find(s => distance(hex, s.hex) < STATUS_NEAR_DISTANCE);
	if (near !== undefined) {
		out.push(`${near.name}に近く、状態の色と見分けにくい`);
	}
	if (contrastRatio(hex, colors.bg) < MIN_BACKGROUND_CONTRAST) {
		out.push('画面の地とほとんど同じで、見えにくい');
	}
	return out;
}

/** 色の呼び名（候補の名前。候補に無ければ大文字の hex）。 */
export function colorName(hex: string): string {
	const lower = hex.toLowerCase();
	const choice = colorChoices.find(c => c.hex.toLowerCase() === lower);
	if (choice !== undefined) {
		return choice.name;
	}
	if (lower === colors.text.toLowerCase()) {
		return '白（本文色）';
	}
	return hex.toUpperCase();
}

/** その場所のいまの色。 */
export function themeColorOf(settings: ThemeColorSettings, slot: ThemeColorSlot): string {
	return settings[slot] ?? DEFAULT_THEME_COLORS[slot];
}

/** その場所が既定の色のままか。 */
export function isDefaultThemeColor(settings: ThemeColorSettings, slot: ThemeColorSlot): boolean {
	return themeColorOf(settings, slot).toLowerCase() === DEFAULT_THEME_COLORS[slot].toLowerCase();
}

/**
 * 場所の色を変えた設定。`hex` が undefined か既定と同じなら、その場所の保存を消す
 * （既定のままの場所は、以降の版で既定が変わればそれに付いていく）。色でない値は無視する。
 */
export function withThemeColor(settings: ThemeColorSettings, slot: ThemeColorSlot, hex: string | undefined): ThemeColorSettings {
	const parsed = hex === undefined ? undefined : parseHexInput(hex);
	if (hex !== undefined && parsed === undefined) {
		return settings;
	}
	const stored = parsed === undefined || parsed === DEFAULT_THEME_COLORS[slot].toLowerCase() ? undefined : parsed;
	if (stored === settings[slot]) {
		return settings;
	}
	const { [slot]: _removed, ...rest } = settings;
	return stored === undefined ? rest : { ...rest, [slot]: stored };
}

/** 画面が使う色へ展開する。既定の場所は theme の値そのもの（今の見た目と同じ）を返す。 */
export function resolveThemeColors(settings: ThemeColorSettings): ThemeColors {
	const primary = themeColorOf(settings, 'primary');
	const bubble = themeColorOf(settings, 'bubble');
	const accent = themeColorOf(settings, 'accent');
	return {
		primary,
		onPrimary: textColorOn(primary),
		primaryPressed: pressedColorOf(primary),
		bubble,
		onBubble: textColorOn(bubble),
		accent,
		onAccent: textColorOn(accent),
		accentWash: settings.accent === undefined ? colors.accentWash : tintOf(accent, WASH_OPACITY),
	};
}

/** 保存する形（変えた場所だけの JSON）。 */
export function serializeThemeColorSettings(settings: ThemeColorSettings): string {
	return JSON.stringify(settings);
}

/**
 * 保存されていたものを設定に戻す。保存が無い・壊れているときは undefined（使う側で既定に倒す）。
 * 知らない場所・色でない値は落とす（別の版で保存したものでも画面を壊さない）。
 */
export function parseThemeColorSettings(raw: string | null): ThemeColorSettings | undefined {
	if (raw === null) {
		return undefined;
	}
	let value: unknown;
	try {
		value = JSON.parse(raw);
	} catch {
		return undefined;
	}
	if (typeof value !== 'object' || value === null || Array.isArray(value)) {
		return undefined;
	}
	const stored = new Map<string, unknown>(Object.entries(value));
	let settings: ThemeColorSettings = {};
	for (const slot of THEME_COLOR_SLOTS) {
		const item = stored.get(slot);
		if (typeof item === 'string' && isHexColor(item)) {
			settings = withThemeColor(settings, slot, item);
		}
	}
	return settings;
}
