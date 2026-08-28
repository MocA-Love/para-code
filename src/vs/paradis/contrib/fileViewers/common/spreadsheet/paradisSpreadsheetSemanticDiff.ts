/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import type { CancellationToken } from '../../../../../base/common/cancellation.js';
import { StopWatch } from '../../../../../base/common/stopwatch.js';
import {
	validateOfficeChange,
	type ParadisOfficeChange,
	type ParadisOfficeChangeCategory,
	type ParadisOfficeChangeValue,
	type ParadisOfficeCompletenessManifest,
} from '../paradisOfficeProtocol.js';
import { ParadisOfficePackageError, throwIfParadisOfficeCancelled } from '../office/paradisOfficeArchive.js';
import type { ParadisSpreadsheetObjects } from './paradisSpreadsheetObjects.js';
import {
	alignSpreadsheetGrid,
	matchSpreadsheetSheets,
	type ParadisSpreadsheetGridAlignment,
	type ParadisSpreadsheetGridAlignLimits,
	type ParadisSpreadsheetSheetMatch,
} from './paradisSpreadsheetGridAlign.js';
import type {
	ParadisSemanticCell,
	ParadisSemanticColumn,
	ParadisSemanticRow,
	ParadisSemanticSheet,
	ParadisSpreadsheetSnapshot,
} from './paradisSpreadsheetSemantic.js';

export interface ParadisSpreadsheetSemanticDiffLimits {
	readonly changes: number;
	readonly diagnostics: number;
	readonly pageSize: number;
	readonly valueCharacters: number;
	readonly valueNodes: number;
	readonly sourceParts: number;
	readonly sheets: number;
	readonly grid: ParadisSpreadsheetGridAlignLimits;
}

export interface ParadisSpreadsheetSemanticDiffOptions {
	readonly categories?: readonly ParadisOfficeChangeCategory[];
	readonly cursor?: string;
	readonly pageSize?: number;
	readonly numericTolerance?: number;
	readonly cancellationToken?: CancellationToken;
	readonly now?: () => number;
	readonly deadlineMilliseconds?: number;
	readonly limits?: Partial<Omit<ParadisSpreadsheetSemanticDiffLimits, 'grid'>> & { readonly grid?: Partial<ParadisSpreadsheetGridAlignLimits> };
}

export interface ParadisSpreadsheetNumericToleranceDiagnostic {
	readonly kind: 'numericWithinTolerance';
	readonly locator: string;
	readonly originalRaw: string;
	readonly modifiedRaw: string;
	readonly delta: number;
	readonly tolerance: number;
}

export interface ParadisSpreadsheetSheetAlignment {
	readonly originalName?: string;
	readonly modifiedName?: string;
	readonly originalIndex?: number;
	readonly modifiedIndex?: number;
	readonly matchedBy: ParadisSpreadsheetSheetMatch['matchedBy'];
	readonly certainty: ParadisSpreadsheetSheetMatch['certainty'];
	readonly grid?: ParadisSpreadsheetGridAlignment;
}

export interface ParadisSpreadsheetSemanticDiffPage {
	readonly changes: readonly ParadisOfficeChange[];
	readonly alignments: readonly ParadisSpreadsheetSheetAlignment[];
	readonly diagnostics: readonly ParadisSpreadsheetNumericToleranceDiagnostic[];
	readonly completeness: ParadisOfficeCompletenessManifest;
	readonly nextCursor?: string;
	readonly terminal: boolean;
}

const categories = new Set<ParadisOfficeChangeCategory>(['content', 'formatting', 'structure', 'annotation', 'revision', 'object', 'security']);
const maximumDeadlineMilliseconds = 60_000;
const maximumChangeValueCharacters = 24 * 1024;
const maximumScalarCharacters = 4_096;
const maximumLimits: ParadisSpreadsheetSemanticDiffLimits = Object.freeze({
	changes: 100_000,
	diagnostics: 25_000,
	pageSize: 1_000,
	valueCharacters: 16 * 1024 * 1024,
	valueNodes: 1_000_000,
	sourceParts: 100_000,
	sheets: 10_000,
	grid: Object.freeze({ axisEntries: 100_000, cells: 1_000_000, lcsCells: 500_000, fingerprintCharacters: 16 * 1024 * 1024 }),
});
const gridLimitKeys = new Set<keyof ParadisSpreadsheetGridAlignLimits>(['axisEntries', 'cells', 'lcsCells', 'fingerprintCharacters']);

interface Runtime {
	readonly options: OwnedOptions;
	readonly started: number;
	readonly hardDeadline: StopWatch;
	checks: number;
	valueCharacters: number;
	valueNodes: number;
	normalizationNodes: number;
	readonly changes: ParadisOfficeChange[];
	readonly diagnostics: ParadisSpreadsheetNumericToleranceDiagnostic[];
	originalSnapshot?: ParadisSpreadsheetSnapshot;
	modifiedSnapshot?: ParadisSpreadsheetSnapshot;
}

interface OwnedOptions {
	readonly categories?: ReadonlySet<ParadisOfficeChangeCategory>;
	readonly cursor?: string;
	readonly pageSize: number;
	readonly numericTolerance?: number;
	readonly cancellationToken?: CancellationToken;
	readonly now: () => number;
	readonly deadlineMilliseconds: number;
	readonly limits: ParadisSpreadsheetSemanticDiffLimits;
}

interface CellLocation {
	readonly row: number;
	readonly column: number;
}

/** Compares two raw-semantic snapshots and returns one deterministic bounded page. */
export function compareSpreadsheetSemantics(
	original: ParadisSpreadsheetSnapshot,
	modified: ParadisSpreadsheetSnapshot,
	options: ParadisSpreadsheetSemanticDiffOptions = {},
): ParadisSpreadsheetSemanticDiffPage {
	const owned = ownOptions(options);
	const runtime: Runtime = { options: owned, started: readClock(owned.now), hardDeadline: StopWatch.create(true), checks: 0, valueCharacters: 0, valueNodes: 0, normalizationNodes: 0, changes: [], diagnostics: [] };
	checkpoint(runtime, true);
	assertSnapshot(original, runtime);
	assertSnapshot(modified, runtime);
	if (!original.completeness.terminal || !modified.completeness.terminal) { throw new ParadisOfficePackageError('unsafe'); }

	compareValue(runtime, 'structure', 'workbook.dateSystem', 'workbook', original.date1904, modified.date1904, 'exact', [original.workbookSource.partId, modified.workbookSource.partId]);
	compareValue(runtime, 'structure', 'workbook.calcProperties', 'workbook', original.calcProperties, modified.calcProperties, 'exact', [original.workbookSource.partId, modified.workbookSource.partId]);
	compareValue(runtime, 'structure', 'workbook.definedNames', 'workbook', original.definedNames, modified.definedNames, 'exact', [original.workbookSource.partId, modified.workbookSource.partId]);
	compareValue(runtime, 'structure', 'workbook.views', 'workbook', original.workbookViews, modified.workbookViews, 'exact', [original.workbookSource.partId, modified.workbookSource.partId]);

	const matches = matchSpreadsheetSheets(original.sheets, modified.sheets, gridContext(runtime));
	const alignments: ParadisSpreadsheetSheetAlignment[] = [];
	for (const match of matches) {
		checkpoint(runtime);
		if (!match.original || !match.modified) {
			const sheet = match.original ?? match.modified!;
			emit(runtime, 'structure', match.original ? 'sheet.removed' : 'sheet.added', sheet.name, match.original ? sheetIdentity(sheet) : undefined, match.modified ? sheetIdentity(sheet) : undefined, 'ambiguous', [sheet.source.partId], sheetAnchor(sheet.name));
			alignments.push(Object.freeze({
				...(match.original ? { originalName: match.original.name, originalIndex: match.originalIndex } : {}),
				...(match.modified ? { modifiedName: match.modified.name, modifiedIndex: match.modifiedIndex } : {}),
				matchedBy: match.matchedBy, certainty: match.certainty,
			}));
			continue;
		}
		const grid = alignSpreadsheetGrid(match.original, match.modified, gridContext(runtime));
		alignments.push(Object.freeze({ originalName: match.original.name, modifiedName: match.modified.name, originalIndex: match.originalIndex, modifiedIndex: match.modifiedIndex, matchedBy: match.matchedBy, certainty: match.certainty, grid }));
		compareMatchedSheet(match.original, match.modified, grid, runtime);
	}

	if (runtime.changes.length > owned.limits.changes) { throw new ParadisOfficePackageError('limitExceeded'); }
	const filtered = owned.categories ? runtime.changes.filter(change => owned.categories!.has(change.category)) : runtime.changes;
	const revision = hashText(filtered.map(change => `${change.id}:${change.category}:${change.subject.kind}:${change.subject.locator}`).join('|'));
	const offset = parseCursor(owned.cursor, revision, filtered.length);
	const end = Math.min(filtered.length, offset + owned.pageSize);
	const terminal = end === filtered.length;
	const pageChanges = Object.freeze(filtered.slice(offset, end));
	const sourcePartIds = collectSnapshotParts(original, modified, owned.limits.sourceParts);
	const opaqueParts = countOpaqueParts(original) + countOpaqueParts(modified);
	if (sourcePartIds.size + opaqueParts > owned.limits.sourceParts) { throw new ParadisOfficePackageError('limitExceeded'); }
	const completeness: ParadisOfficeCompletenessManifest = Object.freeze({
		expectedParts: sourcePartIds.size + opaqueParts,
		visitedParts: sourcePartIds.size + opaqueParts,
		parsedParts: sourcePartIds.size,
		opaqueParts,
		failedParts: 0,
		omittedParts: 0,
		expectedSemanticUnits: filtered.length,
		visitedSemanticUnits: end,
		terminal,
	});
	return Object.freeze({
		changes: pageChanges,
		alignments: Object.freeze(alignments),
		diagnostics: Object.freeze(runtime.diagnostics),
		completeness,
		...(!terminal ? { nextCursor: `spreadsheet:${end}:${revision}` } : {}),
		terminal,
	});
}

/** Compatibility alias for consumers that name the operation after its result. */
export const diffSpreadsheetSemantics = compareSpreadsheetSemantics;

/** Resolves one projection sheet without treating original/modified rename aliases as interchangeable. */
export function selectSpreadsheetSheetAlignment(
	alignments: readonly ParadisSpreadsheetSheetAlignment[],
	sheetName: string,
	side: 'modified' | 'originalOnly',
): ParadisSpreadsheetSheetAlignment | undefined {
	const candidates = alignments.filter(candidate => side === 'originalOnly'
		? candidate.modifiedName === undefined && candidate.originalName === sheetName
		: candidate.modifiedName === sheetName);
	return candidates.length === 1 ? candidates[0] : undefined;
}

function compareMatchedSheet(original: ParadisSemanticSheet, modified: ParadisSemanticSheet, grid: ParadisSpreadsheetGridAlignment, runtime: Runtime): void {
	const parts = [original.source.partId, modified.source.partId];
	const locator = modified.name;
	compareValue(runtime, 'structure', 'sheet.name', locator, original.name, modified.name, 'exact', parts, sheetAnchor(modified.name));
	compareValue(runtime, 'structure', 'sheet.order', locator, original.order, modified.order, 'exact', parts, sheetAnchor(modified.name));
	compareValue(runtime, 'structure', 'sheet.state', locator, original.state, modified.state, 'exact', parts, sheetAnchor(modified.name));
	compareValue(runtime, 'structure', 'sheet.dimension', locator, original.dimension, modified.dimension, 'exact', parts, sheetAnchor(modified.name));
	compareValue(runtime, 'structure', 'sheet.views', locator, original.views, modified.views, 'exact', parts, sheetAnchor(modified.name));
	compareValue(runtime, 'structure', 'sheet.merges', locator, original.merges, modified.merges, 'exact', parts, sheetAnchor(modified.name));
	compareAxisStructure(original, modified, grid, runtime);
	compareCells(original, modified, grid, runtime);
	compareConditionalFormatting(original, modified, runtime);
	compareValue(runtime, 'annotation', 'sheet.annotations', locator, withoutProvenance(original.annotations, runtime), withoutProvenance(modified.annotations, runtime), 'exact', annotationParts(original, modified), sheetAnchor(modified.name));
	compareObjects(original, modified, runtime);
}

function compareAxisStructure(original: ParadisSemanticSheet, modified: ParadisSemanticSheet, grid: ParadisSpreadsheetGridAlignment, runtime: Runtime): void {
	const parts = [original.source.partId, modified.source.partId];
	for (const entry of grid.rows) {
		checkpoint(runtime);
		if (entry.status !== 'aligned') {
			const locator = `${modified.name}!row:${entry.modified ?? entry.original}`;
			emit(runtime, 'structure', `row.${entry.status}`, locator, entry.original, entry.modified, entry.certainty, parts, entry.modified ? rowAnchor(modified.name, entry.modified) : undefined);
		}
		if (entry.original !== undefined && entry.modified !== undefined) {
			compareValue(runtime, 'structure', 'row.properties', `${modified.name}!row:${entry.modified}`, rowProperties(original.rows.get(entry.original)), rowProperties(modified.rows.get(entry.modified)), entry.certainty, parts, rowAnchor(modified.name, entry.modified));
		}
	}
	for (const entry of grid.columns) {
		checkpoint(runtime);
		if (entry.status !== 'aligned') {
			const locator = `${modified.name}!column:${entry.modified ?? entry.original}`;
			emit(runtime, 'structure', `column.${entry.status}`, locator, entry.original, entry.modified, entry.certainty, parts, entry.modified ? columnAnchor(modified.name, entry.modified) : undefined);
		}
		if (entry.original !== undefined && entry.modified !== undefined) {
			compareValue(runtime, 'structure', 'column.properties', `${modified.name}!column:${entry.modified}`, columnProperties(original.columns, entry.original), columnProperties(modified.columns, entry.modified), entry.certainty, parts, columnAnchor(modified.name, entry.modified));
		}
	}
}

function compareCells(original: ParadisSemanticSheet, modified: ParadisSemanticSheet, grid: ParadisSpreadsheetGridAlignment, runtime: Runtime): void {
	const rowMap = new Map<number, { readonly target: number; readonly certainty: ParadisSpreadsheetAlignmentCertainty }>();
	const columnMap = new Map<number, { readonly target: number; readonly certainty: ParadisSpreadsheetAlignmentCertainty }>();
	for (const entry of grid.rows) {
		if (entry.original !== undefined && entry.modified !== undefined) { rowMap.set(entry.original, { target: entry.modified, certainty: entry.certainty === 'heuristic' ? 'heuristic' : 'exact' }); }
	}
	for (const entry of grid.columns) {
		if (entry.original !== undefined && entry.modified !== undefined) { columnMap.set(entry.original, { target: entry.modified, certainty: entry.certainty === 'heuristic' ? 'heuristic' : 'exact' }); }
	}
	const visitedModified = new Set<string>();
	const modifiedRows = new Set([...rowMap.values()].map(value => value.target));
	const modifiedColumns = new Set([...columnMap.values()].map(value => value.target));
	for (const [address, originalCell] of original.cells) {
		checkpoint(runtime);
		const parsed = parseAddress(address);
		const row = rowMap.get(parsed.row);
		const column = columnMap.get(parsed.column);
		if (!row || !column) { continue; }
		const modifiedAddress = formatAddress(column.target, row.target);
		const modifiedCell = modified.cells.get(modifiedAddress);
		visitedModified.add(modifiedAddress);
		const certainty = row.certainty === 'heuristic' || column.certainty === 'heuristic' ? 'heuristic' : 'exact';
		if (!modifiedCell) {
			emit(runtime, 'content', 'cell.removed', `${modified.name}!${modifiedAddress}`, cellContent(originalCell), undefined, certainty, [original.source.partId, modified.source.partId], cellAnchor(modified.name, modifiedAddress));
			continue;
		}
		compareCell(originalCell, modifiedCell, address, modifiedAddress, original, modified, certainty, runtime);
	}
	for (const [address, modifiedCell] of modified.cells) {
		if (visitedModified.has(address)) { continue; }
		const parsed = parseAddress(address);
		if (modifiedRows.has(parsed.row) && modifiedColumns.has(parsed.column)) {
			emit(runtime, 'content', 'cell.added', `${modified.name}!${address}`, undefined, cellContent(modifiedCell), 'exact', [original.source.partId, modified.source.partId], cellAnchor(modified.name, address));
		}
	}
}

type ParadisSpreadsheetAlignmentCertainty = 'exact' | 'heuristic';

function compareCell(
	originalCell: ParadisSemanticCell,
	modifiedCell: ParadisSemanticCell,
	originalAddress: string,
	modifiedAddress: string,
	originalSheet: ParadisSemanticSheet,
	modifiedSheet: ParadisSemanticSheet,
	certainty: ParadisSpreadsheetAlignmentCertainty,
	runtime: Runtime,
): void {
	const locator = `${modifiedSheet.name}!${modifiedAddress}`;
	const anchor = cellAnchor(modifiedSheet.name, modifiedAddress);
	const sourceParts = uniqueParts([originalSheet.source.partId, modifiedSheet.source.partId, originalCell.styleSource?.partId, modifiedCell.styleSource?.partId]);
	compareValue(runtime, 'content', 'cell.storedType', locator, originalCell.storedType, modifiedCell.storedType, certainty, sourceParts, anchor);
	compareValue(runtime, 'content', 'cell.rawType', locator, originalCell.rawType, modifiedCell.rawType, certainty, sourceParts, anchor);
	compareValue(runtime, 'content', 'cell.rawValue', locator, originalCell.rawValue, modifiedCell.rawValue, certainty, sourceParts, anchor);
	compareValue(runtime, 'content', 'cell.text', locator, originalCell.text, modifiedCell.text, certainty, sourceParts, anchor);
	compareValue(runtime, 'content', 'cell.sharedStringIndex', locator, originalCell.sharedStringIndex, modifiedCell.sharedStringIndex, certainty, sourceParts, anchor);
	compareValue(runtime, 'content', 'cell.richText', locator, originalCell.richText, modifiedCell.richText, certainty, sourceParts, anchor);
	compareValue(runtime, 'content', 'cell.formula', locator, originalCell.formula, modifiedCell.formula, certainty, sourceParts, anchor);
	compareValue(runtime, 'content', 'cell.cachedResult', locator, originalCell.cachedResult, modifiedCell.cachedResult, certainty, sourceParts, anchor);
	compareValue(runtime, 'formatting', 'cell.styleRef', locator, rawStyleIdentity(originalCell), rawStyleIdentity(modifiedCell), certainty, sourceParts, anchor);
	const originalNumberFormat = numberFormatIdentity(originalSheet, originalCell, runtime.originalSnapshot!);
	const modifiedNumberFormat = numberFormatIdentity(modifiedSheet, modifiedCell, runtime.modifiedSnapshot!);
	compareValue(runtime, 'formatting', 'cell.numberFormat', locator, originalNumberFormat, modifiedNumberFormat, certainty, styleParts(runtime, originalSheet, modifiedSheet), anchor);
	compareValue(runtime, 'formatting', 'cell.diagonalBorder', locator, diagonalIdentity(originalCell, runtime.originalSnapshot!), diagonalIdentity(modifiedCell, runtime.modifiedSnapshot!), certainty, styleParts(runtime, originalSheet, modifiedSheet), anchor);
	compareValue(runtime, 'formatting', 'cell.format', locator, nonDiagonalFormatIdentity(originalCell, runtime.originalSnapshot!), nonDiagonalFormatIdentity(modifiedCell, runtime.modifiedSnapshot!), certainty, styleParts(runtime, originalSheet, modifiedSheet), anchor);
	diagnoseTolerance(originalCell, modifiedCell, `${modifiedSheet.name}!${modifiedAddress}`, runtime);
}

function compareConditionalFormatting(original: ParadisSemanticSheet, modified: ParadisSemanticSheet, runtime: Runtime): void {
	const locator = modified.name;
	const parts = uniqueParts([original.source.partId, modified.source.partId, original.conditionalFormatting?.stylesSource?.partId, modified.conditionalFormatting?.stylesSource?.partId]);
	compareValue(runtime, 'formatting', 'sheet.conditionalFormatting', locator, withoutProvenance(original.conditionalFormatting, runtime), withoutProvenance(modified.conditionalFormatting, runtime), 'exact', parts, sheetAnchor(modified.name));
	compareValue(runtime, 'formatting', 'conditionalFormatting.diagonalBorder', locator, conditionalDiagonals(original), conditionalDiagonals(modified), 'exact', parts, sheetAnchor(modified.name));
}

function compareObjects(original: ParadisSemanticSheet, modified: ParadisSemanticSheet, runtime: Runtime): void {
	const originalObjects = objectsOf(original);
	const modifiedObjects = objectsOf(modified);
	if (!originalObjects && !modifiedObjects) { return; }
	const parts = uniqueParts([original.source.partId, modified.source.partId, ...objectPartIds(originalObjects), ...objectPartIds(modifiedObjects)]);
	compareValue(runtime, 'object', 'sheet.objects', modified.name, objectIdentity(originalObjects), objectIdentity(modifiedObjects), 'exact', parts, sheetAnchor(modified.name));
	compareValue(runtime, 'security', 'sheet.security', modified.name, withoutProvenance(originalObjects?.security, runtime), withoutProvenance(modifiedObjects?.security, runtime), 'exact', parts, sheetAnchor(modified.name));
	compareValue(runtime, 'object', 'object.opaquePart', modified.name, originalObjects?.opaqueParts, modifiedObjects?.opaqueParts, 'opaque', parts, sheetAnchor(modified.name));
	const originalLines = new Map((originalObjects?.drawings ?? []).filter(drawing => drawing.kind === 'line').map(drawing => [drawing.id, drawing.lineGeometry]));
	const modifiedLines = new Map((modifiedObjects?.drawings ?? []).filter(drawing => drawing.kind === 'line').map(drawing => [drawing.id, drawing.lineGeometry]));
	for (const id of new Set([...originalLines.keys(), ...modifiedLines.keys()])) {
		compareValue(runtime, 'object', 'object.lineGeometry', `${modified.name}!object:${id}`, originalLines.get(id), modifiedLines.get(id), 'exact', parts, sheetAnchor(modified.name));
	}
}

function compareValue(
	runtime: Runtime,
	category: ParadisOfficeChangeCategory,
	kind: string,
	locator: string,
	before: unknown,
	after: unknown,
	certainty: ParadisOfficeChange['certainty'],
	sourceParts: readonly string[],
	anchor?: string,
): void {
	const beforeCanonical = canonicalValue(before, runtime);
	const afterCanonical = canonicalValue(after, runtime);
	assertChangeValueLength(beforeCanonical, afterCanonical);
	if (beforeCanonical === afterCanonical) { return; }
	emitCanonical(runtime, category, kind, locator, before, after, beforeCanonical, afterCanonical, certainty, sourceParts, anchor);
}

function emit(
	runtime: Runtime,
	category: ParadisOfficeChangeCategory,
	kind: string,
	locator: string,
	before: unknown,
	after: unknown,
	certainty: ParadisOfficeChange['certainty'],
	sourceParts: readonly string[],
	anchor?: string,
): void {
	const beforeCanonical = canonicalValue(before, runtime);
	const afterCanonical = canonicalValue(after, runtime);
	assertChangeValueLength(beforeCanonical, afterCanonical);
	emitCanonical(runtime, category, kind, locator, before, after, beforeCanonical, afterCanonical, certainty, sourceParts, anchor);
}

function emitCanonical(
	runtime: Runtime,
	category: ParadisOfficeChangeCategory,
	kind: string,
	locator: string,
	before: unknown,
	after: unknown,
	beforeCanonical: string,
	afterCanonical: string,
	certainty: ParadisOfficeChange['certainty'],
	sourceParts: readonly string[],
	anchor?: string,
): void {
	if (runtime.changes.length >= runtime.options.limits.changes) { throw new ParadisOfficePackageError('limitExceeded'); }
	const id = `spreadsheet:${runtime.changes.length}:${hashText(`${category}|${kind}|${locator}|${beforeCanonical}|${afterCanonical}`)}`;
	const change: ParadisOfficeChange = Object.freeze({
		id, category, subject: Object.freeze({ kind, locator }), before: changeValue(before, beforeCanonical), after: changeValue(after, afterCanonical), certainty,
		sourceParts: Object.freeze(uniqueParts(sourceParts)), ...(anchor ? { navigableAnchor: anchor } : {}),
	});
	if (!validateOfficeChange(change).valid) { throw new ParadisOfficePackageError('limitExceeded'); }
	runtime.changes.push(change);
}

function changeValue(value: unknown, canonical: string): ParadisOfficeChangeValue {
	if (value === undefined) { return Object.freeze({ kind: 'none' }); }
	if (value === null) { return Object.freeze({ kind: 'scalar', valueType: 'null', value: null }); }
	if (typeof value === 'boolean') { return Object.freeze({ kind: 'scalar', valueType: 'boolean', value }); }
	if (typeof value === 'number') { return Object.freeze({ kind: 'scalar', valueType: 'number', value: String(value) }); }
	const text = typeof value === 'string' ? value : canonical;
	if (text.length <= maximumScalarCharacters) { return Object.freeze({ kind: 'scalar', valueType: 'text', value: text }); }
	const items: ParadisOfficeChangeValue[] = [];
	for (let offset = 0; offset < text.length; offset += maximumScalarCharacters) {
		items.push(Object.freeze({ kind: 'scalar', valueType: 'text', value: text.slice(offset, offset + maximumScalarCharacters) }));
	}
	return Object.freeze({ kind: 'list', items: Object.freeze(items) });
}

function assertChangeValueLength(before: string, after: string): void {
	if (before.length > maximumChangeValueCharacters || after.length > maximumChangeValueCharacters) { throw new ParadisOfficePackageError('limitExceeded'); }
}

function canonicalValue(value: unknown, runtime: Runtime, depth = 0): string {
	if (++runtime.valueNodes > runtime.options.limits.valueNodes || depth > 24) { throw new ParadisOfficePackageError('limitExceeded'); }
	if (value === undefined) { return 'undefined'; }
	if (value === null || typeof value === 'boolean' || typeof value === 'number') { return JSON.stringify(value); }
	if (typeof value === 'string') { chargeValueCharacters(value.length, runtime); return JSON.stringify(value); }
	if (Array.isArray(value)) { return `[${value.map(item => canonicalValue(item, runtime, depth + 1)).join(',')}]`; }
	if (!value || typeof value !== 'object' || Object.getPrototypeOf(value) !== Object.prototype) { throw new ParadisOfficePackageError('unsafe'); }
	const record = value as Record<string, unknown>;
	return `{${Object.keys(record).sort().filter(key => record[key] !== undefined).map(key => `${JSON.stringify(key)}:${canonicalValue(record[key], runtime, depth + 1)}`).join(',')}}`;
}

function chargeValueCharacters(characters: number, runtime: Runtime): void {
	runtime.valueCharacters += characters;
	if (runtime.valueCharacters > runtime.options.limits.valueCharacters) { throw new ParadisOfficePackageError('limitExceeded'); }
}

function cellContent(cell: ParadisSemanticCell): unknown {
	return { storedType: cell.storedType, rawType: cell.rawType, rawValue: cell.rawValue, text: cell.text, sharedStringIndex: cell.sharedStringIndex, richText: cell.richText, formula: cell.formula, cachedResult: cell.cachedResult };
}

function rawStyleIdentity(cell: ParadisSemanticCell): unknown {
	return { styleRef: cell.styleRef, effectiveStyleRef: cell.effectiveStyleRef, effectiveStyleOrigin: cell.effectiveStyleOrigin };
}

function styleAt(cell: ParadisSemanticCell, snapshot: ParadisSpreadsheetSnapshot) {
	const index = cell.effectiveStyleRef ?? cell.styleRef;
	return index === undefined ? undefined : snapshot.styles.cellFormats.find(format => format.index === index);
}

function numberFormatIdentity(_sheet: ParadisSemanticSheet, cell: ParadisSemanticCell, snapshot: ParadisSpreadsheetSnapshot): unknown {
	const id = styleAt(cell, snapshot)?.numberFormatId;
	if (id === undefined) { return undefined; }
	return { id, code: snapshot.styles.numberFormats.find(format => format.id === id)?.code ?? `builtin:${id}` };
}

function diagonalIdentity(cell: ParadisSemanticCell, snapshot: ParadisSpreadsheetSnapshot): unknown {
	const borderRef = styleAt(cell, snapshot)?.borderRef;
	if (borderRef === undefined) { return undefined; }
	const border = snapshot.styles.borders.find(candidate => candidate.index === borderRef);
	if (!border || (!border.diagonalUp && !border.diagonalDown && !border.diagonal)) { return undefined; }
	return { borderRef, up: !!border.diagonalUp, down: !!border.diagonalDown, style: border.diagonal?.style, color: border.diagonal?.color };
}

function nonDiagonalFormatIdentity(cell: ParadisSemanticCell, snapshot: ParadisSpreadsheetSnapshot): unknown {
	const format = styleAt(cell, snapshot);
	if (!format) { return undefined; }
	const { numberFormatId: _numberFormatId, borderRef, ...rest } = format;
	const border = borderRef === undefined ? undefined : snapshot.styles.borders.find(candidate => candidate.index === borderRef);
	if (!border) { return rest; }
	const { diagonalUp: _diagonalUp, diagonalDown: _diagonalDown, diagonal: _diagonal, ...nonDiagonalBorder } = border;
	return { ...rest, borderRef, border: nonDiagonalBorder };
}

function conditionalDiagonals(sheet: ParadisSemanticSheet): unknown {
	return sheet.conditionalFormatting?.differentialStyles
		.filter(style => style.border?.diagonal || style.border?.diagonalUp || style.border?.diagonalDown)
		.map(style => ({ index: style.index, up: !!style.border?.diagonalUp, down: !!style.border?.diagonalDown, style: style.border?.diagonal?.style, color: style.border?.diagonal?.color }));
}

function withoutProvenance(value: unknown, runtime: Runtime, depth = 0, ancestors = new WeakSet<object>()): unknown {
	checkpoint(runtime);
	if (++runtime.normalizationNodes > runtime.options.limits.valueNodes || depth > 24) { throw new ParadisOfficePackageError('limitExceeded'); }
	if (value === undefined || value === null || typeof value !== 'object') { return value; }
	if (ancestors.has(value)) { throw new ParadisOfficePackageError('unsafe'); }
	ancestors.add(value);
	if (Array.isArray(value)) {
		const result = value.map(item => withoutProvenance(item, runtime, depth + 1, ancestors));
		ancestors.delete(value);
		return result;
	}
	if (Object.getPrototypeOf(value) !== Object.prototype) { throw new ParadisOfficePackageError('unsafe'); }
	const result: Record<string, unknown> = {};
	for (const key of Object.keys(value)) {
		if (key === 'source' || key.endsWith('Source')) { continue; }
		result[key] = withoutProvenance((value as Record<string, unknown>)[key], runtime, depth + 1, ancestors);
	}
	ancestors.delete(value);
	return result;
}

function rowProperties(row: ParadisSemanticRow | undefined): unknown {
	if (!row) { return undefined; }
	return { height: row.height, hidden: row.hidden, customHeight: row.customHeight, customFormat: row.customFormat, outlineLevel: row.outlineLevel, collapsed: row.collapsed, thickTop: row.thickTop, thickBottom: row.thickBottom, styleRef: row.styleRef };
}

function columnProperties(columns: readonly ParadisSemanticColumn[], index: number): unknown {
	const column = columns.find(candidate => index >= candidate.min && index <= candidate.max);
	if (!column) { return undefined; }
	return { width: column.width, hidden: column.hidden, customWidth: column.customWidth, bestFit: column.bestFit, outlineLevel: column.outlineLevel, collapsed: column.collapsed, styleRef: column.styleRef };
}

function diagnoseTolerance(original: ParadisSemanticCell, modified: ParadisSemanticCell, locator: string, runtime: Runtime): void {
	const tolerance = runtime.options.numericTolerance;
	if (tolerance === undefined || original.storedType !== 'number' || modified.storedType !== 'number' || !original.rawValue?.present || !modified.rawValue?.present || original.rawValue.text === modified.rawValue.text) { return; }
	const before = Number(original.rawValue.text);
	const after = Number(modified.rawValue.text);
	const delta = Math.abs(before - after);
	if (!Number.isFinite(before) || !Number.isFinite(after) || delta > tolerance) { return; }
	if (runtime.diagnostics.length >= runtime.options.limits.diagnostics) { throw new ParadisOfficePackageError('limitExceeded'); }
	runtime.diagnostics.push(Object.freeze({ kind: 'numericWithinTolerance', locator, originalRaw: original.rawValue.text, modifiedRaw: modified.rawValue.text, delta, tolerance }));
}

function objectIdentity(objects: ParadisSpreadsheetObjects | undefined): unknown {
	if (!objects) { return undefined; }
	return {
		images: objects.images,
		drawings: objects.drawings.map(drawing => {
			const { lineGeometry: _lineGeometry, ...identity } = drawing;
			return identity;
		}),
		charts: objects.charts,
		opaqueDrawings: objects.opaqueDrawings,
		pivots: objects.pivots,
	};
}

function objectsOf(sheet: ParadisSemanticSheet): ParadisSpreadsheetObjects | undefined {
	return (sheet as ParadisSemanticSheet & { readonly objects?: ParadisSpreadsheetObjects }).objects;
}

function objectPartIds(objects: ParadisSpreadsheetObjects | undefined): string[] {
	if (!objects) { return []; }
	return uniqueParts([
		...objects.images.map(item => item.source.partId),
		...objects.drawings.map(item => item.source.partId),
		...objects.charts.flatMap(item => [item.source.partId, item.chartSource.partId]),
		...objects.opaqueDrawings.map(item => item.source.partId),
		...objects.pivots.map(item => item.source.partId),
		...objects.security.sheetProtections.map(item => item.source.partId),
	]);
}

function annotationParts(original: ParadisSemanticSheet, modified: ParadisSemanticSheet): string[] {
	return uniqueParts([
		original.source.partId, modified.source.partId,
		...annotationPartIds(original.annotations), ...annotationPartIds(modified.annotations),
	]);
}

function annotationPartIds(annotations: ParadisSemanticSheet['annotations']): string[] {
	if (!annotations) { return []; }
	return uniqueParts([
		annotations.worksheetSource.partId, annotations.contentTypesSource.partId, annotations.rootRelationshipsSource.partId,
		annotations.workbookSource.partId, annotations.worksheetRelationshipsSource.partId, annotations.workbookRelationshipsSource.partId,
		annotations.commentsSource?.partId, annotations.vmlDrawingSource?.partId, annotations.vmlDrawingRelationshipsSource?.partId,
		annotations.threadedCommentsSource?.partId, annotations.personsSource?.partId,
	]);
}

function sheetIdentity(sheet: ParadisSemanticSheet): unknown {
	return { name: sheet.name, sheetId: sheet.sheetId, order: sheet.order, state: sheet.state, partId: sheet.partId, source: sheet.source };
}

function styleParts(runtime: Runtime, original: ParadisSemanticSheet, modified: ParadisSemanticSheet): string[] {
	return uniqueParts([original.source.partId, modified.source.partId, runtime.originalSnapshot?.styles.source?.partId, runtime.modifiedSnapshot?.styles.source?.partId]);
}

function uniqueParts(values: readonly (string | undefined)[]): string[] {
	return [...new Set(values.filter((value): value is string => typeof value === 'string'))].sort();
}

function collectSnapshotParts(original: ParadisSpreadsheetSnapshot, modified: ParadisSpreadsheetSnapshot, limit: number): Set<string> {
	const parts = new Set<string>();
	for (const [side, snapshot] of [['original', original], ['modified', modified]] as const) {
		const add = (partId: string): void => { parts.add(`${side}:${partId}`); };
		add(snapshot.workbookSource.partId);
		if (snapshot.styles.source) { add(snapshot.styles.source.partId); }
		for (const sheet of snapshot.sheets) {
			add(sheet.source.partId);
			for (const part of annotationPartIds(sheet.annotations)) { add(part); }
			for (const part of objectPartIds(objectsOf(sheet))) { add(part); }
			if (parts.size > limit) { throw new ParadisOfficePackageError('limitExceeded'); }
		}
	}
	return parts;
}

function countOpaqueParts(snapshot: ParadisSpreadsheetSnapshot): number {
	return snapshot.sheets.reduce((count, sheet) => count + (objectsOf(sheet)?.opaqueParts.length ?? 0), 0);
}

function assertSnapshot(value: unknown, runtime: Runtime): asserts value is ParadisSpreadsheetSnapshot {
	checkpoint(runtime);
	if (!value || typeof value !== 'object' || Object.getPrototypeOf(value) !== Object.prototype) { throw new ParadisOfficePackageError('unsafe'); }
	const snapshot = value as Partial<ParadisSpreadsheetSnapshot>;
	if (!Array.isArray(snapshot.sheets) || snapshot.sheets.length > runtime.options.limits.sheets || !snapshot.styles || typeof snapshot.styles !== 'object'
		|| !snapshot.completeness || typeof snapshot.completeness !== 'object' || !snapshot.workbookSource || typeof snapshot.workbookSource !== 'object') {
		throw new ParadisOfficePackageError(Array.isArray(snapshot.sheets) ? 'limitExceeded' : 'unsafe');
	}
	if (!runtime.originalSnapshot) { runtime.originalSnapshot = value as ParadisSpreadsheetSnapshot; } else { runtime.modifiedSnapshot = value as ParadisSpreadsheetSnapshot; }
}

function ownOptions(value: ParadisSpreadsheetSemanticDiffOptions): OwnedOptions {
	if (!value || typeof value !== 'object' || Object.getPrototypeOf(value) !== Object.prototype) { throw new ParadisOfficePackageError('unsafe'); }
	const allowed = new Set(['categories', 'cursor', 'pageSize', 'numericTolerance', 'cancellationToken', 'now', 'deadlineMilliseconds', 'limits']);
	for (const key of Object.keys(value)) { if (!allowed.has(key)) { throw new ParadisOfficePackageError('unsafe'); } }
	let selectedCategories: ReadonlySet<ParadisOfficeChangeCategory> | undefined;
	if (value.categories !== undefined) {
		if (!Array.isArray(value.categories) || value.categories.length > categories.size || value.categories.some(category => !categories.has(category))) { throw new ParadisOfficePackageError('unsafe'); }
		selectedCategories = new Set(value.categories);
	}
	const now = value.now ?? Date.now;
	const deadlineMilliseconds = value.deadlineMilliseconds ?? maximumDeadlineMilliseconds;
	if (typeof now !== 'function' || !Number.isSafeInteger(deadlineMilliseconds) || deadlineMilliseconds < 0 || deadlineMilliseconds > maximumDeadlineMilliseconds) { throw new ParadisOfficePackageError('limitExceeded'); }
	if (value.cursor !== undefined && typeof value.cursor !== 'string') { throw new ParadisOfficePackageError('unsafe'); }
	if (value.numericTolerance !== undefined && (!Number.isFinite(value.numericTolerance) || value.numericTolerance < 0)) { throw new ParadisOfficePackageError('unsafe'); }
	const limits = ownLimits(value.limits);
	const pageSize = value.pageSize ?? Math.min(250, limits.pageSize);
	if (!Number.isSafeInteger(pageSize) || pageSize < 1 || pageSize > limits.pageSize) { throw new ParadisOfficePackageError('limitExceeded'); }
	return {
		...(selectedCategories ? { categories: selectedCategories } : {}),
		...(value.cursor !== undefined ? { cursor: value.cursor } : {}),
		pageSize,
		...(value.numericTolerance !== undefined ? { numericTolerance: value.numericTolerance } : {}),
		...(value.cancellationToken ? { cancellationToken: value.cancellationToken } : {}),
		now, deadlineMilliseconds, limits,
	};
}

function ownLimits(value: ParadisSpreadsheetSemanticDiffOptions['limits']): ParadisSpreadsheetSemanticDiffLimits {
	if (value === undefined) { return maximumLimits; }
	if (!value || typeof value !== 'object' || Object.getPrototypeOf(value) !== Object.prototype) { throw new ParadisOfficePackageError('unsafe'); }
	const result = { ...maximumLimits, grid: { ...maximumLimits.grid } };
	const scalarKeys = ['changes', 'diagnostics', 'pageSize', 'valueCharacters', 'valueNodes', 'sourceParts', 'sheets'] as const;
	for (const key of Object.keys(value)) {
		if (![...scalarKeys, 'grid'].includes(key as typeof scalarKeys[number] | 'grid')) { throw new ParadisOfficePackageError('unsafe'); }
	}
	for (const key of scalarKeys) {
		const candidate = value[key];
		if (candidate === undefined) { continue; }
		if (!Number.isSafeInteger(candidate) || candidate < 1 || candidate > maximumLimits[key]) { throw new ParadisOfficePackageError('limitExceeded'); }
		result[key] = candidate;
	}
	if (value.grid !== undefined) {
		if (!value.grid || typeof value.grid !== 'object' || Object.getPrototypeOf(value.grid) !== Object.prototype) { throw new ParadisOfficePackageError('unsafe'); }
		for (const key of Object.keys(value.grid) as (keyof ParadisSpreadsheetGridAlignLimits)[]) {
			if (!gridLimitKeys.has(key)) { throw new ParadisOfficePackageError('unsafe'); }
			const candidate = value.grid[key];
			if (!Number.isSafeInteger(candidate) || (candidate as number) < 1 || (candidate as number) > maximumLimits.grid[key]) { throw new ParadisOfficePackageError('limitExceeded'); }
			result.grid[key] = candidate as number;
		}
	}
	return Object.freeze({ ...result, grid: Object.freeze(result.grid) });
}

function gridContext(runtime: Runtime) {
	checkpoint(runtime, true);
	const elapsedClock = Math.max(0, readClock(runtime.options.now) - runtime.started);
	const remaining = Math.max(0, Math.floor(Math.min(runtime.options.deadlineMilliseconds - elapsedClock, runtime.options.deadlineMilliseconds - runtime.hardDeadline.elapsed())));
	return { cancellationToken: runtime.options.cancellationToken, now: runtime.options.now, deadlineMilliseconds: remaining, limits: runtime.options.limits.grid };
}

function parseCursor(cursor: string | undefined, revision: string, length: number): number {
	if (cursor === undefined) { return 0; }
	const match = /^spreadsheet:(\d+):([0-9a-f]+)$/.exec(cursor);
	if (!match || match[2] !== revision) { throw new ParadisOfficePackageError('unsafe'); }
	const offset = Number(match[1]);
	if (!Number.isSafeInteger(offset) || offset < 0 || offset > length) { throw new ParadisOfficePackageError('unsafe'); }
	return offset;
}

function checkpoint(runtime: Runtime, force = false): void {
	if (!force && ++runtime.checks % 128 !== 0) { return; }
	throwIfParadisOfficeCancelled(runtime.options.cancellationToken);
	const current = readClock(runtime.options.now);
	if (current - runtime.started > runtime.options.deadlineMilliseconds || runtime.hardDeadline.elapsed() > runtime.options.deadlineMilliseconds) { throw new ParadisOfficePackageError('limitExceeded'); }
}

function readClock(now: () => number): number {
	const value = now();
	if (!Number.isFinite(value)) { throw new ParadisOfficePackageError('unsafe'); }
	return value;
}

function parseAddress(address: string): CellLocation {
	const match = /^([A-Z]{1,3})([1-9]\d{0,6})$/.exec(address);
	if (!match) { throw new ParadisOfficePackageError('unsafe'); }
	const column = [...match[1]].reduce((total, char) => total * 26 + char.charCodeAt(0) - 64, 0);
	const row = Number(match[2]);
	if (column > 16_384 || row > 1_048_576) { throw new ParadisOfficePackageError('unsafe'); }
	return { row, column };
}

function formatAddress(column: number, row: number): string {
	let value = column;
	let name = '';
	while (value > 0) { value--; name = String.fromCharCode(65 + value % 26) + name; value = Math.floor(value / 26); }
	return `${name}${row}`;
}

function sheetAnchor(name: string): string { return `sheet:${encodeURIComponent(name)}`; }
function cellAnchor(name: string, address: string): string { return `${sheetAnchor(name)}!${address}`; }
function rowAnchor(name: string, row: number): string { return `${sheetAnchor(name)}!row:${row}`; }
function columnAnchor(name: string, column: number): string { return `${sheetAnchor(name)}!column:${column}`; }

function hashText(value: string): string {
	let hash = 0x811c9dc5;
	for (let index = 0; index < value.length; index++) { hash ^= value.charCodeAt(index); hash = Math.imul(hash, 0x01000193); }
	return (hash >>> 0).toString(16).padStart(8, '0');
}
