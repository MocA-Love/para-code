// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

/**
 * 下から出るシート（`BottomDrawer`）を指で引いたときの判定。画面に依存しない純粋な関数だけを置き、
 * 「どれだけ動かすか」「いつ掴むか」「離したら閉じるか」をテストで固定する。
 */

/** ここまで引き下げたら閉じる（pt）。 */
export const DISMISS_DISTANCE = 80;
/** 下向きの速さ（pt/ms）がこれを超えていれば、距離が足りなくても閉じる。 */
export const DISMISS_VELOCITY = 0.5;
/** 上へ引いたときは付いてこさせず、この割合だけ動かす（それ以上は広がらない合図）。 */
export const RUBBER_BAND = 0.25;
/** つまみ・見出しで引き始めとみなす縦の移動量（pt）。 */
export const GRAB_SLOP = 4;
/** 中身（スクロールする面）で引き始めとみなす縦の移動量（pt）。スクロールと取り合うので少し大きめ。 */
export const CONTENT_SLOP = 8;
/** 中身のスクロールが上端にあるとみなす誤差（pt）。 */
export const TOP_SCROLL_EPSILON = 1;
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

/** つまみの帯で掴むか。縦に動いたら上下どちらでも掴む（上はゴムで返す）。 */
export function shouldGrabHandle(dx: number, dy: number): boolean {
	return Math.abs(dy) > GRAB_SLOP && Math.abs(dy) > Math.abs(dx);
}

/**
 * 見出しの行で掴むか。見出しは中身と一緒にスクロールすることがあるので、中身が上端にあって
 * 下へ引いたときだけ掴む（上へ引いたときは中身のスクロールに任せる）。
 */
export function shouldGrabHeader(scrollOffset: number, dx: number, dy: number): boolean {
	return scrollOffset <= TOP_SCROLL_EPSILON && dy > GRAB_SLOP && dy > Math.abs(dx);
}

/** 中身を引いて掴むか。上端までスクロールしていて、下へ引いたときだけスクロールから奪う。 */
export function shouldGrabContent(scrollOffset: number, dx: number, dy: number): boolean {
	return scrollOffset <= TOP_SCROLL_EPSILON && dy > CONTENT_SLOP && dy > Math.abs(dx);
}

/** 幕が消えきるまでの引き下げ量（pt）。シートの高さぶん下げたら幕が無くなる。 */
export function backdropFadeDistance(sheetHeight: number): number {
	if (!(sheetHeight > 0)) {
		return FALLBACK_FADE_DISTANCE;
	}
	return Math.max(MIN_FADE_DISTANCE, sheetHeight);
}
