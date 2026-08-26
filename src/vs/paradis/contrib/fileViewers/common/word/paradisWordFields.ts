/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import type { CancellationToken } from '../../../../../base/common/cancellation.js';
import { ParadisOfficePackageError, throwIfParadisOfficeCancelled, type ParadisOfficeXmlNode } from '../office/paradisOfficeArchive.js';
import type { ParadisOfficeFingerprint } from '../paradisOfficeProtocol.js';
import {
	fingerprintParadisWordObjectBytes,
	ownParadisWordObjectPart,
	parseParadisWordObjectXml,
	parseParadisWordRelationships,
	type ParadisWordObjectPartInput,
	type ParadisWordObjectSource,
	type ParadisWordParsedRelationship,
} from './paradisWordObjects.js';
import { ParadisWordModelGuard, sanitizeModelError, type ParadisWordModelOptions, type ParadisWordPartAuthority } from './paradisWordStyles.js';

type XmlElement = Extract<ParadisOfficeXmlNode, { readonly kind: 'element' }>;

const wordNamespaces = new Set([
	'http://schemas.openxmlformats.org/wordprocessingml/2006/main',
	'http://purl.oclc.org/ooxml/wordprocessingml/main',
]);
const relationshipNamespaces = new Set([
	'http://schemas.openxmlformats.org/officeDocument/2006/relationships',
	'http://purl.oclc.org/ooxml/officeDocument/relationships',
]);
const headerRelationshipTypes = new Set([
	'http://schemas.openxmlformats.org/officeDocument/2006/relationships/header',
	'http://purl.oclc.org/ooxml/officeDocument/relationships/header',
]);
const footerRelationshipTypes = new Set([
	'http://schemas.openxmlformats.org/officeDocument/2006/relationships/footer',
	'http://purl.oclc.org/ooxml/officeDocument/relationships/footer',
]);

export interface ParadisWordFieldParseInput {
	readonly document: ParadisWordObjectPartInput;
	readonly relationshipPart?: ParadisWordObjectPartInput;
	readonly token?: CancellationToken;
}

export interface ParadisWordFieldParseOptions extends ParadisWordModelOptions {
	readonly maximumFields?: number;
	readonly maximumFieldDepth?: number;
	readonly maximumSections?: number;
	readonly maximumRevisions?: number;
}

export interface ParadisWordFieldObject {
	readonly id: string;
	readonly kind: 'field';
	readonly fieldKind: 'simple' | 'complex';
	readonly source: ParadisWordObjectSource;
	readonly instruction: string;
	readonly savedResult: string;
	readonly dirty?: string;
	readonly locked?: string;
	readonly evaluation: 'savedResultOnly';
	readonly fingerprint: ParadisOfficeFingerprint;
}

export interface ParadisWordSectionStoryReference {
	readonly kind: 'header' | 'footer';
	readonly role: 'default' | 'first' | 'even';
	readonly targetPartUri: string;
}

export interface ParadisWordSectionObject {
	readonly id: string;
	readonly kind: 'section';
	readonly sectionOrdinal: number;
	readonly source: ParadisWordObjectSource;
	readonly breakType?: string;
	readonly paper?: { readonly width?: string; readonly height?: string; readonly orientation?: string; readonly code?: string };
	readonly margins?: {
		readonly top?: string; readonly right?: string; readonly bottom?: string; readonly left?: string;
		readonly header?: string; readonly footer?: string; readonly gutter?: string;
	};
	readonly columns?: {
		readonly count?: string;
		readonly space?: string;
		readonly equalWidth?: string;
		readonly separator?: string;
		readonly definitions: readonly { readonly width?: string; readonly space?: string }[];
	};
	readonly pageNumber?: { readonly start?: string; readonly format?: string; readonly chapterStyle?: string; readonly chapterSeparator?: string };
	readonly titlePage: boolean;
	readonly storyReferences: readonly ParadisWordSectionStoryReference[];
	readonly fingerprint: ParadisOfficeFingerprint;
}

export type ParadisWordRevisionPropertyScope = 'paragraph' | 'run' | 'table' | 'row' | 'cell' | 'section';

export interface ParadisWordRevisionObject {
	readonly id: string;
	readonly kind: 'revision';
	readonly revisionKind: 'inserted' | 'deleted' | 'moveFrom' | 'moveTo' | 'propertyChange';
	readonly propertyScope?: ParadisWordRevisionPropertyScope;
	readonly source: ParadisWordObjectSource;
	readonly revisionId?: string;
	readonly author?: string;
	readonly date?: string;
	readonly text: string;
	readonly fingerprint: ParadisOfficeFingerprint;
}

export interface ParadisWordFieldModel {
	readonly fields: readonly ParadisWordFieldObject[];
	readonly sections: readonly ParadisWordSectionObject[];
	readonly revisions: readonly ParadisWordRevisionObject[];
}

interface OrderedField {
	readonly order: number;
	readonly value: ParadisWordFieldObject;
}

interface ComplexFieldState {
	readonly source: ParadisWordObjectSource;
	readonly order: number;
	readonly instruction: string[];
	readonly savedResult: string[];
	readonly dirty?: string;
	readonly locked?: string;
	separated: boolean;
}

/** Parses stored field results, section settings, and in-document revisions without evaluating fields. */
export function parseParadisWordFields(input: ParadisWordFieldParseInput, options: ParadisWordFieldParseOptions = {}): ParadisWordFieldModel {
	try {
		throwIfParadisOfficeCancelled(input?.token ?? options.token);
		const maximumFields = boundedMaximum(options.maximumFields, 1_000_000);
		const maximumFieldDepth = boundedMaximum(options.maximumFieldDepth, 1_024);
		const maximumSections = boundedMaximum(options.maximumSections, 100_000);
		const maximumRevisions = boundedMaximum(options.maximumRevisions, 1_000_000);
		const guard = new ParadisWordModelGuard({
			...options,
			maximumDefinitions: Math.min(1_000_000, maximumFields + maximumSections + maximumRevisions),
			token: input.token ?? options.token,
		});
		const document = ownParadisWordObjectPart(input.document, isWordStoryPart);
		const relationshipPart = input.relationshipPart
			? ownParadisWordObjectPart(input.relationshipPart, uri => uri === relationshipPartUri(document.source.partUri))
			: undefined;
		if (relationshipPart?.contentType && relationshipPart.contentType.toLocaleLowerCase('en-US') !== 'application/vnd.openxmlformats-package.relationships+xml') {
			throw new ParadisOfficePackageError('unsafe');
		}
		const relationships = relationshipPart ? parseParadisWordRelationships(relationshipPart, document.source.partUri, guard) : new Map<string, ParadisWordParsedRelationship>();
		const root = parseParadisWordObjectXml(document, guard).root;
		if (!wordNamespaces.has(root.uri) || !['document', 'hdr', 'ftr', 'footnotes', 'endnotes', 'comments', 'glossaryDocument'].includes(root.local)) {
			throw new ParadisOfficePackageError('malformed');
		}

		const orderedFields = collectFields(root, document.source, guard, maximumFields, maximumFieldDepth);
		const sections: ParadisWordSectionObject[] = [];
		const revisions: ParadisWordRevisionObject[] = [];
		collectSectionsAndRevisions(root, [], false, document.source, relationships, guard, maximumSections, maximumRevisions, sections, revisions);
		return deepFreeze({
			fields: orderedFields.sort((left, right) => left.order - right.order).map(value => value.value),
			sections,
			revisions,
		});
	} catch (error) {
		throw sanitizeModelError(error);
	}
}

function collectFields(root: XmlElement, authority: ParadisWordPartAuthority, guard: ParadisWordModelGuard, maximumFields: number, maximumFieldDepth: number): OrderedField[] {
	const fields: OrderedField[] = [];
	const stack: ComplexFieldState[] = [];
	let order = 0;
	let count = 0;
	const reserveField = (): void => {
		if (++count > maximumFields) {
			throw new ParadisOfficePackageError('limitExceeded');
		}
		guard.definition();
	};
	const appendField = (value: ParadisWordFieldObject, fieldOrder: number): void => {
		fields.push({ order: fieldOrder, value });
	};
	const visit = (element: XmlElement, path: readonly number[]): void => {
		guard.checkpoint();
		const currentOrder = order++;
		if (isWordElement(element, 'fldSimple')) {
			reserveField();
			const source = objectSource(authority, path);
			const namespace = wordNamespace(element);
			const instruction = requiredAttribute(element, namespace, 'instr');
			const savedResult = savedText(element);
			for (const context of stack) {
				if (context.separated) {
					context.savedResult.push(savedResult);
				}
			}
			const semantic = {
				id: stableId('field', source), kind: 'field', fieldKind: 'simple', source, instruction, savedResult,
				...(optionalAttribute(element, namespace, 'dirty') !== undefined ? { dirty: optionalAttribute(element, namespace, 'dirty') } : {}),
				...(optionalAttribute(element, namespace, 'fldLock') !== undefined ? { locked: optionalAttribute(element, namespace, 'fldLock') } : {}),
				evaluation: 'savedResultOnly',
			} as const;
			appendField({ ...semantic, fingerprint: fingerprintText(JSON.stringify(semantic)) }, currentOrder);
			return;
		}

		if (isWordElement(element, 'fldChar')) {
			const namespace = wordNamespace(element);
			const type = requiredAttribute(element, namespace, 'fldCharType');
			if (type === 'begin') {
				reserveField();
				if (stack.length >= maximumFieldDepth) {
					throw new ParadisOfficePackageError('limitExceeded');
				}
				const context: ComplexFieldState = {
					source: objectSource(authority, path), order: currentOrder, instruction: [], savedResult: [], separated: false,
					...(optionalAttribute(element, namespace, 'dirty') !== undefined ? { dirty: optionalAttribute(element, namespace, 'dirty') } : {}),
					...(optionalAttribute(element, namespace, 'fldLock') !== undefined ? { locked: optionalAttribute(element, namespace, 'fldLock') } : {}),
				};
				stack.push(context);
			} else if (type === 'separate') {
				const context = stack[stack.length - 1];
				if (!context || context.separated) {
					throw new ParadisOfficePackageError('malformed');
				}
				context.separated = true;
			} else if (type === 'end') {
				const context = stack.pop();
				if (!context) {
					throw new ParadisOfficePackageError('malformed');
				}
				const instruction = context.instruction.join('');
				const savedResult = context.savedResult.join('');
				const semantic = {
					id: stableId('field', context.source), kind: 'field', fieldKind: 'complex', source: context.source, instruction, savedResult,
					...(context.dirty !== undefined ? { dirty: context.dirty } : {}), ...(context.locked !== undefined ? { locked: context.locked } : {}),
					evaluation: 'savedResultOnly',
				} as const;
				appendField({ ...semantic, fingerprint: fingerprintText(JSON.stringify(semantic)) }, context.order);
			} else {
				throw new ParadisOfficePackageError('malformed');
			}
		} else if (isWordElement(element, 'instrText')) {
			const context = stack[stack.length - 1];
			if (context && !context.separated) {
				context.instruction.push(elementText(element));
			}
		} else if (isWordElement(element, 't') || isWordElement(element, 'delText')) {
			for (const context of stack) {
				if (context.separated) {
					context.savedResult.push(elementText(element));
				}
			}
		}
		let ordinal = 0;
		for (const child of elementChildren(element)) {
			visit(child, [...path, ordinal++]);
		}
	};
	visit(root, []);
	if (stack.length > 0) {
		throw new ParadisOfficePackageError('malformed');
	}
	return fields;
}

function collectSectionsAndRevisions(
	element: XmlElement,
	path: readonly number[],
	insidePropertyRevision: boolean,
	authority: ParadisWordPartAuthority,
	relationships: ReadonlyMap<string, ParadisWordParsedRelationship>,
	guard: ParadisWordModelGuard,
	maximumSections: number,
	maximumRevisions: number,
	sections: ParadisWordSectionObject[],
	revisions: ParadisWordRevisionObject[],
): void {
	guard.checkpoint();
	const revision = revisionDescriptor(element);
	if (revision) {
		if (revisions.length >= maximumRevisions) {
			throw new ParadisOfficePackageError('limitExceeded');
		}
		guard.definition();
		revisions.push(parseRevision(element, path, authority, revision));
	}
	if (isWordElement(element, 'sectPr') && !insidePropertyRevision) {
		if (sections.length >= maximumSections) {
			throw new ParadisOfficePackageError('limitExceeded');
		}
		guard.definition();
		sections.push(parseSection(element, path, authority, relationships, sections.length));
	}
	const nextInsidePropertyRevision = insidePropertyRevision || revision?.revisionKind === 'propertyChange';
	let ordinal = 0;
	for (const child of elementChildren(element)) {
		collectSectionsAndRevisions(child, [...path, ordinal++], nextInsidePropertyRevision, authority, relationships, guard, maximumSections, maximumRevisions, sections, revisions);
	}
}

function parseSection(
	element: XmlElement,
	path: readonly number[],
	authority: ParadisWordPartAuthority,
	relationships: ReadonlyMap<string, ParadisWordParsedRelationship>,
	sectionOrdinal: number,
): ParadisWordSectionObject {
	const type = wordChild(element, 'type');
	const paper = wordChild(element, 'pgSz');
	const margins = wordChild(element, 'pgMar');
	const columns = wordChild(element, 'cols');
	const pageNumber = wordChild(element, 'pgNumType');
	const titlePage = wordChild(element, 'titlePg');
	const source = objectSource(authority, path);
	const storyReferences: ParadisWordSectionStoryReference[] = [];
	for (const child of elementChildren(element)) {
		if (!isWordElement(child, 'headerReference') && !isWordElement(child, 'footerReference')) {
			continue;
		}
		const kind = child.local === 'headerReference' ? 'header' : 'footer';
		const role = requiredAttribute(child, wordNamespace(child), 'type');
		if (role !== 'default' && role !== 'first' && role !== 'even') {
			throw new ParadisOfficePackageError('malformed');
		}
		const relationshipId = relationshipAttribute(child, 'id');
		const relationship = relationshipId ? relationships.get(relationshipId) : undefined;
		const accepted = kind === 'header' ? headerRelationshipTypes : footerRelationshipTypes;
		if (!relationship || relationship.targetMode !== 'internal' || !relationship.targetPartUri || !accepted.has(relationship.type)) {
			throw new ParadisOfficePackageError('unsafe');
		}
		storyReferences.push({ kind, role, targetPartUri: relationship.targetPartUri });
	}
	const value = compact({
		id: stableId('section', source), kind: 'section' as const, sectionOrdinal, source,
		breakType: type && optionalAttribute(type, wordNamespace(type), 'val'),
		paper: paper ? compact({
			width: optionalAttribute(paper, wordNamespace(paper), 'w'), height: optionalAttribute(paper, wordNamespace(paper), 'h'),
			orientation: optionalAttribute(paper, wordNamespace(paper), 'orient'), code: optionalAttribute(paper, wordNamespace(paper), 'code'),
		}) : undefined,
		margins: margins ? compact({
			top: optionalAttribute(margins, wordNamespace(margins), 'top'), right: optionalAttribute(margins, wordNamespace(margins), 'right'),
			bottom: optionalAttribute(margins, wordNamespace(margins), 'bottom'), left: optionalAttribute(margins, wordNamespace(margins), 'left'),
			header: optionalAttribute(margins, wordNamespace(margins), 'header'), footer: optionalAttribute(margins, wordNamespace(margins), 'footer'),
			gutter: optionalAttribute(margins, wordNamespace(margins), 'gutter'),
		}) : undefined,
		columns: columns ? compact({
			count: optionalAttribute(columns, wordNamespace(columns), 'num'), space: optionalAttribute(columns, wordNamespace(columns), 'space'),
			equalWidth: optionalAttribute(columns, wordNamespace(columns), 'equalWidth'), separator: optionalAttribute(columns, wordNamespace(columns), 'sep'),
			definitions: elementChildren(columns).filter(column => isWordElement(column, 'col')).map(column => compact({
				width: optionalAttribute(column, wordNamespace(column), 'w'), space: optionalAttribute(column, wordNamespace(column), 'space'),
			})),
		}) : undefined,
		pageNumber: pageNumber ? compact({
			start: optionalAttribute(pageNumber, wordNamespace(pageNumber), 'start'), format: optionalAttribute(pageNumber, wordNamespace(pageNumber), 'fmt'),
			chapterStyle: optionalAttribute(pageNumber, wordNamespace(pageNumber), 'chapStyle'), chapterSeparator: optionalAttribute(pageNumber, wordNamespace(pageNumber), 'chapSep'),
		}) : undefined,
		titlePage: titlePage ? toggle(titlePage) : false,
		storyReferences,
	});
	return { ...value, fingerprint: fingerprintText(JSON.stringify(value)) };
}

function parseRevision(
	element: XmlElement,
	path: readonly number[],
	authority: ParadisWordPartAuthority,
	descriptor: { readonly revisionKind: ParadisWordRevisionObject['revisionKind']; readonly propertyScope?: ParadisWordRevisionPropertyScope },
): ParadisWordRevisionObject {
	const source = objectSource(authority, path);
	const namespace = wordNamespace(element);
	return compact({
		id: stableId('revision', source), kind: 'revision' as const, revisionKind: descriptor.revisionKind, propertyScope: descriptor.propertyScope, source,
		revisionId: optionalAttribute(element, namespace, 'id'), author: optionalAttribute(element, namespace, 'author'), date: optionalAttribute(element, namespace, 'date'),
		text: descriptor.revisionKind === 'propertyChange' ? '' : savedText(element),
		fingerprint: fingerprintText(canonicalXml(element)),
	});
}

function revisionDescriptor(element: XmlElement): { readonly revisionKind: ParadisWordRevisionObject['revisionKind']; readonly propertyScope?: ParadisWordRevisionPropertyScope } | undefined {
	if (!wordNamespaces.has(element.uri)) {
		return undefined;
	}
	if (element.local === 'ins') {
		return { revisionKind: 'inserted' };
	}
	if (element.local === 'del') {
		return { revisionKind: 'deleted' };
	}
	if (element.local === 'moveFrom') {
		return { revisionKind: 'moveFrom' };
	}
	if (element.local === 'moveTo') {
		return { revisionKind: 'moveTo' };
	}
	const scopes: Readonly<Record<string, ParadisWordRevisionPropertyScope>> = {
		pPrChange: 'paragraph', rPrChange: 'run', tblPrChange: 'table', trPrChange: 'row', tcPrChange: 'cell', sectPrChange: 'section',
	};
	const propertyScope = scopes[element.local];
	return propertyScope ? { revisionKind: 'propertyChange', propertyScope } : undefined;
}

function savedText(element: XmlElement): string {
	const result: string[] = [];
	const visit = (candidate: XmlElement): void => {
		if (isWordElement(candidate, 't') || isWordElement(candidate, 'delText')) {
			result.push(elementText(candidate));
			return;
		}
		for (const child of elementChildren(candidate)) {
			visit(child);
		}
	};
	visit(element);
	return result.join('');
}

function toggle(element: XmlElement): boolean {
	const value = optionalAttribute(element, wordNamespace(element), 'val');
	if (value === undefined || value === '1' || value === 'true' || value === 'on') {
		return true;
	}
	if (value === '0' || value === 'false' || value === 'off') {
		return false;
	}
	throw new ParadisOfficePackageError('malformed');
}

function canonicalXml(element: XmlElement): string {
	const attributes = [...element.attributes]
		.map(attribute => `{${attribute.uri}}${attribute.local}=${JSON.stringify(attribute.value)}`)
		.sort()
		.join(',');
	const textIsSemantic = wordNamespaces.has(element.uri) && ['t', 'delText', 'instrText'].includes(element.local);
	const children = element.children.map(child => child.kind === 'element'
		? canonicalXml(child)
		: !textIsSemantic && /^\s*$/.test(child.value) ? '' : `#${JSON.stringify(child.value)}`).join('');
	return `<{${element.uri}}${element.local} ${attributes}>${children}</{${element.uri}}${element.local}>`;
}

function relationshipPartUri(ownerPartUri: string): string {
	const separator = ownerPartUri.lastIndexOf('/');
	return `${ownerPartUri.slice(0, separator)}/_rels/${ownerPartUri.slice(separator + 1)}.rels`;
}

function isWordStoryPart(partUri: string): boolean {
	return partUri === '/word/document.xml' || /^\/word\/(?:header|footer)\d+\.xml$/.test(partUri)
		|| ['/word/footnotes.xml', '/word/endnotes.xml', '/word/comments.xml', '/word/glossary/document.xml'].includes(partUri);
}

function objectSource(authority: ParadisWordPartAuthority, path: readonly number[]): ParadisWordObjectSource {
	return { ...authority, semanticPath: Object.freeze([...path]) };
}

function stableId(kind: string, source: ParadisWordObjectSource): string {
	return `wordObject:${encodeURIComponent(source.partUri)}:${source.semanticPath.join('.')}:${kind}`;
}

function fingerprintText(value: string): ParadisOfficeFingerprint {
	return fingerprintParadisWordObjectBytes(new TextEncoder().encode(value));
}

function isWordElement(element: XmlElement, local: string): boolean {
	return wordNamespaces.has(element.uri) && element.local === local;
}

function wordNamespace(element: XmlElement): string {
	if (!wordNamespaces.has(element.uri)) {
		throw new ParadisOfficePackageError('malformed');
	}
	return element.uri;
}

function wordChild(element: XmlElement, local: string): XmlElement | undefined {
	return elementChildren(element).find(candidate => isWordElement(candidate, local));
}

function elementChildren(element: XmlElement): XmlElement[] {
	return element.children.filter((child): child is XmlElement => child.kind === 'element');
}

function elementText(element: XmlElement): string {
	return element.children.map(child => child.kind === 'text' ? child.value : elementText(child)).join('');
}

function relationshipAttribute(element: XmlElement, local: string): string | undefined {
	return element.attributes.find(attribute => relationshipNamespaces.has(attribute.uri) && attribute.local === local)?.value;
}

function requiredAttribute(element: XmlElement, uri: string, local: string): string {
	const value = optionalAttribute(element, uri, local);
	if (value === undefined) {
		throw new ParadisOfficePackageError('malformed');
	}
	return value;
}

function optionalAttribute(element: XmlElement, uri: string, local: string): string | undefined {
	return element.attributes.find(attribute => attribute.uri === uri && attribute.local === local)?.value;
}

function compact<T extends Record<string, unknown>>(value: T): T {
	const result: Record<string, unknown> = {};
	for (const [key, item] of Object.entries(value)) {
		if (item !== undefined) {
			result[key] = item;
		}
	}
	return result as T;
}

function boundedMaximum(value: number | undefined, hardMaximum: number): number {
	if (value === undefined) {
		return hardMaximum;
	}
	if (!Number.isSafeInteger(value) || value < 0) {
		throw new ParadisOfficePackageError('limitExceeded');
	}
	return Math.min(value, hardMaximum);
}

function deepFreeze<T>(value: T): T {
	const seen = new WeakSet<object>();
	const stack: object[] = [];
	if (value && typeof value === 'object') {
		stack.push(value);
	}
	while (stack.length > 0) {
		const current = stack.pop()!;
		if (seen.has(current)) {
			continue;
		}
		seen.add(current);
		for (const key of Reflect.ownKeys(current)) {
			const candidate = Object.getOwnPropertyDescriptor(current, key)?.value;
			if (candidate && typeof candidate === 'object') {
				stack.push(candidate);
			}
		}
		Object.freeze(current);
	}
	return value;
}
