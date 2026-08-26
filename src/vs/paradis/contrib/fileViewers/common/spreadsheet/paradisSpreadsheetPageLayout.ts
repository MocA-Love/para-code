/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import { type ParadisOfficeXmlDocument, type ParadisOfficeXmlNode, ParadisOfficePackageError } from '../office/paradisOfficeArchive.js';
import type { ParadisSemanticRange, ParadisSpreadsheetPartSource, ParadisSpreadsheetTextIdentity } from './paradisSpreadsheetSemantic.js';

type XmlElement = Extract<ParadisOfficeXmlNode, { readonly kind: 'element' }>;

const spreadsheetNamespaces = new Set([
	'http://schemas.openxmlformats.org/spreadsheetml/2006/main',
	'http://purl.oclc.org/ooxml/spreadsheetml/main',
]);
const relationshipNamespaces = new Set([
	'http://schemas.openxmlformats.org/officeDocument/2006/relationships',
	'http://purl.oclc.org/ooxml/officeDocument/relationships',
]);
const maximumExcelRows = 1_048_576;
const maximumExcelColumns = 16_384;

export interface ParadisSpreadsheetPrintTitles {
	readonly rows?: { readonly from: number; readonly to: number };
	readonly columns?: { readonly from: number; readonly to: number };
}

export interface ParadisSpreadsheetPrintOptions {
	readonly horizontalCentered?: boolean;
	readonly verticalCentered?: boolean;
	readonly headings?: boolean;
	readonly gridLines?: boolean;
	readonly gridLinesSet?: boolean;
}

export interface ParadisSpreadsheetPageMargins {
	readonly left?: string;
	readonly right?: string;
	readonly top?: string;
	readonly bottom?: string;
	readonly header?: string;
	readonly footer?: string;
}

export interface ParadisSpreadsheetPageSetup {
	readonly fitToPage?: boolean;
	readonly autoPageBreaks?: boolean;
	readonly paperSize?: number;
	readonly paperWidth?: string;
	readonly paperHeight?: string;
	readonly paperUnits?: string;
	readonly scale?: number;
	readonly firstPageNumber?: number;
	readonly fitToWidth?: number;
	readonly fitToHeight?: number;
	readonly pageOrder?: 'downThenOver' | 'overThenDown';
	readonly orientation?: 'default' | 'portrait' | 'landscape';
	readonly usePrinterDefaults?: boolean;
	readonly blackAndWhite?: boolean;
	readonly draft?: boolean;
	readonly cellComments?: 'none' | 'asDisplayed' | 'atEnd';
	readonly useFirstPageNumber?: boolean;
	readonly errors?: 'displayed' | 'blank' | 'dash' | 'NA';
	readonly horizontalDpi?: number;
	readonly verticalDpi?: number;
	readonly copies?: number;
	readonly printerSettingsRelationshipId?: string;
	readonly printerSettingsSource?: ParadisSpreadsheetPartSource;
}

export interface ParadisSpreadsheetPageBreak {
	readonly id: number;
	readonly min: number;
	readonly max: number;
	readonly manual: boolean;
	readonly pivotCreated?: boolean;
}

export interface ParadisSpreadsheetPageBreaks {
	readonly rows: readonly ParadisSpreadsheetPageBreak[];
	readonly columns: readonly ParadisSpreadsheetPageBreak[];
}

export type ParadisSpreadsheetHeaderFooterToken =
	| { readonly kind: 'text'; readonly value: string }
	| { readonly kind: 'page' | 'pages' | 'date' | 'time' | 'fileName' | 'path' | 'sheetName' | 'picture' | 'redactedPath' }
	| { readonly kind: 'format'; readonly code: string };

export interface ParadisSpreadsheetHeaderFooterSections {
	readonly left: readonly ParadisSpreadsheetHeaderFooterToken[];
	readonly center: readonly ParadisSpreadsheetHeaderFooterToken[];
	readonly right: readonly ParadisSpreadsheetHeaderFooterToken[];
}

export interface ParadisSpreadsheetHeaderFooterVariant {
	readonly header?: ParadisSpreadsheetHeaderFooterSections;
	readonly footer?: ParadisSpreadsheetHeaderFooterSections;
}

export interface ParadisSpreadsheetHeaderFooter {
	readonly differentOddEven?: boolean;
	readonly differentFirst?: boolean;
	readonly scaleWithDocument?: boolean;
	readonly alignWithMargins?: boolean;
	readonly odd?: ParadisSpreadsheetHeaderFooterVariant;
	readonly even?: ParadisSpreadsheetHeaderFooterVariant;
	readonly first?: ParadisSpreadsheetHeaderFooterVariant;
	readonly identities: readonly ParadisSpreadsheetTextIdentity[];
}

export interface ParadisSpreadsheetPrintSemantics {
	readonly source: ParadisSpreadsheetPartSource;
	readonly workbookSource: ParadisSpreadsheetPartSource;
	readonly areas: readonly ParadisSemanticRange[];
	readonly titles: ParadisSpreadsheetPrintTitles;
	readonly options: ParadisSpreadsheetPrintOptions;
	readonly margins: ParadisSpreadsheetPageMargins;
	readonly setup: ParadisSpreadsheetPageSetup;
	readonly headerFooter: ParadisSpreadsheetHeaderFooter;
	readonly breaks: ParadisSpreadsheetPageBreaks;
}

/** @internal Services supplied by the bounded, authority-verifying Task 4A parser. */
export interface ParadisSpreadsheetPrintParseServices {
	readonly checkpoint: () => void;
	readonly consumePrintRange: () => void;
	readonly consumePageBreak: () => void;
	readonly resolvePrinterSettingsRelationship: (id: string) => ParadisSpreadsheetPartSource;
	readonly textIdentity: (value: string) => ParadisSpreadsheetTextIdentity;
	readonly opaque: (node: XmlElement, source: ParadisSpreadsheetPartSource, path: string) => void;
}

/** Parses a strict Excel A1 rectangle and returns its canonical absolute-free identity. */
export function parseSpreadsheetA1Range(value: string): ParadisSemanticRange {
	if (typeof value !== 'string' || value.length < 2 || value.length > 64 || /\s/.test(value)) {
		throw new ParadisOfficePackageError('malformed');
	}
	const match = /^\$?([A-Za-z]{1,3})\$?([1-9][0-9]*)(?::\$?([A-Za-z]{1,3})\$?([1-9][0-9]*))?$/.exec(value);
	if (!match) {
		throw new ParadisOfficePackageError('malformed');
	}
	const minColumn = columnNumber(match[1]);
	const minRow = boundedInteger(match[2], 1, maximumExcelRows);
	const maxColumn = match[3] ? columnNumber(match[3]) : minColumn;
	const maxRow = match[4] ? boundedInteger(match[4], 1, maximumExcelRows) : minRow;
	if (minColumn > maxColumn || minRow > maxRow) {
		throw new ParadisOfficePackageError('malformed');
	}
	const ref = `${columnName(minColumn)}${minRow}${minColumn === maxColumn && minRow === maxRow ? '' : `:${columnName(maxColumn)}${maxRow}`}`;
	return { ref, minRow, maxRow, minColumn, maxColumn };
}

/** Parses workbook-defined print names and worksheet print primitives from verified XML documents. */
export function parseSpreadsheetPrintSemantics(
	workbookDocument: ParadisOfficeXmlDocument,
	worksheetDocument: ParadisOfficeXmlDocument,
	sheetName: string,
	localSheetId: number,
	workbookSource: ParadisSpreadsheetPartSource,
	worksheetSource: ParadisSpreadsheetPartSource,
	services: ParadisSpreadsheetPrintParseServices,
): ParadisSpreadsheetPrintSemantics {
	const workbook = spreadsheetRoot(workbookDocument, 'workbook');
	const worksheet = spreadsheetRoot(worksheetDocument, 'worksheet');
	const names = parseDefinedPrintNames(workbook, sheetName, localSheetId, services);
	const options: ParadisSpreadsheetPrintOptions = {};
	const margins: ParadisSpreadsheetPageMargins = {};
	const setup: ParadisSpreadsheetPageSetup = {};
	let headerFooter: ParadisSpreadsheetHeaderFooter = { identities: [] };
	let rowBreaks: readonly ParadisSpreadsheetPageBreak[] = [];
	let columnBreaks: readonly ParadisSpreadsheetPageBreak[] = [];
	const seen = new Set<string>();
	for (const child of elementChildren(worksheet)) {
		services.checkpoint();
		if (!spreadsheetNamespaces.has(child.uri)) {
			services.opaque(child, worksheetSource, `/worksheet/${child.local}`);
			continue;
		}
		switch (child.local) {
			case 'sheetPr': singleton(seen, child.local); Object.assign(setup, parsePageSetupProperties(child)); break;
			case 'printOptions': singleton(seen, child.local); Object.assign(options, parsePrintOptions(child)); break;
			case 'pageMargins': singleton(seen, child.local); Object.assign(margins, parseMargins(child)); break;
			case 'pageSetup': {
				singleton(seen, child.local);
				const parsed = parsePageSetupNode(child);
				const printerSettingsSource = parsed.printerSettingsRelationshipId ? services.resolvePrinterSettingsRelationship(parsed.printerSettingsRelationshipId) : undefined;
				Object.assign(setup, parsed);
				if (printerSettingsSource) { Object.assign(setup, { printerSettingsSource }); }
				break;
			}
			case 'headerFooter': singleton(seen, child.local); headerFooter = parseHeaderFooter(child, worksheetSource, services); break;
			case 'rowBreaks': singleton(seen, child.local); rowBreaks = parseBreaks(child, 'row', services); break;
			case 'colBreaks': singleton(seen, child.local); columnBreaks = parseBreaks(child, 'column', services); break;
			case 'extLst': parseOpaqueExtensions(child, worksheetSource, '/worksheet/extLst', services); break;
		}
	}
	return {
		source: worksheetSource, workbookSource, areas: names.areas, titles: names.titles,
		options, margins, setup, headerFooter, breaks: { rows: rowBreaks, columns: columnBreaks },
	};
}

function parseDefinedPrintNames(
	workbook: XmlElement,
	sheetName: string,
	localSheetId: number,
	services: ParadisSpreadsheetPrintParseServices,
): { readonly areas: readonly ParadisSemanticRange[]; readonly titles: ParadisSpreadsheetPrintTitles } {
	let definedNames: XmlElement | undefined;
	for (const child of elementChildren(workbook)) {
		if (spreadsheetNamespaces.has(child.uri) && child.local === 'definedNames') {
			if (definedNames) { throw new ParadisOfficePackageError('malformed'); }
			definedNames = child;
		}
	}
	const areas: ParadisSemanticRange[] = [];
	const titles: { rows?: { from: number; to: number }; columns?: { from: number; to: number } } = {};
	let areaSeen = false;
	let titlesSeen = false;
	for (const node of elementChildren(definedNames)) {
		services.checkpoint();
		if (!spreadsheetNamespaces.has(node.uri) || node.local !== 'definedName') {
			continue;
		}
		const name = attribute(node, 'name');
		if (name !== '_xlnm.Print_Area' && name !== '_xlnm.Print_Titles') {
			continue;
		}
		exactAttributes(node, ['name', 'localSheetId', 'hidden', 'function', 'vbProcedure', 'xlm', 'functionGroupId', 'shortcutKey', 'publishToServer', 'workbookParameter']);
		if (boundedOptionalInteger(attribute(node, 'localSheetId'), 0, Number.MAX_SAFE_INTEGER) !== localSheetId) {
			continue;
		}
		const formula = textContent(node);
		if (name === '_xlnm.Print_Area') {
			if (areaSeen) { throw new ParadisOfficePackageError('malformed'); }
			areaSeen = true;
			for (const token of splitDefinedNameUnion(formula)) {
				services.consumePrintRange();
				const range = parseQualifiedCellRange(token, sheetName);
				if (areas.some(candidate => rangesOverlap(candidate, range))) { throw new ParadisOfficePackageError('malformed'); }
				areas.push(range);
			}
		} else {
			if (titlesSeen) { throw new ParadisOfficePackageError('malformed'); }
			titlesSeen = true;
			for (const token of splitDefinedNameUnion(formula)) {
				services.consumePrintRange();
				const title = parseQualifiedTitle(token, sheetName);
				if (title.kind === 'rows') {
					if (titles.rows) { throw new ParadisOfficePackageError('malformed'); }
					titles.rows = title.rows;
				} else {
					if (titles.columns) { throw new ParadisOfficePackageError('malformed'); }
					titles.columns = title.columns;
				}
			}
		}
	}
	return { areas: Object.freeze(areas), titles };
}

function parsePrintOptions(node: XmlElement): ParadisSpreadsheetPrintOptions {
	exactAttributes(node, ['horizontalCentered', 'verticalCentered', 'headings', 'gridLines', 'gridLinesSet']);
	return optionalBooleans(node, ['horizontalCentered', 'verticalCentered', 'headings', 'gridLines', 'gridLinesSet']);
}

function parseMargins(node: XmlElement): ParadisSpreadsheetPageMargins {
	exactAttributes(node, ['left', 'right', 'top', 'bottom', 'header', 'footer']);
	const result: Record<string, string> = {};
	for (const key of ['left', 'right', 'top', 'bottom', 'header', 'footer'] as const) {
		const value = attribute(node, key);
		if (value !== undefined) {
			const number = Number(value);
			if (!Number.isFinite(number) || number < 0) { throw new ParadisOfficePackageError('malformed'); }
			result[key] = value;
		}
	}
	return result;
}

function parsePageSetupNode(node: XmlElement): ParadisSpreadsheetPageSetup {
	exactAttributes(node, [
		'paperSize', 'paperWidth', 'paperHeight', 'paperUnits', 'scale', 'firstPageNumber', 'fitToWidth', 'fitToHeight', 'pageOrder', 'orientation', 'usePrinterDefaults',
		'blackAndWhite', 'draft', 'cellComments', 'useFirstPageNumber', 'errors', 'horizontalDpi', 'verticalDpi', 'copies',
	], ['id']);
	const result: Record<string, string | number | boolean> = {};
	for (const key of ['paperWidth', 'paperHeight'] as const) {
		const value = attribute(node, key);
		if (value !== undefined) {
			if (!/^(?:0|[1-9][0-9]*)(?:\.[0-9]+)?(?:mm|cm|in|pt|pc|pi)$/.test(value) || Number.parseFloat(value) <= 0) { throw new ParadisOfficePackageError('malformed'); }
			result[key] = value;
		}
	}
	const paperUnits = enumAttribute(node, 'paperUnits', ['mm', 'cm', 'in', 'pt', 'pc', 'pi']);
	if (paperUnits) { result.paperUnits = paperUnits; }
	for (const [key, minimum, maximum] of [
		['paperSize', 1, 255], ['scale', 10, 400], ['firstPageNumber', 1, 0xffffffff], ['fitToWidth', 0, 0xffff],
		['fitToHeight', 0, 0xffff], ['horizontalDpi', 1, 0xffffffff], ['verticalDpi', 1, 0xffffffff], ['copies', 1, 0xffff],
	] as const) {
		const value = attribute(node, key);
		if (value !== undefined) { result[key] = boundedInteger(value, minimum, maximum); }
	}
	for (const key of ['usePrinterDefaults', 'blackAndWhite', 'draft', 'useFirstPageNumber'] as const) {
		const value = attribute(node, key);
		if (value !== undefined) { result[key] = booleanLexical(value); }
	}
	const pageOrder = enumAttribute(node, 'pageOrder', ['downThenOver', 'overThenDown']);
	const orientation = enumAttribute(node, 'orientation', ['default', 'portrait', 'landscape']);
	const cellComments = enumAttribute(node, 'cellComments', ['none', 'asDisplayed', 'atEnd']);
	const errors = enumAttribute(node, 'errors', ['displayed', 'blank', 'dash', 'NA']);
	if (pageOrder) { result.pageOrder = pageOrder; }
	if (orientation) { result.orientation = orientation; }
	if (cellComments) { result.cellComments = cellComments; }
	if (errors) { result.errors = errors; }
	const relationshipId = namespacedAttribute(node, relationshipNamespaces, 'id');
	if (relationshipId !== undefined) { result.printerSettingsRelationshipId = relationshipId; }
	return result;
}

function parsePageSetupProperties(sheetProperties: XmlElement): Pick<ParadisSpreadsheetPageSetup, 'fitToPage' | 'autoPageBreaks'> {
	let result: Pick<ParadisSpreadsheetPageSetup, 'fitToPage' | 'autoPageBreaks'> = {};
	for (const child of elementChildren(sheetProperties)) {
		if (!spreadsheetNamespaces.has(child.uri) || child.local !== 'pageSetUpPr') { continue; }
		if (Object.keys(result).length !== 0) { throw new ParadisOfficePackageError('malformed'); }
		exactAttributes(child, ['fitToPage', 'autoPageBreaks']);
		result = { fitToPage: optionalBooleanValue(child, 'fitToPage'), autoPageBreaks: optionalBooleanValue(child, 'autoPageBreaks') };
	}
	return result;
}

function parseHeaderFooter(node: XmlElement, source: ParadisSpreadsheetPartSource, services: ParadisSpreadsheetPrintParseServices): ParadisSpreadsheetHeaderFooter {
	exactAttributes(node, ['differentOddEven', 'differentFirst', 'scaleWithDoc', 'alignWithMargins']);
	const result: {
		differentOddEven?: boolean; differentFirst?: boolean; scaleWithDocument?: boolean; alignWithMargins?: boolean;
		odd?: ParadisSpreadsheetHeaderFooterVariant; even?: ParadisSpreadsheetHeaderFooterVariant; first?: ParadisSpreadsheetHeaderFooterVariant;
		identities: ParadisSpreadsheetTextIdentity[];
	} = { identities: [] };
	const flagMapping = [
		['differentOddEven', 'differentOddEven'], ['differentFirst', 'differentFirst'],
		['scaleWithDoc', 'scaleWithDocument'], ['alignWithMargins', 'alignWithMargins'],
	] as const;
	for (const [attributeName, propertyName] of flagMapping) {
		const value = attribute(node, attributeName);
		if (value !== undefined) { result[propertyName] = booleanLexical(value); }
	}
	const seen = new Set<string>();
	for (const child of elementChildren(node)) {
		services.checkpoint();
		if (!spreadsheetNamespaces.has(child.uri)) {
			services.opaque(child, source, `/worksheet/headerFooter/${child.local}`);
			continue;
		}
		const match = /^(odd|even|first)(Header|Footer)$/.exec(child.local);
		if (!match || child.attributes.length !== 0 || seen.has(child.local)) { throw new ParadisOfficePackageError('malformed'); }
		seen.add(child.local);
		const value = textContent(child);
		result.identities.push(services.textIdentity(value));
		const variant = match[1] as 'odd' | 'even' | 'first';
		const side = match[2] === 'Header' ? 'header' : 'footer';
		result[variant] = { ...result[variant], [side]: parseHeaderFooterSections(value) };
	}
	return result;
}

function parseHeaderFooterSections(value: string): ParadisSpreadsheetHeaderFooterSections {
	const sections: Record<'left' | 'center' | 'right', ParadisSpreadsheetHeaderFooterToken[]> = { left: [], center: [], right: [] };
	let active: keyof typeof sections = 'center';
	let text = '';
	const flush = () => {
		if (!text) { return; }
		const tokens = redactLiteralPath(text);
		sections[active].push(...tokens);
		text = '';
	};
	for (let index = 0; index < value.length; index++) {
		if (value[index] !== '&') { text += value[index]; continue; }
		const next = value[index + 1];
		if (next === undefined) { text += '&'; continue; }
		if (next === '&') { text += '&'; index++; continue; }
		flush();
		index++;
		if (next === 'L' || next === 'C' || next === 'R') {
			active = next === 'L' ? 'left' : next === 'C' ? 'center' : 'right';
			continue;
		}
		const token = headerFooterFieldToken(next);
		if (token) { sections[active].push(token); continue; }
		if (next === '"') {
			const end = value.indexOf('"', index + 1);
			if (end < 0) { throw new ParadisOfficePackageError('malformed'); }
			sections[active].push({ kind: 'format', code: 'font' });
			index = end;
			continue;
		}
		if (/[0-9]/.test(next)) {
			while (index + 1 < value.length && /[0-9]/.test(value[index + 1])) { index++; }
			sections[active].push({ kind: 'format', code: 'size' });
			continue;
		}
		sections[active].push({ kind: 'format', code: /^[A-Za-z+\-]$/.test(next) ? next : 'unknown' });
	}
	flush();
	return { left: Object.freeze(sections.left), center: Object.freeze(sections.center), right: Object.freeze(sections.right) };
}

function headerFooterFieldToken(code: string): ParadisSpreadsheetHeaderFooterToken | undefined {
	switch (code) {
		case 'P': return { kind: 'page' };
		case 'N': return { kind: 'pages' };
		case 'D': return { kind: 'date' };
		case 'T': return { kind: 'time' };
		case 'F': return { kind: 'fileName' };
		case 'Z': return { kind: 'path' };
		case 'A': return { kind: 'sheetName' };
		case 'G': return { kind: 'picture' };
		default: return undefined;
	}
}

function redactLiteralPath(value: string): readonly ParadisSpreadsheetHeaderFooterToken[] {
	return headerFooterTextLooksSensitive(value) ? [{ kind: 'redactedPath' }] : [{ kind: 'text', value: sanitizeText(value) }];
}

/** Redacts path/URI literals while retaining exact text only in the separately stored fingerprint. */
export function redactSpreadsheetHeaderFooterText(value: string): string {
	return headerFooterTextLooksSensitive(value) ? '[path]' : sanitizeText(value);
}

function headerFooterTextLooksSensitive(value: string): boolean {
	return /(?:[A-Za-z]:[\\/]|\\\\|\/(?:[^&\s]+)|(?:^|\s)\.\.?[\\/])/.test(value)
		|| /[A-Za-z][A-Za-z0-9+.-]*:/.test(value)
		|| value.includes('\\');
}

function parseBreaks(node: XmlElement, axis: 'row' | 'column', services: ParadisSpreadsheetPrintParseServices): readonly ParadisSpreadsheetPageBreak[] {
	exactAttributes(node, ['count', 'manualBreakCount']);
	const children = elementChildren(node);
	const declared = boundedOptionalInteger(attribute(node, 'count'), 0, axis === 'row' ? maximumExcelRows : maximumExcelColumns);
	if (declared !== undefined && declared !== children.length) { throw new ParadisOfficePackageError('malformed'); }
	const manualDeclared = boundedOptionalInteger(attribute(node, 'manualBreakCount'), 0, children.length);
	const result: ParadisSpreadsheetPageBreak[] = [];
	const identities = new Set<number>();
	for (const child of children) {
		services.checkpoint();
		services.consumePageBreak();
		if (!spreadsheetNamespaces.has(child.uri) || child.local !== 'brk') { throw new ParadisOfficePackageError('malformed'); }
		exactAttributes(child, ['id', 'min', 'max', 'man', 'pt']);
		const id = boundedOptionalInteger(attribute(child, 'id'), 0, axis === 'row' ? maximumExcelRows - 1 : maximumExcelColumns - 1) ?? 0;
		const axisMaximum = axis === 'row' ? maximumExcelColumns - 1 : maximumExcelRows - 1;
		const min = boundedOptionalInteger(attribute(child, 'min'), 0, axisMaximum) ?? 0;
		const max = boundedOptionalInteger(attribute(child, 'max'), min, axisMaximum) ?? 0;
		if (max < min) { throw new ParadisOfficePackageError('malformed'); }
		if (identities.has(id)) { throw new ParadisOfficePackageError('malformed'); }
		identities.add(id);
		result.push({
			id, min, max, manual: attribute(child, 'man') === undefined ? false : booleanLexical(attribute(child, 'man')!),
			...(attribute(child, 'pt') === undefined ? {} : { pivotCreated: booleanLexical(attribute(child, 'pt')!) }),
		});
	}
	if (manualDeclared !== undefined && manualDeclared !== result.filter(value => value.manual).length) { throw new ParadisOfficePackageError('malformed'); }
	return Object.freeze(result);
}

function parseOpaqueExtensions(node: XmlElement, source: ParadisSpreadsheetPartSource, path: string, services: ParadisSpreadsheetPrintParseServices): void {
	if (node.attributes.length !== 0) { throw new ParadisOfficePackageError('malformed'); }
	for (const extension of elementChildren(node)) {
		services.checkpoint();
		if (!spreadsheetNamespaces.has(extension.uri) || extension.local !== 'ext') { throw new ParadisOfficePackageError('malformed'); }
		exactAttributes(extension, ['uri']);
		services.opaque(extension, source, `${path}/ext`);
	}
}

function parseQualifiedCellRange(value: string, sheetName: string): ParadisSemanticRange {
	const [qualifier, ref] = splitQualifier(value);
	if (decodeSheetQualifier(qualifier) !== sheetName) { throw new ParadisOfficePackageError('malformed'); }
	return parseSpreadsheetA1Range(ref);
}

function parseQualifiedTitle(value: string, sheetName: string):
	| { readonly kind: 'rows'; readonly rows: { readonly from: number; readonly to: number } }
	| { readonly kind: 'columns'; readonly columns: { readonly from: number; readonly to: number } } {
	const [qualifier, ref] = splitQualifier(value);
	if (decodeSheetQualifier(qualifier) !== sheetName) { throw new ParadisOfficePackageError('malformed'); }
	let match = /^\$([1-9][0-9]*):\$([1-9][0-9]*)$/.exec(ref);
	if (match) {
		const from = boundedInteger(match[1], 1, maximumExcelRows);
		const to = boundedInteger(match[2], from, maximumExcelRows);
		return { kind: 'rows', rows: { from, to } };
	}
	match = /^\$([A-Za-z]{1,3}):\$([A-Za-z]{1,3})$/.exec(ref);
	if (match) {
		const from = columnNumber(match[1]);
		const to = columnNumber(match[2]);
		if (from > to) { throw new ParadisOfficePackageError('malformed'); }
		return { kind: 'columns', columns: { from, to } };
	}
	throw new ParadisOfficePackageError('malformed');
}

function splitDefinedNameUnion(value: string): readonly string[] {
	const result: string[] = [];
	const apostrophe = '\u0027';
	let start = 0;
	let quoted = false;
	for (let index = 0; index < value.length; index++) {
		if (value[index] === apostrophe) {
			if (quoted && value[index + 1] === apostrophe) { index++; continue; }
			quoted = !quoted;
		} else if (value[index] === ',' && !quoted) {
			result.push(value.slice(start, index)); start = index + 1;
		}
	}
	if (quoted) { throw new ParadisOfficePackageError('malformed'); }
	result.push(value.slice(start));
	if (result.some(token => token.length === 0 || token.trim() !== token)) { throw new ParadisOfficePackageError('malformed'); }
	return result;
}

function splitQualifier(value: string): readonly [string, string] {
	const apostrophe = '\u0027';
	let quoted = false;
	for (let index = 0; index < value.length; index++) {
		if (value[index] === apostrophe) {
			if (quoted && value[index + 1] === apostrophe) { index++; continue; }
			quoted = !quoted;
		} else if (value[index] === '!' && !quoted) {
			return [value.slice(0, index), value.slice(index + 1)];
		}
	}
	throw new ParadisOfficePackageError('malformed');
}

function decodeSheetQualifier(value: string): string {
	const apostrophe = '\u0027';
	if (value.startsWith(apostrophe) && value.endsWith(apostrophe) && value.length >= 2) {
		return value.slice(1, -1).replaceAll(apostrophe.repeat(2), apostrophe);
	}
	if (!/^[^'!\[\]]+$/.test(value)) { throw new ParadisOfficePackageError('malformed'); }
	return value;
}

function rangesOverlap(left: ParadisSemanticRange, right: ParadisSemanticRange): boolean {
	return left.minRow <= right.maxRow && right.minRow <= left.maxRow && left.minColumn <= right.maxColumn && right.minColumn <= left.maxColumn;
}

function spreadsheetRoot(document: ParadisOfficeXmlDocument, local: string): XmlElement {
	if (!document || !document.root || document.root.kind !== 'element' || !spreadsheetNamespaces.has(document.root.uri) || document.root.local !== local) {
		throw new ParadisOfficePackageError('malformed');
	}
	return document.root;
}

function elementChildren(node: XmlElement | undefined): readonly XmlElement[] {
	return node ? node.children.filter((child): child is XmlElement => child.kind === 'element') : [];
}

function textContent(node: XmlElement): string {
	let result = '';
	for (const child of node.children) {
		if (child.kind !== 'text') { throw new ParadisOfficePackageError('malformed'); }
		result += child.value;
	}
	return result;
}

function exactAttributes(node: XmlElement, unqualified: readonly string[], related: readonly string[] = []): void {
	const ordinary = new Set(unqualified);
	const relationship = new Set(related);
	for (const candidate of node.attributes) {
		if (candidate.uri === '' ? ordinary.has(candidate.local) : relationshipNamespaces.has(candidate.uri) && relationship.has(candidate.local)) { continue; }
		throw new ParadisOfficePackageError('malformed');
	}
}

function attribute(node: XmlElement, local: string): string | undefined {
	return node.attributes.find(candidate => candidate.uri === '' && candidate.local === local)?.value;
}

function namespacedAttribute(node: XmlElement, namespaces: ReadonlySet<string>, local: string): string | undefined {
	return node.attributes.find(candidate => namespaces.has(candidate.uri) && candidate.local === local)?.value;
}

function optionalBooleans<T extends string>(node: XmlElement, keys: readonly T[]): Partial<Record<T, boolean>> {
	const result: Partial<Record<T, boolean>> = {};
	for (const key of keys) {
		const value = attribute(node, key);
		if (value !== undefined) { result[key] = booleanLexical(value); }
	}
	return result;
}

function booleanLexical(value: string): boolean {
	if (value === '1' || value === 'true') { return true; }
	if (value === '0' || value === 'false') { return false; }
	throw new ParadisOfficePackageError('malformed');
}

function optionalBooleanValue(node: XmlElement, local: string): boolean | undefined {
	const value = attribute(node, local);
	return value === undefined ? undefined : booleanLexical(value);
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

function singleton(seen: Set<string>, value: string): void {
	if (seen.has(value)) { throw new ParadisOfficePackageError('malformed'); }
	seen.add(value);
}

function columnNumber(value: string): number {
	let result = 0;
	for (const character of value.toUpperCase()) { result = result * 26 + character.charCodeAt(0) - 64; }
	if (result < 1 || result > maximumExcelColumns) { throw new ParadisOfficePackageError('malformed'); }
	return result;
}

function columnName(value: number): string {
	let result = '';
	while (value > 0) { value--; result = String.fromCharCode(65 + value % 26) + result; value = Math.floor(value / 26); }
	return result;
}

function sanitizeText(value: string): string {
	return value.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f\u202a-\u202e\u2066-\u2069]/g, '�');
}
