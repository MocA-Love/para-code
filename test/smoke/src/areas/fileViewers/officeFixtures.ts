/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import * as fs from 'fs';
import JSZip from 'jszip';

function normalizeOfficeCliXml(xml: string, spreadsheet = false): string {
	const normalized = xml.charCodeAt(0) === 0xFEFF ? xml.slice(1) : xml;
	return (spreadsheet ? normalized
		.replace('xmlns:x="http://schemas.openxmlformats.org/spreadsheetml/2006/main"', 'xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"')
		.replaceAll('<x:', '<').replaceAll('</x:', '</') : normalized)
		.replace('encoding="utf-8"', 'encoding="UTF-8"');
}

/** Converts the immutable Office CLI evidence fixture into the supported package used by the product integration tests. */
export async function writeSupportedSpreadsheetFixture(sourcePath: string, targetPath: string): Promise<void> {
	const source = await JSZip.loadAsync(fs.readFileSync(sourcePath));
	const output = new JSZip();
	output.file('[Content_Types].xml', '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Default Extension="png" ContentType="image/png"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/><Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/><Override PartName="/xl/drawings/drawing1.xml" ContentType="application/vnd.openxmlformats-officedocument.drawing+xml"/></Types>', { createFolders: false });
	output.file('_rels/.rels', '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="office" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>', { createFolders: false });
	output.file('xl/workbook.xml', normalizeOfficeCliXml(await source.file('xl/workbook.xml')!.async('string'), true), { createFolders: false });
	output.file('xl/_rels/workbook.xml.rels', '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/><Relationship Id="styles" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/></Relationships>', { createFolders: false });
	output.file('xl/worksheets/sheet1.xml', normalizeOfficeCliXml(await source.file('xl/worksheets/sheet1.xml')!.async('string'), true), { createFolders: false });
	output.file('xl/worksheets/_rels/sheet1.xml.rels', '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="R8fa5cfa5350f405f" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/drawing" Target="../drawings/drawing1.xml"/></Relationships>', { createFolders: false });
	output.file('xl/styles.xml', normalizeOfficeCliXml(await source.file('xl/styles.xml')!.async('string'), true), { createFolders: false });
	output.file('xl/drawings/drawing1.xml', normalizeOfficeCliXml(await source.file('xl/drawings/drawing1.xml')!.async('string')), { createFolders: false });
	output.file('xl/drawings/_rels/drawing1.xml.rels', '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="R6adcaab12e694e2c" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" Target="../media/image.png"/></Relationships>', { createFolders: false });
	output.file('xl/media/image.png', await source.file('xl/media/image.png')!.async('uint8array'), { createFolders: false });
	fs.writeFileSync(targetPath, await output.generateAsync({ type: 'nodebuffer' }));
}

/** Converts the immutable Office CLI evidence fixture into the supported package used by the product integration tests. */
export async function writeSupportedWordFixture(sourcePath: string, targetPath: string): Promise<void> {
	const source = await JSZip.loadAsync(fs.readFileSync(sourcePath));
	const output = new JSZip();
	output.file('[Content_Types].xml', '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="png" ContentType="image/png"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>', { createFolders: false });
	output.file('_rels/.rels', '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="office" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>', { createFolders: false });
	output.file('word/document.xml', normalizeOfficeCliXml(await source.file('word/document.xml')!.async('string')), { createFolders: false });
	output.file('word/_rels/document.xml.rels', '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="R7fb693fe671f49f2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" Target="media/image.png"/></Relationships>', { createFolders: false });
	output.file('word/media/image.png', await source.file('media/image.png')!.async('uint8array'), { createFolders: false });
	fs.writeFileSync(targetPath, await output.generateAsync({ type: 'nodebuffer' }));
}
