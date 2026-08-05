// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

/**
 * iPadの2カラムレイアウトの寸法。実機を起動せずに詰められるよう、幅の計算だけを
 * ここに純関数として切り出している。
 */

/** サイドバーの下限・上限（pt）。ワークスペース名とブランチ名が読める幅を下限にしている。 */
const SIDEBAR_MIN = 280;
const SIDEBAR_MAX = 340;

/** ウィンドウ幅に対するサイドバーの比率（iPad Pro 11のportrait 834ptでおよそ272→下限の280に丸まる）。 */
const SIDEBAR_RATIO = 0.28;

/**
 * サイドバー幅。狭いiPadでは本文が潰れないよう下限で止め、広いiPadでは
 * 間延びしないよう上限で止める。
 */
export function sidebarWidthFor(windowWidth: number): number {
	return Math.round(Math.min(SIDEBAR_MAX, Math.max(SIDEBAR_MIN, windowWidth * SIDEBAR_RATIO)));
}

/**
 * 本文（チャット・記事的なコンテンツ）の最大読み幅。広いiPadで1行が長くなりすぎると
 * 目線の戻りが大きく読みづらいため、中央寄せで列幅を制限する。
 * ターミナルやdiffなど「広いほど良い」ものには適用しない。
 */
export const CONTENT_MAX_WIDTH = 760;

/**
 * 一覧を何列で並べるか。行の情報量が多い（タイトル＋スペース＋ブランチ＋状態）ため、
 * 1列あたり最低でもこの幅を確保できるときだけ2列にする。
 */
const MIN_COLUMN_WIDTH = 420;

export function listColumnsFor(contentWidth: number): 1 | 2 {
	return contentWidth >= MIN_COLUMN_WIDTH * 2 ? 2 : 1;
}
