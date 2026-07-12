// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

/** ファイルビューアが扱う、WebViewのJavaScript実行可否に関係する種別。 */
export type FileViewerScriptKind = 'spreadsheet' | 'pdf' | 'docx' | 'image' | 'av' | 'markdown' | 'html' | 'other';

/** ファイルビューア内の表示モード。 */
export type FileViewerScriptMode = 'render' | 'code';

/** 差分ビューアが扱う、WebViewのJavaScript実行可否に関係する種別。 */
export type DiffViewerScriptKind = 'spreadsheet' | 'markdown' | 'html' | 'other';

/**
 * ファイルビューアのWebView内でJavaScriptを実行するかを返す。
 * HTMLはペアリング済みワークスペースの信頼済みコンテンツとして、PC版と同様に実行を許可する。
 */
export function isFileViewerJavaScriptEnabled(kind: FileViewerScriptKind, mode: FileViewerScriptMode, focusLine?: number): boolean {
	return (kind === 'html' && mode === 'render') || kind === 'spreadsheet' || kind === 'docx' || (mode === 'code' && focusLine !== undefined);
}

/** 差分ビューアのレンダーWebView内でJavaScriptを実行するかを返す。 */
export function isDiffViewerJavaScriptEnabled(kind: DiffViewerScriptKind): boolean {
	return kind === 'html' || kind === 'spreadsheet';
}
