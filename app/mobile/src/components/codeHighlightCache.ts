// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

/**
 * 会話のコードブロックの PC テーマのハイライト（fs hl の応答）の読み方と、結果のメモリキャッシュ。
 * 会話の描画（`markdownText.tsx`）が要求して入れ、その場で範囲を選ぶ表示（`inplaceSelectHtml.ts`）は
 * {@link peekCodeHighlight} で同じ色を引く（PC へ新しく要求はしない）。RN を持たない純粋なファイル。
 */

/** 色付きテキスト片。1行 = HighlightRun[]。 */
export interface HighlightRun { text: string; color?: string; italic?: boolean; bold?: boolean }
export interface HighlightData { lines: HighlightRun[][]; bg?: string; fg?: string }

/**
 * PCから届いた `.monaco-tokenized-source` HTML（span.mtkN と <br/> のみ、< > & エスケープ）と
 * カラーマップCSS（`.mtkN { color: ... }`）をネイティブText用の色付きラン列へ変換する。
 * 期待形式から外れた場合は undefined（プレーン表示のまま）。
 */
export function parseTokenizedHtml(html: string, css: string): HighlightRun[][] | undefined {
	const inner = /^<div[^>]*>([\s\S]*)<\/div>$/.exec(html.trim())?.[1];
	if (inner === undefined) {
		return undefined;
	}
	const colorByClass = new Map<string, string>();
	for (const rule of css.matchAll(/\.(mtk\d+)\s*\{\s*color:\s*([^;}]+);/g)) {
		const className = rule[1];
		const color = rule[2];
		if (className !== undefined && color !== undefined) {
			colorByClass.set(className, color.trim());
		}
	}
	const unescape = (s: string) => s.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');
	let currentLine: HighlightRun[] = [];
	const lines: HighlightRun[][] = [currentLine];
	const tokenPattern = /<span class="([^"]*)">([\s\S]*?)<\/span>|<br\/?>|([^<]+)/g;
	for (const m of inner.matchAll(tokenPattern)) {
		if (m[0].startsWith('<br')) {
			currentLine = [];
			lines.push(currentLine);
			continue;
		}
		if (m[1] !== undefined) {
			const classes = m[1].split(/\s+/);
			const colorClass = classes.find(c => /^mtk\d+$/.test(c));
			currentLine.push({
				text: unescape(m[2] ?? ''),
				...(colorClass !== undefined && colorByClass.has(colorClass) ? { color: colorByClass.get(colorClass) } : {}),
				...(classes.includes('mtki') ? { italic: true } : {}),
				...(classes.includes('mtkb') ? { bold: true } : {}),
			});
		} else if (m[3] !== undefined && m[3].length > 0) {
			currentLine.push({ text: unescape(m[3]) });
		}
	}
	return lines;
}

/** ハイライト結果のメモリキャッシュ（同一コード片の再取得を避ける）。null = 取得失敗（再試行しない）。 */
export const highlightCache = new Map<string, HighlightData | null>();
export const HIGHLIGHT_CACHE_LIMIT = 120;

/** キャッシュの鍵（言語と本文）。 */
export function codeHighlightKey(text: string, lang: string | undefined): string {
	return `${lang ?? ''} ${text}`;
}

/** 会話の描画が取ってあるハイライトを引く（取れていない・失敗したものは `undefined`）。 */
export function peekCodeHighlight(text: string, lang: string | undefined): HighlightData | undefined {
	return highlightCache.get(codeHighlightKey(text, lang)) ?? undefined;
}
