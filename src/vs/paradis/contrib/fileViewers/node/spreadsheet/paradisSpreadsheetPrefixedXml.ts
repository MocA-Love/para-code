/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import type JSZip from 'jszip';
import type { IParadisOfficeArchive } from '../../common/office/paradisOfficeArchive.js';
import { createParadisOfficeNodeArchive } from '../office/paradisOfficeNodeArchive.js';

/** The SpreadsheetML main namespace (transitional). Only elements and attributes bound to it are changed. */
const SPREADSHEETML_MAIN = 'http://schemas.openxmlformats.org/spreadsheetml/2006/main';

/** How much of each part is read to find its root start tag. */
const MAX_HEAD_BYTES = 64 * 1024;

/**
 * One XML token. Comments, CDATA sections, processing instructions and declarations are matched only so
 * that their contents are skipped; end tags and start tags are rewritten.
 */
const TOKEN = /<!--[\s\S]*?-->|<!\[CDATA\[[\s\S]*?\]\]>|<\?[\s\S]*?\?>|<!(?:[^>"'[]|"[^"]*"|'[^']*'|\[[^\]]*\])*>|<\/(?<end>[^\s>]+)\s*>|<(?<start>[^\s/>!?]+)(?<attributes>(?:\s+[^\s=/>]+\s*=\s*(?:"[^"]*"|'[^']*'))*)(?<trailing>\s*)(?<empty>\/?)>/g;

const ATTRIBUTE = /(?<space>\s+)(?<name>[^\s=/>]+)(?<equals>\s*=\s*)(?<value>"[^"]*"|'[^']*')/g;

/**
 * Rewrites a workbook package so that SpreadsheetML elements and attributes have no namespace prefix,
 * only when some part uses one.
 *
 * OpenXML SDK and .NET report tools write `<x:workbook xmlns:x="…/spreadsheetml/2006/main">`. The XML
 * is the same document as `<workbook xmlns="…">`, but exceljs and the viewer's own readers compare
 * element names as written, so such a workbook does not open. Each `.xml` part whose root start tag binds
 * a prefix to the SpreadsheetML main namespace is rewritten by {@link unprefixSpreadsheetMlXml}; other
 * namespaces (`r:`, `mc:`, `x14:`, `xdr:`, VML's `x:`) are left alone.
 *
 * The check reads only the head of each `.xml` part (through the central directory), so a workbook with no
 * such part is returned unchanged (the same object) without a JSZip load.
 */
export async function unprefixWorkbookSpreadsheetMl(buffer: Buffer, JSZipRuntime: typeof JSZip): Promise<Buffer> {
	const candidates = await findPrefixedSpreadsheetMlParts(buffer);
	if (!candidates?.length) {
		return buffer;
	}
	const zip = await JSZipRuntime.loadAsync(buffer);
	let changed = false;
	for (const name of candidates) {
		const file = zip.file(name);
		if (!file) {
			continue;
		}
		const xml = await file.async('text');
		const rewritten = unprefixSpreadsheetMlXml(xml);
		if (rewritten !== undefined && rewritten !== xml) {
			zip.file(name, rewritten);
			changed = true;
		}
	}
	return changed ? zip.generateAsync({ type: 'nodebuffer', compression: 'STORE' }) : buffer;
}

/** The `.xml` parts whose root start tag binds a prefix to SpreadsheetML; `undefined` when the package cannot be listed. */
async function findPrefixedSpreadsheetMlParts(buffer: Buffer): Promise<string[] | undefined> {
	let archive: IParadisOfficeArchive;
	try {
		archive = await createParadisOfficeNodeArchive(new Uint8Array(buffer.buffer, buffer.byteOffset, buffer.byteLength));
	} catch {
		// Not a ZIP that the archive reader accepts. exceljs reports its own error.
		return undefined;
	}
	const names: string[] = [];
	try {
		for await (const entry of archive.entries()) {
			if (entry.directory || !/\.xml$/i.test(entry.name)) {
				continue;
			}
			const chunks: Uint8Array[] = [];
			let length = 0;
			let verdict: boolean | undefined;
			for await (const chunk of archive.read(entry)) {
				chunks.push(chunk.slice());
				length += chunk.byteLength;
				verdict = rootBindsSpreadsheetMlPrefix(Buffer.concat(chunks).toString('utf8'));
				if (verdict !== undefined || length >= MAX_HEAD_BYTES) {
					break;
				}
			}
			// A root start tag that does not end within the head is left to the full rewrite to decide.
			if (verdict ?? length >= MAX_HEAD_BYTES) {
				names.push(entry.name);
			}
		}
	} catch {
		return undefined;
	} finally {
		archive.dispose();
	}
	return names;
}

/**
 * Whether the root start tag in `head` binds a prefix to SpreadsheetML; `undefined` when `head` ends
 * before the root start tag does.
 */
export function rootBindsSpreadsheetMlPrefix(head: string): boolean | undefined {
	for (const match of head.matchAll(TOKEN)) {
		const groups = match.groups!;
		if (groups.start !== undefined) {
			for (const attribute of (groups.attributes ?? '').matchAll(ATTRIBUTE)) {
				if (attribute.groups!.name.startsWith('xmlns:') && attributeText(attribute.groups!.value) === SPREADSHEETML_MAIN) {
					return true;
				}
			}
			return false;
		}
		if (groups.end !== undefined) {
			return false;
		}
	}
	return undefined;
}

interface IAttribute {
	readonly space: string;
	name: string;
	readonly equals: string;
	readonly value: string;
}

function parseAttributes(text: string): IAttribute[] {
	return [...text.matchAll(ATTRIBUTE)].map(match => {
		const { space, name, equals, value } = match.groups!;
		return { space, name, equals, value };
	});
}

interface IElementFrame {
	readonly name: string;
	readonly outputName: string;
	/** Prefix (`''` for the default namespace) → namespace URI, as declared in the input. */
	readonly scope: ReadonlyMap<string, string>;
	/** The default namespace in scope in the output. */
	readonly outputDefault: string;
}

/**
 * Removes the prefix from every element and attribute name bound to the SpreadsheetML main namespace.
 *
 * Only names change, plus `xmlns` declarations where the default namespace in scope must change so that
 * each element keeps its namespace: an element that lost its prefix gets `xmlns="…/main"` when the default
 * in scope is something else, and an unprefixed element of another namespace (or none) below it gets its
 * own default back. Attribute order, quotes, text, comments and CDATA stay as they are, and the prefix
 * declarations stay (other attribute values may name them). A prefixed attribute keeps its prefix when the
 * element already has an attribute of that local name.
 *
 * Returns `undefined` when the XML is not well-formed enough to follow (unbalanced tags), so the caller
 * keeps the part as it was.
 */
export function unprefixSpreadsheetMlXml(xml: string): string | undefined {
	const root: IElementFrame = { name: '', outputName: '', scope: new Map([['', '']]), outputDefault: '' };
	const stack: IElementFrame[] = [];
	let failed = false;
	let changed = false;
	const result = xml.replace(TOKEN, (token: string, ...args: unknown[]) => {
		if (failed) {
			return token;
		}
		const groups = args[args.length - 1] as { end?: string; start?: string; attributes?: string; trailing?: string; empty?: string };
		if (groups.end !== undefined) {
			const frame = stack.pop();
			if (!frame || frame.name !== groups.end) {
				failed = true;
				return token;
			}
			return frame.outputName === frame.name ? token : `</${frame.outputName}>`;
		}
		if (groups.start === undefined) {
			return token;
		}
		const parent = stack.length ? stack[stack.length - 1] : root;
		const name = groups.start;
		const attributesText = groups.attributes ?? '';
		const plain = !attributesText.includes(':') && !attributesText.includes('xmlns');

		// Namespace declarations of this element.
		let scope = parent.scope;
		let ownDefault: string | undefined;
		let attributes: IAttribute[] | undefined;
		if (!plain) {
			attributes = parseAttributes(attributesText);
			let declared: Map<string, string> | undefined;
			for (const { name: attributeName, value } of attributes) {
				if (attributeName === 'xmlns' || attributeName.startsWith('xmlns:')) {
					declared ??= new Map(parent.scope);
					const prefix = attributeName === 'xmlns' ? '' : attributeName.slice(6);
					declared.set(prefix, attributeText(value));
					if (prefix === '') {
						ownDefault = attributeText(value);
					}
				}
			}
			scope = declared ?? scope;
		}

		const colon = name.indexOf(':');
		const prefix = colon < 0 ? undefined : name.slice(0, colon);
		const strip = prefix !== undefined && scope.get(prefix) === SPREADSHEETML_MAIN;
		const outputName = strip ? name.slice(colon + 1) : name;

		// The default namespace this element needs in the output, and whether a declaration must change.
		let outputDefault = ownDefault ?? parent.outputDefault;
		let setDefault: string | undefined;
		if (!outputName.includes(':')) {
			const needed = strip ? SPREADSHEETML_MAIN : scope.get('') ?? '';
			if (outputDefault !== needed) {
				setDefault = needed;
				outputDefault = needed;
			}
		}

		// Attributes bound to SpreadsheetML lose their prefix unless that name is taken.
		let attributesChanged = setDefault !== undefined;
		if (attributes) {
			const taken = new Set(attributes.map(attribute => attribute.name));
			for (const attribute of attributes) {
				const attributeColon = attribute.name.indexOf(':');
				if (attributeColon < 0 || attribute.name.startsWith('xmlns:')) {
					continue;
				}
				const local = attribute.name.slice(attributeColon + 1);
				if (scope.get(attribute.name.slice(0, attributeColon)) === SPREADSHEETML_MAIN && !taken.has(local)) {
					taken.add(local);
					attribute.name = local;
					attributesChanged = true;
				}
			}
		}

		if (groups.empty !== '/') {
			stack.push({ name, outputName, scope, outputDefault });
		}
		if (!strip && !attributesChanged) {
			return token;
		}
		changed = true;
		let rebuiltAttributes = attributesText;
		if (attributesChanged) {
			const parts = attributes ?? parseAttributes(attributesText);
			if (setDefault !== undefined) {
				const value = `"${escapeAttribute(setDefault)}"`;
				const existing = parts.findIndex(attribute => attribute.name === 'xmlns');
				if (existing >= 0) {
					parts[existing] = { ...parts[existing], equals: '=', value };
				} else {
					parts.unshift({ space: ' ', name: 'xmlns', equals: '=', value });
				}
			}
			rebuiltAttributes = parts.map(attribute => `${attribute.space}${attribute.name}${attribute.equals}${attribute.value}`).join('');
		}
		return `<${outputName}${rebuiltAttributes}${groups.trailing ?? ''}${groups.empty ?? ''}>`;
	});
	if (failed || stack.length) {
		return undefined;
	}
	return changed ? result : xml;
}

/** The value of a quoted attribute, with the predefined and character references resolved. */
function attributeText(quoted: string): string {
	return quoted.slice(1, -1).replace(/&(?:#x(?<hex>[0-9a-fA-F]+)|#(?<decimal>[0-9]+)|(?<named>amp|lt|gt|quot|apos));/g, (entity, ...args) => {
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
