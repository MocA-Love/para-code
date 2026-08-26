/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import { deepStrictEqual, doesNotMatch, ok, strictEqual, throws } from 'assert';
import { CancellationToken } from '../../../../../base/common/cancellation.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { ParadisOfficePackageError } from '../../common/office/paradisOfficeArchive.js';
import { parseParadisOfficeXml } from '../../common/office/paradisOfficeCanonicalXml.js';
import {
	bindSpreadsheetAnnotationOverlays,
	fingerprintSpreadsheetAnnotationsBytes,
	fingerprintSpreadsheetAnnotationsXml,
	parseSpreadsheetAnnotations,
	parseSpreadsheetAnnotationsVerifiedDocuments,
	type ParadisSpreadsheetAnnotationsInput,
	type ParadisSpreadsheetVerifiedAnnotationsInput,
} from '../../common/spreadsheet/paradisSpreadsheetAnnotations.js';
import type { ParadisSemanticCell, ParadisSpreadsheetPartSource } from '../../common/spreadsheet/paradisSpreadsheetSemantic.js';

const spreadsheetNamespace = 'http://schemas.openxmlformats.org/spreadsheetml/2006/main';
const officeRelationshipNamespace = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';
const packageRelationshipNamespace = 'http://schemas.openxmlformats.org/package/2006/relationships';
const x14Namespace = 'http://schemas.microsoft.com/office/spreadsheetml/2009/9/main';
const xmNamespace = 'http://schemas.microsoft.com/office/excel/2006/main';
const threadedNamespace = 'http://schemas.microsoft.com/office/spreadsheetml/2018/threadedcomments';
const vmlNamespace = 'urn:schemas-microsoft-com:vml';
const excelNamespace = 'urn:schemas-microsoft-com:office:excel';
const relationshipsContentType = 'application/vnd.openxmlformats-package.relationships+xml';

const relationshipTypes = {
	worksheet: `${officeRelationshipNamespace}/worksheet`,
	comments: `${officeRelationshipNamespace}/comments`,
	vml: `${officeRelationshipNamespace}/vmlDrawing`,
	hyperlink: `${officeRelationshipNamespace}/hyperlink`,
	threaded: 'http://schemas.microsoft.com/office/2017/10/relationships/threadedComment',
	person: 'http://schemas.microsoft.com/office/2017/10/relationships/person',
};

const partIds = {
	contentTypes: '/[Content_Types].xml',
	rootRelationships: '/_rels/.rels',
	workbook: '/xl/workbook.xml',
	worksheet: '/xl/worksheets/sheet1.xml',
	worksheetRelationships: '/xl/worksheets/_rels/sheet1.xml.rels',
	workbookRelationships: '/xl/_rels/workbook.xml.rels',
	comments: '/xl/comments1.xml',
	vml: '/xl/drawings/vmlDrawing1.vml',
	vmlRelationships: '/xl/drawings/_rels/vmlDrawing1.vml.rels',
	threaded: '/xl/threadedComments/threadedComment1.xml',
	persons: '/xl/persons/person.xml',
} as const;

const rootThreadId = '{00000000-0000-0000-0000-000000000101}';
const replyThreadId = '{00000000-0000-0000-0000-000000000102}';
const personId = '{00000000-0000-0000-0000-000000000201}';

function sourceFor(partId: string, xml: string): ParadisSpreadsheetPartSource {
	return { partId, fingerprint: fingerprintSpreadsheetAnnotationsXml(xml) };
}

function sourceForBytes(partId: string, bytes: Uint8Array): ParadisSpreadsheetPartSource {
	return { partId, fingerprint: fingerprintSpreadsheetAnnotationsBytes(bytes) };
}

function contentTypes(): string {
	return `<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
		<Default Extension="vml" ContentType="application/vnd.openxmlformats-officedocument.vmlDrawing"/>
		<Default Extension="rels" ContentType="${relationshipsContentType}"/>
		<Override PartName="${partIds.workbook}" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>
		<Override PartName="${partIds.worksheet}" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>
		<Override PartName="${partIds.comments}" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.comments+xml"/>
		<Override PartName="${partIds.threaded}" ContentType="application/vnd.ms-excel.threadedcomments+xml"/>
		<Override PartName="${partIds.persons}" ContentType="application/vnd.ms-excel.person+xml"/>
	</Types>`;
}

function rootRelationships(workbookTarget = 'xl/workbook.xml'): string {
	return `<Relationships xmlns="${packageRelationshipNamespace}"><Relationship Id="rWorkbook" Type="${officeRelationshipNamespace}/officeDocument" Target="${workbookTarget}"/></Relationships>`;
}

function workbook(): string {
	return `<workbook xmlns="${spreadsheetNamespace}" xmlns:r="${officeRelationshipNamespace}"><sheets><sheet name="Sheet1" sheetId="1" r:id="rSheet1"/></sheets></workbook>`;
}

function worksheet(target = 'HTTPS://Example.COM:443/a/../secret-token?q=1'): string {
	return `\uFEFF<worksheet xmlns="${spreadsheetNamespace}" xmlns:r="${officeRelationshipNamespace}" xmlns:x14="${x14Namespace}" xmlns:xm="${xmNamespace}">
		<sheetData/>
		<dataValidations count="1"><dataValidation type="list" allowBlank="1" showInputMessage="1" promptTitle=" Pick " prompt="A or B" errorStyle="stop" errorTitle="No" error="Choose one" sqref="A1:A2"><formula1>"A,B"</formula1></dataValidation></dataValidations>
		<hyperlinks>
			<hyperlink ref="A1" r:id="rLink" location="'Archive'!B2" tooltip="Open archived cell" display="Archive"/>
			<hyperlink ref="B2" location="NamedRange" tooltip="Jump locally"/>
		</hyperlinks>
		<legacyDrawing r:id="rVml"/>
		<extLst><ext uri="{CCE6A557-97BC-4B89-ADB6-D9C93CAAB3DF}"><x14:dataValidations count="1"><x14:dataValidation type="custom" allowBlank="0"><x14:formula1><xm:f>LEN(B1)&gt;0</xm:f></x14:formula1><xm:sqref>B1</xm:sqref><x14:futureFeature flag="1"><x14:value>opaque</x14:value></x14:futureFeature></x14:dataValidation></x14:dataValidations></ext></extLst>
	</worksheet>`;
}

function worksheetRelationships(target = 'HTTPS://Example.COM:443/a/../secret-token?q=1'): string {
	return `<Relationships xmlns="${packageRelationshipNamespace}">
		<Relationship Id="rComments" Type="${relationshipTypes.comments}" Target="../comments1.xml"/>
		<Relationship Id="rVml" Type="${relationshipTypes.vml}" Target="../drawings/vmlDrawing1.vml"/>
		<Relationship Id="rThreaded" Type="${relationshipTypes.threaded}" Target="../threadedComments/threadedComment1.xml"/>
		<Relationship Id="rLink" Type="${relationshipTypes.hyperlink}" Target="${escapeXml(target)}" TargetMode="External"/>
	</Relationships>`;
}

function escapeXml(value: string): string {
	return value.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;');
}

function workbookRelationships(): string {
	return `<Relationships xmlns="${packageRelationshipNamespace}"><Relationship Id="rSheet1" Type="${relationshipTypes.worksheet}" Target="worksheets/sheet1.xml"/><Relationship Id="rPersons" Type="${relationshipTypes.person}" Target="persons/person.xml"/></Relationships>`;
}

function comments(author = 'Ali\u202Ece'): string {
	return `<comments xmlns="${spreadsheetNamespace}"><authors><author>${author}</author></authors><commentList><comment ref="A1" authorId="0" shapeId="1025"><text><r><rPr><b/><color rgb="FFFF0000"/></rPr><t>Hello</t></r><r><t xml:space="preserve"> note</t></r></text></comment></commentList></comments>`;
}

function vmlDrawing(): string {
	return `<xml xmlns:v="${vmlNamespace}" xmlns:x="${excelNamespace}"><v:shape id="_x0000_s1025"><x:ClientData ObjectType="Note"><x:MoveWithCells/><x:SizeWithCells/><x:Anchor>0, 15, 0, 2, 3, 31, 4, 4</x:Anchor><x:Row>0</x:Row><x:Column>0</x:Column></x:ClientData></v:shape></xml>`;
}

function vmlDrawingRelationships(body = ''): string {
	return `<Relationships xmlns="${packageRelationshipNamespace}">${body}</Relationships>`;
}

function threadedComments(parentId = rootThreadId): string {
	return `<ThreadedComments xmlns="${threadedNamespace}">
		<threadedComment ref="A1" dT="2026-08-24T10:00:00Z" personId="${personId}" id="${rootThreadId}" done="1"><text>Root discussion</text></threadedComment>
		<threadedComment ref="A1" dT="2026-08-24T10:01:00Z" personId="${personId}" id="${replyThreadId}" parentId="${parentId}"><text>Reply</text></threadedComment>
	</ThreadedComments>`;
}

function persons(displayName = 'Alice'): string {
	return `<personList xmlns="${threadedNamespace}"><person displayName="${displayName}" id="${personId}" userId="alice@example.invalid" providerId="None"/></personList>`;
}

interface XmlSet {
	readonly contentTypesXml: string;
	readonly rootRelationshipsXml: string;
	readonly workbookXml: string;
	readonly worksheetXml: string;
	readonly worksheetRelationshipsXml: string;
	readonly workbookRelationshipsXml: string;
	readonly commentsXml: string;
	readonly vmlDrawingXml: string;
	readonly vmlDrawingRelationshipsXml: string;
	readonly threadedCommentsXml: string;
	readonly personsXml: string;
}

function xmlSet(overrides: Partial<XmlSet> = {}): XmlSet {
	return {
		contentTypesXml: contentTypes(), rootRelationshipsXml: rootRelationships(), workbookXml: workbook(),
		worksheetXml: worksheet(), worksheetRelationshipsXml: worksheetRelationships(),
		workbookRelationshipsXml: workbookRelationships(), commentsXml: comments(), vmlDrawingXml: vmlDrawing(),
		vmlDrawingRelationshipsXml: vmlDrawingRelationships(),
		threadedCommentsXml: threadedComments(), personsXml: persons(), ...overrides,
	};
}

function inputFor(xml: XmlSet): ParadisSpreadsheetAnnotationsInput {
	return {
		contentTypesXml: xml.contentTypesXml, contentTypesSource: sourceFor(partIds.contentTypes, xml.contentTypesXml),
		rootRelationshipsXml: xml.rootRelationshipsXml, rootRelationshipsSource: sourceFor(partIds.rootRelationships, xml.rootRelationshipsXml),
		workbookXml: xml.workbookXml, workbookSource: sourceFor(partIds.workbook, xml.workbookXml),
		worksheetXml: xml.worksheetXml, worksheetSource: sourceFor(partIds.worksheet, xml.worksheetXml),
		worksheetRelationshipsXml: xml.worksheetRelationshipsXml, worksheetRelationshipsSource: sourceFor(partIds.worksheetRelationships, xml.worksheetRelationshipsXml),
		workbookRelationshipsXml: xml.workbookRelationshipsXml, workbookRelationshipsSource: sourceFor(partIds.workbookRelationships, xml.workbookRelationshipsXml),
		commentsXml: xml.commentsXml, commentsSource: sourceFor(partIds.comments, xml.commentsXml),
		vmlDrawingXml: xml.vmlDrawingXml, vmlDrawingSource: sourceFor(partIds.vml, xml.vmlDrawingXml),
		vmlDrawingRelationshipsXml: xml.vmlDrawingRelationshipsXml, vmlDrawingRelationshipsSource: sourceFor(partIds.vmlRelationships, xml.vmlDrawingRelationshipsXml),
		threadedCommentsXml: xml.threadedCommentsXml, threadedCommentsSource: sourceFor(partIds.threaded, xml.threadedCommentsXml),
		personsXml: xml.personsXml, personsSource: sourceFor(partIds.persons, xml.personsXml),
	};
}

function verifiedInputFor(xml: XmlSet): ParadisSpreadsheetVerifiedAnnotationsInput {
	const raw = inputFor(xml);
	const bytes = (value: string) => new TextEncoder().encode(value);
	const parse = (value: string) => parseParadisOfficeXml(value.startsWith('\uFEFF') ? value.slice(1) : value, {
		depth: 96, nodes: 10_000, attributeLength: 64 * 1024, characters: 1024 * 1024,
	});
	return {
		contentTypesDocument: parse(xml.contentTypesXml), contentTypesBytes: bytes(xml.contentTypesXml), contentTypesSource: raw.contentTypesSource,
		rootRelationshipsDocument: parse(xml.rootRelationshipsXml), rootRelationshipsBytes: bytes(xml.rootRelationshipsXml), rootRelationshipsSource: raw.rootRelationshipsSource,
		workbookDocument: parse(xml.workbookXml), workbookBytes: bytes(xml.workbookXml), workbookSource: raw.workbookSource,
		worksheetDocument: parse(xml.worksheetXml), worksheetBytes: bytes(xml.worksheetXml), worksheetSource: raw.worksheetSource,
		worksheetRelationshipsDocument: parse(xml.worksheetRelationshipsXml), worksheetRelationshipsBytes: bytes(xml.worksheetRelationshipsXml), worksheetRelationshipsSource: raw.worksheetRelationshipsSource,
		workbookRelationshipsDocument: parse(xml.workbookRelationshipsXml), workbookRelationshipsBytes: bytes(xml.workbookRelationshipsXml), workbookRelationshipsSource: raw.workbookRelationshipsSource,
		commentsDocument: parse(xml.commentsXml), commentsBytes: bytes(xml.commentsXml), commentsSource: raw.commentsSource,
		vmlDrawingDocument: parse(xml.vmlDrawingXml), vmlDrawingBytes: bytes(xml.vmlDrawingXml), vmlDrawingSource: raw.vmlDrawingSource,
		vmlDrawingRelationshipsDocument: parse(xml.vmlDrawingRelationshipsXml), vmlDrawingRelationshipsBytes: bytes(xml.vmlDrawingRelationshipsXml), vmlDrawingRelationshipsSource: raw.vmlDrawingRelationshipsSource,
		threadedCommentsDocument: parse(xml.threadedCommentsXml), threadedCommentsBytes: bytes(xml.threadedCommentsXml), threadedCommentsSource: raw.threadedCommentsSource,
		personsDocument: parse(xml.personsXml), personsBytes: bytes(xml.personsXml), personsSource: raw.personsSource,
	};
}

function invalid(run: () => unknown, code: ParadisOfficePackageError['code']): void {
	throws(run, error => error instanceof ParadisOfficePackageError && error.code === code);
}

suite('ParadisSpreadsheetAnnotations', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	test('parses every supplied optional XML Part even when its string is empty', () => {
		for (const name of ['commentsXml', 'vmlDrawingXml', 'vmlDrawingRelationshipsXml', 'threadedCommentsXml', 'personsXml'] as const) {
			const xml = { ...xmlSet(), [name]: '' };
			invalid(() => parseSpreadsheetAnnotations(inputFor(xml)), 'malformed');
		}
	});

	test('requires the exact Relationships MIME before parsing every relationships Part', () => {
		const defaultEntry = `<Default Extension="rels" ContentType="${relationshipsContentType}"/>`;
		const missing = contentTypes().replace(defaultEntry, '');
		invalid(() => parseSpreadsheetAnnotations(inputFor(xmlSet({ contentTypesXml: missing }))), 'unsafe');

		const wrong = contentTypes().replace(relationshipsContentType, 'application/octet-stream');
		invalid(() => parseSpreadsheetAnnotations(inputFor(xmlSet({ contentTypesXml: wrong }))), 'unsafe');

		const relationshipParts = [
			['rootRelationshipsXml', partIds.rootRelationships],
			['workbookRelationshipsXml', partIds.workbookRelationships],
			['worksheetRelationshipsXml', partIds.worksheetRelationships],
			['vmlDrawingRelationshipsXml', partIds.vmlRelationships],
		] as const;
		const exactOverrides = relationshipParts.map(([, partId]) => `<Override PartName="${partId}" ContentType="${relationshipsContentType}"/>`).join('');
		const overrideOnly = contentTypes().replace(defaultEntry, '').replace('</Types>', `${exactOverrides}</Types>`);
		strictEqual(parseSpreadsheetAnnotations(inputFor(xmlSet({ contentTypesXml: overrideOnly }))).validations.length, 2);

		for (const [xmlName, partId] of relationshipParts) {
			const badOverride = `<Override PartName="${partId}" ContentType="application/octet-stream"/>`;
			const contentTypesXml = contentTypes().replace('</Types>', `${badOverride}</Types>`);
			const xml = { ...xmlSet(), contentTypesXml, [xmlName]: '' };
			invalid(() => parseSpreadsheetAnnotations(inputFor(xml)), 'unsafe');
		}
	});

	test('validates verified Relationships MIME before reading any relationship bytes or graph', () => {
		const relationshipParts = [
			['rootRelationshipsDocument', 'rootRelationshipsBytes', 'rootRelationshipsSource', partIds.rootRelationships],
			['workbookRelationshipsDocument', 'workbookRelationshipsBytes', 'workbookRelationshipsSource', partIds.workbookRelationships],
			['worksheetRelationshipsDocument', 'worksheetRelationshipsBytes', 'worksheetRelationshipsSource', partIds.worksheetRelationships],
			['vmlDrawingRelationshipsDocument', 'vmlDrawingRelationshipsBytes', 'vmlDrawingRelationshipsSource', partIds.vmlRelationships],
		] as const;
		for (const [documentName, bytesName, sourceName, partId] of relationshipParts) {
			const badOverride = `<Override PartName="${partId}" ContentType="application/octet-stream"/>`;
			const contentTypesXml = contentTypes().replace('</Types>', `${badOverride}</Types>`);
			const verified = verifiedInputFor(xmlSet({ contentTypesXml }));
			const invalidBytes = new TextEncoder().encode('not relationships xml');
			let graphReads = 0;
			const sentinelDocument = new Proxy(verified[documentName]!, {
				getPrototypeOf(target) { graphReads++; return Reflect.getPrototypeOf(target); },
			});
			const candidate = {
				...verified,
				[documentName]: sentinelDocument,
				[bytesName]: invalidBytes,
				[sourceName]: sourceForBytes(partId, invalidBytes),
			} as ParadisSpreadsheetVerifiedAnnotationsInput;
			invalid(() => parseSpreadsheetAnnotationsVerifiedDocuments(candidate, () => undefined), 'unsafe');
			strictEqual(graphReads, 0, partId);
		}
	});

	test('parses standard and x14 validation as bounded source-owned semantic records', () => {
		const xml = xmlSet();
		const model = parseSpreadsheetAnnotations(inputFor(xml));

		strictEqual(model.worksheetSource.fingerprint.value, sourceFor(partIds.worksheet, xml.worksheetXml).fingerprint.value, 'BOM-inclusive worksheet identity');
		deepStrictEqual(model.validations.map(validation => ({
			kind: validation.kind, type: validation.type, ranges: validation.ranges.map(range => range.ref),
			formula1: validation.formula1, allowBlank: validation.allowBlank,
		})), [
			{ kind: 'standard', type: 'list', ranges: ['A1:A2'], formula1: '"A,B"', allowBlank: true },
			{ kind: 'x14', type: 'custom', ranges: ['B1'], formula1: 'LEN(B1)>0', allowBlank: false },
		]);
		strictEqual(model.validations[0].promptTitle?.text, ' Pick ');
		strictEqual(model.validations[0].error?.text, 'Choose one');
		strictEqual(model.validations[1].source.fingerprint.value, model.worksheetSource.fingerprint.value);
		strictEqual(model.opaqueFragments.length, 1);
		deepStrictEqual(model.opaqueFragments[0].name, { namespace: x14Namespace, local: 'futureFeature' });
		strictEqual(model.opaqueFragments[0].fingerprint.algorithm, 'sha256');
		strictEqual(model.opaqueFragments[0].source.fingerprint.value, model.worksheetSource.fingerprint.value);
		ok(Object.isFrozen(model));
		ok(Object.isFrozen(model.validations));
	});

	test('keeps legacy note rich-text topology, sanitized UI author identity, and VML anchor provenance', () => {
		const model = parseSpreadsheetAnnotations(inputFor(xmlSet()));
		strictEqual(model.legacyNotes.length, 1);
		const note = model.legacyNotes[0];
		strictEqual(note.ref, 'A1');
		strictEqual(note.author.text, 'Ali�ce');
		strictEqual(note.author.fingerprint.algorithm, 'sha256', 'raw author identity remains hashable after UI sanitization');
		strictEqual(note.content.text, 'Hello note');
		deepStrictEqual(note.content.runs, [
			{ text: 'Hello', properties: { bold: true, color: { kind: 'rgb', rgb: 'FFFF0000' } } },
			{ text: ' note' },
		]);
		deepStrictEqual(note.anchor, {
			shapeId: '_x0000_s1025', shapeNumericId: 1025, row: 0, column: 0,
			leftColumn: 0, leftOffset: 15, topRow: 0, topOffset: 2,
			rightColumn: 3, rightOffset: 31, bottomRow: 4, bottomOffset: 4,
			moveWithCells: true, sizeWithCells: true, source: model.vmlDrawingSource,
		});
		strictEqual(note.source.fingerprint.value, model.commentsSource?.fingerprint.value);
	});

	test('parses threaded roots, replies, resolution, persons, and validates the reply DAG', () => {
		const model = parseSpreadsheetAnnotations(inputFor(xmlSet()));
		deepStrictEqual(model.persons.map(person => [person.id, person.displayName.text, person.source.partId]), [[personId, 'Alice', partIds.persons]]);
		deepStrictEqual(model.threadedComments.map(comment => ({
			id: comment.id, parentId: comment.parentId, depth: comment.depth, ref: comment.ref,
			resolved: comment.resolved, text: comment.content.text, personId: comment.personId,
		})), [
			{ id: rootThreadId, parentId: undefined, depth: 0, ref: 'A1', resolved: true, text: 'Root discussion', personId },
			{ id: replyThreadId, parentId: rootThreadId, depth: 1, ref: 'A1', resolved: false, text: 'Reply', personId },
		]);

		const cycleXml = threadedComments(replyThreadId);
		invalid(() => parseSpreadsheetAnnotations(inputFor(xmlSet({ threadedCommentsXml: cycleXml }))), 'malformed');
		const dangling = threadedComments('{00000000-0000-0000-0000-000000000999}');
		invalid(() => parseSpreadsheetAnnotations(inputFor(xmlSet({ threadedCommentsXml: dangling }))), 'malformed');
	});

	test('keeps hyperlink target and location distinct, redacts target values, and normalizes hashes without a fetch capability', () => {
		const model = parseSpreadsheetAnnotations(inputFor(xmlSet()));
		strictEqual(model.hyperlinks.length, 2);
		deepStrictEqual(model.hyperlinks[0].location, { text: '\'Archive\'!B2', fingerprint: model.hyperlinks[0].location?.fingerprint });
		strictEqual(model.hyperlinks[0].tooltip?.text, 'Open archived cell');
		strictEqual(model.hyperlinks[0].target?.classification, 'safeExternal');
		strictEqual(model.hyperlinks[0].target?.scheme, 'https');
		strictEqual(model.hyperlinks[0].target?.display, 'https://example.com/…');
		strictEqual(model.hyperlinks[0].target?.normalizedTargetHash.algorithm, 'sha256');
		strictEqual(model.hyperlinks[1].target, undefined);
		strictEqual(model.hyperlinks[1].location?.text, 'NamedRange');
		doesNotMatch(JSON.stringify(model), /secret-token|\?q=1/i, 'raw target paths and query strings never cross the semantic/UI boundary');

		const canonical = 'https://example.com/secret-token?q=1';
		const normalized = parseSpreadsheetAnnotations(inputFor(xmlSet({ worksheetXml: worksheet(canonical), worksheetRelationshipsXml: worksheetRelationships(canonical) })));
		strictEqual(model.hyperlinks[0].target?.normalizedTargetHash.value, normalized.hyperlinks[0].target?.normalizedTargetHash.value);
	});

	test('classifies unsafe external schemes without leaking their target and keeps normalized target hashes', () => {
		for (const scheme of ['data', 'javascript', 'file', 'vscode', 'command', 'ftp']) {
			const target = `${scheme}:private/secret-token`;
			const model = parseSpreadsheetAnnotations(inputFor(xmlSet({ worksheetXml: worksheet(target), worksheetRelationshipsXml: worksheetRelationships(target) })));
			strictEqual(model.hyperlinks[0].target?.classification, 'unsafeExternal', scheme);
			strictEqual(model.hyperlinks[0].target?.scheme, scheme, scheme);
			strictEqual(model.hyperlinks[0].target?.display, 'blocked external link', scheme);
			strictEqual(model.hyperlinks[0].target?.normalizedTargetHash.value.length, 64, scheme);
			doesNotMatch(JSON.stringify(model), /private|secret-token/i, scheme);
		}
	});

	test('binds supplemental Parts through relationship target and content-type authority', () => {
		const unicodeIdWorksheet = worksheet().replace('r:id="rLink"', 'r:id="rélation"');
		const unicodeIdRelationships = worksheetRelationships().replace('Id="rLink"', 'Id="rélation"');
		strictEqual(parseSpreadsheetAnnotations(inputFor(xmlSet({ worksheetXml: unicodeIdWorksheet, worksheetRelationshipsXml: unicodeIdRelationships }))).hyperlinks.length, 2);
		const middleDotWorksheet = worksheet().replace('r:id="rLink"', 'r:id="r·id"');
		const middleDotRelationships = worksheetRelationships().replace('Id="rLink"', 'Id="r·id"');
		strictEqual(parseSpreadsheetAnnotations(inputFor(xmlSet({ worksheetXml: middleDotWorksheet, worksheetRelationshipsXml: middleDotRelationships }))).hyperlinks.length, 2);
		const numeralWorksheet = worksheet().replace('r:id="rLink"', 'r:id="Ⅻ"');
		const numeralRelationships = worksheetRelationships().replace('Id="rLink"', 'Id="Ⅻ"');
		strictEqual(parseSpreadsheetAnnotations(inputFor(xmlSet({ worksheetXml: numeralWorksheet, worksheetRelationshipsXml: numeralRelationships }))).hyperlinks.length, 2);

		const wrongRelationship = worksheetRelationships().replace('../comments1.xml', '../comments2.xml');
		invalid(() => parseSpreadsheetAnnotations(inputFor(xmlSet({ worksheetRelationshipsXml: wrongRelationship }))), 'unsafe');

		const wrongType = contentTypes().replace('application/vnd.ms-excel.threadedcomments+xml', 'application/octet-stream');
		invalid(() => parseSpreadsheetAnnotations(inputFor(xmlSet({ contentTypesXml: wrongType }))), 'unsafe');

		const forged = inputFor(xmlSet());
		invalid(() => parseSpreadsheetAnnotations({ ...forged, worksheetSource: { ...forged.worksheetSource, fingerprint: { ...forged.worksheetSource.fingerprint, value: '0'.repeat(64) } } }), 'unsafe');

		const aliasingRelationship = worksheetRelationships().replace('Id="rVml"', 'Id="rComments"');
		invalid(() => parseSpreadsheetAnnotations(inputFor(xmlSet({ worksheetRelationshipsXml: aliasingRelationship }))), 'malformed');

		const drawingHfWorksheet = worksheet().replace('</worksheet>', '<legacyDrawingHF r:id="rVmlHF"/></worksheet>');
		const drawingHfRelationships = worksheetRelationships().replace('</Relationships>', `<Relationship Id="rVmlHF" Type="${relationshipTypes.vml}" Target="../drawings/vmlDrawingHF1.vml"/></Relationships>`);
		strictEqual(parseSpreadsheetAnnotations(inputFor(xmlSet({ worksheetXml: drawingHfWorksheet, worksheetRelationshipsXml: drawingHfRelationships }))).legacyNotes.length, 1);
		const noVmlRelationships = inputFor(xmlSet());
		strictEqual(parseSpreadsheetAnnotations({
			...noVmlRelationships,
			vmlDrawingRelationshipsXml: undefined,
			vmlDrawingRelationshipsSource: undefined,
		}).legacyNotes.length, 1);

		const hfOnlyWorksheet = worksheet().replace('<legacyDrawing r:id="rVml"/>', '<legacyDrawingHF r:id="rVmlHF"/>');
		const hfOnlyRelationships = `<Relationships xmlns="${packageRelationshipNamespace}">
			<Relationship Id="rVmlHF" Type="${relationshipTypes.vml}" Target="../drawings/vmlDrawingHF1.vml"/>
			<Relationship Id="rThreaded" Type="${relationshipTypes.threaded}" Target="../threadedComments/threadedComment1.xml"/>
			<Relationship Id="rLink" Type="${relationshipTypes.hyperlink}" Target="https://example.invalid" TargetMode="External"/>
		</Relationships>`;
		const hfOnly = inputFor(xmlSet({ worksheetXml: hfOnlyWorksheet, worksheetRelationshipsXml: hfOnlyRelationships }));
		strictEqual(parseSpreadsheetAnnotations({
			...hfOnly,
			commentsXml: undefined, commentsSource: undefined,
			vmlDrawingXml: undefined, vmlDrawingSource: undefined,
			vmlDrawingRelationshipsXml: undefined, vmlDrawingRelationshipsSource: undefined,
		}).legacyNotes.length, 0);
	});

	test('scopes opaque relationship canonicalization to the owning Part', () => {
		const withAliasVml = vmlDrawing().replace('<x:ClientData', `<v:imagedata xmlns:r="${officeRelationshipNamespace}" r:id="rAlias"/><x:ClientData`);
		const relsA = worksheetRelationships().replace('</Relationships>', `<Relationship Id="rAlias" Type="${relationshipTypes.hyperlink}" Target="https://example.invalid/a" TargetMode="External"/></Relationships>`);
		const relsB = relsA.replace('https://example.invalid/a', 'https://example.invalid/b');
		const modelA = parseSpreadsheetAnnotations(inputFor(xmlSet({ vmlDrawingXml: withAliasVml, worksheetRelationshipsXml: relsA })));
		const modelB = parseSpreadsheetAnnotations(inputFor(xmlSet({ vmlDrawingXml: withAliasVml, worksheetRelationshipsXml: relsB })));
		strictEqual(
			modelA.opaqueFragments.find(fragment => fragment.name.local === 'imagedata')?.fingerprint.value,
			modelB.opaqueFragments.find(fragment => fragment.name.local === 'imagedata')?.fingerprint.value,
		);
		const vmlRelsA = vmlDrawingRelationships(`<Relationship Id="rAlias" Type="${officeRelationshipNamespace}/image" Target="image1.png"/>`);
		const renamedVml = withAliasVml.replace('r:id="rAlias"', 'r:id="rAlias2"');
		const vmlRelsB = vmlDrawingRelationships(`<Relationship Id="rAlias2" Type="${officeRelationshipNamespace}/image" Target="image1.png"/>`);
		const canonicalA = parseSpreadsheetAnnotations(inputFor(xmlSet({ vmlDrawingXml: withAliasVml, vmlDrawingRelationshipsXml: vmlRelsA })));
		const canonicalB = parseSpreadsheetAnnotations(inputFor(xmlSet({ vmlDrawingXml: renamedVml, vmlDrawingRelationshipsXml: vmlRelsB })));
		strictEqual(
			canonicalA.opaqueFragments.find(fragment => fragment.name.local === 'imagedata')?.fingerprint.value,
			canonicalB.opaqueFragments.find(fragment => fragment.name.local === 'imagedata')?.fingerprint.value,
		);
	});

	test('requires the known x14 validation extension and selects Markup Compatibility branches', () => {
		const wrongUri = worksheet().replace('{CCE6A557-97BC-4B89-ADB6-D9C93CAAB3DF}', '{00000000-0000-0000-0000-000000000999}');
		const wrongModel = parseSpreadsheetAnnotations(inputFor(xmlSet({ worksheetXml: wrongUri })));
		strictEqual(wrongModel.validations.length, 1);
		ok(wrongModel.opaqueFragments.some(fragment => fragment.name.local === 'ext'));

		const base = worksheet();
		const extension = /<extLst>.*<\/extLst>/.exec(base)?.[0];
		ok(extension);
		const alternate = `<mc:AlternateContent xmlns:mc="http://schemas.openxmlformats.org/markup-compatibility/2006"><mc:Choice Requires="x14">${extension}</mc:Choice><mc:Fallback><extLst/></mc:Fallback></mc:AlternateContent>`;
		const alternateModel = parseSpreadsheetAnnotations(inputFor(xmlSet({ worksheetXml: base.replace(extension, alternate) })));
		strictEqual(alternateModel.validations.length, 2);
		ok(alternateModel.opaqueFragments.some(fragment => fragment.name.local === 'Fallback'));
		const fallbackOnly = `<mc:AlternateContent xmlns:mc="http://schemas.openxmlformats.org/markup-compatibility/2006"><mc:Fallback>${extension}</mc:Fallback></mc:AlternateContent>`;
		invalid(() => parseSpreadsheetAnnotations(inputFor(xmlSet({ worksheetXml: base.replace(extension, fallbackOnly) }))), 'malformed');
		const fallbackFirst = `<mc:AlternateContent xmlns:mc="http://schemas.openxmlformats.org/markup-compatibility/2006"><mc:Fallback><extLst/></mc:Fallback><mc:Choice Requires="x14">${extension}</mc:Choice></mc:AlternateContent>`;
		invalid(() => parseSpreadsheetAnnotations(inputFor(xmlSet({ worksheetXml: base.replace(extension, fallbackFirst) }))), 'malformed');
	});

	test('rejects typed-array proxies before any trap can observe or mutate byte ownership', () => {
		const input = inputFor(xmlSet());
		let reads = 0;
		const bytes = new Proxy(new TextEncoder().encode(input.worksheetXml), {
			get(target, property) { reads++; return Reflect.get(target, property, target); },
		});
		invalid(() => parseSpreadsheetAnnotations({ ...input, worksheetBytes: bytes }), 'unsafe');
		strictEqual(reads, 0);
	});

	test('uses the stable fixed-byte contract for fingerprint, raw, and verified ownership', () => {
		const xml = xmlSet();
		const raw = inputFor(xml);
		const verified = verifiedInputFor(xml);
		const worksheetBytes = new TextEncoder().encode(xml.worksheetXml);
		const candidates: Uint8Array[] = [];

		if (typeof SharedArrayBuffer !== 'undefined') {
			const shared = new Uint8Array(new SharedArrayBuffer(worksheetBytes.byteLength));
			shared.set(worksheetBytes); candidates.push(shared);
		}
		if (typeof ArrayBuffer.prototype.resize === 'function') {
			const buffer = new ArrayBuffer(worksheetBytes.byteLength, { maxByteLength: worksheetBytes.byteLength + 1024 });
			const resizable = new Uint8Array(buffer); resizable.set(worksheetBytes); candidates.push(resizable);
		}
		const detachedBuffer = worksheetBytes.slice().buffer;
		const detached = new Uint8Array(detachedBuffer);
		structuredClone(detachedBuffer, { transfer: [detachedBuffer] });
		candidates.push(detached);
		class SubclassedBytes extends Uint8Array { }
		candidates.push(new SubclassedBytes(worksheetBytes));

		let programmableReads = 0;
		const programmable = worksheetBytes.slice();
		Object.defineProperty(programmable, 'byteLength', { get: () => { programmableReads++; return worksheetBytes.byteLength; } });
		candidates.push(programmable);
		const programmableBuffer = worksheetBytes.slice();
		Object.defineProperty(programmableBuffer.buffer, 'constructor', { get: () => { programmableReads++; return ArrayBuffer; } });
		candidates.push(programmableBuffer);
		let proxyReads = 0;
		candidates.push(new Proxy(worksheetBytes.slice(), {
			get(target, property) { proxyReads++; return Reflect.get(target, property, target); },
		}));

		for (const bytes of candidates) {
			invalid(() => fingerprintSpreadsheetAnnotationsBytes(bytes), 'unsafe');
			invalid(() => parseSpreadsheetAnnotations({ ...raw, worksheetBytes: bytes }), 'unsafe');
			invalid(() => parseSpreadsheetAnnotationsVerifiedDocuments({ ...verified, worksheetBytes: bytes }, () => undefined), 'unsafe');
		}
		strictEqual(programmableReads, 0);
		strictEqual(proxyReads, 0);

		const fixed = worksheetBytes.slice();
		const expected = fingerprintSpreadsheetAnnotationsBytes(fixed);
		strictEqual(parseSpreadsheetAnnotations({ ...raw, worksheetBytes: fixed }).worksheetSource.fingerprint.value, expected.value);
		strictEqual(parseSpreadsheetAnnotationsVerifiedDocuments({ ...verified, worksheetBytes: fixed }, () => undefined).worksheetSource.fingerprint.value, expected.value);

		let clock = 0;
		invalid(() => parseSpreadsheetAnnotations({ ...raw, worksheetBytes: fixed }, { now: () => clock++, deadlineMilliseconds: 1 }), 'limitExceeded');
	});

	test('rejects invalid refs, Unicode controls, reply cycles, hostile input accessors, cancellation, and deadlines', () => {
		const badRef = comments().replace('ref="A1"', 'ref="XFE1"');
		invalid(() => parseSpreadsheetAnnotations(inputFor(xmlSet({ commentsXml: badRef }))), 'malformed');
		const badAnchor = vmlDrawing().replace('<x:Row>0</x:Row>', '<x:Row>1048576</x:Row>');
		invalid(() => parseSpreadsheetAnnotations(inputFor(xmlSet({ vmlDrawingXml: badAnchor }))), 'malformed');
		const poisonedName = persons('Alice&#1;');
		invalid(() => parseSpreadsheetAnnotations(inputFor(xmlSet({ personsXml: poisonedName }))), 'malformed');
		invalid(() => parseSpreadsheetAnnotations(new Proxy({}, { getOwnPropertyDescriptor: () => { throw new Error('secret'); } }) as never), 'unsafe');
		invalid(() => parseSpreadsheetAnnotations(Object.defineProperty({}, 'worksheetXml', { get: () => worksheet() }) as never), 'unsafe');
		invalid(() => parseSpreadsheetAnnotations(inputFor(xmlSet()), { cancellationToken: CancellationToken.Cancelled }), 'cancelled');

		let clock = 0;
		invalid(() => parseSpreadsheetAnnotations(inputFor(xmlSet()), { now: () => clock++, deadlineMilliseconds: 1 }), 'limitExceeded');
		invalid(() => parseSpreadsheetAnnotations(inputFor(xmlSet()), { limits: { comments: 1, textCharacters: 3 } }), 'limitExceeded');
	});

	test('accepts already raw-byte-verified documents, owns their topology, and preserves opaque fragment identity', () => {
		const xml = xmlSet();
		const parse = (value: string) => parseParadisOfficeXml(value.startsWith('\uFEFF') ? value.slice(1) : value, { depth: 96, nodes: 10_000, attributeLength: 64 * 1024, characters: 1024 * 1024 });
		const input = inputFor(xml);
		const bytes = (value: string) => new TextEncoder().encode(value);
		const worksheetDocument = parse(xml.worksheetXml);
		let checkpoints = 0;
		const model = parseSpreadsheetAnnotationsVerifiedDocuments({
			contentTypesDocument: parse(xml.contentTypesXml), contentTypesBytes: bytes(xml.contentTypesXml), contentTypesSource: input.contentTypesSource,
			rootRelationshipsDocument: parse(xml.rootRelationshipsXml), rootRelationshipsBytes: bytes(xml.rootRelationshipsXml), rootRelationshipsSource: input.rootRelationshipsSource,
			workbookDocument: parse(xml.workbookXml), workbookBytes: bytes(xml.workbookXml), workbookSource: input.workbookSource,
			worksheetDocument, worksheetBytes: bytes(xml.worksheetXml), worksheetSource: input.worksheetSource,
			worksheetRelationshipsDocument: parse(xml.worksheetRelationshipsXml), worksheetRelationshipsBytes: bytes(xml.worksheetRelationshipsXml), worksheetRelationshipsSource: input.worksheetRelationshipsSource,
			workbookRelationshipsDocument: parse(xml.workbookRelationshipsXml), workbookRelationshipsBytes: bytes(xml.workbookRelationshipsXml), workbookRelationshipsSource: input.workbookRelationshipsSource,
			commentsDocument: parse(xml.commentsXml), commentsBytes: bytes(xml.commentsXml), commentsSource: input.commentsSource,
			vmlDrawingDocument: parse(xml.vmlDrawingXml), vmlDrawingBytes: bytes(xml.vmlDrawingXml), vmlDrawingSource: input.vmlDrawingSource,
			vmlDrawingRelationshipsDocument: parse(xml.vmlDrawingRelationshipsXml), vmlDrawingRelationshipsBytes: bytes(xml.vmlDrawingRelationshipsXml), vmlDrawingRelationshipsSource: input.vmlDrawingRelationshipsSource,
			threadedCommentsDocument: parse(xml.threadedCommentsXml), threadedCommentsBytes: bytes(xml.threadedCommentsXml), threadedCommentsSource: input.threadedCommentsSource,
			personsDocument: parse(xml.personsXml), personsBytes: bytes(xml.personsXml), personsSource: input.personsSource,
		}, () => { checkpoints++; });
		ok(checkpoints > 0);
		strictEqual(model.validations.length, 2);
		strictEqual(model.opaqueFragments[0].fingerprint.value.length, 64);
		(worksheetDocument.root.children as unknown[]).length = 0;
		strictEqual(model.validations.length, 2, 'returned ownership is detached from verified input documents');
	});

	test('binds verified graphs to copied raw bytes before any upstream callback and aggregates verified graph limits', () => {
		const xml = xmlSet();
		const parse = (value: string) => parseParadisOfficeXml(value.startsWith('\uFEFF') ? value.slice(1) : value, { depth: 96, nodes: 10_000, attributeLength: 64 * 1024, characters: 1024 * 1024 });
		const raw = inputFor(xml);
		const worksheetDocument = parse(xml.worksheetXml);
		const bytes = (value: string) => new TextEncoder().encode(value);
		const verified = {
			contentTypesDocument: parse(xml.contentTypesXml), contentTypesBytes: bytes(xml.contentTypesXml), contentTypesSource: raw.contentTypesSource,
			rootRelationshipsDocument: parse(xml.rootRelationshipsXml), rootRelationshipsBytes: bytes(xml.rootRelationshipsXml), rootRelationshipsSource: raw.rootRelationshipsSource,
			workbookDocument: parse(xml.workbookXml), workbookBytes: bytes(xml.workbookXml), workbookSource: raw.workbookSource,
			worksheetDocument, worksheetBytes: bytes(xml.worksheetXml), worksheetSource: raw.worksheetSource,
			worksheetRelationshipsDocument: parse(xml.worksheetRelationshipsXml), worksheetRelationshipsBytes: bytes(xml.worksheetRelationshipsXml), worksheetRelationshipsSource: raw.worksheetRelationshipsSource,
			workbookRelationshipsDocument: parse(xml.workbookRelationshipsXml), workbookRelationshipsBytes: bytes(xml.workbookRelationshipsXml), workbookRelationshipsSource: raw.workbookRelationshipsSource,
			commentsDocument: parse(xml.commentsXml), commentsBytes: bytes(xml.commentsXml), commentsSource: raw.commentsSource,
			vmlDrawingDocument: parse(xml.vmlDrawingXml), vmlDrawingBytes: bytes(xml.vmlDrawingXml), vmlDrawingSource: raw.vmlDrawingSource,
			vmlDrawingRelationshipsDocument: parse(xml.vmlDrawingRelationshipsXml), vmlDrawingRelationshipsBytes: bytes(xml.vmlDrawingRelationshipsXml), vmlDrawingRelationshipsSource: raw.vmlDrawingRelationshipsSource,
			threadedCommentsDocument: parse(xml.threadedCommentsXml), threadedCommentsBytes: bytes(xml.threadedCommentsXml), threadedCommentsSource: raw.threadedCommentsSource,
			personsDocument: parse(xml.personsXml), personsBytes: bytes(xml.personsXml), personsSource: raw.personsSource,
		};
		let first = true;
		const protectedModel = parseSpreadsheetAnnotationsVerifiedDocuments(verified, () => {
			if (!first) { return; }
			first = false;
			const validation = (worksheetDocument.root.children as unknown as Array<{ readonly kind: string; readonly children?: unknown[] }>).find(node => node.kind === 'element' && (node as { readonly local?: string }).local === 'dataValidations');
			const sqref = (validation?.children as Array<{ readonly attributes?: Array<{ readonly local: string; value: string }> }>)[0].attributes?.find(attribute => attribute.local === 'sqref');
			ok(sqref); sqref.value = 'C3';
		});
		deepStrictEqual(protectedModel.validations[0].ranges.map(range => range.ref), ['A1:A2']);

		const untouched = { ...verified, worksheetDocument: parse(xml.worksheetXml) };
		invalid(() => parseSpreadsheetAnnotationsVerifiedDocuments(untouched, () => undefined, { limits: { xmlNodes: 10 } }), 'limitExceeded');
	});

	test('supports explicit security profiles, Strict relationships, relocated workbook rels, and explicit Internal targets', () => {
		strictEqual(parseSpreadsheetAnnotations(inputFor(xmlSet()), { profile: 'desktop', limits: { xmlDepth: 97 } }).validations.length, 2);
		invalid(() => parseSpreadsheetAnnotations(inputFor(xmlSet()), { limits: { xmlDepth: 97 } }), 'limitExceeded');
		invalid(() => parseSpreadsheetAnnotations(inputFor(xmlSet()), { profile: 'browser', deadlineMilliseconds: 45_001 }), 'limitExceeded');
		const strictOfficeRelationships = 'http://purl.oclc.org/ooxml/officeDocument/relationships';
		const strictWorksheet = worksheet().replaceAll(spreadsheetNamespace, 'http://purl.oclc.org/ooxml/spreadsheetml/main').replaceAll(officeRelationshipNamespace, strictOfficeRelationships);
		const strictWorksheetRels = worksheetRelationships().replaceAll(officeRelationshipNamespace, strictOfficeRelationships).replace('Target="../comments1.xml"', 'Target="../comments1.xml" TargetMode="Internal"');
		const strictWorkbookRels = workbookRelationships().replaceAll('http://schemas.microsoft.com/office/2017/10/relationships/person', 'http://purl.oclc.org/ooxml/officeDocument/relationships/person');
		const strictModel = parseSpreadsheetAnnotations(inputFor(xmlSet({ worksheetXml: strictWorksheet, worksheetRelationshipsXml: strictWorksheetRels, workbookRelationshipsXml: strictWorkbookRels })));
		strictEqual(strictModel.hyperlinks[0].target?.classification, 'safeExternal');

		const relocatedWorkbookPart = '/book/main.xml';
		const relocatedWorkbookRels = `<Relationships xmlns="${packageRelationshipNamespace}"><Relationship Id="rSheet1" Type="${relationshipTypes.worksheet}" Target="../xl/worksheets/sheet1.xml"/><Relationship Id="rPersons" Type="${relationshipTypes.person}" Target="../xl/persons/person.xml"/></Relationships>`;
		const relocatedContentTypes = contentTypes().replace(`PartName="${partIds.workbook}"`, `PartName="${relocatedWorkbookPart}"`);
		const relocated = inputFor(xmlSet({
			contentTypesXml: relocatedContentTypes, rootRelationshipsXml: rootRelationships('book/main.xml'), workbookRelationshipsXml: relocatedWorkbookRels,
		}));
		const relocatedXml = relocated.workbookRelationshipsXml!;
		strictEqual(parseSpreadsheetAnnotations({
			...relocated, workbookSource: sourceFor(relocatedWorkbookPart, relocated.workbookXml),
			workbookRelationshipsSource: sourceFor('/book/_rels/main.xml.rels', relocatedXml),
		}).persons.length, 1);
		invalid(() => parseSpreadsheetAnnotations({ ...relocated, workbookRelationshipsSource: sourceFor('/unrelated/_rels/fake.xml.rels', relocatedXml) }), 'unsafe');
		const graftedWorksheetPart = '/xl/worksheets/grafted.xml';
		const graftedTypes = contentTypes().replace(`PartName="${partIds.worksheet}"`, `PartName="${graftedWorksheetPart}"`);
		const grafted = inputFor(xmlSet({ contentTypesXml: graftedTypes }));
		invalid(() => parseSpreadsheetAnnotations({
			...grafted, worksheetSource: sourceFor(graftedWorksheetPart, grafted.worksheetXml),
			worksheetRelationshipsSource: sourceFor('/xl/worksheets/_rels/grafted.xml.rels', grafted.worksheetRelationshipsXml),
		}), 'unsafe');

		const hostileThreadedType = worksheetRelationships().replace(relationshipTypes.threaded, 'https://attacker.invalid/threadedComment');
		invalid(() => parseSpreadsheetAnnotations(inputFor(xmlSet({ worksheetRelationshipsXml: hostileThreadedType }))), 'unsafe');

		const chartWorkbook = workbook().replace('</sheets>', '<sheet name="Chart" sheetId="2" r:id="rChart1"/></sheets>');
		const chartRelationships = workbookRelationships().replace('</Relationships>', `<Relationship Id="rChart1" Type="${officeRelationshipNamespace}/chartsheet" Target="chartsheets/sheet1.xml"/></Relationships>`);
		strictEqual(parseSpreadsheetAnnotations(inputFor(xmlSet({ workbookXml: chartWorkbook, workbookRelationshipsXml: chartRelationships }))).validations.length, 2);
		const macroWorkbook = workbook().replace('</sheets>', '<sheet name="Macro" sheetId="2" r:id="rMacro1"/></sheets>');
		for (const kind of ['xlMacrosheet', 'xlIntlMacrosheet']) {
			const macroRelationships = workbookRelationships().replace('</Relationships>', `<Relationship Id="rMacro1" Type="http://schemas.microsoft.com/office/2006/relationships/${kind}" Target="macrosheets/sheet1.xml"/></Relationships>`);
			strictEqual(parseSpreadsheetAnnotations(inputFor(xmlSet({ workbookXml: macroWorkbook, workbookRelationshipsXml: macroRelationships }))).validations.length, 2);
		}
	});

	test('accepts canonical percent-encoded OPC part names but rejects encoded traversal separators', () => {
		const commentsPart = '/xl/comments 1.xml';
		const encodedTypes = contentTypes().replace(`PartName="${partIds.comments}"`, 'PartName="/xl/comments%201.xml"');
		const encodedRelationships = worksheetRelationships().replace('../comments1.xml', '../comments%201.xml');
		const input = inputFor(xmlSet({ contentTypesXml: encodedTypes, worksheetRelationshipsXml: encodedRelationships }));
		strictEqual(parseSpreadsheetAnnotations({ ...input, commentsSource: sourceFor(commentsPart, input.commentsXml!) }).legacyNotes.length, 1);

		const traversal = worksheetRelationships().replace('../comments1.xml', '..%2Fcomments1.xml');
		invalid(() => parseSpreadsheetAnnotations(inputFor(xmlSet({ worksheetRelationshipsXml: traversal }))), 'unsafe');
		const control = worksheetRelationships().replace('../comments1.xml', '../comments%0A1.xml');
		invalid(() => parseSpreadsheetAnnotations(inputFor(xmlSet({ worksheetRelationshipsXml: control }))), 'unsafe');
		const bidiPart = '/xl/comments\u202E1.xml';
		const bidiTypes = contentTypes().replace(`PartName="${partIds.comments}"`, `PartName="${bidiPart}"`);
		const bidiRelationships = worksheetRelationships().replace('../comments1.xml', '../comments\u202E1.xml');
		const bidiInput = inputFor(xmlSet({ contentTypesXml: bidiTypes, worksheetRelationshipsXml: bidiRelationships }));
		invalid(() => parseSpreadsheetAnnotations({ ...bidiInput, commentsSource: sourceFor(bidiPart, bidiInput.commentsXml!) }), 'unsafe');
	});

	test('accepts x14 revision uid and retains unknown annotation topology with stable canonical identity', () => {
		const revisionNamespace = 'http://schemas.microsoft.com/office/spreadsheetml/2014/revision';
		const withUid = worksheet().replace('<x14:dataValidation type="custom"', `<x14:dataValidation xmlns:xr="${revisionNamespace}" xr:uid="{00000000-0000-0000-0000-000000000001}" type="custom"`);
		strictEqual(parseSpreadsheetAnnotations(inputFor(xmlSet({ worksheetXml: withUid }))).validations.length, 2);

		const falseVml = vmlDrawing().replace('<x:Row>0</x:Row>', '<x:AutoFill>False</x:AutoFill><x:Row>0</x:Row>');
		const trueVml = falseVml.replace('>False<', '>True<');
		const falseModel = parseSpreadsheetAnnotations(inputFor(xmlSet({ vmlDrawingXml: falseVml })));
		const trueModel = parseSpreadsheetAnnotations(inputFor(xmlSet({ vmlDrawingXml: trueVml })));
		ok(falseModel.opaqueFragments.some(fragment => fragment.name.local === 'AutoFill'));
		ok(falseModel.opaqueFragments.every(fragment => fragment.path.startsWith('/') && fragment.ordinal >= 0));
		strictEqual(falseModel.opaqueFragments.length, trueModel.opaqueFragments.length);
		ok(falseModel.opaqueFragments.some((fragment, index) => fragment.fingerprint.value !== trueModel.opaqueFragments[index].fingerprint.value));
		const unrelatedWorksheet = worksheet().replace('<x14:dataValidations', '<x14:unrelated/><x14:dataValidations');
		const unrelatedModel = parseSpreadsheetAnnotations(inputFor(xmlSet({ worksheetXml: unrelatedWorksheet, vmlDrawingXml: falseVml })));
		strictEqual(
			falseModel.opaqueFragments.find(fragment => fragment.name.local === 'AutoFill')?.path,
			unrelatedModel.opaqueFragments.find(fragment => fragment.name.local === 'AutoFill')?.path,
			'opaque paths are Part-local XML paths, not global output ordinals',
		);

		const indentedComments = comments().replace('</r><r>', '</r>\n        <r>');
		const compactModel = parseSpreadsheetAnnotations(inputFor(xmlSet()));
		const indentedModel = parseSpreadsheetAnnotations(inputFor(xmlSet({ commentsXml: indentedComments })));
		strictEqual(compactModel.legacyNotes[0].content.fingerprint.value, indentedModel.legacyNotes[0].content.fingerprint.value);
		const preserved = '<x14:futureFeature xml:space="preserve"><x14:inner xml:space="default"><x14:value/></x14:inner></x14:futureFeature>';
		const resetIndented = '<x14:futureFeature xml:space="preserve"><x14:inner xml:space="default">\n  <x14:value/>\n</x14:inner></x14:futureFeature>';
		const preservedModel = parseSpreadsheetAnnotations(inputFor(xmlSet({ worksheetXml: worksheet().replace(/<x14:futureFeature[^>]*>.*?<\/x14:futureFeature>/, preserved) })));
		const resetModel = parseSpreadsheetAnnotations(inputFor(xmlSet({ worksheetXml: worksheet().replace(/<x14:futureFeature[^>]*>.*?<\/x14:futureFeature>/, resetIndented) })));
		strictEqual(preservedModel.opaqueFragments[0].fingerprint.value, resetModel.opaqueFragments[0].fingerprint.value);
	});

	test('enforces VML anchor units and ordering', () => {
		const invalidXOffset = vmlDrawing().replace('0, 15, 0, 2, 3, 31, 4, 4', '0, 1024, 0, 2, 3, 31, 4, 4');
		invalid(() => parseSpreadsheetAnnotations(inputFor(xmlSet({ vmlDrawingXml: invalidXOffset }))), 'malformed');
		const invalidYOffset = vmlDrawing().replace('0, 15, 0, 2, 3, 31, 4, 4', '0, 15, 0, 256, 3, 31, 4, 4');
		invalid(() => parseSpreadsheetAnnotations(inputFor(xmlSet({ vmlDrawingXml: invalidYOffset }))), 'malformed');
		const reversed = vmlDrawing().replace('0, 15, 0, 2, 3, 31, 4, 4', '0, 900, 0, 200, 0, 100, 0, 50');
		invalid(() => parseSpreadsheetAnnotations(inputFor(xmlSet({ vmlDrawingXml: reversed }))), 'malformed');
	});

	test('validates URL authority and canonicalizes encoded dot segments without exposing target bytes', () => {
		const markupHost = 'https://<svg>/private';
		const blocked = parseSpreadsheetAnnotations(inputFor(xmlSet({ worksheetXml: worksheet(markupHost), worksheetRelationshipsXml: worksheetRelationships(markupHost) })));
		strictEqual(blocked.hyperlinks[0].target?.classification, 'unsafeExternal');
		strictEqual(blocked.hyperlinks[0].target?.display, 'blocked external link');
		doesNotMatch(JSON.stringify(blocked), /svg|private/i);

		const encoded = 'https://example.com/a/%2E%2E/secret';
		const canonical = 'https://example.com/secret';
		const encodedModel = parseSpreadsheetAnnotations(inputFor(xmlSet({ worksheetXml: worksheet(encoded), worksheetRelationshipsXml: worksheetRelationships(encoded) })));
		const canonicalModel = parseSpreadsheetAnnotations(inputFor(xmlSet({ worksheetXml: worksheet(canonical), worksheetRelationshipsXml: worksheetRelationships(canonical) })));
		strictEqual(encodedModel.hyperlinks[0].target?.normalizedTargetHash.value, canonicalModel.hyperlinks[0].target?.normalizedTargetHash.value);

		const idn = 'https://例え.テスト/path';
		const idnModel = parseSpreadsheetAnnotations(inputFor(xmlSet({ worksheetXml: worksheet(idn), worksheetRelationshipsXml: worksheetRelationships(idn) })));
		strictEqual(idnModel.hyperlinks[0].target?.classification, 'safeExternal');
		doesNotMatch(idnModel.hyperlinks[0].target?.display ?? '', /例え|テスト/);
		const invalidIpv6 = 'https://[::::]/path';
		const invalidIpv6Model = parseSpreadsheetAnnotations(inputFor(xmlSet({ worksheetXml: worksheet(invalidIpv6), worksheetRelationshipsXml: worksheetRelationships(invalidIpv6) })));
		strictEqual(invalidIpv6Model.hyperlinks[0].target?.classification, 'unsafeExternal');
	});

	test('accepts cell and range hyperlink locations as internal anchors', () => {
		const rangeLocation = worksheet().replace('location="NamedRange"', 'location="A1:B2"');
		const model = parseSpreadsheetAnnotations(inputFor(xmlSet({ worksheetXml: rangeLocation })));
		strictEqual(model.hyperlinks[1].location?.text, 'A1:B2');
	});

	test('normalizes mailto and blocked target identities without revealing them', () => {
		const pairs = [
			['mailto:%61lice@EXAMPLE.invalid', 'mailto:alice@example.invalid'],
			['FILE:///tmp/%73ecret', 'file:///tmp/secret'],
			['file:///tmp/a/../secret', 'file:///tmp/secret'],
			['mailto:alice@例え.テスト', 'mailto:alice@xn--r8jz45g.xn--zckzah'],
		] as const;
		for (const [left, right] of pairs) {
			const leftModel = parseSpreadsheetAnnotations(inputFor(xmlSet({ worksheetXml: worksheet(left), worksheetRelationshipsXml: worksheetRelationships(left) })));
			const rightModel = parseSpreadsheetAnnotations(inputFor(xmlSet({ worksheetXml: worksheet(right), worksheetRelationshipsXml: worksheetRelationships(right) })));
			strictEqual(leftModel.hyperlinks[0].target?.normalizedTargetHash.value, rightModel.hyperlinks[0].target?.normalizedTargetHash.value);
		}
		for (const malformed of ['mailto:alice@example.invalid:25', 'mailto:alice@example.invalid/path']) {
			const model = parseSpreadsheetAnnotations(inputFor(xmlSet({ worksheetXml: worksheet(malformed), worksheetRelationshipsXml: worksheetRelationships(malformed) })));
			strictEqual(model.hyperlinks[0].target?.classification, 'unsafeExternal');
		}
	});

	test('indexes validation and range hyperlink overlays without expanding ranges', () => {
		const rangeWorksheet = worksheet().replace('ref="A1" r:id="rLink"', 'ref="A1:B2" r:id="rLink"');
		const model = parseSpreadsheetAnnotations(inputFor(xmlSet({ worksheetXml: rangeWorksheet })));
		deepStrictEqual(model.rangeOverlays.map(overlay => ({
			ranges: overlay.ranges.map(range => range.ref), validationIds: overlay.validationIds, hyperlinkIds: overlay.hyperlinkIds,
		})), [
			{ ranges: ['A1:A2'], validationIds: ['validation:standard:0'], hyperlinkIds: undefined },
			{ ranges: ['B1'], validationIds: ['validation:x14:1'], hyperlinkIds: undefined },
			{ ranges: ['A1:B2'], validationIds: undefined, hyperlinkIds: ['hyperlink:A1:B2:0'] },
		]);
		strictEqual(model.cellOverlays.some(overlay => overlay.ref.includes(':')), false);
	});

	test('accepts raw non-UTF8 Part bytes while preserving decoded semantics', () => {
		const decodedWorksheet = worksheet().slice(1);
		const utf16 = new Uint8Array(2 + decodedWorksheet.length * 2);
		utf16[0] = 0xff; utf16[1] = 0xfe;
		for (let index = 0; index < decodedWorksheet.length; index++) {
			const code = decodedWorksheet.charCodeAt(index);
			utf16[2 + index * 2] = code & 0xff;
			utf16[3 + index * 2] = code >>> 8;
		}
		const input = inputFor(xmlSet({ worksheetXml: decodedWorksheet }));
		const model = parseSpreadsheetAnnotations({ ...input, worksheetBytes: utf16, worksheetSource: sourceForBytes(partIds.worksheet, utf16) });
		strictEqual(model.validations.length, 2);
		strictEqual(model.worksheetSource.fingerprint.value, sourceForBytes(partIds.worksheet, utf16).fingerprint.value);
		const mismatchedXml = decodedWorksheet.replace('sqref="A1:A2"', 'sqref="C3"');
		invalid(() => parseSpreadsheetAnnotations({ ...input, worksheetXml: mismatchedXml, worksheetBytes: utf16, worksheetSource: sourceForBytes(partIds.worksheet, utf16) }), 'unsafe');

		const multibyteWorksheet = decodedWorksheet.replace('<sheetData/>', `<sheetData/><future>${'ࠀ'.repeat(1000)}</future>`);
		const multibyteInput = inputFor(xmlSet({ worksheetXml: multibyteWorksheet }));
		invalid(() => parseSpreadsheetAnnotations(multibyteInput, { limits: { xmlCharacters: 4096 } }), 'limitExceeded');
	});

	test('accepts empty legacy notes and timezone-offset threaded timestamps', () => {
		const emptyComments = comments().replace('<text><r><rPr><b/><color rgb="FFFF0000"/></rPr><t>Hello</t></r><r><t xml:space="preserve"> note</t></r></text>', '<text/>');
		const offsetThreaded = threadedComments().replace('2026-08-24T10:00:00Z', '2026-08-24T19:00:00+09:00');
		const model = parseSpreadsheetAnnotations(inputFor(xmlSet({ commentsXml: emptyComments, threadedCommentsXml: offsetThreaded })));
		strictEqual(model.legacyNotes[0].content.text, '');
		strictEqual(model.threadedComments[0].dateTime, '2026-08-24T19:00:00+09:00');
		const invalidThreaded = threadedComments().replace('2026-08-24T10:00:00Z', '2026-13-40T25:61:61+99:99');
		invalid(() => parseSpreadsheetAnnotations(inputFor(xmlSet({ threadedCommentsXml: invalidThreaded }))), 'malformed');
		const mixedPlainFirst = comments().replace('<r><rPr><b/><color rgb="FFFF0000"/></rPr><t>Hello</t></r><r><t xml:space="preserve"> note</t></r>', '<t>plain</t><r><t>rich</t></r>');
		invalid(() => parseSpreadsheetAnnotations(inputFor(xmlSet({ commentsXml: mixedPlainFirst }))), 'malformed');
		const mixedRichFirst = comments().replace('<r><rPr><b/><color rgb="FFFF0000"/></rPr><t>Hello</t></r><r><t xml:space="preserve"> note</t></r>', '<r><t>rich</t></r><t>plain</t>');
		invalid(() => parseSpreadsheetAnnotations(inputFor(xmlSet({ commentsXml: mixedRichFirst }))), 'malformed');
	});

	test('keeps annotation and hyperlink overlays separate from immutable diagonal base-style provenance', () => {
		const styleSource: ParadisSpreadsheetPartSource = {
			partId: '/xl/styles.xml', fingerprint: { algorithm: 'sha256', value: 'a'.repeat(64), byteLength: 2048 },
		};
		const baseCell: ParadisSemanticCell = Object.freeze({
			storedType: 'string', rawType: 'str', rawValue: { present: true, text: 'linked' }, text: 'linked',
			styleRef: 7, effectiveStyleRef: 7, effectiveStyleOrigin: 'cell', styleSource,
		});
		const before = JSON.stringify(baseCell);
		const model = parseSpreadsheetAnnotations(inputFor(xmlSet()));
		const cells = new Map<string, ParadisSemanticCell>([['A1', baseCell]]);
		const bound = bindSpreadsheetAnnotationOverlays(model, cells);
		const overlay = model.cellOverlays.find(candidate => candidate.ref === 'A1');

		deepStrictEqual(bound, [overlay]);
		deepStrictEqual(overlay, {
			ref: 'A1', legacyNoteIds: [model.legacyNotes[0].id], threadedCommentIds: [rootThreadId, replyThreadId], hyperlinkIds: [model.hyperlinks[0].id],
		});
		strictEqual(JSON.stringify(baseCell), before);
		strictEqual(baseCell.styleRef, 7);
		strictEqual(baseCell.effectiveStyleRef, 7);
		strictEqual(baseCell.styleSource, styleSource);
		doesNotMatch(JSON.stringify(model.cellOverlays), /style|border|diagonal/i, 'overlays cannot replace base diagonal/style identity');
	});
});
