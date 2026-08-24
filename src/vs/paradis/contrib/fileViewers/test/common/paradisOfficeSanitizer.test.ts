/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.
// allow-any-unicode-comment-file

import { deepStrictEqual, notStrictEqual, ok, strictEqual, throws } from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import {
	buildParadisOfficeWordCsp,
	sanitizeOfficeSvg,
	validateAndSubsetOfficeFont,
	type ParadisRenderableFont,
	type ParadisSanitizedSvg,
	type ParadisOfficeTrustedFontSubset,
} from '../../common/paradisOfficeSanitizer.js';

suite('ParadisOfficeSanitizer', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	test('builds an exact mounted-loopback Word CSP without broad network or executable fallbacks', () => {
		const csp = buildParadisOfficeWordCsp('nonce-value', {
			kind: 'mountedLoopback',
			origins: ['http://127.0.0.1:43123'],
		});

		strictEqual(csp, 'default-src \'none\'; script-src \'nonce-nonce-value\' http://127.0.0.1:43123; style-src \'unsafe-inline\'; img-src data: blob: http://127.0.0.1:43123; font-src data: blob: http://127.0.0.1:43123; connect-src http://127.0.0.1:43123 data: blob:; object-src \'none\'; frame-src \'none\'; worker-src \'none\'; base-uri \'none\'; form-action \'none\'; navigate-to \'none\';');
		ok(!csp.includes('https:'));
		ok(!csp.includes('*'));
		ok(!csp.includes('\'unsafe-eval\''));
	});

	test('builds an exact webview-resource fallback CSP and keeps it separate from mount sources', () => {
		const csp = buildParadisOfficeWordCsp('fallback-nonce', {
			kind: 'webviewResource',
			cspSources: ['https://file+.vscode-resource.vscode-cdn.net'],
		});

		strictEqual(csp, 'default-src \'none\'; script-src \'nonce-fallback-nonce\' https://file+.vscode-resource.vscode-cdn.net; style-src \'unsafe-inline\'; img-src data: blob: https://file+.vscode-resource.vscode-cdn.net; font-src data: blob: https://file+.vscode-resource.vscode-cdn.net; connect-src https://file+.vscode-resource.vscode-cdn.net data: blob:; object-src \'none\'; frame-src \'none\'; worker-src \'none\'; base-uri \'none\'; form-action \'none\'; navigate-to \'none\';');
		ok(!csp.includes('http://127.0.0.1'));
		ok(!/(?:^|\s)https:(?:\s|;|$)/.test(csp));
	});

	test('rejects CSP source injection, wildcard, broad schemes, and non-loopback mount origins', () => {
		for (const origins of [
			['http://localhost:43123'],
			['http://127.0.0.1'],
			['https://127.0.0.1:43123'],
			['http://127.0.0.1:43123/path'],
			['http://127.0.0.1:43123; img-src *'],
		] as const) {
			throws(() => buildParadisOfficeWordCsp('nonce', { kind: 'mountedLoopback', origins }));
		}
		for (const cspSources of [
			['https:'],
			['https://*.vscode-resource.vscode-cdn.net'],
			['https://trusted.example/path'],
			['\'self\' https://trusted.example'],
			['http://trusted.example'],
		] as const) {
			throws(() => buildParadisOfficeWordCsp('nonce', { kind: 'webviewResource', cspSources }));
		}
		throws(() => buildParadisOfficeWordCsp('bad\' nonce', { kind: 'webviewResource', cspSources: ['https://trusted.example'] }));
	});

	test('canonicalizes only the typed SVG allowlist and returns fresh sanitized bytes', () => {
		const input = {
			nodeId: 'shape-1',
			assetId: 'asset-shape-1',
			source: '<s:svg xmlns:s="http://www.w3.org/2000/svg" viewBox="0 0 20 10"><s:g opacity="1"><s:path stroke="#000000" fill="none" d="M 0 0 L 20 10"/><s:text x="2" y="8">Safe</s:text></s:g></s:svg>',
			altText: 'Safe shape',
		} as const;

		const first = sanitizeOfficeSvg(input);
		const second = sanitizeOfficeSvg(input);
		if (!hasBytes(first) || !hasBytes(second)) {
			throw new Error('Expected a sanitized SVG');
		}

		strictEqual(new TextDecoder().decode(first.bytes), '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20 10"><g opacity="1"><path d="M 0 0 L 20 10" fill="none" stroke="#000000"/><text x="2" y="8">Safe</text></g></svg>');
		deepStrictEqual({ id: first.id, kind: first.kind, mime: first.mime, byteLength: first.byteLength, altText: first.altText }, {
			id: 'asset-shape-1', kind: 'sanitizedSvg', mime: 'image/svg+xml', byteLength: first.bytes.byteLength, altText: 'Safe shape'
		});
		strictEqual(first.fingerprint.algorithm, 'sha256');
		strictEqual(first.fingerprint.byteLength, first.bytes.byteLength);
		strictEqual(first.fingerprint.value, second.fingerprint.value);
		notStrictEqual(first, second);
		notStrictEqual(first.bytes, second.bytes);
	});

	test('turns active, externally referencing, and namespace-confused SVG into fingerprinted placeholders', () => {
		const unsafeSources = [
			'<svg xmlns="http://www.w3.org/2000/svg"><foreignObject/></svg>',
			'<svg xmlns="http://www.w3.org/2000/svg"><script/></svg>',
			'<svg xmlns="http://www.w3.org/2000/svg"><style/></svg>',
			'<svg xmlns="http://www.w3.org/2000/svg"><animate/></svg>',
			'<svg xmlns="http://www.w3.org/2000/svg"><filter/></svg>',
			'<svg xmlns="http://www.w3.org/2000/svg"><image/></svg>',
			'<svg xmlns="http://www.w3.org/2000/svg"><use href="#safe"/></svg>',
			'<svg xmlns="http://www.w3.org/2000/svg" onload="alert(1)"/>',
			'<svg xmlns="http://www.w3.org/2000/svg"><path href="https://attacker.example/x" d="M0 0"/></svg>',
			'<svg xmlns="http://www.w3.org/2000/svg"><path fill="url(#paint)" d="M0 0"/></svg>',
			'<svg xmlns="http://www.w3.org/2000/svg"><path fill="data:image/svg+xml,x" d="M0 0"/></svg>',
			'<!DOCTYPE svg [<!ENTITY x "boom">]><svg xmlns="http://www.w3.org/2000/svg"><text>&x;</text></svg>',
			'<svg xmlns="http://www.w3.org/2000/svg"><text>&#65;</text></svg>',
			'<svg xmlns="urn:not-svg"><path d="M0 0"/></svg>',
			'<svg xmlns="http://www.w3.org/2000/svg" xmlns:x="urn:evil"><x:path d="M0 0"/></svg>',
			'<svg xmlns="http://www.w3.org/2000/svg" fill="red" fill="blue"/>',
			'<svg xmlns="http://www.w3.org/2000/svg"><path fill="#12345" d="M0 0"/></svg>',
			'<svg xmlns="http://www.w3.org/2000/svg"><path fill="rgb(999,0,0)" d="M0 0"/></svg>',
			'<svg xmlns="http://www.w3.org/2000/svg" opacity="2"/>',
			'<svg xmlns="http://www.w3.org/2000/svg" width="-1"/>',
		];

		for (const [index, source] of unsafeSources.entries()) {
			const result = sanitizeOfficeSvg({ nodeId: `unsafe-${index}`, assetId: `unsafe-${index}`, source });
			ok(!hasBytes(result), source);
			strictEqual(result.reason, 'unsafe');
			strictEqual(result.feature, 'svg');
			ok(/^[a-f\d]{64}$/.test(result.fingerprint ?? ''));
		}
	});

	test('rejects stateful SVG input instead of validating and publishing different snapshots', () => {
		const input = { nodeId: 'stateful-svg', assetId: 'stateful-svg' } as { nodeId: string; assetId: string; source: string };
		Object.defineProperty(input, 'source', { enumerable: true, get: () => '<svg xmlns="http://www.w3.org/2000/svg"/>' });

		const result = sanitizeOfficeSvg(input);

		ok(!hasBytes(result));
		strictEqual(result.reason, 'unsafe');
	});

	test('enforces SVG byte, depth, node, and attribute budgets before publishing bytes', () => {
		const deep = `<svg xmlns="http://www.w3.org/2000/svg">${'<g>'.repeat(65)}${'</g>'.repeat(65)}</svg>`;
		const many = `<svg xmlns="http://www.w3.org/2000/svg">${'<g/>'.repeat(16_385)}</svg>`;
		const longAttribute = `<svg xmlns="http://www.w3.org/2000/svg"><text font-family="${'a'.repeat(4_097)}">x</text></svg>`;
		const oversized = `<svg xmlns="http://www.w3.org/2000/svg"><text>${'a'.repeat(1_048_577)}</text></svg>`;

		for (const [index, source] of [deep, many, longAttribute, oversized].entries()) {
			const result = sanitizeOfficeSvg({ nodeId: `bounded-${index}`, assetId: `bounded-${index}`, source });
			ok(!hasBytes(result));
			strictEqual(result.reason, 'budget');
		}
	});

	test('validates a raw SFNT and publishes only a trusted bounded WOFF2 subset', () => {
		const source = minimalSfnt([{ tag: 'maxp', bytes: new Uint8Array([0, 1, 0, 0, 0, 3]) }]);
		const subsetBytes = minimalWoff2([{ tag: 'maxp', originalLength: 6 }]);
		const trustedSubset: ParadisOfficeTrustedFontSubset = {
			bytes: subsetBytes,
			glyphCount: 2,
			expandedByteLength: 36,
			hasExternalReferences: false,
		};
		let sourceSeenBySubsetter: Uint8Array | undefined;

		const result = validateAndSubsetOfficeFont({
			nodeId: 'font-1',
			assetId: 'asset-font-1',
			source,
			glyphIds: [0, 2],
			altText: 'Embedded font',
			subsetter: (sourceSnapshot, glyphIds) => {
				sourceSeenBySubsetter = sourceSnapshot;
				deepStrictEqual(glyphIds, [0, 2]);
				return trustedSubset;
			},
		});

		if (!hasBytes(result)) {
			throw new Error('Expected a trusted font subset');
		}
		strictEqual(result.kind, 'fontSubset');
		strictEqual(result.mime, 'font/woff2');
		strictEqual(result.fingerprint.byteLength, subsetBytes.byteLength);
		deepStrictEqual(result.bytes, subsetBytes);
		notStrictEqual(result.bytes, subsetBytes);
		notStrictEqual(sourceSeenBySubsetter, source);
	});

	test('rejects unsafe raw font tables and invalid, oversized, or externally referencing subset output', () => {
		const validSource = minimalSfnt([{ tag: 'maxp', bytes: new Uint8Array([0, 1, 0, 0, 0, 1]) }]);
		const safeSubset = minimalWoff2([{ tag: 'maxp', originalLength: 6 }]);
		const svgFont = minimalSfnt([{ tag: 'SVG ', bytes: new Uint8Array([0, 0, 0, 0]) }]);
		const invalidOffset = validSource.slice();
		writeU32(invalidOffset, 20, 0xfffffff0);
		const overlap = minimalSfnt([
			{ tag: 'maxp', bytes: new Uint8Array([0, 1, 0, 0, 0, 1]) },
			{ tag: 'name', bytes: new Uint8Array([0, 0, 0, 0]) },
		]);
		writeU32(overlap, 28 + 8, 44);
		const missingMaxp = minimalSfnt([{ tag: 'name', bytes: new Uint8Array([0, 0, 0, 0]) }]);
		const invalidWoff2Metadata = safeSubset.slice();
		writeU32(invalidWoff2Metadata, 28, invalidWoff2Metadata.byteLength);
		writeU32(invalidWoff2Metadata, 36, 0xffffffff);
		const emptyWoff2Payload = safeSubset.slice();
		writeU32(emptyWoff2Payload, 20, 0);
		const undersizedExpandedWoff2 = safeSubset.slice();
		writeU32(undersizedExpandedWoff2, 16, 1);

		const cases = [
			{ source: svgFont, subset: { bytes: safeSubset, glyphCount: 1, expandedByteLength: 36, hasExternalReferences: false } },
			{ source: invalidOffset, subset: { bytes: safeSubset, glyphCount: 1, expandedByteLength: 36, hasExternalReferences: false } },
			{ source: overlap, subset: { bytes: safeSubset, glyphCount: 1, expandedByteLength: 36, hasExternalReferences: false } },
			{ source: missingMaxp, subset: { bytes: safeSubset, glyphCount: 1, expandedByteLength: 36, hasExternalReferences: false } },
			{ source: validSource, subset: { bytes: validSource, glyphCount: 1, expandedByteLength: 36, hasExternalReferences: false } },
			{ source: validSource, subset: { bytes: safeSubset, glyphCount: 65_536, expandedByteLength: 36, hasExternalReferences: false } },
			{ source: validSource, subset: { bytes: safeSubset, glyphCount: 0, expandedByteLength: 36, hasExternalReferences: false } },
			{ source: validSource, subset: { bytes: safeSubset, glyphCount: 1, expandedByteLength: 134_217_729, hasExternalReferences: false } },
			{ source: validSource, subset: { bytes: safeSubset, glyphCount: 1, expandedByteLength: 36, hasExternalReferences: true } },
			{ source: validSource, subset: { bytes: invalidWoff2Metadata, glyphCount: 1, expandedByteLength: 36, hasExternalReferences: false } },
			{ source: validSource, subset: { bytes: emptyWoff2Payload, glyphCount: 1, expandedByteLength: 36, hasExternalReferences: false } },
			{ source: validSource, subset: { bytes: undersizedExpandedWoff2, glyphCount: 1, expandedByteLength: 1, hasExternalReferences: false } },
		];

		for (const [index, entry] of cases.entries()) {
			const result = validateAndSubsetOfficeFont({
				nodeId: `font-unsafe-${index}`,
				assetId: `font-unsafe-${index}`,
				source: entry.source,
				glyphIds: [0],
				subsetter: () => entry.subset,
			});
			ok(!hasBytes(result));
			strictEqual(result.reason, 'unsafe');
			strictEqual(result.feature, 'embeddedFont');
		}
	});

	test('uses a deterministic placeholder when a trusted font subsetter is unavailable', () => {
		const source = minimalSfnt([{ tag: 'maxp', bytes: new Uint8Array([0, 1, 0, 0, 0, 1]) }]);
		const first = validateAndSubsetOfficeFont({ nodeId: 'font-no-subsetter', assetId: 'font-no-subsetter', source, glyphIds: [0] });
		const second = validateAndSubsetOfficeFont({ nodeId: 'font-no-subsetter', assetId: 'font-no-subsetter', source, glyphIds: [0] });

		ok(!hasBytes(first) && !hasBytes(second));
		strictEqual(first.reason, 'unsupported');
		strictEqual(first.fingerprint, second.fingerprint);
	});

	test('rejects stateful trusted subset output instead of publishing a later byte snapshot', () => {
		const source = minimalSfnt([{ tag: 'maxp', bytes: new Uint8Array([0, 1, 0, 0, 0, 1]) }]);
		const subsetBytes = minimalWoff2([{ tag: 'maxp', originalLength: 6 }]);
		const statefulSubset = { glyphCount: 1, expandedByteLength: 36, hasExternalReferences: false } as ParadisOfficeTrustedFontSubset;
		Object.defineProperty(statefulSubset, 'bytes', { enumerable: true, get: () => subsetBytes });

		const result = validateAndSubsetOfficeFont({
			nodeId: 'font-stateful-subset', assetId: 'font-stateful-subset', source, glyphIds: [0], subsetter: () => statefulSubset,
		});

		ok(!hasBytes(result));
		strictEqual(result.reason, 'unsafe');
	});
});

function hasBytes(value: object): value is ParadisSanitizedSvg | ParadisRenderableFont {
	return Object.prototype.hasOwnProperty.call(value, 'bytes');
}

function minimalSfnt(tables: readonly { readonly tag: string; readonly bytes: Uint8Array }[]): Uint8Array {
	const directoryEnd = 12 + tables.length * 16;
	let offset = directoryEnd;
	const records = tables.map(table => {
		const record = { ...table, offset };
		offset += (table.bytes.byteLength + 3) & ~3;
		return record;
	});
	const result = new Uint8Array(offset);
	writeU32(result, 0, 0x00010000);
	writeU16(result, 4, tables.length);
	for (const [index, table] of records.entries()) {
		const recordOffset = 12 + index * 16;
		writeTag(result, recordOffset, table.tag);
		writeU32(result, recordOffset + 4, tableChecksum(table.bytes));
		writeU32(result, recordOffset + 8, table.offset);
		writeU32(result, recordOffset + 12, table.bytes.byteLength);
		result.set(table.bytes, table.offset);
	}
	return result;
}

function tableChecksum(bytes: Uint8Array): number {
	let sum = 0;
	for (let offset = 0; offset < bytes.byteLength; offset += 4) {
		const word = (bytes[offset] ?? 0) * 0x1000000
			+ (bytes[offset + 1] ?? 0) * 0x10000
			+ (bytes[offset + 2] ?? 0) * 0x100
			+ (bytes[offset + 3] ?? 0);
		sum = (sum + word) >>> 0;
	}
	return sum;
}

function minimalWoff2(tables: readonly { readonly tag: string; readonly originalLength: number }[]): Uint8Array {
	const knownTags = ['cmap', 'head', 'hhea', 'hmtx', 'maxp', 'name'];
	const directory: number[] = [];
	for (const table of tables) {
		const tagIndex = knownTags.indexOf(table.tag);
		if (tagIndex < 0) {
			throw new Error(`Unsupported test tag ${table.tag}`);
		}
		directory.push(tagIndex, table.originalLength);
	}
	const result = new Uint8Array(48 + directory.length + 1);
	writeTag(result, 0, 'wOF2');
	writeU32(result, 4, 0x00010000);
	writeU32(result, 8, result.byteLength);
	writeU16(result, 12, tables.length);
	writeU32(result, 16, 36);
	writeU32(result, 20, 1);
	result.set(directory, 48);
	result[result.byteLength - 1] = 0;
	return result;
}

function writeTag(target: Uint8Array, offset: number, value: string): void {
	for (let index = 0; index < 4; index++) {
		target[offset + index] = value.charCodeAt(index);
	}
}

function writeU16(target: Uint8Array, offset: number, value: number): void {
	target[offset] = value >>> 8;
	target[offset + 1] = value;
}

function writeU32(target: Uint8Array, offset: number, value: number): void {
	target[offset] = value >>> 24;
	target[offset + 1] = value >>> 16;
	target[offset + 2] = value >>> 8;
	target[offset + 3] = value;
}
