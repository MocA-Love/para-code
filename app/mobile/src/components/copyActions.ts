// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import { Share } from 'react-native';
import { haptic } from '../haptics.js';
import { isClipboardAvailable, writeClipboardText } from '../nativeClipboard.js';
import { useParaToast } from '../paraToast.js';
import type { ContextMenuOps } from './contextMenuModel.js';

/**
 * メニューの「〜をコピー」「共有…」の中身。写したらターミナル・メモと同じトースト（「〜をコピーしました」）で知らせる。
 */

/** `text` を写し、`toast`（「相対パスをコピーしました」など）を出す。 */
export async function copyTextWithToast(text: string, toast: string): Promise<void> {
	const copied = await writeClipboardText(text);
	haptic(copied ? 'success' : 'error');
	useParaToast.getState().show(copied
		? { key: 'context-menu-copy', text: toast, icon: 'copy-outline', tone: 'done' }
		: { key: 'context-menu-copy', text: 'コピーできませんでした', icon: 'alert-circle', tone: 'warn' }, copied ? 1500 : 3000);
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
		share: shareText,
	};
}
