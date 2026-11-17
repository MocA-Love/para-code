/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import type { CancellationToken } from '../../../../../base/common/cancellation.js';
import { ParadisOfficePackageError, throwIfParadisOfficeCancelled, type ParadisOfficeXmlDocument, type ParadisOfficeXmlNode } from '../office/paradisOfficeArchive.js';
import { parseParadisOfficeXml, sha256ParadisOfficeBytes } from '../office/paradisOfficeCanonicalXml.js';
import type { ParadisOfficeFingerprint } from '../paradisOfficeProtocol.js';
import {
	type ParadisSpreadsheetChart,
	type ParadisSpreadsheetChartCachePoint,
	type ParadisSpreadsheetChartNumberData,
	type ParadisSpreadsheetChartSeries,
	type ParadisSpreadsheetChartStringData,
	type ParadisSpreadsheetDrawing,
	type ParadisSpreadsheetDrawingAnchor,
	type ParadisSpreadsheetDrawingExtent,
	type ParadisSpreadsheetDrawingLineStyle,
	type ParadisSpreadsheetDrawingMarker,
	type ParadisSpreadsheetDrawingPosition,
	type ParadisSpreadsheetDrawingTransform,
	type ParadisSpreadsheetImage,
	type ParadisSpreadsheetImageCrop,
	type ParadisSpreadsheetObjects,
	type ParadisSpreadsheetOpaqueDrawing,
	type ParadisSpreadsheetPivot,
	type ParadisSpreadsheetPivotCache,
	type ParadisSpreadsheetPivotSource,
	type ParadisSpreadsheetPivotValue,
	type ParadisSpreadsheetProtectionCredential,
	type ParadisSpreadsheetSheetProtection,
	type ParadisSpreadsheetUnsafePart,
	type ParadisSpreadsheetWorkbookProtection,
} from './paradisSpreadsheetObjects.js';
import type { ParadisSpreadsheetPartSource } from './paradisSpreadsheetSemantic.js';

export { bindSpreadsheetObjectsToSheet } from './paradisSpreadsheetObjects.js';
export type * from './paradisSpreadsheetObjects.js';

type XmlElement = Extract<ParadisOfficeXmlNode, { readonly kind: 'element' }>;

export interface ParadisSpreadsheetObjectPartInput {
	readonly bytes: Uint8Array;
	readonly source: ParadisSpreadsheetPartSource;
}

export interface ParadisSpreadsheetObjectsInput {
	readonly parts: readonly ParadisSpreadsheetObjectPartInput[];
	readonly token?: CancellationToken;
}

interface OwnedPart {
	readonly bytes: Uint8Array;
	readonly source: ParadisSpreadsheetPartSource;
	readonly contentType?: string;
}

interface ContentTypes {
	readonly defaults: ReadonlyMap<string, string>;
	readonly overrides: ReadonlyMap<string, string>;
}

interface Relationship {
	readonly id: string;
	readonly type: string;
	readonly suffix: string;
	readonly external: boolean;
	readonly target?: string;
	readonly targetFingerprint?: ParadisOfficeFingerprint;
	readonly targetScheme?: string;
}

interface DrawingResult {
	readonly images: readonly ParadisSpreadsheetImage[];
	readonly drawings: readonly ParadisSpreadsheetDrawing[];
	readonly charts: readonly ParadisSpreadsheetChart[];
	readonly opaqueDrawings: readonly ParadisSpreadsheetOpaqueDrawing[];
}

const contentTypeNamespace = 'http://schemas.openxmlformats.org/package/2006/content-types';
const packageRelationshipNamespace = 'http://schemas.openxmlformats.org/package/2006/relationships';
const spreadsheetNamespaces = new Set([
	'http://schemas.openxmlformats.org/spreadsheetml/2006/main',
	'http://purl.oclc.org/ooxml/spreadsheetml/main',
]);
const spreadsheetDrawingNamespaces = new Set([
	'http://schemas.openxmlformats.org/drawingml/2006/spreadsheetDrawing',
	'http://purl.oclc.org/ooxml/drawingml/spreadsheetDrawing',
]);
const drawingMainNamespaces = new Set([
	'http://schemas.openxmlformats.org/drawingml/2006/main',
	'http://purl.oclc.org/ooxml/drawingml/main',
]);
const chartNamespaces = new Set([
	'http://schemas.openxmlformats.org/drawingml/2006/chart',
	'http://purl.oclc.org/ooxml/drawingml/chart',
]);
const officeRelationshipNamespaces = new Set([
	'http://schemas.openxmlformats.org/officeDocument/2006/relationships',
	'http://purl.oclc.org/ooxml/officeDocument/relationships',
]);
const relationshipsContentType = 'application/vnd.openxmlformats-package.relationships+xml';
const workbookContentTypes = new Set([
	'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml',
	'application/vnd.ms-excel.sheet.macroenabled.main+xml',
	'application/vnd.openxmlformats-officedocument.spreadsheetml.template.main+xml',
	'application/vnd.ms-excel.template.macroenabled.main+xml',
]);
const worksheetContentTypes = new Set([
	'application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml',
	'application/vnd.openxmlformats-officedocument.spreadsheetml.chartsheet+xml',
]);
const drawingContentTypes = new Set(['application/vnd.openxmlformats-officedocument.drawing+xml']);
const chartContentTypes = new Set(['application/vnd.openxmlformats-officedocument.drawingml.chart+xml']);
const pivotTableContentTypes = new Set(['application/vnd.openxmlformats-officedocument.spreadsheetml.pivottable+xml']);
const pivotCacheDefinitionContentTypes = new Set(['application/vnd.openxmlformats-officedocument.spreadsheetml.pivotcachedefinition+xml']);
const pivotCacheRecordsContentTypes = new Set(['application/vnd.openxmlformats-officedocument.spreadsheetml.pivotcacherecords+xml']);
const maxParts = 2_048;
const maxPartBytes = 64 * 1024 * 1024;
const maxTotalBytes = 256 * 1024 * 1024;
const xmlLimits = { depth: 128, nodes: 500_000, attributeLength: 1024 * 1024, characters: 64 * 1024 * 1024 } as const;

export function parseSpreadsheetObjects(input: ParadisSpreadsheetObjectsInput): ParadisSpreadsheetObjects {
	try {
		throwIfParadisOfficeCancelled(input?.token);
		const rawParts = ownParts(input?.parts, input?.token);
		const contentTypesPart = rawParts.get('/[Content_Types].xml');
		if (!contentTypesPart) {
			throw new ParadisOfficePackageError('malformed');
		}
		const contentTypes = parseContentTypes(parseXml(contentTypesPart, input.token));
		const parts = attachContentTypes(rawParts, contentTypes);
		const relationships = parseAllRelationships(parts, input.token);
		validatePackageRoot(parts, relationships);

		const workbook = exactlyOnePart(parts, workbookContentTypes);
		const workbookDocument = parseXml(workbook, input.token);
		const workbookProtection = parseWorkbookProtection(workbookDocument);
		const sheetProtections = [...parts.values()]
			.filter(part => part.contentType && worksheetContentTypes.has(part.contentType.toLocaleLowerCase('en-US')))
			.map(part => parseSheetProtection(part, input.token))
			.filter((value): value is ParadisSpreadsheetSheetProtection => value !== undefined);

		const drawingResults = [...parts.values()]
			.filter(part => part.contentType && drawingContentTypes.has(part.contentType.toLocaleLowerCase('en-US')))
			.map(part => parseDrawingPart(part, parts, relationships, input.token));
		const pivots = parsePivots(parts, relationships, workbook, workbookDocument, input.token);
		const unsafeParts = parseUnsafeParts(parts);
		const externalReferences = [...relationships.values()].flatMap(value => value)
			.filter(relationship => relationship.external)
			.map(relationship => ({
				relationshipType: relationship.suffix,
				...(relationship.targetScheme ? { targetScheme: relationship.targetScheme } : {}),
				targetFingerprint: relationship.targetFingerprint!,
				behavior: 'notFetched' as const,
			}));
		const opaqueParts = parseOpaqueParts(parts);

		return deepFreeze({
			images: drawingResults.flatMap(value => value.images),
			drawings: drawingResults.flatMap(value => value.drawings),
			charts: drawingResults.flatMap(value => value.charts),
			opaqueDrawings: drawingResults.flatMap(value => value.opaqueDrawings),
			pivots,
			security: {
				...(workbookProtection ? { workbookProtection } : {}),
				sheetProtections,
				unsafeParts,
				externalReferences,
			},
			opaqueParts,
		});
	} catch (error) {
		throw sanitizeError(error);
	}
}

export function fingerprintSpreadsheetObjectBytes(bytes: Uint8Array): ParadisOfficeFingerprint {
	try {
		if (!(bytes instanceof Uint8Array) || bytes.byteLength > maxPartBytes) {
			throw new ParadisOfficePackageError(bytes instanceof Uint8Array ? 'limitExceeded' : 'unsafe');
		}
		return sha256Bytes(bytes);
	} catch (error) {
		throw sanitizeError(error);
	}
}

function ownParts(value: readonly ParadisSpreadsheetObjectPartInput[] | undefined, token: CancellationToken | undefined): ReadonlyMap<string, OwnedPart> {
	if (!Array.isArray(value) || value.length === 0 || value.length > maxParts) {
		throw new ParadisOfficePackageError(value && value.length > maxParts ? 'limitExceeded' : 'malformed');
	}
	const parts = new Map<string, OwnedPart>();
	let total = 0;
	for (const candidate of value) {
		throwIfParadisOfficeCancelled(token);
		if (!candidate || typeof candidate !== 'object' || !(candidate.bytes instanceof Uint8Array)) {
			throw new ParadisOfficePackageError('unsafe');
		}
		const source = ownSource(candidate.source);
		if (parts.has(source.partId)) {
			throw new ParadisOfficePackageError('malformed');
		}
		if (candidate.bytes.byteLength > maxPartBytes) {
			throw new ParadisOfficePackageError('limitExceeded');
		}
		total += candidate.bytes.byteLength;
		if (!Number.isSafeInteger(total) || total > maxTotalBytes) {
			throw new ParadisOfficePackageError('limitExceeded');
		}
		const bytes = Uint8Array.from(candidate.bytes);
		const actual = sha256Bytes(bytes);
		if (actual.value !== source.fingerprint.value || actual.byteLength !== source.fingerprint.byteLength) {
			throw new ParadisOfficePackageError('unsafe');
		}
		parts.set(source.partId, { bytes, source });
	}
	return parts;
}

function ownSource(value: ParadisSpreadsheetPartSource): ParadisSpreadsheetPartSource {
	if (!value || typeof value !== 'object' || canonicalPartId(value.partId) !== value.partId || !value.fingerprint
		|| value.fingerprint.algorithm !== 'sha256' || !/^[0-9a-f]{64}$/i.test(value.fingerprint.value)
		|| !Number.isSafeInteger(value.fingerprint.byteLength) || value.fingerprint.byteLength < 0) {
		throw new ParadisOfficePackageError('unsafe');
	}
	return {
		partId: value.partId,
		fingerprint: { algorithm: 'sha256', value: value.fingerprint.value.toLocaleLowerCase('en-US'), byteLength: value.fingerprint.byteLength },
	};
}

function parseXml(part: OwnedPart, token: CancellationToken | undefined): ParadisOfficeXmlDocument {
	if (part.bytes.byteLength > xmlLimits.characters) {
		throw new ParadisOfficePackageError('limitExceeded');
	}
	let xml: string;
	try {
		xml = new TextDecoder('utf-8', { fatal: true }).decode(part.bytes);
	} catch {
		throw new ParadisOfficePackageError('malformed');
	}
	return parseParadisOfficeXml(xml, xmlLimits, token);
}

function parseContentTypes(document: ParadisOfficeXmlDocument): ContentTypes {
	const root = document.root;
	if (root.uri !== contentTypeNamespace || root.local !== 'Types') {
		throw new ParadisOfficePackageError('malformed');
	}
	const defaults = new Map<string, string>();
	const overrides = new Map<string, string>();
	for (const child of elements(root)) {
		if (child.uri !== contentTypeNamespace || child.local !== 'Default' && child.local !== 'Override') {
			throw new ParadisOfficePackageError('malformed');
		}
		const contentType = requiredAttribute(child, 'ContentType');
		if (!validContentType(contentType)) {
			throw new ParadisOfficePackageError('malformed');
		}
		if (child.local === 'Default') {
			const extension = requiredAttribute(child, 'Extension').toLocaleLowerCase('en-US');
			if (!extension || extension.includes('/') || defaults.has(extension)) {
				throw new ParadisOfficePackageError('malformed');
			}
			defaults.set(extension, contentType);
		} else {
			const partId = canonicalPartId(requiredAttribute(child, 'PartName'));
			if (overrides.has(partId)) {
				throw new ParadisOfficePackageError('malformed');
			}
			overrides.set(partId, contentType);
		}
	}
	return { defaults, overrides };
}

function attachContentTypes(parts: ReadonlyMap<string, OwnedPart>, contentTypes: ContentTypes): ReadonlyMap<string, OwnedPart> {
	const result = new Map<string, OwnedPart>();
	for (const [partId, part] of parts) {
		if (partId === '/[Content_Types].xml') {
			result.set(partId, part);
			continue;
		}
		const extension = partId.slice(partId.lastIndexOf('.') + 1).toLocaleLowerCase('en-US');
		const contentType = contentTypes.overrides.get(partId) ?? contentTypes.defaults.get(extension);
		if (!contentType) {
			throw new ParadisOfficePackageError('unsafe');
		}
		if (partId.endsWith('.rels') && contentType !== relationshipsContentType) {
			throw new ParadisOfficePackageError('unsafe');
		}
		result.set(partId, { ...part, contentType });
	}
	return result;
}

function parseAllRelationships(parts: ReadonlyMap<string, OwnedPart>, token: CancellationToken | undefined): ReadonlyMap<string, readonly Relationship[]> {
	const result = new Map<string, readonly Relationship[]>();
	for (const part of parts.values()) {
		if (part.contentType !== relationshipsContentType) {
			continue;
		}
		throwIfParadisOfficeCancelled(token);
		const owner = relationshipOwner(part.source.partId);
		if (owner !== '/' && !parts.has(owner) || result.has(owner)) {
			throw new ParadisOfficePackageError('malformed');
		}
		const root = parseXml(part, token).root;
		if (root.uri !== packageRelationshipNamespace || root.local !== 'Relationships') {
			throw new ParadisOfficePackageError('malformed');
		}
		const ids = new Set<string>();
		const relationships: Relationship[] = [];
		for (const child of elements(root)) {
			if (child.uri !== packageRelationshipNamespace || child.local !== 'Relationship') {
				throw new ParadisOfficePackageError('malformed');
			}
			const id = requiredAttribute(child, 'Id');
			const type = requiredAttribute(child, 'Type');
			const target = requiredAttribute(child, 'Target');
			const mode = attribute(child, 'TargetMode');
			if (!id || ids.has(id) || !validRelationshipType(type) || mode !== undefined && mode !== 'External') {
				throw new ParadisOfficePackageError('malformed');
			}
			ids.add(id);
			const suffix = type.slice(type.lastIndexOf('/') + 1);
			if (mode === 'External') {
				const scheme = /^([A-Za-z][A-Za-z0-9+.-]*):/.exec(target)?.[1]?.toLocaleLowerCase('en-US');
				relationships.push({ id, type, suffix, external: true, targetFingerprint: sha256Bytes(new TextEncoder().encode(target)), ...(scheme ? { targetScheme: scheme } : {}) });
			} else {
				const resolved = resolveTarget(owner, target);
				if (!parts.has(resolved)) {
					throw new ParadisOfficePackageError('unsafe');
				}
				relationships.push({ id, type, suffix, external: false, target: resolved });
			}
		}
		result.set(owner, relationships);
	}
	return result;
}

function validatePackageRoot(parts: ReadonlyMap<string, OwnedPart>, relationships: ReadonlyMap<string, readonly Relationship[]>): void {
	const roots = (relationships.get('/') ?? []).filter(value => relationshipMatches(value, 'officeDocument'));
	if (roots.length !== 1 || roots[0].external || !roots[0].target) {
		throw new ParadisOfficePackageError('unsafe');
	}
	const workbook = parts.get(roots[0].target);
	if (!workbook?.contentType || !workbookContentTypes.has(workbook.contentType.toLocaleLowerCase('en-US'))) {
		throw new ParadisOfficePackageError('unsafe');
	}
}

function exactlyOnePart(parts: ReadonlyMap<string, OwnedPart>, contentTypes: ReadonlySet<string>): OwnedPart {
	const found = [...parts.values()].filter(part => part.contentType && contentTypes.has(part.contentType.toLocaleLowerCase('en-US')));
	if (found.length !== 1) {
		throw new ParadisOfficePackageError('malformed');
	}
	return found[0];
}

function parseWorkbookProtection(document: ParadisOfficeXmlDocument): ParadisSpreadsheetWorkbookProtection | undefined {
	const root = spreadsheetRoot(document, 'workbook');
	const protection = child(root, spreadsheetNamespaces, 'workbookProtection');
	if (!protection) {
		return undefined;
	}
	const credential = parseProtectionCredential(protection, 'workbook');
	return compact({
		lockStructure: optionalBoolean(protection, 'lockStructure'),
		lockWindows: optionalBoolean(protection, 'lockWindows'),
		lockRevision: optionalBoolean(protection, 'lockRevision'),
		credential,
	});
}

function parseSheetProtection(part: OwnedPart, token: CancellationToken | undefined): ParadisSpreadsheetSheetProtection | undefined {
	const root = parseXml(part, token).root;
	if (!spreadsheetNamespaces.has(root.uri) || root.local !== 'worksheet' && root.local !== 'chartsheet') {
		throw new ParadisOfficePackageError('malformed');
	}
	const protection = child(root, spreadsheetNamespaces, 'sheetProtection');
	if (!protection) {
		return undefined;
	}
	return compact({
		source: part.source,
		sheet: optionalBoolean(protection, 'sheet'),
		objects: optionalBoolean(protection, 'objects'),
		scenarios: optionalBoolean(protection, 'scenarios'),
		formatCells: optionalBoolean(protection, 'formatCells'),
		formatColumns: optionalBoolean(protection, 'formatColumns'),
		formatRows: optionalBoolean(protection, 'formatRows'),
		insertColumns: optionalBoolean(protection, 'insertColumns'),
		insertRows: optionalBoolean(protection, 'insertRows'),
		insertHyperlinks: optionalBoolean(protection, 'insertHyperlinks'),
		deleteColumns: optionalBoolean(protection, 'deleteColumns'),
		deleteRows: optionalBoolean(protection, 'deleteRows'),
		selectLockedCells: optionalBoolean(protection, 'selectLockedCells'),
		sort: optionalBoolean(protection, 'sort'),
		autoFilter: optionalBoolean(protection, 'autoFilter'),
		pivotTables: optionalBoolean(protection, 'pivotTables'),
		selectUnlockedCells: optionalBoolean(protection, 'selectUnlockedCells'),
		credential: parseProtectionCredential(protection, 'sheet'),
	});
}

function parseProtectionCredential(node: XmlElement, prefix: 'workbook' | 'sheet'): ParadisSpreadsheetProtectionCredential | undefined {
	const algorithm = attribute(node, prefix === 'workbook' ? 'workbookAlgorithmName' : 'algorithmName');
	const spinCount = optionalInteger(node, prefix === 'workbook' ? 'workbookSpinCount' : 'spinCount');
	const salt = attribute(node, prefix === 'workbook' ? 'workbookSaltValue' : 'saltValue');
	const hash = attribute(node, prefix === 'workbook' ? 'workbookHashValue' : 'hashValue');
	const legacyPassword = attribute(node, prefix === 'workbook' ? 'workbookPassword' : 'password');
	const legacyRevisionPassword = prefix === 'workbook' ? attribute(node, 'revisionsPassword') : undefined;
	if (algorithm === undefined && spinCount === undefined && salt === undefined && hash === undefined && legacyPassword === undefined && legacyRevisionPassword === undefined) {
		return undefined;
	}
	return compact({
		algorithm,
		spinCount,
		saltFingerprint: salt === undefined ? undefined : sha256Bytes(new TextEncoder().encode(salt)),
		hashFingerprint: hash === undefined ? undefined : sha256Bytes(new TextEncoder().encode(hash)),
		legacyPasswordFingerprint: legacyPassword === undefined ? undefined : sha256Bytes(new TextEncoder().encode(legacyPassword)),
		legacyRevisionPasswordFingerprint: legacyRevisionPassword === undefined ? undefined : sha256Bytes(new TextEncoder().encode(legacyRevisionPassword)),
	});
}

function parseDrawingPart(
	part: OwnedPart,
	parts: ReadonlyMap<string, OwnedPart>,
	relationshipsByOwner: ReadonlyMap<string, readonly Relationship[]>,
	token: CancellationToken | undefined,
): DrawingResult {
	const root = parseXml(part, token).root;
	if (!spreadsheetDrawingNamespaces.has(root.uri) || root.local !== 'wsDr') {
		throw new ParadisOfficePackageError('malformed');
	}
	const relationships = relationshipsByOwner.get(part.source.partId) ?? [];
	const images: ParadisSpreadsheetImage[] = [];
	const drawings: ParadisSpreadsheetDrawing[] = [];
	const charts: ParadisSpreadsheetChart[] = [];
	const opaqueDrawings: ParadisSpreadsheetOpaqueDrawing[] = [];
	let ordinal = 0;
	for (const anchorNode of elements(root)) {
		throwIfParadisOfficeCancelled(token);
		if (!spreadsheetDrawingNamespaces.has(anchorNode.uri) || !['twoCellAnchor', 'oneCellAnchor', 'absoluteAnchor'].includes(anchorNode.local)) {
			continue;
		}
		const anchor = parseAnchor(anchorNode);
		const picture = child(anchorNode, spreadsheetDrawingNamespaces, 'pic');
		const shape = child(anchorNode, spreadsheetDrawingNamespaces, 'sp') ?? child(anchorNode, spreadsheetDrawingNamespaces, 'cxnSp');
		const graphicFrame = child(anchorNode, spreadsheetDrawingNamespaces, 'graphicFrame');
		if (picture) {
			images.push(parseImage(picture, anchor, part, parts, relationships, ordinal));
		} else if (shape) {
			drawings.push(parseShape(shape, anchor, part, ordinal));
		} else if (graphicFrame) {
			const parsedChart = parseChartFrame(graphicFrame, anchor, part, parts, relationships, ordinal, token);
			if (parsedChart) {
				charts.push(parsedChart);
			} else {
				opaqueDrawings.push(parseOpaqueDrawing(anchor, part, ordinal));
			}
		} else {
			opaqueDrawings.push(parseOpaqueDrawing(anchor, part, ordinal));
		}
		ordinal++;
	}
	return { images, drawings, charts, opaqueDrawings };
}

function parseAnchor(node: XmlElement): ParadisSpreadsheetDrawingAnchor {
	if (node.local === 'twoCellAnchor') {
		const editAs = attribute(node, 'editAs');
		if (editAs !== undefined && editAs !== 'absolute' && editAs !== 'oneCell' && editAs !== 'twoCell') {
			throw new ParadisOfficePackageError('malformed');
		}
		return compact({
			kind: 'twoCell' as const,
			editAs,
			from: parseMarker(requiredChild(node, spreadsheetDrawingNamespaces, 'from')),
			to: parseMarker(requiredChild(node, spreadsheetDrawingNamespaces, 'to')),
		});
	}
	if (node.local === 'oneCellAnchor') {
		return {
			kind: 'oneCell',
			from: parseMarker(requiredChild(node, spreadsheetDrawingNamespaces, 'from')),
			extent: parseExtent(requiredChild(node, spreadsheetDrawingNamespaces, 'ext')),
		};
	}
	return {
		kind: 'absolute',
		position: parsePosition(requiredChild(node, spreadsheetDrawingNamespaces, 'pos')),
		extent: parseExtent(requiredChild(node, spreadsheetDrawingNamespaces, 'ext')),
	};
}

function parseMarker(node: XmlElement): ParadisSpreadsheetDrawingMarker {
	const column = integerText(requiredChild(node, spreadsheetDrawingNamespaces, 'col'), 16_383);
	const row = integerText(requiredChild(node, spreadsheetDrawingNamespaces, 'row'), 1_048_575);
	return {
		column,
		columnOffset: integerText(requiredChild(node, spreadsheetDrawingNamespaces, 'colOff'), Number.MAX_SAFE_INTEGER, true),
		row,
		rowOffset: integerText(requiredChild(node, spreadsheetDrawingNamespaces, 'rowOff'), Number.MAX_SAFE_INTEGER, true),
	};
}

function parsePosition(node: XmlElement): ParadisSpreadsheetDrawingPosition {
	return { x: requiredIntegerAttribute(node, 'x', true), y: requiredIntegerAttribute(node, 'y', true) };
}

function parseExtent(node: XmlElement): ParadisSpreadsheetDrawingExtent {
	return { cx: requiredIntegerAttribute(node, 'cx'), cy: requiredIntegerAttribute(node, 'cy') };
}

function parseImage(
	node: XmlElement,
	anchor: ParadisSpreadsheetDrawingAnchor,
	drawingPart: OwnedPart,
	parts: ReadonlyMap<string, OwnedPart>,
	relationships: readonly Relationship[],
	ordinal: number,
): ParadisSpreadsheetImage {
	const metadata = parseNonVisualProperties(node);
	const blip = descendant(node, drawingMainNamespaces, 'blip');
	const embeddedRelationshipId = blip && relationshipAttribute(blip, 'embed');
	const linkedRelationshipId = blip && relationshipAttribute(blip, 'link');
	if (Boolean(embeddedRelationshipId) === Boolean(linkedRelationshipId)) {
		throw new ParadisOfficePackageError('malformed');
	}
	const relationship = findRelationshipById(relationships, embeddedRelationshipId ?? linkedRelationshipId, 'image');
	let content: ParadisSpreadsheetImage['content'];
	if (linkedRelationshipId) {
		if (!relationship.external || !relationship.targetFingerprint) {
			throw new ParadisOfficePackageError('unsafe');
		}
		content = {
			...(relationship.targetScheme ? { targetScheme: relationship.targetScheme } : {}),
			targetFingerprint: relationship.targetFingerprint,
			behavior: 'notFetched',
		};
	} else {
		const mediaPart = !relationship.external && relationship.target ? parts.get(relationship.target) : undefined;
		if (!mediaPart?.contentType || !mediaPart.contentType.toLocaleLowerCase('en-US').startsWith('image/')) {
			throw new ParadisOfficePackageError('unsafe');
		}
		content = { contentType: mediaPart.contentType, fingerprint: mediaPart.source.fingerprint };
	}
	const shapeProperties = child(node, spreadsheetDrawingNamespaces, 'spPr');
	const sourceRect = descendant(node, drawingMainNamespaces, 'srcRect');
	return compact({
		id: stableId('image', drawingPart.source, ordinal),
		kind: 'image' as const,
		...metadata,
		source: drawingPart.source,
		anchor,
		transform: shapeProperties ? parseTransform(shapeProperties) : undefined,
		crop: sourceRect ? parseCrop(sourceRect) : undefined,
		line: shapeProperties ? parseLineStyle(shapeProperties) : undefined,
		content,
	});
}

function parseOpaqueDrawing(anchor: ParadisSpreadsheetDrawingAnchor, drawingPart: OwnedPart, ordinal: number): ParadisSpreadsheetOpaqueDrawing {
	return {
		id: stableId('opaqueDrawing', drawingPart.source, ordinal),
		kind: 'opaqueDrawing',
		source: drawingPart.source,
		anchor,
		fingerprint: drawingPart.source.fingerprint,
		evaluation: 'notEvaluated',
	};
}

function parseShape(node: XmlElement, anchor: ParadisSpreadsheetDrawingAnchor, drawingPart: OwnedPart, ordinal: number): ParadisSpreadsheetDrawing {
	const metadata = parseNonVisualProperties(node);
	const shapeProperties = child(node, spreadsheetDrawingNamespaces, 'spPr');
	const presetGeometry = shapeProperties && descendant(shapeProperties, drawingMainNamespaces, 'prstGeom');
	const preset = presetGeometry && attribute(presetGeometry, 'prst');
	const kind: ParadisSpreadsheetDrawing['kind'] = node.local === 'cxnSp' || preset === 'line' || preset === 'straightConnector1' ? 'line' : 'shape';
	const transform = shapeProperties ? parseTransform(shapeProperties) : undefined;
	return compact({
		id: stableId(kind, drawingPart.source, ordinal),
		kind,
		...metadata,
		source: drawingPart.source,
		anchor,
		presetGeometry: preset,
		transform,
		line: shapeProperties ? parseLineStyle(shapeProperties) : undefined,
		lineGeometry: kind === 'line' ? parseLineGeometry(anchor, transform) : undefined,
	});
}

function parseChartFrame(
	node: XmlElement,
	anchor: ParadisSpreadsheetDrawingAnchor,
	drawingPart: OwnedPart,
	parts: ReadonlyMap<string, OwnedPart>,
	relationships: readonly Relationship[],
	ordinal: number,
	token: CancellationToken | undefined,
): ParadisSpreadsheetChart | undefined {
	const chartReference = descendant(node, chartNamespaces, 'chart');
	if (!chartReference) {
		return undefined;
	}
	const relationship = relationshipById(relationships, relationshipAttribute(chartReference, 'id'), 'chart');
	const chartPart = relationship.target ? parts.get(relationship.target) : undefined;
	if (!chartPart?.contentType || !chartContentTypes.has(chartPart.contentType.toLocaleLowerCase('en-US'))) {
		throw new ParadisOfficePackageError('unsafe');
	}
	return parseChartPart(chartPart, anchor, drawingPart, parseNonVisualProperties(node).name, ordinal, token);
}

function parseChartPart(
	chartPart: OwnedPart,
	anchor: ParadisSpreadsheetDrawingAnchor,
	drawingPart: OwnedPart,
	name: string | undefined,
	ordinal: number,
	token: CancellationToken | undefined,
): ParadisSpreadsheetChart {
	const root = parseXml(chartPart, token).root;
	if (!chartNamespaces.has(root.uri) || root.local !== 'chartSpace') {
		throw new ParadisOfficePackageError('malformed');
	}
	const chartNode = requiredDescendant(root, chartNamespaces, 'chart');
	const plotArea = requiredChild(chartNode, chartNamespaces, 'plotArea');
	const chartNodes = elements(plotArea).filter(value => chartNamespaces.has(value.uri) && /Chart$/.test(value.local));
	const supported = chartNodes.filter(value => ['areaChart', 'barChart', 'lineChart', 'pieChart', 'scatterChart'].includes(value.local));
	const chartType = chartNodes.length === 1 && supported.length === 1 ? supported[0].local.slice(0, -5) as ParadisSpreadsheetChart['chartType'] : 'unsupported';
	const titleNode = child(chartNode, chartNamespaces, 'title');
	const title = titleNode ? textDescendants(titleNode, drawingMainNamespaces, 't').join('') || undefined : undefined;
	const series = chartType === 'unsupported' ? [] : elements(supported[0]).filter(value => chartNamespaces.has(value.uri) && value.local === 'ser').map(parseChartSeries);
	const hasSavedCache = series.some(value => value.name?.cache.length || value.categories?.cache.length || value.values?.cache.length || value.xValues?.cache.length || value.yValues?.cache.length);
	const hasExternalFormula = series.some(value => [value.name, value.categories, value.values, value.xValues, value.yValues].some(data => data?.evaluation === 'notEvaluated'));
	return compact({
		id: stableId('chart', drawingPart.source, ordinal),
		kind: 'chart' as const,
		name,
		source: drawingPart.source,
		chartSource: chartPart.source,
		anchor,
		title,
		chartType,
		series,
		evaluation: chartType !== 'unsupported' && hasSavedCache && !hasExternalFormula ? 'savedCacheOnly' as const : 'notEvaluated' as const,
		opaqueFingerprint: chartType === 'unsupported' ? chartPart.source.fingerprint : undefined,
	});
}

function parseChartSeries(node: XmlElement): ParadisSpreadsheetChartSeries {
	return compact({
		index: requiredValueInteger(requiredChild(node, chartNamespaces, 'idx')),
		order: requiredValueInteger(requiredChild(node, chartNamespaces, 'order')),
		name: child(node, chartNamespaces, 'tx') ? parseChartStringData(requiredChild(node, chartNamespaces, 'tx')) : undefined,
		categories: child(node, chartNamespaces, 'cat') ? parseChartStringData(requiredChild(node, chartNamespaces, 'cat')) : undefined,
		values: child(node, chartNamespaces, 'val') ? parseChartNumberData(requiredChild(node, chartNamespaces, 'val')) : undefined,
		xValues: child(node, chartNamespaces, 'xVal') ? parseChartNumberData(requiredChild(node, chartNamespaces, 'xVal')) : undefined,
		yValues: child(node, chartNamespaces, 'yVal') ? parseChartNumberData(requiredChild(node, chartNamespaces, 'yVal')) : undefined,
	});
}

function parseChartStringData(node: XmlElement): ParadisSpreadsheetChartStringData {
	const reference = descendant(node, chartNamespaces, 'strRef') ?? descendant(node, chartNamespaces, 'numRef');
	const literal = descendant(node, chartNamespaces, 'strLit') ?? descendant(node, chartNamespaces, 'numLit');
	const container = reference ?? literal;
	if (!container) {
		const value = descendant(node, chartNamespaces, 'v');
		return { cache: value ? [{ index: 0, value: text(value) }] : [] };
	}
	const formula = reference && child(reference, chartNamespaces, 'f');
	const cache = descendant(container, chartNamespaces, 'strCache') ?? descendant(container, chartNamespaces, 'numCache') ?? container;
	const formulaText = formula ? text(formula) : undefined;
	return compact({
		...(formulaText && isExternalChartFormula(formulaText)
			? { formulaFingerprint: sha256Bytes(new TextEncoder().encode(formulaText)), evaluation: 'notEvaluated' as const }
			: { formula: formulaText }),
		cache: parseChartCache(cache),
	});
}

function parseChartNumberData(node: XmlElement): ParadisSpreadsheetChartNumberData {
	const data = parseChartStringData(node);
	const format = descendant(node, chartNamespaces, 'formatCode');
	return compact({ ...data, formatCode: format ? text(format) : undefined });
}

function parseChartCache(node: XmlElement): readonly ParadisSpreadsheetChartCachePoint[] {
	const points = descendants(node, chartNamespaces, 'pt').map(point => ({
		index: requiredIntegerAttribute(point, 'idx'),
		value: text(requiredChild(point, chartNamespaces, 'v')),
	}));
	const seen = new Set<number>();
	for (const point of points) {
		if (seen.has(point.index)) {
			throw new ParadisOfficePackageError('malformed');
		}
		seen.add(point.index);
	}
	return points;
}

function parsePivots(
	parts: ReadonlyMap<string, OwnedPart>,
	relationshipsByOwner: ReadonlyMap<string, readonly Relationship[]>,
	workbookPart: OwnedPart,
	workbookDocument: ParadisOfficeXmlDocument,
	token: CancellationToken | undefined,
): readonly ParadisSpreadsheetPivot[] {
	const cacheById = workbookPivotCaches(workbookDocument, relationshipsByOwner.get(workbookPart.source.partId) ?? []);
	const pivots: ParadisSpreadsheetPivot[] = [];
	let ordinal = 0;
	for (const part of parts.values()) {
		if (!part.contentType || !pivotTableContentTypes.has(part.contentType.toLocaleLowerCase('en-US'))) {
			continue;
		}
		throwIfParadisOfficeCancelled(token);
		const root = spreadsheetRoot(parseXml(part, token), 'pivotTableDefinition');
		const cacheId = requiredIntegerAttribute(root, 'cacheId');
		let cachePartId = cacheById.get(cacheId);
		const directCache = (relationshipsByOwner.get(part.source.partId) ?? []).filter(value => relationshipMatches(value, 'pivotCacheDefinition'));
		if (directCache.length > 1 || directCache.some(value => value.external || !value.target)) {
			throw new ParadisOfficePackageError('unsafe');
		}
		if (directCache[0]?.target) {
			if (cachePartId && cachePartId !== directCache[0].target) {
				throw new ParadisOfficePackageError('unsafe');
			}
			cachePartId = directCache[0].target;
		}
		const cachePart = cachePartId ? parts.get(cachePartId) : undefined;
		if (!cachePart?.contentType || !pivotCacheDefinitionContentTypes.has(cachePart.contentType.toLocaleLowerCase('en-US'))) {
			throw new ParadisOfficePackageError('unsafe');
		}
		const cache = parsePivotCache(cachePart, parts, relationshipsByOwner, token);
		const location = child(root, spreadsheetNamespaces, 'location');
		pivots.push({
			id: stableId('pivot', part.source, ordinal++),
			kind: 'pivot',
			name: requiredAttribute(root, 'name'),
			source: part.source,
			cacheId,
			...(location && attribute(location, 'ref') ? { location: attribute(location, 'ref') } : {}),
			placements: parsePivotPlacements(root),
			cache,
			refresh: 'notPerformed',
		});
	}
	return pivots;
}

function workbookPivotCaches(document: ParadisOfficeXmlDocument, relationships: readonly Relationship[]): ReadonlyMap<number, string> {
	const root = spreadsheetRoot(document, 'workbook');
	const pivotCaches = child(root, spreadsheetNamespaces, 'pivotCaches');
	const result = new Map<number, string>();
	if (!pivotCaches) {
		return result;
	}
	for (const cache of children(pivotCaches, spreadsheetNamespaces, 'pivotCache')) {
		const cacheId = requiredIntegerAttribute(cache, 'cacheId');
		const relationship = relationshipById(relationships, relationshipAttribute(cache, 'id'), 'pivotCacheDefinition');
		if (!relationship.target || result.has(cacheId)) {
			throw new ParadisOfficePackageError('malformed');
		}
		result.set(cacheId, relationship.target);
	}
	return result;
}

function parsePivotPlacements(root: XmlElement): ParadisSpreadsheetPivot['placements'] {
	const fieldIndexes = (local: string) => {
		const container = child(root, spreadsheetNamespaces, local);
		return container ? children(container, spreadsheetNamespaces, 'field').map(value => requiredIntegerAttribute(value, 'x', true)) : [];
	};
	const pageContainer = child(root, spreadsheetNamespaces, 'pageFields');
	const dataContainer = child(root, spreadsheetNamespaces, 'dataFields');
	return {
		rows: fieldIndexes('rowFields'),
		columns: fieldIndexes('colFields'),
		pages: pageContainer ? children(pageContainer, spreadsheetNamespaces, 'pageField').map(value => compact({
			field: requiredIntegerAttribute(value, 'fld'), item: optionalInteger(value, 'item'), name: attribute(value, 'name'),
		})) : [],
		data: dataContainer ? children(dataContainer, spreadsheetNamespaces, 'dataField').map(value => compact({
			field: requiredIntegerAttribute(value, 'fld'), name: attribute(value, 'name'), subtotal: attribute(value, 'subtotal'),
		})) : [],
	};
}

function parsePivotCache(
	part: OwnedPart,
	parts: ReadonlyMap<string, OwnedPart>,
	relationshipsByOwner: ReadonlyMap<string, readonly Relationship[]>,
	token: CancellationToken | undefined,
): ParadisSpreadsheetPivotCache {
	const root = spreadsheetRoot(parseXml(part, token), 'pivotCacheDefinition');
	const cacheSource = requiredChild(root, spreadsheetNamespaces, 'cacheSource');
	const source = parsePivotSource(cacheSource, relationshipsByOwner.get(part.source.partId) ?? []);
	const fieldsNode = child(root, spreadsheetNamespaces, 'cacheFields');
	const fields = fieldsNode ? children(fieldsNode, spreadsheetNamespaces, 'cacheField').map(field => {
		const sharedItems = child(field, spreadsheetNamespaces, 'sharedItems');
		return compact({
			name: requiredAttribute(field, 'name'),
			databaseField: optionalBoolean(field, 'databaseField'),
			sharedItems: sharedItems ? elements(sharedItems).map(parsePivotValue) : [],
		});
	}) : [];
	const recordsRelationshipId = relationshipAttribute(root, 'id');
	let recordsSource: ParadisSpreadsheetPartSource | undefined;
	let records: readonly (readonly ParadisSpreadsheetPivotValue[])[] = [];
	if (recordsRelationshipId) {
		const relationship = relationshipById(relationshipsByOwner.get(part.source.partId) ?? [], recordsRelationshipId, 'pivotCacheRecords');
		const recordsPart = relationship.target ? parts.get(relationship.target) : undefined;
		if (!recordsPart?.contentType || !pivotCacheRecordsContentTypes.has(recordsPart.contentType.toLocaleLowerCase('en-US'))) {
			throw new ParadisOfficePackageError('unsafe');
		}
		recordsSource = recordsPart.source;
		const recordsRoot = spreadsheetRoot(parseXml(recordsPart, token), 'pivotCacheRecords');
		records = children(recordsRoot, spreadsheetNamespaces, 'r').map(record => elements(record).map(parsePivotValue));
		const declared = optionalInteger(recordsRoot, 'count');
		if (declared !== undefined && declared !== records.length) {
			throw new ParadisOfficePackageError('malformed');
		}
	}
	return compact({ sourcePart: part.source, recordsSource, source, fields, records, recordCount: optionalInteger(root, 'recordCount') });
}

function parsePivotSource(node: XmlElement, relationships: readonly Relationship[]): ParadisSpreadsheetPivotSource {
	const kind = requiredAttribute(node, 'type');
	if (kind === 'worksheet') {
		const source = requiredChild(node, spreadsheetNamespaces, 'worksheetSource');
		const relationshipId = relationshipAttribute(source, 'id');
		if (relationshipId) {
			const relationship = relationshipById(relationships, relationshipId);
			const relationshipFingerprint = relationship.targetFingerprint ?? (relationship.target ? sha256Bytes(new TextEncoder().encode(relationship.target)) : undefined);
			return compact({ kind: 'external' as const, relationshipFingerprint, evaluation: 'notEvaluated' as const });
		}
		return compact({ kind: 'worksheet' as const, sheet: attribute(source, 'sheet'), ref: attribute(source, 'ref'), name: attribute(source, 'name') });
	}
	if (kind === 'external') {
		return { kind: 'external', evaluation: 'notEvaluated' };
	}
	if (kind === 'consolidation' || kind === 'scenario') {
		return { kind, evaluation: 'notEvaluated' };
	}
	return { kind: 'unknown', evaluation: 'notEvaluated' };
}

function parsePivotValue(node: XmlElement): ParadisSpreadsheetPivotValue {
	if (!spreadsheetNamespaces.has(node.uri)) {
		throw new ParadisOfficePackageError('malformed');
	}
	const value = attribute(node, 'v');
	switch (node.local) {
		case 's': return { kind: 'string', value: value ?? '' };
		case 'n': return { kind: 'number', value: requiredValue(value) };
		case 'b': return { kind: 'boolean', value: parseBoolean(requiredValue(value)) };
		case 'd': return { kind: 'date', value: requiredValue(value) };
		case 'e': return { kind: 'error', value: requiredValue(value) };
		case 'x': return { kind: 'sharedItemIndex', index: parseInteger(requiredValue(value)) };
		case 'm': return { kind: 'missing' };
		default: throw new ParadisOfficePackageError('malformed');
	}
}

function parseUnsafeParts(parts: ReadonlyMap<string, OwnedPart>): readonly ParadisSpreadsheetUnsafePart[] {
	const result: ParadisSpreadsheetUnsafePart[] = [];
	for (const part of parts.values()) {
		if (!part.contentType) {
			continue;
		}
		const lower = part.contentType.toLocaleLowerCase('en-US');
		let kind: ParadisSpreadsheetUnsafePart['kind'] | undefined;
		let behavior: ParadisSpreadsheetUnsafePart['behavior'] = 'notExecuted';
		if (lower.includes('vbaproject')) { kind = 'vba'; }
		else if (lower.includes('oleobject')) { kind = 'ole'; }
		else if (lower.includes('activex')) { kind = 'activeX'; }
		else if (lower.includes('connections')) { kind = 'connection'; behavior = 'notEvaluated'; }
		else if (lower.includes('signature')) { kind = 'signature'; }
		else if (lower.includes('embeddedpackage')) { kind = 'embeddedPackage'; }
		if (kind) {
			result.push({ kind, contentType: part.contentType, fingerprint: part.source.fingerprint, behavior });
		}
	}
	return result;
}

function parseOpaqueParts(parts: ReadonlyMap<string, OwnedPart>): ParadisSpreadsheetObjects['opaqueParts'] {
	return [...parts.values()].filter(part => {
		if (!part.contentType) { return false; }
		const lower = part.contentType.toLocaleLowerCase('en-US');
		return part.contentType !== relationshipsContentType
			&& !workbookContentTypes.has(lower) && !worksheetContentTypes.has(lower) && !drawingContentTypes.has(lower)
			&& !chartContentTypes.has(lower) && !pivotTableContentTypes.has(lower) && !pivotCacheDefinitionContentTypes.has(lower)
			&& !pivotCacheRecordsContentTypes.has(lower) && !lower.startsWith('image/') && !isUnsafeContentType(lower);
	}).map(part => ({ contentType: part.contentType!, fingerprint: part.source.fingerprint, evaluation: 'notEvaluated' as const }));
}

function isUnsafeContentType(lower: string): boolean {
	return lower.includes('vbaproject') || lower.includes('oleobject') || lower.includes('activex') || lower.includes('connections') || lower.includes('signature') || lower.includes('embeddedpackage');
}

function parseNonVisualProperties(node: XmlElement): { readonly name?: string; readonly description?: string; readonly title?: string } {
	const properties = descendant(node, spreadsheetDrawingNamespaces, 'cNvPr');
	return properties ? compact({ name: attribute(properties, 'name'), description: attribute(properties, 'descr'), title: attribute(properties, 'title') }) : {};
}

function parseTransform(node: XmlElement): ParadisSpreadsheetDrawingTransform | undefined {
	const transform = descendant(node, drawingMainNamespaces, 'xfrm');
	if (!transform) { return undefined; }
	const offset = child(transform, drawingMainNamespaces, 'off');
	const extent = child(transform, drawingMainNamespaces, 'ext');
	return compact({
		offset: offset ? parsePosition(offset) : undefined,
		extent: extent ? parseExtent(extent) : undefined,
		rotation: optionalInteger(transform, 'rot', true),
		flipHorizontal: optionalBoolean(transform, 'flipH'),
		flipVertical: optionalBoolean(transform, 'flipV'),
	});
}

function parseCrop(node: XmlElement): ParadisSpreadsheetImageCrop | undefined {
	const result = compact({
		left: optionalInteger(node, 'l'), top: optionalInteger(node, 't'), right: optionalInteger(node, 'r'), bottom: optionalInteger(node, 'b'),
	});
	return Object.keys(result).length > 0 ? result : undefined;
}

function parseLineStyle(node: XmlElement): ParadisSpreadsheetDrawingLineStyle | undefined {
	const line = descendant(node, drawingMainNamespaces, 'ln');
	if (!line) { return undefined; }
	const colorNode = descendants(line, drawingMainNamespaces, 'srgbClr')[0];
	const result = compact({ width: optionalInteger(line, 'w'), color: colorNode && attribute(colorNode, 'val') });
	return Object.keys(result).length > 0 ? result : undefined;
}

function parseLineGeometry(anchor: ParadisSpreadsheetDrawingAnchor, transform: ParadisSpreadsheetDrawingTransform | undefined): ParadisSpreadsheetDrawing['lineGeometry'] {
	if (anchor.kind === 'twoCell') {
		return { kind: 'cellAnchored', start: anchor.from, end: anchor.to, diagonal: markerDiagonal(anchor.from, anchor.to) };
	}
	if (anchor.kind === 'absolute') {
		return { kind: 'absolute', start: anchor.position, extent: anchor.extent, diagonal: extentDiagonal(anchor.extent, transform) };
	}
	return { kind: 'cellAnchoredExtent', start: anchor.from, extent: anchor.extent, diagonal: extentDiagonal(anchor.extent, transform) };
}

function markerDiagonal(start: ParadisSpreadsheetDrawingMarker, end: ParadisSpreadsheetDrawingMarker): 'up' | 'down' | 'horizontal' | 'vertical' {
	const horizontal = comparePair(start.column, start.columnOffset, end.column, end.columnOffset);
	const vertical = comparePair(start.row, start.rowOffset, end.row, end.rowOffset);
	if (vertical === 0) { return 'horizontal'; }
	if (horizontal === 0) { return 'vertical'; }
	return horizontal === vertical ? 'down' : 'up';
}

function extentDiagonal(extent: ParadisSpreadsheetDrawingExtent, transform: ParadisSpreadsheetDrawingTransform | undefined): 'up' | 'down' | 'horizontal' | 'vertical' {
	if (extent.cy === 0) { return 'horizontal'; }
	if (extent.cx === 0) { return 'vertical'; }
	return Boolean(transform?.flipHorizontal) !== Boolean(transform?.flipVertical) ? 'up' : 'down';
}

function comparePair(leftMajor: number, leftMinor: number, rightMajor: number, rightMinor: number): -1 | 0 | 1 {
	return leftMajor < rightMajor || leftMajor === rightMajor && leftMinor < rightMinor ? -1 : leftMajor === rightMajor && leftMinor === rightMinor ? 0 : 1;
}

function relationshipById(relationships: readonly Relationship[], id: string | undefined, suffix?: string): Relationship {
	const relationship = findRelationshipById(relationships, id, suffix);
	if (relationship.external) { throw new ParadisOfficePackageError('unsafe'); }
	return relationship;
}

function findRelationshipById(relationships: readonly Relationship[], id: string | undefined, suffix?: string): Relationship {
	if (!id) { throw new ParadisOfficePackageError('malformed'); }
	const found = relationships.filter(value => value.id === id && (suffix === undefined || relationshipMatches(value, suffix)));
	if (found.length !== 1) { throw new ParadisOfficePackageError('unsafe'); }
	return found[0];
}

function relationshipMatches(relationship: Relationship, suffix: string): boolean {
	return officeRelationshipNamespaces.has(relationship.type.slice(0, relationship.type.lastIndexOf('/'))) && relationship.suffix === suffix;
}

function relationshipAttribute(node: XmlElement, local: string): string | undefined {
	return node.attributes.find(value => officeRelationshipNamespaces.has(value.uri) && value.local === local)?.value;
}

function relationshipOwner(partId: string): string {
	if (partId === '/_rels/.rels') { return '/'; }
	const match = /^(.*)\/_rels\/([^/]+)\.rels$/.exec(partId);
	if (!match) { throw new ParadisOfficePackageError('malformed'); }
	return `${match[1]}/${match[2]}`;
}

function resolveTarget(owner: string, rawTarget: string): string {
	if (!rawTarget || rawTarget.includes('\\') || rawTarget.includes('\0') || rawTarget.includes('?') || rawTarget.includes('#') || /^[A-Za-z][A-Za-z0-9+.-]*:/.test(rawTarget)) {
		throw new ParadisOfficePackageError('unsafe');
	}
	let target: string;
	try {
		target = decodeURIComponent(rawTarget);
	} catch {
		throw new ParadisOfficePackageError('unsafe');
	}
	if (target.includes('\\') || target.includes('\0')) { throw new ParadisOfficePackageError('unsafe'); }
	const base = owner === '/' ? '/' : owner.slice(0, owner.lastIndexOf('/') + 1);
	return normalizePartId(target.startsWith('/') ? target : `${base}${target}`);
}

function canonicalPartId(value: string): string {
	if (typeof value !== 'string' || !value.startsWith('/') || value.length > 2048 || value.includes('\\') || value.includes('\0') || value.includes('?') || value.includes('#')) {
		throw new ParadisOfficePackageError('unsafe');
	}
	const normalized = normalizePartId(value);
	if (normalized !== value) { throw new ParadisOfficePackageError('unsafe'); }
	return normalized;
}

function normalizePartId(value: string): string {
	const segments: string[] = [];
	for (const segment of value.split('/')) {
		if (!segment || segment === '.') { continue; }
		if (segment === '..') {
			if (segments.length === 0) { throw new ParadisOfficePackageError('unsafe'); }
			segments.pop();
		} else {
			segments.push(segment);
		}
	}
	return `/${segments.join('/')}`;
}

function spreadsheetRoot(document: ParadisOfficeXmlDocument, local: string): XmlElement {
	if (!spreadsheetNamespaces.has(document.root.uri) || document.root.local !== local) {
		throw new ParadisOfficePackageError('malformed');
	}
	return document.root;
}

function elements(node: XmlElement): readonly XmlElement[] {
	return node.children.filter((value): value is XmlElement => value.kind === 'element');
}

function child(node: XmlElement, namespaces: ReadonlySet<string>, local: string): XmlElement | undefined {
	return elements(node).find(value => namespaces.has(value.uri) && value.local === local);
}

function children(node: XmlElement, namespaces: ReadonlySet<string>, local: string): readonly XmlElement[] {
	return elements(node).filter(value => namespaces.has(value.uri) && value.local === local);
}

function requiredChild(node: XmlElement, namespaces: ReadonlySet<string>, local: string): XmlElement {
	const values = children(node, namespaces, local);
	if (values.length !== 1) { throw new ParadisOfficePackageError('malformed'); }
	return values[0];
}

function descendant(node: XmlElement, namespaces: ReadonlySet<string>, local: string): XmlElement | undefined {
	return descendants(node, namespaces, local)[0];
}

function requiredDescendant(node: XmlElement, namespaces: ReadonlySet<string>, local: string): XmlElement {
	const value = descendant(node, namespaces, local);
	if (!value) { throw new ParadisOfficePackageError('malformed'); }
	return value;
}

function descendants(node: XmlElement, namespaces: ReadonlySet<string>, local: string): XmlElement[] {
	const result: XmlElement[] = [];
	const stack = [...elements(node)].reverse();
	while (stack.length > 0) {
		const current = stack.pop()!;
		if (namespaces.has(current.uri) && current.local === local) { result.push(current); }
		stack.push(...[...elements(current)].reverse());
	}
	return result;
}

function textDescendants(node: XmlElement, namespaces: ReadonlySet<string>, local: string): string[] {
	return descendants(node, namespaces, local).map(text);
}

function text(node: XmlElement): string {
	let result = '';
	for (const item of node.children) {
		if (item.kind === 'text') { result += item.value; }
		else { throw new ParadisOfficePackageError('malformed'); }
	}
	return result;
}

function attribute(node: XmlElement, local: string): string | undefined {
	return node.attributes.find(value => value.uri === '' && value.local === local)?.value;
}

function requiredAttribute(node: XmlElement, local: string): string {
	return requiredValue(attribute(node, local));
}

function requiredValue(value: string | undefined): string {
	if (value === undefined || value === '') { throw new ParadisOfficePackageError('malformed'); }
	return value;
}

function isExternalChartFormula(value: string): boolean {
	return /\\/.test(value)
		|| /^[A-Za-z][A-Za-z0-9+.-]*:/.test(value.trim().replace(/^'/, ''))
		|| /\[[^\]]+\][^!]*!/.test(value)
		|| /(?:^|')\/(?:[^/]+\/)+/.test(value);
}

function optionalBoolean(node: XmlElement, local: string): boolean | undefined {
	const value = attribute(node, local);
	return value === undefined ? undefined : parseBoolean(value);
}

function parseBoolean(value: string): boolean {
	if (value === '1' || value === 'true') { return true; }
	if (value === '0' || value === 'false') { return false; }
	throw new ParadisOfficePackageError('malformed');
}

function optionalInteger(node: XmlElement, local: string, signed = false): number | undefined {
	const value = attribute(node, local);
	return value === undefined ? undefined : parseInteger(value, Number.MAX_SAFE_INTEGER, signed);
}

function requiredIntegerAttribute(node: XmlElement, local: string, signed = false): number {
	return parseInteger(requiredAttribute(node, local), Number.MAX_SAFE_INTEGER, signed);
}

function requiredValueInteger(node: XmlElement): number {
	return parseInteger(requiredAttribute(node, 'val'));
}

function integerText(node: XmlElement, maximum = Number.MAX_SAFE_INTEGER, signed = false): number {
	return parseInteger(text(node), maximum, signed);
}

function parseInteger(value: string, maximum = Number.MAX_SAFE_INTEGER, signed = false): number {
	if (!(signed ? /^-?\d+$/.test(value) : /^\d+$/.test(value))) { throw new ParadisOfficePackageError('malformed'); }
	const parsed = Number(value);
	if (!Number.isSafeInteger(parsed) || parsed > maximum || !signed && parsed < 0) { throw new ParadisOfficePackageError('malformed'); }
	return parsed;
}

function stableId(kind: string, source: ParadisSpreadsheetPartSource, ordinal: number): string {
	return `${kind}:${source.partId}:${ordinal}`;
}

function validContentType(value: string): boolean {
	return /^[a-z0-9!#$&^_.+\-]+\/[a-z0-9!#$&^_.+\-]+(?:;[^\r\n]*)?$/i.test(value);
}

function validRelationshipType(value: string): boolean {
	return /^[A-Za-z][A-Za-z0-9+.-]*:\/\/[^\s]+$/.test(value);
}

function compact<T extends Record<string, unknown>>(value: T): T {
	const result: Record<string, unknown> = {};
	for (const [key, item] of Object.entries(value)) { if (item !== undefined) { result[key] = item; } }
	return result as T;
}

function deepFreeze<T>(value: T): T {
	const seen = new WeakSet<object>();
	const stack: object[] = [];
	if (value && typeof value === 'object') { stack.push(value); }
	while (stack.length > 0) {
		const current = stack.pop()!;
		if (seen.has(current)) { continue; }
		seen.add(current);
		for (const key of Reflect.ownKeys(current)) {
			const child = Object.getOwnPropertyDescriptor(current, key)?.value;
			if (child && typeof child === 'object') { stack.push(child); }
		}
		Object.freeze(current);
	}
	return value;
}

function sha256Bytes(bytes: Uint8Array): ParadisOfficeFingerprint {
	return { algorithm: 'sha256', value: sha256ParadisOfficeBytes(bytes), byteLength: bytes.length };
}

function sanitizeError(error: unknown): ParadisOfficePackageError {
	if (error instanceof ParadisOfficePackageError) { return new ParadisOfficePackageError(error.code); }
	return new ParadisOfficePackageError('unsafe');
}
