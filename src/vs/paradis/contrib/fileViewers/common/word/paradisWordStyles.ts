/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import type { CancellationToken } from '../../../../../base/common/cancellation.js';
import type { ParadisOfficeFingerprint } from '../paradisOfficeProtocol.js';
import { ParadisOfficePackageError, throwIfParadisOfficeCancelled, type ParadisOfficeXmlDocument, type ParadisOfficeXmlNode } from '../office/paradisOfficeArchive.js';

const wordNamespaces = new Set([
	'http://schemas.openxmlformats.org/wordprocessingml/2006/main',
	'http://purl.oclc.org/ooxml/wordprocessingml/main',
]);
const drawingNamespaces = new Set([
	'http://schemas.openxmlformats.org/drawingml/2006/main',
	'http://purl.oclc.org/ooxml/drawingml/main',
]);
const relationshipNamespaces = new Set([
	'http://schemas.openxmlformats.org/officeDocument/2006/relationships',
	'http://purl.oclc.org/ooxml/officeDocument/relationships',
]);

type XmlElement = Extract<ParadisOfficeXmlNode, { readonly kind: 'element' }>;
export type ParadisWordStyleType = 'paragraph' | 'character' | 'table' | 'numbering';
export type ParadisWordPropertyScope = 'paragraph' | 'run' | 'table' | 'numbering';

/** Verified all-byte identity carried by a parsed Word package Part. */
export interface ParadisWordPartAuthority {
	readonly partUri: string;
	readonly partFingerprint: ParadisOfficeFingerprint;
}

/** Common synchronous semantic-model controls. */
export interface ParadisWordModelOptions {
	readonly token?: CancellationToken;
	readonly deadlineMilliseconds?: number;
	readonly now?: () => number;
	readonly maximumDefinitions?: number;
	readonly maximumProperties?: number;
}

export interface ParadisWordPropertyProvenance extends ParadisWordPartAuthority {
	readonly origin: 'docDefault' | 'style' | 'direct';
	readonly definitionId?: string;
	readonly semanticPath: readonly number[];
}

/** One direct or inherited OOXML property. Lexical attributes remain authoritative. */
export interface ParadisWordEffectiveProperty {
	readonly attributes: Readonly<Record<string, string>>;
	readonly resolvedAttributes: Readonly<Record<string, string>>;
	readonly explicit: boolean;
	/** Last contributor to this property; mixed compound values use attributeProvenance below. */
	readonly provenance: ParadisWordPropertyProvenance;
	readonly attributeProvenance?: Readonly<Record<string, { readonly explicit: boolean; readonly provenance: ParadisWordPropertyProvenance }>>;
}

export type ParadisWordEffectivePropertySet = Readonly<Record<string, ParadisWordEffectiveProperty>>;

export interface ParadisWordStyleDefinition {
	readonly type: ParadisWordStyleType;
	readonly styleId: string;
	readonly name?: string;
	readonly basedOn?: string;
	readonly link?: string;
	readonly next?: string;
	readonly isDefault: boolean;
	readonly paragraph: ParadisWordEffectivePropertySet;
	readonly run: ParadisWordEffectivePropertySet;
	readonly table: ParadisWordEffectivePropertySet;
	readonly numbering: ParadisWordEffectivePropertySet;
	readonly definitionFingerprint: string;
}

export interface ParadisWordEmbeddedFontReference {
	readonly relationshipId?: string;
	readonly fontKey?: string;
	readonly subsetted?: string;
}

export interface ParadisWordFontMetadata {
	readonly name: string;
	readonly family?: string;
	readonly charset?: string;
	readonly embedded: Readonly<Partial<Record<'regular' | 'bold' | 'italic' | 'boldItalic', ParadisWordEmbeddedFontReference>>>;
	readonly source: ParadisWordPartAuthority & { readonly semanticPath: readonly number[] };
}

export interface ParadisWordStyleModel {
	readonly styles: ReadonlyMap<string, ParadisWordStyleDefinition>;
	readonly defaultStyles: ReadonlyMap<ParadisWordStyleType, string>;
	readonly documentDefaults: Readonly<Record<ParadisWordPropertyScope, ParadisWordEffectivePropertySet>>;
	readonly themeColors: ReadonlyMap<string, string>;
	readonly themeFonts: ReadonlyMap<string, string>;
	readonly fonts: ReadonlyMap<string, ParadisWordFontMetadata>;
}

export interface ParadisWordStylePart {
	readonly document: ParadisOfficeXmlDocument;
	readonly authority: ParadisWordPartAuthority;
}

export interface ParadisWordStyleParseInput {
	readonly styles: ParadisWordStylePart;
	readonly theme?: ParadisWordStylePart;
	readonly fontTable?: ParadisWordStylePart;
}

export interface ParadisWordDirectPropertyInput {
	readonly authority: ParadisWordPartAuthority;
	readonly semanticPath: readonly number[];
	readonly paragraph?: XmlElement;
	readonly run?: XmlElement;
	readonly table?: XmlElement;
	readonly numbering?: XmlElement;
}

export interface ParadisWordEffectiveStyleRequest {
	readonly nodeId: string;
	readonly nodeKind?: ParadisWordStyleType;
	readonly paragraphStyleId?: string;
	readonly characterStyleId?: string;
	readonly tableStyleId?: string;
	readonly numberingStyleId?: string;
	readonly direct?: ParadisWordDirectPropertyInput;
}

export interface ParadisWordEffectiveStyle {
	readonly paragraph: ParadisWordEffectivePropertySet;
	readonly run: ParadisWordEffectivePropertySet;
	readonly table: ParadisWordEffectivePropertySet;
	readonly numbering: ParadisWordEffectivePropertySet;
	readonly appliedStyles: readonly ParadisWordStyleDefinition[];
}

export interface ParadisWordStyleReference {
	readonly styleId: string;
	readonly nodeIds: readonly string[];
}

export interface ParadisWordStyleDefinitionChange {
	readonly kind: 'styleDefinition';
	readonly styleId: string;
	readonly styleType: ParadisWordStyleType;
	readonly beforeFingerprint?: string;
	readonly afterFingerprint?: string;
	readonly affectedNodeIds: readonly string[];
}

/** Minimal guard shared by the style, table, and numbering semantic parsers. */
export class ParadisWordModelGuard {
	private readonly started: number;
	private readonly deadlineMilliseconds: number;
	private readonly now: () => number;
	private definitions = 0;
	private properties = 0;
	readonly maximumDefinitions: number;
	readonly maximumProperties: number;

	constructor(private readonly options: ParadisWordModelOptions = {}) {
		this.deadlineMilliseconds = options.deadlineMilliseconds ?? 60_000;
		this.maximumDefinitions = options.maximumDefinitions ?? 100_000;
		this.maximumProperties = options.maximumProperties ?? 1_000_000;
		if (!Number.isSafeInteger(this.deadlineMilliseconds) || this.deadlineMilliseconds < 0
			|| !Number.isSafeInteger(this.maximumDefinitions) || this.maximumDefinitions < 0
			|| !Number.isSafeInteger(this.maximumProperties) || this.maximumProperties < 0) {
			throw new ParadisOfficePackageError('limitExceeded');
		}
		this.now = options.now ?? Date.now;
		this.started = this.readTime();
		this.checkpoint();
	}

	checkpoint(): void {
		throwIfParadisOfficeCancelled(this.options.token);
		const current = this.readTime();
		if (current < this.started || current - this.started > this.deadlineMilliseconds) {
			throw new ParadisOfficePackageError('limitExceeded');
		}
	}

	definition(): void {
		this.checkpoint();
		if (++this.definitions > this.maximumDefinitions) {
			throw new ParadisOfficePackageError('limitExceeded');
		}
	}

	property(): void {
		this.checkpoint();
		if (++this.properties > this.maximumProperties) {
			throw new ParadisOfficePackageError('limitExceeded');
		}
	}

	private readTime(): number {
		let value: number;
		try {
			value = this.now();
		} catch {
			throw new ParadisOfficePackageError('invalid');
		}
		if (!Number.isFinite(value) || value < 0) {
			throw new ParadisOfficePackageError('invalid');
		}
		return value;
	}
}

/** Parses style, theme, and font metadata without fetching or decoding embedded fonts. */
export function parseParadisWordStyles(input: ParadisWordStyleParseInput, options: ParadisWordModelOptions = {}): ParadisWordStyleModel {
	try {
		const guard = new ParadisWordModelGuard(options);
		validateAuthority(input.styles.authority, uri => uri === '/word/styles.xml');
		const root = wordRoot(input.styles.document, 'styles');
		const defaults = emptyPropertyScopes();
		const styles = new Map<string, ParadisWordStyleDefinition>();
		const rootPath = [0];
		for (const [index, element] of elementChildren(root).entries()) {
			guard.checkpoint();
			const path = [...rootPath, index];
			if (isWordElement(element, 'docDefaults')) {
				parseDocumentDefaults(defaults, element, path, input.styles.authority, guard);
			} else if (isWordElement(element, 'style')) {
				guard.definition();
				const definition = parseStyleDefinition(element, path, input.styles.authority, guard);
				if (styles.has(definition.styleId)) {
					throw new ParadisOfficePackageError('malformed');
				}
				styles.set(definition.styleId, definition);
			}
		}
		validateStyleCycles(styles, guard);
		const defaultStyles = new Map<ParadisWordStyleType, string>();
		for (const definition of styles.values()) {
			if (!definition.isDefault) {
				continue;
			}
			if (defaultStyles.has(definition.type)) {
				throw new ParadisOfficePackageError('malformed');
			}
			defaultStyles.set(definition.type, definition.styleId);
		}
		const theme = input.theme ? parseTheme(input.theme, guard) : { colors: new Map<string, string>(), fonts: new Map<string, string>() };
		const fonts = input.fontTable ? parseFontTable(input.fontTable, guard) : new Map<string, ParadisWordFontMetadata>();
		return {
			styles,
			defaultStyles,
			documentDefaults: freezeScopes(defaults),
			themeColors: theme.colors,
			themeFonts: theme.fonts,
			fonts,
		};
	} catch (error) {
		throw sanitizeModelError(error);
	}
}

/** Resolves the direct and inherited properties used by one semantic node. */
export function resolveParadisWordEffectiveProperties(model: ParadisWordStyleModel, request: ParadisWordEffectiveStyleRequest): ParadisWordEffectiveStyle {
	try {
		if (!request.nodeId) {
			throw new ParadisOfficePackageError('malformed');
		}
		const scopes = mutableScopes(model.documentDefaults);
		const appliedStyles: ParadisWordStyleDefinition[] = [];
		const nodeKind = request.nodeKind ?? 'paragraph';
		for (const [type, styleId] of [
			['table', request.tableStyleId],
			['numbering', request.numberingStyleId],
			['paragraph', request.paragraphStyleId],
			['character', request.characterStyleId],
		] as const) {
			const effectiveStyleId = styleId ?? (nodeKind === type ? model.defaultStyles.get(type) : undefined);
			if (!effectiveStyleId) {
				continue;
			}
			const definition = model.styles.get(effectiveStyleId);
			if (!definition || definition.type !== type) {
				throw new ParadisOfficePackageError('malformed');
			}
			for (const inherited of styleChain(model.styles, definition)) {
				mergeScopes(scopes, inherited);
			}
			appliedStyles.push(definition);
		}
		if (request.direct) {
			validateAuthority(request.direct.authority, uri => uri.startsWith('/word/') && uri.endsWith('.xml'));
			for (const [scope, element, slot] of [
				['paragraph', request.direct.paragraph, 0],
				['run', request.direct.run, 1],
				['table', request.direct.table, 2],
				['numbering', request.direct.numbering, 3],
			] as const) {
				if (!element) {
					continue;
				}
				const direct = collectPropertySet(element, [...request.direct.semanticPath, slot], scope, {
					origin: 'direct', definitionId: request.nodeId, ...request.direct.authority,
				}, undefined, true);
				mergePropertySet(scopes[scope], direct);
			}
		}
		resolveThemeProperties(scopes, model.themeColors, model.themeFonts);
		return { ...freezeScopes(scopes), appliedStyles: Object.freeze(appliedStyles) };
	} catch (error) {
		throw sanitizeModelError(error);
	}
}

/** Returns one package-level record per changed style definition. */
export function diffParadisWordStyleDefinitions(
	before: ParadisWordStyleModel,
	after: ParadisWordStyleModel,
	references: readonly ParadisWordStyleReference[],
): readonly ParadisWordStyleDefinitionChange[] {
	try {
		const referencesByStyle = new Map<string, Set<string>>();
		for (const reference of references) {
			const affectedStyleIds = new Set<string>([reference.styleId]);
			for (const model of [before, after]) {
				const definition = model.styles.get(reference.styleId);
				if (definition) {
					for (const inherited of styleChain(model.styles, definition)) {
						affectedStyleIds.add(inherited.styleId);
					}
				}
			}
			for (const affectedStyleId of affectedStyleIds) {
				const nodes = referencesByStyle.get(affectedStyleId) ?? new Set<string>();
				for (const nodeId of reference.nodeIds) {
					if (nodeId) {
						nodes.add(nodeId);
					}
				}
				referencesByStyle.set(affectedStyleId, nodes);
			}
		}
		const ids = [...new Set([...before.styles.keys(), ...after.styles.keys()])].sort();
		const changes: ParadisWordStyleDefinitionChange[] = [];
		for (const styleId of ids) {
			const oldDefinition = before.styles.get(styleId);
			const newDefinition = after.styles.get(styleId);
			if (oldDefinition?.definitionFingerprint === newDefinition?.definitionFingerprint) {
				continue;
			}
			const styleType = newDefinition?.type ?? oldDefinition?.type;
			if (!styleType) {
				continue;
			}
			changes.push({
				kind: 'styleDefinition', styleId, styleType,
				...(oldDefinition ? { beforeFingerprint: oldDefinition.definitionFingerprint } : {}),
				...(newDefinition ? { afterFingerprint: newDefinition.definitionFingerprint } : {}),
				affectedNodeIds: Object.freeze([...(referencesByStyle.get(styleId) ?? [])].sort()),
			});
		}
		return Object.freeze(changes);
	} catch (error) {
		throw sanitizeModelError(error);
	}
}

export function validateAuthority(authority: ParadisWordPartAuthority, acceptsUri: (uri: string) => boolean): void {
	if (!authority || typeof authority !== 'object' || typeof authority.partUri !== 'string' || !acceptsUri(authority.partUri)) {
		throw new ParadisOfficePackageError('unsafe');
	}
	const fingerprint = authority.partFingerprint;
	if (!fingerprint || fingerprint.algorithm !== 'sha256' || !/^[0-9a-f]{64}$/i.test(fingerprint.value)
		|| !Number.isSafeInteger(fingerprint.byteLength) || fingerprint.byteLength < 0) {
		throw new ParadisOfficePackageError('unsafe');
	}
}

export function sanitizeModelError(error: unknown): ParadisOfficePackageError {
	let code: ParadisOfficePackageError['code'] = 'malformed';
	if (error instanceof ParadisOfficePackageError) {
		code = error.code;
	}
	return new ParadisOfficePackageError(code);
}

export function semanticDefinitionFingerprint(value: string): string {
	let hash = 0x811c9dc5;
	for (let index = 0; index < value.length; index++) {
		hash ^= value.charCodeAt(index);
		hash = Math.imul(hash, 0x01000193) >>> 0;
	}
	return `fnv1a32:${hash.toString(16).padStart(8, '0')}`;
}

export function canonicalElementValue(element: XmlElement): string {
	const attributes = [...element.attributes]
		.map(attribute => `{${attribute.uri}}${attribute.local}=${JSON.stringify(attribute.value)}`)
		.sort()
		.join(',');
	const children = element.children
		.filter((child): child is XmlElement => child.kind === 'element')
		.map(canonicalElementValue)
		.join('');
	return `<{${element.uri}}${element.local} ${attributes}>${children}</{${element.uri}}${element.local}>`;
}

function parseDocumentDefaults(
	scopes: MutablePropertyScopes,
	element: XmlElement,
	path: readonly number[],
	authority: ParadisWordPartAuthority,
	guard: ParadisWordModelGuard,
): void {
	for (const [index, child] of elementChildren(element).entries()) {
		const wrapperPath = [...path, index];
		if (isWordElement(child, 'rPrDefault')) {
			const run = uniqueWordChildWithIndex(child, 'rPr');
			if (run) {
				mergePropertySet(scopes.run, collectPropertySet(run.element, [...wrapperPath, run.index], 'run', { origin: 'docDefault', ...authority }, guard));
			}
		} else if (isWordElement(child, 'pPrDefault')) {
			const paragraph = uniqueWordChildWithIndex(child, 'pPr');
			if (paragraph) {
				mergePropertySet(scopes.paragraph, collectPropertySet(paragraph.element, [...wrapperPath, paragraph.index], 'paragraph', { origin: 'docDefault', ...authority }, guard));
			}
		}
	}
}

function parseStyleDefinition(
	element: XmlElement,
	path: readonly number[],
	authority: ParadisWordPartAuthority,
	guard: ParadisWordModelGuard,
): ParadisWordStyleDefinition {
	const namespace = wordNamespace(element);
	const type = requiredAttribute(element, namespace, 'type');
	if (type !== 'paragraph' && type !== 'character' && type !== 'table' && type !== 'numbering') {
		throw new ParadisOfficePackageError('malformed');
	}
	const styleId = requiredAttribute(element, namespace, 'styleId');
	const scopes = emptyPropertyScopes();
	let name: string | undefined;
	let basedOn: string | undefined;
	let link: string | undefined;
	let next: string | undefined;
	for (const [index, child] of elementChildren(element).entries()) {
		const childPath = [...path, index];
		if (isWordElement(child, 'name')) {
			name = optionalAttribute(child, wordNamespace(child), 'val');
		} else if (isWordElement(child, 'basedOn')) {
			basedOn = optionalAttribute(child, wordNamespace(child), 'val');
		} else if (isWordElement(child, 'link')) {
			link = optionalAttribute(child, wordNamespace(child), 'val');
		} else if (isWordElement(child, 'next')) {
			next = optionalAttribute(child, wordNamespace(child), 'val');
		} else if (isWordElement(child, 'pPr')) {
			mergePropertySet(scopes.paragraph, collectPropertySet(child, childPath, 'paragraph', { origin: 'style', definitionId: styleId, ...authority }, guard));
		} else if (isWordElement(child, 'rPr')) {
			mergePropertySet(scopes.run, collectPropertySet(child, childPath, 'run', { origin: 'style', definitionId: styleId, ...authority }, guard));
		} else if (isWordElement(child, 'tblPr')) {
			mergePropertySet(scopes.table, collectPropertySet(child, childPath, 'table', { origin: 'style', definitionId: styleId, ...authority }, guard));
		}
	}
	return {
		type, styleId, ...(name ? { name } : {}), ...(basedOn ? { basedOn } : {}), ...(link ? { link } : {}), ...(next ? { next } : {}),
		isDefault: optionalAttribute(element, namespace, 'default') !== undefined && toggleValue(optionalAttribute(element, namespace, 'default')),
		...freezeScopes(scopes),
		definitionFingerprint: semanticDefinitionFingerprint(canonicalElementValue(element)),
	};
}

function collectPropertySet(
	container: XmlElement,
	containerPath: readonly number[],
	scope: ParadisWordPropertyScope,
	provenance: Omit<ParadisWordPropertyProvenance, 'semanticPath'>,
	guard?: ParadisWordModelGuard,
	explicit = false,
): Record<string, ParadisWordEffectiveProperty> {
	const result: Record<string, ParadisWordEffectiveProperty> = {};
	const visit = (parent: XmlElement, path: readonly number[], prefix: string): void => {
		for (const [index, child] of elementChildren(parent).entries()) {
			guard?.property();
			if (!isWordElement(child)) {
				continue;
			}
			const childPath = [...path, index];
			const key = prefix ? `${prefix}.${child.local}` : child.local;
			if (isPropertyContainer(scope, child.local) && elementChildren(child).length > 0) {
				visit(child, childPath, key);
				continue;
			}
			const property: ParadisWordEffectiveProperty = {
				attributes: attributeRecord(child),
				resolvedAttributes: {},
				explicit,
				provenance: { ...provenance, semanticPath: Object.freeze(childPath) },
			};
			result[key] = property;
		}
	};
	visit(container, containerPath, '');
	return result;
}

function isPropertyContainer(scope: ParadisWordPropertyScope, local: string): boolean {
	return local === 'numPr' || local === 'tblBorders' || local === 'tcBorders'
		|| (scope === 'table' && (local === 'tblStylePr' || local === 'tblCellMar'));
}

function mergeScopes(target: MutablePropertyScopes, source: Pick<ParadisWordStyleDefinition, ParadisWordPropertyScope>): void {
	mergePropertySet(target.paragraph, source.paragraph);
	mergePropertySet(target.run, source.run);
	mergePropertySet(target.table, source.table);
	mergePropertySet(target.numbering, source.numbering);
}

function mergePropertySet(target: Record<string, ParadisWordEffectiveProperty>, source: ParadisWordEffectivePropertySet): void {
	for (const [key, property] of Object.entries(source)) {
		const existing = target[key];
		if (!existing) {
			target[key] = property;
			continue;
		}
		const attributeProvenance: Record<string, { readonly explicit: boolean; readonly provenance: ParadisWordPropertyProvenance }> = {};
		for (const attribute of Object.keys(existing.attributes)) {
			attributeProvenance[attribute] = existing.attributeProvenance?.[attribute] ?? { explicit: existing.explicit, provenance: existing.provenance };
		}
		for (const attribute of Object.keys(property.attributes)) {
			attributeProvenance[attribute] = property.attributeProvenance?.[attribute] ?? { explicit: property.explicit, provenance: property.provenance };
		}
		const distinctOrigins = new Set(Object.values(attributeProvenance).map(value => propertyOriginKey(value)));
		target[key] = {
			attributes: { ...existing.attributes, ...property.attributes },
			resolvedAttributes: { ...existing.resolvedAttributes, ...property.resolvedAttributes },
			explicit: property.explicit,
			provenance: property.provenance,
			...(distinctOrigins.size > 1 ? { attributeProvenance } : {}),
		};
	}
}

function propertyOriginKey(value: { readonly explicit: boolean; readonly provenance: ParadisWordPropertyProvenance }): string {
	const source = value.provenance;
	return `${value.explicit}|${source.origin}|${source.definitionId ?? ''}|${source.partUri}|${source.partFingerprint.value}|${source.semanticPath.join('.')}`;
}

function styleChain(styles: ReadonlyMap<string, ParadisWordStyleDefinition>, definition: ParadisWordStyleDefinition): readonly ParadisWordStyleDefinition[] {
	const result: ParadisWordStyleDefinition[] = [];
	let current: ParadisWordStyleDefinition | undefined = definition;
	while (current) {
		result.unshift(current);
		current = current.basedOn ? styles.get(current.basedOn) : undefined;
	}
	return result;
}

function validateStyleCycles(styles: ReadonlyMap<string, ParadisWordStyleDefinition>, guard: ParadisWordModelGuard): void {
	for (const definition of styles.values()) {
		const visited = new Set<string>();
		let current: ParadisWordStyleDefinition | undefined = definition;
		while (current) {
			guard.checkpoint();
			if (visited.has(current.styleId)) {
				throw new ParadisOfficePackageError('malformed');
			}
			visited.add(current.styleId);
			current = current.basedOn ? styles.get(current.basedOn) : undefined;
		}
	}
}

function parseTheme(part: ParadisWordStylePart, guard: ParadisWordModelGuard): { readonly colors: Map<string, string>; readonly fonts: Map<string, string> } {
	validateAuthority(part.authority, uri => /^\/word\/theme\/[^/]+\.xml$/.test(uri));
	if (!drawingNamespaces.has(part.document.root.uri) || part.document.root.local !== 'theme') {
		throw new ParadisOfficePackageError('malformed');
	}
	const colors = new Map<string, string>();
	const fonts = new Map<string, string>();
	const scheme = findDescendant(part.document.root, drawingNamespaces, 'clrScheme');
	if (scheme) {
		for (const item of elementChildren(scheme)) {
			guard.definition();
			const value = elementChildren(item).find(child => drawingNamespaces.has(child.uri));
			const raw = value && (optionalAttribute(value, '', 'val') ?? optionalAttribute(value, '', 'lastClr'));
			const fallback = value && optionalAttribute(value, '', 'lastClr');
			const color = fallback ?? raw;
			if (color && /^[0-9a-f]{6}$/i.test(color)) {
				colors.set(item.local, `#${color.toUpperCase()}`);
			}
		}
	}
	const fontScheme = findDescendant(part.document.root, drawingNamespaces, 'fontScheme');
	if (fontScheme) {
		for (const [familyLocal, prefix] of [['majorFont', 'major'], ['minorFont', 'minor']] as const) {
			const family = elementChildren(fontScheme).find(child => drawingNamespaces.has(child.uri) && child.local === familyLocal);
			if (!family) {
				continue;
			}
			for (const [local, suffixes] of [
				['latin', ['HAnsi', 'Ascii']], ['ea', ['EastAsia']], ['cs', ['Bidi']],
			] as const) {
				const font = elementChildren(family).find(child => drawingNamespaces.has(child.uri) && child.local === local);
				const typeface = font && optionalAttribute(font, '', 'typeface');
				if (typeface) {
					for (const suffix of suffixes) {
						fonts.set(`${prefix}${suffix}`, typeface);
					}
				}
			}
		}
	}
	return { colors, fonts };
}

function parseFontTable(part: ParadisWordStylePart, guard: ParadisWordModelGuard): Map<string, ParadisWordFontMetadata> {
	validateAuthority(part.authority, uri => uri === '/word/fontTable.xml');
	const root = wordRoot(part.document, 'fonts');
	const result = new Map<string, ParadisWordFontMetadata>();
	for (const [index, font] of elementChildren(root).entries()) {
		if (!isWordElement(font, 'font')) {
			continue;
		}
		guard.definition();
		const name = requiredAttribute(font, wordNamespace(font), 'name');
		if (result.has(name)) {
			throw new ParadisOfficePackageError('malformed');
		}
		const family = uniqueWordChildWithIndex(font, 'family')?.element;
		const charset = uniqueWordChildWithIndex(font, 'charset')?.element;
		const embedded: Partial<Record<'regular' | 'bold' | 'italic' | 'boldItalic', ParadisWordEmbeddedFontReference>> = {};
		for (const [local, kind] of [
			['embedRegular', 'regular'], ['embedBold', 'bold'], ['embedItalic', 'italic'], ['embedBoldItalic', 'boldItalic'],
		] as const) {
			const embed = uniqueWordChildWithIndex(font, local)?.element;
			if (embed) {
				embedded[kind] = {
					...(optionalRelationshipAttribute(embed, 'id') ? { relationshipId: optionalRelationshipAttribute(embed, 'id') } : {}),
					...(optionalAttribute(embed, wordNamespace(embed), 'fontKey') ? { fontKey: optionalAttribute(embed, wordNamespace(embed), 'fontKey') } : {}),
					...(optionalAttribute(embed, wordNamespace(embed), 'subsetted') ? { subsetted: optionalAttribute(embed, wordNamespace(embed), 'subsetted') } : {}),
				};
			}
		}
		result.set(name, {
			name,
			...(family ? { family: optionalAttribute(family, wordNamespace(family), 'val') } : {}),
			...(charset ? { charset: optionalAttribute(charset, wordNamespace(charset), 'val') } : {}),
			embedded,
			source: { ...part.authority, semanticPath: Object.freeze([0, index]) },
		});
	}
	return result;
}

function resolveThemeProperties(scopes: MutablePropertyScopes, colors: ReadonlyMap<string, string>, fonts: ReadonlyMap<string, string>): void {
	for (const scope of Object.values(scopes)) {
		for (const [key, property] of Object.entries(scope)) {
			if (key.endsWith('color') && property.attributes.themeColor) {
				const color = colors.get(property.attributes.themeColor);
				if (color) {
					scope[key] = { ...property, resolvedAttributes: { ...property.resolvedAttributes, color } };
				}
			} else if (key.endsWith('rFonts')) {
				const attributes = property.attributes;
				const resolved: Record<string, string> = {};
				for (const [script, direct, themed] of [
					['ascii', 'ascii', 'asciiTheme'], ['hAnsi', 'hAnsi', 'hAnsiTheme'], ['eastAsia', 'eastAsia', 'eastAsiaTheme'], ['cs', 'cs', 'cstheme'],
				] as const) {
					const value = attributes[direct] ?? (attributes[themed] ? fonts.get(attributes[themed]) : undefined);
					if (value) {
						resolved[script] = value;
					}
				}
				scope[key] = { ...property, resolvedAttributes: resolved };
			}
		}
	}
}

type MutablePropertyScopes = Record<ParadisWordPropertyScope, Record<string, ParadisWordEffectiveProperty>>;

function emptyPropertyScopes(): MutablePropertyScopes {
	return { paragraph: {}, run: {}, table: {}, numbering: {} };
}

function mutableScopes(source: Readonly<Record<ParadisWordPropertyScope, ParadisWordEffectivePropertySet>>): MutablePropertyScopes {
	return { paragraph: { ...source.paragraph }, run: { ...source.run }, table: { ...source.table }, numbering: { ...source.numbering } };
}

function freezeScopes(scopes: MutablePropertyScopes): Readonly<Record<ParadisWordPropertyScope, ParadisWordEffectivePropertySet>> {
	return {
		paragraph: Object.freeze({ ...scopes.paragraph }),
		run: Object.freeze({ ...scopes.run }),
		table: Object.freeze({ ...scopes.table }),
		numbering: Object.freeze({ ...scopes.numbering }),
	};
}

function wordRoot(document: ParadisOfficeXmlDocument, local: string): XmlElement {
	if (!document || !document.root || !isWordElement(document.root, local)) {
		throw new ParadisOfficePackageError('malformed');
	}
	return document.root;
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

function elementChildren(element: XmlElement): readonly XmlElement[] {
	return element.children.filter((child): child is XmlElement => child.kind === 'element');
}

function uniqueWordChildWithIndex(element: XmlElement, local: string): { readonly element: XmlElement; readonly index: number } | undefined {
	const matches = elementChildren(element).map((child, index) => ({ element: child, index })).filter(candidate => isWordElement(candidate.element, local));
	if (matches.length > 1) {
		throw new ParadisOfficePackageError('malformed');
	}
	return matches[0];
}

function findDescendant(element: XmlElement, namespaces: ReadonlySet<string>, local: string): XmlElement | undefined {
	for (const child of elementChildren(element)) {
		if (namespaces.has(child.uri) && child.local === local) {
			return child;
		}
		const nested = findDescendant(child, namespaces, local);
		if (nested) {
			return nested;
		}
	}
	return undefined;
}

function attributeRecord(element: XmlElement): Readonly<Record<string, string>> {
	const result: Record<string, string> = {};
	for (const attribute of element.attributes) {
		if (!wordNamespaces.has(attribute.uri) && attribute.uri !== '') {
			continue;
		}
		if (Object.hasOwn(result, attribute.local)) {
			throw new ParadisOfficePackageError('malformed');
		}
		result[attribute.local] = attribute.value;
	}
	return result;
}

function requiredAttribute(element: XmlElement, uri: string, local: string): string {
	const value = optionalAttribute(element, uri, local);
	if (!value) {
		throw new ParadisOfficePackageError('malformed');
	}
	return value;
}

function optionalRelationshipAttribute(element: XmlElement, local: string): string | undefined {
	const matches = element.attributes.filter(attribute => relationshipNamespaces.has(attribute.uri) && attribute.local === local);
	if (matches.length > 1) {
		throw new ParadisOfficePackageError('malformed');
	}
	return matches[0]?.value;
}

function optionalAttribute(element: XmlElement, uri: string, local: string): string | undefined {
	const matches = element.attributes.filter(attribute => attribute.uri === uri && attribute.local === local);
	if (matches.length > 1) {
		throw new ParadisOfficePackageError('malformed');
	}
	return matches[0]?.value;
}

function toggleValue(value: string | undefined): boolean {
	return value === undefined || value === '1' || value === 'true' || value === 'on';
}
