// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import { HIT_SIZE } from '../theme.js';

/** `Pressable` の `hitSlop` と同じ形（react-native を読み込まずにテストできるよう自前で持つ）。 */
export interface HitSlopInsets {
	readonly top: number;
	readonly bottom: number;
	readonly left: number;
	readonly right: number;
}

/**
 * 見た目の小さい操作（行内の「コピー」「全文を表示」など）の当たり判定を {@link HIT_SIZE} まで広げる余白。
 * 見た目の寸法から足りないぶんを上下（幅を渡したときは左右も）に等分する。
 * 行の中に並んだ小さな操作は、見た目を大きくすると行の高さまで変わるので、こちらで補う。
 */
export function hitSlopToMinimum(visualHeight: number, visualWidth?: number): HitSlopInsets {
	const vertical = Math.max(0, Math.ceil((HIT_SIZE - visualHeight) / 2));
	const horizontal = visualWidth === undefined ? 0 : Math.max(0, Math.ceil((HIT_SIZE - visualWidth) / 2));
	return { top: vertical, bottom: vertical, left: horizontal, right: horizontal };
}
