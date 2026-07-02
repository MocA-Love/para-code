/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-PATCH/PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

// Excelビューア/差分で共有する DOM 描画ヘルパー(Vanilla DOM。Superset の SpreadsheetViewer.tsx 相当)。

import * as dom from '../../../../base/browser/dom.js';
import { IParadisCellData, IParadisCellStyle } from '../common/paradisSpreadsheet.js';

const $ = dom.$;

export const PARADIS_ROW_NUM_COL_WIDTH = 36;

/** 0始まりの列インデックスを Excel の列ラベル(A, B, ..., Z, AA, ...)へ変換する。 */
export function getColumnLabel(index: number): string {
	let label = '';
	let n = index;
	do {
		label = String.fromCharCode(65 + (n % 26)) + label;
		n = Math.floor(n / 26) - 1;
	} while (n >= 0);
	return label;
}

/** プレーンなスタイルオブジェクト(camelCase CSS プロパティ→値)を要素へ適用する。 */
export function applyStyleObject(el: HTMLElement, style: IParadisCellStyle): void {
	const target = el.style as unknown as Record<string, string>;
	for (const key in style) {
		if (Object.prototype.hasOwnProperty.call(style, key)) {
			target[key] = style[key];
		}
	}
}

/** セルの中身(リッチテキストなら複数span、それ以外はテキスト)を td に流し込む。 */
export function setCellContent(td: HTMLElement, cell: IParadisCellData): void {
	if (cell.richText && cell.richText.length > 0) {
		for (const part of cell.richText) {
			const span = dom.append(td, $('span'));
			span.textContent = part.text;
			applyStyleObject(span, part.style);
		}
		return;
	}
	td.textContent = cell.value;
}

/** ビューア/差分の各データセルに共通の基本スタイルを適用し、セル固有スタイルを重ねる。 */
export function applyBaseCellStyle(td: HTMLElement, cell: IParadisCellData): void {
	const s = td.style;
	s.overflow = 'hidden';
	s.padding = '1px 3px';
	s.whiteSpace = 'nowrap';
	s.lineHeight = 'normal';
	s.boxSizing = 'border-box';
	applyStyleObject(td, cell.style);
	if (cell.wrapText) {
		s.whiteSpace = 'pre-wrap';
		s.wordBreak = 'break-all';
		s.overflow = 'visible';
	}
	if (cell.verticalText) {
		s.writingMode = 'vertical-rl';
		s.textOrientation = 'upright';
		s.letterSpacing = '0';
		s.lineHeight = '1';
		s.textAlign = 'center';
		s.verticalAlign = 'middle';
		s.whiteSpace = 'normal';
		s.wordBreak = 'keep-all';
		s.overflow = 'hidden';
		s.padding = '2px 0';
	}
}
