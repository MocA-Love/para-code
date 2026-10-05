// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

/** ファイルビューアが扱う、WebViewのJavaScript実行可否に関係する種別。 */
export type FileViewerScriptKind = 'spreadsheet' | 'pdf' | 'docx' | 'image' | 'av' | 'markdown' | 'html' | 'unsupported' | 'other';

/** ファイルビューア内の表示モード。 */
export type FileViewerScriptMode = 'render' | 'code';

/** 差分ビューアが扱う、WebViewのJavaScript実行可否に関係する種別。 */
export type DiffViewerScriptKind = 'spreadsheet' | 'docx' | 'markdown' | 'html' | 'other';

/**
 * ファイルビューアのWebView内でJavaScriptを実行するかを返す。
 * HTMLはペアリング済みワークスペースの信頼済みコンテンツとして、PC版と同様に実行を許可する。
 */
export function isFileViewerJavaScriptEnabled(kind: FileViewerScriptKind, mode: FileViewerScriptMode, focusLine?: number): boolean {
	return (kind === 'html' && mode === 'render') || kind === 'spreadsheet' || kind === 'docx' || (mode === 'code' && focusLine !== undefined);
}

/**
 * ファイルビューア（`src/features/code/fileViewerBody.tsx`）の WebView でスクリプトを有効にするか。
 * 中の検索（`fileFind.ts`）を `injectJavaScript` で動かすため、画像・PDF・動画・音声のほかはすべて有効にする。
 *
 * コードと Markdown は、`buildCodeHtml` / `buildMarkdownHtml` に nonce を渡して作った HTML（自分のスクリプトだけを
 * 許す CSP 付き）にだけ使うこと。CSP の無い HTML（旧ビューア `fileViewer.tsx`）は {@link isFileViewerJavaScriptEnabled} のまま。
 */
export function isSearchableFileViewerJavaScriptEnabled(kind: FileViewerScriptKind): boolean {
	return kind !== 'image' && kind !== 'pdf' && kind !== 'av' && kind !== 'unsupported';
}

/** 差分ビューアのレンダーWebView内でJavaScriptを実行するかを返す（Word の差分は PC が描いた静的な HTML なので実行しない）。 */
export function isDiffViewerJavaScriptEnabled(kind: DiffViewerScriptKind): boolean {
	return kind === 'html' || kind === 'spreadsheet';
}
