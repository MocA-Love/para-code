/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import type { CancellationToken } from '../../../../../base/common/cancellation.js';
import { StopWatch } from '../../../../../base/common/stopwatch.js';
import { ParadisOfficePackageError, throwIfParadisOfficeCancelled } from '../office/paradisOfficeArchive.js';
import type { ParadisSemanticCell, ParadisSemanticSheet } from './paradisSpreadsheetSemantic.js';

export type ParadisSpreadsheetAlignmentCertainty = 'exact' | 'heuristic' | 'ambiguous';
export type ParadisSpreadsheetAlignmentStatus = 'aligned' | 'moved' | 'added' | 'removed';

export interface ParadisSpreadsheetAxisAlignmentEntry {
	readonly original?: number;
	readonly modified?: number;
	readonly status: ParadisSpreadsheetAlignmentStatus;
	readonly certainty: ParadisSpreadsheetAlignmentCertainty;
}

export interface ParadisSpreadsheetGridAlignment {
	readonly rows: readonly ParadisSpreadsheetAxisAlignmentEntry[];
	readonly columns: readonly ParadisSpreadsheetAxisAlignmentEntry[];
}

export interface ParadisSpreadsheetSheetMatch {
	readonly original?: ParadisSemanticSheet;
	readonly modified?: ParadisSemanticSheet;
	readonly originalIndex?: number;
	readonly modifiedIndex?: number;
	readonly matchedBy: 'partIdentity' | 'name' | 'contentFingerprint' | 'unmatched';
	readonly certainty: 'exact' | 'heuristic' | 'ambiguous';
}

export interface ParadisSpreadsheetGridAlignLimits {
	readonly axisEntries: number;
	readonly cells: number;
	readonly lcsCells: number;
	readonly fingerprintCharacters: number;
}

export interface ParadisSpreadsheetGridAlignContext {
	readonly cancellationToken?: CancellationToken;
	readonly now?: () => number;
	readonly deadlineMilliseconds?: number;
	readonly limits?: Partial<ParadisSpreadsheetGridAlignLimits>;
}

const maximumLimits: ParadisSpreadsheetGridAlignLimits = Object.freeze({
	axisEntries: 100_000,
	cells: 1_000_000,
	lcsCells: 500_000,
	fingerprintCharacters: 16 * 1024 * 1024,
});
const limitKeys = new Set<keyof ParadisSpreadsheetGridAlignLimits>(['axisEntries', 'cells', 'lcsCells', 'fingerprintCharacters']);
const maximumDeadlineMilliseconds = 60_000;

interface Runtime {
	readonly cancellationToken?: CancellationToken;
	readonly now: () => number;
	readonly started: number;
	readonly deadlineMilliseconds: number;
	readonly hardDeadline: StopWatch;
	readonly limits: ParadisSpreadsheetGridAlignLimits;
	checks: number;
	cells: number;
	fingerprintCharacters: number;
	readonly countedCellMaps: WeakSet<object>;
	readonly cellIdentities: WeakMap<object, string>;
}

interface AxisItem {
	readonly index: number;
	readonly fingerprint: string;
}

interface Pair {
	readonly original: number;
	readonly modified: number;
	readonly certainty: 'exact' | 'heuristic';
	readonly moved?: boolean;
}

/** Matches sheets in the stable priority required by semantic diff. */
export function matchSpreadsheetSheets(
	original: readonly ParadisSemanticSheet[],
	modified: readonly ParadisSemanticSheet[],
	context: ParadisSpreadsheetGridAlignContext = {},
): readonly ParadisSpreadsheetSheetMatch[] {
	const runtime = createRuntime(context);
	assertSheetArray(original, runtime);
	assertSheetArray(modified, runtime);
	const unmatchedOriginal = new Set(original.map((_sheet, index) => index));
	const unmatchedModified = new Set(modified.map((_sheet, index) => index));
	const matches: ParadisSpreadsheetSheetMatch[] = [];

	matchUnique(original, modified, unmatchedOriginal, unmatchedModified, sheet => sheet.partId, 'partIdentity', 'exact', matches, runtime);
	matchUnique(original, modified, unmatchedOriginal, unmatchedModified, sheet => sheet.name, 'name', 'exact', matches, runtime);
	const originalFingerprints = new Map<number, string>();
	const modifiedFingerprints = new Map<number, string>();
	for (const index of unmatchedOriginal) { originalFingerprints.set(index, sheetContentFingerprintOwned(original[index], runtime)); }
	for (const index of unmatchedModified) { modifiedFingerprints.set(index, sheetContentFingerprintOwned(modified[index], runtime)); }
	matchUnique(
		original, modified, unmatchedOriginal, unmatchedModified,
		(_sheet, index, side) => (side === 'original' ? originalFingerprints : modifiedFingerprints).get(index)!,
		'contentFingerprint', 'heuristic', matches, runtime,
	);

	for (const originalIndex of unmatchedOriginal) {
		matches.push({ original: original[originalIndex], originalIndex, matchedBy: 'unmatched', certainty: 'ambiguous' });
	}
	for (const modifiedIndex of unmatchedModified) {
		matches.push({ modified: modified[modifiedIndex], modifiedIndex, matchedBy: 'unmatched', certainty: 'ambiguous' });
	}
	matches.sort((left, right) => (left.originalIndex ?? Number.MAX_SAFE_INTEGER) - (right.originalIndex ?? Number.MAX_SAFE_INTEGER)
		|| (left.modifiedIndex ?? Number.MAX_SAFE_INTEGER) - (right.modifiedIndex ?? Number.MAX_SAFE_INTEGER));
	return Object.freeze(matches.map(match => Object.freeze(match)));
}

/** Aligns logical rows and columns from cell content only. Style, dimensions, and diagonals are intentionally excluded. */
export function alignSpreadsheetGrid(
	original: ParadisSemanticSheet,
	modified: ParadisSemanticSheet,
	context: ParadisSpreadsheetGridAlignContext = {},
): ParadisSpreadsheetGridAlignment {
	const runtime = createRuntime(context);
	assertSheet(original, runtime);
	assertSheet(modified, runtime);
	const originalRows = rowItems(original, runtime);
	const modifiedRows = rowItems(modified, runtime);
	const originalColumns = columnItems(original, runtime);
	const modifiedColumns = columnItems(modified, runtime);
	let rows = alignAxis(originalRows, modifiedRows, runtime);
	let columns = alignAxis(originalColumns, modifiedColumns, runtime);
	const initialRows = pairedCoordinates(rows);
	if (initialRows.length > 0) {
		columns = alignAxis(
			columnItems(original, runtime, initialRows.map(pair => pair.original)),
			columnItems(modified, runtime, initialRows.map(pair => pair.modified)),
			runtime,
		);
	}
	const refinedColumns = pairedCoordinates(columns);
	if (refinedColumns.length > 0) {
		rows = alignAxis(
			rowItems(original, runtime, refinedColumns.map(pair => pair.original)),
			rowItems(modified, runtime, refinedColumns.map(pair => pair.modified)),
			runtime,
		);
	}
	const refinedRows = pairedCoordinates(rows);
	if (refinedRows.length > 0) {
		columns = alignAxis(
			columnItems(original, runtime, refinedRows.map(pair => pair.original)),
			columnItems(modified, runtime, refinedRows.map(pair => pair.modified)),
			runtime,
		);
	}
	return Object.freeze({
		rows,
		columns,
	});
}

/** Bounded content fingerprint used only after part identity and name matching fail. */
export function spreadsheetSheetContentFingerprint(sheet: ParadisSemanticSheet, context: ParadisSpreadsheetGridAlignContext = {}): string {
	const runtime = createRuntime(context);
	return sheetContentFingerprintOwned(sheet, runtime);
}

function sheetContentFingerprintOwned(sheet: ParadisSemanticSheet, runtime: Runtime): string {
	assertSheet(sheet, runtime);
	const entries: string[] = [];
	for (const [, cell] of sortedCells(sheet, runtime)) {
		entries.push(cellContentIdentity(cell, runtime));
	}
	entries.sort();
	return fingerprintKey(entries.join('\u001E'));
}

function matchUnique(
	original: readonly ParadisSemanticSheet[],
	modified: readonly ParadisSemanticSheet[],
	unmatchedOriginal: Set<number>,
	unmatchedModified: Set<number>,
	keyOf: (sheet: ParadisSemanticSheet, index: number, side: 'original' | 'modified') => string,
	matchedBy: ParadisSpreadsheetSheetMatch['matchedBy'],
	certainty: ParadisSpreadsheetSheetMatch['certainty'],
	matches: ParadisSpreadsheetSheetMatch[],
	runtime: Runtime,
): void {
	const originalByKey = indexUnique(unmatchedOriginal, index => keyOf(original[index], index, 'original'), runtime);
	const modifiedByKey = indexUnique(unmatchedModified, index => keyOf(modified[index], index, 'modified'), runtime);
	for (const [key, originalIndexes] of originalByKey) {
		checkpoint(runtime);
		const modifiedIndexes = modifiedByKey.get(key);
		if (originalIndexes.length !== 1 || modifiedIndexes?.length !== 1) {
			continue;
		}
		const originalIndex = originalIndexes[0];
		const modifiedIndex = modifiedIndexes[0];
		unmatchedOriginal.delete(originalIndex);
		unmatchedModified.delete(modifiedIndex);
		matches.push({ original: original[originalIndex], modified: modified[modifiedIndex], originalIndex, modifiedIndex, matchedBy, certainty });
	}
}

function indexUnique(indexes: ReadonlySet<number>, keyOf: (index: number) => string, runtime: Runtime): Map<string, number[]> {
	const result = new Map<string, number[]>();
	for (const index of indexes) {
		checkpoint(runtime);
		const key = keyOf(index);
		const values = result.get(key);
		if (values) { values.push(index); } else { result.set(key, [index]); }
	}
	return result;
}

function rowItems(sheet: ParadisSemanticSheet, runtime: Runtime, projectedColumns?: readonly number[]): AxisItem[] {
	const cells = sortedCells(sheet, runtime);
	let maximum = 0;
	const values = new Map<number, string[]>();
	for (const [address, cell] of cells) {
		const parsed = parseAddress(address);
		maximum = Math.max(maximum, parsed.row);
		if (!projectedColumns) {
			const row = values.get(parsed.row);
			const identity = `${parsed.column}:${cellContentIdentity(cell, runtime)}`;
			if (row) { row.push(identity); } else { values.set(parsed.row, [identity]); }
		}
	}
	for (const index of sheet.rows.keys()) { maximum = Math.max(maximum, safeAxisIndex(index)); }
	if (projectedColumns && maximum * projectedColumns.length > runtime.limits.cells) { throw new ParadisOfficePackageError('limitExceeded'); }
	return buildAxis(maximum, index => fingerprintKey(projectedColumns
		? projectedColumns.map(column => cellIdentityAt(sheet, index, column, runtime)).join('\u001F')
		: values.get(index)?.join('\u001F') ?? ''), runtime);
}

function columnItems(sheet: ParadisSemanticSheet, runtime: Runtime, projectedRows?: readonly number[]): AxisItem[] {
	const cells = sortedCells(sheet, runtime);
	let maximum = 0;
	const values = new Map<number, string[]>();
	for (const [address, cell] of cells) {
		const parsed = parseAddress(address);
		maximum = Math.max(maximum, parsed.column);
		if (!projectedRows) {
			const column = values.get(parsed.column);
			const identity = `${parsed.row}:${cellContentIdentity(cell, runtime)}`;
			if (column) { column.push(identity); } else { values.set(parsed.column, [identity]); }
		}
	}
	for (const column of sheet.columns) { maximum = Math.max(maximum, safeAxisIndex(column.max)); }
	if (projectedRows && maximum * projectedRows.length > runtime.limits.cells) { throw new ParadisOfficePackageError('limitExceeded'); }
	return buildAxis(maximum, index => fingerprintKey(projectedRows
		? projectedRows.map(row => cellIdentityAt(sheet, row, index, runtime)).join('\u001F')
		: values.get(index)?.join('\u001F') ?? ''), runtime);
}

function pairedCoordinates(entries: readonly ParadisSpreadsheetAxisAlignmentEntry[]): readonly { readonly original: number; readonly modified: number }[] {
	return entries.flatMap(entry => entry.original !== undefined && entry.modified !== undefined ? [{ original: entry.original, modified: entry.modified }] : []);
}

function cellIdentityAt(sheet: ParadisSemanticSheet, row: number, column: number, runtime: Runtime): string {
	const cell = Map.prototype.get.call(sheet.cells, formatAddress(column, row)) as ParadisSemanticCell | undefined;
	return cell ? cellContentIdentity(cell, runtime) : 'null';
}

function buildAxis(maximum: number, fingerprintAt: (index: number) => string, runtime: Runtime): AxisItem[] {
	if (maximum > runtime.limits.axisEntries) { throw new ParadisOfficePackageError('limitExceeded'); }
	const result: AxisItem[] = [];
	for (let index = 1; index <= maximum; index++) {
		checkpoint(runtime);
		result.push({ index, fingerprint: fingerprintAt(index) });
	}
	return result;
}

function cellContentIdentity(cell: ParadisSemanticCell, runtime: Runtime): string {
	const cached = runtime.cellIdentities.get(cell);
	if (cached !== undefined) { return cached; }
	const identity = JSON.stringify([
		cell.storedType,
		cell.rawType ?? null,
		cell.rawValue?.present ? cell.rawValue.text : null,
		cell.text ?? null,
		cell.sharedStringIndex ?? null,
		cell.formula ? [cell.formula.kind, cell.formula.sharedIndex ?? null, cell.formula.ref ?? null, cell.formula.text] : null,
		cell.cachedResult?.present ? [cell.cachedResult.type, cell.cachedResult.rawValue] : null,
		cell.richText?.map(run => run.text) ?? null,
	]);
	chargeFingerprint(identity.length, runtime);
	runtime.cellIdentities.set(cell, identity);
	return identity;
}

function alignAxis(original: readonly AxisItem[], modified: readonly AxisItem[], runtime: Runtime): readonly ParadisSpreadsheetAxisAlignmentEntry[] {
	const originalCounts = counts(original);
	const modifiedCounts = counts(modified);
	const modifiedUniquePosition = new Map<string, number>();
	for (let index = 0; index < modified.length; index++) {
		if (modifiedCounts.get(modified[index].fingerprint) === 1) { modifiedUniquePosition.set(modified[index].fingerprint, index); }
	}
	const candidates: { readonly original: number; readonly modified: number }[] = [];
	for (let index = 0; index < original.length; index++) {
		const item = original[index];
		if (originalCounts.get(item.fingerprint) === 1) {
			const modifiedIndex = modifiedUniquePosition.get(item.fingerprint);
			if (modifiedIndex !== undefined) { candidates.push({ original: index, modified: modifiedIndex }); }
		}
	}
	const anchors = longestIncreasingCandidates(candidates, runtime);
	const pairs: Pair[] = anchors.map(anchor => ({ ...anchor, certainty: 'exact' }));
	let previousOriginal = -1;
	let previousModified = -1;
	for (let anchorIndex = 0; anchorIndex <= anchors.length; anchorIndex++) {
		const nextOriginal = anchorIndex < anchors.length ? anchors[anchorIndex].original : original.length;
		const nextModified = anchorIndex < anchors.length ? anchors[anchorIndex].modified : modified.length;
		alignGap(original, modified, previousOriginal + 1, nextOriginal, previousModified + 1, nextModified, pairs, runtime);
		previousOriginal = nextOriginal;
		previousModified = nextModified;
	}
	const pairedOriginal = new Set(pairs.map(pair => pair.original));
	const pairedModified = new Set(pairs.map(pair => pair.modified));
	// A unique equal item outside the monotonic anchor chain is a genuine move, not an insertion/deletion tie.
	for (let originalIndex = 0; originalIndex < original.length; originalIndex++) {
		if (pairedOriginal.has(originalIndex)) { continue; }
		const fingerprint = original[originalIndex].fingerprint;
		if (originalCounts.get(fingerprint) !== 1 || modifiedCounts.get(fingerprint) !== 1) { continue; }
		const modifiedIndex = modifiedUniquePosition.get(fingerprint)!;
		if (!pairedModified.has(modifiedIndex)) {
			pairs.push({ original: originalIndex, modified: modifiedIndex, certainty: 'exact', moved: true });
			pairedOriginal.add(originalIndex);
			pairedModified.add(modifiedIndex);
		}
	}
	const entries: ParadisSpreadsheetAxisAlignmentEntry[] = pairs.map(pair => Object.freeze({
		original: original[pair.original].index,
		modified: modified[pair.modified].index,
		status: pair.moved ? 'moved' : 'aligned',
		certainty: pair.certainty,
	}));
	for (let index = 0; index < original.length; index++) {
		if (!pairedOriginal.has(index)) {
			entries.push(Object.freeze({ original: original[index].index, status: 'removed', certainty: isAmbiguous(original[index].fingerprint, originalCounts, modifiedCounts) ? 'ambiguous' : 'exact' }));
		}
	}
	for (let index = 0; index < modified.length; index++) {
		if (!pairedModified.has(index)) {
			entries.push(Object.freeze({ modified: modified[index].index, status: 'added', certainty: isAmbiguous(modified[index].fingerprint, originalCounts, modifiedCounts) ? 'ambiguous' : 'exact' }));
		}
	}
	entries.sort((left, right) => (left.modified ?? Number.MAX_SAFE_INTEGER) - (right.modified ?? Number.MAX_SAFE_INTEGER)
		|| (left.original ?? Number.MAX_SAFE_INTEGER) - (right.original ?? Number.MAX_SAFE_INTEGER));
	return Object.freeze(entries);
}

function alignGap(
	original: readonly AxisItem[], modified: readonly AxisItem[],
	originalStart: number, originalEnd: number, modifiedStart: number, modifiedEnd: number,
	pairs: Pair[], runtime: Runtime,
): void {
	const originalLength = originalEnd - originalStart;
	const modifiedLength = modifiedEnd - modifiedStart;
	if (originalLength === 1 && modifiedLength === 1) {
		pairs.push({ original: originalStart, modified: modifiedStart, certainty: 'heuristic' });
		return;
	}
	if (originalLength === 0 || modifiedLength === 0 || originalLength * modifiedLength > runtime.limits.lcsCells) { return; }
	const originalCounts = counts(original.slice(originalStart, originalEnd));
	const modifiedCounts = counts(modified.slice(modifiedStart, modifiedEnd));
	const width = modifiedLength + 1;
	const dp = new Uint32Array((originalLength + 1) * width);
	for (let i = originalLength - 1; i >= 0; i--) {
		checkpoint(runtime);
		for (let j = modifiedLength - 1; j >= 0; j--) {
			const fingerprint = original[originalStart + i].fingerprint;
			const equalUnique = fingerprint === modified[modifiedStart + j].fingerprint
				&& originalCounts.get(fingerprint) === 1 && modifiedCounts.get(fingerprint) === 1;
			dp[i * width + j] = equalUnique ? dp[(i + 1) * width + j + 1] + 1 : Math.max(dp[(i + 1) * width + j], dp[i * width + j + 1]);
		}
	}
	let i = 0;
	let j = 0;
	while (i < originalLength && j < modifiedLength) {
		const fingerprint = original[originalStart + i].fingerprint;
		if (fingerprint === modified[modifiedStart + j].fingerprint && originalCounts.get(fingerprint) === 1 && modifiedCounts.get(fingerprint) === 1) {
			pairs.push({ original: originalStart + i, modified: modifiedStart + j, certainty: 'exact' });
			i++; j++;
		} else if (dp[(i + 1) * width + j] >= dp[i * width + j + 1]) {
			i++;
		} else {
			j++;
		}
	}
}

function longestIncreasingCandidates(candidates: readonly { readonly original: number; readonly modified: number }[], runtime: Runtime): readonly { readonly original: number; readonly modified: number }[] {
	if (candidates.length === 0) { return []; }
	const tails: number[] = [];
	const previous = new Int32Array(candidates.length);
	previous.fill(-1);
	for (let index = 0; index < candidates.length; index++) {
		checkpoint(runtime);
		let low = 0;
		let high = tails.length;
		while (low < high) {
			const middle = (low + high) >>> 1;
			if (candidates[tails[middle]].modified < candidates[index].modified) { low = middle + 1; } else { high = middle; }
		}
		if (low > 0) { previous[index] = tails[low - 1]; }
		tails[low] = index;
	}
	const result: { original: number; modified: number }[] = [];
	for (let index = tails[tails.length - 1]; index >= 0; index = previous[index]) { result.push(candidates[index]); }
	return result.reverse();
}

function counts(items: readonly AxisItem[]): Map<string, number> {
	const result = new Map<string, number>();
	for (const item of items) { result.set(item.fingerprint, (result.get(item.fingerprint) ?? 0) + 1); }
	return result;
}

function isAmbiguous(fingerprint: string, originalCounts: ReadonlyMap<string, number>, modifiedCounts: ReadonlyMap<string, number>): boolean {
	return (originalCounts.get(fingerprint) ?? 0) > 1 || (modifiedCounts.get(fingerprint) ?? 0) > 1;
}

function sortedCells(sheet: ParadisSemanticSheet, runtime: Runtime): readonly [string, ParadisSemanticCell][] {
	if (!(sheet.cells instanceof Map) || Object.getPrototypeOf(sheet.cells) !== Map.prototype || sheet.cells.size > runtime.limits.cells) {
		throw new ParadisOfficePackageError(sheet.cells instanceof Map ? 'limitExceeded' : 'unsafe');
	}
	if (!runtime.countedCellMaps.has(sheet.cells)) {
		runtime.countedCellMaps.add(sheet.cells);
		runtime.cells += sheet.cells.size;
		if (runtime.cells > runtime.limits.cells) { throw new ParadisOfficePackageError('limitExceeded'); }
	}
	const result = [...sheet.cells.entries()];
	result.sort((left, right) => {
		const a = parseAddress(left[0]);
		const b = parseAddress(right[0]);
		return a.row - b.row || a.column - b.column;
	});
	return result;
}

function parseAddress(address: string): { readonly row: number; readonly column: number } {
	if (typeof address !== 'string') { throw new ParadisOfficePackageError('unsafe'); }
	const match = /^([A-Z]{1,3})([1-9]\d{0,6})$/.exec(address);
	if (!match) { throw new ParadisOfficePackageError('unsafe'); }
	const column = [...match[1]].reduce((total, char) => total * 26 + char.charCodeAt(0) - 64, 0);
	const row = Number(match[2]);
	if (column > 16_384 || row > 1_048_576) { throw new ParadisOfficePackageError('unsafe'); }
	return { row, column };
}

function safeAxisIndex(value: unknown): number {
	if (!Number.isSafeInteger(value) || (value as number) < 1) { throw new ParadisOfficePackageError('unsafe'); }
	return value as number;
}

function hashText(value: string): string {
	let hash = 0x811c9dc5;
	for (let index = 0; index < value.length; index++) {
		hash ^= value.charCodeAt(index);
		hash = Math.imul(hash, 0x01000193);
	}
	return `${value.length}:${(hash >>> 0).toString(16).padStart(8, '0')}`;
}

function fingerprintKey(value: string): string {
	return `${value.length}:${hashText(value)}:${value}`;
}

function chargeFingerprint(characters: number, runtime: Runtime): void {
	runtime.fingerprintCharacters += characters;
	if (runtime.fingerprintCharacters > runtime.limits.fingerprintCharacters) { throw new ParadisOfficePackageError('limitExceeded'); }
}

function assertSheetArray(value: unknown, runtime: Runtime): asserts value is readonly ParadisSemanticSheet[] {
	if (!Array.isArray(value) || value.length > runtime.limits.axisEntries) { throw new ParadisOfficePackageError(Array.isArray(value) ? 'limitExceeded' : 'unsafe'); }
	for (const sheet of value) { assertSheet(sheet, runtime); }
}

function assertSheet(value: unknown, runtime: Runtime): asserts value is ParadisSemanticSheet {
	checkpoint(runtime);
	if (!value || typeof value !== 'object' || Object.getPrototypeOf(value) !== Object.prototype) { throw new ParadisOfficePackageError('unsafe'); }
	const sheet = value as Partial<ParadisSemanticSheet>;
	if (typeof sheet.name !== 'string' || typeof sheet.partId !== 'string' || !Number.isSafeInteger(sheet.order)
		|| sheet.name.length > 255 || sheet.partId.length > 4_096
		|| !(sheet.cells instanceof Map) || Object.getPrototypeOf(sheet.cells) !== Map.prototype
		|| !(sheet.rows instanceof Map) || Object.getPrototypeOf(sheet.rows) !== Map.prototype
		|| !Array.isArray(sheet.columns)) {
		throw new ParadisOfficePackageError('unsafe');
	}
}

function createRuntime(context: ParadisSpreadsheetGridAlignContext): Runtime {
	if (!context || typeof context !== 'object' || Object.getPrototypeOf(context) !== Object.prototype) { throw new ParadisOfficePackageError('unsafe'); }
	const now = context.now ?? Date.now;
	const deadlineMilliseconds = context.deadlineMilliseconds ?? maximumDeadlineMilliseconds;
	if (typeof now !== 'function' || !Number.isSafeInteger(deadlineMilliseconds) || deadlineMilliseconds < 0 || deadlineMilliseconds > maximumDeadlineMilliseconds) {
		throw new ParadisOfficePackageError('limitExceeded');
	}
	const limits = { ...maximumLimits };
	if (context.limits !== undefined) {
		if (!context.limits || typeof context.limits !== 'object' || Object.getPrototypeOf(context.limits) !== Object.prototype) { throw new ParadisOfficePackageError('unsafe'); }
		for (const key of Object.keys(context.limits) as (keyof ParadisSpreadsheetGridAlignLimits)[]) {
			if (!limitKeys.has(key)) { throw new ParadisOfficePackageError('unsafe'); }
			const candidate = context.limits[key];
			if (!Number.isSafeInteger(candidate) || (candidate as number) < 1 || (candidate as number) > maximumLimits[key]) { throw new ParadisOfficePackageError('limitExceeded'); }
			limits[key] = candidate as number;
		}
	}
	const started = readClock(now);
	const runtime: Runtime = {
		...(context.cancellationToken ? { cancellationToken: context.cancellationToken } : {}),
		now, started, deadlineMilliseconds, hardDeadline: StopWatch.create(true), limits, checks: 0, cells: 0, fingerprintCharacters: 0,
		countedCellMaps: new WeakSet(), cellIdentities: new WeakMap(),
	};
	checkpoint(runtime, true);
	return runtime;
}

function checkpoint(runtime: Runtime, force = false): void {
	if (!force && ++runtime.checks % 128 !== 0) { return; }
	throwIfParadisOfficeCancelled(runtime.cancellationToken);
	const current = readClock(runtime.now);
	if (current - runtime.started > runtime.deadlineMilliseconds || runtime.hardDeadline.elapsed() > runtime.deadlineMilliseconds) {
		throw new ParadisOfficePackageError('limitExceeded');
	}
}

function readClock(now: () => number): number {
	const value = now();
	if (!Number.isFinite(value)) { throw new ParadisOfficePackageError('unsafe'); }
	return value;
}

function formatAddress(column: number, row: number): string {
	let value = column;
	let name = '';
	while (value > 0) { value--; name = String.fromCharCode(65 + value % 26) + name; value = Math.floor(value / 26); }
	return `${name}${row}`;
}
