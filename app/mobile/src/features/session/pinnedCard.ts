// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import { createContext, useContext } from 'react';

/**
 * コンポーザーの上に固定する回答カード（許可・質問）の高さの上限と、カードの中の入力欄を見せる口。
 */

/** キーボードが出ているときの上限の下限（選択肢 2 つとメモの欄が入る高さ）。 */
export const PINNED_CARD_MIN_HEIGHT_WITH_KEYBOARD = 140;
/** キーボードが出ているとき、キーボードの上に残る高さのうちカードに使ってよい割合（残りは会話と入力欄）。 */
const PINNED_CARD_KEYBOARD_SHARE = 0.45;

/**
 * カードの高さの上限。キーボードが出ている（`keyboard` > 0）ときは、キーボードの上に残る高さに合わせて下げる
 * （iPhone の小さい画面でメモ欄にフォーカスしたとき、カードが会話と入力欄を押し出さないように）。
 */
export function pinnedCardMaxHeight(base: number, windowHeight: number, keyboard: number): number {
	if (keyboard <= 0) {
		return base;
	}
	const room = Math.round((windowHeight - keyboard) * PINNED_CARD_KEYBOARD_SHARE);
	return Math.min(base, Math.max(PINNED_CARD_MIN_HEIGHT_WITH_KEYBOARD, room));
}

/** カードのスクロールの中で、指定した部品（入力欄など）が見える位置までスクロールする口。カードの外では何もしない。 */
export interface PinnedCardScroll {
	reveal(node: unknown): void;
}

export const PinnedCardScrollContext = createContext<PinnedCardScroll>({ reveal: () => { } });

export function usePinnedCardScroll(): PinnedCardScroll {
	return useContext(PinnedCardScrollContext);
}
