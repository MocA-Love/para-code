/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: localized diff text uses symbols)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import { localize } from '../../../../nls.js';
import type { IParadisDiffDetail } from './paradisSpreadsheetDiff.js';

const MAX_DIFF_TITLE_LENGTH = 4_096;

function detailLabel(detail: IParadisDiffDetail): string {
	switch (detail.kind) {
		case 'value': return localize('paradis.spreadsheet.diff.value', "値");
		case 'fontFamily': return localize('paradis.spreadsheet.diff.fontFamily', "フォント");
		case 'fontSize': return localize('paradis.spreadsheet.diff.fontSize', "フォントサイズ");
		case 'textAlign': return localize('paradis.spreadsheet.diff.textAlign', "横位置");
		case 'verticalAlign': return localize('paradis.spreadsheet.diff.verticalAlign', "縦位置");
		case 'fontWeight': return localize('paradis.spreadsheet.diff.fontWeight', "太さ");
		case 'fontStyle': return localize('paradis.spreadsheet.diff.fontStyle', "字体");
		case 'textDecoration': return localize('paradis.spreadsheet.diff.textDecoration', "装飾線");
		case 'color': return localize('paradis.spreadsheet.diff.color', "文字色");
		case 'backgroundColor': return localize('paradis.spreadsheet.diff.backgroundColor', "塗りつぶしの色");
		case 'borderTop': return localize('paradis.spreadsheet.diff.borderTop', "上罫線");
		case 'borderRight': return localize('paradis.spreadsheet.diff.borderRight', "右罫線");
		case 'borderBottom': return localize('paradis.spreadsheet.diff.borderBottom', "下罫線");
		case 'borderLeft': return localize('paradis.spreadsheet.diff.borderLeft', "左罫線");
		case 'paddingLeft': return localize('paradis.spreadsheet.diff.paddingLeft', "インデント");
		case 'paddingRight': return localize('paradis.spreadsheet.diff.paddingRight', "インデント");
		case 'otherStyle': return localize('paradis.spreadsheet.diff.otherStyle', "スタイル（{0}）", detail.property ?? '');
		case 'mergedColumns': return localize('paradis.spreadsheet.diff.mergedColumns', "結合列");
		case 'mergedRows': return localize('paradis.spreadsheet.diff.mergedRows', "結合行");
		case 'wrapText': return localize('paradis.spreadsheet.diff.wrapText', "折り返して全体を表示");
		case 'verticalText': return localize('paradis.spreadsheet.diff.verticalText', "縦書き");
		case 'shrinkToFit': return localize('paradis.spreadsheet.diff.shrinkToFit', "縮小して全体を表示");
		case 'richText': return localize('paradis.spreadsheet.diff.richText', "リッチテキスト");
		case 'diagonalBorder': return localize('paradis.spreadsheet.diff.diagonalBorder', "斜め罫線");
		case 'dataValidation': return localize('paradis.spreadsheet.diff.dataValidation', "データの入力規則");
		case 'object': return localize('paradis.spreadsheet.diff.object', "オブジェクト");
		case 'objectStart': return localize('paradis.spreadsheet.diff.objectStart', "オブジェクト開始位置（行:列:オフセット）");
		case 'objectEnd': return localize('paradis.spreadsheet.diff.objectEnd', "オブジェクト終了位置（行:列:オフセット）");
		case 'objectWidth': return localize('paradis.spreadsheet.diff.objectWidth', "オブジェクトの幅");
		case 'objectHeight': return localize('paradis.spreadsheet.diff.objectHeight', "オブジェクトの高さ");
		case 'objectFlipHorizontal': return localize('paradis.spreadsheet.diff.objectFlipHorizontal', "左右反転");
		case 'objectFlipVertical': return localize('paradis.spreadsheet.diff.objectFlipVertical', "上下反転");
		case 'objectType': return localize('paradis.spreadsheet.diff.objectType', "オブジェクトの種類");
		case 'objectOutlineColor': return localize('paradis.spreadsheet.diff.objectOutlineColor', "枠線の色");
		case 'objectOutlineWidth': return localize('paradis.spreadsheet.diff.objectOutlineWidth', "枠線の太さ");
		case 'objectDash': return localize('paradis.spreadsheet.diff.objectDash', "線種");
		case 'objectImage': return localize('paradis.spreadsheet.diff.objectImage', "画像（種類；サイズ；フィンガープリント）");
	}
}

function detailValue(value: string | undefined): string {
	if (value === undefined) {
		return localize('paradis.spreadsheet.diff.unset', "（未設定）");
	}
	if (value === '') {
		return localize('paradis.spreadsheet.diff.empty', "（空）");
	}
	return value;
}

export function formatDiffDetails(details: readonly IParadisDiffDetail[]): string {
	let title = '';
	for (const detail of details) {
		const line = localize(
			'paradis.spreadsheet.diff.detail',
			"{0}: {1} → {2}",
			detailLabel(detail),
			detailValue(detail.original),
			detailValue(detail.modified),
		);
		const separator = title.length === 0 ? '' : '\n';
		if (title.length + separator.length + line.length > MAX_DIFF_TITLE_LENGTH) {
			return `${title.slice(0, MAX_DIFF_TITLE_LENGTH - 1)}…`;
		}
		title += separator + line;
	}
	return title;
}
