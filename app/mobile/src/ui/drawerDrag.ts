// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

/**
 * 下から出るシート（`BottomDrawer`）を指で引いたときの判定。画面に依存しない純粋な関数だけを置き、
 * 「どれだけ動かすか」「離したら閉じるか」をテストで固定する。
 */

/** ここまで引き下げたら閉じる（pt）。 */
export const DISMISS_DISTANCE = 80;
/** 下向きの速さ（pt/ms）がこれを超えていれば、距離が足りなくても閉じる。 */
export const DISMISS_VELOCITY = 0.5;
/** 上へ引いたときは付いてこさせず、この割合だけ動かす（それ以上は広がらない合図）。 */
export const RUBBER_BAND = 0.25;
/** シートの高さを測る前に、幕が消えきるまでの距離として使う値（pt）。 */
export const FALLBACK_FADE_DISTANCE = 300;
/** 幕が消えきるまでの距離の下限（pt）。低いシートで少し引いただけで幕が消えないように。 */
export const MIN_FADE_DISTANCE = 120;

/** 指の縦の移動量（下が正）から、シートを下げる量を返す。下へは 1:1、上へはゴムのように少しだけ。 */
export function dragOffset(dy: number): number {
	return dy >= 0 ? dy : dy * RUBBER_BAND;
}

/** 離したときに閉じるか。一定距離を超えたか、下向きに速く払ったとき。 */
export function shouldDismissDrag(dy: number, vy: number): boolean {
	if (dy > DISMISS_DISTANCE) {
		return true;
	}
	return dy > 0 && vy > DISMISS_VELOCITY;
}

/** 幕が消えきるまでの引き下げ量（pt）。シートの高さぶん下げたら幕が無くなる。 */
export function backdropFadeDistance(sheetHeight: number): number {
	if (!(sheetHeight > 0)) {
		return FALLBACK_FADE_DISTANCE;
	}
	return Math.max(MIN_FADE_DISTANCE, sheetHeight);
}
