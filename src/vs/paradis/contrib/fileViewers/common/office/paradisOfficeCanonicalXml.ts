/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import type { ParadisOfficeFingerprint } from '../paradisOfficeProtocol.js';
import type { CancellationToken } from '../../../../../base/common/cancellation.js';
import { type ParadisOfficeXmlDocument, type ParadisOfficeXmlNode, ParadisOfficePackageError, throwIfParadisOfficeCancelled } from './paradisOfficeArchive.js';

export interface ParadisOfficeXmlLimits {
	readonly depth: number;
	readonly nodes: number;
	readonly attributeLength: number;
	readonly characters: number;
}

const xmlNamespace = 'http://www.w3.org/XML/1998/namespace';
const xmlnsNamespace = 'http://www.w3.org/2000/xmlns/';

type XmlElement = Extract<ParadisOfficeXmlNode, { readonly kind: 'element' }>;

interface XmlFrame {
	readonly name: XmlQName;
	readonly node: XmlElement;
	readonly namespaces: Readonly<Record<string, string>>;
}

interface XmlQName {
	readonly prefix: string;
	readonly local: string;
}

interface RawXmlAttribute {
	readonly name: XmlQName;
	readonly value: string;
}

/**
 * Parses the deliberately small XML subset accepted from an untrusted Office package.
 * It does not depend on DOM, Node, or a streaming parser so adapters have identical output.
 */
export function parseParadisOfficeXml(xml: string, limits: ParadisOfficeXmlLimits, token?: CancellationToken, checkpoint?: () => void): ParadisOfficeXmlDocument {

	try {
		if (typeof xml !== 'string') {
			throw new ParadisOfficePackageError('malformed');
		}
		validateLimits(limits);
		const parser = new ParadisOfficeXmlParser(xml, limits, token, checkpoint);
		return parser.parse();
	} catch (error) {
		if (error instanceof ParadisOfficePackageError) {
			throw error;
		}
		throw new ParadisOfficePackageError('malformed');
	}
}

class ParadisOfficeXmlParser {
	private readonly stack: XmlFrame[] = [];
	private root: XmlElement | undefined;
	private index = 0;
	private nodes = 0;
	private characters = 0;
	private events = 0;
	private lastCheckpoint = 0;

	constructor(
		private readonly xml: string,
		private readonly limits: ParadisOfficeXmlLimits,
		private readonly token: CancellationToken | undefined,
		private readonly checkpoint: (() => void) | undefined,
	) { }

	parse(): ParadisOfficeXmlDocument {
		this.checkpointNow();
		let seenDeclaration = false;
		while (this.index < this.xml.length) {
			if (this.peek() === '<') {
				if (this.startsWith('<!--')) {
					this.parseComment();
				} else if (this.startsWith('<![CDATA[')) {
					this.parseCdata();
				} else if (this.startsWith('<?')) {
					seenDeclaration = this.parseProcessingInstruction(seenDeclaration);
				} else if (this.startsWith('</')) {
					this.parseEndTag();
				} else if (this.startsWith('<!')) {
					this.malformed();
				} else {
					this.parseStartTag();
				}
			} else {
				this.parseText();
			}
		}
		if (!this.root || this.stack.length !== 0) {
			this.malformed();
		}
		return { root: this.root };
	}

	private parseStartTag(): void {
		this.consume('<');
		const name = this.parseQName();
		const attributes: RawXmlAttribute[] = [];
		const rawNames = new Set<string>();
		let selfClosing = false;
		while (true) {
			const whitespace = this.skipWhitespace();
			if (this.startsWith('/>')) {
				this.consume('/');
				this.consume('>');
				selfClosing = true;
				break;
			}
			if (this.peek() === '>') {
				this.consume('>');
				break;
			}
			if (!whitespace) {
				this.malformed();
			}
			const attributeName = this.parseQName();
			const rawName = attributeName.prefix ? `${attributeName.prefix}:${attributeName.local}` : attributeName.local;
			if (rawNames.has(rawName)) {
				this.malformed();
			}
			rawNames.add(rawName);
			this.skipWhitespace();
			this.consume('=');
			this.skipWhitespace();
			attributes.push({ name: attributeName, value: this.parseAttributeValue() });
		}

		const namespaces: Record<string, string> = { ...(this.stack[this.stack.length - 1]?.namespaces ?? { xml: xmlNamespace }) };
		for (const attribute of attributes) {
			if (attribute.name.prefix === '' && attribute.name.local === 'xmlns') {
				if (attribute.value === xmlNamespace || attribute.value === xmlnsNamespace) {
					this.malformed();
				}
				namespaces[''] = attribute.value;
			} else if (attribute.name.prefix === 'xmlns') {
				this.validateNamespaceBinding(attribute.name.local, attribute.value);
				namespaces[attribute.name.local] = attribute.value;
			}
		}
		const element = this.createElement(name, attributes, namespaces);
		if (++this.nodes > this.limits.nodes || this.stack.length + 1 > this.limits.depth) {
			throw new ParadisOfficePackageError('limitExceeded');
		}
		if (this.stack.length > 0) {
			(this.stack[this.stack.length - 1].node.children as ParadisOfficeXmlNode[]).push(element);
		} else if (this.root) {
			this.malformed();
		} else {
			this.root = element;
		}
		this.recordEvent();
		if (!selfClosing) {
			this.stack.push({ name, node: element, namespaces });
		}
	}

	private createElement(name: XmlQName, attributes: readonly RawXmlAttribute[], namespaces: Readonly<Record<string, string>>): XmlElement {
		const uri = this.resolveElementUri(name, namespaces);
		const expandedAttributes: { uri: string; local: string; value: string }[] = [];
		const expandedNames = new Set<string>();
		for (const attribute of attributes) {
			if (attribute.name.prefix === '' && attribute.name.local === 'xmlns' || attribute.name.prefix === 'xmlns') {
				continue;
			}
			// XML Namespaces deliberately never apply the default namespace to attributes.
			const attributeUri = attribute.name.prefix === '' ? '' : this.resolveAttributeUri(attribute.name, namespaces);
			const expandedName = `{${attributeUri}}${attribute.name.local}`;
			if (expandedNames.has(expandedName)) {
				this.malformed();
			}
			expandedNames.add(expandedName);
			expandedAttributes.push({ uri: attributeUri, local: attribute.name.local, value: attribute.value });
		}
		const namespaceBindings: Record<string, string> = {};
		for (const [prefix, value] of Object.entries(namespaces)) {
			if (prefix !== 'xml') {
				namespaceBindings[prefix] = value;
			}
		}
		return { kind: 'element', uri, local: name.local, attributes: expandedAttributes, children: [], namespaceBindings };
	}

	private parseEndTag(): void {
		this.consume('<');
		this.consume('/');
		const name = this.parseQName();
		this.skipWhitespace();
		this.consume('>');
		const frame = this.stack.pop();
		if (!frame || frame.name.prefix !== name.prefix || frame.name.local !== name.local) {
			this.malformed();
		}
		this.recordEvent();
	}

	private parseText(): void {
		const value = this.parseCharacterData(false);
		if (this.stack.length === 0) {
			if (!isXmlWhitespace(value)) {
				this.malformed();
			}
			return;
		}
		this.appendText(value);
	}

	private parseCdata(): void {
		if (this.stack.length === 0) {
			this.malformed();
		}
		for (const character of '<![CDATA[') {
			this.consume(character);
		}
		let value = '';
		while (!this.startsWith(']]>')) {
			if (this.index >= this.xml.length) {
				this.malformed();
			}
			value += this.consumeCodePoint();
		}
		this.consume(']');
		this.consume(']');
		this.consume('>');
		this.appendText(value);
	}

	private parseComment(): void {
		for (const character of '<!--') {
			this.consume(character);
		}
		while (!this.startsWith('-->')) {
			if (this.index >= this.xml.length || this.startsWith('--')) {
				this.malformed();
			}
			this.consumeCodePoint();
		}
		this.consume('-');
		this.consume('-');
		this.consume('>');
		this.recordEvent();
	}

	private parseProcessingInstruction(seenDeclaration: boolean): boolean {
		const atStart = this.index === 0;
		this.consume('<');
		this.consume('?');
		const target = this.parseName();
		const isDeclaration = target === 'xml';
		if (target.toLowerCase() === 'xml' && !isDeclaration || isDeclaration && (!atStart || seenDeclaration)) {
			this.malformed();
		}
		if (isDeclaration && !isXmlWhitespaceCharacter(this.peek())) {
			this.malformed();
		}
		while (!this.startsWith('?>')) {
			if (this.index >= this.xml.length) {
				this.malformed();
			}
			this.consumeCodePoint();
		}
		this.consume('?');
		this.consume('>');
		this.recordEvent();
		return seenDeclaration || isDeclaration;
	}

	private parseAttributeValue(): string {
		const quote = this.peek();
		if (quote !== '"' && quote !== '\'') {
			this.malformed();
		}
		this.consume(quote);
		let value = '';
		while (this.peek() !== quote) {
			if (this.index >= this.xml.length || this.peek() === '<') {
				this.malformed();
			}
			value += this.peek() === '&' ? this.parseEntity() : this.consumeCodePoint();
		}
		this.consume(quote);
		if (value.length > this.limits.attributeLength) {
			throw new ParadisOfficePackageError('limitExceeded');
		}
		return value;
	}

	private parseCharacterData(cdata: boolean): string {
		let value = '';
		while (this.index < this.xml.length && this.peek() !== '<') {
			if (!cdata && this.startsWith(']]>')) {
				this.malformed();
			}
			value += this.peek() === '&' ? this.parseEntity() : this.consumeCodePoint();
		}
		return value;
	}

	private parseEntity(): string {
		this.consume('&');
		let encoded = '';
		while (this.peek() !== ';') {
			if (this.index >= this.xml.length || this.peek() === '<' || this.peek() === '&') {
				this.malformed();
			}
			encoded += this.consumeCodePoint();
		}
		this.consume(';');
		if (encoded === 'amp') { return '&'; }
		if (encoded === 'lt') { return '<'; }
		if (encoded === 'gt') { return '>'; }
		if (encoded === 'quot') { return '"'; }
		if (encoded === 'apos') { return '\''; }
		if (encoded.startsWith('#x') || encoded.startsWith('#')) {
			const digits = encoded.startsWith('#x') ? encoded.slice(2) : encoded.slice(1);
			const radix = encoded[1] === 'x' ? 16 : 10;
			if (!digits || !isNumber(digits, radix)) {
				this.malformed();
			}
			const codePoint = Number.parseInt(digits, radix);
			if (!Number.isSafeInteger(codePoint) || !isValidXmlCodePoint(codePoint)) {
				this.malformed();
			}
			return String.fromCodePoint(codePoint);
		}
		this.malformed();
	}

	private parseQName(): XmlQName {
		const name = this.parseName();
		const firstColon = name.indexOf(':');
		if (firstColon !== name.lastIndexOf(':')) {
			this.malformed();
		}
		if (firstColon < 0) {
			return { prefix: '', local: name };
		}
		const prefix = name.slice(0, firstColon);
		const local = name.slice(firstColon + 1);
		if (!prefix || !local) {
			this.malformed();
		}
		return { prefix, local };
	}

	private parseName(): string {
		const first = this.peekCodePoint();
		if (first === undefined || !isXmlNameStart(first)) {
			this.malformed();
		}
		let name = this.consumeCodePoint();
		while (true) {
			const codePoint = this.peekCodePoint();
			if (codePoint === undefined || !isXmlNameCharacter(codePoint)) {
				return name;
			}
			name += this.consumeCodePoint();
		}
	}

	private resolveElementUri(name: XmlQName, namespaces: Readonly<Record<string, string>>): string {
		if (name.prefix === 'xmlns') {
			this.malformed();
		}
		if (name.prefix === 'xml') {
			return xmlNamespace;
		}
		if (!name.prefix) {
			return namespaces[''] ?? '';
		}
		const uri = namespaces[name.prefix];
		if (!uri) {
			this.malformed();
		}
		return uri;
	}

	private resolveAttributeUri(name: XmlQName, namespaces: Readonly<Record<string, string>>): string {
		if (!name.prefix) {
			return '';
		}
		if (name.prefix === 'xml') {
			return xmlNamespace;
		}
		const uri = namespaces[name.prefix];
		if (!uri) {
			this.malformed();
		}
		return uri;
	}

	private validateNamespaceBinding(prefix: string, uri: string): void {
		if (!prefix || prefix === 'xmlns' || uri === xmlnsNamespace || prefix === 'xml' && uri !== xmlNamespace || prefix !== 'xml' && uri === xmlNamespace || !uri) {
			this.malformed();
		}
	}

	private appendText(value: string): void {
		this.characters += value.length;
		if (this.characters > this.limits.characters) {
			throw new ParadisOfficePackageError('limitExceeded');
		}
		(this.stack[this.stack.length - 1].node.children as ParadisOfficeXmlNode[]).push({ kind: 'text', value });
		this.recordEvent();
	}

	private skipWhitespace(): boolean {
		let found = false;
		while (isXmlWhitespaceCharacter(this.peek())) {
			this.consumeCodePoint();
			found = true;
		}
		return found;
	}

	private consume(expected: string): void {
		if (this.peek() !== expected) {
			this.malformed();
		}
		this.consumeCodePoint();
	}

	private consumeCodePoint(): string {
		const codePoint = this.peekCodePoint();
		if (codePoint === undefined || !isValidXmlCodePoint(codePoint)) {
			this.malformed();
		}
		const character = String.fromCodePoint(codePoint);
		this.index += character.length;
		this.checkpointIfNeeded();
		return character;
	}

	private peek(): string {
		return this.xml[this.index] ?? '';
	}

	private peekCodePoint(): number | undefined {
		if (this.index >= this.xml.length) {
			return undefined;
		}
		const first = this.xml.charCodeAt(this.index);
		if (first >= 0xd800 && first <= 0xdbff) {
			const second = this.xml.charCodeAt(this.index + 1);
			if (second < 0xdc00 || second > 0xdfff) {
				this.malformed();
			}
			return (first - 0xd800) * 0x400 + second - 0xdc00 + 0x10000;
		}
		if (first >= 0xdc00 && first <= 0xdfff) {
			this.malformed();
		}
		return first;
	}

	private startsWith(value: string): boolean {
		return this.xml.startsWith(value, this.index);
	}

	private recordEvent(): void {
		this.events++;
		this.checkpointIfNeeded();
	}

	private checkpointIfNeeded(): void {
		if (this.index - this.lastCheckpoint >= 4096 || this.events >= 4096) {
			this.checkpointNow();
		}
	}

	private checkpointNow(): void {
		this.checkpoint?.();
		throwIfParadisOfficeCancelled(this.token);
		this.lastCheckpoint = this.index;
		this.events = 0;
	}

	private malformed(): never {
		throw new ParadisOfficePackageError('malformed');
	}
}

function isXmlWhitespace(value: string): boolean {

	for (let index = 0; index < value.length; index++) {
		if (!isXmlWhitespaceCharacter(value[index] ?? '')) {
			return false;
		}
	}
	return true;
}

function isXmlWhitespaceCharacter(value: string): boolean {

	return value === ' ' || value === '\t' || value === '\r' || value === '\n';
}

function isNumber(value: string, radix: number): boolean {

	for (let index = 0; index < value.length; index++) {
		const code = value.charCodeAt(index);
		const digit = code >= 0x30 && code <= 0x39 ? code - 0x30 : code >= 0x41 && code <= 0x46 ? code - 0x41 + 10 : code >= 0x61 && code <= 0x66 ? code - 0x61 + 10 : radix;
		if (digit >= radix) {
			return false;
		}
	}
	return true;
}

function isValidXmlCodePoint(codePoint: number): boolean {

	return codePoint === 0x9 || codePoint === 0xa || codePoint === 0xd || codePoint >= 0x20 && codePoint <= 0xd7ff || codePoint >= 0xe000 && codePoint <= 0xfffd || codePoint >= 0x10000 && codePoint <= 0x10ffff;
}

function isXmlNameStart(codePoint: number): boolean {

	return codePoint === 0x3a || codePoint === 0x5f || codePoint >= 0x41 && codePoint <= 0x5a || codePoint >= 0x61 && codePoint <= 0x7a || codePoint >= 0xc0 && codePoint <= 0xd6 || codePoint >= 0xd8 && codePoint <= 0xf6 || codePoint >= 0xf8 && codePoint <= 0x2ff || codePoint >= 0x370 && codePoint <= 0x37d || codePoint >= 0x37f && codePoint <= 0x1fff || codePoint >= 0x200c && codePoint <= 0x200d || codePoint >= 0x2070 && codePoint <= 0x218f || codePoint >= 0x2c00 && codePoint <= 0x2fef || codePoint >= 0x3001 && codePoint <= 0xd7ff || codePoint >= 0xf900 && codePoint <= 0xfdcf || codePoint >= 0xfdf0 && codePoint <= 0xfffd || codePoint >= 0x10000 && codePoint <= 0xeffff;
}

function isXmlNameCharacter(codePoint: number): boolean {

	return isXmlNameStart(codePoint) || codePoint === 0x2d || codePoint === 0x2e || codePoint >= 0x30 && codePoint <= 0x39 || codePoint === 0xb7 || codePoint >= 0x300 && codePoint <= 0x36f || codePoint >= 0x203f && codePoint <= 0x2040;
}

export interface CanonicalXmlSourceRef {
	readonly path: readonly number[];
	readonly hash: ParadisOfficeFingerprint;
}

export interface CanonicalXmlResult {
	readonly canonical: string;
	readonly hash: ParadisOfficeFingerprint;
	readonly sourceRefs: readonly CanonicalXmlSourceRef[];
	readonly markupCompatibility: readonly { readonly branch: 'choice' | 'fallback'; readonly selected: boolean; readonly hash: ParadisOfficeFingerprint; readonly sourceRef: CanonicalXmlSourceRef }[];
}

/** Canonicalizes namespace-aware adapter output only. */
export function canonicalizeOfficeXml(document: ParadisOfficeXmlDocument, relationshipResolver: (relationshipId: string) => string | undefined, checkpoint?: () => void): CanonicalXmlResult {

	const sourceRefs: CanonicalXmlSourceRef[] = [];
	const markupCompatibility: CanonicalXmlResult['markupCompatibility'][number][] = [];
	const render = (node: ParadisOfficeXmlNode, path: readonly number[], preserve: boolean, inheritedBindings: Readonly<Record<string, string>> = {}): string => {
		checkpoint?.();
		if (node.kind === 'text') { return !preserve && !node.value.trim() ? '' : `{${JSON.stringify(node.value)}}`; }
		const nextPreserve = preserve || node.attributes.some(attribute => attribute.uri === 'http://www.w3.org/XML/1998/namespace' && attribute.local === 'space' && attribute.value === 'preserve');
		const attributes = node.attributes.map(attribute => ({ name: `{${attribute.uri}}${attribute.local}`, value: attribute.local === 'id' ? relationshipResolver(attribute.value) ?? `unresolved:${attribute.value}` : attribute.value })).sort((left, right) => left.name.localeCompare(right.name) || left.value.localeCompare(right.value));
		const bindings = { ...inheritedBindings, ...(node.namespaceBindings ?? {}) };
		const mcBranches = node.children.filter((child): child is Extract<ParadisOfficeXmlNode, { kind: 'element' }> => child.kind === 'element' && child.uri === markupCompatibilityNamespace && (child.local === 'Choice' || child.local === 'Fallback'));
		let children: string;
		if (mcBranches.length > 0) {
			const selected = selectMarkupCompatibilityBranch(mcBranches, bindings);
			const hashes = mcBranches.map((branch, index) => {
				const branchPath = [...path, node.children.indexOf(branch)];
				const canonical = render(branch, branchPath, nextPreserve, bindings);
				const sourceRef = { path: branchPath, hash: sha256Fingerprint(canonical) };
				sourceRefs.push(sourceRef);
				markupCompatibility.push({ branch: branch.local === 'Choice' ? 'choice' : 'fallback', selected: branch === selected, hash: sourceRef.hash, sourceRef });
				return `${branch === selected ? 'selected' : 'opaque'}:${sourceRef.hash.value}:${index}`;
			});
			children = `${node.children.filter(child => !mcBranches.includes(child as Extract<ParadisOfficeXmlNode, { kind: 'element' }>)).map((child, index) => render(child, [...path, index], nextPreserve, bindings)).join('')}[MC:${hashes.join(',')}]`;
		} else {
			children = node.children.map((child, index) => render(child, [...path, index], nextPreserve, bindings)).join('');
		}
		const value = `({${node.uri}}${node.local}${attributes.map(attribute => `[${attribute.name}=${JSON.stringify(attribute.value)}]`).join('')}${children})`;
		if (!isKnownOfficeQName(`{${node.uri}}${node.local}`)) { sourceRefs.push({ path, hash: sha256Fingerprint(value) }); }
		return value;
	};
	const canonical = render(document.root, [0], false);
	return { canonical, hash: sha256Fingerprint(canonical), sourceRefs, markupCompatibility };
}

const markupCompatibilityNamespace = 'http://schemas.openxmlformats.org/markup-compatibility/2006';
const supportedMarkupCompatibilityNamespaces = new Set([
	'http://schemas.openxmlformats.org/wordprocessingml/2006/main',
	'http://schemas.openxmlformats.org/spreadsheetml/2006/main',
	'http://schemas.openxmlformats.org/drawingml/2006/main',
]);

function selectMarkupCompatibilityBranch(branches: readonly Extract<ParadisOfficeXmlNode, { kind: 'element' }>[], inheritedBindings: Readonly<Record<string, string>>): Extract<ParadisOfficeXmlNode, { kind: 'element' }> {

	for (const branch of branches) {
		if (branch.local !== 'Choice') { continue; }
		const requires = branch.attributes.find(attribute => attribute.local === 'Requires' && attribute.uri === '')?.value;
		if (!requires) { continue; }
		const bindings = { ...inheritedBindings, ...(branch.namespaceBindings ?? {}) };
		if (requires.split(/\s+/).every(prefix => supportedMarkupCompatibilityNamespaces.has(bindings[prefix] ?? ''))) {
			return branch;
		}
	}
	return branches.find(branch => branch.local === 'Fallback') ?? branches[0];
}

function isKnownOfficeQName(qname: string): boolean {

	return qname.startsWith('{http://schemas.openxmlformats.org/') || qname.startsWith('{http://schemas.microsoft.com/office/');
}

function validateLimits(limits: ParadisOfficeXmlLimits): void {

	for (const value of [limits.depth, limits.nodes, limits.attributeLength, limits.characters]) {
		if (!Number.isSafeInteger(value) || value < 0) {
			throw new ParadisOfficePackageError('invalid');
		}
	}
}

function sha256Fingerprint(value: string): ParadisOfficeFingerprint {

	const bytes = new TextEncoder().encode(value);
	const words: number[] = [];
	for (let index = 0; index < bytes.length; index++) {
		words[index >> 2] = (words[index >> 2] ?? 0) | (bytes[index] << (24 - (index % 4) * 8));
	}
	words[bytes.length >> 2] = (words[bytes.length >> 2] ?? 0) | (0x80 << (24 - (bytes.length % 4) * 8));
	words[(((bytes.length + 8) >> 6) + 1) * 16 - 1] = bytes.length * 8;
	let h0 = 0x6a09e667; let h1 = 0xbb67ae85; let h2 = 0x3c6ef372; let h3 = 0xa54ff53a;
	let h4 = 0x510e527f; let h5 = 0x9b05688c; let h6 = 0x1f83d9ab; let h7 = 0x5be0cd19;
	for (let offset = 0; offset < words.length; offset += 16) {
		const w = new Array<number>(64);
		for (let index = 0; index < 16; index++) { w[index] = words[offset + index] ?? 0; }
		for (let index = 16; index < 64; index++) {
			const a = w[index - 15]; const b = w[index - 2];
			w[index] = (((a >>> 7 | a << 25) ^ (a >>> 18 | a << 14) ^ (a >>> 3)) + w[index - 16] + ((b >>> 17 | b << 15) ^ (b >>> 19 | b << 13) ^ (b >>> 10)) + w[index - 7]) | 0;
		}
		let a = h0; let b = h1; let c = h2; let d = h3; let e = h4; let f = h5; let g = h6; let h = h7;
		for (let index = 0; index < 64; index++) {
			const s1 = (e >>> 6 | e << 26) ^ (e >>> 11 | e << 21) ^ (e >>> 25 | e << 7);
			const choice = (e & f) ^ (~e & g);
			const temp1 = (h + s1 + choice + SHA256_CONSTANTS[index] + w[index]) | 0;
			const s0 = (a >>> 2 | a << 30) ^ (a >>> 13 | a << 19) ^ (a >>> 22 | a << 10);
			const majority = (a & b) ^ (a & c) ^ (b & c);
			const temp2 = (s0 + majority) | 0;
			h = g; g = f; f = e; e = (d + temp1) | 0; d = c; c = b; b = a; a = (temp1 + temp2) | 0;
		}
		h0 = (h0 + a) | 0; h1 = (h1 + b) | 0; h2 = (h2 + c) | 0; h3 = (h3 + d) | 0;
		h4 = (h4 + e) | 0; h5 = (h5 + f) | 0; h6 = (h6 + g) | 0; h7 = (h7 + h) | 0;
	}
	return { algorithm: 'sha256', value: [h0, h1, h2, h3, h4, h5, h6, h7].map(word => (word >>> 0).toString(16).padStart(8, '0')).join(''), byteLength: bytes.length };
}

const SHA256_CONSTANTS = [
	0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
	0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
	0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
	0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
	0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
	0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
	0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
	0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
];
