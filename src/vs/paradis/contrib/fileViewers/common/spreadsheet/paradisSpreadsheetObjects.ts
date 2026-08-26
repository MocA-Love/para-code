/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import type { ParadisOfficeFingerprint } from '../paradisOfficeProtocol.js';
import type { ParadisSemanticSheet, ParadisSpreadsheetPartSource } from './paradisSpreadsheetSemantic.js';

export interface ParadisSpreadsheetDrawingMarker {
	readonly column: number;
	readonly columnOffset: number;
	readonly row: number;
	readonly rowOffset: number;
}

export type ParadisSpreadsheetDrawingAnchor =
	| {
		readonly kind: 'twoCell';
		readonly editAs?: 'absolute' | 'oneCell' | 'twoCell';
		readonly from: ParadisSpreadsheetDrawingMarker;
		readonly to: ParadisSpreadsheetDrawingMarker;
	}
	| {
		readonly kind: 'oneCell';
		readonly from: ParadisSpreadsheetDrawingMarker;
		readonly extent: ParadisSpreadsheetDrawingExtent;
	}
	| {
		readonly kind: 'absolute';
		readonly position: ParadisSpreadsheetDrawingPosition;
		readonly extent: ParadisSpreadsheetDrawingExtent;
	};

export interface ParadisSpreadsheetDrawingPosition {
	readonly x: number;
	readonly y: number;
}

export interface ParadisSpreadsheetDrawingExtent {
	readonly cx: number;
	readonly cy: number;
}

export interface ParadisSpreadsheetDrawingTransform {
	readonly offset?: ParadisSpreadsheetDrawingPosition;
	readonly extent?: ParadisSpreadsheetDrawingExtent;
	readonly rotation?: number;
	readonly flipHorizontal?: boolean;
	readonly flipVertical?: boolean;
}

export interface ParadisSpreadsheetDrawingLineStyle {
	readonly width?: number;
	readonly color?: string;
}

export interface ParadisSpreadsheetImageCrop {
	readonly left?: number;
	readonly top?: number;
	readonly right?: number;
	readonly bottom?: number;
}

export interface ParadisSpreadsheetImage {
	readonly id: string;
	readonly kind: 'image';
	readonly name?: string;
	readonly description?: string;
	readonly title?: string;
	readonly source: ParadisSpreadsheetPartSource;
	readonly anchor: ParadisSpreadsheetDrawingAnchor;
	readonly transform?: ParadisSpreadsheetDrawingTransform;
	readonly crop?: ParadisSpreadsheetImageCrop;
	readonly line?: ParadisSpreadsheetDrawingLineStyle;
	readonly content: ParadisSpreadsheetEmbeddedImageContent | ParadisSpreadsheetExternalImageContent;
}

export interface ParadisSpreadsheetEmbeddedImageContent {
	readonly contentType: string;
	readonly fingerprint: ParadisOfficeFingerprint;
}

export interface ParadisSpreadsheetExternalImageContent {
	readonly targetScheme?: string;
	readonly targetFingerprint: ParadisOfficeFingerprint;
	readonly behavior: 'notFetched';
}

export interface ParadisSpreadsheetCellAnchoredLineGeometry {
	readonly kind: 'cellAnchored';
	/** Exact DrawingML marker values. No cell-to-pixel conversion is performed. */
	readonly start: ParadisSpreadsheetDrawingMarker;
	readonly end: ParadisSpreadsheetDrawingMarker;
	readonly diagonal: 'up' | 'down' | 'horizontal' | 'vertical';
}

export interface ParadisSpreadsheetAbsoluteLineGeometry {
	readonly kind: 'absolute';
	/** Exact position and extent values. The parser does not synthesize shifted endpoints. */
	readonly start: ParadisSpreadsheetDrawingPosition;
	readonly extent: ParadisSpreadsheetDrawingExtent;
	readonly diagonal: 'up' | 'down' | 'horizontal' | 'vertical';
}

export interface ParadisSpreadsheetCellAnchoredExtentLineGeometry {
	readonly kind: 'cellAnchoredExtent';
	/** Exact one-cell marker plus extent. No absolute-position conversion is performed. */
	readonly start: ParadisSpreadsheetDrawingMarker;
	readonly extent: ParadisSpreadsheetDrawingExtent;
	readonly diagonal: 'up' | 'down' | 'horizontal' | 'vertical';
}

export interface ParadisSpreadsheetDrawing {
	readonly id: string;
	readonly kind: 'shape' | 'line';
	readonly name?: string;
	readonly description?: string;
	readonly title?: string;
	readonly source: ParadisSpreadsheetPartSource;
	readonly anchor: ParadisSpreadsheetDrawingAnchor;
	readonly presetGeometry?: string;
	readonly transform?: ParadisSpreadsheetDrawingTransform;
	readonly line?: ParadisSpreadsheetDrawingLineStyle;
	readonly lineGeometry?: ParadisSpreadsheetCellAnchoredLineGeometry | ParadisSpreadsheetCellAnchoredExtentLineGeometry | ParadisSpreadsheetAbsoluteLineGeometry;
}

export interface ParadisSpreadsheetOpaqueDrawing {
	readonly id: string;
	readonly kind: 'opaqueDrawing';
	readonly source: ParadisSpreadsheetPartSource;
	readonly anchor: ParadisSpreadsheetDrawingAnchor;
	readonly fingerprint: ParadisOfficeFingerprint;
	readonly evaluation: 'notEvaluated';
}

export interface ParadisSpreadsheetChartCachePoint {
	readonly index: number;
	readonly value: string;
}

export interface ParadisSpreadsheetChartStringData {
	readonly formula?: string;
	readonly formulaFingerprint?: ParadisOfficeFingerprint;
	readonly evaluation?: 'notEvaluated';
	readonly cache: readonly ParadisSpreadsheetChartCachePoint[];
}

export interface ParadisSpreadsheetChartNumberData extends ParadisSpreadsheetChartStringData {
	readonly formatCode?: string;
}

export interface ParadisSpreadsheetChartSeries {
	readonly index: number;
	readonly order: number;
	readonly name?: ParadisSpreadsheetChartStringData;
	readonly categories?: ParadisSpreadsheetChartStringData;
	readonly values?: ParadisSpreadsheetChartNumberData;
	readonly xValues?: ParadisSpreadsheetChartNumberData;
	readonly yValues?: ParadisSpreadsheetChartNumberData;
}

export interface ParadisSpreadsheetChart {
	readonly id: string;
	readonly kind: 'chart';
	readonly name?: string;
	readonly source: ParadisSpreadsheetPartSource;
	readonly chartSource: ParadisSpreadsheetPartSource;
	readonly anchor: ParadisSpreadsheetDrawingAnchor;
	readonly title?: string;
	readonly chartType: 'area' | 'bar' | 'line' | 'pie' | 'scatter' | 'unsupported';
	readonly series: readonly ParadisSpreadsheetChartSeries[];
	readonly evaluation: 'savedCacheOnly' | 'notEvaluated';
	readonly opaqueFingerprint?: ParadisOfficeFingerprint;
}

export type ParadisSpreadsheetPivotValue =
	| { readonly kind: 'string'; readonly value: string }
	| { readonly kind: 'number'; readonly value: string }
	| { readonly kind: 'boolean'; readonly value: boolean }
	| { readonly kind: 'date'; readonly value: string }
	| { readonly kind: 'error'; readonly value: string }
	| { readonly kind: 'sharedItemIndex'; readonly index: number }
	| { readonly kind: 'missing' };

export type ParadisSpreadsheetPivotSource =
	| { readonly kind: 'worksheet'; readonly sheet?: string; readonly ref?: string; readonly name?: string }
	| { readonly kind: 'external'; readonly relationshipFingerprint?: ParadisOfficeFingerprint; readonly evaluation: 'notEvaluated' }
	| { readonly kind: 'consolidation' | 'scenario' | 'unknown'; readonly evaluation: 'notEvaluated' };

export interface ParadisSpreadsheetPivotCacheField {
	readonly name: string;
	readonly databaseField?: boolean;
	readonly sharedItems: readonly ParadisSpreadsheetPivotValue[];
}

export interface ParadisSpreadsheetPivotCache {
	readonly sourcePart: ParadisSpreadsheetPartSource;
	readonly recordsSource?: ParadisSpreadsheetPartSource;
	readonly source: ParadisSpreadsheetPivotSource;
	readonly fields: readonly ParadisSpreadsheetPivotCacheField[];
	readonly records: readonly (readonly ParadisSpreadsheetPivotValue[])[];
	readonly recordCount?: number;
}

export interface ParadisSpreadsheetPivot {
	readonly id: string;
	readonly kind: 'pivot';
	readonly name: string;
	readonly source: ParadisSpreadsheetPartSource;
	readonly cacheId: number;
	readonly location?: string;
	readonly placements: {
		readonly rows: readonly number[];
		readonly columns: readonly number[];
		readonly pages: readonly { readonly field: number; readonly item?: number; readonly name?: string }[];
		readonly data: readonly { readonly field: number; readonly name?: string; readonly subtotal?: string }[];
	};
	readonly cache: ParadisSpreadsheetPivotCache;
	readonly refresh: 'notPerformed';
}

export interface ParadisSpreadsheetProtectionCredential {
	readonly algorithm?: string;
	readonly spinCount?: number;
	readonly saltFingerprint?: ParadisOfficeFingerprint;
	readonly hashFingerprint?: ParadisOfficeFingerprint;
	readonly legacyPasswordFingerprint?: ParadisOfficeFingerprint;
	readonly legacyRevisionPasswordFingerprint?: ParadisOfficeFingerprint;
}

export interface ParadisSpreadsheetWorkbookProtection {
	readonly lockStructure?: boolean;
	readonly lockWindows?: boolean;
	readonly lockRevision?: boolean;
	readonly credential?: ParadisSpreadsheetProtectionCredential;
}

export interface ParadisSpreadsheetSheetProtection {
	readonly source: ParadisSpreadsheetPartSource;
	readonly sheet?: boolean;
	readonly objects?: boolean;
	readonly scenarios?: boolean;
	readonly formatCells?: boolean;
	readonly formatColumns?: boolean;
	readonly formatRows?: boolean;
	readonly insertColumns?: boolean;
	readonly insertRows?: boolean;
	readonly insertHyperlinks?: boolean;
	readonly deleteColumns?: boolean;
	readonly deleteRows?: boolean;
	readonly selectLockedCells?: boolean;
	readonly sort?: boolean;
	readonly autoFilter?: boolean;
	readonly pivotTables?: boolean;
	readonly selectUnlockedCells?: boolean;
	readonly credential?: ParadisSpreadsheetProtectionCredential;
}

export interface ParadisSpreadsheetUnsafePart {
	readonly kind: 'vba' | 'ole' | 'activeX' | 'connection' | 'signature' | 'embeddedPackage';
	readonly contentType: string;
	readonly fingerprint: ParadisOfficeFingerprint;
	readonly behavior: 'notExecuted' | 'notEvaluated';
}

export interface ParadisSpreadsheetExternalReference {
	readonly relationshipType: string;
	readonly targetScheme?: string;
	readonly targetFingerprint: ParadisOfficeFingerprint;
	readonly behavior: 'notFetched';
}

export interface ParadisSpreadsheetOpaqueObjectPart {
	readonly contentType: string;
	readonly fingerprint: ParadisOfficeFingerprint;
	readonly evaluation: 'notEvaluated';
}

export interface ParadisSpreadsheetObjectSecurity {
	readonly workbookProtection?: ParadisSpreadsheetWorkbookProtection;
	readonly sheetProtections: readonly ParadisSpreadsheetSheetProtection[];
	readonly unsafeParts: readonly ParadisSpreadsheetUnsafePart[];
	readonly externalReferences: readonly ParadisSpreadsheetExternalReference[];
}

export interface ParadisSpreadsheetObjects {
	readonly images: readonly ParadisSpreadsheetImage[];
	readonly drawings: readonly ParadisSpreadsheetDrawing[];
	readonly charts: readonly ParadisSpreadsheetChart[];
	readonly opaqueDrawings: readonly ParadisSpreadsheetOpaqueDrawing[];
	readonly pivots: readonly ParadisSpreadsheetPivot[];
	readonly security: ParadisSpreadsheetObjectSecurity;
	readonly opaqueParts: readonly ParadisSpreadsheetOpaqueObjectPart[];
}

export interface ParadisSemanticSheetWithObjects extends ParadisSemanticSheet {
	readonly objects: ParadisSpreadsheetObjects;
}

/** Adds an object overlay without changing any Task 1 cell/style/diagonal provenance. */
export function bindSpreadsheetObjectsToSheet(sheet: ParadisSemanticSheet, objects: ParadisSpreadsheetObjects): ParadisSemanticSheetWithObjects {
	return Object.freeze({ ...sheet, objects });
}
