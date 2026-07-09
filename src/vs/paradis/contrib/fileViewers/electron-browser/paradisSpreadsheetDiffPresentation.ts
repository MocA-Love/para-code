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
		case 'value': return localize('paradis.spreadsheet.diff.value', "Value");
		case 'fontFamily': return localize('paradis.spreadsheet.diff.fontFamily', "Font");
		case 'fontSize': return localize('paradis.spreadsheet.diff.fontSize', "Font Size");
		case 'textAlign': return localize('paradis.spreadsheet.diff.textAlign', "Horizontal Alignment");
		case 'verticalAlign': return localize('paradis.spreadsheet.diff.verticalAlign', "Vertical Alignment");
		case 'fontWeight': return localize('paradis.spreadsheet.diff.fontWeight', "Font Weight");
		case 'fontStyle': return localize('paradis.spreadsheet.diff.fontStyle', "Font Style");
		case 'textDecoration': return localize('paradis.spreadsheet.diff.textDecoration', "Text Decoration");
		case 'color': return localize('paradis.spreadsheet.diff.color', "Font Color");
		case 'backgroundColor': return localize('paradis.spreadsheet.diff.backgroundColor', "Fill Color");
		case 'borderTop': return localize('paradis.spreadsheet.diff.borderTop', "Top Border");
		case 'borderRight': return localize('paradis.spreadsheet.diff.borderRight', "Right Border");
		case 'borderBottom': return localize('paradis.spreadsheet.diff.borderBottom', "Bottom Border");
		case 'borderLeft': return localize('paradis.spreadsheet.diff.borderLeft', "Left Border");
		case 'paddingLeft': return localize('paradis.spreadsheet.diff.paddingLeft', "Indent");
		case 'otherStyle': return localize('paradis.spreadsheet.diff.otherStyle', "Style ({0})", detail.property ?? '');
		case 'mergedColumns': return localize('paradis.spreadsheet.diff.mergedColumns', "Merged Columns");
		case 'mergedRows': return localize('paradis.spreadsheet.diff.mergedRows', "Merged Rows");
		case 'wrapText': return localize('paradis.spreadsheet.diff.wrapText', "Wrap Text");
		case 'verticalText': return localize('paradis.spreadsheet.diff.verticalText', "Vertical Text");
		case 'shrinkToFit': return localize('paradis.spreadsheet.diff.shrinkToFit', "Shrink to Fit");
		case 'richText': return localize('paradis.spreadsheet.diff.richText', "Rich Text");
		case 'diagonalBorder': return localize('paradis.spreadsheet.diff.diagonalBorder', "Diagonal Border");
		case 'object': return localize('paradis.spreadsheet.diff.object', "Object");
		case 'objectStart': return localize('paradis.spreadsheet.diff.objectStart', "Object Start (Row:Column:Offsets)");
		case 'objectEnd': return localize('paradis.spreadsheet.diff.objectEnd', "Object End (Row:Column:Offsets)");
		case 'objectWidth': return localize('paradis.spreadsheet.diff.objectWidth', "Object Width");
		case 'objectHeight': return localize('paradis.spreadsheet.diff.objectHeight', "Object Height");
		case 'objectFlipHorizontal': return localize('paradis.spreadsheet.diff.objectFlipHorizontal', "Object Flipped Horizontally");
		case 'objectFlipVertical': return localize('paradis.spreadsheet.diff.objectFlipVertical', "Object Flipped Vertically");
		case 'objectType': return localize('paradis.spreadsheet.diff.objectType', "Object Type");
		case 'objectOutlineColor': return localize('paradis.spreadsheet.diff.objectOutlineColor', "Object Outline Color");
		case 'objectOutlineWidth': return localize('paradis.spreadsheet.diff.objectOutlineWidth', "Object Outline Width");
		case 'objectDash': return localize('paradis.spreadsheet.diff.objectDash', "Object Dash");
		case 'objectImage': return localize('paradis.spreadsheet.diff.objectImage', "Object Image (Type; Size; Fingerprint)");
	}
}

function detailValue(value: string | undefined): string {
	if (value === undefined) {
		return localize('paradis.spreadsheet.diff.unset', "(unset)");
	}
	if (value === '') {
		return localize('paradis.spreadsheet.diff.empty', "(empty)");
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
