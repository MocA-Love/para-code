// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

/**
 * 読み上げの使用量の棒グラフ（`voiceUsageChart.tsx`）の指の動きの判定。画面から切り離した純関数
 * （`voiceChartGesture.test.ts`）。
 *
 * 触れただけでは何も選ばない（縦のスクロールの始まりかもしれないため）。横の動きが縦より勝ったら「なぞり」として
 * 選び始め、ほとんど動かずに離したら「タップ」としてその棒を選ぶ。
 */

/** なぞりと見なす横の移動（pt）。 */
export const VOICE_CHART_SCRUB_SLOP = 8;
/** タップと見なす移動の上限（pt）。 */
export const VOICE_CHART_TAP_SLOP = 6;

/** 横の位置（グラフの左端からの距離）から、何本目の棒かを決める。 */
export function barIndexAt(x: number, width: number, count: number): number | undefined {
	if (count <= 0 || width <= 0 || !Number.isFinite(x)) {
		return undefined;
	}
	return Math.max(0, Math.min(count - 1, Math.floor((x / width) * count)));
}

/** 横の動きが縦より勝った（なぞり始めてよい）。 */
export function isHorizontalScrub(dx: number, dy: number): boolean {
	return Math.abs(dx) >= VOICE_CHART_SCRUB_SLOP && Math.abs(dx) > Math.abs(dy);
}

/** ほとんど動かずに離した（タップ）。 */
export function isTap(dx: number, dy: number): boolean {
	return Math.abs(dx) <= VOICE_CHART_TAP_SLOP && Math.abs(dy) <= VOICE_CHART_TAP_SLOP;
}
