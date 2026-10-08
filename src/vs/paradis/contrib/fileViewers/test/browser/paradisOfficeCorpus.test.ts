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
import { PARADIS_OFFICE_SANITIZER_XML_ELEMENTS, sanitizeOfficeDocxPackageForRenderer } from '../../common/paradisOfficeSanitizer.js';
import { resolveParadisOfficeRelationshipTarget } from '../../common/office/paradisOfficeArchive.js';
import { PARADIS_OFFICE_BUDGET_PROFILES } from '../../common/paradisOfficeProtocol.js';
import { parseSpreadsheetSemantic } from '../../common/spreadsheet/paradisSpreadsheetSemanticParser.js';
import { parseWordSemantic } from '../../common/word/paradisWordSemanticParser.js';
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

	test('keeps the text of an external hyperlink and removes only the link', async () => {
		const bytes = await wordPackage({
			body: '<w:p><w:hyperlink r:id="rIdLink"><w:r><w:t>link text</w:t></w:r></w:hyperlink></w:p>',
			extraRelationships: [{ source: '/word/document.xml', id: 'rIdLink', type: `${R}/hyperlink`, target: 'https://example.invalid/', targetMode: 'External' }],
		});
		const result = await sanitize(bytes);
		strictEqual(result.placeholders.length, 0);
		const text = new TextDecoder().decode(result.bytes);
		ok(/<w:hyperlink\s*><w:r><w:t>link text<\/w:t><\/w:r><\/w:hyperlink>/.test(text));
		ok(!text.includes('example.invalid'));
	});

	test('counts an OLE object once even though its preview picture is also blocked', async () => {
		const object = '<w:p><w:r><w:object><v:shape id="s1"><v:imagedata r:id="rIdPreview"/></v:shape><o:OLEObject Type="Embed" ProgID="Excel.Sheet.8" ShapeID="s1" r:id="rIdOle"/></w:object></w:r></w:p>';
		const bytes = await wordPackage({
			body: object,
			extraParts: [
				['/word/media/image1.emf', Uint8Array.of(1, 0, 0, 0), 'image/x-emf'],
				['/word/embeddings/object1.bin', Uint8Array.of(0xd0, 0xcf, 0x11, 0xe0), 'application/vnd.openxmlformats-officedocument.oleObject'],
			],
			extraRelationships: [
				{ source: '/word/document.xml', id: 'rIdPreview', type: `${R}/image`, target: 'media/image1.emf' },
				{ source: '/word/document.xml', id: 'rIdOle', type: `${R}/oleObject`, target: 'embeddings/object1.bin' },
			],
		});
		const result = await sanitize(bytes);
		deepStrictEqual(result.placeholders.map(placeholder => placeholder.feature), ['embeddedObject']);
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
});
