/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import { deepStrictEqual, strictEqual, throws } from 'assert';
import { CancellationTokenSource } from '../../../../../base/common/cancellation.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import type { ParadisOfficeFingerprint } from '../../common/paradisOfficeProtocol.js';
import { ParadisOfficePackageError, type ParadisOfficeXmlDocument, type ParadisOfficeXmlNode } from '../../common/office/paradisOfficeArchive.js';
import { parseParadisOfficeXml } from '../../common/office/paradisOfficeCanonicalXml.js';
import {
	diffParadisWordStyleDefinitions,
	parseParadisWordStyles,
	resolveParadisWordEffectiveProperties,
	type ParadisWordPartAuthority,
} from '../../common/word/paradisWordStyles.js';
import { parseParadisWordTable } from '../../common/word/paradisWordTables.js';
import { parseParadisWordNumbering, resolveParadisWordNumbering } from '../../common/word/paradisWordNumbering.js';

const wordNamespace = 'http://schemas.openxmlformats.org/wordprocessingml/2006/main';
const drawingNamespace = 'http://schemas.openxmlformats.org/drawingml/2006/main';
const relationshipNamespace = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';
const vmlNamespace = 'urn:schemas-microsoft-com:vml';
const xmlLimits = { depth: 64, nodes: 10_000, attributeLength: 10_000, characters: 100_000 };

type XmlElement = Extract<ParadisOfficeXmlNode, { readonly kind: 'element' }>;

function xml(value: string): ParadisOfficeXmlDocument {
	return parseParadisOfficeXml(value, xmlLimits);
}

function child(parent: XmlElement, local: string): XmlElement {
	const result = parent.children.find((node): node is XmlElement => node.kind === 'element' && node.uri === wordNamespace && node.local === local);
	if (!result) {
		throw new Error(`missing fixture child ${local}`);
	}
	return result;
}

function fingerprint(character: string): ParadisOfficeFingerprint {
	return { algorithm: 'sha256', value: character.repeat(64), byteLength: 128 };
}

function authority(partUri: string, character: string): ParadisWordPartAuthority {
	return { partUri, partFingerprint: fingerprint(character) };
}

const stylesXml = `
<w:styles xmlns:w="${wordNamespace}">
	<w:docDefaults>
		<w:rPrDefault><w:rPr><w:i w:val="0"/><w:lang w:eastAsia="ja-JP" w:bidi="ar-SA"/></w:rPr></w:rPrDefault>
		<w:pPrDefault><w:pPr><w:spacing w:after="0"/></w:pPr></w:pPrDefault>
	</w:docDefaults>
	<w:style w:type="paragraph" w:styleId="Normal" w:default="1">
		<w:name w:val="Normal"/><w:next w:val="Normal"/><w:rPr><w:rFonts w:asciiTheme="majorHAnsi" w:hAnsiTheme="majorHAnsi" w:eastAsiaTheme="majorEastAsia" w:cstheme="majorBidi"/></w:rPr>
	</w:style>
	<w:style w:type="paragraph" w:styleId="Heading1">
		<w:name w:val="Heading 1"/><w:basedOn w:val="Normal"/><w:link w:val="Heading1Char"/><w:next w:val="BodyText"/>
		<w:pPr><w:keepNext/><w:numPr><w:ilvl w:val="0"/><w:numId w:val="12"/></w:numPr></w:pPr>
		<w:rPr><w:color w:themeColor="accent1" w:themeTint="80"/><w:strike w:val="1"/></w:rPr>
	</w:style>
	<w:style w:type="character" w:styleId="Heading1Char"><w:rPr><w:b/><w:strike w:val="0"/></w:rPr></w:style>
	<w:style w:type="table" w:styleId="TableGrid"><w:tblPr><w:tblW w:w="9000" w:type="dxa"/><w:shd w:fill="E7E6E6"/></w:tblPr><w:rPr><w:strike w:val="1"/></w:rPr></w:style>
	<w:style w:type="numbering" w:styleId="ListStyle"><w:pPr><w:ind w:left="720"/></w:pPr><w:rPr><w:strike w:val="1"/></w:rPr></w:style>
</w:styles>`;

const themeXml = `
<a:theme xmlns:a="${drawingNamespace}"><a:themeElements>
	<a:clrScheme name="Office"><a:dk1><a:sysClr val="windowText" lastClr="000000"/></a:dk1><a:accent1><a:srgbClr val="112233"/></a:accent1></a:clrScheme>
	<a:fontScheme name="Office"><a:majorFont><a:latin typeface="Aptos Display"/><a:ea typeface="Yu Gothic"/><a:cs typeface="Times New Roman"/></a:majorFont><a:minorFont><a:latin typeface="Aptos"/><a:ea typeface="Yu Mincho"/><a:cs typeface="Arial"/></a:minorFont></a:fontScheme>
</a:themeElements></a:theme>`;

const fontTableXml = `
<w:fonts xmlns:w="${wordNamespace}" xmlns:r="${relationshipNamespace}">
	<w:font w:name="Aptos Display"><w:family w:val="swiss"/><w:charset w:val="00"/><w:embedRegular r:id="rIdFont1" w:fontKey="{11111111-1111-1111-1111-111111111111}" w:subsetted="1"/></w:font>
</w:fonts>`;

suite('ParadisWordStyles', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	test('resolves document defaults, all four style kinds, themes, scripts, and direct explicit defaults with provenance', () => {
		const model = parseParadisWordStyles({
			styles: { document: xml(stylesXml), authority: authority('/word/styles.xml', 'a') },
			theme: { document: xml(themeXml), authority: authority('/word/theme/theme1.xml', 'b') },
			fontTable: { document: xml(fontTableXml), authority: authority('/word/fontTable.xml', 'c') },
		});
		const direct = xml(`<w:direct xmlns:w="${wordNamespace}"><w:pPr><w:keepNext w:val="0"/></w:pPr><w:rPr><w:b w:val="0"/><w:rFonts w:ascii="Direct Latin"/></w:rPr></w:direct>`).root;
		const result = resolveParadisWordEffectiveProperties(model, {
			nodeId: 'paragraph-7',
			paragraphStyleId: 'Heading1',
			characterStyleId: 'Heading1Char',
			tableStyleId: 'TableGrid',
			numberingStyleId: 'ListStyle',
			direct: {
				authority: authority('/word/document.xml', 'd'),
				semanticPath: [0, 3],
				paragraph: child(direct, 'pPr'),
				run: child(direct, 'rPr'),
			},
		});

		deepStrictEqual({
			metadata: result.appliedStyles.map(style => [style.type, style.styleId, style.basedOn, style.link, style.next]),
			spacing: result.paragraph.spacing,
			keepNext: result.paragraph.keepNext,
			numbering: [result.paragraph['numPr.ilvl'], result.paragraph['numPr.numId']],
			indent: result.paragraph.ind,
			bold: result.run.b,
			cascade: result.run.strike,
			italic: result.run.i,
			color: result.run.color,
			fonts: result.run.rFonts,
			tableWidth: result.table.tblW,
			tableShading: result.table.shd,
		}, {
			metadata: [
				['table', 'TableGrid', undefined, undefined, undefined],
				['numbering', 'ListStyle', undefined, undefined, undefined],
				['paragraph', 'Heading1', 'Normal', 'Heading1Char', 'BodyText'],
				['character', 'Heading1Char', undefined, undefined, undefined],
			],
			spacing: {
				attributes: { after: '0' }, resolvedAttributes: {}, explicit: false,
				provenance: { origin: 'docDefault', partUri: '/word/styles.xml', partFingerprint: fingerprint('a'), semanticPath: [0, 0, 1, 0, 0] },
			},
			keepNext: {
				attributes: { val: '0' }, resolvedAttributes: {}, explicit: true,
				provenance: { origin: 'direct', definitionId: 'paragraph-7', partUri: '/word/document.xml', partFingerprint: fingerprint('d'), semanticPath: [0, 3, 0, 0] },
			},
			numbering: [
				{ attributes: { val: '0' }, resolvedAttributes: {}, explicit: false, provenance: { origin: 'style', definitionId: 'Heading1', partUri: '/word/styles.xml', partFingerprint: fingerprint('a'), semanticPath: [0, 2, 4, 1, 0] } },
				{ attributes: { val: '12' }, resolvedAttributes: {}, explicit: false, provenance: { origin: 'style', definitionId: 'Heading1', partUri: '/word/styles.xml', partFingerprint: fingerprint('a'), semanticPath: [0, 2, 4, 1, 1] } },
			],
			indent: { attributes: { left: '720' }, resolvedAttributes: {}, explicit: false, provenance: { origin: 'style', definitionId: 'ListStyle', partUri: '/word/styles.xml', partFingerprint: fingerprint('a'), semanticPath: [0, 5, 0, 0] } },
			bold: { attributes: { val: '0' }, resolvedAttributes: {}, explicit: true, provenance: { origin: 'direct', definitionId: 'paragraph-7', partUri: '/word/document.xml', partFingerprint: fingerprint('d'), semanticPath: [0, 3, 1, 0] } },
			cascade: { attributes: { val: '0' }, resolvedAttributes: {}, explicit: false, provenance: { origin: 'style', definitionId: 'Heading1Char', partUri: '/word/styles.xml', partFingerprint: fingerprint('a'), semanticPath: [0, 3, 0, 1] } },
			italic: { attributes: { val: '0' }, resolvedAttributes: {}, explicit: false, provenance: { origin: 'docDefault', partUri: '/word/styles.xml', partFingerprint: fingerprint('a'), semanticPath: [0, 0, 0, 0, 0] } },
			color: { attributes: { themeColor: 'accent1', themeTint: '80' }, resolvedAttributes: { color: '#112233' }, explicit: false, provenance: { origin: 'style', definitionId: 'Heading1', partUri: '/word/styles.xml', partFingerprint: fingerprint('a'), semanticPath: [0, 2, 5, 0] } },
			fonts: {
				attributes: { asciiTheme: 'majorHAnsi', hAnsiTheme: 'majorHAnsi', eastAsiaTheme: 'majorEastAsia', cstheme: 'majorBidi', ascii: 'Direct Latin' },
				resolvedAttributes: { ascii: 'Direct Latin', hAnsi: 'Aptos Display', eastAsia: 'Yu Gothic', cs: 'Times New Roman' }, explicit: true,
				provenance: { origin: 'direct', definitionId: 'paragraph-7', partUri: '/word/document.xml', partFingerprint: fingerprint('d'), semanticPath: [0, 3, 1, 1] },
				attributeProvenance: {
					asciiTheme: { explicit: false, provenance: { origin: 'style', definitionId: 'Normal', partUri: '/word/styles.xml', partFingerprint: fingerprint('a'), semanticPath: [0, 1, 2, 0] } },
					hAnsiTheme: { explicit: false, provenance: { origin: 'style', definitionId: 'Normal', partUri: '/word/styles.xml', partFingerprint: fingerprint('a'), semanticPath: [0, 1, 2, 0] } },
					eastAsiaTheme: { explicit: false, provenance: { origin: 'style', definitionId: 'Normal', partUri: '/word/styles.xml', partFingerprint: fingerprint('a'), semanticPath: [0, 1, 2, 0] } },
					cstheme: { explicit: false, provenance: { origin: 'style', definitionId: 'Normal', partUri: '/word/styles.xml', partFingerprint: fingerprint('a'), semanticPath: [0, 1, 2, 0] } },
					ascii: { explicit: true, provenance: { origin: 'direct', definitionId: 'paragraph-7', partUri: '/word/document.xml', partFingerprint: fingerprint('d'), semanticPath: [0, 3, 1, 1] } },
				},
			},
			tableWidth: { attributes: { w: '9000', type: 'dxa' }, resolvedAttributes: {}, explicit: false, provenance: { origin: 'style', definitionId: 'TableGrid', partUri: '/word/styles.xml', partFingerprint: fingerprint('a'), semanticPath: [0, 4, 0, 0] } },
			tableShading: { attributes: { fill: 'E7E6E6' }, resolvedAttributes: {}, explicit: false, provenance: { origin: 'style', definitionId: 'TableGrid', partUri: '/word/styles.xml', partFingerprint: fingerprint('a'), semanticPath: [0, 4, 0, 1] } },
		});
		deepStrictEqual(model.fonts.get('Aptos Display'), {
			name: 'Aptos Display', family: 'swiss', charset: '00',
			embedded: { regular: { relationshipId: 'rIdFont1', fontKey: '{11111111-1111-1111-1111-111111111111}', subsetted: '1' } },
			source: { partUri: '/word/fontTable.xml', partFingerprint: fingerprint('c'), semanticPath: [0, 0] },
		});
		const defaultParagraph = resolveParadisWordEffectiveProperties(model, { nodeId: 'paragraph-without-pStyle', nodeKind: 'paragraph' });
		deepStrictEqual({
			styles: defaultParagraph.appliedStyles.map(style => style.styleId),
			fonts: defaultParagraph.run.rFonts.resolvedAttributes,
		}, { styles: ['Normal'], fonts: { ascii: 'Aptos Display', hAnsi: 'Aptos Display', eastAsia: 'Yu Gothic', cs: 'Times New Roman' } });
	});

	test('reports one style-definition change with sorted affected node IDs', () => {
		const before = parseParadisWordStyles({ styles: { document: xml(stylesXml), authority: authority('/word/styles.xml', 'a') } });
		const after = parseParadisWordStyles({ styles: { document: xml(stylesXml.replace('<w:keepNext/>', '<w:keepNext w:val="0"/>')), authority: authority('/word/styles.xml', 'e') } });

		deepStrictEqual(diffParadisWordStyleDefinitions(before, after, [
			{ styleId: 'Heading1', nodeIds: ['p-2', 'p-1', 'p-2'] },
		]), [{
			kind: 'styleDefinition', styleId: 'Heading1', styleType: 'paragraph',
			beforeFingerprint: before.styles.get('Heading1')!.definitionFingerprint,
			afterFingerprint: after.styles.get('Heading1')!.definitionFingerprint,
			affectedNodeIds: ['p-1', 'p-2'],
		}]);

		const changedBase = parseParadisWordStyles({ styles: { document: xml(stylesXml.replace('</w:rPr>\n\t</w:style>', '<w:smallCaps/></w:rPr>\n\t</w:style>')), authority: authority('/word/styles.xml', 'f') } });
		const baseChanges = diffParadisWordStyleDefinitions(before, changedBase, [{ styleId: 'Heading1', nodeIds: ['p-2', 'p-1'] }]);
		deepStrictEqual(baseChanges.find(change => change.styleId === 'Normal')?.affectedNodeIds, ['p-1', 'p-2']);
	});

	test('preserves table grid, merge, sizing, raw borders, row flags, RTL, and nested-table addresses', () => {
		const document = xml(`<w:tbl xmlns:w="${wordNamespace}">
			<w:tblPr><w:tblW w:w="9000" w:type="dxa"/><w:bidiVisual/><w:shd w:fill="F2F2F2"/><w:tblBorders><w:top w:val="single" w:sz="8" w:color="010203"/><w:tl2br w:val="dashDot" w:sz="13" w:color="80A0B0" w:themeColor="accent2" w:themeTint="40"/></w:tblBorders></w:tblPr>
			<w:tblGrid><w:gridCol w:w="3000"/><w:gridCol w:w="3000"/><w:gridCol w:w="3000"/></w:tblGrid>
			<w:tr><w:trPr><w:trHeight w:val="480" w:hRule="exact"/><w:tblHeader/><w:cantSplit/></w:trPr>
				<w:tc><w:tcPr><w:gridSpan w:val="2"/><w:vMerge w:val="restart"/><w:hMerge w:val="restart"/><w:tcW w:w="6000" w:type="dxa"/><w:shd w:fill="ABCDEF"/><w:tcBorders><w:tr2bl w:val="double" w:color="0A0B0C"/></w:tcBorders></w:tcPr><w:p/>
					<w:tbl><w:tblGrid><w:gridCol w:w="1000"/></w:tblGrid><w:tr><w:tc><w:tcPr><w:tcW w:w="1000" w:type="dxa"/></w:tcPr><w:p/></w:tc></w:tr></w:tbl>
				</w:tc><w:tc><w:tcPr><w:tcW w:w="3000" w:type="dxa"/></w:tcPr><w:p/></w:tc>
			</w:tr>
			<w:tr><w:tc><w:tcPr><w:vMerge/><w:hMerge/><w:gridSpan w:val="2"/></w:tcPr><w:p/></w:tc><w:tc><w:p/></w:tc></w:tr>
		</w:tbl>`);
		const table = parseParadisWordTable(document.root, { authority: authority('/word/document.xml', 'f'), semanticPath: [0, 4] });

		deepStrictEqual({
			width: table.width,
			rightToLeft: table.rightToLeft,
			shading: table.shading,
			gridColumns: table.gridColumns,
			borders: table.borders,
			firstRow: table.rows[0],
			secondRowCells: table.rows[1].cells,
		}, {
			width: { value: '9000', type: 'dxa' },
			rightToLeft: true,
			shading: { fill: 'F2F2F2' },
			gridColumns: ['3000', '3000', '3000'],
			borders: {
				top: { direction: undefined, value: 'single', size: '8', color: '010203', themeColor: undefined, themeTint: undefined, themeShade: undefined, space: undefined, provenance: { partUri: '/word/document.xml', partFingerprint: fingerprint('f'), semanticPath: [0, 4], xmlPath: [0, 3, 0] } },
				topLeftToBottomRight: { direction: 'topLeftToBottomRight', value: 'dashDot', size: '13', color: '80A0B0', themeColor: 'accent2', themeTint: '40', themeShade: undefined, space: undefined, provenance: { partUri: '/word/document.xml', partFingerprint: fingerprint('f'), semanticPath: [0, 4], xmlPath: [0, 3, 1] } },
			},
			firstRow: {
				height: { value: '480', rule: 'exact' }, repeatHeader: true, cantSplit: true,
				cells: [{
					columnStart: 0, columnSpan: 2, verticalMerge: 'restart', horizontalMerge: 'restart', width: { value: '6000', type: 'dxa' }, shading: { fill: 'ABCDEF' },
					borders: { topRightToBottomLeft: { direction: 'topRightToBottomLeft', value: 'double', size: undefined, color: '0A0B0C', themeColor: undefined, themeTint: undefined, themeShade: undefined, space: undefined, provenance: { partUri: '/word/document.xml', partFingerprint: fingerprint('f'), semanticPath: [0, 4, 0, 0], xmlPath: [2, 1, 0, 5, 0] } } },
					nestedTables: [{
						source: { partUri: '/word/document.xml', partFingerprint: fingerprint('f'), semanticPath: [0, 4, 0, 0, 1], xmlPath: [2, 1, 2] }, rightToLeft: false,
						gridColumns: ['1000'], borders: {}, rows: [{ repeatHeader: false, cantSplit: false, cells: [{ columnStart: 0, columnSpan: 1, width: { value: '1000', type: 'dxa' }, borders: {}, nestedTables: [] }] }],
					}],
				}, {
					columnStart: 2, columnSpan: 1, width: { value: '3000', type: 'dxa' }, borders: {}, nestedTables: [],
				}],
			},
			secondRowCells: [{ columnStart: 0, columnSpan: 2, verticalMerge: 'continue', horizontalMerge: 'continue', borders: {}, nestedTables: [] }, { columnStart: 2, columnSpan: 1, borders: {}, nestedTables: [] }],
		});
		strictEqual(Object.hasOwn(table.borders.topLeftToBottomRight, 'geometry'), false);
	});

	test('resolves abstract numbering, starts, restarts, overrides, formats, text, and picture-bullet metadata', () => {
		const numberingXml = `<w:numbering xmlns:w="${wordNamespace}" xmlns:r="${relationshipNamespace}" xmlns:v="${vmlNamespace}">
			<w:numPicBullet w:numPicBulletId="3"><w:pict><v:shape id="bullet"><v:imagedata r:id="rIdBullet"/></v:shape></w:pict></w:numPicBullet>
			<w:abstractNum w:abstractNumId="7"><w:multiLevelType w:val="multilevel"/>
				<w:lvl w:ilvl="0"><w:start w:val="1"/><w:lvlRestart w:val="1"/><w:numFmt w:val="decimal"/><w:lvlText w:val="%1."/><w:pStyle w:val="ListParagraph"/></w:lvl>
				<w:lvl w:ilvl="1"><w:start w:val="1"/><w:numFmt w:val="bullet"/><w:lvlText w:val=""/><w:lvlPicBulletId w:val="3"/></w:lvl>
			</w:abstractNum>
			<w:num w:numId="12"><w:abstractNumId w:val="7"/><w:lvlOverride w:ilvl="0"><w:startOverride w:val="5"/></w:lvlOverride></w:num>
		</w:numbering>`;
		const model = parseParadisWordNumbering({ document: xml(numberingXml), authority: authority('/word/numbering.xml', '9') });
		const decimal = resolveParadisWordNumbering(model, '12', 0);
		const bullet = resolveParadisWordNumbering(model, '12', 1);

		deepStrictEqual({
			decimal: { ...decimal, definitionFingerprint: undefined },
			bullet: { ...bullet, definitionFingerprint: undefined },
			picture: model.pictureBullets.get('3'),
			fingerprintsEqual: decimal.definitionFingerprint === bullet.definitionFingerprint,
		}, {
			decimal: { numId: '12', abstractNumId: '7', level: '0', start: '5', restart: '1', format: 'decimal', text: '%1.', paragraphStyleId: 'ListParagraph', pictureBulletId: undefined, pictureBullet: undefined, definitionFingerprint: undefined },
			bullet: { numId: '12', abstractNumId: '7', level: '1', start: '1', restart: undefined, format: 'bullet', text: '', paragraphStyleId: undefined, pictureBulletId: '3', pictureBullet: { id: '3', relationshipId: 'rIdBullet', source: { partUri: '/word/numbering.xml', partFingerprint: fingerprint('9'), semanticPath: [0, 0] } }, definitionFingerprint: undefined },
			picture: { id: '3', relationshipId: 'rIdBullet', source: { partUri: '/word/numbering.xml', partFingerprint: fingerprint('9'), semanticPath: [0, 0] } },
			fingerprintsEqual: true,
		});
		strictEqual(decimal.definitionFingerprint.startsWith('fnv1a32:'), true);
		const changed = parseParadisWordNumbering({ document: xml(numberingXml.replace('%1.', '(%1)')), authority: authority('/word/numbering.xml', '9') });
		strictEqual(resolveParadisWordNumbering(changed, '12', 0).definitionFingerprint === decimal.definitionFingerprint, false);

		const overrideOnlyPicture = `<w:numPicBullet w:numPicBulletId="4"><w:pict><v:shape id="override-bullet"><v:imagedata r:id="rIdOverrideBullet"/></v:shape></w:pict></w:numPicBullet><w:num w:numId="13"><w:abstractNumId w:val="7"/><w:lvlOverride w:ilvl="1"><w:lvl w:ilvl="1"><w:lvlPicBulletId w:val="4"/></w:lvl></w:lvlOverride></w:num>`;
		const withOverridePicture = parseParadisWordNumbering({ document: xml(numberingXml.replace('</w:numbering>', `${overrideOnlyPicture}</w:numbering>`)), authority: authority('/word/numbering.xml', '9') });
		const changedOverridePicture = parseParadisWordNumbering({ document: xml(numberingXml.replace('</w:numbering>', `${overrideOnlyPicture.replace('rIdOverrideBullet', 'rIdChangedBullet')}</w:numbering>`)), authority: authority('/word/numbering.xml', '9') });
		strictEqual(resolveParadisWordNumbering(withOverridePicture, '13', 1).definitionFingerprint === resolveParadisWordNumbering(changedOverridePicture, '13', 1).definitionFingerprint, false);
	});

	test('rejects basedOn cycles and duplicate numbering IDs as sanitized package failures', () => {
		const cyclic = xml(`<w:styles xmlns:w="${wordNamespace}"><w:style w:type="paragraph" w:styleId="A"><w:basedOn w:val="B"/></w:style><w:style w:type="paragraph" w:styleId="B"><w:basedOn w:val="A"/></w:style></w:styles>`);
		throws(() => parseParadisWordStyles({ styles: { document: cyclic, authority: authority('/word/styles.xml', 'a') } }), error => error instanceof ParadisOfficePackageError && error.code === 'malformed' && error.message === 'malformed');
		const duplicate = xml(`<w:numbering xmlns:w="${wordNamespace}"><w:abstractNum w:abstractNumId="1"/><w:abstractNum w:abstractNumId="1"/></w:numbering>`);
		throws(() => parseParadisWordNumbering({ document: duplicate, authority: authority('/word/numbering.xml', 'b') }), error => error instanceof ParadisOfficePackageError && error.code === 'malformed' && error.message === 'malformed');
	});

	test('enforces cancellation, deadline, authority, and table bounds before returning partial semantics', () => {
		const cancelled = new CancellationTokenSource();
		cancelled.cancel();
		throws(() => parseParadisWordStyles({ styles: { document: xml(stylesXml), authority: authority('/word/styles.xml', 'a') } }, { token: cancelled.token }), error => error instanceof ParadisOfficePackageError && error.code === 'cancelled');
		cancelled.dispose();

		let time = 0;
		throws(() => parseParadisWordNumbering({ document: xml(`<w:numbering xmlns:w="${wordNamespace}"/>`), authority: authority('/word/numbering.xml', 'b') }, { deadlineMilliseconds: 1, now: () => time += 2 }), error => error instanceof ParadisOfficePackageError && error.code === 'limitExceeded');
		throws(() => parseParadisWordStyles({ styles: { document: xml(stylesXml), authority: authority('/word/not-styles.xml', 'a') } }), error => error instanceof ParadisOfficePackageError && error.code === 'unsafe');

		const boundedTable = xml(`<w:tbl xmlns:w="${wordNamespace}"><w:tr><w:tc/><w:tc/></w:tr></w:tbl>`);
		throws(() => parseParadisWordTable(boundedTable.root, { authority: authority('/word/document.xml', 'f'), semanticPath: [0] }, { maximumCells: 1 }), error => error instanceof ParadisOfficePackageError && error.code === 'limitExceeded');
	});
});
