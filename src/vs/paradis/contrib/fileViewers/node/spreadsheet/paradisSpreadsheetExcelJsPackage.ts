/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import type JSZip from 'jszip';
import type { IParadisOfficeArchive } from '../../common/office/paradisOfficeArchive.js';
import { createParadisOfficeNodeArchive } from '../office/paradisOfficeNodeArchive.js';

/** The package files the layout check reads: every relationships part and the content types part. */
export interface IExcelJsPackageListing {
	/** Every file entry name in the ZIP, as stored. */
	readonly names: readonly string[];
	/** Relationships part name → XML text. */
	readonly relationships: ReadonlyMap<string, string>;
	readonly contentTypes?: string;
}

/** What to change so exceljs finds every part. */
export interface IExcelJsPackagePlan {
	/** Old name → new name, for parts and their relationships parts. */
	readonly moves: ReadonlyMap<string, string>;
	/** Final name → new text, for relationships parts and `[Content_Types].xml`. */
	readonly texts: ReadonlyMap<string, string>;
}

/** Relationships parts are small; a package whose relationships exceed this is left as it is. */
const MAX_RELATIONSHIPS_BYTES = 8 * 1024 * 1024;

/**
 * Rewrites a workbook package into the part layout exceljs expects, only when it differs.
 *
 * exceljs finds parts by name patterns (`xl/comments1.xml`, `xl/drawings/vmlDrawing1.vml`) and joins
 * relationship Targets as relative strings (`../comments1.xml`). ECMA-376 Part 2 §6.5.3 also allows an
 * absolute Target (`/xl/comments/comment1.xml`) and any part name, which some producers write; exceljs
 * then dereferences an undefined entry and the whole workbook fails to open.
 *
 * The check reads only the relationships parts and `[Content_Types].xml` (through the central
 * directory), so a workbook already in that layout is returned unchanged (the same object) without a
 * second JSZip load. Otherwise this moves legacy comments and their VML to the names exceljs matches,
 * rewrites internal Targets as relative ones (including the moved parts' own relationships and every
 * other relationship that points at a moved part), and follows the moves in the content type Overrides.
 */
export async function normalizeWorkbookForExcelJs(buffer: Buffer, JSZipRuntime: typeof JSZip): Promise<Buffer> {
	const listing = await readExcelJsPackageListing(buffer);
	const plan = listing && planExcelJsPackageLayout(listing);
	if (!plan) {
		return buffer;
	}
	const zip = await JSZipRuntime.loadAsync(buffer);
	for (const [from, to] of plan.moves) {
		const file = zip.file(from);
		if (file) {
			zip.file(to, await file.async('uint8array'));
			zip.remove(from);
		}
	}
	for (const [name, text] of plan.texts) {
		zip.file(name, text);
	}
	return zip.generateAsync({ type: 'nodebuffer', compression: 'STORE' });
}

/** Reads the names, relationships parts and content types; `undefined` when the package cannot be listed. */
async function readExcelJsPackageListing(buffer: Buffer): Promise<IExcelJsPackageListing | undefined> {
	let archive: IParadisOfficeArchive;
	try {
		archive = await createParadisOfficeNodeArchive(new Uint8Array(buffer.buffer, buffer.byteOffset, buffer.byteLength));
	} catch {
		// Not a ZIP that the archive reader accepts. exceljs reports its own error.
		return undefined;
	}
	const names: string[] = [];
	const relationships = new Map<string, string>();
	let contentTypes: string | undefined;
	let total = 0;
	try {
		for await (const entry of archive.entries()) {
			if (entry.directory) {
				continue;
			}
			names.push(entry.name);
			const isRelationships = entry.name.endsWith('.rels');
			if (!isRelationships && entry.name !== '[Content_Types].xml') {
				continue;
			}
			const chunks: Uint8Array[] = [];
			for await (const chunk of archive.read(entry)) {
				total += chunk.byteLength;
				if (total > MAX_RELATIONSHIPS_BYTES) {
					return undefined;
				}
				chunks.push(chunk.slice());
			}
			const text = Buffer.concat(chunks).toString('utf8');
			if (isRelationships) {
				relationships.set(entry.name, text);
			} else {
				contentTypes = text;
			}
		}
	} catch {
		return undefined;
	} finally {
		archive.dispose();
	}
	return { names, relationships, contentTypes };
}

interface RelationshipElement {
	readonly element: string;
	readonly target: string;
	readonly typeName: string;
	readonly external: boolean;
}

/**
 * Decides the moves and rewrites for `normalizeWorkbookForExcelJs`. Returns `undefined` when exceljs
 * already finds every part (no absolute internal Target, comments and VML already at the matched names).
 */
export function planExcelJsPackageLayout(listing: IExcelJsPackageListing): IExcelJsPackagePlan | undefined {
	const names = new Set(listing.names);
	const parsed = new Map<string, { readonly source: string; readonly relationships: readonly RelationshipElement[] }>();
	for (const [relsName, xml] of [...listing.relationships].sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0)) {
		const source = relationshipSource(relsName);
		if (source !== undefined) {
			parsed.set(relsName, { source, relationships: relationshipElements(xml) });
		}
	}

	// 1. Which comments and VML parts must move, and where to.
	const moves = new Map<string, string>();
	const taken = new Set(names);
	const nextName = (prefix: string, suffix: string): string => {
		let index = 1;
		while (taken.has(`${prefix}${index}${suffix}`)) {
			index++;
		}
		const name = `${prefix}${index}${suffix}`;
		taken.add(name);
		return name;
	};
	let absoluteTargets = false;
	for (const { source, relationships } of parsed.values()) {
		for (const relationship of relationships) {
			if (relationship.external) {
				continue;
			}
			absoluteTargets ||= relationship.target.startsWith('/');
			const partName = resolvePartName(directoryOf(source), relationship.target);
			if (partName === undefined || !names.has(partName) || moves.has(partName)) {
				continue;
			}
			if (relationship.typeName === 'comments' && !/^xl\/comments\d+\.xml$/.test(partName)) {
				moves.set(partName, nextName('xl/comments', '.xml'));
			} else if (relationship.typeName === 'vmlDrawing' && !/^xl\/drawings\/vmlDrawing\d+\.vml$/.test(partName)) {
				moves.set(partName, nextName('xl/drawings/vmlDrawing', '.vml'));
			}
		}
	}
	if (moves.size === 0 && !absoluteTargets) {
		return undefined;
	}
	// A moved part takes its relationships part with it.
	for (const [from, to] of [...moves]) {
		const fromRels = relationshipPartName(from);
		if (listing.relationships.has(fromRels)) {
			moves.set(fromRels, relationshipPartName(to));
		}
	}

	// 2. Rewrite Targets. Each Target resolves against where its source was, and is written relative to
	//    where its source is now, pointing at where the target is now.
	const texts = new Map<string, string>();
	for (const [relsName, { source, relationships }] of parsed) {
		const oldDirectory = directoryOf(source);
		const newSource = moves.get(source) ?? source;
		const newDirectory = directoryOf(newSource);
		const sourceMoved = newSource !== source;
		const rewrites = new Map<string, string>();
		for (const relationship of relationships) {
			if (relationship.external) {
				continue;
			}
			const partName = resolvePartName(oldDirectory, relationship.target);
			if (partName === undefined) {
				continue;
			}
			const newPart = moves.get(partName) ?? partName;
			if (!sourceMoved && newPart === partName && !relationship.target.startsWith('/')) {
				continue;
			}
			const target = escapeAttribute(relativeTarget(newDirectory, newPart));
			rewrites.set(relationship.element, relationship.element.replace(/\bTarget\s*=\s*("[^"]*"|'[^']*')/, () => `Target="${target}"`));
		}
		const xml = listing.relationships.get(relsName)!;
		const rewritten = rewrites.size === 0 ? xml : xml.replace(/<Relationship\b[^>]*>/g, element => rewrites.get(element) ?? element);
		if (rewritten !== xml || moves.has(relsName)) {
			texts.set(moves.get(relsName) ?? relsName, rewritten);
		}
	}

	// 3. Follow the moves in `[Content_Types].xml` (Part 2 §10.1.2.2: Override PartName is the part name).
	if (listing.contentTypes !== undefined && moves.size > 0) {
		const contentTypes = rewriteContentTypes(listing.contentTypes, moves);
		if (contentTypes !== listing.contentTypes) {
			texts.set('[Content_Types].xml', contentTypes);
		}
	}
	return { moves, texts };
}

function relationshipElements(xml: string): RelationshipElement[] {
	const result: RelationshipElement[] = [];
	for (const match of xml.matchAll(/<Relationship\b[^>]*>/g)) {
		const element = match[0];
		const target = attributeValue(element, 'Target');
		if (target === undefined) {
			continue;
		}
		const type = attributeValue(element, 'Type') ?? '';
		result.push({
			element,
			target,
			typeName: type.slice(type.lastIndexOf('/') + 1),
			external: attributeValue(element, 'TargetMode') === 'External',
		});
	}
	return result;
}

function attributeValue(element: string, name: string): string | undefined {
	const match = new RegExp(`\\b${name}\\s*=\\s*(?:"(?<double>[^"]*)"|'(?<single>[^']*)')`).exec(element);
	const raw = match?.groups?.double ?? match?.groups?.single;
	return raw === undefined ? undefined : unescapeAttribute(raw);
}

function unescapeAttribute(value: string): string {
	return value.replace(/&(?:#x(?<hex>[0-9a-fA-F]+)|#(?<decimal>[0-9]+)|(?<named>amp|lt|gt|quot|apos));/g, (entity, ...args) => {
		const groups = args[args.length - 1] as { hex?: string; decimal?: string; named?: string };
		if (groups.hex !== undefined || groups.decimal !== undefined) {
			const codePoint = groups.hex !== undefined ? parseInt(groups.hex, 16) : parseInt(groups.decimal!, 10);
			return codePoint <= 0x10FFFF ? String.fromCodePoint(codePoint) : entity;
		}
		return { amp: '&', lt: '<', gt: '>', quot: '"', apos: '\'' }[groups.named as 'amp'];
	});
}

function escapeAttribute(value: string): string {
	return value.replace(/[&<"]/g, character => character === '&' ? '&amp;' : character === '<' ? '&lt;' : '&quot;');
}

function rewriteContentTypes(xml: string, moves: ReadonlyMap<string, string>): string {
	const byLowerName = new Map<string, string>();
	for (const [from, to] of moves) {
		// Part names compare case-insensitively (Part 2 §6.3.5).
		byLowerName.set(`/${from}`.toLowerCase(), `/${to}`);
	}
	return xml.replace(/<Override\b[^>]*>/g, element => {
		const partName = attributeValue(element, 'PartName');
		const moved = partName === undefined ? undefined : byLowerName.get(partName.toLowerCase());
		return moved === undefined ? element : element.replace(/\bPartName\s*=\s*("[^"]*"|'[^']*')/, () => `PartName="${escapeAttribute(moved)}"`);
	});
}

/** `xl/worksheets/_rels/sheet1.xml.rels` → `xl/worksheets/sheet1.xml`; the package root → ''. */
function relationshipSource(relsName: string): string | undefined {
	if (relsName === '_rels/.rels') {
		return '';
	}
	const match = /^(?<directory>.*\/)?_rels\/(?<name>[^/]+)\.rels$/.exec(relsName);
	return match?.groups ? `${match.groups.directory ?? ''}${match.groups.name}` : undefined;
}

function directoryOf(partName: string): string {
	return partName.includes('/') ? partName.slice(0, partName.lastIndexOf('/')) : '';
}

function resolvePartName(sourceDirectory: string, target: string): string | undefined {
	const segments = target.startsWith('/') || !sourceDirectory ? [] : sourceDirectory.split('/');
	for (const segment of target.replace(/^\/+/, '').split('/')) {
		if (!segment || segment === '.') {
			continue;
		}
		if (segment === '..') {
			if (segments.length === 0) {
				return undefined;
			}
			segments.pop();
		} else {
			segments.push(segment);
		}
	}
	return segments.length ? segments.join('/') : undefined;
}

function relativeTarget(sourceDirectory: string, partName: string): string {
	const from = sourceDirectory ? sourceDirectory.split('/') : [];
	const to = partName.split('/');
	let common = 0;
	while (common < from.length && common < to.length - 1 && from[common] === to[common]) {
		common++;
	}
	return [...from.slice(common).map(() => '..'), ...to.slice(common)].join('/');
}

function relationshipPartName(partName: string): string {
	const slash = partName.lastIndexOf('/');
	return `${partName.slice(0, slash + 1)}_rels/${partName.slice(slash + 1)}.rels`;
}
