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
import type {
	ParadisSemanticRichTextProperties,
	ParadisSemanticRichTextRun,
	ParadisSemanticRange,
	ParadisSpreadsheetAnnotations,
	ParadisSpreadsheetCellAnnotationOverlay,
	ParadisSpreadsheetCommentContent,
	ParadisSpreadsheetHyperlink,
	ParadisSpreadsheetHyperlinkTarget,
	ParadisSpreadsheetLegacyNote,
	ParadisSpreadsheetLegacyNoteAnchor,
	ParadisSpreadsheetOpaqueAnnotationFragment,
	ParadisSpreadsheetPartSource,
	ParadisSpreadsheetPerson,
	ParadisSpreadsheetTextIdentity,
	ParadisSpreadsheetThreadedComment,
	ParadisSpreadsheetValidation,
	ParadisSpreadsheetValidationErrorStyle,
	ParadisSpreadsheetValidationOperator,
} from './paradisSpreadsheetSemantic.js';

export type {
	ParadisSpreadsheetAnnotations,
	ParadisSpreadsheetHyperlink,
	ParadisSpreadsheetLegacyNote,
	ParadisSpreadsheetPerson,
	ParadisSpreadsheetThreadedComment,
	ParadisSpreadsheetValidation,
} from './paradisSpreadsheetSemantic.js';

type XmlElement = Extract<ParadisOfficeXmlNode, { readonly kind: 'element' }>;

const spreadsheetNamespaces = new Set([
	'http://schemas.openxmlformats.org/spreadsheetml/2006/main',
	'http://purl.oclc.org/ooxml/spreadsheetml/main',
]);
const officeRelationshipNamespace = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';
const strictOfficeRelationshipNamespace = 'http://purl.oclc.org/ooxml/officeDocument/relationships';
const officeRelationshipNamespaces = new Set([officeRelationshipNamespace, strictOfficeRelationshipNamespace]);
const packageRelationshipNamespace = 'http://schemas.openxmlformats.org/package/2006/relationships';
const contentTypeNamespace = 'http://schemas.openxmlformats.org/package/2006/content-types';
const markupCompatibilityNamespace = 'http://schemas.openxmlformats.org/markup-compatibility/2006';
const spreadsheetRevisionNamespace = 'http://schemas.microsoft.com/office/spreadsheetml/2014/revision';
const x14Namespace = 'http://schemas.microsoft.com/office/spreadsheetml/2009/9/main';
const x14ValidationExtensionUri = '{CCE6A557-97BC-4B89-ADB6-D9C93CAAB3DF}';
const xmNamespace = 'http://schemas.microsoft.com/office/excel/2006/main';
const threadedNamespace = 'http://schemas.microsoft.com/office/spreadsheetml/2018/threadedcomments';
const vmlNamespace = 'urn:schemas-microsoft-com:vml';
const excelNamespace = 'urn:schemas-microsoft-com:office:excel';
const xmlNamespace = 'http://www.w3.org/XML/1998/namespace';
const maximumExcelRows = 1_048_576;
const maximumExcelColumns = 16_384;
const maximumDeadlineMilliseconds = 60_000;
const parsedAnnotationModels = new WeakSet<object>();

const relationshipTypes = Object.freeze({
	officeDocument: 'officeDocument',
	worksheet: 'worksheet',
	comments: 'comments',
	vml: 'vmlDrawing',
	hyperlink: 'hyperlink',
	threaded: 'http://schemas.microsoft.com/office/2017/10/relationships/threadedComment',
	person: 'person',
});

const contentTypes = Object.freeze({
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
	comments: new Set(['application/vnd.openxmlformats-officedocument.spreadsheetml.comments+xml']),
	vml: new Set(['application/vnd.openxmlformats-officedocument.vmlDrawing']),
	threaded: new Set(['application/vnd.ms-excel.threadedcomments+xml']),
	persons: new Set(['application/vnd.ms-excel.person+xml']),
});

export interface ParadisSpreadsheetAnnotationsLimits {
	readonly xmlCharacters: number;
	readonly xmlDepth: number;
	readonly xmlNodes: number;
	readonly attributeLength: number;
	readonly validations: number;
	readonly ranges: number;
	readonly comments: number;
	readonly persons: number;
	readonly hyperlinks: number;
	readonly relationships: number;
	readonly formulas: number;
	readonly formulaCharacters: number;
	readonly textCharacters: number;
	readonly textValueCharacters: number;
	readonly targetCharacters: number;
	readonly opaqueFragments: number;
	readonly opaqueCharacters: number;
	readonly outputNodes: number;
	readonly outputProperties: number;
}

const commonLimits = {
	validations: 100_000,
	ranges: 100_000,
	comments: 100_000,
	persons: 100_000,
	hyperlinks: 100_000,
	relationships: 100_000,
	formulas: 200_000,
	formulaCharacters: 8 * 1024 * 1024,
	textCharacters: 24 * 1024 * 1024,
	textValueCharacters: 32_767,
	targetCharacters: 8_192,
	opaqueFragments: 100_000,
	opaqueCharacters: 24 * 1024 * 1024,
	outputNodes: 1_000_000,
	outputProperties: 2_000_000,
};
const limitsByProfile = Object.freeze({
	desktop: { ...commonLimits, xmlCharacters: 64 * 1024 * 1024, xmlDepth: 128, xmlNodes: 2_000_000, attributeLength: 1024 * 1024 },
	remote: { ...commonLimits, xmlCharacters: 32 * 1024 * 1024, xmlDepth: 96, xmlNodes: 1_000_000, attributeLength: 512 * 1024 },
	browser: { ...commonLimits, xmlCharacters: 24 * 1024 * 1024, xmlDepth: 96, xmlNodes: 750_000, attributeLength: 512 * 1024 },
} satisfies Record<string, ParadisSpreadsheetAnnotationsLimits>);
const defaultLimits = limitsByProfile.browser;
const limitKeys = Object.freeze(Object.keys(defaultLimits) as (keyof ParadisSpreadsheetAnnotationsLimits)[]);

export interface ParadisSpreadsheetAnnotationsContext {
	readonly profile?: 'desktop' | 'remote' | 'browser';
	readonly cancellationToken?: CancellationToken;
	readonly now?: () => number;
	readonly deadlineMilliseconds?: number;
	readonly limits?: Partial<ParadisSpreadsheetAnnotationsLimits>;
}

export interface ParadisSpreadsheetAnnotationsInput {
	readonly contentTypesXml: string;
	readonly contentTypesBytes?: Uint8Array;
	readonly contentTypesSource: ParadisSpreadsheetPartSource;
	readonly rootRelationshipsXml: string;
	readonly rootRelationshipsBytes?: Uint8Array;
	readonly rootRelationshipsSource: ParadisSpreadsheetPartSource;
	readonly workbookXml: string;
	readonly workbookBytes?: Uint8Array;
	readonly workbookSource: ParadisSpreadsheetPartSource;
	readonly worksheetXml: string;
	readonly worksheetBytes?: Uint8Array;
	readonly worksheetSource: ParadisSpreadsheetPartSource;
	readonly worksheetRelationshipsXml: string;
	readonly worksheetRelationshipsBytes?: Uint8Array;
	readonly worksheetRelationshipsSource: ParadisSpreadsheetPartSource;
	readonly workbookRelationshipsXml: string;
	readonly workbookRelationshipsBytes?: Uint8Array;
	readonly workbookRelationshipsSource: ParadisSpreadsheetPartSource;
	readonly commentsXml?: string;
	readonly commentsBytes?: Uint8Array;
	readonly commentsSource?: ParadisSpreadsheetPartSource;
	readonly vmlDrawingXml?: string;
	readonly vmlDrawingBytes?: Uint8Array;
	readonly vmlDrawingSource?: ParadisSpreadsheetPartSource;
	readonly vmlDrawingRelationshipsXml?: string;
	readonly vmlDrawingRelationshipsBytes?: Uint8Array;
	readonly vmlDrawingRelationshipsSource?: ParadisSpreadsheetPartSource;
	readonly threadedCommentsXml?: string;
	readonly threadedCommentsBytes?: Uint8Array;
	readonly threadedCommentsSource?: ParadisSpreadsheetPartSource;
	readonly personsXml?: string;
	readonly personsBytes?: Uint8Array;
	readonly personsSource?: ParadisSpreadsheetPartSource;
}

/** @internal Documents whose all-byte PartSource was already verified by the Task 1 package parser. */
export interface ParadisSpreadsheetVerifiedAnnotationsInput {
	readonly contentTypesDocument: ParadisOfficeXmlDocument;
	readonly contentTypesBytes: Uint8Array;
	readonly contentTypesSource: ParadisSpreadsheetPartSource;
	readonly rootRelationshipsDocument: ParadisOfficeXmlDocument;
	readonly rootRelationshipsBytes: Uint8Array;
	readonly rootRelationshipsSource: ParadisSpreadsheetPartSource;
	readonly workbookDocument: ParadisOfficeXmlDocument;
	readonly workbookBytes: Uint8Array;
	readonly workbookSource: ParadisSpreadsheetPartSource;
	readonly worksheetDocument: ParadisOfficeXmlDocument;
	readonly worksheetBytes: Uint8Array;
	readonly worksheetSource: ParadisSpreadsheetPartSource;
	readonly worksheetRelationshipsDocument: ParadisOfficeXmlDocument;
	readonly worksheetRelationshipsBytes: Uint8Array;
	readonly worksheetRelationshipsSource: ParadisSpreadsheetPartSource;
	readonly workbookRelationshipsDocument: ParadisOfficeXmlDocument;
	readonly workbookRelationshipsBytes: Uint8Array;
	readonly workbookRelationshipsSource: ParadisSpreadsheetPartSource;
	readonly commentsDocument?: ParadisOfficeXmlDocument;
	readonly commentsBytes?: Uint8Array;
	readonly commentsSource?: ParadisSpreadsheetPartSource;
	readonly vmlDrawingDocument?: ParadisOfficeXmlDocument;
	readonly vmlDrawingBytes?: Uint8Array;
	readonly vmlDrawingSource?: ParadisSpreadsheetPartSource;
	readonly vmlDrawingRelationshipsDocument?: ParadisOfficeXmlDocument;
	readonly vmlDrawingRelationshipsBytes?: Uint8Array;
	readonly vmlDrawingRelationshipsSource?: ParadisSpreadsheetPartSource;
	readonly threadedCommentsDocument?: ParadisOfficeXmlDocument;
	readonly threadedCommentsBytes?: Uint8Array;
	readonly threadedCommentsSource?: ParadisSpreadsheetPartSource;
	readonly personsDocument?: ParadisOfficeXmlDocument;
	readonly personsBytes?: Uint8Array;
	readonly personsSource?: ParadisSpreadsheetPartSource;
}

interface OwnedContext {
	readonly profile: 'desktop' | 'remote' | 'browser';
	readonly cancellationToken?: CancellationToken;
	readonly now: () => number;
	readonly deadlineMilliseconds: number;
	readonly limits: ParadisSpreadsheetAnnotationsLimits;
}

interface Runtime {
	readonly context: OwnedContext;
	readonly hardDeadline: StopWatch;
	readonly started: number;
	upstreamCheckpoint?: () => void;
	lastClock: number;
	checks: number;
	ranges: number;
	comments: number;
	formulaCharacters: number;
	formulas: number;
	textCharacters: number;
	opaqueFragments: number;
	opaqueCharacters: number;
	outputNodes: number;
	outputProperties: number;
	verifiedXmlNodes: number;
	verifiedXmlCharacters: number;
	readonly relationshipScopes: Map<string, ReadonlyMap<string, string>>;
	readonly nodeLocations: WeakMap<object, { readonly parent?: XmlElement; readonly ordinal: number }>;
}

interface OwnedDocuments {
	readonly contentTypesDocument: ParadisOfficeXmlDocument;
	readonly contentTypesSource: ParadisSpreadsheetPartSource;
	readonly rootRelationshipsDocument: ParadisOfficeXmlDocument;
	readonly rootRelationshipsSource: ParadisSpreadsheetPartSource;
	readonly workbookDocument: ParadisOfficeXmlDocument;
	readonly workbookSource: ParadisSpreadsheetPartSource;
	readonly worksheetDocument: ParadisOfficeXmlDocument;
	readonly worksheetSource: ParadisSpreadsheetPartSource;
	readonly worksheetRelationshipsDocument: ParadisOfficeXmlDocument;
	readonly worksheetRelationshipsSource: ParadisSpreadsheetPartSource;
	readonly workbookRelationshipsDocument: ParadisOfficeXmlDocument;
	readonly workbookRelationshipsSource: ParadisSpreadsheetPartSource;
	readonly commentsDocument?: ParadisOfficeXmlDocument;
	readonly commentsSource?: ParadisSpreadsheetPartSource;
	readonly vmlDrawingDocument?: ParadisOfficeXmlDocument;
	readonly vmlDrawingSource?: ParadisSpreadsheetPartSource;
	readonly vmlDrawingRelationshipsDocument?: ParadisOfficeXmlDocument;
	readonly vmlDrawingRelationshipsSource?: ParadisSpreadsheetPartSource;
	readonly threadedCommentsDocument?: ParadisOfficeXmlDocument;
	readonly threadedCommentsSource?: ParadisSpreadsheetPartSource;
	readonly personsDocument?: ParadisOfficeXmlDocument;
	readonly personsSource?: ParadisSpreadsheetPartSource;
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

/** Computes the exact UTF-8 identity, including a leading BOM when present. */
export function fingerprintSpreadsheetAnnotationsXml(xml: string): ParadisSpreadsheetPartSource['fingerprint'] {
	try {
		if (typeof xml !== 'string' || xml.length > defaultLimits.xmlCharacters) {
			throw new ParadisOfficePackageError(typeof xml === 'string' ? 'limitExceeded' : 'unsafe');
		}
		const fingerprint = sha256Text(xml);
		if (fingerprint.byteLength > defaultLimits.xmlCharacters) { throw new ParadisOfficePackageError('limitExceeded'); }
		return fingerprint;
	} catch (error) {
		throw sanitizeAnnotationsError(error);
	}
}

/** Computes an identity over the actual Part bytes, independent of XML encoding. */
export function fingerprintSpreadsheetAnnotationsBytes(bytes: Uint8Array): ParadisSpreadsheetPartSource['fingerprint'] {
	try {
		return sha256Bytes(ownBytes(bytes, defaultLimits.xmlCharacters));
	} catch (error) {
		throw sanitizeAnnotationsError(error);
	}
}

/** Parses exact raw OOXML strings and verifies every supplied all-byte PartSource before XML parsing. */
export function parseSpreadsheetAnnotations(
	input: ParadisSpreadsheetAnnotationsInput,
	context: ParadisSpreadsheetAnnotationsContext = {},
): ParadisSpreadsheetAnnotations {
	const hardDeadline = StopWatch.create(true);
	try {
		const runtime = createRuntime(ownContext(context), hardDeadline);
		const owned = ownRawInput(input, runtime);
		const documents = parseRawDocuments(owned, runtime);
		return buildAnnotations(documents, runtime);
	} catch (error) {
		throw sanitizeAnnotationsError(error);
	}
}

/** @internal Consumes already byte-verified canonical documents and immediately owns their graph. */
export function parseSpreadsheetAnnotationsVerifiedDocuments(
	input: ParadisSpreadsheetVerifiedAnnotationsInput,
	upstreamCheckpoint: () => void,
	context: ParadisSpreadsheetAnnotationsContext = {},
): ParadisSpreadsheetAnnotations {
	const hardDeadline = StopWatch.create(true);
	try {
		if (typeof upstreamCheckpoint !== 'function') {
			throw new ParadisOfficePackageError('unsafe');
		}
		const runtime = createRuntime(ownContext(context), hardDeadline);
		const documents = ownVerifiedInput(input, runtime);
		runtime.upstreamCheckpoint = upstreamCheckpoint;
		checkpoint(runtime, true);
		return buildAnnotations(documents, runtime);
	} catch (error) {
		throw sanitizeAnnotationsError(error);
	}
}

/** Binds parser-issued overlays to existing cells without reading or replacing base style state. */
export function bindSpreadsheetAnnotationOverlays(
	model: ParadisSpreadsheetAnnotations,
	cells: ReadonlyMap<string, unknown>,
): readonly ParadisSpreadsheetCellAnnotationOverlay[] {
	try {
		if (!model || typeof model !== 'object' || !parsedAnnotationModels.has(model)
			|| !(cells instanceof Map) || Object.getPrototypeOf(cells) !== Map.prototype) {
			throw new ParadisOfficePackageError('unsafe');
		}
		const result: ParadisSpreadsheetCellAnnotationOverlay[] = [];
		for (const overlay of model.cellOverlays) {
			if (Map.prototype.has.call(cells, overlay.ref)) { result.push(overlay); }
		}
		return Object.freeze(result);
	} catch (error) {
		throw sanitizeAnnotationsError(error);
	}
}

function ownContext(value: unknown): OwnedContext {
	const record = ownRecord(value, new Set(['profile', 'cancellationToken', 'now', 'deadlineMilliseconds', 'limits']));
	const limitsRecord = record.limits === undefined ? undefined : ownRecord(record.limits, new Set(limitKeys));
	const profile = record.profile ?? 'browser';
	if (profile !== 'desktop' && profile !== 'remote' && profile !== 'browser') {
		throw new ParadisOfficePackageError('unsafe');
	}
	const maximumLimits = limitsByProfile[profile];
	const limits = { ...maximumLimits };
	for (const key of limitKeys) {
		const candidate = limitsRecord?.[key];
		if (candidate !== undefined) {
			if (!Number.isSafeInteger(candidate) || (candidate as number) < 1 || (candidate as number) > maximumLimits[key]) {
				throw new ParadisOfficePackageError('limitExceeded');
			}
			limits[key] = candidate as number;
		}
	}
	const now = record.now ?? Date.now;
	if (typeof now !== 'function') {
		throw new ParadisOfficePackageError('unsafe');
	}
	const maximumDeadline = profile === 'browser' ? 45_000 : maximumDeadlineMilliseconds;
	const deadlineMilliseconds = record.deadlineMilliseconds ?? maximumDeadline;
	if (!Number.isSafeInteger(deadlineMilliseconds) || (deadlineMilliseconds as number) < 0 || (deadlineMilliseconds as number) > maximumDeadline) {
		throw new ParadisOfficePackageError('limitExceeded');
	}
	const cancellationToken = record.cancellationToken;
	if (cancellationToken !== undefined && (!cancellationToken || typeof cancellationToken !== 'object')) {
		throw new ParadisOfficePackageError('unsafe');
	}
	return {
		profile,
		...(cancellationToken ? { cancellationToken: cancellationToken as CancellationToken } : {}),
		now: now as () => number,
		deadlineMilliseconds: deadlineMilliseconds as number,
		limits,
	};
}

function createRuntime(context: OwnedContext, hardDeadline: StopWatch, upstreamCheckpoint?: () => void): Runtime {
	const started = readClock(context.now);
	const runtime: Runtime = {
		context, hardDeadline, started, lastClock: started, checks: 0, ranges: 0, comments: 0,
		formulaCharacters: 0, formulas: 0, textCharacters: 0, opaqueFragments: 0, opaqueCharacters: 0,
		outputNodes: 0, outputProperties: 0,
		verifiedXmlNodes: 0, verifiedXmlCharacters: 0, relationshipScopes: new Map(), nodeLocations: new WeakMap(),
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

function readClock(now: () => number): number {
	const value = now();
	if (!Number.isFinite(value) || value < 0) {
		throw new ParadisOfficePackageError('unsafe');
	}
	return value;
}

function ownRawInput(input: unknown, runtime: Runtime): ParadisSpreadsheetAnnotationsInput {
	const parts = [
		['contentTypesXml', 'contentTypesBytes', 'contentTypesSource'],
		['rootRelationshipsXml', 'rootRelationshipsBytes', 'rootRelationshipsSource'],
		['workbookXml', 'workbookBytes', 'workbookSource'],
		['worksheetXml', 'worksheetBytes', 'worksheetSource'],
		['worksheetRelationshipsXml', 'worksheetRelationshipsBytes', 'worksheetRelationshipsSource'],
		['workbookRelationshipsXml', 'workbookRelationshipsBytes', 'workbookRelationshipsSource'],
		['commentsXml', 'commentsBytes', 'commentsSource'],
		['vmlDrawingXml', 'vmlDrawingBytes', 'vmlDrawingSource'],
		['vmlDrawingRelationshipsXml', 'vmlDrawingRelationshipsBytes', 'vmlDrawingRelationshipsSource'],
		['threadedCommentsXml', 'threadedCommentsBytes', 'threadedCommentsSource'],
		['personsXml', 'personsBytes', 'personsSource'],
	] as const;
	const record = ownRecord(input, new Set(parts.flat()));
	const result: Record<string, unknown> = {};
	for (let index = 0; index < parts.length; index++) {
		checkpoint(runtime);
		const [xmlName, bytesName, sourceName] = parts[index];
		const required = index < 6;
		const xml = record[xmlName];
		const byteValue = record[bytesName];
		const sourceValue = record[sourceName];
		if ((xml === undefined) !== (sourceValue === undefined) || required && xml === undefined) {
			throw new ParadisOfficePackageError('unsafe');
		}
		if (xml === undefined) {
			continue;
		}
		if (typeof xml !== 'string' || xml.length > runtime.context.limits.xmlCharacters) {
			throw new ParadisOfficePackageError(typeof xml === 'string' ? 'limitExceeded' : 'unsafe');
		}
		const source = ownPartSource(sourceValue);
		const bytes = byteValue === undefined ? undefined : ownBytes(byteValue, runtime.context.limits.xmlCharacters);
		if (bytes) { verifyByteSource(bytes, source, runtime); } else { verifyXmlSource(xml, source, runtime); }
		result[xmlName] = xml;
		if (bytes) { result[bytesName] = bytes; }
		result[sourceName] = source;
	}
	return result as unknown as ParadisSpreadsheetAnnotationsInput;
}

function parseRawDocuments(input: ParadisSpreadsheetAnnotationsInput, runtime: Runtime): OwnedDocuments {
	const parse = (xml: string, bytes?: Uint8Array): ParadisOfficeXmlDocument => {
		const decodedDocument = parseParadisOfficeXml(xml.startsWith('\uFEFF') ? xml.slice(1) : xml, {
			depth: runtime.context.limits.xmlDepth,
			nodes: runtime.context.limits.xmlNodes,
			attributeLength: runtime.context.limits.attributeLength,
			characters: runtime.context.limits.xmlCharacters,
		}, runtime.context.cancellationToken, () => checkpoint(runtime));
		if (!bytes) { return decodedDocument; }
		const authoritativeDocument = parseVerifiedBytes(bytes, runtime);
		if (!xmlDocumentsEqual(decodedDocument, authoritativeDocument, runtime)) {
			throw new ParadisOfficePackageError('unsafe');
		}
		return authoritativeDocument;
	};
	return {
		contentTypesDocument: parse(input.contentTypesXml, input.contentTypesBytes), contentTypesSource: input.contentTypesSource,
		rootRelationshipsDocument: parse(input.rootRelationshipsXml, input.rootRelationshipsBytes), rootRelationshipsSource: input.rootRelationshipsSource,
		workbookDocument: parse(input.workbookXml, input.workbookBytes), workbookSource: input.workbookSource,
		worksheetDocument: parse(input.worksheetXml, input.worksheetBytes), worksheetSource: input.worksheetSource,
		worksheetRelationshipsDocument: parse(input.worksheetRelationshipsXml, input.worksheetRelationshipsBytes), worksheetRelationshipsSource: input.worksheetRelationshipsSource,
		workbookRelationshipsDocument: parse(input.workbookRelationshipsXml, input.workbookRelationshipsBytes), workbookRelationshipsSource: input.workbookRelationshipsSource,
		...(input.commentsXml ? { commentsDocument: parse(input.commentsXml, input.commentsBytes), commentsSource: input.commentsSource! } : {}),
		...(input.vmlDrawingXml ? { vmlDrawingDocument: parse(input.vmlDrawingXml, input.vmlDrawingBytes), vmlDrawingSource: input.vmlDrawingSource! } : {}),
		...(input.vmlDrawingRelationshipsXml ? { vmlDrawingRelationshipsDocument: parse(input.vmlDrawingRelationshipsXml, input.vmlDrawingRelationshipsBytes), vmlDrawingRelationshipsSource: input.vmlDrawingRelationshipsSource! } : {}),
		...(input.threadedCommentsXml ? { threadedCommentsDocument: parse(input.threadedCommentsXml, input.threadedCommentsBytes), threadedCommentsSource: input.threadedCommentsSource! } : {}),
		...(input.personsXml ? { personsDocument: parse(input.personsXml, input.personsBytes), personsSource: input.personsSource! } : {}),
	};
}

function ownVerifiedInput(input: unknown, runtime: Runtime): OwnedDocuments {
	const parts = [
		['contentTypesDocument', 'contentTypesBytes', 'contentTypesSource'],
		['rootRelationshipsDocument', 'rootRelationshipsBytes', 'rootRelationshipsSource'],
		['workbookDocument', 'workbookBytes', 'workbookSource'],
		['worksheetDocument', 'worksheetBytes', 'worksheetSource'],
		['worksheetRelationshipsDocument', 'worksheetRelationshipsBytes', 'worksheetRelationshipsSource'],
		['workbookRelationshipsDocument', 'workbookRelationshipsBytes', 'workbookRelationshipsSource'],
		['commentsDocument', 'commentsBytes', 'commentsSource'],
		['vmlDrawingDocument', 'vmlDrawingBytes', 'vmlDrawingSource'],
		['vmlDrawingRelationshipsDocument', 'vmlDrawingRelationshipsBytes', 'vmlDrawingRelationshipsSource'],
		['threadedCommentsDocument', 'threadedCommentsBytes', 'threadedCommentsSource'],
		['personsDocument', 'personsBytes', 'personsSource'],
	] as const;
	const record = ownRecord(input, new Set(parts.flat()));
	const result: Record<string, unknown> = {};
	for (let index = 0; index < parts.length; index++) {
		checkpoint(runtime);
		const [documentName, bytesName, sourceName] = parts[index];
		const required = index < 6;
		const document = record[documentName];
		const bytes = record[bytesName];
		const source = record[sourceName];
		if ((document === undefined) !== (source === undefined) || (document === undefined) !== (bytes === undefined) || required && document === undefined) {
			throw new ParadisOfficePackageError('unsafe');
		}
		if (document !== undefined) {
			const ownedSource = ownPartSource(source);
			const ownedBytes = ownBytes(bytes, runtime.context.limits.xmlCharacters, runtime);
			verifyByteSource(ownedBytes, ownedSource, runtime);
			const ownedDocument = ownXmlDocument(document, runtime);
			const authoritativeDocument = parseVerifiedBytes(ownedBytes, runtime);
			if (!xmlDocumentsEqual(ownedDocument, authoritativeDocument, runtime)) {
				throw new ParadisOfficePackageError('unsafe');
			}
			result[documentName] = authoritativeDocument;
			result[sourceName] = ownedSource;
		}
	}
	return result as unknown as OwnedDocuments;
}

function ownXmlDocument(value: unknown, runtime: Runtime): ParadisOfficeXmlDocument {
	runtime.verifiedXmlNodes = 0;
	runtime.verifiedXmlCharacters = 0;
	const record = ownRecord(value, new Set(['root']));
	return { root: ownXmlElement(record.root, runtime, new WeakSet(), 1) };
}

function ownXmlElement(value: unknown, runtime: Runtime, seen: WeakSet<object>, depth: number): XmlElement {
	if (depth > runtime.context.limits.xmlDepth || !value || typeof value !== 'object' || seen.has(value)) {
		throw new ParadisOfficePackageError(depth > runtime.context.limits.xmlDepth ? 'limitExceeded' : 'unsafe');
	}
	seen.add(value);
	consumeVerifiedXmlNode(runtime);
	const record = ownRecord(value, new Set(['kind', 'uri', 'local', 'attributes', 'children', 'namespaceBindings']));
	if (record.kind !== 'element' || typeof record.uri !== 'string' || typeof record.local !== 'string') {
		throw new ParadisOfficePackageError('unsafe');
	}
	const attributes = ownArray(record.attributes, runtime.context.limits.xmlNodes, runtime).map(candidate => {
		const attribute = ownRecord(candidate, new Set(['uri', 'local', 'value']));
		if (typeof attribute.uri !== 'string' || typeof attribute.local !== 'string' || typeof attribute.value !== 'string'
			|| attribute.value.length > runtime.context.limits.attributeLength) {
			throw new ParadisOfficePackageError('unsafe');
		}
		return { uri: attribute.uri, local: attribute.local, value: attribute.value };
	});
	const children: ParadisOfficeXmlNode[] = [];
	for (const candidate of ownArray(record.children, runtime.context.limits.xmlNodes, runtime)) {
		checkpoint(runtime);
		if (!candidate || typeof candidate !== 'object') {
			throw new ParadisOfficePackageError('unsafe');
		}
		const kind = Object.getOwnPropertyDescriptor(candidate, 'kind');
		if (!kind || !Object.prototype.hasOwnProperty.call(kind, 'value')) {
			throw new ParadisOfficePackageError('unsafe');
		}
		if (kind.value === 'element') {
			children.push(ownXmlElement(candidate, runtime, seen, depth + 1));
		} else if (kind.value === 'text') {
			const text = ownRecord(candidate, new Set(['kind', 'value']));
			if (typeof text.value !== 'string') {
				throw new ParadisOfficePackageError('unsafe');
			}
			consumeVerifiedXmlNode(runtime);
			runtime.verifiedXmlCharacters = safeAdd(runtime.verifiedXmlCharacters, text.value.length);
			if (runtime.verifiedXmlCharacters > runtime.context.limits.xmlCharacters) {
				throw new ParadisOfficePackageError('limitExceeded');
			}
			children.push({ kind: 'text', value: text.value });
		} else {
			throw new ParadisOfficePackageError('unsafe');
		}
	}
	return { kind: 'element', uri: record.uri, local: record.local, attributes, children };
}

function consumeVerifiedXmlNode(runtime: Runtime): void {
	runtime.verifiedXmlNodes = safeAdd(runtime.verifiedXmlNodes, 1);
	if (runtime.verifiedXmlNodes > runtime.context.limits.xmlNodes) {
		throw new ParadisOfficePackageError('limitExceeded');
	}
}

function parseVerifiedBytes(bytes: Uint8Array, runtime: Runtime): ParadisOfficeXmlDocument {
	let encoding = 'utf-8';
	let offset = 0;
	if (bytes.length >= 2 && bytes[0] === 0xff && bytes[1] === 0xfe) {
		encoding = 'utf-16le'; offset = 2;
	} else if (bytes.length >= 2 && bytes[0] === 0xfe && bytes[1] === 0xff) {
		encoding = 'utf-16be'; offset = 2;
	} else if (bytes.length >= 3 && bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) {
		offset = 3;
	}
	let xml: string;
	try {
		xml = new TextDecoder(encoding, { fatal: true }).decode(bytes.subarray(offset));
	} catch {
		throw new ParadisOfficePackageError('malformed');
	}
	if (xml.startsWith('\uFEFF')) { xml = xml.slice(1); }
	return parseParadisOfficeXml(xml, {
		depth: runtime.context.limits.xmlDepth,
		nodes: runtime.context.limits.xmlNodes,
		attributeLength: runtime.context.limits.attributeLength,
		characters: runtime.context.limits.xmlCharacters,
	}, runtime.context.cancellationToken, () => checkpoint(runtime));
}

function xmlDocumentsEqual(left: ParadisOfficeXmlDocument, right: ParadisOfficeXmlDocument, runtime: Runtime): boolean {
	const stack: Array<readonly [ParadisOfficeXmlNode, ParadisOfficeXmlNode]> = [[left.root, right.root]];
	while (stack.length > 0) {
		checkpoint(runtime);
		const [leftNode, rightNode] = stack.pop()!;
		if (leftNode.kind !== rightNode.kind) { return false; }
		if (leftNode.kind === 'text' && rightNode.kind === 'text') {
			if (leftNode.value !== rightNode.value) { return false; }
			continue;
		}
		if (leftNode.kind !== 'element' || rightNode.kind !== 'element'
			|| leftNode.uri !== rightNode.uri || leftNode.local !== rightNode.local
			|| leftNode.attributes.length !== rightNode.attributes.length || leftNode.children.length !== rightNode.children.length) {
			return false;
		}
		const leftAttributes = [...leftNode.attributes].sort(compareXmlAttributes);
		const rightAttributes = [...rightNode.attributes].sort(compareXmlAttributes);
		for (let index = 0; index < leftAttributes.length; index++) {
			if (leftAttributes[index].uri !== rightAttributes[index].uri || leftAttributes[index].local !== rightAttributes[index].local
				|| leftAttributes[index].value !== rightAttributes[index].value) {
				return false;
			}
		}
		for (let index = leftNode.children.length - 1; index >= 0; index--) {
			stack.push([leftNode.children[index], rightNode.children[index]]);
		}
	}
	return true;
}

function compareXmlAttributes(
	left: { readonly uri: string; readonly local: string },
	right: { readonly uri: string; readonly local: string },
): number {
	return compareCodePoint(`${left.uri}\0${left.local}`, `${right.uri}\0${right.local}`);
}

function buildAnnotations(input: OwnedDocuments, runtime: Runtime): ParadisSpreadsheetAnnotations {
	validateSourceLocations(input);
	const typeMap = parseContentTypes(input.contentTypesDocument, runtime);
	validateContentType(input.workbookSource.partId, contentTypes.workbook, typeMap);
	validateContentType(input.worksheetSource.partId, contentTypes.worksheet, typeMap);
	spreadsheetRoot(input.workbookDocument, 'workbook');
	const rootRelationships = parseRelationships(input.rootRelationshipsDocument, '/', runtime);
	validateRootWorkbookAuthority(input.workbookSource, rootRelationships);
	const worksheetRelationships = parseRelationships(input.worksheetRelationshipsDocument, input.worksheetSource.partId, runtime);
	const worksheetTargets = new Map<string, string>();
	for (const relationship of worksheetRelationships) {
		checkpoint(runtime);
		worksheetTargets.set(relationship.id, relationship.resolvedTarget ?? normalizeExternalRelationshipIdentity(relationship.target));
	}
	runtime.relationshipScopes.set(input.worksheetSource.partId, worksheetTargets);
	if ((input.vmlDrawingRelationshipsSource === undefined) !== (input.vmlDrawingRelationshipsDocument === undefined)
		|| input.vmlDrawingRelationshipsSource !== undefined && input.vmlDrawingSource === undefined) {
		throw new ParadisOfficePackageError('unsafe');
	}
	if (input.vmlDrawingSource && input.vmlDrawingRelationshipsDocument) {
		const vmlRelationships = parseRelationships(input.vmlDrawingRelationshipsDocument, input.vmlDrawingSource.partId, runtime);
		const vmlTargets = new Map<string, string>();
		for (const relationship of vmlRelationships) {
			checkpoint(runtime);
			vmlTargets.set(relationship.id, relationship.resolvedTarget ?? normalizeExternalRelationshipIdentity(relationship.target));
		}
		runtime.relationshipScopes.set(input.vmlDrawingSource.partId, vmlTargets);
	}
	const workbookOwner = relationshipOwner(input.workbookRelationshipsSource.partId);
	const workbookRelationships = parseRelationships(input.workbookRelationshipsDocument, workbookOwner, runtime);
	validateWorkbookWorksheetAuthority(input.workbookDocument, input.worksheetSource, workbookRelationships, runtime);
	validateSupplementalAuthority(input, typeMap, worksheetRelationships, workbookRelationships);

	const opaqueFragments: ParadisSpreadsheetOpaqueAnnotationFragment[] = [];
	const { validations, legacyDrawingRelationshipId, hyperlinks } = parseWorksheet(
		input.worksheetDocument,
		input.worksheetSource,
		input.worksheetRelationshipsSource,
		worksheetRelationships,
		opaqueFragments,
		runtime,
	);
	const anchors = input.vmlDrawingDocument && input.vmlDrawingSource
		? parseVmlAnchors(input.vmlDrawingDocument, input.vmlDrawingSource, opaqueFragments, runtime)
		: new Map<string, ParadisSpreadsheetLegacyNoteAnchor>();
	if (input.vmlDrawingSource) {
		validateLegacyDrawingReference(legacyDrawingRelationshipId, input.vmlDrawingSource, worksheetRelationships);
	} else if (legacyDrawingRelationshipId !== undefined) {
		throw new ParadisOfficePackageError('unsafe');
	}
	const legacyNotes = input.commentsDocument && input.commentsSource
		? parseLegacyNotes(input.commentsDocument, input.commentsSource, anchors, opaqueFragments, runtime)
		: [];
	const persons = input.personsDocument && input.personsSource
		? parsePersons(input.personsDocument, input.personsSource, runtime)
		: [];
	const threadedComments = input.threadedCommentsDocument && input.threadedCommentsSource
		? parseThreadedComments(input.threadedCommentsDocument, input.threadedCommentsSource, persons, opaqueFragments, runtime)
		: [];
	const result: ParadisSpreadsheetAnnotations = {
		worksheetSource: input.worksheetSource,
		contentTypesSource: input.contentTypesSource,
		rootRelationshipsSource: input.rootRelationshipsSource,
		workbookSource: input.workbookSource,
		worksheetRelationshipsSource: input.worksheetRelationshipsSource,
		workbookRelationshipsSource: input.workbookRelationshipsSource,
		...(input.commentsSource ? { commentsSource: input.commentsSource } : {}),
		...(input.vmlDrawingSource ? { vmlDrawingSource: input.vmlDrawingSource } : {}),
		...(input.vmlDrawingRelationshipsSource ? { vmlDrawingRelationshipsSource: input.vmlDrawingRelationshipsSource } : {}),
		...(input.threadedCommentsSource ? { threadedCommentsSource: input.threadedCommentsSource } : {}),
		...(input.personsSource ? { personsSource: input.personsSource } : {}),
		validations, legacyNotes, threadedComments, persons, hyperlinks, opaqueFragments,
		cellOverlays: buildCellOverlays(legacyNotes, threadedComments, hyperlinks, runtime),
		rangeOverlays: buildRangeOverlays(validations, hyperlinks, runtime),
	};
	const frozen = deepFreeze(result, runtime);
	parsedAnnotationModels.add(frozen);
	return frozen;
}

function validateSourceLocations(input: OwnedDocuments): void {
	if (input.contentTypesSource.partId !== '/[Content_Types].xml'
		|| input.rootRelationshipsSource.partId !== '/_rels/.rels'
		|| input.worksheetRelationshipsSource.partId !== relationshipPartFor(input.worksheetSource.partId)
		|| input.workbookRelationshipsSource.partId !== relationshipPartFor(input.workbookSource.partId)
		|| input.vmlDrawingSource && input.vmlDrawingRelationshipsSource
		&& input.vmlDrawingRelationshipsSource.partId !== relationshipPartFor(input.vmlDrawingSource.partId)) {
		throw new ParadisOfficePackageError('unsafe');
	}
}

function validateRootWorkbookAuthority(source: ParadisSpreadsheetPartSource, relationships: readonly Relationship[]): void {
	const candidates = relationships.filter(relationship => relationshipTypeMatches(relationship.type, relationshipTypes.officeDocument));
	if (candidates.length !== 1 || candidates[0].external || candidates[0].resolvedTarget !== source.partId) {
		throw new ParadisOfficePackageError('unsafe');
	}
}

function validateWorkbookWorksheetAuthority(
	document: ParadisOfficeXmlDocument,
	worksheetSource: ParadisSpreadsheetPartSource,
	relationships: readonly Relationship[],
	runtime: Runtime,
): void {
	const root = spreadsheetRoot(document, 'workbook');
	const sheetsNodes = elementChildren(root, runtime).filter(child => isSpreadsheetElement(child, 'sheets'));
	if (sheetsNodes.length !== 1) { throw new ParadisOfficePackageError('unsafe'); }
	let matches = 0;
	for (const sheet of elementChildren(sheetsNodes[0], runtime)) {
		if (!isSpreadsheetElement(sheet, 'sheet')) { throw new ParadisOfficePackageError('malformed'); }
		const relationship = relationshipById(relationships, requiredRelationshipIdAttribute(sheet));
		if (relationship.external || !relationship.resolvedTarget || !isWorkbookSheetRelationship(relationship.type)) {
			throw new ParadisOfficePackageError('unsafe');
		}
		if (relationship.resolvedTarget === worksheetSource.partId) {
			if (!relationshipTypeMatches(relationship.type, relationshipTypes.worksheet)) { throw new ParadisOfficePackageError('unsafe'); }
			matches++;
		}
	}
	if (matches !== 1) { throw new ParadisOfficePackageError('unsafe'); }
}

function isWorkbookSheetRelationship(value: string): boolean {
	return ['worksheet', 'chartsheet', 'dialogsheet', 'macrosheet'].some(kind => relationshipTypeMatches(value, kind))
		|| value === 'http://schemas.microsoft.com/office/2006/relationships/xlMacrosheet'
		|| value === 'http://schemas.microsoft.com/office/2006/relationships/xlIntlMacrosheet';
}

function relationshipPartFor(owner: string): string {
	const slash = owner.lastIndexOf('/');
	if (slash < 0 || owner.endsWith('/')) {
		throw new ParadisOfficePackageError('unsafe');
	}
	return `${owner.slice(0, slash)}/_rels/${owner.slice(slash + 1)}.rels`;
}

function relationshipOwner(partId: string): string {
	const match = /^(.*)\/_rels\/([^/]+)\.rels$/.exec(partId);
	if (!match) {
		throw new ParadisOfficePackageError('unsafe');
	}
	return `${match[1]}/${match[2]}`;
}

function parseContentTypes(document: ParadisOfficeXmlDocument, runtime: Runtime): ContentTypeMap {
	const root = requiredRoot(document, contentTypeNamespace, 'Types');
	exactAttributes(root, []);
	const defaults = new Map<string, string>();
	const overrides = new Map<string, string>();
	for (const child of elementChildren(root, runtime)) {
		if (child.uri !== contentTypeNamespace || child.local !== 'Default' && child.local !== 'Override') {
			throw new ParadisOfficePackageError('malformed');
		}
		assertEmptyElement(child, runtime);
		if (child.local === 'Default') {
			exactAttributes(child, ['Extension', 'ContentType']);
			const extension = requiredAttribute(child, 'Extension').toLowerCase();
			const type = requiredAttribute(child, 'ContentType');
			if (!/^[a-z0-9]+$/.test(extension) || !validContentType(type) || defaults.has(extension)) {
				throw new ParadisOfficePackageError('malformed');
			}
			defaults.set(extension, type);
		} else {
			exactAttributes(child, ['PartName', 'ContentType']);
			const part = canonicalPartId(requiredAttribute(child, 'PartName'));
			const type = requiredAttribute(child, 'ContentType');
			if (!validContentType(type) || overrides.has(part)) {
				throw new ParadisOfficePackageError('malformed');
			}
			overrides.set(part, type);
		}
	}
	return { defaults, overrides };
}

function selectWorksheetChildren(
	root: XmlElement,
	source: ParadisSpreadsheetPartSource,
	opaqueFragments: ParadisSpreadsheetOpaqueAnnotationFragment[],
	runtime: Runtime,
): readonly XmlElement[] {
	const result: XmlElement[] = [];
	for (const child of elementChildren(root, runtime)) {
		if (child.uri !== markupCompatibilityNamespace || child.local !== 'AlternateContent') {
			result.push(child);
			continue;
		}
		exactAttributes(child, []);
		const branches = elementChildren(child, runtime);
		let selected: XmlElement | undefined;
		let fallback: XmlElement | undefined;
		let choices = 0;
		for (const branch of branches) {
			if (branch.uri !== markupCompatibilityNamespace) { throw new ParadisOfficePackageError('malformed'); }
			if (branch.local === 'Choice') {
				if (fallback) { throw new ParadisOfficePackageError('malformed'); }
				choices++;
				exactAttributes(branch, ['Requires']);
				const required = requiredAttribute(branch, 'Requires').trim().split(/\s+/);
				const namespaces = branch.namespaceBindings ?? {};
				if (!selected && required.length > 0 && required.every(prefix => supportedCompatibilityNamespace(namespaces[prefix]))) {
					selected = branch;
				}
			} else if (branch.local === 'Fallback') {
				if (fallback) { throw new ParadisOfficePackageError('malformed'); }
				exactAttributes(branch, []); fallback = branch;
			} else {
				throw new ParadisOfficePackageError('malformed');
			}
		}
		if (choices === 0) { throw new ParadisOfficePackageError('malformed'); }
		selected ??= fallback;
		if (!selected) { throw new ParadisOfficePackageError('malformed'); }
		for (const branch of branches) {
			if (branch === selected) { result.push(...elementChildren(branch, runtime)); }
			else { pushOpaqueFragment(opaqueFragments, branch, source, runtime); }
		}
	}
	return result;
}

function supportedCompatibilityNamespace(value: string | undefined): boolean {
	return value === x14Namespace || value === xmNamespace || value !== undefined && spreadsheetNamespaces.has(value);
}

function validContentType(value: string): boolean {
	return value.length > 2 && value.length <= 255 && /^[A-Za-z0-9!#$&^_.+\-]+\/[A-Za-z0-9!#$&^_.+\-]+$/.test(value);
}

function validateContentType(partId: string, allowed: ReadonlySet<string>, map: ContentTypeMap): void {
	const dot = partId.lastIndexOf('.');
	const extension = dot < 0 ? '' : partId.slice(dot + 1).toLowerCase();
	const actual = map.overrides.get(partId) ?? map.defaults.get(extension);
	if (!actual || !allowed.has(actual)) {
		throw new ParadisOfficePackageError('unsafe');
	}
}

function parseRelationships(document: ParadisOfficeXmlDocument, ownerPartId: string, runtime: Runtime): readonly Relationship[] {
	const root = requiredRoot(document, packageRelationshipNamespace, 'Relationships');
	exactAttributes(root, []);
	const result: Relationship[] = [];
	const ids = new Set<string>();
	for (const child of elementChildren(root, runtime)) {
		if (child.uri !== packageRelationshipNamespace || child.local !== 'Relationship') {
			throw new ParadisOfficePackageError('malformed');
		}
		if (result.length >= runtime.context.limits.relationships) {
			throw new ParadisOfficePackageError('limitExceeded');
		}
		exactAttributes(child, ['Id', 'Type', 'Target', 'TargetMode']);
		assertEmptyElement(child, runtime);
		const id = requiredAttribute(child, 'Id');
		const type = requiredAttribute(child, 'Type');
		const target = requiredAttribute(child, 'Target');
		const targetMode = attribute(child, 'TargetMode');
		if (!validRelationshipId(id) || ids.has(id) || type.length > 2048 || target.length > runtime.context.limits.targetCharacters
			|| targetMode !== undefined && targetMode !== 'External' && targetMode !== 'Internal') {
			throw new ParadisOfficePackageError('malformed');
		}
		ids.add(id);
		const external = targetMode === 'External';
		result.push({ id, type, target, external, ...(external ? {} : { resolvedTarget: resolvePartTarget(ownerPartId, target) }) });
	}
	return result;
}

function validRelationshipId(value: string): boolean {
	return value.length <= 255 && /^[\p{L}\p{Nl}_][\p{L}\p{N}\p{M}_.\-\u00B7\u203F\u2040]*$/u.test(value) && !containsUnsafeControl(value);
}

function validateSupplementalAuthority(
	input: OwnedDocuments,
	typeMap: ContentTypeMap,
	worksheetRelationships: readonly Relationship[],
	workbookRelationships: readonly Relationship[],
): void {
	validateBoundPart(input.commentsSource, relationshipTypes.comments, contentTypes.comments, typeMap, worksheetRelationships);
	validateBoundPart(input.vmlDrawingSource, relationshipTypes.vml, contentTypes.vml, typeMap, worksheetRelationships);
	validateBoundPart(input.threadedCommentsSource, relationshipTypes.threaded, contentTypes.threaded, typeMap, worksheetRelationships);
	validateBoundPart(input.personsSource, relationshipTypes.person, contentTypes.persons, typeMap, workbookRelationships);
	if (input.threadedCommentsSource && !input.personsSource) {
		throw new ParadisOfficePackageError('unsafe');
	}
}

function validateBoundPart(
	source: ParadisSpreadsheetPartSource | undefined,
	type: string,
	allowedTypes: ReadonlySet<string>,
	contentTypeMap: ContentTypeMap,
	relationships: readonly Relationship[],
): void {
	const candidates = relationships.filter(relationship => relationshipTypeMatches(relationship.type, type));
	if (!source) {
		if (type === relationshipTypes.vml) {
			if (candidates.some(candidate => candidate.external)) { throw new ParadisOfficePackageError('unsafe'); }
			return;
		}
		if (candidates.length !== 0) {
			throw new ParadisOfficePackageError('unsafe');
		}
		return;
	}
	const matching = candidates.filter(candidate => !candidate.external && candidate.resolvedTarget === source.partId);
	if (matching.length !== 1 || type !== relationshipTypes.vml && candidates.length !== 1
		|| type === relationshipTypes.vml && candidates.some(candidate => candidate.external)) {
		throw new ParadisOfficePackageError('unsafe');
	}
	validateContentType(source.partId, allowedTypes, contentTypeMap);
}

function resolvePartTarget(ownerPartId: string, target: string): string {
	if (!target || target.startsWith('/') || target.includes('\\') || target.includes('\0') || target.includes('?') || target.includes('#')) {
		throw new ParadisOfficePackageError('unsafe');
	}
	const base = ownerPartId.slice(0, ownerPartId.lastIndexOf('/')).split('/').filter(Boolean);
	for (const segment of target.split('/')) {
		if (!segment || segment === '.') {
			continue;
		}
		if (segment === '..') {
			if (base.length === 0) {
				throw new ParadisOfficePackageError('unsafe');
			}
			base.pop();
		} else {
			base.push(segment);
		}
	}
	return canonicalPartId(`/${base.join('/')}`);
}

function canonicalPartId(value: string): string {
	if (!value.startsWith('/') || value.includes('\\') || value.includes('\0')) {
		throw new ParadisOfficePackageError('unsafe');
	}
	const segments = value.slice(1).split('/').map(decodePartSegment);
	if (segments.some(segment => !segment || segment === '.' || segment === '..')) {
		throw new ParadisOfficePackageError('unsafe');
	}
	return `/${segments.join('/')}`;
}

function decodePartSegment(value: string): string {
	if (!isValidUnicodeText(value) || containsUnsafeControl(value)) { throw new ParadisOfficePackageError('unsafe'); }
	if (!value.includes('%')) { return value; }
	if (/%(?:2f|5c|00|25)/i.test(value) || /%(?![0-9A-Fa-f]{2})/.test(value)) {
		throw new ParadisOfficePackageError('unsafe');
	}
	let decoded: string;
	try { decoded = decodeURIComponent(value); } catch { throw new ParadisOfficePackageError('unsafe'); }
	if (!decoded || decoded.includes('/') || decoded.includes('\\') || decoded.includes('\0') || decoded.includes('%')
		|| !isValidUnicodeText(decoded) || containsUnsafeControl(decoded)) {
		throw new ParadisOfficePackageError('unsafe');
	}
	return decoded;
}

function validateLegacyDrawingReference(id: string | undefined, source: ParadisSpreadsheetPartSource, relationships: readonly Relationship[]): void {
	if (!id) {
		throw new ParadisOfficePackageError('unsafe');
	}
	const relationship = relationshipById(relationships, id);
	if (!relationshipTypeMatches(relationship.type, relationshipTypes.vml) || relationship.external || relationship.resolvedTarget !== source.partId) {
		throw new ParadisOfficePackageError('unsafe');
	}
}

function relationshipTypeMatches(value: string, kind: string): boolean {
	if (kind === relationshipTypes.threaded) {
		return value === kind;
	}
	if (kind === relationshipTypes.person && value === 'http://schemas.microsoft.com/office/2017/10/relationships/person') {
		return true;
	}
	return officeRelationshipNamespaces.has(value.slice(0, value.lastIndexOf('/'))) && value.endsWith(`/${kind}`);
}

function relationshipById(relationships: readonly Relationship[], id: string): Relationship {
	const relationship = relationships.find(candidate => candidate.id === id);
	if (!relationship) {
		throw new ParadisOfficePackageError('unsafe');
	}
	return relationship;
}

function parseWorksheet(
	document: ParadisOfficeXmlDocument,
	worksheetSource: ParadisSpreadsheetPartSource,
	worksheetRelationshipsSource: ParadisSpreadsheetPartSource,
	relationships: readonly Relationship[],
	opaqueFragments: ParadisSpreadsheetOpaqueAnnotationFragment[],
	runtime: Runtime,
): {
	readonly validations: readonly ParadisSpreadsheetValidation[];
	readonly legacyDrawingRelationshipId?: string;
	readonly hyperlinks: readonly ParadisSpreadsheetHyperlink[];
} {
	const root = spreadsheetRoot(document, 'worksheet');
	const validations: ParadisSpreadsheetValidation[] = [];
	const hyperlinks: ParadisSpreadsheetHyperlink[] = [];
	let legacyDrawingRelationshipId: string | undefined;
	let seenStandardValidations = false;
	let seenHyperlinks = false;
	let seenLegacyDrawing = false;
	for (const child of selectWorksheetChildren(root, worksheetSource, opaqueFragments, runtime)) {
		checkpoint(runtime);
		if (isSpreadsheetElement(child, 'dataValidations')) {
			if (seenStandardValidations) { throw new ParadisOfficePackageError('malformed'); }
			seenStandardValidations = true;
			validations.push(...parseStandardValidations(child, worksheetSource, validations.length, runtime));
		} else if (isSpreadsheetElement(child, 'hyperlinks')) {
			if (seenHyperlinks) { throw new ParadisOfficePackageError('malformed'); }
			seenHyperlinks = true;
			hyperlinks.push(...parseHyperlinks(child, worksheetSource, worksheetRelationshipsSource, relationships, runtime));
		} else if (isSpreadsheetElement(child, 'legacyDrawing')) {
			if (seenLegacyDrawing) { throw new ParadisOfficePackageError('malformed'); }
			seenLegacyDrawing = true;
			exactAttributes(child, [], [[officeRelationshipNamespace, 'id'], [strictOfficeRelationshipNamespace, 'id']]);
			assertEmptyElement(child, runtime);
			legacyDrawingRelationshipId = requiredRelationshipIdAttribute(child);
		} else if (isSpreadsheetElement(child, 'extLst')) {
			validations.push(...parseX14Validations(child, worksheetSource, validations.length, opaqueFragments, runtime));
		}
	}
	if (validations.length > runtime.context.limits.validations || hyperlinks.length > runtime.context.limits.hyperlinks) {
		throw new ParadisOfficePackageError('limitExceeded');
	}
	return { validations, ...(legacyDrawingRelationshipId ? { legacyDrawingRelationshipId } : {}), hyperlinks };
}

function parseStandardValidations(
	node: XmlElement,
	source: ParadisSpreadsheetPartSource,
	startOrder: number,
	runtime: Runtime,
): readonly ParadisSpreadsheetValidation[] {
	exactAttributes(node, ['count', 'disablePrompts', 'xWindow', 'yWindow']);
	const declared = integerAttribute(node, 'count');
	const result: ParadisSpreadsheetValidation[] = [];
	for (const child of elementChildren(node, runtime)) {
		if (!isSpreadsheetElement(child, 'dataValidation')) {
			throw new ParadisOfficePackageError('malformed');
		}
		if (safeAdd(startOrder, result.length) >= runtime.context.limits.validations) {
			throw new ParadisOfficePackageError('limitExceeded');
		}
		result.push(parseValidation(child, 'standard', source, startOrder + result.length, runtime));
	}
	if (declared !== undefined && declared !== result.length) {
		throw new ParadisOfficePackageError('malformed');
	}
	return result;
}

function parseX14Validations(
	extensionList: XmlElement,
	source: ParadisSpreadsheetPartSource,
	startOrder: number,
	opaqueFragments: ParadisSpreadsheetOpaqueAnnotationFragment[],
	runtime: Runtime,
): readonly ParadisSpreadsheetValidation[] {
	const result: ParadisSpreadsheetValidation[] = [];
	for (const extension of elementChildren(extensionList, runtime)) {
		if (!isSpreadsheetElement(extension, 'ext')) {
			continue;
		}
		exactAttributes(extension, ['uri']);
		if (attribute(extension, 'uri')?.toUpperCase() !== x14ValidationExtensionUri) {
			pushOpaqueFragment(opaqueFragments, extension, source, runtime);
			continue;
		}
		for (const candidate of elementChildren(extension, runtime)) {
			if (candidate.uri !== x14Namespace || candidate.local !== 'dataValidations') {
				pushOpaqueFragment(opaqueFragments, candidate, source, runtime);
				continue;
			}
			exactAttributes(candidate, ['count', 'disablePrompts', 'xWindow', 'yWindow']);
			const declared = integerAttribute(candidate, 'count');
			let parsed = 0;
			for (const validation of elementChildren(candidate, runtime)) {
				if (validation.uri !== x14Namespace || validation.local !== 'dataValidation') {
					pushOpaqueFragment(opaqueFragments, validation, source, runtime);
					continue;
				}
				if (safeAdd(safeAdd(startOrder, result.length), 1) > runtime.context.limits.validations) {
					throw new ParadisOfficePackageError('limitExceeded');
				}
				result.push(parseValidation(validation, 'x14', source, startOrder + result.length, runtime, opaqueFragments));
				parsed++;
			}
			if (declared !== undefined && declared !== parsed) {
				throw new ParadisOfficePackageError('malformed');
			}
		}
	}
	return result;
}

function parseValidation(
	node: XmlElement,
	kind: 'standard' | 'x14',
	source: ParadisSpreadsheetPartSource,
	order: number,
	runtime: Runtime,
	opaqueFragments?: ParadisSpreadsheetOpaqueAnnotationFragment[],
): ParadisSpreadsheetValidation {
	exactAttributes(node, [
		'type', 'errorStyle', 'imeMode', 'operator', 'allowBlank', 'showDropDown', 'showInputMessage', 'showErrorMessage',
		'errorTitle', 'error', 'promptTitle', 'prompt', 'sqref',
	], kind === 'x14' ? [[markupCompatibilityNamespace, 'Ignorable'], [spreadsheetRevisionNamespace, 'uid']] : []);
	const type = optionalEnumAttribute(node, 'type', ['none', 'whole', 'decimal', 'list', 'date', 'time', 'textLength', 'custom'] as const) ?? 'none';
	const operator = optionalEnumAttribute(node, 'operator', ['between', 'notBetween', 'equal', 'notEqual', 'lessThan', 'lessThanOrEqual', 'greaterThan', 'greaterThanOrEqual'] as const);
	const errorStyle = optionalEnumAttribute(node, 'errorStyle', ['stop', 'warning', 'information'] as const);
	let formula1: string | undefined;
	let formula2: string | undefined;
	let sqref: string | undefined = kind === 'standard' ? attribute(node, 'sqref') : undefined;
	for (const child of elementChildren(node, runtime)) {
		checkpoint(runtime);
		if (kind === 'standard' && isSpreadsheetElement(child, 'formula1')) {
			if (formula1 !== undefined) { throw new ParadisOfficePackageError('malformed'); }
			formula1 = ownFormula(directText(child, runtime), runtime);
		} else if (kind === 'standard' && isSpreadsheetElement(child, 'formula2')) {
			if (formula2 !== undefined) { throw new ParadisOfficePackageError('malformed'); }
			formula2 = ownFormula(directText(child, runtime), runtime);
		} else if (kind === 'x14' && child.uri === x14Namespace && (child.local === 'formula1' || child.local === 'formula2')) {
			const formula = parseX14Formula(child, runtime);
			if (child.local === 'formula1') {
				if (formula1 !== undefined) { throw new ParadisOfficePackageError('malformed'); }
				formula1 = formula;
			} else {
				if (formula2 !== undefined) { throw new ParadisOfficePackageError('malformed'); }
				formula2 = formula;
			}
		} else if (kind === 'x14' && child.uri === xmNamespace && child.local === 'sqref') {
			if (sqref !== undefined) { throw new ParadisOfficePackageError('malformed'); }
			sqref = directText(child, runtime);
		} else if (kind === 'x14' && opaqueFragments) {
			pushOpaqueFragment(opaqueFragments, child, source, runtime);
		} else {
			throw new ParadisOfficePackageError('malformed');
		}
	}
	if (sqref === undefined) {
		throw new ParadisOfficePackageError('malformed');
	}
	const ranges = parseSqref(sqref, runtime);
	return compact({
		id: `validation:${kind}:${order}`, order, kind, type, ranges, source, formula1, formula2,
		operator: operator as ParadisSpreadsheetValidationOperator | undefined,
		errorStyle: errorStyle as ParadisSpreadsheetValidationErrorStyle | undefined,
		allowBlank: booleanAttribute(node, 'allowBlank'), showDropDown: booleanAttribute(node, 'showDropDown'),
		showInputMessage: booleanAttribute(node, 'showInputMessage'), showErrorMessage: booleanAttribute(node, 'showErrorMessage'),
		imeMode: attribute(node, 'imeMode'),
		promptTitle: optionalTextIdentity(attribute(node, 'promptTitle'), runtime),
		prompt: optionalTextIdentity(attribute(node, 'prompt'), runtime),
		errorTitle: optionalTextIdentity(attribute(node, 'errorTitle'), runtime),
		error: optionalTextIdentity(attribute(node, 'error'), runtime),
	});
}

function parseX14Formula(node: XmlElement, runtime: Runtime): string {
	exactAttributes(node, []);
	const children = elementChildren(node, runtime);
	if (children.length !== 1 || children[0].uri !== xmNamespace || children[0].local !== 'f') {
		throw new ParadisOfficePackageError('malformed');
	}
	exactAttributes(children[0], []);
	return ownFormula(directText(children[0], runtime), runtime);
}

function ownFormula(value: string, runtime: Runtime): string {
	runtime.formulas = safeAdd(runtime.formulas, 1);
	runtime.formulaCharacters = safeAdd(runtime.formulaCharacters, value.length);
	if (runtime.formulas > runtime.context.limits.formulas || runtime.formulaCharacters > runtime.context.limits.formulaCharacters) {
		throw new ParadisOfficePackageError('limitExceeded');
	}
	if (!isValidUnicodeText(value)) {
		throw new ParadisOfficePackageError('malformed');
	}
	return value;
}

function parseHyperlinks(
	node: XmlElement,
	worksheetSource: ParadisSpreadsheetPartSource,
	relationshipSource: ParadisSpreadsheetPartSource,
	relationships: readonly Relationship[],
	runtime: Runtime,
): readonly ParadisSpreadsheetHyperlink[] {
	exactAttributes(node, []);
	const result: ParadisSpreadsheetHyperlink[] = [];
	const refs = new Set<string>();
	for (const child of elementChildren(node, runtime)) {
		if (!isSpreadsheetElement(child, 'hyperlink') || result.length >= runtime.context.limits.hyperlinks) {
			throw new ParadisOfficePackageError(result.length >= runtime.context.limits.hyperlinks ? 'limitExceeded' : 'malformed');
		}
		exactAttributes(child, ['ref', 'location', 'tooltip', 'display'], [[officeRelationshipNamespace, 'id'], [strictOfficeRelationshipNamespace, 'id']]);
		assertEmptyElement(child, runtime);
		const ref = parseRange(requiredAttribute(child, 'ref')).ref;
		if (refs.has(ref)) { throw new ParadisOfficePackageError('malformed'); }
		refs.add(ref);
		const relationshipId = relationshipIdAttribute(child);
		const locationValue = attribute(child, 'location');
		if (!relationshipId && locationValue === undefined) {
			throw new ParadisOfficePackageError('malformed');
		}
		let target: ParadisSpreadsheetHyperlinkTarget | undefined;
		if (relationshipId) {
			const relationship = relationshipById(relationships, relationshipId);
			if (!relationshipTypeMatches(relationship.type, relationshipTypes.hyperlink)) {
				throw new ParadisOfficePackageError('unsafe');
			}
			target = classifyHyperlinkTarget(relationship, relationshipSource, runtime);
		}
		result.push(compact({
			id: `hyperlink:${ref}:${result.length}`, ref, source: worksheetSource, target,
			location: optionalLocationIdentity(locationValue, runtime),
			tooltip: optionalTextIdentity(attribute(child, 'tooltip'), runtime),
			display: optionalTextIdentity(attribute(child, 'display'), runtime),
		}));
	}
	return result;
}

function classifyHyperlinkTarget(
	relationship: Relationship,
	relationshipSource: ParadisSpreadsheetPartSource,
	runtime: Runtime,
): ParadisSpreadsheetHyperlinkTarget {
	if (!relationship.external) {
		if (!relationship.resolvedTarget) { throw new ParadisOfficePackageError('unsafe'); }
		return {
			classification: 'internalPart', display: 'internal workbook target',
			normalizedTargetHash: sha256Text(relationship.resolvedTarget, runtime), relationshipSource,
		};
	}
	const raw = relationship.target;
	if (raw !== raw.trim() || raw.length === 0 || raw.length > runtime.context.limits.targetCharacters || !isValidUnicodeText(raw) || containsUnsafeControl(raw)) {
		throw new ParadisOfficePackageError('malformed');
	}
	const schemeMatch = /^([A-Za-z][A-Za-z0-9+.-]*):/.exec(raw);
	const scheme = schemeMatch?.[1].toLowerCase();
	if (scheme === 'http' || scheme === 'https') {
		const normalized = normalizeHttpTarget(raw, scheme);
		if (normalized) {
			return {
				classification: 'safeExternal', scheme, display: `${normalized.origin}/…`,
				normalizedTargetHash: sha256Text(normalized.target, runtime), relationshipSource,
			};
		}
	}
	if (scheme === 'mailto' && /^mailto:[^\s@]+@[^\s@]+(?:\?.*)?$/i.test(raw)) {
		const normalizedMailto = normalizeMailtoTarget(raw);
		if (normalizedMailto) {
			return {
				classification: 'safeExternal', scheme, display: 'mailto:…',
				normalizedTargetHash: sha256Text(normalizedMailto, runtime), relationshipSource,
			};
		}
	}
	const normalizedUnsafe = normalizeExternalRelationshipIdentity(raw);
	return {
		classification: 'unsafeExternal', ...(scheme ? { scheme } : {}), display: 'blocked external link',
		normalizedTargetHash: sha256Text(normalizedUnsafe, runtime), relationshipSource,
	};
}

function normalizeHttpTarget(raw: string, scheme: 'http' | 'https'): { readonly origin: string; readonly target: string } | undefined {
	try {
		const parsed = new URL(raw);
		if (parsed.protocol !== `${scheme}:` || parsed.username || parsed.password || parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
			return undefined;
		}
		const origin = parsed.origin;
		const path = normalizePercentEscapes(parsed.pathname || '/');
		const suffix = normalizePercentEscapes(`${parsed.search}${parsed.hash}`);
		return { origin, target: `${origin}${path}${suffix}` };
	} catch {
		return undefined;
	}
}

function normalizePercentEscapes(value: string): string {
	return value.replace(/%[0-9a-f]{2}/gi, candidate => {
		const character = String.fromCharCode(Number.parseInt(candidate.slice(1), 16));
		return /^[A-Za-z0-9._~\-]$/.test(character) ? character : candidate.toUpperCase();
	});
}

function normalizeExternalRelationshipIdentity(value: string): string {
	const match = /^([A-Za-z][A-Za-z0-9+.-]*):(.*)$/.exec(value);
	if (!match) { return normalizePercentEscapes(value); }
	const scheme = match[1].toLowerCase();
	if (scheme === 'http' || scheme === 'https') {
		return normalizeHttpTarget(value, scheme)?.target ?? `${scheme}:${normalizePercentEscapes(match[2])}`;
	}
	if (scheme === 'mailto') {
		return normalizeMailtoTarget(value) ?? `${scheme}:${normalizePercentEscapes(match[2])}`;
	}
	try {
		const parsed = new URL(value);
		if (parsed.protocol === `${scheme}:`) { return normalizePercentEscapes(parsed.href); }
	} catch { /* Opaque schemes retain a normalized lexical identity below. */ }
	return `${scheme}:${normalizePercentEscapes(match[2])}`;
}

function normalizeMailtoTarget(value: string): string | undefined {
	const match = /^mailto:([^?]+)(\?.*)?$/i.exec(value);
	if (!match) { return undefined; }
	const address = normalizePercentEscapes(match[1]);
	const at = address.lastIndexOf('@');
	if (at <= 0 || at === address.length - 1) { return undefined; }
	let domain: string;
	try {
		const domainUrl = new URL(`https://${address.slice(at + 1)}`);
		if (domainUrl.username || domainUrl.password || domainUrl.port || domainUrl.pathname !== '/' || domainUrl.search || domainUrl.hash) { return undefined; }
		domain = domainUrl.hostname;
	} catch { return undefined; }
	if (!domain) { return undefined; }
	return `mailto:${address.slice(0, at)}@${domain}${normalizePercentEscapes(match[2] ?? '')}`;
}

function parseVmlAnchors(
	document: ParadisOfficeXmlDocument,
	source: ParadisSpreadsheetPartSource,
	opaqueFragments: ParadisSpreadsheetOpaqueAnnotationFragment[],
	runtime: Runtime,
): ReadonlyMap<string, ParadisSpreadsheetLegacyNoteAnchor> {
	const root = requiredRoot(document, '', 'xml');
	const result = new Map<string, ParadisSpreadsheetLegacyNoteAnchor>();
	for (const shape of elementChildren(root, runtime)) {
		if (shape.uri !== vmlNamespace || shape.local !== 'shape') {
			pushOpaqueFragment(opaqueFragments, shape, source, runtime);
			continue;
		}
		const shapeId = attribute(shape, 'id');
		if (!shapeId || shapeId.length > 255 || !isValidUnicodeText(shapeId)) {
			throw new ParadisOfficePackageError('malformed');
		}
		for (const clientData of elementChildren(shape, runtime)) {
			if (clientData.uri !== excelNamespace || clientData.local !== 'ClientData' || attribute(clientData, 'ObjectType') !== 'Note') {
				pushOpaqueFragment(opaqueFragments, clientData, source, runtime);
				continue;
			}
			const anchor = parseVmlClientData(clientData, shapeId, source, opaqueFragments, runtime);
			const key = `${anchor.row}:${anchor.column}`;
			if (result.has(key)) {
				throw new ParadisOfficePackageError('malformed');
			}
			result.set(key, anchor);
		}
	}
	return result;
}

function parseVmlClientData(
	node: XmlElement,
	shapeId: string,
	source: ParadisSpreadsheetPartSource,
	opaqueFragments: ParadisSpreadsheetOpaqueAnnotationFragment[],
	runtime: Runtime,
): ParadisSpreadsheetLegacyNoteAnchor {
	exactAttributes(node, ['ObjectType']);
	let row: number | undefined;
	let column: number | undefined;
	let anchor: readonly number[] | undefined;
	let moveWithCells = false;
	let sizeWithCells = false;
	for (const child of elementChildren(node, runtime)) {
		if (child.uri !== excelNamespace) {
			throw new ParadisOfficePackageError('malformed');
		}
		if (child.local === 'Row') {
			if (row !== undefined) { throw new ParadisOfficePackageError('malformed'); }
			row = parseBoundedIntegerText(child, 0, maximumExcelRows - 1, runtime);
		} else if (child.local === 'Column') {
			if (column !== undefined) { throw new ParadisOfficePackageError('malformed'); }
			column = parseBoundedIntegerText(child, 0, maximumExcelColumns - 1, runtime);
		} else if (child.local === 'Anchor') {
			if (anchor !== undefined) { throw new ParadisOfficePackageError('malformed'); }
			const values = directText(child, runtime).split(',').map(value => value.trim());
			if (values.length !== 8 || values.some(value => !/^(?:0|[1-9][0-9]*)$/.test(value))) {
				throw new ParadisOfficePackageError('malformed');
			}
			anchor = values.map(value => Number(value));
			if (!anchor.every(Number.isSafeInteger)
				|| anchor[0] >= maximumExcelColumns || anchor[2] >= maximumExcelRows
				|| anchor[4] >= maximumExcelColumns || anchor[6] >= maximumExcelRows
				|| anchor[1] > 1023 || anchor[5] > 1023 || anchor[3] > 255 || anchor[7] > 255
				|| anchor[4] < anchor[0] || anchor[4] === anchor[0] && anchor[5] <= anchor[1]
				|| anchor[6] < anchor[2] || anchor[6] === anchor[2] && anchor[7] <= anchor[3]) {
				throw new ParadisOfficePackageError('malformed');
			}
		} else if (child.local === 'MoveWithCells') {
			assertEmptyElement(child, runtime); moveWithCells = true;
		} else if (child.local === 'SizeWithCells') {
			assertEmptyElement(child, runtime); sizeWithCells = true;
		} else {
			pushOpaqueFragment(opaqueFragments, child, source, runtime);
		}
	}
	if (row === undefined || column === undefined || !anchor) {
		throw new ParadisOfficePackageError('malformed');
	}
	const numericMatch = /(?:^|_)s([0-9]+)$/.exec(shapeId);
	const shapeNumericId = numericMatch ? Number(numericMatch[1]) : undefined;
	return {
		shapeId, ...(shapeNumericId !== undefined && Number.isSafeInteger(shapeNumericId) ? { shapeNumericId } : {}), row, column,
		leftColumn: anchor[0], leftOffset: anchor[1], topRow: anchor[2], topOffset: anchor[3],
		rightColumn: anchor[4], rightOffset: anchor[5], bottomRow: anchor[6], bottomOffset: anchor[7],
		moveWithCells, sizeWithCells, source,
	};
}

function parseBoundedIntegerText(node: XmlElement, minimum: number, maximum: number, runtime: Runtime): number {
	const value = directText(node, runtime);
	if (!/^(?:0|[1-9][0-9]*)$/.test(value)) {
		throw new ParadisOfficePackageError('malformed');
	}
	const result = Number(value);
	if (!Number.isSafeInteger(result) || result < minimum || result > maximum) {
		throw new ParadisOfficePackageError('malformed');
	}
	return result;
}

function parseLegacyNotes(
	document: ParadisOfficeXmlDocument,
	source: ParadisSpreadsheetPartSource,
	anchors: ReadonlyMap<string, ParadisSpreadsheetLegacyNoteAnchor>,
	opaqueFragments: ParadisSpreadsheetOpaqueAnnotationFragment[],
	runtime: Runtime,
): readonly ParadisSpreadsheetLegacyNote[] {
	const root = spreadsheetRoot(document, 'comments');
	let authors: readonly ParadisSpreadsheetTextIdentity[] | undefined;
	let notes: readonly ParadisSpreadsheetLegacyNote[] | undefined;
	for (const child of elementChildren(root, runtime)) {
		if (isSpreadsheetElement(child, 'authors')) {
			if (authors) { throw new ParadisOfficePackageError('malformed'); }
			authors = parseAuthors(child, runtime);
		} else if (isSpreadsheetElement(child, 'commentList')) {
			if (notes || !authors) { throw new ParadisOfficePackageError('malformed'); }
			notes = parseCommentList(child, authors, source, anchors, opaqueFragments, runtime);
		} else if (isSpreadsheetElement(child, 'extLst')) {
			for (const extension of elementChildren(child, runtime)) {
				pushOpaqueFragment(opaqueFragments, extension, source, runtime);
			}
		} else {
			throw new ParadisOfficePackageError('malformed');
		}
	}
	if (!authors || !notes) {
		throw new ParadisOfficePackageError('malformed');
	}
	return notes;
}

function parseAuthors(node: XmlElement, runtime: Runtime): readonly ParadisSpreadsheetTextIdentity[] {
	exactAttributes(node, []);
	const result: ParadisSpreadsheetTextIdentity[] = [];
	for (const child of elementChildren(node, runtime)) {
		if (!isSpreadsheetElement(child, 'author')) {
			throw new ParadisOfficePackageError('malformed');
		}
		result.push(textIdentity(directText(child, runtime), runtime));
	}
	if (result.length === 0 || result.length > runtime.context.limits.comments) {
		throw new ParadisOfficePackageError(result.length === 0 ? 'malformed' : 'limitExceeded');
	}
	return result;
}

function parseCommentList(
	node: XmlElement,
	authors: readonly ParadisSpreadsheetTextIdentity[],
	source: ParadisSpreadsheetPartSource,
	anchors: ReadonlyMap<string, ParadisSpreadsheetLegacyNoteAnchor>,
	opaqueFragments: ParadisSpreadsheetOpaqueAnnotationFragment[],
	runtime: Runtime,
): readonly ParadisSpreadsheetLegacyNote[] {
	exactAttributes(node, []);
	const result: ParadisSpreadsheetLegacyNote[] = [];
	const refs = new Set<string>();
	for (const child of elementChildren(node, runtime)) {
		if (!isSpreadsheetElement(child, 'comment')) {
			throw new ParadisOfficePackageError('malformed');
		}
		consumeComment(runtime);
		exactAttributes(child, ['ref', 'authorId', 'shapeId', 'guid']);
		const ref = parseRange(requiredAttribute(child, 'ref')).ref;
		if (ref.includes(':') || refs.has(ref)) {
			throw new ParadisOfficePackageError('malformed');
		}
		refs.add(ref);
		const authorId = requiredIntegerAttribute(child, 'authorId');
		if (authorId >= authors.length) {
			throw new ParadisOfficePackageError('malformed');
		}
		const children = elementChildren(child, runtime);
		if (children.length < 1 || !isSpreadsheetElement(children[0], 'text')) {
			throw new ParadisOfficePackageError('malformed');
		}
		const content = parseCommentContent(children[0], source, opaqueFragments, runtime);
		for (let index = 1; index < children.length; index++) {
			if (isSpreadsheetElement(children[index], 'extLst')) {
				for (const extension of elementChildren(children[index], runtime)) {
					pushOpaqueFragment(opaqueFragments, extension, source, runtime);
				}
			} else {
				throw new ParadisOfficePackageError('malformed');
			}
		}
		const coordinate = parseCellReference(ref);
		const anchor = anchors.get(`${coordinate.row - 1}:${coordinate.column - 1}`);
		const shapeId = integerAttribute(child, 'shapeId');
		if (shapeId !== undefined && anchor?.shapeNumericId !== undefined && shapeId !== anchor.shapeNumericId) {
			throw new ParadisOfficePackageError('unsafe');
		}
		result.push({
			id: `note:${ref}:${result.length}`, ref, authorId, author: authors[authorId], content, source,
			...(anchor ? { anchor } : {}),
		});
	}
	return result;
}

function parseCommentContent(
	node: XmlElement,
	source: ParadisSpreadsheetPartSource,
	opaqueFragments: ParadisSpreadsheetOpaqueAnnotationFragment[],
	runtime: Runtime,
): ParadisSpreadsheetCommentContent {
	exactAttributes(node, []);
	const runs: ParadisSemanticRichTextRun[] = [];
	let plain = false;
	for (const child of elementChildren(node, runtime)) {
		if (isSpreadsheetElement(child, 't')) {
			if (runs.length !== 0) { throw new ParadisOfficePackageError('malformed'); }
			plain = true;
			runs.push({ text: ownUiText(parseTextNode(child, runtime), runtime) });
		} else if (isSpreadsheetElement(child, 'r')) {
			if (plain) { throw new ParadisOfficePackageError('malformed'); }
			runs.push(parseRichTextRun(child, source, opaqueFragments, runtime));
		} else if (isSpreadsheetElement(child, 'rPh') || isSpreadsheetElement(child, 'phoneticPr')) {
			pushOpaqueFragment(opaqueFragments, child, source, runtime);
		} else {
			throw new ParadisOfficePackageError('malformed');
		}
	}
	return { text: runs.map(run => run.text).join(''), runs, fingerprint: fingerprintFragment(node, runtime) };
}

function parseRichTextRun(
	node: XmlElement,
	source: ParadisSpreadsheetPartSource,
	opaqueFragments: ParadisSpreadsheetOpaqueAnnotationFragment[],
	runtime: Runtime,
): ParadisSemanticRichTextRun {
	exactAttributes(node, []);
	let properties: ParadisSemanticRichTextProperties | undefined;
	let text: string | undefined;
	for (const child of elementChildren(node, runtime)) {
		if (isSpreadsheetElement(child, 'rPr')) {
			if (properties || text !== undefined) { throw new ParadisOfficePackageError('malformed'); }
			properties = parseRichTextProperties(child, source, opaqueFragments, runtime);
		} else if (isSpreadsheetElement(child, 't')) {
			if (text !== undefined) { throw new ParadisOfficePackageError('malformed'); }
			text = ownUiText(parseTextNode(child, runtime), runtime);
		} else {
			throw new ParadisOfficePackageError('malformed');
		}
	}
	if (text === undefined) {
		throw new ParadisOfficePackageError('malformed');
	}
	return { text, ...(properties && Reflect.ownKeys(properties).length > 0 ? { properties } : {}) };
}

function parseRichTextProperties(
	node: XmlElement,
	source: ParadisSpreadsheetPartSource,
	opaqueFragments: ParadisSpreadsheetOpaqueAnnotationFragment[],
	runtime: Runtime,
): ParadisSemanticRichTextProperties {
	exactAttributes(node, []);
	const result: Record<string, unknown> = {};
	const seen = new Set<string>();
	for (const child of elementChildren(node, runtime)) {
		if (!isSpreadsheetElement(child) || seen.has(child.local)) {
			throw new ParadisOfficePackageError('malformed');
		}
		seen.add(child.local);
		switch (child.local) {
			case 'b': result.bold = booleanValueElement(child, true, runtime); break;
			case 'i': result.italic = booleanValueElement(child, true, runtime); break;
			case 'strike': result.strike = booleanValueElement(child, true, runtime); break;
			case 'u': result.underline = attribute(child, 'val') ?? 'single'; assertEmptyElement(child, runtime); break;
			case 'rFont': result.fontName = requiredAttribute(child, 'val'); assertEmptyElement(child, runtime); break;
			case 'sz': result.fontSize = requiredAttribute(child, 'val'); assertEmptyElement(child, runtime); break;
			case 'vertAlign': result.verticalAlign = requiredAttribute(child, 'val'); assertEmptyElement(child, runtime); break;
			case 'color': result.color = parseColor(child, runtime); break;
			default: pushOpaqueFragment(opaqueFragments, child, source, runtime); break;
		}
	}
	return result as ParadisSemanticRichTextProperties;
}

function parseTextNode(node: XmlElement, runtime: Runtime): string {
	exactAttributes(node, [], [[xmlNamespace, 'space']]);
	const space = namespacedAttribute(node, xmlNamespace, 'space');
	if (space !== undefined && space !== 'preserve' && space !== 'default') {
		throw new ParadisOfficePackageError('malformed');
	}
	return directText(node, runtime);
}

function booleanValueElement(node: XmlElement, defaultValue: boolean, runtime: Runtime): boolean {
	exactAttributes(node, ['val']);
	assertEmptyElement(node, runtime);
	return booleanAttribute(node, 'val') ?? defaultValue;
}

function parseColor(node: XmlElement, runtime: Runtime): ParadisSemanticRichTextProperties['color'] {
	exactAttributes(node, ['rgb', 'indexed', 'theme', 'tint', 'auto']);
	assertEmptyElement(node, runtime);
	const rgb = attribute(node, 'rgb');
	const indexed = integerAttribute(node, 'indexed');
	const theme = integerAttribute(node, 'theme');
	const auto = booleanAttribute(node, 'auto');
	const variants = Number(rgb !== undefined) + Number(indexed !== undefined) + Number(theme !== undefined) + Number(auto !== undefined);
	if (variants !== 1 || rgb !== undefined && !/^[0-9A-Fa-f]{6}(?:[0-9A-Fa-f]{2})?$/.test(rgb)) {
		throw new ParadisOfficePackageError('malformed');
	}
	if (rgb !== undefined) { return compact({ kind: 'rgb' as const, rgb: rgb.toUpperCase(), tint: attribute(node, 'tint') }); }
	if (indexed !== undefined) { return compact({ kind: 'indexed' as const, indexed, tint: attribute(node, 'tint') }); }
	if (theme !== undefined) { return compact({ kind: 'theme' as const, theme, tint: attribute(node, 'tint') }); }
	return compact({ kind: 'auto' as const, auto, tint: attribute(node, 'tint') });
}

function consumeComment(runtime: Runtime): void {
	runtime.comments = safeAdd(runtime.comments, 1);
	if (runtime.comments > runtime.context.limits.comments) {
		throw new ParadisOfficePackageError('limitExceeded');
	}
}

function parsePersons(
	document: ParadisOfficeXmlDocument,
	source: ParadisSpreadsheetPartSource,
	runtime: Runtime,
): readonly ParadisSpreadsheetPerson[] {
	const root = requiredRoot(document, threadedNamespace, 'personList');
	exactAttributes(root, []);
	const result: ParadisSpreadsheetPerson[] = [];
	const ids = new Set<string>();
	for (const child of elementChildren(root, runtime)) {
		if (child.uri !== threadedNamespace || child.local !== 'person' || result.length >= runtime.context.limits.persons) {
			throw new ParadisOfficePackageError(result.length >= runtime.context.limits.persons ? 'limitExceeded' : 'malformed');
		}
		exactAttributes(child, ['displayName', 'id', 'userId', 'providerId']);
		assertEmptyElement(child, runtime);
		const id = requiredGuidAttribute(child, 'id');
		if (ids.has(id)) { throw new ParadisOfficePackageError('malformed'); }
		ids.add(id);
		result.push(compact({
			id, displayName: textIdentity(requiredAttribute(child, 'displayName'), runtime),
			userId: optionalTextIdentity(attribute(child, 'userId'), runtime),
			providerId: optionalTextIdentity(attribute(child, 'providerId'), runtime), source,
		}));
	}
	return result;
}

function parseThreadedComments(
	document: ParadisOfficeXmlDocument,
	source: ParadisSpreadsheetPartSource,
	persons: readonly ParadisSpreadsheetPerson[],
	opaqueFragments: ParadisSpreadsheetOpaqueAnnotationFragment[],
	runtime: Runtime,
): readonly ParadisSpreadsheetThreadedComment[] {
	const root = requiredRoot(document, threadedNamespace, 'ThreadedComments');
	exactAttributes(root, []);
	const personIds = new Set(persons.map(person => person.id));
	const preliminary: Array<Omit<ParadisSpreadsheetThreadedComment, 'depth'>> = [];
	const ids = new Set<string>();
	for (const child of elementChildren(root, runtime)) {
		if (child.uri !== threadedNamespace || child.local !== 'threadedComment') {
			throw new ParadisOfficePackageError('malformed');
		}
		consumeComment(runtime);
		exactAttributes(child, ['ref', 'dT', 'personId', 'id', 'parentId', 'done']);
		const id = requiredGuidAttribute(child, 'id');
		const personId = requiredGuidAttribute(child, 'personId');
		const parentId = optionalGuidAttribute(child, 'parentId');
		const ref = parseRange(requiredAttribute(child, 'ref')).ref;
		if (ref.includes(':') || ids.has(id) || !personIds.has(personId) || parentId === id) {
			throw new ParadisOfficePackageError('malformed');
		}
		ids.add(id);
		const dateTime = attribute(child, 'dT');
		if (dateTime !== undefined && !validDateTime(dateTime)) {
			throw new ParadisOfficePackageError('malformed');
		}
		let content: ParadisSpreadsheetCommentContent | undefined;
		for (const contentNode of elementChildren(child, runtime)) {
			if (contentNode.uri === threadedNamespace && contentNode.local === 'text' && !content) {
				const rawText = directText(contentNode, runtime);
				const text = ownUiText(rawText, runtime);
				content = { text, runs: [{ text }], fingerprint: fingerprintFragment(contentNode, runtime) };
			} else {
				pushOpaqueFragment(opaqueFragments, contentNode, source, runtime);
			}
		}
		if (!content) { throw new ParadisOfficePackageError('malformed'); }
		preliminary.push(compact({
			id, ref, personId, parentId, resolved: booleanAttribute(child, 'done') ?? false,
			dateTime, content, source,
		}));
	}
	const byId = new Map(preliminary.map(comment => [comment.id, comment]));
	const depths = new Map<string, number>();
	for (const comment of preliminary) {
		checkpoint(runtime);
		if (depths.has(comment.id)) { continue; }
		const chain: string[] = [];
		const visiting = new Set<string>();
		let current: Omit<ParadisSpreadsheetThreadedComment, 'depth'> | undefined = comment;
		let baseDepth = -1;
		while (current) {
			checkpoint(runtime);
			const knownDepth = depths.get(current.id);
			if (knownDepth !== undefined) {
				baseDepth = knownDepth;
				break;
			}
			if (visiting.has(current.id)) {
				throw new ParadisOfficePackageError('malformed');
			}
			visiting.add(current.id);
			chain.push(current.id);
			if (!current.parentId) {
				break;
			}
			const parent = byId.get(current.parentId);
			if (!parent || parent.ref !== current.ref) {
				throw new ParadisOfficePackageError('malformed');
			}
			current = parent;
		}
		for (let index = chain.length - 1; index >= 0; index--) {
			baseDepth = safeAdd(baseDepth, 1);
			if (baseDepth > runtime.context.limits.comments) {
				throw new ParadisOfficePackageError('limitExceeded');
			}
			depths.set(chain[index], baseDepth);
		}
	}
	return preliminary.map(comment => ({ ...comment, depth: depths.get(comment.id)! }));
}

function validDateTime(value: string): boolean {
	const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d+)?(Z|[+\-](\d{2}):(\d{2}))$/.exec(value);
	if (!match) { return false; }
	const year = Number(match[1]);
	const month = Number(match[2]);
	const day = Number(match[3]);
	const hour = Number(match[4]);
	const minute = Number(match[5]);
	const second = Number(match[6]);
	if (year < 1 || month < 1 || month > 12 || day < 1 || day > daysInMonth(year, month) || hour > 23 || minute > 59 || second > 59) {
		return false;
	}
	if (match[7] !== 'Z') {
		const offsetHour = Number(match[8]);
		const offsetMinute = Number(match[9]);
		if (offsetHour > 14 || offsetMinute > 59 || offsetHour === 14 && offsetMinute !== 0) { return false; }
	}
	return true;
}

function daysInMonth(year: number, month: number): number {
	if (month === 2) {
		return year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0) ? 29 : 28;
	}
	return month === 4 || month === 6 || month === 9 || month === 11 ? 30 : 31;
}

function buildCellOverlays(
	legacyNotes: readonly ParadisSpreadsheetLegacyNote[],
	threadedComments: readonly ParadisSpreadsheetThreadedComment[],
	hyperlinks: readonly ParadisSpreadsheetHyperlink[],
	runtime: Runtime,
): readonly ParadisSpreadsheetCellAnnotationOverlay[] {
	interface MutableOverlay {
		readonly ref: string;
		readonly legacyNoteIds: string[];
		readonly threadedCommentIds: string[];
		readonly hyperlinkIds: string[];
	}
	const values = new Map<string, MutableOverlay>();
	const get = (ref: string): MutableOverlay => {
		let value = values.get(ref);
		if (!value) {
			value = { ref, legacyNoteIds: [], threadedCommentIds: [], hyperlinkIds: [] };
			values.set(ref, value);
		}
		return value;
	};
	for (const note of legacyNotes) {
		checkpoint(runtime); get(note.ref).legacyNoteIds.push(note.id);
	}
	for (const comment of threadedComments) {
		checkpoint(runtime); get(comment.ref).threadedCommentIds.push(comment.id);
	}
	for (const hyperlink of hyperlinks) {
		checkpoint(runtime);
		if (!hyperlink.ref.includes(':')) { get(hyperlink.ref).hyperlinkIds.push(hyperlink.id); }
	}
	return [...values.values()].sort((left, right) => compareCellRefs(left.ref, right.ref)).map(value => compact({
		ref: value.ref,
		legacyNoteIds: value.legacyNoteIds.length ? value.legacyNoteIds : undefined,
		threadedCommentIds: value.threadedCommentIds.length ? value.threadedCommentIds : undefined,
		hyperlinkIds: value.hyperlinkIds.length ? value.hyperlinkIds : undefined,
	}));
}

function buildRangeOverlays(
	validations: readonly ParadisSpreadsheetValidation[],
	hyperlinks: readonly ParadisSpreadsheetHyperlink[],
	runtime: Runtime,
): ParadisSpreadsheetAnnotations['rangeOverlays'] {
	const result: Array<ParadisSpreadsheetAnnotations['rangeOverlays'][number]> = [];
	for (const validation of validations) {
		checkpoint(runtime);
		result.push({ ranges: validation.ranges, validationIds: [validation.id] });
	}
	for (const hyperlink of hyperlinks) {
		checkpoint(runtime);
		if (hyperlink.ref.includes(':')) {
			result.push({ ranges: [parseRange(hyperlink.ref)], hyperlinkIds: [hyperlink.id] });
		}
	}
	return result;
}

function compareCellRefs(left: string, right: string): number {
	const leftCoordinate = parseCellReference(left);
	const rightCoordinate = parseCellReference(right);
	return leftCoordinate.row - rightCoordinate.row || leftCoordinate.column - rightCoordinate.column;
}

function spreadsheetRoot(document: ParadisOfficeXmlDocument, local: string): XmlElement {
	if (!document || !isSpreadsheetElement(document.root, local)) {
		throw new ParadisOfficePackageError('malformed');
	}
	return document.root;
}

function requiredRoot(document: ParadisOfficeXmlDocument, uri: string, local: string): XmlElement {
	if (!document || !document.root || document.root.uri !== uri || document.root.local !== local) {
		throw new ParadisOfficePackageError('malformed');
	}
	return document.root;
}

function isSpreadsheetElement(node: XmlElement, local?: string): boolean {
	return spreadsheetNamespaces.has(node.uri) && (local === undefined || node.local === local);
}

function elementChildren(node: XmlElement, runtime: Runtime): readonly XmlElement[] {
	const result: XmlElement[] = [];
	if (!runtime.nodeLocations.has(node)) { runtime.nodeLocations.set(node, { ordinal: 0 }); }
	const counts = new Map<string, number>();
	for (const child of node.children) {
		checkpoint(runtime);
		if (child.kind === 'element') {
			const name = `{${child.uri}}${child.local}`;
			const ordinal = counts.get(name) ?? 0;
			counts.set(name, ordinal + 1);
			runtime.nodeLocations.set(child, { parent: node, ordinal });
			result.push(child);
		} else if (child.value.trim().length > 0) {
			throw new ParadisOfficePackageError('malformed');
		}
	}
	return result;
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

function assertEmptyElement(node: XmlElement, runtime: Runtime): void {
	for (const child of node.children) {
		checkpoint(runtime);
		if (child.kind === 'element' || child.value.trim().length > 0) {
			throw new ParadisOfficePackageError('malformed');
		}
	}
}

function exactAttributes(node: XmlElement, allowed: readonly string[], allowedNamespaced: readonly (readonly [string, string])[] = []): void {
	const names = new Set(allowed);
	const namespaced = new Set(allowedNamespaced.map(([uri, local]) => `{${uri}}${local}`));
	for (const candidate of node.attributes) {
		if (candidate.uri === '' ? !names.has(candidate.local) : !namespaced.has(`{${candidate.uri}}${candidate.local}`)) {
			throw new ParadisOfficePackageError('malformed');
		}
	}
}

function attribute(node: XmlElement, local: string): string | undefined {
	return node.attributes.find(candidate => candidate.uri === '' && candidate.local === local)?.value;
}

function namespacedAttribute(node: XmlElement, uri: string, local: string): string | undefined {
	return node.attributes.find(candidate => candidate.uri === uri && candidate.local === local)?.value;
}

function requiredAttribute(node: XmlElement, local: string): string {
	const value = attribute(node, local);
	if (value === undefined) {
		throw new ParadisOfficePackageError('malformed');
	}
	return value;
}

function relationshipIdAttribute(node: XmlElement): string | undefined {
	const transitional = namespacedAttribute(node, officeRelationshipNamespace, 'id');
	const strict = namespacedAttribute(node, strictOfficeRelationshipNamespace, 'id');
	if (transitional !== undefined && strict !== undefined) {
		throw new ParadisOfficePackageError('malformed');
	}
	return transitional ?? strict;
}

function requiredRelationshipIdAttribute(node: XmlElement): string {
	const value = relationshipIdAttribute(node);
	if (value === undefined) { throw new ParadisOfficePackageError('malformed'); }
	return value;
}

function integerAttribute(node: XmlElement, local: string): number | undefined {
	const value = attribute(node, local);
	if (value === undefined) { return undefined; }
	if (!/^(?:0|[1-9][0-9]*)$/.test(value)) {
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
	if (result === undefined) { throw new ParadisOfficePackageError('malformed'); }
	return result;
}

function booleanAttribute(node: XmlElement, local: string): boolean | undefined {
	const value = attribute(node, local);
	if (value === undefined) { return undefined; }
	if (value === '1' || value === 'true') { return true; }
	if (value === '0' || value === 'false') { return false; }
	throw new ParadisOfficePackageError('malformed');
}

function optionalEnumAttribute<T extends string>(node: XmlElement, local: string, values: readonly T[]): T | undefined {
	const value = attribute(node, local);
	if (value === undefined) { return undefined; }
	if (!values.includes(value as T)) {
		throw new ParadisOfficePackageError('malformed');
	}
	return value as T;
}

function requiredGuidAttribute(node: XmlElement, local: string): string {
	const value = requiredAttribute(node, local);
	if (!/^\{[0-9A-Fa-f]{8}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{12}\}$/.test(value)) {
		throw new ParadisOfficePackageError('malformed');
	}
	return value.toUpperCase();
}

function optionalGuidAttribute(node: XmlElement, local: string): string | undefined {
	return attribute(node, local) === undefined ? undefined : requiredGuidAttribute(node, local);
}

function parseSqref(value: string, runtime: Runtime): readonly ParadisSemanticRange[] {
	if (!value || value !== value.trim()) {
		throw new ParadisOfficePackageError('malformed');
	}
	const result: ParadisSemanticRange[] = [];
	let start = 0;
	for (let index = 0; index <= value.length; index++) {
		checkpoint(runtime);
		if (index < value.length && !/\s/.test(value[index])) { continue; }
		if (index === start) { throw new ParadisOfficePackageError('malformed'); }
		runtime.ranges = safeAdd(runtime.ranges, 1);
		if (runtime.ranges > runtime.context.limits.ranges) {
			throw new ParadisOfficePackageError('limitExceeded');
		}
		result.push(parseRange(value.slice(start, index)));
		while (index + 1 < value.length && /\s/.test(value[index + 1])) {
			checkpoint(runtime); index++;
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
	return {
		ref: parts.length === 1 ? formatCellAddress(start.row, start.column) : `${formatCellAddress(start.row, start.column)}:${formatCellAddress(end.row, end.column)}`,
		minRow: Math.min(start.row, end.row), minColumn: Math.min(start.column, end.column),
		maxRow: Math.max(start.row, end.row), maxColumn: Math.max(start.column, end.column),
	};
}

function parseCellReference(value: string): { readonly row: number; readonly column: number } {
	const match = /^\$?([A-Za-z]{1,3})\$?([1-9][0-9]{0,6})$/.exec(value);
	if (!match) { throw new ParadisOfficePackageError('malformed'); }
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
	let remaining = column;
	let name = '';
	while (remaining > 0) {
		remaining--;
		name = String.fromCharCode(65 + remaining % 26) + name;
		remaining = Math.floor(remaining / 26);
	}
	return `${name}${row}`;
}

function optionalTextIdentity(value: string | undefined, runtime: Runtime): ParadisSpreadsheetTextIdentity | undefined {
	return value === undefined ? undefined : textIdentity(value, runtime);
}

function optionalLocationIdentity(value: string | undefined, runtime: Runtime): ParadisSpreadsheetTextIdentity | undefined {
	if (value === undefined) { return undefined; }
	if (!value || value.startsWith('/') || value.includes('\\')
		|| /^(?:[A-Za-z][A-Za-z0-9+.-]*):/.test(value) && !isCellRangeLocation(value)) {
		throw new ParadisOfficePackageError('malformed');
	}
	return textIdentity(value, runtime);
}

function isCellRangeLocation(value: string): boolean {
	try { parseRange(value); return true; } catch { return false; }
}

function textIdentity(value: string, runtime: Runtime): ParadisSpreadsheetTextIdentity {
	return { text: ownUiText(value, runtime), fingerprint: sha256Text(value, runtime) };
}

function ownUiText(value: string, runtime: Runtime): string {
	if (!isValidUnicodeText(value)) {
		throw new ParadisOfficePackageError('malformed');
	}
	runtime.textCharacters = safeAdd(runtime.textCharacters, value.length);
	if (value.length > runtime.context.limits.textValueCharacters || runtime.textCharacters > runtime.context.limits.textCharacters) {
		throw new ParadisOfficePackageError('limitExceeded');
	}
	let result = '';
	for (const character of value.normalize('NFC')) {
		checkpoint(runtime);
		const code = character.codePointAt(0)!;
		result += isUnsafeDisplayCodePoint(code) ? '\uFFFD' : character;
	}
	return result;
}

function isUnsafeDisplayCodePoint(code: number): boolean {
	return code < 0x20 && code !== 0x09 && code !== 0x0a && code !== 0x0d
		|| code >= 0x7f && code <= 0x9f
		|| code === 0x061c || code === 0x200b || code === 0x200c || code === 0x200d
		|| code >= 0x202a && code <= 0x202e || code >= 0x2066 && code <= 0x2069
		|| code === 0xfeff;
}

function containsUnsafeControl(value: string): boolean {
	for (const character of value) {
		if (isUnsafeDisplayCodePoint(character.codePointAt(0)!)) { return true; }
	}
	return false;
}

function isValidUnicodeText(value: string): boolean {
	for (let index = 0; index < value.length; index++) {
		const code = value.charCodeAt(index);
		if (code >= 0xd800 && code <= 0xdbff) {
			if (++index >= value.length || value.charCodeAt(index) < 0xdc00 || value.charCodeAt(index) > 0xdfff) { return false; }
		} else if (code >= 0xdc00 && code <= 0xdfff || code === 0) {
			return false;
		}
	}
	return true;
}

function pushOpaqueFragment(
	result: ParadisSpreadsheetOpaqueAnnotationFragment[],
	node: XmlElement,
	source: ParadisSpreadsheetPartSource,
	runtime: Runtime,
): void {
	runtime.opaqueFragments = safeAdd(runtime.opaqueFragments, 1);
	if (runtime.opaqueFragments > runtime.context.limits.opaqueFragments) {
		throw new ParadisOfficePackageError('limitExceeded');
	}
	const location = runtime.nodeLocations.get(node);
	if (!location) { throw new ParadisOfficePackageError('unsafe'); }
	result.push({
		name: { namespace: node.uri, local: node.local }, path: materializeNodePath(node, runtime), ordinal: location.ordinal,
		fingerprint: fingerprintFragment(node, runtime, runtime.relationshipScopes.get(source.partId)), source,
	});
}

function materializeNodePath(node: XmlElement, runtime: Runtime): string {
	const segments: string[] = [];
	let current: XmlElement | undefined = node;
	while (current) {
		checkpoint(runtime);
		const location = runtime.nodeLocations.get(current);
		if (!location || segments.length >= runtime.context.limits.xmlDepth) { throw new ParadisOfficePackageError('unsafe'); }
		segments.push(`{${current.uri}}${current.local}[${location.ordinal}]`);
		current = location.parent;
	}
	return `/${segments.reverse().join('/')}`;
}

function fingerprintFragment(
	node: XmlElement,
	runtime: Runtime,
	relationshipTargets?: ReadonlyMap<string, string>,
): ParadisSpreadsheetPartSource['fingerprint'] {
	const chunks: string[] = [];
	interface Frame { readonly node: ParadisOfficeXmlNode; readonly closing?: boolean; readonly preserveSpace: boolean; readonly parentHasElements?: boolean }
	const stack: Frame[] = [{ node, preserveSpace: false }];
	while (stack.length > 0) {
		checkpoint(runtime);
		const frame = stack.pop()!;
		if (frame.node.kind === 'text') {
			if (!frame.preserveSpace && frame.parentHasElements && frame.node.value.trim().length === 0) { continue; }
			pushOpaqueText(chunks, `T${frame.node.value.length}:${frame.node.value}`, runtime);
			continue;
		}
		if (frame.closing) {
			pushOpaqueText(chunks, 'E;', runtime);
			continue;
		}
		const attributes = [...frame.node.attributes].sort((left, right) => compareCodePoint(`${left.uri}\0${left.local}`, `${right.uri}\0${right.local}`));
		const space = frame.node.attributes.find(attribute => attribute.uri === xmlNamespace && attribute.local === 'space')?.value;
		const preserveSpace = space === 'preserve' ? true : space === 'default' ? false : frame.preserveSpace;
		const hasElements = frame.node.children.some(child => child.kind === 'element');
		pushOpaqueText(chunks, `S${frame.node.uri.length}:${frame.node.uri}${frame.node.local.length}:${frame.node.local};`, runtime);
		for (const attribute of attributes) {
			const value = officeRelationshipNamespaces.has(attribute.uri) && attribute.local === 'id'
				? relationshipTargets?.get(attribute.value) ?? attribute.value
				: attribute.value;
			pushOpaqueText(chunks, `A${attribute.uri.length}:${attribute.uri}${attribute.local.length}:${attribute.local}${value.length}:${value};`, runtime);
		}
		stack.push({ node: frame.node, closing: true, preserveSpace });
		for (let index = frame.node.children.length - 1; index >= 0; index--) {
			stack.push({ node: frame.node.children[index], preserveSpace, parentHasElements: hasElements });
		}
	}
	return sha256Text(chunks.join(''), runtime);
}

function compareCodePoint(left: string, right: string): number {
	return left < right ? -1 : left > right ? 1 : 0;
}

function pushOpaqueText(chunks: string[], value: string, runtime: Runtime): void {
	runtime.opaqueCharacters = safeAdd(runtime.opaqueCharacters, value.length);
	if (runtime.opaqueCharacters > runtime.context.limits.opaqueCharacters) {
		throw new ParadisOfficePackageError('limitExceeded');
	}
	chunks.push(value);
}

function verifyXmlSource(xml: string, source: ParadisSpreadsheetPartSource, runtime: Runtime): void {
	const fingerprint = sha256Text(xml, runtime);
	if (fingerprint.byteLength > runtime.context.limits.xmlCharacters) {
		throw new ParadisOfficePackageError('limitExceeded');
	}
	if (fingerprint.value !== source.fingerprint.value || fingerprint.byteLength !== source.fingerprint.byteLength) {
		throw new ParadisOfficePackageError('unsafe');
	}
}

function verifyByteSource(bytes: Uint8Array, source: ParadisSpreadsheetPartSource, runtime: Runtime): void {
	const fingerprint = sha256Bytes(bytes, runtime);
	if (fingerprint.value !== source.fingerprint.value || fingerprint.byteLength !== source.fingerprint.byteLength) {
		throw new ParadisOfficePackageError('unsafe');
	}
}

function sha256Text(value: string, runtime?: Runtime): ParadisSpreadsheetPartSource['fingerprint'] {
	const bytes = new TextEncoder().encode(value);
	return sha256Bytes(bytes, runtime);
}

function sha256Bytes(bytes: Uint8Array, runtime?: Runtime): ParadisSpreadsheetPartSource['fingerprint'] {
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
		for (let index = 0; index < 16; index++) { words[index] = view.getUint32(offset + index * 4, false); }
		for (let index = 16; index < 64; index++) {
			const left = words[index - 15];
			const right = words[index - 2];
			const sigma0 = rotateRight(left, 7) ^ rotateRight(left, 18) ^ (left >>> 3);
			const sigma1 = rotateRight(right, 17) ^ rotateRight(right, 19) ^ (right >>> 10);
			words[index] = (words[index - 16] + sigma0 + words[index - 7] + sigma1) >>> 0;
		}
		let [a, b, c, d, e, f, g, h] = state;
		for (let index = 0; index < 64; index++) {
			const sigma1 = rotateRight(e, 6) ^ rotateRight(e, 11) ^ rotateRight(e, 25);
			const choice = (e & f) ^ (~e & g);
			const temporary1 = (h + sigma1 + choice + constants[index] + words[index]) >>> 0;
			const sigma0 = rotateRight(a, 2) ^ rotateRight(a, 13) ^ rotateRight(a, 22);
			const majority = (a & b) ^ (a & c) ^ (b & c);
			const temporary2 = (sigma0 + majority) >>> 0;
			h = g; g = f; f = e; e = (d + temporary1) >>> 0; d = c; c = b; b = a; a = (temporary1 + temporary2) >>> 0;
		}
		state[0] = (state[0] + a) >>> 0; state[1] = (state[1] + b) >>> 0;
		state[2] = (state[2] + c) >>> 0; state[3] = (state[3] + d) >>> 0;
		state[4] = (state[4] + e) >>> 0; state[5] = (state[5] + f) >>> 0;
		state[6] = (state[6] + g) >>> 0; state[7] = (state[7] + h) >>> 0;
	}
	return { algorithm: 'sha256', value: [...state].map(word => word.toString(16).padStart(8, '0')).join(''), byteLength: bytes.length };
}

function rotateRight(value: number, bits: number): number {
	return (value >>> bits) | (value << (32 - bits));
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
		if (!descriptor) { continue; }
		if (!Object.prototype.hasOwnProperty.call(descriptor, 'value')) {
			throw new ParadisOfficePackageError('unsafe');
		}
		result[key] = descriptor.value;
	}
	return result;
}

function ownArray(value: unknown, limit: number, runtime: Runtime): readonly unknown[] {
	if (!Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype) {
		throw new ParadisOfficePackageError('unsafe');
	}
	const lengthDescriptor = Object.getOwnPropertyDescriptor(value, 'length');
	if (!lengthDescriptor || !Object.prototype.hasOwnProperty.call(lengthDescriptor, 'value')
		|| !Number.isSafeInteger(lengthDescriptor.value) || lengthDescriptor.value < 0 || lengthDescriptor.value > limit) {
		throw new ParadisOfficePackageError(lengthDescriptor && lengthDescriptor.value > limit ? 'limitExceeded' : 'unsafe');
	}
	const length = lengthDescriptor.value as number;
	const result: unknown[] = [];
	for (let index = 0; index < length; index++) {
		checkpoint(runtime);
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

function ownBytes(value: unknown, limit: number, runtime?: Runtime): Uint8Array {
	if (!ArrayBuffer.isView(value) || !(value instanceof Uint8Array) || Object.getPrototypeOf(value) !== Uint8Array.prototype) {
		throw new ParadisOfficePackageError('unsafe');
	}
	const length = value.byteLength;
	if (!Number.isSafeInteger(length) || length < 0 || length > limit) {
		throw new ParadisOfficePackageError(length > limit ? 'limitExceeded' : 'unsafe');
	}
	if (runtime) { checkpoint(runtime, true); }
	const result = new Uint8Array(length);
	Uint8Array.prototype.set.call(result, value);
	if (runtime) { checkpoint(runtime, true); }
	return result;
}

function ownPartSource(value: unknown): ParadisSpreadsheetPartSource {
	const source = ownRecord(value, new Set(['partId', 'fingerprint']));
	const fingerprint = ownRecord(source.fingerprint, new Set(['algorithm', 'value', 'byteLength']));
	if (typeof source.partId !== 'string' || canonicalPartId(source.partId) !== source.partId
		|| fingerprint.algorithm !== 'sha256' || typeof fingerprint.value !== 'string' || !/^[0-9a-f]{64}$/i.test(fingerprint.value)
		|| !Number.isSafeInteger(fingerprint.byteLength) || (fingerprint.byteLength as number) < 0) {
		throw new ParadisOfficePackageError('unsafe');
	}
	return {
		partId: source.partId,
		fingerprint: { algorithm: 'sha256', value: fingerprint.value.toLowerCase(), byteLength: fingerprint.byteLength as number },
	};
}

function safeAdd(left: number, right: number): number {
	const result = left + right;
	if (!Number.isSafeInteger(result) || result < 0) {
		throw new ParadisOfficePackageError('limitExceeded');
	}
	return result;
}

function compact<T extends object>(value: T): T {
	const result: Record<string, unknown> = {};
	for (const [key, entry] of Object.entries(value)) {
		if (entry !== undefined) { result[key] = entry; }
	}
	return result as T;
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
		if (Object.isFrozen(current)) { continue; }
		runtime.outputNodes = safeAdd(runtime.outputNodes, 1);
		if (runtime.outputNodes > runtime.context.limits.outputNodes) { throw new ParadisOfficePackageError('limitExceeded'); }
		const keys: PropertyKey[] = [];
		if (Array.isArray(current)) {
			const length = Object.getOwnPropertyDescriptor(current, 'length')?.value;
			if (!Number.isSafeInteger(length) || length < 0) { throw new ParadisOfficePackageError('unsafe'); }
			for (let index = 0; index < length; index++) { keys.push(String(index)); }
		} else {
			keys.push(...Reflect.ownKeys(current));
		}
		runtime.outputProperties = safeAdd(runtime.outputProperties, keys.length);
		if (runtime.outputProperties > runtime.context.limits.outputProperties) { throw new ParadisOfficePackageError('limitExceeded'); }
		for (const key of keys) {
			const child = Object.getOwnPropertyDescriptor(current, key)?.value;
			if (child && typeof child === 'object') { stack.push(child); }
		}
		Object.freeze(current);
	}
	return value;
}

function sanitizeAnnotationsError(error: unknown): ParadisOfficePackageError {
	try {
		if (error instanceof ParadisOfficePackageError) {
			const code = Object.getOwnPropertyDescriptor(error, 'code')?.value;
			if (code === 'invalid' || code === 'encrypted' || code === 'zipBomb' || code === 'limitExceeded'
				|| code === 'malformed' || code === 'cancelled' || code === 'unsafe') {
				return new ParadisOfficePackageError(code);
			}
		}
	} catch { /* Poisoned failures never cross the parser boundary. */ }
	return new ParadisOfficePackageError('unsafe');
}
