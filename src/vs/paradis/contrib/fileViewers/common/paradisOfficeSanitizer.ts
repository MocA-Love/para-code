/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import type { CancellationToken } from '../../../../base/common/cancellation.js';
import type { ParadisOfficeFingerprint, ParadisOfficePlaceholder, ParadisOfficeRenderableAsset } from './paradisOfficeProtocol.js';
import { canonicalizeParadisOfficeArchiveName, ParadisOfficePackageError, throwIfParadisOfficeCancelled, type ParadisOfficeArchiveEntry, type ParadisOfficeXmlNode } from './office/paradisOfficeArchive.js';
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
	readonly rawFingerprint?: ParadisOfficeFingerprint;
	readonly token?: CancellationToken;
	readonly checkpoint?: () => void;
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
}

export type ParadisOfficeTrustedFontSubsetter = (sourceSnapshot: Uint8Array, glyphIds: readonly number[]) => ParadisOfficeTrustedFontSubset;

export interface ParadisOfficeDecodedFont {
	readonly sfnt: Uint8Array;
	readonly woff2Fingerprint: ParadisOfficeFingerprint;
	readonly includedGlyphIds: readonly number[];
	readonly compositeDependencies: readonly { readonly glyphId: number; readonly components: readonly number[] }[];
}

export function fingerprintOfficeAssetForDecoder(bytes: Uint8Array): ParadisOfficeFingerprint {
	const owned = copyPlainBytes(bytes); if (!owned || owned.byteLength > MAX_FONT_OUTPUT_BYTES) { throw new ParadisOfficePackageError('unsafe'); }
	return fingerprint(owned);
}

export type ParadisOfficeWoff2Decoder = (woff2Snapshot: Uint8Array) => ParadisOfficeDecodedFont;

export interface ParadisOfficeFontInput {
	readonly nodeId: string;
	readonly assetId: string;
	readonly source: Uint8Array;
	readonly glyphIds: readonly number[];
	readonly subsetter?: ParadisOfficeTrustedFontSubsetter;
	readonly decoder?: ParadisOfficeWoff2Decoder;
	readonly rawFingerprint?: ParadisOfficeFingerprint;
	readonly token?: CancellationToken;
	readonly checkpoint?: () => void;
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

export interface ParadisOfficePackageArchive {
	entries(token?: CancellationToken): AsyncIterable<ParadisOfficeArchiveEntry>;
	read(entry: ParadisOfficeArchiveEntry, token?: CancellationToken): AsyncIterable<Uint8Array>;
	dispose(): void;
}

export interface ParadisOfficeRenderablePackage {
	readonly bytes: Uint8Array;
	readonly assets: readonly ParadisOfficeRenderableAsset[];
	readonly placeholders: readonly ParadisOfficePlaceholder[];
}

export interface ParadisOfficePackageSanitizerInput {
	readonly nodeId: string;
	readonly source: Uint8Array;
	readonly archive: ParadisOfficePackageArchive;
	readonly token?: CancellationToken;
	readonly checkpoint?: () => void;
	readonly deadline?: number;
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
		return placeholder('office-svg', 'svg', 'unsafe');
	}
	if (snapshot.source.length > MAX_SVG_BYTES) {
		return placeholder(snapshot.nodeId, 'svg', 'budget', snapshot.rawFingerprint?.value);
	}
	const rawBytes = new TextEncoder().encode(snapshot.source);
	if (rawBytes.byteLength > MAX_SVG_BYTES) {
		return placeholder(snapshot.nodeId, 'svg', 'budget', snapshot.rawFingerprint?.value);
	}
	const rawFingerprint = fingerprint(rawBytes, snapshot.token, snapshot.checkpoint);
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
			fingerprint: fingerprint(bytes, snapshot.token, snapshot.checkpoint),
		}, snapshot.altText);
	} catch (error) {
		if (error instanceof ParadisOfficePackageError && error.code === 'cancelled') { throw error; }
		const reason = error instanceof ParadisOfficePackageError && error.code === 'limitExceeded' ? 'budget' : 'unsafe';
		return placeholder(snapshot.nodeId, 'svg', reason, rawFingerprint.value);
	}
}

function snapshotSvgInput(input: ParadisOfficeSvgInput): ParadisOfficeSvgInput | undefined {
	const values = dataProperties(input, ['nodeId', 'assetId', 'source'], ['altText', 'rawFingerprint', 'token', 'checkpoint']);
	if (!values
		|| !isAssetId(values.nodeId)
		|| !isAssetId(values.assetId)
		|| typeof values.source !== 'string'
		|| values.rawFingerprint !== undefined && !isFingerprint(values.rawFingerprint)
		|| values.checkpoint !== undefined && typeof values.checkpoint !== 'function'
		|| values.altText !== undefined && (typeof values.altText !== 'string' || values.altText.length > 4_096)) {
		return undefined;
	}
	return withOptionalAltText({
		nodeId: values.nodeId, assetId: values.assetId, source: values.source,
		...(values.rawFingerprint === undefined ? {} : { rawFingerprint: values.rawFingerprint as ParadisOfficeFingerprint }),
		...(values.token === undefined ? {} : { token: values.token as CancellationToken }),
		...(values.checkpoint === undefined ? {} : { checkpoint: values.checkpoint as () => void }),
	}, values.altText as string | undefined);
}

function snapshotFontInput(input: ParadisOfficeFontInput): ParadisOfficeFontInput | undefined {
	const values = dataProperties(input, ['nodeId', 'assetId', 'source', 'glyphIds'], ['subsetter', 'decoder', 'rawFingerprint', 'token', 'checkpoint', 'altText']);
	const sourceView = plainBytes(values?.source);
	const source = sourceView?.byteLength && sourceView.byteLength <= MAX_FONT_INPUT_BYTES ? copyPlainBytes(sourceView) : sourceView;
	const glyphIds = copyPlainNumberArray(values?.glyphIds);
	if (!values
		|| !isAssetId(values.nodeId)
		|| !isAssetId(values.assetId)
		|| !source
		|| !glyphIds
		|| values.subsetter !== undefined && typeof values.subsetter !== 'function'
		|| values.decoder !== undefined && typeof values.decoder !== 'function'
		|| values.rawFingerprint !== undefined && !isFingerprint(values.rawFingerprint)
		|| values.checkpoint !== undefined && typeof values.checkpoint !== 'function'
		|| values.altText !== undefined && (typeof values.altText !== 'string' || values.altText.length > 4_096)) {
		return undefined;
	}
	return withOptionalAltText({
		nodeId: values.nodeId,
		assetId: values.assetId,
		source,
		glyphIds,
		...(values.subsetter === undefined ? {} : { subsetter: values.subsetter as ParadisOfficeTrustedFontSubsetter }),
		...(values.decoder === undefined ? {} : { decoder: values.decoder as ParadisOfficeWoff2Decoder }),
		...(values.rawFingerprint === undefined ? {} : { rawFingerprint: values.rawFingerprint as ParadisOfficeFingerprint }),
		...(values.token === undefined ? {} : { token: values.token as CancellationToken }),
		...(values.checkpoint === undefined ? {} : { checkpoint: values.checkpoint as () => void }),
	}, values.altText as string | undefined);
}

function snapshotTrustedSubset(value: ParadisOfficeTrustedFontSubset): ParadisOfficeTrustedFontSubset | undefined {
	const values = dataProperties(value, ['bytes'], []);
	const bytes = copyPlainBytes(values?.bytes);
	if (!values || !bytes) {
		return undefined;
	}
	return { bytes };
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

/** Rebuilds an owned STORE-only package whose renderer-facing assets are allowlisted. */
export async function sanitizeOfficeDocxPackageForRenderer(input: ParadisOfficePackageSanitizerInput): Promise<ParadisOfficeRenderablePackage> {
	const source = copyPlainBytes(input.source);
	if (!source || source.byteLength > 32 * 1024 * 1024 || !isAssetId(input.nodeId)) { throw new ParadisOfficePackageError('unsafe'); }
	const metadata: ParadisOfficeArchiveEntry[] = [];
	const names = new Set<string>();
	const assets: ParadisOfficeRenderableAsset[] = [];
	const placeholders: ParadisOfficePlaceholder[] = [];
	let compressedTotal = 0; let expandedTotal = 0;
	try {
		for await (const entry of input.archive.entries(input.token)) {
			checkPackageWork(input);
			const canonical = canonicalizeParadisOfficeArchiveName(entry.name).slice(1);
			if (metadata.length >= 4_096 || entry.name.length > 4_096 || canonical !== entry.name || names.has(canonical) || entry.encrypted || entry.symlink) { throw new ParadisOfficePackageError('unsafe'); }
			names.add(canonical); metadata.push(entry);
			compressedTotal += entry.compressedBytes; expandedTotal += entry.declaredExpandedBytes;
			if (entry.compressedBytes < 0 || entry.declaredExpandedBytes < 0 || entry.declaredExpandedBytes > 16 * 1024 * 1024
				|| entry.declaredExpandedBytes > Math.max(1, entry.compressedBytes) * 100 || compressedTotal > 32 * 1024 * 1024
				|| expandedTotal > 64 * 1024 * 1024 || expandedTotal > Math.max(1, compressedTotal) * 100) { throw new ParadisOfficePackageError('zipBomb'); }
			await Promise.resolve();
		}
		const values = new Map<string, Uint8Array>();
		for (const entry of metadata) {
			checkPackageWork(input);
			if (entry.directory) { values.set(entry.name, new Uint8Array()); continue; }
			const raw = await readPackageEntry(input.archive, entry, input.token, input.checkpoint);
			if (entry.crc32 === undefined || crc32(raw, input.token, input.checkpoint) !== entry.crc32) { throw new ParadisOfficePackageError('malformed'); }
			values.set(entry.name, raw); await Promise.resolve();
		}
		const policy = analyzeOpcPackage(values, input.nodeId, input.token, input.checkpoint);
		for (const placeholderValue of policy.placeholders) { placeholders.push(placeholderValue); }
		const initiallyAnchored = placeholders.length;
		for (const [name, replacement] of policy.rewrittenXml) { values.set(name, replacement); }
		for (const name of policy.removedParts) { values.delete(name); }
		for (const name of policy.svgParts) {
			const raw = values.get(name); if (!raw) { continue; }
			const processed = sanitizePackageMedia(input.nodeId, name, raw, true, input.token, input.checkpoint);
			values.set(name, processed.bytes); assets.push(processed.asset); if (processed.placeholder) { placeholders.push(processed.placeholder); }
		}
		for (const name of policy.imageParts) {
			if (policy.svgParts.has(name)) { continue; }
			const raw = values.get(name); if (!raw) { continue; }
			const processed = placeholderMedia(input.nodeId, name, fingerprint(raw, input.token, input.checkpoint));
			values.set(name, processed.bytes); assets.push(processed.asset); placeholders.push(processed.placeholder);
		}
		if (placeholders.length > initiallyAnchored) {
			const mainName = [...values.keys()].find(name => /^word\/document\.xml$/i.test(name));
			if (mainName) { const main = parsePackageXml(values.get(mainName)!); appendVisibleWordPlaceholders(main.root, placeholders.slice(initiallyAnchored)); values.set(mainName, new TextEncoder().encode(serializeOfficeXml(main.root))); }
		}
		if (assets.length + placeholders.length > 4_096) { throw new ParadisOfficePackageError('limitExceeded'); }
		const entries = metadata.filter(entry => values.has(entry.name)).map(entry => ({ name: entry.name, bytes: values.get(entry.name)!, directory: entry.directory }));
		const bytes = await writeStoreZip(entries, input);
		if (bytes.byteLength > 64 * 1024 * 1024) { throw new ParadisOfficePackageError('limitExceeded'); }
		return { bytes, assets, placeholders };
	} finally {
		input.archive.dispose();
	}
}

function checkPackageWork(input: ParadisOfficePackageSanitizerInput): void {
	input.checkpoint?.(); throwIfParadisOfficeCancelled(input.token);
	if (input.deadline !== undefined && Date.now() > input.deadline) { throw new ParadisOfficePackageError('limitExceeded'); }
}

type OfficeXmlElement = Extract<ParadisOfficeXmlNode, { readonly kind: 'element' }>;
interface OpcPolicy {
	readonly removedParts: Set<string>;
	readonly svgParts: Set<string>;
	readonly imageParts: Set<string>;
	readonly rewrittenXml: Map<string, Uint8Array>;
	readonly placeholders: ParadisOfficePlaceholder[];
}

function analyzeOpcPackage(values: ReadonlyMap<string, Uint8Array>, nodeId: string, token?: CancellationToken, checkpoint?: () => void): OpcPolicy {
	const contentBytes = values.get('[Content_Types].xml');
	if (!contentBytes) { throw new ParadisOfficePackageError('malformed'); }
	const contentDocument = parsePackageXml(contentBytes);
	if (contentDocument.root.uri !== CONTENT_TYPES_NAMESPACE || contentDocument.root.local !== 'Types') { throw new ParadisOfficePackageError('malformed'); }
	const defaults = new Map<string, string>(); const overrides = new Map<string, string>();
	for (const child of contentDocument.root.children) {
		if (child.kind !== 'element' || child.uri !== CONTENT_TYPES_NAMESPACE) { continue; }
		if (child.local === 'Default') { const extension = xmlAttribute(child, 'Extension'); const type = xmlAttribute(child, 'ContentType'); if (extension && type) { defaults.set(extension.toLowerCase(), type); } }
		if (child.local === 'Override') { const part = xmlAttribute(child, 'PartName'); const type = xmlAttribute(child, 'ContentType'); if (part && type) { overrides.set(canonicalPartName(part), type); } }
	}
	const contentType = (name: string): string => overrides.get(name) ?? defaults.get(name.slice(name.lastIndexOf('.') + 1).toLowerCase()) ?? '';
	const removedParts = new Set<string>(); const svgParts = new Set<string>(); const imageParts = new Set<string>();
	const rewrittenXml = new Map<string, Uint8Array>(); const placeholders: ParadisOfficePlaceholder[] = [];
	for (const [name, bytes] of values) {
		checkpoint?.(); throwIfParadisOfficeCancelled(token);
		if (!name.endsWith('.rels')) { continue; }
		const document = parsePackageXml(bytes);
		if (document.root.uri !== RELATIONSHIPS_NAMESPACE || document.root.local !== 'Relationships') { throw new ParadisOfficePackageError('malformed'); }
		const kept: ParadisOfficeXmlNode[] = [];
		for (const child of document.root.children) {
			if (child.kind !== 'element' || child.uri !== RELATIONSHIPS_NAMESPACE || child.local !== 'Relationship') { kept.push(child); continue; }
			const id = xmlAttribute(child, 'Id') ?? ''; const type = xmlAttribute(child, 'Type') ?? ''; const target = xmlAttribute(child, 'Target') ?? '';
			const external = (xmlAttribute(child, 'TargetMode') ?? '').toLowerCase() === 'external';
			const resolved = external ? undefined : resolveRelationshipTarget(name, target);
			const unsafe = external || isUnsafeRelationshipType(type) || !resolved;
			if (unsafe) {
				if (resolved && values.has(resolved)) { removedParts.add(resolved); }
				placeholders.push(packagePlaceholder(nodeId, `${name}:${id}`, external ? 'externalRelationship' : relationshipFeature(type), fingerprint(new TextEncoder().encode(`${type}|${target}`), token, checkpoint).value));
				continue;
			}
			const targetType = contentType(resolved);
			if (isSvgContentType(targetType)) { svgParts.add(resolved); imageParts.add(resolved); }
			else if (isImageRelationshipType(type) || targetType.startsWith('image/')) { imageParts.add(resolved); }
			else if (isUnsafeContentType(targetType)) { removedParts.add(resolved); placeholders.push(packagePlaceholder(nodeId, resolved, contentFeature(targetType), fingerprint(values.get(resolved) ?? new Uint8Array(), token, checkpoint).value)); continue; }
			kept.push(child);
		}
		(document.root.children as ParadisOfficeXmlNode[]).splice(0, document.root.children.length, ...kept);
		rewrittenXml.set(name, new TextEncoder().encode(serializeOfficeXml(document.root)));
	}
	for (const [name, bytes] of values) {
		const type = contentType(name);
		if (isSvgContentType(type)) { svgParts.add(name); imageParts.add(name); }
		else if (isUnsafeContentType(type) && !removedParts.has(name)) { removedParts.add(name); placeholders.push(packagePlaceholder(nodeId, name, contentFeature(type), fingerprint(bytes, token, checkpoint).value)); }
	}
	for (const part of removedParts) { svgParts.delete(part); imageParts.delete(part); }
	rewriteContentTypes(contentDocument.root, removedParts, new Set([...imageParts].filter(name => !svgParts.has(name))));
	rewrittenXml.set('[Content_Types].xml', new TextEncoder().encode(serializeOfficeXml(contentDocument.root)));
	if (placeholders.length > 0) {
		const mainName = [...values.keys()].find(name => /^(?:word\/document|word\/header\d*|word\/footer\d*)\.xml$/i.test(name));
		if (mainName) {
			const main = parsePackageXml(values.get(mainName)!); appendVisibleWordPlaceholders(main.root, placeholders);
			rewrittenXml.set(mainName, new TextEncoder().encode(serializeOfficeXml(main.root)));
		}
	}
	return { removedParts, svgParts, imageParts, rewrittenXml, placeholders };
}

const CONTENT_TYPES_NAMESPACE = 'http://schemas.openxmlformats.org/package/2006/content-types';
const RELATIONSHIPS_NAMESPACE = 'http://schemas.openxmlformats.org/package/2006/relationships';
const WORD_NAMESPACE = 'http://schemas.openxmlformats.org/wordprocessingml/2006/main';

function parsePackageXml(bytes: Uint8Array): { readonly root: OfficeXmlElement } {
	let text: string;
	try { text = new TextDecoder('utf-8', { fatal: true }).decode(bytes); } catch { throw new ParadisOfficePackageError('malformed'); }
	return parseParadisOfficeXml(text, { depth: 64, nodes: 65_536, attributeLength: 4_096, characters: 8 * 1024 * 1024 });
}

function xmlAttribute(element: OfficeXmlElement, local: string): string | undefined { return element.attributes.find(attribute => attribute.uri === '' && attribute.local === local)?.value; }
function canonicalPartName(value: string): string { return canonicalizeParadisOfficeArchiveName(value.startsWith('/') ? value.slice(1) : value).slice(1); }

function resolveRelationshipTarget(relsName: string, target: string): string | undefined {
	if (!target || target.includes('\\') || target.includes('%') || target.includes('\0')) { return undefined; }
	let base = '';
	if (relsName !== '_rels/.rels') {
		const match = /^(.*\/)?_rels\/([^/]+)\.rels$/.exec(relsName); if (!match) { return undefined; }
		base = match[1] ?? '';
	}
	const segments = (target.startsWith('/') ? target.slice(1) : base + target).split('/'); const resolved: string[] = [];
	for (const segment of segments) { if (!segment || segment === '.') { continue; } if (segment === '..') { if (!resolved.pop()) { return undefined; } } else { resolved.push(segment); } }
	try { return canonicalizeParadisOfficeArchiveName(resolved.join('/')).slice(1); } catch { return undefined; }
}

function isImageRelationshipType(type: string): boolean { return /\/image$/i.test(type); }
function isUnsafeRelationshipType(type: string): boolean { return /\/(?:aFChunk|font|oleObject|package|control|activeX|vbaProject|hyperlink|attachedTemplate)$/i.test(type); }
function relationshipFeature(type: string): string {
	const value = type.slice(type.lastIndexOf('/') + 1);
	return /afchunk/i.test(value) ? 'altChunk' : /font/i.test(value) ? 'embeddedFont' : /ole|activex|control|package/i.test(value) ? 'embeddedObject' : /vba/i.test(value) ? 'macro' : 'unsafeRelationship';
}
function isSvgContentType(type: string): boolean { return type.toLowerCase() === 'image/svg+xml'; }
function isUnsafeContentType(type: string): boolean { return /(?:vbaProject|oleObject|activeX|font|msdownload|executable|javascript|text\/html|message\/rfc822)/i.test(type); }
function contentFeature(type: string): string { return /font/i.test(type) ? 'embeddedFont' : /vba/i.test(type) ? 'macro' : /ole|activeX/i.test(type) ? 'embeddedObject' : /html|rfc822/i.test(type) ? 'altChunk' : 'unsafeContent'; }

function rewriteContentTypes(root: OfficeXmlElement, removed: ReadonlySet<string>, replacements: ReadonlySet<string>): void {
	const children = root.children.filter(child => child.kind !== 'element' || child.local !== 'Override' || !removed.has(canonicalPartName(xmlAttribute(child, 'PartName') ?? 'invalid')));
	for (const name of replacements) {
		const existing = children.find((child): child is OfficeXmlElement => child.kind === 'element' && child.local === 'Override' && canonicalPartName(xmlAttribute(child, 'PartName') ?? 'invalid') === name);
		if (existing) { const attributes = existing.attributes.map(attribute => attribute.local === 'ContentType' ? { ...attribute, value: 'image/svg+xml' } : attribute); const index = children.indexOf(existing); children[index] = { ...existing, attributes }; }
		else { children.push({ kind: 'element', uri: CONTENT_TYPES_NAMESPACE, local: 'Override', attributes: [{ uri: '', local: 'PartName', value: `/${name}` }, { uri: '', local: 'ContentType', value: 'image/svg+xml' }], children: [] }); }
	}
	(root.children as ParadisOfficeXmlNode[]).splice(0, root.children.length, ...children);
}

function appendVisibleWordPlaceholders(root: OfficeXmlElement, placeholders: readonly ParadisOfficePlaceholder[]): void {
	const body = findOfficeElement(root, WORD_NAMESPACE, 'body'); if (!body) { throw new ParadisOfficePackageError('malformed'); }
	for (const value of placeholders.slice(0, 256)) {
		(body.children as ParadisOfficeXmlNode[]).push({ kind: 'element', uri: WORD_NAMESPACE, local: 'p', attributes: [], children: [{ kind: 'element', uri: WORD_NAMESPACE, local: 'r', attributes: [], children: [{ kind: 'element', uri: WORD_NAMESPACE, local: 't', attributes: [], children: [{ kind: 'text', value: `Office asset unavailable: ${value.feature} ${value.fingerprint?.slice(0, 12) ?? ''}` }] }] }] });
	}
}

function findOfficeElement(root: OfficeXmlElement, uri: string, local: string): OfficeXmlElement | undefined {
	if (root.uri === uri && root.local === local) { return root; }
	for (const child of root.children) { if (child.kind === 'element') { const found = findOfficeElement(child, uri, local); if (found) { return found; } } }
	return undefined;
}

function serializeOfficeXml(root: OfficeXmlElement): string {
	const uris = new Set<string>(); const collect = (node: ParadisOfficeXmlNode): void => { if (node.kind === 'text') { return; } if (node.uri) { uris.add(node.uri); } for (const attribute of node.attributes) { if (attribute.uri) { uris.add(attribute.uri); } } for (const child of node.children) { collect(child); } }; collect(root);
	const prefixes = new Map<string, string>(); let next = 0;
	for (const uri of uris) { prefixes.set(uri, uri === WORD_NAMESPACE ? 'w' : uri === XML_NAMESPACE ? 'xml' : `n${next++}`); }
	const render = (node: ParadisOfficeXmlNode, isRoot = false): string => {
		if (node.kind === 'text') { return escapeXmlText(node.value); }
		const prefix = prefixes.get(node.uri); const name = prefix ? `${prefix}:${node.local}` : node.local;
		const declarations = isRoot ? [...prefixes].filter(([, value]) => value !== 'xml').map(([uri, value]) => ` xmlns:${value}="${escapeXmlAttribute(uri)}"`).join('') : '';
		const attributes = node.attributes.map(attribute => ` ${prefixes.get(attribute.uri) ? `${prefixes.get(attribute.uri)}:` : ''}${attribute.local}="${escapeXmlAttribute(attribute.value)}"`).join('');
		const children = node.children.map(child => render(child)).join('');
		return children ? `<${name}${declarations}${attributes}>${children}</${name}>` : `<${name}${declarations}${attributes}/>`;
	};
	return `<?xml version="1.0" encoding="UTF-8"?>${render(root, true)}`;
}

async function readPackageEntry(archive: ParadisOfficePackageArchive, entry: ParadisOfficeArchiveEntry, token?: CancellationToken, checkpoint?: () => void): Promise<Uint8Array> {
	const chunks: Uint8Array[] = [];
	let length = 0;
	for await (const chunk of archive.read(entry, token)) {
		checkpoint?.(); throwIfParadisOfficeCancelled(token);
		const owned = copyPlainBytes(chunk);
		if (!owned) { throw new ParadisOfficePackageError('unsafe'); }
		length += owned.byteLength;
		if (length > entry.declaredExpandedBytes || length > 32 * 1024 * 1024) { throw new ParadisOfficePackageError('limitExceeded'); }
		chunks.push(owned);
	}
	if (length !== entry.declaredExpandedBytes) { throw new ParadisOfficePackageError('malformed'); }
	const result = new Uint8Array(length);
	let offset = 0;
	for (const chunk of chunks) { result.set(chunk, offset); offset += chunk.byteLength; }
	return result;
}

function sanitizePackageMedia(nodeId: string, name: string, raw: Uint8Array, semanticSvg: boolean, token?: CancellationToken, checkpoint?: () => void): { readonly bytes: Uint8Array; readonly asset: ParadisOfficeRenderableAsset; readonly placeholder?: ParadisOfficePlaceholder } {
	const rawHash = fingerprint(raw, token, checkpoint);
	const id = `asset_${rawHash.value.slice(0, 32)}`;
	if (semanticSvg) {
		let source: string;
		try { source = new TextDecoder('utf-8', { fatal: true }).decode(raw); } catch { return placeholderMedia(nodeId, name, rawHash); }
		const sanitized = sanitizeOfficeSvg({ nodeId: `${nodeId}_svg`, assetId: id, source, rawFingerprint: rawHash, token, checkpoint });
		if (Object.prototype.hasOwnProperty.call(sanitized, 'bytes')) {
			const safe = sanitized as ParadisSanitizedSvg;
			return { bytes: safe.bytes.slice(), asset: assetMetadata(safe) };
		}
	}
	return placeholderMedia(nodeId, name, rawHash);
}

function placeholderMedia(nodeId: string, name: string, rawHash: ParadisOfficeFingerprint): { readonly bytes: Uint8Array; readonly asset: ParadisOfficeRenderableAsset; readonly placeholder: ParadisOfficePlaceholder } {
	const id = `placeholder_${rawHash.value.slice(0, 32)}`;
	const source = `<svg xmlns="${SVG_NAMESPACE}" viewBox="0 0 320 48"><rect width="320" height="48" fill="#eeeeee"/><text x="8" y="28" fill="#000000">Office asset unavailable ${rawHash.value.slice(0, 12)}</text></svg>`;
	const safe = sanitizeOfficeSvg({ nodeId: `${nodeId}_placeholder`, assetId: id, source });
	if (!Object.prototype.hasOwnProperty.call(safe, 'bytes')) { throw new ParadisOfficePackageError('unsafe'); }
	const svg = safe as ParadisSanitizedSvg;
	return {
		bytes: svg.bytes.slice(),
		asset: { ...assetMetadata(svg), kind: 'placeholderPreview' },
		placeholder: packagePlaceholder(nodeId, name, 'unsafeMedia', rawHash.value),
	};
}

function assetMetadata(svg: ParadisSanitizedSvg): Extract<ParadisOfficeRenderableAsset, { readonly kind: 'sanitizedSvg' }> {
	return { id: svg.id, kind: 'sanitizedSvg', mime: 'image/svg+xml', byteLength: svg.byteLength, fingerprint: svg.fingerprint, ...(svg.altText === undefined ? {} : { altText: svg.altText }) };
}

function packagePlaceholder(nodeId: string, name: string, feature: string, hash: string): ParadisOfficePlaceholder {
	return { nodeId: `${nodeId}_${hash.slice(0, 16)}`, feature, reason: 'unsafe', title: 'Office asset unavailable', detail: `package-asset:${name.length}`, fingerprint: hash };
}

async function writeStoreZip(entries: readonly { readonly name: string; readonly bytes: Uint8Array; readonly directory: boolean }[], input: ParadisOfficePackageSanitizerInput): Promise<Uint8Array> {
	const encoder = new TextEncoder();
	const records = entries.map(entry => ({ ...entry, nameBytes: encoder.encode(entry.name), crc: crc32(entry.bytes, input.token, input.checkpoint) }));
	let localLength = 0;
	for (const record of records) { localLength += 30 + record.nameBytes.byteLength + record.bytes.byteLength; }
	let centralLength = 0;
	for (const record of records) { centralLength += 46 + record.nameBytes.byteLength; }
	const output = new Uint8Array(localLength + centralLength + 22);
	const view = new DataView(output.buffer);
	let offset = 0;
	const offsets: number[] = [];
	for (const record of records) {
		checkPackageWork(input); offsets.push(offset); writeLe32(view, offset, 0x04034b50); writeLe16(view, offset + 4, 20); writeLe16(view, offset + 6, 0x0800); writeLe16(view, offset + 8, 0);
		writeLe32(view, offset + 14, record.crc); writeLe32(view, offset + 18, record.bytes.byteLength); writeLe32(view, offset + 22, record.bytes.byteLength); writeLe16(view, offset + 26, record.nameBytes.byteLength);
		output.set(record.nameBytes, offset + 30); output.set(record.bytes, offset + 30 + record.nameBytes.byteLength); offset += 30 + record.nameBytes.byteLength + record.bytes.byteLength;
		await Promise.resolve();
	}
	const centralOffset = offset;
	for (let index = 0; index < records.length; index++) {
		checkPackageWork(input); const record = records[index]; writeLe32(view, offset, 0x02014b50); writeLe16(view, offset + 4, 20); writeLe16(view, offset + 6, 20); writeLe16(view, offset + 8, 0x0800); writeLe32(view, offset + 16, record.crc);
		writeLe32(view, offset + 20, record.bytes.byteLength); writeLe32(view, offset + 24, record.bytes.byteLength); writeLe16(view, offset + 28, record.nameBytes.byteLength); writeLe32(view, offset + 38, record.directory ? 0x10 : 0); writeLe32(view, offset + 42, offsets[index]);
		output.set(record.nameBytes, offset + 46); offset += 46 + record.nameBytes.byteLength;
		await Promise.resolve();
	}
	writeLe32(view, offset, 0x06054b50); writeLe16(view, offset + 8, records.length); writeLe16(view, offset + 10, records.length); writeLe32(view, offset + 12, centralLength); writeLe32(view, offset + 16, centralOffset);
	return output;
}

function crc32(bytes: Uint8Array, token?: CancellationToken, checkpoint?: () => void): number {
	let crc = 0xffffffff;
	for (let index = 0; index < bytes.byteLength; index++) { if ((index & 0xffff) === 0) { checkpoint?.(); throwIfParadisOfficeCancelled(token); } crc = CRC32_TABLE[(crc ^ bytes[index]) & 0xff] ^ (crc >>> 8); }
	return (crc ^ 0xffffffff) >>> 0;
}

const CRC32_TABLE = new Uint32Array(256);
for (let index = 0; index < CRC32_TABLE.length; index++) { let value = index; for (let bit = 0; bit < 8; bit++) { value = (value >>> 1) ^ (value & 1 ? 0xedb88320 : 0); } CRC32_TABLE[index] = value >>> 0; }

function writeLe16(view: DataView, offset: number, value: number): void { view.setUint16(offset, value, true); }
function writeLe32(view: DataView, offset: number, value: number): void { view.setUint32(offset, value, true); }

function copyPlainBytes(value: unknown): Uint8Array | undefined {
	const view = plainBytes(value);
	if (!view) { return undefined; }
	try {
		const copy = new Uint8Array(view.byteLength); copy.set(view); return copy;
	} catch {
		return undefined;
	}
}

function plainBytes(value: unknown): Uint8Array | undefined {
	try {
		if (!(value instanceof Uint8Array) || Object.getPrototypeOf(value) !== Uint8Array.prototype || isSharedBytes(value)) { return undefined; }
		const buffer = value.buffer;
		if (!(buffer instanceof ArrayBuffer) || Object.getPrototypeOf(buffer) !== ArrayBuffer.prototype || (buffer as ArrayBuffer & { readonly resizable?: boolean }).resizable === true) { return undefined; }
		return value;
	} catch { return undefined; }
}

function isFingerprint(value: unknown): value is ParadisOfficeFingerprint {
	const record = dataProperties(value as object, ['algorithm', 'value', 'byteLength'], []);
	return !!record && record.algorithm === 'sha256' && typeof record.value === 'string' && /^[a-f\d]{64}$/.test(record.value)
		&& typeof record.byteLength === 'number' && Number.isSafeInteger(record.byteLength) && record.byteLength >= 0;
}

/** Validates raw font structure, delegates subsetting, and publishes only revalidated WOFF2. */
export function validateAndSubsetOfficeFont(input: ParadisOfficeFontInput): ParadisRenderableFont | ParadisOfficePlaceholder {
	const snapshot = snapshotFontInput(input);
	if (!snapshot) {
		return placeholder('office-font', 'embeddedFont', 'unsafe');
	}
	if (snapshot.source.byteLength > MAX_FONT_INPUT_BYTES) {
		return placeholder(snapshot.nodeId, 'embeddedFont', 'budget', snapshot.rawFingerprint?.value);
	}
	const source = copyPlainBytes(snapshot.source)!;
	const rawFingerprint = fingerprint(source, snapshot.token, snapshot.checkpoint);
	let inspected: InspectedFont;
	try {
		inspected = inspectFont(source);
		if (!inspected.tables.has('maxp')) { throw new UnsafeAssetError(); }
		validateGlyphIds(snapshot.glyphIds, inspected.glyphCount);
	} catch (error) {
		return placeholder(snapshot.nodeId, 'embeddedFont', error instanceof AssetBudgetError ? 'budget' : 'unsafe', rawFingerprint.value);
	}
	if (!snapshot.subsetter || !snapshot.decoder) {
		return placeholder(snapshot.nodeId, 'embeddedFont', 'unsupported', rawFingerprint.value);
	}
	try {
		const trusted = snapshotTrustedSubset(snapshot.subsetter(source.slice(), [...snapshot.glyphIds]));
		if (!trusted) { throw new UnsafeAssetError(); }
		const subsetBytes = copyPlainBytes(trusted.bytes);
		if (!subsetBytes) { throw new UnsafeAssetError(); }
		if (subsetBytes.byteLength > MAX_FONT_OUTPUT_BYTES) {
			throw new AssetBudgetError();
		}
		const output = inspectWoff2(subsetBytes);
		const decoded = snapshotDecodedFont(snapshot.decoder(subsetBytes.slice()));
		if (!decoded) { throw new UnsafeAssetError(); }
		const decodedInspection = inspectSfnt(decoded.sfnt);
		validateDecodedFont(output, decodedInspection, decoded, snapshot.glyphIds, inspected.glyphCount, fingerprint(subsetBytes, snapshot.token, snapshot.checkpoint));
		if (output.tables.has('SVG ') || !output.tables.has('maxp')) {
			throw new UnsafeAssetError();
		}
		throwIfParadisOfficeCancelled(snapshot.token); snapshot.checkpoint?.();
		const published = subsetBytes.slice();
		return withOptionalAltText({
			id: snapshot.assetId,
			kind: 'fontSubset' as const,
			mime: 'font/woff2' as const,
			bytes: published,
			byteLength: published.byteLength,
			fingerprint: fingerprint(published, snapshot.token, snapshot.checkpoint),
		}, snapshot.altText);
	} catch (error) {
		return placeholder(snapshot.nodeId, 'embeddedFont', error instanceof AssetBudgetError ? 'budget' : 'unsafe', rawFingerprint.value);
	}
}

function snapshotDecodedFont(value: ParadisOfficeDecodedFont): ParadisOfficeDecodedFont | undefined {
	const values = dataProperties(value, ['sfnt', 'woff2Fingerprint', 'includedGlyphIds', 'compositeDependencies'], []);
	const sfnt = copyPlainBytes(values?.sfnt);
	const included = copyPlainNumberArray(values?.includedGlyphIds);
	if (!values || !sfnt || !included || !isFingerprint(values.woff2Fingerprint) || !Array.isArray(values.compositeDependencies) || Object.getPrototypeOf(values.compositeDependencies) !== Array.prototype) { return undefined; }
	const dependencies: { readonly glyphId: number; readonly components: readonly number[] }[] = [];
	try {
		for (const raw of Array.prototype.slice.call(values.compositeDependencies) as unknown[]) {
			const record = dataProperties(raw as object, ['glyphId', 'components'], []);
			const components = copyPlainNumberArray(record?.components);
			if (!record || typeof record.glyphId !== 'number' || !components) { return undefined; }
			dependencies.push({ glyphId: record.glyphId, components });
		}
	} catch { return undefined; }
	return { sfnt, woff2Fingerprint: values.woff2Fingerprint, includedGlyphIds: included, compositeDependencies: dependencies };
}

function copyPlainNumberArray(value: unknown): readonly number[] | undefined {
	try {
		if (!Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype) { return undefined; }
		const copy = Array.prototype.slice.call(value) as unknown[];
		return copy.every(item => typeof item === 'number' && Number.isSafeInteger(item) && item >= 0 && item <= MAX_FONT_GLYPHS) ? copy as number[] : undefined;
	} catch { return undefined; }
}

function validateDecodedFont(woff2: InspectedFont, sfnt: InspectedFont, decoded: ParadisOfficeDecodedFont, requested: readonly number[], sourceGlyphCount: number | undefined, expectedFingerprint: ParadisOfficeFingerprint): void {
	if (decoded.woff2Fingerprint.byteLength !== expectedFingerprint.byteLength || decoded.woff2Fingerprint.value !== expectedFingerprint.value) { throw new UnsafeAssetError(); }
	if (sfnt.expandedByteLength !== woff2.expandedByteLength || sfnt.expandedByteLength > expectedFingerprint.byteLength * 100) { throw new AssetBudgetError(); }
	for (const tag of ['maxp', 'cmap', 'name', 'OS/2']) { if (!sfnt.tables.has(tag) || !woff2.tables.has(tag)) { throw new UnsafeAssetError(); } }
	const outline = sfnt.tables.has('glyf') && sfnt.tables.has('loca') || sfnt.tables.has('CFF ') || sfnt.tables.has('CFF2');
	if (!outline || sfnt.tables.has('SVG ') || sfnt.tables.has('COLR') || !sameSet(sfnt.tables, woff2.tables)) { throw new UnsafeAssetError(); }
	const glyphCount = sfnt.glyphCount;
	if (!glyphCount) { throw new UnsafeAssetError(); }
	const actualDependencies = validateSfntSemanticTables(decoded.sfnt, sfnt.records ?? [], glyphCount);
	const included = new Set(decoded.includedGlyphIds);
	if (included.size !== decoded.includedGlyphIds.length || included.size !== glyphCount || !included.has(0) || [...included].some(id => id >= glyphCount || sourceGlyphCount !== undefined && id >= sourceGlyphCount)) { throw new UnsafeAssetError(); }
	for (let id = 0; id < glyphCount; id++) { if (!included.has(id)) { throw new UnsafeAssetError(); } }
	for (const glyph of requested) { if (!included.has(glyph)) { throw new UnsafeAssetError(); } }
	for (const dependency of decoded.compositeDependencies) {
		if (!included.has(dependency.glyphId) || dependency.components.some(component => !included.has(component))) { throw new UnsafeAssetError(); }
	}
	const declaredDependencies = new Map(decoded.compositeDependencies.map(value => [value.glyphId, [...value.components].sort((a, b) => a - b).join(',')]));
	if (declaredDependencies.size !== decoded.compositeDependencies.length || declaredDependencies.size !== actualDependencies.size) { throw new UnsafeAssetError(); }
	for (const [glyph, components] of actualDependencies) { if (declaredDependencies.get(glyph) !== components.join(',')) { throw new UnsafeAssetError(); } }
}

function validateSfntSemanticTables(bytes: Uint8Array, records: readonly FontTableRecord[], glyphCount: number): ReadonlyMap<number, readonly number[]> {
	const byTag = new Map(records.map(record => [record.tag, record]));
	const cmap = byTag.get('cmap'); const name = byTag.get('name'); const os2 = byTag.get('OS/2');
	if (!cmap || !name || !os2) { throw new UnsafeAssetError(); }
	if (cmap.length < 4 || readU16(bytes, cmap.offset) !== 0) { throw new UnsafeAssetError(); }
	const cmapCount = readU16(bytes, cmap.offset + 2);
	if (cmapCount < 1 || cmapCount > 64 || 4 + cmapCount * 8 > cmap.length) { throw new UnsafeAssetError(); }
	for (let index = 0; index < cmapCount; index++) {
		const subtable = readU32(bytes, cmap.offset + 4 + index * 8 + 4);
		if (subtable >= cmap.length) { throw new UnsafeAssetError(); }
	}
	if (name.length < 6) { throw new UnsafeAssetError(); }
	const nameFormat = readU16(bytes, name.offset); const nameCount = readU16(bytes, name.offset + 2); const strings = readU16(bytes, name.offset + 4);
	if (nameFormat > 1 || nameCount > 4_096 || 6 + nameCount * 12 > name.length || strings > name.length) { throw new UnsafeAssetError(); }
	for (let index = 0; index < nameCount; index++) {
		const recordOffset = name.offset + 6 + index * 12;
		const length = readU16(bytes, recordOffset + 8); const offset = readU16(bytes, recordOffset + 10);
		if (strings + offset + length > name.length) { throw new UnsafeAssetError(); }
	}
	if (os2.length < 2) { throw new UnsafeAssetError(); }
	const os2Version = readU16(bytes, os2.offset); const os2Minimum = [78, 86, 96, 96, 96, 100][os2Version];
	if (os2Minimum === undefined || os2.length < os2Minimum) { throw new UnsafeAssetError(); }
	if (byTag.has('glyf')) {
		const head = byTag.get('head'); const loca = byTag.get('loca'); const glyf = byTag.get('glyf');
		if (!head || !loca || !glyf || head.length < 54) { throw new UnsafeAssetError(); }
		const longLoca = readU16(bytes, head.offset + 50) === 1; const entrySize = longLoca ? 4 : 2;
		if (loca.length < (glyphCount + 1) * entrySize) { throw new UnsafeAssetError(); }
		let previous = 0; const offsets: number[] = [];
		for (let index = 0; index <= glyphCount; index++) {
			const raw = longLoca ? readU32(bytes, loca.offset + index * 4) : readU16(bytes, loca.offset + index * 2) * 2;
			if (raw < previous || raw > glyf.length) { throw new UnsafeAssetError(); }
			previous = raw; offsets.push(raw);
		}
		return parseGlyfDependencies(bytes, glyf.offset, offsets);
	} else {
		const cff = byTag.get('CFF ') ?? byTag.get('CFF2');
		if (!cff || cff.length < 4) { throw new UnsafeAssetError(); }
		return new Map();
	}
}

function parseGlyfDependencies(bytes: Uint8Array, glyfOffset: number, offsets: readonly number[]): ReadonlyMap<number, readonly number[]> {
	const result = new Map<number, readonly number[]>();
	for (let glyph = 0; glyph + 1 < offsets.length; glyph++) {
		const start = glyfOffset + offsets[glyph]; const end = glyfOffset + offsets[glyph + 1]; if (start === end) { continue; }
		if (end - start < 10) { throw new UnsafeAssetError(); }
		const contours = (readU16(bytes, start) << 16) >> 16; if (contours >= 0) { continue; }
		let offset = start + 10; const components: number[] = []; let more = true;
		while (more) {
			if (offset + 4 > end) { throw new UnsafeAssetError(); }
			const flags = readU16(bytes, offset); const component = readU16(bytes, offset + 2); components.push(component); offset += 4;
			offset += flags & 1 ? 4 : 2; if (flags & 8) { offset += 2; } else if (flags & 0x40) { offset += 4; } else if (flags & 0x80) { offset += 8; }
			if (offset > end || components.length > 1_024) { throw new UnsafeAssetError(); }
			more = (flags & 0x20) !== 0;
		}
		result.set(glyph, [...new Set(components)].sort((a, b) => a - b));
	}
	return result;
}

function sameSet(left: ReadonlySet<string>, right: ReadonlySet<string>): boolean {
	return left.size === right.size && [...left].every(value => right.has(value));
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
	if (name === 'd') { return canonicalizeSvgPath(value) !== undefined; }
	if (name === 'points') { return canonicalizeSvgPoints(value) !== undefined; }
	if (name === 'transform' || name === 'gradientTransform') { return canonicalizeSvgTransform(value) !== undefined; }
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

function normalizeSvgAttribute(name: string, value: string): string {
	if (name === 'd') { return canonicalizeSvgPath(value) ?? ''; }
	if (name === 'points') { return canonicalizeSvgPoints(value) ?? ''; }
	if (name === 'transform' || name === 'gradientTransform') { return canonicalizeSvgTransform(value) ?? ''; }
	return value.trim().replace(/\s+/g, ' ');
}

interface SvgToken { readonly kind: 'command' | 'number'; readonly raw: string; readonly value?: number }

function tokenizeSvg(value: string, commands: string): readonly SvgToken[] | undefined {
	if (value.length > 65_536) { return undefined; }
	const matcher = new RegExp(`[${commands}]|[+-]?(?:\\d+(?:\\.\\d*)?|\\.\\d+)(?:[eE][+-]?\\d+)?`, 'g');
	const tokens: SvgToken[] = [];
	let previousEnd = 0;
	let previous: SvgToken | undefined;
	for (let match = matcher.exec(value); match; match = matcher.exec(value)) {
		const gap = value.slice(previousEnd, match.index);
		if (!/^\s*,?\s*$/.test(gap) || gap.includes(',') && (!previous || commands.includes(match[0]))) { return undefined; }
		if (!gap && previous?.kind === 'number' && !/^[+-]/.test(match[0])) { return undefined; }
		const raw = match[0];
		const token: SvgToken = commands.includes(raw)
			? { kind: 'command', raw }
			: { kind: 'number', raw, value: Number(raw) };
		if (token.kind === 'number' && (!Number.isFinite(token.value) || Math.abs(token.value!) > 10_000_000)) { return undefined; }
		tokens.push(token);
		if (tokens.length > 65_536) { return undefined; }
		previous = token;
		previousEnd = match.index + raw.length;
	}
	return tokens.length > 0 && /^\s*$/.test(value.slice(previousEnd)) ? tokens : undefined;
}

function canonicalNumber(value: number): string {
	return Object.is(value, -0) ? '0' : String(value);
}

function canonicalizeSvgPoints(value: string): string | undefined {
	const tokens = tokenizeSvg(value, '');
	if (!tokens || tokens.some(token => token.kind !== 'number') || tokens.length < 2 || tokens.length % 2 !== 0 || tokens.length > 16_384) { return undefined; }
	return tokens.map(token => canonicalNumber(token.value!)).join(' ');
}

const SVG_PATH_ARITY: Readonly<Record<string, number>> = { M: 2, L: 2, H: 1, V: 1, C: 6, S: 4, Q: 4, T: 2, A: 7, Z: 0 };

function canonicalizeSvgPath(value: string): string | undefined {
	const tokens = tokenizeSvg(value, 'MmZzLlHhVvCcSsQqTtAa');
	if (!tokens || tokens[0].kind !== 'command' || tokens[0].raw.toUpperCase() !== 'M') { return undefined; }
	const output: string[] = [];
	let index = 0;
	let groups = 0;
	while (index < tokens.length) {
		const commandToken = tokens[index++];
		if (commandToken.kind !== 'command') { return undefined; }
		const command = commandToken.raw;
		const upper = command.toUpperCase();
		const arity = SVG_PATH_ARITY[upper];
		if (arity === undefined) { return undefined; }
		if (arity === 0) { output.push(command); continue; }
		let groupCount = 0;
		while (index < tokens.length && tokens[index].kind === 'number') {
			if (index + arity > tokens.length || tokens.slice(index, index + arity).some(token => token.kind !== 'number')) { return undefined; }
			const numbers = tokens.slice(index, index + arity).map(token => token.value!);
			if (upper === 'A' && (numbers[0] < 0 || numbers[1] < 0 || ![0, 1].includes(numbers[3]) || ![0, 1].includes(numbers[4]))) { return undefined; }
			const emittedCommand = upper === 'M' && groupCount > 0 ? (command === 'M' ? 'L' : 'l') : command;
			output.push(emittedCommand, ...numbers.map(canonicalNumber));
			index += arity;
			groupCount++;
			groups++;
			if (groups > 8_192) { return undefined; }
		}
		if (groupCount === 0) { return undefined; }
	}
	return output.join(' ');
}

function canonicalizeSvgTransform(value: string): string | undefined {
	const output: string[] = [];
	const matcher = /(matrix|translate|scale|rotate|skewX|skewY)\s*\(([^)]*)\)/g;
	let end = 0;
	let count = 0;
	for (let match = matcher.exec(value); match; match = matcher.exec(value)) {
		if (!/^\s*$/.test(value.slice(end, match.index))) { return undefined; }
		const numbers = tokenizeSvg(match[2], '');
		const arities: Readonly<Record<string, readonly number[]>> = { matrix: [6], translate: [1, 2], scale: [1, 2], rotate: [1, 3], skewX: [1], skewY: [1] };
		if (!numbers || numbers.some(token => token.kind !== 'number') || !arities[match[1]].includes(numbers.length)) { return undefined; }
		output.push(`${match[1]}(${numbers.map(token => canonicalNumber(token.value!)).join(' ')})`);
		end = matcher.lastIndex;
		if (++count > 1_024) { return undefined; }
	}
	return output.length > 0 && /^\s*$/.test(value.slice(end)) ? output.join(' ') : undefined;
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
	readonly records?: readonly FontTableRecord[];
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
	return { tables: tags, glyphCount: sfntGlyphCount(bytes, records), expandedByteLength: bytes.byteLength, records };
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
	let calculatedExpanded = 12 + tableCount * 16;
	for (let index = 0; index < tableCount; index++) {
		requireRange(bytes, offset, 1);
		const flags = bytes[offset++];
		const tagIndex = flags & 0x3f;
		const tag = tagIndex === 0x3f ? readTag(bytes, offset) : WOFF2_KNOWN_TAGS[tagIndex];
		if (tagIndex === 0x3f) { offset += 4; }
		if (!tag || tags.has(tag)) { throw new UnsafeAssetError(); }
		const original = readBase128(bytes, offset); offset = original.next;
		calculatedExpanded += (original.value + 3) & ~3;
		if (!Number.isSafeInteger(calculatedExpanded) || calculatedExpanded > MAX_FONT_EXPANDED_BYTES) { throw new AssetBudgetError(); }
		const transformVersion = flags >>> 6;
		const transformed = (tag === 'glyf' || tag === 'loca') ? transformVersion === 0 : transformVersion !== 0;
		if (transformed) {
			const transformedLength = readBase128(bytes, offset);
			offset = transformedLength.next;
		}
		tags.add(tag);
	}
	if (calculatedExpanded !== expandedByteLength) { throw new UnsafeAssetError(); }
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

function placeholder(nodeId: string, feature: string, reason: ParadisOfficePlaceholder['reason'], fingerprintValue?: string): ParadisOfficePlaceholder {
	return {
		nodeId,
		feature,
		reason,
		title: feature === 'svg' ? 'SVG preview unavailable' : 'Embedded font unavailable',
		...(fingerprintValue === undefined ? {} : { fingerprint: fingerprintValue }),
	};
}

function withOptionalAltText<T extends object>(value: T, altText: string | undefined): T & { readonly altText?: string } {
	return altText === undefined ? value : { ...value, altText };
}

class UnsafeAssetError extends Error { }
class AssetBudgetError extends Error { }

function fingerprint(bytes: Uint8Array, token?: CancellationToken, checkpoint?: () => void): ParadisOfficeFingerprint {
	let h0 = 0x6a09e667; let h1 = 0xbb67ae85; let h2 = 0x3c6ef372; let h3 = 0xa54ff53a;
	let h4 = 0x510e527f; let h5 = 0x9b05688c; let h6 = 0x1f83d9ab; let h7 = 0x5be0cd19;
	const w = new Uint32Array(64);
	const processBlock = (block: Uint8Array, offset: number): void => {
		checkpoint?.(); throwIfParadisOfficeCancelled(token);
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
