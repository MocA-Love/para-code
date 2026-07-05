// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

/**
 * ファイルのフルスクリーンビューア。
 * - コード表示: PC側で現行テーマのままトークン化されたHTML（mtkクラス + カラーマップCSS）を
 *   WebView に流し込み、PC版とまったく同じ配色でシンタックスハイライトする
 * - .md / .html は PC版のfileViewersと同様に「レンダー / Raw」を切り替えられる
 *   （md は marked でHTML化、html はそのまま表示）
 */

import { useMemo, useState } from 'react';
import { ActivityIndicator, Modal, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
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
	/** xlsx: シート名一覧（2枚以上でネイティブのシートタブを表示）。 */
	sheets?: string[];
	/** xlsx: 表示中のシートインデックス。 */
	sheetIndex?: number;
	/** xlsx: シートタブが選択された（PCへ該当シートを再要求する）。 */
	onSelectSheet?: (index: number) => void;
	/** テキスト検索から開いた場合の一致行（1始まり）。その行へスクロールしハイライトする。 */
	focusLine?: number;
	onClose: () => void;
}

type ViewMode = 'render' | 'code';

function escapeHtml(text: string): string {
	return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/** PCテーマのコードビューHTML（PC側ハイライトが無い場合はプレーンテキストにフォールバック）。 */
function buildCodeHtml(result: FsReadResult, focusLine?: number): string {
	const bg = result.bg ?? '#1e1e1e';
	const fg = result.fg ?? '#d4d4d4';
	const body = result.html ?? `<div class="monaco-tokenized-source">${escapeHtml(result.content)}</div>`;
	// 検索一致行へのジャンプ: トークン化HTMLは行を <br> で区切るため、<br> を数えて
	// 対象行のノード列を span で包み、ハイライトしてスクロールする。
	const focusScript = focusLine !== undefined && focusLine > 0 ? `<script>
(function () {
	var source = document.querySelector('.monaco-tokenized-source');
	if (!source) { return; }
	var target = ${focusLine};
	var line = 1;
	var span = null;
	var nodes = Array.prototype.slice.call(source.childNodes);
	for (var i = 0; i < nodes.length; i++) {
		var node = nodes[i];
		if (node.nodeName === 'BR') { line++; if (line > target) { break; } continue; }
		if (line === target) {
			if (!span) {
				span = document.createElement('span');
				span.className = 'pm-focus-line';
				source.insertBefore(span, node);
			}
			span.appendChild(node);
		}
	}
	if (span) { setTimeout(function () { span.scrollIntoView({ block: 'center' }); }, 50); }
})();
</script>` : '';
	return `<!DOCTYPE html><html><head>
<meta name="viewport" content="width=device-width, initial-scale=1">
<style>${result.css ?? ''}</style>
<style>
	body { margin: 0; background: ${bg}; color: ${fg}; }
	.monaco-tokenized-source { display: block; font-family: Menlo, ui-monospace, monospace; font-size: 11px; line-height: 1.55; white-space: pre; padding: 12px; }
	.pm-focus-line { background: rgba(255, 200, 0, .22); outline: 2px solid rgba(255, 200, 0, .45); border-radius: 2px; }
</style>
</head><body>${body}${focusScript}</body></html>`;
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

export function FileViewer({ path, result, spreadsheetHtml, sheets, sheetIndex, onSelectSheet, focusLine, onClose }: FileViewerProps) {
	const name = path.split('/').pop() ?? path;
	const kind = /\.(?:xlsx|xlsm)$/i.test(name) ? 'spreadsheet' : /\.(?:md|markdown)$/i.test(name) ? 'markdown' : /\.(?:html?|xhtml)$/i.test(name) ? 'html' : 'other';
	// 検索一致行が指定されているときはRaw(コード)表示で開く（レンダー表示では行の概念がないため）
	const [mode, setMode] = useState<ViewMode>(kind === 'other' || focusLine !== undefined ? 'code' : 'render');

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
		return buildCodeHtml(result, focusLine);
	}, [result, spreadsheetHtml, mode, kind, focusLine]);

	// 行ジャンプのスクロールスクリプトは自前生成のコードHTML内のみで有効化する
	// （.html のレンダー表示など、リポジトリ由来のHTMLでは引き続きJS無効）。
	const allowJs = kind === 'spreadsheet' || (mode === 'code' && focusLine !== undefined);

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
				{kind === 'spreadsheet' && sheets !== undefined && sheets.length > 1 ? (
					<ScrollView horizontal showsHorizontalScrollIndicator={false} style={styles.sheetBar} contentContainerStyle={styles.sheetBarContent}>
						{sheets.map((sheetName, i) => (
							<Pressable key={i} style={[styles.sheetChip, i === sheetIndex && styles.sheetChipActive]} onPress={() => onSelectSheet?.(i)}>
								<Text style={[styles.sheetText, i === sheetIndex && styles.sheetTextActive]} numberOfLines={1}>{sheetName}</Text>
							</Pressable>
						))}
					</ScrollView>
				) : null}
				{result?.truncated || result?.highlightTruncated ? (
					<Text style={styles.truncated}>サイズ上限のため先頭のみ表示しています</Text>
				) : null}
				{html !== undefined ? (
					// javaScriptEnabled は自前生成HTML（スプレッドシート・検索行ジャンプ付き
					// コードビュー）のみ true。リポジトリ内の信頼できない .html の
					// スクリプトは端末で実行しない（レンダーは静的表示のみ）。
					<WebView
						style={styles.web}
						source={{ html }}
						originWhitelist={['*']}
						javaScriptEnabled={allowJs}
					/>
				) : (
					<View style={styles.loadingBox}>
						<ActivityIndicator color={colors.textDim} />
						<Text style={styles.dim}>読み込み中…</Text>
					</View>
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
	loadingBox: { alignItems: 'center', gap: 8, marginTop: 24 },
	sheetBar: { flexGrow: 0, flexShrink: 0, backgroundColor: colors.surface, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: colors.border },
	sheetBarContent: { paddingHorizontal: 12, paddingVertical: 8, gap: 8 },
	sheetChip: { backgroundColor: colors.panel, borderWidth: 1, borderColor: colors.border, borderRadius: 8, paddingHorizontal: 12, paddingVertical: 6, maxWidth: 180 },
	sheetChipActive: { borderColor: colors.accent2, backgroundColor: 'rgba(0,122,204,.16)' },
	sheetText: { color: colors.textDim, fontSize: 12 },
	sheetTextActive: { color: colors.text, fontWeight: '600' },
});
