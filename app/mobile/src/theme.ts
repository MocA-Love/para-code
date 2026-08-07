// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

/** モックアップ (mock-2.html、案A「Aftermath」) のデザイントークン。全画面で共有する。 */
export const colors = {
	bg: '#050506',
	panel: '#131316',
	surface: '#131316',
	surface2: '#1c1c20',
	surface3: '#232328',
	border: 'rgba(255,255,255,0.08)',
	borderStrong: 'rgba(255,255,255,0.16)',
	text: '#f0f0f2',
	textDim: '#8a8a92',
	// PC版のブランドプライマリカラー（paradisDefaultSettings.contribution.ts の #09AFD9）と統一。
	// accent2 はPC版ライトテーマ用の濃い版 #0598BD をボタン等の面塗りに流用する。
	accent: '#09AFD9',
	accent2: '#0598BD',
	accentWash: 'rgba(9,175,217,0.14)',
	green: '#4fd1a5',
	yellow: '#e0c07d',
	orange: '#d99a6c',
	red: '#f47272',
	purple: '#c193d9',
	mod: '#e0c07d',
	add: '#4fd1a5',
	del: '#f47272',
	claude: '#d97757',
	glassBg: 'rgba(28,28,32,0.6)',
	glassBorder: 'rgba(255,255,255,0.14)',
	attentionBg: 'rgba(36,20,20,0.92)',
} as const;

export const mono = { ios: 'Menlo', default: 'monospace' } as const;

/**
 * 角丸のランプ。役割ごとに1つの値を決めておき、画面ごとに数字を発明しない。
 *
 * 入れ子にするときは同心円則（外側の半径 − 余白 ＝ 内側の半径）で内側を決める。
 * 例: card(14) の中に padding 4 で入るチップなら 10（= control）。
 */
export const radius = {
	/** 丸ピル（チップ・バッジ・丸ボタン）。 */
	pill: 999,
	/** 小さな操作要素（入力欄・セグメント・コード枠）。 */
	control: 10,
	/** 一覧の行・カード。 */
	card: 14,
	/** カードを束ねる面・ポップオーバー。 */
	panel: 20,
	/** コンポーザー（入力バー）。 */
	composer: 26,
	/** ボトムシートの上端。 */
	sheet: 28,
} as const;

/**
 * iOSの連続曲率（squircle）。iOS 26のガラス面とシステム部品は全てこれで描かれるため、
 * 角丸を指定するスタイルには必ず併せて当てる（単純な円弧だと曲がり始めが食い違い、
 * 純正部品と並べたときに「別のOSの部品」に見える）。
 */
export const squircle = { borderCurve: 'continuous' } as const;

/**
 * 色に不透明度を足して `#RRGGBBAA` にする。
 *
 * 呼び出し側で `color + '33'` のように桁を連結すると、二重に足されたときに
 * `#RRGGBBAAAA` という無効色になる（RNの正規化は null を返し、警告も出ないまま
 * `StyleSheet.flatten` の後勝ちで下地ごと消える）。不透明度は必ずこの関数を通すこと。
 *
 * hex以外（`rgba()`・色名など）に不透明度は足しようがないので `undefined` を返す。
 * ワークスペース色はPCから任意の文字列で届くため、ここで不透明のまま通すと
 * 意図せず全面がその色に染まる。
 */
export function withAlpha(color: string, opacity: number): string | undefined {
	if (opacity >= 1) {
		return color;
	}
	const expanded = /^#[0-9a-fA-F]{3}$/.test(color)
		? `#${color[1]}${color[1]}${color[2]}${color[2]}${color[3]}${color[3]}`
		: color;
	if (!/^#[0-9a-fA-F]{6}$/.test(expanded)) {
		return undefined;
	}
	const alpha = Math.round(Math.max(0, opacity) * 255);
	return expanded + alpha.toString(16).padStart(2, '0');
}
