/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import { deepStrictEqual, doesNotMatch, notStrictEqual, strictEqual, throws } from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { ParadisOfficePackageError } from '../../common/office/paradisOfficeArchive.js';
import {
	fingerprintParadisWordObjectBytes,
	parseParadisWordObjects,
	type ParadisWordObjectPartInput,
} from '../../common/word/paradisWordObjects.js';
import { parseParadisWordFields } from '../../common/word/paradisWordFields.js';

const word = 'http://schemas.openxmlformats.org/wordprocessingml/2006/main';
const relationships = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';
const packageRelationships = 'http://schemas.openxmlformats.org/package/2006/relationships';
const wordDrawing = 'http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing';
const drawing = 'http://schemas.openxmlformats.org/drawingml/2006/main';
const picture = 'http://schemas.openxmlformats.org/drawingml/2006/picture';
const wordShape = 'http://schemas.microsoft.com/office/word/2010/wordprocessingShape';
const math = 'http://schemas.openxmlformats.org/officeDocument/2006/math';

function utf8(value: string): Uint8Array {
	return new TextEncoder().encode(value);
}

function part(partUri: string, value: string | Uint8Array, contentType?: string): ParadisWordObjectPartInput {
	const bytes = typeof value === 'string' ? utf8(value) : value;
	return {
		bytes,
		source: { partUri, partFingerprint: fingerprintParadisWordObjectBytes(bytes) },
		...(contentType ? { contentType } : {}),
	};
}

function relationshipPart(entries: string): ParadisWordObjectPartInput {
	return part('/word/_rels/document.xml.rels', `<Relationships xmlns="${packageRelationships}">${entries}</Relationships>`, 'application/vnd.openxmlformats-package.relationships+xml');
}

function pictureXml(overrides: { readonly extent?: string; readonly crop?: string; readonly rotation?: string; readonly effect?: string; readonly description?: string; readonly relationshipAttribute?: string; readonly wrap?: string; readonly blipEffect?: string } = {}): string {
	return `<w:document xmlns:w="${word}" xmlns:r="${relationships}" xmlns:wp="${wordDrawing}" xmlns:a="${drawing}" xmlns:pic="${picture}" xmlns:wps="${wordShape}" xmlns:m="${math}"><w:body>
		<w:p><w:r><w:drawing><wp:anchor distT="1" distB="2" distL="3" distR="4" simplePos="0" relativeHeight="5" behindDoc="0" locked="1" layoutInCell="1" allowOverlap="0">
			<wp:simplePos x="-10" y="20"/><wp:positionH relativeFrom="page"><wp:posOffset>30</wp:posOffset></wp:positionH><wp:positionV relativeFrom="paragraph"><wp:align>center</wp:align></wp:positionV>
			<wp:extent cx="${overrides.extent ?? '1000'}" cy="2000"/><wp:effectExtent l="11" t="12" r="13" b="14"/>${overrides.wrap ?? '<wp:wrapSquare wrapText="bothSides" distT="21" distB="22" distL="23" distR="24"/>'}
			<wp:docPr id="7" name="Picture 7" descr="${overrides.description ?? 'diagram'}" title="Architecture"/>
			<a:graphic><a:graphicData><pic:pic><pic:blipFill><a:blip ${overrides.relationshipAttribute ?? 'r:embed="rImage"'}>${overrides.blipEffect ?? ''}</a:blip><a:srcRect l="${overrides.crop ?? '100'}" t="200" r="300" b="400"/></pic:blipFill><pic:spPr>
				<a:xfrm rot="${overrides.rotation ?? '60000'}" flipH="1" flipV="0"><a:off x="31" y="32"/><a:ext cx="33" cy="34"/></a:xfrm><a:prstGeom prst="rect"/>
				<a:effectLst><a:outerShdw blurRad="${overrides.effect ?? '500'}" dist="600" dir="700"><a:srgbClr val="112233"/></a:outerShdw></a:effectLst>
			</pic:spPr></pic:pic></a:graphicData></a:graphic>
		</wp:anchor></w:drawing></w:r></w:p>
		<w:p><w:r><w:drawing><wp:inline><wp:extent cx="500" cy="600"/><a:graphic><a:graphicData><wps:wsp><wps:spPr><a:xfrm rot="120000" flipV="1"><a:off x="-50" y="60"/><a:ext cx="700" cy="800"/></a:xfrm><a:prstGeom prst="line"/><a:ln w="12700"><a:prstDash val="dashDot"/><a:headEnd type="triangle"/><a:tailEnd type="oval"/></a:ln></wps:spPr></wps:wsp></a:graphicData></a:graphic></wp:inline></w:drawing></w:r></w:p>
		<w:tbl><w:tblPr><w:tblBorders><w:tl2br w:val="single"/></w:tblBorders></w:tblPr><w:tr><w:tc><w:p/></w:tc></w:tr></w:tbl>
	</w:body></w:document>`;
}

function embeddedModel(documentXml = pictureXml(), bytes = new Uint8Array([137, 80, 78, 71, 1])) {
	return parseParadisWordObjects({
		document: part('/word/document.xml', documentXml, 'application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml'),
		relationshipPart: relationshipPart(`<Relationship Id="rImage" Type="${relationships}/image" Target="media/image1.png"/>`),
		relatedParts: [part('/word/media/image1.png', bytes, 'image/png')],
	});
}

suite('ParadisWordObjects', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	test('separates image content, placement, and presentation identities', () => {
		const first = embeddedModel();
		const replaced = embeddedModel(pictureXml(), new Uint8Array([137, 80, 78, 71, 2]));
		const resized = embeddedModel(pictureXml({ extent: '1001' }));
		const restyled = embeddedModel(pictureXml({ crop: '101', rotation: '60001', effect: '501', description: 'updated diagram', blipEffect: '<a:grayscl/>' }));

		strictEqual(first.images.length, 1);
		strictEqual(first.images[0].content.kind, 'embedded');
		notStrictEqual(first.images[0].content.fingerprint.value, replaced.images[0].content.kind === 'embedded' ? replaced.images[0].content.fingerprint.value : undefined);
		strictEqual(first.images[0].placement.fingerprint.value, replaced.images[0].placement.fingerprint.value);
		strictEqual(first.images[0].presentation.fingerprint.value, replaced.images[0].presentation.fingerprint.value);

		notStrictEqual(first.images[0].placement.fingerprint.value, resized.images[0].placement.fingerprint.value);
		strictEqual(first.images[0].content.fingerprint.value, resized.images[0].content.kind === 'embedded' ? resized.images[0].content.fingerprint.value : undefined);
		strictEqual(first.images[0].presentation.fingerprint.value, resized.images[0].presentation.fingerprint.value);

		notStrictEqual(first.images[0].presentation.fingerprint.value, restyled.images[0].presentation.fingerprint.value);
		strictEqual(first.images[0].content.fingerprint.value, restyled.images[0].content.kind === 'embedded' ? restyled.images[0].content.fingerprint.value : undefined);
		strictEqual(first.images[0].placement.fingerprint.value, restyled.images[0].placement.fingerprint.value);
		strictEqual(first.images[0].presentation.blipEffectsFingerprint, undefined);
		notStrictEqual(first.images[0].presentation.blipEffectsFingerprint, restyled.images[0].presentation.blipEffectsFingerprint);
		deepStrictEqual(first.images[0].presentation, {
			fingerprint: first.images[0].presentation.fingerprint,
			name: 'Picture 7', alternativeText: 'diagram', title: 'Architecture',
			crop: { left: '100', top: '200', right: '300', bottom: '400' },
			transform: { rotation: '60000', flipHorizontal: '1', flipVertical: '0', offset: { x: '31', y: '32' }, extent: { cx: '33', cy: '34' } },
			effectsFingerprint: first.images[0].presentation.effectsFingerprint,
		});
	});

	test('retains exact image anchor and line geometry without treating table diagonals as drawings', () => {
		const model = embeddedModel();

		deepStrictEqual(model.images[0].placement, {
			fingerprint: model.images[0].placement.fingerprint,
			kind: 'anchor', distances: { top: '1', bottom: '2', left: '3', right: '4' },
			simplePosition: { x: '-10', y: '20' },
			horizontalPosition: { relativeFrom: 'page', offset: '30' },
			verticalPosition: { relativeFrom: 'paragraph', align: 'center' },
			extent: { cx: '1000', cy: '2000' }, effectExtent: { left: '11', top: '12', right: '13', bottom: '14' },
			wrap: { kind: 'square', wrapText: 'bothSides', distances: { top: '21', bottom: '22', left: '23', right: '24' } },
			anchorProperties: { simplePosition: '0', relativeHeight: '5', behindDocument: '0', locked: '1', layoutInCell: '1', allowOverlap: '0' },
		});
		strictEqual(model.lines.length, 1);
		deepStrictEqual(model.lines[0].geometry, {
			preset: 'line',
			transform: { rotation: '120000', flipVertical: '1', offset: { x: '-50', y: '60' }, extent: { cx: '700', cy: '800' } },
			line: { width: '12700', presetDash: 'dashDot', headEnd: { type: 'triangle' }, tailEnd: { type: 'oval' } },
		});

		const polygonModel = embeddedModel(pictureXml({
			wrap: '<wp:wrapTight wrapText="largest"><wp:wrapPolygon edited="1"><wp:start x="10" y="20"/><wp:lineTo x="30" y="40"/><wp:lineTo x="50" y="60"/></wp:wrapPolygon></wp:wrapTight>',
		}));
		deepStrictEqual(polygonModel.images[0].placement.wrap, {
			kind: 'tight', wrapText: 'largest', distances: {},
			polygon: { edited: '1', start: { x: '10', y: '20' }, lines: [{ x: '30', y: '40' }, { x: '50', y: '60' }] },
		});
		notStrictEqual(model.images[0].placement.fingerprint.value, polygonModel.images[0].placement.fingerprint.value);
	});

	test('redacts external image targets and never represents them as fetched content', () => {
		const target = 'https://private.example/assets/customer-diagram.png?token=secret';
		const model = parseParadisWordObjects({
			document: part('/word/document.xml', pictureXml({ relationshipAttribute: 'r:link="rImage"' })),
			relationshipPart: relationshipPart(`<Relationship Id="rImage" Type="${relationships}/image" TargetMode="External" Target="${target.replace('&', '&amp;')}"/>`),
			relatedParts: [],
		});

		deepStrictEqual(model.images[0].content, {
			kind: 'external', targetScheme: 'https', targetFingerprint: fingerprintParadisWordObjectBytes(utf8(target)), behavior: 'notFetched',
		});
		doesNotMatch(JSON.stringify(model), /private\.example|customer-diagram|secret/);
	});

	test('canonicalizes OMML and exposes only a plain-text projection', () => {
		const firstXml = `<w:document xmlns:w="${word}" xmlns:m="${math}"><w:body><w:p><m:oMath><m:r m:rsidR="2" m:rsidDel="1"><m:t>x+y</m:t></m:r></m:oMath></w:p></w:body></w:document>`;
		const equivalentXml = `<x:document xmlns:x="${word}" xmlns:q="${math}"><x:body><x:p>
			<q:oMath><q:r q:rsidDel="1" q:rsidR="2"><q:t>x+y</q:t></q:r></q:oMath>
		</x:p></x:body></x:document>`;
		const changedXml = firstXml.replace('x+y', 'x-y');
		const unsafeProjectionXml = firstXml.replace('x+y', '&lt;img src=x onerror=alert(1)&gt;');
		const first = parseParadisWordObjects({ document: part('/word/document.xml', firstXml), relatedParts: [] });
		const equivalent = parseParadisWordObjects({ document: part('/word/document.xml', equivalentXml), relatedParts: [] });
		const changed = parseParadisWordObjects({ document: part('/word/document.xml', changedXml), relatedParts: [] });
		const projected = parseParadisWordObjects({ document: part('/word/document.xml', unsafeProjectionXml), relatedParts: [] });

		strictEqual(first.math[0].canonicalFingerprint.value, equivalent.math[0].canonicalFingerprint.value);
		notStrictEqual(first.math[0].canonicalFingerprint.value, changed.math[0].canonicalFingerprint.value);
		deepStrictEqual(first.math[0].projection, { kind: 'plainText', text: 'x+y' });
		deepStrictEqual(projected.math[0].projection, { kind: 'plainText', text: '<img src=x onerror=alert(1)>' });
		strictEqual(Object.keys(projected.math[0]).includes('canonicalXml'), false);
	});

	test('preserves saved simple and complex field state without recalculation', () => {
		const documentXml = `<w:document xmlns:w="${word}"><w:body><w:p>
			<w:fldSimple w:instr=" PAGE \\* MERGEFORMAT " w:dirty="true" w:fldLock="1"><w:r><w:t>7</w:t></w:r></w:fldSimple>
			<w:r><w:fldChar w:fldCharType="begin" w:dirty="1" w:fldLock="0"/></w:r><w:r><w:instrText> DATE \\@ </w:instrText></w:r><w:r><w:instrText>"yyyy"</w:instrText></w:r>
			<w:r><w:fldChar w:fldCharType="separate"/></w:r><w:r><w:t>2026</w:t></w:r><w:r><w:fldChar w:fldCharType="end"/></w:r>
		</w:p></w:body></w:document>`;
		const model = parseParadisWordFields({ document: part('/word/document.xml', documentXml) });

		deepStrictEqual(model.fields.map(field => ({ kind: field.fieldKind, instruction: field.instruction, result: field.savedResult, dirty: field.dirty, locked: field.locked, evaluation: field.evaluation })), [
			{ kind: 'simple', instruction: ' PAGE \\* MERGEFORMAT ', result: '7', dirty: 'true', locked: '1', evaluation: 'savedResultOnly' },
			{ kind: 'complex', instruction: ' DATE \\@ "yyyy"', result: '2026', dirty: '1', locked: '0', evaluation: 'savedResultOnly' },
		]);
	});

	test('enforces field count and logical nesting limits when a complex field begins', () => {
		const documentXml = `<w:document xmlns:w="${word}"><w:body><w:p>
			<w:r><w:fldChar w:fldCharType="begin"/></w:r><w:r><w:fldChar w:fldCharType="begin"/></w:r>
		</w:p></w:body></w:document>`;
		const document = part('/word/document.xml', documentXml);
		throws(() => parseParadisWordFields({ document }, { maximumFields: 1 }), error => error instanceof ParadisOfficePackageError && error.code === 'limitExceeded');
		throws(() => parseParadisWordFields({ document }, { maximumFieldDepth: 1 }), error => error instanceof ParadisOfficePackageError && error.code === 'limitExceeded');
	});

	test('models section properties and typed content/property revisions', () => {
		const documentXml = `<w:document xmlns:w="${word}" xmlns:r="${relationships}"><w:body>
			<w:p><w:ins w:id="1" w:author="Alice" w:date="2026-08-24T10:00:00Z"><w:r><w:t>inserted</w:t></w:r></w:ins>
			<w:del w:id="2" w:author="Bob"><w:r><w:delText>deleted</w:delText></w:r></w:del><w:moveFrom w:id="3"><w:r><w:t>from</w:t></w:r></w:moveFrom><w:moveTo w:id="4"><w:r><w:t>to</w:t></w:r></w:moveTo></w:p>
			<w:p><w:pPr><w:pPrChange w:id="5" w:author="Carol"><w:pPr><w:jc w:val="left"/></w:pPr></w:pPrChange></w:pPr><w:r><w:rPr><w:rPrChange w:id="6"><w:rPr><w:b/></w:rPr></w:rPrChange></w:rPr><w:t>x</w:t></w:r></w:p>
			<w:tbl><w:tblPr><w:tblPrChange w:id="7"><w:tblPr/></w:tblPrChange></w:tblPr><w:tr><w:trPr><w:trPrChange w:id="8"><w:trPr/></w:trPrChange></w:trPr><w:tc><w:tcPr><w:tcPrChange w:id="9"><w:tcPr/></w:tcPrChange></w:tcPr><w:p/></w:tc></w:tr></w:tbl>
			<w:sectPr><w:type w:val="continuous"/><w:pgSz w:w="12240" w:h="15840" w:orient="portrait"/><w:pgMar w:top="1440" w:right="720" w:bottom="1440" w:left="720" w:header="360" w:footer="360" w:gutter="0"/>
				<w:cols w:num="2" w:space="360" w:equalWidth="0" w:sep="1"><w:col w:w="5000" w:space="240"/><w:col w:w="5000"/></w:cols><w:pgNumType w:start="3" w:fmt="decimal"/><w:titlePg/>
				<w:headerReference w:type="default" r:id="rHeader"/><w:footerReference w:type="even" r:id="rFooter"/><w:sectPrChange w:id="10"><w:sectPr><w:type w:val="nextPage"/></w:sectPr></w:sectPrChange>
			</w:sectPr>
		</w:body></w:document>`;
		const model = parseParadisWordFields({
			document: part('/word/document.xml', documentXml),
			relationshipPart: relationshipPart([
				`<Relationship Id="rHeader" Type="${relationships}/header" Target="header1.xml"/>`,
				`<Relationship Id="rFooter" Type="${relationships}/footer" Target="footer1.xml"/>`,
			].join('')),
		});

		deepStrictEqual(model.sections.map(section => ({
			breakType: section.breakType, paper: section.paper, margins: section.margins, columns: section.columns,
			pageNumber: section.pageNumber, titlePage: section.titlePage,
			storyReferences: section.storyReferences.map(reference => [reference.kind, reference.role, reference.targetPartUri]),
		})), [{
			breakType: 'continuous', paper: { width: '12240', height: '15840', orientation: 'portrait' },
			margins: { top: '1440', right: '720', bottom: '1440', left: '720', header: '360', footer: '360', gutter: '0' },
			columns: { count: '2', space: '360', equalWidth: '0', separator: '1', definitions: [{ width: '5000', space: '240' }, { width: '5000' }] },
			pageNumber: { start: '3', format: 'decimal' }, titlePage: true,
			storyReferences: [['header', 'default', '/word/header1.xml'], ['footer', 'even', '/word/footer1.xml']],
		}]);
		deepStrictEqual(model.revisions.map(revision => [revision.revisionKind, revision.propertyScope, revision.revisionId, revision.text]), [
			['inserted', undefined, '1', 'inserted'], ['deleted', undefined, '2', 'deleted'], ['moveFrom', undefined, '3', 'from'], ['moveTo', undefined, '4', 'to'],
			['propertyChange', 'paragraph', '5', ''], ['propertyChange', 'run', '6', ''], ['propertyChange', 'table', '7', ''], ['propertyChange', 'row', '8', ''], ['propertyChange', 'cell', '9', ''], ['propertyChange', 'section', '10', ''],
		]);
		strictEqual(model.sections.length, 1);
	});

	test('rejects forged all-byte authority before parsing', () => {
		const document = part('/word/document.xml', pictureXml());
		const forged = { ...document, source: { ...document.source, partFingerprint: { ...document.source.partFingerprint, value: '0'.repeat(64) } } };
		throws(() => parseParadisWordObjects({ document: forged, relatedParts: [] }), error => error instanceof ParadisOfficePackageError && error.code === 'unsafe');
		throws(() => parseParadisWordFields({ document: forged }), error => error instanceof ParadisOfficePackageError && error.code === 'unsafe');
	});
});
