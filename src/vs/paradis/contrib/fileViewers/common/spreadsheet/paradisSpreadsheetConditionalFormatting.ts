/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import type { CancellationToken } from '../../../../../base/common/cancellation.js';
import { StopWatch } from '../../../../../base/common/stopwatch.js';
import { parseParadisOfficeXml } from '../office/paradisOfficeCanonicalXml.js';
import {
	type ParadisOfficeXmlDocument,
	type ParadisOfficeXmlNode,
	ParadisOfficePackageError,
	throwIfParadisOfficeCancelled,
} from '../office/paradisOfficeArchive.js';
import type {
	ParadisSemanticCell,
	ParadisSemanticRange,
	ParadisSpreadsheetColor,
	ParadisSpreadsheetConditionalBorder,
	ParadisSpreadsheetConditionalFormatEvaluation,
	ParadisSpreadsheetConditionalFormatting,
	ParadisSpreadsheetConditionalFormatRule,
	ParadisSpreadsheetConditionalFormatRuleType,
	ParadisSpreadsheetConditionalNotEvaluatedReason,
	ParadisSpreadsheetConditionalOperator,
	ParadisSpreadsheetConditionalRenderOverlay,
	ParadisSpreadsheetConditionalTimePeriod,
	ParadisSpreadsheetConditionalValueObject,
	ParadisSpreadsheetConditionalVisualRule,
	ParadisSpreadsheetDifferentialFill,
	ParadisSpreadsheetDifferentialFont,
	ParadisSpreadsheetDifferentialAlignment,
	ParadisSpreadsheetDifferentialProtection,
	ParadisSpreadsheetDifferentialStyle,
	ParadisSpreadsheetPartSource,
	ParadisSpreadsheetSnapshot,
	ParadisSpreadsheetX14DataBar,
	ParadisSpreadsheetX14OpaqueRule,
} from './paradisSpreadsheetSemantic.js';

export type { ParadisSpreadsheetConditionalFormatEvaluation } from './paradisSpreadsheetSemantic.js';

type XmlElement = Extract<ParadisOfficeXmlNode, { readonly kind: 'element' }>;

const spreadsheetNamespaces = new Set([
	'http://schemas.openxmlformats.org/spreadsheetml/2006/main',
	'http://purl.oclc.org/ooxml/spreadsheetml/main',
]);
const markupCompatibilityNamespace = 'http://schemas.openxmlformats.org/markup-compatibility/2006';
const markupCompatibilityRootAttributes = new Set(['Ignorable', 'MustUnderstand', 'ProcessContent', 'PreserveElements', 'PreserveAttributes']);
const spreadsheetRevisionNamespace = 'http://schemas.microsoft.com/office/spreadsheetml/2014/revision';
const spreadsheetX14Namespace = 'http://schemas.microsoft.com/office/spreadsheetml/2009/9/main';
const spreadsheetXmNamespace = 'http://schemas.microsoft.com/office/excel/2006/main';
const maximumExcelRows = 1_048_576;
const maximumExcelColumns = 16_384;
const maximumDeadlineMilliseconds = 60_000;
const parsedConditionalFormattingModels = new WeakSet<object>();
const verifiedDifferentialStylesCache = new WeakMap<object, { readonly source: ParadisSpreadsheetPartSource; readonly styles: readonly ParadisSpreadsheetDifferentialStyle[] }>();

export interface ParadisSpreadsheetConditionalFormattingLimits {
	readonly xmlCharacters: number;
	readonly xmlDepth: number;
	readonly xmlNodes: number;
	readonly attributeLength: number;
	readonly rules: number;
	readonly ranges: number;
	readonly formulasPerRule: number;
	readonly formulaBytes: number;
	readonly formulaDepth: number;
	readonly formulaTokens: number;
	readonly differentialStyles: number;
	readonly evaluatedCells: number;
	readonly evaluationOperations: number;
	readonly evaluationResults: number;
	readonly snapshotSheets: number;
	readonly snapshotCells: number;
	readonly outputNodes: number;
	readonly outputProperties: number;
	readonly opaqueEvents: number;
	readonly opaqueCharacters: number;
}

const defaultLimits: ParadisSpreadsheetConditionalFormattingLimits = {
	xmlCharacters: 24 * 1024 * 1024,
	xmlDepth: 96,
	xmlNodes: 750_000,
	attributeLength: 512 * 1024,
	rules: 10_000,
	ranges: 100_000,
	formulasPerRule: 3,
	formulaBytes: 1024 * 1024,
	formulaDepth: 64,
	formulaTokens: 8192,
	differentialStyles: 10_000,
	evaluatedCells: 10_000,
	evaluationOperations: 10_000_000,
	evaluationResults: 1_000_000,
	snapshotSheets: 1024,
	snapshotCells: 1_000_000,
	outputNodes: 1_000_000,
	outputProperties: 2_000_000,
	opaqueEvents: 1_000_000,
	opaqueCharacters: 24 * 1024 * 1024,
};
const limitKeys = Object.freeze(Object.keys(defaultLimits) as (keyof ParadisSpreadsheetConditionalFormattingLimits)[]);

export interface ParadisSpreadsheetConditionalFormattingInput {
	readonly worksheetXml: string;
	readonly worksheetSource: ParadisSpreadsheetPartSource;
	readonly stylesXml?: string;
	readonly stylesSource?: ParadisSpreadsheetPartSource;
}

/** @internal Verified canonical documents supplied only by the Task 1 package parser. */
export interface ParadisSpreadsheetVerifiedConditionalFormattingInput {
	readonly worksheetDocument: ParadisOfficeXmlDocument;
	readonly worksheetSource: ParadisSpreadsheetPartSource;
	readonly stylesDocument?: ParadisOfficeXmlDocument;
	readonly stylesSource?: ParadisSpreadsheetPartSource;
}

export interface ParadisSpreadsheetConditionalFormattingContext {
	readonly cancellationToken?: CancellationToken;
	readonly now?: () => number;
	readonly deadlineMilliseconds?: number;
	readonly limits?: Partial<ParadisSpreadsheetConditionalFormattingLimits>;
}

export interface ParadisSpreadsheetConditionalFormatEvaluationRequest {
	readonly sheetName: string;
	readonly addresses: readonly string[];
	/** Time-period rules require a caller-owned, timezone-free Excel serial for today. */
	readonly todaySerial?: number;
	readonly cancellationToken?: CancellationToken;
	readonly now?: () => number;
	readonly deadlineMilliseconds?: number;
	readonly limits?: Partial<ParadisSpreadsheetConditionalFormattingLimits>;
}

/** Computes the exact UTF-8 XML identity required by the parser's all-byte authority boundary. */
export function fingerprintSpreadsheetConditionalFormattingXml(xml: string): ParadisSpreadsheetPartSource['fingerprint'] {
	try {
		if (typeof xml !== 'string' || xml.length > defaultLimits.xmlCharacters) {
			throw new ParadisOfficePackageError(typeof xml === 'string' ? 'limitExceeded' : 'unsafe');
		}
		return sha256Xml(xml);
	} catch (error) {
		throw sanitizeConditionalFormattingError(error);
	}
}

interface OwnedContext {
	readonly cancellationToken?: CancellationToken;
	readonly now: () => number;
	readonly deadlineMilliseconds: number;
	readonly limits: ParadisSpreadsheetConditionalFormattingLimits;
}

interface Runtime {
	readonly context: OwnedContext;
	readonly hardDeadline: StopWatch;
	readonly started: number;
	lastClock: number;
	checks: number;
	formulaBytes: number;
	formulaTokens: number;
	evaluationOperations: number;
	evaluationResults: number;
	ownedRanges: number;
	outputNodes: number;
	outputProperties: number;
	parsedRanges: number;
	parsedRules: number;
	opaqueEvents: number;
	opaqueCharacters: number;
	readonly upstreamCheckpoint?: () => void;
	workbook?: OwnedWorkbook;
	readonly formulaDependencyReasons: Map<string, ParadisSpreadsheetConditionalNotEvaluatedReason>;
}

interface CellCoordinate {
	readonly row: number;
	readonly column: number;
}

interface OwnedCell {
	readonly address: string;
	readonly coordinate: CellCoordinate;
	readonly cell?: ParadisSemanticCell;
}

interface OwnedSheet {
	readonly name: string;
	readonly partId: string;
	readonly source: ParadisSpreadsheetPartSource;
	readonly cells: ReadonlyMap<string, ParadisSemanticCell>;
}

interface OwnedWorkbook {
	readonly date1904: boolean;
	readonly sheets: ReadonlyMap<string, OwnedSheet>;
	readonly stylesSource?: ParadisSpreadsheetPartSource;
}

interface EvaluationCache {
	readonly numericValues: Map<string, readonly number[]>;
	readonly averageStatistics: Map<string, { readonly scale: number; readonly mean: number; readonly standardDeviation: number }>;
	readonly topThresholds: Map<string, number>;
	readonly visualThresholds: Map<string, readonly number[]>;
	readonly duplicateCounts: Map<string, ReadonlyMap<string, number>>;
	readonly canonicalSupplementalFormulas: Map<string, boolean>;
}

type Scalar = number | string | boolean | { readonly kind: 'blank' };
type FormulaValue = Scalar | readonly Scalar[];

class EvaluationIssue {
	constructor(readonly reason: ParadisSpreadsheetConditionalNotEvaluatedReason) { }
}

/** Parses raw worksheet/styles OOXML into immutable rules without evaluating or mutating cell styles. */
export function parseSpreadsheetConditionalFormatting(
	input: ParadisSpreadsheetConditionalFormattingInput,
	context: ParadisSpreadsheetConditionalFormattingContext = {},
): ParadisSpreadsheetConditionalFormatting {
	const hardDeadline = StopWatch.create(true);
	try {
		const ownedContext = ownContext(context);
		const runtime = createRuntime(ownedContext, hardDeadline);
		const ownedInput = ownParseInput(input, runtime);
		checkpoint(runtime, true);
		const worksheetDocument = parseParadisOfficeXml(ownedInput.worksheetXml, xmlLimits(ownedContext), ownedContext.cancellationToken, () => checkpoint(runtime));
		const stylesDocument = ownedInput.stylesXml === undefined ? undefined : parseParadisOfficeXml(ownedInput.stylesXml, xmlLimits(ownedContext), ownedContext.cancellationToken, () => checkpoint(runtime));
		return buildConditionalFormattingModel(worksheetDocument, ownedInput.worksheetSource, stylesDocument, ownedInput.stylesSource, runtime);
	} catch (error) {
		throw sanitizeConditionalFormattingError(error);
	}
}

/** @internal Parses Parts whose all-byte identity was already verified by Task 1. */
export function parseSpreadsheetConditionalFormattingVerifiedDocuments(
	input: ParadisSpreadsheetVerifiedConditionalFormattingInput,
	upstreamCheckpoint: () => void,
): ParadisSpreadsheetConditionalFormatting {
	const hardDeadline = StopWatch.create(true);
	try {
		if (!input || typeof input !== 'object' || typeof upstreamCheckpoint !== 'function') { throw new ParadisOfficePackageError('unsafe'); }
		const runtime = createRuntime(ownContext({}), hardDeadline, upstreamCheckpoint);
		const worksheetSource = ownPartSource(input.worksheetSource);
		const stylesSource = input.stylesSource === undefined ? undefined : ownPartSource(input.stylesSource);
		if (!input.worksheetDocument?.root || (input.stylesDocument === undefined) !== (stylesSource === undefined)) { throw new ParadisOfficePackageError('unsafe'); }
		let differentialStyles: readonly ParadisSpreadsheetDifferentialStyle[] | undefined;
		if (input.stylesDocument && stylesSource) {
			const cached = verifiedDifferentialStylesCache.get(input.stylesDocument);
			if (cached && samePartSource(cached.source, stylesSource)) {
				differentialStyles = cached.styles;
			} else {
				differentialStyles = deepFreeze(parseDifferentialStyles(input.stylesDocument, stylesSource, runtime), runtime);
				verifiedDifferentialStylesCache.set(input.stylesDocument, { source: stylesSource, styles: differentialStyles });
			}
		}
		return buildConditionalFormattingModel(input.worksheetDocument, worksheetSource, input.stylesDocument, stylesSource, runtime, differentialStyles);
	} catch (error) {
		throw sanitizeConditionalFormattingError(error);
	}
}

function buildConditionalFormattingModel(
	worksheetDocument: ParadisOfficeXmlDocument,
	worksheetSource: ParadisSpreadsheetPartSource,
	stylesDocument: ParadisOfficeXmlDocument | undefined,
	stylesSource: ParadisSpreadsheetPartSource | undefined,
	runtime: Runtime,
	preparsedDifferentialStyles?: readonly ParadisSpreadsheetDifferentialStyle[],
): ParadisSpreadsheetConditionalFormatting {
	const differentialStyles = preparsedDifferentialStyles ?? (stylesDocument ? parseDifferentialStyles(stylesDocument, stylesSource!, runtime) : []);
	const result: ParadisSpreadsheetConditionalFormatting = {
		worksheetSource, ...(stylesSource ? { stylesSource } : {}),
		rules: parseRules(worksheetDocument, worksheetSource, runtime), differentialStyles,
	};
	const frozen = deepFreeze(result, runtime);
	parsedConditionalFormattingModels.add(frozen);
	return frozen;
}

/**
 * Evaluates requested cells from raw semantic values/caches only; no formula recalculation occurs.
 * `snapshot` is a trusted, operation-local Task 1 parser result. Serialized or caller-forged snapshot
 * graphs are outside this API boundary; the evaluator re-owns the graph to prevent later TOCTOU only.
 */
/** @internal Evaluation core; public callers must use the Task 1 authority wrapper. */
export function evaluateSpreadsheetConditionalFormattingOwned(
	model: ParadisSpreadsheetConditionalFormatting,
	snapshot: ParadisSpreadsheetSnapshot,
	request: ParadisSpreadsheetConditionalFormatEvaluationRequest,
): readonly ParadisSpreadsheetConditionalFormatEvaluation[] {
	const hardDeadline = StopWatch.create(true);
	try {
		if (!model || typeof model !== 'object' || !parsedConditionalFormattingModels.has(model)) {
			throw new ParadisOfficePackageError('unsafe');
		}
		const ownedRequest = ownEvaluationRequest(request, hardDeadline);
		const runtime = ownedRequest.runtime;
		const ownedModel = ownModel(model, runtime);
		const workbook = ownWorkbook(snapshot, runtime);
		runtime.workbook = workbook;
		const currentSheet = workbook.sheets.get(normalizeSheetName(ownedRequest.sheetName));
		if (!currentSheet) {
			throw new ParadisOfficePackageError('malformed');
		}
		if (!samePartSource(ownedModel.worksheetSource, currentSheet.source)
			|| ownedModel.stylesSource !== undefined && (!workbook.stylesSource || !samePartSource(ownedModel.stylesSource, workbook.stylesSource))) {
			throw new ParadisOfficePackageError('unsafe');
		}
		const cells = ownRequestedCells(ownedRequest.addresses, currentSheet, runtime);
		const cache: EvaluationCache = { numericValues: new Map(), averageStatistics: new Map(), topThresholds: new Map(), visualThresholds: new Map(), duplicateCounts: new Map(), canonicalSupplementalFormulas: new Map() };
		const results: ParadisSpreadsheetConditionalFormatEvaluation[] = [];
		for (const target of cells) {
			checkpoint(runtime);
			let stoppedByRuleId: string | undefined;
			let uncertainStop = false;
			for (const rule of ownedModel.rules) {
				checkpoint(runtime);
				const anchor = matchingRangeAnchor(rule.ranges, target.coordinate, runtime);
				if (!anchor) {
					continue;
				}
				if (stoppedByRuleId) {
					pushEvaluation(results, { status: 'exact', ruleId: rule.id, priority: rule.priority, cellAddress: target.address, applies: false, suppressedByRuleId: stoppedByRuleId }, runtime);
					continue;
				}
				if (uncertainStop) {
					pushEvaluation(results, { status: 'notEvaluated', ruleId: rule.id, priority: rule.priority, cellAddress: target.address, reason: 'precedingRuleNotEvaluated' }, runtime);
					continue;
				}
				const evaluated = evaluateRule(rule, target, anchor, currentSheet, workbook, ownedModel, ownedRequest.todaySerial, cache, runtime);
				if (evaluated instanceof EvaluationIssue) {
					pushEvaluation(results, { status: 'notEvaluated', ruleId: rule.id, priority: rule.priority, cellAddress: target.address, reason: evaluated.reason }, runtime);
					if (rule.stopIfTrue) {
						uncertainStop = true;
					}
					continue;
				}
				const exact: ParadisSpreadsheetConditionalFormatEvaluation = {
					status: 'exact', ruleId: rule.id, priority: rule.priority, cellAddress: target.address,
					applies: evaluated.applies,
					...(evaluated.overlay ? { renderOverlay: evaluated.overlay } : {}),
				};
				pushEvaluation(results, exact, runtime);
				if (rule.stopIfTrue && evaluated.applies) {
					stoppedByRuleId = rule.id;
				}
			}
		}
		return deepFreeze(results, runtime);
	} catch (error) {
		throw sanitizeConditionalFormattingError(error);
	}
}

function xmlLimits(context: OwnedContext) {
	return {
		depth: context.limits.xmlDepth,
		nodes: context.limits.xmlNodes,
		attributeLength: context.limits.attributeLength,
		characters: context.limits.xmlCharacters,
	};
}

function ownParseInput(input: unknown, runtime: Runtime): ParadisSpreadsheetConditionalFormattingInput {
	const record = ownRecord(input, new Set(['worksheetXml', 'worksheetSource', 'stylesXml', 'stylesSource']));
	if (typeof record.worksheetXml !== 'string' || record.worksheetXml.length > runtime.context.limits.xmlCharacters) {
		throw new ParadisOfficePackageError(typeof record.worksheetXml === 'string' ? 'limitExceeded' : 'unsafe');
	}
	const worksheetSource = ownPartSource(record.worksheetSource);
	verifyXmlSource(record.worksheetXml, worksheetSource, runtime);
	const stylesXml = record.stylesXml;
	if (stylesXml !== undefined && (typeof stylesXml !== 'string' || stylesXml.length > runtime.context.limits.xmlCharacters)) {
		throw new ParadisOfficePackageError(typeof stylesXml === 'string' ? 'limitExceeded' : 'unsafe');
	}
	const stylesSource = record.stylesSource === undefined ? undefined : ownPartSource(record.stylesSource);
	if ((stylesXml === undefined) !== (stylesSource === undefined)) {
		throw new ParadisOfficePackageError('unsafe');
	}
	if (stylesXml !== undefined) {
		verifyXmlSource(stylesXml, stylesSource!, runtime);
	}
	checkpoint(runtime, true);
	return { worksheetXml: record.worksheetXml, worksheetSource, ...(stylesXml === undefined ? {} : { stylesXml, stylesSource: stylesSource! }) };
}

function ownEvaluationRequest(request: unknown, hardDeadline: StopWatch): {
	readonly sheetName: string;
	readonly addresses: readonly string[];
	readonly todaySerial?: number;
	readonly runtime: Runtime;
} {
	const record = ownRecord(request, new Set(['sheetName', 'addresses', 'todaySerial', 'cancellationToken', 'now', 'deadlineMilliseconds', 'limits']));
	if (typeof record.sheetName !== 'string' || record.sheetName.length < 1 || record.sheetName.length > 31) {
		throw new ParadisOfficePackageError('unsafe');
	}
	const context = ownContext(record);
	const runtime = createRuntime(context, hardDeadline);
	const addresses = ownStringArray(record.addresses, context.limits.evaluatedCells, runtime);
	const todaySerial = record.todaySerial;
	if (todaySerial !== undefined && (typeof todaySerial !== 'number' || !Number.isFinite(todaySerial))) {
		throw new ParadisOfficePackageError('unsafe');
	}
	return { sheetName: record.sheetName, addresses, ...(todaySerial === undefined ? {} : { todaySerial }), runtime };
}

function ownContext(value: unknown): OwnedContext {
	const record = ownRecord(value, new Set(['cancellationToken', 'now', 'deadlineMilliseconds', 'limits', 'sheetName', 'addresses', 'todaySerial']));
	const limitsRecord = record.limits === undefined ? undefined : ownRecord(record.limits, new Set(limitKeys));
	const limits = { ...defaultLimits };
	for (const key of limitKeys) {
		const candidate = limitsRecord?.[key];
		if (candidate !== undefined) {
			if (!Number.isSafeInteger(candidate) || (candidate as number) < 1 || (candidate as number) > defaultLimits[key]) {
				throw new ParadisOfficePackageError('limitExceeded');
			}
			limits[key] = candidate as number;
		}
	}
	const now = record.now ?? Date.now;
	if (typeof now !== 'function') {
		throw new ParadisOfficePackageError('unsafe');
	}
	const deadlineMilliseconds = record.deadlineMilliseconds ?? maximumDeadlineMilliseconds;
	if (!Number.isSafeInteger(deadlineMilliseconds) || (deadlineMilliseconds as number) < 0 || (deadlineMilliseconds as number) > maximumDeadlineMilliseconds) {
		throw new ParadisOfficePackageError('limitExceeded');
	}
	const cancellationToken = record.cancellationToken;
	if (cancellationToken !== undefined && (typeof cancellationToken !== 'object' || cancellationToken === null)) {
		throw new ParadisOfficePackageError('unsafe');
	}
	return { ...(cancellationToken ? { cancellationToken: cancellationToken as CancellationToken } : {}), now: now as () => number, deadlineMilliseconds: deadlineMilliseconds as number, limits };
}

function createRuntime(context: OwnedContext, hardDeadline: StopWatch, upstreamCheckpoint?: () => void): Runtime {
	const started = readClock(context.now);
	const runtime: Runtime = {
		context, hardDeadline, started, lastClock: started, checks: 0,
		formulaBytes: 0, formulaTokens: 0, evaluationOperations: 0, evaluationResults: 0, ownedRanges: 0,
		outputNodes: 0, outputProperties: 0,
		parsedRanges: 0, parsedRules: 0,
		opaqueEvents: 0, opaqueCharacters: 0,
		formulaDependencyReasons: new Map(),
		...(upstreamCheckpoint ? { upstreamCheckpoint } : {}),
	};
	checkpoint(runtime, true);
	return runtime;
}

function checkpoint(runtime: Runtime, force = false): void {
	runtime.upstreamCheckpoint?.();
	if (!force && ++runtime.checks % 64 !== 0) {
		return;
	}
	throwIfParadisOfficeCancelled(runtime.context.cancellationToken);
	const current = readClock(runtime.context.now);
	if (current < runtime.lastClock) {
		throw new ParadisOfficePackageError('unsafe');
	}
	runtime.lastClock = current;
	if (current - runtime.started > runtime.context.deadlineMilliseconds || runtime.hardDeadline.elapsed() > runtime.context.deadlineMilliseconds) {
		throw new ParadisOfficePackageError('limitExceeded');
	}
}

function consumeEvaluationOperations(runtime: Runtime, count = 1): void {
	runtime.evaluationOperations = safeAdd(runtime.evaluationOperations, count);
	if (runtime.evaluationOperations > runtime.context.limits.evaluationOperations) {
		throw new ParadisOfficePackageError('limitExceeded');
	}
	checkpoint(runtime);
}

function pushEvaluation(
	results: ParadisSpreadsheetConditionalFormatEvaluation[],
	result: ParadisSpreadsheetConditionalFormatEvaluation,
	runtime: Runtime,
): void {
	runtime.evaluationResults = safeAdd(runtime.evaluationResults, 1);
	if (runtime.evaluationResults > runtime.context.limits.evaluationResults) {
		throw new ParadisOfficePackageError('limitExceeded');
	}
	results.push(result);
}

function consumeOpaqueEvent(runtime: Runtime, text = ''): void {
	runtime.opaqueEvents = safeAdd(runtime.opaqueEvents, 1);
	runtime.opaqueCharacters = safeAdd(runtime.opaqueCharacters, text.length);
	if (runtime.opaqueEvents > runtime.context.limits.opaqueEvents || runtime.opaqueCharacters > runtime.context.limits.opaqueCharacters) {
		throw new ParadisOfficePackageError('limitExceeded');
	}
	checkpoint(runtime);
}

function createOpaquePath(runtime: Runtime, parent: string | undefined, ordinal: number): string {
	consumeEvaluationOperations(runtime);
	const suffix = String(ordinal);
	const length = parent === undefined ? suffix.length : safeAdd(safeAdd(parent.length, 1), suffix.length);
	runtime.opaqueCharacters = safeAdd(runtime.opaqueCharacters, length);
	if (runtime.opaqueCharacters > runtime.context.limits.opaqueCharacters) { throw new ParadisOfficePackageError('limitExceeded'); }
	return parent === undefined ? suffix : `${parent}/${suffix}`;
}

function readClock(now: () => number): number {
	const value = now();
	if (!Number.isFinite(value) || value < 0) {
		throw new ParadisOfficePackageError('unsafe');
	}
	return value;
}

function ownRecord(value: unknown, allowed: ReadonlySet<string>): Record<string, unknown> {
	if (!value || typeof value !== 'object') {
		throw new ParadisOfficePackageError('unsafe');
	}
	const prototype = Object.getPrototypeOf(value);
	if (prototype !== Object.prototype && prototype !== null) {
		throw new ParadisOfficePackageError('unsafe');
	}
	const result: Record<string, unknown> = {};
	for (const key of allowed) {
		const descriptor = Object.getOwnPropertyDescriptor(value, key);
		if (!descriptor) {
			continue;
		}
		if (!Object.prototype.hasOwnProperty.call(descriptor, 'value')) {
			throw new ParadisOfficePackageError('unsafe');
		}
		result[key] = descriptor.value;
	}
	return result;
}

function ownStringArray(value: unknown, limit: number, runtime?: Runtime): readonly string[] {
	const values = ownArrayValues(value, limit, runtime);
	const result: string[] = [];
	for (const entry of values) {
		if (typeof entry !== 'string') {
			throw new ParadisOfficePackageError('unsafe');
		}
		result.push(entry);
	}
	return result;
}

function ownArrayValues(value: unknown, limit: number, runtime?: Runtime): readonly unknown[] {
	if (!Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype) {
		throw new ParadisOfficePackageError('unsafe');
	}
	const lengthDescriptor = Object.getOwnPropertyDescriptor(value, 'length');
	if (!lengthDescriptor || !Object.prototype.hasOwnProperty.call(lengthDescriptor, 'value')
		|| !Number.isSafeInteger(lengthDescriptor.value) || lengthDescriptor.value < 0) {
		throw new ParadisOfficePackageError('unsafe');
	}
	const length = lengthDescriptor.value as number;
	if (length > limit) {
		throw new ParadisOfficePackageError('limitExceeded');
	}
	const result: unknown[] = [];
	for (let index = 0; index < length; index++) {
		if (runtime) { checkpoint(runtime); }
		const descriptor = Object.getOwnPropertyDescriptor(value, index);
		if (!descriptor || !Object.prototype.hasOwnProperty.call(descriptor, 'value')) {
			throw new ParadisOfficePackageError('unsafe');
		}
		result.push(descriptor.value);
	}
	if (Object.getOwnPropertyDescriptor(value, 'length')?.value !== length) {
		throw new ParadisOfficePackageError('unsafe');
	}
	return result;
}

function ownPartSource(value: unknown): ParadisSpreadsheetPartSource {
	const source = ownRecord(value, new Set(['partId', 'fingerprint']));
	const fingerprint = ownRecord(source.fingerprint, new Set(['algorithm', 'value', 'byteLength']));
	if (typeof source.partId !== 'string' || !source.partId.startsWith('/') || source.partId.includes('\\') || source.partId.includes('\0')
		|| fingerprint.algorithm !== 'sha256' || typeof fingerprint.value !== 'string' || !/^[0-9a-f]{64}$/i.test(fingerprint.value)
		|| !Number.isSafeInteger(fingerprint.byteLength) || (fingerprint.byteLength as number) < 0) {
		throw new ParadisOfficePackageError('unsafe');
	}
	return {
		partId: source.partId,
		fingerprint: { algorithm: 'sha256', value: fingerprint.value.toLowerCase(), byteLength: fingerprint.byteLength as number },
	};
}

function parseRules(document: ParadisOfficeXmlDocument, source: ParadisSpreadsheetPartSource, runtime: Runtime): readonly ParadisSpreadsheetConditionalFormatRule[] {
	const root = spreadsheetRoot(document, 'worksheet');
	const rules: ParadisSpreadsheetConditionalFormatRule[] = [];
	const priorities = new Set<number>();
	let ranges = 0;
	let documentOrder = 0;
	for (const child of elementChildren(root, runtime)) {
		if (isSpreadsheetElement(child, 'extLst')) {
			for (const rule of parseWorksheetX14Rules(child, source, documentOrder, rules, runtime)) {
				if (rules.length >= runtime.context.limits.rules) { throw new ParadisOfficePackageError('limitExceeded'); }
				if (priorities.has(rule.priority)) { throw new ParadisOfficePackageError('malformed'); }
				priorities.add(rule.priority);
				rules.push(rule);
				documentOrder++;
			}
			continue;
		}
		if (!isSpreadsheetElement(child, 'conditionalFormatting')) {
			continue;
		}
		exactAttributes(child, ['sqref', 'pivot']);
		const parsedRanges = parseSqref(requiredAttribute(child, 'sqref'), runtime);
		const pivot = booleanAttribute(child, 'pivot');
		ranges = safeAdd(ranges, parsedRanges.length);
		if (ranges > runtime.context.limits.ranges) {
			throw new ParadisOfficePackageError('limitExceeded');
		}
		let blockRules = 0;
		let seenExtensions = false;
		for (const ruleNode of elementChildren(child, runtime)) {
			if (isSpreadsheetElement(ruleNode, 'extLst')) {
				if (seenExtensions) { throw new ParadisOfficePackageError('malformed'); }
				seenExtensions = true;
				continue;
			}
			if (seenExtensions || !isSpreadsheetElement(ruleNode, 'cfRule')) {
				throw new ParadisOfficePackageError('malformed');
			}
			if (rules.length >= runtime.context.limits.rules) {
				throw new ParadisOfficePackageError('limitExceeded');
			}
			runtime.parsedRules = safeAdd(runtime.parsedRules, 1);
			if (runtime.parsedRules > runtime.context.limits.rules) { throw new ParadisOfficePackageError('limitExceeded'); }
			const rule = parseRule(ruleNode, parsedRanges, source, documentOrder++, pivot, runtime);
			if (priorities.has(rule.priority)) {
				throw new ParadisOfficePackageError('malformed');
			}
			priorities.add(rule.priority);
			rules.push(rule);
			blockRules++;
		}
		if (blockRules === 0) { throw new ParadisOfficePackageError('malformed'); }
	}
	rules.sort((left, right) => left.priority - right.priority || left.order - right.order);
	return rules;
}

function parseWorksheetX14Rules(
	extensionList: XmlElement,
	source: ParadisSpreadsheetPartSource,
	startOrder: number,
	existingRules: ParadisSpreadsheetConditionalFormatRule[],
	runtime: Runtime,
): readonly ParadisSpreadsheetConditionalFormatRule[] {
	const result: ParadisSpreadsheetConditionalFormatRule[] = [];
	for (const extension of elementChildren(extensionList, runtime)) {
		if (!isSpreadsheetElement(extension, 'ext')) { continue; }
		for (const container of elementChildren(extension, runtime)) {
			if (container.uri !== spreadsheetX14Namespace || container.local !== 'conditionalFormattings') { continue; }
			for (const formatting of elementChildren(container, runtime)) {
				if (formatting.uri !== spreadsheetX14Namespace || formatting.local !== 'conditionalFormatting') { throw new ParadisOfficePackageError('malformed'); }
				let ranges: readonly ParadisSemanticRange[] | undefined;
				const pending: { priority?: number; id?: string; type: string; stopIfTrue: boolean; formulas: readonly string[]; dataBar?: ParadisSpreadsheetX14DataBar; opaque: ParadisSpreadsheetX14OpaqueRule }[] = [];
				for (const child of elementChildren(formatting, runtime)) {
					if (child.uri === spreadsheetXmNamespace && child.local === 'sqref') {
						if (ranges) { throw new ParadisOfficePackageError('malformed'); }
						ranges = parseSqref(directText(child, runtime), runtime);
						continue;
					}
					if (child.uri !== spreadsheetX14Namespace || child.local !== 'cfRule') { throw new ParadisOfficePackageError('malformed'); }
					runtime.parsedRules = safeAdd(runtime.parsedRules, 1);
					if (runtime.parsedRules > runtime.context.limits.rules) { throw new ParadisOfficePackageError('limitExceeded'); }
					const allowedRuleAttributes = new Set(['type', 'priority', 'id', 'stopIfTrue', 'aboveAverage', 'percent', 'bottom', 'operator', 'text', 'timePeriod', 'rank', 'stdDev', 'equalAverage', 'activePresent']);
					let typedCandidate = child.attributes.every(candidate => candidate.uri === '' && allowedRuleAttributes.has(candidate.local));
					const type = attribute(child, 'type') ?? 'unknown';
					for (const node of child.children) {
						checkpoint(runtime);
						if (node.kind === 'text' && node.value.trim().length > 0) { typedCandidate = false; }
					}
					const children = elementChildrenBestEffort(child, runtime);
					const id = attribute(child, 'id');
					const formulas: string[] = [];
					let dataBarNode: XmlElement | undefined;
					for (const ruleChild of children) {
						if (ruleChild.uri === spreadsheetXmNamespace && ruleChild.local === 'f') {
							if (formulas.length >= runtime.context.limits.formulasPerRule) { throw new ParadisOfficePackageError('limitExceeded'); }
							try {
								const formula = directText(ruleChild, runtime);
								chargeFormula(formula, runtime);
								formulas.push(formula);
							} catch (error) {
								if (!(error instanceof ParadisOfficePackageError) || error.code !== 'malformed') { throw error; }
								typedCandidate = false;
							}
						} else if (ruleChild.uri === spreadsheetX14Namespace && ruleChild.local === 'dataBar' && !dataBarNode) {
							dataBarNode = ruleChild;
						} else {
							typedCandidate = false;
						}
					}
					let rawPriority: number | undefined;
					let stopIfTrue = false;
					try {
						rawPriority = integerAttribute(child, 'priority');
						if (rawPriority !== undefined && rawPriority < 1) { typedCandidate = false; rawPriority = undefined; }
						stopIfTrue = booleanAttribute(child, 'stopIfTrue') ?? false;
					} catch (error) {
						if (!(error instanceof ParadisOfficePackageError) || error.code !== 'malformed') { throw error; }
						typedCandidate = false;
					}
					let dataBar: ParadisSpreadsheetX14DataBar | undefined;
					if (typedCandidate && type === 'dataBar' && dataBarNode) {
						try {
							dataBar = parseX14DataBar(dataBarNode, id, runtime);
						} catch (error) {
							if (!(error instanceof ParadisOfficePackageError) || error.code !== 'malformed') { throw error; }
						}
					}
					pending.push({
						priority: rawPriority, id, type, stopIfTrue, formulas,
						opaque: parseX14OpaqueRule(child, type, id, runtime),
						...(dataBar ? { dataBar } : {}),
					});
				}
				if (!ranges || pending.length === 0) { throw new ParadisOfficePackageError('malformed'); }
				for (const entry of pending) {
					const linkedIndex = entry.id === undefined ? -1 : findLinkedRuleIndex(existingRules, entry.id, runtime);
					const combinedFormulaCount = linkedIndex >= 0 ? safeAdd(existingRules[linkedIndex].formulas.length, entry.formulas.length) : 0;
					if (linkedIndex >= 0 && entry.priority === undefined
						&& combinedFormulaCount <= runtime.context.limits.formulasPerRule
						&& !existingRules[linkedIndex].x14DataBar && !existingRules[linkedIndex].x14OpaqueRule
						&& sameRanges(existingRules[linkedIndex].ranges, ranges)) {
						const linked = existingRules[linkedIndex];
						existingRules[linkedIndex] = {
							...linked,
							formulas: [...linked.formulas, ...entry.formulas],
							x14OpaqueRule: entry.opaque,
							...(entry.dataBar ? { x14DataBar: entry.dataBar } : {}),
						};
						continue;
					}
					let priority = entry.priority;
					if (priority === undefined) {
						priority = 1;
						for (const rule of existingRules) {
							checkpoint(runtime);
							priority = Math.max(priority, safeAdd(rule.priority, 1));
						}
						for (const rule of result) {
							checkpoint(runtime);
							priority = Math.max(priority, safeAdd(rule.priority, 1));
						}
					}
					result.push({
						id: entry.id ?? `${source.partId}#x14-${startOrder + result.length}`,
						order: startOrder + result.length, type: entry.dataBar && entry.priority !== undefined ? 'dataBar' : 'unsupported', priority, stopIfTrue: entry.stopIfTrue,
						ranges, formulas: entry.formulas, source, hasExtensions: true,
						x14OpaqueRule: entry.opaque,
						...(entry.dataBar && entry.priority !== undefined ? { x14DataBar: entry.dataBar } : {}),
					});
				}
			}
		}
	}
	return result;
}

function findLinkedRuleIndex(rules: readonly ParadisSpreadsheetConditionalFormatRule[], id: string, runtime: Runtime): number {
	let result = -1;
	for (let index = 0; index < rules.length; index++) {
		checkpoint(runtime);
		if (rules[index].extensionId === id) {
			if (result >= 0) { return -2; }
			result = index;
		}
	}
	return result;
}

function sameRanges(left: readonly ParadisSemanticRange[], right: readonly ParadisSemanticRange[]): boolean {
	return left.length === right.length && left.every((range, index) => range.ref === right[index].ref);
}

function parseX14DataBar(node: XmlElement, id: string | undefined, runtime: Runtime): ParadisSpreadsheetX14DataBar {
	exactAttributes(node, ['minLength', 'maxLength', 'showValue', 'border', 'gradient', 'direction', 'negativeBarColorSameAsPositive', 'negativeBarBorderColorSameAsPositive', 'axisPosition']);
	const values: ParadisSpreadsheetConditionalValueObject[] = [];
	const result: Record<string, unknown> = compact({
		id, minLength: integerAttribute(node, 'minLength'), maxLength: integerAttribute(node, 'maxLength'),
		showValue: booleanAttribute(node, 'showValue'), border: booleanAttribute(node, 'border'), gradient: booleanAttribute(node, 'gradient'),
		direction: attribute(node, 'direction'), axisPosition: attribute(node, 'axisPosition'),
		negativeBarColorSameAsPositive: booleanAttribute(node, 'negativeBarColorSameAsPositive'),
		negativeBarBorderColorSameAsPositive: booleanAttribute(node, 'negativeBarBorderColorSameAsPositive'), values,
	});
	const colorNames = new Map<string, string>([
		['fillColor', 'fillColor'], ['borderColor', 'borderColor'], ['negativeFillColor', 'negativeFillColor'],
		['negativeBorderColor', 'negativeBorderColor'], ['axisColor', 'axisColor'],
	]);
	for (const child of elementChildren(node, runtime)) {
		if (child.uri !== spreadsheetX14Namespace) { throw new ParadisOfficePackageError('malformed'); }
		if (child.local === 'cfvo') {
			if (values.length >= 2) { throw new ParadisOfficePackageError('malformed'); }
			exactAttributes(child, ['type', 'gte']);
			const type = optionalEnumAttribute(child, 'type', ['min', 'max', 'num', 'percent', 'percentile', 'formula', 'autoMin', 'autoMax'] as const);
			if (!type) { throw new ParadisOfficePackageError('malformed'); }
			const children = elementChildren(child, runtime);
			let value: string | undefined;
			if (children.length > 0) {
				if (children.length !== 1 || children[0].uri !== spreadsheetXmNamespace || children[0].local !== 'f') { throw new ParadisOfficePackageError('malformed'); }
				value = directText(children[0], runtime);
			}
			if (type === 'formula') {
				if (value === undefined) { throw new ParadisOfficePackageError('malformed'); }
				chargeFormula(value, runtime);
			}
			values.push(compact({ type, value, greaterThanOrEqual: booleanAttribute(child, 'gte') }));
			continue;
		}
		const property = colorNames.get(child.local);
		if (!property || Object.prototype.hasOwnProperty.call(result, property)) { throw new ParadisOfficePackageError('malformed'); }
		result[property] = parseColor(child);
	}
	if (values.length !== 2) { throw new ParadisOfficePackageError('malformed'); }
	return result as unknown as ParadisSpreadsheetX14DataBar;
}

function parseX14OpaqueRule(node: XmlElement, type: string, id: string | undefined, runtime: Runtime): ParadisSpreadsheetX14OpaqueRule {
	const elements: ParadisSpreadsheetX14OpaqueRule['elements'][number][] = [];
	const events: ParadisSpreadsheetX14OpaqueRule['events'][number][] = [];
	interface Frame {
		readonly node: XmlElement;
		readonly parentIndex?: number;
		readonly depth: number;
		readonly ordinal: number;
		readonly path: string;
		entered: boolean;
		elementIndex: number;
		nextChildIndex: number;
	}
	const stack: Frame[] = [{ node, depth: 0, ordinal: 0, path: createOpaquePath(runtime, undefined, 0), entered: false, elementIndex: -1, nextChildIndex: 0 }];
	while (stack.length > 0) {
		checkpoint(runtime);
		const frame = stack[stack.length - 1];
		if (!frame.entered) {
			const attributes: Record<string, string> = {};
			const rawAttributeEntries: { key: string; value: string }[] = [];
			for (const attribute of frame.node.attributes) {
				checkpoint(runtime);
				rawAttributeEntries.push({ key: attribute.uri ? `{${attribute.uri}}${attribute.local}` : attribute.local, value: attribute.value });
			}
			const attributeEntries = boundedSort(rawAttributeEntries, (left, right) => left.key < right.key ? -1 : left.key > right.key ? 1 : 0, runtime);
			for (const attribute of attributeEntries) { attributes[attribute.key] = attribute.value; }
			frame.elementIndex = elements.length;
			frame.entered = true;
			elements.push(compact({ parentIndex: frame.parentIndex, depth: frame.depth, ordinal: frame.ordinal, path: frame.path, namespace: frame.node.uri, local: frame.node.local, attributes }));
			consumeOpaqueEvent(runtime);
			events.push(compact({ kind: 'start' as const, elementIndex: frame.elementIndex, parentIndex: frame.parentIndex, depth: frame.depth, ordinal: frame.ordinal, path: frame.path }));
			continue;
		}
		if (frame.nextChildIndex < frame.node.children.length) {
			consumeEvaluationOperations(runtime);
			const ordinal = frame.nextChildIndex++;
			const child = frame.node.children[ordinal];
			const path = createOpaquePath(runtime, frame.path, ordinal);
			if (child.kind === 'text') {
				consumeOpaqueEvent(runtime, child.value);
				events.push({ kind: 'text', parentIndex: frame.elementIndex, depth: frame.depth + 1, ordinal, path, text: child.value });
			} else {
				stack.push({ node: child, parentIndex: frame.elementIndex, depth: frame.depth + 1, ordinal, path, entered: false, elementIndex: -1, nextChildIndex: 0 });
			}
			continue;
		}
		consumeOpaqueEvent(runtime);
		events.push(compact({ kind: 'end' as const, elementIndex: frame.elementIndex, parentIndex: frame.parentIndex, depth: frame.depth, ordinal: frame.ordinal, path: frame.path }));
		stack.pop();
	}
	return { type, ...(id ? { id } : {}), childType: node.local, attributes: elements[0].attributes, elements, events };
}

function parseRule(
	node: XmlElement,
	ranges: readonly ParadisSemanticRange[],
	source: ParadisSpreadsheetPartSource,
	order: number,
	pivot: boolean | undefined,
	runtime: Runtime,
): ParadisSpreadsheetConditionalFormatRule {
	const allowedAttributes = [
		'type', 'dxfId', 'priority', 'stopIfTrue', 'aboveAverage', 'percent', 'bottom', 'operator', 'text',
		'timePeriod', 'rank', 'stdDev', 'equalAverage',
	];
	exactAttributes(node, allowedAttributes);
	const rawType = requiredAttribute(node, 'type');
	const type = parseRuleType(rawType);
	validateRuleAttributes(node, type);
	const priority = requiredPositiveIntegerAttribute(node, 'priority');
	const stopIfTrue = booleanAttribute(node, 'stopIfTrue') ?? false;
	const differentialStyleRef = integerAttribute(node, 'dxfId');
	const formulas: string[] = [];
	let visualRule: ParadisSpreadsheetConditionalVisualRule | undefined;
	let hasExtensions = false;
	let extensionId: string | undefined;
	for (const child of elementChildren(node, runtime)) {
		checkpoint(runtime);
		if (isSpreadsheetElement(child, 'formula')) {
			if (formulas.length >= runtime.context.limits.formulasPerRule) {
				throw new ParadisOfficePackageError('limitExceeded');
			}
			exactAttributes(child, []);
			const formula = directText(child, runtime);
			chargeFormula(formula, runtime);
			formulas.push(formula);
			continue;
		}
		if (isSpreadsheetElement(child, 'extLst') && !hasExtensions) {
			hasExtensions = true;
			extensionId = parseBaseRuleExtensionId(child, runtime);
			continue;
		}
		if (type === 'colorScale' && isSpreadsheetElement(child, 'colorScale') && !visualRule) {
			visualRule = parseColorScale(child, runtime);
			continue;
		}
		if (type === 'dataBar' && isSpreadsheetElement(child, 'dataBar') && !visualRule) {
			visualRule = parseDataBar(child, runtime);
			continue;
		}
		if (type === 'iconSet' && isSpreadsheetElement(child, 'iconSet') && !visualRule) {
			visualRule = parseIconSet(child, runtime);
			continue;
		}
		throw new ParadisOfficePackageError('malformed');
	}
	const operator = type === 'cellIs'
		? optionalEnumAttribute(node, 'operator', ['between', 'notBetween', 'equal', 'notEqual', 'greaterThan', 'lessThan', 'greaterThanOrEqual', 'lessThanOrEqual'] as const)
		: undefined;
	const rank = integerAttribute(node, 'rank');
	const percent = booleanAttribute(node, 'percent');
	const bottom = booleanAttribute(node, 'bottom');
	const aboveAverage = booleanAttribute(node, 'aboveAverage');
	const equalAverage = booleanAttribute(node, 'equalAverage');
	const standardDeviation = integerAttribute(node, 'stdDev');
	const text = attribute(node, 'text');
	const timePeriod = optionalEnumAttribute(node, 'timePeriod', ['today', 'yesterday', 'tomorrow', 'last7Days', 'lastWeek', 'thisWeek', 'nextWeek', 'lastMonth', 'thisMonth', 'nextMonth'] as const);
	validateRuleShape(type, operator, rank, percent, equalAverage, standardDeviation, formulas, visualRule, text, timePeriod);
	return compact({
		id: `${source.partId}#cf-${order}`, order, type, priority, stopIfTrue, ranges, formulas, source,
		differentialStyleRef, pivot, hasExtensions: hasExtensions || undefined, extensionId, operator, rank, percent, bottom, aboveAverage, equalAverage,
		standardDeviation, text, timePeriod, visualRule,
	});
}

function parseBaseRuleExtensionId(extensionList: XmlElement, runtime: Runtime): string | undefined {
	let result: string | undefined;
	for (const extension of elementChildren(extensionList, runtime)) {
		for (const child of elementChildren(extension, runtime)) {
			if (child.uri === spreadsheetX14Namespace && child.local === 'id') {
				if (result !== undefined) { throw new ParadisOfficePackageError('malformed'); }
				result = directText(child, runtime);
			}
		}
	}
	return result;
}

function validateRuleAttributes(node: XmlElement, type: ParadisSpreadsheetConditionalFormatRuleType): void {
	const allowed = ['type', 'dxfId', 'priority', 'stopIfTrue'];
	switch (type) {
		case 'cellIs': allowed.push('operator'); break;
		case 'top10': allowed.push('rank', 'percent', 'bottom'); break;
		case 'aboveAverage': allowed.push('aboveAverage', 'equalAverage', 'stdDev'); break;
		case 'containsText': case 'notContainsText': case 'beginsWith': case 'endsWith': allowed.push('text', 'operator'); break;
		case 'timePeriod': allowed.push('timePeriod'); break;
	}
	exactAttributes(node, allowed);
	const textOperator = attribute(node, 'operator');
	if (type === 'containsText' && textOperator !== undefined && textOperator !== 'containsText'
		|| type === 'notContainsText' && textOperator !== undefined && textOperator !== 'notContains'
		|| type === 'beginsWith' && textOperator !== undefined && textOperator !== 'beginsWith'
		|| type === 'endsWith' && textOperator !== undefined && textOperator !== 'endsWith') {
		throw new ParadisOfficePackageError('malformed');
	}
}

function parseRuleType(value: string, allowUnsupported = false): ParadisSpreadsheetConditionalFormatRuleType {
	const supported: readonly ParadisSpreadsheetConditionalFormatRuleType[] = [
		'cellIs', 'expression', 'top10', 'aboveAverage', 'duplicateValues', 'uniqueValues', 'containsText',
		'notContainsText', 'beginsWith', 'endsWith', 'containsBlanks', 'notContainsBlanks', 'containsErrors',
		'notContainsErrors', 'timePeriod', 'colorScale', 'dataBar', 'iconSet',
	];
	if (allowUnsupported && value === 'unsupported') { return 'unsupported'; }
	if (!supported.includes(value as ParadisSpreadsheetConditionalFormatRuleType)) {
		throw new ParadisOfficePackageError('malformed');
	}
	return value as ParadisSpreadsheetConditionalFormatRuleType;
}

function validateRuleShape(
	type: ParadisSpreadsheetConditionalFormatRuleType,
	operator: ParadisSpreadsheetConditionalOperator | undefined,
	rank: number | undefined,
	percent: boolean | undefined,
	equalAverage: boolean | undefined,
	standardDeviation: number | undefined,
	formulas: readonly string[],
	visualRule: ParadisSpreadsheetConditionalVisualRule | undefined,
	text: string | undefined,
	timePeriod: ParadisSpreadsheetConditionalTimePeriod | undefined,
): void {
	if (type === 'cellIs') {
		if (!operator || formulas.length !== (operator === 'between' || operator === 'notBetween' ? 2 : 1)) {
			throw new ParadisOfficePackageError('malformed');
		}
	} else if (type === 'expression' && formulas.length !== 1) {
		throw new ParadisOfficePackageError('malformed');
	} else if (type === 'top10') {
		if (rank === undefined || formulas.length !== 0 || percent && rank > 100 || !percent && (rank < 1 || rank > 1000)) {
			throw new ParadisOfficePackageError('malformed');
		}
	} else if (type === 'aboveAverage' && equalAverage && standardDeviation !== undefined) {
		throw new ParadisOfficePackageError('malformed');
	} else if (['containsText', 'notContainsText', 'beginsWith', 'endsWith'].includes(type) && text === undefined) {
		throw new ParadisOfficePackageError('malformed');
	} else if (type === 'timePeriod' && !timePeriod) {
		throw new ParadisOfficePackageError('malformed');
	} else if (['colorScale', 'dataBar', 'iconSet'].includes(type) && !visualRule) {
		throw new ParadisOfficePackageError('malformed');
	}
}

function parseColorScale(node: XmlElement, runtime: Runtime): ParadisSpreadsheetConditionalVisualRule {
	exactAttributes(node, []);
	const values: ParadisSpreadsheetConditionalValueObject[] = [];
	const colors: ParadisSpreadsheetColor[] = [];
	let seenColor = false;
	for (const child of elementChildren(node, runtime)) {
		if (isSpreadsheetElement(child, 'cfvo') && !seenColor) {
			values.push(parseConditionalValue(child, runtime));
		} else if (isSpreadsheetElement(child, 'color')) {
			seenColor = true;
			colors.push(parseColor(child));
		} else {
			throw new ParadisOfficePackageError('malformed');
		}
	}
	if ((values.length !== 2 && values.length !== 3) || colors.length !== values.length) {
		throw new ParadisOfficePackageError('malformed');
	}
	return { kind: 'colorScale', values, colors };
}

function parseDataBar(node: XmlElement, runtime: Runtime): ParadisSpreadsheetConditionalVisualRule {
	exactAttributes(node, ['minLength', 'maxLength', 'showValue', 'gradient']);
	const values: ParadisSpreadsheetConditionalValueObject[] = [];
	let color: ParadisSpreadsheetColor | undefined;
	for (const child of elementChildren(node, runtime)) {
		if (isSpreadsheetElement(child, 'cfvo') && !color) {
			values.push(parseConditionalValue(child, runtime));
		} else if (isSpreadsheetElement(child, 'color') && !color) {
			color = parseColor(child);
		} else {
			throw new ParadisOfficePackageError('malformed');
		}
	}
	if (values.length !== 2 || !color) {
		throw new ParadisOfficePackageError('malformed');
	}
	const minLength = integerAttribute(node, 'minLength');
	const maxLength = integerAttribute(node, 'maxLength');
	if ((minLength !== undefined && minLength > 100) || (maxLength !== undefined && maxLength > 100)) {
		throw new ParadisOfficePackageError('malformed');
	}
	if ((minLength ?? 10) > (maxLength ?? 90)) {
		throw new ParadisOfficePackageError('malformed');
	}
	return compact({
		kind: 'dataBar' as const, values, color,
		showValue: booleanAttribute(node, 'showValue') ?? true,
		gradient: booleanAttribute(node, 'gradient') ?? true,
		minLength, maxLength,
	});
}

function parseIconSet(node: XmlElement, runtime: Runtime): ParadisSpreadsheetConditionalVisualRule {
	exactAttributes(node, ['iconSet', 'showValue', 'percent', 'reverse']);
	const values = elementChildren(node, runtime).map(child => {
		if (!isSpreadsheetElement(child, 'cfvo')) {
			throw new ParadisOfficePackageError('malformed');
		}
		return parseConditionalValue(child, runtime);
	});
	if (values.length < 3 || values.length > 5) {
		throw new ParadisOfficePackageError('malformed');
	}
	return {
		kind: 'iconSet', values,
		iconSet: attribute(node, 'iconSet') ?? '3TrafficLights1',
		showValue: booleanAttribute(node, 'showValue') ?? true,
		percent: booleanAttribute(node, 'percent') ?? true,
		reverse: booleanAttribute(node, 'reverse') ?? false,
	};
}

function parseConditionalValue(node: XmlElement, runtime: Runtime): ParadisSpreadsheetConditionalValueObject {
	exactAttributes(node, ['type', 'val', 'gte']);
	assertEmptyElement(node);
	const type = optionalEnumAttribute(node, 'type', ['min', 'max', 'num', 'percent', 'percentile', 'formula', 'autoMin', 'autoMax'] as const);
	if (!type) {
		throw new ParadisOfficePackageError('malformed');
	}
	const value = attribute(node, 'val');
	if (!['min', 'max', 'autoMin', 'autoMax'].includes(type) && value === undefined) {
		throw new ParadisOfficePackageError('malformed');
	}
	if (type === 'formula') {
		chargeFormula(value!, runtime);
	}
	return compact({ type, value, greaterThanOrEqual: booleanAttribute(node, 'gte') });
}

function parseDifferentialStyles(document: ParadisOfficeXmlDocument, source: ParadisSpreadsheetPartSource, runtime: Runtime): readonly ParadisSpreadsheetDifferentialStyle[] {
	const root = spreadsheetRoot(document, 'styleSheet');
	exactRootAttributes(root);
	let dxfs: XmlElement | undefined;
	for (const child of elementChildren(root, runtime)) {
		if (isSpreadsheetElement(child, 'dxfs')) {
			if (dxfs) {
				throw new ParadisOfficePackageError('malformed');
			}
			dxfs = child;
		}
	}
	if (!dxfs) {
		return [];
	}
	exactAttributes(dxfs, ['count']);
	const result: ParadisSpreadsheetDifferentialStyle[] = [];
	for (const child of elementChildren(dxfs, runtime)) {
		if (!isSpreadsheetElement(child, 'dxf')) {
			throw new ParadisOfficePackageError('malformed');
		}
		if (result.length >= runtime.context.limits.differentialStyles) {
			throw new ParadisOfficePackageError('limitExceeded');
		}
		result.push(parseDifferentialStyle(child, result.length, source, runtime));
	}
	const declared = integerAttribute(dxfs, 'count');
	if (declared !== undefined && declared !== result.length) {
		throw new ParadisOfficePackageError('malformed');
	}
	return result;
}

function parseDifferentialStyle(node: XmlElement, index: number, source: ParadisSpreadsheetPartSource, runtime: Runtime): ParadisSpreadsheetDifferentialStyle {
	exactAttributes(node, []);
	let font: ParadisSpreadsheetDifferentialFont | undefined;
	let fill: ParadisSpreadsheetDifferentialFill | undefined;
	let border: ParadisSpreadsheetConditionalBorder | undefined;
	let alignment: ParadisSpreadsheetDifferentialAlignment | undefined;
	let protection: ParadisSpreadsheetDifferentialProtection | undefined;
	let hasExtensions = false;
	let numberFormat: ParadisSpreadsheetDifferentialStyle['numberFormat'];
	for (const child of elementChildren(node, runtime)) {
		if (isSpreadsheetElement(child, 'font') && !font) {
			font = parseDifferentialFont(child, runtime);
		} else if (isSpreadsheetElement(child, 'fill') && !fill) {
			fill = parseDifferentialFill(child, runtime);
		} else if (isSpreadsheetElement(child, 'border') && !border) {
			border = parseConditionalBorder(child, runtime);
		} else if (isSpreadsheetElement(child, 'alignment') && !alignment) {
			alignment = parseDifferentialAlignment(child);
		} else if (isSpreadsheetElement(child, 'protection') && !protection) {
			protection = parseDifferentialProtection(child);
		} else if (isSpreadsheetElement(child, 'extLst') && !hasExtensions) {
			hasExtensions = true;
		} else if (isSpreadsheetElement(child, 'numFmt') && !numberFormat) {
			exactAttributes(child, ['numFmtId', 'formatCode']);
			numberFormat = { id: requiredIntegerAttribute(child, 'numFmtId'), code: requiredAttribute(child, 'formatCode') };
		} else {
			throw new ParadisOfficePackageError('malformed');
		}
	}
	return compact({ index, source, numberFormat, font, fill, border, alignment, protection, hasExtensions: hasExtensions || undefined });
}

function parseDifferentialFont(node: XmlElement, runtime: Runtime): ParadisSpreadsheetDifferentialFont {
	exactAttributes(node, []);
	const result: Record<string, unknown> = {};
	const seen = new Set<string>();
	for (const child of elementChildren(node, runtime)) {
		if (!isSpreadsheetElement(child) || seen.has(child.local)) {
			throw new ParadisOfficePackageError('malformed');
		}
		seen.add(child.local);
		if (child.local === 'color') {
			result.color = parseColor(child);
			continue;
		}
		exactAttributes(child, ['val']);
		assertEmptyElement(child);
		switch (child.local) {
			case 'b': result.bold = booleanAttribute(child, 'val') ?? true; break;
			case 'i': result.italic = booleanAttribute(child, 'val') ?? true; break;
			case 'strike': result.strike = booleanAttribute(child, 'val') ?? true; break;
			case 'u': result.underline = attribute(child, 'val') ?? 'single'; break;
			case 'name': result.fontName = attribute(child, 'val'); break;
			case 'sz': result.fontSize = attribute(child, 'val'); break;
			case 'outline': result.outline = booleanAttribute(child, 'val') ?? true; break;
			case 'shadow': result.shadow = booleanAttribute(child, 'val') ?? true; break;
			case 'vertAlign': result.verticalAlign = attribute(child, 'val'); break;
			case 'scheme': result.scheme = attribute(child, 'val'); break;
			case 'family': result.family = attribute(child, 'val'); break;
			case 'charset': result.charset = attribute(child, 'val'); break;
			case 'condense': result.condense = booleanAttribute(child, 'val') ?? true; break;
			case 'extend': result.extend = booleanAttribute(child, 'val') ?? true; break;
			default: throw new ParadisOfficePackageError('malformed');
		}
	}
	return result as ParadisSpreadsheetDifferentialFont;
}

function parseDifferentialFill(node: XmlElement, runtime: Runtime): ParadisSpreadsheetDifferentialFill {
	exactAttributes(node, []);
	const children = elementChildren(node, runtime);
	if (children.length !== 1) {
		throw new ParadisOfficePackageError('malformed');
	}
	const pattern = children[0];
	if (isSpreadsheetElement(pattern, 'gradientFill')) {
		exactAttributes(pattern, ['type', 'degree', 'left', 'right', 'top', 'bottom']);
		const stops: { position: string; color: ParadisSpreadsheetColor }[] = [];
		for (const stop of elementChildren(pattern, runtime)) {
			if (!isSpreadsheetElement(stop, 'stop') || stops.length >= 256) {
				throw new ParadisOfficePackageError(stops.length >= 256 ? 'limitExceeded' : 'malformed');
			}
			exactAttributes(stop, ['position']);
			const stopChildren = elementChildren(stop, runtime);
			if (stopChildren.length !== 1 || !isSpreadsheetElement(stopChildren[0], 'color')) {
				throw new ParadisOfficePackageError('malformed');
			}
			stops.push({ position: requiredAttribute(stop, 'position'), color: parseColor(stopChildren[0]) });
		}
		if (stops.length < 2) {
			throw new ParadisOfficePackageError('malformed');
		}
		return { gradient: compact({ type: attribute(pattern, 'type'), degree: attribute(pattern, 'degree'), left: attribute(pattern, 'left'), right: attribute(pattern, 'right'), top: attribute(pattern, 'top'), bottom: attribute(pattern, 'bottom'), stops }) };
	}
	if (!isSpreadsheetElement(pattern, 'patternFill')) {
		throw new ParadisOfficePackageError('malformed');
	}
	exactAttributes(pattern, ['patternType']);
	let foregroundColor: ParadisSpreadsheetColor | undefined;
	let backgroundColor: ParadisSpreadsheetColor | undefined;
	for (const child of elementChildren(pattern, runtime)) {
		if (isSpreadsheetElement(child, 'fgColor') && !foregroundColor) {
			foregroundColor = parseColor(child);
		} else if (isSpreadsheetElement(child, 'bgColor') && !backgroundColor) {
			backgroundColor = parseColor(child);
		} else {
			throw new ParadisOfficePackageError('malformed');
		}
	}
	return compact({ patternType: attribute(pattern, 'patternType'), foregroundColor, backgroundColor });
}

function parseDifferentialAlignment(node: XmlElement): ParadisSpreadsheetDifferentialAlignment {
	exactAttributes(node, ['horizontal', 'vertical', 'textRotation', 'wrapText', 'shrinkToFit', 'indent', 'relativeIndent', 'justifyLastLine', 'readingOrder']);
	assertEmptyElement(node);
	return compact({
		horizontal: attribute(node, 'horizontal'), vertical: attribute(node, 'vertical'),
		textRotation: integerAttribute(node, 'textRotation'), wrapText: booleanAttribute(node, 'wrapText'),
		shrinkToFit: booleanAttribute(node, 'shrinkToFit'), indent: integerAttribute(node, 'indent'),
		relativeIndent: signedIntegerAttribute(node, 'relativeIndent'), justifyLastLine: booleanAttribute(node, 'justifyLastLine'),
		readingOrder: integerAttribute(node, 'readingOrder'),
	});
}

function parseDifferentialProtection(node: XmlElement): ParadisSpreadsheetDifferentialProtection {
	exactAttributes(node, ['locked', 'hidden']);
	assertEmptyElement(node);
	return compact({ locked: booleanAttribute(node, 'locked'), hidden: booleanAttribute(node, 'hidden') });
}

function parseConditionalBorder(node: XmlElement, runtime: Runtime): ParadisSpreadsheetConditionalBorder {
	exactAttributes(node, ['diagonalUp', 'diagonalDown', 'outline']);
	const result: Record<string, unknown> = compact({
		diagonalUp: booleanAttribute(node, 'diagonalUp'),
		diagonalDown: booleanAttribute(node, 'diagonalDown'),
		outline: booleanAttribute(node, 'outline'),
	});
	const allowed = new Set(['start', 'end', 'left', 'right', 'top', 'bottom', 'diagonal', 'vertical', 'horizontal']);
	for (const child of elementChildren(node, runtime)) {
		if (!isSpreadsheetElement(child) || !allowed.has(child.local) || Object.prototype.hasOwnProperty.call(result, child.local)) {
			throw new ParadisOfficePackageError('malformed');
		}
		exactAttributes(child, ['style']);
		const children = elementChildren(child, runtime);
		if (children.length > 1 || (children[0] && !isSpreadsheetElement(children[0], 'color'))) {
			throw new ParadisOfficePackageError('malformed');
		}
		result[child.local] = compact({ style: attribute(child, 'style'), color: children[0] ? parseColor(children[0]) : undefined });
	}
	return result as ParadisSpreadsheetConditionalBorder;
}

function parseColor(node: XmlElement): ParadisSpreadsheetColor {
	exactAttributes(node, ['rgb', 'indexed', 'theme', 'tint', 'auto']);
	assertEmptyElement(node);
	const rgb = attribute(node, 'rgb');
	const indexed = integerAttribute(node, 'indexed');
	const theme = integerAttribute(node, 'theme');
	const auto = booleanAttribute(node, 'auto');
	const tint = attribute(node, 'tint');
	if (Number(rgb !== undefined) + Number(indexed !== undefined) + Number(theme !== undefined) + Number(auto !== undefined) !== 1) {
		throw new ParadisOfficePackageError('malformed');
	}
	if (rgb !== undefined) {
		if (!/^(?:[0-9A-Fa-f]{6}|[0-9A-Fa-f]{8})$/.test(rgb)) {
			throw new ParadisOfficePackageError('malformed');
		}
		return { kind: 'rgb', rgb, ...(tint === undefined ? {} : { tint }) };
	}
	if (indexed !== undefined) {
		return { kind: 'indexed', indexed, ...(tint === undefined ? {} : { tint }) };
	}
	if (theme !== undefined) {
		return { kind: 'theme', theme, ...(tint === undefined ? {} : { tint }) };
	}
	return { kind: 'auto', auto: auto!, ...(tint === undefined ? {} : { tint }) };
}

function ownModel(model: unknown, runtime: Runtime): ParadisSpreadsheetConditionalFormatting {
	const record = ownRecord(model, new Set(['worksheetSource', 'stylesSource', 'rules', 'differentialStyles']));
	const worksheetSource = ownPartSource(record.worksheetSource);
	const stylesSource = record.stylesSource === undefined ? undefined : ownPartSource(record.stylesSource);
	const ruleValues = ownArrayValues(record.rules, runtime.context.limits.rules, runtime);
	const differentialStyleValues = ownArrayValues(record.differentialStyles, runtime.context.limits.differentialStyles, runtime);
	const rules: ParadisSpreadsheetConditionalFormatRule[] = [];
	const rangeCache = new WeakMap<object, readonly ParadisSemanticRange[]>();
	for (const value of ruleValues) {
		checkpoint(runtime);
		rules.push(ownRule(value, runtime, rangeCache));
	}
	const differentialStyles: ParadisSpreadsheetDifferentialStyle[] = [];
	for (const value of differentialStyleValues) {
		checkpoint(runtime);
		differentialStyles.push(ownDifferentialStyle(value, runtime));
	}
	if (rules.some(rule => !samePartSource(rule.source, worksheetSource))
		|| differentialStyles.some(style => !stylesSource || !samePartSource(style.source, stylesSource))) {
		throw new ParadisOfficePackageError('unsafe');
	}
	return { worksheetSource, ...(stylesSource ? { stylesSource } : {}), rules, differentialStyles };
}

function ownRule(value: unknown, runtime: Runtime, rangeCache: WeakMap<object, readonly ParadisSemanticRange[]>): ParadisSpreadsheetConditionalFormatRule {
	const keys = new Set([
		'id', 'order', 'type', 'priority', 'stopIfTrue', 'ranges', 'formulas', 'source', 'differentialStyleRef',
		'pivot', 'hasExtensions', 'extensionId', 'operator', 'rank', 'percent', 'bottom', 'aboveAverage', 'equalAverage', 'standardDeviation', 'text',
		'timePeriod', 'visualRule', 'x14DataBar', 'x14OpaqueRule',
	]);
	const record = ownRecord(value, keys);
	if (typeof record.id !== 'string' || !Number.isSafeInteger(record.order) || (record.order as number) < 0
		|| !Number.isSafeInteger(record.priority) || (record.priority as number) < 1 || typeof record.stopIfTrue !== 'boolean') {
		throw new ParadisOfficePackageError('unsafe');
	}
	if (typeof record.type !== 'string') {
		throw new ParadisOfficePackageError('unsafe');
	}
	const type = parseRuleType(record.type, true);
	const ranges = ownRanges(record.ranges, runtime, rangeCache);
	const formulas = ownStringArray(record.formulas, runtime.context.limits.formulasPerRule, runtime);
	for (const formula of formulas) {
		chargeFormula(formula, runtime);
	}
	const differentialStyleRef = optionalNonnegativeInteger(record.differentialStyleRef);
	const operator = record.operator === undefined ? undefined : ownConditionalOperator(record.operator);
	const rank = optionalNonnegativeInteger(record.rank);
	const standardDeviation = optionalNonnegativeInteger(record.standardDeviation);
	for (const key of ['pivot', 'hasExtensions', 'percent', 'bottom', 'aboveAverage', 'equalAverage'] as const) {
		if (record[key] !== undefined && typeof record[key] !== 'boolean') {
			throw new ParadisOfficePackageError('unsafe');
		}
	}
	if (record.text !== undefined && typeof record.text !== 'string' || record.timePeriod !== undefined && typeof record.timePeriod !== 'string'
		|| record.extensionId !== undefined && typeof record.extensionId !== 'string') {
		throw new ParadisOfficePackageError('unsafe');
	}
	const visualRule = record.visualRule === undefined ? undefined : ownVisualRule(record.visualRule, runtime);
	const x14DataBar = record.x14DataBar === undefined ? undefined : ownX14DataBar(record.x14DataBar, runtime);
	const x14OpaqueRule = record.x14OpaqueRule === undefined ? undefined : ownX14OpaqueRule(record.x14OpaqueRule, runtime);
	return compact({
		id: record.id, order: record.order as number, type, priority: record.priority as number,
		stopIfTrue: record.stopIfTrue, ranges, formulas, source: ownPartSource(record.source), differentialStyleRef,
		pivot: record.pivot as boolean | undefined, hasExtensions: record.hasExtensions as boolean | undefined, extensionId: record.extensionId as string | undefined,
		operator, rank, percent: record.percent as boolean | undefined, bottom: record.bottom as boolean | undefined,
		aboveAverage: record.aboveAverage as boolean | undefined, equalAverage: record.equalAverage as boolean | undefined,
		standardDeviation, text: record.text as string | undefined,
		timePeriod: record.timePeriod as ParadisSpreadsheetConditionalTimePeriod | undefined, visualRule, x14DataBar, x14OpaqueRule,
	});
}

function ownX14DataBar(value: unknown, runtime: Runtime): ParadisSpreadsheetX14DataBar {
	const keys = ['id', 'minLength', 'maxLength', 'showValue', 'border', 'gradient', 'direction', 'axisPosition', 'negativeBarColorSameAsPositive', 'negativeBarBorderColorSameAsPositive', 'fillColor', 'borderColor', 'negativeFillColor', 'negativeBorderColor', 'axisColor', 'values'] as const;
	const record = ownRecord(value, new Set(keys));
	for (const key of ['id', 'direction', 'axisPosition'] as const) {
		if (record[key] !== undefined && typeof record[key] !== 'string') { throw new ParadisOfficePackageError('unsafe'); }
	}
	for (const key of ['minLength', 'maxLength'] as const) { optionalNonnegativeInteger(record[key]); }
	for (const key of ['showValue', 'border', 'gradient', 'negativeBarColorSameAsPositive', 'negativeBarBorderColorSameAsPositive'] as const) {
		if (record[key] !== undefined && typeof record[key] !== 'boolean') { throw new ParadisOfficePackageError('unsafe'); }
	}
	for (const key of ['fillColor', 'borderColor', 'negativeFillColor', 'negativeBorderColor', 'axisColor'] as const) {
		if (record[key] !== undefined) { record[key] = ownColor(record[key]); }
	}
	record.values = ownArrayValues(record.values, 5, runtime).map(entry => ownConditionalValue(entry, runtime));
	return compact(record) as unknown as ParadisSpreadsheetX14DataBar;
}

function ownX14OpaqueRule(value: unknown, runtime: Runtime): ParadisSpreadsheetX14OpaqueRule {
	const record = ownRecord(value, new Set(['type', 'id', 'childType', 'attributes', 'elements', 'events']));
	if (typeof record.type !== 'string' || record.id !== undefined && typeof record.id !== 'string' || record.childType !== undefined && typeof record.childType !== 'string') { throw new ParadisOfficePackageError('unsafe'); }
	const attributesRecord = ownRecord(record.attributes, new Set(Object.keys(record.attributes as object)));
	const attributes: Record<string, string> = {};
	for (const [key, entry] of Object.entries(attributesRecord)) {
		if (typeof entry !== 'string') { throw new ParadisOfficePackageError('unsafe'); }
		attributes[key] = entry;
	}
	const elements = ownArrayValues(record.elements, runtime.context.limits.xmlNodes, runtime).map((value, index) => {
		const element = ownRecord(value, new Set(['parentIndex', 'depth', 'ordinal', 'path', 'namespace', 'local', 'attributes', 'text']));
		if (typeof element.namespace !== 'string' || typeof element.local !== 'string' || element.text !== undefined && typeof element.text !== 'string'
			|| !Number.isSafeInteger(element.depth) || (element.depth as number) < 0
			|| !Number.isSafeInteger(element.ordinal) || (element.ordinal as number) < 0 || typeof element.path !== 'string'
			|| element.parentIndex !== undefined && (!Number.isSafeInteger(element.parentIndex) || (element.parentIndex as number) < 0 || (element.parentIndex as number) >= index)) { throw new ParadisOfficePackageError('unsafe'); }
		const rawAttributes = element.attributes as Record<string, unknown>;
		const ownedAttributes = ownRecord(rawAttributes, new Set(Object.keys(rawAttributes)));
		for (const entry of Object.values(ownedAttributes)) { if (typeof entry !== 'string') { throw new ParadisOfficePackageError('unsafe'); } }
		return compact({ parentIndex: element.parentIndex as number | undefined, depth: element.depth as number, ordinal: element.ordinal as number, path: element.path, namespace: element.namespace, local: element.local, attributes: ownedAttributes as Readonly<Record<string, string>>, ...(element.text === undefined ? {} : { text: element.text }) });
	});
	const events = ownArrayValues(record.events, runtime.context.limits.opaqueEvents, runtime).map(value => {
		const event = ownRecord(value, new Set(['kind', 'elementIndex', 'parentIndex', 'depth', 'ordinal', 'path', 'text']));
		if (event.kind !== 'start' && event.kind !== 'end' && event.kind !== 'text' || !Number.isSafeInteger(event.depth) || (event.depth as number) < 0
			|| !Number.isSafeInteger(event.ordinal) || (event.ordinal as number) < 0 || typeof event.path !== 'string') { throw new ParadisOfficePackageError('unsafe'); }
		if (event.kind === 'text') {
			if (!Number.isSafeInteger(event.parentIndex) || (event.parentIndex as number) < 0 || typeof event.text !== 'string') { throw new ParadisOfficePackageError('unsafe'); }
			return { kind: 'text' as const, parentIndex: event.parentIndex as number, depth: event.depth as number, ordinal: event.ordinal as number, path: event.path, text: event.text };
		}
		if (!Number.isSafeInteger(event.elementIndex) || (event.elementIndex as number) < 0 || event.parentIndex !== undefined && (!Number.isSafeInteger(event.parentIndex) || (event.parentIndex as number) < 0)) { throw new ParadisOfficePackageError('unsafe'); }
		return compact({ kind: event.kind as 'start' | 'end', elementIndex: event.elementIndex as number, parentIndex: event.parentIndex as number | undefined, depth: event.depth as number, ordinal: event.ordinal as number, path: event.path });
	});
	return { type: record.type, ...(record.id ? { id: record.id } : {}), ...(record.childType ? { childType: record.childType } : {}), attributes, elements, events };
}

function ownRanges(value: unknown, runtime: Runtime, cache: WeakMap<object, readonly ParadisSemanticRange[]>): readonly ParadisSemanticRange[] {
	if (!value || typeof value !== 'object') { throw new ParadisOfficePackageError('unsafe'); }
	const cached = cache.get(value);
	if (cached) { return cached; }
	const values = ownArrayValues(value, runtime.context.limits.ranges, runtime);
	runtime.ownedRanges = safeAdd(runtime.ownedRanges, values.length);
	if (runtime.ownedRanges > runtime.context.limits.ranges) {
		throw new ParadisOfficePackageError('limitExceeded');
	}
	const result: ParadisSemanticRange[] = [];
	for (const value of values) {
		const record = ownRecord(value, new Set(['ref', 'minRow', 'minColumn', 'maxRow', 'maxColumn']));
		if (typeof record.ref !== 'string') {
			throw new ParadisOfficePackageError('unsafe');
		}
		const parsed = parseRange(record.ref);
		if (parsed.minRow !== record.minRow || parsed.minColumn !== record.minColumn || parsed.maxRow !== record.maxRow || parsed.maxColumn !== record.maxColumn) {
			throw new ParadisOfficePackageError('unsafe');
		}
		result.push(parsed);
	}
	cache.set(value, result);
	return result;
}

function ownConditionalOperator(value: unknown): ParadisSpreadsheetConditionalOperator {
	if (typeof value !== 'string' || !['between', 'notBetween', 'equal', 'notEqual', 'greaterThan', 'lessThan', 'greaterThanOrEqual', 'lessThanOrEqual'].includes(value)) {
		throw new ParadisOfficePackageError('unsafe');
	}
	return value as ParadisSpreadsheetConditionalOperator;
}

function ownVisualRule(value: unknown, runtime: Runtime): ParadisSpreadsheetConditionalVisualRule {
	const record = ownRecord(value, new Set(['kind', 'values', 'colors', 'color', 'showValue', 'gradient', 'minLength', 'maxLength', 'iconSet', 'reverse', 'percent']));
	const values = ownArrayValues(record.values, 5, runtime).map(entry => ownConditionalValue(entry, runtime));
	if (record.kind === 'colorScale') {
		const colors = ownArrayValues(record.colors, 3, runtime);
		if (colors.length !== values.length) {
			throw new ParadisOfficePackageError('unsafe');
		}
		return { kind: 'colorScale', values, colors: colors.map(entry => ownColor(entry)) };
	}
	if (record.kind === 'dataBar') {
		if (typeof record.showValue !== 'boolean' || typeof record.gradient !== 'boolean') {
			throw new ParadisOfficePackageError('unsafe');
		}
		return compact({ kind: 'dataBar' as const, values, color: ownColor(record.color), showValue: record.showValue, gradient: record.gradient, minLength: optionalNonnegativeInteger(record.minLength), maxLength: optionalNonnegativeInteger(record.maxLength) });
	}
	if (record.kind === 'iconSet') {
		if (typeof record.iconSet !== 'string' || typeof record.showValue !== 'boolean' || typeof record.reverse !== 'boolean' || typeof record.percent !== 'boolean') {
			throw new ParadisOfficePackageError('unsafe');
		}
		return { kind: 'iconSet', values, iconSet: record.iconSet, showValue: record.showValue, reverse: record.reverse, percent: record.percent };
	}
	throw new ParadisOfficePackageError('unsafe');
}

function ownConditionalValue(value: unknown, runtime: Runtime): ParadisSpreadsheetConditionalValueObject {
	const record = ownRecord(value, new Set(['type', 'value', 'greaterThanOrEqual']));
	if (typeof record.type !== 'string' || !['min', 'max', 'num', 'percent', 'percentile', 'formula', 'autoMin', 'autoMax'].includes(record.type)
		|| record.value !== undefined && typeof record.value !== 'string'
		|| record.greaterThanOrEqual !== undefined && typeof record.greaterThanOrEqual !== 'boolean') {
		throw new ParadisOfficePackageError('unsafe');
	}
	if (record.type === 'formula') {
		chargeFormula(record.value as string, runtime);
	}
	return compact({ type: record.type as ParadisSpreadsheetConditionalValueObject['type'], value: record.value as string | undefined, greaterThanOrEqual: record.greaterThanOrEqual as boolean | undefined });
}

function ownDifferentialStyle(value: unknown, runtime: Runtime): ParadisSpreadsheetDifferentialStyle {
	const record = ownRecord(value, new Set(['index', 'source', 'numberFormat', 'font', 'fill', 'border', 'alignment', 'protection', 'hasExtensions']));
	if (!Number.isSafeInteger(record.index) || (record.index as number) < 0) {
		throw new ParadisOfficePackageError('unsafe');
	}
	if (record.hasExtensions !== undefined && typeof record.hasExtensions !== 'boolean') { throw new ParadisOfficePackageError('unsafe'); }
	return compact({
		index: record.index as number,
		source: ownPartSource(record.source),
		numberFormat: record.numberFormat === undefined ? undefined : ownNumberFormat(record.numberFormat),
		font: record.font === undefined ? undefined : ownFont(record.font),
		fill: record.fill === undefined ? undefined : ownFill(record.fill, runtime),
		border: record.border === undefined ? undefined : ownBorder(record.border),
		alignment: record.alignment === undefined ? undefined : ownAlignment(record.alignment),
		protection: record.protection === undefined ? undefined : ownProtection(record.protection),
		hasExtensions: record.hasExtensions as boolean | undefined,
	});
}

function ownNumberFormat(value: unknown) {
	const record = ownRecord(value, new Set(['id', 'code']));
	if (!Number.isSafeInteger(record.id) || (record.id as number) < 0 || typeof record.code !== 'string') {
		throw new ParadisOfficePackageError('unsafe');
	}
	return { id: record.id as number, code: record.code };
}

function ownFont(value: unknown): ParadisSpreadsheetDifferentialFont {
	const record = ownRecord(value, new Set(['bold', 'italic', 'strike', 'underline', 'fontName', 'fontSize', 'outline', 'shadow', 'verticalAlign', 'scheme', 'family', 'charset', 'condense', 'extend', 'color']));
	for (const key of ['bold', 'italic', 'strike', 'outline', 'shadow', 'condense', 'extend'] as const) {
		if (record[key] !== undefined && typeof record[key] !== 'boolean') {
			throw new ParadisOfficePackageError('unsafe');
		}
	}
	for (const key of ['underline', 'fontName', 'fontSize', 'verticalAlign', 'scheme', 'family', 'charset'] as const) {
		if (record[key] !== undefined && typeof record[key] !== 'string') {
			throw new ParadisOfficePackageError('unsafe');
		}
	}
	return compact({ ...record, color: record.color === undefined ? undefined : ownColor(record.color) }) as ParadisSpreadsheetDifferentialFont;
}

function ownFill(value: unknown, runtime: Runtime): ParadisSpreadsheetDifferentialFill {
	const record = ownRecord(value, new Set(['patternType', 'foregroundColor', 'backgroundColor', 'gradient']));
	if (record.patternType !== undefined && typeof record.patternType !== 'string') {
		throw new ParadisOfficePackageError('unsafe');
	}
	return compact({ patternType: record.patternType as string | undefined, foregroundColor: record.foregroundColor === undefined ? undefined : ownColor(record.foregroundColor), backgroundColor: record.backgroundColor === undefined ? undefined : ownColor(record.backgroundColor), gradient: record.gradient === undefined ? undefined : ownGradient(record.gradient, runtime) });
}

function ownGradient(value: unknown, runtime: Runtime): NonNullable<ParadisSpreadsheetDifferentialFill['gradient']> {
	const record = ownRecord(value, new Set(['type', 'degree', 'left', 'right', 'top', 'bottom', 'stops']));
	for (const key of ['type', 'degree', 'left', 'right', 'top', 'bottom'] as const) {
		if (record[key] !== undefined && typeof record[key] !== 'string') {
			throw new ParadisOfficePackageError('unsafe');
		}
	}
	const stopValues = ownArrayValues(record.stops, 256, runtime);
	if (stopValues.length < 2) {
		throw new ParadisOfficePackageError('unsafe');
	}
	const stops = stopValues.map(value => {
		const stop = ownRecord(value, new Set(['position', 'color']));
		if (typeof stop.position !== 'string') {
			throw new ParadisOfficePackageError('unsafe');
		}
		return { position: stop.position, color: ownColor(stop.color) };
	});
	return compact({ type: record.type as string | undefined, degree: record.degree as string | undefined, left: record.left as string | undefined, right: record.right as string | undefined, top: record.top as string | undefined, bottom: record.bottom as string | undefined, stops });
}

function ownAlignment(value: unknown): ParadisSpreadsheetDifferentialAlignment {
	const record = ownRecord(value, new Set(['horizontal', 'vertical', 'textRotation', 'wrapText', 'shrinkToFit', 'indent', 'relativeIndent', 'justifyLastLine', 'readingOrder']));
	for (const key of ['horizontal', 'vertical'] as const) {
		if (record[key] !== undefined && typeof record[key] !== 'string') { throw new ParadisOfficePackageError('unsafe'); }
	}
	for (const key of ['textRotation', 'indent', 'readingOrder'] as const) {
		optionalNonnegativeInteger(record[key]);
	}
	if (record.relativeIndent !== undefined && (!Number.isSafeInteger(record.relativeIndent) || (record.relativeIndent as number) < -15 || (record.relativeIndent as number) > 15)) {
		throw new ParadisOfficePackageError('unsafe');
	}
	for (const key of ['wrapText', 'shrinkToFit', 'justifyLastLine'] as const) {
		if (record[key] !== undefined && typeof record[key] !== 'boolean') { throw new ParadisOfficePackageError('unsafe'); }
	}
	return compact(record) as ParadisSpreadsheetDifferentialAlignment;
}

function ownProtection(value: unknown): ParadisSpreadsheetDifferentialProtection {
	const record = ownRecord(value, new Set(['locked', 'hidden']));
	if (record.locked !== undefined && typeof record.locked !== 'boolean' || record.hidden !== undefined && typeof record.hidden !== 'boolean') {
		throw new ParadisOfficePackageError('unsafe');
	}
	return compact(record) as ParadisSpreadsheetDifferentialProtection;
}

function ownBorder(value: unknown): ParadisSpreadsheetConditionalBorder {
	const keys = ['diagonalUp', 'diagonalDown', 'outline', 'start', 'end', 'left', 'right', 'top', 'bottom', 'diagonal', 'vertical', 'horizontal'] as const;
	const record = ownRecord(value, new Set(keys));
	const result: Record<string, unknown> = {};
	for (const key of keys) {
		const entry = record[key];
		if (entry === undefined) {
			continue;
		}
		if (key === 'diagonalUp' || key === 'diagonalDown' || key === 'outline') {
			if (typeof entry !== 'boolean') {
				throw new ParadisOfficePackageError('unsafe');
			}
			result[key] = entry;
		} else {
			const edge = ownRecord(entry, new Set(['style', 'color']));
			if (edge.style !== undefined && typeof edge.style !== 'string') {
				throw new ParadisOfficePackageError('unsafe');
			}
			result[key] = compact({ style: edge.style as string | undefined, color: edge.color === undefined ? undefined : ownColor(edge.color) });
		}
	}
	return result as ParadisSpreadsheetConditionalBorder;
}

function ownColor(value: unknown): ParadisSpreadsheetColor {
	const record = ownRecord(value, new Set(['kind', 'rgb', 'indexed', 'theme', 'tint', 'auto']));
	if (typeof record.kind !== 'string' || !['rgb', 'indexed', 'theme', 'auto'].includes(record.kind)) {
		throw new ParadisOfficePackageError('unsafe');
	}
	if (record.rgb !== undefined && typeof record.rgb !== 'string' || record.tint !== undefined && typeof record.tint !== 'string'
		|| record.indexed !== undefined && !Number.isSafeInteger(record.indexed) || record.theme !== undefined && !Number.isSafeInteger(record.theme)
		|| record.auto !== undefined && typeof record.auto !== 'boolean') {
		throw new ParadisOfficePackageError('unsafe');
	}
	return compact(record) as unknown as ParadisSpreadsheetColor;
}

function ownWorkbook(snapshot: unknown, runtime: Runtime): OwnedWorkbook {
	const record = ownRecord(snapshot, new Set(['date1904', 'sheets', 'styles']));
	if (typeof record.date1904 !== 'boolean') {
		throw new ParadisOfficePackageError('unsafe');
	}
	const sheetValues = ownArrayValues(record.sheets, runtime.context.limits.snapshotSheets, runtime);
	const sheets = new Map<string, OwnedSheet>();
	const stylesRecord = ownRecord(record.styles, new Set(['source']));
	const stylesSource = stylesRecord.source === undefined ? undefined : ownPartSource(stylesRecord.source);
	let totalCells = 0;
	for (const value of sheetValues) {
		checkpoint(runtime);
		const sheetRecord = ownRecord(value, new Set(['name', 'partId', 'source', 'cells']));
		const normalizedName = typeof sheetRecord.name === 'string' ? normalizeSheetName(sheetRecord.name) : '';
		const source = ownPartSource(sheetRecord.source);
		if (typeof sheetRecord.name !== 'string' || typeof sheetRecord.partId !== 'string' || sheetRecord.partId !== source.partId
			|| sheets.has(normalizedName) || !(sheetRecord.cells instanceof Map)) {
			throw new ParadisOfficePackageError('unsafe');
		}
		const cells = new Map<string, ParadisSemanticCell>();
		const initialSize = intrinsicMapSize(sheetRecord.cells);
		totalCells = safeAdd(totalCells, initialSize);
		if (totalCells > runtime.context.limits.snapshotCells) {
			throw new ParadisOfficePackageError('limitExceeded');
		}
		for (const entry of intrinsicMapEntries(sheetRecord.cells)) {
			checkpoint(runtime);
			if (!Array.isArray(entry) || typeof entry[0] !== 'string') {
				throw new ParadisOfficePackageError('unsafe');
			}
			const coordinate = parseCellReference(entry[0]);
			const address = formatCellAddress(coordinate.row, coordinate.column);
			if (address !== entry[0].replace(/\$/g, '').toUpperCase() || cells.has(address)) {
				throw new ParadisOfficePackageError('unsafe');
			}
			cells.set(address, ownCell(entry[1], runtime));
		}
		if (intrinsicMapSize(sheetRecord.cells) !== initialSize || cells.size !== initialSize) {
			throw new ParadisOfficePackageError('unsafe');
		}
		sheets.set(normalizedName, { name: sheetRecord.name, partId: sheetRecord.partId, source, cells });
	}
	return { date1904: record.date1904, sheets, ...(stylesSource ? { stylesSource } : {}) };
}

function samePartSource(left: ParadisSpreadsheetPartSource, right: ParadisSpreadsheetPartSource): boolean {
	return left.partId === right.partId && left.fingerprint.algorithm === right.fingerprint.algorithm
		&& left.fingerprint.value === right.fingerprint.value && left.fingerprint.byteLength === right.fingerprint.byteLength;
}

function intrinsicMapSize(value: Map<unknown, unknown>): number {
	return Object.getOwnPropertyDescriptor(Map.prototype, 'size')!.get!.call(value);
}

function intrinsicMapEntries(value: Map<unknown, unknown>): IterableIterator<[unknown, unknown]> {
	return Map.prototype.entries.call(value);
}

function ownCell(value: unknown, runtime: Runtime): ParadisSemanticCell {
	const record = ownRecord(value, new Set(['storedType', 'rawType', 'rawValue', 'text', 'formula', 'cachedResult']));
	if (typeof record.storedType !== 'string' || !['blank', 'number', 'string', 'boolean', 'error', 'date', 'formula'].includes(record.storedType)
		|| record.rawType !== undefined && typeof record.rawType !== 'string' || record.text !== undefined && typeof record.text !== 'string') {
		throw new ParadisOfficePackageError('unsafe');
	}
	const rawValue = record.rawValue === undefined ? undefined : ownRawValue(record.rawValue);
	const formula = record.formula === undefined ? undefined : ownFormula(record.formula, runtime);
	const cachedResult = record.cachedResult === undefined ? undefined : ownCachedResult(record.cachedResult);
	return compact({ storedType: record.storedType, rawType: record.rawType as string | undefined, rawValue, text: record.text as string | undefined, formula, cachedResult }) as ParadisSemanticCell;
}

function ownRawValue(value: unknown): ParadisSemanticCell['rawValue'] {
	const record = ownRecord(value, new Set(['present', 'text']));
	if (typeof record.present !== 'boolean' || record.present && typeof record.text !== 'string') {
		throw new ParadisOfficePackageError('unsafe');
	}
	return record.present ? { present: true, text: record.text as string } : { present: false };
}

function ownFormula(value: unknown, runtime: Runtime): NonNullable<ParadisSemanticCell['formula']> {
	const record = ownRecord(value, new Set(['text', 'kind', 'ref', 'sharedIndex']));
	if (typeof record.text !== 'string' || typeof record.kind !== 'string' || !['normal', 'shared', 'array'].includes(record.kind)
		|| record.ref !== undefined && typeof record.ref !== 'string' || record.sharedIndex !== undefined && !Number.isSafeInteger(record.sharedIndex)) {
		throw new ParadisOfficePackageError('unsafe');
	}
	chargeFormula(record.text, runtime);
	return compact({ text: record.text, kind: record.kind, ref: record.ref as string | undefined, sharedIndex: record.sharedIndex as number | undefined }) as NonNullable<ParadisSemanticCell['formula']>;
}

function ownCachedResult(value: unknown): ParadisSemanticCell['cachedResult'] {
	const record = ownRecord(value, new Set(['present', 'type', 'rawValue']));
	if (typeof record.present !== 'boolean') {
		throw new ParadisOfficePackageError('unsafe');
	}
	if (!record.present) {
		return { present: false };
	}
	if (typeof record.type !== 'string' || !['number', 'string', 'boolean', 'error', 'date'].includes(record.type) || typeof record.rawValue !== 'string') {
		throw new ParadisOfficePackageError('unsafe');
	}
	return { present: true, type: record.type as 'number' | 'string' | 'boolean' | 'error' | 'date', rawValue: record.rawValue };
}

function ownRequestedCells(addresses: readonly string[], sheet: OwnedSheet, runtime: Runtime): readonly OwnedCell[] {
	const result: OwnedCell[] = [];
	const seen = new Set<string>();
	for (const rawAddress of addresses) {
		checkpoint(runtime);
		const coordinate = parseCellReference(rawAddress);
		const address = formatCellAddress(coordinate.row, coordinate.column);
		if (seen.has(address)) {
			throw new ParadisOfficePackageError('unsafe');
		}
		seen.add(address);
		result.push({ address, coordinate, cell: sheet.cells.get(address) });
	}
	return result;
}

function evaluateRule(
	rule: ParadisSpreadsheetConditionalFormatRule,
	target: OwnedCell,
	anchor: CellCoordinate,
	currentSheet: OwnedSheet,
	workbook: OwnedWorkbook,
	model: ParadisSpreadsheetConditionalFormatting,
	todaySerial: number | undefined,
	cache: EvaluationCache,
	runtime: Runtime,
): { readonly applies: boolean; readonly overlay?: ParadisSpreadsheetConditionalRenderOverlay } | EvaluationIssue {
	try {
		if (rule.x14DataBar || rule.x14OpaqueRule) { throw new EvaluationIssue('unsupportedExtension'); }
		let applies = false;
		let overlay: ParadisSpreadsheetConditionalRenderOverlay | undefined;
		const supplementalFormulaApplies = evaluateSupplementalRuleFormulas(rule, target, anchor, currentSheet, workbook, cache, runtime);
		switch (rule.type) {
			case 'cellIs': {
				const targetValue = scalarCellValue(target.cell, target.address, workbook.date1904, currentSheet, runtime);
				const operands = rule.formulas.map(formula => scalarFormulaValue(evaluateFormula(formula, target.coordinate, anchor, currentSheet, workbook, runtime)));
				applies = evaluateCellOperator(rule.operator!, targetValue, operands);
				break;
			}
			case 'expression':
				applies = booleanFormulaValue(evaluateFormula(rule.formulas[0], target.coordinate, anchor, currentSheet, workbook, runtime));
				break;
			case 'top10':
				applies = evaluateTop10(rule, target, currentSheet, workbook.date1904, cache, runtime);
				break;
			case 'aboveAverage':
				applies = evaluateAboveAverage(rule, target, currentSheet, workbook.date1904, cache, runtime);
				break;
			case 'duplicateValues':
			case 'uniqueValues':
				applies = evaluateDuplicate(rule, target, currentSheet, workbook.date1904, cache, runtime);
				break;
			case 'containsText':
			case 'notContainsText':
			case 'beginsWith':
			case 'endsWith':
				applies = evaluateTextRule(rule, target, currentSheet, runtime);
				break;
			case 'containsBlanks':
			case 'notContainsBlanks':
			case 'containsErrors':
			case 'notContainsErrors':
				applies = evaluateBlankOrErrorRule(rule, target, currentSheet, runtime);
				break;
			case 'timePeriod':
				applies = evaluateTimePeriod(rule, target, todaySerial, workbook.date1904, currentSheet, runtime);
				break;
			case 'colorScale':
			case 'dataBar':
			case 'iconSet': {
				if (rule.formulas.length > 0 && !booleanFormulaValue(evaluateFormula(rule.formulas[0], target.coordinate, anchor, currentSheet, workbook, runtime))) {
					applies = false;
					break;
				}
				const visual = evaluateVisualRule(rule, target, anchor, currentSheet, workbook, cache, runtime);
				applies = visual !== undefined;
				overlay = visual;
				break;
			}
		}
		applies = applies && supplementalFormulaApplies;
		if (applies && rule.differentialStyleRef !== undefined) {
			const style = model.differentialStyles[rule.differentialStyleRef];
			if (!style || style.index !== rule.differentialStyleRef || !model.stylesSource) {
				throw new EvaluationIssue('differentialStyleMissing');
			}
			overlay = {
				kind: 'differentialStyle', differentialStyleRef: rule.differentialStyleRef,
				source: ownPartSource(style.source),
			};
		}
		return { applies, ...(overlay ? { overlay } : {}) };
	} catch (error) {
		if (error instanceof EvaluationIssue) {
			return error;
		}
		throw error;
	}
}

function evaluateSupplementalRuleFormulas(
	rule: ParadisSpreadsheetConditionalFormatRule,
	target: OwnedCell,
	anchor: CellCoordinate,
	currentSheet: OwnedSheet,
	workbook: OwnedWorkbook,
	cache: EvaluationCache,
	runtime: Runtime,
): boolean {
	if (rule.type === 'cellIs' || rule.type === 'expression' || rule.type === 'colorScale' || rule.type === 'dataBar' || rule.type === 'iconSet') {
		return true;
	}
	let applies = true;
	for (const formula of rule.formulas) {
		try {
			applies = booleanFormulaValue(evaluateFormula(formula, target.coordinate, anchor, currentSheet, workbook, runtime)) && applies;
		} catch (error) {
			if (!(error instanceof EvaluationIssue)
				|| error.reason !== 'unsupportedFunction' && error.reason !== 'unsupportedExpression'
				&& !(error.reason === 'volatileFunction' && rule.type === 'timePeriod')) {
				throw error;
			}
			if (!isCanonicalSupplementalFormula(rule, formula, cache, runtime)) {
				throw error;
			}
			validateFormulaDependencies(formula, target.coordinate, anchor, currentSheet, workbook, rule.type === 'timePeriod', runtime);
		}
	}
	return applies;
}

function isCanonicalSupplementalFormula(rule: ParadisSpreadsheetConditionalFormatRule, formula: string, cache: EvaluationCache, runtime: Runtime): boolean {
	const key = `${rule.id}\0${formula}`;
	const cached = cache.canonicalSupplementalFormulas.get(key);
	if (cached !== undefined) { return cached; }
	consumeEvaluationOperations(runtime);
	const normalized = removeFormulaWhitespace(formula.startsWith('=') ? formula.slice(1) : formula);
	const reference = String.raw`(?:(?:'(?:''|[^'])+'|[A-Za-z_][A-Za-z0-9_.]*)!)?\$?[A-Za-z]{1,3}\$?[1-9][0-9]{0,6}`;
	const literal = `"${(rule.text ?? '').replace(/"/g, '""')}"`.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
	let result = false;
	switch (rule.type) {
		case 'containsText': result = new RegExp(`^NOT\\(ISERROR\\(SEARCH\\(${literal},${reference}\\)\\)\\)$`, 'i').test(normalized); break;
		case 'notContainsText': result = new RegExp(`^ISERROR\\(SEARCH\\(${literal},${reference}\\)\\)$`, 'i').test(normalized); break;
		case 'beginsWith': result = new RegExp(`^LEFT\\(${reference},LEN\\(${literal}\\)\\)=${literal}$`, 'i').test(normalized); break;
		case 'endsWith': result = new RegExp(`^RIGHT\\(${reference},LEN\\(${literal}\\)\\)=${literal}$`, 'i').test(normalized); break;
		case 'containsBlanks': result = new RegExp(`^LEN\\(TRIM\\(${reference}\\)\\)=0$`, 'i').test(normalized); break;
		case 'notContainsBlanks': result = new RegExp(`^LEN\\(TRIM\\(${reference}\\)\\)>0$`, 'i').test(normalized); break;
		case 'containsErrors': result = new RegExp(`^ISERROR\\(${reference}\\)$`, 'i').test(normalized); break;
		case 'notContainsErrors': result = new RegExp(`^NOT\\(ISERROR\\(${reference}\\)\\)$`, 'i').test(normalized); break;
		case 'timePeriod': {
			const patterns: Partial<Record<ParadisSpreadsheetConditionalTimePeriod, string>> = {
				today: `^FLOOR\\(${reference},1\\)=TODAY\\(\\)$`,
				yesterday: `^FLOOR\\(${reference},1\\)=TODAY\\(\\)-1$`,
				tomorrow: `^FLOOR\\(${reference},1\\)=TODAY\\(\\)\\+1$`,
				last7Days: `^AND\\(TODAY\\(\\)-FLOOR\\(${reference},1\\)<=6,FLOOR\\(${reference},1\\)<=TODAY\\(\\)\\)$`,
				thisWeek: `^AND\\(TODAY\\(\\)-ROUNDDOWN\\(${reference},0\\)<=WEEKDAY\\(TODAY\\(\\)\\)-1,ROUNDDOWN\\(${reference},0\\)-TODAY\\(\\)<=7-WEEKDAY\\(TODAY\\(\\)\\)\\)$`,
				lastWeek: `^AND\\(TODAY\\(\\)-ROUNDDOWN\\(${reference},0\\)>=\\(WEEKDAY\\(TODAY\\(\\)\\)\\),TODAY\\(\\)-ROUNDDOWN\\(${reference},0\\)<\\(WEEKDAY\\(TODAY\\(\\)\\)\\+7\\)\\)$`,
				nextWeek: `^AND\\(ROUNDDOWN\\(${reference},0\\)-TODAY\\(\\)>\\(7-WEEKDAY\\(TODAY\\(\\)\\)\\),ROUNDDOWN\\(${reference},0\\)-TODAY\\(\\)<\\(15-WEEKDAY\\(TODAY\\(\\)\\)\\)\\)$`,
				lastMonth: `^AND\\(MONTH\\(${reference}\\)=MONTH\\(EDATE\\(TODAY\\(\\),0-1\\)\\),YEAR\\(${reference}\\)=YEAR\\(EDATE\\(TODAY\\(\\),0-1\\)\\)\\)$`,
				thisMonth: `^AND\\(MONTH\\(${reference}\\)=MONTH\\(TODAY\\(\\)\\),YEAR\\(${reference}\\)=YEAR\\(TODAY\\(\\)\\)\\)$`,
				nextMonth: `^AND\\(MONTH\\(${reference}\\)=MONTH\\(EDATE\\(TODAY\\(\\),0\\+1\\)\\),YEAR\\(${reference}\\)=YEAR\\(EDATE\\(TODAY\\(\\),0\\+1\\)\\)\\)$`,
			};
			const pattern = rule.timePeriod && patterns[rule.timePeriod];
			result = pattern !== undefined && new RegExp(pattern, 'i').test(normalized);
			break;
		}
		default: result = false;
	}
	cache.canonicalSupplementalFormulas.set(key, result);
	return result;
}

function removeFormulaWhitespace(value: string): string {
	let quoted = false;
	const result: string[] = [];
	for (let index = 0; index < value.length; index++) {
		const character = value[index];
		if (character === '"') {
			result.push(character);
			if (quoted && value[index + 1] === '"') {
				result.push(value[++index]);
			} else {
				quoted = !quoted;
			}
		} else if (quoted || !/\s/.test(character)) {
			result.push(character);
		}
	}
	return result.join('');
}

function validateFormulaDependencies(
	formula: string,
	target: CellCoordinate,
	anchor: CellCoordinate,
	currentSheet: OwnedSheet,
	workbook: OwnedWorkbook,
	allowToday: boolean,
	runtime: Runtime,
): void {
	if (containsExternalReference(formula)) { throw new EvaluationIssue('externalReference'); }
	const tokens = new FormulaTokenizer(formula.startsWith('=') ? formula.slice(1) : formula, runtime);
	while (true) {
		const token = tokens.next();
		if (token.kind === 'end') { return; }
		if (token.kind === 'identifier' && ['RAND', 'RANDBETWEEN', 'NOW', 'TODAY', 'OFFSET', 'INDIRECT'].includes(token.value)
			&& !(allowToday && token.value === 'TODAY')) {
			throw new EvaluationIssue('volatileFunction');
		}
		if (token.kind !== 'reference') { continue; }
		const sheet = token.sheet === undefined ? currentSheet : workbook.sheets.get(normalizeSheetName(token.sheet));
		if (!sheet) { throw new EvaluationIssue('invalidValue'); }
		const start = resolveFormulaReference(token.start, target, anchor);
		const end = token.end ? resolveFormulaReference(token.end, target, anchor) : start;
		if (sheet !== currentSheet || start.row !== target.row || start.column !== target.column || end.row !== target.row || end.column !== target.column) {
			throw new EvaluationIssue('unsupportedExpression');
		}
		const minRow = Math.min(start.row, end.row);
		const maxRow = Math.max(start.row, end.row);
		const minColumn = Math.min(start.column, end.column);
		const maxColumn = Math.max(start.column, end.column);
		const area = safeMultiply(maxRow - minRow + 1, maxColumn - minColumn + 1);
		if (area > runtime.context.limits.snapshotCells) { throw new ParadisOfficePackageError('limitExceeded'); }
		for (let row = minRow; row <= maxRow; row++) {
			for (let column = minColumn; column <= maxColumn; column++) {
				consumeEvaluationOperations(runtime);
				const address = formatCellAddress(row, column);
				scalarCellValue(sheet.cells.get(address), address, workbook.date1904, sheet, runtime);
			}
		}
	}
}

function evaluateCellOperator(operator: ParadisSpreadsheetConditionalOperator, target: Scalar, operands: readonly Scalar[]): boolean {
	let lower = operands[0];
	let upper = operands[1];
	if ((operator === 'between' || operator === 'notBetween') && compareScalars(lower, upper) > 0) {
		[lower, upper] = [upper, lower];
	}
	const first = compareScalars(target, lower);
	switch (operator) {
		case 'between': return first >= 0 && compareScalars(target, upper) <= 0;
		case 'notBetween': return first < 0 || compareScalars(target, upper) > 0;
		case 'equal': return first === 0;
		case 'notEqual': return first !== 0;
		case 'greaterThan': return first > 0;
		case 'lessThan': return first < 0;
		case 'greaterThanOrEqual': return first >= 0;
		case 'lessThanOrEqual': return first <= 0;
	}
}

function evaluateTop10(rule: ParadisSpreadsheetConditionalFormatRule, target: OwnedCell, sheet: OwnedSheet, date1904: boolean, cache: EvaluationCache, runtime: Runtime): boolean {
	const targetValue = optionalNumericScalar(scalarCellValue(target.cell, target.address, date1904, sheet, runtime));
	if (targetValue === undefined) { return false; }
	const values = aggregateNumericValues(rule, sheet, date1904, cache, runtime);
	if (values.length === 0) {
		return false;
	}
	let count = rule.rank!;
	if (rule.percent) {
		if (count === 0) { return false; }
		count = Math.max(1, Math.ceil(values.length * Math.min(100, count) / 100));
	}
	count = Math.min(values.length, count);
	const thresholdKey = `${rule.id}:${rule.bottom ? 'bottom' : 'top'}:${count}`;
	let threshold = cache.topThresholds.get(thresholdKey);
	if (threshold === undefined) {
		threshold = rankThreshold(values, count, rule.bottom ?? false, runtime);
		cache.topThresholds.set(thresholdKey, threshold);
	}
	return rule.bottom ? targetValue <= threshold : targetValue >= threshold;
}

function rankThreshold(values: readonly number[], count: number, bottom: boolean, runtime: Runtime): number {
	const heap: number[] = [];
	const orderedBefore = (left: number, right: number) => bottom ? left >= right : left <= right;
	for (const value of values) {
		consumeEvaluationOperations(runtime);
		if (heap.length < count) {
			heap.push(value);
			let index = heap.length - 1;
			while (index > 0) {
				consumeEvaluationOperations(runtime);
				const parent = Math.floor((index - 1) / 2);
				if (orderedBefore(heap[parent], heap[index])) { break; }
				[heap[parent], heap[index]] = [heap[index], heap[parent]];
				index = parent;
			}
			continue;
		}
		if (bottom ? value >= heap[0] : value <= heap[0]) { continue; }
		heap[0] = value;
		let index = 0;
		while (true) {
			consumeEvaluationOperations(runtime);
			const left = index * 2 + 1;
			const right = left + 1;
			if (left >= heap.length) { break; }
			let child = left;
			if (right < heap.length && !orderedBefore(heap[left], heap[right])) { child = right; }
			if (orderedBefore(heap[index], heap[child])) { break; }
			[heap[index], heap[child]] = [heap[child], heap[index]];
			index = child;
		}
	}
	if (heap.length === 0) { throw new EvaluationIssue('invalidValue'); }
	return heap[0];
}

function evaluateAboveAverage(rule: ParadisSpreadsheetConditionalFormatRule, target: OwnedCell, sheet: OwnedSheet, date1904: boolean, cache: EvaluationCache, runtime: Runtime): boolean {
	const targetValue = optionalNumericScalar(scalarCellValue(target.cell, target.address, date1904, sheet, runtime));
	if (targetValue === undefined) { return false; }
	const values = aggregateNumericValues(rule, sheet, date1904, cache, runtime);
	if (values.length === 0) {
		return false;
	}
	let statistics = cache.averageStatistics.get(rule.id);
	if (!statistics) {
		let scale = 0;
		for (const value of values) {
			consumeEvaluationOperations(runtime);
			scale = Math.max(scale, Math.abs(value));
		}
		let mean = 0;
		let squaredDifferenceSum = 0;
		let count = 0;
		for (const value of values) {
			consumeEvaluationOperations(runtime);
			const normalized = scale === 0 ? 0 : value / scale;
			count++;
			const delta = normalized - mean;
			mean += delta / count;
			squaredDifferenceSum += delta * (normalized - mean);
		}
		statistics = { scale, mean, standardDeviation: Math.sqrt(Math.max(0, squaredDifferenceSum / values.length)) };
		cache.averageStatistics.set(rule.id, statistics);
	}
	const targetNormalized = statistics.scale === 0 ? 0 : targetValue / statistics.scale;
	const standardDeviation = statistics.standardDeviation * (rule.standardDeviation ?? 0);
	const above = rule.aboveAverage ?? true;
	const threshold = statistics.mean + (above ? standardDeviation : -standardDeviation);
	return above
		? rule.equalAverage ? targetNormalized >= threshold : targetNormalized > threshold
		: rule.equalAverage ? targetNormalized <= threshold : targetNormalized < threshold;
}

function evaluateDuplicate(rule: ParadisSpreadsheetConditionalFormatRule, target: OwnedCell, sheet: OwnedSheet, date1904: boolean, cache: EvaluationCache, runtime: Runtime): boolean {
	const targetValue = scalarCellValue(target.cell, target.address, date1904, sheet, runtime);
	const targetKey = scalarKey(targetValue);
	const cached = cache.duplicateCounts.get(rule.id);
	if (cached) {
		const count = cached.get(targetKey) ?? 0;
		return rule.type === 'duplicateValues' ? count > 1 : count === 1;
	}
	const counts = new Map<string, number>();
	let materialized = 0;
	const rangeArea = rangeUnionArea(rule.ranges, runtime);
	for (const [address, cell] of sheet.cells) {
		consumeEvaluationOperations(runtime);
		const coordinate = parseCellReference(address);
		if (!matchingRangeAnchor(rule.ranges, coordinate, runtime)) {
			continue;
		}
		materialized++;
		const key = scalarKey(scalarCellValue(cell, address, date1904, sheet, runtime));
		counts.set(key, safeAdd(counts.get(key) ?? 0, 1));
	}
	if (rangeArea > materialized) {
		counts.set('blank', safeAdd(counts.get('blank') ?? 0, rangeArea - materialized));
	}
	cache.duplicateCounts.set(rule.id, counts);
	const count = counts.get(targetKey) ?? 0;
	return rule.type === 'duplicateValues' ? count > 1 : count === 1;
}

function rangeUnionArea(ranges: readonly ParadisSemanticRange[], runtime: Runtime): number {
	const boundaries = new Set<number>();
	for (const range of ranges) {
		consumeEvaluationOperations(runtime);
		boundaries.add(range.minColumn);
		boundaries.add(range.maxColumn + 1);
	}
	const rawColumns: number[] = [];
	for (const boundary of boundaries) {
		consumeEvaluationOperations(runtime);
		rawColumns.push(boundary);
	}
	const columns = boundedSort(rawColumns, (left, right) => left - right, runtime);
	let area = 0;
	for (let index = 0; index + 1 < columns.length; index++) {
		consumeEvaluationOperations(runtime);
		const from = columns[index];
		const to = columns[index + 1];
		const intervals: { from: number; to: number }[] = [];
		for (const range of ranges) {
			consumeEvaluationOperations(runtime);
			if (range.minColumn < to && range.maxColumn + 1 > from) {
				intervals.push({ from: range.minRow, to: range.maxRow + 1 });
			}
		}
		const sortedIntervals = boundedSort(intervals, (left, right) => left.from - right.from || left.to - right.to, runtime);
		let coveredRows = 0;
		let currentFrom = -1;
		let currentTo = -1;
		for (const interval of sortedIntervals) {
			consumeEvaluationOperations(runtime);
			if (interval.from > currentTo) {
				if (currentFrom >= 0) { coveredRows = safeAdd(coveredRows, currentTo - currentFrom); }
				currentFrom = interval.from;
				currentTo = interval.to;
			} else {
				currentTo = Math.max(currentTo, interval.to);
			}
		}
		if (currentFrom >= 0) { coveredRows = safeAdd(coveredRows, currentTo - currentFrom); }
		area = safeAdd(area, safeMultiply(to - from, coveredRows));
	}
	return area;
}

function evaluateTextRule(rule: ParadisSpreadsheetConditionalFormatRule, target: OwnedCell, sheet: OwnedSheet, runtime: Runtime): boolean {
	const value = scalarCellValue(target.cell, target.address, runtime.workbook?.date1904 ?? false, sheet, runtime);
	if (typeof value !== 'string') {
		return false;
	}
	const actual = value.toLocaleLowerCase('en-US');
	const expected = rule.text!.toLocaleLowerCase('en-US');
	switch (rule.type) {
		case 'containsText': return actual.includes(expected);
		case 'notContainsText': return !actual.includes(expected);
		case 'beginsWith': return actual.startsWith(expected);
		case 'endsWith': return actual.endsWith(expected);
		default: return false;
	}
}

function evaluateBlankOrErrorRule(rule: ParadisSpreadsheetConditionalFormatRule, target: OwnedCell, sheet: OwnedSheet, runtime: Runtime): boolean {
	const cell = target.cell;
	if (cell?.storedType === 'formula' && !cell.cachedResult?.present) {
		throw new EvaluationIssue(runtime.workbook
			? classifyMissingFormulaCacheDependencies(sheet, target.address, runtime.workbook, runtime)
			: classifyMissingFormulaCache(cell.formula?.text ?? '', target.address));
	}
	const blank = isConditionalBlankCell(cell);
	const error = cell?.storedType === 'error' || Boolean(cell?.storedType === 'formula' && cell.cachedResult?.present && cell.cachedResult.type === 'error');
	switch (rule.type) {
		case 'containsBlanks': return blank;
		case 'notContainsBlanks': return !blank;
		case 'containsErrors': return error;
		case 'notContainsErrors': return !error;
		default: return false;
	}
}

function isConditionalBlankCell(cell: ParadisSemanticCell | undefined): boolean {
	if (!cell || cell.storedType === 'blank') { return true; }
	let value: string | undefined;
	if (cell.storedType === 'string') {
		value = cell.text ?? (cell.rawValue?.present ? cell.rawValue.text : undefined);
	} else if (cell.storedType === 'formula' && cell.cachedResult?.present && cell.cachedResult.type === 'string') {
		value = cell.cachedResult.rawValue;
	}
	return value !== undefined && value.replace(/ /g, '').length === 0;
}

function evaluateTimePeriod(rule: ParadisSpreadsheetConditionalFormatRule, target: OwnedCell, todaySerial: number | undefined, date1904: boolean, sheet: OwnedSheet, runtime: Runtime): boolean {
	if (todaySerial === undefined) {
		throw new EvaluationIssue('todayMissing');
	}
	const numeric = optionalNumericScalar(scalarCellValue(target.cell, target.address, date1904, sheet, runtime));
	if (numeric === undefined) { return false; }
	const maximumSerial = date1904 ? 2_957_003 : 2_958_465;
	if (numeric < 0 || numeric > maximumSerial || todaySerial < 0 || todaySerial > maximumSerial) {
		throw new EvaluationIssue('invalidValue');
	}
	const value = Math.floor(numeric);
	const today = Math.floor(todaySerial);
	switch (rule.timePeriod) {
		case 'today': return value === today;
		case 'yesterday': return value === today - 1;
		case 'tomorrow': return value === today + 1;
		case 'last7Days': return value >= today - 6 && value <= today;
		case 'lastWeek': {
			const start = excelWeekStart(today, date1904);
			return value >= start - 7 && value < start;
		}
		case 'thisWeek': {
			const start = excelWeekStart(today, date1904);
			return value >= start && value < start + 7;
		}
		case 'nextWeek': {
			const start = excelWeekStart(today, date1904);
			return value >= start + 7 && value < start + 14;
		}
		case 'lastMonth': return sameRelativeMonth(value, today, -1, date1904);
		case 'thisMonth': return sameRelativeMonth(value, today, 0, date1904);
		case 'nextMonth': return sameRelativeMonth(value, today, 1, date1904);
	}
	throw new EvaluationIssue('unsupportedExpression');
}

function excelWeekStart(serial: number, date1904: boolean): number {
	// 1900-01-01 is Monday and 1904-01-01 is Friday. Excel periods begin on Sunday.
	const epochOffset = date1904 ? 5 : 0;
	const weekdayFromSunday = (((serial + epochOffset) % 7) + 7) % 7;
	return serial - weekdayFromSunday;
}

function sameRelativeMonth(value: number, today: number, offset: number, date1904: boolean): boolean {
	const valueDate = serialToDate(value, date1904);
	const todayDate = serialToDate(today, date1904);
	let year = todayDate.year;
	let month = todayDate.month + offset;
	while (month < 1) { month += 12; year--; }
	while (month > 12) { month -= 12; year++; }
	return valueDate.year === year && valueDate.month === month;
}

function serialToDate(serial: number, date1904: boolean): { readonly year: number; readonly month: number } {
	let days = serial + (date1904 ? 1 : 0);
	if (!date1904 && days >= 60) {
		days--;
	}
	const baseYear = date1904 ? 1904 : 1900;
	const absoluteOrdinal = daysBeforeYear(baseYear) + days;
	let low = baseYear;
	let high = 10_000;
	while (low + 1 < high) {
		const middle = Math.floor((low + high) / 2);
		if (daysBeforeYear(middle) < absoluteOrdinal) {
			low = middle;
		} else {
			high = middle;
		}
	}
	const year = low;
	days = absoluteOrdinal - daysBeforeYear(year);
	const monthLengths = [31, isLeapYear(year) ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
	let month = 1;
	while (days > monthLengths[month - 1]) {
		days -= monthLengths[month - 1];
		month++;
	}
	return { year, month };
}

function isLeapYear(year: number): boolean {
	return year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
}

function evaluateVisualRule(
	rule: ParadisSpreadsheetConditionalFormatRule,
	target: OwnedCell,
	anchor: CellCoordinate,
	currentSheet: OwnedSheet,
	workbook: OwnedWorkbook,
	cache: EvaluationCache,
	runtime: Runtime,
): ParadisSpreadsheetConditionalRenderOverlay | undefined {
	const targetValue = optionalNumericScalar(scalarCellValue(target.cell, target.address, workbook.date1904, currentSheet, runtime));
	if (targetValue === undefined) { return undefined; }
	const values = aggregateNumericValues(rule, currentSheet, workbook.date1904, cache, runtime);
	if (values.length === 0) {
		throw new EvaluationIssue('invalidValue');
	}
	const visual = rule.visualRule!;
	let thresholds = cache.visualThresholds.get(rule.id);
	if (!thresholds || visual.values.some(value => value.type === 'formula')) {
		thresholds = visual.values.map(value => resolveThreshold(value, values, target.coordinate, anchor, currentSheet, workbook, runtime));
		if (!visual.values.some(value => value.type === 'formula')) { cache.visualThresholds.set(rule.id, thresholds); }
	}
	if (visual.kind === 'colorScale') {
		let segment = 0;
		while (segment + 1 < thresholds.length - 1 && targetValue > thresholds[segment + 1]) {
			segment++;
		}
		const lower = thresholds[segment];
		const upper = thresholds[segment + 1];
		const mix = stableRatio(targetValue, lower, upper);
		const position = thresholds[thresholds.length - 1] === thresholds[0]
			? 0
			: stableRatio(targetValue, thresholds[0], thresholds[thresholds.length - 1]);
		return { kind: 'colorScale', position, lowerColor: ownColor(visual.colors[segment]), upperColor: ownColor(visual.colors[segment + 1]), mix };
	}
	if (visual.kind === 'dataBar') {
		const ratio = stableRatio(targetValue, thresholds[0], thresholds[1]);
		const minLength = visual.minLength ?? 10;
		const maxLength = visual.maxLength ?? 90;
		const renderedRatio = (minLength + ratio * (maxLength - minLength)) / 100;
		return { kind: 'dataBar', ratio: renderedRatio, color: ownColor(visual.color), showValue: visual.showValue, gradient: visual.gradient, minLength, maxLength };
	}
	let iconIndex = 0;
	for (let index = 0; index < thresholds.length; index++) {
		const gte = visual.values[index].greaterThanOrEqual ?? true;
		if (gte ? targetValue >= thresholds[index] : targetValue > thresholds[index]) {
			iconIndex = index;
		}
	}
	if (visual.reverse) {
		iconIndex = thresholds.length - 1 - iconIndex;
	}
	return { kind: 'iconSet', iconSet: visual.iconSet, iconIndex, showValue: visual.showValue, reverse: visual.reverse };
}

function resolveThreshold(
	value: ParadisSpreadsheetConditionalValueObject,
	values: readonly number[],
	target: CellCoordinate,
	anchor: CellCoordinate,
	currentSheet: OwnedSheet,
	workbook: OwnedWorkbook,
	runtime: Runtime,
): number {
	let min = values[0];
	let max = values[0];
	for (const entry of values) {
		consumeEvaluationOperations(runtime);
		min = Math.min(min, entry);
		max = Math.max(max, entry);
	}
	switch (value.type) {
		case 'min': return min;
		case 'autoMin': return Math.min(0, min);
		case 'max': return max;
		case 'autoMax': return Math.max(0, max);
		case 'num': return parseFiniteNumber(value.value!);
		case 'percent': return stableInterpolate(min, max, parseBoundedPercent(value.value!) / 100);
		case 'percentile': {
			const index = (values.length - 1) * parseBoundedPercent(value.value!) / 100;
			const lower = Math.floor(index);
			const upper = Math.ceil(index);
			const lowerValue = selectNumericValue(values, lower, runtime);
			const upperValue = upper === lower ? lowerValue : selectNumericValue(values, upper, runtime);
			return stableInterpolate(lowerValue, upperValue, index - lower);
		}
		case 'formula': return numericScalar(scalarFormulaValue(evaluateFormula(value.value!, target, anchor, currentSheet, workbook, runtime)));
	}
}

function stableRatio(value: number, lower: number, upper: number): number {
	if (upper === lower) { return value >= upper ? 1 : 0; }
	const scale = Math.max(Math.abs(value), Math.abs(lower), Math.abs(upper));
	if (scale === 0) { return 0; }
	const denominator = upper / scale - lower / scale;
	if (denominator === 0) { return value >= upper ? 1 : 0; }
	return clamp((value / scale - lower / scale) / denominator);
}

function stableInterpolate(lower: number, upper: number, ratio: number): number {
	if (ratio <= 0 || lower === upper) { return lower; }
	if (ratio >= 1) { return upper; }
	const scale = Math.max(Math.abs(lower), Math.abs(upper));
	if (scale === 0) { return 0; }
	const normalized = (lower / scale) * (1 - ratio) + (upper / scale) * ratio;
	return finiteNumber(Math.max(-1, Math.min(1, normalized)) * scale);
}

function aggregateNumericValues(rule: ParadisSpreadsheetConditionalFormatRule, sheet: OwnedSheet, date1904: boolean, cache: EvaluationCache, runtime: Runtime): readonly number[] {
	const cached = cache.numericValues.get(rule.id);
	if (cached) { return cached; }
	const result: number[] = [];
	for (const [address, cell] of sheet.cells) {
		consumeEvaluationOperations(runtime);
		const coordinate = parseCellReference(address);
		if (!matchingRangeAnchor(rule.ranges, coordinate, runtime)) {
			continue;
		}
		const scalar = scalarCellValue(cell, address, date1904, sheet, runtime);
		if (typeof scalar === 'number') {
			result.push(scalar);
		}
	}
	cache.numericValues.set(rule.id, result);
	return result;
}

function selectNumericValue(values: readonly number[], wanted: number, runtime: Runtime): number {
	if (wanted < 0 || wanted >= values.length) { throw new EvaluationIssue('invalidValue'); }
	const work: number[] = [];
	for (const value of values) {
		consumeEvaluationOperations(runtime);
		work.push(value);
	}
	let left = 0;
	let right = work.length - 1;
	while (left < right) {
		consumeEvaluationOperations(runtime);
		const middle = Math.floor((left + right) / 2);
		const pivot = medianNumber(work[left], work[middle], work[right]);
		let low = left;
		let index = left;
		let high = right;
		while (index <= high) {
			consumeEvaluationOperations(runtime);
			if (work[index] < pivot) {
				[work[low++], work[index++]] = [work[index], work[low]];
			} else if (work[index] > pivot) {
				[work[index], work[high--]] = [work[high], work[index]];
			} else {
				index++;
			}
		}
		if (wanted < low) { right = low - 1; }
		else if (wanted > high) { left = high + 1; }
		else { return pivot; }
	}
	return work[left];
}

function medianNumber(a: number, b: number, c: number): number {
	return a < b ? b < c ? b : a < c ? c : a : a < c ? a : b < c ? c : b;
}

function boundedSort<T>(values: readonly T[], compare: (left: T, right: T) => number, runtime: Runtime): T[] {
	let source: T[] = [];
	for (const value of values) {
		consumeEvaluationOperations(runtime);
		source.push(value);
	}
	let target = new Array<T>(source.length);
	for (let width = 1; width < source.length; width *= 2) {
		for (let start = 0; start < source.length; start += width * 2) {
			let left = start;
			let right = Math.min(start + width, source.length);
			const leftEnd = right;
			const rightEnd = Math.min(start + width * 2, source.length);
			let output = start;
			while (left < leftEnd || right < rightEnd) {
				consumeEvaluationOperations(runtime);
				if (right >= rightEnd || left < leftEnd && compare(source[left], source[right]) <= 0) {
					target[output++] = source[left++];
				} else {
					target[output++] = source[right++];
				}
			}
		}
		[source, target] = [target, source];
	}
	return source;
}

function scalarCellValue(cell: ParadisSemanticCell | undefined, address: string, date1904 = false, sheet?: OwnedSheet, runtime?: Runtime): Scalar {
	if (!cell || cell.storedType === 'blank') {
		return { kind: 'blank' };
	}
	if (cell.storedType === 'error') {
		throw new EvaluationIssue('errorValue');
	}
	if (cell.storedType === 'formula') {
		if (!cell.cachedResult?.present) {
			throw new EvaluationIssue(sheet && runtime?.workbook
				? classifyMissingFormulaCacheDependencies(sheet, address, runtime.workbook, runtime)
				: classifyMissingFormulaCache(cell.formula?.text ?? '', address));
		}
		if (cell.cachedResult.type === 'error') {
			throw new EvaluationIssue('errorValue');
		}
		return scalarFromRaw(cell.cachedResult.type, cell.cachedResult.rawValue, date1904);
	}
	if (cell.storedType === 'string') {
		if (cell.rawType === 's' && cell.text === undefined) {
			throw new EvaluationIssue('sharedStringMissing');
		}
		return cell.text ?? (cell.rawValue?.present ? cell.rawValue.text : '');
	}
	if (cell.storedType === 'number') {
		return parseFiniteNumber(cell.rawValue?.present ? cell.rawValue.text : '');
	}
	if (cell.storedType === 'date') {
		return parseDateValue(cell.rawValue?.present ? cell.rawValue.text : '', date1904);
	}
	if (cell.storedType === 'boolean') {
		const raw = cell.rawValue?.present ? cell.rawValue.text : '';
		if (raw === '1' || raw === 'true') { return true; }
		if (raw === '0' || raw === 'false') { return false; }
		throw new EvaluationIssue('invalidValue');
	}
	throw new EvaluationIssue('invalidValue');
}

function scalarFromRaw(type: string, raw: string, date1904: boolean): Scalar {
	if (type === 'number') {
		return parseFiniteNumber(raw);
	}
	if (type === 'date') {
		return parseDateValue(raw, date1904);
	}
	if (type === 'boolean') {
		if (raw === '1' || raw === 'true') { return true; }
		if (raw === '0' || raw === 'false') { return false; }
		throw new EvaluationIssue('invalidValue');
	}
	if (type === 'string') {
		return raw;
	}
	throw new EvaluationIssue('errorValue');
}

function classifyMissingFormulaCache(formula: string, address: string): ParadisSpreadsheetConditionalNotEvaluatedReason {
	if (containsExternalReference(formula)) {
		return 'externalReference';
	}
	const upper = formula.toUpperCase();
	if (/\b(?:RAND|RANDBETWEEN|NOW|TODAY|OFFSET|INDIRECT)\s*\(/.test(upper)) {
		return 'volatileFunction';
	}
	const escapedAddress = address.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
	if (new RegExp(`(^|[^A-Z0-9_])\\$?${escapedAddress.replace(/([A-Z]+)([0-9]+)/, '$1\\$?$2')}([^A-Z0-9_]|$)`, 'i').test(formula)) {
		return 'cycle';
	}
	return 'cacheMissing';
}

function classifyMissingFormulaCacheDependencies(
	startSheet: OwnedSheet,
	startAddress: string,
	workbook: OwnedWorkbook,
	runtime: Runtime,
): ParadisSpreadsheetConditionalNotEvaluatedReason {
	const startKey = dependencyKey(startSheet, startAddress);
	const cached = runtime.formulaDependencyReasons.get(startKey);
	if (cached) { return cached; }
	const nodes = new Map<string, { readonly sheet: OwnedSheet; readonly address: string; readonly edges: string[] }>();
	const queue: { readonly sheet: OwnedSheet; readonly address: string }[] = [{ sheet: startSheet, address: startAddress }];
	const queued = new Set<string>([startKey]);
	let external = false;
	let volatile = false;
	for (let cursor = 0; cursor < queue.length; cursor++) {
		consumeEvaluationOperations(runtime);
		if (nodes.size >= runtime.context.limits.snapshotCells) { throw new ParadisOfficePackageError('limitExceeded'); }
		const current = queue[cursor];
		const key = dependencyKey(current.sheet, current.address);
		const cell = current.sheet.cells.get(current.address);
		const formula = cell?.storedType === 'formula' && !cell.cachedResult?.present ? cell.formula?.text ?? '' : '';
		const edges: string[] = [];
		nodes.set(key, { sheet: current.sheet, address: current.address, edges });
		if (!formula) { continue; }
		if (containsExternalReference(formula)) {
			external = true;
			continue;
		}
		if (containsVolatileFunction(formula, runtime)) { volatile = true; }
		try {
			const tokenizer = new FormulaTokenizer(formula.startsWith('=') ? formula.slice(1) : formula, runtime);
			while (true) {
				const token = tokenizer.next();
				if (token.kind === 'end') { break; }
				if (token.kind === 'identifier' && ['RAND', 'RANDBETWEEN', 'NOW', 'TODAY', 'OFFSET', 'INDIRECT'].includes(token.value)) {
					volatile = true;
				}
				if (token.kind !== 'reference') { continue; }
				const referencedSheet = token.sheet === undefined ? current.sheet : workbook.sheets.get(normalizeSheetName(token.sheet));
				if (!referencedSheet) { continue; }
				const origin = parseCellReference(current.address);
				const start = resolveFormulaReference(token.start, origin, origin);
				const end = token.end ? resolveFormulaReference(token.end, origin, origin) : start;
				const minRow = Math.min(start.row, end.row);
				const maxRow = Math.max(start.row, end.row);
				const minColumn = Math.min(start.column, end.column);
				const maxColumn = Math.max(start.column, end.column);
				const area = safeMultiply(maxRow - minRow + 1, maxColumn - minColumn + 1);
				if (area > runtime.context.limits.snapshotCells) { throw new ParadisOfficePackageError('limitExceeded'); }
				for (let row = minRow; row <= maxRow; row++) {
					for (let column = minColumn; column <= maxColumn; column++) {
						consumeEvaluationOperations(runtime);
						const address = formatCellAddress(row, column);
						const dependency = referencedSheet.cells.get(address);
						if (dependency?.storedType !== 'formula' || dependency.cachedResult?.present) { continue; }
						const dependencyKeyValue = dependencyKey(referencedSheet, address);
						edges.push(dependencyKeyValue);
						if (!queued.has(dependencyKeyValue)) {
							queued.add(dependencyKeyValue);
							queue.push({ sheet: referencedSheet, address });
						}
					}
				}
			}
		} catch (error) {
			if (error instanceof ParadisOfficePackageError) { throw error; }
			if (!(error instanceof EvaluationIssue)) { throw error; }
		}
	}
	let cycle = false;
	const colors = new Map<string, 1 | 2>();
	for (const key of nodes.keys()) {
		if (colors.has(key)) { continue; }
		const stack: { readonly key: string; index: number }[] = [{ key, index: 0 }];
		colors.set(key, 1);
		while (stack.length > 0) {
			consumeEvaluationOperations(runtime);
			const frame = stack[stack.length - 1];
			const edges = nodes.get(frame.key)?.edges ?? [];
			if (frame.index >= edges.length) {
				colors.set(frame.key, 2);
				stack.pop();
				continue;
			}
			const edge = edges[frame.index++];
			const color = colors.get(edge);
			if (color === 1) { cycle = true; continue; }
			if (color === 2 || !nodes.has(edge)) { continue; }
			colors.set(edge, 1);
			stack.push({ key: edge, index: 0 });
		}
	}
	const reason: ParadisSpreadsheetConditionalNotEvaluatedReason = external ? 'externalReference' : volatile ? 'volatileFunction' : cycle ? 'cycle' : 'cacheMissing';
	runtime.formulaDependencyReasons.set(startKey, reason);
	return reason;
}

function dependencyKey(sheet: OwnedSheet, address: string): string {
	return `${normalizeSheetName(sheet.name)}\0${address}`;
}

function containsVolatileFunction(formula: string, runtime: Runtime): boolean {
	const volatileFunctions = new Set(['RAND', 'RANDBETWEEN', 'NOW', 'TODAY', 'OFFSET', 'INDIRECT']);
	let quoted = false;
	let quotedSheet = false;
	for (let index = 0; index < formula.length; index++) {
		consumeEvaluationOperations(runtime);
		const character = formula[index];
		if (!quoted && character.charCodeAt(0) === 39) {
			if (quotedSheet && formula.charCodeAt(index + 1) === 39) { index++; }
			else { quotedSheet = !quotedSheet; }
			continue;
		}
		if (!quotedSheet && character === '"') {
			if (quoted && formula[index + 1] === '"') { index++; }
			else { quoted = !quoted; }
			continue;
		}
		if (quoted || quotedSheet || !/[A-Za-z_]/.test(character)) { continue; }
		const start = index;
		while (index + 1 < formula.length && /[A-Za-z0-9_.]/.test(formula[index + 1])) { consumeEvaluationOperations(runtime); index++; }
		const identifier = formula.slice(start, index + 1).toUpperCase().split('.').pop()!;
		let cursor = index + 1;
		while (cursor < formula.length && /\s/.test(formula[cursor])) { consumeEvaluationOperations(runtime); cursor++; }
		if (formula[cursor] === '(' && volatileFunctions.has(identifier)) { return true; }
	}
	return false;
}

function parseFiniteNumber(value: string): number {
	if (!/^[+-]?(?:(?:[0-9]+(?:\.[0-9]*)?)|(?:\.[0-9]+))(?:[Ee][+-]?[0-9]+)?$/.test(value)) {
		throw new EvaluationIssue('invalidValue');
	}
	const parsed = Number(value);
	if (!Number.isFinite(parsed)) {
		throw new EvaluationIssue('invalidValue');
	}
	return parsed;
}

function finiteNumber(value: number): number {
	if (!Number.isFinite(value)) {
		throw new EvaluationIssue('invalidValue');
	}
	return value;
}

function parseDateValue(value: string, date1904: boolean): number {
	if (/^[+-]?(?:(?:[0-9]+(?:\.[0-9]*)?)|(?:\.[0-9]+))(?:[Ee][+-]?[0-9]+)?$/.test(value)) {
		return parseFiniteNumber(value);
	}
	const match = /^([0-9]{4})-([0-9]{2})-([0-9]{2})(?:T([0-9]{2}):([0-9]{2}):([0-9]{2})(?:\.([0-9]{1,9}))?Z?)?$/.exec(value);
	if (!match) {
		throw new EvaluationIssue('invalidValue');
	}
	const year = Number(match[1]);
	const month = Number(match[2]);
	const day = Number(match[3]);
	const hour = Number(match[4] ?? 0);
	const minute = Number(match[5] ?? 0);
	const second = Number(match[6] ?? 0);
	if (year < (date1904 ? 1904 : 1900) || month < 1 || month > 12 || day < 1 || day > daysInMonth(year, month)
		|| hour > 23 || minute > 59 || second > 59) {
		throw new EvaluationIssue('invalidValue');
	}
	const baseYear = date1904 ? 1904 : 1900;
	let days = daysBeforeYear(year) - daysBeforeYear(baseYear);
	for (let currentMonth = 1; currentMonth < month; currentMonth++) {
		days += daysInMonth(year, currentMonth);
	}
	days += day - 1;
	let serial = days + (date1904 ? 0 : 1);
	if (!date1904 && (year > 1900 || month > 2)) {
		serial++;
	}
	const fraction = match[7] ? Number(`0.${match[7]}`) : 0;
	serial += (hour * 3600 + minute * 60 + second + fraction) / 86_400;
	return serial;
}

function daysBeforeYear(year: number): number {
	const previous = year - 1;
	return previous * 365 + Math.floor(previous / 4) - Math.floor(previous / 100) + Math.floor(previous / 400);
}

function daysInMonth(year: number, month: number): number {
	return [31, isLeapYear(year) ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][month - 1];
}

function parseBoundedPercent(value: string): number {
	const result = parseFiniteNumber(value);
	if (result < 0 || result > 100) {
		throw new EvaluationIssue('invalidValue');
	}
	return result;
}

function numericScalar(value: Scalar): number {
	if (typeof value !== 'number') {
		throw new EvaluationIssue('invalidValue');
	}
	return value;
}

function optionalNumericScalar(value: Scalar): number | undefined {
	return typeof value === 'number' ? value : undefined;
}

function scalarFormulaValue(value: FormulaValue): Scalar {
	if (Array.isArray(value)) {
		if (value.length !== 1) {
			throw new EvaluationIssue('unsupportedExpression');
		}
		return value[0];
	}
	return value as Scalar;
}

function booleanFormulaValue(value: FormulaValue): boolean {
	const scalar = scalarFormulaValue(value);
	if (typeof scalar === 'boolean') {
		return scalar;
	}
	if (typeof scalar === 'number') {
		return scalar !== 0;
	}
	if (typeof scalar === 'string') {
		return scalar.length > 0;
	}
	return false;
}

function compareScalars(left: Scalar, right: Scalar): number {
	if (typeof left === 'number' && typeof right === 'number') {
		return left === right ? 0 : left < right ? -1 : 1;
	}
	if (typeof left === 'boolean' && typeof right === 'boolean') {
		return left === right ? 0 : left ? 1 : -1;
	}
	if (typeof left !== typeof right || isBlank(left) !== isBlank(right)) {
		return scalarTypeRank(left) - scalarTypeRank(right);
	}
	const leftText = isBlank(left) ? '' : String(left).toLocaleLowerCase('en-US');
	const rightText = isBlank(right) ? '' : String(right).toLocaleLowerCase('en-US');
	return leftText === rightText ? 0 : leftText < rightText ? -1 : 1;
}

function scalarTypeRank(value: Scalar): number {
	if (isBlank(value)) { return 0; }
	if (typeof value === 'number') { return 1; }
	if (typeof value === 'string') { return 2; }
	return 3;
}

function scalarKey(value: Scalar): string {
	if (isBlank(value)) { return 'blank'; }
	return `${typeof value}:${typeof value === 'string' ? value.toLocaleLowerCase('en-US') : String(value)}`;
}

function isBlank(value: Scalar): value is { readonly kind: 'blank' } {
	return typeof value === 'object';
}

function clamp(value: number): number {
	return Math.max(0, Math.min(1, value));
}

type FormulaToken =
	| { readonly kind: 'number'; readonly value: number }
	| { readonly kind: 'string'; readonly value: string }
	| { readonly kind: 'boolean'; readonly value: boolean }
	| { readonly kind: 'reference'; readonly sheet?: string; readonly start: FormulaReference; readonly end?: FormulaReference }
	| { readonly kind: 'identifier'; readonly value: string }
	| { readonly kind: 'operator'; readonly value: string }
	| { readonly kind: 'leftParen' | 'rightParen' | 'comma' | 'end' };

interface FormulaReference {
	readonly column: number;
	readonly row: number;
	readonly absoluteColumn: boolean;
	readonly absoluteRow: boolean;
}

function evaluateFormula(
	formula: string,
	target: CellCoordinate,
	anchor: CellCoordinate,
	currentSheet: OwnedSheet,
	workbook: OwnedWorkbook,
	runtime: Runtime,
): FormulaValue {
	if (containsExternalReference(formula)) {
		throw new EvaluationIssue('externalReference');
	}
	const tokenizer = new FormulaTokenizer(formula.startsWith('=') ? formula.slice(1) : formula, runtime);
	const parser = new FormulaParser(tokenizer, target, anchor, currentSheet, workbook, runtime);
	return parser.parse();
}

function containsExternalReference(formula: string): boolean {
	let quoted = false;
	let quotedSheet = false;
	const unquoted: string[] = [];
	for (let index = 0; index < formula.length; index++) {
		if (!quoted && formula.charCodeAt(index) === 39) {
			unquoted.push(formula[index]);
			if (quotedSheet && formula.charCodeAt(index + 1) === 39) {
				unquoted.push(formula[++index]);
			} else {
				quotedSheet = !quotedSheet;
			}
		} else if (!quotedSheet && formula[index] === '"') {
			if (quoted && formula[index + 1] === '"') {
				index++;
				continue;
			}
			quoted = !quoted;
		} else if (!quoted) {
			unquoted.push(formula[index]);
		}
	}
	return /\[[^\]\r\n]{1,255}\][^!(),+\-*/^<>=]{0,255}!/.test(unquoted.join(''));
}

class FormulaTokenizer {
	private index = 0;
	private cached: FormulaToken | undefined;

	constructor(private readonly input: string, private readonly runtime: Runtime) { }

	peek(): FormulaToken {
		return this.cached ??= this.read();
	}

	next(): FormulaToken {
		const result = this.peek();
		this.cached = undefined;
		return result;
	}

	private read(): FormulaToken {
		this.runtime.formulaTokens = safeAdd(this.runtime.formulaTokens, 1);
		if (this.runtime.formulaTokens > this.runtime.context.limits.formulaTokens) {
			throw new ParadisOfficePackageError('limitExceeded');
		}
		checkpoint(this.runtime);
		while (/\s/.test(this.input[this.index] ?? '')) {
			checkpoint(this.runtime);
			this.index++;
		}
		if (this.index >= this.input.length) {
			return { kind: 'end' };
		}
		const remaining = this.input.slice(this.index, this.index + 512);
		const numberMatch = /^(?:(?:[0-9]+(?:\.[0-9]*)?)|(?:\.[0-9]+))(?:[Ee][+-]?[0-9]+)?/.exec(remaining);
		if (numberMatch) {
			this.index += numberMatch[0].length;
			const value = Number(numberMatch[0]);
			if (!Number.isFinite(value)) {
				throw new EvaluationIssue('invalidValue');
			}
			return { kind: 'number', value };
		}
		if (remaining[0] === '"') {
			let value = '';
			this.index++;
			while (this.index < this.input.length) {
				checkpoint(this.runtime);
				if (this.input[this.index] === '"') {
					if (this.input[this.index + 1] === '"') {
						value += '"';
						this.index += 2;
						continue;
					}
					this.index++;
					return { kind: 'string', value };
				}
				value += this.input[this.index++];
			}
			throw new EvaluationIssue('unsupportedExpression');
		}
		const reference = this.readReference();
		if (reference) {
			return reference;
		}
		const identifier = /^[A-Za-z_][A-Za-z0-9_.]*/.exec(remaining);
		if (identifier) {
			this.index += identifier[0].length;
			const upper = identifier[0].toUpperCase();
			if (upper === 'TRUE' || upper === 'FALSE') {
				return { kind: 'boolean', value: upper === 'TRUE' };
			}
			return { kind: 'identifier', value: upper };
		}
		for (const operator of ['<=', '>=', '<>']) {
			if (remaining.startsWith(operator)) {
				this.index += operator.length;
				return { kind: 'operator', value: operator };
			}
		}
		const character = this.input[this.index++];
		switch (character) {
			case '+': case '-': case '*': case '/': case '^': case '=': case '<': case '>': case '%':
				return { kind: 'operator', value: character };
			case '(': return { kind: 'leftParen' };
			case ')': return { kind: 'rightParen' };
			case ',': case ';': return { kind: 'comma' };
			default: throw new EvaluationIssue('unsupportedExpression');
		}
	}

	private readReference(): Extract<FormulaToken, { readonly kind: 'reference' }> | undefined {
		const remaining = this.input.slice(this.index, this.index + 512);
		let sheet: string | undefined;
		let prefixLength = 0;
		if (remaining.charCodeAt(0) === 39) {
			let cursor = 1;
			let value = '';
			while (cursor < remaining.length) {
				checkpoint(this.runtime);
				if (remaining.charCodeAt(cursor) === 39) {
					if (remaining.charCodeAt(cursor + 1) === 39) {
						value += String.fromCharCode(39);
						cursor += 2;
						continue;
					}
					if (remaining[cursor + 1] !== '!') {
						return undefined;
					}
					sheet = value;
					prefixLength = cursor + 2;
					break;
				}
				value += remaining[cursor++];
			}
			if (prefixLength === 0) {
				throw new EvaluationIssue('unsupportedExpression');
			}
		} else {
			const sheetMatch = /^([A-Za-z_][A-Za-z0-9_.]*)!/.exec(remaining);
			if (sheetMatch) {
				sheet = sheetMatch[1];
				prefixLength = sheetMatch[0].length;
			}
		}
		const referenceText = remaining.slice(prefixLength);
		const match = /^(\$?[A-Za-z]{1,3}\$?[1-9][0-9]{0,6})(?::(\$?[A-Za-z]{1,3}\$?[1-9][0-9]{0,6}))?/.exec(referenceText);
		if (!match) {
			return undefined;
		}
		const nextCharacter = referenceText[match[0].length];
		if (nextCharacter && /[A-Za-z0-9_.]/.test(nextCharacter)) {
			return undefined;
		}
		this.index += prefixLength + match[0].length;
		return { kind: 'reference', ...(sheet ? { sheet } : {}), start: parseFormulaReference(match[1]), ...(match[2] ? { end: parseFormulaReference(match[2]) } : {}) };
	}
}

class FormulaParser {
	private depth = 0;

	constructor(
		private readonly tokens: FormulaTokenizer,
		private readonly target: CellCoordinate,
		private readonly anchor: CellCoordinate,
		private readonly currentSheet: OwnedSheet,
		private readonly workbook: OwnedWorkbook,
		private readonly runtime: Runtime,
	) { }

	parse(): FormulaValue {
		this.checkDepth();
		const result = this.parseComparison();
		if (this.tokens.next().kind !== 'end') {
			throw new EvaluationIssue('unsupportedExpression');
		}
		return result;
	}

	private parseComparison(): FormulaValue {
		let left = this.parseAdditive();
		while (this.peekOperator(['=', '<>', '<', '>', '<=', '>='])) {
			const operator = (this.tokens.next() as Extract<FormulaToken, { readonly kind: 'operator' }>).value;
			left = applyBinary(left, this.parseAdditive(), (a, b) => {
				const comparison = compareScalars(a, b);
				switch (operator) {
					case '=': return comparison === 0;
					case '<>': return comparison !== 0;
					case '<': return comparison < 0;
					case '>': return comparison > 0;
					case '<=': return comparison <= 0;
					default: return comparison >= 0;
				}
			}, this.runtime);
		}
		return left;
	}

	private parseAdditive(): FormulaValue {
		let left = this.parseMultiplicative();
		while (this.peekOperator(['+', '-'])) {
			const operator = (this.tokens.next() as Extract<FormulaToken, { readonly kind: 'operator' }>).value;
			left = applyBinary(left, this.parseMultiplicative(), (a, b) => finiteNumber(arithmeticScalar(a) + (operator === '+' ? arithmeticScalar(b) : -arithmeticScalar(b))), this.runtime);
		}
		return left;
	}

	private parseMultiplicative(): FormulaValue {
		let left = this.parsePower();
		while (this.peekOperator(['*', '/'])) {
			const operator = (this.tokens.next() as Extract<FormulaToken, { readonly kind: 'operator' }>).value;
			left = applyBinary(left, this.parsePower(), (a, b) => {
				const divisor = arithmeticScalar(b);
				if (operator === '/' && divisor === 0) {
					throw new EvaluationIssue('errorValue');
				}
				return finiteNumber(operator === '*' ? arithmeticScalar(a) * divisor : arithmeticScalar(a) / divisor);
			}, this.runtime);
		}
		return left;
	}

	private parsePower(): FormulaValue {
		this.enterDepth();
		try {
			let left = this.parseUnary();
			while (this.peekOperator(['^'])) {
				this.tokens.next();
				left = applyBinary(left, this.parseUnary(), (a, b) => {
					const result = arithmeticScalar(a) ** arithmeticScalar(b);
					if (!Number.isFinite(result)) {
						throw new EvaluationIssue('invalidValue');
					}
					return result;
				}, this.runtime);
			}
			return left;
		} finally {
			this.depth--;
		}
	}

	private parseUnary(): FormulaValue {
		this.enterDepth();
		try {
			if (this.peekOperator(['+', '-'])) {
				const operator = (this.tokens.next() as Extract<FormulaToken, { readonly kind: 'operator' }>).value;
				return applyUnary(this.parseUnary(), value => operator === '+' ? arithmeticScalar(value) : -arithmeticScalar(value), this.runtime);
			}
			let value = this.parsePrimary();
			while (this.peekOperator(['%'])) {
				this.tokens.next();
				value = applyUnary(value, entry => arithmeticScalar(entry) / 100, this.runtime);
			}
			return value;
		} finally {
			this.depth--;
		}
	}

	private parsePrimary(): FormulaValue {
		this.enterDepth();
		try {
			const token = this.tokens.next();
			switch (token.kind) {
				case 'number': case 'string': case 'boolean': return token.value;
				case 'reference': return this.resolveReference(token);
				case 'leftParen': {
					const value = this.parseComparison();
					if (this.tokens.next().kind !== 'rightParen') {
						throw new EvaluationIssue('unsupportedExpression');
					}
					return value;
				}
				case 'identifier': return this.parseFunction(token.value);
				default: throw new EvaluationIssue('unsupportedExpression');
			}
		} finally {
			this.depth--;
		}
	}

	private parseFunction(name: string): FormulaValue {
		if (this.tokens.next().kind !== 'leftParen') {
			throw new EvaluationIssue('unsupportedExpression');
		}
		if (['RAND', 'RANDBETWEEN', 'NOW', 'TODAY', 'OFFSET', 'INDIRECT'].includes(name)) {
			throw new EvaluationIssue('volatileFunction');
		}
		if (!['AND', 'OR', 'NOT'].includes(name)) {
			throw new EvaluationIssue('unsupportedFunction');
		}
		const argumentsList: FormulaValue[] = [];
		if (this.tokens.peek().kind !== 'rightParen') {
			while (true) {
				argumentsList.push(this.parseComparison());
				if (this.tokens.peek().kind !== 'comma') {
					break;
				}
				this.tokens.next();
			}
		}
		if (this.tokens.next().kind !== 'rightParen' || name === 'NOT' && argumentsList.length !== 1 || name !== 'NOT' && argumentsList.length < 1) {
			throw new EvaluationIssue('unsupportedExpression');
		}
		const booleans: boolean[] = [];
		for (const value of argumentsList) {
			for (const entry of Array.isArray(value) ? value : [value as Scalar]) {
				consumeEvaluationOperations(this.runtime);
				booleans.push(booleanFormulaValue(entry));
			}
		}
		return name === 'NOT' ? !booleans[0] : name === 'AND' ? booleans.every(Boolean) : booleans.some(Boolean);
	}

	private resolveReference(token: Extract<FormulaToken, { readonly kind: 'reference' }>): FormulaValue {
		const sheet = token.sheet === undefined ? this.currentSheet : this.workbook.sheets.get(normalizeSheetName(token.sheet));
		if (!sheet) {
			throw new EvaluationIssue('invalidValue');
		}
		const start = resolveFormulaReference(token.start, this.target, this.anchor);
		const end = token.end ? resolveFormulaReference(token.end, this.target, this.anchor) : start;
		const minRow = Math.min(start.row, end.row);
		const maxRow = Math.max(start.row, end.row);
		const minColumn = Math.min(start.column, end.column);
		const maxColumn = Math.max(start.column, end.column);
		const area = safeMultiply(maxRow - minRow + 1, maxColumn - minColumn + 1);
		if (area > this.runtime.context.limits.snapshotCells) {
			throw new ParadisOfficePackageError('limitExceeded');
		}
		const result: Scalar[] = [];
		for (let row = minRow; row <= maxRow; row++) {
			for (let column = minColumn; column <= maxColumn; column++) {
				consumeEvaluationOperations(this.runtime);
				const address = formatCellAddress(row, column);
				result.push(scalarCellValue(sheet.cells.get(address), address, this.workbook.date1904, sheet, this.runtime));
			}
		}
		return result.length === 1 ? result[0] : result;
	}

	private enterDepth(): void {
		this.depth++;
		this.checkDepth();
	}

	private checkDepth(): void {
		if (this.depth > this.runtime.context.limits.formulaDepth) {
			throw new ParadisOfficePackageError('limitExceeded');
		}
	}

	private peekOperator(values: readonly string[]): boolean {
		const token = this.tokens.peek();
		return token.kind === 'operator' && values.includes(token.value);
	}
}

function applyUnary(value: FormulaValue, operation: (value: Scalar) => Scalar, runtime: Runtime): FormulaValue {
	if (!Array.isArray(value)) { return operation(value as Scalar); }
	const result: Scalar[] = [];
	for (const entry of value) {
		consumeEvaluationOperations(runtime);
		result.push(operation(entry));
	}
	return result;
}

function applyBinary(left: FormulaValue, right: FormulaValue, operation: (left: Scalar, right: Scalar) => Scalar, runtime: Runtime): FormulaValue {
	const leftValues = Array.isArray(left) ? left : [left as Scalar];
	const rightValues = Array.isArray(right) ? right : [right as Scalar];
	const length = Math.max(leftValues.length, rightValues.length);
	if (leftValues.length !== 1 && leftValues.length !== length || rightValues.length !== 1 && rightValues.length !== length) {
		throw new EvaluationIssue('unsupportedExpression');
	}
	const result: Scalar[] = [];
	for (let index = 0; index < length; index++) {
		consumeEvaluationOperations(runtime);
		result.push(operation(leftValues[leftValues.length === 1 ? 0 : index], rightValues[rightValues.length === 1 ? 0 : index]));
	}
	return result.length === 1 ? result[0] : result;
}

function arithmeticScalar(value: Scalar): number {
	if (typeof value === 'number') { return value; }
	if (typeof value === 'boolean') { return value ? 1 : 0; }
	if (isBlank(value)) { return 0; }
	const parsed = Number(value);
	if (!Number.isFinite(parsed)) {
		throw new EvaluationIssue('invalidValue');
	}
	return parsed;
}

function parseFormulaReference(value: string): FormulaReference {
	const match = /^(\$?)([A-Za-z]{1,3})(\$?)([1-9][0-9]{0,6})$/.exec(value);
	if (!match) {
		throw new EvaluationIssue('unsupportedExpression');
	}
	const column = columnNumber(match[2]);
	const row = Number(match[4]);
	if (column < 1 || column > maximumExcelColumns || row < 1 || row > maximumExcelRows) {
		throw new EvaluationIssue('invalidValue');
	}
	return { column, row, absoluteColumn: match[1] === '$', absoluteRow: match[3] === '$' };
}

function resolveFormulaReference(reference: FormulaReference, target: CellCoordinate, anchor: CellCoordinate): CellCoordinate {
	const column = reference.absoluteColumn ? reference.column : reference.column + target.column - anchor.column;
	const row = reference.absoluteRow ? reference.row : reference.row + target.row - anchor.row;
	if (column < 1 || column > maximumExcelColumns || row < 1 || row > maximumExcelRows) {
		throw new EvaluationIssue('invalidValue');
	}
	return { column, row };
}

function normalizeSheetName(value: string): string {
	return value.toLocaleLowerCase('en-US');
}

function spreadsheetRoot(document: ParadisOfficeXmlDocument, local: string): XmlElement {
	if (!document || !isSpreadsheetElement(document.root, local)) {
		throw new ParadisOfficePackageError('malformed');
	}
	return document.root;
}

function isSpreadsheetElement(node: XmlElement, local?: string): boolean {
	return spreadsheetNamespaces.has(node.uri) && (local === undefined || node.local === local);
}

function elementChildren(node: XmlElement, runtime: Runtime): readonly XmlElement[] {
	const result: XmlElement[] = [];
	for (const child of node.children) {
		checkpoint(runtime);
		if (child.kind === 'element') {
			result.push(child);
		} else if (child.value.trim().length > 0) {
			throw new ParadisOfficePackageError('malformed');
		}
	}
	return result;
}

function elementChildrenBestEffort(node: XmlElement, runtime: Runtime): readonly XmlElement[] {
	const result: XmlElement[] = [];
	for (const child of node.children) {
		checkpoint(runtime);
		if (child.kind === 'element') { result.push(child); }
	}
	return result;
}

function assertEmptyElement(node: XmlElement): void {
	for (const child of node.children) {
		if (child.kind === 'element' || child.value.trim().length > 0) {
			throw new ParadisOfficePackageError('malformed');
		}
	}
}

function directText(node: XmlElement, runtime: Runtime): string {
	let result = '';
	for (const child of node.children) {
		checkpoint(runtime);
		if (child.kind !== 'text') {
			throw new ParadisOfficePackageError('malformed');
		}
		result += child.value;
	}
	return result;
}

function exactAttributes(node: XmlElement, allowedNames: readonly string[]): void {
	const allowed = new Set(allowedNames);
	for (const candidate of node.attributes) {
		if (candidate.uri !== '' || !allowed.has(candidate.local)) {
			throw new ParadisOfficePackageError('malformed');
		}
	}
}

function exactRootAttributes(node: XmlElement): void {
	for (const candidate of node.attributes) {
		if (candidate.uri === markupCompatibilityNamespace && markupCompatibilityRootAttributes.has(candidate.local)) {
			continue;
		}
		if (candidate.uri === spreadsheetRevisionNamespace && candidate.local === 'uid'
			&& /^\{[0-9A-Fa-f]{8}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{12}\}$/.test(candidate.value)) {
			continue;
		}
		throw new ParadisOfficePackageError('malformed');
	}
}

function attribute(node: XmlElement, local: string): string | undefined {
	return node.attributes.find(candidate => candidate.uri === '' && candidate.local === local)?.value;
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
	if (!/^(?:0|[1-9][0-9]*)$/.test(value)) {
		throw new ParadisOfficePackageError('malformed');
	}
	const result = Number(value);
	if (!Number.isSafeInteger(result)) {
		throw new ParadisOfficePackageError('malformed');
	}
	return result;
}

function signedIntegerAttribute(node: XmlElement, local: string): number | undefined {
	const value = attribute(node, local);
	if (value === undefined) {
		return undefined;
	}
	if (!/^-?(?:0|[1-9][0-9]*)$/.test(value)) {
		throw new ParadisOfficePackageError('malformed');
	}
	const result = Number(value);
	if (!Number.isSafeInteger(result)) {
		throw new ParadisOfficePackageError('malformed');
	}
	return result;
}

function requiredIntegerAttribute(node: XmlElement, local: string): number {
	const result = integerAttribute(node, local);
	if (result === undefined) {
		throw new ParadisOfficePackageError('malformed');
	}
	return result;
}

function requiredPositiveIntegerAttribute(node: XmlElement, local: string): number {
	const result = requiredIntegerAttribute(node, local);
	if (result < 1) {
		throw new ParadisOfficePackageError('malformed');
	}
	return result;
}

function booleanAttribute(node: XmlElement, local: string): boolean | undefined {
	const value = attribute(node, local);
	if (value === undefined) {
		return undefined;
	}
	if (value === '1' || value === 'true') { return true; }
	if (value === '0' || value === 'false') { return false; }
	throw new ParadisOfficePackageError('malformed');
}

function optionalEnumAttribute<T extends string>(node: XmlElement, local: string, values: readonly T[]): T | undefined {
	const value = attribute(node, local);
	if (value === undefined) {
		return undefined;
	}
	if (!values.includes(value as T)) {
		throw new ParadisOfficePackageError('malformed');
	}
	return value as T;
}

function optionalNonnegativeInteger(value: unknown): number | undefined {
	if (value === undefined) {
		return undefined;
	}
	if (!Number.isSafeInteger(value) || (value as number) < 0) {
		throw new ParadisOfficePackageError('unsafe');
	}
	return value as number;
}

function parseSqref(value: string, runtime: Runtime): readonly ParadisSemanticRange[] {
	if (value.length === 0 || value !== value.trim()) {
		throw new ParadisOfficePackageError('malformed');
	}
	const result: ParadisSemanticRange[] = [];
	let start = 0;
	for (let index = 0; index <= value.length; index++) {
		checkpoint(runtime);
		if (index < value.length && !/\s/.test(value[index])) { continue; }
		if (index === start) { throw new ParadisOfficePackageError('malformed'); }
		runtime.parsedRanges = safeAdd(runtime.parsedRanges, 1);
		if (runtime.parsedRanges > runtime.context.limits.ranges) { throw new ParadisOfficePackageError('limitExceeded'); }
		result.push(parseRange(value.slice(start, index)));
		while (index + 1 < value.length && /\s/.test(value[index + 1])) {
			checkpoint(runtime);
			index++;
		}
		start = index + 1;
	}
	return result;
}

function parseRange(value: string): ParadisSemanticRange {
	const parts = value.split(':');
	if (parts.length < 1 || parts.length > 2) {
		throw new ParadisOfficePackageError('malformed');
	}
	const start = parseCellReference(parts[0]);
	const end = parts[1] === undefined ? start : parseCellReference(parts[1]);
	const minRow = Math.min(start.row, end.row);
	const minColumn = Math.min(start.column, end.column);
	const maxRow = Math.max(start.row, end.row);
	const maxColumn = Math.max(start.column, end.column);
	return { ref: parts.length === 1 ? formatCellAddress(start.row, start.column) : `${formatCellAddress(start.row, start.column)}:${formatCellAddress(end.row, end.column)}`, minRow, minColumn, maxRow, maxColumn };
}

function parseCellReference(value: string): CellCoordinate {
	const match = /^\$?([A-Za-z]{1,3})\$?([1-9][0-9]{0,6})$/.exec(value);
	if (!match) {
		throw new ParadisOfficePackageError('malformed');
	}
	const column = columnNumber(match[1]);
	const row = Number(match[2]);
	if (column < 1 || column > maximumExcelColumns || row < 1 || row > maximumExcelRows) {
		throw new ParadisOfficePackageError('malformed');
	}
	return { row, column };
}

function columnNumber(value: string): number {
	let result = 0;
	for (const character of value.toUpperCase()) {
		result = result * 26 + character.charCodeAt(0) - 64;
	}
	return result;
}

function formatCellAddress(row: number, column: number): string {
	if (row < 1 || row > maximumExcelRows || column < 1 || column > maximumExcelColumns) {
		throw new ParadisOfficePackageError('malformed');
	}
	let remaining = column;
	let name = '';
	while (remaining > 0) {
		remaining--;
		name = String.fromCharCode(65 + remaining % 26) + name;
		remaining = Math.floor(remaining / 26);
	}
	return `${name}${row}`;
}

function matchingRangeAnchor(ranges: readonly ParadisSemanticRange[], coordinate: CellCoordinate, runtime?: Runtime): CellCoordinate | undefined {
	const anchor = ranges[0] ? { row: ranges[0].minRow, column: ranges[0].minColumn } : undefined;
	for (const range of ranges) {
		if (runtime) { consumeEvaluationOperations(runtime); }
		if (coordinate.row >= range.minRow && coordinate.row <= range.maxRow && coordinate.column >= range.minColumn && coordinate.column <= range.maxColumn) {
			return anchor;
		}
	}
	return undefined;
}

function chargeFormula(formula: string, runtime: Runtime): void {
	const bytes = utf8Length(formula);
	runtime.formulaBytes = safeAdd(runtime.formulaBytes, bytes);
	if (runtime.formulaBytes > runtime.context.limits.formulaBytes) {
		throw new ParadisOfficePackageError('limitExceeded');
	}
}

function utf8Length(value: string): number {
	let bytes = 0;
	for (let index = 0; index < value.length; index++) {
		const code = value.charCodeAt(index);
		if (code <= 0x7f) {
			bytes++;
		} else if (code <= 0x7ff) {
			bytes += 2;
		} else if (code >= 0xd800 && code <= 0xdbff && index + 1 < value.length && value.charCodeAt(index + 1) >= 0xdc00 && value.charCodeAt(index + 1) <= 0xdfff) {
			bytes += 4;
			index++;
		} else {
			bytes += 3;
		}
	}
	return bytes;
}

function verifyXmlSource(xml: string, source: ParadisSpreadsheetPartSource, runtime: Runtime): void {
	const fingerprint = sha256Xml(xml, runtime);
	if (fingerprint.value !== source.fingerprint.value || fingerprint.byteLength !== source.fingerprint.byteLength) {
		throw new ParadisOfficePackageError('unsafe');
	}
}

function sha256Xml(xml: string, runtime?: Runtime): ParadisSpreadsheetPartSource['fingerprint'] {
	const bytes = new TextEncoder().encode(xml);
	const paddedLength = Math.ceil((bytes.length + 9) / 64) * 64;
	const padded = new Uint8Array(paddedLength);
	padded.set(bytes);
	padded[bytes.length] = 0x80;
	const bitLength = bytes.length * 8;
	const view = new DataView(padded.buffer);
	view.setUint32(paddedLength - 8, Math.floor(bitLength / 0x1_0000_0000), false);
	view.setUint32(paddedLength - 4, bitLength >>> 0, false);
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
		for (let index = 0; index < 16; index++) {
			words[index] = view.getUint32(offset + index * 4, false);
		}
		for (let index = 16; index < 64; index++) {
			const a = words[index - 15];
			const b = words[index - 2];
			const s0 = rotateRight(a, 7) ^ rotateRight(a, 18) ^ (a >>> 3);
			const s1 = rotateRight(b, 17) ^ rotateRight(b, 19) ^ (b >>> 10);
			words[index] = (words[index - 16] + s0 + words[index - 7] + s1) >>> 0;
		}
		let [a, b, c, d, e, f, g, h] = state;
		for (let index = 0; index < 64; index++) {
			const s1 = rotateRight(e, 6) ^ rotateRight(e, 11) ^ rotateRight(e, 25);
			const choice = (e & f) ^ (~e & g);
			const temporary1 = (h + s1 + choice + constants[index] + words[index]) >>> 0;
			const s0 = rotateRight(a, 2) ^ rotateRight(a, 13) ^ rotateRight(a, 22);
			const majority = (a & b) ^ (a & c) ^ (b & c);
			const temporary2 = (s0 + majority) >>> 0;
			h = g; g = f; f = e; e = (d + temporary1) >>> 0; d = c; c = b; b = a; a = (temporary1 + temporary2) >>> 0;
		}
		state[0] = (state[0] + a) >>> 0; state[1] = (state[1] + b) >>> 0;
		state[2] = (state[2] + c) >>> 0; state[3] = (state[3] + d) >>> 0;
		state[4] = (state[4] + e) >>> 0; state[5] = (state[5] + f) >>> 0;
		state[6] = (state[6] + g) >>> 0; state[7] = (state[7] + h) >>> 0;
	}
	return { algorithm: 'sha256', value: [...state].map(value => value.toString(16).padStart(8, '0')).join(''), byteLength: bytes.length };
}

function rotateRight(value: number, bits: number): number {
	return (value >>> bits) | (value << (32 - bits));
}

function safeAdd(left: number, right: number): number {
	const result = left + right;
	if (!Number.isSafeInteger(result) || result < 0) {
		throw new ParadisOfficePackageError('limitExceeded');
	}
	return result;
}

function safeMultiply(left: number, right: number): number {
	const result = left * right;
	if (!Number.isSafeInteger(result) || result < 0) {
		throw new ParadisOfficePackageError('limitExceeded');
	}
	return result;
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

function deepFreeze<T>(value: T, runtime: Runtime): T {
	const seen = new WeakSet<object>();
	const stack: object[] = [];
	if (value && typeof value === 'object') {
		stack.push(value);
	}
	while (stack.length > 0) {
		checkpoint(runtime);
		const current = stack.pop()!;
		if (seen.has(current)) {
			continue;
		}
		seen.add(current);
		if (Object.isFrozen(current)) { continue; }
		runtime.outputNodes = safeAdd(runtime.outputNodes, 1);
		if (runtime.outputNodes > runtime.context.limits.outputNodes) { throw new ParadisOfficePackageError('limitExceeded'); }
		const keys: PropertyKey[] = [];
		if (Array.isArray(current)) {
			const length = Object.getOwnPropertyDescriptor(current, 'length')?.value;
			if (!Number.isSafeInteger(length) || length < 0) { throw new ParadisOfficePackageError('unsafe'); }
			for (let index = 0; index < length; index++) {
				checkpoint(runtime);
				keys.push(String(index));
			}
		} else {
			keys.push(...Reflect.ownKeys(current));
		}
		runtime.outputProperties = safeAdd(runtime.outputProperties, keys.length);
		if (runtime.outputProperties > runtime.context.limits.outputProperties) { throw new ParadisOfficePackageError('limitExceeded'); }
		for (const key of keys) {
			checkpoint(runtime);
			const child = Object.getOwnPropertyDescriptor(current, key)?.value;
			if (child && typeof child === 'object') {
				stack.push(child);
			}
		}
		Object.freeze(current);
	}
	return value;
}

function sanitizeConditionalFormattingError(error: unknown): ParadisOfficePackageError {
	try {
		if (error instanceof ParadisOfficePackageError) {
			const code = Object.getOwnPropertyDescriptor(error, 'code')?.value;
			if (code === 'invalid' || code === 'encrypted' || code === 'zipBomb' || code === 'limitExceeded'
				|| code === 'malformed' || code === 'cancelled' || code === 'unsafe') {
				return new ParadisOfficePackageError(code);
			}
		}
	} catch { /* Poisoned errors are reduced to a local safe value. */ }
	return new ParadisOfficePackageError('unsafe');
}
