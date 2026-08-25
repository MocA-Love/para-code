/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import type { CancellationToken } from '../../../../../base/common/cancellation.js';
import { StopWatch } from '../../../../../base/common/stopwatch.js';
import {
	PARADIS_OFFICE_BUDGET_PROFILES,
	type ParadisOfficeBudgetProfile,
	type ParadisOfficeFingerprint,
	type ParadisOfficeInventory,
	type ParadisOfficeInventoryPart,
} from '../paradisOfficeProtocol.js';
import {
	canonicalizeParadisOfficeArchiveName,
	type IParadisOfficeArchive,
	type ParadisOfficeArchiveEntry,
	type ParadisOfficeXmlDocument,
	type ParadisOfficeXmlNode,
	ParadisOfficePackageError,
	throwIfParadisOfficeCancelled,
} from '../office/paradisOfficeArchive.js';
import { diagnoseSpreadsheetProjection, type IParadisCellData, type IParadisCellStyle, type IParadisDiagonalBorder, type IParadisRowData, type IParadisSheetData, type IParadisWorkbookData } from '../paradisSpreadsheet.js';
import { formatPreparedSpreadsheetValue, formatSpreadsheetValue, prepareSpreadsheetNumberFormat, type ParadisFormattedCellValue, type ParadisSpreadsheetNumberFormatContext, type ParadisSpreadsheetPreparedNumberFormat } from './paradisSpreadsheetNumberFormat.js';
import type {
	ParadisSemanticBorder,
	ParadisSemanticBorderEdge,
	ParadisSemanticCachedResultType,
	ParadisSemanticCell,
	ParadisSemanticCellFormat,
	ParadisSemanticColumn,
	ParadisSemanticFormula,
	ParadisSemanticRange,
	ParadisSemanticRichTextProperties,
	ParadisSemanticRichTextRun,
	ParadisSemanticRow,
	ParadisSemanticSheet,
	ParadisSemanticSheetPane,
	ParadisSemanticSheetSelection,
	ParadisSemanticSheetState,
	ParadisSemanticSheetView,
	ParadisSpreadsheetCalcProperties,
	ParadisSpreadsheetColor,
	ParadisSpreadsheetCustomNumberFormat,
	ParadisSpreadsheetDefinedName,
	ParadisSpreadsheetPartSource,
	ParadisSpreadsheetSnapshot,
	ParadisSpreadsheetStyles,
	ParadisSpreadsheetWorkbookView,
} from './paradisSpreadsheetSemantic.js';

type XmlElement = Extract<ParadisOfficeXmlNode, { readonly kind: 'element' }>;

const spreadsheetNamespaces = new Set([
	'http://schemas.openxmlformats.org/spreadsheetml/2006/main',
	'http://purl.oclc.org/ooxml/spreadsheetml/main',
]);
const relationshipNamespaces = new Set([
	'http://schemas.openxmlformats.org/officeDocument/2006/relationships',
	'http://purl.oclc.org/ooxml/officeDocument/relationships',
]);
const officeDocumentRelationships = new Set([
	'http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument',
	'http://purl.oclc.org/ooxml/officeDocument/relationships/officeDocument',
]);
const worksheetRelationships = new Set([
	'http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet',
	'http://purl.oclc.org/ooxml/officeDocument/relationships/worksheet',
]);
const stylesRelationships = new Set([
	'http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles',
	'http://purl.oclc.org/ooxml/officeDocument/relationships/styles',
]);
const sharedStringsRelationships = new Set([
	'http://schemas.openxmlformats.org/officeDocument/2006/relationships/sharedStrings',
	'http://purl.oclc.org/ooxml/officeDocument/relationships/sharedStrings',
]);
const xmlNamespace = 'http://www.w3.org/XML/1998/namespace';
const packageRelationshipNamespaces = new Set([
	'http://schemas.openxmlformats.org/package/2006/relationships',
	'http://purl.oclc.org/ooxml/package/relationships',
]);
const packageContentTypeNamespaces = new Set([
	'http://schemas.openxmlformats.org/package/2006/content-types',
	'http://purl.oclc.org/ooxml/package/content-types',
]);
const contentTypesPartId = '/[Content_Types].xml';
const relationshipContentTypes = new Set(['application/vnd.openxmlformats-package.relationships+xml']);
const maximumExcelRows = 1_048_576;
const maximumExcelColumns = 16_384;
const worksheetContentTypes = new Set([
	'application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml',
	'application/vnd.ms-excel.worksheet+xml',
]);
const stylesContentTypes = new Set([
	'application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml',
	'application/vnd.ms-excel.styles+xml',
]);
const sharedStringsContentTypes = new Set([
	'application/vnd.openxmlformats-officedocument.spreadsheetml.sharedStrings+xml',
	'application/vnd.ms-excel.sharedStrings+xml',
]);
const workbookContentTypes: Readonly<Record<Extract<ParadisOfficeInventory['format'], 'xlsx' | 'xlsm' | 'xltx' | 'xltm'>, ReadonlySet<string>>> = {
	xlsx: new Set([
		'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml',
		'application/vnd.ms-excel.sheet.main+xml',
	]),
	xlsm: new Set(['application/vnd.ms-excel.sheet.macroEnabled.main+xml']),
	xltx: new Set([
		'application/vnd.openxmlformats-officedocument.spreadsheetml.template.main+xml',
		'application/vnd.ms-excel.template.main+xml',
	]),
	xltm: new Set(['application/vnd.ms-excel.template.macroEnabled.main+xml']),
};

export interface ParadisSpreadsheetSemanticLimits {
	readonly sheets: number;
	readonly cells: number;
	readonly projectionSheets: number;
	readonly projectionRows: number;
	readonly projectionCells: number;
	readonly rows: number;
	readonly columns: number;
	readonly merges: number;
	readonly definedNames: number;
	readonly sharedStrings: number;
}

export interface ParadisSpreadsheetSemanticParseOptions {
	readonly projection?: IParadisWorkbookData;
	readonly limits?: Partial<ParadisSpreadsheetSemanticLimits>;
	readonly now?: () => number;
	readonly deadlineMilliseconds?: number;
	readonly workbookLocale?: string;
	readonly applicationLocale?: string;
}

export interface ParadisSpreadsheetOwnedSemanticInput {
	readonly inventory: ParadisOfficeInventory;
	readonly options: ParadisSpreadsheetSemanticParseOptions;
}

export interface ParadisSpreadsheetRenderFormatDiagnostic extends ParadisFormattedCellValue {
	readonly sheetName: string;
	readonly cellAddress: string;
}

export interface ParadisSpreadsheetFormattedRenderProjection {
	readonly projection: IParadisWorkbookData;
	/** Projection diagnostics are captured against the raw projection before display formatting. */
	readonly diagnostics: ParadisSpreadsheetSnapshot['projectionDiagnostics'];
	readonly formatDiagnostics: readonly ParadisSpreadsheetRenderFormatDiagnostic[];
	readonly formatDiagnosticsTruncated: boolean;
}

export interface ParadisSpreadsheetRenderProjectionLimits {
	readonly sheets: number;
	readonly rows: number;
	readonly cells: number;
	readonly formatDiagnostics: number;
	readonly inputCharacters: number;
	readonly inputUtf8Bytes: number;
	readonly outputCharacters: number;
	readonly outputUtf8Bytes: number;
	readonly diagnosticCharacters: number;
	readonly diagnosticUtf8Bytes: number;
	readonly parsedFormats: number;
	readonly parsedFormatCharacters: number;
}

export interface ParadisSpreadsheetSemanticResult extends ParadisSpreadsheetSnapshot {
	readonly renderProjection?: IParadisWorkbookData;
	readonly renderFormatDiagnostics?: readonly ParadisSpreadsheetRenderFormatDiagnostic[];
	readonly renderFormatDiagnosticsTruncated?: boolean;
}

interface ParadisSpreadsheetRenderSemanticInput {
	readonly date1904: boolean;
	readonly projectionDiagnostics: ParadisSpreadsheetSnapshot['projectionDiagnostics'];
	readonly sheets: readonly {
		readonly name: string;
		readonly order: number;
		readonly cells: ReadonlyMap<string, ParadisSemanticCell>;
	}[];
	readonly styles: Pick<ParadisSpreadsheetStyles, 'numberFormats' | 'cellFormats'>;
}

const defaultRenderProjectionLimits: ParadisSpreadsheetRenderProjectionLimits = {
	sheets: 65_535,
	rows: 5_000_000,
	cells: 5_000_000,
	formatDiagnostics: 10_000,
	inputCharacters: 64 * 1024 * 1024,
	inputUtf8Bytes: 128 * 1024 * 1024,
	outputCharacters: 64 * 1024 * 1024,
	outputUtf8Bytes: 128 * 1024 * 1024,
	diagnosticCharacters: 4 * 1024 * 1024,
	diagnosticUtf8Bytes: 8 * 1024 * 1024,
	parsedFormats: 4096,
	parsedFormatCharacters: 4 * 1024 * 1024,
};

/**
 * Builds a display-only projection. Raw cell identity, formula/cache fields, style refs, borders,
 * diagonal provenance, and the diagnostics established against the raw projection are untouched.
 */
export function formatSpreadsheetRenderProjection(
	snapshot: ParadisSpreadsheetSnapshot,
	projection: IParadisWorkbookData,
	context: ParadisSpreadsheetNumberFormatContext = {},
	limitOverrides: Partial<ParadisSpreadsheetRenderProjectionLimits> = {},
): ParadisSpreadsheetFormattedRenderProjection {
	try {
		const ownedContext = ownRenderFormatContext(context, false);
		const limits = resolveRenderProjectionLimits(limitOverrides);
		const operation = createRenderProjectionOperation(ownedContext, limits);
		operation.checkpoint(true);
		const ownershipBudget = new OwnershipBudget(() => operation.checkpoint());
		const semanticLimits = resolveSpreadsheetSemanticLimits({
			projectionSheets: limits.sheets,
			projectionRows: limits.rows,
			projectionCells: limits.cells,
		});
		const projections = snapshotProjection(projection, semanticLimits, () => operation.checkpoint(), ownershipBudget, limits);
		const ownedSnapshot = snapshotStandaloneRenderSemanticSnapshot(snapshot, ownershipBudget, limits);
		return formatOwnedSpreadsheetRenderProjection(
			ownedSnapshot,
			projections.render,
			ownedContext,
			limits,
			operation,
			{ characters: projections.renderCharacters, utf8Bytes: projections.renderUtf8Bytes },
		);
	} catch (error) {
		throw sanitizeSpreadsheetPackageError(error, 'unsafe');
	}
}

interface RenderProjectionOperation {
	readonly context: ParadisSpreadsheetNumberFormatContext;
	readonly limits: ParadisSpreadsheetRenderProjectionLimits;
	readonly checkpoint: (force?: boolean) => void;
}

function createRenderProjectionOperation(
	context: ParadisSpreadsheetNumberFormatContext,
	limits: ParadisSpreadsheetRenderProjectionLimits,
): RenderProjectionOperation {
	const now = context.now ?? Date.now;
	const deadlineMilliseconds = context.deadlineMilliseconds ?? 60_000;
	const hardDeadline = StopWatch.create(true);
	const started = readMonotonicClock(now);
	let lastClock = started;
	let checkpointCount = 0;
	return {
		context,
		limits,
		checkpoint: (force = false): void => {
			checkpointCount++;
			if (!force && checkpointCount % 128 !== 0) {
				return;
			}
			try {
				throwIfParadisOfficeCancelled(context.cancellationToken);
			} catch (error) {
				throw sanitizeSpreadsheetPackageError(error, 'unsafe');
			}
			if (hardDeadline.elapsed() > deadlineMilliseconds) {
				throw new ParadisOfficePackageError('limitExceeded');
			}
			const currentClock = readMonotonicClock(now);
			if (currentClock < lastClock) {
				throw new ParadisOfficePackageError('unsafe');
			}
			lastClock = currentClock;
			if (currentClock - started > deadlineMilliseconds) {
				throw new ParadisOfficePackageError('limitExceeded');
			}
		},
	};
}

function formatOwnedSpreadsheetRenderProjection(
	snapshot: ParadisSpreadsheetRenderSemanticInput,
	projection: IParadisWorkbookData,
	context: ParadisSpreadsheetNumberFormatContext = {},
	limitOverrides: Partial<ParadisSpreadsheetRenderProjectionLimits> = {},
	ownedOperation?: RenderProjectionOperation,
	initialProjectionBudget: { readonly characters: number; readonly utf8Bytes: number } = { characters: 0, utf8Bytes: 0 },
): ParadisSpreadsheetFormattedRenderProjection {
	const diagnostics = snapshot.projectionDiagnostics;
	const formatContext = ownRenderFormatContext(ownedOperation?.context ?? context, snapshot.date1904);
	// Validate/copy the formatter boundary, and observe cancellation before any projection traversal.
	formatSpreadsheetValue(null, 0, formatContext);
	const limits = ownedOperation?.limits ?? resolveRenderProjectionLimits(limitOverrides);
	const operation = ownedOperation ?? createRenderProjectionOperation(formatContext, limits);
	const checkpoint = operation.checkpoint;
	checkpoint(true);
	const formatDiagnostics: ParadisSpreadsheetRenderFormatDiagnostic[] = [];
	const preparedFormats = new Map<number | string, ParadisSpreadsheetPreparedNumberFormat>();
	let formatDiagnosticsTruncated = false;
	let sheetCount = 0;
	let rowCount = 0;
	let cellCount = 0;
	let inputCharacters = initialProjectionBudget.characters;
	let inputUtf8Bytes = initialProjectionBudget.utf8Bytes;
	let outputCharacters = initialProjectionBudget.characters;
	let outputUtf8Bytes = initialProjectionBudget.utf8Bytes;
	let diagnosticCharacters = 0;
	let diagnosticUtf8Bytes = 0;
	let parsedFormatCharacters = 0;
	const semanticSheetsByName = new Map(snapshot.sheets.map(sheet => [sheet.name, sheet]));
	const sheets = projection.sheets.map((sheet, sheetIndex): IParadisSheetData => {
		checkpoint();
		if (++sheetCount > limits.sheets) {
			throw new ParadisOfficePackageError('limitExceeded');
		}
		const semanticSheet = snapshot.sheets[sheetIndex]?.name === sheet.name ? snapshot.sheets[sheetIndex] : semanticSheetsByName.get(sheet.name);
		if (!semanticSheet) {
			return sheet;
		}
		let sheetChanged = false;
		const rows = sheet.rows.map((row): IParadisRowData => {
			checkpoint();
			if (++rowCount > limits.rows) {
				throw new ParadisOfficePackageError('limitExceeded');
			}
			let rowChanged = false;
			const cells = row.cells.map((cell, cellIndex): IParadisCellData => {
				checkpoint();
				if (++cellCount > limits.cells) {
					throw new ParadisOfficePackageError('limitExceeded');
				}
				const column = sheet.minCol + cellIndex;
				const cellAddress = formatCellAddress(row.excelRow, column);
				const semanticCell = semanticSheet.cells.get(cellAddress);
				if (!semanticCell) {
					return cell;
				}
				const value = semanticDisplayValue(semanticCell);
				if (value === undefined) {
					return cell;
				}
				const numberFormat = semanticNumberFormat(snapshot, semanticCell);
				const sourceText = generalRenderBudgetText(value);
				inputCharacters = addProjectionStringBudget(inputCharacters, sourceText.length, limits.inputCharacters);
				inputUtf8Bytes = addProjectionStringBudget(inputUtf8Bytes, boundedUtf8Length(sourceText, () => checkpoint()), limits.inputUtf8Bytes);
				let prepared = preparedFormats.get(numberFormat);
				if (!prepared) {
					if (preparedFormats.size >= limits.parsedFormats) {
						throw new ParadisOfficePackageError('limitExceeded');
					}
					const formatCharacters = typeof numberFormat === 'string' ? numberFormat.length : String(numberFormat).length;
					parsedFormatCharacters = addProjectionStringBudget(parsedFormatCharacters, formatCharacters, limits.parsedFormatCharacters);
					prepared = prepareSpreadsheetNumberFormat(numberFormat, formatContext);
					preparedFormats.set(numberFormat, prepared);
				}
				const formatted = formatPreparedSpreadsheetValue(prepared, value);
				const previousValueBytes = boundedUtf8Length(cell.value, () => checkpoint());
				outputCharacters -= cell.value.length;
				outputUtf8Bytes -= previousValueBytes;
				if (outputCharacters < 0 || outputUtf8Bytes < 0) {
					throw new ParadisOfficePackageError('unsafe');
				}
				outputCharacters = addProjectionStringBudget(outputCharacters, formatted.text.length, limits.outputCharacters);
				outputUtf8Bytes = addProjectionStringBudget(outputUtf8Bytes, boundedUtf8Length(formatted.text, () => checkpoint()), limits.outputUtf8Bytes);
				if (formatted.status === 'approximated') {
					if (formatDiagnostics.length < limits.formatDiagnostics) {
						const diagnosticStrings = [semanticSheet.name, cellAddress, formatted.text, ...formatted.unsupportedTokens];
						for (const diagnosticString of diagnosticStrings) {
							diagnosticCharacters = addProjectionStringBudget(diagnosticCharacters, diagnosticString.length, limits.diagnosticCharacters);
							diagnosticUtf8Bytes = addProjectionStringBudget(diagnosticUtf8Bytes, boundedUtf8Length(diagnosticString, () => checkpoint()), limits.diagnosticUtf8Bytes);
						}
						formatDiagnostics.push({ sheetName: semanticSheet.name, cellAddress, ...formatted });
					} else {
						formatDiagnosticsTruncated = true;
					}
				}
				if (formatted.text === cell.value) {
					return cell;
				}
				rowChanged = true;
				return { ...cell, value: formatted.text };
			});
			if (!rowChanged) {
				return row;
			}
			sheetChanged = true;
			return { ...row, cells };
		});
		return sheetChanged ? { ...sheet, rows } : sheet;
	});
	checkpoint(true);
	return {
		projection: sheets.some((sheet, index) => sheet !== projection.sheets[index]) ? { ...projection, sheets } : projection,
		diagnostics,
		formatDiagnostics,
		formatDiagnosticsTruncated,
	};
}

function generalRenderBudgetText(value: number | string | boolean | null): string {
	return value === null ? '' : typeof value === 'boolean' ? value ? 'TRUE' : 'FALSE' : String(value);
}

function addProjectionStringBudget(current: number, increment: number, maximum: number): number {
	const next = current + increment;
	if (!Number.isSafeInteger(next) || next > maximum) {
		throw new ParadisOfficePackageError('limitExceeded');
	}
	return next;
}

function snapshotStandaloneRenderSemanticSnapshot(value: unknown, budget: OwnershipBudget, limits = defaultRenderProjectionLimits): ParadisSpreadsheetRenderSemanticInput {
	const root = projectDataRecord(value, ['date1904', 'projectionDiagnostics', 'styles', 'sheets'], 4, budget);
	const cloneBudget: RenderCloneBudget = {
		clones: new WeakMap(), active: new WeakSet(), nodes: 0, properties: 0, arrayElements: 0, characters: 0, utf8Bytes: 0,
		maximumCharacters: Math.min(limits.inputCharacters, limits.outputCharacters),
		maximumUtf8Bytes: Math.min(limits.inputUtf8Bytes, limits.outputUtf8Bytes),
	};
	const diagnosticCloneBudget: RenderCloneBudget = {
		clones: new WeakMap(), active: new WeakSet(), nodes: 0, properties: 0, arrayElements: 0, characters: 0, utf8Bytes: 0,
		maximumCharacters: limits.diagnosticCharacters,
		maximumUtf8Bytes: limits.diagnosticUtf8Bytes,
	};
	const checkpoint = () => budget.checkpoint();
	const stylesRecord = projectDataRecord(root.styles, ['numberFormats', 'cellFormats'], 2, budget);
	const numberFormats = projectDataArray(stylesRecord.numberFormats, 65_535, budget).map(entry => {
		const record = projectDataRecord(entry, ['id', 'code'], 2, budget);
		return { id: ownedNumber(record.id), code: ownedString(record.code, budget) };
	});
	const cellFormats = projectDataArray(stylesRecord.cellFormats, 65_535, budget).map((entry, index) => {
		const record = projectDataRecord(entry, ['index', 'numberFormatId'], 2, budget);
		return { index: record.index === undefined ? index : ownedNumber(record.index), ...(record.numberFormatId !== undefined ? { numberFormatId: ownedNumber(record.numberFormatId) } : {}) };
	});
	const sheets = projectDataArray(root.sheets, defaultSemanticLimits.projectionSheets, budget).map(sheetValue => {
		const record = projectDataRecord(sheetValue, ['name', 'order', 'cells'], 3, budget);
		const cellsValue = record.cells;
		try {
			if (!cellsValue || typeof cellsValue !== 'object' || Object.getPrototypeOf(cellsValue) !== Map.prototype) {
				throw new ParadisOfficePackageError('unsafe');
			}
		} catch (error) {
			throw sanitizeSpreadsheetPackageError(error, 'unsafe');
		}
		budget.consumeObject(cellsValue);
		const cells = new Map<string, ParadisSemanticCell>();
		let count = 0;
		try {
			for (const [addressValue, cellValue] of Map.prototype.entries.call(cellsValue) as IterableIterator<[unknown, unknown]>) {
				if (++count > defaultSemanticLimits.projectionCells) {
					throw new ParadisOfficePackageError('limitExceeded');
				}
				const address = ownedString(addressValue, budget);
				const cellRecord = projectDataRecord(cellValue, [
					'storedType', 'rawType', 'rawValue', 'text', 'formula', 'cachedResult', 'styleRef', 'effectiveStyleRef', 'effectiveStyleOrigin', 'styleSource', 'sharedStringIndex', 'richText',
				], 12, budget);
				const clonedCell: Record<string, unknown> = {};
				for (const key of Object.keys(cellRecord)) {
					clonedCell[key] = cloneRenderProjectionValue(cellRecord[key], cloneBudget, checkpoint);
				}
				cells.set(address, clonedCell as unknown as ParadisSemanticCell);
			}
		} catch (error) {
			throw sanitizeSpreadsheetPackageError(error, 'unsafe');
		}
		return {
			name: ownedString(record.name, budget),
			order: ownedNumber(record.order),
			cells,
		};
	});
	const projectionDiagnostics = cloneRenderProjectionValue(root.projectionDiagnostics, diagnosticCloneBudget, checkpoint) as ParadisSpreadsheetSnapshot['projectionDiagnostics'];
	return {
		date1904: ownedBoolean(root.date1904),
		projectionDiagnostics,
		sheets,
		styles: { numberFormats, cellFormats },
	};
}

function resolveRenderProjectionLimits(overrides: Partial<ParadisSpreadsheetRenderProjectionLimits>): ParadisSpreadsheetRenderProjectionLimits {
	const allowed = new Set([
		'sheets', 'rows', 'cells', 'formatDiagnostics', 'inputCharacters', 'inputUtf8Bytes', 'outputCharacters', 'outputUtf8Bytes',
		'diagnosticCharacters', 'diagnosticUtf8Bytes', 'parsedFormats', 'parsedFormatCharacters',
	]);
	const record: Record<string, unknown> = Object.create(null);
	try {
		for (const key of Reflect.ownKeys(overrides)) {
			if (typeof key !== 'string' || !allowed.has(key)) {
				throw new ParadisOfficePackageError('unsafe');
			}
			const descriptor = Object.getOwnPropertyDescriptor(overrides, key);
			if (!descriptor || !Object.hasOwn(descriptor, 'value')) {
				throw new ParadisOfficePackageError('unsafe');
			}
			record[key] = descriptor.value;
		}
	} catch (error) {
		throw sanitizeSpreadsheetPackageError(error, 'unsafe');
	}
	const result = { ...defaultRenderProjectionLimits };
	for (const key of allowed as ReadonlySet<keyof ParadisSpreadsheetRenderProjectionLimits>) {
		const value = record[key];
		if (value === undefined) {
			continue;
		}
		if (!Number.isSafeInteger(value) || (value as number) < 0 || (value as number) > defaultRenderProjectionLimits[key]) {
			throw new ParadisOfficePackageError('limitExceeded');
		}
		result[key] = value as number;
	}
	return result;
}

function ownRenderFormatContext(context: ParadisSpreadsheetNumberFormatContext, date1904: boolean): ParadisSpreadsheetNumberFormatContext {
	try {
		const allowed = new Set(['date1904', 'workbookLocale', 'applicationLocale', 'cancellationToken', 'now', 'deadlineMilliseconds', 'limits']);
		const result: Record<string, unknown> = Object.create(null);
		for (const key of Reflect.ownKeys(context)) {
			if (typeof key !== 'string' || !allowed.has(key)) {
				throw new ParadisOfficePackageError('unsafe');
			}
			const descriptor = Object.getOwnPropertyDescriptor(context, key);
			if (!descriptor || !Object.hasOwn(descriptor, 'value')) {
				throw new ParadisOfficePackageError('unsafe');
			}
			result[key] = descriptor.value;
		}
		if (result.limits !== undefined) {
			const limits = result.limits;
			if (!limits || typeof limits !== 'object' || Array.isArray(limits)) {
				throw new ParadisOfficePackageError('unsafe');
			}
			const ownedLimits: Record<string, unknown> = Object.create(null);
			for (const key of Reflect.ownKeys(limits)) {
				if (typeof key !== 'string' || !['formatCharacters', 'sections', 'tokens', 'inputCharacters', 'outputCharacters'].includes(key)) {
					throw new ParadisOfficePackageError('unsafe');
				}
				const descriptor = Object.getOwnPropertyDescriptor(limits, key);
				if (!descriptor || !Object.hasOwn(descriptor, 'value')) {
					throw new ParadisOfficePackageError('unsafe');
				}
				ownedLimits[key] = descriptor.value;
			}
			result.limits = ownedLimits;
		}
		result.date1904 = date1904;
		return result as ParadisSpreadsheetNumberFormatContext;
	} catch (error) {
		if (error instanceof ParadisOfficePackageError) {
			throw error;
		}
		throw new ParadisOfficePackageError('unsafe');
	}
}

function semanticDisplayValue(cell: ParadisSemanticCell): number | string | boolean | null | undefined {
	if (cell.storedType === 'formula') {
		if (!cell.cachedResult?.present) {
			return undefined;
		}
		return typedDisplayValue(cell, cell.cachedResult.type, cell.cachedResult.rawValue);
	}
	if (cell.storedType === 'blank') {
		return null;
	}
	if (cell.storedType === 'string') {
		return cell.text ?? (cell.rawValue?.present ? cell.rawValue.text : '');
	}
	if (cell.storedType === 'boolean') {
		return cell.rawValue?.present ? cell.rawValue.text === '1' || cell.rawValue.text === 'true' : false;
	}
	if (cell.storedType === 'error' || cell.storedType === 'date') {
		return undefined;
	}
	if (!cell.rawValue?.present) {
		return undefined;
	}
	return cell.storedType === 'number' ? finiteSpreadsheetNumber(cell.rawValue.text) : cell.rawValue.text;
}

function typedDisplayValue(cell: ParadisSemanticCell, type: ParadisSemanticCachedResultType, rawValue: string): number | string | boolean | undefined {
	switch (type) {
		case 'number': return finiteSpreadsheetNumber(rawValue);
		case 'boolean': return rawValue === '1' || rawValue === 'true';
		case 'string': return cell.rawType === 's' ? undefined : rawValue;
		case 'error': case 'date': return undefined;
	}
}

function finiteSpreadsheetNumber(value: string): number {
	if (value.length > 256 || !/^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[Ee][+-]?\d+)?$/.test(value)) {
		throw new ParadisOfficePackageError('malformed');
	}
	const parsed = Number(value);
	if (!Number.isFinite(parsed)) {
		throw new ParadisOfficePackageError('malformed');
	}
	return parsed;
}

function semanticNumberFormat(snapshot: ParadisSpreadsheetRenderSemanticInput, cell: ParadisSemanticCell): number | string {
	const format = cell.effectiveStyleRef === undefined ? undefined : snapshot.styles.cellFormats[cell.effectiveStyleRef];
	const id = format?.numberFormatId ?? 0;
	const custom = snapshot.styles.numberFormats.find(candidate => candidate.id === id);
	if (custom) {
		return custom.code;
	}
	return id >= 0 && id <= 49 ? id : `[numFmtId:${id}]`;
}

interface OwnedSemanticContext extends ParadisSpreadsheetOwnedSemanticInput {
	readonly renderProjection?: IParadisWorkbookData;
	readonly renderProjectionCharacters?: number;
	readonly renderProjectionUtf8Bytes?: number;
	readonly hardDeadline: StopWatch;
	readonly deadlineMilliseconds: number;
}

const ownedSemanticContexts = new WeakMap<ParadisOfficeInventory, { readonly options: ParadisSpreadsheetSemanticParseOptions; readonly context: OwnedSemanticContext }>();

const defaultSemanticLimits: ParadisSpreadsheetSemanticLimits = {
	sheets: 65_535,
	cells: 5_000_000,
	projectionSheets: 65_535,
	projectionRows: 5_000_000,
	projectionCells: 5_000_000,
	rows: maximumExcelRows,
	columns: maximumExcelColumns,
	merges: 1_000_000,
	definedNames: 65_535,
	sharedStrings: 5_000_000,
};
const semanticLimitKeys: readonly (keyof ParadisSpreadsheetSemanticLimits)[] = [
	'sheets', 'cells', 'projectionSheets', 'projectionRows', 'projectionCells', 'rows', 'columns', 'merges', 'definedNames', 'sharedStrings',
];
const maximumInventoryKeys = 16;
const maximumInventoryParts = PARADIS_OFFICE_BUDGET_PROFILES.desktopLocal.entryCount;
const maximumInventoryRelationships = 100_000;
const maximumInventoryFeatures = maximumInventoryParts;
const maximumInventoryPartKeys = 24;
const maximumInventoryRelationshipKeys = 12;
const maximumOwnershipNodes = 250_000;
const maximumOwnershipProperties = 1_000_000;
const maximumOwnershipArrayElements = 1_000_000;
const maximumOwnershipStringCharacters = 64 * 1024 * 1024;
const maximumSemanticDeadlineMilliseconds = Math.max(...Object.values(PARADIS_OFFICE_BUDGET_PROFILES).map(profile => profile.semanticParseMilliseconds));
const typedArrayPrototype = Object.getPrototypeOf(Uint8Array.prototype);
const typedArrayByteLength = Object.getOwnPropertyDescriptor(typedArrayPrototype, 'byteLength')!.get!;
const typedArrayBuffer = Object.getOwnPropertyDescriptor(typedArrayPrototype, 'buffer')!.get!;
const typedArraySet = Uint8Array.prototype.set;
const arrayBufferByteLength = Object.getOwnPropertyDescriptor(ArrayBuffer.prototype, 'byteLength')!.get!;
const arrayBufferResizable = Object.getOwnPropertyDescriptor(ArrayBuffer.prototype, 'resizable')?.get;
const arrayBufferDetached = Object.getOwnPropertyDescriptor(ArrayBuffer.prototype, 'detached')?.get;

class OwnershipBudget {
	private readonly seenObjects = new WeakSet<object>();
	private nodes = 0;
	private properties = 0;
	private arrayElements = 0;
	private stringCharacters = 0;

	constructor(private readonly checkpointCallback: () => void = () => undefined) { }

	checkpoint(): void {
		this.checkpointCallback();
	}

	consumeObject(value: object): void {
		if (this.seenObjects.has(value)) {
			throw new ParadisOfficePackageError('unsafe');
		}
		this.seenObjects.add(value);
	}

	consumeRecord(properties: number): void {
		this.nodes = addOwnershipValue(this.nodes, 1, maximumOwnershipNodes);
		this.properties = addOwnershipValue(this.properties, properties, maximumOwnershipProperties);
	}

	consumeArray(elements: number): void {
		this.nodes = addOwnershipValue(this.nodes, 1, maximumOwnershipNodes);
		this.arrayElements = addOwnershipValue(this.arrayElements, elements, maximumOwnershipArrayElements);
	}

	consumeString(value: string): string {
		this.stringCharacters = addOwnershipValue(this.stringCharacters, value.length, maximumOwnershipStringCharacters);
		return value;
	}
}

function addOwnershipValue(current: number, value: number, maximum: number): number {
	const next = current + value;
	if (!Number.isSafeInteger(next) || next > maximum) {
		throw new ParadisOfficePackageError('limitExceeded');
	}
	return next;
}

interface ParsedPart {
	readonly document: ParadisOfficeXmlDocument;
	readonly source: ParadisSpreadsheetPartSource;
}

interface WorkbookSheetRecord {
	readonly name: string;
	readonly sheetId: string;
	readonly state: ParadisSemanticSheetState;
	readonly relationshipId: string;
}

interface ParsedWorkbook {
	readonly date1904: boolean;
	readonly sheets: readonly WorkbookSheetRecord[];
	readonly calcProperties?: ParadisSpreadsheetCalcProperties;
	readonly definedNames: readonly ParadisSpreadsheetDefinedName[];
	readonly workbookViews: readonly ParadisSpreadsheetWorkbookView[];
}

interface SharedStringRecord {
	readonly text: string;
	readonly richText?: readonly ParadisSemanticRichTextRun[];
}

interface SemanticCounters {
	unknownElements: number;
	unknownAttributes: number;
	unresolvedReferences: number;
	expectedCells: number;
	parsedCells: number;
	cellsWithStyleRefs: number;
	unresolvedStyleRefs: number;
	cellsWithDiagonalStyleRefs: number;
}

interface RawRelationship {
	readonly id: string;
	readonly type: string;
	readonly target: string;
	readonly targetMode: 'internal' | 'external';
}

interface IndexedArchivePart {
	readonly entry: ParadisOfficeArchiveEntry;
	readonly inventoryPart: ParadisOfficeInventoryPart;
}

interface SemanticArchiveReader {
	readonly parts: ReadonlyMap<string, IndexedArchivePart>;
	readonly parsed: Map<string, ParsedPart>;
	rereadCompressedBytes: number;
	rereadExpandedBytes: number;
}

/**
 * Consumes and disposes an archive after parsing namespace-validated, all-byte-verified OOXML Parts.
 * The parser owns the archive for success, cancellation, rejection, and malformed-input paths.
 */
export async function parseSpreadsheetSemantic(
	archive: IParadisOfficeArchive,
	inventory: ParadisOfficeInventory,
	token?: CancellationToken,
	options: ParadisSpreadsheetSemanticParseOptions = {},
): Promise<ParadisSpreadsheetSemanticResult> {
	let archiveDisposeAttempted = false;
	try {
		const markedContext = ownedSemanticContexts.get(inventory);
		const context = markedContext?.options === options ? markedContext.context : createOwnedSemanticContext(inventory, options, token);
		if (markedContext?.options === options) {
			ownedSemanticContexts.delete(inventory);
		}
		const ownedInventory = context.inventory;
		const ownedOptions = context.options;
		const profile = budgetProfile(ownedInventory.budgetProfile);
		const limits = resolveSpreadsheetSemanticLimits(ownedOptions.limits);
		const ownedProjection = ownedOptions.projection;
		const ownedRenderProjection = context.renderProjection;
		const now = ownedOptions.now ?? Date.now;
		const deadlineMilliseconds = context.deadlineMilliseconds;
		const started = readMonotonicClock(now);
		let lastClock = started;
		let checkpointCount = 0;
		const checkpoint = (force = false): void => {
			checkpointCount++;
			if (!force && checkpointCount % 128 !== 0) {
				return;
			}
			throwIfParadisOfficeCancelled(token);
			if (context.hardDeadline.elapsed() > deadlineMilliseconds) {
				throw new ParadisOfficePackageError('limitExceeded');
			}
			const currentClock = readMonotonicClock(now);
			if (currentClock < lastClock) {
				throw new ParadisOfficePackageError('invalid');
			}
			lastClock = currentClock;
			if (currentClock - started > deadlineMilliseconds) {
				throw new ParadisOfficePackageError('limitExceeded');
			}
		};
		checkpoint(true);
		validateInventory(ownedInventory, archive, profile);
		const inventoryPartsById = new Map<string, ParadisOfficeInventoryPart>();
		for (const part of ownedInventory.parts) {
			checkpoint();
			inventoryPartsById.set(part.canonicalUri, part);
		}
		const reader = await indexSemanticArchive(archive, ownedInventory, profile, token, checkpoint);
		const contentTypesPart = await readSemanticPart(archive, reader, contentTypesPartId, profile, token, checkpoint);
		const rootRelationshipsPartId = relationshipPartId(undefined);
		validateContentTypesPart(contentTypesPart.document, inventoryPartsById, new Set([contentTypesPartId, rootRelationshipsPartId]), checkpoint);
		validatePartContentType(inventoryPartsById, rootRelationshipsPartId, relationshipContentTypes);
		const rootRelationshipsPart = await readSemanticPart(archive, reader, rootRelationshipsPartId, profile, token, checkpoint);
		const rootRelationships = parseRelationshipPart(rootRelationshipsPart.document, undefined, checkpoint);
		validateRelationshipAuthority(rootRelationships, undefined, ownedInventory, reader.parts, checkpoint);
		const workbookRelationship = uniqueRawRelationship(rootRelationships, officeDocumentRelationships, checkpoint);
		const workbookPartId = safeRawInternalTarget(workbookRelationship);
		validateContentTypesPart(contentTypesPart.document, inventoryPartsById, new Set([contentTypesPartId, rootRelationshipsPartId, workbookPartId]), checkpoint);
		validatePartContentType(inventoryPartsById, workbookPartId, workbookContentTypesForFormat(ownedInventory.format));
		const workbookPart = await readSemanticPart(archive, reader, workbookPartId, profile, token, checkpoint);
		const workbookRelationshipsPartId = relationshipPartId(workbookPartId);
		validateContentTypesPart(contentTypesPart.document, inventoryPartsById, new Set([contentTypesPartId, workbookRelationshipsPartId]), checkpoint);
		validatePartContentType(inventoryPartsById, workbookRelationshipsPartId, relationshipContentTypes);
		const workbookRelationshipsPart = await readSemanticPart(archive, reader, workbookRelationshipsPartId, profile, token, checkpoint);
		const workbookRelationships = parseRelationshipPart(workbookRelationshipsPart.document, workbookPartId, checkpoint);
		validateRelationshipAuthority(workbookRelationships, workbookPartId, ownedInventory, reader.parts, checkpoint);
		const counters: SemanticCounters = {
			unknownElements: 0,
			unknownAttributes: 0,
			unresolvedReferences: 0,
			expectedCells: 0,
			parsedCells: 0,
			cellsWithStyleRefs: 0,
			unresolvedStyleRefs: 0,
			cellsWithDiagonalStyleRefs: 0,
		};
		const workbook = parseWorkbook(workbookPart.document, limits, counters, checkpoint);
		const referencedWorksheetRelationships = new Set(workbook.sheets.map(sheet => sheet.relationshipId));
		const requestedPartIds = new Set<string>([
			contentTypesPartId,
			workbookPartId,
			rootRelationshipsPartId,
			workbookRelationshipsPartId,
		]);
		for (const relationship of workbookRelationships) {
			checkpoint();
			const acceptedContentTypes = worksheetRelationships.has(relationship.type) && referencedWorksheetRelationships.has(relationship.id)
				? worksheetContentTypes
				: stylesRelationships.has(relationship.type)
					? stylesContentTypes
					: sharedStringsRelationships.has(relationship.type)
						? sharedStringsContentTypes
						: undefined;
			if (acceptedContentTypes) {
				const target = safeRawInternalTarget(relationship);
				validatePartContentType(inventoryPartsById, target, acceptedContentTypes);
				requestedPartIds.add(target);
			}
		}
		if (requestedPartIds.size > profile.entryCount) {
			throw new ParadisOfficePackageError('limitExceeded');
		}
		validateContentTypesPart(contentTypesPart.document, inventoryPartsById, requestedPartIds, checkpoint);
		validatePartContentType(inventoryPartsById, workbookPartId, workbookContentTypesForFormat(ownedInventory.format));
		for (const partId of requestedPartIds) {
			await readSemanticPart(archive, reader, partId, profile, token, checkpoint);
		}
		const stylesRelationship = optionalUniqueRawRelationship(workbookRelationships, stylesRelationships, checkpoint);
		const sharedStringsRelationship = optionalUniqueRawRelationship(workbookRelationships, sharedStringsRelationships, checkpoint);
		const workbookRelationshipsById = new Map<string, RawRelationship>();
		for (const relationship of workbookRelationships) {
			checkpoint();
			workbookRelationshipsById.set(relationship.id, relationship);
		}
		const stylesPart = stylesRelationship ? requiredParsedPart(reader.parsed, safeRawInternalTarget(stylesRelationship)) : undefined;
		const sharedStringsPart = sharedStringsRelationship ? requiredParsedPart(reader.parsed, safeRawInternalTarget(sharedStringsRelationship)) : undefined;
		const styles = parseStyles(stylesPart, counters, checkpoint);
		const sharedStrings = parseSharedStrings(sharedStringsPart, limits, counters, checkpoint);
		const sheets: ParadisSemanticSheet[] = [];
		const seenRelationshipIds = new Set<string>();
		const seenSheetPartIds = new Set<string>();
		for (let order = 0; order < workbook.sheets.length; order++) {
			checkpoint();
			const sheetRecord = workbook.sheets[order];
			if (seenRelationshipIds.has(sheetRecord.relationshipId)) {
				throw new ParadisOfficePackageError('unsafe');
			}
			seenRelationshipIds.add(sheetRecord.relationshipId);
			const relationship = workbookRelationshipsById.get(sheetRecord.relationshipId);
			if (!relationship || !worksheetRelationships.has(relationship.type)) {
				throw new ParadisOfficePackageError('unsafe');
			}
			const partId = safeRawInternalTarget(relationship);
			if (seenSheetPartIds.has(partId)) {
				throw new ParadisOfficePackageError('unsafe');
			}
			seenSheetPartIds.add(partId);
			const part = requiredParsedPart(reader.parsed, partId);
			sheets.push(parseWorksheet(part, partId, order, sheetRecord, sharedStrings, styles, limits, counters, checkpoint));
		}
		const resolvedStyles: ParadisSpreadsheetStyles = {
			...styles,
			completeness: {
				...styles.completeness,
				cellsWithStyleRefs: counters.cellsWithStyleRefs,
				unresolvedStyleRefs: counters.unresolvedStyleRefs,
				cellsWithDiagonalStyleRefs: counters.cellsWithDiagonalStyleRefs,
			},
		};
		const baseSnapshot: ParadisSpreadsheetSnapshot = {
			workbookSource: workbookPart.source,
			date1904: workbook.date1904,
			...(workbook.calcProperties ? { calcProperties: workbook.calcProperties } : {}),
			definedNames: workbook.definedNames,
			workbookViews: workbook.workbookViews,
			sheets,
			styles: resolvedStyles,
			completeness: {
				expectedParts: requestedPartIds.size,
				visitedParts: reader.parsed.size,
				parsedParts: reader.parsed.size,
				expectedSheets: workbook.sheets.length,
				parsedSheets: sheets.length,
				expectedCells: counters.expectedCells,
				parsedCells: counters.parsedCells,
				unknownElements: counters.unknownElements,
				unknownAttributes: counters.unknownAttributes,
				unresolvedReferences: counters.unresolvedReferences,
				terminal: true,
			},
			projectionDiagnostics: [],
		};
		let projectionCells = 0;
		let projectionSheets = 0;
		let projectionRows = 0;
		const result: ParadisSpreadsheetSemanticResult = ownedProjection
			? {
				...baseSnapshot,
				projectionDiagnostics: diagnoseSpreadsheetProjection(baseSnapshot, ownedProjection, {
					checkpoint: () => checkpoint(),
					consumeProjectionSheet: () => {
						if (++projectionSheets > limits.projectionSheets) {
							throw new ParadisOfficePackageError('limitExceeded');
						}
					},
					consumeProjectionRow: () => {
						if (++projectionRows > limits.projectionRows) {
							throw new ParadisOfficePackageError('limitExceeded');
						}
					},
					consumeProjectionCell: () => {
						if (++projectionCells > limits.projectionCells) {
							throw new ParadisOfficePackageError('limitExceeded');
						}
					},
				}),
			}
			: baseSnapshot;
		checkpoint(true);
		const formattedProjection = ownedRenderProjection ? formatOwnedSpreadsheetRenderProjection(
			result,
			ownedRenderProjection,
			{
				date1904: result.date1904,
				...(ownedOptions.workbookLocale ? { workbookLocale: ownedOptions.workbookLocale } : {}),
				...(ownedOptions.applicationLocale ? { applicationLocale: ownedOptions.applicationLocale } : {}),
				...(token ? { cancellationToken: token } : {}),
				now,
				deadlineMilliseconds: Math.max(0, Math.min(
					deadlineMilliseconds - Math.ceil(context.hardDeadline.elapsed()),
					deadlineMilliseconds - Math.ceil(lastClock - started),
				)),
			},
			{
				sheets: limits.projectionSheets,
				rows: limits.projectionRows,
				cells: limits.projectionCells,
				formatDiagnostics: 10_000,
			},
			undefined,
			{
				characters: context.renderProjectionCharacters ?? 0,
				utf8Bytes: context.renderProjectionUtf8Bytes ?? 0,
			},
		) : undefined;
		const finalResult: ParadisSpreadsheetSemanticResult = formattedProjection ? {
			...result,
			renderProjection: formattedProjection.projection,
			renderFormatDiagnostics: formattedProjection.formatDiagnostics,
			renderFormatDiagnosticsTruncated: formattedProjection.formatDiagnosticsTruncated,
		} : result;
		checkpoint(true);
		try {
			archiveDisposeAttempted = true;
			archive.dispose();
		} catch {
			throw new ParadisOfficePackageError('invalid');
		}
		return finalResult;
	} catch (error) {
		throw sanitizeSpreadsheetPackageError(error, 'malformed');
	} finally {
		if (!archiveDisposeAttempted) {
			try {
				archiveDisposeAttempted = true;
				archive.dispose();
			} catch {
				// Preserve the already-sanitized parse error; cleanup must never replace it.
			}
		}
	}
}

export function sanitizeSpreadsheetPackageError(
	error: unknown,
	fallback: ParadisOfficePackageError['code'] = 'invalid',
): ParadisOfficePackageError {
	try {
		if (error instanceof ParadisOfficePackageError) {
			const code = Object.getOwnPropertyDescriptor(error, 'code')?.value;
			if (code === 'invalid' || code === 'encrypted' || code === 'zipBomb' || code === 'limitExceeded'
				|| code === 'malformed' || code === 'cancelled' || code === 'unsafe') {
				return new ParadisOfficePackageError(code);
			}
		}
	} catch { /* Introspection of an attacker-controlled thrown value must not escape this boundary. */ }
	return new ParadisOfficePackageError(fallback);
}

function budgetProfile(kind: ParadisOfficeInventory['budgetProfile']): ParadisOfficeBudgetProfile {
	switch (kind) {
		case 'desktopLocal': case 'remoteMobile': case 'browser':
			return PARADIS_OFFICE_BUDGET_PROFILES[kind];
		default:
			throw new ParadisOfficePackageError('unsafe');
	}
}

export function resolveSpreadsheetSemanticLimits(overrides: Partial<ParadisSpreadsheetSemanticLimits> | undefined): ParadisSpreadsheetSemanticLimits {
	const limits = { ...defaultSemanticLimits };
	for (const key of semanticLimitKeys) {
		const descriptor = overrides === undefined ? undefined : Object.getOwnPropertyDescriptor(overrides, key);
		if (descriptor && !Object.hasOwn(descriptor, 'value')) {
			throw new ParadisOfficePackageError('unsafe');
		}
		const override = descriptor?.value;
		if (override === undefined) {
			continue;
		}
		if (!Number.isSafeInteger(override) || override < 0) {
			throw new ParadisOfficePackageError('limitExceeded');
		}
		limits[key] = Math.min(defaultSemanticLimits[key], override);
	}
	return limits;
}

type OwnedRecord = Readonly<Record<string, unknown>>;

function projectDataRecord(value: unknown, allowedKeys: readonly string[], maximumKeys: number, budget: OwnershipBudget): OwnedRecord {
	if (!value || typeof value !== 'object') {
		throw new ParadisOfficePackageError('unsafe');
	}
	budget.consumeObject(value);
	if (allowedKeys.length > maximumKeys) {
		throw new ParadisOfficePackageError('limitExceeded');
	}
	budget.consumeRecord(allowedKeys.length);
	rejectDangerousOwnDescriptors(value, budget);
	const result: Record<string, unknown> = {};
	for (const key of allowedKeys) {
		budget.checkpoint();
		const descriptor = Object.getOwnPropertyDescriptor(value, key);
		if (!descriptor) {
			continue;
		}
		if (!Object.hasOwn(descriptor, 'value')) {
			throw new ParadisOfficePackageError('unsafe');
		}
		result[key] = descriptor.value;
	}
	return result;
}

function projectDataArray(value: unknown, maximumElements: number, budget: OwnershipBudget): readonly unknown[] {
	if (!Array.isArray(value)) {
		throw new ParadisOfficePackageError('unsafe');
	}
	budget.consumeObject(value);
	const lengthDescriptor = Object.getOwnPropertyDescriptor(value, 'length');
	const rawLength = lengthDescriptor?.value;
	if (typeof rawLength !== 'number' || !Number.isSafeInteger(rawLength)
		|| rawLength < 0 || rawLength > maximumElements) {
		throw new ParadisOfficePackageError('limitExceeded');
	}
	const length = rawLength;
	budget.consumeArray(length);
	rejectDangerousOwnDescriptors(value, budget);
	const result = new Array<unknown>(length);
	for (let index = 0; index < length; index++) {
		budget.checkpoint();
		const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
		if (!descriptor || !Object.hasOwn(descriptor, 'value')) {
			throw new ParadisOfficePackageError('unsafe');
		}
		result[index] = descriptor.value;
	}
	return result;
}

function rejectDangerousOwnDescriptors(value: object, budget: OwnershipBudget): void {
	for (const key of ['__proto__', 'prototype', 'constructor', Symbol.iterator, Symbol.species]) {
		budget.checkpoint();
		if (Object.getOwnPropertyDescriptor(value, key)) {
			throw new ParadisOfficePackageError('unsafe');
		}
	}
}

function ownedString(value: unknown, budget: OwnershipBudget): string {
	if (typeof value !== 'string') {
		throw new ParadisOfficePackageError('unsafe');
	}
	return budget.consumeString(value);
}

function ownedNumber(value: unknown): number {
	if (!Number.isSafeInteger(value) || (value as number) < 0) {
		throw new ParadisOfficePackageError('unsafe');
	}
	return value as number;
}

function ownedBoolean(value: unknown): boolean {
	if (typeof value !== 'boolean') {
		throw new ParadisOfficePackageError('unsafe');
	}
	return value;
}

/** Takes a bounded deep ownership snapshot synchronously, before an adapter crosses an async runtime boundary. */
export function ownSpreadsheetSemanticInput(
	inventory: ParadisOfficeInventory,
	options: ParadisSpreadsheetSemanticParseOptions,
	token?: CancellationToken,
	executionProfile?: ParadisOfficeInventory['budgetProfile'],
): ParadisSpreadsheetOwnedSemanticInput {
	const context = createOwnedSemanticContext(inventory, options, token, executionProfile);
	ownedSemanticContexts.set(context.inventory, { options: context.options, context });
	return { inventory: context.inventory, options: context.options };
}

export interface ParadisSpreadsheetOwnedAdapterInput extends ParadisSpreadsheetOwnedSemanticInput {
	readonly bytes: Uint8Array;
}

/** Owns stable package bytes before reflecting over caller-owned inventory/options. */
export function ownSpreadsheetSemanticAdapterInput(
	bytes: Uint8Array,
	inventory: ParadisOfficeInventory,
	options: ParadisSpreadsheetSemanticParseOptions,
	token: CancellationToken | undefined,
	executionProfile: ParadisOfficeInventory['budgetProfile'],
): ParadisSpreadsheetOwnedAdapterInput {
	const profile = budgetProfile(executionProfile);
	const hardDeadline = StopWatch.create(true);
	const checkpoint = (): void => {
		throwIfParadisOfficeCancelled(token);
		if (hardDeadline.elapsed() > profile.semanticParseMilliseconds) {
			throw new ParadisOfficePackageError('limitExceeded');
		}
	};
	const ownedBytes = ownStableSpreadsheetBytes(bytes, profile.compressedInputBytes, checkpoint);
	const context = createOwnedSemanticContext(inventory, options, token, executionProfile, hardDeadline);
	ownedSemanticContexts.set(context.inventory, { options: context.options, context });
	return { bytes: ownedBytes, inventory: context.inventory, options: context.options };
}

function createOwnedSemanticContext(
	inventory: ParadisOfficeInventory,
	options: ParadisSpreadsheetSemanticParseOptions,
	token?: CancellationToken,
	executionProfile?: ParadisOfficeInventory['budgetProfile'],
	hardDeadline = StopWatch.create(true),
): OwnedSemanticContext {
	let deadlineMilliseconds = executionProfile === undefined
		? maximumSemanticDeadlineMilliseconds
		: budgetProfile(executionProfile).semanticParseMilliseconds;
	const checkpoint = (): void => {
		throwIfParadisOfficeCancelled(token);
		if (hardDeadline.elapsed() > deadlineMilliseconds) {
			throw new ParadisOfficePackageError('limitExceeded');
		}
	};
	const budget = new OwnershipBudget(checkpoint);
	const inventoryRecord = projectInventoryEnvelope(inventory, budget);
	const optionsRecord = projectDataRecord(options, ['projection', 'limits', 'now', 'deadlineMilliseconds', 'workbookLocale', 'applicationLocale'], 6, budget);
	const declaredProfile = ownedString(inventoryRecord.budgetProfile, budget);
	if (executionProfile !== undefined && declaredProfile !== executionProfile) {
		throw new ParadisOfficePackageError('unsafe');
	}
	const effectiveProfile = budgetProfile((executionProfile ?? declaredProfile) as ParadisOfficeInventory['budgetProfile']);
	const requestedDeadline = optionsRecord.deadlineMilliseconds ?? effectiveProfile.semanticParseMilliseconds;
	if (typeof requestedDeadline !== 'number' || !Number.isSafeInteger(requestedDeadline) || requestedDeadline < 0) {
		throw new ParadisOfficePackageError('limitExceeded');
	}
	deadlineMilliseconds = Math.min(effectiveProfile.semanticParseMilliseconds, requestedDeadline);
	checkpoint();
	const ownedInventory = snapshotInventory(inventoryRecord, checkpoint, budget, effectiveProfile.entryCount);
	const limits = resolveOwnedLimits(optionsRecord.limits, budget);
	const projections = optionsRecord.projection === undefined ? undefined : snapshotProjection(optionsRecord.projection, limits, checkpoint, budget);
	const projection = projections?.diagnostic;
	const now = optionsRecord.now;
	if (now !== undefined && typeof now !== 'function') {
		throw new ParadisOfficePackageError('unsafe');
	}
	const workbookLocale = optionsRecord.workbookLocale === undefined ? undefined : ownedString(optionsRecord.workbookLocale, budget);
	const applicationLocale = optionsRecord.applicationLocale === undefined ? undefined : ownedString(optionsRecord.applicationLocale, budget);
	if ((workbookLocale?.length ?? 0) > 128 || (applicationLocale?.length ?? 0) > 128) {
		throw new ParadisOfficePackageError('limitExceeded');
	}
	const ownedOptions: ParadisSpreadsheetSemanticParseOptions = {
		limits,
		...(projection ? { projection } : {}),
		...(now ? { now: now as () => number } : {}),
		...(workbookLocale !== undefined ? { workbookLocale } : {}),
		...(applicationLocale !== undefined ? { applicationLocale } : {}),
		deadlineMilliseconds,
	};
	return {
		inventory: deepFreezeOwned(ownedInventory, checkpoint),
		options: deepFreezeOwned(ownedOptions, checkpoint),
		...(projections ? { renderProjection: deepFreezeOwned(projections.render, checkpoint) } : {}),
		...(projections ? { renderProjectionCharacters: projections.renderCharacters, renderProjectionUtf8Bytes: projections.renderUtf8Bytes } : {}),
		hardDeadline,
		deadlineMilliseconds,
	};
}

function ownStableSpreadsheetBytes(value: unknown, maximumBytes: number, checkpoint: () => void): Uint8Array {
	checkpoint();
	if (!value || typeof value !== 'object' || Object.getPrototypeOf(value) !== Uint8Array.prototype) {
		throw new ParadisOfficePackageError('invalid');
	}
	for (const key of ['constructor', 'byteLength', 'slice', Symbol.species]) {
		checkpoint();
		if (Object.getOwnPropertyDescriptor(value, key)) {
			throw new ParadisOfficePackageError('invalid');
		}
	}
	const source = value as Uint8Array;
	const sourceBuffer = typedArrayBuffer.call(source) as ArrayBuffer;
	if (Object.getPrototypeOf(sourceBuffer) !== ArrayBuffer.prototype) {
		throw new ParadisOfficePackageError('invalid');
	}
	for (const key of ['constructor', 'byteLength', 'slice', Symbol.species]) {
		checkpoint();
		if (Object.getOwnPropertyDescriptor(sourceBuffer, key)) {
			throw new ParadisOfficePackageError('invalid');
		}
	}
	if (arrayBufferResizable?.call(sourceBuffer) === true || arrayBufferDetached?.call(sourceBuffer) === true) {
		throw new ParadisOfficePackageError('invalid');
	}
	const length = typedArrayByteLength.call(source) as number;
	const bufferLength = arrayBufferByteLength.call(sourceBuffer) as number;
	if (!Number.isSafeInteger(length) || length < 0 || length > maximumBytes || !Number.isSafeInteger(bufferLength) || bufferLength < length) {
		throw new ParadisOfficePackageError(length > maximumBytes ? 'limitExceeded' : 'invalid');
	}
	const owned = new Uint8Array(new ArrayBuffer(length));
	typedArraySet.call(owned, source);
	checkpoint();
	if (typedArrayBuffer.call(source) !== sourceBuffer
		|| typedArrayByteLength.call(source) !== length
		|| arrayBufferByteLength.call(sourceBuffer) !== bufferLength
		|| arrayBufferResizable?.call(sourceBuffer) === true
		|| arrayBufferDetached?.call(sourceBuffer) === true) {
		throw new ParadisOfficePackageError('unsafe');
	}
	for (let index = 0; index < length; index++) {
		if ((index & 0xfff) === 0) {
			checkpoint();
		}
		if (owned[index] !== source[index]) {
			throw new ParadisOfficePackageError('unsafe');
		}
	}
	checkpoint();
	return owned;
}

function deepFreezeOwned<T extends object>(value: T, checkpoint: () => void): T {
	const seen = new WeakSet<object>();
	const stack: object[] = [value];
	while (stack.length > 0) {
		checkpoint();
		const current = stack.pop()!;
		if (seen.has(current)) {
			continue;
		}
		seen.add(current);
		if (Array.isArray(current)) {
			for (let index = 0; index < current.length; index++) {
				checkpoint();
				const child = current[index];
				if (child && typeof child === 'object') {
					stack.push(child);
				}
			}
		} else {
			for (const key in current) {
				checkpoint();
				if (!Object.hasOwn(current, key)) {
					continue;
				}
				const child = Object.getOwnPropertyDescriptor(current, key)?.value;
				if (child && typeof child === 'object') {
					stack.push(child);
				}
			}
		}
		Object.freeze(current);
	}
	checkpoint();
	return value;
}

function resolveOwnedLimits(value: unknown, budget: OwnershipBudget): ParadisSpreadsheetSemanticLimits {
	if (value === undefined) {
		return resolveSpreadsheetSemanticLimits(undefined);
	}
	const record = projectDataRecord(value, semanticLimitKeys, semanticLimitKeys.length, budget);
	const overrides: Record<keyof ParadisSpreadsheetSemanticLimits, number> = { ...defaultSemanticLimits };
	for (const key of semanticLimitKeys) {
		if (record[key] !== undefined) {
			overrides[key] = ownedNumber(record[key]);
		}
	}
	return resolveSpreadsheetSemanticLimits(overrides);
}

interface OwnedProjectionSnapshots {
	readonly diagnostic: IParadisWorkbookData;
	readonly render: IParadisWorkbookData;
	readonly renderCharacters: number;
	readonly renderUtf8Bytes: number;
}

interface RenderCloneBudget {
	readonly clones: WeakMap<object, unknown>;
	readonly active: WeakSet<object>;
	nodes: number;
	properties: number;
	arrayElements: number;
	characters: number;
	utf8Bytes: number;
	readonly maximumCharacters: number;
	readonly maximumUtf8Bytes: number;
}

function snapshotProjection(
	projection: unknown,
	limits: ParadisSpreadsheetSemanticLimits,
	checkpoint: () => void,
	budget: OwnershipBudget,
	renderLimits: ParadisSpreadsheetRenderProjectionLimits = defaultRenderProjectionLimits,
): OwnedProjectionSnapshots {
	const projectionRecord = projectDataRecord(projection, ['sheets', 'drawingsBySheet', 'themeColors'], 3, budget);
	const sourceSheets = projectDataArray(projectionRecord.sheets, limits.projectionSheets, budget);
	const cloneBudget: RenderCloneBudget = {
		clones: new WeakMap(), active: new WeakSet(), nodes: 0, properties: 0, arrayElements: 0, characters: 0, utf8Bytes: 0,
		maximumCharacters: Math.min(renderLimits.inputCharacters, renderLimits.outputCharacters),
		maximumUtf8Bytes: Math.min(renderLimits.inputUtf8Bytes, renderLimits.outputUtf8Bytes),
	};
	let rowCount = 0;
	let cellCount = 0;
	const diagnosticSheets: IParadisWorkbookData['sheets'][number][] = [];
	const renderSheets: IParadisWorkbookData['sheets'][number][] = [];
	for (const sheetValue of sourceSheets) {
		checkpoint();
		const sheet = projectDataRecord(sheetValue, [
			'name', 'rows', 'columnCount', 'columnWidths', 'truncated', 'minCol', 'dataValidations', 'shapes', 'showGridLines', 'zoomScale',
			'tabColor', 'protectedSheet', 'rowBreaks', 'colBreaks', 'printArea', 'pageLayout',
		], 18, budget);
		const sourceRows = projectDataArray(sheet.rows, limits.projectionRows - rowCount, budget);
		const diagnosticRows: IParadisWorkbookData['sheets'][number]['rows'][number][] = [];
		const renderRows: IParadisWorkbookData['sheets'][number]['rows'][number][] = [];
		for (const rowValue of sourceRows) {
			checkpoint();
			rowCount++;
			const row = projectDataRecord(rowValue, ['excelRow', 'height', 'cells'], 3, budget);
			const sourceCells = projectDataArray(row.cells, limits.projectionCells - cellCount, budget);
			const diagnosticCells: IParadisWorkbookData['sheets'][number]['rows'][number]['cells'][number][] = [];
			const renderCells: IParadisWorkbookData['sheets'][number]['rows'][number]['cells'][number][] = [];
			for (const cellValue of sourceCells) {
				checkpoint();
				cellCount++;
				const cell = projectDataRecord(cellValue, [
					'value', 'style', 'colSpan', 'rowSpan', 'hidden', 'wrapText', 'verticalText', 'shrinkToFit', 'richText', 'diagonal', 'dataValidation',
				], 11, budget);
				const diagonal = cell.diagonal === undefined ? undefined : snapshotProjectionDiagonal(cell.diagonal, budget);
				const value = ownedString(cell.value, budget);
				cloneBudget.characters = addRenderCloneBudget(cloneBudget.characters, value.length, cloneBudget.maximumCharacters);
				cloneBudget.utf8Bytes = addRenderCloneBudget(cloneBudget.utf8Bytes, boundedUtf8Length(value, checkpoint), cloneBudget.maximumUtf8Bytes);
				diagnosticCells.push({
					value,
					style: {},
					...(diagonal ? { diagonal } : {}),
				});
				const renderCell: Record<string, unknown> = { value, style: cloneRenderCellStyle(cell.style, cloneBudget, checkpoint) };
				for (const key of ['colSpan', 'rowSpan', 'hidden', 'wrapText', 'verticalText', 'shrinkToFit', 'richText', 'diagonal', 'dataValidation']) {
					if (cell[key] !== undefined) {
						renderCell[key] = cloneRenderProjectionValue(cell[key], cloneBudget, checkpoint);
					}
				}
				renderCells.push(renderCell as unknown as IParadisCellData);
			}
			const excelRow = ownedNumber(row.excelRow);
			const height = ownedNumber(row.height);
			diagnosticRows.push({ excelRow, height, cells: diagnosticCells });
			renderRows.push({ excelRow, height, cells: renderCells });
		}
		const name = ownedString(sheet.name, budget);
		cloneBudget.characters = addRenderCloneBudget(cloneBudget.characters, name.length, cloneBudget.maximumCharacters);
		cloneBudget.utf8Bytes = addRenderCloneBudget(cloneBudget.utf8Bytes, boundedUtf8Length(name, checkpoint), cloneBudget.maximumUtf8Bytes);
		const columnCount = ownedNumber(sheet.columnCount);
		const truncated = ownedBoolean(sheet.truncated);
		const minCol = ownedNumber(sheet.minCol);
		diagnosticSheets.push({ name, rows: diagnosticRows, columnCount, columnWidths: [], truncated, minCol });
		const renderSheet: Record<string, unknown> = {
			name, rows: renderRows, columnCount, truncated, minCol,
			columnWidths: cloneRenderProjectionValue(sheet.columnWidths, cloneBudget, checkpoint),
		};
		for (const key of ['dataValidations', 'shapes', 'showGridLines', 'zoomScale', 'tabColor', 'protectedSheet', 'rowBreaks', 'colBreaks', 'printArea', 'pageLayout']) {
			if (sheet[key] !== undefined) {
				renderSheet[key] = cloneRenderProjectionValue(sheet[key], cloneBudget, checkpoint);
			}
		}
		renderSheets.push(renderSheet as unknown as IParadisSheetData);
	}
	const render: Record<string, unknown> = { sheets: renderSheets };
	for (const key of ['drawingsBySheet', 'themeColors']) {
		if (projectionRecord[key] !== undefined) {
			render[key] = cloneRenderProjectionValue(projectionRecord[key], cloneBudget, checkpoint);
		}
	}
	return {
		diagnostic: { sheets: diagnosticSheets },
		render: render as unknown as IParadisWorkbookData,
		renderCharacters: cloneBudget.characters,
		renderUtf8Bytes: cloneBudget.utf8Bytes,
	};
}

function cloneRenderCellStyle(value: unknown, budget: RenderCloneBudget, checkpoint: () => void): IParadisCellStyle {
	if (!value || typeof value !== 'object' || Array.isArray(value)) {
		throw new ParadisOfficePackageError('unsafe');
	}
	try {
		if (budget.clones.has(value)) {
			throw new ParadisOfficePackageError('unsafe');
		}
		budget.nodes = addRenderCloneBudget(budget.nodes, 1, 10_000_000);
		const prototype = Object.getPrototypeOf(value);
		if (prototype !== Object.prototype && prototype !== null) {
			throw new ParadisOfficePackageError('unsafe');
		}
		const keys = Reflect.ownKeys(value);
		if (keys.length > 256) {
			throw new ParadisOfficePackageError('limitExceeded');
		}
		budget.properties = addRenderCloneBudget(budget.properties, keys.length, 50_000_000);
		const result: Record<string, string> = {};
		budget.clones.set(value, result);
		for (const key of keys) {
			checkpoint();
			if (typeof key !== 'string' || key === '__proto__' || key === 'prototype' || key === 'constructor') {
				throw new ParadisOfficePackageError('unsafe');
			}
			const descriptor = Object.getOwnPropertyDescriptor(value, key);
			if (!descriptor || !Object.hasOwn(descriptor, 'value') || typeof descriptor.value !== 'string') {
				throw new ParadisOfficePackageError('unsafe');
			}
			budget.characters = addRenderCloneBudget(budget.characters, key.length, budget.maximumCharacters);
			budget.utf8Bytes = addRenderCloneBudget(budget.utf8Bytes, boundedUtf8Length(key, checkpoint), budget.maximumUtf8Bytes);
			budget.characters = addRenderCloneBudget(budget.characters, descriptor.value.length, budget.maximumCharacters);
			budget.utf8Bytes = addRenderCloneBudget(budget.utf8Bytes, boundedUtf8Length(descriptor.value, checkpoint), budget.maximumUtf8Bytes);
			result[key] = descriptor.value;
		}
		return result;
	} catch (error) {
		throw sanitizeSpreadsheetPackageError(error, 'unsafe');
	}
}

function cloneRenderProjectionValue(value: unknown, budget: RenderCloneBudget, checkpoint: () => void, depth = 0): unknown {
	checkpoint();
	if (value === null || typeof value === 'boolean') {
		return value;
	}
	if (typeof value === 'number') {
		if (!Number.isFinite(value)) {
			throw new ParadisOfficePackageError('unsafe');
		}
		return value;
	}
	if (typeof value === 'string') {
		budget.characters = addRenderCloneBudget(budget.characters, value.length, budget.maximumCharacters);
		budget.utf8Bytes = addRenderCloneBudget(budget.utf8Bytes, boundedUtf8Length(value, checkpoint), budget.maximumUtf8Bytes);
		return value;
	}
	if (!value || typeof value !== 'object' || depth >= 32) {
		throw new ParadisOfficePackageError('unsafe');
	}
	try {
		if (budget.active.has(value)) {
			throw new ParadisOfficePackageError('unsafe');
		}
		if (budget.clones.has(value)) {
			throw new ParadisOfficePackageError('unsafe');
		}
		budget.nodes = addRenderCloneBudget(budget.nodes, 1, 10_000_000);
		budget.active.add(value);
		if (Array.isArray(value)) {
			const length = Object.getOwnPropertyDescriptor(value, 'length')?.value;
			if (!Number.isSafeInteger(length) || length < 0 || length > 5_000_000) {
				throw new ParadisOfficePackageError('limitExceeded');
			}
			budget.arrayElements = addRenderCloneBudget(budget.arrayElements, length, 10_000_000);
			const result = new Array<unknown>(length);
			budget.clones.set(value, result);
			for (let index = 0; index < length; index++) {
				const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
				if (!descriptor || !Object.hasOwn(descriptor, 'value')) {
					throw new ParadisOfficePackageError('unsafe');
				}
				result[index] = cloneRenderProjectionValue(descriptor.value, budget, checkpoint, depth + 1);
			}
			budget.active.delete(value);
			return result;
		}
		const prototype = Object.getPrototypeOf(value);
		if (prototype !== Object.prototype && prototype !== null) {
			throw new ParadisOfficePackageError('unsafe');
		}
		const keys = Reflect.ownKeys(value);
		if (keys.length > 256) {
			throw new ParadisOfficePackageError('limitExceeded');
		}
		budget.properties = addRenderCloneBudget(budget.properties, keys.length, 50_000_000);
		const result: Record<string, unknown> = {};
		budget.clones.set(value, result);
		for (const key of keys) {
			if (typeof key !== 'string' || key === '__proto__' || key === 'prototype' || key === 'constructor') {
				throw new ParadisOfficePackageError('unsafe');
			}
			const descriptor = Object.getOwnPropertyDescriptor(value, key);
			if (!descriptor || !Object.hasOwn(descriptor, 'value')) {
				throw new ParadisOfficePackageError('unsafe');
			}
			budget.characters = addRenderCloneBudget(budget.characters, key.length, budget.maximumCharacters);
			budget.utf8Bytes = addRenderCloneBudget(budget.utf8Bytes, boundedUtf8Length(key, checkpoint), budget.maximumUtf8Bytes);
			result[key] = cloneRenderProjectionValue(descriptor.value, budget, checkpoint, depth + 1);
		}
		budget.active.delete(value);
		return result;
	} catch (error) {
		budget.active.delete(value);
		throw sanitizeSpreadsheetPackageError(error, 'unsafe');
	}
}

function addRenderCloneBudget(current: number, increment: number, maximum: number): number {
	const next = current + increment;
	if (!Number.isSafeInteger(next) || next > maximum) {
		throw new ParadisOfficePackageError('limitExceeded');
	}
	return next;
}

function boundedUtf8Length(value: string, checkpoint: () => void): number {
	let bytes = 0;
	for (let index = 0; index < value.length; index++) {
		if ((index & 0xff) === 0) {
			checkpoint();
		}
		const code = value.charCodeAt(index);
		if (code < 0x80) {
			bytes++;
		} else if (code < 0x800) {
			bytes += 2;
		} else if (code >= 0xd800 && code <= 0xdbff && value.charCodeAt(index + 1) >= 0xdc00 && value.charCodeAt(index + 1) <= 0xdfff) {
			bytes += 4;
			index++;
		} else {
			bytes += 3;
		}
		if (!Number.isSafeInteger(bytes)) {
			throw new ParadisOfficePackageError('limitExceeded');
		}
	}
	return bytes;
}

function snapshotProjectionDiagonal(value: unknown, budget: OwnershipBudget): IParadisDiagonalBorder {
	const record = projectDataRecord(value, ['up', 'down', 'style', 'color', 'rawStyle', 'rawColor'], 6, budget);
	return {
		up: ownedBoolean(record.up),
		down: ownedBoolean(record.down),
		style: ownedString(record.style, budget),
		color: ownedString(record.color, budget),
		...(record.rawStyle !== undefined ? { rawStyle: ownedString(record.rawStyle, budget) } : {}),
		...(record.rawColor !== undefined ? { rawColor: snapshotSpreadsheetColor(record.rawColor, budget) } : {}),
	};
}

function readMonotonicClock(now: () => number): number {
	const value = now();
	if (!Number.isFinite(value) || value < 0 || value > Number.MAX_SAFE_INTEGER) {
		throw new ParadisOfficePackageError('invalid');
	}
	return value;
}

function projectInventoryEnvelope(inventory: ParadisOfficeInventory, budget: OwnershipBudget): OwnedRecord {
	return projectDataRecord(inventory, [
		'format', 'container', 'parts', 'relationships', 'features', 'security', 'budgetProfile', 'budgetUsage',
		'outcome', 'completeness', 'warnings',
	], maximumInventoryKeys, budget);
}

function snapshotInventory(inventory: OwnedRecord, checkpoint: (force?: boolean) => void, budget: OwnershipBudget, maximumParts = maximumInventoryParts): ParadisOfficeInventory {
	const sourceParts = projectDataArray(inventory.parts, Math.min(maximumInventoryParts, maximumParts), budget);
	const parts: ParadisOfficeInventoryPart[] = [];
	for (const part of sourceParts) {
		checkpoint();
		parts.push(copyInventoryPart(part, budget));
	}
	const sourceRelationships = projectDataArray(inventory.relationships, maximumInventoryRelationships, budget);
	const relationships: ParadisOfficeInventory['relationships'][number][] = [];
	for (const relationshipValue of sourceRelationships) {
		checkpoint();
		const relationship = projectDataRecord(relationshipValue, ['id', 'sourcePartId', 'type', 'target', 'targetMode', 'missing', 'cyclic'], maximumInventoryRelationshipKeys, budget);
		const targetMode = ownedString(relationship.targetMode, budget);
		if (targetMode !== 'internal' && targetMode !== 'external') {
			throw new ParadisOfficePackageError('unsafe');
		}
		relationships.push({
			id: ownedString(relationship.id, budget),
			...(relationship.sourcePartId !== undefined ? { sourcePartId: ownedString(relationship.sourcePartId, budget) } : {}),
			type: ownedString(relationship.type, budget),
			target: ownedString(relationship.target, budget),
			targetMode,
			missing: ownedBoolean(relationship.missing),
			cyclic: ownedBoolean(relationship.cyclic),
		});
	}
	projectDataArray(inventory.features, maximumInventoryFeatures, budget);
	const security = projectDataRecord(inventory.security, [
		'encrypted', 'hasMacros', 'hasExternalRelationships', 'hasEmbeddedObjects', 'hasProtection', 'hasSignatures',
	], 6, budget);
	const budgetUsage = projectDataRecord(inventory.budgetUsage, [
		'compressedInputBytes', 'expandedBytes', 'entryCount', 'largestPartBytes', 'totalMediaBytes', 'elapsedMilliseconds',
	], 6, budget);
	return {
		format: ownedString(inventory.format, budget) as ParadisOfficeInventory['format'],
		container: ownedString(inventory.container, budget) as ParadisOfficeInventory['container'],
		parts,
		relationships,
		features: [],
		security: {
			encrypted: ownedBoolean(security.encrypted),
			hasMacros: ownedBoolean(security.hasMacros),
			hasExternalRelationships: ownedBoolean(security.hasExternalRelationships),
			hasEmbeddedObjects: ownedBoolean(security.hasEmbeddedObjects),
			hasProtection: ownedBoolean(security.hasProtection),
			hasSignatures: ownedBoolean(security.hasSignatures),
		},
		budgetProfile: ownedString(inventory.budgetProfile, budget) as ParadisOfficeInventory['budgetProfile'],
		budgetUsage: {
			compressedInputBytes: ownedNumber(budgetUsage.compressedInputBytes),
			expandedBytes: ownedNumber(budgetUsage.expandedBytes),
			entryCount: ownedNumber(budgetUsage.entryCount),
			largestPartBytes: ownedNumber(budgetUsage.largestPartBytes),
			totalMediaBytes: ownedNumber(budgetUsage.totalMediaBytes),
			elapsedMilliseconds: ownedNumber(budgetUsage.elapsedMilliseconds),
		},
	};
}

function copyInventoryPart(value: unknown, budget: OwnershipBudget): ParadisOfficeInventoryPart {
	const part = projectDataRecord(value, [
		'id', 'canonicalUri', 'contentType', 'compressedBytes', 'expandedBytes', 'required', 'canonicalHash',
		'coverage', 'rawHash', 'hashCompleteness', 'fingerprint',
	], maximumInventoryPartKeys, budget);
	const base = {
		id: ownedString(part.id, budget),
		canonicalUri: ownedString(part.canonicalUri, budget),
		contentType: ownedString(part.contentType, budget),
		compressedBytes: ownedNumber(part.compressedBytes),
		expandedBytes: ownedNumber(part.expandedBytes),
		required: ownedBoolean(part.required),
		...(part.canonicalHash !== undefined ? { canonicalHash: snapshotFingerprint(part.canonicalHash, budget) } : {}),
	};
	const coverage = ownedString(part.coverage, budget);
	if (coverage === 'completeOpaque') {
		return { ...base, coverage, hashCompleteness: 'allBytes', fingerprint: snapshotFingerprint(part.fingerprint, budget) };
	}
	if (coverage === 'parsed') {
		return { ...base, coverage, rawHash: snapshotFingerprint(part.rawHash, budget), hashCompleteness: 'allBytes' };
	}
	if (!isIncompletePartCoverage(coverage)) {
		throw new ParadisOfficePackageError('unsafe');
	}
	const hashCompleteness = part.hashCompleteness === undefined ? undefined : ownedString(part.hashCompleteness, budget);
	if (hashCompleteness !== undefined && hashCompleteness !== 'allBytes' && hashCompleteness !== 'incomplete') {
		throw new ParadisOfficePackageError('unsafe');
	}
	return {
		...base,
		coverage,
		...(part.rawHash !== undefined ? { rawHash: snapshotFingerprint(part.rawHash, budget) } : {}),
		...(hashCompleteness !== undefined ? { hashCompleteness } : {}),
	};
}

function isIncompletePartCoverage(value: string): value is 'partial' | 'opaque' | 'unsafe' | 'failed' | 'omittedByBudget' {
	return value === 'partial' || value === 'opaque' || value === 'unsafe' || value === 'failed' || value === 'omittedByBudget';
}

function snapshotFingerprint(value: unknown, budget: OwnershipBudget): ParadisOfficeFingerprint {
	const record = projectDataRecord(value, ['algorithm', 'value', 'byteLength'], 3, budget);
	if (ownedString(record.algorithm, budget) !== 'sha256') {
		throw new ParadisOfficePackageError('unsafe');
	}
	return { algorithm: 'sha256', value: ownedString(record.value, budget), byteLength: ownedNumber(record.byteLength) };
}

function snapshotSpreadsheetColor(value: unknown, budget: OwnershipBudget): ParadisSpreadsheetColor {
	const record = projectDataRecord(value, ['kind', 'rgb', 'indexed', 'theme', 'tint', 'auto'], 6, budget);
	const kind = ownedString(record.kind, budget);
	if (!['rgb', 'indexed', 'theme', 'auto'].includes(kind)) {
		throw new ParadisOfficePackageError('unsafe');
	}
	return {
		kind: kind as ParadisSpreadsheetColor['kind'],
		...(record.rgb !== undefined ? { rgb: ownedString(record.rgb, budget) } : {}),
		...(record.indexed !== undefined ? { indexed: ownedNumber(record.indexed) } : {}),
		...(record.theme !== undefined ? { theme: ownedNumber(record.theme) } : {}),
		...(record.tint !== undefined ? { tint: ownedString(record.tint, budget) } : {}),
		...(record.auto !== undefined ? { auto: ownedBoolean(record.auto) } : {}),
	};
}

function validateInventory(inventory: ParadisOfficeInventory, archive: IParadisOfficeArchive, profile: ParadisOfficeBudgetProfile): void {
	if (!['xlsx', 'xlsm', 'xltx', 'xltm'].includes(inventory.format) || inventory.container !== 'opc') {
		throw new ParadisOfficePackageError('invalid');
	}
	if (inventory.budgetUsage.compressedInputBytes !== archive.containerByteLength
		|| archive.containerByteLength > profile.compressedInputBytes
		|| inventory.parts.length > profile.entryCount) {
		throw new ParadisOfficePackageError('unsafe');
	}
	const partIds = new Set<string>();
	for (const part of inventory.parts) {
		if (partIds.has(part.canonicalUri) || part.id !== part.canonicalUri) {
			throw new ParadisOfficePackageError('unsafe');
		}
		partIds.add(part.canonicalUri);
	}
}

function validatePartContentType(inventoryPartsById: ReadonlyMap<string, ParadisOfficeInventoryPart>, partId: string, accepted: ReadonlySet<string>): void {
	const part = inventoryPartsById.get(partId);
	if (!part || !accepted.has(part.contentType)) {
		throw new ParadisOfficePackageError('unsafe');
	}
}

function workbookContentTypesForFormat(format: ParadisOfficeInventory['format']): ReadonlySet<string> {
	switch (format) {
		case 'xlsx': case 'xlsm': case 'xltx': case 'xltm':
			return workbookContentTypes[format];
		default:
			throw new ParadisOfficePackageError('invalid');
	}
}

function validateContentTypesPart(
	document: ParadisOfficeXmlDocument,
	inventoryPartsById: ReadonlyMap<string, ParadisOfficeInventoryPart>,
	relevantPartIds: ReadonlySet<string>,
	checkpoint: (force?: boolean) => void,
): void {
	const root = document.root;
	if (root.local !== 'Types' || !packageContentTypeNamespaces.has(root.uri)) {
		throw new ParadisOfficePackageError('malformed');
	}
	const defaults = new Map<string, string>();
	const overrides = new Map<string, string>();
	for (const node of elementChildren(root, checkpoint)) {
		checkpoint();
		if (node.uri !== root.uri || (node.local !== 'Default' && node.local !== 'Override')) {
			throw new ParadisOfficePackageError('malformed');
		}
		for (const candidate of node.attributes) {
			const allowed = node.local === 'Default' ? ['Extension', 'ContentType'] : ['PartName', 'ContentType'];
			if (candidate.uri !== '' || !allowed.includes(candidate.local)) {
				throw new ParadisOfficePackageError('malformed');
			}
		}
		const contentType = requiredAttribute(node, 'ContentType');
		if (node.local === 'Default') {
			const extension = requiredAttribute(node, 'Extension').toLowerCase();
			if (!extension || defaults.has(extension)) {
				throw new ParadisOfficePackageError('unsafe');
			}
			defaults.set(extension, contentType);
		} else {
			const rawPartName = requiredAttribute(node, 'PartName');
			if (!rawPartName.startsWith('/')) {
				throw new ParadisOfficePackageError('malformed');
			}
			const partName = canonicalizeParadisOfficeArchiveName(rawPartName.slice(1));
			if (overrides.has(partName)) {
				throw new ParadisOfficePackageError('unsafe');
			}
			overrides.set(partName, contentType);
		}
	}
	for (const partId of relevantPartIds) {
		checkpoint();
		if (partId === contentTypesPartId) {
			continue;
		}
		const part = inventoryPartsById.get(partId);
		const dot = partId.lastIndexOf('.');
		const slash = partId.lastIndexOf('/');
		const extension = dot > slash ? partId.slice(dot + 1).toLowerCase() : '';
		const authority = overrides.get(partId) ?? defaults.get(extension);
		if (!part || !authority || authority !== part.contentType) {
			throw new ParadisOfficePackageError('unsafe');
		}
	}
}

function uniqueRawRelationship(relationships: readonly RawRelationship[], types: ReadonlySet<string>, checkpoint: () => void): RawRelationship {
	const matches: RawRelationship[] = [];
	for (const relationship of relationships) {
		checkpoint();
		if (types.has(relationship.type)) {
			matches.push(relationship);
		}
	}
	if (matches.length !== 1) {
		throw new ParadisOfficePackageError('unsafe');
	}
	return matches[0];
}

function optionalUniqueRawRelationship(relationships: readonly RawRelationship[], types: ReadonlySet<string>, checkpoint: () => void): RawRelationship | undefined {
	const matches: RawRelationship[] = [];
	for (const relationship of relationships) {
		checkpoint();
		if (types.has(relationship.type)) {
			matches.push(relationship);
		}
	}
	if (matches.length > 1) {
		throw new ParadisOfficePackageError('unsafe');
	}
	return matches[0];
}

function safeRawInternalTarget(relationship: RawRelationship): string {
	if (relationship.targetMode !== 'internal' || !relationship.target.startsWith('/')) {
		throw new ParadisOfficePackageError('unsafe');
	}
	return relationship.target;
}

function relationshipPartId(sourcePartId: string | undefined): string {
	if (!sourcePartId) {
		return '/_rels/.rels';
	}
	const separator = sourcePartId.lastIndexOf('/');
	if (separator < 0 || separator === sourcePartId.length - 1) {
		throw new ParadisOfficePackageError('unsafe');
	}
	return `${sourcePartId.slice(0, separator)}/_rels/${sourcePartId.slice(separator + 1)}.rels`;
}

function parseRelationshipPart(
	document: ParadisOfficeXmlDocument,
	sourcePartId: string | undefined,
	checkpoint: (force?: boolean) => void,
): readonly RawRelationship[] {
	const root = document.root;
	if (root.local !== 'Relationships' || !packageRelationshipNamespaces.has(root.uri)) {
		throw new ParadisOfficePackageError('malformed');
	}
	const result: RawRelationship[] = [];
	const ids = new Set<string>();
	for (const node of elementChildren(root, checkpoint)) {
		checkpoint();
		if (node.local !== 'Relationship' || node.uri !== root.uri) {
			throw new ParadisOfficePackageError('malformed');
		}
		for (const candidate of node.attributes) {
			if (candidate.uri !== '' || !['Id', 'Type', 'Target', 'TargetMode'].includes(candidate.local)) {
				throw new ParadisOfficePackageError('malformed');
			}
		}
		const id = requiredAttribute(node, 'Id');
		const type = requiredAttribute(node, 'Type');
		const rawTarget = requiredAttribute(node, 'Target');
		const rawMode = attribute(node, 'TargetMode');
		if (rawMode !== undefined && rawMode !== 'External') {
			throw new ParadisOfficePackageError('malformed');
		}
		const targetMode = rawMode === 'External' ? 'external' : 'internal';
		const target = targetMode === 'external' ? rawTarget : resolveRelationshipTarget(sourcePartId, rawTarget);
		if (ids.has(id)) {
			throw new ParadisOfficePackageError('unsafe');
		}
		ids.add(id);
		result.push({ id, type, target, targetMode });
	}
	return result;
}

function validateRelationshipAuthority(
	actual: readonly RawRelationship[],
	sourcePartId: string | undefined,
	inventory: ParadisOfficeInventory,
	indexedParts: ReadonlyMap<string, IndexedArchivePart>,
	checkpoint: () => void,
): void {
	const expected: ParadisOfficeInventory['relationships'][number][] = [];
	for (const relationship of inventory.relationships) {
		checkpoint();
		if (relationship.sourcePartId === sourcePartId) {
			expected.push(relationship);
		}
	}
	if (actual.length !== expected.length) {
		throw new ParadisOfficePackageError('unsafe');
	}
	const actualById = new Map<string, RawRelationship>();
	for (const relationship of actual) {
		checkpoint();
		actualById.set(relationship.id, relationship);
	}
	const expectedIds = new Set<string>();
	for (const relationship of expected) {
		checkpoint();
		if (expectedIds.has(relationship.id)) {
			throw new ParadisOfficePackageError('unsafe');
		}
		expectedIds.add(relationship.id);
		const authority = actualById.get(relationship.id);
		if (!authority
			|| authority.type !== relationship.type
			|| authority.target !== relationship.target
			|| authority.targetMode !== relationship.targetMode
			|| relationship.cyclic
			|| relationship.missing !== (authority.targetMode === 'internal' && !indexedParts.has(authority.target))) {
			throw new ParadisOfficePackageError('unsafe');
		}
	}
}

function resolveRelationshipTarget(sourcePartId: string | undefined, target: string): string {
	if (!target || target.startsWith('/') || target.includes('\\') || target.includes('%')) {
		throw new ParadisOfficePackageError('malformed');
	}
	const base = sourcePartId ? sourcePartId.slice(1).split('/').slice(0, -1) : [];
	for (const segment of target.split('/')) {
		if (!segment || segment === '.') {
			continue;
		}
		if (segment === '..') {
			if (base.length === 0) {
				throw new ParadisOfficePackageError('malformed');
			}
			base.pop();
		} else {
			base.push(segment);
		}
	}
	return `/${base.join('/')}`;
}

async function indexSemanticArchive(
	archive: IParadisOfficeArchive,
	inventory: ParadisOfficeInventory,
	profile: ParadisOfficeBudgetProfile,
	token: CancellationToken | undefined,
	checkpoint: (force?: boolean) => void,
): Promise<SemanticArchiveReader> {
	const inventoryParts = new Map(inventory.parts.map(part => [part.canonicalUri, part]));
	const parts = new Map<string, IndexedArchivePart>();
	const seen = new Set<string>();
	const seenInventoryParts = new Set<string>();
	let entries = 0;
	let aggregateCompressedBytes = 0;
	for await (const entry of archive.entries(token)) {
		checkpoint();
		if (++entries > profile.entryCount) {
			throw new ParadisOfficePackageError('limitExceeded');
		}
		validateEntryMetadata(entry);
		aggregateCompressedBytes = addSafeBudget(aggregateCompressedBytes, entry.compressedBytes);
		if (aggregateCompressedBytes > archive.containerByteLength) {
			throw new ParadisOfficePackageError('zipBomb');
		}
		const canonicalName = canonicalizeParadisOfficeArchiveName(entry.directory && entry.name.endsWith('/') ? entry.name.slice(0, -1) : entry.name);
		if (seen.has(canonicalName)) {
			throw new ParadisOfficePackageError('unsafe');
		}
		seen.add(canonicalName);
		if (entry.directory) {
			continue;
		}
		if (entry.encrypted || entry.symlink) {
			throw new ParadisOfficePackageError('unsafe');
		}
		const inventoryPart = inventoryParts.get(canonicalName);
		if (!inventoryPart || entry.compressedBytes !== inventoryPart.compressedBytes || entry.declaredExpandedBytes !== inventoryPart.expandedBytes) {
			throw new ParadisOfficePackageError('unsafe');
		}
		seenInventoryParts.add(canonicalName);
		parts.set(canonicalName, { entry, inventoryPart });
	}
	if (seenInventoryParts.size !== inventoryParts.size) {
		throw new ParadisOfficePackageError('unsafe');
	}
	return { parts, parsed: new Map(), rereadCompressedBytes: 0, rereadExpandedBytes: 0 };
}

async function readSemanticPart(
	archive: IParadisOfficeArchive,
	reader: SemanticArchiveReader,
	partId: string,
	profile: ParadisOfficeBudgetProfile,
	token: CancellationToken | undefined,
	checkpoint: (force?: boolean) => void,
): Promise<ParsedPart> {
	const existing = reader.parsed.get(partId);
	if (existing) {
		return existing;
	}
	const indexed = reader.parts.get(partId);
	if (!indexed) {
		throw new ParadisOfficePackageError('unsafe');
	}
	const expectedFingerprint = allByteFingerprint(indexed.inventoryPart);
	reader.rereadCompressedBytes = addSafeBudget(reader.rereadCompressedBytes, indexed.entry.compressedBytes);
	const bytes = await readPartBytes(archive, reader, indexed.entry, profile, token, checkpoint);
	const fingerprint = await archive.hash(bytes.slice());
	if (!sameFingerprint(fingerprint, expectedFingerprint) || fingerprint.byteLength !== bytes.byteLength) {
		throw new ParadisOfficePackageError('unsafe');
	}
	const document = await archive.parseXml(decodeXml(bytes), {
		depth: profile.xmlDepth,
		nodes: profile.xmlNodesPerPart,
		attributeLength: profile.attributeLength,
		characters: profile.xmlPartBytes,
	}, token, () => checkpoint());
	const parsed = { document, source: { partId, fingerprint } };
	reader.parsed.set(partId, parsed);
	checkpoint(true);
	return parsed;
}

function addSafeBudget(left: number, right: number): number {
	const value = left + right;
	if (!Number.isSafeInteger(value) || value < 0) {
		throw new ParadisOfficePackageError('limitExceeded');
	}
	return value;
}

function validateEntryMetadata(entry: ParadisOfficeArchiveEntry): void {
	if (!Number.isSafeInteger(entry.compressedBytes) || entry.compressedBytes < 0
		|| !Number.isSafeInteger(entry.declaredExpandedBytes) || entry.declaredExpandedBytes < 0) {
		throw new ParadisOfficePackageError('invalid');
	}
}

function allByteFingerprint(part: ParadisOfficeInventoryPart): ParadisOfficeFingerprint {
	if (part.coverage !== 'parsed' || part.hashCompleteness !== 'allBytes') {
		throw new ParadisOfficePackageError('unsafe');
	}
	return part.rawHash;
}

async function readPartBytes(
	archive: IParadisOfficeArchive,
	reader: SemanticArchiveReader,
	entry: ParadisOfficeArchiveEntry,
	profile: ParadisOfficeBudgetProfile,
	token: CancellationToken | undefined,
	checkpoint: (force?: boolean) => void,
): Promise<Uint8Array> {
	const chunks: Uint8Array[] = [];
	let length = 0;
	for await (const chunk of archive.read(entry, token)) {
		checkpoint();
		if (!(chunk instanceof Uint8Array) || !Number.isSafeInteger(length + chunk.byteLength)) {
			throw new ParadisOfficePackageError('limitExceeded');
		}
		const nextLength = length + chunk.byteLength;
		const nextExpandedBytes = addSafeBudget(reader.rereadExpandedBytes, chunk.byteLength);
		if (nextLength > profile.xmlPartBytes || nextExpandedBytes > profile.expandedBytes) {
			throw new ParadisOfficePackageError('limitExceeded');
		}
		if ((entry.compressedBytes <= 0 ? nextLength > 0 : nextLength > entry.compressedBytes * profile.compressionRatio)
			|| (archive.containerByteLength <= 0 ? nextExpandedBytes > 0 : nextExpandedBytes > archive.containerByteLength * profile.compressionRatio)
			|| (reader.rereadCompressedBytes <= 0 ? nextExpandedBytes > 0 : nextExpandedBytes > reader.rereadCompressedBytes * profile.compressionRatio)) {
			throw new ParadisOfficePackageError('zipBomb');
		}
		length = nextLength;
		reader.rereadExpandedBytes = nextExpandedBytes;
		chunks.push(chunk.slice());
	}
	if (length !== entry.declaredExpandedBytes) {
		throw new ParadisOfficePackageError('unsafe');
	}
	const bytes = new Uint8Array(length);
	let offset = 0;
	for (const chunk of chunks) {
		bytes.set(chunk, offset);
		offset += chunk.byteLength;
	}
	return bytes;
}

function sameFingerprint(left: ParadisOfficeFingerprint, right: ParadisOfficeFingerprint): boolean {
	return left.algorithm === right.algorithm && left.value === right.value && left.byteLength === right.byteLength;
}

function decodeXml(bytes: Uint8Array): string {
	try {
		return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
	} catch {
		throw new ParadisOfficePackageError('malformed');
	}
}

function requiredParsedPart(parts: ReadonlyMap<string, ParsedPart>, partId: string): ParsedPart {
	const part = parts.get(partId);
	if (!part) {
		throw new ParadisOfficePackageError('unsafe');
	}
	return part;
}

function parseWorkbook(
	document: ParadisOfficeXmlDocument,
	limits: ParadisSpreadsheetSemanticLimits,
	counters: SemanticCounters,
	checkpoint: (force?: boolean) => void,
): ParsedWorkbook {
	const root = spreadsheetRoot(document, 'workbook');
	countUnknownAttributes(root, [], counters);
	let date1904 = false;
	let calcProperties: ParadisSpreadsheetCalcProperties | undefined;
	const sheets: WorkbookSheetRecord[] = [];
	const definedNames: ParadisSpreadsheetDefinedName[] = [];
	const workbookViews: ParadisSpreadsheetWorkbookView[] = [];
	const seenSingletons = new Set<string>();
	const singletonElements = new Set([
		'fileVersion', 'fileSharing', 'workbookPr', 'workbookProtection', 'bookViews', 'sheets', 'functionGroups',
		'externalReferences', 'definedNames', 'calcPr', 'oleSize', 'customWorkbookViews', 'pivotCaches', 'smartTagPr',
		'smartTagTypes', 'webPublishing', 'webPublishObjects', 'extLst',
	]);
	for (const child of elementChildren(root, checkpoint)) {
		checkpoint();
		if (!isSpreadsheetElement(child)) {
			counters.unknownElements++;
			continue;
		}
		if (singletonElements.has(child.local)) {
			if (seenSingletons.has(child.local)) {
				throw new ParadisOfficePackageError('malformed');
			}
			seenSingletons.add(child.local);
		}
		switch (child.local) {
			case 'workbookPr':
				countUnknownAttributes(child, ['date1904'], counters);
				date1904 = booleanAttribute(child, 'date1904') ?? false;
				break;
			case 'bookViews':
				parseWorkbookViews(child, workbookViews, counters, checkpoint);
				break;
			case 'sheets':
				parseWorkbookSheets(child, sheets, limits.sheets, counters, checkpoint);
				break;
			case 'definedNames':
				parseDefinedNames(child, definedNames, limits.definedNames, counters, checkpoint);
				break;
			case 'calcPr':
				calcProperties = parseCalcProperties(child, counters);
				break;
			case 'fileVersion': case 'fileSharing': case 'workbookProtection': case 'functionGroups': case 'externalReferences': case 'customWorkbookViews': case 'pivotCaches': case 'smartTagPr': case 'smartTagTypes': case 'webPublishing': case 'fileRecoveryPr': case 'webPublishObjects': case 'extLst':
				break;
			default:
				counters.unknownElements++;
		}
	}
	if (sheets.length > limits.sheets || definedNames.length > limits.definedNames) {
		throw new ParadisOfficePackageError('limitExceeded');
	}
	if (!seenSingletons.has('sheets') || sheets.length === 0) {
		throw new ParadisOfficePackageError('malformed');
	}
	return { date1904, sheets, ...(calcProperties ? { calcProperties } : {}), definedNames, workbookViews };
}

function parseWorkbookViews(root: XmlElement, result: ParadisSpreadsheetWorkbookView[], counters: SemanticCounters, checkpoint: (force?: boolean) => void): void {
	countUnknownAttributes(root, [], counters);
	for (const node of elementChildren(root, checkpoint)) {
		checkpoint();
		if (!isSpreadsheetElement(node, 'workbookView')) {
			counters.unknownElements++;
			continue;
		}
		const allowed = ['activeTab', 'firstSheet', 'visibility', 'showHorizontalScroll', 'showVerticalScroll', 'showSheetTabs', 'tabRatio', 'xWindow', 'yWindow', 'windowWidth', 'windowHeight'];
		countUnknownAttributes(node, allowed, counters);
		result.push(compact({
			activeTab: integerAttribute(node, 'activeTab'),
			firstSheet: integerAttribute(node, 'firstSheet'),
			visibility: attribute(node, 'visibility'),
			showHorizontalScroll: booleanAttribute(node, 'showHorizontalScroll'),
			showVerticalScroll: booleanAttribute(node, 'showVerticalScroll'),
			showSheetTabs: booleanAttribute(node, 'showSheetTabs'),
			tabRatio: integerAttribute(node, 'tabRatio'),
			xWindow: integerAttribute(node, 'xWindow'),
			yWindow: integerAttribute(node, 'yWindow'),
			windowWidth: integerAttribute(node, 'windowWidth'),
			windowHeight: integerAttribute(node, 'windowHeight'),
		}));
	}
}

function parseWorkbookSheets(root: XmlElement, result: WorkbookSheetRecord[], limit: number, counters: SemanticCounters, checkpoint: (force?: boolean) => void): void {
	countUnknownAttributes(root, [], counters);
	for (const node of elementChildren(root, checkpoint)) {
		checkpoint();
		if (!isSpreadsheetElement(node, 'sheet')) {
			counters.unknownElements++;
			continue;
		}
		if (result.length >= limit) {
			throw new ParadisOfficePackageError('limitExceeded');
		}
		countUnknownAttributes(node, ['name', 'sheetId', 'state'], counters, [{ namespaces: relationshipNamespaces, local: 'id' }]);
		const name = requiredAttribute(node, 'name');
		const sheetId = requiredAttribute(node, 'sheetId');
		const relationshipId = relationshipAttribute(node, 'id');
		const stateValue = attribute(node, 'state') ?? 'visible';
		if (!relationshipId || !['visible', 'hidden', 'veryHidden'].includes(stateValue)) {
			throw new ParadisOfficePackageError('malformed');
		}
		result.push({ name, sheetId, state: stateValue as ParadisSemanticSheetState, relationshipId });
	}
}

function parseDefinedNames(root: XmlElement, result: ParadisSpreadsheetDefinedName[], limit: number, counters: SemanticCounters, checkpoint: (force?: boolean) => void): void {
	countUnknownAttributes(root, [], counters);
	for (const node of elementChildren(root, checkpoint)) {
		checkpoint();
		if (!isSpreadsheetElement(node, 'definedName')) {
			counters.unknownElements++;
			continue;
		}
		if (result.length >= limit) {
			throw new ParadisOfficePackageError('limitExceeded');
		}
		const allowed = ['name', 'localSheetId', 'hidden', 'function', 'vbProcedure', 'xlm', 'functionGroupId', 'shortcutKey', 'publishToServer', 'workbookParameter', 'functionGroupId', 'description', 'help', 'statusBar', 'comment', 'customMenu'];
		countUnknownAttributes(node, allowed, counters);
		result.push(compact({
			name: requiredAttribute(node, 'name'),
			text: directTextContent(node, checkpoint),
			localSheetId: integerAttribute(node, 'localSheetId'),
			hidden: booleanAttribute(node, 'hidden'),
			function: booleanAttribute(node, 'function'),
			vbProcedure: booleanAttribute(node, 'vbProcedure'),
			xlm: booleanAttribute(node, 'xlm'),
			functionGroupId: integerAttribute(node, 'functionGroupId'),
			shortcutKey: attribute(node, 'shortcutKey'),
		}));
	}
}

function parseCalcProperties(node: XmlElement, counters: SemanticCounters): ParadisSpreadsheetCalcProperties {
	const allowed = ['calcId', 'calcMode', 'fullCalcOnLoad', 'forceFullCalc', 'calcOnSave', 'concurrentCalc', 'concurrentManualCount', 'fullPrecision', 'iterate', 'iterateCount', 'iterateDelta', 'refMode', 'calcCompleted'];
	countUnknownAttributes(node, allowed, counters);
	return compact({
		calcId: attribute(node, 'calcId'),
		calcMode: attribute(node, 'calcMode'),
		fullCalcOnLoad: booleanAttribute(node, 'fullCalcOnLoad'),
		forceFullCalc: booleanAttribute(node, 'forceFullCalc'),
		calcOnSave: booleanAttribute(node, 'calcOnSave'),
		concurrentCalc: booleanAttribute(node, 'concurrentCalc'),
		concurrentManualCount: integerAttribute(node, 'concurrentManualCount'),
		fullPrecision: booleanAttribute(node, 'fullPrecision'),
		iterate: booleanAttribute(node, 'iterate'),
		iterateCount: integerAttribute(node, 'iterateCount'),
		iterateDelta: attribute(node, 'iterateDelta'),
		refMode: attribute(node, 'refMode'),
		calcCompleted: booleanAttribute(node, 'calcCompleted'),
	});
}

function parseStyles(part: ParsedPart | undefined, counters: SemanticCounters, checkpoint: (force?: boolean) => void): ParadisSpreadsheetStyles {
	if (!part) {
		return {
			numberFormats: [], cellFormats: [], borders: [],
			completeness: { parsedCellFormats: 0, parsedBorders: 0, cellsWithStyleRefs: 0, unresolvedStyleRefs: 0, cellsWithDiagonalStyleRefs: 0 },
		};
	}
	const root = spreadsheetRoot(part.document, 'styleSheet');
	countUnknownAttributes(root, [], counters);
	const numberFormats: ParadisSpreadsheetCustomNumberFormat[] = [];
	const cellFormats: ParadisSemanticCellFormat[] = [];
	const borders: ParadisSemanticBorder[] = [];
	let declaredCellFormats: number | undefined;
	let declaredBorders: number | undefined;
	const seenSingletons = new Set<string>();
	const singletonElements = new Set([
		'numFmts', 'fonts', 'fills', 'borders', 'cellStyleXfs', 'cellXfs', 'cellStyles', 'dxfs', 'tableStyles', 'colors', 'extLst',
	]);
	for (const child of elementChildren(root, checkpoint)) {
		checkpoint();
		if (!isSpreadsheetElement(child)) {
			counters.unknownElements++;
			continue;
		}
		if (singletonElements.has(child.local)) {
			if (seenSingletons.has(child.local)) {
				throw new ParadisOfficePackageError('malformed');
			}
			seenSingletons.add(child.local);
		}
		if (['numFmts', 'fonts', 'fills', 'borders', 'cellStyleXfs', 'cellXfs', 'cellStyles', 'dxfs'].includes(child.local)) {
			countUnknownAttributes(child, ['count'], counters);
		}
		switch (child.local) {
			case 'numFmts':
				for (const node of spreadsheetChildren(child, 'numFmt', counters, checkpoint)) {
					checkpoint();
					countUnknownAttributes(node, ['numFmtId', 'formatCode'], counters);
					numberFormats.push({ id: requiredIntegerAttribute(node, 'numFmtId'), code: requiredAttribute(node, 'formatCode') });
				}
				break;
			case 'borders':
				declaredBorders = optionalCountAttribute(child);
				for (const node of spreadsheetChildren(child, 'border', counters, checkpoint)) {
					checkpoint();
					borders.push(parseBorder(node, borders.length, counters, checkpoint));
				}
				break;
			case 'cellXfs':
				declaredCellFormats = optionalCountAttribute(child);
				for (const node of spreadsheetChildren(child, 'xf', counters, checkpoint)) {
					checkpoint();
					cellFormats.push(parseCellFormat(node, cellFormats.length, counters));
				}
				break;
			case 'fonts': case 'fills': case 'cellStyleXfs': case 'cellStyles': case 'dxfs': case 'tableStyles': case 'colors': case 'extLst':
				break;
			default:
				counters.unknownElements++;
		}
	}
	if (declaredCellFormats !== undefined && declaredCellFormats !== cellFormats.length) {
		counters.unresolvedReferences++;
	}
	if (declaredBorders !== undefined && declaredBorders !== borders.length) {
		counters.unresolvedReferences++;
	}
	return {
		source: part.source,
		numberFormats,
		cellFormats,
		borders,
		completeness: {
			...(declaredCellFormats !== undefined ? { declaredCellFormats } : {}),
			parsedCellFormats: cellFormats.length,
			...(declaredBorders !== undefined ? { declaredBorders } : {}),
			parsedBorders: borders.length,
			cellsWithStyleRefs: 0,
			unresolvedStyleRefs: 0,
			cellsWithDiagonalStyleRefs: 0,
		},
	};
}

function parseBorder(node: XmlElement, index: number, counters: SemanticCounters, checkpoint: (force?: boolean) => void): ParadisSemanticBorder {
	countUnknownAttributes(node, ['diagonalUp', 'diagonalDown', 'outline'], counters);
	const result: Record<string, unknown> = compact({
		index,
		diagonalUp: booleanAttribute(node, 'diagonalUp'),
		diagonalDown: booleanAttribute(node, 'diagonalDown'),
		outline: booleanAttribute(node, 'outline'),
	});
	const validEdges = new Set(['start', 'end', 'left', 'right', 'top', 'bottom', 'diagonal', 'vertical', 'horizontal']);
	const seenEdges = new Set<string>();
	for (const child of elementChildren(node, checkpoint)) {
		if (!isSpreadsheetElement(child) || !validEdges.has(child.local)) {
			counters.unknownElements++;
			continue;
		}
		if (seenEdges.has(child.local)) {
			throw new ParadisOfficePackageError('malformed');
		}
		seenEdges.add(child.local);
		result[child.local] = parseBorderEdge(child, counters, checkpoint);
	}
	return result as unknown as ParadisSemanticBorder;
}

function parseBorderEdge(node: XmlElement, counters: SemanticCounters, checkpoint: (force?: boolean) => void): ParadisSemanticBorderEdge {
	countUnknownAttributes(node, ['style'], counters);
	const children = elementChildren(node, checkpoint);
	const colors = children.filter(child => isSpreadsheetElement(child, 'color'));
	if (colors.length > 1) {
		throw new ParadisOfficePackageError('malformed');
	}
	const color = colors[0];
	for (const child of children) {
		checkpoint();
		if (child !== color) {
			counters.unknownElements++;
		}
	}
	return compact({ style: attribute(node, 'style'), color: color ? parseColor(color, counters) : undefined });
}

function parseCellFormat(node: XmlElement, index: number, counters: SemanticCounters): ParadisSemanticCellFormat {
	const allowed = ['numFmtId', 'fontId', 'fillId', 'borderId', 'xfId', 'applyNumberFormat', 'applyFont', 'applyFill', 'applyBorder', 'applyAlignment', 'applyProtection', 'quotePrefix', 'pivotButton'];
	countUnknownAttributes(node, allowed, counters);
	return compact({
		index,
		numberFormatId: integerAttribute(node, 'numFmtId'),
		fontRef: integerAttribute(node, 'fontId'),
		fillRef: integerAttribute(node, 'fillId'),
		borderRef: integerAttribute(node, 'borderId'),
		baseStyleRef: integerAttribute(node, 'xfId'),
		applyNumberFormat: booleanAttribute(node, 'applyNumberFormat'),
		applyFont: booleanAttribute(node, 'applyFont'),
		applyFill: booleanAttribute(node, 'applyFill'),
		applyBorder: booleanAttribute(node, 'applyBorder'),
		applyAlignment: booleanAttribute(node, 'applyAlignment'),
		applyProtection: booleanAttribute(node, 'applyProtection'),
		quotePrefix: booleanAttribute(node, 'quotePrefix'),
		pivotButton: booleanAttribute(node, 'pivotButton'),
	});
}

function parseSharedStrings(
	part: ParsedPart | undefined,
	limits: ParadisSpreadsheetSemanticLimits,
	counters: SemanticCounters,
	checkpoint: (force?: boolean) => void,
): readonly SharedStringRecord[] {
	if (!part) {
		return [];
	}
	const root = spreadsheetRoot(part.document, 'sst');
	countUnknownAttributes(root, ['count', 'uniqueCount'], counters);
	const result: SharedStringRecord[] = [];
	for (const node of elementChildren(root, checkpoint)) {
		checkpoint();
		if (!isSpreadsheetElement(node, 'si')) {
			counters.unknownElements++;
			continue;
		}
		if (result.length >= limits.sharedStrings) {
			throw new ParadisOfficePackageError('limitExceeded');
		}
		result.push(parseStringContainer(node, counters, checkpoint));
	}
	return result;
}

function parseWorksheet(
	part: ParsedPart,
	partId: string,
	order: number,
	record: WorkbookSheetRecord,
	sharedStrings: readonly SharedStringRecord[],
	styles: ParadisSpreadsheetStyles,
	limits: ParadisSpreadsheetSemanticLimits,
	counters: SemanticCounters,
	checkpoint: (force?: boolean) => void,
): ParadisSemanticSheet {
	const root = spreadsheetRoot(part.document, 'worksheet');
	countUnknownAttributes(root, [], counters);
	const cells = new Map<string, ParadisSemanticCell>();
	const rows = new Map<number, ParadisSemanticRow>();
	const columns: ParadisSemanticColumn[] = [];
	const merges: ParadisSemanticRange[] = [];
	const views: ParadisSemanticSheetView[] = [];
	let dimension: ParadisSemanticRange | undefined;
	let sheetData: XmlElement | undefined;
	const seenSingletons = new Set<string>();
	const singletonElements = new Set([
		'sheetPr', 'dimension', 'sheetViews', 'sheetFormatPr', 'sheetData', 'sheetCalcPr', 'sheetProtection', 'protectedRanges',
		'scenarios', 'autoFilter', 'sortState', 'dataConsolidate', 'customSheetViews', 'mergeCells', 'phoneticPr', 'dataValidations',
		'hyperlinks', 'printOptions', 'pageMargins', 'pageSetup', 'headerFooter', 'rowBreaks', 'colBreaks', 'customProperties',
		'cellWatches', 'ignoredErrors', 'smartTags', 'drawing', 'legacyDrawing', 'legacyDrawingHF', 'picture', 'oleObjects',
		'controls', 'webPublishItems', 'tableParts', 'extLst',
	]);
	for (const child of elementChildren(root, checkpoint)) {
		checkpoint();
		if (!isSpreadsheetElement(child)) {
			counters.unknownElements++;
			continue;
		}
		if (singletonElements.has(child.local)) {
			if (seenSingletons.has(child.local)) {
				throw new ParadisOfficePackageError('malformed');
			}
			seenSingletons.add(child.local);
		}
		switch (child.local) {
			case 'dimension':
				countUnknownAttributes(child, ['ref'], counters);
				dimension = parseRange(requiredAttribute(child, 'ref'));
				break;
			case 'sheetViews':
				parseSheetViews(child, views, counters, checkpoint);
				break;
			case 'cols':
				parseColumns(child, columns, limits, counters, checkpoint);
				break;
			case 'sheetData':
				if (sheetData) {
					throw new ParadisOfficePackageError('malformed');
				}
				sheetData = child;
				break;
			case 'mergeCells':
				parseMerges(child, merges, limits, counters, checkpoint);
				break;
			case 'sheetPr': case 'sheetFormatPr': case 'sheetCalcPr': case 'sheetProtection': case 'protectedRanges': case 'scenarios': case 'autoFilter': case 'sortState': case 'dataConsolidate': case 'customSheetViews': case 'phoneticPr': case 'conditionalFormatting': case 'dataValidations': case 'hyperlinks': case 'printOptions': case 'pageMargins': case 'pageSetup': case 'headerFooter': case 'rowBreaks': case 'colBreaks': case 'customProperties': case 'cellWatches': case 'ignoredErrors': case 'smartTags': case 'drawing': case 'legacyDrawing': case 'legacyDrawingHF': case 'picture': case 'oleObjects': case 'controls': case 'webPublishItems': case 'tableParts': case 'extLst':
				break;
			default:
				counters.unknownElements++;
		}
	}
	if (!sheetData) {
		throw new ParadisOfficePackageError('malformed');
	}
	parseSheetData(sheetData, rows, cells, columns, sharedStrings, styles, limits, counters, checkpoint);
	return {
		name: record.name,
		sheetId: record.sheetId,
		order,
		state: record.state,
		relationshipId: record.relationshipId,
		partId,
		source: part.source,
		...(dimension ? { dimension } : {}),
		views,
		rows,
		columns,
		merges,
		cells,
	};
}

function parseSheetViews(root: XmlElement, result: ParadisSemanticSheetView[], counters: SemanticCounters, checkpoint: (force?: boolean) => void): void {
	countUnknownAttributes(root, [], counters);
	for (const node of elementChildren(root, checkpoint)) {
		checkpoint();
		if (!isSpreadsheetElement(node, 'sheetView')) {
			counters.unknownElements++;
			continue;
		}
		const allowed = ['workbookViewId', 'showGridLines', 'showRowColHeaders', 'showZeros', 'rightToLeft', 'tabSelected', 'showRuler', 'showOutlineSymbols', 'defaultGridColor', 'view', 'topLeftCell', 'colorId', 'zoomScale', 'zoomScaleNormal', 'zoomScaleSheetLayoutView', 'zoomScalePageLayoutView', 'windowProtection'];
		countUnknownAttributes(node, allowed, counters);
		let pane: ParadisSemanticSheetPane | undefined;
		let seenPane = false;
		const selections: ParadisSemanticSheetSelection[] = [];
		for (const child of elementChildren(node, checkpoint)) {
			if (isSpreadsheetElement(child, 'pane')) {
				if (seenPane) {
					throw new ParadisOfficePackageError('malformed');
				}
				seenPane = true;
				pane = parsePane(child, counters);
			} else if (isSpreadsheetElement(child, 'selection')) {
				selections.push(parseSelection(child, counters));
			} else if (!isSpreadsheetElement(child, 'pivotSelection') && !isSpreadsheetElement(child, 'extLst')) {
				counters.unknownElements++;
			}
		}
		result.push(compact({
			workbookViewId: integerAttribute(node, 'workbookViewId'),
			showGridLines: booleanAttribute(node, 'showGridLines'),
			showRowColHeaders: booleanAttribute(node, 'showRowColHeaders'),
			showZeros: booleanAttribute(node, 'showZeros'),
			rightToLeft: booleanAttribute(node, 'rightToLeft'),
			tabSelected: booleanAttribute(node, 'tabSelected'),
			showRuler: booleanAttribute(node, 'showRuler'),
			showOutlineSymbols: booleanAttribute(node, 'showOutlineSymbols'),
			defaultGridColor: booleanAttribute(node, 'defaultGridColor'),
			view: attribute(node, 'view'),
			topLeftCell: attribute(node, 'topLeftCell'),
			colorId: integerAttribute(node, 'colorId'),
			zoomScale: integerAttribute(node, 'zoomScale'),
			zoomScaleNormal: integerAttribute(node, 'zoomScaleNormal'),
			zoomScaleSheetLayoutView: integerAttribute(node, 'zoomScaleSheetLayoutView'),
			zoomScalePageLayoutView: integerAttribute(node, 'zoomScalePageLayoutView'),
			pane,
			selections,
		}));
	}
}

function parsePane(node: XmlElement, counters: SemanticCounters): ParadisSemanticSheetPane {
	countUnknownAttributes(node, ['xSplit', 'ySplit', 'topLeftCell', 'activePane', 'state'], counters);
	return compact({
		xSplit: attribute(node, 'xSplit'), ySplit: attribute(node, 'ySplit'), topLeftCell: attribute(node, 'topLeftCell'),
		activePane: attribute(node, 'activePane'), state: attribute(node, 'state'),
	});
}

function parseSelection(node: XmlElement, counters: SemanticCounters): ParadisSemanticSheetSelection {
	countUnknownAttributes(node, ['pane', 'activeCell', 'activeCellId', 'sqref'], counters);
	return compact({
		pane: attribute(node, 'pane'), activeCell: attribute(node, 'activeCell'),
		activeCellId: integerAttribute(node, 'activeCellId'), sqref: attribute(node, 'sqref'),
	});
}

function parseColumns(root: XmlElement, result: ParadisSemanticColumn[], limits: ParadisSpreadsheetSemanticLimits, counters: SemanticCounters, checkpoint: (force?: boolean) => void): void {
	countUnknownAttributes(root, [], counters);
	for (const node of elementChildren(root, checkpoint)) {
		checkpoint();
		if (!isSpreadsheetElement(node, 'col')) {
			counters.unknownElements++;
			continue;
		}
		if (result.length >= limits.columns) {
			throw new ParadisOfficePackageError('limitExceeded');
		}
		const allowed = ['min', 'max', 'width', 'hidden', 'customWidth', 'bestFit', 'outlineLevel', 'collapsed', 'style', 'phonetic'];
		countUnknownAttributes(node, allowed, counters);
		const min = requiredIntegerAttribute(node, 'min');
		const max = requiredIntegerAttribute(node, 'max');
		if (min < 1 || max < min || max > maximumExcelColumns) {
			throw new ParadisOfficePackageError('malformed');
		}
		result.push(compact({
			min, max, width: attribute(node, 'width'), hidden: booleanAttribute(node, 'hidden'),
			customWidth: booleanAttribute(node, 'customWidth'), bestFit: booleanAttribute(node, 'bestFit'),
			outlineLevel: integerAttribute(node, 'outlineLevel'), collapsed: booleanAttribute(node, 'collapsed'),
			styleRef: integerAttribute(node, 'style'),
		}));
	}
}

function parseSheetData(
	root: XmlElement,
	rows: Map<number, ParadisSemanticRow>,
	cells: Map<string, ParadisSemanticCell>,
	columns: readonly ParadisSemanticColumn[],
	sharedStrings: readonly SharedStringRecord[],
	styles: ParadisSpreadsheetStyles,
	limits: ParadisSpreadsheetSemanticLimits,
	counters: SemanticCounters,
	checkpoint: (force?: boolean) => void,
): void {
	countUnknownAttributes(root, [], counters);
	let previousRow = 0;
	for (const node of elementChildren(root, checkpoint)) {
		checkpoint();
		if (!isSpreadsheetElement(node, 'row')) {
			counters.unknownElements++;
			continue;
		}
		const rowIndex = integerAttribute(node, 'r') ?? previousRow + 1;
		previousRow = rowIndex;
		if (rowIndex < 1 || rowIndex > maximumExcelRows || rows.has(rowIndex) || rows.size >= limits.rows) {
			throw new ParadisOfficePackageError(rows.size >= limits.rows ? 'limitExceeded' : 'malformed');
		}
		const allowed = ['r', 'spans', 's', 'customFormat', 'ht', 'hidden', 'customHeight', 'outlineLevel', 'collapsed', 'thickTop', 'thickBot', 'ph', 'dyDescent'];
		countUnknownAttributes(node, allowed, counters, [{ namespaces: new Set(['http://schemas.microsoft.com/office/spreadsheetml/2009/9/ac']), local: 'dyDescent' }]);
		const rowStyleRef = integerAttribute(node, 's');
		const effectiveRowStyleRef = booleanAttribute(node, 'customFormat') === true ? (rowStyleRef ?? 0) : undefined;
		rows.set(rowIndex, compact({
			index: rowIndex,
			height: attribute(node, 'ht'),
			hidden: booleanAttribute(node, 'hidden'),
			customHeight: booleanAttribute(node, 'customHeight'),
			customFormat: booleanAttribute(node, 'customFormat'),
			outlineLevel: integerAttribute(node, 'outlineLevel'),
			collapsed: booleanAttribute(node, 'collapsed'),
			thickTop: booleanAttribute(node, 'thickTop'),
			thickBottom: booleanAttribute(node, 'thickBot'),
			styleRef: rowStyleRef,
		}));
		let previousColumn = 0;
		for (const cellNode of elementChildren(node, checkpoint)) {
			checkpoint();
			if (!isSpreadsheetElement(cellNode, 'c')) {
				counters.unknownElements++;
				continue;
			}
			counters.expectedCells++;
			if (counters.expectedCells > limits.cells) {
				throw new ParadisOfficePackageError('limitExceeded');
			}
			const rawAddress = attribute(cellNode, 'r');
			const addressValue = rawAddress?.toUpperCase() ?? formatCellAddress(rowIndex, previousColumn + 1);
			const coordinate = parseCellAddress(addressValue);
			if (!coordinate || coordinate.row !== rowIndex || cells.has(addressValue)) {
				throw new ParadisOfficePackageError('malformed');
			}
			previousColumn = coordinate.column;
			const explicitStyleRef = integerAttribute(cellNode, 's');
			const effectiveStyle = resolveEffectiveCellStyle(explicitStyleRef, effectiveRowStyleRef, coordinate.column, columns, styles);
			cells.set(addressValue, parseCell(cellNode, sharedStrings, styles, effectiveStyle, counters, checkpoint));
			counters.parsedCells++;
		}
	}
}

function parseCell(
	node: XmlElement,
	sharedStrings: readonly SharedStringRecord[],
	styles: ParadisSpreadsheetStyles,
	effectiveStyle: { readonly ref?: number; readonly origin?: ParadisSemanticCell['effectiveStyleOrigin'] },
	counters: SemanticCounters,
	checkpoint: (force?: boolean) => void,
): ParadisSemanticCell {
	countUnknownAttributes(node, ['r', 's', 't', 'cm', 'vm', 'ph'], counters);
	const rawType = attribute(node, 't');
	const styleRef = integerAttribute(node, 's');
	const valueNode = uniqueSpreadsheetChild(node, 'v', checkpoint);
	const formulaNode = uniqueSpreadsheetChild(node, 'f', checkpoint);
	const inlineNode = uniqueSpreadsheetChild(node, 'is', checkpoint);
	if (valueNode) {
		countUnknownAttributes(valueNode, [], counters);
	}
	if (inlineNode && rawType !== 'inlineStr') {
		throw new ParadisOfficePackageError('malformed');
	}
	for (const child of elementChildren(node, checkpoint)) {
		if (child !== valueNode && child !== formulaNode && child !== inlineNode && !isSpreadsheetElement(child, 'extLst')) {
			counters.unknownElements++;
		}
	}
	const styleFields = cellStyleFields(styleRef, effectiveStyle, styles, counters);
	if (formulaNode) {
		if (inlineNode) {
			throw new ParadisOfficePackageError('malformed');
		}
		const formula = parseFormula(formulaNode, counters, checkpoint);
		const cachedResult = valueNode
			? { present: true as const, type: cachedResultType(rawType), rawValue: directTextContent(valueNode, checkpoint) }
			: { present: false as const };
		return {
			storedType: 'formula',
			...(rawType !== undefined ? { rawType } : {}),
			rawValue: undefined,
			formula,
			cachedResult,
			...styleFields,
		};
	}
	if (rawType === 'inlineStr') {
		if (valueNode) {
			throw new ParadisOfficePackageError('malformed');
		}
		if (!inlineNode) {
			return { storedType: 'string', rawType, rawValue: { present: false }, ...styleFields };
		}
		const inline = parseStringContainer(inlineNode, counters, checkpoint);
		return { storedType: 'string', rawType, rawValue: { present: true, text: inline.text }, text: inline.text, ...(inline.richText ? { richText: inline.richText } : {}), ...styleFields };
	}
	if (rawType === 's') {
		const rawValue = semanticRawValue(valueNode, checkpoint);
		const sharedStringIndex = rawValue.present ? parseUnsignedInteger(rawValue.text) : undefined;
		const sharedString = sharedStringIndex === undefined ? undefined : sharedStrings[sharedStringIndex];
		if (!sharedString) {
			counters.unresolvedReferences++;
		}
		return {
			storedType: 'string', rawType, rawValue,
			...(sharedString ? { text: sharedString.text, sharedStringIndex, ...(sharedString.richText ? { richText: sharedString.richText } : {}) } : {}),
			...styleFields,
		};
	}
	if (rawType === 'str') {
		const rawValue = semanticRawValue(valueNode, checkpoint);
		return { storedType: 'string', rawType, rawValue, ...(rawValue.present ? { text: rawValue.text } : {}), ...styleFields };
	}
	if (rawType === 'b') {
		return { storedType: 'boolean', rawType, rawValue: semanticRawValue(valueNode, checkpoint), ...styleFields };
	}
	if (rawType === 'e') {
		return { storedType: 'error', rawType, rawValue: semanticRawValue(valueNode, checkpoint), ...styleFields };
	}
	if (rawType === 'd') {
		return { storedType: 'date', rawType, rawValue: semanticRawValue(valueNode, checkpoint), ...styleFields };
	}
	if (rawType !== undefined && rawType !== 'n') {
		counters.unresolvedReferences++;
		const rawValue = semanticRawValue(valueNode, checkpoint);
		return { storedType: 'string', rawType, rawValue, ...(rawValue.present ? { text: rawValue.text } : {}), ...styleFields };
	}
	if (!valueNode) {
		return rawType === 'n'
			? { storedType: 'number', rawType, rawValue: { present: false }, ...styleFields }
			: { storedType: 'blank', rawValue: { present: false }, ...styleFields };
	}
	return { storedType: 'number', ...(rawType ? { rawType } : {}), rawValue: { present: true, text: directTextContent(valueNode, checkpoint) }, ...styleFields };
}

function semanticRawValue(node: XmlElement | undefined, checkpoint: (force?: boolean) => void) {
	return node ? { present: true as const, text: directTextContent(node, checkpoint) } : { present: false as const };
}

function resolveEffectiveCellStyle(
	cellStyleRef: number | undefined,
	rowStyleRef: number | undefined,
	column: number,
	columns: readonly ParadisSemanticColumn[],
	styles: ParadisSpreadsheetStyles,
): { readonly ref?: number; readonly origin?: ParadisSemanticCell['effectiveStyleOrigin'] } {
	if (cellStyleRef !== undefined) {
		return { ref: cellStyleRef, origin: 'cell' };
	}
	if (rowStyleRef !== undefined) {
		return { ref: rowStyleRef, origin: 'row' };
	}
	const columnStyle = columns.find(candidate => candidate.min <= column && column <= candidate.max && candidate.styleRef !== undefined)?.styleRef;
	if (columnStyle !== undefined) {
		return { ref: columnStyle, origin: 'column' };
	}
	return styles.cellFormats.length > 0 ? { ref: 0, origin: 'default' } : {};
}

function cellStyleFields(
	styleRef: number | undefined,
	effectiveStyle: { readonly ref?: number; readonly origin?: ParadisSemanticCell['effectiveStyleOrigin'] },
	styles: ParadisSpreadsheetStyles,
	counters: SemanticCounters,
): Pick<ParadisSemanticCell, 'styleRef' | 'effectiveStyleRef' | 'effectiveStyleOrigin' | 'styleSource'> {
	if (styleRef !== undefined) {
		counters.cellsWithStyleRefs++;
	}
	if (effectiveStyle.ref === undefined) {
		return { ...(styleRef !== undefined ? { styleRef } : {}) };
	}
	const format = styles.cellFormats[effectiveStyle.ref];
	if (!format) {
		counters.unresolvedStyleRefs++;
		return {
			...(styleRef !== undefined ? { styleRef } : {}),
			effectiveStyleRef: effectiveStyle.ref,
			...(effectiveStyle.origin ? { effectiveStyleOrigin: effectiveStyle.origin } : {}),
			...(styles.source ? { styleSource: styles.source } : {}),
		};
	}
	const border = format.borderRef === undefined ? undefined : styles.borders[format.borderRef];
	if (format.borderRef !== undefined && !border) {
		counters.unresolvedStyleRefs++;
	}
	if (border?.diagonalUp || border?.diagonalDown || border?.diagonal?.style || border?.diagonal?.color) {
		counters.cellsWithDiagonalStyleRefs++;
	}
	return {
		...(styleRef !== undefined ? { styleRef } : {}),
		effectiveStyleRef: effectiveStyle.ref,
		...(effectiveStyle.origin ? { effectiveStyleOrigin: effectiveStyle.origin } : {}),
		...(styles.source ? { styleSource: styles.source } : {}),
	};
}

function parseFormula(node: XmlElement, counters: SemanticCounters, checkpoint: (force?: boolean) => void): ParadisSemanticFormula {
	countUnknownAttributes(node, ['t', 'ref', 'si', 'aca', 'bx', 'ca', 'del1', 'del2', 'dt2D', 'dtr', 'r1', 'r2'], counters);
	const kindValue = attribute(node, 't');
	const kind = kindValue === undefined || kindValue === 'normal' ? 'normal' : kindValue;
	if (kind !== 'normal' && kind !== 'shared' && kind !== 'array') {
		throw new ParadisOfficePackageError('malformed');
	}
	return compact({
		text: directTextContent(node, checkpoint),
		kind,
		ref: attribute(node, 'ref'),
		sharedIndex: integerAttribute(node, 'si'),
	});
}

function cachedResultType(rawType: string | undefined): ParadisSemanticCachedResultType {
	switch (rawType) {
		case 'str': case 's': case 'inlineStr': return 'string';
		case 'b': return 'boolean';
		case 'e': return 'error';
		case 'd': return 'date';
		default: return 'number';
	}
}

function parseStringContainer(node: XmlElement, counters: SemanticCounters, checkpoint: (force?: boolean) => void): SharedStringRecord {
	countUnknownAttributes(node, [], counters);
	const runs: ParadisSemanticRichTextRun[] = [];
	let text = '';
	let rich = false;
	for (const child of elementChildren(node, checkpoint)) {
		checkpoint();
		if (isSpreadsheetElement(child, 't')) {
			countUnknownAttributes(child, [], counters, [{ namespaces: new Set([xmlNamespace]), local: 'space' }]);
			const value = directTextContent(child, checkpoint);
			text += value;
		} else if (isSpreadsheetElement(child, 'r')) {
			rich = true;
			const run = parseRichTextRun(child, counters, checkpoint);
			runs.push(run);
			text += run.text;
		} else if (!isSpreadsheetElement(child, 'rPh') && !isSpreadsheetElement(child, 'phoneticPr')) {
			counters.unknownElements++;
		}
	}
	return { text, ...(rich ? { richText: runs } : {}) };
}

function parseRichTextRun(node: XmlElement, counters: SemanticCounters, checkpoint: (force?: boolean) => void): ParadisSemanticRichTextRun {
	countUnknownAttributes(node, [], counters);
	let properties: ParadisSemanticRichTextProperties | undefined;
	let text = '';
	for (const child of elementChildren(node, checkpoint)) {
		checkpoint();
		if (isSpreadsheetElement(child, 'rPr')) {
			properties = parseRichTextProperties(child, counters, checkpoint);
		} else if (isSpreadsheetElement(child, 't')) {
			countUnknownAttributes(child, [], counters, [{ namespaces: new Set([xmlNamespace]), local: 'space' }]);
			text += directTextContent(child, checkpoint);
		} else {
			counters.unknownElements++;
		}
	}
	return { text, ...(properties && Object.keys(properties).length > 0 ? { properties } : {}) };
}

function parseRichTextProperties(node: XmlElement, counters: SemanticCounters, checkpoint: (force?: boolean) => void): ParadisSemanticRichTextProperties {
	countUnknownAttributes(node, [], counters);
	const result: Record<string, unknown> = {};
	for (const child of elementChildren(node, checkpoint)) {
		checkpoint();
		if (!isSpreadsheetElement(child)) {
			counters.unknownElements++;
			continue;
		}
		if (child.local !== 'color') {
			countUnknownAttributes(child, ['val'], counters);
		}
		switch (child.local) {
			case 'b': result.bold = booleanAttribute(child, 'val') ?? true; break;
			case 'i': result.italic = booleanAttribute(child, 'val') ?? true; break;
			case 'strike': result.strike = booleanAttribute(child, 'val') ?? true; break;
			case 'u': result.underline = attribute(child, 'val') ?? 'single'; break;
			case 'rFont': result.fontName = attribute(child, 'val'); break;
			case 'sz': result.fontSize = attribute(child, 'val'); break;
			case 'vertAlign': result.verticalAlign = attribute(child, 'val'); break;
			case 'color': result.color = parseColor(child, counters); break;
			case 'charset': case 'family': case 'scheme': case 'condense': case 'extend': case 'outline': case 'shadow':
				break;
			default: counters.unknownElements++;
		}
	}
	return result as ParadisSemanticRichTextProperties;
}

function parseColor(node: XmlElement, counters: SemanticCounters): ParadisSpreadsheetColor {
	countUnknownAttributes(node, ['rgb', 'indexed', 'theme', 'tint', 'auto'], counters);
	const rgb = attribute(node, 'rgb');
	const indexed = integerAttribute(node, 'indexed');
	const theme = integerAttribute(node, 'theme');
	const auto = booleanAttribute(node, 'auto');
	const tint = attribute(node, 'tint');
	const sourceCount = Number(rgb !== undefined) + Number(indexed !== undefined) + Number(theme !== undefined) + Number(auto !== undefined);
	if (sourceCount !== 1) {
		throw new ParadisOfficePackageError('malformed');
	}
	if (rgb !== undefined) {
		return { kind: 'rgb', rgb, ...(tint !== undefined ? { tint } : {}) };
	}
	if (indexed !== undefined) {
		return { kind: 'indexed', indexed, ...(tint !== undefined ? { tint } : {}) };
	}
	if (theme !== undefined) {
		return { kind: 'theme', theme, ...(tint !== undefined ? { tint } : {}) };
	}
	return { kind: 'auto', auto: auto!, ...(tint !== undefined ? { tint } : {}) };
}

function parseMerges(root: XmlElement, result: ParadisSemanticRange[], limits: ParadisSpreadsheetSemanticLimits, counters: SemanticCounters, checkpoint: (force?: boolean) => void): void {
	countUnknownAttributes(root, ['count'], counters);
	for (const node of elementChildren(root, checkpoint)) {
		checkpoint();
		if (!isSpreadsheetElement(node, 'mergeCell')) {
			counters.unknownElements++;
			continue;
		}
		if (result.length >= limits.merges) {
			throw new ParadisOfficePackageError('limitExceeded');
		}
		countUnknownAttributes(node, ['ref'], counters);
		result.push(parseRange(requiredAttribute(node, 'ref')));
	}
}

function parseRange(value: string): ParadisSemanticRange {
	const references = value.replace(/\$/g, '').toUpperCase().split(':');
	if (references.length > 2) {
		throw new ParadisOfficePackageError('malformed');
	}
	const start = parseCellAddress(references[0]);
	const end = parseCellAddress(references[1] ?? references[0]);
	if (!start || !end || start.row > end.row || start.column > end.column) {
		throw new ParadisOfficePackageError('malformed');
	}
	return { ref: value, minRow: start.row, minColumn: start.column, maxRow: end.row, maxColumn: end.column };
}

function parseCellAddress(value: string): { readonly row: number; readonly column: number } | undefined {
	const match = /^([A-Z]{1,3})([1-9][0-9]{0,6})$/.exec(value);
	if (!match) {
		return undefined;
	}
	let column = 0;
	for (const character of match[1]) {
		column = column * 26 + character.charCodeAt(0) - 64;
	}
	const row = Number.parseInt(match[2], 10);
	return column <= maximumExcelColumns && row <= maximumExcelRows ? { row, column } : undefined;
}

function formatCellAddress(row: number, column: number): string {
	if (row < 1 || row > maximumExcelRows || column < 1 || column > maximumExcelColumns) {
		throw new ParadisOfficePackageError('malformed');
	}
	let value = column;
	let name = '';
	while (value > 0) {
		value--;
		name = String.fromCharCode(65 + value % 26) + name;
		value = Math.floor(value / 26);
	}
	return `${name}${row}`;
}

function spreadsheetRoot(document: ParadisOfficeXmlDocument, local: string): XmlElement {
	if (!isSpreadsheetElement(document.root, local)) {
		throw new ParadisOfficePackageError('malformed');
	}
	return document.root;
}

function isSpreadsheetElement(node: XmlElement, local?: string): boolean {
	return spreadsheetNamespaces.has(node.uri) && (local === undefined || node.local === local);
}

function uniqueSpreadsheetChild(node: XmlElement, local: string, checkpoint: (force?: boolean) => void): XmlElement | undefined {
	const matches = elementChildren(node, checkpoint).filter(child => isSpreadsheetElement(child, local));
	if (matches.length > 1) {
		throw new ParadisOfficePackageError('malformed');
	}
	return matches[0];
}

function spreadsheetChildren(node: XmlElement, local: string, counters: SemanticCounters, checkpoint: (force?: boolean) => void): readonly XmlElement[] {
	const result: XmlElement[] = [];
	for (const child of elementChildren(node, checkpoint)) {
		checkpoint();
		if (isSpreadsheetElement(child, local)) {
			result.push(child);
		} else {
			counters.unknownElements++;
		}
	}
	return result;
}

function elementChildren(node: XmlElement, checkpoint?: (force?: boolean) => void): readonly XmlElement[] {
	const result: XmlElement[] = [];
	for (const child of node.children) {
		checkpoint?.();
		if (child.kind === 'element') {
			result.push(child);
		}
	}
	return result;
}

function directTextContent(node: XmlElement, checkpoint?: (force?: boolean) => void): string {
	let value = '';
	for (const child of node.children) {
		checkpoint?.();
		if (child.kind === 'text') {
			value += child.value;
		} else {
			throw new ParadisOfficePackageError('malformed');
		}
	}
	return value;
}

function attribute(node: XmlElement, local: string): string | undefined {
	return node.attributes.find(candidate => candidate.uri === '' && candidate.local === local)?.value;
}

function relationshipAttribute(node: XmlElement, local: string): string | undefined {
	return node.attributes.find(candidate => relationshipNamespaces.has(candidate.uri) && candidate.local === local)?.value;
}

function requiredAttribute(node: XmlElement, local: string): string {
	const value = attribute(node, local);
	if (value === undefined) {
		throw new ParadisOfficePackageError('malformed');
	}
	return value;
}

function integerAttribute(node: XmlElement, local: string): number | undefined {
	const value = attribute(node, local);
	if (value === undefined) {
		return undefined;
	}
	const parsed = parseUnsignedInteger(value);
	if (parsed === undefined) {
		throw new ParadisOfficePackageError('malformed');
	}
	return parsed;
}

function requiredIntegerAttribute(node: XmlElement, local: string): number {
	const value = integerAttribute(node, local);
	if (value === undefined) {
		throw new ParadisOfficePackageError('malformed');
	}
	return value;
}

function optionalCountAttribute(node: XmlElement): number | undefined {
	return integerAttribute(node, 'count');
}

function parseUnsignedInteger(value: string): number | undefined {
	if (!/^(?:0|[1-9][0-9]*)$/.test(value)) {
		return undefined;
	}
	const result = Number.parseInt(value, 10);
	return Number.isSafeInteger(result) ? result : undefined;
}

function booleanAttribute(node: XmlElement, local: string): boolean | undefined {
	const value = attribute(node, local);
	if (value === undefined) {
		return undefined;
	}
	if (value === '1' || value === 'true') {
		return true;
	}
	if (value === '0' || value === 'false') {
		return false;
	}
	throw new ParadisOfficePackageError('malformed');
}

interface NamespacedAttributeAllowance {
	readonly namespaces: ReadonlySet<string>;
	readonly local: string;
}

function countUnknownAttributes(node: XmlElement, localNames: readonly string[], counters: SemanticCounters, namespaced: readonly NamespacedAttributeAllowance[] = []): void {
	const allowed = new Set(localNames);
	for (const candidate of node.attributes) {
		if (candidate.uri === '' && allowed.has(candidate.local)) {
			continue;
		}
		if (namespaced.some(allowance => allowance.local === candidate.local && allowance.namespaces.has(candidate.uri))) {
			continue;
		}
		counters.unknownAttributes++;
	}
}

function compact<T extends object>(value: T): T {
	const result: Record<string, unknown> = {};
	for (const [key, entry] of Object.entries(value)) {
		if (entry !== undefined) {
			result[key] = entry;
		}
	}
	return result as T;
}
