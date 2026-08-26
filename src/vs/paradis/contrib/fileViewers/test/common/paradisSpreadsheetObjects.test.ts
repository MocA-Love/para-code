/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import { deepStrictEqual, doesNotMatch, notStrictEqual, ok, strictEqual, throws } from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { ParadisOfficePackageError } from '../../common/office/paradisOfficeArchive.js';
import {
	bindSpreadsheetObjectsToSheet,
	fingerprintSpreadsheetObjectBytes,
	parseSpreadsheetObjects,
	type ParadisSpreadsheetObjectPartInput,
} from '../../common/spreadsheet/paradisSpreadsheetObjectParser.js';
import type { ParadisSemanticSheet, ParadisSpreadsheetPartSource } from '../../common/spreadsheet/paradisSpreadsheetSemantic.js';

const packageRelationships = 'http://schemas.openxmlformats.org/package/2006/relationships';
const officeRelationships = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';
const spreadsheet = 'http://schemas.openxmlformats.org/spreadsheetml/2006/main';
const drawing = 'http://schemas.openxmlformats.org/drawingml/2006/spreadsheetDrawing';
const drawingMain = 'http://schemas.openxmlformats.org/drawingml/2006/main';
const chart = 'http://schemas.openxmlformats.org/drawingml/2006/chart';
const relationshipContentType = 'application/vnd.openxmlformats-package.relationships+xml';

function utf8(value: string): Uint8Array {
	return new TextEncoder().encode(value);
}

function part(partId: string, value: string | Uint8Array): ParadisSpreadsheetObjectPartInput {
	const bytes = typeof value === 'string' ? utf8(value) : value;
	return { bytes, source: { partId, fingerprint: fingerprintSpreadsheetObjectBytes(bytes) } };
}

function contentTypes(): string {
	return `<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
		<Default Extension="rels" ContentType="${relationshipContentType}"/>
		<Default Extension="png" ContentType="image/png"/>
		<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>
		<Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>
		<Override PartName="/xl/drawings/drawing1.xml" ContentType="application/vnd.openxmlformats-officedocument.drawing+xml"/>
		<Override PartName="/xl/charts/chart1.xml" ContentType="application/vnd.openxmlformats-officedocument.drawingml.chart+xml"/>
		<Override PartName="/xl/pivotTables/pivotTable1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.pivotTable+xml"/>
		<Override PartName="/xl/pivotCache/pivotCacheDefinition1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.pivotCacheDefinition+xml"/>
		<Override PartName="/xl/pivotCache/pivotCacheRecords1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.pivotCacheRecords+xml"/>
		<Override PartName="/xl/vbaProject.bin" ContentType="application/vnd.ms-office.vbaProject"/>
		<Override PartName="/xl/embeddings/oleObject1.bin" ContentType="application/vnd.openxmlformats-officedocument.oleObject"/>
		<Override PartName="/xl/activeX/activeX1.bin" ContentType="application/vnd.ms-office.activeX"/>
		<Override PartName="/xl/connections.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.connections+xml"/>
		<Override PartName="/xl/future/data.bin" ContentType="application/vnd.example.future"/>
	</Types>`;
}

function relationships(entries: string): string {
	return `<Relationships xmlns="${packageRelationships}">${entries}</Relationships>`;
}

function workbook(): string {
	return `<workbook xmlns="${spreadsheet}" xmlns:r="${officeRelationships}">
		<workbookProtection lockStructure="1" lockWindows="0" workbookAlgorithmName="SHA-512" workbookSpinCount="100000" workbookSaltValue="private-salt" workbookHashValue="private-hash"/>
		<sheets><sheet name="Data" sheetId="1" r:id="rSheet"/></sheets>
		<pivotCaches><pivotCache cacheId="1" r:id="rPivotCache"/></pivotCaches>
	</workbook>`;
}

function worksheet(): string {
	return `<worksheet xmlns="${spreadsheet}" xmlns:r="${officeRelationships}">
		<sheetProtection sheet="1" objects="1" scenarios="0" algorithmName="SHA-512" spinCount="50000" saltValue="sheet-salt" hashValue="sheet-hash"/>
		<sheetData><row r="1"><c r="A1" s="7"/></row></sheetData>
		<drawing r:id="rDrawing"/><pivotTableParts count="1"><pivotTablePart r:id="rPivot"/></pivotTableParts>
		<oleObjects><oleObject progId="Excel.Sheet.12" r:id="rOle"/></oleObjects>
	</worksheet>`;
}

function drawingXml(): string {
	return `<xdr:wsDr xmlns:xdr="${drawing}" xmlns:a="${drawingMain}" xmlns:r="${officeRelationships}">
		<xdr:twoCellAnchor editAs="oneCell">
			<xdr:from><xdr:col>1</xdr:col><xdr:colOff>101</xdr:colOff><xdr:row>2</xdr:row><xdr:rowOff>202</xdr:rowOff></xdr:from>
			<xdr:to><xdr:col>4</xdr:col><xdr:colOff>303</xdr:colOff><xdr:row>6</xdr:row><xdr:rowOff>404</xdr:rowOff></xdr:to>
			<xdr:pic><xdr:nvPicPr><xdr:cNvPr id="1" name="Repeated" descr="Quarterly image" title="Preview"/></xdr:nvPicPr>
				<xdr:blipFill><a:blip r:embed="rImage"/><a:srcRect l="1000" t="2000" r="3000" b="4000"/></xdr:blipFill>
				<xdr:spPr><a:xfrm rot="60000" flipH="1"><a:off x="11" y="22"/><a:ext cx="3300" cy="4400"/></a:xfrm><a:prstGeom prst="rect"/><a:ln w="12700"><a:solidFill><a:srgbClr val="112233"/></a:solidFill></a:ln></xdr:spPr>
			</xdr:pic><xdr:clientData/>
		</xdr:twoCellAnchor>
		<xdr:twoCellAnchor>
			<xdr:from><xdr:col>8</xdr:col><xdr:colOff>909</xdr:colOff><xdr:row>10</xdr:row><xdr:rowOff>1001</xdr:rowOff></xdr:from>
			<xdr:to><xdr:col>14</xdr:col><xdr:colOff>212</xdr:colOff><xdr:row>4</xdr:row><xdr:rowOff>414</xdr:rowOff></xdr:to>
			<xdr:sp><xdr:nvSpPr><xdr:cNvPr id="2" name="Repeated"/></xdr:nvSpPr><xdr:spPr><a:xfrm rot="120000" flipV="1"><a:off x="55" y="66"/><a:ext cx="7700" cy="8800"/></a:xfrm><a:prstGeom prst="line"/><a:ln w="25400"/></xdr:spPr></xdr:sp><xdr:clientData/>
		</xdr:twoCellAnchor>
		<xdr:twoCellAnchor>
			<xdr:from><xdr:col>0</xdr:col><xdr:colOff>0</xdr:colOff><xdr:row>8</xdr:row><xdr:rowOff>0</xdr:rowOff></xdr:from>
			<xdr:to><xdr:col>6</xdr:col><xdr:colOff>0</xdr:colOff><xdr:row>14</xdr:row><xdr:rowOff>0</xdr:rowOff></xdr:to>
			<xdr:graphicFrame><xdr:nvGraphicFramePr><xdr:cNvPr id="3" name="Repeated"/></xdr:nvGraphicFramePr><a:graphic><a:graphicData><c:chart xmlns:c="${chart}" r:id="rChart"/></a:graphicData></a:graphic></xdr:graphicFrame><xdr:clientData/>
		</xdr:twoCellAnchor>
	</xdr:wsDr>`;
}

function chartXml(): string {
	return `<c:chartSpace xmlns:c="${chart}"><c:chart><c:title><c:tx><c:rich><a:p xmlns:a="${drawingMain}"><a:r><a:t>Sales</a:t></a:r></a:p></c:rich></c:tx></c:title><c:plotArea><c:barChart><c:barDir val="col"/><c:grouping val="clustered"/><c:ser>
		<c:idx val="0"/><c:order val="0"/><c:tx><c:strRef><c:f>Data!$B$1</c:f><c:strCache><c:ptCount val="1"/><c:pt idx="0"><c:v>Revenue</c:v></c:pt></c:strCache></c:strRef></c:tx>
		<c:cat><c:strRef><c:f>Data!$A$2:$A$3</c:f><c:strCache><c:ptCount val="2"/><c:pt idx="0"><c:v>North</c:v></c:pt><c:pt idx="1"><c:v>South</c:v></c:pt></c:strCache></c:strRef></c:cat>
		<c:val><c:numRef><c:f>Data!$B$2:$B$3</c:f><c:numCache><c:formatCode>0.00</c:formatCode><c:ptCount val="2"/><c:pt idx="0"><c:v>10.5</c:v></c:pt><c:pt idx="1"><c:v>20</c:v></c:pt></c:numCache></c:numRef></c:val>
	</c:ser></c:barChart></c:plotArea></c:chart></c:chartSpace>`;
}

function pivotTable(): string {
	return `<pivotTableDefinition xmlns="${spreadsheet}" name="Summary" cacheId="1"><location ref="D2:G8" firstHeaderRow="1" firstDataRow="2" firstDataCol="1"/><rowFields count="1"><field x="0"/></rowFields><colFields count="1"><field x="1"/></colFields><pageFields count="1"><pageField fld="2" item="0" name="Page"/></pageFields><dataFields count="1"><dataField name="Sum of Amount" fld="3" subtotal="sum"/></dataFields></pivotTableDefinition>`;
}

function pivotCacheDefinition(): string {
	return `<pivotCacheDefinition xmlns="${spreadsheet}" xmlns:r="${officeRelationships}" r:id="rRecords" recordCount="2" refreshOnLoad="0"><cacheSource type="worksheet"><worksheetSource ref="A1:D3" sheet="Data"/></cacheSource><cacheFields count="2"><cacheField name="Region"><sharedItems count="2"><s v="North"/><s v="South"/></sharedItems></cacheField><cacheField name="Amount" databaseField="1"><sharedItems containsNumber="1" minValue="10.5" maxValue="20"/></cacheField></cacheFields></pivotCacheDefinition>`;
}

function pivotCacheRecords(): string {
	return `<pivotCacheRecords xmlns="${spreadsheet}" count="2"><r><s v="North"/><n v="10.5"/></r><r><s v="South"/><n v="20"/></r></pivotCacheRecords>`;
}

function fixtureParts(): ParadisSpreadsheetObjectPartInput[] {
	return [
		part('/[Content_Types].xml', contentTypes()),
		part('/_rels/.rels', relationships(`<Relationship Id="rWorkbook" Type="${officeRelationships}/officeDocument" Target="xl/workbook.xml"/>`)),
		part('/xl/workbook.xml', workbook()),
		part('/xl/_rels/workbook.xml.rels', relationships([
			`<Relationship Id="rSheet" Type="${officeRelationships}/worksheet" Target="worksheets/sheet1.xml"/>`,
			`<Relationship Id="rPivotCache" Type="${officeRelationships}/pivotCacheDefinition" Target="pivotCache/pivotCacheDefinition1.xml"/>`,
			`<Relationship Id="rVba" Type="${officeRelationships}/vbaProject" Target="vbaProject.bin"/>`,
			`<Relationship Id="rConnections" Type="${officeRelationships}/connections" Target="connections.xml"/>`,
			`<Relationship Id="rExternal" Type="${officeRelationships}/externalLinkPath" TargetMode="External" Target="file:///Users/alice/private/source.xlsx"/>`,
		].join(''))),
		part('/xl/worksheets/sheet1.xml', worksheet()),
		part('/xl/worksheets/_rels/sheet1.xml.rels', relationships([
			`<Relationship Id="rDrawing" Type="${officeRelationships}/drawing" Target="../drawings/drawing1.xml"/>`,
			`<Relationship Id="rPivot" Type="${officeRelationships}/pivotTable" Target="../pivotTables/pivotTable1.xml"/>`,
			`<Relationship Id="rOle" Type="${officeRelationships}/oleObject" Target="../embeddings/oleObject1.bin"/>`,
			`<Relationship Id="rActiveX" Type="${officeRelationships}/control" Target="../activeX/activeX1.bin"/>`,
		].join(''))),
		part('/xl/drawings/drawing1.xml', drawingXml()),
		part('/xl/drawings/_rels/drawing1.xml.rels', relationships([
			`<Relationship Id="rImage" Type="${officeRelationships}/image" Target="../media/image1.png"/>`,
			`<Relationship Id="rChart" Type="${officeRelationships}/chart" Target="../charts/chart1.xml"/>`,
		].join(''))),
		part('/xl/media/image1.png', new Uint8Array([0x89, 0x50, 0x4e, 0x47, 1, 2, 3, 4])),
		part('/xl/charts/chart1.xml', chartXml()),
		part('/xl/pivotTables/pivotTable1.xml', pivotTable()),
		part('/xl/pivotTables/_rels/pivotTable1.xml.rels', relationships(`<Relationship Id="rCache" Type="${officeRelationships}/pivotCacheDefinition" Target="../pivotCache/pivotCacheDefinition1.xml"/>`)),
		part('/xl/pivotCache/pivotCacheDefinition1.xml', pivotCacheDefinition()),
		part('/xl/pivotCache/_rels/pivotCacheDefinition1.xml.rels', relationships(`<Relationship Id="rRecords" Type="${officeRelationships}/pivotCacheRecords" Target="pivotCacheRecords1.xml"/>`)),
		part('/xl/pivotCache/pivotCacheRecords1.xml', pivotCacheRecords()),
		part('/xl/vbaProject.bin', new Uint8Array([86, 66, 65, 0, 1])),
		part('/xl/embeddings/oleObject1.bin', new Uint8Array([79, 76, 69, 0, 2])),
		part('/xl/activeX/activeX1.bin', new Uint8Array([65, 88, 0, 3])),
		part('/xl/connections.xml', `<connections xmlns="${spreadsheet}"><connection id="1" name="Private warehouse" type="5"><dbPr connection="Server=secret.example;Password=hunter2" command="SELECT * FROM private"/></connection></connections>`),
		part('/xl/future/data.bin', new Uint8Array([9, 8, 7, 6])),
	];
}

function replacePart(parts: ParadisSpreadsheetObjectPartInput[], partId: string, value: string | Uint8Array): ParadisSpreadsheetObjectPartInput[] {
	const index = parts.findIndex(candidate => candidate.source.partId === partId);
	ok(index >= 0);
	parts[index] = part(partId, value);
	return parts;
}

function scatterChartXml(): string {
	return `<c:chartSpace xmlns:c="${chart}"><c:chart><c:plotArea><c:scatterChart><c:scatterStyle val="line"/><c:ser>
		<c:idx val="0"/><c:order val="0"/>
		<c:xVal><c:numRef><c:f>Data!$A$2:$A$3</c:f><c:numCache><c:formatCode>0</c:formatCode><c:ptCount val="2"/><c:pt idx="0"><c:v>1</c:v></c:pt><c:pt idx="1"><c:v>2</c:v></c:pt></c:numCache></c:numRef></c:xVal>
		<c:yVal><c:numRef><c:f>Data!$B$2:$B$3</c:f><c:numCache><c:formatCode>0.0</c:formatCode><c:ptCount val="2"/><c:pt idx="0"><c:v>10.5</c:v></c:pt><c:pt idx="1"><c:v>20</c:v></c:pt></c:numCache></c:numRef></c:yVal>
	</c:ser></c:scatterChart></c:plotArea></c:chart></c:chartSpace>`;
}

function oneCellAndOpaqueDrawingXml(): string {
	return `<xdr:wsDr xmlns:xdr="${drawing}" xmlns:a="${drawingMain}" xmlns:r="${officeRelationships}">
		<xdr:oneCellAnchor><xdr:from><xdr:col>5</xdr:col><xdr:colOff>10</xdr:colOff><xdr:row>7</xdr:row><xdr:rowOff>20</xdr:rowOff></xdr:from><xdr:ext cx="300" cy="400"/>
			<xdr:sp><xdr:nvSpPr><xdr:cNvPr id="4" name="One cell line"/></xdr:nvSpPr><xdr:spPr><a:prstGeom prst="line"/></xdr:spPr></xdr:sp><xdr:clientData/></xdr:oneCellAnchor>
		<xdr:twoCellAnchor><xdr:from><xdr:col>0</xdr:col><xdr:colOff>0</xdr:colOff><xdr:row>0</xdr:row><xdr:rowOff>0</xdr:rowOff></xdr:from><xdr:to><xdr:col>1</xdr:col><xdr:colOff>0</xdr:colOff><xdr:row>1</xdr:row><xdr:rowOff>0</xdr:rowOff></xdr:to><xdr:grpSp/><xdr:clientData/></xdr:twoCellAnchor>
		<xdr:absoluteAnchor><xdr:pos x="-3600" y="0"/><xdr:ext cx="500" cy="600"/><xdr:graphicFrame><xdr:nvGraphicFramePr><xdr:cNvPr id="5" name="Future frame"/></xdr:nvGraphicFramePr><a:graphic><a:graphicData uri="urn:future"/></a:graphic></xdr:graphicFrame><xdr:clientData/></xdr:absoluteAnchor>
	</xdr:wsDr>`;
}

function invalid(run: () => unknown, code: ParadisOfficePackageError['code']): void {
	throws(run, error => error instanceof ParadisOfficePackageError && error.code === code);
}

suite('ParadisSpreadsheetObjects', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	test('uses source position rather than duplicate display names for object identity', () => {
		const model = parseSpreadsheetObjects({ parts: fixtureParts() });
		const repeated = [...model.images, ...model.drawings, ...model.charts].filter(value => value.name === 'Repeated');
		strictEqual(repeated.length, 3);
		strictEqual(new Set(repeated.map(value => value.id)).size, 3);
		notStrictEqual(model.pivots[0].id, model.charts[0].id);
	});

	test('keeps image content, placement, crop, transform, and line endpoints independently', () => {
		const model = parseSpreadsheetObjects({ parts: fixtureParts() });
		const image = model.images[0];
		deepStrictEqual(image.anchor, {
			kind: 'twoCell', editAs: 'oneCell',
			from: { column: 1, columnOffset: 101, row: 2, rowOffset: 202 },
			to: { column: 4, columnOffset: 303, row: 6, rowOffset: 404 },
		});
		deepStrictEqual(image.transform, { offset: { x: 11, y: 22 }, extent: { cx: 3300, cy: 4400 }, rotation: 60000, flipHorizontal: true });
		deepStrictEqual(image.crop, { left: 1000, top: 2000, right: 3000, bottom: 4000 });
		deepStrictEqual(image.line, { width: 12700, color: '112233' });
		deepStrictEqual(image.content, { contentType: 'image/png', fingerprint: fingerprintSpreadsheetObjectBytes(new Uint8Array([0x89, 0x50, 0x4e, 0x47, 1, 2, 3, 4])) });

		const line = model.drawings.find(value => value.kind === 'line');
		ok(line?.lineGeometry);
		deepStrictEqual(line.lineGeometry, {
			kind: 'cellAnchored',
			start: { column: 8, columnOffset: 909, row: 10, rowOffset: 1001 },
			end: { column: 14, columnOffset: 212, row: 4, rowOffset: 414 },
			diagonal: 'up',
		});
		deepStrictEqual(line.transform, { offset: { x: 55, y: 66 }, extent: { cx: 7700, cy: 8800 }, rotation: 120000, flipVertical: true });
		strictEqual(line.source.fingerprint.value, fingerprintSpreadsheetObjectBytes(utf8(drawingXml())).value);
	});

	test('models saved chart references and caches without resolving or recalculating ranges', () => {
		const chartObject = parseSpreadsheetObjects({ parts: fixtureParts() }).charts[0];
		deepStrictEqual({ name: chartObject.name, type: chartObject.chartType, title: chartObject.title, evaluation: chartObject.evaluation }, {
			name: 'Repeated', type: 'bar', title: 'Sales', evaluation: 'savedCacheOnly',
		});
		deepStrictEqual(chartObject.series, [{
			index: 0, order: 0,
			name: { formula: 'Data!$B$1', cache: [{ index: 0, value: 'Revenue' }] },
			categories: { formula: 'Data!$A$2:$A$3', cache: [{ index: 0, value: 'North' }, { index: 1, value: 'South' }] },
			values: { formula: 'Data!$B$2:$B$3', formatCode: '0.00', cache: [{ index: 0, value: '10.5' }, { index: 1, value: '20' }] },
		}]);
	});

	test('redacts external chart formulas and external linked images while retaining saved metadata', () => {
		const externalFormula = `'C:\\Users\\alice\\[secret.xlsx]Data'!$B$2:$B$3`;
		const formulaParts = replacePart(fixtureParts(), '/xl/charts/chart1.xml', chartXml().replace('Data!$B$2:$B$3', externalFormula));
		const formulaModel = parseSpreadsheetObjects({ parts: formulaParts });
		deepStrictEqual(formulaModel.charts[0].series[0].values, {
			formulaFingerprint: fingerprintSpreadsheetObjectBytes(utf8(externalFormula)), evaluation: 'notEvaluated', formatCode: '0.00',
			cache: [{ index: 0, value: '10.5' }, { index: 1, value: '20' }],
		});
		doesNotMatch(JSON.stringify(formulaModel), /Users|alice|secret\.xlsx/);

		const linkedParts = fixtureParts();
		replacePart(linkedParts, '/xl/drawings/drawing1.xml', drawingXml().replace('r:embed="rImage"', 'r:link="rImage"'));
		replacePart(linkedParts, '/xl/drawings/_rels/drawing1.xml.rels', relationships([
			`<Relationship Id="rImage" Type="${officeRelationships}/image" TargetMode="External" Target="https://cdn.example/private.png"/>`,
			`<Relationship Id="rChart" Type="${officeRelationships}/chart" Target="../charts/chart1.xml"/>`,
		].join('')));
		const linkedModel = parseSpreadsheetObjects({ parts: linkedParts });
		deepStrictEqual(linkedModel.images[0].content, {
			targetScheme: 'https', targetFingerprint: fingerprintSpreadsheetObjectBytes(utf8('https://cdn.example/private.png')), behavior: 'notFetched',
		});
		doesNotMatch(JSON.stringify(linkedModel.images[0]), /cdn\.example|private\.png/);
	});

	test('keeps scatter x/y caches and pivot shared-item indexes as stored data', () => {
		const scatterParts = replacePart(fixtureParts(), '/xl/charts/chart1.xml', scatterChartXml());
		const scatter = parseSpreadsheetObjects({ parts: scatterParts }).charts[0];
		strictEqual(scatter.chartType, 'scatter');
		deepStrictEqual(scatter.series[0].xValues, {
			formula: 'Data!$A$2:$A$3', formatCode: '0', cache: [{ index: 0, value: '1' }, { index: 1, value: '2' }],
		});
		deepStrictEqual(scatter.series[0].yValues, {
			formula: 'Data!$B$2:$B$3', formatCode: '0.0', cache: [{ index: 0, value: '10.5' }, { index: 1, value: '20' }],
		});

		const indexedParts = replacePart(fixtureParts(), '/xl/pivotCache/pivotCacheRecords1.xml', pivotCacheRecords().replace('<s v="North"/>', '<x v="0"/>'));
		deepStrictEqual(parseSpreadsheetObjects({ parts: indexedParts }).pivots[0].cache.records[0][0], { kind: 'sharedItemIndex', index: 0 });
	});

	test('models pivot worksheet source, fields, and saved cache records without refresh', () => {
		const pivot = parseSpreadsheetObjects({ parts: fixtureParts() }).pivots[0];
		deepStrictEqual({ name: pivot.name, cacheId: pivot.cacheId, location: pivot.location, refresh: pivot.refresh }, {
			name: 'Summary', cacheId: 1, location: 'D2:G8', refresh: 'notPerformed',
		});
		deepStrictEqual(pivot.placements, {
			rows: [0], columns: [1], pages: [{ field: 2, item: 0, name: 'Page' }], data: [{ field: 3, name: 'Sum of Amount', subtotal: 'sum' }],
		});
		deepStrictEqual(pivot.cache.source, { kind: 'worksheet', sheet: 'Data', ref: 'A1:D3' });
		deepStrictEqual(pivot.cache.fields.map(field => ({ name: field.name, sharedItems: field.sharedItems })), [
			{ name: 'Region', sharedItems: [{ kind: 'string', value: 'North' }, { kind: 'string', value: 'South' }] },
			{ name: 'Amount', sharedItems: [] },
		]);
		deepStrictEqual(pivot.cache.records, [
			[{ kind: 'string', value: 'North' }, { kind: 'number', value: '10.5' }],
			[{ kind: 'string', value: 'South' }, { kind: 'number', value: '20' }],
		]);
	});

	test('returns protection and unsafe package features as redacted metadata and hashes only', () => {
		const model = parseSpreadsheetObjects({ parts: fixtureParts() });
		deepStrictEqual(model.security.workbookProtection, {
			lockStructure: true, lockWindows: false,
			credential: { algorithm: 'SHA-512', spinCount: 100000, saltFingerprint: fingerprintSpreadsheetObjectBytes(utf8('private-salt')), hashFingerprint: fingerprintSpreadsheetObjectBytes(utf8('private-hash')) },
		});
		strictEqual(model.security.sheetProtections[0].sheet, true);
		deepStrictEqual(model.security.unsafeParts.map(value => [value.kind, value.behavior, value.fingerprint.algorithm]), [
			['vba', 'notExecuted', 'sha256'], ['ole', 'notExecuted', 'sha256'], ['activeX', 'notExecuted', 'sha256'], ['connection', 'notEvaluated', 'sha256'],
		]);
		strictEqual(model.security.externalReferences[0].behavior, 'notFetched');
		strictEqual(model.security.externalReferences[0].targetScheme, 'file');
		const serialized = JSON.stringify(model);
		doesNotMatch(serialized, /Users|alice|source\.xlsx|secret\.example|hunter2|SELECT \*/);
	});

	test('hashes legacy workbook and sheet protection credentials without exposing them', () => {
		const protectedParts = fixtureParts();
		replacePart(protectedParts, '/xl/workbook.xml', workbook().replace('lockStructure="1"', 'lockStructure="1" workbookPassword="ABCD" revisionsPassword="DCBA"'));
		replacePart(protectedParts, '/xl/worksheets/sheet1.xml', worksheet().replace('sheet="1"', 'sheet="1" password="DAA7"'));
		const security = parseSpreadsheetObjects({ parts: protectedParts }).security;
		strictEqual(security.workbookProtection?.credential?.legacyPasswordFingerprint?.value, fingerprintSpreadsheetObjectBytes(utf8('ABCD')).value);
		strictEqual(security.workbookProtection?.credential?.legacyRevisionPasswordFingerprint?.value, fingerprintSpreadsheetObjectBytes(utf8('DCBA')).value);
		strictEqual(security.sheetProtections[0].credential?.legacyPasswordFingerprint?.value, fingerprintSpreadsheetObjectBytes(utf8('DAA7')).value);
		doesNotMatch(JSON.stringify(security), /ABCD|DCBA|DAA7/);
	});

	test('preserves signed coordinates and one-cell line marker geometry, and retains unknown drawing anchors opaquely', () => {
		const signedParts = replacePart(fixtureParts(), '/xl/drawings/drawing1.xml', drawingXml().replace('<xdr:colOff>101</xdr:colOff>', '<xdr:colOff>-101</xdr:colOff>').replace('<a:off x="11" y="22"/>', '<a:off x="-11" y="22"/>'));
		const signedImage = parseSpreadsheetObjects({ parts: signedParts }).images[0];
		strictEqual(signedImage.anchor.kind === 'twoCell' && signedImage.anchor.from.columnOffset, -101);
		strictEqual(signedImage.transform?.offset?.x, -11);

		const drawingParts = replacePart(fixtureParts(), '/xl/drawings/drawing1.xml', oneCellAndOpaqueDrawingXml());
		const model = parseSpreadsheetObjects({ parts: drawingParts });
		const line = model.drawings[0];
		deepStrictEqual(line.lineGeometry, {
			kind: 'cellAnchoredExtent', start: { column: 5, columnOffset: 10, row: 7, rowOffset: 20 }, extent: { cx: 300, cy: 400 }, diagonal: 'down',
		});
		strictEqual(model.opaqueDrawings.length, 2);
		ok(model.opaqueDrawings.every(value => value.evaluation === 'notEvaluated' && value.source.fingerprint.value === fingerprintSpreadsheetObjectBytes(utf8(oneCellAndOpaqueDrawingXml())).value));
		deepStrictEqual(model.opaqueDrawings.map(value => value.anchor.kind), ['twoCell', 'absolute']);
	});

	test('keeps unknown content opaque and not evaluated', () => {
		const model = parseSpreadsheetObjects({ parts: fixtureParts() });
		deepStrictEqual(model.opaqueParts.map(value => ({ contentType: value.contentType, evaluation: value.evaluation, fingerprint: value.fingerprint })), [{
			contentType: 'application/vnd.example.future', evaluation: 'notEvaluated', fingerprint: fingerprintSpreadsheetObjectBytes(new Uint8Array([9, 8, 7, 6])),
		}]);
	});

	test('rejects forged hashes, duplicate Parts, wrong content types, traversal, and missing internal targets', () => {
		const forged = fixtureParts();
		forged[2] = { ...forged[2], source: { ...forged[2].source, fingerprint: { ...forged[2].source.fingerprint, value: '0'.repeat(64) } } };
		invalid(() => parseSpreadsheetObjects({ parts: forged }), 'unsafe');

		const duplicate = fixtureParts();
		duplicate.push(duplicate[2]);
		invalid(() => parseSpreadsheetObjects({ parts: duplicate }), 'malformed');

		const wrongType = fixtureParts();
		wrongType[0] = part('/[Content_Types].xml', contentTypes().replace('application/vnd.openxmlformats-officedocument.drawingml.chart+xml', 'application/octet-stream'));
		invalid(() => parseSpreadsheetObjects({ parts: wrongType }), 'unsafe');

		const traversal = fixtureParts();
		traversal[7] = part('/xl/drawings/_rels/drawing1.xml.rels', relationships(`<Relationship Id="rImage" Type="${officeRelationships}/image" Target="../../../private.png"/><Relationship Id="rChart" Type="${officeRelationships}/chart" Target="../charts/chart1.xml"/>`));
		invalid(() => parseSpreadsheetObjects({ parts: traversal }), 'unsafe');

		const missing = fixtureParts().filter(value => value.source.partId !== '/xl/media/image1.png');
		invalid(() => parseSpreadsheetObjects({ parts: missing }), 'unsafe');
	});

	test('attaches an object overlay without changing base diagonal style provenance', () => {
		const diagonal = Object.freeze({ diagonalUp: true, diagonalDown: false, diagonal: Object.freeze({ style: 'thin' }) });
		const cell = Object.freeze({ storedType: 'blank' as const, styleRef: 7, effectiveStyleRef: 9, effectiveStyleOrigin: 'cell' as const });
		const sheet = Object.freeze({
			name: 'Data', sheetId: '1', order: 0, state: 'visible' as const, relationshipId: 'rSheet', partId: '/xl/worksheets/sheet1.xml',
			source: { partId: '/xl/worksheets/sheet1.xml', fingerprint: fingerprintSpreadsheetObjectBytes(utf8(worksheet())) } as ParadisSpreadsheetPartSource,
			views: Object.freeze([]), rows: new Map(), columns: Object.freeze([]), merges: Object.freeze([]), cells: new Map([['A1', cell]]),
			conditionalFormatting: Object.freeze({ baseDiagonal: diagonal }) as never,
		}) satisfies ParadisSemanticSheet;
		const bound = bindSpreadsheetObjectsToSheet(sheet, parseSpreadsheetObjects({ parts: fixtureParts() }));
		notStrictEqual(bound, sheet);
		strictEqual(bound.cells, sheet.cells);
		strictEqual(bound.cells.get('A1'), cell);
		strictEqual(bound.cells.get('A1')?.styleRef, 7);
		strictEqual(bound.cells.get('A1')?.effectiveStyleRef, 9);
		strictEqual(bound.conditionalFormatting, sheet.conditionalFormatting);
		strictEqual((bound.conditionalFormatting as unknown as { baseDiagonal: unknown }).baseDiagonal, diagonal);
		ok(bound.objects.drawings.some(value => value.lineGeometry?.diagonal === 'up'));
	});
});
