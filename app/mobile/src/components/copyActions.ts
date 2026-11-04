// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import { Share } from 'react-native';
import { haptic } from '../haptics.js';
import { isClipboardAvailable, writeClipboardText } from '../nativeClipboard.js';
import { useParaToast } from '../paraToast.js';
import type { ContextMenuOps } from './contextMenuModel.js';

/**
 * メニューの「〜をコピー」「共有…」の中身。写したらターミナル・メモと同じトースト（「〜をコピーしました」）で知らせる。
 *
 * 知らせ方の約束（Q549 U3 案 B）: 押した場所の見た目が変わるもの（入出力の枠・コードブロックの「コピー済」）はトーストを
 * 重ねない。シートやメニューから写したときだけトーストを出す。失敗はどこでも必ず知らせる。時間はどれも {@link COPY_TOAST_MS}。
 */

/** コピーのトーストを出しておく時間。 */
export const COPY_TOAST_MS = 1_500;

/** 写せなかったことを知らせる（`sub` は理由）。 */
export function notifyCopyFailed(sub?: string): void {
	haptic('error');
	useParaToast.getState().show({ key: 'context-menu-copy', text: 'コピーできませんでした', ...(sub !== undefined ? { sub } : {}), icon: 'alert-circle', tone: 'warn' }, COPY_TOAST_MS);
}

/** `text` を写し、`toast`（「相対パスをコピーしました」など）を出す。 */
export async function copyTextWithToast(text: string, toast: string): Promise<void> {
	const copied = await writeClipboardText(text);
	if (!copied) {
		notifyCopyFailed();
		return;
	}
	haptic('success');
	useParaToast.getState().show({ key: 'context-menu-copy', text: toast, icon: 'copy-outline', tone: 'done' }, COPY_TOAST_MS);
}

/** OS の共有シートで文字を渡す。 */
export function shareText(text: string): void {
	void Share.share({ message: text }).catch(() => { /* 閉じた・共有先が無いときは何もしない */ });
}

/** 画面で使う、メニューの写す・共有するの道具。 */
export function contextMenuOps(): ContextMenuOps {
	return {
		canCopy: isClipboardAvailable(),
		copy: (text, toast) => { void copyTextWithToast(text, toast); },
		copyLater: (load, toast) => {
			void load().then(text => copyTextWithToast(text, toast), (error: unknown) => notifyCopyFailed(error instanceof Error ? error.message : String(error)));
		},
		share: shareText,
	};
}
