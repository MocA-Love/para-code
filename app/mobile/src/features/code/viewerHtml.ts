// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import docxPreviewBundle from '../../../assets/docxpreview/docxPreviewBundle.json';
import { colors } from '../../theme.js';

/*
 * Word 文書と画像のプレビューの HTML。旧ビューア（`src/components/fileViewer.tsx`）から、中身を変えずに
 * 移したもの（レンダリングの原本は PC 版の `paradisDocxFileEditor.ts`。表示仕様を変えるときは両方に反映する）。
 */

/** 拡張子 → MIME タイプ（画像の data URI 用）。 */
const IMAGE_MIME: Record<string, string> = {
	jpg: 'image/jpeg', jpeg: 'image/jpeg', jpe: 'image/jpeg',
	png: 'image/png', bmp: 'image/bmp', gif: 'image/gif', ico: 'image/x-icon',
	webp: 'image/webp', avif: 'image/avif', svg: 'image/svg+xml',
};

/** 拡張子（小文字。無ければ空文字）。 */
export function fileExt(name: string): string {
	const dot = name.lastIndexOf('.');
	return dot >= 0 ? name.slice(dot + 1).toLowerCase() : '';
}

/**
 * Word(.docx) のレンダーHTML。PC版ビューア（paradisDocxFileEditor.ts の _buildHtml）と同じ
 * vendored ライブラリ（jszip + パッチ済み docx-preview、assets/docxpreview/ に同梱）・同じ
 * レンダリングオプション・同じ後処理を WebView 内で実行する。表示仕様の変更は PC 版と
 * 両方に反映すること（レンダリングロジックの原本は PC 版）。
 */
export function buildDocxHtml(docxBase64: string): string {
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
	body { background-color: ${colors.codeBg}; font-family: -apple-system, sans-serif; font-size: 13px; }
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
			// 【WebKit回避策1】WKWebView(WebKit) は表セル直上の writing-mode（直交フロー）を
			// レイアウトできず、縦書きセルの文字が1文字ずつ横に積まれてセル幅が暴走し、
			// 表全体の罫線・列幅も崩れる。writing-mode（と transform）をセル内のラッパー div へ
			// 移すと正しく描画される（PC版のChromiumはtd直上で正しく描画できるため後処理は不要）。
			for (const td of contentEl.querySelectorAll('td')) {
				const wm = td.style.writingMode;
				if (wm && wm !== 'horizontal-tb') {
					const wrap = document.createElement('div');
					wrap.style.writingMode = wm;
					const tf = td.style.transform;
					if (tf && tf !== 'none') {
						wrap.style.transform = tf;
					}
					while (td.firstChild) {
						wrap.appendChild(td.firstChild);
					}
					td.appendChild(wrap);
					td.style.writingMode = '';
					td.style.transform = '';
				}
			}
			// 【WebKit回避策2】WebKit は border-collapse の表で 1px 未満の罫線を描画しない。
			// Word 標準の罫線は 0.5pt ≒ 0.67px のため、そのままだと表の細罫線がほぼ全て消える。
			// 1px 未満の罫線幅を 1px へ底上げする（docx-preview 生成のCSSルールと
			// セルのインラインstyleの両方）。
			const bumpBorders = style => {
				for (const side of ['top', 'right', 'bottom', 'left']) {
					const prop = 'border-' + side + '-width';
					const value = style.getPropertyValue(prop);
					if (!value) {
						continue;
					}
					const num = parseFloat(value);
					if (isNaN(num) || num <= 0) {
						continue;
					}
					const px = value.endsWith('pt') ? num * 96 / 72 : num;
					if (px < 1) {
						style.setProperty(prop, '1px');
					}
				}
			};
			for (const sheet of document.styleSheets) {
				let rules;
				try {
					rules = sheet.cssRules;
				} catch (ruleErr) {
					rules = undefined;
				}
				if (!rules) {
					continue;
				}
				for (const rule of rules) {
					if (rule.style) {
						bumpBorders(rule.style);
					}
				}
			}
			for (const el of contentEl.querySelectorAll('table, td, th')) {
				bumpBorders(el.style);
			}
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
 * 画像のレンダーHTML。バイナリを data URI で埋め込み、暗背景の中央に収めて表示する
 * （ピンチズーム可）。SVG も <img> 経由なので内部スクリプトは実行されない
 * （WebView 側でも JS 無効で表示する）。
 */
export function buildImageHtml(base64: string, ext: string): string {
	const mime = IMAGE_MIME[ext] ?? 'application/octet-stream';
	return `<!DOCTYPE html><html><head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1, maximum-scale=10">
<style>
	html, body { margin: 0; height: 100%; background: ${colors.codeBg}; }
	body { display: flex; align-items: center; justify-content: center; }
	img { max-width: 100%; max-height: 100%; object-fit: contain; }
</style>
</head><body><img src="data:${mime};base64,${base64}"></body></html>`;
}

