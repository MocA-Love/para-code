/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import { deepStrictEqual, ok, rejects, strictEqual } from 'assert';
import { CancellationToken } from '../../../../../base/common/cancellation.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { createParadisOfficeWebArchive } from '../../browser/office/paradisOfficeWebArchive.js';
import { inspectOfficePackage } from '../../common/office/paradisOfficePackageCore.js';
import { sanitizeOfficeDocxPackageForRenderer } from '../../common/paradisOfficeSanitizer.js';
import { PARADIS_OFFICE_BUDGET_PROFILES } from '../../common/paradisOfficeProtocol.js';
import { parseSpreadsheetSemantic } from '../../common/spreadsheet/paradisSpreadsheetSemanticParser.js';
import { parseWordSemantic } from '../../common/word/paradisWordSemanticParser.js';
import { buildOpcFixture, type IParadisOfficeFixtureOptions, type IParadisOfficeFixtureRelationship, type ParadisOfficeFixturePart } from '../common/paradisOfficeFixture.js';

/*
 * Minimal, invented OPC packages that each exercise one ECMA-376 rule or one way real producers write
 * packages. Every case runs the renderer preprocessor (sanitizer), the package inventory, and the
 * semantic parser over the same bytes through the production web ZIP reader.
 */

const R = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';
const W = 'http://schemas.openxmlformats.org/wordprocessingml/2006/main';
const S = 'http://schemas.openxmlformats.org/spreadsheetml/2006/main';
const A = 'http://schemas.openxmlformats.org/drawingml/2006/main';
const WP = 'http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing';
const CT = {
	document: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml',
	styles: 'application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml',
	workbook: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml',
	worksheet: 'application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml',
} as const;

function wordDocument(body: string, declaration = ''): string {
	return `${declaration}<w:document xmlns:w="${W}" xmlns:r="${R}" xmlns:wp="${WP}" xmlns:a="${A}"><w:body>${body}<w:sectPr/></w:body></w:document>`;
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
		...(overrides.contentTypesXml ? { contentTypesXml: overrides.contentTypesXml } : {}),
	});
}

async function sanitize(bytes: Uint8Array) {
	return sanitizeOfficeDocxPackageForRenderer({ nodeId: 'corpus', source: bytes, archive: await createParadisOfficeWebArchive(bytes.slice()) });
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

	test('does not read [Content_Types].xml as a story when Default xml carries the document type (Part 2 §7.2.3)', async () => {
		const bytes = await wordPackage({
			contentTypesXml: `<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="xml" ContentType="${CT.document}"/><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Override PartName="/word/styles.xml" ContentType="${CT.styles}"/></Types>`,
		});
		strictEqual((await sanitize(bytes)).placeholders.length, 0);
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
});
