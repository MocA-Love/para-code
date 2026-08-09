// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

/**
 * ヘッダーのスロット（島・ピル・丸ボタン）の器を、モーフの進捗から何ptに収めるか。
 *
 * 器の幅は**下限と上限で挟んで**決める。こうすると「これから出る中身の自然な幅」を測らずに
 * 縮む動きも太る動きも同じ式で書ける（測るのは「いま出ている幅」だけでよい）。
 *  - 進捗0: 下限＝上限＝いまの幅 → **いまの見た目に固定**
 *  - 進捗1: 制約なし → 中身なりの幅に落ち着く
 *
 * **ここを純粋な関数として切り出してあるのは、静止時に器を消してしまう間違いを二度と
 * 通さないため。** 実際に一度やっている（2026-08-09）: 「消えるスロットは0へ縮める」枝を
 * 上限0で判定したところ、上限の初期値も0だったため**静止時に全スロットの幅が0になり、
 * ヘッダーがまるごと見えなくなった**。静止と「消える」は別の状態なので、
 * {@link PARA_HEADER_NO_CAP} という別の値で区別する。
 */

/** 上限を課さない（静止している／モーフの対象外）。 */
export const PARA_HEADER_NO_CAP = -1;

/** 器に当てる幅の制約。`maxWidth` が `undefined` なら中身なりに広がってよい。 */
export interface ParaHeaderBounds {
	readonly minWidth: number;
	readonly maxWidth: number | undefined;
}

/**
 * @param progress 0 = 旧の見た目、1 = 新の見た目（静止時は必ず1）
 * @param fromWidth モーフを始めたときの実測幅（pt）
 * @param capWidth 新しい仕様でのこのスロットの上限（pt）。
 *   {@link PARA_HEADER_NO_CAP} なら制約なし、`0` なら**このスロットは無くなる**。
 */
export function paraHeaderBoundsFor(progress: number, fromWidth: number, capWidth: number): ParaHeaderBounds {
	'worklet';
	// 静止・モーフ対象外。器は中身なりの幅で出す。**いちばん多く通る枝なので先頭に置く。**
	if (capWidth < 0) {
		return { minWidth: 0, maxWidth: undefined };
	}
	// 無くなるスロットは0へ縮めて**そのまま0で留める**。ここで制約を外すと、着地した瞬間に
	// 器が中身なりの幅へ跳ね返って一瞬出てしまう。
	if (capWidth === 0) {
		return { minWidth: 0, maxWidth: Math.max(0, fromWidth * (1 - progress)) };
	}
	if (progress >= 1) {
		return { minWidth: 0, maxWidth: undefined };
	}
	return {
		minWidth: fromWidth * (1 - progress),
		maxWidth: fromWidth + (capWidth - fromWidth) * progress,
	};
}
