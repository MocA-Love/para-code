/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import { ParadisOfficePackageError, type ParadisOfficeXmlNode } from '../office/paradisOfficeArchive.js';
import {
	ParadisWordModelGuard,
	sanitizeModelError,
	validateAuthority,
	type ParadisWordModelOptions,
	type ParadisWordPartAuthority,
} from './paradisWordStyles.js';

const wordNamespaces = new Set([
	'http://schemas.openxmlformats.org/wordprocessingml/2006/main',
	'http://purl.oclc.org/ooxml/wordprocessingml/main',
]);

type XmlElement = Extract<ParadisOfficeXmlNode, { readonly kind: 'element' }>;

export interface ParadisWordTableParseOptions extends ParadisWordModelOptions {
	readonly maximumCells?: number;
	readonly maximumTableDepth?: number;
}

export interface ParadisWordTableParseSource {
	readonly authority: ParadisWordPartAuthority;
	readonly semanticPath: readonly number[];
}

export interface ParadisWordTableSource extends ParadisWordPartAuthority {
	readonly semanticPath: readonly number[];
	/** Element-only location relative to the table passed to parseParadisWordTable. */
	readonly xmlPath: readonly number[];
}

export interface ParadisWordTableWidth {
	readonly value?: string;
	readonly type?: string;
}

export interface ParadisWordTableHeight {
	readonly value?: string;
	readonly rule?: string;
}

export interface ParadisWordTableBorder {
	readonly direction?: 'topLeftToBottomRight' | 'topRightToBottomLeft';
	readonly value?: string;
	readonly size?: string;
	readonly color?: string;
	readonly themeColor?: string;
	readonly themeTint?: string;
	readonly themeShade?: string;
	readonly space?: string;
	readonly provenance: ParadisWordTableSource;
}

export interface ParadisWordTableCell {
	readonly columnStart: number;
	readonly columnSpan: number;
	readonly verticalMerge?: 'restart' | 'continue';
	readonly horizontalMerge?: 'restart' | 'continue';
	readonly width?: ParadisWordTableWidth;
	readonly shading?: Readonly<Record<string, string>>;
	readonly borders: Readonly<Record<string, ParadisWordTableBorder>>;
	readonly nestedTables: readonly ParadisWordTableGrid[];
}

export interface ParadisWordTableRow {
	readonly height?: ParadisWordTableHeight;
	readonly repeatHeader: boolean;
	readonly cantSplit: boolean;
	readonly cells: readonly ParadisWordTableCell[];
}

/** Source-addressed table grid. No border style or line geometry is normalized here. */
export interface ParadisWordTableGrid {
	readonly source: ParadisWordTableSource;
	readonly width?: ParadisWordTableWidth;
	readonly rightToLeft: boolean;
	readonly shading?: Readonly<Record<string, string>>;
	readonly gridColumns: readonly (string | undefined)[];
	readonly borders: Readonly<Record<string, ParadisWordTableBorder>>;
	readonly rows: readonly ParadisWordTableRow[];
}

interface TableParseState {
	readonly authority: ParadisWordPartAuthority;
	readonly guard: ParadisWordModelGuard;
	readonly maximumCells: number;
	readonly maximumTableDepth: number;
	cells: number;
}

/** Parses one table and its nested tables while retaining lexical merge and diagonal data. */
export function parseParadisWordTable(
	table: XmlElement,
	source: ParadisWordTableParseSource,
	options: ParadisWordTableParseOptions = {},
): ParadisWordTableGrid {
	try {
		validateAuthority(source.authority, uri => uri.startsWith('/word/') && uri.endsWith('.xml'));
		const maximumCells = options.maximumCells ?? 1_000_000;
		const maximumTableDepth = options.maximumTableDepth ?? 64;
		if (!Number.isSafeInteger(maximumCells) || maximumCells < 0 || !Number.isSafeInteger(maximumTableDepth) || maximumTableDepth < 1) {
			throw new ParadisOfficePackageError('limitExceeded');
		}
		const state: TableParseState = {
			authority: source.authority,
			guard: new ParadisWordModelGuard(options), maximumCells, maximumTableDepth, cells: 0,
		};
		return parseTable(table, source.semanticPath, [], state, 1);
	} catch (error) {
		throw sanitizeModelError(error);
	}
}

function parseTable(table: XmlElement, semanticPath: readonly number[], xmlPath: readonly number[], state: TableParseState, depth: number): ParadisWordTableGrid {
	state.guard.checkpoint();
	if (!isWordElement(table, 'tbl')) {
		throw new ParadisOfficePackageError('malformed');
	}
	if (depth > state.maximumTableDepth) {
		throw new ParadisOfficePackageError('limitExceeded');
	}
	let width: ParadisWordTableWidth | undefined;
	let rightToLeft = false;
	let shading: Readonly<Record<string, string>> | undefined;
	let borders: Readonly<Record<string, ParadisWordTableBorder>> = {};
	const gridColumns: (string | undefined)[] = [];
	const rows: ParadisWordTableRow[] = [];
	let rowOrdinal = 0;
	for (const [index, child] of elementChildren(table).entries()) {
		state.guard.checkpoint();
		const childXmlPath = [...xmlPath, index];
		if (isWordElement(child, 'tblPr')) {
			const properties = parseTableProperties(child, semanticPath, childXmlPath, state);
			width = properties.width;
			rightToLeft = properties.rightToLeft;
			shading = properties.shading;
			borders = properties.borders;
		} else if (isWordElement(child, 'tblGrid')) {
			for (const column of elementChildren(child)) {
				if (isWordElement(column, 'gridCol')) {
					gridColumns.push(optionalAttribute(column, wordNamespace(column), 'w'));
				}
			}
		} else if (isWordElement(child, 'tr')) {
			rows.push(parseRow(child, [...semanticPath, rowOrdinal++], childXmlPath, state, depth));
		}
	}
	return {
		source: { ...state.authority, semanticPath: Object.freeze([...semanticPath]), xmlPath: Object.freeze([...xmlPath]) },
		...(width ? { width } : {}),
		rightToLeft,
		...(shading ? { shading } : {}),
		gridColumns: Object.freeze(gridColumns), borders, rows: Object.freeze(rows),
	};
}

function parseTableProperties(element: XmlElement, semanticPath: readonly number[], xmlPath: readonly number[], state: TableParseState): {
	readonly width?: ParadisWordTableWidth;
	readonly rightToLeft: boolean;
	readonly shading?: Readonly<Record<string, string>>;
	readonly borders: Readonly<Record<string, ParadisWordTableBorder>>;
} {
	let width: ParadisWordTableWidth | undefined;
	let rightToLeft = false;
	let shading: Readonly<Record<string, string>> | undefined;
	let borders: Readonly<Record<string, ParadisWordTableBorder>> = {};
	for (const [index, child] of elementChildren(element).entries()) {
		const childXmlPath = [...xmlPath, index];
		if (isWordElement(child, 'tblW')) {
			width = parseWidth(child);
		} else if (isWordElement(child, 'bidiVisual')) {
			rightToLeft = toggle(child);
		} else if (isWordElement(child, 'shd')) {
			shading = attributeRecord(child);
		} else if (isWordElement(child, 'tblBorders')) {
			borders = parseBorders(child, semanticPath, childXmlPath, state);
		}
	}
	return { ...(width ? { width } : {}), rightToLeft, ...(shading ? { shading } : {}), borders };
}

function parseRow(element: XmlElement, semanticPath: readonly number[], xmlPath: readonly number[], state: TableParseState, depth: number): ParadisWordTableRow {
	let height: ParadisWordTableHeight | undefined;
	let repeatHeader = false;
	let cantSplit = false;
	const cells: ParadisWordTableCell[] = [];
	let columnStart = 0;
	let cellOrdinal = 0;
	for (const [index, child] of elementChildren(element).entries()) {
		const childXmlPath = [...xmlPath, index];
		if (isWordElement(child, 'trPr')) {
			for (const property of elementChildren(child)) {
				if (isWordElement(property, 'trHeight')) {
					height = { value: optionalAttribute(property, wordNamespace(property), 'val'), rule: optionalAttribute(property, wordNamespace(property), 'hRule') };
				} else if (isWordElement(property, 'tblHeader')) {
					repeatHeader = toggle(property);
				} else if (isWordElement(property, 'cantSplit')) {
					cantSplit = toggle(property);
				}
			}
		} else if (isWordElement(child, 'tc')) {
			if (++state.cells > state.maximumCells) {
				throw new ParadisOfficePackageError('limitExceeded');
			}
			const cell = parseCell(child, [...semanticPath, cellOrdinal++], childXmlPath, columnStart, state, depth);
			cells.push(cell);
			columnStart += cell.columnSpan;
		}
	}
	return { ...(height ? { height } : {}), repeatHeader, cantSplit, cells: Object.freeze(cells) };
}

function parseCell(
	element: XmlElement,
	semanticPath: readonly number[],
	xmlPath: readonly number[],
	columnStart: number,
	state: TableParseState,
	depth: number,
): ParadisWordTableCell {
	let columnSpan = 1;
	let verticalMerge: 'restart' | 'continue' | undefined;
	let horizontalMerge: 'restart' | 'continue' | undefined;
	let width: ParadisWordTableWidth | undefined;
	let shading: Readonly<Record<string, string>> | undefined;
	let borders: Readonly<Record<string, ParadisWordTableBorder>> = {};
	const nestedTables: ParadisWordTableGrid[] = [];
	let blockOrdinal = 0;
	for (const [index, child] of elementChildren(element).entries()) {
		const childXmlPath = [...xmlPath, index];
		if (isWordElement(child, 'tcPr')) {
			for (const [propertyIndex, property] of elementChildren(child).entries()) {
				const propertyXmlPath = [...childXmlPath, propertyIndex];
				if (isWordElement(property, 'gridSpan')) {
					columnSpan = positiveInteger(optionalAttribute(property, wordNamespace(property), 'val'));
				} else if (isWordElement(property, 'vMerge')) {
					verticalMerge = mergeValue(property);
				} else if (isWordElement(property, 'hMerge')) {
					horizontalMerge = mergeValue(property);
				} else if (isWordElement(property, 'tcW')) {
					width = parseWidth(property);
				} else if (isWordElement(property, 'shd')) {
					shading = attributeRecord(property);
				} else if (isWordElement(property, 'tcBorders')) {
					borders = parseBorders(property, semanticPath, propertyXmlPath, state);
				}
			}
		} else {
			if (isWordElement(child, 'tbl')) {
				nestedTables.push(parseTable(child, [...semanticPath, blockOrdinal], childXmlPath, state, depth + 1));
			}
			blockOrdinal++;
		}
	}
	return {
		columnStart, columnSpan,
		...(verticalMerge ? { verticalMerge } : {}),
		...(horizontalMerge ? { horizontalMerge } : {}),
		...(width ? { width } : {}),
		...(shading ? { shading } : {}),
		borders, nestedTables: Object.freeze(nestedTables),
	};
}

function parseBorders(
	element: XmlElement,
	semanticPath: readonly number[],
	xmlPath: readonly number[],
	state: TableParseState,
): Readonly<Record<string, ParadisWordTableBorder>> {
	const result: Record<string, ParadisWordTableBorder> = {};
	for (const [index, border] of elementChildren(element).entries()) {
		if (!isWordElement(border)) {
			continue;
		}
		const direction = border.local === 'tl2br' ? 'topLeftToBottomRight' : border.local === 'tr2bl' ? 'topRightToBottomLeft' : undefined;
		const key = direction ?? border.local;
		if (Object.hasOwn(result, key)) {
			throw new ParadisOfficePackageError('malformed');
		}
		const namespace = wordNamespace(border);
		result[key] = {
			direction,
			value: optionalAttribute(border, namespace, 'val'),
			size: optionalAttribute(border, namespace, 'sz'),
			color: optionalAttribute(border, namespace, 'color'),
			themeColor: optionalAttribute(border, namespace, 'themeColor'),
			themeTint: optionalAttribute(border, namespace, 'themeTint'),
			themeShade: optionalAttribute(border, namespace, 'themeShade'),
			space: optionalAttribute(border, namespace, 'space'),
			provenance: {
				...state.authority,
				semanticPath: Object.freeze([...semanticPath]),
				xmlPath: Object.freeze([...xmlPath, index]),
			},
		};
	}
	return result;
}

function parseWidth(element: XmlElement): ParadisWordTableWidth {
	const namespace = wordNamespace(element);
	return { value: optionalAttribute(element, namespace, 'w'), type: optionalAttribute(element, namespace, 'type') };
}

function mergeValue(element: XmlElement): 'restart' | 'continue' {
	const value = optionalAttribute(element, wordNamespace(element), 'val');
	if (value === undefined || value === 'continue') {
		return 'continue';
	}
	if (value === 'restart') {
		return 'restart';
	}
	throw new ParadisOfficePackageError('malformed');
}

function positiveInteger(value: string | undefined): number {
	if (!value || !/^\d+$/.test(value)) {
		throw new ParadisOfficePackageError('malformed');
	}
	const result = Number(value);
	if (!Number.isSafeInteger(result) || result < 1) {
		throw new ParadisOfficePackageError('limitExceeded');
	}
	return result;
}

function toggle(element: XmlElement): boolean {
	const value = optionalAttribute(element, wordNamespace(element), 'val');
	return value === undefined || value === '1' || value === 'true' || value === 'on';
}

function attributeRecord(element: XmlElement): Readonly<Record<string, string>> {
	const result: Record<string, string> = {};
	for (const attribute of element.attributes) {
		if (wordNamespaces.has(attribute.uri) || attribute.uri === '') {
			result[attribute.local] = attribute.value;
		}
	}
	return result;
}

function elementChildren(element: XmlElement): readonly XmlElement[] {
	return element.children.filter((child): child is XmlElement => child.kind === 'element');
}

function isWordElement(element: XmlElement, local?: string): boolean {
	return wordNamespaces.has(element.uri) && (local === undefined || element.local === local);
}

function wordNamespace(element: XmlElement): string {
	if (!wordNamespaces.has(element.uri)) {
		throw new ParadisOfficePackageError('malformed');
	}
	return element.uri;
}

function optionalAttribute(element: XmlElement, uri: string, local: string): string | undefined {
	const matches = element.attributes.filter(attribute => attribute.uri === uri && attribute.local === local);
	if (matches.length > 1) {
		throw new ParadisOfficePackageError('malformed');
	}
	return matches[0]?.value;
}
