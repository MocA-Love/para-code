/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import type { CancellationToken } from '../../../../../base/common/cancellation.js';
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
import { diagnoseSpreadsheetProjection, type IParadisWorkbookData } from '../paradisSpreadsheet.js';
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
}

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

/**
 * Consumes and disposes an archive after parsing namespace-validated, all-byte-verified OOXML Parts.
 * The parser owns the archive for success, cancellation, rejection, and malformed-input paths.
 */
export async function parseSpreadsheetSemantic(
	archive: IParadisOfficeArchive,
	inventory: ParadisOfficeInventory,
	token?: CancellationToken,
	options: ParadisSpreadsheetSemanticParseOptions = {},
): Promise<ParadisSpreadsheetSnapshot> {
	let archiveDisposeAttempted = false;
	try {
		const ownedInventory = snapshotInventory(inventory);
		const profile = budgetProfile(ownedInventory.budgetProfile);
		const limits = semanticLimits(options.limits);
		const now = options.now ?? Date.now;
		const deadlineMilliseconds = options.deadlineMilliseconds ?? profile.semanticParseMilliseconds;
		if (!Number.isFinite(deadlineMilliseconds) || deadlineMilliseconds < 0) {
			throw new ParadisOfficePackageError('limitExceeded');
		}
		const started = now();
		let checkpointCount = 0;
		const checkpoint = (force = false): void => {
			checkpointCount++;
			if (!force && checkpointCount % 128 !== 0) {
				return;
			}
			throwIfParadisOfficeCancelled(token);
			if (now() - started > deadlineMilliseconds) {
				throw new ParadisOfficePackageError('limitExceeded');
			}
		};
		checkpoint(true);
		validateInventory(ownedInventory, archive, profile);
		const workbookRelationship = uniqueRelationship(ownedInventory, undefined, officeDocumentRelationships);
		const workbookPartId = safeInternalTarget(workbookRelationship);
		const workbookRelationships = ownedInventory.relationships.filter(relationship => relationship.sourcePartId === workbookPartId);
		const requestedPartIds = new Set<string>([
			contentTypesPartId,
			workbookPartId,
			relationshipPartId(undefined),
			relationshipPartId(workbookPartId),
		]);
		for (const relationship of workbookRelationships) {
			const acceptedContentTypes = worksheetRelationships.has(relationship.type)
				? worksheetContentTypes
				: stylesRelationships.has(relationship.type)
					? stylesContentTypes
					: sharedStringsRelationships.has(relationship.type)
						? sharedStringsContentTypes
						: undefined;
			if (acceptedContentTypes) {
				const target = safeInternalTarget(relationship);
				validatePartContentType(ownedInventory, target, acceptedContentTypes);
				requestedPartIds.add(target);
			}
		}
		if (requestedPartIds.size > profile.entryCount) {
			throw new ParadisOfficePackageError('limitExceeded');
		}
		const parsedParts = await readAndParseParts(archive, ownedInventory, requestedPartIds, profile, token, checkpoint);
		const workbookPart = requiredParsedPart(parsedParts, workbookPartId);
		validateContentTypesPart(requiredParsedPart(parsedParts, contentTypesPartId).document, ownedInventory, requestedPartIds, checkpoint);
		validatePartContentType(ownedInventory, workbookPartId, workbookContentTypesForFormat(ownedInventory.format));
		validateRelationshipPart(requiredParsedPart(parsedParts, relationshipPartId(undefined)).document, undefined, ownedInventory, checkpoint);
		validateRelationshipPart(requiredParsedPart(parsedParts, relationshipPartId(workbookPartId)).document, workbookPartId, ownedInventory, checkpoint);
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
		if (workbook.sheets.length > limits.sheets) {
			throw new ParadisOfficePackageError('limitExceeded');
		}
		const stylesRelationship = optionalUniqueRelationship(ownedInventory, workbookPartId, stylesRelationships);
		const sharedStringsRelationship = optionalUniqueRelationship(ownedInventory, workbookPartId, sharedStringsRelationships);
		const stylesPart = stylesRelationship ? requiredParsedPart(parsedParts, safeInternalTarget(stylesRelationship)) : undefined;
		const sharedStringsPart = sharedStringsRelationship ? requiredParsedPart(parsedParts, safeInternalTarget(sharedStringsRelationship)) : undefined;
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
			const relationship = ownedInventory.relationships.find(candidate => candidate.sourcePartId === workbookPartId && candidate.id === sheetRecord.relationshipId);
			if (!relationship || !worksheetRelationships.has(relationship.type)) {
				throw new ParadisOfficePackageError('unsafe');
			}
			const partId = safeInternalTarget(relationship);
			if (seenSheetPartIds.has(partId)) {
				throw new ParadisOfficePackageError('unsafe');
			}
			seenSheetPartIds.add(partId);
			const part = requiredParsedPart(parsedParts, partId);
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
				visitedParts: parsedParts.size,
				parsedParts: parsedParts.size,
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
		const result = options.projection
			? {
				...baseSnapshot,
				projectionDiagnostics: diagnoseSpreadsheetProjection(baseSnapshot, options.projection, {
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
		try {
			archiveDisposeAttempted = true;
			archive.dispose();
		} catch {
			throw new ParadisOfficePackageError('invalid');
		}
		return result;
	} catch (error) {
		if (error instanceof ParadisOfficePackageError) {
			throw error;
		}
		throw new ParadisOfficePackageError('malformed');
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

function budgetProfile(kind: ParadisOfficeInventory['budgetProfile']): ParadisOfficeBudgetProfile {
	return PARADIS_OFFICE_BUDGET_PROFILES[kind];
}

function semanticLimits(overrides: Partial<ParadisSpreadsheetSemanticLimits> | undefined): ParadisSpreadsheetSemanticLimits {
	const limits = { ...defaultSemanticLimits, ...overrides };
	for (const value of Object.values(limits)) {
		if (!Number.isSafeInteger(value) || value < 0) {
			throw new ParadisOfficePackageError('limitExceeded');
		}
	}
	return limits;
}

function snapshotInventory(inventory: ParadisOfficeInventory): ParadisOfficeInventory {
	return {
		...inventory,
		parts: inventory.parts.map(copyInventoryPart),
		relationships: inventory.relationships.map(relationship => ({ ...relationship })),
		features: inventory.features.map(feature => ({ ...feature, partIds: [...feature.partIds] })),
		security: { ...inventory.security },
		budgetUsage: { ...inventory.budgetUsage },
	};
}

function copyInventoryPart(part: ParadisOfficeInventoryPart): ParadisOfficeInventoryPart {
	const canonicalHash = part.canonicalHash ? { ...part.canonicalHash } : undefined;
	if (part.coverage === 'completeOpaque') {
		return { ...part, fingerprint: { ...part.fingerprint }, ...(canonicalHash ? { canonicalHash } : {}) };
	}
	if (part.coverage === 'parsed') {
		return { ...part, rawHash: { ...part.rawHash }, ...(canonicalHash ? { canonicalHash } : {}) };
	}
	return {
		...part,
		...(part.rawHash ? { rawHash: { ...part.rawHash } } : {}),
		...(canonicalHash ? { canonicalHash } : {}),
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

function validatePartContentType(inventory: ParadisOfficeInventory, partId: string, accepted: ReadonlySet<string>): void {
	const part = inventory.parts.find(candidate => candidate.canonicalUri === partId);
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
	inventory: ParadisOfficeInventory,
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
		const part = inventory.parts.find(candidate => candidate.canonicalUri === partId);
		const dot = partId.lastIndexOf('.');
		const slash = partId.lastIndexOf('/');
		const extension = dot > slash ? partId.slice(dot + 1).toLowerCase() : '';
		const authority = overrides.get(partId) ?? defaults.get(extension);
		if (!part || !authority || authority !== part.contentType) {
			throw new ParadisOfficePackageError('unsafe');
		}
	}
}

function uniqueRelationship(inventory: ParadisOfficeInventory, sourcePartId: string | undefined, types: ReadonlySet<string>) {
	const relationships = inventory.relationships.filter(relationship => relationship.sourcePartId === sourcePartId && types.has(relationship.type));
	if (relationships.length !== 1) {
		throw new ParadisOfficePackageError('unsafe');
	}
	return relationships[0];
}

function optionalUniqueRelationship(inventory: ParadisOfficeInventory, sourcePartId: string, types: ReadonlySet<string>) {
	const relationships = inventory.relationships.filter(relationship => relationship.sourcePartId === sourcePartId && types.has(relationship.type));
	if (relationships.length > 1) {
		throw new ParadisOfficePackageError('unsafe');
	}
	return relationships[0];
}

function safeInternalTarget(relationship: ParadisOfficeInventory['relationships'][number]): string {
	if (relationship.targetMode !== 'internal' || relationship.missing || relationship.cyclic || !relationship.target.startsWith('/')) {
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

function validateRelationshipPart(
	document: ParadisOfficeXmlDocument,
	sourcePartId: string | undefined,
	inventory: ParadisOfficeInventory,
	checkpoint: (force?: boolean) => void,
): void {
	const root = document.root;
	if (root.local !== 'Relationships' || !packageRelationshipNamespaces.has(root.uri)) {
		throw new ParadisOfficePackageError('malformed');
	}
	const actual = new Map<string, { readonly type: string; readonly target: string; readonly targetMode: 'internal' | 'external' }>();
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
		if (actual.has(id)) {
			throw new ParadisOfficePackageError('unsafe');
		}
		actual.set(id, { type, target, targetMode });
	}
	const expected = inventory.relationships.filter(relationship => relationship.sourcePartId === sourcePartId);
	if (actual.size !== expected.length) {
		throw new ParadisOfficePackageError('unsafe');
	}
	const expectedIds = new Set<string>();
	for (const relationship of expected) {
		checkpoint();
		if (expectedIds.has(relationship.id)) {
			throw new ParadisOfficePackageError('unsafe');
		}
		expectedIds.add(relationship.id);
		const authority = actual.get(relationship.id);
		if (!authority
			|| authority.type !== relationship.type
			|| authority.target !== relationship.target
			|| authority.targetMode !== relationship.targetMode) {
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

async function readAndParseParts(
	archive: IParadisOfficeArchive,
	inventory: ParadisOfficeInventory,
	requestedPartIds: ReadonlySet<string>,
	profile: ParadisOfficeBudgetProfile,
	token: CancellationToken | undefined,
	checkpoint: (force?: boolean) => void,
): Promise<ReadonlyMap<string, ParsedPart>> {
	const inventoryParts = new Map(inventory.parts.map(part => [part.canonicalUri, part]));
	const parsed = new Map<string, ParsedPart>();
	const seen = new Set<string>();
	const seenInventoryParts = new Set<string>();
	let entries = 0;
	for await (const entry of archive.entries(token)) {
		checkpoint();
		if (++entries > profile.entryCount) {
			throw new ParadisOfficePackageError('limitExceeded');
		}
		validateEntryMetadata(entry);
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
		if (!requestedPartIds.has(canonicalName)) {
			continue;
		}
		const expectedFingerprint = allByteFingerprint(inventoryPart);
		const bytes = await readPartBytes(archive, entry, profile.xmlPartBytes, token, checkpoint);
		const fingerprint = await archive.hash(bytes.slice());
		if (!sameFingerprint(fingerprint, expectedFingerprint) || fingerprint.byteLength !== bytes.byteLength) {
			throw new ParadisOfficePackageError('unsafe');
		}
		const xml = decodeXml(bytes);
		const document = await archive.parseXml(xml, {
			depth: profile.xmlDepth,
			nodes: profile.xmlNodesPerPart,
			attributeLength: profile.attributeLength,
			characters: profile.xmlPartBytes,
		}, token, () => checkpoint());
		parsed.set(canonicalName, { document, source: { partId: canonicalName, fingerprint } });
		checkpoint(true);
	}
	if (seenInventoryParts.size !== inventoryParts.size) {
		throw new ParadisOfficePackageError('unsafe');
	}
	for (const partId of requestedPartIds) {
		if (!parsed.has(partId)) {
			throw new ParadisOfficePackageError('unsafe');
		}
	}
	return parsed;
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
	entry: ParadisOfficeArchiveEntry,
	maximumBytes: number,
	token: CancellationToken | undefined,
	checkpoint: (force?: boolean) => void,
): Promise<Uint8Array> {
	const chunks: Uint8Array[] = [];
	let length = 0;
	for await (const chunk of archive.read(entry, token)) {
		checkpoint();
		if (!(chunk instanceof Uint8Array) || !Number.isSafeInteger(length + chunk.byteLength) || length + chunk.byteLength > maximumBytes) {
			throw new ParadisOfficePackageError('limitExceeded');
		}
		length += chunk.byteLength;
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
	for (const child of elementChildren(root, checkpoint)) {
		checkpoint();
		if (!isSpreadsheetElement(child)) {
			counters.unknownElements++;
			continue;
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
	for (const child of elementChildren(root, checkpoint)) {
		checkpoint();
		if (!isSpreadsheetElement(child)) {
			counters.unknownElements++;
			continue;
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
	for (const child of elementChildren(node, checkpoint)) {
		if (!isSpreadsheetElement(child) || !validEdges.has(child.local)) {
			counters.unknownElements++;
			continue;
		}
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
	for (const child of elementChildren(root, checkpoint)) {
		checkpoint();
		if (!isSpreadsheetElement(child)) {
			counters.unknownElements++;
			continue;
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
				parseSheetData(child, rows, cells, sharedStrings, styles, limits, counters, checkpoint);
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
		const selections: ParadisSemanticSheetSelection[] = [];
		for (const child of elementChildren(node, checkpoint)) {
			if (isSpreadsheetElement(child, 'pane')) {
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
			styleRef: integerAttribute(node, 's'),
		}));
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
			const addressValue = requiredAttribute(cellNode, 'r').toUpperCase();
			const coordinate = parseCellAddress(addressValue);
			if (!coordinate || coordinate.row !== rowIndex || cells.has(addressValue)) {
				throw new ParadisOfficePackageError('malformed');
			}
			cells.set(addressValue, parseCell(cellNode, sharedStrings, styles, counters, checkpoint));
			counters.parsedCells++;
		}
	}
}

function parseCell(
	node: XmlElement,
	sharedStrings: readonly SharedStringRecord[],
	styles: ParadisSpreadsheetStyles,
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
	const styleFields = cellStyleFields(styleRef, styles, counters);
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
		const inline = inlineNode ? parseStringContainer(inlineNode, counters, checkpoint) : { text: '' };
		return { storedType: 'string', rawType, rawValue: inline.text, text: inline.text, ...(inline.richText ? { richText: inline.richText } : {}), ...styleFields };
	}
	if (rawType === 's') {
		const rawValue = valueNode ? directTextContent(valueNode, checkpoint) : '';
		const sharedStringIndex = parseUnsignedInteger(rawValue);
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
		const rawValue = valueNode ? directTextContent(valueNode, checkpoint) : '';
		return { storedType: 'string', rawType, rawValue, text: rawValue, ...styleFields };
	}
	if (rawType === 'b') {
		return { storedType: 'boolean', rawType, rawValue: valueNode ? directTextContent(valueNode, checkpoint) : '', ...styleFields };
	}
	if (rawType === 'e') {
		return { storedType: 'error', rawType, rawValue: valueNode ? directTextContent(valueNode, checkpoint) : '', ...styleFields };
	}
	if (rawType === 'd') {
		return { storedType: 'date', rawType, rawValue: valueNode ? directTextContent(valueNode, checkpoint) : '', ...styleFields };
	}
	if (rawType !== undefined && rawType !== 'n') {
		counters.unresolvedReferences++;
		const rawValue = valueNode ? directTextContent(valueNode, checkpoint) : '';
		return { storedType: 'string', rawType, rawValue, text: rawValue, ...styleFields };
	}
	if (!valueNode) {
		return { storedType: 'blank', ...styleFields };
	}
	return { storedType: 'number', ...(rawType ? { rawType } : {}), rawValue: directTextContent(valueNode, checkpoint), ...styleFields };
}

function cellStyleFields(styleRef: number | undefined, styles: ParadisSpreadsheetStyles, counters: SemanticCounters): Pick<ParadisSemanticCell, 'styleRef' | 'styleSource'> {
	if (styleRef === undefined) {
		return {};
	}
	counters.cellsWithStyleRefs++;
	const format = styles.cellFormats[styleRef];
	if (!format) {
		counters.unresolvedStyleRefs++;
		return { styleRef, ...(styles.source ? { styleSource: styles.source } : {}) };
	}
	const border = format.borderRef === undefined ? undefined : styles.borders[format.borderRef];
	if (format.borderRef !== undefined && !border) {
		counters.unresolvedStyleRefs++;
	}
	if (border?.diagonalUp || border?.diagonalDown || border?.diagonal?.style || border?.diagonal?.color) {
		counters.cellsWithDiagonalStyleRefs++;
	}
	return { styleRef, ...(styles.source ? { styleSource: styles.source } : {}) };
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
	return compact({
		rgb: attribute(node, 'rgb'), indexed: integerAttribute(node, 'indexed'), theme: integerAttribute(node, 'theme'),
		tint: attribute(node, 'tint'), auto: booleanAttribute(node, 'auto'),
	});
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
