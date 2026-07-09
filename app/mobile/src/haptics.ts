// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

/**
 * アプリ全域で使う触覚フィードバック（ハプティクス）のユーティリティ。
 * expo-haptics に依存するが、未対応端末やシミュレータで例外が発生しても
 * 画面操作をブロックしないよう、すべて try/catch + fire-and-forget で呼び出す。
 */

import * as Haptics from 'expo-haptics';

/**
 * 軽いカチッとした感触（選択・切替時）。
 */
export function hapticSelection(): void {
	try {
		void Haptics.selectionAsync();
	} catch {
		// 触覚フィードバック非対応端末では無視する
	}
}

/**
 * 押した感のある衝撃フィードバック（ボタン押下時）。
 */
export function hapticImpact(style: 'light' | 'medium' | 'heavy'): void {
	try {
		const feedbackStyle =
			style === 'light'
				? Haptics.ImpactFeedbackStyle.Light
				: style === 'medium'
					? Haptics.ImpactFeedbackStyle.Medium
					: Haptics.ImpactFeedbackStyle.Heavy;
		void Haptics.impactAsync(feedbackStyle);
	} catch {
		// 触覚フィードバック非対応端末では無視する
	}
}

/**
 * 完了を示す通知フィードバック。
 */
export function hapticSuccess(): void {
	try {
		void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
	} catch {
		// 触覚フィードバック非対応端末では無視する
	}
}

/**
 * 注意・警告を示す通知フィードバック。
 */
export function hapticWarning(): void {
	try {
		void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Warning);
	} catch {
		// 触覚フィードバック非対応端末では無視する
	}
}
