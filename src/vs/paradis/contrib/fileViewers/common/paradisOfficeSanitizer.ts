/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import type { ParadisOfficeFingerprint, ParadisOfficePlaceholder } from './paradisOfficeProtocol.js';
import { ParadisOfficePackageError, type ParadisOfficeXmlNode } from './office/paradisOfficeArchive.js';
import { parseParadisOfficeXml } from './office/paradisOfficeCanonicalXml.js';

const SVG_NAMESPACE = 'http://www.w3.org/2000/svg';
const XML_NAMESPACE = 'http://www.w3.org/XML/1998/namespace';
const MAX_SVG_BYTES = 1024 * 1024;
const MAX_SVG_DEPTH = 64;
const MAX_SVG_NODES = 16_384;
const MAX_SVG_ATTRIBUTE_LENGTH = 4_096;
const MAX_FONT_INPUT_BYTES = 128 * 1024 * 1024;
const MAX_FONT_OUTPUT_BYTES = 16 * 1024 * 1024;
const MAX_FONT_EXPANDED_BYTES = 128 * 1024 * 1024;
const MAX_FONT_TABLES = 64;
const MAX_FONT_GLYPHS = 65_535;

export type ParadisOfficeWordCspSource =
	| { readonly kind: 'mountedLoopback'; readonly origins: readonly string[] }
	| { readonly kind: 'webviewResource'; readonly cspSources: readonly string[] };

export interface ParadisOfficeSvgInput {
	readonly nodeId: string;
	readonly assetId: string;
	readonly source: string;
	readonly altText?: string;
}

export interface ParadisSanitizedSvg {
	readonly id: string;
	readonly kind: 'sanitizedSvg';
	readonly mime: 'image/svg+xml';
	readonly bytes: Uint8Array;
	readonly byteLength: number;
	readonly fingerprint: ParadisOfficeFingerprint;
	readonly altText?: string;
}

export interface ParadisOfficeTrustedFontSubset {
	readonly bytes: Uint8Array;
	readonly glyphCount: number;
	readonly expandedByteLength: number;
	readonly hasExternalReferences: boolean;
}

export type ParadisOfficeTrustedFontSubsetter = (sourceSnapshot: Uint8Array, glyphIds: readonly number[]) => ParadisOfficeTrustedFontSubset;

export interface ParadisOfficeFontInput {
	readonly nodeId: string;
	readonly assetId: string;
	readonly source: Uint8Array;
	readonly glyphIds: readonly number[];
	readonly subsetter?: ParadisOfficeTrustedFontSubsetter;
	readonly altText?: string;
}

export interface ParadisRenderableFont {
	readonly id: string;
	readonly kind: 'fontSubset';
	readonly mime: 'font/woff2';
	readonly bytes: Uint8Array;
	readonly byteLength: number;
	readonly fingerprint: ParadisOfficeFingerprint;
	readonly altText?: string;
}

/** Builds the isolated Word webview policy from already-resolved, exact origins only. */
export function buildParadisOfficeWordCsp(nonce: string, source: ParadisOfficeWordCspSource): string {
	if (!/^[A-Za-z\d-]{1,128}$/.test(nonce)) {
		throw new Error('Invalid Office webview nonce');
	}
	const rawSources = source.kind === 'mountedLoopback' ? source.origins : source.cspSources;
	if (rawSources.length === 0 || rawSources.length > 8) {
		throw new Error('Invalid Office webview source count');
	}
	const validated = [...new Set(rawSources.map(value => validateCspOrigin(value, source.kind)))];
	const origins = validated.join(' ');
	return `default-src 'none'; script-src 'nonce-${nonce}' ${origins}; style-src 'unsafe-inline'; img-src data: blob: ${origins}; font-src data: blob: ${origins}; connect-src ${origins} data: blob:; object-src 'none'; frame-src 'none'; worker-src 'none'; base-uri 'none'; form-action 'none'; navigate-to 'none';`;
}

/** Converts a resource URL to the one exact origin permitted by the fallback CSP. */
export function paradisOfficeWebviewResourceOrigin(resourceUrl: string): string {
	const parsed = new URL(resourceUrl);
	if (parsed.protocol !== 'https:' || !parsed.hostname || parsed.username || parsed.password) {
		throw new Error('Invalid Office webview resource URL');
	}
	return parsed.origin;
}

/** Parses and reserializes only the SVG primitive allowlist. */
export function sanitizeOfficeSvg(input: ParadisOfficeSvgInput): ParadisSanitizedSvg | ParadisOfficePlaceholder {
	const snapshot = snapshotSvgInput(input);
	if (!snapshot) {
		return placeholder('office-svg', 'svg', 'unsafe', fingerprint(new Uint8Array()).value);
	}
	if (snapshot.source.length > MAX_SVG_BYTES) {
		const boundedIdentity = new TextEncoder().encode(`oversized-svg:${snapshot.source.length}`);
		return placeholder(snapshot.nodeId, 'svg', 'budget', fingerprint(boundedIdentity).value);
	}
	const rawBytes = new TextEncoder().encode(snapshot.source);
	const rawFingerprint = fingerprint(rawBytes);
	if (rawBytes.byteLength > MAX_SVG_BYTES) {
		return placeholder(snapshot.nodeId, 'svg', 'budget', rawFingerprint.value);
	}
	try {
		if (/<!DOCTYPE|<!ENTITY|<\?(?!xml(?:\s|\?>))|<!--|&(?:#|[A-Za-z])/i.test(snapshot.source)) {
			throw new UnsafeAssetError();
		}
		const document = parseParadisOfficeXml(snapshot.source, {
			depth: MAX_SVG_DEPTH,
			nodes: MAX_SVG_NODES,
			attributeLength: MAX_SVG_ATTRIBUTE_LENGTH,
			characters: MAX_SVG_BYTES,
		});
		if (document.root.uri !== SVG_NAMESPACE || document.root.local !== 'svg') {
			throw new UnsafeAssetError();
		}
		const canonical = serializeSvgNode(document.root, true);
		const bytes = new TextEncoder().encode(canonical);
		if (bytes.byteLength > MAX_SVG_BYTES) {
			return placeholder(snapshot.nodeId, 'svg', 'budget', rawFingerprint.value);
		}
		return withOptionalAltText({
			id: snapshot.assetId,
			kind: 'sanitizedSvg' as const,
			mime: 'image/svg+xml' as const,
			bytes: bytes.slice(),
			byteLength: bytes.byteLength,
			fingerprint: fingerprint(bytes),
		}, snapshot.altText);
	} catch (error) {
		const reason = error instanceof ParadisOfficePackageError && error.code === 'limitExceeded' ? 'budget' : 'unsafe';
		return placeholder(snapshot.nodeId, 'svg', reason, rawFingerprint.value);
	}
}

function snapshotSvgInput(input: ParadisOfficeSvgInput): ParadisOfficeSvgInput | undefined {
	const values = dataProperties(input, ['nodeId', 'assetId', 'source'], ['altText']);
	if (!values
		|| !isAssetId(values.nodeId)
		|| !isAssetId(values.assetId)
		|| typeof values.source !== 'string'
		|| values.altText !== undefined && (typeof values.altText !== 'string' || values.altText.length > 4_096)) {
		return undefined;
	}
	return withOptionalAltText({ nodeId: values.nodeId, assetId: values.assetId, source: values.source }, values.altText as string | undefined);
}

function snapshotFontInput(input: ParadisOfficeFontInput): ParadisOfficeFontInput | undefined {
	const values = dataProperties(input, ['nodeId', 'assetId', 'source', 'glyphIds'], ['subsetter', 'altText']);
	if (!values
		|| !isAssetId(values.nodeId)
		|| !isAssetId(values.assetId)
		|| !(values.source instanceof Uint8Array)
		|| isSharedBytes(values.source)
		|| !Array.isArray(values.glyphIds)
		|| !values.glyphIds.every(value => typeof value === 'number')
		|| values.subsetter !== undefined && typeof values.subsetter !== 'function'
		|| values.altText !== undefined && (typeof values.altText !== 'string' || values.altText.length > 4_096)) {
		return undefined;
	}
	return withOptionalAltText({
		nodeId: values.nodeId,
		assetId: values.assetId,
		source: values.source,
		glyphIds: [...values.glyphIds],
		...(values.subsetter === undefined ? {} : { subsetter: values.subsetter as ParadisOfficeTrustedFontSubsetter }),
	}, values.altText as string | undefined);
}

function snapshotTrustedSubset(value: ParadisOfficeTrustedFontSubset): ParadisOfficeTrustedFontSubset | undefined {
	const values = dataProperties(value, ['bytes', 'glyphCount', 'expandedByteLength', 'hasExternalReferences'], []);
	if (!values || !(values.bytes instanceof Uint8Array) || isSharedBytes(values.bytes)) {
		return undefined;
	}
	return {
		bytes: values.bytes,
		glyphCount: values.glyphCount as number,
		expandedByteLength: values.expandedByteLength as number,
		hasExternalReferences: values.hasExternalReferences as boolean,
	};
}

function dataProperties(value: object, required: readonly string[], optional: readonly string[]): Record<string, unknown> | undefined {
	let descriptors: PropertyDescriptorMap;
	try {
		descriptors = Object.getOwnPropertyDescriptors(value);
	} catch {
		return undefined;
	}
	const names = Object.keys(descriptors);
	if (names.length < required.length || names.some(name => !required.includes(name) && !optional.includes(name))) {
		return undefined;
	}
	const result: Record<string, unknown> = {};
	for (const name of required) {
		const descriptor = descriptors[name];
		if (!descriptor || !Object.prototype.hasOwnProperty.call(descriptor, 'value')) { return undefined; }
		result[name] = descriptor.value;
	}
	for (const name of optional) {
		const descriptor = descriptors[name];
		if (descriptor && !Object.prototype.hasOwnProperty.call(descriptor, 'value')) { return undefined; }
		result[name] = descriptor?.value;
	}
	return result;
}

function isAssetId(value: unknown): value is string {
	return typeof value === 'string' && /^[A-Za-z\d][A-Za-z\d:_-]{0,255}$/.test(value);
}

function isSharedBytes(value: Uint8Array): boolean {
	return typeof SharedArrayBuffer !== 'undefined' && value.buffer instanceof SharedArrayBuffer;
}

/** Validates raw font structure, delegates subsetting, and publishes only revalidated WOFF2. */
export function validateAndSubsetOfficeFont(input: ParadisOfficeFontInput): ParadisRenderableFont | ParadisOfficePlaceholder {
	const snapshot = snapshotFontInput(input);
	if (!snapshot) {
		return placeholder('office-font', 'embeddedFont', 'unsafe', fingerprint(new Uint8Array()).value);
	}
	if (snapshot.source.byteLength > MAX_FONT_INPUT_BYTES) {
		return placeholder(snapshot.nodeId, 'embeddedFont', 'budget', fingerprint(snapshot.source).value);
	}
	const source = snapshot.source.slice();
	const rawFingerprint = fingerprint(source);
	let inspected: InspectedFont;
	try {
		inspected = inspectFont(source);
		if (!inspected.tables.has('maxp')) { throw new UnsafeAssetError(); }
		validateGlyphIds(snapshot.glyphIds, inspected.glyphCount);
	} catch (error) {
		return placeholder(snapshot.nodeId, 'embeddedFont', error instanceof AssetBudgetError ? 'budget' : 'unsafe', rawFingerprint.value);
	}
	if (!snapshot.subsetter) {
		return placeholder(snapshot.nodeId, 'embeddedFont', 'unsupported', rawFingerprint.value);
	}
	try {
		const trusted = snapshotTrustedSubset(snapshot.subsetter(source.slice(), [...snapshot.glyphIds]));
		if (!trusted || !(trusted.bytes instanceof Uint8Array)
			|| !Number.isSafeInteger(trusted.glyphCount) || trusted.glyphCount < 1 || trusted.glyphCount > MAX_FONT_GLYPHS
			|| !Number.isSafeInteger(trusted.expandedByteLength) || trusted.expandedByteLength < 0 || trusted.expandedByteLength > MAX_FONT_EXPANDED_BYTES
			|| trusted.hasExternalReferences !== false) {
			throw new UnsafeAssetError();
		}
		const subsetBytes = trusted.bytes.slice();
		if (subsetBytes.byteLength > MAX_FONT_OUTPUT_BYTES) {
			throw new AssetBudgetError();
		}
		const output = inspectWoff2(subsetBytes);
		if (output.expandedByteLength !== trusted.expandedByteLength || output.tables.has('SVG ') || !output.tables.has('maxp')) {
			throw new UnsafeAssetError();
		}
		return withOptionalAltText({
			id: snapshot.assetId,
			kind: 'fontSubset' as const,
			mime: 'font/woff2' as const,
			bytes: subsetBytes,
			byteLength: subsetBytes.byteLength,
			fingerprint: fingerprint(subsetBytes),
		}, snapshot.altText);
	} catch (error) {
		return placeholder(snapshot.nodeId, 'embeddedFont', error instanceof AssetBudgetError ? 'budget' : 'unsafe', rawFingerprint.value);
	}
}

function validateCspOrigin(value: string, kind: ParadisOfficeWordCspSource['kind']): string {
	if (!value || /[\s;'"*]/.test(value)) {
		throw new Error('Invalid Office webview CSP source');
	}
	let parsed: URL;
	try {
		parsed = new URL(value);
	} catch {
		throw new Error('Invalid Office webview CSP source');
	}
	if (parsed.origin !== value || parsed.pathname !== '/' || parsed.search || parsed.hash || parsed.username || parsed.password) {
		throw new Error('Office webview CSP sources must be exact origins');
	}
	if (kind === 'mountedLoopback') {
		if (parsed.protocol !== 'http:' || parsed.hostname !== '127.0.0.1' || !parsed.port) {
			throw new Error('Office preview mounts require an exact loopback port');
		}
	} else if (parsed.protocol !== 'https:') {
		throw new Error('Office webview resources require an exact HTTPS origin');
	}
	return value;
}

const SVG_ELEMENTS = new Set([
	'svg', 'g', 'path', 'rect', 'circle', 'ellipse', 'line', 'polyline', 'polygon', 'text', 'tspan', 'defs', 'clipPath', 'linearGradient', 'radialGradient', 'stop'
]);

const COMMON_SVG_ATTRIBUTES = new Set([
	'id', 'transform', 'fill', 'fill-opacity', 'stroke', 'stroke-width', 'stroke-opacity', 'stroke-linecap', 'stroke-linejoin', 'stroke-miterlimit', 'opacity'
]);

const SVG_ELEMENT_ATTRIBUTES: Readonly<Record<string, ReadonlySet<string>>> = {
	svg: new Set(['viewBox', 'width', 'height', 'preserveAspectRatio']),
	g: new Set(),
	path: new Set(['d', 'pathLength']),
	rect: new Set(['x', 'y', 'width', 'height', 'rx', 'ry']),
	circle: new Set(['cx', 'cy', 'r']),
	ellipse: new Set(['cx', 'cy', 'rx', 'ry']),
	line: new Set(['x1', 'y1', 'x2', 'y2']),
	polyline: new Set(['points']),
	polygon: new Set(['points']),
	text: new Set(['x', 'y', 'dx', 'dy', 'text-anchor', 'dominant-baseline', 'font-family', 'font-size', 'font-style', 'font-weight']),
	tspan: new Set(['x', 'y', 'dx', 'dy', 'text-anchor', 'dominant-baseline', 'font-family', 'font-size', 'font-style', 'font-weight']),
	defs: new Set(),
	clipPath: new Set(['id', 'clipPathUnits']),
	linearGradient: new Set(['id', 'x1', 'y1', 'x2', 'y2', 'gradientUnits', 'gradientTransform', 'spreadMethod']),
	radialGradient: new Set(['id', 'cx', 'cy', 'r', 'fx', 'fy', 'fr', 'gradientUnits', 'gradientTransform', 'spreadMethod']),
	stop: new Set(['offset', 'stop-color', 'stop-opacity']),
};

function serializeSvgNode(node: ParadisOfficeXmlNode, root: boolean): string {
	if (node.kind === 'text') {
		return escapeXmlText(node.value);
	}
	if (node.uri !== SVG_NAMESPACE || !SVG_ELEMENTS.has(node.local)) {
		throw new UnsafeAssetError();
	}
	for (const uri of Object.values(node.namespaceBindings ?? {})) {
		if (uri !== SVG_NAMESPACE) {
			throw new UnsafeAssetError();
		}
	}
	const attributes = node.attributes.map(attribute => {
		if (attribute.uri !== '' && !(attribute.uri === XML_NAMESPACE && attribute.local === 'space')) {
			throw new UnsafeAssetError();
		}
		const name = attribute.uri === XML_NAMESPACE ? `xml:${attribute.local}` : attribute.local;
		if (/^on/i.test(name) || name === 'style' || name === 'href' || name.endsWith(':href')) {
			throw new UnsafeAssetError();
		}
		const allowed = name === 'xml:space' || COMMON_SVG_ATTRIBUTES.has(name) || SVG_ELEMENT_ATTRIBUTES[node.local]?.has(name);
		if (!allowed || !validateSvgAttribute(name, attribute.value)) {
			throw new UnsafeAssetError();
		}
		return { name, value: normalizeSvgAttribute(name, attribute.value) };
	}).sort((left, right) => left.name.localeCompare(right.name));
	const serializedAttributes = [
		...(root ? [{ name: 'xmlns', value: SVG_NAMESPACE }] : []),
		...attributes,
	].map(attribute => ` ${attribute.name}="${escapeXmlAttribute(attribute.value)}"`).join('');
	const children = node.children.map(child => serializeSvgNode(child, false)).join('');
	return children ? `<${node.local}${serializedAttributes}>${children}</${node.local}>` : `<${node.local}${serializedAttributes}/>`;
}

function validateSvgAttribute(name: string, rawValue: string): boolean {
	const value = rawValue.trim();
	if (!value || /url\s*\(|data:|(?:https?|file|javascript|vbscript):|[\u0000-\u0008\u000b\u000c\u000e-\u001f]/i.test(value)) {
		return false;
	}
	if (name === 'id') { return /^[A-Za-z_][A-Za-z\d_.-]{0,127}$/.test(value); }
	if (name === 'd') { return value.length <= 65_536 && /^[MmZzLlHhVvCcSsQqTtAaEe\d+.,\-\s]+$/.test(value); }
	if (name === 'points') { return value.length <= 65_536 && /^[Ee\d+.,\-\s]+$/.test(value); }
	if (name === 'transform' || name === 'gradientTransform') {
		return /^(?:(?:matrix|translate|scale|rotate|skewX|skewY)\s*\([Ee\d+.,\-\s]+\)\s*)+$/.test(value);
	}
	if (name === 'viewBox') { return numericList(value, 4); }
	if (name === 'preserveAspectRatio') { return /^(?:none|x(?:Min|Mid|Max)Y(?:Min|Mid|Max)(?:\s+(?:meet|slice))?)$/.test(value); }
	if (name === 'fill' || name === 'stroke' || name === 'stop-color') { return isSvgColor(value); }
	if (name === 'stroke-linecap') { return value === 'butt' || value === 'round' || value === 'square'; }
	if (name === 'stroke-linejoin') { return value === 'miter' || value === 'round' || value === 'bevel'; }
	if (name === 'text-anchor') { return value === 'start' || value === 'middle' || value === 'end'; }
	if (name === 'dominant-baseline') { return /^(?:auto|middle|central|hanging|text-before-edge|text-after-edge|alphabetic)$/.test(value); }
	if (name === 'font-style') { return value === 'normal' || value === 'italic' || value === 'oblique'; }
	if (name === 'font-weight') { return /^(?:normal|bold|[1-9]00)$/.test(value); }
	if (name === 'font-family') { return value.length <= 256 && /^[\p{L}\p{N} _,'".-]+$/u.test(value); }
	if (name === 'clipPathUnits' || name === 'gradientUnits') { return value === 'userSpaceOnUse' || value === 'objectBoundingBox'; }
	if (name === 'spreadMethod') { return value === 'pad' || value === 'reflect' || value === 'repeat'; }
	if (name === 'xml:space') { return value === 'default' || value === 'preserve'; }
	if (name === 'opacity' || name === 'fill-opacity' || name === 'stroke-opacity' || name === 'stop-opacity') { return isUnitInterval(value); }
	if (name === 'offset') { return isGradientOffset(value); }
	if (name === 'width' || name === 'height' || name === 'r' || name === 'rx' || name === 'ry' || name === 'pathLength' || name === 'stroke-width' || name === 'font-size') {
		return isSvgLength(value, false);
	}
	if (name === 'stroke-miterlimit') {
		return isSvgLength(value, false) && Number(value) >= 1;
	}
	return isSvgLength(value, true);
}

function normalizeSvgAttribute(_name: string, value: string): string {
	return value.trim().replace(/\s+/g, ' ');
}

function numericList(value: string, count: number): boolean {
	const values = value.trim().split(/[\s,]+/);
	return values.length === count && values.every(isBoundedNumber);
}

function isSvgLength(value: string, allowNegative: boolean): boolean {
	const match = /^([+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?)(px|pt|pc|cm|mm|in|%)?$/.exec(value);
	return !!match && isBoundedNumber(match[1]) && (allowNegative || Number(match[1]) >= 0);
}

function isUnitInterval(value: string): boolean {
	const parsed = Number(value);
	return isBoundedNumber(value) && parsed >= 0 && parsed <= 1;
}

function isGradientOffset(value: string): boolean {
	if (value.endsWith('%')) {
		const parsed = Number(value.slice(0, -1));
		return Number.isFinite(parsed) && parsed >= 0 && parsed <= 100;
	}
	return isUnitInterval(value);
}

function isBoundedNumber(value: string): boolean {
	const parsed = Number(value);
	return Number.isFinite(parsed) && Math.abs(parsed) <= 10_000_000;
}

function isSvgColor(value: string): boolean {
	return value === 'none' || value === 'transparent' || value === 'currentColor'
		|| /^(?:#[a-f\d]{3}|#[a-f\d]{4}|#[a-f\d]{6}|#[a-f\d]{8})$/i.test(value)
		|| /^(?:black|white|red|green|blue|gray|grey|yellow|orange|purple)$/i.test(value)
		|| isRgbColor(value);
}

function isRgbColor(value: string): boolean {
	const match = /^rgba?\(\s*(\d{1,3})\s*,\s*(\d{1,3})\s*,\s*(\d{1,3})(?:\s*,\s*(0(?:\.\d+)?|1(?:\.0+)?))?\s*\)$/.exec(value);
	return !!match && [match[1], match[2], match[3]].every(component => Number(component) <= 255);
}

function escapeXmlText(value: string): string {
	return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function escapeXmlAttribute(value: string): string {
	return escapeXmlText(value).replace(/"/g, '&quot;');
}

interface InspectedFont {
	readonly tables: ReadonlySet<string>;
	readonly glyphCount?: number;
	readonly expandedByteLength: number;
}

interface FontTableRecord {
	readonly tag: string;
	readonly offset: number;
	readonly length: number;
}

function inspectFont(bytes: Uint8Array): InspectedFont {
	if (bytes.byteLength < 4) { throw new UnsafeAssetError(); }
	const scalar = readU32(bytes, 0);
	if (scalar === 0x00010000) { return inspectSfnt(bytes); }
	const signature = readTag(bytes, 0);
	if (signature === 'wOF2') { return inspectWoff2(bytes); }
	if (signature === 'wOFF') { return inspectWoff(bytes); }
	if (signature === 'OTTO' || signature === 'true' || signature === 'typ1') {
		return inspectSfnt(bytes);
	}
	throw new UnsafeAssetError();
}

function inspectSfnt(bytes: Uint8Array): InspectedFont {
	requireRange(bytes, 0, 12);
	const tableCount = readU16(bytes, 4);
	validateTableCount(tableCount);
	const directoryEnd = 12 + tableCount * 16;
	requireRange(bytes, 12, tableCount * 16);
	const records: FontTableRecord[] = [];
	const tags = new Set<string>();
	for (let index = 0; index < tableCount; index++) {
		const recordOffset = 12 + index * 16;
		const tag = readTag(bytes, recordOffset);
		const checksum = readU32(bytes, recordOffset + 4);
		const offset = readU32(bytes, recordOffset + 8);
		const length = readU32(bytes, recordOffset + 12);
		if (tags.has(tag) || offset % 4 !== 0 || offset < directoryEnd) { throw new UnsafeAssetError(); }
		requireRange(bytes, offset, length);
		if (fontTableChecksum(bytes, offset, length, tag === 'head') !== checksum) { throw new UnsafeAssetError(); }
		tags.add(tag);
		records.push({ tag, offset, length });
	}
	validateFontTables(records, tags);
	return { tables: tags, glyphCount: sfntGlyphCount(bytes, records), expandedByteLength: bytes.byteLength };
}

function inspectWoff(bytes: Uint8Array): InspectedFont {
	requireRange(bytes, 0, 44);
	if (readU32(bytes, 8) !== bytes.byteLength || readU16(bytes, 14) !== 0) { throw new UnsafeAssetError(); }
	const tableCount = readU16(bytes, 12);
	validateTableCount(tableCount);
	const directoryEnd = 44 + tableCount * 20;
	const expandedByteLength = readU32(bytes, 16);
	if (expandedByteLength < 12 + tableCount * 16) { throw new UnsafeAssetError(); }
	if (expandedByteLength > MAX_FONT_EXPANDED_BYTES) { throw new AssetBudgetError(); }
	requireRange(bytes, 44, tableCount * 20);
	const records: FontTableRecord[] = [];
	const tags = new Set<string>();
	let glyphCount: number | undefined;
	for (let index = 0; index < tableCount; index++) {
		const recordOffset = 44 + index * 20;
		const tag = readTag(bytes, recordOffset);
		const offset = readU32(bytes, recordOffset + 4);
		const compressedLength = readU32(bytes, recordOffset + 8);
		const originalLength = readU32(bytes, recordOffset + 12);
		const checksum = readU32(bytes, recordOffset + 16);
		if (tags.has(tag) || offset % 4 !== 0 || offset < directoryEnd || compressedLength > originalLength) { throw new UnsafeAssetError(); }
		requireRange(bytes, offset, compressedLength);
		if (compressedLength === originalLength && fontTableChecksum(bytes, offset, originalLength, tag === 'head') !== checksum) { throw new UnsafeAssetError(); }
		if (tag === 'maxp' && compressedLength === originalLength) { glyphCount = maxpGlyphCount(bytes, offset, originalLength); }
		tags.add(tag);
		records.push({ tag, offset, length: compressedLength });
	}
	validateFontTables(records, tags);
	return { tables: tags, glyphCount, expandedByteLength };
}

function inspectWoff2(bytes: Uint8Array): InspectedFont {
	requireRange(bytes, 0, 48);
	if (readTag(bytes, 0) !== 'wOF2' || readU32(bytes, 8) !== bytes.byteLength || readU16(bytes, 14) !== 0) {
		throw new UnsafeAssetError();
	}
	const tableCount = readU16(bytes, 12);
	validateTableCount(tableCount);
	const expandedByteLength = readU32(bytes, 16);
	if (expandedByteLength < 12 + tableCount * 16) { throw new UnsafeAssetError(); }
	if (expandedByteLength > MAX_FONT_EXPANDED_BYTES) { throw new AssetBudgetError(); }
	const compressedLength = readU32(bytes, 20);
	if (compressedLength < 1) { throw new UnsafeAssetError(); }
	let offset = 48;
	const tags = new Set<string>();
	for (let index = 0; index < tableCount; index++) {
		requireRange(bytes, offset, 1);
		const flags = bytes[offset++];
		const tagIndex = flags & 0x3f;
		const tag = tagIndex === 0x3f ? readTag(bytes, offset) : WOFF2_KNOWN_TAGS[tagIndex];
		if (tagIndex === 0x3f) { offset += 4; }
		if (!tag || tags.has(tag)) { throw new UnsafeAssetError(); }
		const original = readBase128(bytes, offset); offset = original.next;
		const transformVersion = flags >>> 6;
		const transformed = (tag === 'glyf' || tag === 'loca') ? transformVersion === 0 : transformVersion !== 0;
		if (transformed) {
			const transformedLength = readBase128(bytes, offset);
			offset = transformedLength.next;
		}
		tags.add(tag);
	}
	requireRange(bytes, offset, compressedLength);
	const compressedEnd = offset + compressedLength;
	const metadataOffset = readU32(bytes, 28);
	const metadataLength = readU32(bytes, 32);
	const metadataExpandedLength = readU32(bytes, 36);
	const privateOffset = readU32(bytes, 40);
	const privateLength = readU32(bytes, 44);
	if (metadataOffset === 0 ? metadataLength !== 0 || metadataExpandedLength !== 0 : metadataLength < 1 || metadataExpandedLength < 1) {
		throw new UnsafeAssetError();
	}
	if (metadataExpandedLength > MAX_FONT_EXPANDED_BYTES) { throw new AssetBudgetError(); }
	if (privateOffset === 0 ? privateLength !== 0 : privateLength < 1) { throw new UnsafeAssetError(); }
	const optionalRanges = [
		...(metadataOffset === 0 ? [] : [{ offset: metadataOffset, length: metadataLength }]),
		...(privateOffset === 0 ? [] : [{ offset: privateOffset, length: privateLength }]),
	].sort((left, right) => left.offset - right.offset);
	for (const range of optionalRanges) {
		if (range.offset < compressedEnd) { throw new UnsafeAssetError(); }
		requireRange(bytes, range.offset, range.length);
	}
	for (let index = 1; index < optionalRanges.length; index++) {
		if (optionalRanges[index].offset < optionalRanges[index - 1].offset + optionalRanges[index - 1].length) { throw new UnsafeAssetError(); }
	}
	if (tags.has('SVG ')) { throw new UnsafeAssetError(); }
	return { tables: tags, expandedByteLength };
}

function validateFontTables(records: readonly FontTableRecord[], tags: ReadonlySet<string>): void {
	if (tags.has('SVG ')) { throw new UnsafeAssetError(); }
	const sorted = [...records].sort((left, right) => left.offset - right.offset || left.length - right.length);
	for (let index = 1; index < sorted.length; index++) {
		if (sorted[index - 1].length > 0 && sorted[index].length > 0 && sorted[index].offset < sorted[index - 1].offset + sorted[index - 1].length) {
			throw new UnsafeAssetError();
		}
	}
}

function validateTableCount(value: number): void {
	if (!Number.isSafeInteger(value) || value < 1 || value > MAX_FONT_TABLES) {
		throw value > MAX_FONT_TABLES ? new AssetBudgetError() : new UnsafeAssetError();
	}
}

function sfntGlyphCount(bytes: Uint8Array, records: readonly FontTableRecord[]): number | undefined {
	const maxp = records.find(record => record.tag === 'maxp');
	return maxp ? maxpGlyphCount(bytes, maxp.offset, maxp.length) : undefined;
}

function maxpGlyphCount(bytes: Uint8Array, offset: number, length: number): number {
	if (length < 6) { throw new UnsafeAssetError(); }
	const glyphCount = readU16(bytes, offset + 4);
	if (glyphCount < 1 || glyphCount > MAX_FONT_GLYPHS) { throw new AssetBudgetError(); }
	return glyphCount;
}

function validateGlyphIds(glyphIds: readonly number[], sourceGlyphCount: number | undefined): void {
	if (glyphIds.length > MAX_FONT_GLYPHS) { throw new AssetBudgetError(); }
	const seen = new Set<number>();
	for (const glyphId of glyphIds) {
		if (!Number.isSafeInteger(glyphId) || glyphId < 0 || glyphId > MAX_FONT_GLYPHS || sourceGlyphCount !== undefined && glyphId >= sourceGlyphCount || seen.has(glyphId)) {
			throw new UnsafeAssetError();
		}
		seen.add(glyphId);
	}
}

function fontTableChecksum(bytes: Uint8Array, offset: number, length: number, head: boolean): number {
	let sum = 0;
	for (let index = 0; index < length; index += 4) {
		let word = 0;
		for (let byte = 0; byte < 4; byte++) {
			const tableIndex = index + byte;
			const value = head && tableIndex >= 8 && tableIndex < 12 ? 0 : tableIndex < length ? bytes[offset + tableIndex] : 0;
			word = (word << 8) | value;
		}
		sum = (sum + (word >>> 0)) >>> 0;
	}
	return sum;
}

function requireRange(bytes: Uint8Array, offset: number, length: number): void {
	const end = offset + length;
	if (!Number.isSafeInteger(offset) || !Number.isSafeInteger(length) || offset < 0 || length < 0 || !Number.isSafeInteger(end) || end > bytes.byteLength) {
		throw new UnsafeAssetError();
	}
}

function readTag(bytes: Uint8Array, offset: number): string {
	requireRange(bytes, offset, 4);
	let value = '';
	for (let index = 0; index < 4; index++) {
		const code = bytes[offset + index];
		if (code < 0x20 || code > 0x7e) { throw new UnsafeAssetError(); }
		value += String.fromCharCode(code);
	}
	return value;
}

function readU16(bytes: Uint8Array, offset: number): number {
	requireRange(bytes, offset, 2);
	return bytes[offset] * 0x100 + bytes[offset + 1];
}

function readU32(bytes: Uint8Array, offset: number): number {
	requireRange(bytes, offset, 4);
	return (bytes[offset] * 0x1000000 + bytes[offset + 1] * 0x10000 + bytes[offset + 2] * 0x100 + bytes[offset + 3]) >>> 0;
}

function readBase128(bytes: Uint8Array, offset: number): { readonly value: number; readonly next: number } {
	let value = 0;
	for (let count = 0; count < 5; count++) {
		requireRange(bytes, offset, 1);
		const byte = bytes[offset++];
		if (count === 0 && byte === 0x80 || value > 0x01ffffff) { throw new UnsafeAssetError(); }
		value = value * 128 + (byte & 0x7f);
		if ((byte & 0x80) === 0) { return { value, next: offset }; }
	}
	throw new UnsafeAssetError();
}

const WOFF2_KNOWN_TAGS = [
	'cmap', 'head', 'hhea', 'hmtx', 'maxp', 'name', 'OS/2', 'post', 'cvt ', 'fpgm', 'glyf', 'loca', 'prep', 'CFF ', 'VORG', 'EBDT',
	'EBLC', 'gasp', 'hdmx', 'kern', 'LTSH', 'PCLT', 'VDMX', 'vhea', 'vmtx', 'BASE', 'GDEF', 'GPOS', 'GSUB', 'EBSC', 'JSTF', 'MATH',
	'CBDT', 'CBLC', 'COLR', 'CPAL', 'SVG ', 'sbix', 'acnt', 'avar', 'bdat', 'bloc', 'bsln', 'cvar', 'fdsc', 'feat', 'fmtx', 'fvar',
	'gvar', 'hsty', 'just', 'lcar', 'mort', 'morx', 'opbd', 'prop', 'trak', 'Zapf', 'Silf', 'Glat', 'Gloc', 'Feat', 'Sill'
] as const;

function placeholder(nodeId: string, feature: string, reason: ParadisOfficePlaceholder['reason'], fingerprintValue: string): ParadisOfficePlaceholder {
	return {
		nodeId,
		feature,
		reason,
		title: feature === 'svg' ? 'SVG preview unavailable' : 'Embedded font unavailable',
		fingerprint: fingerprintValue,
	};
}

function withOptionalAltText<T extends object>(value: T, altText: string | undefined): T & { readonly altText?: string } {
	return altText === undefined ? value : { ...value, altText };
}

class UnsafeAssetError extends Error { }
class AssetBudgetError extends Error { }

function fingerprint(bytes: Uint8Array): ParadisOfficeFingerprint {
	let h0 = 0x6a09e667; let h1 = 0xbb67ae85; let h2 = 0x3c6ef372; let h3 = 0xa54ff53a;
	let h4 = 0x510e527f; let h5 = 0x9b05688c; let h6 = 0x1f83d9ab; let h7 = 0x5be0cd19;
	const processBlock = (block: Uint8Array, offset: number): void => {
		const w = new Array<number>(64);
		for (let index = 0; index < 16; index++) {
			const wordOffset = offset + index * 4;
			w[index] = block[wordOffset] * 0x1000000 + block[wordOffset + 1] * 0x10000 + block[wordOffset + 2] * 0x100 + block[wordOffset + 3];
		}
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
	};
	const completeBytes = bytes.byteLength - bytes.byteLength % 64;
	for (let offset = 0; offset < completeBytes; offset += 64) {
		processBlock(bytes, offset);
	}
	const remaining = bytes.byteLength - completeBytes;
	const paddingLength = remaining < 56 ? 64 : 128;
	const padding = new Uint8Array(paddingLength);
	padding.set(bytes.subarray(completeBytes));
	padding[remaining] = 0x80;
	const bitLengthHigh = Math.floor(bytes.byteLength / 0x20000000);
	const bitLengthLow = (bytes.byteLength * 8) >>> 0;
	const lengthOffset = paddingLength - 8;
	padding[lengthOffset] = bitLengthHigh >>> 24;
	padding[lengthOffset + 1] = bitLengthHigh >>> 16;
	padding[lengthOffset + 2] = bitLengthHigh >>> 8;
	padding[lengthOffset + 3] = bitLengthHigh;
	padding[lengthOffset + 4] = bitLengthLow >>> 24;
	padding[lengthOffset + 5] = bitLengthLow >>> 16;
	padding[lengthOffset + 6] = bitLengthLow >>> 8;
	padding[lengthOffset + 7] = bitLengthLow;
	for (let offset = 0; offset < padding.byteLength; offset += 64) {
		processBlock(padding, offset);
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
] as const;
