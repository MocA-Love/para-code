// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import { useStableInsets } from './useStableInsets.js';

/**
 * NativeTabsのフローティングタブバー（Liquid Glass）に画面最下部のコンテンツが
 * 隠れないよう確保する下余白。NativeTabsの自動コンテンツインセットは先頭の
 * スクロールビューにしか効かず、入力バーやツールバーなど非スクロールの最下部
 * 要素には適用されないため、各画面で手動で確保する。
 * 値はSafeArea下端 + フローティングタブバー本体の高さの目安。
 */
export function useTabBarSpacer(): number {
	const insets = useStableInsets();
	return insets.bottom + 62;
}
