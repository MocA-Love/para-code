/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.
// allow-any-unicode-comment-file

import { deepStrictEqual, notStrictEqual, ok, rejects, strictEqual, throws } from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { CancellationTokenSource } from '../../../../../base/common/cancellation.js';
import { decodeBase64 } from '../../../../../base/common/buffer.js';
import { buildParadisOfficeWordCsp, fingerprintOfficeAssetForDecoder, sanitizeOfficeDocxPackageForRenderer, sanitizeOfficeSvg, validateAndSubsetOfficeFont, type ParadisOfficeDecodedFont, type ParadisRenderableFont, type ParadisSanitizedSvg, type ParadisOfficeTrustedFontSubset } from '../../common/paradisOfficeSanitizer.js';
import { parseParadisOfficeXml } from '../../common/office/paradisOfficeCanonicalXml.js';
import type { ParadisOfficeArchiveEntry, ParadisOfficeXmlNode } from '../../common/office/paradisOfficeArchive.js';

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
		for (const origins of [['http://localhost:43123'], ['http://127.0.0.1'], ['https://127.0.0.1:43123'], ['http://127.0.0.1:43123/path'], ['http://127.0.0.1:43123; img-src *']] as const) {
			throws(() =>
				buildParadisOfficeWordCsp('nonce', {
					kind: 'mountedLoopback',
					origins,
				}),
			);
		}
		for (const cspSources of [['https:'], ['https://*.vscode-resource.vscode-cdn.net'], ['https://trusted.example/path'], ['\'self\' https://trusted.example'], ['http://trusted.example']] as const) {
			throws(() =>
				buildParadisOfficeWordCsp('nonce', {
					kind: 'webviewResource',
					cspSources,
				}),
			);
		}
		throws(() =>
			buildParadisOfficeWordCsp('bad\' nonce', {
				kind: 'webviewResource',
				cspSources: ['https://trusted.example'],
			}),
		);
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
		deepStrictEqual(
			{
				id: first.id,
				kind: first.kind,
				mime: first.mime,
				byteLength: first.byteLength,
				altText: first.altText,
			},
			{
				id: 'asset-shape-1',
				kind: 'sanitizedSvg',
				mime: 'image/svg+xml',
				byteLength: first.bytes.byteLength,
				altText: 'Safe shape',
			},
		);
		strictEqual(first.fingerprint.algorithm, 'sha256');
		strictEqual(first.fingerprint.byteLength, first.bytes.byteLength);
		strictEqual(first.fingerprint.value, second.fingerprint.value);
		notStrictEqual(first, second);
		notStrictEqual(first.bytes, second.bytes);
	});

	test('turns active, externally referencing, and namespace-confused SVG into fingerprinted placeholders', () => {
		const unsafeSources = ['<svg xmlns="http://www.w3.org/2000/svg"><foreignObject/></svg>', '<svg xmlns="http://www.w3.org/2000/svg"><script/></svg>', '<svg xmlns="http://www.w3.org/2000/svg"><style/></svg>', '<svg xmlns="http://www.w3.org/2000/svg"><animate/></svg>', '<svg xmlns="http://www.w3.org/2000/svg"><filter/></svg>', '<svg xmlns="http://www.w3.org/2000/svg"><image/></svg>', '<svg xmlns="http://www.w3.org/2000/svg"><use href="#safe"/></svg>', '<svg xmlns="http://www.w3.org/2000/svg" onload="alert(1)"/>', '<svg xmlns="http://www.w3.org/2000/svg"><path href="https://attacker.example/x" d="M0 0"/></svg>', '<svg xmlns="http://www.w3.org/2000/svg"><path fill="url(#paint)" d="M0 0"/></svg>', '<svg xmlns="http://www.w3.org/2000/svg"><path fill="data:image/svg+xml,x" d="M0 0"/></svg>', '<!DOCTYPE svg [<!ENTITY x "boom">]><svg xmlns="http://www.w3.org/2000/svg"><text>&x;</text></svg>', '<svg xmlns="http://www.w3.org/2000/svg"><text>&#65;</text></svg>', '<svg xmlns="urn:not-svg"><path d="M0 0"/></svg>', '<svg xmlns="http://www.w3.org/2000/svg" xmlns:x="urn:evil"><x:path d="M0 0"/></svg>', '<svg xmlns="http://www.w3.org/2000/svg" fill="red" fill="blue"/>', '<svg xmlns="http://www.w3.org/2000/svg"><path fill="#12345" d="M0 0"/></svg>', '<svg xmlns="http://www.w3.org/2000/svg"><path fill="rgb(999,0,0)" d="M0 0"/></svg>', '<svg xmlns="http://www.w3.org/2000/svg" opacity="2"/>', '<svg xmlns="http://www.w3.org/2000/svg" width="-1"/>'];

		for (const [index, source] of unsafeSources.entries()) {
			const result = sanitizeOfficeSvg({
				nodeId: `unsafe-${index}`,
				assetId: `unsafe-${index}`,
				source,
			});
			ok(!hasBytes(result), source);
			strictEqual(result.reason, 'unsafe');
			strictEqual(result.feature, 'svg');
			ok(/^[a-f\d]{64}$/.test(result.fingerprint ?? ''));
		}
	});

	test('rejects stateful SVG input instead of validating and publishing different snapshots', () => {
		const input = { nodeId: 'stateful-svg', assetId: 'stateful-svg' } as {
			nodeId: string;
			assetId: string;
			source: string;
		};
		Object.defineProperty(input, 'source', {
			enumerable: true,
			get: () => '<svg xmlns="http://www.w3.org/2000/svg"/>',
		});

		const result = sanitizeOfficeSvg(input);

		ok(!hasBytes(result));
		strictEqual(result.reason, 'unsafe');
	});

	test('does not invent a fingerprint for oversized SVG and accepts only a precomputed all-byte identity', () => {
		const source = `<svg xmlns="http://www.w3.org/2000/svg"><text>${'x'.repeat(1_048_577)}</text></svg>`;
		const withoutIdentity = sanitizeOfficeSvg({
			nodeId: 'large-svg',
			assetId: 'large-svg',
			source,
		});
		const rawFingerprint = {
			algorithm: 'sha256',
			value: 'a'.repeat(64),
			byteLength: 1_048_636,
		} as const;
		const withIdentity = sanitizeOfficeSvg({
			nodeId: 'large-svg',
			assetId: 'large-svg',
			source,
			rawFingerprint,
		});

		ok(!hasBytes(withoutIdentity) && !hasBytes(withIdentity));
		strictEqual(withoutIdentity.fingerprint, undefined);
		strictEqual(withIdentity.fingerprint, rawFingerprint.value);
	});

	test('checks cancellation and caller checkpoints while hashing bounded assets', () => {
		let checkpoints = 0;
		const safe = sanitizeOfficeSvg({
			nodeId: 'checked-svg',
			assetId: 'checked-svg',
			source: '<svg xmlns="http://www.w3.org/2000/svg"/>',
			checkpoint: () => checkpoints++,
		});
		ok(hasBytes(safe));
		ok(checkpoints >= 2);
		const cancelled = new CancellationTokenSource();
		cancelled.cancel();
		try {
			throws(() =>
				sanitizeOfficeSvg({
					nodeId: 'cancelled-svg',
					assetId: 'cancelled-svg',
					source: '<svg xmlns="http://www.w3.org/2000/svg"/>',
					token: cancelled.token,
				}),
			);
		} finally {
			cancelled.dispose();
		}
	});

	test('rejects malformed SVG path, point, and transform grammars instead of character-whitelisting them', () => {
		const invalidAttributes = ['d="M 0"', 'd="M0 0 A1 1 0 2 0 2 2"', 'd="M0 0,,L1 1"', `d="M0 0 ${'L1 1 '.repeat(8_193)}"`, 'points="0,0,1"', 'transform="matrix(1 0 0)"', 'transform="translate(1,,2)"'];
		for (const [index, attribute] of invalidAttributes.entries()) {
			const element = attribute.startsWith('points') ? 'polygon' : 'path';
			const result = sanitizeOfficeSvg({
				nodeId: `svg-grammar-${index}`,
				assetId: `svg-grammar-${index}`,
				source: `<svg xmlns="http://www.w3.org/2000/svg"><${element} ${attribute}/></svg>`,
			});
			ok(!hasBytes(result), attribute);
		}
	});

	test('preprocesses package media before renderer publication and emits a typed safe asset manifest', async () => {
		const archive = new MemoryOfficeArchive({
			'[Content_Types].xml': '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/><Override PartName="/word/media/safe.svg" ContentType="image/svg+xml"/><Override PartName="/word/media/unsafe.svg" ContentType="image/svg+xml"/><Override PartName="/word/media/unknown.bin" ContentType="application/octet-stream"/><Override PartName="/word/fonts/font1.odttf" ContentType="application/x-font-ttf"/><Override PartName="/word/afchunk/chunk1.html" ContentType="text/html"/></Types>',
			'_rels/.rels': '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="root" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>',
			'word/document.xml': '<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><w:body><w:p><w:r><w:drawing><a:blip r:embed="safe"/></w:drawing><w:drawing><a:blip r:embed="unsafe"/></w:drawing><w:drawing><a:blip r:embed="unknown"/></w:drawing></w:r></w:p></w:body></w:document>',
			'word/_rels/document.xml.rels': '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="safe" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" Target="media/safe.svg"/><Relationship Id="unsafe" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" Target="media/unsafe.svg"/><Relationship Id="unknown" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" Target="media/unknown.bin"/><Relationship Id="font" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/font" Target="fonts/font1.odttf"/><Relationship Id="chunk" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/aFChunk" Target="afchunk/chunk1.html"/></Relationships>',
			'word/media/safe.svg': '<svg xmlns="http://www.w3.org/2000/svg"><path d="M0 0 L1 1"/></svg>',
			'word/media/unsafe.svg': '<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>',
			'word/media/unknown.bin': 'UNSAFE-MEDIA-BYTES',
			'word/fonts/font1.odttf': 'RAW-FONT-BYTES',
			'word/afchunk/chunk1.html': '<script>RAW-ALTCHUNK</script>',
		});

		const result = await sanitizeOfficeDocxPackageForRenderer({
			nodeId: 'package-1',
			source: Uint8Array.of(0x50, 0x4b, 0x03, 0x04),
			archive,
		});
		const serialized = new TextDecoder().decode(result.bytes);

		strictEqual(serialized.includes('<script>'), false);
		strictEqual(serialized.includes('UNSAFE-MEDIA-BYTES'), false);
		strictEqual(serialized.includes('RAW-FONT-BYTES'), false);
		strictEqual(serialized.includes('RAW-ALTCHUNK'), false);
		ok(serialized.includes('<path d="M 0 0 L 1 1"/>'));
		ok(serialized.includes('Office asset unavailable'));
		strictEqual(
			result.assets.some((asset) => asset.kind === 'sanitizedSvg'),
			true,
		);
		strictEqual(
			result.assets.some((asset) => asset.kind === 'placeholderPreview'),
			true,
		);
		strictEqual(result.placeholders.length, 4);
	});

	test('classifies custom-path assets from OPC content types and relationships and rewrites visible anchors', async () => {
		const archive = new MemoryOfficeArchive({
			'[Content_Types].xml': '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/><Override PartName="/custom/payload.bin" ContentType="image/svg+xml"/><Override PartName="/custom/chunk.bin" ContentType="text/html"/><Override PartName="/custom/font.bin" ContentType="application/x-font-ttf"/><Override PartName="/custom/ole.bin" ContentType="application/vnd.openxmlformats-officedocument.oleObject"/><Override PartName="/word/vbaProject.bin" ContentType="application/vnd.ms-office.vbaProject"/></Types>',
			'_rels/.rels': '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rRoot" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>',
			'word/document.xml': '<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><w:body><w:p><w:r><w:t>Body</w:t><w:drawing><a:blip r:embed="rSvg"/></w:drawing></w:r></w:p></w:body></w:document>',
			'word/_rels/document.xml.rels': '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rSvg" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" Target="../custom/payload.bin"/><Relationship Id="rChunk" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/aFChunk" Target="../custom/chunk.bin"/><Relationship Id="rFont" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/font" Target="../custom/font.bin"/><Relationship Id="rOle" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/oleObject" Target="../custom/ole.bin"/><Relationship Id="rExternal" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/hyperlink" Target="https://attacker.example" TargetMode="External"/></Relationships>',
			'custom/payload.bin': '<svg xmlns="http://www.w3.org/2000/svg"><path d="M0 0 L1 1"/></svg>',
			'custom/chunk.bin': '<script>ALT-CHUNK</script>',
			'custom/font.bin': 'RAW-CUSTOM-FONT',
			'custom/ole.bin': 'RAW-OLE',
			'word/vbaProject.bin': 'RAW-MACRO',
		});

		const result = await sanitizeOfficeDocxPackageForRenderer({
			nodeId: 'semantic-package',
			source: Uint8Array.of(0x50, 0x4b, 0x03, 0x04),
			archive,
		});
		const serialized = new TextDecoder().decode(result.bytes);

		ok(serialized.includes('<path d="M 0 0 L 1 1"/>'));
		ok(serialized.includes('Office asset unavailable'));
		for (const forbidden of ['ALT-CHUNK', 'RAW-CUSTOM-FONT', 'RAW-OLE', 'RAW-MACRO', 'attacker.example', 'oleObject', 'aFChunk']) {
			strictEqual(serialized.includes(forbidden), false, forbidden);
		}
		ok(result.placeholders.length >= 5);
		strictEqual(
			result.assets.some((asset) => asset.kind === 'sanitizedSvg'),
			true,
		);
		strictEqual((result.bytes[6] | (result.bytes[7] << 8)) & 0x0800, 0x0800);
	});

	test('rejects ZIP bombs, CRC mismatch, duplicate canonical names, and late cancellation before publication', async () => {
		const bomb = new MemoryOfficeArchive(
			{ 'word/document.xml': 'tiny' },
			{
				'word/document.xml': {
					compressedBytes: 1,
					declaredExpandedBytes: 1_000,
				},
			},
		);
		await rejects(
			sanitizeOfficeDocxPackageForRenderer({
				nodeId: 'bomb',
				source: Uint8Array.of(1),
				archive: bomb,
			}),
		);
		strictEqual(bomb.readCount, 0);

		const crcMismatch = new MemoryOfficeArchive({ 'word/document.xml': '<document/>' }, { 'word/document.xml': { crc32: 1 } });
		await rejects(
			sanitizeOfficeDocxPackageForRenderer({
				nodeId: 'crc',
				source: Uint8Array.of(1),
				archive: crcMismatch,
			}),
		);

		const duplicate = new MemoryOfficeArchive({ 'word/document.xml': '<document/>' }, {}, ['word/document.xml']);
		await rejects(
			sanitizeOfficeDocxPackageForRenderer({
				nodeId: 'duplicate',
				source: Uint8Array.of(1),
				archive: duplicate,
			}),
		);

		const cancellation = new CancellationTokenSource();
		let schedulerYields = 0;
		try {
			await rejects(
				sanitizeOfficeDocxPackageForRenderer({
					nodeId: 'cancel',
					source: Uint8Array.of(1),
					archive: new MemoryOfficeArchive({
						'word/document.xml': '<document/>',
					}),
					token: cancellation.token,
					scheduler: () =>
						new Promise<void>((resolve) =>
							setTimeout(() => {
								if (++schedulerYields === 2) {
									cancellation.cancel();
								}
								resolve();
							}, 0),
						),
				}),
			);
		} finally {
			cancellation.dispose();
		}
		ok(schedulerYields >= 2);
	});

	test('fails closed on unknown relationships and duplicate or dangling OPC declarations', async () => {
		const base = {
			'[Content_Types].xml': '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/><Override PartName="/custom/payload.bin" ContentType="image/svg+xml"/></Types>',
			'word/document.xml': '<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p/></w:body></w:document>',
			'custom/payload.bin': '<svg xmlns="http://www.w3.org/2000/svg"/>',
		};
		const invalidRels = ['<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="x" Type="urn:custom:drawing" Target="../custom/payload.bin"/></Relationships>', '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="x" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" Target="../custom/payload.bin"/><Relationship Id="x" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" Target="../custom/payload.bin"/></Relationships>', '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="x" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" Target="../missing.bin"/></Relationships>'];
		for (const [index, rels] of invalidRels.entries()) {
			await rejects(
				sanitizeOfficeDocxPackageForRenderer({
					nodeId: `invalid-opc-${index}`,
					source: Uint8Array.of(1),
					archive: new MemoryOfficeArchive({
						...base,
						'word/_rels/document.xml.rels': rels,
					}),
				}),
			);
		}
		const duplicateTypes = new MemoryOfficeArchive({
			...base,
			'[Content_Types].xml': '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Override PartName="/custom/payload.bin" ContentType="image/svg+xml"/><Override PartName="/CUSTOM/PAYLOAD.BIN" ContentType="image/svg+xml"/></Types>',
		});
		await rejects(
			sanitizeOfficeDocxPackageForRenderer({
				nodeId: 'duplicate-types',
				source: Uint8Array.of(1),
				archive: duplicateTypes,
			}),
		);
	});

	test('replaces each relationship consumer in Word stories and rejects a 257th placeholder', async () => {
		const types = '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/><Override PartName="/word/header1.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.header+xml"/><Override PartName="/custom/ole.bin" ContentType="application/vnd.openxmlformats-officedocument.oleObject"/></Types>';
		const rels = '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="ole" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/oleObject" Target="../custom/ole.bin"/></Relationships>';
		const result = await sanitizeOfficeDocxPackageForRenderer({
			nodeId: 'story',
			source: Uint8Array.of(1),
			archive: new MemoryOfficeArchive({
				'[Content_Types].xml': types,
				'word/document.xml': '<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body/></w:document>',
				'word/header1.xml': '<w:hdr xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><w:p><w:r><w:drawing r:id="ole"/></w:r></w:p></w:hdr>',
				'word/_rels/header1.xml.rels': rels,
				'custom/ole.bin': 'OLE',
			}),
		});
		const serialized = new TextDecoder().decode(result.bytes);
		strictEqual(serialized.includes('r:id="ole"'), false);
		ok(serialized.includes('Office asset unavailable'));

		const externalRelationships = Array.from({ length: 257 }, (_, index) => `<Relationship Id="e${index}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/hyperlink" Target="https://example.invalid/${index}" TargetMode="External"/>`).join('');
		await rejects(
			sanitizeOfficeDocxPackageForRenderer({
				nodeId: 'too-many-placeholders',
				source: Uint8Array.of(1),
				archive: new MemoryOfficeArchive({
					'[Content_Types].xml': '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>',
					'word/document.xml': '<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body/></w:document>',
					'word/_rels/document.xml.rels': `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${externalRelationships}</Relationships>`,
				}),
			}),
		);
	});

	test('rejects a full relationship URI spoof instead of accepting its header suffix', async () => {
		const result = await sanitizeMemoryPackage('spoofed-uri', {
			'[Content_Types].xml': contentTypes([
				['/word/document.xml', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml'],
				['/word/header1.xml', 'application/vnd.openxmlformats-officedocument.wordprocessingml.header+xml'],
			]),
			'word/document.xml': '<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><w:body><w:sectPr><w:headerReference w:type="default" r:id="spoof"/></w:sectPr></w:body></w:document>',
			'word/_rels/document.xml.rels': relationships('<Relationship Id="spoof" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/attacker/header" Target="header1.xml"/>'),
			'word/header1.xml': '<w:hdr xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:p><w:r><w:t>ATTACKER-HEADER</w:t></w:r></w:p></w:hdr>',
		});
		const entries = readStoreZipEntries(result.bytes);
		const documentXml = textOf(entries, 'word/document.xml');
		const relationshipXml = textOf(entries, 'word/_rels/document.xml.rels');

		strictEqual(relationshipXml.includes('/attacker/header'), false);
		strictEqual(documentXml.includes('r:id="spoof"'), false);
		strictEqual(entries.has('word/header1.xml'), false);
		ok(documentXml.includes('Office asset unavailable'));
	});

	test('replaces an exact header relationship when a DrawingML consumer misuses it', async () => {
		const result = await sanitizeMemoryPackage('wrong-consumer', {
			'[Content_Types].xml': contentTypes([
				['/word/document.xml', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml'],
				['/word/header1.xml', 'application/vnd.openxmlformats-officedocument.wordprocessingml.header+xml'],
			]),
			'word/document.xml': '<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><w:body><w:p><w:r><w:drawing><a:graphic><a:graphicData><a:blip r:embed="wrong"/></a:graphicData></a:graphic></w:drawing></w:r></w:p></w:body></w:document>',
			'word/_rels/document.xml.rels': relationships('<Relationship Id="wrong" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/header" Target="header1.xml"/>'),
			'word/header1.xml': '<w:hdr xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:p><w:r><w:t>MISUSED-HEADER</w:t></w:r></w:p></w:hdr>',
		});
		const entries = readStoreZipEntries(result.bytes);
		const documentXml = textOf(entries, 'word/document.xml');

		strictEqual(documentXml.includes('wrong'), false);
		ok(documentXml.includes('blip'));
		ok(documentXml.includes('graphicData'));
		strictEqual(entries.has('word/header1.xml'), false);
		ok(documentXml.includes('Office asset unavailable:'));
	});

	test('does not accept an a:blip outside w:drawing as an image consumer', async () => {
		const result = await sanitizeMemoryPackage('wrong-image-context', {
			'[Content_Types].xml': contentTypes([
				['/word/document.xml', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml'],
				['/word/media/image.svg', 'image/svg+xml'],
			]),
			'word/document.xml': '<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><w:body><w:p><w:r><a:blip r:embed="image"/></w:r></w:p></w:body></w:document>',
			'word/_rels/document.xml.rels': relationships('<Relationship Id="image" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" Target="media/image.svg"/>'),
			'word/media/image.svg': '<svg xmlns="http://www.w3.org/2000/svg"><text>WRONG-CONTEXT</text></svg>',
		});
		const entries = readStoreZipEntries(result.bytes);
		const documentXml = textOf(entries, 'word/document.xml');

		strictEqual(entries.has('word/media/image.svg'), false);
		strictEqual(documentXml.includes('<a:blip'), false);
		ok(documentXml.includes('Office asset unavailable:'));
	});

	test('replaces a referenced image with no content type and removes an unreferenced binary', async () => {
		const result = await sanitizeMemoryPackage('missing-content-type', {
			'[Content_Types].xml': contentTypes([
				['/word/document.xml', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml'],
			]),
			'word/document.xml': '<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><w:body><w:p><w:r><w:drawing><a:blip r:embed="missingCt"/></w:drawing></w:r></w:p></w:body></w:document>',
			'word/_rels/document.xml.rels': relationships('<Relationship Id="missingCt" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" Target="media/no-content-type.bin"/>'),
			'word/media/no-content-type.bin': 'REFERENCED-WITHOUT-CONTENT-TYPE',
			'word/media/orphan.bin': 'UNREFERENCED-BINARY',
		});
		const entries = readStoreZipEntries(result.bytes);
		const documentXml = textOf(entries, 'word/document.xml');

		strictEqual(entries.has('word/media/no-content-type.bin'), false);
		strictEqual(entries.has('word/media/orphan.bin'), false);
		strictEqual(documentXml.includes('missingCt'), false);
		ok(documentXml.includes('Office asset unavailable'));
	});

	test('validates duplicate relationship IDs even when both IDs have consumers', async () => {
		await rejects(sanitizeMemoryPackage('duplicate-consumer-ids', {
			'[Content_Types].xml': contentTypes([
				['/word/document.xml', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml'],
				['/word/media/image.svg', 'image/svg+xml'],
			]),
			'word/document.xml': '<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><w:body><w:p><w:r><w:drawing><a:blip r:embed="dup"/></w:drawing></w:r></w:p></w:body></w:document>',
			'word/_rels/document.xml.rels': relationships('<Relationship Id="dup" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" Target="media/image.svg"/><Relationship Id="dup" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" Target="media/image.svg"/>'),
			'word/media/image.svg': '<svg xmlns="http://www.w3.org/2000/svg"/>',
		}));
	});

	test('replaces every consumer of the same blocked relationship ID', async () => {
		const result = await sanitizeMemoryPackage('repeated-consumers', {
			'[Content_Types].xml': contentTypes([
				['/word/document.xml', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml'],
				['/custom/ole.bin', 'application/vnd.openxmlformats-officedocument.oleObject'],
			]),
			'word/document.xml': '<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" xmlns:o="urn:schemas-microsoft-com:office:office" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><w:body><w:p><w:r><w:object><o:OLEObject r:id="blocked"/></w:object></w:r><w:r><w:object><o:OLEObject r:id="blocked"/></w:object></w:r></w:p></w:body></w:document>',
			'word/_rels/document.xml.rels': relationships('<Relationship Id="blocked" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/oleObject" Target="../custom/ole.bin"/>'),
			'custom/ole.bin': 'BLOCKED-OLE',
		});
		const documentXml = textOf(readStoreZipEntries(result.bytes), 'word/document.xml');

		strictEqual(documentXml.includes('r:id="blocked"'), false);
		strictEqual(countOccurrences(documentXml, 'Office asset unavailable:'), 2);
	});

	test('replaces a nested DrawingML consumer beside its preserved schema-valid Word run', async () => {
		const result = await sanitizeMemoryPackage('nested-drawing', {
			'[Content_Types].xml': contentTypes([
				['/word/document.xml', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml'],
				['/custom/ole.bin', 'application/vnd.openxmlformats-officedocument.oleObject'],
			]),
			'word/document.xml': '<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:pic="http://schemas.openxmlformats.org/drawingml/2006/picture" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><w:body><w:p><w:r><w:drawing><a:graphic><a:graphicData><pic:pic><pic:blipFill><a:blip r:embed="blocked"/></pic:blipFill></pic:pic></a:graphicData></a:graphic></w:drawing></w:r></w:p></w:body></w:document>',
			'word/_rels/document.xml.rels': relationships('<Relationship Id="blocked" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/oleObject" Target="../custom/ole.bin"/>'),
			'custom/ole.bin': 'BLOCKED-OLE',
		});
		const documentXml = textOf(readStoreZipEntries(result.bytes), 'word/document.xml');

		strictEqual(documentXml.includes('blocked'), false);
		ok(documentXml.includes('blip'));
		ok(documentXml.includes('drawing'));
		ok(documentXml.includes('Office asset unavailable:'));
	});

	test('preserves line, shape, anchor, transform, and diagonal-border geometry while blocking a DrawingML asset', async () => {
		const nonAssetDrawing = '<a:sp xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"><a:spPr><a:xfrm rot="2700000"><a:off x="91" y="92"/><a:ext cx="93" cy="94"/></a:xfrm><a:prstGeom prst="line"><a:avLst/></a:prstGeom><a:ln w="12700"/></a:spPr></a:sp>';
		const documentXml = '<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" xmlns:wp="http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:pic="http://schemas.openxmlformats.org/drawingml/2006/picture" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><w:body><w:p><w:r><w:drawing><wp:anchor distT="11" distB="12" distL="13" distR="14" simplePos="0" relativeHeight="15" behindDoc="0" locked="0" layoutInCell="1" allowOverlap="1"><wp:positionH relativeFrom="column"><wp:posOffset>160020</wp:posOffset></wp:positionH><wp:positionV relativeFrom="paragraph"><wp:posOffset>320040</wp:posOffset></wp:positionV><wp:extent cx="480060" cy="640080"/><a:graphic><a:graphicData><pic:pic><pic:blipFill><a:blip r:embed="blocked"/></pic:blipFill><pic:spPr><a:xfrm rot="5400000" flipH="1"><a:off x="101" y="202"/><a:ext cx="303" cy="404"/></a:xfrm><a:prstGeom prst="line"><a:avLst/></a:prstGeom><a:ln w="9525"><a:prstDash val="dash"/><a:headEnd type="none"/><a:tailEnd type="triangle"/></a:ln></pic:spPr></pic:pic></a:graphicData></a:graphic></wp:anchor></w:drawing></w:r></w:p><w:tbl><w:tr><w:tc><w:tcPr><w:tcBorders><w:tl2br w:val="single" w:sz="8" w:space="0" w:color="112233"/><w:tr2bl w:val="dashed" w:sz="6" w:space="1" w:color="445566"/></w:tcBorders></w:tcPr><w:p/></w:tc></w:tr></w:tbl></w:body></w:document>';
		const result = await sanitizeMemoryPackage('preserved-drawing-geometry', {
			'[Content_Types].xml': contentTypes([
				['/word/document.xml', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml'],
				['/word/drawings/nonAsset.xml', 'application/xml'],
				['/custom/ole.bin', 'application/vnd.openxmlformats-officedocument.oleObject'],
			]),
			'word/document.xml': documentXml,
			'word/_rels/document.xml.rels': relationships('<Relationship Id="blocked" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/oleObject" Target="../custom/ole.bin"/>'),
			'word/drawings/nonAsset.xml': nonAssetDrawing,
			'custom/ole.bin': 'BLOCKED-OLE',
		});
		const entries = readStoreZipEntries(result.bytes);
		const sanitizedDocument = textOf(entries, 'word/document.xml');

		deepStrictEqual(drawingGeometrySignature(sanitizedDocument), drawingGeometrySignature(documentXml));
		strictEqual(textOf(entries, 'word/drawings/nonAsset.xml'), nonAssetDrawing);
		strictEqual(sanitizedDocument.includes('blocked'), false);
		ok(sanitizedDocument.includes('Office asset unavailable:'));
	});

	test('replaces a body altChunk with a schema-valid block paragraph and keeps sectPr last', async () => {
		const result = await sanitizeMemoryPackage('body-altchunk', {
			'[Content_Types].xml': contentTypes([
				['/word/document.xml', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml'],
				['/word/afchunk/chunk.html', 'text/html'],
			]),
			'word/document.xml': '<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><w:body><w:p><w:r><w:t>Before</w:t></w:r></w:p><w:altChunk r:id="chunk"/><w:sectPr/></w:body></w:document>',
			'word/_rels/document.xml.rels': relationships('<Relationship Id="chunk" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/aFChunk" Target="afchunk/chunk.html"/>'),
			'word/afchunk/chunk.html': '<p>UNSAFE-HTML</p>',
		});
		const documentXml = textOf(readStoreZipEntries(result.bytes), 'word/document.xml');

		strictEqual(documentXml.includes('<w:altChunk'), false);
		ok(documentXml.includes('<w:p><w:r><w:t>Office asset unavailable:'));
		ok(documentXml.lastIndexOf('<w:p>') < documentXml.lastIndexOf('<w:sectPr'));
		ok(documentXml.lastIndexOf('<w:sectPr') < documentXml.lastIndexOf('</w:body>'));
	});

	test('anchors blocked consumers in their own Word story without duplicating them in the main body', async () => {
		const stories = [
			{ name: 'word/document.xml', root: 'document', container: '<w:body><w:p><w:hyperlink r:id="blocked"><w:r><w:t>Main</w:t></w:r></w:hyperlink></w:p></w:body>', contentType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml' },
			{ name: 'word/header1.xml', root: 'hdr', container: '<w:p><w:hyperlink r:id="blocked"><w:r><w:t>Header</w:t></w:r></w:hyperlink></w:p>', contentType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.header+xml' },
			{ name: 'word/footer1.xml', root: 'ftr', container: '<w:p><w:hyperlink r:id="blocked"><w:r><w:t>Footer</w:t></w:r></w:hyperlink></w:p>', contentType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.footer+xml' },
			{ name: 'word/footnotes.xml', root: 'footnotes', container: '<w:footnote w:id="1"><w:p><w:hyperlink r:id="blocked"><w:r><w:t>Footnote</w:t></w:r></w:hyperlink></w:p></w:footnote>', contentType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.footnotes+xml' },
			{ name: 'word/endnotes.xml', root: 'endnotes', container: '<w:endnote w:id="1"><w:p><w:hyperlink r:id="blocked"><w:r><w:t>Endnote</w:t></w:r></w:hyperlink></w:p></w:endnote>', contentType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.endnotes+xml' },
			{ name: 'word/comments.xml', root: 'comments', container: '<w:comment w:id="1"><w:p><w:hyperlink r:id="blocked"><w:r><w:t>Comment</w:t></w:r></w:hyperlink></w:p></w:comment>', contentType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.comments+xml' },
		] as const;
		const files: Record<string, string> = {
			'[Content_Types].xml': contentTypes(stories.map(story => [`/${story.name}`, story.contentType])),
		};
		for (const story of stories) {
			files[story.name] = `<w:${story.root} xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">${story.container}</w:${story.root}>`;
			const slash = story.name.lastIndexOf('/');
			files[`${story.name.slice(0, slash)}/_rels/${story.name.slice(slash + 1)}.rels`] = relationships('<Relationship Id="blocked" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/hyperlink" Target="https://example.invalid" TargetMode="External"/>');
		}

		const entries = readStoreZipEntries((await sanitizeMemoryPackage('story-anchors', files)).bytes);
		for (const story of stories) {
			const xml = textOf(entries, story.name);
			strictEqual(xml.includes('r:id="blocked"'), false, story.name);
			strictEqual(countOccurrences(xml, 'Office asset unavailable:'), 1, story.name);
		}
		strictEqual(countOccurrences(textOf(entries, 'word/document.xml'), 'Office asset unavailable:'), 1);
	});

	test('removes media referenced only by a story that was itself removed', async () => {
		const result = await sanitizeMemoryPackage('removed-story-media', {
			'[Content_Types].xml': contentTypes([
				['/word/document.xml', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml'],
				['/word/header1.xml', 'application/vnd.openxmlformats-officedocument.wordprocessingml.header+xml'],
				['/word/media/header.svg', 'image/svg+xml'],
			]),
			'word/document.xml': '<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><w:body><w:sectPr><w:headerReference w:type="default" r:id="header"/></w:sectPr></w:body></w:document>',
			'word/_rels/document.xml.rels': relationships('<Relationship Id="header" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/attacker/header" Target="header1.xml"/>'),
			'word/header1.xml': '<w:hdr xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><w:p><w:r><w:drawing><a:blip r:embed="image"/></w:drawing></w:r></w:p></w:hdr>',
			'word/_rels/header1.xml.rels': relationships('<Relationship Id="image" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" Target="media/header.svg"/>'),
			'word/media/header.svg': '<svg xmlns="http://www.w3.org/2000/svg"><text>ORPHANED-HEADER-MEDIA</text></svg>',
		});
		const entries = readStoreZipEntries(result.bytes);

		strictEqual(entries.has('word/header1.xml'), false);
		strictEqual(entries.has('word/_rels/header1.xml.rels'), false);
		strictEqual(entries.has('word/media/header.svg'), false);
	});

	test('does not classify a safe fontTable XML part as an embedded font', async () => {
		const result = await sanitizeMemoryPackage('font-table', {
			'[Content_Types].xml': contentTypes([
				['/word/document.xml', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml'],
				['/word/fontTable.xml', 'application/vnd.openxmlformats-officedocument.wordprocessingml.fontTable+xml'],
			]),
			'word/document.xml': '<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body/></w:document>',
			'word/_rels/document.xml.rels': relationships('<Relationship Id="fonts" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/fontTable" Target="fontTable.xml"/>'),
			'word/fontTable.xml': '<w:fonts xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"/>',
		});

		strictEqual(readStoreZipEntries(result.bytes).has('word/fontTable.xml'), true);
		strictEqual(result.placeholders.length, 0);
	});

	test('writes placeholders in the source story Word namespace for Strict OPC', async () => {
		const strictWord = 'http://purl.oclc.org/ooxml/wordprocessingml/main';
		const strictRelationships = 'http://purl.oclc.org/ooxml/officeDocument/relationships';
		const result = await sanitizeMemoryPackage('strict-story', {
			'[Content_Types].xml': contentTypes([
				['/word/document.xml', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml'],
				['/word/afchunk/chunk.html', 'text/html'],
			]),
			'word/document.xml': `<w:document xmlns:w="${strictWord}" xmlns:r="${strictRelationships}"><w:body><w:altChunk r:id="chunk"/></w:body></w:document>`,
			'word/_rels/document.xml.rels': relationships('<Relationship Id="chunk" Type="http://purl.oclc.org/ooxml/officeDocument/relationships/aFChunk" Target="afchunk/chunk.html"/>'),
			'word/afchunk/chunk.html': '<p>UNSAFE</p>',
		});
		const documentXml = textOf(readStoreZipEntries(result.bytes), 'word/document.xml');

		ok(documentXml.includes(strictWord));
		strictEqual(documentXml.includes('http://schemas.openxmlformats.org/wordprocessingml/2006/main'), false);
		ok(documentXml.includes('Office asset unavailable:'));
	});

	test('rejects an invalid relationship TargetMode instead of treating it as internal', async () => {
		await rejects(sanitizeMemoryPackage('invalid-target-mode', {
			'[Content_Types].xml': contentTypes([
				['/word/document.xml', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml'],
				['/word/media/image.svg', 'image/svg+xml'],
			]),
			'word/document.xml': '<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><w:body><w:p><w:r><w:drawing><a:blip r:embed="image"/></w:drawing></w:r></w:p></w:body></w:document>',
			'word/_rels/document.xml.rels': relationships('<Relationship Id="image" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" Target="media/image.svg" TargetMode="Attacker"/>'),
			'word/media/image.svg': '<svg xmlns="http://www.w3.org/2000/svg"/>',
		}));
	});

	test('enforces SVG byte, depth, node, and attribute budgets before publishing bytes', () => {
		const deep = `<svg xmlns="http://www.w3.org/2000/svg">${'<g>'.repeat(65)}${'</g>'.repeat(65)}</svg>`;
		const many = `<svg xmlns="http://www.w3.org/2000/svg">${'<g/>'.repeat(16_385)}</svg>`;
		const longAttribute = `<svg xmlns="http://www.w3.org/2000/svg"><text font-family="${'a'.repeat(4_097)}">x</text></svg>`;
		const oversized = `<svg xmlns="http://www.w3.org/2000/svg"><text>${'a'.repeat(1_048_577)}</text></svg>`;

		for (const [index, source] of [deep, many, longAttribute, oversized].entries()) {
			const result = sanitizeOfficeSvg({
				nodeId: `bounded-${index}`,
				assetId: `bounded-${index}`,
				source,
			});
			ok(!hasBytes(result));
			strictEqual(result.reason, 'budget');
		}
	});

	test('refuses font publication until a production decoder trust boundary is available', () => {
		const source = minimalSfnt([{ tag: 'maxp', bytes: new Uint8Array([0, 1, 0, 0, 0, 3]) }]);
		const decodedSfnt = renderableSfnt(3);
		const subsetBytes = decoderBackedWoff2(decodedSfnt);
		const trustedSubset: ParadisOfficeTrustedFontSubset = {
			bytes: subsetBytes,
		};
		let sourceSeenBySubsetter: Uint8Array | undefined;
		let subsetSeenByDecoder: Uint8Array | undefined;

		const result = validateAndSubsetOfficeFont({
			nodeId: 'font-1',
			assetId: 'asset-font-1',
			source,
			glyphIds: [1, 2],
			altText: 'Embedded font',
			subsetter: (sourceSnapshot, glyphIds) => {
				sourceSeenBySubsetter = sourceSnapshot;
				deepStrictEqual(glyphIds, [1, 2]);
				return trustedSubset;
			},
			decoder: (subsetSnapshot) => {
				subsetSeenByDecoder = subsetSnapshot;
				return decodedFont(decodedSfnt, [0, 1, 2], [], subsetSnapshot);
			},
		});

		ok(!hasBytes(result));
		strictEqual(result.reason, 'unsupported');
		strictEqual(sourceSeenBySubsetter, undefined);
		strictEqual(subsetSeenByDecoder, undefined);
	});

	test('keeps an actual Brotli WOFF2 fixture blocked without a production decoder integration', () => {
		const woff2 = plainBase64('d09GMgABAAAAAAEwAAoAAAAAAqgAAADoAAEAAAAAAAAAAAAAAAAAAAAAAAAAAAAABmAANAocNgE2AiQDCAsGAAQgBYEWByYbBwIoLgrsBvmOsXBOxBC8oQ9ULET893vdnndfaH18NZ75wmUQrjXVLAqP8hgVpZgoVFdJEB7IxvlC5JUpu9n5D6xgy+P+Eo8Cjj3sLuxmNPC5jKc7D3SAA90Yawc52ESeLdUXVfvMRjpJQEdtMBjKDGrXBACwCxoKO0qwo9tF1wXDjG9ZADTQERTmAB2QWr67OX+rzoEg/F/Y9b4XUlP4eC/vnVOvbZQGwgk7xaQIq3wl/YKmBDQAACx5ERBBQDMvAkoQ0AfAnDP1RdEsoM2apVHWVQdzOX6e+oGxYxeuPLt34kHTHsUhAA==');
		const sfnt = plainBase64('AAEAAAAKAIAAAwAgT1MvMkUhRMsAAAEoAAAAYGNtYXAADACUAAABkAAAADRnbHlmAvU7NwAAAcwAAAAaaGVhZDBgWKwAAACsAAAANmhoZWEGQgPrAAAA5AAAACRobXR4BdwAAAAAAYgAAAAIbG9jYQANAAAAAAHEAAAABm1heHAABAAFAAABCAAAACBuYW1lyT7btQAAAegAAACWcG9zdAAoAAAAAAKAAAAAJgABAAAAAQAACWcqm18PPPUAAQPoAAAAAOayCogAAAAA5rIKiABkAAADhAK8AAAAAwACAAAAAAAAAAEAAAMg/zgAAAPoAAAAyAMgAAEAAAAAAAAAAAAAAAAAAAACAAEAAAACAAMAAQAAAAAAAgAAAAAAAAAAAAAAAAAAAAAAAwLuAZAABQAEAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAABAAAAAAAAAAAAAAAAPz8/PwAAAEEAQQMg/zgAAAMgAMgAAAAAAAAAAAAAAAAAAAAgAAAB9AAAA+gAAAAAAAIAAAADAAAAFAADAAEAAAAUAAQAIAAAAAQABAABAAAAQf//AAAAQf///8AAAQAAAAAAAAAAAA0AAAABAGQAAAOEArwAAgAAMwEBZAGQAZACvP1EAAAAAAAKAH4AAQAAAAAAAQABAAAAAQAAAAAAAgAHAAEAAQAAAAAAAwABAAAAAQAAAAAABAABAAAAAQAAAAAABgABAAAAAwABBAkAAQACAAgAAwABBAkAAgAOAAoAAwABBAkAAwACAAgAAwABBAkABAACAAgAAwABBAkABgACAAhQUmVndWxhcgBQAFIAZQBnAHUAbABhAHIAAAACAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAIAAAAkAAA=');
		let decoderReached = false;
		const result = validateAndSubsetOfficeFont({
			nodeId: 'real-woff2',
			assetId: 'real-woff2',
			source: sfnt,
			glyphIds: [1],
			subsetter: () => ({ bytes: woff2 }),
			decoder: (input) => {
				decoderReached = true;
				deepStrictEqual(input, woff2);
				return decodedFont(sfnt, [0, 1], [], input);
			},
		});
		ok(!hasBytes(result));
		strictEqual(result.reason, 'unsupported');
		strictEqual(decoderReached, false);
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

		const cases = [
			{ source: svgFont, bytes: safeSubset, subsetter: false },
			{ source: invalidOffset, bytes: safeSubset, subsetter: false },
			{ source: overlap, bytes: safeSubset, subsetter: false },
			{ source: missingMaxp, bytes: safeSubset, subsetter: false },
		];

		for (const [index, entry] of cases.entries()) {
			let subsetterCalls = 0;
			let decoderCalls = 0;
			const result = validateAndSubsetOfficeFont({
				nodeId: `font-unsafe-${index}`,
				assetId: `font-unsafe-${index}`,
				source: entry.source,
				glyphIds: [0],
				subsetter: () => {
					subsetterCalls++;
					return { bytes: entry.bytes };
				},
				decoder: (subset) => {
					decoderCalls++;
					return decodedFont(renderableSfnt(1), [0], [], subset);
				},
			});
			ok(!hasBytes(result));
			strictEqual(result.reason, 'unsafe');
			strictEqual(result.feature, 'embeddedFont');
			strictEqual(subsetterCalls, entry.subsetter ? 1 : 0);
			strictEqual(decoderCalls, 0);
		}
	});

	test('uses a deterministic placeholder when a trusted font subsetter is unavailable', () => {
		const source = minimalSfnt([{ tag: 'maxp', bytes: new Uint8Array([0, 1, 0, 0, 0, 1]) }]);
		const first = validateAndSubsetOfficeFont({
			nodeId: 'font-no-subsetter',
			assetId: 'font-no-subsetter',
			source,
			glyphIds: [0],
		});
		const second = validateAndSubsetOfficeFont({
			nodeId: 'font-no-subsetter',
			assetId: 'font-no-subsetter',
			source,
			glyphIds: [0],
		});

		ok(!hasBytes(first) && !hasBytes(second));
		strictEqual(first.reason, 'unsupported');
		strictEqual(first.fingerprint, second.fingerprint);
	});

	test('does not invoke a stateful caller subsetter without a production decoder boundary', () => {
		const source = minimalSfnt([{ tag: 'maxp', bytes: new Uint8Array([0, 1, 0, 0, 0, 1]) }]);
		const subsetBytes = minimalWoff2([{ tag: 'maxp', originalLength: 6 }]);
		const statefulSubset = {} as ParadisOfficeTrustedFontSubset;
		Object.defineProperty(statefulSubset, 'bytes', {
			enumerable: true,
			get: () => subsetBytes,
		});

		const result = validateAndSubsetOfficeFont({
			nodeId: 'font-stateful-subset',
			assetId: 'font-stateful-subset',
			source,
			glyphIds: [0],
			subsetter: () => statefulSubset,
			decoder: (subset) => decodedFont(renderableSfnt(1), [0], [], subset),
		});

		ok(!hasBytes(result));
		strictEqual(result.reason, 'unsupported');
	});

	test('does not trust caller-supplied decoded SFNT or glyph proof', () => {
		const source = minimalSfnt([{ tag: 'maxp', bytes: new Uint8Array([0, 1, 0, 0, 0, 3]) }]);
		const decodedSfnt = renderableSfnt(3);
		const subset = { bytes: decoderBackedWoff2(decodedSfnt) };
		const decodedCases: readonly ParadisOfficeDecodedFont[] = [
			decodedFont(decodedSfnt, [1, 2], [], subset.bytes),
			decodedFont(decodedSfnt, [0, 1], [], subset.bytes),
			decodedFont(decodedSfnt, [0, 1, 2], [{ glyphId: 2, components: [1, 3] }], subset.bytes),
			{
				...decodedFont(decodedSfnt, [0, 1, 2], [], subset.bytes),
				woff2Fingerprint: {
					algorithm: 'sha256',
					value: 'f'.repeat(64),
					byteLength: subset.bytes.byteLength,
				},
			},
		];

		for (const [index, decoded] of decodedCases.entries()) {
			const result = validateAndSubsetOfficeFont({
				nodeId: `font-proof-${index}`,
				assetId: `font-proof-${index}`,
				source,
				glyphIds: [1, 2],
				subsetter: () => subset,
				decoder: () => decoded,
			});
			ok(!hasBytes(result));
			strictEqual(result.reason, 'unsupported');
		}
	});

	test('rejects exotic byte views and isolates every font processing boundary with fresh copies', () => {
		class DerivedBytes extends Uint8Array { }
		const validSource = minimalSfnt([{ tag: 'maxp', bytes: new Uint8Array([0, 1, 0, 0, 0, 3]) }]);
		const invalidSources: Uint8Array[] = [new DerivedBytes(validSource), new Proxy(validSource, {})];
		const resizable = Reflect.construct(ArrayBuffer, [validSource.byteLength, { maxByteLength: validSource.byteLength * 2 }]) as ArrayBuffer & { readonly resizable?: boolean };
		if (resizable.resizable) {
			const view = new Uint8Array(resizable);
			view.set(validSource);
			invalidSources.push(view);
		}
		for (const [index, source] of invalidSources.entries()) {
			const result = validateAndSubsetOfficeFont({
				nodeId: `font-view-${index}`,
				assetId: `font-view-${index}`,
				source,
				glyphIds: [0],
			});
			ok(!hasBytes(result));
			strictEqual(result.reason, 'unsafe');
		}

		const decodedSfnt = renderableSfnt(3);
		const subsetBytes = decoderBackedWoff2(decodedSfnt);
		let retainedSource: Uint8Array | undefined;
		let retainedSubset: Uint8Array | undefined;
		const result = validateAndSubsetOfficeFont({
			nodeId: 'font-owned',
			assetId: 'font-owned',
			source: validSource,
			glyphIds: [1, 2],
			subsetter: (source) => {
				retainedSource = source;
				return { bytes: subsetBytes };
			},
			decoder: (subset) => {
				retainedSubset = subset;
				return decodedFont(decodedSfnt, [0, 1, 2], [], subset);
			},
		});
		ok(!hasBytes(result));
		strictEqual(result.reason, 'unsupported');
		strictEqual(retainedSource, undefined);
		strictEqual(retainedSubset, undefined);
	});
});

function hasBytes(value: object): value is ParadisSanitizedSvg | ParadisRenderableFont {
	return Object.prototype.hasOwnProperty.call(value, 'bytes');
}

function relationships(children: string): string {
	return `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${children}</Relationships>`;
}

function contentTypes(overrides: readonly (readonly [string, string])[]): string {
	return `<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">${overrides.map(([name, type]) => `<Override PartName="${name}" ContentType="${type}"/>`).join('')}</Types>`;
}

function sanitizeMemoryPackage(nodeId: string, files: Readonly<Record<string, string>>) {
	return sanitizeOfficeDocxPackageForRenderer({
		nodeId,
		source: Uint8Array.of(0x50, 0x4b, 0x03, 0x04),
		archive: new MemoryOfficeArchive(files),
	});
}

function readStoreZipEntries(bytes: Uint8Array): ReadonlyMap<string, Uint8Array> {
	const entries = new Map<string, Uint8Array>();
	const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
	const decoder = new TextDecoder();
	let offset = 0;
	while (offset + 4 <= bytes.byteLength && view.getUint32(offset, true) === 0x04034b50) {
		const compressedSize = view.getUint32(offset + 18, true);
		const nameLength = view.getUint16(offset + 26, true);
		const extraLength = view.getUint16(offset + 28, true);
		const nameStart = offset + 30;
		const dataStart = nameStart + nameLength + extraLength;
		const dataEnd = dataStart + compressedSize;
		ok(dataEnd <= bytes.byteLength, 'STORE ZIP entry is in bounds');
		entries.set(decoder.decode(bytes.subarray(nameStart, nameStart + nameLength)), bytes.slice(dataStart, dataEnd));
		offset = dataEnd;
	}
	return entries;
}

function textOf(entries: ReadonlyMap<string, Uint8Array>, name: string): string {
	const value = entries.get(name);
	ok(value, `Expected ZIP entry ${name}`);
	return new TextDecoder().decode(value);
}

function drawingGeometrySignature(source: string): string {
	const word = 'http://schemas.openxmlformats.org/wordprocessingml/2006/main';
	const wordDrawing = 'http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing';
	const drawing = 'http://schemas.openxmlformats.org/drawingml/2006/main';
	const picture = 'http://schemas.openxmlformats.org/drawingml/2006/picture';
	const selected = new Set([
		`${word}:tcBorders`, `${word}:tl2br`, `${word}:tr2bl`,
		`${wordDrawing}:anchor`, `${wordDrawing}:positionH`, `${wordDrawing}:positionV`, `${wordDrawing}:posOffset`, `${wordDrawing}:extent`,
		`${picture}:spPr`, `${drawing}:xfrm`, `${drawing}:off`, `${drawing}:ext`, `${drawing}:prstGeom`, `${drawing}:avLst`, `${drawing}:ln`, `${drawing}:prstDash`, `${drawing}:headEnd`, `${drawing}:tailEnd`,
	]);
	const signature: unknown[] = [];
	const visit = (node: ParadisOfficeXmlNode): void => {
		if (node.kind === 'text') { return; }
		if (selected.has(`${node.uri}:${node.local}`)) {
			signature.push({
				uri: node.uri,
				local: node.local,
				attributes: node.attributes.map(attribute => `${attribute.uri}:${attribute.local}=${attribute.value}`).sort(),
				text: node.children.filter(child => child.kind === 'text').map(child => child.value).join(''),
			});
		}
		for (const child of node.children) { visit(child); }
	};
	visit(parseParadisOfficeXml(source, { depth: 64, nodes: 65_536, attributeLength: 4_096, characters: 8 * 1024 * 1024 }).root);
	return JSON.stringify(signature);
}

function countOccurrences(value: string, needle: string): number {
	let count = 0;
	let offset = 0;
	while ((offset = value.indexOf(needle, offset)) >= 0) {
		count++;
		offset += needle.length;
	}
	return count;
}

function minimalSfnt(tables: readonly { readonly tag: string; readonly bytes: Uint8Array }[]): Uint8Array {
	const directoryEnd = 12 + tables.length * 16;
	let offset = directoryEnd;
	const records = tables.map((table) => {
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
		const word = (bytes[offset] ?? 0) * 0x1000000 + (bytes[offset + 1] ?? 0) * 0x10000 + (bytes[offset + 2] ?? 0) * 0x100 + (bytes[offset + 3] ?? 0);
		sum = (sum + word) >>> 0;
	}
	return sum;
}

function minimalWoff2(tables: readonly { readonly tag: string; readonly originalLength: number }[], expandedByteLength?: number): Uint8Array {
	const knownTags = ['cmap', 'head', 'hhea', 'hmtx', 'maxp', 'name', 'OS/2', 'post', 'cvt ', 'fpgm', 'glyf', 'loca'];
	const directory: number[] = [];
	for (const table of tables) {
		const tagIndex = knownTags.indexOf(table.tag);
		if (tagIndex < 0) {
			throw new Error(`Unsupported test tag ${table.tag}`);
		}
		directory.push((table.tag === 'glyf' || table.tag === 'loca' ? 0xc0 : 0) | tagIndex, table.originalLength);
	}
	const payloadLength = 32;
	const result = new Uint8Array(48 + directory.length + payloadLength);
	writeTag(result, 0, 'wOF2');
	writeU32(result, 4, 0x00010000);
	writeU32(result, 8, result.byteLength);
	writeU16(result, 12, tables.length);
	const calculatedExpanded = 12 + tables.length * 16 + tables.reduce((sum, table) => sum + ((table.originalLength + 3) & ~3), 0);
	writeU32(result, 16, expandedByteLength ?? calculatedExpanded);
	writeU32(result, 20, payloadLength);
	result.set(directory, 48);
	for (let index = result.byteLength - payloadLength; index < result.byteLength; index++) {
		result[index] = index & 0xff;
	}
	return result;
}

function renderableSfnt(glyphCount: number): Uint8Array {
	const cmap = new Uint8Array(16);
	writeU16(cmap, 2, 1);
	writeU32(cmap, 8, 12);
	const name = new Uint8Array(6);
	writeU16(name, 4, 6);
	return minimalSfnt([
		{
			tag: 'maxp',
			bytes: new Uint8Array([0, 1, 0, 0, glyphCount >>> 8, glyphCount]),
		},
		{ tag: 'cmap', bytes: cmap },
		{ tag: 'name', bytes: name },
		{ tag: 'OS/2', bytes: new Uint8Array(78) },
		{ tag: 'head', bytes: new Uint8Array(54) },
		{ tag: 'glyf', bytes: new Uint8Array() },
		{ tag: 'loca', bytes: new Uint8Array((glyphCount + 1) * 2) },
	]);
}

function decoderBackedWoff2(sfnt: Uint8Array): Uint8Array {
	return minimalWoff2(
		[
			{ tag: 'maxp', originalLength: 6 },
			{ tag: 'cmap', originalLength: 16 },
			{ tag: 'name', originalLength: 6 },
			{ tag: 'OS/2', originalLength: 78 },
			{ tag: 'head', originalLength: 54 },
			{ tag: 'glyf', originalLength: 0 },
			{
				tag: 'loca',
				originalLength: (readU16ForTest(sfnt, sfntMaxpOffset(sfnt) + 4) + 1) * 2,
			},
		],
		sfnt.byteLength,
	);
}

function sfntMaxpOffset(sfnt: Uint8Array): number {
	const tableCount = sfnt[4] * 256 + sfnt[5];
	for (let index = 0; index < tableCount; index++) {
		const offset = 12 + index * 16;
		if (new TextDecoder().decode(sfnt.subarray(offset, offset + 4)) === 'maxp') {
			return readU32ForTest(sfnt, offset + 8);
		}
	}
	throw new Error('missing maxp');
}

function readU16ForTest(bytes: Uint8Array, offset: number): number {
	return bytes[offset] * 256 + bytes[offset + 1];
}
function readU32ForTest(bytes: Uint8Array, offset: number): number {
	return (bytes[offset] * 0x1000000 + bytes[offset + 1] * 0x10000 + bytes[offset + 2] * 0x100 + bytes[offset + 3]) >>> 0;
}

function decodedFont(
	sfnt: Uint8Array,
	includedGlyphIds: readonly number[],
	compositeDependencies: readonly {
		readonly glyphId: number;
		readonly components: readonly number[];
	}[],
	woff2: Uint8Array,
): ParadisOfficeDecodedFont {
	return {
		sfnt,
		woff2Fingerprint: fingerprintOfficeAssetForDecoder(woff2),
		includedGlyphIds,
		compositeDependencies,
	};
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

function plainBase64(value: string): Uint8Array {
	return Uint8Array.from(decodeBase64(value).buffer);
}

class MemoryOfficeArchive {
	readonly containerByteLength = 4;
	private readonly values = new Map<string, Uint8Array>();
	readCount = 0;

	constructor(
		values: Readonly<Record<string, string>>,
		private readonly metadata: Readonly<Record<string, Partial<ParadisOfficeArchiveEntry>>> = {},
		private readonly duplicates: readonly string[] = [],
	) {
		for (const [name, value] of Object.entries(values)) {
			this.values.set(name, new TextEncoder().encode(value));
		}
	}

	async *entries(): AsyncIterable<ParadisOfficeArchiveEntry> {
		for (const [name, value] of this.values) {
			yield {
				name,
				compressedBytes: value.byteLength,
				declaredExpandedBytes: value.byteLength,
				crc32: memoryCrc32(value),
				encrypted: false,
				directory: false,
				symlink: false,
				...this.metadata[name],
			};
		}
		for (const name of this.duplicates) {
			const value = this.values.get(name)!;
			yield {
				name,
				compressedBytes: value.byteLength,
				declaredExpandedBytes: value.byteLength,
				crc32: memoryCrc32(value),
				encrypted: false,
				directory: false,
				symlink: false,
			};
		}
	}

	async *read(entry: ParadisOfficeArchiveEntry): AsyncIterable<Uint8Array> {
		this.readCount++;
		const value = this.values.get(entry.name);
		if (value) {
			yield value.slice();
		}
	}

	dispose(): void { }
}

function memoryCrc32(bytes: Uint8Array): number {
	let crc = 0xffffffff;
	for (const byte of bytes) {
		crc ^= byte;
		for (let bit = 0; bit < 8; bit++) {
			crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
		}
	}
	return (crc ^ 0xffffffff) >>> 0;
}
