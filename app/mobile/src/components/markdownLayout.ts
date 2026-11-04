// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import { scaleChatSize, type ChatTextScale } from '../chatTextScale.js';

/**
 * 会話の Markdown の寸法のうち、会話の描画（`markdownText.tsx`）と、その場で範囲を選ぶ WebView
 * （`inplaceSelectHtml.ts`）が共有する値。片方だけ変えると、差し替えた瞬間に表の桁や字下げがずれる。RN を持たない純関数。
 */

/** 入れ子の箇条書きの 1 段ぶんの字下げ（会話の文字サイズが 100% のとき）。 */
export const BULLET_INDENT = 16;

/** 表セルの表示幅（fontSize 12 相当）。全角は2文字ぶんとして数える。 */
export function estimateTextWidth(text: string): number {
	let width = 0;
	for (const char of text) {
		// 記号混じりでも大きく外さない程度の粗い見積もり（半角6.6px / 全角12px）。
		width += /[　-鿿＀-￯]/.test(char) ? 12 : 6.6;
	}
	return width;
}

/**
 * 列ごとに「一番長いセル」を基準に幅を決める。極端に長い列は上限で頭打ちにする。
 * 会話の文字サイズ（`scale`）を変えているときは、見積もりも同じ割合で広げる・狭める。
 */
export function tableColumnWidths(block: { readonly header: readonly string[]; readonly rows: readonly (readonly string[])[] }, cols: number, scale: ChatTextScale): number[] {
	const widths: number[] = [];
	for (let c = 0; c < cols; c++) {
		let max = estimateTextWidth(block.header[c] ?? '');
		for (const row of block.rows) {
			max = Math.max(max, estimateTextWidth(row[c] ?? ''));
		}
		// +14 はセル左右のパディング、+8 は見積もり誤差ぶんの余白（足りないと折り返す）。
		widths.push(scaleChatSize(Math.min(260, Math.max(52, Math.ceil(max) + 22)), scale));
	}
	return widths;
}
