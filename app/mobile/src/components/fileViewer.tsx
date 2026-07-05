// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

/**
 * ファイルのフルスクリーンビューア。
 * - コード表示: PC側で現行テーマのままトークン化されたHTML（mtkクラス + カラーマップCSS）を
 *   WebView に流し込み、PC版とまったく同じ配色でシンタックスハイライトする
 * - .md / .html は PC版のfileViewersと同様に「レンダー / Raw」を切り替えられる
 *   （md は marked でHTML化、html はそのまま表示）
 */

import { useMemo, useState } from 'react';
import { Modal, Pressable, StyleSheet, Text, View } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { WebView } from 'react-native-webview';
import { marked } from 'marked';
import { colors } from '../theme.js';
import type { FsReadResult } from '../store.js';

interface FileViewerProps {
	path: string;
	/** fsRead の結果。undefined は読み込み中。 */
	result: FsReadResult | undefined;
	/** xlsx等: PC側でレンダリングされた静的HTML（指定時はこちらを優先表示）。 */
	spreadsheetHtml?: string;
	onClose: () => void;
}

type ViewMode = 'render' | 'code';

function escapeHtml(text: string): string {
	return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/** PCテーマのコードビューHTML（PC側ハイライトが無い場合はプレーンテキストにフォールバック）。 */
function buildCodeHtml(result: FsReadResult): string {
	const bg = result.bg ?? '#1e1e1e';
	const fg = result.fg ?? '#d4d4d4';
	const body = result.html ?? `<div class="monaco-tokenized-source">${escapeHtml(result.content)}</div>`;
	return `<!DOCTYPE html><html><head>
<meta name="viewport" content="width=device-width, initial-scale=1">
<style>${result.css ?? ''}</style>
<style>
	body { margin: 0; background: ${bg}; color: ${fg}; }
	.monaco-tokenized-source { display: block; font-family: Menlo, ui-monospace, monospace; font-size: 11px; line-height: 1.55; white-space: pre; padding: 12px; }
</style>
</head><body>${body}</body></html>`;
}

/** markdown のレンダーHTML（PCテーマの背景/前景に合わせた読みやすいスタイル）。DiffViewのレンダーモードと共用。 */
export function buildMarkdownHtml(result: Pick<FsReadResult, 'content' | 'bg' | 'fg'>): string {
	const bg = result.bg ?? '#1e1e1e';
	const fg = result.fg ?? '#d4d4d4';
	const rendered = marked.parse(result.content, { async: false });
	return `<!DOCTYPE html><html><head>
<meta name="viewport" content="width=device-width, initial-scale=1">
<style>
	body { margin: 0; padding: 16px; background: ${bg}; color: ${fg}; font-family: -apple-system, sans-serif; font-size: 15px; line-height: 1.65; word-wrap: break-word; }
	h1, h2 { border-bottom: 1px solid rgba(128,128,128,.3); padding-bottom: .3em; }
	a { color: #58a6ff; }
	img { max-width: 100%; }
	pre { background: rgba(128,128,128,.15); padding: 12px; border-radius: 8px; overflow-x: auto; }
	code { font-family: Menlo, ui-monospace, monospace; font-size: 13px; background: rgba(128,128,128,.15); padding: 1px 4px; border-radius: 4px; }
	pre code { background: none; padding: 0; }
	blockquote { margin: 0; padding-left: 12px; border-left: 3px solid rgba(128,128,128,.4); color: rgba(160,160,160,1); }
	table { border-collapse: collapse; }
	th, td { border: 1px solid rgba(128,128,128,.3); padding: 5px 10px; }
</style>
</head><body>${rendered}</body></html>`;
}

export function FileViewer({ path, result, spreadsheetHtml, onClose }: FileViewerProps) {
	const name = path.split('/').pop() ?? path;
	const kind = /\.(?:xlsx|xlsm)$/i.test(name) ? 'spreadsheet' : /\.(?:md|markdown)$/i.test(name) ? 'markdown' : /\.(?:html?|xhtml)$/i.test(name) ? 'html' : 'other';
	const [mode, setMode] = useState<ViewMode>(kind === 'other' ? 'code' : 'render');

	const html = useMemo(() => {
		if (kind === 'spreadsheet') {
			return spreadsheetHtml;
		}
		if (!result) {
			return undefined;
		}
		if (mode === 'render' && kind === 'html') {
			return result.content;
		}
		if (mode === 'render' && kind === 'markdown') {
			return buildMarkdownHtml(result);
		}
		return buildCodeHtml(result);
	}, [result, spreadsheetHtml, mode, kind]);

	return (
		<Modal visible animationType="slide" presentationStyle="fullScreen" onRequestClose={onClose}>
			<View style={styles.screen}>
				<View style={styles.header}>
					<Ionicons name="document-text-outline" size={16} color={colors.textDim} />
					<Text style={styles.title} numberOfLines={1}>{path}</Text>
					{kind === 'markdown' || kind === 'html' ? (
						<View style={styles.segment}>
							<Pressable style={[styles.segmentBtn, mode === 'render' && styles.segmentBtnActive]} onPress={() => setMode('render')}>
								<Text style={[styles.segmentText, mode === 'render' && styles.segmentTextActive]}>レンダー</Text>
							</Pressable>
							<Pressable style={[styles.segmentBtn, mode === 'code' && styles.segmentBtnActive]} onPress={() => setMode('code')}>
								<Text style={[styles.segmentText, mode === 'code' && styles.segmentTextActive]}>Raw</Text>
							</Pressable>
						</View>
					) : null}
					<Pressable onPress={onClose} hitSlop={8} accessibilityLabel="閉じる">
						<Ionicons name="close" size={22} color={colors.text} />
					</Pressable>
				</View>
				{result?.truncated || result?.highlightTruncated ? (
					<Text style={styles.truncated}>サイズ上限のため先頭のみ表示しています</Text>
				) : null}
				{html !== undefined ? (
					// javaScriptEnabled はスプレッドシート（PC側で自前生成したHTMLのシート切替
					// スクリプトのみ）を除き false。リポジトリ内の信頼できない .html の
					// スクリプトは端末で実行しない（レンダーは静的表示のみ）。
					<WebView
						style={styles.web}
						source={{ html }}
						originWhitelist={['*']}
						javaScriptEnabled={kind === 'spreadsheet'}
					/>
				) : (
					<Text style={styles.dim}>読み込み中…</Text>
				)}
			</View>
		</Modal>
	);
}

const styles = StyleSheet.create({
	screen: { flex: 1, backgroundColor: colors.bg },
	header: { flexDirection: 'row', alignItems: 'center', gap: 8, paddingHorizontal: 16, paddingTop: 58, paddingBottom: 12, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: colors.border, backgroundColor: colors.surface },
	title: { flex: 1, color: colors.text, fontSize: 13 },
	segment: { flexDirection: 'row', backgroundColor: colors.panel, borderRadius: 8, borderWidth: 1, borderColor: colors.border, overflow: 'hidden' },
	segmentBtn: { paddingHorizontal: 10, paddingVertical: 5 },
	segmentBtnActive: { backgroundColor: 'rgba(0,122,204,.25)' },
	segmentText: { color: colors.textDim, fontSize: 12 },
	segmentTextActive: { color: colors.text, fontWeight: '600' },
	truncated: { color: colors.yellow, fontSize: 10, paddingHorizontal: 16, paddingVertical: 4 },
	web: { flex: 1 },
	dim: { color: colors.textDim, fontSize: 13, textAlign: 'center', marginTop: 24 },
});
