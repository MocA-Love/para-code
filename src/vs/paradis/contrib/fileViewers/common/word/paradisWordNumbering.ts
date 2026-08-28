/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import { ParadisOfficePackageError, type ParadisOfficeXmlDocument, type ParadisOfficeXmlNode } from '../office/paradisOfficeArchive.js';
import {
	canonicalElementValue,
	ParadisWordModelGuard,
	sanitizeModelError,
	semanticDefinitionFingerprint,
	validateAuthority,
	type ParadisWordModelOptions,
	type ParadisWordPartAuthority,
} from './paradisWordStyles.js';

const wordNamespaces = new Set([
	'http://schemas.openxmlformats.org/wordprocessingml/2006/main',
	'http://purl.oclc.org/ooxml/wordprocessingml/main',
]);
const relationshipNamespaces = new Set([
	'http://schemas.openxmlformats.org/officeDocument/2006/relationships',
	'http://purl.oclc.org/ooxml/officeDocument/relationships',
]);

type XmlElement = Extract<ParadisOfficeXmlNode, { readonly kind: 'element' }>;

export interface ParadisWordNumberingParseInput {
	readonly document: ParadisOfficeXmlDocument;
	readonly authority: ParadisWordPartAuthority;
}

export interface ParadisWordNumberingParseOptions extends ParadisWordModelOptions {
	readonly maximumLevels?: number;
}

export interface ParadisWordPictureBullet {
	readonly id: string;
	readonly relationshipId?: string;
	readonly source: ParadisWordPartAuthority & { readonly semanticPath: readonly number[] };
}

export interface ParadisWordNumberingLevel {
	readonly level: string;
	readonly start?: string;
	readonly restart?: string;
	readonly format?: string;
	readonly text?: string;
	readonly paragraphStyleId?: string;
	readonly pictureBulletId?: string;
}

export interface ParadisWordAbstractNumbering {
	readonly id: string;
	readonly multiLevelType?: string;
	readonly styleLink?: string;
	readonly numberingStyleLink?: string;
	readonly levels: ReadonlyMap<string, ParadisWordNumberingLevel>;
}

export interface ParadisWordNumberingOverride {
	readonly level: string;
	readonly start?: string;
	readonly replacement?: ParadisWordNumberingLevel;
}

export interface ParadisWordConcreteNumbering {
	readonly id: string;
	readonly abstractNumberingId: string;
	readonly overrides: ReadonlyMap<string, ParadisWordNumberingOverride>;
	readonly definitionFingerprint: string;
}

export interface ParadisWordNumberingModel {
	readonly abstractNumbers: ReadonlyMap<string, ParadisWordAbstractNumbering>;
	readonly numbers: ReadonlyMap<string, ParadisWordConcreteNumbering>;
	readonly pictureBullets: ReadonlyMap<string, ParadisWordPictureBullet>;
}

export interface ParadisWordResolvedNumbering {
	readonly numId: string;
	readonly abstractNumId: string;
	readonly level: string;
	readonly start: string | undefined;
	readonly restart: string | undefined;
	readonly format: string | undefined;
	readonly text: string | undefined;
	readonly paragraphStyleId: string | undefined;
	readonly pictureBulletId: string | undefined;
	readonly pictureBullet: ParadisWordPictureBullet | undefined;
	readonly definitionFingerprint: string;
}

interface ParsedAbstract {
	readonly value: ParadisWordAbstractNumbering;
	readonly canonical: string;
}

interface ParsedNumber {
	readonly id: string;
	readonly abstractNumberingId: string;
	readonly overrides: ReadonlyMap<string, ParadisWordNumberingOverride>;
	readonly canonical: string;
}

/** Parses numbering definitions and picture references without reading picture bytes. */
export function parseParadisWordNumbering(input: ParadisWordNumberingParseInput, options: ParadisWordNumberingParseOptions = {}): ParadisWordNumberingModel {
	try {
		validateAuthority(input.authority, uri => uri === '/word/numbering.xml');
		const guard = new ParadisWordModelGuard(options);
		const maximumLevels = options.maximumLevels ?? 1_000_000;
		if (!Number.isSafeInteger(maximumLevels) || maximumLevels < 0) {
			throw new ParadisOfficePackageError('limitExceeded');
		}
		const root = input.document.root;
		if (!root || !isWordElement(root, 'numbering')) {
			throw new ParadisOfficePackageError('malformed');
		}
		const pictures = new Map<string, ParadisWordPictureBullet>();
		const pictureCanonical = new Map<string, string>();
		const abstracts = new Map<string, ParsedAbstract>();
		const numbers = new Map<string, ParsedNumber>();
		let levels = 0;
		for (const [index, element] of elementChildren(root).entries()) {
			guard.checkpoint();
			const path = [0, index];
			if (isWordElement(element, 'numPicBullet')) {
				guard.definition();
				const id = requiredAttribute(element, wordNamespace(element), 'numPicBulletId');
				if (pictures.has(id)) {
					throw new ParadisOfficePackageError('malformed');
				}
				pictures.set(id, {
					id,
					...(findRelationshipId(element) ? { relationshipId: findRelationshipId(element) } : {}),
					source: { ...input.authority, semanticPath: Object.freeze(path) },
				});
				pictureCanonical.set(id, canonicalElementValue(element));
			} else if (isWordElement(element, 'abstractNum')) {
				guard.definition();
				const parsed = parseAbstract(element, guard, () => {
					if (++levels > maximumLevels) {
						throw new ParadisOfficePackageError('limitExceeded');
					}
				});
				if (abstracts.has(parsed.value.id)) {
					throw new ParadisOfficePackageError('malformed');
				}
				abstracts.set(parsed.value.id, parsed);
			} else if (isWordElement(element, 'num')) {
				guard.definition();
				const parsed = parseNumber(element, guard, () => {
					if (++levels > maximumLevels) {
						throw new ParadisOfficePackageError('limitExceeded');
					}
				});
				if (numbers.has(parsed.id)) {
					throw new ParadisOfficePackageError('malformed');
				}
				numbers.set(parsed.id, parsed);
			}
		}
		const publicNumbers = new Map<string, ParadisWordConcreteNumbering>();
		for (const parsed of numbers.values()) {
			const abstract = abstracts.get(parsed.abstractNumberingId);
			if (!abstract) {
				throw new ParadisOfficePackageError('malformed');
			}
			const pictureIds = new Set<string>();
			for (const level of abstract.value.levels.values()) {
				if (level.pictureBulletId) {
					pictureIds.add(level.pictureBulletId);
				}
			}
			for (const override of parsed.overrides.values()) {
				if (override.replacement?.pictureBulletId) {
					pictureIds.add(override.replacement.pictureBulletId);
				}
			}
			const referencedPictures = [...pictureIds]
				.sort()
				.map(id => pictureCanonical.get(id) ?? `missing:${id}`)
				.join('|');
			publicNumbers.set(parsed.id, {
				id: parsed.id,
				abstractNumberingId: parsed.abstractNumberingId,
				overrides: parsed.overrides,
				definitionFingerprint: semanticDefinitionFingerprint(`${abstract.canonical}|${parsed.canonical}|${referencedPictures}`),
			});
		}
		return {
			abstractNumbers: new Map([...abstracts].map(([id, parsed]) => [id, parsed.value])),
			numbers: publicNumbers,
			pictureBullets: pictures,
		};
	} catch (error) {
		throw sanitizeModelError(error);
	}
}

/** Resolves one concrete numbering level after applying level and start overrides. */
export function resolveParadisWordNumbering(model: ParadisWordNumberingModel, numId: string, level: number): ParadisWordResolvedNumbering {
	try {
		if (!Number.isSafeInteger(level) || level < 0 || level > 8) {
			throw new ParadisOfficePackageError('malformed');
		}
		const levelId = String(level);
		const number = model.numbers.get(numId);
		const abstract = number && model.abstractNumbers.get(number.abstractNumberingId);
		const base = abstract?.levels.get(levelId);
		if (!number || !abstract || !base) {
			throw new ParadisOfficePackageError('malformed');
		}
		const override = number.overrides.get(levelId);
		const replacement = override?.replacement;
		const pictureBulletId = replacement?.pictureBulletId ?? base.pictureBulletId;
		const pictureBullet = pictureBulletId ? model.pictureBullets.get(pictureBulletId) : undefined;
		return {
			numId,
			abstractNumId: abstract.id,
			level: levelId,
			start: override?.start ?? replacement?.start ?? base.start,
			restart: replacement?.restart ?? base.restart,
			format: replacement?.format ?? base.format,
			text: replacement?.text ?? base.text,
			paragraphStyleId: replacement?.paragraphStyleId ?? base.paragraphStyleId,
			pictureBulletId,
			pictureBullet,
			definitionFingerprint: number.definitionFingerprint,
		};
	} catch (error) {
		throw sanitizeModelError(error);
	}
}

function parseAbstract(element: XmlElement, guard: ParadisWordModelGuard, level: () => void): ParsedAbstract {
	const id = requiredAttribute(element, wordNamespace(element), 'abstractNumId');
	let multiLevelType: string | undefined;
	let styleLink: string | undefined;
	let numberingStyleLink: string | undefined;
	const levels = new Map<string, ParadisWordNumberingLevel>();
	for (const child of elementChildren(element)) {
		guard.property();
		if (isWordElement(child, 'multiLevelType')) {
			multiLevelType = optionalAttribute(child, wordNamespace(child), 'val');
		} else if (isWordElement(child, 'styleLink')) {
			styleLink = optionalAttribute(child, wordNamespace(child), 'val');
		} else if (isWordElement(child, 'numStyleLink')) {
			numberingStyleLink = optionalAttribute(child, wordNamespace(child), 'val');
		} else if (isWordElement(child, 'lvl')) {
			level();
			const parsedLevel = parseLevel(child, guard);
			if (levels.has(parsedLevel.level)) {
				throw new ParadisOfficePackageError('malformed');
			}
			levels.set(parsedLevel.level, parsedLevel);
		}
	}
	return {
		value: {
			id,
			...(multiLevelType ? { multiLevelType } : {}),
			...(styleLink ? { styleLink } : {}),
			...(numberingStyleLink ? { numberingStyleLink } : {}),
			levels,
		},
		canonical: canonicalElementValue(element),
	};
}

function parseNumber(element: XmlElement, guard: ParadisWordModelGuard, level: () => void): ParsedNumber {
	const id = requiredAttribute(element, wordNamespace(element), 'numId');
	let abstractNumberingId: string | undefined;
	const overrides = new Map<string, ParadisWordNumberingOverride>();
	for (const child of elementChildren(element)) {
		guard.property();
		if (isWordElement(child, 'abstractNumId')) {
			abstractNumberingId = optionalAttribute(child, wordNamespace(child), 'val');
		} else if (isWordElement(child, 'lvlOverride')) {
			level();
			const overrideLevel = requiredAttribute(child, wordNamespace(child), 'ilvl');
			let start: string | undefined;
			let replacement: ParadisWordNumberingLevel | undefined;
			for (const value of elementChildren(child)) {
				if (isWordElement(value, 'startOverride')) {
					start = optionalAttribute(value, wordNamespace(value), 'val');
				} else if (isWordElement(value, 'lvl')) {
					replacement = parseLevel(value, guard, overrideLevel);
				}
			}
			if (overrides.has(overrideLevel)) {
				throw new ParadisOfficePackageError('malformed');
			}
			overrides.set(overrideLevel, { level: overrideLevel, ...(start ? { start } : {}), ...(replacement ? { replacement } : {}) });
		}
	}
	if (!abstractNumberingId) {
		throw new ParadisOfficePackageError('malformed');
	}
	return { id, abstractNumberingId, overrides, canonical: canonicalElementValue(element) };
}

function parseLevel(element: XmlElement, guard: ParadisWordModelGuard, fallbackLevel?: string): ParadisWordNumberingLevel {
	const level = optionalAttribute(element, wordNamespace(element), 'ilvl') ?? fallbackLevel;
	if (level === undefined || !/^\d+$/.test(level) || Number(level) > 8) {
		throw new ParadisOfficePackageError('malformed');
	}
	let start: string | undefined;
	let restart: string | undefined;
	let format: string | undefined;
	let text: string | undefined;
	let paragraphStyleId: string | undefined;
	let pictureBulletId: string | undefined;
	for (const child of elementChildren(element)) {
		guard.property();
		const value = optionalAttribute(child, wordNamespace(child), 'val');
		if (isWordElement(child, 'start')) {
			start = value;
		} else if (isWordElement(child, 'lvlRestart')) {
			restart = value;
		} else if (isWordElement(child, 'numFmt')) {
			format = value;
		} else if (isWordElement(child, 'lvlText')) {
			text = value;
		} else if (isWordElement(child, 'pStyle')) {
			paragraphStyleId = value;
		} else if (isWordElement(child, 'lvlPicBulletId')) {
			pictureBulletId = value;
		}
	}
	return {
		level,
		...(start !== undefined ? { start } : {}),
		...(restart !== undefined ? { restart } : {}),
		...(format !== undefined ? { format } : {}),
		...(text !== undefined ? { text } : {}),
		...(paragraphStyleId !== undefined ? { paragraphStyleId } : {}),
		...(pictureBulletId !== undefined ? { pictureBulletId } : {}),
	};
}

function findRelationshipId(element: XmlElement): string | undefined {
	for (const attribute of element.attributes) {
		if (relationshipNamespaces.has(attribute.uri) && attribute.local === 'id') {
			return attribute.value;
		}
	}
	for (const child of elementChildren(element)) {
		const result = findRelationshipId(child);
		if (result) {
			return result;
		}
	}
	return undefined;
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

function requiredAttribute(element: XmlElement, uri: string, local: string): string {
	const value = optionalAttribute(element, uri, local);
	if (!value) {
		throw new ParadisOfficePackageError('malformed');
	}
	return value;
}

function optionalAttribute(element: XmlElement, uri: string, local: string): string | undefined {
	const matches = element.attributes.filter(attribute => attribute.uri === uri && attribute.local === local);
	if (matches.length > 1) {
		throw new ParadisOfficePackageError('malformed');
	}
	return matches[0]?.value;
}
