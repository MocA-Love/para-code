// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

/**
 * ファイルのフルスクリーンビューア。
 * - コード表示: PC側で現行テーマのままトークン化されたHTML（mtkクラス + カラーマップCSS）を
 *   WebView に流し込み、PC版とまったく同じ配色でシンタックスハイライトする
 * - .md / .html は PC版のfileViewersと同様に「レンダー / Raw」を切り替えられる
 *   （md は marked でHTML化、html はそのまま表示）
 */

import { useEffect, useMemo, useState } from 'react';
import { ActivityIndicator, Modal, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { WebView } from 'react-native-webview';
import { marked } from 'marked';
import * as LegacyFileSystem from 'expo-file-system/legacy';
import { colors } from '../theme.js';
import type { FsReadResult } from '../store.js';
import docxPreviewBundle from '../../assets/docxpreview/docxPreviewBundle.json';

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
	/** pdf: PDFバイナリ（base64url）。キャッシュへ書き出して WKWebView のネイティブPDF表示に渡す。 */
	pdfData?: string;
	/** docx: Word文書バイナリ（base64）。WebView 内の docx-preview でレンダリングする。 */
	docxData?: string;
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

/**
 * Word(.docx) のレンダーHTML。PC版ビューア（paradisDocxFileEditor.ts の _buildHtml）と同じ
 * vendored ライブラリ（jszip + パッチ済み docx-preview、assets/docxpreview/ に同梱）・同じ
 * レンダリングオプション・同じ後処理を WebView 内で実行する。表示仕様の変更は PC 版と
 * 両方に反映すること（レンダリングロジックの原本は PC 版）。
 */
function buildDocxHtml(docxBase64: string): string {
	// viewport はページ幅（A4縦 ≒ 794px + 余白）に固定し、WKWebView の自動フィットと
	// ピンチズームに任せる（画面幅に合わせて縮小表示され、拡大も自然に効く）。
	return `<!DOCTYPE html><html><head>
<meta charset="UTF-8">
<meta name="viewport" content="width=830">
<style>
	/* PC版と同じ: docx-preview はページ要素に width(=ページ幅) + padding(=余白) を設定し、
	box-sizing:border-box を前提にした値なので、既定の content-box のままだと用紙が余白分
	横に膨らむ。 */
	*, *::before, *::after { box-sizing: border-box; }
	html, body { margin: 0; padding: 0; }
	body { background-color: #1e1e1e; font-family: -apple-system, sans-serif; font-size: 13px; }
	#content { padding: 16px 16px 48px; display: flex; flex-direction: column; align-items: center; }
	#content .docx-wrapper { background: transparent; padding: 0; display: flex; flex-direction: column; align-items: center; gap: 16px; }
	#content .docx-wrapper > section.docx {
		background: #fff; box-shadow: 0 1px 4px rgba(0,0,0,.35); margin: 0;
		/* ページ基準(mso-position-*-relative:page)のVML図形(斜線等)の配置基準（PC版と同じ）。 */
		position: relative;
		/* 色指定の無い文字の既定は黒（用紙上で読める色を明示。PC版と同じ）。 */
		color: #000;
	}
	/* table-layout:fixed の表で折り返し不可能な内容がセル幅を超えたとき、隣接セルへの
	重なりではなく折り返しで高さ側に逃がす（PC版と同じ）。 */
	#content table td, #content table th { overflow-wrap: break-word; }
	#status { position: fixed; top: 45%; width: 100%; text-align: center; opacity: .75; color: #ccc; }
</style>
</head>
<body>
<div id="content"></div>
<div id="status">レンダリング中…</div>
<script>${docxPreviewBundle.jszip}</script>
<script>${docxPreviewBundle.docxPreview}</script>
<script>
	(async () => {
		const statusEl = document.getElementById('status');
		const contentEl = document.getElementById('content');
		try {
			if (!window.docx || !window.JSZip) {
				throw new Error('レンダリングライブラリの読み込みに失敗しました');
			}
			const b64 = ${JSON.stringify(docxBase64)};
			const bin = atob(b64);
			const buf = new Uint8Array(bin.length);
			for (let i = 0; i < bin.length; i++) {
				buf[i] = bin.charCodeAt(i);
			}
			// オプションは PC 版ビューアと同一（各項目の理由は paradisDocxFileEditor.ts 参照）。
			await window.docx.renderAsync(buf.buffer, contentEl, undefined, {
				className: 'docx',
				inWrapper: true,
				ignoreWidth: false,
				ignoreHeight: false,
				breakPages: true,
				ignoreLastRenderedPageBreak: false,
				experimental: true,
				renderHeaders: true,
				renderFooters: true,
				renderFootnotes: true,
				renderEndnotes: true,
				useBase64URL: true
			});
			// ページ本文幅を超える表などがあるとき、白紙をコンテンツ幅まで広げてはみ出しを防ぐ（PC版と同じ）。
			for (const section of contentEl.querySelectorAll('.docx-wrapper > section.docx')) {
				const needed = section.scrollWidth;
				if (needed > section.clientWidth) {
					section.style.width = needed + 'px';
				}
			}
			// Symbol/Wingdings フォントの Private Use Area 記号を標準Unicodeへ差し替える（PC版と同じ。
			// iOS にもこれらのフォントは無く、豆腐になるため）。
			const SYMBOL_FONT_GLYPH_MAP = {
				'\\uF0B7': '\\u2022',
				'\\uF0A7': '\\u25AA',
				'\\uF0E0': '\\u2192',
				'\\uF0FC': '\\u2713',
				'\\uF06C': '\\u25CF',
			};
			const symbolGlyphClass = '[' + Object.keys(SYMBOL_FONT_GLYPH_MAP).join('') + ']';
			const symbolGlyphPattern = new RegExp(symbolGlyphClass);
			const symbolGlyphReplaceAll = new RegExp(symbolGlyphClass, 'g');
			// 注意: この regex リテラルは TS テンプレートリテラル内の埋め込みJSなので、
			// \\s 等の正規表現専用エスケープは二重バックスラッシュで書く（PC版と同じ罠対策）。
			const symbolFontPattern = /font-family:\\s*[^;]*(?:symbol|wingdings|webdings)/i;
			for (const styleEl of document.querySelectorAll('style')) {
				const text = styleEl.textContent;
				if (!text || !symbolGlyphPattern.test(text)) {
					continue;
				}
				const patched = text.replace(/[^{}]+\\{[^{}]*\\}/g, block => {
					if (!symbolFontPattern.test(block)) {
						return block;
					}
					return block.replace(/(content:\\s*")([^"]*)(")/gi,
						(all, before, glyphs, after) => before + glyphs.replace(symbolGlyphReplaceAll, ch => SYMBOL_FONT_GLYPH_MAP[ch] ?? ch) + after);
				});
				if (patched !== text) {
					styleEl.textContent = patched;
				}
			}
			statusEl.remove();
		} catch (err) {
			statusEl.textContent = 'Word 文書を表示できませんでした: ' + (err && err.message ? err.message : err);
		}
	})();
</script>
</body>
</html>`;
}

/**
 * PDF表示。base64 のバイナリをキャッシュファイルへ書き出し、WKWebView に file:// URI で
 * 読ませてネイティブPDFレンダリング（ピンチズーム・ページング・テキスト選択つき）を使う。
 * 書き込みは legacy API の Base64 エンコーディング指定で行う（デコードがネイティブ側で走るため、
 * 数十MBのPDFでもJSスレッドをブロックしない）。
 */
function PdfView({ data }: { data: string }) {
	const [uri, setUri] = useState<string | undefined>(undefined);
	const [error, setError] = useState<string | undefined>(undefined);
	useEffect(() => {
		let cancelled = false;
		let written: string | undefined;
		(async () => {
			try {
				const dir = LegacyFileSystem.cacheDirectory;
				if (!dir) {
					throw new Error('cache directory unavailable');
				}
				const target = `${dir}pm-pdf-view-${Date.now()}.pdf`;
				await LegacyFileSystem.writeAsStringAsync(target, data, { encoding: LegacyFileSystem.EncodingType.Base64 });
				written = target;
				if (!cancelled) {
					setUri(target);
				} else {
					// 書き込み完了前にアンマウント済み。cleanup は written 未設定のまま走り終えているのでここで消す。
					void LegacyFileSystem.deleteAsync(target, { idempotent: true }).catch(() => { });
				}
			} catch (e) {
				if (!cancelled) {
					setError(String(e instanceof Error ? e.message : e));
				}
			}
		})();
		return () => {
			cancelled = true;
			if (written !== undefined) {
				// 一時ファイルの削除失敗は無視（cacheディレクトリはOSが回収する）
				void LegacyFileSystem.deleteAsync(written, { idempotent: true }).catch(() => { });
			}
		};
	}, [data]);
	if (error !== undefined) {
		return <Text style={styles.dim}>PDF を表示できませんでした: {error}</Text>;
	}
	if (uri === undefined) {
		return (
			<View style={styles.loadingBox}>
				<ActivityIndicator color={colors.textDim} />
				<Text style={styles.dim}>読み込み中…</Text>
			</View>
		);
	}
	return (
		<WebView
			style={styles.web}
			source={{ uri }}
			originWhitelist={['*']}
			allowingReadAccessToURL={uri}
			javaScriptEnabled={false}
		/>
	);
}

export function FileViewer({ path, result, spreadsheetHtml, sheets, sheetIndex, onSelectSheet, focusLine, pdfData, docxData, onClose }: FileViewerProps) {
	const name = path.split('/').pop() ?? path;
	const kind = /\.(?:xlsx|xlsm)$/i.test(name) ? 'spreadsheet' : /\.pdf$/i.test(name) ? 'pdf' : /\.docx$/i.test(name) ? 'docx' : /\.(?:md|markdown)$/i.test(name) ? 'markdown' : /\.(?:html?|xhtml)$/i.test(name) ? 'html' : 'other';
	// 検索一致行が指定されているときはRaw(コード)表示で開く（レンダー表示では行の概念がないため）
	const [mode, setMode] = useState<ViewMode>(kind === 'other' || focusLine !== undefined ? 'code' : 'render');

	const html = useMemo(() => {
		if (kind === 'spreadsheet') {
			if (spreadsheetHtml !== undefined) {
				return spreadsheetHtml;
			}
			// レンダリング失敗時は result にエラーメッセージが入る。
			// これを無視すると「読み込み中…」が恒久表示になるため、コード表示で見せる。
			return result ? buildCodeHtml(result) : undefined;
		}
		if (kind === 'pdf') {
			// 正常時は PdfView（file:// URI）で表示するため html は使わない。
			// エラー時のみ result のメッセージをコード表示で見せる。
			return result ? buildCodeHtml(result) : undefined;
		}
		if (kind === 'docx') {
			if (docxData !== undefined) {
				return buildDocxHtml(docxData);
			}
			// エラー時のみ result のメッセージをコード表示で見せる（成功時は docxData が来る）。
			return result ? buildCodeHtml(result) : undefined;
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
	}, [result, spreadsheetHtml, docxData, mode, kind, focusLine]);

	// 行ジャンプのスクロールスクリプトは自前生成のコードHTML内のみで有効化する
	// （.html のレンダー表示など、リポジトリ由来のHTMLでは引き続きJS無効）。
	// docx は WebView 内で vendored の docx-preview を実行するため JS が必要。
	const allowJs = kind === 'spreadsheet' || kind === 'docx' || (mode === 'code' && focusLine !== undefined);

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
				{kind === 'pdf' && pdfData !== undefined ? (
					<PdfView data={pdfData} />
				) : html !== undefined ? (
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
