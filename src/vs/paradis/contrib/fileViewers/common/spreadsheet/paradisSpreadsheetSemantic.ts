/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import type { ParadisOfficeFingerprint } from '../paradisOfficeProtocol.js';

/** An all-byte identity for the OOXML Part that supplied a semantic value. */
export interface ParadisSpreadsheetPartSource {
	readonly partId: string;
	readonly fingerprint: ParadisOfficeFingerprint;
}

export type ParadisSemanticCellStoredType = 'blank' | 'number' | 'string' | 'boolean' | 'error' | 'date' | 'formula';
export type ParadisSemanticFormulaKind = 'normal' | 'shared' | 'array';
export type ParadisSemanticCachedResultType = 'number' | 'string' | 'boolean' | 'error' | 'date';

export interface ParadisSemanticFormula {
	readonly text: string;
	readonly kind: ParadisSemanticFormulaKind;
	readonly ref?: string;
	readonly sharedIndex?: number;
}

export type ParadisSemanticCachedResult =
	| { readonly present: false }
	| { readonly present: true; readonly type: ParadisSemanticCachedResultType; readonly rawValue: string };

export type ParadisSemanticRawValue =
	| { readonly present: false }
	| { readonly present: true; readonly text: string };

export interface ParadisSpreadsheetColor {
	readonly kind: 'rgb' | 'indexed' | 'theme' | 'auto';
	readonly rgb?: string;
	readonly indexed?: number;
	readonly theme?: number;
	readonly tint?: string;
	readonly auto?: boolean;
}

export interface ParadisSemanticRichTextProperties {
	readonly bold?: boolean;
	readonly italic?: boolean;
	readonly strike?: boolean;
	readonly underline?: string;
	readonly fontName?: string;
	readonly fontSize?: string;
	readonly verticalAlign?: string;
	readonly color?: ParadisSpreadsheetColor;
}

export interface ParadisSemanticRichTextRun {
	readonly text: string;
	readonly properties?: ParadisSemanticRichTextProperties;
}

/** Sparse OOXML cell identity. Display formatting and formula recalculation are deliberately absent. */
export interface ParadisSemanticCell {
	readonly storedType: ParadisSemanticCellStoredType;
	readonly rawType?: string;
	readonly rawValue?: ParadisSemanticRawValue;
	readonly text?: string;
	readonly sharedStringIndex?: number;
	readonly richText?: readonly ParadisSemanticRichTextRun[];
	readonly formula?: ParadisSemanticFormula;
	readonly cachedResult?: ParadisSemanticCachedResult;
	readonly styleRef?: number;
	readonly effectiveStyleRef?: number;
	readonly effectiveStyleOrigin?: 'cell' | 'row' | 'column' | 'default';
	readonly styleSource?: ParadisSpreadsheetPartSource;
}

export interface ParadisSemanticRow {
	readonly index: number;
	readonly height?: string;
	readonly hidden?: boolean;
	readonly customHeight?: boolean;
	readonly customFormat?: boolean;
	readonly outlineLevel?: number;
	readonly collapsed?: boolean;
	readonly thickTop?: boolean;
	readonly thickBottom?: boolean;
	readonly styleRef?: number;
}

export interface ParadisSemanticColumn {
	readonly min: number;
	readonly max: number;
	readonly width?: string;
	readonly hidden?: boolean;
	readonly customWidth?: boolean;
	readonly bestFit?: boolean;
	readonly outlineLevel?: number;
	readonly collapsed?: boolean;
	readonly styleRef?: number;
}

export interface ParadisSemanticRange {
	readonly ref: string;
	readonly minRow: number;
	readonly minColumn: number;
	readonly maxRow: number;
	readonly maxColumn: number;
}

export interface ParadisSemanticSheetSelection {
	readonly pane?: string;
	readonly activeCell?: string;
	readonly activeCellId?: number;
	readonly sqref?: string;
}

export interface ParadisSemanticSheetPane {
	readonly xSplit?: string;
	readonly ySplit?: string;
	readonly topLeftCell?: string;
	readonly activePane?: string;
	readonly state?: string;
}

export interface ParadisSemanticSheetView {
	readonly workbookViewId?: number;
	readonly showGridLines?: boolean;
	readonly showRowColHeaders?: boolean;
	readonly showZeros?: boolean;
	readonly rightToLeft?: boolean;
	readonly tabSelected?: boolean;
	readonly showRuler?: boolean;
	readonly showOutlineSymbols?: boolean;
	readonly defaultGridColor?: boolean;
	readonly view?: string;
	readonly topLeftCell?: string;
	readonly colorId?: number;
	readonly zoomScale?: number;
	readonly zoomScaleNormal?: number;
	readonly zoomScaleSheetLayoutView?: number;
	readonly zoomScalePageLayoutView?: number;
	readonly pane?: ParadisSemanticSheetPane;
	readonly selections: readonly ParadisSemanticSheetSelection[];
}

export type ParadisSemanticSheetState = 'visible' | 'hidden' | 'veryHidden';

export interface ParadisSemanticSheet {
	readonly name: string;
	readonly sheetId: string;
	readonly order: number;
	readonly state: ParadisSemanticSheetState;
	readonly relationshipId: string;
	readonly partId: string;
	readonly source: ParadisSpreadsheetPartSource;
	readonly dimension?: ParadisSemanticRange;
	readonly views: readonly ParadisSemanticSheetView[];
	readonly rows: ReadonlyMap<number, ParadisSemanticRow>;
	readonly columns: readonly ParadisSemanticColumn[];
	readonly merges: readonly ParadisSemanticRange[];
	readonly cells: ReadonlyMap<string, ParadisSemanticCell>;
}

export interface ParadisSpreadsheetCalcProperties {
	readonly calcId?: string;
	readonly calcMode?: string;
	readonly fullCalcOnLoad?: boolean;
	readonly forceFullCalc?: boolean;
	readonly calcOnSave?: boolean;
	readonly concurrentCalc?: boolean;
	readonly concurrentManualCount?: number;
	readonly fullPrecision?: boolean;
	readonly iterate?: boolean;
	readonly iterateCount?: number;
	readonly iterateDelta?: string;
	readonly refMode?: string;
	readonly calcCompleted?: boolean;
}

export interface ParadisSpreadsheetDefinedName {
	readonly name: string;
	readonly text: string;
	readonly localSheetId?: number;
	readonly hidden?: boolean;
	readonly function?: boolean;
	readonly vbProcedure?: boolean;
	readonly xlm?: boolean;
	readonly functionGroupId?: number;
	readonly shortcutKey?: string;
}

export interface ParadisSpreadsheetWorkbookView {
	readonly activeTab?: number;
	readonly firstSheet?: number;
	readonly visibility?: string;
	readonly showHorizontalScroll?: boolean;
	readonly showVerticalScroll?: boolean;
	readonly showSheetTabs?: boolean;
	readonly tabRatio?: number;
	readonly xWindow?: number;
	readonly yWindow?: number;
	readonly windowWidth?: number;
	readonly windowHeight?: number;
}

export interface ParadisSemanticBorderEdge {
	readonly style?: string;
	readonly color?: ParadisSpreadsheetColor;
}

export interface ParadisSemanticBorder {
	readonly index: number;
	readonly diagonalUp?: boolean;
	readonly diagonalDown?: boolean;
	readonly outline?: boolean;
	readonly start?: ParadisSemanticBorderEdge;
	readonly end?: ParadisSemanticBorderEdge;
	readonly left?: ParadisSemanticBorderEdge;
	readonly right?: ParadisSemanticBorderEdge;
	readonly top?: ParadisSemanticBorderEdge;
	readonly bottom?: ParadisSemanticBorderEdge;
	readonly diagonal?: ParadisSemanticBorderEdge;
	readonly vertical?: ParadisSemanticBorderEdge;
	readonly horizontal?: ParadisSemanticBorderEdge;
}

export interface ParadisSemanticCellFormat {
	readonly index: number;
	readonly numberFormatId?: number;
	readonly fontRef?: number;
	readonly fillRef?: number;
	readonly borderRef?: number;
	readonly baseStyleRef?: number;
	readonly applyNumberFormat?: boolean;
	readonly applyFont?: boolean;
	readonly applyFill?: boolean;
	readonly applyBorder?: boolean;
	readonly applyAlignment?: boolean;
	readonly applyProtection?: boolean;
	readonly quotePrefix?: boolean;
	readonly pivotButton?: boolean;
}

export interface ParadisSpreadsheetCustomNumberFormat {
	readonly id: number;
	readonly code: string;
}

export interface ParadisSpreadsheetStyleCompleteness {
	readonly declaredCellFormats?: number;
	readonly parsedCellFormats: number;
	readonly declaredBorders?: number;
	readonly parsedBorders: number;
	readonly cellsWithStyleRefs: number;
	readonly unresolvedStyleRefs: number;
	readonly cellsWithDiagonalStyleRefs: number;
}

export interface ParadisSpreadsheetStyles {
	readonly source?: ParadisSpreadsheetPartSource;
	readonly numberFormats: readonly ParadisSpreadsheetCustomNumberFormat[];
	readonly cellFormats: readonly ParadisSemanticCellFormat[];
	readonly borders: readonly ParadisSemanticBorder[];
	readonly completeness: ParadisSpreadsheetStyleCompleteness;
}

export interface ParadisSpreadsheetSemanticCompleteness {
	readonly expectedParts: number;
	readonly visitedParts: number;
	readonly parsedParts: number;
	readonly expectedSheets: number;
	readonly parsedSheets: number;
	readonly expectedCells: number;
	readonly parsedCells: number;
	readonly unknownElements: number;
	readonly unknownAttributes: number;
	readonly unresolvedReferences: number;
	readonly terminal: boolean;
}

export interface ParadisSpreadsheetProjectionDiagnostic {
	readonly kind: 'sheetMissing' | 'cellMissing' | 'valueMismatch' | 'diagonalPresenceMismatch' | 'diagonalDirectionMismatch' | 'diagonalStyleMismatch' | 'diagonalColorMismatch';
	readonly sheetName: string;
	readonly cellAddress?: string;
	readonly semanticValue?: string;
	readonly projectionValue?: string;
	readonly semanticDiagonal?: ParadisSpreadsheetDiagonalIdentity;
	readonly projectionDiagonal?: ParadisSpreadsheetDiagonalIdentity;
}

export interface ParadisSpreadsheetDiagonalIdentity {
	readonly up: boolean;
	readonly down: boolean;
	readonly style?: string;
	readonly color?: ParadisSpreadsheetColor;
}

/** Raw-OOXML-authoritative workbook state used by semantic diff and later render stages. */
export interface ParadisSpreadsheetSnapshot {
	readonly workbookSource: ParadisSpreadsheetPartSource;
	readonly date1904: boolean;
	readonly calcProperties?: ParadisSpreadsheetCalcProperties;
	readonly definedNames: readonly ParadisSpreadsheetDefinedName[];
	readonly workbookViews: readonly ParadisSpreadsheetWorkbookView[];
	readonly sheets: readonly ParadisSemanticSheet[];
	readonly styles: ParadisSpreadsheetStyles;
	readonly completeness: ParadisSpreadsheetSemanticCompleteness;
	readonly projectionDiagnostics: readonly ParadisSpreadsheetProjectionDiagnostic[];
}
