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
			// Scan the first chunk, where the root start tag almost always is, and stop reading once it is
			// found. Otherwise read on up to the limit (or the end of the part) and scan that once more.
			const chunks: Uint8Array[] = [];
			let length = 0;
			let verdict: boolean | undefined;
			let scannedChunks = 0;
			const scan = () => {
				scannedChunks = chunks.length;
				return rootBindsSpreadsheetMlPrefix(Buffer.concat(chunks).toString('utf8'));
			};
			for await (const chunk of archive.read(entry)) {
				chunks.push(chunk.slice(0, Math.min(chunk.byteLength, MAX_HEAD_BYTES - length)));
				length += chunk.byteLength;
				if (chunks.length === 1 || length >= MAX_HEAD_BYTES) {
					verdict = scan();
					if (verdict !== undefined || length >= MAX_HEAD_BYTES) {
						break;
					}
				}
			}
			if (verdict === undefined && scannedChunks !== chunks.length) {
				verdict = scan();
			}
			// A root start tag that does not end within a cut head is left to the full rewrite to decide.
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
 * before the root start tag does. Markup that cannot be read counts as `false` (the part is left alone).
 */
export function rootBindsSpreadsheetMlPrefix(head: string): boolean | undefined {
	let verdict: boolean | undefined;
	const outcome = scanXmlTags(head, tag => {
		verdict = tag.kind === 'start' && tag.attributes.some(attribute => attribute.name.startsWith('xmlns:') && attributeText(attribute.value) === SPREADSHEETML_MAIN);
		return false;
	});
	return outcome === 'truncated' ? undefined : outcome === 'malformed' ? false : verdict ?? undefined;
}

interface IAttribute {
	/** The whitespace before the name. */
	readonly space: string;
	name: string;
	/** `=` with the whitespace around it. */
	readonly equals: string;
	/** The value with its quotes. */
	readonly value: string;
}

type XmlTag =
	| { readonly kind: 'start'; readonly start: number; readonly end: number; readonly name: string; readonly attributes: IAttribute[]; readonly trailing: string; readonly empty: boolean }
	| { readonly kind: 'end'; readonly start: number; readonly end: number; readonly name: string };

type XmlScanOutcome = 'done' | 'stopped' | 'truncated' | 'malformed';

function isXmlSpace(code: number): boolean {
	return code === 0x20 || code === 0x09 || code === 0x0A || code === 0x0D;
}

/** Characters that end a tag or attribute name: whitespace, `/`, `>`, `<`, `=`, quotes. */
function endsName(code: number): boolean {
	return isXmlSpace(code) || code === 0x2F || code === 0x3E || code === 0x3C || code === 0x3D || code === 0x22 || code === 0x27;
}

/**
 * Visits each start and end tag of `xml` in one forward pass (linear in its length). Comments, CDATA
 * sections and processing instructions are skipped. Stops at the first markup that does not close
 * (`truncated`) or cannot be read (`malformed`, including any `<!DOCTYPE`, which OOXML does not allow);
 * `visit` returns `false` to stop (`stopped`).
 */
function scanXmlTags(xml: string, visit: (tag: XmlTag) => boolean): XmlScanOutcome {
	const length = xml.length;
	let index = 0;
	while (true) {
		const open = xml.indexOf('<', index);
		if (open < 0) {
			return 'done';
		}
		if (open + 1 >= length) {
			return 'truncated';
		}
		const next = xml.charCodeAt(open + 1);
		if (next === 0x21 /* ! */) {
			let close: string;
			if (xml.startsWith('<!--', open)) {
				close = '-->';
			} else if (xml.startsWith('<![CDATA[', open)) {
				close = ']]>';
			} else {
				return length - open < 9 ? 'truncated' : 'malformed';
			}
			const end = xml.indexOf(close, open + 2);
			if (end < 0) {
				return 'truncated';
			}
			index = end + close.length;
			continue;
		}
		if (next === 0x3F /* ? */) {
			const end = xml.indexOf('?>', open + 2);
			if (end < 0) {
				return 'truncated';
			}
			index = end + 2;
			continue;
		}
		let cursor = open + (next === 0x2F /* / */ ? 2 : 1);
		const nameStart = cursor;
		while (cursor < length && !endsName(xml.charCodeAt(cursor))) {
			cursor++;
		}
		if (cursor >= length) {
			return 'truncated';
		}
		if (cursor === nameStart) {
			return 'malformed';
		}
		const name = xml.slice(nameStart, cursor);
		if (next === 0x2F) {
			while (cursor < length && isXmlSpace(xml.charCodeAt(cursor))) {
				cursor++;
			}
			if (cursor >= length) {
				return 'truncated';
			}
			if (xml.charCodeAt(cursor) !== 0x3E) {
				return 'malformed';
			}
			if (!visit({ kind: 'end', start: open, end: cursor + 1, name })) {
				return 'stopped';
			}
			index = cursor + 1;
			continue;
		}
		const attributes: IAttribute[] = [];
		let tag: XmlTag | undefined;
		while (!tag) {
			const spaceStart = cursor;
			while (cursor < length && isXmlSpace(xml.charCodeAt(cursor))) {
				cursor++;
			}
			if (cursor >= length) {
				return 'truncated';
			}
			const code = xml.charCodeAt(cursor);
			if (code === 0x3E || code === 0x2F) {
				if (code === 0x2F) {
					if (cursor + 1 >= length) {
						return 'truncated';
					}
					if (xml.charCodeAt(cursor + 1) !== 0x3E) {
						return 'malformed';
					}
				}
				tag = { kind: 'start', start: open, end: cursor + (code === 0x2F ? 2 : 1), name, attributes, trailing: xml.slice(spaceStart, cursor), empty: code === 0x2F };
				break;
			}
			if (cursor === spaceStart) {
				return 'malformed';
			}
			const attributeStart = cursor;
			while (cursor < length && !endsName(xml.charCodeAt(cursor))) {
				cursor++;
			}
			if (cursor === attributeStart) {
				return 'malformed';
			}
			const equalsStart = cursor;
			while (cursor < length && isXmlSpace(xml.charCodeAt(cursor))) {
				cursor++;
			}
			if (cursor < length && xml.charCodeAt(cursor) !== 0x3D) {
				return 'malformed';
			}
			cursor++;
			while (cursor < length && isXmlSpace(xml.charCodeAt(cursor))) {
				cursor++;
			}
			if (cursor >= length) {
				return 'truncated';
			}
			const quote = xml.charCodeAt(cursor);
			if (quote !== 0x22 && quote !== 0x27) {
				return 'malformed';
			}
			const valueStart = cursor++;
			while (cursor < length) {
				const valueCode = xml.charCodeAt(cursor);
				if (valueCode === quote) {
					break;
				}
				if (valueCode === 0x3C) {
					return 'malformed';
				}
				cursor++;
			}
			if (cursor >= length) {
				return 'truncated';
			}
			cursor++;
			attributes.push({ space: xml.slice(spaceStart, attributeStart), name: xml.slice(attributeStart, equalsStart), equals: xml.slice(equalsStart, valueStart), value: xml.slice(valueStart, cursor) });
		}
		if (!visit(tag)) {
			return 'stopped';
		}
		index = tag.end;
	}
}

interface IElementFrame {
	readonly name: string;
	readonly outputName: string;
	/** The prefixes (`''` for the default namespace) this element declares, to take off the table when it ends. */
	readonly declared: readonly string[] | undefined;
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
 * Runs in one forward pass. Returns `undefined` when the XML is not well-formed enough to follow (markup
 * that does not close, unbalanced tags), so the caller keeps the part as it was.
 */
export function unprefixSpreadsheetMlXml(xml: string): string | undefined {
	const root: IElementFrame = { name: '', outputName: '', declared: undefined, outputDefault: '' };
	const stack: IElementFrame[] = [];
	// Prefix (`''` for the default namespace) → the namespace URIs declared for it by the open elements,
	// innermost last. Entering and leaving an element costs one push or pop per declaration.
	const bindings = new Map<string, string[]>([['', ['']]]);
	const lookup = (prefix: string): string | undefined => {
		const uris = bindings.get(prefix);
		return uris?.length ? uris[uris.length - 1] : undefined;
	};
	const undeclare = (declared: readonly string[] | undefined) => {
		for (const prefix of declared ?? []) {
			bindings.get(prefix)!.pop();
		}
	};
	const output: string[] = [];
	let copied = 0;
	let unbalanced = false;
	const replace = (start: number, end: number, text: string) => {
		output.push(xml.slice(copied, start), text);
		copied = end;
	};
	const outcome = scanXmlTags(xml, tag => {
		if (tag.kind === 'end') {
			const frame = stack.pop();
			if (!frame || frame.name !== tag.name) {
				unbalanced = true;
				return false;
			}
			undeclare(frame.declared);
			if (frame.outputName !== frame.name) {
				replace(tag.start, tag.end, `</${frame.outputName}>`);
			}
			return true;
		}
		const parent = stack.length ? stack[stack.length - 1] : root;
		const { name, attributes } = tag;

		// Namespace declarations of this element.
		let declared: string[] | undefined;
		let ownDefault: string | undefined;
		for (const attribute of attributes) {
			if (attribute.name === 'xmlns' || attribute.name.startsWith('xmlns:')) {
				const prefix = attribute.name === 'xmlns' ? '' : attribute.name.slice(6);
				const uri = attributeText(attribute.value);
				let uris = bindings.get(prefix);
				if (!uris) {
					uris = [];
					bindings.set(prefix, uris);
				}
				uris.push(uri);
				(declared ??= []).push(prefix);
				if (prefix === '') {
					ownDefault = uri;
				}
			}
		}

		const colon = name.indexOf(':');
		const strip = colon >= 0 && lookup(name.slice(0, colon)) === SPREADSHEETML_MAIN;
		const outputName = strip ? name.slice(colon + 1) : name;

		// The default namespace this element needs in the output, and whether a declaration must change.
		let outputDefault = ownDefault ?? parent.outputDefault;
		let setDefault: string | undefined;
		if (!outputName.includes(':')) {
			const needed = strip ? SPREADSHEETML_MAIN : lookup('') ?? '';
			if (outputDefault !== needed) {
				setDefault = needed;
				outputDefault = needed;
			}
		}

		// Attributes bound to SpreadsheetML lose their prefix unless that name is taken.
		let attributesChanged = setDefault !== undefined;
		let taken: Set<string> | undefined;
		for (const attribute of attributes) {
			const attributeColon = attribute.name.indexOf(':');
			if (attributeColon < 0 || attribute.name.startsWith('xmlns:') || lookup(attribute.name.slice(0, attributeColon)) !== SPREADSHEETML_MAIN) {
				continue;
			}
			taken ??= new Set(attributes.map(candidate => candidate.name));
			const local = attribute.name.slice(attributeColon + 1);
			if (!taken.has(local)) {
				taken.add(local);
				attribute.name = local;
				attributesChanged = true;
			}
		}

		if (tag.empty) {
			undeclare(declared);
		} else {
			stack.push({ name, outputName, declared, outputDefault });
		}
		if (!strip && !attributesChanged) {
			return true;
		}
		const parts = [...attributes];
		if (setDefault !== undefined) {
			const value = `"${escapeAttribute(setDefault)}"`;
			const existing = parts.findIndex(attribute => attribute.name === 'xmlns');
			if (existing >= 0) {
				parts[existing] = { ...parts[existing], equals: '=', value };
			} else {
				parts.unshift({ space: ' ', name: 'xmlns', equals: '=', value });
			}
		}
		const rebuilt = parts.map(attribute => `${attribute.space}${attribute.name}${attribute.equals}${attribute.value}`).join('');
		replace(tag.start, tag.end, `<${outputName}${rebuilt}${tag.trailing}${tag.empty ? '/' : ''}>`);
		return true;
	});
	if (outcome !== 'done' || unbalanced || stack.length) {
		return undefined;
	}
	if (!output.length) {
		return xml;
	}
	output.push(xml.slice(copied));
	return output.join('');
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
