/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-PATCH/PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

// Excel の「改ページプレビュー」相当のページ割りを求める。手動改ページ(rowBreaks/colBreaks)だけでは
// ページ全体は決まらない（用紙に入りきらない分は Excel が自動で改ページを入れる）ため、用紙設定から
// 1ページに載る大きさを出し、行・列を敷き詰めてページ境界を決める。
//
// このファイルは node 層でも renderer 層でも同じ結果を使う純関数だけで構成する。
// 依存は nls(文言)のみを許容し、DOM や node 組み込みには触れない。
// 長さの単位は全て pt（1pt = 1/72 inch）で統一する。

import { localize } from '../../../../nls.js';

/** 用紙・余白・倍率など、ページ割りの計算に必要な設定。 */
export interface IParadisPageSetup {
	/** 用紙の幅・高さ(pt)。向きを反映済み。 */
	readonly paperWidth: number;
	readonly paperHeight: number;
	readonly marginLeft: number;
	readonly marginRight: number;
	readonly marginTop: number;
	readonly marginBottom: number;
	/** 拡大縮小率(1 = 100%)。 */
	readonly scale: number;
	/** scale がファイルに書かれていたか(fitToPage のとき、Excel はそこへ実効倍率を書き戻す)。 */
	readonly hasSavedScale: boolean;
	/** 「次のページ数に合わせて印刷」が有効か。 */
	readonly fitToPage: boolean;
	/** 横方向に収めるページ数(0 = 指定なし)。 */
	readonly fitToWidth: number;
	/** 縦方向に収めるページ数(0 = 指定なし)。 */
	readonly fitToHeight: number;
	/** ページ番号を振る順序。既定は「上から下、次に右」。 */
	readonly pageOrder: 'downThenOver' | 'overThenDown';
	readonly landscape: boolean;
	/** 用紙名(表示用。"A4" 等)。 */
	readonly paperName: string;
	/** 各ページの先頭で繰り返す行(印刷タイトル)。 */
	readonly repeatRowsFrom?: number;
	readonly repeatRowsTo?: number;
}

/** ページ割りの1区間(Excel の1始まり行番号／列番号。from・to とも境界を含む)。 */
export interface IParadisPageBand {
	readonly from: number;
	readonly to: number;
	/** 区間の終わりが手動改ページによるものか(false = 用紙に入りきらずに自動で切れた)。 */
	readonly manual: boolean;
	/** 区間の合計サイズ(pt。倍率を掛ける前のシート上の寸法)。 */
	readonly size: number;
}

/** ページ割りの計算結果。 */
export interface IParadisPageLayout {
	readonly rowBands: readonly IParadisPageBand[];
	readonly colBands: readonly IParadisPageBand[];
	/** 自動で入った改ページ(その行の下・その列の右で改ページ)。手動分は含まない。 */
	readonly autoRowBreaks: readonly number[];
	readonly autoColBreaks: readonly number[];
	/** ページ番号。pageNumbers[行区間index][列区間index] = 1 始まりのページ番号。 */
	readonly pageNumbers: readonly (readonly number[])[];
	readonly pageCount: number;
	/** 実際に使った拡大縮小率(1 = 100%)。fitToPage のときは計算値。 */
	readonly effectiveScale: number;
	/** 1ページに載る本文領域(pt)。 */
	readonly usableWidth: number;
	readonly usableHeight: number;
}

/** 差分ビューアでの改ページの状態。 */
export type ParadisPageBreakStatus = 'unchanged' | 'added' | 'removed' | 'movedFrom' | 'movedTo';

/** 描画する改ページ線1本。手動/自動の別と、差分ビューアでの状態を持つ。 */
export interface IParadisPageBreakLine {
	/** その行の下・その列の右で改ページ(Excel の1始まり)。 */
	readonly index: number;
	readonly kind: 'manual' | 'auto';
	readonly status?: ParadisPageBreakStatus;
	/** ホバー時の説明(差分ビューア用)。 */
	readonly title?: string;
}

/** ページ番号の透かし1つ分(ページの矩形と表示文字)。 */
export interface IParadisPageLabelBox {
	readonly text: string;
	readonly fromRow: number;
	readonly toRow: number;
	readonly fromCol: number;
	readonly toCol: number;
	/** 差分ビューアで、このページの中身が別のページへ移った場合に強調する。 */
	readonly changed?: boolean;
}

/** 1ページが占める矩形(Excel の1始まり行列。境界を含む)。 */
export interface IParadisPageRectangle {
	readonly page: number;
	readonly fromRow: number;
	readonly toRow: number;
	readonly fromCol: number;
	readonly toCol: number;
}

/** ページ割りをページ単位の矩形に展開する(ページ番号の透かしを置く位置)。 */
export function pageRectangles(layout: IParadisPageLayout): IParadisPageRectangle[] {
	const rects: IParadisPageRectangle[] = [];
	for (let r = 0; r < layout.rowBands.length; r++) {
		for (let c = 0; c < layout.colBands.length; c++) {
			rects.push({
				page: layout.pageNumbers[r][c],
				fromRow: layout.rowBands[r].from,
				toRow: layout.rowBands[r].to,
				fromCol: layout.colBands[c].from,
				toCol: layout.colBands[c].to,
			});
		}
	}
	return rects;
}

/** computePageLayout の入力。行・列の大きさは pt で、非表示行・非表示列は 0 を入れる。 */
export interface IParadisPageLayoutInput {
	readonly setup: IParadisPageSetup;
	/** rowHeights[0] が表す行番号(Excel の1始まり)。 */
	readonly minRow: number;
	readonly rowHeights: readonly number[];
	/** colWidths[0] が表す列番号(Excel の1始まり)。 */
	readonly minCol: number;
	readonly colWidths: readonly number[];
	/** 手動改ページ(その行の下・その列の右で改ページ)。 */
	readonly manualRowBreaks: readonly number[];
	readonly manualColBreaks: readonly number[];
}

const MM_TO_PT = 72 / 25.4;
const IN_TO_PT = 72;

// 用紙サイズ(OOXML の paperSize コード)。日本の帳票で使う JIS 判は JIS の実寸を採る。
const PAPER_MM: { readonly [code: number]: readonly [number, number, string] } = {
	8: [297, 420, 'A3'],
	9: [210, 297, 'A4'],
	10: [210, 297, 'A4'],
	11: [148, 210, 'A5'],
	12: [257, 364, 'B4 (JIS)'],
	13: [182, 257, 'B5 (JIS)'],
	43: [100, 148, 'はがき'],
	44: [200, 148, '往復はがき'],
	66: [420, 594, 'A2'],
	70: [210, 148, 'A5'],
};

const PAPER_IN: { readonly [code: number]: readonly [number, number, string] } = {
	1: [8.5, 11, 'Letter'],
	2: [8.5, 11, 'Letter'],
	3: [11, 17, 'Tabloid'],
	4: [17, 11, 'Ledger'],
	5: [8.5, 14, 'Legal'],
	6: [5.5, 8.5, 'Statement'],
	7: [7.25, 10.5, 'Executive'],
	14: [8.5, 13, 'Folio'],
};

/** paperSize コード → 用紙の短辺・長辺(pt)と表示名。未知のコードは A4 とみなす。 */
export function paperSizeToPt(code: number | undefined): { width: number; height: number; name: string } {
	const mm = code !== undefined ? PAPER_MM[code] : undefined;
	if (mm) {
		return { width: mm[0] * MM_TO_PT, height: mm[1] * MM_TO_PT, name: mm[2] };
	}
	const inch = code !== undefined ? PAPER_IN[code] : undefined;
	if (inch) {
		return { width: inch[0] * IN_TO_PT, height: inch[1] * IN_TO_PT, name: inch[2] };
	}
	const a4 = PAPER_MM[9];
	return { width: a4[0] * MM_TO_PT, height: a4[1] * MM_TO_PT, name: a4[2] };
}

function attr(tag: string | undefined, name: string): string | undefined {
	if (!tag) {
		return undefined;
	}
	const m = tag.match(new RegExp(`\\b${name}="([^"]*)"`));
	return m ? m[1] : undefined;
}

function num(value: string | undefined, fallback: number): number {
	const n = value !== undefined ? Number.parseFloat(value) : Number.NaN;
	return Number.isFinite(n) ? n : fallback;
}

function bool(value: string | undefined, fallback = false): boolean {
	if (value === undefined) {
		return fallback;
	}
	return value === '1' || value === 'true';
}

/**
 * sheetN.xml から用紙設定を読む。exceljs は pageSetup を部分的にしか読まない（fitToPage・pageOrder・
 * 用紙コードが欠ける）ので、シートの XML から直接読む。
 */
export function parsePageSetup(sheetXml: string): IParadisPageSetup {
	// ユーザー設定ビュー(customSheetViews)も pageSetup/pageMargins を持ち、要素の並びでは本体より前に来る。
	// 先頭一致で拾うとそちらを読んでしまうので、この範囲を落としてから探す。
	const body = sheetXml.replace(/<customSheetViews\b[\s\S]*?<\/customSheetViews>/g, '');
	const setupTag = body.match(/<pageSetup\b[^>]*\/?>/)?.[0];
	const marginTag = body.match(/<pageMargins\b[^>]*\/?>/)?.[0];
	const fitTag = body.match(/<pageSetUpPr\b[^>]*\/?>/)?.[0];

	const paper = paperSizeToPt(setupTag ? num(attr(setupTag, 'paperSize'), 9) : 9);
	const landscape = attr(setupTag, 'orientation') === 'landscape';

	// pageMargins は inch。既定値は Excel の「標準」。
	const marginLeft = num(attr(marginTag, 'left'), 0.7) * IN_TO_PT;
	const marginRight = num(attr(marginTag, 'right'), 0.7) * IN_TO_PT;
	const marginTop = num(attr(marginTag, 'top'), 0.75) * IN_TO_PT;
	const marginBottom = num(attr(marginTag, 'bottom'), 0.75) * IN_TO_PT;

	const savedScale = attr(setupTag, 'scale');
	const scalePercent = num(savedScale, 100);
	const fitToPage = bool(attr(fitTag, 'fitToPage'));
	// fitToWidth/fitToHeight は既定 1。属性が無い＝1ページに収める指定。
	const fitToWidth = setupTag ? num(attr(setupTag, 'fitToWidth'), 1) : 1;
	const fitToHeight = setupTag ? num(attr(setupTag, 'fitToHeight'), 1) : 1;

	return {
		paperWidth: landscape ? paper.height : paper.width,
		paperHeight: landscape ? paper.width : paper.height,
		marginLeft,
		marginRight,
		marginTop,
		marginBottom,
		scale: Math.max(0.1, scalePercent / 100),
		hasSavedScale: savedScale !== undefined,
		fitToPage,
		fitToWidth,
		fitToHeight,
		pageOrder: attr(setupTag, 'pageOrder') === 'overThenDown' ? 'overThenDown' : 'downThenOver',
		landscape,
		paperName: paper.name,
	};
}

/**
 * workbook.xml の definedNames から印刷タイトル(各ページ先頭で繰り返す行)を読む。
 * 例: <definedName name="_xlnm.Print_Titles" localSheetId="0">Sheet1!$1:$3</definedName>
 */
export function parsePrintTitleRows(workbookXml: string, localSheetId: number): { from: number; to: number } | undefined {
	const defs = workbookXml.match(/<definedName\b[^>]*>[\s\S]*?<\/definedName>/g) ?? [];
	for (const def of defs) {
		if (!/name="_xlnm\.Print_Titles"/.test(def)) {
			continue;
		}
		if (num(attr(def.match(/<definedName\b[^>]*>/)?.[0], 'localSheetId'), -1) !== localSheetId) {
			continue;
		}
		const body = def.replace(/<\/?definedName[^>]*>/g, '');
		// 行の繰り返しは "$1:$3"。列の繰り返し("$A:$B")は別枠なので行だけ拾う。
		const rows = body.match(/\$(\d+):\$(\d+)/);
		if (rows) {
			return { from: Number.parseInt(rows[1], 10), to: Number.parseInt(rows[2], 10) };
		}
	}
	return undefined;
}

function sum(values: readonly number[]): number {
	let total = 0;
	for (const v of values) {
		total += v;
	}
	return total;
}

/**
 * 大きさの並びを「1ページに載る量」で区切る。手動改ページがあればそこで必ず切る。
 * @param usableFirst 先頭ページで使える大きさ
 * @param usableRest 2ページ目以降で使える大きさ(印刷タイトルの繰り返し分だけ小さくなる)
 */
function splitBands(
	sizes: readonly number[],
	min: number,
	manualBreaks: ReadonlySet<number>,
	usableFirst: number,
	usableRest: number,
): IParadisPageBand[] {
	const bands: IParadisPageBand[] = [];
	if (sizes.length === 0) {
		return bands;
	}
	let start = min;
	let used = 0;
	let usable = usableFirst;
	const close = (last: number, manual: boolean) => {
		bands.push({ from: start, to: last, manual, size: used });
		start = last + 1;
		used = 0;
		usable = usableRest;
	};

	for (let i = 0; i < sizes.length; i++) {
		const index = min + i;
		const size = sizes[i];
		// 1行(1列)だけで用紙を超える場合は、その1行だけで1ページにする(無限に切らない)。
		if (used > 0 && used + size > usable) {
			close(index - 1, false);
		}
		used += size;
		if (manualBreaks.has(index)) {
			close(index, true);
		}
	}
	if (start <= min + sizes.length - 1) {
		bands.push({ from: start, to: min + sizes.length - 1, manual: false, size: used });
	}
	return bands;
}

/** 用紙設定と行・列の大きさから、Excel の改ページプレビューと同じページ割りを求める。 */
export function computePageLayout(input: IParadisPageLayoutInput): IParadisPageLayout {
	const { setup, rowHeights, colWidths, minRow, minCol } = input;
	const usableWidth = Math.max(1, setup.paperWidth - setup.marginLeft - setup.marginRight);
	const usableHeight = Math.max(1, setup.paperHeight - setup.marginTop - setup.marginBottom);

	// 印刷タイトルの繰り返し行(2ページ目以降で毎回消費される高さ)。
	let repeatHeight = 0;
	if (setup.repeatRowsFrom !== undefined && setup.repeatRowsTo !== undefined) {
		for (let r = setup.repeatRowsFrom; r <= setup.repeatRowsTo; r++) {
			const i = r - minRow;
			if (i >= 0 && i < rowHeights.length) {
				repeatHeight += rowHeights[i];
			}
		}
	}

	const totalWidth = sum(colWidths);
	const totalHeight = sum(rowHeights);

	// 「n ページに収める」指定があるときは、そこから実効倍率を求める(拡大はしない)。
	// Excel は fitToPage でも実際に使った倍率を pageSetup/@scale へ書き戻すことが多く、その値は
	// こちらの再計算(列幅の丸めや使用範囲の取り方で数%ずれる)より正確なので、両方求めて小さい方を採る。
	// 「収める」を後から付けたブックでは @scale に手動時代の倍率(多くは 100%)が残っているだけなので、
	// 保存値だけを信じると縮小が効かない。
	let effectiveScale = setup.scale;
	if (setup.fitToPage) {
		const candidates: number[] = [];
		if (setup.fitToWidth > 0 && totalWidth > 0) {
			candidates.push((usableWidth * setup.fitToWidth) / totalWidth);
		}
		if (setup.fitToHeight > 0 && totalHeight > 0) {
			candidates.push((usableHeight * setup.fitToHeight) / Math.max(1, totalHeight + repeatHeight * (setup.fitToHeight - 1)));
		}
		if (candidates.length > 0) {
			const fitted = Math.min(1, Math.min(...candidates));
			effectiveScale = setup.hasSavedScale ? Math.min(setup.scale, fitted) : fitted;
		}
	}

	// 倍率は「用紙側を広げる」形で織り込む(シート座標のまま敷き詰められる)。
	const rowUsableFirst = usableHeight / effectiveScale;
	const rowUsableRest = Math.max(1, (usableHeight / effectiveScale) - repeatHeight);
	const colUsable = usableWidth / effectiveScale;

	const rowBands = splitBands(rowHeights, minRow, new Set(input.manualRowBreaks), rowUsableFirst, rowUsableRest);
	const colBands = splitBands(colWidths, minCol, new Set(input.manualColBreaks), colUsable, colUsable);

	const autoRowBreaks: number[] = [];
	for (const band of rowBands) {
		if (!band.manual && band.to < minRow + rowHeights.length - 1) {
			autoRowBreaks.push(band.to);
		}
	}
	const autoColBreaks: number[] = [];
	for (const band of colBands) {
		if (!band.manual && band.to < minCol + colWidths.length - 1) {
			autoColBreaks.push(band.to);
		}
	}

	// ページ番号は既定で「上から下、次に右」。
	const pageNumbers: number[][] = rowBands.map(() => colBands.map(() => 0));
	let page = 1;
	if (setup.pageOrder === 'overThenDown') {
		for (let r = 0; r < rowBands.length; r++) {
			for (let c = 0; c < colBands.length; c++) {
				pageNumbers[r][c] = page++;
			}
		}
	} else {
		for (let c = 0; c < colBands.length; c++) {
			for (let r = 0; r < rowBands.length; r++) {
				pageNumbers[r][c] = page++;
			}
		}
	}

	return {
		rowBands,
		colBands,
		autoRowBreaks,
		autoColBreaks,
		pageNumbers,
		pageCount: Math.max(0, rowBands.length * colBands.length),
		effectiveScale,
		usableWidth,
		usableHeight,
	};
}

/** ページ番号の透かしの文言。ビューア/差分で共有する(diff からも参照されるため common に置く)。 */
export function pageLabelText(page: number): string {
	return localize('paradis.spreadsheet.pageLabel', "{0} ページ", page);
}
