// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import { create } from 'zustand';

interface UsageEmailMaskState {
	/** Claude / Codex のメールを番号（「Claude 1」など）で出している。 */
	readonly masked: boolean;
	toggle(): void;
}

/**
 * スクリーンショット用に、使用量の画面とホームのカードのメールを番号で出す切り替え（使用量の画面の右上のボタン）。
 * 保存せず、アプリを終了すると表示に戻る。PC の使用量パネルの切り替えとは連動しない。
 */
export const useUsageEmailMask = create<UsageEmailMaskState>(set => ({
	masked: false,
	toggle: () => set(state => ({ masked: !state.masked })),
}));
