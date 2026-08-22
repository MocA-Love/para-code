// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import { Linking } from 'react-native';
import type { ShouldStartLoadRequest } from 'react-native-webview/lib/WebViewTypes';

/**
 * WebView内のリンクタップでビューア自身の文書が置き換わるのを防ぐナビゲーションガード。
 *
 * `onShouldStartLoadWithRequest` を付けないと全ナビゲーションが許可され、markdown/HTML内の
 * 外部リンクをタップしただけでビューアの文書が置き換わる。戻す手段は「閉じて開き直す」しか
 * 無いため、http(s) への遷移はOSのブラウザへ逃がしてビューア側では拒否する。
 *
 * それ以外（about:blank やアンカー等の内部遷移、file:// のPDF内部リンク）はそのまま通す。
 */
export function guardWebViewNavigation(request: ShouldStartLoadRequest): boolean {
	// iframe内のナビゲーションには干渉しない（埋め込みコンテンツはそのまま読ませる）。
	if (!request.isTopFrame) {
		return true;
	}
	if (/^https?:/i.test(request.url)) {
		// 開けないURL（未対応スキーム等）でも失敗は無視する。ビューアの表示には影響しない。
		void Linking.openURL(request.url).catch(() => { });
		return false;
	}
	// javascript: / data: への遷移は拒否する。markdownはmarked.parseの生結果を埋め込むため
	// サニタイズされず、javascript: リンクのタップで任意スクリプトを実行され得る。
	if (/^(?:javascript|data):/i.test(request.url)) {
		return false;
	}
	return true;
}
