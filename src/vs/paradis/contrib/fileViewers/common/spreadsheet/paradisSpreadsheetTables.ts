/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import type { CancellationToken } from '../../../../../base/common/cancellation.js';
import { StopWatch } from '../../../../../base/common/stopwatch.js';
import {
	type ParadisOfficeXmlDocument,
	type ParadisOfficeXmlNode,
	ParadisOfficePackageError,
	throwIfParadisOfficeCancelled,
} from '../office/paradisOfficeArchive.js';
import { parseParadisOfficeXml } from '../office/paradisOfficeCanonicalXml.js';
import {
	parseSpreadsheetA1Range,
	parseSpreadsheetPrintSemantics,
	redactSpreadsheetHeaderFooterText,
	type ParadisSpreadsheetPrintSemantics,
} from './paradisSpreadsheetPageLayout.js';
import type { ParadisSemanticRange, ParadisSemanticSheet, ParadisSpreadsheetPartSource, ParadisSpreadsheetTextIdentity } from './paradisSpreadsheetSemantic.js';

type XmlElement = Extract<ParadisOfficeXmlNode, { readonly kind: 'element' }>;

const spreadsheetNamespaces = new Set([
	'http://schemas.openxmlformats.org/spreadsheetml/2006/main',
	'http://purl.oclc.org/ooxml/spreadsheetml/main',
]);
const officeRelationshipNamespaces = new Set([
	'http://schemas.openxmlformats.org/officeDocument/2006/relationships',
	'http://purl.oclc.org/ooxml/officeDocument/relationships',
]);
const packageRelationshipNamespace = 'http://schemas.openxmlformats.org/package/2006/relationships';
const contentTypeNamespace = 'http://schemas.openxmlformats.org/package/2006/content-types';
const xmlNamespace = 'http://www.w3.org/XML/1998/namespace';
const contentTypesPartId = '/[Content_Types].xml';
const rootRelationshipsPartId = '/_rels/.rels';
const parsedModels = new WeakSet<object>();

const relationshipTypes = Object.freeze({ officeDocument: 'officeDocument', worksheet: 'worksheet', table: 'table', printerSettings: 'printerSettings' });
const contentTypes = Object.freeze({
	relationships: new Set(['application/vnd.openxmlformats-package.relationships+xml']),
	workbook: new Set([
		'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml',
		'application/vnd.ms-excel.sheet.main+xml',
		'application/vnd.ms-excel.sheet.macroEnabled.main+xml',
		'application/vnd.openxmlformats-officedocument.spreadsheetml.template.main+xml',
		'application/vnd.ms-excel.template.macroEnabled.main+xml',
	]),
	worksheet: new Set([
		'application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml',
		'application/vnd.ms-excel.worksheet+xml',
	]),
	table: new Set(['application/vnd.openxmlformats-officedocument.spreadsheetml.table+xml']),
	printerSettings: new Set(['application/vnd.openxmlformats-officedocument.spreadsheetml.printerSettings']),
});

export interface ParadisSpreadsheetStoredTableFormula {
	readonly text: string;
	readonly array?: boolean;
	readonly evaluation: 'notCalculated';
	readonly fingerprint: ParadisSpreadsheetPartSource['fingerprint'];
}

export type ParadisSpreadsheetTableTotalsFunction = 'none' | 'sum' | 'min' | 'max' | 'average' | 'count' | 'countNums' | 'stdDev' | 'var' | 'custom';

export interface ParadisSpreadsheetTableColumn {
	readonly id: number;
	readonly name: string;
	readonly uniqueName?: string;
	readonly totalsRowLabel?: string;
	readonly totalsRowFunction?: ParadisSpreadsheetTableTotalsFunction;
	readonly queryTableFieldId?: number;
	readonly headerRowDxfId?: number;
	readonly dataDxfId?: number;
	readonly totalsRowDxfId?: number;
	readonly headerRowCellStyle?: string;
	readonly dataCellStyle?: string;
	readonly totalsRowCellStyle?: string;
	readonly calculatedColumnFormula?: ParadisSpreadsheetStoredTableFormula;
	readonly totalsRowFormula?: ParadisSpreadsheetStoredTableFormula;
}

export interface ParadisSpreadsheetTableStyleInfo {
	readonly name?: string;
	readonly showFirstColumn?: boolean;
	readonly showLastColumn?: boolean;
	readonly showRowStripes?: boolean;
	readonly showColumnStripes?: boolean;
}

export type ParadisSpreadsheetFilterCriterion =
	| { readonly kind: 'value'; readonly value: string }
	| { readonly kind: 'blank' }
	| { readonly kind: 'custom'; readonly operator?: string; readonly value: string }
	| { readonly kind: 'dynamic'; readonly type: string; readonly value?: string; readonly maxValue?: string }
	| { readonly kind: 'top10'; readonly top?: boolean; readonly percent?: boolean; readonly value: string; readonly filterValue?: string }
	| { readonly kind: 'color'; readonly dxfId?: number; readonly cellColor?: boolean }
	| { readonly kind: 'icon'; readonly iconSet: string; readonly iconId?: number }
	| { readonly kind: 'dateGroup'; readonly grouping: string; readonly year?: number; readonly month?: number; readonly day?: number; readonly hour?: number; readonly minute?: number; readonly second?: number };

export interface ParadisSpreadsheetFilterColumn {
	readonly columnId: number;
	readonly hiddenButton?: boolean;
	readonly showButton?: boolean;
	readonly customFiltersAnd?: boolean;
	readonly calendarType?: 'none' | 'gregorian' | 'gregorianUs' | 'japan' | 'taiwan' | 'korea' | 'hijri' | 'thai' | 'hebrew' | 'gregorianMeFrench' | 'gregorianArabic' | 'gregorianXlitEnglish' | 'gregorianXlitFrench';
	readonly criteria: readonly ParadisSpreadsheetFilterCriterion[];
}

export interface ParadisSpreadsheetSortCondition {
	readonly range: ParadisSemanticRange;
	readonly descending?: boolean;
	readonly sortBy?: string;
	readonly customList?: string;
	readonly dxfId?: number;
	readonly iconSet?: string;
	readonly iconId?: number;
}

export interface ParadisSpreadsheetSortState {
	readonly range: ParadisSemanticRange;
	readonly caseSensitive?: boolean;
	readonly columnSort?: boolean;
	readonly sortMethod?: string;
	readonly conditions: readonly ParadisSpreadsheetSortCondition[];
}

export interface ParadisSpreadsheetAutoFilter {
	readonly range: ParadisSemanticRange;
	readonly columns: readonly ParadisSpreadsheetFilterColumn[];
	readonly sortState?: ParadisSpreadsheetSortState;
}

export interface ParadisSpreadsheetTable {
	readonly id: number;
	readonly name: string;
	readonly displayName: string;
	readonly comment?: string;
	readonly tableType?: 'worksheet' | 'xml' | 'queryTable';
	readonly connectionId?: number;
	readonly headerRowDxfId?: number;
	readonly dataDxfId?: number;
	readonly totalsRowDxfId?: number;
	readonly headerRowBorderDxfId?: number;
	readonly tableBorderDxfId?: number;
	readonly totalsRowBorderDxfId?: number;
	readonly headerRowCellStyle?: string;
	readonly dataCellStyle?: string;
	readonly totalsRowCellStyle?: string;
	readonly range: ParadisSemanticRange;
	readonly source: ParadisSpreadsheetPartSource;
	readonly headerRowCount: number;
	readonly totalsRowCount: number;
	readonly totalsRowShown: boolean;
	readonly insertRow?: boolean;
	readonly insertRowShift?: boolean;
	readonly published?: boolean;
	readonly columns: readonly ParadisSpreadsheetTableColumn[];
	readonly autoFilter?: ParadisSpreadsheetAutoFilter;
	readonly sortState?: ParadisSpreadsheetSortState;
	readonly styleInfo?: ParadisSpreadsheetTableStyleInfo;
}

export interface ParadisSpreadsheetOpaqueTableFragment {
	readonly name: { readonly namespace: string; readonly local: string };
	readonly path: string;
	readonly ordinal: number;
	readonly fingerprint: ParadisSpreadsheetPartSource['fingerprint'];
	readonly source: ParadisSpreadsheetPartSource;
}

export interface ParadisSpreadsheetTableRangeOverlay {
	readonly kind: 'table' | 'tableFilter' | 'tableSort' | 'worksheetFilter' | 'worksheetSort' | 'printArea';
	readonly id: string;
	readonly range: ParadisSemanticRange;
	readonly source: ParadisSpreadsheetPartSource;
}

export interface ParadisSpreadsheetTablesCompleteness {
	readonly expectedParts: number;
	readonly visitedParts: number;
	readonly parsedParts: number;
	readonly opaqueParts: number;
	readonly failedParts: number;
	readonly omittedParts: number;
	readonly expectedSemanticUnits: number;
	readonly visitedSemanticUnits: number;
	readonly unknownElements: number;
	readonly unknownAttributes: number;
	readonly unresolvedReferences: number;
	readonly terminal: boolean;
}

export interface ParadisSpreadsheetTablesAndPrint {
	readonly contentTypesSource: ParadisSpreadsheetPartSource;
	readonly rootRelationshipsSource: ParadisSpreadsheetPartSource;
	readonly workbookSource: ParadisSpreadsheetPartSource;
	readonly workbookRelationshipsSource: ParadisSpreadsheetPartSource;
	readonly worksheetSource: ParadisSpreadsheetPartSource;
	readonly worksheetRelationshipsSource: ParadisSpreadsheetPartSource;
	readonly tables: readonly ParadisSpreadsheetTable[];
	readonly worksheetAutoFilter?: ParadisSpreadsheetAutoFilter;
	readonly worksheetSortState?: ParadisSpreadsheetSortState;
	readonly print: ParadisSpreadsheetPrintSemantics;
	readonly opaqueFragments: readonly ParadisSpreadsheetOpaqueTableFragment[];
	readonly rangeOverlays: readonly ParadisSpreadsheetTableRangeOverlay[];
	readonly completeness: ParadisSpreadsheetTablesCompleteness;
}

export interface ParadisSpreadsheetRawTablePart {
	readonly xml: string;
	readonly bytes: Uint8Array;
	readonly source: ParadisSpreadsheetPartSource;
}

export interface ParadisSpreadsheetRawOpaquePart {
	readonly bytes: Uint8Array;
	readonly source: ParadisSpreadsheetPartSource;
}

export interface ParadisSpreadsheetTablesInput {
	readonly contentTypesXml: string;
	readonly contentTypesBytes: Uint8Array;
	readonly contentTypesSource: ParadisSpreadsheetPartSource;
	readonly rootRelationshipsXml: string;
	readonly rootRelationshipsBytes: Uint8Array;
	readonly rootRelationshipsSource: ParadisSpreadsheetPartSource;
	readonly workbookXml: string;
	readonly workbookBytes: Uint8Array;
	readonly workbookSource: ParadisSpreadsheetPartSource;
	readonly workbookRelationshipsXml: string;
	readonly workbookRelationshipsBytes: Uint8Array;
	readonly workbookRelationshipsSource: ParadisSpreadsheetPartSource;
	readonly worksheetXml: string;
	readonly worksheetBytes: Uint8Array;
	readonly worksheetSource: ParadisSpreadsheetPartSource;
	readonly worksheetRelationshipsXml: string;
	readonly worksheetRelationshipsBytes: Uint8Array;
	readonly worksheetRelationshipsSource: ParadisSpreadsheetPartSource;
	readonly tableParts: readonly ParadisSpreadsheetRawTablePart[];
	readonly printerSettingsParts?: readonly ParadisSpreadsheetRawOpaquePart[];
}

export interface ParadisSpreadsheetVerifiedTablePart {
	readonly document: ParadisOfficeXmlDocument;
	readonly bytes: Uint8Array;
	readonly source: ParadisSpreadsheetPartSource;
}

/** @internal Documents whose bytes and PartSource were issued by the Task 1 parser. */
export interface ParadisSpreadsheetVerifiedTablesInput {
	readonly contentTypesDocument: ParadisOfficeXmlDocument;
	readonly contentTypesBytes: Uint8Array;
	readonly contentTypesSource: ParadisSpreadsheetPartSource;
	readonly rootRelationshipsDocument: ParadisOfficeXmlDocument;
	readonly rootRelationshipsBytes: Uint8Array;
	readonly rootRelationshipsSource: ParadisSpreadsheetPartSource;
	readonly workbookDocument: ParadisOfficeXmlDocument;
	readonly workbookBytes: Uint8Array;
	readonly workbookSource: ParadisSpreadsheetPartSource;
	readonly workbookRelationshipsDocument: ParadisOfficeXmlDocument;
	readonly workbookRelationshipsBytes: Uint8Array;
	readonly workbookRelationshipsSource: ParadisSpreadsheetPartSource;
	readonly worksheetDocument: ParadisOfficeXmlDocument;
	readonly worksheetBytes: Uint8Array;
	readonly worksheetSource: ParadisSpreadsheetPartSource;
	readonly worksheetRelationshipsDocument: ParadisOfficeXmlDocument;
	readonly worksheetRelationshipsBytes: Uint8Array;
	readonly worksheetRelationshipsSource: ParadisSpreadsheetPartSource;
	readonly tableParts: readonly ParadisSpreadsheetVerifiedTablePart[];
	readonly printerSettingsParts?: readonly ParadisSpreadsheetRawOpaquePart[];
}

export interface ParadisSpreadsheetTablesLimits {
	readonly xmlCharacters: number;
	readonly aggregateXmlCharacters: number;
	readonly aggregateXmlNodes: number;
	readonly xmlDepth: number;
	readonly xmlNodes: number;
	readonly attributeLength: number;
	readonly tables: number;
	readonly tableColumns: number;
	readonly filterColumns: number;
	readonly filterCriteria: number;
	readonly sortConditions: number;
	readonly printRanges: number;
	readonly pageBreaks: number;
	readonly formulas: number;
	readonly formulaCharacters: number;
	readonly textCharacters: number;
	readonly opaqueFragments: number;
	readonly opaqueCharacters: number;
	readonly outputNodes: number;
	readonly outputProperties: number;
}

const commonLimits = {
	tables: 1_024, tableColumns: 65_536, filterColumns: 65_536, filterCriteria: 262_144, sortConditions: 65_536,
	printRanges: 1_024, pageBreaks: 100_000, formulas: 65_536, formulaCharacters: 16 * 1024 * 1024,
	textCharacters: 24 * 1024 * 1024, opaqueFragments: 100_000, opaqueCharacters: 24 * 1024 * 1024,
	outputNodes: 1_000_000, outputProperties: 2_000_000,
};
const limitsByProfile = Object.freeze({
	desktop: { ...commonLimits, xmlCharacters: 64 * 1024 * 1024, aggregateXmlCharacters: 256 * 1024 * 1024, aggregateXmlNodes: 4_000_000, xmlDepth: 128, xmlNodes: 2_000_000, attributeLength: 1024 * 1024 },
	remote: { ...commonLimits, xmlCharacters: 32 * 1024 * 1024, aggregateXmlCharacters: 128 * 1024 * 1024, aggregateXmlNodes: 2_000_000, xmlDepth: 96, xmlNodes: 1_000_000, attributeLength: 512 * 1024 },
	browser: { ...commonLimits, xmlCharacters: 24 * 1024 * 1024, aggregateXmlCharacters: 96 * 1024 * 1024, aggregateXmlNodes: 1_500_000, xmlDepth: 96, xmlNodes: 750_000, attributeLength: 512 * 1024 },
} satisfies Record<string, ParadisSpreadsheetTablesLimits>);
const defaultLimits = limitsByProfile.browser;
const limitKeys = Object.freeze(Object.keys(defaultLimits) as (keyof ParadisSpreadsheetTablesLimits)[]);

export interface ParadisSpreadsheetTablesContext {
	readonly cancellationToken?: CancellationToken;
	readonly now?: () => number;
	readonly deadlineMilliseconds?: number;
	readonly limits?: Partial<ParadisSpreadsheetTablesLimits>;
}

interface OwnedContext {
	readonly cancellationToken?: CancellationToken;
	readonly now: () => number;
	readonly deadlineMilliseconds: number;
	readonly limits: ParadisSpreadsheetTablesLimits;
}

interface Runtime {
	readonly context: OwnedContext;
	readonly hardDeadline: StopWatch;
	readonly started: number;
	lastClock: number;
	checks: number;
	tableColumns: number;
	filterColumns: number;
	filterCriteria: number;
	sortConditions: number;
	printRanges: number;
	pageBreaks: number;
	formulas: number;
	formulaCharacters: number;
	textCharacters: number;
	opaqueCharacters: number;
	unknownElements: number;
	unknownAttributes: number;
	unresolvedReferences: number;
	outputNodes: number;
	outputProperties: number;
	aggregateXmlCharacters: number;
	aggregateXmlNodes: number;
	upstreamCheckpoint?: () => void;
	readonly opaqueFragments: ParadisSpreadsheetOpaqueTableFragment[];
	readonly relationshipScopes: Map<string, ReadonlyMap<string, string>>;
}

interface OwnedDocuments {
	readonly contentTypesDocument: ParadisOfficeXmlDocument;
	readonly contentTypesSource: ParadisSpreadsheetPartSource;
	readonly rootRelationshipsDocument: ParadisOfficeXmlDocument;
	readonly rootRelationshipsSource: ParadisSpreadsheetPartSource;
	readonly workbookDocument: ParadisOfficeXmlDocument;
	readonly workbookSource: ParadisSpreadsheetPartSource;
	readonly workbookRelationshipsDocument: ParadisOfficeXmlDocument;
	readonly workbookRelationshipsSource: ParadisSpreadsheetPartSource;
	readonly worksheetDocument: ParadisOfficeXmlDocument;
	readonly worksheetSource: ParadisSpreadsheetPartSource;
	readonly worksheetRelationshipsDocument: ParadisOfficeXmlDocument;
	readonly worksheetRelationshipsSource: ParadisSpreadsheetPartSource;
	readonly tableParts: readonly { readonly document: ParadisOfficeXmlDocument; readonly source: ParadisSpreadsheetPartSource }[];
	readonly printerSettingsParts: readonly ParadisSpreadsheetRawOpaquePart[];
}

interface Relationship {
	readonly id: string;
	readonly type: string;
	readonly target: string;
	readonly external: boolean;
	readonly resolvedTarget?: string;
}

interface ContentTypeMap {
	readonly defaults: ReadonlyMap<string, string>;
	readonly overrides: ReadonlyMap<string, string>;
}

const arrayBufferIsView = ArrayBuffer.isView;
const arrayBufferPrototype = ArrayBuffer.prototype;
const arrayBufferByteLength = Object.getOwnPropertyDescriptor(arrayBufferPrototype, 'byteLength')!.get!;
const arrayBufferResizable = Object.getOwnPropertyDescriptor(arrayBufferPrototype, 'resizable')?.get;
const arrayBufferDetached = Object.getOwnPropertyDescriptor(arrayBufferPrototype, 'detached')?.get;
const typedArrayPrototype = Object.getPrototypeOf(Uint8Array.prototype);
const typedArrayByteLength = Object.getOwnPropertyDescriptor(typedArrayPrototype, 'byteLength')!.get!;
const typedArrayBuffer = Object.getOwnPropertyDescriptor(typedArrayPrototype, 'buffer')!.get!;
const typedArraySet = Uint8Array.prototype.set;

/** Computes an exact SHA-256 identity over the supplied UTF-8 XML string. */
export function fingerprintSpreadsheetTablesXml(xml: string): ParadisSpreadsheetPartSource['fingerprint'] {
	try {
		if (typeof xml !== 'string' || xml.length > defaultLimits.xmlCharacters) { throw new ParadisOfficePackageError(typeof xml === 'string' ? 'limitExceeded' : 'unsafe'); }
		return sha256Bytes(new TextEncoder().encode(xml));
	} catch (error) { throw sanitizeError(error); }
}

/** Computes an exact SHA-256 identity over the supplied raw Part bytes. */
export function fingerprintSpreadsheetTablesBytes(bytes: Uint8Array): ParadisSpreadsheetPartSource['fingerprint'] {
	try { return sha256Bytes(ownBytes(bytes, defaultLimits.xmlCharacters)); } catch (error) { throw sanitizeError(error); }
}

/** Parses raw OOXML Parts after exact PartSource verification. */
export function parseSpreadsheetTablesAndPrint(input: ParadisSpreadsheetTablesInput, context: ParadisSpreadsheetTablesContext = {}): ParadisSpreadsheetTablesAndPrint {
	const hardDeadline = StopWatch.create(true);
	try {
		const runtime = createRuntime(ownContext(context), hardDeadline);
		return buildModel(parseRawInput(input, runtime), runtime);
	} catch (error) { throw sanitizeError(error); }
}

/** Re-verifies Task 1-issued document graphs against owned all-byte Parts before parsing them. */
export function parseSpreadsheetTablesAndPrintVerifiedDocuments(
	input: ParadisSpreadsheetVerifiedTablesInput,
	checkpointFromTask1: () => void,
	context: ParadisSpreadsheetTablesContext = {},
): ParadisSpreadsheetTablesAndPrint {
	const hardDeadline = StopWatch.create(true);
	try {
		if (typeof checkpointFromTask1 !== 'function') { throw new ParadisOfficePackageError('unsafe'); }
		const runtime = createRuntime(ownContext(context), hardDeadline, checkpointFromTask1);
		return buildModel(parseVerifiedInput(input, runtime), runtime);
	} catch (error) { throw sanitizeError(error); }
}

/** Binds source-owned range overlays to a Task 1 sheet without reading or replacing any cell/style state. */
export function bindSpreadsheetTableRangeOverlays(
	model: ParadisSpreadsheetTablesAndPrint,
	sheet: ParadisSemanticSheet,
): readonly ParadisSpreadsheetTableRangeOverlay[] {
	try {
		if (!model || typeof model !== 'object' || !parsedModels.has(model) || !sheet || typeof sheet !== 'object') { throw new ParadisOfficePackageError('unsafe'); }
		const source = Object.getOwnPropertyDescriptor(sheet, 'source')?.value as ParadisSpreadsheetPartSource | undefined;
		const partId = Object.getOwnPropertyDescriptor(sheet, 'partId')?.value;
		if (!source || partId !== model.worksheetSource.partId || source.partId !== model.worksheetSource.partId
			|| source.fingerprint.value !== model.worksheetSource.fingerprint.value || source.fingerprint.byteLength !== model.worksheetSource.fingerprint.byteLength) {
			throw new ParadisOfficePackageError('unsafe');
		}
		return model.rangeOverlays;
	} catch (error) { throw sanitizeError(error); }
}

function createRuntime(context: OwnedContext, hardDeadline: StopWatch, upstreamCheckpoint?: () => void): Runtime {
	const started = readClock(context.now);
	const runtime: Runtime = {
		context, hardDeadline, started, lastClock: started, checks: 0, tableColumns: 0, filterColumns: 0, filterCriteria: 0,
		sortConditions: 0, printRanges: 0, pageBreaks: 0, formulas: 0, formulaCharacters: 0, textCharacters: 0,
		opaqueCharacters: 0, unknownElements: 0, unknownAttributes: 0, unresolvedReferences: 0,
		outputNodes: 0, outputProperties: 0, aggregateXmlCharacters: 0, aggregateXmlNodes: 0,
		opaqueFragments: [], relationshipScopes: new Map(), ...(upstreamCheckpoint ? { upstreamCheckpoint } : {}),
	};
	checkpoint(runtime, true);
	return runtime;
}

function ownContext(value: unknown): OwnedContext {
	const record = ownRecord(value, new Set(['cancellationToken', 'now', 'deadlineMilliseconds', 'limits']));
	const maximum = limitsByProfile.browser;
	const limitsRecord = record.limits === undefined ? undefined : ownRecord(record.limits, new Set(limitKeys));
	const limits = { ...maximum };
	for (const key of limitKeys) {
		const candidate = limitsRecord?.[key];
		if (candidate !== undefined) {
			if (!Number.isSafeInteger(candidate) || (candidate as number) < 1 || (candidate as number) > maximum[key]) { throw new ParadisOfficePackageError('limitExceeded'); }
			limits[key] = candidate as number;
		}
	}
	const now = record.now ?? Date.now;
	if (typeof now !== 'function') { throw new ParadisOfficePackageError('unsafe'); }
	const maximumDeadline = 45_000;
	const deadlineMilliseconds = record.deadlineMilliseconds ?? maximumDeadline;
	if (!Number.isSafeInteger(deadlineMilliseconds) || (deadlineMilliseconds as number) < 0 || (deadlineMilliseconds as number) > maximumDeadline) { throw new ParadisOfficePackageError('limitExceeded'); }
	const cancellationToken = record.cancellationToken;
	if (cancellationToken !== undefined && (!cancellationToken || typeof cancellationToken !== 'object')) { throw new ParadisOfficePackageError('unsafe'); }
	return { ...(cancellationToken ? { cancellationToken: cancellationToken as CancellationToken } : {}), now: now as () => number, deadlineMilliseconds: deadlineMilliseconds as number, limits };
}

function checkpoint(runtime: Runtime, force = false): void {
	runtime.upstreamCheckpoint?.();
	if (!force && ++runtime.checks % 32 !== 0) { return; }
	throwIfParadisOfficeCancelled(runtime.context.cancellationToken);
	const current = readClock(runtime.context.now);
	if (current < runtime.lastClock) { throw new ParadisOfficePackageError('unsafe'); }
	runtime.lastClock = current;
	if (current - runtime.started > runtime.context.deadlineMilliseconds || runtime.hardDeadline.elapsed() > runtime.context.deadlineMilliseconds) { throw new ParadisOfficePackageError('limitExceeded'); }
}

function readClock(now: () => number): number {
	const value = now();
	if (!Number.isFinite(value) || value < 0) { throw new ParadisOfficePackageError('unsafe'); }
	return value;
}

function parseRawInput(input: unknown, runtime: Runtime): OwnedDocuments {
	const record = ownRecord(input, new Set([
		'contentTypesXml', 'contentTypesBytes', 'contentTypesSource', 'rootRelationshipsXml', 'rootRelationshipsBytes', 'rootRelationshipsSource',
		'workbookXml', 'workbookBytes', 'workbookSource', 'workbookRelationshipsXml', 'workbookRelationshipsBytes', 'workbookRelationshipsSource',
		'worksheetXml', 'worksheetBytes', 'worksheetSource', 'worksheetRelationshipsXml', 'worksheetRelationshipsBytes', 'worksheetRelationshipsSource', 'tableParts', 'printerSettingsParts',
	]));
	const ownRaw = (xmlName: string, bytesName: string, sourceName: string): { readonly xml: string; readonly bytes: Uint8Array; readonly source: ParadisSpreadsheetPartSource } => {
		checkpoint(runtime);
		const xml = record[xmlName];
		if (typeof xml !== 'string' || xml.length > runtime.context.limits.xmlCharacters) { throw new ParadisOfficePackageError(typeof xml === 'string' ? 'limitExceeded' : 'unsafe'); }
		const source = ownPartSource(record[sourceName]);
		const bytes = ownBytes(record[bytesName], runtime.context.limits.xmlCharacters, runtime);
		consumeAggregateCharacters(bytes.length, runtime);
		verifySource(bytes, source, runtime);
		return { xml, bytes, source };
	};
	const contentTypesPart = ownRaw('contentTypesXml', 'contentTypesBytes', 'contentTypesSource');
	const contentTypesDocument = parseRawDocument(contentTypesPart.xml, contentTypesPart.bytes, runtime);
	const typeMap = parseContentTypes(contentTypesDocument, runtime);

	const relationshipSources = [
		ownPartSource(record.rootRelationshipsSource), ownPartSource(record.workbookRelationshipsSource), ownPartSource(record.worksheetRelationshipsSource),
	];
	for (const source of relationshipSources) { validateContentType(source.partId, contentTypes.relationships, typeMap); }
	const rootPart = ownRaw('rootRelationshipsXml', 'rootRelationshipsBytes', 'rootRelationshipsSource');
	const workbookPart = ownRaw('workbookXml', 'workbookBytes', 'workbookSource');
	const workbookRelationshipsPart = ownRaw('workbookRelationshipsXml', 'workbookRelationshipsBytes', 'workbookRelationshipsSource');
	const worksheetPart = ownRaw('worksheetXml', 'worksheetBytes', 'worksheetSource');
	const worksheetRelationshipsPart = ownRaw('worksheetRelationshipsXml', 'worksheetRelationshipsBytes', 'worksheetRelationshipsSource');

	const tableValues = ownArray(record.tableParts, runtime.context.limits.tables, runtime);
	const tableParts: { document: ParadisOfficeXmlDocument; source: ParadisSpreadsheetPartSource }[] = [];
	for (const candidate of tableValues) {
		const tableRecord = ownRecord(candidate, new Set(['xml', 'bytes', 'source']));
		if (typeof tableRecord.xml !== 'string' || tableRecord.xml.length > runtime.context.limits.xmlCharacters) { throw new ParadisOfficePackageError(typeof tableRecord.xml === 'string' ? 'limitExceeded' : 'unsafe'); }
		const source = ownPartSource(tableRecord.source);
		const bytes = ownBytes(tableRecord.bytes, runtime.context.limits.xmlCharacters, runtime);
		consumeAggregateCharacters(bytes.length, runtime);
		verifySource(bytes, source, runtime);
		tableParts.push({ document: parseRawDocument(tableRecord.xml, bytes, runtime), source });
	}
	const printerSettingsParts = ownOpaqueParts(record.printerSettingsParts, runtime);
	return {
		contentTypesDocument, contentTypesSource: contentTypesPart.source,
		rootRelationshipsDocument: parseRawDocument(rootPart.xml, rootPart.bytes, runtime), rootRelationshipsSource: rootPart.source,
		workbookDocument: parseRawDocument(workbookPart.xml, workbookPart.bytes, runtime), workbookSource: workbookPart.source,
		workbookRelationshipsDocument: parseRawDocument(workbookRelationshipsPart.xml, workbookRelationshipsPart.bytes, runtime), workbookRelationshipsSource: workbookRelationshipsPart.source,
		worksheetDocument: parseRawDocument(worksheetPart.xml, worksheetPart.bytes, runtime), worksheetSource: worksheetPart.source,
		worksheetRelationshipsDocument: parseRawDocument(worksheetRelationshipsPart.xml, worksheetRelationshipsPart.bytes, runtime), worksheetRelationshipsSource: worksheetRelationshipsPart.source,
		tableParts, printerSettingsParts,
	};
}

function parseVerifiedInput(input: unknown, runtime: Runtime): OwnedDocuments {
	const record = ownRecord(input, new Set([
		'contentTypesDocument', 'contentTypesBytes', 'contentTypesSource', 'rootRelationshipsDocument', 'rootRelationshipsBytes', 'rootRelationshipsSource',
		'workbookDocument', 'workbookBytes', 'workbookSource', 'workbookRelationshipsDocument', 'workbookRelationshipsBytes', 'workbookRelationshipsSource',
		'worksheetDocument', 'worksheetBytes', 'worksheetSource', 'worksheetRelationshipsDocument', 'worksheetRelationshipsBytes', 'worksheetRelationshipsSource', 'tableParts', 'printerSettingsParts',
	]));
	const ownVerified = (documentName: string, bytesName: string, sourceName: string, preparsedSource?: ParadisSpreadsheetPartSource): { readonly document: ParadisOfficeXmlDocument; readonly source: ParadisSpreadsheetPartSource } => {
		checkpoint(runtime);
		const source = preparsedSource ?? ownPartSource(record[sourceName]);
		const bytes = ownBytes(record[bytesName], runtime.context.limits.xmlCharacters, runtime);
		consumeAggregateCharacters(bytes.length, runtime);
		verifySource(bytes, source, runtime);
		const authoritativeDocument = parseVerifiedBytes(bytes, runtime);
		const suppliedDocument = ownXmlDocument(record[documentName], runtime);
		if (!xmlDocumentsEqual(authoritativeDocument, suppliedDocument, runtime)) { throw new ParadisOfficePackageError('unsafe'); }
		consumeDocumentNodes(authoritativeDocument, runtime);
		return { document: authoritativeDocument, source };
	};

	const contentTypesPart = ownVerified('contentTypesDocument', 'contentTypesBytes', 'contentTypesSource');
	const typeMap = parseContentTypes(contentTypesPart.document, runtime);
	const relationshipSources = new Map<string, ParadisSpreadsheetPartSource>();
	for (const sourceName of ['rootRelationshipsSource', 'workbookRelationshipsSource', 'worksheetRelationshipsSource']) {
		const source = ownPartSource(record[sourceName]);
		validateContentType(source.partId, contentTypes.relationships, typeMap);
		relationshipSources.set(sourceName, source);
	}
	const rootPart = ownVerified('rootRelationshipsDocument', 'rootRelationshipsBytes', 'rootRelationshipsSource', relationshipSources.get('rootRelationshipsSource'));
	const workbookPart = ownVerified('workbookDocument', 'workbookBytes', 'workbookSource');
	const workbookRelationshipsPart = ownVerified('workbookRelationshipsDocument', 'workbookRelationshipsBytes', 'workbookRelationshipsSource', relationshipSources.get('workbookRelationshipsSource'));
	const worksheetPart = ownVerified('worksheetDocument', 'worksheetBytes', 'worksheetSource');
	const worksheetRelationshipsPart = ownVerified('worksheetRelationshipsDocument', 'worksheetRelationshipsBytes', 'worksheetRelationshipsSource', relationshipSources.get('worksheetRelationshipsSource'));

	const tableParts: { document: ParadisOfficeXmlDocument; source: ParadisSpreadsheetPartSource }[] = [];
	for (const candidate of ownArray(record.tableParts, runtime.context.limits.tables, runtime)) {
		const tableRecord = ownRecord(candidate, new Set(['document', 'bytes', 'source']));
		const source = ownPartSource(tableRecord.source);
		const bytes = ownBytes(tableRecord.bytes, runtime.context.limits.xmlCharacters, runtime);
		consumeAggregateCharacters(bytes.length, runtime);
		verifySource(bytes, source, runtime);
		const authoritativeDocument = parseVerifiedBytes(bytes, runtime);
		if (!xmlDocumentsEqual(authoritativeDocument, ownXmlDocument(tableRecord.document, runtime), runtime)) { throw new ParadisOfficePackageError('unsafe'); }
		consumeDocumentNodes(authoritativeDocument, runtime);
		tableParts.push({ document: authoritativeDocument, source });
	}
	const printerSettingsParts = ownOpaqueParts(record.printerSettingsParts, runtime);
	return {
		contentTypesDocument: contentTypesPart.document, contentTypesSource: contentTypesPart.source,
		rootRelationshipsDocument: rootPart.document, rootRelationshipsSource: rootPart.source,
		workbookDocument: workbookPart.document, workbookSource: workbookPart.source,
		workbookRelationshipsDocument: workbookRelationshipsPart.document, workbookRelationshipsSource: workbookRelationshipsPart.source,
		worksheetDocument: worksheetPart.document, worksheetSource: worksheetPart.source,
		worksheetRelationshipsDocument: worksheetRelationshipsPart.document, worksheetRelationshipsSource: worksheetRelationshipsPart.source,
		tableParts, printerSettingsParts,
	};
}

function ownOpaqueParts(value: unknown, runtime: Runtime): readonly ParadisSpreadsheetRawOpaquePart[] {
	if (value === undefined) { return []; }
	const result: ParadisSpreadsheetRawOpaquePart[] = [];
	for (const candidate of ownArray(value, 1, runtime)) {
		const record = ownRecord(candidate, new Set(['bytes', 'source']));
		const bytes = ownBytes(record.bytes, runtime.context.limits.xmlCharacters, runtime);
		consumeAggregateCharacters(bytes.length, runtime);
		const source = ownPartSource(record.source);
		verifySource(bytes, source, runtime);
		result.push({ bytes, source });
	}
	return result;
}

function parseRawDocument(xml: string, bytes: Uint8Array | undefined, runtime: Runtime): ParadisOfficeXmlDocument {
	const decoded = parseParadisOfficeXml(xml.startsWith('\uFEFF') ? xml.slice(1) : xml, xmlLimits(runtime), runtime.context.cancellationToken, () => checkpoint(runtime));
	if (!bytes) { consumeDocumentNodes(decoded, runtime); return decoded; }
	const authoritative = parseVerifiedBytes(bytes, runtime);
	if (!xmlDocumentsEqual(decoded, authoritative, runtime)) { throw new ParadisOfficePackageError('unsafe'); }
	consumeDocumentNodes(authoritative, runtime);
	return authoritative;
}

function parseVerifiedBytes(bytes: Uint8Array, runtime: Runtime): ParadisOfficeXmlDocument {
	let encoding = 'utf-8';
	let offset = 0;
	if (bytes.length >= 2 && bytes[0] === 0xff && bytes[1] === 0xfe) { encoding = 'utf-16le'; offset = 2; }
	else if (bytes.length >= 2 && bytes[0] === 0xfe && bytes[1] === 0xff) { encoding = 'utf-16be'; offset = 2; }
	else if (bytes.length >= 3 && bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) { offset = 3; }
	let xml: string;
	try { xml = new TextDecoder(encoding, { fatal: true }).decode(bytes.subarray(offset)); } catch { throw new ParadisOfficePackageError('malformed'); }
	if (xml.startsWith('\uFEFF')) { xml = xml.slice(1); }
	return parseParadisOfficeXml(xml, xmlLimits(runtime), runtime.context.cancellationToken, () => checkpoint(runtime));
}

function consumeAggregateCharacters(value: number, runtime: Runtime): void {
	runtime.aggregateXmlCharacters = safeAdd(runtime.aggregateXmlCharacters, value);
	if (runtime.aggregateXmlCharacters > runtime.context.limits.aggregateXmlCharacters) { throw new ParadisOfficePackageError('limitExceeded'); }
}

function consumeDocumentNodes(document: ParadisOfficeXmlDocument, runtime: Runtime): void {
	const stack: ParadisOfficeXmlNode[] = [document.root];
	while (stack.length > 0) {
		checkpoint(runtime);
		const node = stack.pop()!;
		runtime.aggregateXmlNodes = safeAdd(runtime.aggregateXmlNodes, 1);
		if (runtime.aggregateXmlNodes > runtime.context.limits.aggregateXmlNodes) { throw new ParadisOfficePackageError('limitExceeded'); }
		if (node.kind === 'element') { for (const child of node.children) { stack.push(child); } }
	}
}

function xmlLimits(runtime: Runtime): { readonly depth: number; readonly nodes: number; readonly attributeLength: number; readonly characters: number } {
	return { depth: runtime.context.limits.xmlDepth, nodes: runtime.context.limits.xmlNodes, attributeLength: runtime.context.limits.attributeLength, characters: runtime.context.limits.xmlCharacters };
}

function buildModel(input: OwnedDocuments, runtime: Runtime): ParadisSpreadsheetTablesAndPrint {
	if (input.contentTypesSource.partId !== contentTypesPartId || input.rootRelationshipsSource.partId !== rootRelationshipsPartId
		|| input.workbookRelationshipsSource.partId !== relationshipPartId(input.workbookSource.partId)
		|| input.worksheetRelationshipsSource.partId !== relationshipPartId(input.worksheetSource.partId)) {
		throw new ParadisOfficePackageError('unsafe');
	}
	const typeMap = parseContentTypes(input.contentTypesDocument, runtime);
	for (const source of [input.rootRelationshipsSource, input.workbookRelationshipsSource, input.worksheetRelationshipsSource]) {
		validateContentType(source.partId, contentTypes.relationships, typeMap);
	}
	validateContentType(input.workbookSource.partId, contentTypes.workbook, typeMap);
	validateContentType(input.worksheetSource.partId, contentTypes.worksheet, typeMap);
	const workbook = spreadsheetRoot(input.workbookDocument, 'workbook');
	const worksheet = spreadsheetRoot(input.worksheetDocument, 'worksheet');
	const rootRelationships = parseRelationships(input.rootRelationshipsDocument, '/', runtime);
	validateRelationshipTarget(rootRelationships, relationshipTypes.officeDocument, undefined, input.workbookSource.partId);
	const workbookRelationships = parseRelationships(input.workbookRelationshipsDocument, input.workbookSource.partId, runtime);
	const worksheetRelationships = parseRelationships(input.worksheetRelationshipsDocument, input.worksheetSource.partId, runtime);
	runtime.relationshipScopes.set(input.workbookSource.partId, relationshipTargetMap(workbookRelationships));
	runtime.relationshipScopes.set(input.worksheetSource.partId, relationshipTargetMap(worksheetRelationships));
	const sheet = findSheet(workbook, input.worksheetSource.partId, workbookRelationships);

	const tableReferences = parseWorksheetTableReferences(worksheet, input.worksheetSource, worksheetRelationships, runtime);
	if (tableReferences.length !== input.tableParts.length) { throw new ParadisOfficePackageError('unsafe'); }
	const inputPartsById = new Map<string, { readonly document: ParadisOfficeXmlDocument; readonly source: ParadisSpreadsheetPartSource }>();
	for (const part of input.tableParts) {
		checkpoint(runtime);
		if (inputPartsById.has(part.source.partId)) { throw new ParadisOfficePackageError('unsafe'); }
		validateContentType(part.source.partId, contentTypes.table, typeMap);
		inputPartsById.set(part.source.partId, part);
	}
	const tables: ParadisSpreadsheetTable[] = [];
	const tableIds = new Set<number>();
	const tableNames = new Set<string>();
	const tableDisplayNames = new Set<string>();
	for (const reference of tableReferences) {
		checkpoint(runtime);
		const part = inputPartsById.get(reference.partId);
		if (!part) { throw new ParadisOfficePackageError('unsafe'); }
		const table = parseTable(part.document, part.source, runtime);
		const normalizedName = table.name.toLocaleLowerCase('en-US');
		const normalizedDisplayName = table.displayName.toLocaleLowerCase('en-US');
		if (tableIds.has(table.id) || tableNames.has(normalizedName) || tableDisplayNames.has(normalizedDisplayName)
			|| tables.some(candidate => rangesOverlap(candidate.range, table.range))) {
			throw new ParadisOfficePackageError('malformed');
		}
		tableIds.add(table.id); tableNames.add(normalizedName); tableDisplayNames.add(normalizedDisplayName); tables.push(table);
	}
	const printerSettingsByPartId = new Map<string, ParadisSpreadsheetPartSource>();
	for (const part of input.printerSettingsParts) {
		if (printerSettingsByPartId.has(part.source.partId)) { throw new ParadisOfficePackageError('unsafe'); }
		validateContentType(part.source.partId, contentTypes.printerSettings, typeMap);
		printerSettingsByPartId.set(part.source.partId, part.source);
	}
	const usedPrinterSettings = new Set<string>();

	const worksheetFilters = parseWorksheetFilters(worksheet, input.worksheetSource, runtime);
	const print = parseSpreadsheetPrintSemantics(
		input.workbookDocument, input.worksheetDocument, sheet.name, sheet.index, input.workbookSource, input.worksheetSource,
		{
			checkpoint: () => checkpoint(runtime),
			consumePrintRange: () => consume(runtime, 'printRanges', runtime.context.limits.printRanges),
			consumePageBreak: () => consume(runtime, 'pageBreaks', runtime.context.limits.pageBreaks),
			resolvePrinterSettingsRelationship: id => {
				const relationship = worksheetRelationships.find(candidate => candidate.id === id);
				if (!relationship || relationship.external || !relationship.resolvedTarget || !relationshipTypeMatches(relationship.type, relationshipTypes.printerSettings)) {
					throw new ParadisOfficePackageError('unsafe');
				}
				validateContentType(relationship.resolvedTarget, contentTypes.printerSettings, typeMap);
				const source = printerSettingsByPartId.get(relationship.resolvedTarget);
				if (!source) { throw new ParadisOfficePackageError('unsafe'); }
				usedPrinterSettings.add(source.partId);
				return source;
			},
			textIdentity: value => textIdentity(value, runtime, true),
			opaque: (node, source, path) => pushOpaque(node, source, path, runtime),
		},
	);
	if (usedPrinterSettings.size !== printerSettingsByPartId.size) { throw new ParadisOfficePackageError('unsafe'); }
	for (const range of print.areas) {
		if (print.areas.filter(candidate => rangesOverlap(candidate, range)).length !== 1) { throw new ParadisOfficePackageError('malformed'); }
	}
	const rangeOverlays = createRangeOverlays(tables, worksheetFilters.autoFilter, worksheetFilters.sortState, print, input.worksheetSource);
	const expectedParts = 6 + input.tableParts.length + input.printerSettingsParts.length;
	const semanticUnits = countSemanticUnits(tables, worksheetFilters.autoFilter, worksheetFilters.sortState, print, runtime.opaqueFragments);
	const opaqueParts = new Set([...runtime.opaqueFragments.map(fragment => fragment.source.partId), ...input.printerSettingsParts.map(part => part.source.partId)]).size;
	const model: ParadisSpreadsheetTablesAndPrint = {
		contentTypesSource: input.contentTypesSource, rootRelationshipsSource: input.rootRelationshipsSource,
		workbookSource: input.workbookSource, workbookRelationshipsSource: input.workbookRelationshipsSource,
		worksheetSource: input.worksheetSource, worksheetRelationshipsSource: input.worksheetRelationshipsSource,
		tables, ...(worksheetFilters.autoFilter ? { worksheetAutoFilter: worksheetFilters.autoFilter } : {}),
		...(worksheetFilters.sortState ? { worksheetSortState: worksheetFilters.sortState } : {}), print,
		opaqueFragments: runtime.opaqueFragments, rangeOverlays,
		completeness: {
			expectedParts, visitedParts: expectedParts, parsedParts: expectedParts, opaqueParts,
			failedParts: 0, omittedParts: 0, expectedSemanticUnits: semanticUnits, visitedSemanticUnits: semanticUnits,
			unknownElements: runtime.unknownElements, unknownAttributes: runtime.unknownAttributes,
			unresolvedReferences: runtime.unresolvedReferences, terminal: true,
		},
	};
	const frozen = deepFreeze(model, runtime);
	parsedModels.add(frozen);
	return frozen;
}

function countSemanticUnits(
	tables: readonly ParadisSpreadsheetTable[],
	worksheetFilter: ParadisSpreadsheetAutoFilter | undefined,
	worksheetSort: ParadisSpreadsheetSortState | undefined,
	print: ParadisSpreadsheetPrintSemantics,
	opaque: readonly ParadisSpreadsheetOpaqueTableFragment[],
): number {
	let count = 1 + opaque.length + print.areas.length + print.breaks.rows.length + print.breaks.columns.length + print.headerFooter.identities.length;
	if (print.titles.rows) { count++; }
	if (print.titles.columns) { count++; }
	if (Object.keys(print.options).length > 0) { count++; }
	if (Object.keys(print.margins).length > 0) { count++; }
	if (Object.keys(print.setup).length > 0) { count++; }
	const countFilter = (filter: ParadisSpreadsheetAutoFilter | undefined): void => {
		if (!filter) { return; }
		count++;
		for (const column of filter.columns) { count = safeAdd(count, 1 + column.criteria.length); }
		if (filter.sortState) { count = safeAdd(count, 1 + filter.sortState.conditions.length); }
	};
	for (const table of tables) {
		count = safeAdd(count, 1 + table.columns.length);
		for (const column of table.columns) {
			if (column.calculatedColumnFormula) { count++; }
			if (column.totalsRowFormula) { count++; }
		}
		countFilter(table.autoFilter);
		if (table.sortState) { count = safeAdd(count, 1 + table.sortState.conditions.length); }
	}
	countFilter(worksheetFilter);
	if (worksheetSort && worksheetSort !== worksheetFilter?.sortState) { count = safeAdd(count, 1 + worksheetSort.conditions.length); }
	return count;
}

function relationshipPartId(ownerPartId: string): string {
	const separator = ownerPartId.lastIndexOf('/');
	if (separator < 0 || separator === ownerPartId.length - 1) { throw new ParadisOfficePackageError('unsafe'); }
	return `${ownerPartId.slice(0, separator + 1)}_rels/${ownerPartId.slice(separator + 1)}.rels`;
}

function findSheet(workbook: XmlElement, worksheetPartId: string, relationships: readonly Relationship[]): { readonly name: string; readonly index: number } {
	const sheetContainers = elementChildren(workbook).filter(node => spreadsheetNamespaces.has(node.uri) && node.local === 'sheets');
	if (sheetContainers.length !== 1) { throw new ParadisOfficePackageError('malformed'); }
	const sheets = elementChildren(sheetContainers[0]);
	for (let index = 0; index < sheets.length; index++) {
		const node = sheets[index];
		if (!spreadsheetNamespaces.has(node.uri) || node.local !== 'sheet') { throw new ParadisOfficePackageError('malformed'); }
		const id = namespacedAttribute(node, officeRelationshipNamespaces, 'id');
		const relationship = relationships.find(candidate => candidate.id === id);
		if (relationship && relationshipTypeMatches(relationship.type, relationshipTypes.worksheet) && !relationship.external && relationship.resolvedTarget === worksheetPartId) {
			const name = requiredAttribute(node, 'name');
			if (!isValidText(name) || name.length > 31) { throw new ParadisOfficePackageError('malformed'); }
			return { name, index };
		}
	}
	throw new ParadisOfficePackageError('unsafe');
}

function parseWorksheetTableReferences(
	worksheet: XmlElement,
	source: ParadisSpreadsheetPartSource,
	relationships: readonly Relationship[],
	runtime: Runtime,
): readonly { readonly relationshipId: string; readonly partId: string }[] {
	const containers = elementChildren(worksheet).filter(node => spreadsheetNamespaces.has(node.uri) && node.local === 'tableParts');
	if (containers.length > 1) { throw new ParadisOfficePackageError('malformed'); }
	if (containers.length === 0) { return []; }
	const container = containers[0];
	exactAttributes(container, ['count']);
	const children = elementChildren(container);
	const count = boundedOptionalInteger(attribute(container, 'count'), 0, runtime.context.limits.tables);
	if (count !== undefined && count !== children.length) { throw new ParadisOfficePackageError('malformed'); }
	const result: { relationshipId: string; partId: string }[] = [];
	const ids = new Set<string>();
	for (const node of children) {
		checkpoint(runtime);
		if (!spreadsheetNamespaces.has(node.uri) || node.local !== 'tablePart') { throw new ParadisOfficePackageError('malformed'); }
		exactAttributes(node, [], ['id']);
		const id = namespacedAttribute(node, officeRelationshipNamespaces, 'id');
		if (!id || ids.has(id)) { throw new ParadisOfficePackageError('malformed'); }
		ids.add(id);
		const relationship = relationships.find(candidate => candidate.id === id);
		if (!relationship || relationship.external || !relationship.resolvedTarget || !relationshipTypeMatches(relationship.type, relationshipTypes.table)) { throw new ParadisOfficePackageError('unsafe'); }
		result.push({ relationshipId: id, partId: relationship.resolvedTarget });
	}
	const referenced = new Set(result.map(value => value.partId));
	if (referenced.size !== result.length) { throw new ParadisOfficePackageError('unsafe'); }
	const unreferencedTableRelationships = relationships.filter(candidate => relationshipTypeMatches(candidate.type, relationshipTypes.table) && !ids.has(candidate.id));
	if (unreferencedTableRelationships.length !== 0) { throw new ParadisOfficePackageError('unsafe'); }
	runtime.relationshipScopes.set(source.partId, relationshipTargetMap(relationships));
	return result;
}

function parseTable(document: ParadisOfficeXmlDocument, source: ParadisSpreadsheetPartSource, runtime: Runtime): ParadisSpreadsheetTable {
	const root = spreadsheetRoot(document, 'table');
	exactAttributes(root, [
		'id', 'name', 'displayName', 'comment', 'ref', 'tableType', 'headerRowCount', 'insertRow', 'insertRowShift', 'totalsRowCount',
		'totalsRowShown', 'published', 'headerRowDxfId', 'dataDxfId', 'totalsRowDxfId', 'headerRowBorderDxfId', 'tableBorderDxfId',
		'totalsRowBorderDxfId', 'headerRowCellStyle', 'dataCellStyle', 'totalsRowCellStyle', 'connectionId',
	]);
	const id = boundedInteger(requiredAttribute(root, 'id'), 1, 0xffffffff);
	const name = semanticText(requiredAttribute(root, 'name'), runtime);
	const displayName = semanticText(requiredAttribute(root, 'displayName'), runtime);
	if (!name || !displayName || /[\s\[\]':]/.test(displayName)) { throw new ParadisOfficePackageError('malformed'); }
	const range = parseSpreadsheetA1Range(requiredAttribute(root, 'ref'));
	const headerRowCount = boundedOptionalInteger(attribute(root, 'headerRowCount'), 0, 1) ?? 1;
	const totalsRowCount = boundedOptionalInteger(attribute(root, 'totalsRowCount'), 0, 1) ?? 0;
	const totalsRowShown = attribute(root, 'totalsRowShown') === undefined ? true : booleanLexical(attribute(root, 'totalsRowShown')!);
	if (range.maxRow - range.minRow + 1 < headerRowCount + totalsRowCount) { throw new ParadisOfficePackageError('malformed'); }
	let columns: readonly ParadisSpreadsheetTableColumn[] | undefined;
	let autoFilter: ParadisSpreadsheetAutoFilter | undefined;
	let sortState: ParadisSpreadsheetSortState | undefined;
	let styleInfo: ParadisSpreadsheetTableStyleInfo | undefined;
	const seen = new Set<string>();
	for (const child of elementChildren(root)) {
		checkpoint(runtime);
		if (!spreadsheetNamespaces.has(child.uri)) { pushOpaque(child, source, `/table/${child.local}`, runtime); continue; }
		switch (child.local) {
			case 'tableColumns': singleton(seen, child.local); columns = parseTableColumns(child, source, runtime); break;
			case 'autoFilter': singleton(seen, child.local); autoFilter = parseAutoFilter(child, range, source, '/table/autoFilter', runtime); break;
			case 'sortState': singleton(seen, child.local); sortState = parseSortState(child, autoFilter?.range ?? range, source, '/table/sortState', runtime); break;
			case 'tableStyleInfo': singleton(seen, child.local); styleInfo = parseTableStyle(child); break;
			case 'extLst': parseOpaqueExtensions(child, source, '/table/extLst', runtime); break;
			default: pushOpaque(child, source, `/table/${child.local}`, runtime); break;
		}
	}
	if (!columns || columns.length !== range.maxColumn - range.minColumn + 1) { throw new ParadisOfficePackageError('malformed'); }
	if (autoFilter && !rangeContains(range, autoFilter.range)) { throw new ParadisOfficePackageError('malformed'); }
	return compact({
		id, name, displayName, comment: optionalSemanticText(root, 'comment', runtime),
		tableType: enumAttribute(root, 'tableType', ['worksheet', 'xml', 'queryTable'] as const),
		connectionId: boundedOptionalInteger(attribute(root, 'connectionId'), 0, 0xffffffff),
		headerRowDxfId: boundedOptionalInteger(attribute(root, 'headerRowDxfId'), 0, 0xffffffff), dataDxfId: boundedOptionalInteger(attribute(root, 'dataDxfId'), 0, 0xffffffff),
		totalsRowDxfId: boundedOptionalInteger(attribute(root, 'totalsRowDxfId'), 0, 0xffffffff),
		headerRowBorderDxfId: boundedOptionalInteger(attribute(root, 'headerRowBorderDxfId'), 0, 0xffffffff), tableBorderDxfId: boundedOptionalInteger(attribute(root, 'tableBorderDxfId'), 0, 0xffffffff),
		totalsRowBorderDxfId: boundedOptionalInteger(attribute(root, 'totalsRowBorderDxfId'), 0, 0xffffffff),
		headerRowCellStyle: optionalSemanticText(root, 'headerRowCellStyle', runtime), dataCellStyle: optionalSemanticText(root, 'dataCellStyle', runtime),
		totalsRowCellStyle: optionalSemanticText(root, 'totalsRowCellStyle', runtime),
		range, source, headerRowCount, totalsRowCount, totalsRowShown,
		insertRow: optionalBoolean(root, 'insertRow'), insertRowShift: optionalBoolean(root, 'insertRowShift'), published: optionalBoolean(root, 'published'),
		columns, autoFilter, sortState, styleInfo,
	});
}

function parseTableColumns(node: XmlElement, source: ParadisSpreadsheetPartSource, runtime: Runtime): readonly ParadisSpreadsheetTableColumn[] {
	exactAttributes(node, ['count']);
	const children = elementChildren(node);
	const declared = boundedOptionalInteger(attribute(node, 'count'), 1, 16_384);
	if (declared !== undefined && declared !== children.length) { throw new ParadisOfficePackageError('malformed'); }
	const result: ParadisSpreadsheetTableColumn[] = [];
	const ids = new Set<number>();
	const names = new Set<string>();
	const uniqueNames = new Set<string>();
	for (const child of children) {
		consume(runtime, 'tableColumns', runtime.context.limits.tableColumns);
		if (!spreadsheetNamespaces.has(child.uri) || child.local !== 'tableColumn') { throw new ParadisOfficePackageError('malformed'); }
		exactAttributes(child, [
			'id', 'uniqueName', 'name', 'totalsRowFunction', 'totalsRowLabel', 'queryTableFieldId', 'headerRowDxfId', 'dataDxfId',
			'totalsRowDxfId', 'headerRowCellStyle', 'dataCellStyle', 'totalsRowCellStyle',
		]);
		const id = boundedInteger(requiredAttribute(child, 'id'), 1, 0xffffffff);
		const name = semanticText(requiredAttribute(child, 'name'), runtime);
		const uniqueName = optionalSemanticText(child, 'uniqueName', runtime);
		const normalizedUniqueName = uniqueName?.toLocaleLowerCase('en-US');
		if (ids.has(id) || names.has(name.toLocaleLowerCase('en-US')) || normalizedUniqueName && uniqueNames.has(normalizedUniqueName)) { throw new ParadisOfficePackageError('malformed'); }
		ids.add(id); names.add(name.toLocaleLowerCase('en-US'));
		if (normalizedUniqueName) { uniqueNames.add(normalizedUniqueName); }
		let calculatedColumnFormula: ParadisSpreadsheetStoredTableFormula | undefined;
		let totalsRowFormula: ParadisSpreadsheetStoredTableFormula | undefined;
		for (const formula of elementChildren(child)) {
			checkpoint(runtime);
			if (!spreadsheetNamespaces.has(formula.uri)) { pushOpaque(formula, source, `/table/tableColumns/tableColumn/${formula.local}`, runtime); continue; }
			if (formula.local === 'calculatedColumnFormula') {
				if (calculatedColumnFormula) { throw new ParadisOfficePackageError('malformed'); }
				calculatedColumnFormula = parseStoredFormula(formula, runtime);
			} else if (formula.local === 'totalsRowFormula') {
				if (totalsRowFormula) { throw new ParadisOfficePackageError('malformed'); }
				totalsRowFormula = parseStoredFormula(formula, runtime);
			} else if (formula.local === 'extLst') {
				parseOpaqueExtensions(formula, source, '/table/tableColumns/tableColumn/extLst', runtime);
			} else {
				pushOpaque(formula, source, `/table/tableColumns/tableColumn/${formula.local}`, runtime);
			}
		}
		const totalsRowFunction = enumAttribute(child, 'totalsRowFunction', ['none', 'sum', 'min', 'max', 'average', 'count', 'countNums', 'stdDev', 'var', 'custom'] as const);
		result.push(compact({
			id, name, uniqueName, totalsRowLabel: optionalSemanticText(child, 'totalsRowLabel', runtime), totalsRowFunction,
			queryTableFieldId: boundedOptionalInteger(attribute(child, 'queryTableFieldId'), 0, 0xffffffff),
			headerRowDxfId: boundedOptionalInteger(attribute(child, 'headerRowDxfId'), 0, 0xffffffff), dataDxfId: boundedOptionalInteger(attribute(child, 'dataDxfId'), 0, 0xffffffff),
			totalsRowDxfId: boundedOptionalInteger(attribute(child, 'totalsRowDxfId'), 0, 0xffffffff),
			headerRowCellStyle: optionalSemanticText(child, 'headerRowCellStyle', runtime), dataCellStyle: optionalSemanticText(child, 'dataCellStyle', runtime),
			totalsRowCellStyle: optionalSemanticText(child, 'totalsRowCellStyle', runtime), calculatedColumnFormula, totalsRowFormula,
		}));
	}
	if (result.length === 0) { throw new ParadisOfficePackageError('malformed'); }
	return Object.freeze(result);
}

function parseStoredFormula(node: XmlElement, runtime: Runtime): ParadisSpreadsheetStoredTableFormula {
	exactAttributes(node, ['array']);
	consume(runtime, 'formulas', runtime.context.limits.formulas);
	const text = textOnly(node);
	runtime.formulaCharacters = safeAdd(runtime.formulaCharacters, text.length);
	if (runtime.formulaCharacters > runtime.context.limits.formulaCharacters || !isValidText(text)) { throw new ParadisOfficePackageError(runtime.formulaCharacters > runtime.context.limits.formulaCharacters ? 'limitExceeded' : 'malformed'); }
	return compact({ text, array: optionalBoolean(node, 'array'), evaluation: 'notCalculated' as const, fingerprint: sha256Bytes(new TextEncoder().encode(text), runtime) });
}

function parseTableStyle(node: XmlElement): ParadisSpreadsheetTableStyleInfo {
	exactAttributes(node, ['name', 'showFirstColumn', 'showLastColumn', 'showRowStripes', 'showColumnStripes']);
	if (elementChildren(node).length !== 0) { throw new ParadisOfficePackageError('malformed'); }
	return compact({
		name: attribute(node, 'name'), showFirstColumn: optionalBoolean(node, 'showFirstColumn'), showLastColumn: optionalBoolean(node, 'showLastColumn'),
		showRowStripes: optionalBoolean(node, 'showRowStripes'), showColumnStripes: optionalBoolean(node, 'showColumnStripes'),
	});
}

function parseWorksheetFilters(
	worksheet: XmlElement,
	source: ParadisSpreadsheetPartSource,
	runtime: Runtime,
): { readonly autoFilter?: ParadisSpreadsheetAutoFilter; readonly sortState?: ParadisSpreadsheetSortState } {
	let autoFilter: ParadisSpreadsheetAutoFilter | undefined;
	let sortState: ParadisSpreadsheetSortState | undefined;
	for (const child of elementChildren(worksheet)) {
		checkpoint(runtime);
		if (!spreadsheetNamespaces.has(child.uri)) { continue; }
		if (child.local === 'autoFilter') {
			if (autoFilter) { throw new ParadisOfficePackageError('malformed'); }
			autoFilter = parseAutoFilter(child, undefined, source, '/worksheet/autoFilter', runtime);
		} else if (child.local === 'sortState') {
			if (sortState) { throw new ParadisOfficePackageError('malformed'); }
			sortState = parseSortState(child, autoFilter?.range, source, '/worksheet/sortState', runtime);
		}
	}
	if (autoFilter?.sortState && sortState) { throw new ParadisOfficePackageError('malformed'); }
	if (autoFilter?.sortState) { sortState = autoFilter.sortState; }
	if (sortState && autoFilter && !rangeContains(autoFilter.range, sortState.range)) { throw new ParadisOfficePackageError('malformed'); }
	runtime.relationshipScopes.set(source.partId, runtime.relationshipScopes.get(source.partId) ?? new Map());
	return compact({ autoFilter, sortState });
}

function parseAutoFilter(
	node: XmlElement,
	ownerRange: ParadisSemanticRange | undefined,
	source: ParadisSpreadsheetPartSource,
	path: string,
	runtime: Runtime,
): ParadisSpreadsheetAutoFilter {
	exactAttributes(node, ['ref']);
	const range = parseSpreadsheetA1Range(requiredAttribute(node, 'ref'));
	if (ownerRange && !rangeContains(ownerRange, range)) { throw new ParadisOfficePackageError('malformed'); }
	const columns: ParadisSpreadsheetFilterColumn[] = [];
	let sortState: ParadisSpreadsheetSortState | undefined;
	const columnIds = new Set<number>();
	for (const child of elementChildren(node)) {
		checkpoint(runtime);
		if (!spreadsheetNamespaces.has(child.uri)) { throw new ParadisOfficePackageError('malformed'); }
		if (child.local === 'filterColumn') {
			consume(runtime, 'filterColumns', runtime.context.limits.filterColumns);
			const column = parseFilterColumn(child, range, source, `${path}/filterColumn`, runtime);
			if (columnIds.has(column.columnId)) { throw new ParadisOfficePackageError('malformed'); }
			columnIds.add(column.columnId); columns.push(column);
		} else if (child.local === 'sortState') {
			if (sortState) { throw new ParadisOfficePackageError('malformed'); }
			sortState = parseSortState(child, range, source, `${path}/sortState`, runtime);
		} else if (child.local === 'extLst') {
			parseOpaqueExtensions(child, source, `${path}/extLst`, runtime);
		} else {
			throw new ParadisOfficePackageError('malformed');
		}
	}
	return compact({ range, columns: Object.freeze(columns), sortState });
}

function parseFilterColumn(
	node: XmlElement,
	filterRange: ParadisSemanticRange,
	source: ParadisSpreadsheetPartSource,
	path: string,
	runtime: Runtime,
): ParadisSpreadsheetFilterColumn {
	exactAttributes(node, ['colId', 'hiddenButton', 'showButton']);
	const columnId = boundedInteger(requiredAttribute(node, 'colId'), 0, filterRange.maxColumn - filterRange.minColumn);
	const criteria: ParadisSpreadsheetFilterCriterion[] = [];
	let customFiltersAnd: boolean | undefined;
	let calendarType: ParadisSpreadsheetFilterColumn['calendarType'];
	let kindSeen = false;
	let extensionSeen = false;
	for (const child of elementChildren(node)) {
		checkpoint(runtime);
		if (!spreadsheetNamespaces.has(child.uri)) { throw new ParadisOfficePackageError('malformed'); }
		if (child.local === 'extLst') {
			if (extensionSeen) { throw new ParadisOfficePackageError('malformed'); }
			extensionSeen = true; parseOpaqueExtensions(child, source, `${path}/extLst`, runtime); continue;
		}
		if (kindSeen) { throw new ParadisOfficePackageError('malformed'); }
		kindSeen = true;
		switch (child.local) {
			case 'filters': calendarType = parseValueFilters(child, criteria, runtime); break;
			case 'customFilters': customFiltersAnd = parseCustomFilters(child, criteria, runtime); break;
			case 'dynamicFilter': criteria.push(parseDynamicFilter(child, runtime)); break;
			case 'top10': criteria.push(parseTop10(child, runtime)); break;
			case 'colorFilter': criteria.push(parseColorFilter(child, runtime)); break;
			case 'iconFilter': criteria.push(parseIconFilter(child, runtime)); break;
			default: throw new ParadisOfficePackageError('malformed');
		}
	}
	return compact({ columnId, hiddenButton: optionalBoolean(node, 'hiddenButton'), showButton: optionalBoolean(node, 'showButton'), customFiltersAnd, calendarType, criteria: Object.freeze(criteria) });
}

function parseValueFilters(node: XmlElement, result: ParadisSpreadsheetFilterCriterion[], runtime: Runtime): ParadisSpreadsheetFilterColumn['calendarType'] {
	exactAttributes(node, ['blank', 'calendarType']);
	const calendarType = enumAttribute(node, 'calendarType', ['none', 'gregorian', 'gregorianUs', 'japan', 'taiwan', 'korea', 'hijri', 'thai', 'hebrew', 'gregorianMeFrench', 'gregorianArabic', 'gregorianXlitEnglish', 'gregorianXlitFrench'] as const);
	for (const child of elementChildren(node)) {
		checkpoint(runtime);
		if (!spreadsheetNamespaces.has(child.uri)) { throw new ParadisOfficePackageError('malformed'); }
		if (child.local === 'filter') {
			exactAttributes(child, ['val']);
			pushCriterion(result, { kind: 'value', value: semanticText(requiredAttribute(child, 'val'), runtime) }, runtime);
		} else if (child.local === 'dateGroupItem') {
			exactAttributes(child, ['year', 'month', 'day', 'hour', 'minute', 'second', 'dateTimeGrouping']);
			const grouping = requiredAttribute(child, 'dateTimeGrouping');
			if (!['year', 'month', 'day', 'hour', 'minute', 'second'].includes(grouping)) { throw new ParadisOfficePackageError('malformed'); }
			const criterion = compact({
				kind: 'dateGroup' as const, grouping,
				year: boundedOptionalInteger(attribute(child, 'year'), 0, 9999), month: boundedOptionalInteger(attribute(child, 'month'), 1, 12),
				day: boundedOptionalInteger(attribute(child, 'day'), 1, 31), hour: boundedOptionalInteger(attribute(child, 'hour'), 0, 23),
				minute: boundedOptionalInteger(attribute(child, 'minute'), 0, 59), second: boundedOptionalInteger(attribute(child, 'second'), 0, 59),
			});
			const requiredParts = ['year', 'month', 'day', 'hour', 'minute', 'second'] as const;
			for (let index = 0; index <= requiredParts.indexOf(grouping as typeof requiredParts[number]); index++) {
				if (criterion[requiredParts[index]] === undefined) { throw new ParadisOfficePackageError('malformed'); }
			}
			pushCriterion(result, criterion, runtime);
		} else { throw new ParadisOfficePackageError('malformed'); }
	}
	if (optionalBoolean(node, 'blank') === true) { pushCriterion(result, { kind: 'blank' }, runtime); }
	return calendarType;
}

function parseCustomFilters(node: XmlElement, result: ParadisSpreadsheetFilterCriterion[], runtime: Runtime): boolean | undefined {
	exactAttributes(node, ['and']);
	const children = elementChildren(node);
	if (children.length < 1 || children.length > 2) { throw new ParadisOfficePackageError('malformed'); }
	for (const child of children) {
		if (!spreadsheetNamespaces.has(child.uri) || child.local !== 'customFilter') { throw new ParadisOfficePackageError('malformed'); }
		exactAttributes(child, ['operator', 'val']);
		const operator = enumAttribute(child, 'operator', ['equal', 'notEqual', 'lessThan', 'lessThanOrEqual', 'greaterThan', 'greaterThanOrEqual'] as const);
		pushCriterion(result, compact({ kind: 'custom' as const, operator, value: semanticText(requiredAttribute(child, 'val'), runtime) }), runtime);
	}
	return optionalBoolean(node, 'and');
}

function parseDynamicFilter(node: XmlElement, runtime: Runtime): ParadisSpreadsheetFilterCriterion {
	exactAttributes(node, ['type', 'val', 'maxVal']);
	consume(runtime, 'filterCriteria', runtime.context.limits.filterCriteria);
	const type = requiredAttribute(node, 'type');
	const allowed = new Set([
		'null', 'aboveAverage', 'belowAverage', 'tomorrow', 'today', 'yesterday', 'nextWeek', 'thisWeek', 'lastWeek',
		'nextMonth', 'thisMonth', 'lastMonth', 'nextQuarter', 'thisQuarter', 'lastQuarter', 'nextYear', 'thisYear', 'lastYear',
		'yearToDate', 'Q1', 'Q2', 'Q3', 'Q4', ...Array.from({ length: 12 }, (_, index) => `M${index + 1}`),
	]);
	if (!allowed.has(type)) { throw new ParadisOfficePackageError('malformed'); }
	return compact({ kind: 'dynamic' as const, type, value: optionalFiniteLexical(node, 'val'), maxValue: optionalFiniteLexical(node, 'maxVal') });
}

function parseTop10(node: XmlElement, runtime: Runtime): ParadisSpreadsheetFilterCriterion {
	exactAttributes(node, ['top', 'percent', 'val', 'filterVal']);
	consume(runtime, 'filterCriteria', runtime.context.limits.filterCriteria);
	return compact({ kind: 'top10' as const, top: optionalBoolean(node, 'top'), percent: optionalBoolean(node, 'percent'), value: requiredFiniteLexical(node, 'val'), filterValue: optionalFiniteLexical(node, 'filterVal') });
}

function parseColorFilter(node: XmlElement, runtime: Runtime): ParadisSpreadsheetFilterCriterion {
	exactAttributes(node, ['dxfId', 'cellColor']);
	consume(runtime, 'filterCriteria', runtime.context.limits.filterCriteria);
	return compact({ kind: 'color' as const, dxfId: boundedOptionalInteger(attribute(node, 'dxfId'), 0, 0xffffffff), cellColor: optionalBoolean(node, 'cellColor') });
}

function parseIconFilter(node: XmlElement, runtime: Runtime): ParadisSpreadsheetFilterCriterion {
	exactAttributes(node, ['iconSet', 'iconId']);
	consume(runtime, 'filterCriteria', runtime.context.limits.filterCriteria);
	return compact({ kind: 'icon' as const, iconSet: iconSetAttribute(node), iconId: boundedOptionalInteger(attribute(node, 'iconId'), 0, 4) });
}

function pushCriterion(result: ParadisSpreadsheetFilterCriterion[], value: ParadisSpreadsheetFilterCriterion, runtime: Runtime): void {
	consume(runtime, 'filterCriteria', runtime.context.limits.filterCriteria); result.push(value);
}

function parseSortState(
	node: XmlElement,
	ownerRange: ParadisSemanticRange | undefined,
	source: ParadisSpreadsheetPartSource,
	path: string,
	runtime: Runtime,
): ParadisSpreadsheetSortState {
	exactAttributes(node, ['ref', 'caseSensitive', 'columnSort', 'sortMethod']);
	const range = parseSpreadsheetA1Range(requiredAttribute(node, 'ref'));
	if (ownerRange && !rangeContains(ownerRange, range)) { throw new ParadisOfficePackageError('malformed'); }
	const conditions: ParadisSpreadsheetSortCondition[] = [];
	let extensionSeen = false;
	for (const child of elementChildren(node)) {
		checkpoint(runtime);
		if (spreadsheetNamespaces.has(child.uri) && child.local === 'extLst') {
			if (extensionSeen) { throw new ParadisOfficePackageError('malformed'); }
			extensionSeen = true; parseOpaqueExtensions(child, source, `${path}/extLst`, runtime); continue;
		}
		if (!spreadsheetNamespaces.has(child.uri) || child.local !== 'sortCondition') { throw new ParadisOfficePackageError('malformed'); }
		consume(runtime, 'sortConditions', runtime.context.limits.sortConditions);
		exactAttributes(child, ['descending', 'sortBy', 'ref', 'customList', 'dxfId', 'iconSet', 'iconId']);
		const conditionRange = parseSpreadsheetA1Range(requiredAttribute(child, 'ref'));
		if (!rangeContains(range, conditionRange) || conditions.some(candidate => rangesOverlap(candidate.range, conditionRange))) { throw new ParadisOfficePackageError('malformed'); }
		conditions.push(compact({
			range: conditionRange, descending: optionalBoolean(child, 'descending'), sortBy: enumAttribute(child, 'sortBy', ['value', 'cellColor', 'fontColor', 'icon'] as const),
			customList: optionalSemanticText(child, 'customList', runtime), dxfId: boundedOptionalInteger(attribute(child, 'dxfId'), 0, 0xffffffff),
			iconSet: attribute(child, 'iconSet') === undefined ? undefined : iconSetAttribute(child), iconId: boundedOptionalInteger(attribute(child, 'iconId'), 0, 4),
		}));
	}
	if (conditions.length === 0) { throw new ParadisOfficePackageError('malformed'); }
	return compact({
		range, caseSensitive: optionalBoolean(node, 'caseSensitive'), columnSort: optionalBoolean(node, 'columnSort'), sortMethod: enumAttribute(node, 'sortMethod', ['none', 'stroke', 'pinYin'] as const),
		conditions: Object.freeze(conditions),
	});
}

function createRangeOverlays(
	tables: readonly ParadisSpreadsheetTable[],
	worksheetAutoFilter: ParadisSpreadsheetAutoFilter | undefined,
	worksheetSortState: ParadisSpreadsheetSortState | undefined,
	print: ParadisSpreadsheetPrintSemantics,
	worksheetSource: ParadisSpreadsheetPartSource,
): readonly ParadisSpreadsheetTableRangeOverlay[] {
	const result: ParadisSpreadsheetTableRangeOverlay[] = [];
	for (const table of tables) {
		result.push({ kind: 'table', id: `table:${table.id}`, range: table.range, source: table.source });
		if (table.autoFilter) { result.push({ kind: 'tableFilter', id: `table:${table.id}:filter`, range: table.autoFilter.range, source: table.source }); }
		if (table.sortState) { result.push({ kind: 'tableSort', id: `table:${table.id}:sort`, range: table.sortState.range, source: table.source }); }
	}
	if (worksheetAutoFilter) { result.push({ kind: 'worksheetFilter', id: 'worksheet:filter', range: worksheetAutoFilter.range, source: worksheetSource }); }
	if (worksheetSortState) { result.push({ kind: 'worksheetSort', id: 'worksheet:sort', range: worksheetSortState.range, source: worksheetSource }); }
	for (let index = 0; index < print.areas.length; index++) { result.push({ kind: 'printArea', id: `printArea:${index}`, range: print.areas[index], source: print.workbookSource }); }
	return Object.freeze(result);
}

function parseOpaqueExtensions(node: XmlElement, source: ParadisSpreadsheetPartSource, path: string, runtime: Runtime): void {
	exactAttributes(node, []);
	for (const extension of elementChildren(node)) {
		if (!spreadsheetNamespaces.has(extension.uri) || extension.local !== 'ext') { throw new ParadisOfficePackageError('malformed'); }
		exactAttributes(extension, ['uri']);
		pushOpaque(extension, source, `${path}/ext`, runtime);
	}
}

function pushOpaque(node: XmlElement, source: ParadisSpreadsheetPartSource, path: string, runtime: Runtime): void {
	consume(runtime, 'unknownElements', runtime.context.limits.opaqueFragments);
	let attributeCount = 0;
	const stack: ParadisOfficeXmlNode[] = [node];
	while (stack.length > 0) {
		checkpoint(runtime);
		const current = stack.pop()!;
		if (current.kind === 'element') {
			attributeCount = safeAdd(attributeCount, current.attributes.length);
			for (const child of current.children) { stack.push(child); }
		}
	}
	runtime.unknownAttributes = safeAdd(runtime.unknownAttributes, attributeCount);
	runtime.opaqueFragments.push({
		name: { namespace: node.uri, local: node.local }, path, ordinal: runtime.opaqueFragments.length,
		fingerprint: fingerprintFragment(node, runtime, runtime.relationshipScopes.get(source.partId)), source,
	});
}

function fingerprintFragment(node: XmlElement, runtime: Runtime, relationshipTargets?: ReadonlyMap<string, string>): ParadisSpreadsheetPartSource['fingerprint'] {
	const chunks: string[] = [];
	interface Frame { readonly node: ParadisOfficeXmlNode; readonly closing?: boolean; readonly preserveSpace: boolean; readonly parentHasElements?: boolean }
	const stack: Frame[] = [{ node, preserveSpace: false }];
	while (stack.length > 0) {
		checkpoint(runtime);
		const frame = stack.pop()!;
		if (frame.node.kind === 'text') {
			if (!frame.preserveSpace && frame.parentHasElements && frame.node.value.trim().length === 0) { continue; }
			pushOpaqueText(chunks, `T${frame.node.value.length}:${frame.node.value}`, runtime); continue;
		}
		if (frame.closing) { pushOpaqueText(chunks, 'E;', runtime); continue; }
		const attributes = [...frame.node.attributes].sort((left, right) => compareCodePoint(`${left.uri}\0${left.local}`, `${right.uri}\0${right.local}`));
		const space = frame.node.attributes.find(candidate => candidate.uri === xmlNamespace && candidate.local === 'space')?.value;
		const preserveSpace = space === 'preserve' ? true : space === 'default' ? false : frame.preserveSpace;
		const hasElements = frame.node.children.some(child => child.kind === 'element');
		pushOpaqueText(chunks, `S${frame.node.uri.length}:${frame.node.uri}${frame.node.local.length}:${frame.node.local};`, runtime);
		for (const candidate of attributes) {
			let value = candidate.value;
			if (officeRelationshipNamespaces.has(candidate.uri) && candidate.local === 'id') {
				const target = relationshipTargets?.get(candidate.value);
				if (!target) { throw new ParadisOfficePackageError('unsafe'); }
				value = target;
			}
			pushOpaqueText(chunks, `A${candidate.uri.length}:${candidate.uri}${candidate.local.length}:${candidate.local}${value.length}:${value};`, runtime);
		}
		stack.push({ node: frame.node, closing: true, preserveSpace });
		for (let index = frame.node.children.length - 1; index >= 0; index--) { stack.push({ node: frame.node.children[index], preserveSpace, parentHasElements: hasElements }); }
	}
	return sha256Bytes(new TextEncoder().encode(chunks.join('')), runtime);
}

function pushOpaqueText(chunks: string[], value: string, runtime: Runtime): void {
	runtime.opaqueCharacters = safeAdd(runtime.opaqueCharacters, value.length);
	if (runtime.opaqueCharacters > runtime.context.limits.opaqueCharacters) { throw new ParadisOfficePackageError('limitExceeded'); }
	chunks.push(value);
}

function parseContentTypes(document: ParadisOfficeXmlDocument, runtime: Runtime): ContentTypeMap {
	const root = document.root;
	if (root.kind !== 'element' || root.uri !== contentTypeNamespace || root.local !== 'Types') { throw new ParadisOfficePackageError('malformed'); }
	const defaults = new Map<string, string>();
	const overrides = new Map<string, string>();
	for (const child of elementChildren(root)) {
		checkpoint(runtime);
		if (child.uri !== contentTypeNamespace || child.local !== 'Default' && child.local !== 'Override') { throw new ParadisOfficePackageError('malformed'); }
		if (child.local === 'Default') {
			exactAttributes(child, ['Extension', 'ContentType']);
			const extension = requiredAttribute(child, 'Extension').toLocaleLowerCase('en-US');
			const type = requiredAttribute(child, 'ContentType');
			if (!extension || defaults.has(extension) || !validMime(type)) { throw new ParadisOfficePackageError('malformed'); }
			defaults.set(extension, type);
		} else {
			exactAttributes(child, ['PartName', 'ContentType']);
			const partId = canonicalPartId(requiredAttribute(child, 'PartName'));
			const type = requiredAttribute(child, 'ContentType');
			if (overrides.has(partId) || !validMime(type)) { throw new ParadisOfficePackageError('malformed'); }
			overrides.set(partId, type);
		}
	}
	return { defaults, overrides };
}

function validateContentType(partId: string, allowed: ReadonlySet<string>, map: ContentTypeMap): void {
	const extension = partId.slice(partId.lastIndexOf('.') + 1).toLocaleLowerCase('en-US');
	const type = map.overrides.get(partId) ?? map.defaults.get(extension);
	if (!type || !allowed.has(type)) { throw new ParadisOfficePackageError('unsafe'); }
}

function parseRelationships(document: ParadisOfficeXmlDocument, ownerPartId: string, runtime: Runtime): readonly Relationship[] {
	const root = document.root;
	if (root.kind !== 'element' || root.uri !== packageRelationshipNamespace || root.local !== 'Relationships') { throw new ParadisOfficePackageError('malformed'); }
	const result: Relationship[] = [];
	const ids = new Set<string>();
	for (const node of elementChildren(root)) {
		checkpoint(runtime);
		if (node.uri !== packageRelationshipNamespace || node.local !== 'Relationship') { throw new ParadisOfficePackageError('malformed'); }
		exactAttributes(node, ['Id', 'Type', 'Target', 'TargetMode']);
		const id = requiredAttribute(node, 'Id');
		const type = requiredAttribute(node, 'Type');
		const target = requiredAttribute(node, 'Target');
		const mode = attribute(node, 'TargetMode');
		if (!id || ids.has(id) || !type || !target || mode !== undefined && mode !== 'External') { throw new ParadisOfficePackageError('malformed'); }
		ids.add(id);
		result.push({ id, type, target, external: mode === 'External', ...(mode !== 'External' ? { resolvedTarget: resolveRelationshipTarget(ownerPartId, target) } : {}) });
	}
	return result;
}

function validateRelationshipTarget(relationships: readonly Relationship[], type: string, id: string | undefined, target: string): void {
	const candidates = relationships.filter(candidate => relationshipTypeMatches(candidate.type, type) && (id === undefined || candidate.id === id));
	if (candidates.length !== 1 || candidates[0].external || candidates[0].resolvedTarget !== target) { throw new ParadisOfficePackageError('unsafe'); }
}

function relationshipTypeMatches(value: string, suffix: string): boolean {
	return [...officeRelationshipNamespaces].some(namespace => value === `${namespace}/${suffix}`);
}

function relationshipTargetMap(relationships: readonly Relationship[]): ReadonlyMap<string, string> {
	const result = new Map<string, string>();
	for (const relationship of relationships) { result.set(relationship.id, relationship.resolvedTarget ?? `external:${sha256Bytes(new TextEncoder().encode(relationship.target)).value}`); }
	return result;
}

function resolveRelationshipTarget(ownerPartId: string, target: string): string {
	if (!target || target.includes('\\') || target.includes('?') || target.includes('#') || /^[A-Za-z][A-Za-z0-9+.-]*:/.test(target)) { throw new ParadisOfficePackageError('unsafe'); }
	let decoded: string;
	try { decoded = decodeURIComponent(target); } catch { throw new ParadisOfficePackageError('unsafe'); }
	if (decoded.includes('\\') || decoded.includes('\0')) { throw new ParadisOfficePackageError('unsafe'); }
	const base = ownerPartId === '/' ? '/' : ownerPartId.slice(0, ownerPartId.lastIndexOf('/') + 1);
	return canonicalPartId(decoded.startsWith('/') ? decoded : `${base}${decoded}`);
}

function canonicalPartId(value: string): string {
	if (typeof value !== 'string' || !value.startsWith('/') || value.includes('\\') || value.includes('\0') || value.includes('?') || value.includes('#') || value.length > 2048) { throw new ParadisOfficePackageError('unsafe'); }
	const segments: string[] = [];
	for (const segment of value.split('/')) {
		if (!segment || segment === '.') { continue; }
		if (segment === '..') { if (segments.length === 0) { throw new ParadisOfficePackageError('unsafe'); } segments.pop(); }
		else { segments.push(segment); }
	}
	const result = `/${segments.join('/')}`;
	if (result !== value.replace(/\/\.(?=\/|$)/g, '').replace(/\/{2,}/g, '/')) {
		// Relationship targets may contain dot segments, but public PartSource identities may not.
		if (!value.includes('/../')) { throw new ParadisOfficePackageError('unsafe'); }
	}
	return result;
}

function validMime(value: string): boolean {
	return /^[a-z0-9!#$&^_.+\-]+\/[a-z0-9!#$&^_.+\-]+(?:;[^\r\n]*)?$/i.test(value);
}

function ownXmlDocument(value: unknown, runtime: Runtime): ParadisOfficeXmlDocument {
	const record = ownRecord(value, new Set(['root']));
	return { root: ownXmlElement(record.root, runtime, new WeakSet(), 1, { nodes: 0, characters: 0 }) };
}

function ownXmlElement(
	value: unknown,
	runtime: Runtime,
	seen: WeakSet<object>,
	depth: number,
	usage: { nodes: number; characters: number },
): XmlElement {
	if (depth > runtime.context.limits.xmlDepth || !value || typeof value !== 'object' || seen.has(value)) { throw new ParadisOfficePackageError(depth > runtime.context.limits.xmlDepth ? 'limitExceeded' : 'unsafe'); }
	seen.add(value); usage.nodes = safeAdd(usage.nodes, 1);
	if (usage.nodes > runtime.context.limits.xmlNodes) { throw new ParadisOfficePackageError('limitExceeded'); }
	const record = ownRecord(value, new Set(['kind', 'uri', 'local', 'attributes', 'children', 'namespaceBindings']));
	if (record.kind !== 'element' || typeof record.uri !== 'string' || typeof record.local !== 'string') { throw new ParadisOfficePackageError('unsafe'); }
	const attributes = ownArray(record.attributes, runtime.context.limits.xmlNodes, runtime).map(candidate => {
		const attributeRecord = ownRecord(candidate, new Set(['uri', 'local', 'value']));
		if (typeof attributeRecord.uri !== 'string' || typeof attributeRecord.local !== 'string' || typeof attributeRecord.value !== 'string' || attributeRecord.value.length > runtime.context.limits.attributeLength) { throw new ParadisOfficePackageError('unsafe'); }
		return { uri: attributeRecord.uri, local: attributeRecord.local, value: attributeRecord.value };
	});
	const children: ParadisOfficeXmlNode[] = [];
	for (const candidate of ownArray(record.children, runtime.context.limits.xmlNodes, runtime)) {
		checkpoint(runtime);
		if (!candidate || typeof candidate !== 'object') { throw new ParadisOfficePackageError('unsafe'); }
		const kind = Object.getOwnPropertyDescriptor(candidate, 'kind');
		if (!kind || !Object.prototype.hasOwnProperty.call(kind, 'value')) { throw new ParadisOfficePackageError('unsafe'); }
		if (kind.value === 'element') { children.push(ownXmlElement(candidate, runtime, seen, depth + 1, usage)); }
		else if (kind.value === 'text') {
			const text = ownRecord(candidate, new Set(['kind', 'value']));
			if (typeof text.value !== 'string') { throw new ParadisOfficePackageError('unsafe'); }
			usage.nodes = safeAdd(usage.nodes, 1); usage.characters = safeAdd(usage.characters, text.value.length);
			if (usage.nodes > runtime.context.limits.xmlNodes || usage.characters > runtime.context.limits.xmlCharacters) { throw new ParadisOfficePackageError('limitExceeded'); }
			children.push({ kind: 'text', value: text.value });
		} else { throw new ParadisOfficePackageError('unsafe'); }
	}
	return { kind: 'element', uri: record.uri, local: record.local, attributes, children };
}

function xmlDocumentsEqual(left: ParadisOfficeXmlDocument, right: ParadisOfficeXmlDocument, runtime: Runtime): boolean {
	const stack: Array<readonly [ParadisOfficeXmlNode, ParadisOfficeXmlNode]> = [[left.root, right.root]];
	while (stack.length > 0) {
		checkpoint(runtime);
		const [leftNode, rightNode] = stack.pop()!;
		if (leftNode.kind !== rightNode.kind) { return false; }
		if (leftNode.kind === 'text' && rightNode.kind === 'text') { if (leftNode.value !== rightNode.value) { return false; } continue; }
		if (leftNode.kind !== 'element' || rightNode.kind !== 'element' || leftNode.uri !== rightNode.uri || leftNode.local !== rightNode.local
			|| leftNode.attributes.length !== rightNode.attributes.length || leftNode.children.length !== rightNode.children.length) { return false; }
		const leftAttributes = [...leftNode.attributes].sort(compareAttributes);
		const rightAttributes = [...rightNode.attributes].sort(compareAttributes);
		for (let index = 0; index < leftAttributes.length; index++) {
			if (leftAttributes[index].uri !== rightAttributes[index].uri || leftAttributes[index].local !== rightAttributes[index].local || leftAttributes[index].value !== rightAttributes[index].value) { return false; }
		}
		for (let index = leftNode.children.length - 1; index >= 0; index--) { stack.push([leftNode.children[index], rightNode.children[index]]); }
	}
	return true;
}

function compareAttributes(left: { readonly uri: string; readonly local: string }, right: { readonly uri: string; readonly local: string }): number {
	return compareCodePoint(`${left.uri}\0${left.local}`, `${right.uri}\0${right.local}`);
}

function spreadsheetRoot(document: ParadisOfficeXmlDocument, local: string): XmlElement {
	if (!document || document.root.kind !== 'element' || !spreadsheetNamespaces.has(document.root.uri) || document.root.local !== local) { throw new ParadisOfficePackageError('malformed'); }
	return document.root;
}

function elementChildren(node: XmlElement): readonly XmlElement[] {
	return node.children.filter((child): child is XmlElement => child.kind === 'element');
}

function textOnly(node: XmlElement): string {
	let result = '';
	for (const child of node.children) { if (child.kind !== 'text') { throw new ParadisOfficePackageError('malformed'); } result += child.value; }
	return result;
}

function exactAttributes(node: XmlElement, ordinaryNames: readonly string[], relationshipNames: readonly string[] = []): void {
	const ordinary = new Set(ordinaryNames);
	const related = new Set(relationshipNames);
	for (const candidate of node.attributes) {
		if (candidate.uri === '' && ordinary.has(candidate.local) || officeRelationshipNamespaces.has(candidate.uri) && related.has(candidate.local)) { continue; }
		throw new ParadisOfficePackageError('malformed');
	}
}

function attribute(node: XmlElement, local: string): string | undefined {
	return node.attributes.find(candidate => candidate.uri === '' && candidate.local === local)?.value;
}

function namespacedAttribute(node: XmlElement, namespaces: ReadonlySet<string>, local: string): string | undefined {
	return node.attributes.find(candidate => namespaces.has(candidate.uri) && candidate.local === local)?.value;
}

function requiredAttribute(node: XmlElement, local: string): string {
	const value = attribute(node, local);
	if (value === undefined) { throw new ParadisOfficePackageError('malformed'); }
	return value;
}

function optionalBoolean(node: XmlElement, local: string): boolean | undefined {
	const value = attribute(node, local);
	return value === undefined ? undefined : booleanLexical(value);
}

function booleanLexical(value: string): boolean {
	if (value === '1' || value === 'true') { return true; }
	if (value === '0' || value === 'false') { return false; }
	throw new ParadisOfficePackageError('malformed');
}

function boundedInteger(value: string, minimum: number, maximum: number): number {
	if (!/^(?:0|[1-9][0-9]*)$/.test(value)) { throw new ParadisOfficePackageError('malformed'); }
	const result = Number(value);
	if (!Number.isSafeInteger(result) || result < minimum || result > maximum) { throw new ParadisOfficePackageError('malformed'); }
	return result;
}

function boundedOptionalInteger(value: string | undefined, minimum: number, maximum: number): number | undefined {
	return value === undefined ? undefined : boundedInteger(value, minimum, maximum);
}

function enumAttribute<T extends string>(node: XmlElement, local: string, values: readonly T[]): T | undefined {
	const value = attribute(node, local);
	if (value === undefined) { return undefined; }
	if (!(values as readonly string[]).includes(value)) { throw new ParadisOfficePackageError('malformed'); }
	return value as T;
}

function iconSetAttribute(node: XmlElement): string {
	const value = requiredAttribute(node, 'iconSet');
	const allowed = new Set([
		'3Arrows', '3ArrowsGray', '3Flags', '3TrafficLights1', '3TrafficLights2', '3Signs', '3Symbols', '3Symbols2',
		'4Arrows', '4ArrowsGray', '4RedToBlack', '4Rating', '4TrafficLights', '5Arrows', '5ArrowsGray', '5Rating', '5Quarters',
	]);
	if (!allowed.has(value)) { throw new ParadisOfficePackageError('malformed'); }
	return value;
}

function requiredFiniteLexical(node: XmlElement, local: string): string {
	const value = requiredAttribute(node, local);
	if (!Number.isFinite(Number(value))) { throw new ParadisOfficePackageError('malformed'); }
	return value;
}

function optionalFiniteLexical(node: XmlElement, local: string): string | undefined {
	const value = attribute(node, local);
	if (value !== undefined && !Number.isFinite(Number(value))) { throw new ParadisOfficePackageError('malformed'); }
	return value;
}

function singleton(seen: Set<string>, value: string): void {
	if (seen.has(value)) { throw new ParadisOfficePackageError('malformed'); }
	seen.add(value);
}

function rangeContains(outer: ParadisSemanticRange, inner: ParadisSemanticRange): boolean {
	return outer.minRow <= inner.minRow && outer.maxRow >= inner.maxRow && outer.minColumn <= inner.minColumn && outer.maxColumn >= inner.maxColumn;
}

function rangesOverlap(left: ParadisSemanticRange, right: ParadisSemanticRange): boolean {
	return left.minRow <= right.maxRow && right.minRow <= left.maxRow && left.minColumn <= right.maxColumn && right.minColumn <= left.maxColumn;
}

function semanticText(value: string, runtime: Runtime): string {
	if (!isValidText(value)) { throw new ParadisOfficePackageError('malformed'); }
	runtime.textCharacters = safeAdd(runtime.textCharacters, value.length);
	if (runtime.textCharacters > runtime.context.limits.textCharacters) { throw new ParadisOfficePackageError('limitExceeded'); }
	return value;
}

function optionalSemanticText(node: XmlElement, local: string, runtime: Runtime): string | undefined {
	const value = attribute(node, local);
	return value === undefined ? undefined : semanticText(value, runtime);
}

function textIdentity(value: string, runtime: Runtime, redactPaths: boolean): ParadisSpreadsheetTextIdentity {
	semanticText(value, runtime);
	return { text: redactPaths ? redactPathText(value) : sanitizeText(value), fingerprint: sha256Bytes(new TextEncoder().encode(value), runtime) };
}

function redactPathText(value: string): string {
	return redactSpreadsheetHeaderFooterText(value);
}

function sanitizeText(value: string): string {
	return value.normalize('NFC').replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/g, '�');
}

function isValidText(value: string): boolean {
	for (let index = 0; index < value.length; index++) {
		const code = value.charCodeAt(index);
		if (code === 0 || code >= 0xd800 && code <= 0xdbff && (++index >= value.length || value.charCodeAt(index) < 0xdc00 || value.charCodeAt(index) > 0xdfff) || code >= 0xdc00 && code <= 0xdfff) { return false; }
	}
	return true;
}

function consume<K extends keyof Runtime>(runtime: Runtime, key: K, limit: number): void {
	checkpoint(runtime);
	const current = runtime[key];
	if (typeof current !== 'number') { throw new ParadisOfficePackageError('unsafe'); }
	const value = safeAdd(current, 1);
	if (value > limit) { throw new ParadisOfficePackageError('limitExceeded'); }
	(runtime as Record<keyof Runtime, Runtime[keyof Runtime]>)[key] = value;
}

function compact<T extends object>(value: T): T {
	const result: Record<string, unknown> = {};
	for (const [key, entry] of Object.entries(value)) { if (entry !== undefined) { result[key] = entry; } }
	return result as T;
}

function ownRecord(value: unknown, allowed: ReadonlySet<string>): Record<string, unknown> {
	if (!value || typeof value !== 'object') { throw new ParadisOfficePackageError('unsafe'); }
	const prototype = Object.getPrototypeOf(value);
	if (prototype !== Object.prototype && prototype !== null) { throw new ParadisOfficePackageError('unsafe'); }
	const result: Record<string, unknown> = {};
	for (const key of allowed) {
		const descriptor = Object.getOwnPropertyDescriptor(value, key);
		if (!descriptor) { continue; }
		if (!Object.prototype.hasOwnProperty.call(descriptor, 'value')) { throw new ParadisOfficePackageError('unsafe'); }
		result[key] = descriptor.value;
	}
	return result;
}

function ownArray(value: unknown, limit: number, runtime: Runtime): readonly unknown[] {
	if (!Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype) { throw new ParadisOfficePackageError('unsafe'); }
	const descriptor = Object.getOwnPropertyDescriptor(value, 'length');
	if (!descriptor || !Object.prototype.hasOwnProperty.call(descriptor, 'value') || !Number.isSafeInteger(descriptor.value) || descriptor.value < 0 || descriptor.value > limit) {
		throw new ParadisOfficePackageError(descriptor && descriptor.value > limit ? 'limitExceeded' : 'unsafe');
	}
	const length = descriptor.value as number;
	const result: unknown[] = [];
	for (let index = 0; index < length; index++) {
		checkpoint(runtime);
		const item = Object.getOwnPropertyDescriptor(value, index);
		if (!item || !Object.prototype.hasOwnProperty.call(item, 'value')) { throw new ParadisOfficePackageError('unsafe'); }
		result.push(item.value);
	}
	if (Object.getOwnPropertyDescriptor(value, 'length')?.value !== length) { throw new ParadisOfficePackageError('unsafe'); }
	return result;
}

function ownBytes(value: unknown, limit: number, runtime?: Runtime): Uint8Array {
	const observe = () => runtime && checkpoint(runtime, true);
	observe();
	if (!value || typeof value !== 'object' || !arrayBufferIsView(value) || Object.getPrototypeOf(value) !== Uint8Array.prototype) { throw new ParadisOfficePackageError('unsafe'); }
	for (const key of ['constructor', 'byteLength', 'slice', Symbol.species]) { observe(); if (Object.getOwnPropertyDescriptor(value, key)) { throw new ParadisOfficePackageError('unsafe'); } }
	const source = value as Uint8Array;
	const buffer = typedArrayBuffer.call(source) as ArrayBuffer;
	if (Object.getPrototypeOf(buffer) !== arrayBufferPrototype) { throw new ParadisOfficePackageError('unsafe'); }
	for (const key of ['constructor', 'byteLength', 'slice', Symbol.species]) { observe(); if (Object.getOwnPropertyDescriptor(buffer, key)) { throw new ParadisOfficePackageError('unsafe'); } }
	if (arrayBufferResizable?.call(buffer) === true || arrayBufferDetached?.call(buffer) === true) { throw new ParadisOfficePackageError('unsafe'); }
	const length = typedArrayByteLength.call(source) as number;
	const bufferLength = arrayBufferByteLength.call(buffer) as number;
	if (!Number.isSafeInteger(length) || length < 0 || length > limit || !Number.isSafeInteger(bufferLength) || bufferLength < length) { throw new ParadisOfficePackageError(length > limit ? 'limitExceeded' : 'unsafe'); }
	const owned = new Uint8Array(new ArrayBuffer(length));
	typedArraySet.call(owned, source);
	observe();
	if (typedArrayBuffer.call(source) !== buffer || typedArrayByteLength.call(source) !== length || arrayBufferByteLength.call(buffer) !== bufferLength
		|| arrayBufferResizable?.call(buffer) === true || arrayBufferDetached?.call(buffer) === true) { throw new ParadisOfficePackageError('unsafe'); }
	for (let index = 0; index < length; index++) { if ((index & 0xfff) === 0) { observe(); } if (owned[index] !== source[index]) { throw new ParadisOfficePackageError('unsafe'); } }
	observe();
	return owned;
}

function ownPartSource(value: unknown): ParadisSpreadsheetPartSource {
	const source = ownRecord(value, new Set(['partId', 'fingerprint']));
	const fingerprint = ownRecord(source.fingerprint, new Set(['algorithm', 'value', 'byteLength']));
	if (typeof source.partId !== 'string' || canonicalPartId(source.partId) !== source.partId || fingerprint.algorithm !== 'sha256'
		|| typeof fingerprint.value !== 'string' || !/^[0-9a-f]{64}$/i.test(fingerprint.value)
		|| !Number.isSafeInteger(fingerprint.byteLength) || (fingerprint.byteLength as number) < 0) { throw new ParadisOfficePackageError('unsafe'); }
	return { partId: source.partId, fingerprint: { algorithm: 'sha256', value: fingerprint.value.toLocaleLowerCase('en-US'), byteLength: fingerprint.byteLength as number } };
}

function verifySource(bytes: Uint8Array, source: ParadisSpreadsheetPartSource, runtime: Runtime): void {
	const actual = sha256Bytes(bytes, runtime);
	if (actual.value !== source.fingerprint.value || actual.byteLength !== source.fingerprint.byteLength) { throw new ParadisOfficePackageError('unsafe'); }
}

function deepFreeze<T>(value: T, runtime: Runtime): T {
	const seen = new WeakSet<object>();
	const stack: object[] = [];
	if (value && typeof value === 'object') { stack.push(value); }
	while (stack.length > 0) {
		checkpoint(runtime);
		const current = stack.pop()!;
		if (seen.has(current)) { continue; }
		seen.add(current);
		runtime.outputNodes = safeAdd(runtime.outputNodes, 1);
		if (runtime.outputNodes > runtime.context.limits.outputNodes) { throw new ParadisOfficePackageError('limitExceeded'); }
		const keys: PropertyKey[] = [];
		if (Array.isArray(current)) {
			const length = Object.getOwnPropertyDescriptor(current, 'length')?.value;
			if (!Number.isSafeInteger(length) || length < 0) { throw new ParadisOfficePackageError('unsafe'); }
			for (let index = 0; index < length; index++) { keys.push(String(index)); }
		} else { keys.push(...Reflect.ownKeys(current)); }
		runtime.outputProperties = safeAdd(runtime.outputProperties, keys.length);
		if (runtime.outputProperties > runtime.context.limits.outputProperties) { throw new ParadisOfficePackageError('limitExceeded'); }
		for (const key of keys) { const child = Object.getOwnPropertyDescriptor(current, key)?.value; if (child && typeof child === 'object') { stack.push(child); } }
		Object.freeze(current);
	}
	return value;
}

function sha256Bytes(bytes: Uint8Array, runtime?: Runtime): ParadisSpreadsheetPartSource['fingerprint'] {
	const paddedLength = Math.ceil((bytes.length + 9) / 64) * 64;
	const padded = new Uint8Array(paddedLength); padded.set(bytes); padded[bytes.length] = 0x80;
	const bitLength = bytes.length * 8;
	const view = new DataView(padded.buffer); view.setUint32(paddedLength - 8, Math.floor(bitLength / 0x1_0000_0000), false); view.setUint32(paddedLength - 4, bitLength >>> 0, false);
	const constants = [
		0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
		0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
		0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
		0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
		0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
		0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
		0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
		0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
	];
	const state = new Uint32Array([0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19]);
	const words = new Uint32Array(64);
	for (let offset = 0; offset < paddedLength; offset += 64) {
		if (runtime) { checkpoint(runtime); }
		for (let index = 0; index < 16; index++) { words[index] = view.getUint32(offset + index * 4, false); }
		for (let index = 16; index < 64; index++) {
			const left = words[index - 15], right = words[index - 2];
			words[index] = (words[index - 16] + (rotateRight(left, 7) ^ rotateRight(left, 18) ^ left >>> 3) + words[index - 7] + (rotateRight(right, 17) ^ rotateRight(right, 19) ^ right >>> 10)) >>> 0;
		}
		let [a, b, c, d, e, f, g, h] = state;
		for (let index = 0; index < 64; index++) {
			const temporary1 = (h + (rotateRight(e, 6) ^ rotateRight(e, 11) ^ rotateRight(e, 25)) + ((e & f) ^ (~e & g)) + constants[index] + words[index]) >>> 0;
			const temporary2 = ((rotateRight(a, 2) ^ rotateRight(a, 13) ^ rotateRight(a, 22)) + ((a & b) ^ (a & c) ^ (b & c))) >>> 0;
			h = g; g = f; f = e; e = (d + temporary1) >>> 0; d = c; c = b; b = a; a = (temporary1 + temporary2) >>> 0;
		}
		state[0] = (state[0] + a) >>> 0; state[1] = (state[1] + b) >>> 0; state[2] = (state[2] + c) >>> 0; state[3] = (state[3] + d) >>> 0;
		state[4] = (state[4] + e) >>> 0; state[5] = (state[5] + f) >>> 0; state[6] = (state[6] + g) >>> 0; state[7] = (state[7] + h) >>> 0;
	}
	return { algorithm: 'sha256', value: [...state].map(word => word.toString(16).padStart(8, '0')).join(''), byteLength: bytes.length };
}

function rotateRight(value: number, bits: number): number { return value >>> bits | value << 32 - bits; }

function compareCodePoint(left: string, right: string): number { return left < right ? -1 : left > right ? 1 : 0; }

function safeAdd(left: number, right: number): number {
	const result = left + right;
	if (!Number.isSafeInteger(result) || result < 0) { throw new ParadisOfficePackageError('limitExceeded'); }
	return result;
}

function sanitizeError(error: unknown): ParadisOfficePackageError {
	try {
		if (error instanceof ParadisOfficePackageError) {
			const code = Object.getOwnPropertyDescriptor(error, 'code')?.value;
			if (code === 'invalid' || code === 'encrypted' || code === 'zipBomb' || code === 'limitExceeded' || code === 'malformed' || code === 'cancelled' || code === 'unsafe') { return new ParadisOfficePackageError(code); }
		}
	} catch { /* Poisoned failures do not cross this boundary. */ }
	return new ParadisOfficePackageError('unsafe');
}
