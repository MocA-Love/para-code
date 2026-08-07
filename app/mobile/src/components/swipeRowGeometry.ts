// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

/**
 * 行を横スワイプしたときの、止まる位置と実行される位置。
 *
 * 見た目から切り離して純関数にしてある。ここは**3つの距離の大小が崩れた瞬間に壊れる**のに、
 * 崩れても画面上は「開いているのに押せない」「少し動かしただけで実行される」という形でしか
 * 現れず、目視では気付けないため。実際、カード3枚（確認済み・アーカイブ・削除）のときに
 * 引き切り位置が開く位置より手前に来て、開いた瞬間に実行扱いになる不具合を出した。
 */

/** アクションカード1枚の幅。 */
export const CARD_WIDTH = 72;
/** カード同士の隙間。 */
export const CARD_GAP = 8;
/** 行とカードの間の隙間。 */
export const ROW_GAP = 8;

export interface SwipeGeometry {
	/** 指を離したときに止まる位置（カードが全部見える）。 */
	openDistance: number;
	/** ここまで引いたら引き切り扱い。必ず `openDistance` より深い。 */
	fullSwipeAt: number;
	/** これ以上は引けない上限。必ず `fullSwipeAt` より深い。 */
	limit: number;
	/** カード1枚のポップ演出（淡く小さい→実寸）に割り当てる区間の幅。`openDistance`をカード枚数で割ったもの。 */
	cardStep: number;
}

/**
 * カードの「端からの並び順」。ポップ演出は端に近いカードから始まるが、DOM上の並びは
 * 左→右で固定なので、スワイプの向きによって反転が要る。'left'（右側から出る）は
 * DOM上最後のカードが端＝0番、'right'はDOM上先頭が端＝0番。
 * ±1を目視で検出できない系統のロジックなので、ここに置いてテストで固定する。
 */
export function cardEdgeIndex(direction: 'left' | 'right', index: number, count: number): number {
	return direction === 'left' ? count - 1 - index : index;
}

export function swipeGeometry(actionCount: number): SwipeGeometry {
	const cards = Math.max(0, actionCount);
	const openDistance = cards === 0 ? 0 : cards * CARD_WIDTH + (cards - 1) * CARD_GAP + ROW_GAP;
	// 引き切りは「開く位置からさらにカード半分ぶん」。**上限で頭打ちにはしない**。
	// 頭打ちにすると枚数が増えたときに開く位置を追い越し、開いた時点で実行扱いになる。
	// 値は整数ptに丸める。判定はこの3つの大小関係だけに乗っているので、端数を残さない。
	const fullSwipeAt = Math.round(openDistance + CARD_WIDTH * 0.6);
	// openDistanceを直接割ることで、CARD_GAPとROW_GAPの値が今後ずれても
	// 「最後の1枚がopenDistanceに達したときちょうど実寸になる」整合性が自動的に保たれる。
	const cardStep = cards === 0 ? 0 : openDistance / cards;
	return { openDistance, fullSwipeAt, limit: Math.round(fullSwipeAt + CARD_WIDTH * 0.5), cardStep };
}
