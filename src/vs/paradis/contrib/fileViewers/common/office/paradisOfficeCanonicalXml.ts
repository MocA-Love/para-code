/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import type { ParadisOfficeFingerprint } from '../paradisOfficeProtocol.js';
import { ParadisOfficePackageError } from './paradisOfficeArchive.js';

export interface ParadisOfficeXmlLimits {
	readonly depth: number;
	readonly nodes: number;
	readonly attributeLength: number;
	readonly characters: number;
}

export interface CanonicalXmlSourceRef {
	readonly path: readonly number[];
	readonly hash: ParadisOfficeFingerprint;
}

export interface CanonicalXmlResult {
	readonly canonical: string;
	readonly hash: ParadisOfficeFingerprint;
	readonly sourceRefs: readonly CanonicalXmlSourceRef[];
	readonly markupCompatibility: readonly { readonly branch: 'choice' | 'fallback'; readonly hash: ParadisOfficeFingerprint }[];
}

const defaultLimits: ParadisOfficeXmlLimits = { depth: 128, nodes: 2_000_000, attributeLength: 1024 * 1024, characters: 64 * 1024 * 1024 };
const tokenPattern = /<!--[\s\S]*?-->|<\?[^?]*\?>|<!\[CDATA\[[\s\S]*?\]\]>|<[^>]*>|[^<]+/g;
const namePattern = /^[A-Za-z_][A-Za-z0-9._:-]*$/;

interface ElementFrame {
	readonly name: string;
	readonly namespace: ReadonlyMap<string, string>;
	readonly preserve: boolean;
	readonly path: readonly number[];
	children: number;
}

/**
 * Namespace-aware, non-DOM canonicalization for untrusted OOXML. DTDs and every
 * non-predefined entity are rejected before tokenization. The result is stable across
 * prefix, attribute-order, and indentation-only changes.
 */
export function canonicalizeOfficeXml(xml: string, relationshipResolver: (relationshipId: string) => string | undefined, limits: ParadisOfficeXmlLimits = defaultLimits, collectMarkupBranches = true): CanonicalXmlResult {

	if (typeof xml !== 'string' || /<!DOCTYPE|<!ENTITY/i.test(xml)) {
		throw new ParadisOfficePackageError('malformed');
	}
	validateLimits(limits);
	const output: string[] = [];
	const stack: ElementFrame[] = [];
	const sourceRefs: CanonicalXmlSourceRef[] = [];
	let nodes = 0;
	let characters = 0;
	let cursor = 0;
	let match: RegExpExecArray | null;
	while ((match = tokenPattern.exec(xml))) {
		if (match.index !== cursor) {
			throw new ParadisOfficePackageError('malformed');
		}
		cursor = tokenPattern.lastIndex;
		const token = match[0];
		if (token.startsWith('<!--') || token.startsWith('<?')) {
			continue;
		}
		if (token.startsWith('<![CDATA[')) {
			appendText(token.slice(9, -3), stack, output, limits, value => {
				characters += value;
				if (characters > limits.characters) { throw new ParadisOfficePackageError('limitExceeded'); }
			});
			continue;
		}
		if (!token.startsWith('<')) {
			appendText(decodeXml(token), stack, output, limits, value => {
				characters += value;
				if (characters > limits.characters) { throw new ParadisOfficePackageError('limitExceeded'); }
			});
			continue;
		}
		if (token.startsWith('</')) {
			const name = token.slice(2, -1).trim();
			if (!namePattern.test(name) || stack.length === 0 || stack[stack.length - 1].name !== name) {
				throw new ParadisOfficePackageError('malformed');
			}
			output.push(')');
			stack.pop();
			continue;
		}
		if (token.startsWith('<!')) {
			throw new ParadisOfficePackageError('malformed');
		}
		const selfClosing = /\/\s*>$/.test(token);
		const inner = token.slice(1, selfClosing ? -2 : -1).trim();
		const space = inner.search(/\s/);
		const name = space === -1 ? inner : inner.slice(0, space);
		if (!namePattern.test(name)) {
			throw new ParadisOfficePackageError('malformed');
		}
		const rawAttributes = space === -1 ? '' : inner.slice(space).trim();
		const parent = stack[stack.length - 1];
		const namespace = new Map(parent?.namespace ?? []);
		const attributes = parseAttributes(rawAttributes, limits);
		for (const attribute of attributes) {
			if (attribute.name === 'xmlns') {
				namespace.set('', attribute.value);
			} else if (attribute.name.startsWith('xmlns:')) {
				namespace.set(attribute.name.slice(6), attribute.value);
			}
		}
		nodes++;
		if (nodes > limits.nodes || stack.length + 1 > limits.depth) {
			throw new ParadisOfficePackageError('limitExceeded');
		}
		const path = parent ? [...parent.path, parent.children++] : [0];
		const preserve = parent?.preserve === true || attributes.some(attribute => attribute.name === 'xml:space' && attribute.value === 'preserve');
		const qname = canonicalQName(name, namespace);
		const canonicalAttributes = attributes
			.filter(attribute => !attribute.name.startsWith('xmlns'))
			.map(attribute => ({ name: canonicalQName(attribute.name, namespace), value: relationshipValue(attribute.name, attribute.value, relationshipResolver) }))
			.sort((left, right) => left.name.localeCompare(right.name) || left.value.localeCompare(right.value));
		output.push(`(${qname}${canonicalAttributes.map(attribute => `[${attribute.name}=${JSON.stringify(attribute.value)}]`).join('')}`);
		const frame: ElementFrame = { name, namespace, preserve, path, children: 0 };
		if (selfClosing) {
			output.push(')');
			if (!isKnownOfficeQName(qname)) {
				const canonical = output[output.length - 2] + ')';
				sourceRefs.push({ path, hash: sha256Fingerprint(canonical) });
			}
		} else {
			stack.push(frame);
		}
	}
	if (cursor !== xml.length || stack.length !== 0) {
		throw new ParadisOfficePackageError('malformed');
	}
	const canonical = output.join('');
	return { canonical, hash: sha256Fingerprint(canonical), sourceRefs, markupCompatibility: collectMarkupBranches ? markupCompatibilityBranches(xml, relationshipResolver, limits) : [] };
}

function markupCompatibilityBranches(xml: string, resolver: (relationshipId: string) => string | undefined, limits: ParadisOfficeXmlLimits): readonly { readonly branch: 'choice' | 'fallback'; readonly hash: ParadisOfficeFingerprint }[] {

	const declaration = /xmlns:([A-Za-z_][A-Za-z\d._-]*)\s*=\s*["']http:\/\/schemas\.openxmlformats\.org\/markup-compatibility\/2006["']/.exec(xml);
	if (!declaration) {
		return [];
	}
	const prefix = declaration[1];
	const escapedPrefix = prefix.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
	const pattern = new RegExp(`<${escapedPrefix}:(Choice|Fallback)\\b[^>]*>[\\s\\S]*?<\\/${escapedPrefix}:\\1\\s*>`, 'g');
	const branches: { branch: 'choice' | 'fallback'; hash: ParadisOfficeFingerprint }[] = [];
	for (const match of xml.matchAll(pattern)) {
		const wrapper = `<root xmlns:${prefix}="http://schemas.openxmlformats.org/markup-compatibility/2006">${match[0]}</root>`;
		branches.push({ branch: match[1] === 'Choice' ? 'choice' : 'fallback', hash: canonicalizeOfficeXml(wrapper, resolver, limits, false).hash });
	}
	return branches;
}

function appendText(value: string, stack: readonly ElementFrame[], output: string[], limits: ParadisOfficeXmlLimits, account: (count: number) => void): void {

	if (stack.length === 0) {
		if (value.trim()) {
			throw new ParadisOfficePackageError('malformed');
		}
		return;
	}
	account(value.length);
	if (value.length > limits.characters) {
		throw new ParadisOfficePackageError('limitExceeded');
	}
	if (!stack[stack.length - 1].preserve && !value.trim()) {
		return;
	}
	output.push(`{${JSON.stringify(value)}}`);
}

function parseAttributes(source: string, limits: ParadisOfficeXmlLimits): readonly { readonly name: string; readonly value: string }[] {

	const result: { name: string; value: string }[] = [];
	let offset = 0;
	const pattern = /\s*([^\s=]+)\s*=\s*(["'])([\s\S]*?)\2/g;
	let match: RegExpExecArray | null;
	while ((match = pattern.exec(source))) {
		if (match.index !== offset || !namePattern.test(match[1])) {
			throw new ParadisOfficePackageError('malformed');
		}
		offset = pattern.lastIndex;
		const value = decodeXml(match[3]);
		if (value.length > limits.attributeLength) {
			throw new ParadisOfficePackageError('limitExceeded');
		}
		result.push({ name: match[1], value });
	}
	if (source && offset !== source.length) {
		throw new ParadisOfficePackageError('malformed');
	}
	return result;
}

function decodeXml(value: string): string {

	return value.replace(/&(#x[\da-f]+|#\d+|amp|lt|gt|quot|apos);/gi, (entity, encoded: string) => {
		if (encoded === 'amp') { return '&'; }
		if (encoded === 'lt') { return '<'; }
		if (encoded === 'gt') { return '>'; }
		if (encoded === 'quot') { return '"'; }
		if (encoded === 'apos') { return '\''; }
		const codePoint = encoded.startsWith('#x') ? Number.parseInt(encoded.slice(2), 16) : Number.parseInt(encoded.slice(1), 10);
		if (!Number.isSafeInteger(codePoint) || codePoint < 0 || codePoint > 0x10ffff) {
			throw new ParadisOfficePackageError('malformed');
		}
		return String.fromCodePoint(codePoint);
	}).replace(/&[^;]+;/, () => { throw new ParadisOfficePackageError('malformed'); });
}

function canonicalQName(name: string, namespace: ReadonlyMap<string, string>): string {

	const colon = name.indexOf(':');
	const prefix = colon === -1 ? '' : name.slice(0, colon);
	const local = colon === -1 ? name : name.slice(colon + 1);
	const uri = prefix === 'xml' ? 'http://www.w3.org/XML/1998/namespace' : namespace.get(prefix);
	if (prefix && !uri) {
		throw new ParadisOfficePackageError('malformed');
	}
	return `{${uri ?? ''}}${local}`;
}

function relationshipValue(name: string, value: string, resolver: (relationshipId: string) => string | undefined): string {

	return name === 'r:id' || name.endsWith(':id') ? resolver(value) ?? `unresolved:${value}` : value;
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
