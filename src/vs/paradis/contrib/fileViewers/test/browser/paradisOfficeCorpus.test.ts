/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import { deepStrictEqual, ok, rejects, strictEqual, throws } from 'assert';
import { CancellationToken } from '../../../../../base/common/cancellation.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { createParadisOfficeWebArchive } from '../../browser/office/paradisOfficeWebArchive.js';
import { inspectOfficePackage } from '../../common/office/paradisOfficePackageCore.js';
import { PARADIS_OFFICE_LISTED_PARTS_LIMIT, PARADIS_OFFICE_SANITIZER_XML_ELEMENTS, sanitizeOfficeDocxPackageForRenderer } from '../../common/paradisOfficeSanitizer.js';
import { resolveParadisOfficeRelationshipTarget } from '../../common/office/paradisOfficeArchive.js';
import { canonicalizeOfficeXml, parseParadisOfficeXml } from '../../common/office/paradisOfficeCanonicalXml.js';
import { PARADIS_OFFICE_BUDGET_PROFILES } from '../../common/paradisOfficeProtocol.js';
import { parseSpreadsheetSemantic } from '../../common/spreadsheet/paradisSpreadsheetSemanticParser.js';
import { parseWordSemantic } from '../../common/word/paradisWordSemanticParser.js';
import { minimalGif, minimalJpeg, minimalPng, pngChunk } from '../common/paradisWordImageFixture.js';
import { emfRecord, minimalEmf, minimalWmf, ParadisMetafileBytes, wmfRecord } from '../common/paradisOfficeMetafileFixture.js';
import { buildOpcFixture, type IParadisOfficeFixtureOptions, type IParadisOfficeFixtureRelationship, type ParadisOfficeFixturePart } from '../common/paradisOfficeFixture.js';

/*
 * Minimal, invented OPC packages that each exercise one ECMA-376 rule or one way real producers write
 * packages, through the production web ZIP reader. Cases name which stages they run: the renderer
 * preprocessor (sanitizer), the package inventory, and the semantic parsers. Rejections that must stay
 * in place next to each relaxed rule are fixed here too.
 */

const R = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';
const W = 'http://schemas.openxmlformats.org/wordprocessingml/2006/main';
const S = 'http://schemas.openxmlformats.org/spreadsheetml/2006/main';
const A = 'http://schemas.openxmlformats.org/drawingml/2006/main';
const WP = 'http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing';
const MS = 'http://schemas.microsoft.com/office';
const V = 'urn:schemas-microsoft-com:vml';
const O = 'urn:schemas-microsoft-com:office:office';
const CT = {
	document: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml',
	styles: 'application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml',
	workbook: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml',
	worksheet: 'application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml',
} as const;

function wordDocument(body: string, declaration = ''): string {
	return `${declaration}<w:document xmlns:w="${W}" xmlns:r="${R}" xmlns:wp="${WP}" xmlns:a="${A}" xmlns:v="${V}" xmlns:o="${O}"><w:body>${body}<w:sectPr/></w:body></w:document>`;
}

function wordPackage(overrides: Partial<IParadisOfficeFixtureOptions> & { readonly body?: string; readonly declaration?: string; readonly extraParts?: readonly ParadisOfficeFixturePart[]; readonly extraRelationships?: readonly IParadisOfficeFixtureRelationship[]; readonly documentTarget?: string } = {}): Promise<Uint8Array> {
	const declaration = overrides.declaration ?? '';
	return buildOpcFixture({
		parts: [
			['/word/document.xml', wordDocument(overrides.body ?? '<w:p><w:r><w:t>sample</w:t></w:r></w:p>', declaration), CT.document],
			['/word/styles.xml', `${declaration}<w:styles xmlns:w="${W}"/>`, CT.styles],
			...(overrides.extraParts ?? []),
		],
		relationships: [
			{ id: 'rIdRoot', type: `${R}/officeDocument`, target: overrides.documentTarget ?? 'word/document.xml' },
			{ source: '/word/document.xml', id: 'rIdStyles', type: `${R}/styles`, target: 'styles.xml' },
			...(overrides.extraRelationships ?? []),
		],
		...(overrides.folders ? { folders: overrides.folders } : {}),
		...(overrides.renameEntries ? { renameEntries: overrides.renameEntries } : {}),
		...(overrides.contentTypesXml ? { contentTypesXml: overrides.contentTypesXml } : {}),
		...(overrides.compression ? { compression: overrides.compression } : {}),
	});
}

async function sanitize(bytes: Uint8Array, xmlElementLimits?: { readonly part?: number; readonly package?: number }) {
	return sanitizeOfficeDocxPackageForRenderer({ nodeId: 'corpus', source: bytes, archive: await createParadisOfficeWebArchive(bytes.slice()), ...(xmlElementLimits ? { xmlElementLimits } : {}) });
}

const plainContentTypes = `<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Override PartName="/word/document.xml" ContentType="${CT.document}"/><Override PartName="/word/styles.xml" ContentType="${CT.styles}"/></Types>`;

function relationshipsOf(bytes: Uint8Array, part: string): string {
	const text = new TextDecoder().decode(bytes);
	const start = text.indexOf(part);
	return start < 0 ? '' : text.slice(start, text.indexOf('</Relationships>', start));
}

async function inventoryOf(bytes: Uint8Array) {
	return inspectOfficePackage(await createParadisOfficeWebArchive(bytes.slice()), PARADIS_OFFICE_BUDGET_PROFILES.desktopLocal, CancellationToken.None);
}

async function parseWord(bytes: Uint8Array) {
	return parseWordSemantic(await createParadisOfficeWebArchive(bytes.slice()), await inventoryOf(bytes), CancellationToken.None);
}

async function parseSpreadsheet(bytes: Uint8Array) {
	return parseSpreadsheetSemantic(await createParadisOfficeWebArchive(bytes.slice()), await inventoryOf(bytes), CancellationToken.None);
}

function zipNames(bytes: Uint8Array): string[] {
	const names: string[] = [];
	const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
	for (let offset = 0; offset + 30 <= bytes.byteLength && view.getUint32(offset, true) === 0x04034b50;) {
		const size = view.getUint32(offset + 18, true);
		const nameLength = view.getUint16(offset + 26, true);
		const extraLength = view.getUint16(offset + 28, true);
		names.push(new TextDecoder().decode(bytes.subarray(offset + 30, offset + 30 + nameLength)));
		offset += 30 + nameLength + extraLength + size;
	}
	return names.sort();
}

suite('ParadisOfficeCorpus', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	test('accepts a lowercase utf-8 XML declaration in every part (XML 1.0 §4.3.3)', async () => {
		const lower = '<?xml version="1.0" encoding="utf-8"?>';
		const bytes = await wordPackage({
			declaration: lower,
			contentTypesXml: `${lower}<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Override PartName="/word/document.xml" ContentType="${CT.document}"/><Override PartName="/word/styles.xml" ContentType="${CT.styles}"/></Types>`,
		});
		strictEqual((await sanitize(bytes)).placeholders.length, 0);
		deepStrictEqual([...new Set((await inventoryOf(bytes)).parts.map(part => part.coverage))], ['parsed']);
		strictEqual((await parseWord(bytes)).completeness.terminal, true);
	});

	test('still rejects an XML declaration that names a different encoding', async () => {
		const bytes = await wordPackage({ declaration: '<?xml version="1.0" encoding="Shift_JIS"?>' });
		await rejects(sanitize(bytes), /malformed/);
	});

	test('leaves ZIP folder items out of the package (Part 2 §7.3)', async () => {
		const bytes = await wordPackage({ folders: ['_rels/', 'word/', 'word/_rels/'] });
		const result = await sanitize(bytes);
		deepStrictEqual(zipNames(result.bytes), ['[Content_Types].xml', '_rels/.rels', 'word/_rels/document.xml.rels', 'word/document.xml', 'word/styles.xml']);
		strictEqual((await parseWord(bytes)).completeness.terminal, true);
	});

	test('drops a relationship whose display-irrelevant target part is absent', async () => {
		const bytes = await wordPackage({ extraRelationships: [{ id: 'rIdCustom', type: `${R}/custom-properties`, target: 'docProps/custom.xml' }] });
		const result = await sanitize(bytes);
		strictEqual(result.placeholders.length, 0);
		deepStrictEqual(result.ignoredParts, [{ partName: 'docProps/custom.xml', kind: 'custom-properties', reason: 'missingTarget' }]);
		ok(!new TextDecoder().decode(result.bytes).includes('custom-properties'));
	});

	test('replaces a story consumer whose image part is absent and keeps the rest of the story', async () => {
		const drawing = `<w:p><w:r><w:drawing><wp:inline><wp:extent cx="1" cy="1"/><a:graphic><a:graphicData><a:blip r:embed="rIdImage"/></a:graphicData></a:graphic></wp:inline></w:drawing></w:r></w:p>`;
		const bytes = await wordPackage({
			body: `<w:p><w:r><w:t>kept</w:t></w:r></w:p>${drawing}`,
			extraRelationships: [{ source: '/word/document.xml', id: 'rIdImage', type: `${R}/image`, target: 'media/absent.png' }],
		});
		const result = await sanitize(bytes);
		deepStrictEqual(result.placeholders.map(placeholder => placeholder.feature), ['missingRelationship']);
		ok(new TextDecoder().decode(result.bytes).includes('kept'));
	});

	test('still requires the main document part', async () => {
		const bytes = await buildOpcFixture({
			parts: [['/word/styles.xml', `<w:styles xmlns:w="${W}"/>`, CT.styles]],
			relationships: [{ id: 'rIdRoot', type: `${R}/officeDocument`, target: 'word/document.xml' }],
		});
		await rejects(sanitize(bytes), /malformed/);
	});

	test('types parts through Default without reading [Content_Types].xml or customXml items as stories (Part 2 §7.2.3)', async () => {
		const bytes = await wordPackage({
			contentTypesXml: `<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="xml" ContentType="${CT.document}"/><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Override PartName="/word/styles.xml" ContentType="${CT.styles}"/></Types>`,
			extraParts: [['/customXml/item1.xml', '<root/>']],
			extraRelationships: [
				{ source: '/word/document.xml', id: 'rIdItem', type: `${R}/customXml`, target: '../customXml/item1.xml' },
				{ source: '/customXml/item1.xml', id: 'rIdProps', type: `${R}/customXmlProps`, target: 'itemProps1.xml' },
			],
		});
		await sanitize(bytes);
		const inventory = await inventoryOf(bytes);
		strictEqual(inventory.parts.find(part => part.id === '/word/document.xml')?.contentType, CT.document);
		strictEqual(inventory.parts.find(part => part.id === '/_rels/.rels')?.contentType, 'application/vnd.openxmlformats-package.relationships+xml');
		strictEqual((await parseWord(bytes)).completeness.terminal, true);
	});

	test('parses a long story beyond 65,536 XML nodes', async () => {
		const bytes = await wordPackage({ body: '<w:p/>'.repeat(70_000) });
		await sanitize(bytes);
		strictEqual((await parseWord(bytes)).completeness.terminal, true);
	});

	test('resolves absolute relationship targets from the package root (Part 2 §6.5.3)', async () => {
		const word = await wordPackage({ documentTarget: '/word/document.xml' });
		await sanitize(word);
		strictEqual((await inventoryOf(word)).relationships.find(relationship => relationship.id === 'rIdRoot')?.target, '/word/document.xml');
		strictEqual((await parseWord(word)).completeness.terminal, true);

		const workbook = await buildOpcFixture({
			parts: [
				['/xl/workbook.xml', `<workbook xmlns="${S}" xmlns:r="${R}"><sheets><sheet name="One" sheetId="1" r:id="rIdSheet"/></sheets></workbook>`, CT.workbook],
				['/xl/worksheets/sheet1.xml', `<worksheet xmlns="${S}"><sheetData><row r="1"><c r="A1"><v>1</v></c></row></sheetData></worksheet>`, CT.worksheet],
			],
			relationships: [
				{ id: 'rIdRoot', type: `${R}/officeDocument`, target: '/xl/workbook.xml' },
				{ source: '/xl/workbook.xml', id: 'rIdSheet', type: `${R}/worksheet`, target: '/xl/worksheets/sheet1.xml' },
			],
		});
		const snapshot = await parseSpreadsheet(workbook);
		strictEqual(snapshot.sheets[0].cells.size, 1);
	});

	test('keeps rejecting Targets that leave the package or name a network path (RFC 3986 §4.2)', async () => {
		// The inventory and both semantic parsers resolve through this one function.
		for (const target of ['/../word/document.xml', '../../x', '//host/word/document.xml', 'a\\b', 'a%2Fb']) {
			throws(() => resolveParadisOfficeRelationshipTarget('/word/document.xml', target), /malformed/, target);
		}
		strictEqual(resolveParadisOfficeRelationshipTarget('/word/document.xml', '/word/styles.xml'), '/word/styles.xml');
		strictEqual(resolveParadisOfficeRelationshipTarget('/word/document.xml', 'media/../styles.xml'), '/word/styles.xml');
		const escaping = await wordPackage({ documentTarget: '/../word/document.xml' });
		await rejects(sanitize(escaping), /malformed/);
		await rejects(inventoryOf(escaping), /malformed/);
	});

	test('keeps rejecting folder items that are not plain empty folders', async () => {
		const cases: readonly { readonly name: string; readonly options: NonNullable<Parameters<typeof wordPackage>[0]>; readonly error: RegExp }[] = [
			{ name: 'parent segment', options: { folders: ['zz/'], renameEntries: [['zz/', '../']] }, error: /invalid/ },
			{ name: 'empty segment', options: { folders: ['wordx/'], renameEntries: [['wordx/', 'word//']] }, error: /invalid/ },
			{ name: 'non-empty folder', options: { extraParts: [['/wordy', 'abc', 'application/octet-stream']], renameEntries: [['wordy', 'word/']], contentTypesXml: plainContentTypes }, error: /malformed|unsafe/ },
			{ name: 'folder named like a part', options: { folders: ['word/document.xml/'] }, error: /unsafe/ },
		];
		for (const testCase of cases) {
			await rejects(sanitize(await wordPackage(testCase.options)), testCase.error, testCase.name);
		}
	});

	test('drops absent OLE, macro, and ActiveX targets from the relationships and the output', async () => {
		const bytes = await wordPackage({
			extraRelationships: [
				{ source: '/word/document.xml', id: 'rIdOle', type: `${R}/oleObject`, target: 'embeddings/absent.bin' },
				{ source: '/word/document.xml', id: 'rIdVba', type: `${MS}/2006/relationships/vbaProject`, target: 'vbaProject.bin' },
				{ source: '/word/document.xml', id: 'rIdControl', type: `${R}/control`, target: 'activeX/activeX1.xml' },
			],
		});
		const result = await sanitize(bytes);
		strictEqual(result.placeholders.length, 0);
		const relationships = relationshipsOf(result.bytes, 'word/_rels/document.xml.rels');
		for (const id of ['rIdOle', 'rIdVba', 'rIdControl']) {
			ok(!relationships.includes(id), id);
		}
		deepStrictEqual(zipNames(result.bytes), ['[Content_Types].xml', '_rels/.rels', 'word/_rels/document.xml.rels', 'word/document.xml', 'word/styles.xml']);
	});

	test('bounds XML elements per part and per package', async () => {
		strictEqual(PARADIS_OFFICE_SANITIZER_XML_ELEMENTS.part, 200_000);
		// document + body + 10 paragraphs + sectPr = 13 elements; styles adds 1.
		const bytes = await wordPackage({ body: '<w:p/>'.repeat(10) });
		await sanitize(bytes, { part: 13 });
		await rejects(sanitize(bytes, { part: 12 }), /limitExceeded/);
		await sanitize(bytes, { package: 14 });
		await rejects(sanitize(bytes, { package: 13 }), /limitExceeded/);
	});

	test('leaves out parts that nothing draws and lists them instead of counting placeholders (Part 1 §9.1.4)', async () => {
		const bytes = await wordPackage({
			extraParts: [
				['/customXml/item1.xml', '<root/>', 'application/xml'],
				['/customXml/itemProps1.xml', '<ds:datastoreItem xmlns:ds="http://schemas.openxmlformats.org/officeDocument/2006/customXml" ds:itemID="{00000000-0000-0000-0000-000000000001}"/>', 'application/vnd.openxmlformats-officedocument.customXmlProperties+xml'],
				['/word/people.xml', `<w15:people xmlns:w15="${MS}/word/2012/wordml"/>`, 'application/vnd.openxmlformats-officedocument.wordprocessingml.people+xml'],
				['/word/commentsIds.xml', `<w16cid:commentsIds xmlns:w16cid="${MS}/word/2016/wordml/cid"/>`, 'application/vnd.openxmlformats-officedocument.wordprocessingml.commentsIds+xml'],
				['/word/header9.xml', `<w:hdr xmlns:w="${W}"><w:p/></w:hdr>`, 'application/vnd.openxmlformats-officedocument.wordprocessingml.header+xml'],
			],
			extraRelationships: [
				{ source: '/word/document.xml', id: 'rIdItem', type: `${R}/customXml`, target: '../customXml/item1.xml' },
				{ source: '/customXml/item1.xml', id: 'rIdProps', type: `${R}/customXmlProps`, target: 'itemProps1.xml' },
				{ source: '/word/document.xml', id: 'rIdPeople', type: `${MS}/2011/relationships/people`, target: 'people.xml' },
				{ source: '/word/document.xml', id: 'rIdIds', type: `${MS}/2016/09/relationships/commentsIds`, target: 'commentsIds.xml' },
				{ source: '/word/document.xml', id: 'rIdOrphanHeader', type: `${R}/header`, target: 'header9.xml' },
			],
		});
		const result = await sanitize(bytes);
		strictEqual(result.placeholders.length, 0);
		deepStrictEqual(result.ignoredParts, [
			{ partName: 'customXml/item1.xml', kind: 'customXml', reason: 'notRendered' },
			{ partName: 'customXml/itemProps1.xml', kind: 'customXmlProps', reason: 'notRendered' },
			{ partName: 'word/commentsIds.xml', kind: 'commentsIds', reason: 'notRendered' },
			{ partName: 'word/header9.xml', kind: 'header', reason: 'unreferenced' },
			{ partName: 'word/people.xml', kind: 'people', reason: 'notRendered' },
		]);
		const text = new TextDecoder().decode(result.bytes);
		ok(!text.includes('Office asset unavailable'));
		strictEqual((await parseWord(bytes)).completeness.terminal, true);
	});

	test('keeps comment threading written with the wordprocessingml content type (MS-DOCX §2.1.2)', async () => {
		const bytes = await wordPackage({
			extraParts: [['/word/commentsExtended.xml', `<w15:commentsEx xmlns:w15="${MS}/word/2012/wordml"/>`, 'application/vnd.openxmlformats-officedocument.wordprocessingml.commentsExtended+xml']],
			extraRelationships: [{ source: '/word/document.xml', id: 'rIdEx', type: `${MS}/2011/relationships/commentsExtended`, target: 'commentsExtended.xml' }],
		});
		const result = await sanitize(bytes);
		deepStrictEqual([result.placeholders.length, result.ignoredParts.length], [0, 0]);
		ok(zipNames(result.bytes).includes('word/commentsExtended.xml'));
	});

	test('keeps the runs of an external hyperlink, drops the link element, and reports only the scheme', async () => {
		const bytes = await wordPackage({
			body: '<w:p><w:hyperlink r:id="rIdLink"><w:r><w:t>link text</w:t></w:r></w:hyperlink></w:p>',
			extraRelationships: [{ source: '/word/document.xml', id: 'rIdLink', type: `${R}/hyperlink`, target: 'https://example.invalid/', targetMode: 'External' }],
		});
		const result = await sanitize(bytes);
		strictEqual(result.placeholders.length, 0);
		const text = new TextDecoder().decode(result.bytes);
		ok(text.includes('<w:p><w:r><w:t>link text</w:t></w:r></w:p>'));
		ok(!text.includes('w:hyperlink'));
		ok(!text.includes('example.invalid'));
		deepStrictEqual(result.blockedParts, [{ feature: 'externalRelationship', kind: 'hyperlink', scheme: 'https', count: 1 }]);
	});

	test('draws an embedded object as its preview picture, without the embedding, and reports the embedding as blocked (Q321 f)', async () => {
		const words = (...values: number[]) => new ParadisMetafileBytes().u32(...values);
		const embedding = (index: number) => index < 2
			? `<o:OLEObject Type="Embed" ProgID="Excel.Sheet.8" ShapeID="s${index}" r:id="rIdOle${index}"/>`
			// ISO/IEC 29500 strict writes the embedding as w:objectEmbed.
			: `<w:objectEmbed w:progId="Excel.Sheet.8" w:shapeId="s${index}" r:id="rIdOle${index}"/>`;
		const objectRun = (index: number, shapeAttributes: string) => `<w:p><w:r><w:object w:dxaOrig="100" w:dyaOrig="50"><v:shape id="s${index}" o:ole="" ${shapeAttributes}><v:imagedata r:id="rIdPreview${index}" o:title=""/></v:shape>${embedding(index)}</w:object></w:r></w:p>`;
		const previews = [minimalEmf([emfRecord(43, words(0, 0, 40, 20))]), Uint8Array.of(1, 0, 0, 0), minimalEmf([emfRecord(43, words(0, 0, 20, 20))])];
		const bytes = await wordPackage({
			body: objectRun(0, 'style="width:50pt;height:25pt"') + objectRun(1, '') + objectRun(2, ''),
			extraParts: [
				...previews.map((preview, index) => [`/word/media/image${index}.emf`, preview, 'image/x-emf'] as const),
				...previews.map((_, index) => [`/word/embeddings/object${index}.bin`, Uint8Array.of(0xd0, 0xcf, 0x11, 0xe0), 'application/vnd.openxmlformats-officedocument.oleObject'] as const),
			],
			extraRelationships: previews.flatMap((_, index) => [
				{ source: '/word/document.xml', id: `rIdPreview${index}`, type: `${R}/image`, target: `media/image${index}.emf` },
				{ source: '/word/document.xml', id: `rIdOle${index}`, type: `${R}/oleObject`, target: `embeddings/object${index}.bin` },
			]),
		});
		const result = await sanitize(bytes);
		const text = new TextDecoder().decode(result.bytes);
		deepStrictEqual({
			// The preview that converts is drawn; the one that does not stays a box. Neither embedding is a box.
			placeholders: result.placeholders.map(placeholder => placeholder.feature),
			drawn: result.assets.filter(asset => asset.kind === 'sanitizedSvg').length,
			blocked: result.blockedParts.map(part => `${part.feature}:${part.partName}`),
			pictures: (text.match(/<w:pict><v:shape id="s\d"[^>]*><v:imagedata r:id="rIdPreview\d" o:title=""\/><\/v:shape><\/w:pict>/g) ?? []).length,
			leftovers: ['<w:object', 'OLEObject', 'objectEmbed', 'o:ole=', 'object0.bin', 'object1.bin', 'object2.bin', 'rIdOle'].filter(value => text.includes(value)),
		}, {
			placeholders: ['unsafeMedia'],
			drawn: 2,
			blocked: ['embeddedObject:word/embeddings/object0.bin', 'embeddedObject:word/embeddings/object1.bin', 'embeddedObject:word/embeddings/object2.bin'],
			pictures: 3,
			leftovers: [],
		});
	});

	test('falls back from an embedded font without a placeholder', async () => {
		const bytes = await wordPackage({
			extraParts: [
				['/word/fontTable.xml', `<w:fonts xmlns:w="${W}" xmlns:r="${R}"><w:font w:name="Sample"><w:embedRegular r:id="rIdFont" w:fontKey="{00000000-0000-0000-0000-000000000002}"/></w:font></w:fonts>`, 'application/vnd.openxmlformats-officedocument.wordprocessingml.fontTable+xml'],
				['/word/fonts/font1.odttf', Uint8Array.of(0, 1, 0, 0), 'application/vnd.openxmlformats-officedocument.obfuscatedFont'],
			],
			extraRelationships: [
				{ source: '/word/document.xml', id: 'rIdFonts', type: `${R}/fontTable`, target: 'fontTable.xml' },
				{ source: '/word/fontTable.xml', id: 'rIdFont', type: `${R}/font`, target: 'fonts/font1.odttf' },
			],
		});
		const result = await sanitize(bytes);
		strictEqual(result.placeholders.length, 0);
		deepStrictEqual(result.ignoredParts, [{ partName: 'word/fonts/font1.odttf', kind: 'font', reason: 'notRendered' }]);
		ok(!zipNames(result.bytes).includes('word/fonts/font1.odttf'));
	});
	test('never resolves a namespace prefix through Object.prototype', () => {
		const limits = { depth: 8, nodes: 8, attributeLength: 64, characters: 1024 };
		for (const prefix of ['constructor', 'toString', '__proto__']) {
			throws(() => parseParadisOfficeXml(`<${prefix}:a/>`, limits), /malformed/, `element ${prefix}`);
			throws(() => parseParadisOfficeXml(`<a ${prefix}:b="1"/>`, limits), /malformed/, `attribute ${prefix}`);
		}
		// Declaring such a prefix is valid XML and binds it like any other prefix.
		strictEqual(parseParadisOfficeXml('<__proto__:a xmlns:__proto__="urn:example:p"/>', limits).root.uri, 'urn:example:p');
	});

	test('rejects a second Default for the same extension in the package inventory (Part 2 §7.2.3.2)', async () => {
		const bytes = await wordPackage({
			contentTypesXml: `<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="XML" ContentType="application/xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="${CT.document}"/><Override PartName="/word/styles.xml" ContentType="${CT.styles}"/></Types>`,
		});
		await rejects(inventoryOf(bytes), /malformed/);
	});
	test('reports macros, embedded objects, unknown types, and external targets as blocked, without URLs', async () => {
		const bytes = await wordPackage({
			extraParts: [
				['/word/vbaProject.bin', Uint8Array.of(1, 2, 3), 'application/vnd.ms-office.vbaProject'],
				['/word/embeddings/object1.bin', Uint8Array.of(4, 5, 6), 'application/vnd.openxmlformats-officedocument.oleObject'],
				['/word/unknown.bin', Uint8Array.of(7), 'application/octet-stream'],
			],
			extraRelationships: [
				{ source: '/word/document.xml', id: 'rIdVba', type: `${MS}/2006/relationships/vbaProject`, target: 'vbaProject.bin' },
				{ source: '/word/document.xml', id: 'rIdOle', type: `${R}/oleObject`, target: 'embeddings/object1.bin' },
				{ source: '/word/document.xml', id: 'rIdUnknown', type: 'urn:example:unknown', target: 'unknown.bin' },
				{ source: '/word/document.xml', id: 'rIdTemplate', type: `${R}/attachedTemplate`, target: 'file:///C:/private/template.dotm', targetMode: 'External' },
				{ id: 'rIdUnc', type: `${R}/hyperlink`, target: '\\\\server\\share\\x.docx', targetMode: 'External' },
			],
		});
		const result = await sanitize(bytes);
		strictEqual(result.placeholders.length, 0);
		deepStrictEqual(result.blockedParts, [
			{ feature: 'embeddedObject', kind: 'oleObject', partName: 'word/embeddings/object1.bin', count: 1 },
			{ feature: 'externalRelationship', kind: 'attachedTemplate', scheme: 'file', count: 1 },
			{ feature: 'externalRelationship', kind: 'hyperlink', scheme: 'unc', count: 1 },
			{ feature: 'macro', kind: 'vbaProject', partName: 'word/vbaProject.bin', count: 1 },
			{ feature: 'unknownRelationship', kind: 'unknown', partName: 'word/unknown.bin', count: 1 },
		]);
		const text = new TextDecoder().decode(result.bytes);
		for (const forbidden of ['private', 'server', 'vbaProject', 'object1', 'unknown.bin']) {
			ok(!text.includes(forbidden), forbidden);
		}
	});

	test('caps the listed parts and counts the rest', async () => {
		const parts: ParadisOfficeFixturePart[] = [];
		const relationships: IParadisOfficeFixtureRelationship[] = [];
		for (let index = 0; index < 260; index++) {
			parts.push([`/customXml/item${index}.xml`, '<root/>', 'application/xml']);
			relationships.push({ source: '/word/document.xml', id: `rIdItem${index}`, type: `${R}/customXml`, target: `../customXml/item${index}.xml` });
		}
		const result = await sanitize(await wordPackage({ extraParts: parts, extraRelationships: relationships }));
		strictEqual(result.ignoredParts.length, PARADIS_OFFICE_LISTED_PARTS_LIMIT);
		strictEqual(result.ignoredPartsOmitted, 4);
	});

	test('re-serializes retained metadata XML so DOCTYPE-free comments and processing instructions are dropped', async () => {
		const bytes = await wordPackage({
			extraParts: [['/docProps/core.xml', '<?xml version="1.0" encoding="UTF-8"?><!-- note --><?pi data?><cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties" xmlns:dc="http://purl.org/dc/elements/1.1/"><dc:title>T</dc:title></cp:coreProperties>', 'application/vnd.openxmlformats-package.core-properties+xml']],
			extraRelationships: [{ id: 'rIdCore', type: 'http://schemas.openxmlformats.org/package/2006/relationships/metadata/core-properties', target: 'docProps/core.xml' }],
		});
		const text = new TextDecoder().decode((await sanitize(bytes)).bytes);
		ok(text.includes('<cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties" xmlns:dc="http://purl.org/dc/elements/1.1/"><dc:title>T</dc:title></cp:coreProperties>'));
		ok(!text.includes('<!-- note -->'));
		ok(!text.includes('<?pi'));
	});

	test('replaces control and bidi characters in listed part names', async () => {
		const bytes = await wordPackage({
			extraParts: [['/customXml/item\u202e1.xml', '<root/>', 'application/xml']],
			extraRelationships: [{ source: '/word/document.xml', id: 'rIdItem', type: `${R}/customXml`, target: '../customXml/item\u202e1.xml' }],
		});
		deepStrictEqual((await sanitize(bytes)).ignoredParts.map(part => part.partName), ['customXml/item\ufffd1.xml']);
	});
	test('drops an external link element inside other run containers and keeps nested content valid', async () => {
		const link = (body: string) => wordPackage({
			body,
			extraRelationships: [
				{ source: '/word/document.xml', id: 'rIdA', type: `${R}/hyperlink`, target: 'https://example.invalid/a', targetMode: 'External' },
				{ source: '/word/document.xml', id: 'rIdB', type: `${R}/hyperlink`, target: 'https://example.invalid/b', targetMode: 'External' },
			],
		});
		const text = async (body: string) => {
			const result = await sanitize(await link(body));
			strictEqual(result.placeholders.length, 0);
			const xml = new TextDecoder().decode(result.bytes);
			ok(!xml.includes('r:id="rId'), body);
			ok(!xml.includes('example.invalid'), body);
			return xml;
		};
		// Inside w:dir (bidirectional run container): the element is dropped, the run stays in w:dir.
		ok((await text('<w:p><w:dir w:val="rtl"><w:hyperlink r:id="rIdA"><w:r><w:t>dir</w:t></w:r></w:hyperlink></w:dir></w:p>')).includes('<w:dir w:val="rtl"><w:r><w:t>dir</w:t></w:r></w:dir>'));
		// A nested link that declares its own namespace keeps both elements and loses only the links.
		const nested = await text('<w:p><w:hyperlink r:id="rIdA"><w:hyperlink xmlns:x="urn:example:x" r:id="rIdB"><w:r><w:t>nested</w:t></w:r></w:hyperlink></w:hyperlink></w:p>');
		ok(nested.includes('<w:t>nested</w:t>'));
		strictEqual((nested.match(/<w:hyperlink\b/g) ?? []).length, 2);
		// A simple field inside a link moves up into the paragraph unchanged.
		ok((await text('<w:p><w:hyperlink r:id="rIdA"><w:fldSimple w:instr=" PAGE "><w:r><w:t>1</w:t></w:r></w:fldSimple></w:hyperlink></w:p>')).includes('<w:p><w:fldSimple w:instr=" PAGE "><w:r><w:t>1</w:t></w:r></w:fldSimple></w:p>'));
	});
	test('draws inspected PNG, JPEG, and GIF images and keeps everything else as boxes (Q312 A)', async () => {
		const png = minimalPng(2, 2);
		const crcBroken = png.slice();
		crcBroken[29] ^= 0xff;
		const script = [...new TextEncoder().encode('<html><script>alert(1)</script></html>')];
		const images: readonly (readonly [name: string, bytes: Uint8Array, type: string])[] = [
			['image1.png', png, 'image/png'],
			['image2.gif', minimalGif(2, 2), 'image/gif'],
			['image3.jpg', minimalJpeg(2, 2), 'image/jpg'],
			// A polyglot: the PNG is drawn and the HTML after IEND is cut.
			['image4.png', Uint8Array.from([...png, ...script]), 'image/png'],
			['image5.png', png, 'image/jpeg'],
			['image6.emf', Uint8Array.of(1, 0, 0, 0, 0x6c, 0, 0, 0), 'image/x-emf'],
			['image7.png', png.slice(0, 30), 'image/png'],
			['image8.png', crcBroken, 'image/png'],
			['image9.png', minimalPng(2, 2, { before: pngChunk('acTL', [0, 0, 0, 2, 0, 0, 0, 0]) }), 'image/png'],
			['image10.gif', minimalGif(2, 2, { frames: 1_001 }), 'image/gif'],
			['image11.png', new TextEncoder().encode('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>'), 'image/png'],
		];
		const body = images.map((_, index) => `<w:p><w:r><w:drawing><wp:inline><wp:extent cx="1" cy="1"/><a:graphic><a:graphicData><a:blip r:embed="rIdImage${index}"/></a:graphicData></a:graphic></wp:inline></w:drawing></w:r></w:p>`).join('');
		const result = await sanitize(await wordPackage({
			body,
			extraParts: images.map(([name, bytes, type]) => [`/word/media/${name}`, bytes, type] as const),
			extraRelationships: images.map(([name], index) => ({ source: '/word/document.xml', id: `rIdImage${index}`, type: `${R}/image`, target: `media/${name}` })),
		}));
		const text = new TextDecoder().decode(result.bytes);
		deepStrictEqual({
			drawn: result.assets.filter(asset => asset.kind === 'rasterImage').map(asset => `${asset.mime}:${asset.byteLength}`).sort(),
			boxes: result.placeholders.length,
			scriptLeft: text.includes('<script>'),
			types: ['image1.png', 'image3.jpg', 'image4.png', 'image5.png', 'image11.png'].map(name => new RegExp(`PartName="/word/media/${name.replace('.', '[.]')}" ContentType="(?<type>[^"]+)"`).exec(text)?.groups?.type),
		}, {
			drawn: [`image/gif:${minimalGif(2, 2).byteLength}`, `image/jpeg:${minimalJpeg(2, 2).byteLength}`, `image/png:${png.byteLength}`, `image/png:${png.byteLength}`].sort(),
			boxes: 7,
			scriptLeft: false,
			types: ['image/png', 'image/jpg', 'image/png', 'image/svg+xml', 'image/svg+xml'],
		});
	});

	test('draws EMF and WMF images as converted SVG and keeps the ones it cannot draw as boxes (Q321 f)', async () => {
		const words = (...values: number[]) => new ParadisMetafileBytes().u32(...values);
		const images: readonly (readonly [name: string, bytes: Uint8Array, type: string])[] = [
			['image1.emf', minimalEmf([emfRecord(43, words(0, 0, 40, 20))]), 'image/x-emf'],
			['image2.wmf', minimalWmf([wmfRecord(0x041b, [500, 1000, 0, 0])]), 'image/x-wmf'],
			// An arc is not drawn, so the image stays a box.
			['image3.emf', minimalEmf([emfRecord(45, words(0, 0, 10, 10, 0, 0, 10, 10))]), 'image/x-emf'],
			// The declared type must match the signature.
			['image4.png', minimalEmf([emfRecord(43, words(0, 0, 40, 20))]), 'image/png'],
		];
		const body = images.map((_, index) => `<w:p><w:r><w:drawing><wp:inline><wp:extent cx="1" cy="1"/><a:graphic><a:graphicData><a:blip r:embed="rIdImage${index}"/></a:graphicData></a:graphic></wp:inline></w:drawing></w:r></w:p>`).join('');
		const result = await sanitize(await wordPackage({
			body,
			extraParts: images.map(([name, bytes, type]) => [`/word/media/${name}`, bytes, type] as const),
			extraRelationships: images.map(([name], index) => ({ source: '/word/document.xml', id: `rIdImage${index}`, type: `${R}/image`, target: `media/${name}` })),
		}));
		const text = new TextDecoder().decode(result.bytes);
		deepStrictEqual({
			drawn: result.assets.filter(asset => asset.kind === 'sanitizedSvg').length,
			boxes: result.placeholders.length,
			types: images.map(([name]) => new RegExp(`PartName="/word/media/${name.replace('.', '[.]')}" ContentType="(?<type>[^"]+)"`).exec(text)?.groups?.type),
			converted: (text.match(/<svg xmlns="http:[/][/]www[.]w3[.]org[/]2000[/]svg" width=/g) ?? []).length,
		}, {
			drawn: 2,
			boxes: 2,
			types: ['image/svg+xml', 'image/svg+xml', 'image/svg+xml', 'image/svg+xml'],
			converted: 2,
		});
	});

	test('converts EMF only while the rewritten package stays under its cap, and keeps opening the document (Q321 f)', async function () {
		this.timeout(20_000);
		const words = (...values: number[]) => new ParadisMetafileBytes().u32(...values);
		// Filler parts that deflate about 15 times (one noisy byte in 24), so the package passes the ZIP ratio and
		// size checks while its expanded size sits near the 32 MiB cap of the rewritten package.
		const filler = (bytes: number, seed: number) => {
			const value = new Uint8Array(bytes).fill(0x41);
			let state = seed;
			for (let index = 0; index < bytes; index += 24) {
				state = (Math.imul(state, 1_103_515_245) + 12_345) >>> 0;
				value[index] = 0x41 + (state >>> 26);
			}
			return value;
		};
		const open = async (fillerBytes: number) => {
			const fillers = [0, 1, 2, 3].map(index => [`/customXml/item${index}.bin`, filler(fillerBytes / 4, index + 1), 'application/octet-stream'] as const);
			const result = await sanitize(await wordPackage({
				body: '<w:p><w:r><w:drawing><wp:inline><wp:extent cx="1" cy="1"/><a:graphic><a:graphicData><a:blip r:embed="rIdImage"/></a:graphicData></a:graphic></wp:inline></w:drawing></w:r></w:p>',
				extraParts: [['/word/media/image1.emf', minimalEmf([emfRecord(43, words(0, 0, 40, 20))]), 'image/x-emf'], ...fillers],
				extraRelationships: [{ source: '/word/document.xml', id: 'rIdImage', type: `${R}/image`, target: 'media/image1.emf' }],
				compression: 'DEFLATE',
			}));
			return { drawn: result.assets.filter(asset => asset.kind === 'sanitizedSvg').length, boxes: result.placeholders.length };
		};
		deepStrictEqual([await open(29 * 1024 * 1024), await open(31 * 1024 * 1024)], [{ drawn: 1, boxes: 0 }, { drawn: 0, boxes: 1 }]);
	});

	test('keeps images past the document pixel budget, and images too large on their own, as boxes that say why', async () => {
		// The inspector reads only the header, so the claimed sizes need no pixel data.
		const images = [minimalPng(7_000, 7_000), minimalPng(7_000, 7_000), minimalPng(7_000, 1_000), minimalPng(40_000, 1)];
		const body = images.map((_, index) => `<w:p><w:r><w:drawing><wp:inline><wp:extent cx="1" cy="1"/><a:graphic><a:graphicData><a:blip r:embed="rIdImage${index}"/></a:graphicData></a:graphic></wp:inline></w:drawing></w:r></w:p>`).join('');
		const bytes = await wordPackage({
			body,
			extraParts: images.map((image, index) => [`/word/media/image${index + 1}.png`, image, 'image/png'] as const),
			extraRelationships: images.map((_, index) => ({ source: '/word/document.xml', id: `rIdImage${index}`, type: `${R}/image`, target: `media/image${index + 1}.png` })),
		});
		const counts = (result: Awaited<ReturnType<typeof sanitize>>) => [result.assets.filter(asset => asset.kind === 'rasterImage').length, result.placeholders.length];
		const whole = await sanitize(bytes);
		// A view that shows two documents passes half of the budget for each.
		const half = await sanitizeOfficeDocxPackageForRenderer({ nodeId: 'corpus', source: bytes, archive: await createParadisOfficeWebArchive(bytes.slice()), imagePixelBudget: 50_000_000 });
		deepStrictEqual({
			counts: [counts(whole), counts(half)],
			why: whole.placeholders.map(placeholder => [placeholder.reason, placeholder.detail]),
		}, {
			counts: [[2, 2], [1, 3]],
			why: [['budget', '画像が多いため、表示していません。'], ['budget', '画像が大きすぎるため、表示していません。']],
		});
	});

	test('parses a workbook that carries binary parts and Default-typed media (Part 2 §7.2.3.4)', async () => {
		const workbook = await buildOpcFixture({
			parts: [
				['/xl/workbook.xml', `<workbook xmlns="${S}" xmlns:r="${R}"><sheets><sheet name="One" sheetId="1" r:id="rIdSheet"/></sheets></workbook>`, CT.workbook],
				['/xl/worksheets/sheet1.xml', `<worksheet xmlns="${S}" xmlns:r="${R}"><sheetData><row r="1"><c r="A1"><v>1</v></c></row></sheetData><pageSetup r:id="rIdPrinter"/></worksheet>`, CT.worksheet],
				['/xl/printerSettings/printerSettings1.bin', Uint8Array.of(0, 1, 2, 3), 'application/vnd.openxmlformats-officedocument.spreadsheetml.printerSettings'],
				['/xl/media/image1.png', Uint8Array.of(0x89, 0x50, 0x4e, 0x47), 'image/png'],
			],
			relationships: [
				{ id: 'rIdRoot', type: `${R}/officeDocument`, target: 'xl/workbook.xml' },
				{ source: '/xl/workbook.xml', id: 'rIdSheet', type: `${R}/worksheet`, target: 'worksheets/sheet1.xml' },
				{ source: '/xl/worksheets/sheet1.xml', id: 'rIdPrinter', type: `${R}/printerSettings`, target: '../printerSettings/printerSettings1.bin' },
			],
		});
		const snapshot = await parseSpreadsheet(workbook);
		deepStrictEqual([snapshot.completeness.terminal, snapshot.sheets[0].cells.size], [true, 1]);
	});

	test('does not count Ignorable markup or AlternateContent as unknown elements (Part 3 §10)', async () => {
		const MC = 'http://schemas.openxmlformats.org/markup-compatibility/2006';
		const XR = 'http://schemas.microsoft.com/office/spreadsheetml/2014/revision';
		const workbookXml = (extra: string) => `<workbook xmlns="${S}" xmlns:r="${R}" xmlns:mc="${MC}" xmlns:xr="${XR}" xmlns:x15ac="http://schemas.microsoft.com/office/spreadsheetml/2010/11/ac" mc:Ignorable="x15ac xr"><mc:AlternateContent><mc:Choice Requires="x15"><x15ac:absPath url="C:\\"/></mc:Choice></mc:AlternateContent><xr:revisionPtr revIDLastSave="0"/>${extra}<sheets><sheet name="One" sheetId="1" r:id="rIdSheet"/></sheets></workbook>`;
		const build = (extra: string, sheetExtra = '') => buildOpcFixture({
			parts: [
				['/xl/workbook.xml', workbookXml(extra), CT.workbook],
				['/xl/worksheets/sheet1.xml', `<worksheet xmlns="${S}" xmlns:xr="${XR}"><sheetData/>${sheetExtra}</worksheet>`, CT.worksheet],
			],
			relationships: [
				{ id: 'rIdRoot', type: `${R}/officeDocument`, target: 'xl/workbook.xml' },
				{ source: '/xl/workbook.xml', id: 'rIdSheet', type: `${R}/worksheet`, target: 'worksheets/sheet1.xml' },
			],
		});
		strictEqual((await parseSpreadsheet(await build(''))).completeness.unknownElements, 0);
		strictEqual((await parseSpreadsheet(await build('<foo:bar xmlns:foo="urn:example:foo"/>'))).completeness.unknownElements, 1);
		// The workbook's mc:Ignorable does not reach the worksheet, which declares none of its own.
		strictEqual((await parseSpreadsheet(await build('', '<xr:revisionPtr/>'))).completeness.unknownElements, 1);
	});

	test('hashes canonical XML like the platform SHA-256 across block boundaries', async () => {
		for (const length of [0, 1, 40, 41, 55, 56, 63, 64, 65, 119, 120, 1_000, 70_000]) {
			const document = parseParadisOfficeXml(`<a>${'x'.repeat(length)}</a>`, { depth: 4, nodes: 4, attributeLength: 16, characters: 100_000 });
			const canonical = canonicalizeOfficeXml(document, () => undefined);
			const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(canonical.canonical)));
			strictEqual(canonical.hash.value, [...digest].map(byte => byte.toString(16).padStart(2, '0')).join(''), String(length));
		}
	});

	test('parses names, attribute values, and text the same way on the ASCII fast path (XML 1.0 §2.11, §3.3.3)', () => {
		const document = parseParadisOfficeXml('<α:root xmlns:α="urn:example:a" plain="a\tb\nc\r\nd&#9;e" quoted=\'x"y\'>t&amp;u\r\nv\rw<α:child/>z</α:root>', { depth: 4, nodes: 4, attributeLength: 64, characters: 1_000 });
		deepStrictEqual(document.root.attributes.map(attribute => [attribute.local, attribute.value]), [['plain', 'a b c d\te'], ['quoted', 'x"y']]);
		deepStrictEqual(document.root.children.map(child => child.kind === 'text' ? child.value : child.local), ['t&u\nv\nw', 'child', 'z']);
		strictEqual(document.root.uri, 'urn:example:a');
	});

	test('can skip canonical hashes while keeping every all-byte hash in the inventory', async () => {
		const bytes = await wordPackage();
		const full = await inventoryOf(bytes);
		const light = await inspectOfficePackage(await createParadisOfficeWebArchive(bytes.slice()), PARADIS_OFFICE_BUDGET_PROFILES.desktopLocal, CancellationToken.None, { canonicalHashes: false });
		ok(full.parts.filter(part => part.coverage === 'parsed').every(part => part.canonicalHash?.value.length === 64));
		ok(light.parts.every(part => part.canonicalHash === undefined));
		deepStrictEqual(light.parts.map(part => part.coverage === 'parsed' ? part.rawHash.value : ''), full.parts.map(part => part.coverage === 'parsed' ? part.rawHash.value : ''));
		strictEqual((await parseWordSemantic(await createParadisOfficeWebArchive(bytes.slice()), light, CancellationToken.None)).completeness.terminal, true);
	});
});
