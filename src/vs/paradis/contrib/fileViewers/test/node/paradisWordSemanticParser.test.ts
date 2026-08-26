/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import { deepStrictEqual, rejects, strictEqual } from 'assert';
import { createHash } from 'crypto';
import JSZip from 'jszip';
import { CancellationToken, CancellationTokenSource } from '../../../../../base/common/cancellation.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { PARADIS_OFFICE_BUDGET_PROFILES, type ParadisOfficeInventory } from '../../common/paradisOfficeProtocol.js';
import { ParadisOfficePackageError } from '../../common/office/paradisOfficeArchive.js';
import { inspectOfficePackage } from '../../common/office/paradisOfficePackageCore.js';
import type { ParadisWordDrawingNode, ParadisWordNode, ParadisWordTableNode } from '../../common/word/paradisWordSemantic.js';
import { parseWordSemantic } from '../../common/word/paradisWordSemanticParser.js';
import { createParadisOfficeNodeArchive } from '../../node/office/paradisOfficeNodeArchive.js';
import { parseWordSemanticNode } from '../../node/word/paradisWordNodeAdapter.js';
import { buildOpcFixture } from '../common/paradisOfficeFixture.js';

const wordNamespace = 'http://schemas.openxmlformats.org/wordprocessingml/2006/main';
const relationshipNamespace = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';
const packageRelationshipNamespace = 'http://schemas.openxmlformats.org/package/2006/relationships';
const drawingWordprocessingNamespace = 'http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing';
const drawingNamespace = 'http://schemas.openxmlformats.org/drawingml/2006/main';
const pictureNamespace = 'http://schemas.openxmlformats.org/drawingml/2006/picture';
const mathNamespace = 'http://schemas.openxmlformats.org/officeDocument/2006/math';
const vmlNamespace = 'urn:schemas-microsoft-com:vml';
const officeDocumentRelationship = `${relationshipNamespace}/officeDocument`;
const headerRelationship = `${relationshipNamespace}/header`;
const footerRelationship = `${relationshipNamespace}/footer`;
const footnotesRelationship = `${relationshipNamespace}/footnotes`;
const endnotesRelationship = `${relationshipNamespace}/endnotes`;
const commentsRelationship = `${relationshipNamespace}/comments`;
const hyperlinkRelationship = `${relationshipNamespace}/hyperlink`;
const imageRelationship = `${relationshipNamespace}/image`;
const altChunkRelationship = `${relationshipNamespace}/aFChunk`;

const headerXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:hdr xmlns:w="${wordNamespace}" xmlns:r="${relationshipNamespace}" xmlns:wp="${drawingWordprocessingNamespace}" xmlns:a="${drawingNamespace}" xmlns:pic="${pictureNamespace}" xmlns:v="${vmlNamespace}">
	<w:p><w:r><w:t>Shared header</w:t></w:r><w:r><w:drawing>
		<wp:anchor distT="0" distB="1" distL="2" distR="3" simplePos="0" relativeHeight="251658240" behindDoc="0" locked="1" layoutInCell="1" allowOverlap="0">
			<wp:simplePos x="11" y="22"/><wp:positionH relativeFrom="page"><wp:align>center</wp:align></wp:positionH>
			<wp:positionV relativeFrom="paragraph"><wp:posOffset>-25400</wp:posOffset></wp:positionV><wp:extent cx="914400" cy="457200"/><wp:effectExtent l="31" t="32" r="33" b="34"/><wp:wrapSquare wrapText="bothSides" distT="41" distB="42" distL="43" distR="44"/>
			<a:graphic><a:graphicData><pic:pic><pic:spPr><a:xfrm rot="5400000" flipH="1" flipV="0"><a:off x="100" y="200"/><a:ext cx="300" cy="400"/></a:xfrm><a:prstGeom prst="line"><a:avLst/></a:prstGeom><a:ln w="12700" cap="rnd" cmpd="dbl" algn="ctr"><a:prstDash val="dashDot"/><a:headEnd type="triangle" w="sm" len="lg"/><a:tailEnd type="oval" w="med" len="sm"/></a:ln></pic:spPr></pic:pic></a:graphicData></a:graphic>
		</wp:anchor>
	</w:drawing></w:r></w:p>
	<w:pict><v:shape id="header-textbox" style="position:absolute;left:1pt;top:2pt;width:3pt;height:4pt;rotation:45"><v:textbox><w:txbxContent><w:p><w:r><w:t>Header box</w:t></w:r></w:p></w:txbxContent></v:textbox></v:shape></w:pict>
</w:hdr>`;

const footerXml = `<w:ftr xmlns:w="${wordNamespace}"><w:p><w:r><w:t>Footer</w:t></w:r></w:p></w:ftr>`;
const footnotesXml = `<w:footnotes xmlns:w="${wordNamespace}"><w:footnote w:id="-1"><w:p><w:r><w:t>separator</w:t></w:r></w:p></w:footnote><w:footnote w:id="7"><w:p><w:r><w:t>Footnote seven</w:t></w:r></w:p></w:footnote></w:footnotes>`;
const endnotesXml = `<w:endnotes xmlns:w="${wordNamespace}"><w:endnote w:id="8"><w:p><w:r><w:t>Endnote eight</w:t></w:r></w:p></w:endnote></w:endnotes>`;
const commentsXml = `<w:comments xmlns:w="${wordNamespace}"><w:comment w:id="9" w:author="Reviewer" w:date="2026-08-24T12:00:00Z"><w:p><w:r><w:t>Comment nine</w:t></w:r></w:p></w:comment></w:comments>`;

interface WordFixture {
	readonly bytes: Uint8Array;
	readonly inventory: ParadisOfficeInventory;
	readonly documentXml: string;
}

function documentXml(ids: { readonly prefix: string }): string {
	const id = (name: string) => `${ids.prefix}${name}`;
	return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:document xmlns:w="${wordNamespace}" xmlns:r="${relationshipNamespace}" xmlns:wp="${drawingWordprocessingNamespace}" xmlns:a="${drawingNamespace}" xmlns:pic="${pictureNamespace}" xmlns:m="${mathNamespace}" xmlns:v="${vmlNamespace}" xmlns:w14="http://schemas.microsoft.com/office/word/2010/wordml">
	<w:body>
		<w:p><w:bookmarkStart w:id="20" w:name="mark"/><w:r><w:t>Body</w:t><w:tab/><w:br w:type="page"/><w:sym w:font="Wingdings" w:char="F0FC"/></w:r>
			<w:hyperlink r:id="${id('Link')}"><w:r><w:t>link</w:t></w:r></w:hyperlink><w:bookmarkEnd w:id="20"/>
			<w:fldSimple w:instr=" PAGE "><w:r><w:t>1</w:t></w:r></w:fldSimple>
			<w:r><w:fldChar w:fldCharType="begin"/></w:r><w:r><w:instrText> DATE </w:instrText></w:r><w:r><w:fldChar w:fldCharType="separate"/></w:r><w:r><w:t>saved</w:t></w:r><w:r><w:fldChar w:fldCharType="end"/></w:r>
			<m:oMath><m:r><m:t>x+y</m:t></m:r></m:oMath><w:ins w:id="30" w:author="A"><w:r><w:t>inserted</w:t></w:r></w:ins><w:del w:id="31" w:author="B"><w:r><w:delText>deleted</w:delText></w:r></w:del>
			<w:r><w:drawing><wp:inline distT="5" distB="6" distL="7" distR="8"><wp:extent cx="111" cy="222"/><a:graphic><a:graphicData><pic:pic><pic:blipFill><a:blip r:embed="${id('Image')}"/></pic:blipFill><pic:spPr><a:xfrm rot="60000" flipH="0" flipV="1"><a:off x="10" y="20"/><a:ext cx="30" cy="40"/></a:xfrm><a:prstGeom prst="rect"><a:avLst/></a:prstGeom><a:ln w="9"><a:prstDash val="solid"/></a:ln></pic:spPr></pic:pic></a:graphicData></a:graphic></wp:inline></w:drawing></w:r>
			<w:r><w:pict><v:shape id="legacy-image"><v:imagedata r:id="${id('Image')}"/></v:shape></w:pict></w:r>
			<w:r><w:footnoteReference w:id="7"/><w:endnoteReference w:id="8"/><w:commentReference w:id="9"/></w:r><w:commentRangeStart w:id="9"/><w:commentRangeEnd w:id="9"/>
		</w:p>
		<w:sdt><w:sdtPr><w:alias w:val="Control"/><w:tag w:val="tag-1"/><w:lock w:val="sdtLocked"/></w:sdtPr><w:sdtContent><w:p><w:r><w:t>Controlled</w:t></w:r></w:p></w:sdtContent></w:sdt>
		<w:tbl><w:tblPr><w:tblBorders><w:tl2br w:val="dashDot" w:sz="13" w:space="2" w:color="80A0B0" w:themeColor="accent2"/></w:tblBorders></w:tblPr><w:tr><w:tc><w:p><w:r><w:t>Cell</w:t></w:r></w:p><w:tbl><w:tblPr><w:tblBorders><w:tr2bl w:val="double" w:color="010203"/></w:tblBorders></w:tblPr><w:tr><w:tc><w:p><w:r><w:t>Nested</w:t></w:r></w:p></w:tc></w:tr></w:tbl></w:tc></w:tr></w:tbl>
		<w:altChunk r:id="${id('Chunk')}"/><w14:contentPart r:id="${id('Unknown')}"/>
		<w:pict><v:shape id="body-textbox" style="position:absolute;left:5pt;top:6pt;width:7pt;height:8pt"><v:textbox><w:txbxContent><w:p><w:r><w:t>Body box</w:t></w:r></w:p></w:txbxContent></v:textbox></v:shape></w:pict>
		<w:sectPr><w:headerReference w:type="default" r:id="${id('Header')}"/><w:headerReference w:type="first" r:id="${id('Header')}"/><w:headerReference w:type="even" r:id="${id('Header')}"/><w:footerReference w:type="default" r:id="${id('Footer')}"/></w:sectPr>
	</w:body>
</w:document>`;
}

async function createWordFixture(prefix = 'rId'): Promise<WordFixture> {
	const mainDocument = documentXml({ prefix });
	const id = (name: string) => `${prefix}${name}`;
	const bytes = await buildOpcFixture({
		parts: [
			['/word/document.xml', mainDocument, 'application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml'],
			['/word/header1.xml', headerXml, 'application/vnd.openxmlformats-officedocument.wordprocessingml.header+xml'],
			['/word/footer1.xml', footerXml, 'application/vnd.openxmlformats-officedocument.wordprocessingml.footer+xml'],
			['/word/footnotes.xml', footnotesXml, 'application/vnd.openxmlformats-officedocument.wordprocessingml.footnotes+xml'],
			['/word/endnotes.xml', endnotesXml, 'application/vnd.openxmlformats-officedocument.wordprocessingml.endnotes+xml'],
			['/word/comments.xml', commentsXml, 'application/vnd.openxmlformats-officedocument.wordprocessingml.comments+xml'],
			['/word/media/image1.png', new Uint8Array([137, 80, 78, 71]), 'image/png'],
			['/word/chunk1.html', '<p>Chunk</p>', 'text/html'],
		],
		relationships: [
			{ id: 'rIdRoot', type: officeDocumentRelationship, target: 'word/document.xml' },
			{ source: '/word/document.xml', id: id('Header'), type: headerRelationship, target: 'header1.xml' },
			{ source: '/word/document.xml', id: id('Footer'), type: footerRelationship, target: 'footer1.xml' },
			{ source: '/word/document.xml', id: id('Footnotes'), type: footnotesRelationship, target: 'footnotes.xml' },
			{ source: '/word/document.xml', id: id('Endnotes'), type: endnotesRelationship, target: 'endnotes.xml' },
			{ source: '/word/document.xml', id: id('Comments'), type: commentsRelationship, target: 'comments.xml' },
			{ source: '/word/document.xml', id: id('Link'), type: hyperlinkRelationship, target: 'https://example.invalid', targetMode: 'External' },
			{ source: '/word/document.xml', id: id('Image'), type: imageRelationship, target: 'media/image1.png' },
			{ source: '/word/document.xml', id: id('Chunk'), type: altChunkRelationship, target: 'chunk1.html' },
		],
	});
	const inventory = await inspectOfficePackage(await createParadisOfficeNodeArchive(bytes), PARADIS_OFFICE_BUDGET_PROFILES.desktopLocal, CancellationToken.None);
	return { bytes, inventory, documentXml: mainDocument };
}

function flatten(nodes: readonly ParadisWordNode[]): ParadisWordNode[] {
	const result: ParadisWordNode[] = [];
	for (const node of nodes) {
		result.push(node);
		if (node.children) {
			result.push(...flatten(node.children));
		}
	}
	return result;
}

function sha256(value: string): string {
	return createHash('sha256').update(new TextEncoder().encode(value)).digest('hex');
}

suite('ParadisWordSemanticParser', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	test('separates ordered body, shared header, footer, note, comment, and textbox stories', async () => {
		const fixture = await createWordFixture();
		const document = await parseWordSemantic(await createParadisOfficeNodeArchive(fixture.bytes), fixture.inventory, CancellationToken.None);

		deepStrictEqual(document.stories.map(story => story.address.kind), [
			'body', 'header', 'footer', 'footnote', 'endnote', 'comment', 'textbox', 'textbox',
		]);
		deepStrictEqual(document.stories.map(story => story.text), [
			'Bodylink1savedx+yinserteddeletedControlledCellNested', 'Shared header', 'Footer', 'Footnote seven', 'Endnote eight', 'Comment nine', 'Body box', 'Header box',
		]);
		const header = document.stories.find(story => story.address.kind === 'header')!;
		deepStrictEqual(header.address.roles, ['default', 'first', 'even']);
		deepStrictEqual(document.storyReferences.map(reference => [reference.kind, reference.role, reference.storyId, reference.sectionOrdinal]), [
			['header', 'default', header.id, 0], ['header', 'first', header.id, 0], ['header', 'even', header.id, 0],
			['footer', 'default', document.stories.find(story => story.address.kind === 'footer')!.id, 0],
		]);
		strictEqual(new Set(document.storyReferences.slice(0, 3).map(reference => reference.storyId)).size, 1);
	});

	test('builds every Task 1 block and inline node without flattening source order', async () => {
		const fixture = await createWordFixture();
		const document = await parseWordSemantic(await createParadisOfficeNodeArchive(fixture.bytes), fixture.inventory, CancellationToken.None);
		const body = document.stories[0];
		const nodes = flatten(body.nodes);

		deepStrictEqual(body.nodes.map(node => node.kind), ['section']);
		deepStrictEqual(nodes.filter(node => node.kind !== 'section').map(node => node.kind), [
			'paragraph', 'bookmark', 'text', 'tab', 'break', 'symbol', 'hyperlink', 'paragraph', 'text', 'bookmark',
			'field', 'paragraph', 'text', 'field', 'text', 'omml', 'revision', 'paragraph', 'text', 'revision', 'paragraph', 'text',
			'drawing', 'image', 'image', 'noteReference', 'noteReference', 'commentReference', 'commentReference', 'commentReference',
			'contentControl', 'paragraph', 'text', 'table', 'row', 'cell', 'paragraph', 'text', 'table', 'row', 'cell', 'paragraph', 'text', 'altChunk', 'unknownBlock', 'unknownBlock',
		]);
		const breakNode = nodes.find(node => node.kind === 'break');
		strictEqual(breakNode?.kind === 'break' ? breakNode.breakType : undefined, 'page');
		const fieldNodes = nodes.filter(node => node.kind === 'field');
		deepStrictEqual(fieldNodes.map(node => node.kind === 'field' ? [node.fieldKind, node.instruction, node.savedResult] : []), [
			['simple', ' PAGE ', '1'], ['complex', ' DATE ', 'saved'],
		]);
		const chunk = nodes.find(node => node.kind === 'altChunk');
		deepStrictEqual(chunk?.kind === 'altChunk' ? [chunk.targetPartUri, chunk.contentType] : undefined, ['/word/chunk1.html', 'text/html']);
		deepStrictEqual(nodes.filter(node => node.kind === 'image').map(node => node.kind === 'image' ? [node.targetPartUri, node.external] : []), [
			['/word/media/image1.png', false], ['/word/media/image1.png', false],
		]);
	});

	test('retains exact DrawingML placement and table diagonal provenance without normalization', async () => {
		const fixture = await createWordFixture();
		const document = await parseWordSemantic(await createParadisOfficeNodeArchive(fixture.bytes), fixture.inventory, CancellationToken.None);
		const header = document.stories.find(story => story.address.kind === 'header')!;
		const drawing = flatten(header.nodes).find((node): node is ParadisWordDrawingNode => node.kind === 'drawing')!;

		deepStrictEqual(drawing.geometry, {
			placement: 'anchor',
			distances: { top: '0', bottom: '1', left: '2', right: '3' },
			simplePosition: { x: '11', y: '22' },
			horizontalPosition: { relativeFrom: 'page', align: 'center' },
			verticalPosition: { relativeFrom: 'paragraph', offset: '-25400' },
			extent: { cx: '914400', cy: '457200' },
			effectExtent: { left: '31', top: '32', right: '33', bottom: '34' },
			wrap: { kind: 'square', wrapText: 'bothSides', distances: { top: '41', bottom: '42', left: '43', right: '44' } },
			transform: { rotation: '5400000', flipHorizontal: '1', flipVertical: '0', offset: { x: '100', y: '200' }, extent: { cx: '300', cy: '400' } },
			presetGeometry: 'line',
			line: { width: '12700', presetDash: 'dashDot', cap: 'rnd', compound: 'dbl', alignment: 'ctr', headEnd: { type: 'triangle', width: 'sm', length: 'lg' }, tailEnd: { type: 'oval', width: 'med', length: 'sm' } },
			anchorProperties: { simplePosition: '0', relativeHeight: '251658240', behindDocument: '0', locked: '1', layoutInCell: '1', allowOverlap: '0' },
			sourcePartFingerprint: { algorithm: 'sha256', value: sha256(headerXml), byteLength: new TextEncoder().encode(headerXml).byteLength },
		});
		const tables = flatten(document.stories[0].nodes).filter((node): node is ParadisWordTableNode => node.kind === 'table');
		const table = tables[0];
		deepStrictEqual(table.diagonalBorders, [{
			direction: 'topLeftToBottomRight', value: 'dashDot', size: '13', space: '2', color: '80A0B0', themeColor: 'accent2',
			sourceSemanticPath: table.source.semanticPath,
			sourcePartFingerprint: { algorithm: 'sha256', value: sha256(fixture.documentXml), byteLength: new TextEncoder().encode(fixture.documentXml).byteLength },
		}]);
		deepStrictEqual(tables[1].diagonalBorders, [{
			direction: 'topRightToBottomLeft', value: 'double', color: '010203', sourceSemanticPath: tables[1].source.semanticPath,
			sourcePartFingerprint: { algorithm: 'sha256', value: sha256(fixture.documentXml), byteLength: new TextEncoder().encode(fixture.documentXml).byteLength },
		}]);
		strictEqual(drawing.source.partFingerprint.value, sha256(headerXml));
		strictEqual(table.source.partFingerprint.value, sha256(fixture.documentXml));
		const headerTextbox = document.stories.find(story => story.address.kind === 'textbox' && story.text === 'Header box')!;
		deepStrictEqual(headerTextbox.address.textboxGeometry, {
			container: 'vmlShape',
			shapeId: 'header-textbox',
			rawStyle: 'position:absolute;left:1pt;top:2pt;width:3pt;height:4pt;rotation:45',
			sourcePartFingerprint: { algorithm: 'sha256', value: sha256(headerXml), byteLength: new TextEncoder().encode(headerXml).byteLength },
		});
	});

	test('assigns part/path/kind/ordinal/fingerprint anchors whose identities do not depend on rId spelling', async () => {
		const firstFixture = await createWordFixture('rId');
		const secondFixture = await createWordFixture('relationship-');
		const first = await parseWordSemantic(await createParadisOfficeNodeArchive(firstFixture.bytes), firstFixture.inventory, CancellationToken.None);
		const second = await parseWordSemantic(await createParadisOfficeNodeArchive(secondFixture.bytes), secondFixture.inventory, CancellationToken.None);
		const reindentedZip = await JSZip.loadAsync(firstFixture.bytes);
		const main = reindentedZip.file('word/document.xml')!;
		reindentedZip.file('word/document.xml', firstFixture.documentXml.replace(/\n\t*/g, '\n        '), { createFolders: false, date: main.date });
		const reindentedBytes = await reindentedZip.generateAsync({ comment: '', compression: 'STORE', platform: 'DOS', type: 'uint8array' });
		const reindentedInventory = await inspectOfficePackage(await createParadisOfficeNodeArchive(reindentedBytes), PARADIS_OFFICE_BUDGET_PROFILES.desktopLocal, CancellationToken.None);
		const reindented = await parseWordSemantic(await createParadisOfficeNodeArchive(reindentedBytes), reindentedInventory, CancellationToken.None);

		deepStrictEqual(first.stories.map(story => story.id), second.stories.map(story => story.id));
		deepStrictEqual(first.stories.map(story => flatten(story.nodes).map(node => node.id)), second.stories.map(story => flatten(story.nodes).map(node => node.id)));
		deepStrictEqual(first.stories.map(story => flatten(story.nodes).map(node => node.id)), reindented.stories.map(story => flatten(story.nodes).map(node => node.id)));
		for (const story of first.stories) {
			for (const node of flatten(story.nodes)) {
				deepStrictEqual(node.anchor, {
					partUri: node.source.partUri,
					semanticPath: node.source.semanticPath,
					kind: node.source.kind,
					ordinal: node.source.ordinal,
					fingerprint: node.source.fingerprint,
				});
				strictEqual(node.source.partFingerprint.algorithm, 'sha256');
			}
		}
	});

	test('owns Node inputs synchronously and rejects mutated raw authority, cancellation, deadlines, and accessors', async () => {
		const fixture = await createWordFixture();
		const callerBytes = fixture.bytes.slice();
		const parsing = parseWordSemanticNode(callerBytes, fixture.inventory, CancellationToken.None);
		callerBytes.fill(0);
		(fixture.inventory.parts as ParadisOfficeInventory['parts'][number][])[0] = { ...fixture.inventory.parts[0], contentType: 'application/x-mutated' };
		strictEqual((await parsing).stories[0].address.kind, 'body');

		const fresh = await createWordFixture();
		const zip = await JSZip.loadAsync(fresh.bytes);
		const contentTypes = zip.file('[Content_Types].xml')!;
		zip.file('[Content_Types].xml', (await contentTypes.async('text')).replace('wordprocessingml.document.main+xml', 'octet-stream____________________________'), { createFolders: false, date: contentTypes.date });
		const mutated = await zip.generateAsync({ comment: '', compression: 'STORE', platform: 'DOS', type: 'uint8array' });
		await rejects(
			parseWordSemantic(await createParadisOfficeNodeArchive(mutated), fresh.inventory, CancellationToken.None),
			error => error instanceof ParadisOfficePackageError && error.code === 'unsafe',
		);

		const cancelled = new CancellationTokenSource();
		cancelled.cancel();
		await rejects(parseWordSemanticNode(fresh.bytes, fresh.inventory, cancelled.token), /cancelled/);
		cancelled.dispose();

		let now = 0;
		await rejects(
			parseWordSemanticNode(fresh.bytes, fresh.inventory, CancellationToken.None, { deadlineMilliseconds: 1, now: () => now += 2 }),
			error => error instanceof ParadisOfficePackageError && error.code === 'limitExceeded',
		);

		let getterReads = 0;
		const options = {};
		Object.defineProperty(options, 'deadlineMilliseconds', { get: () => { getterReads++; return 1; } });
		await rejects(parseWordSemanticNode(fresh.bytes, fresh.inventory, CancellationToken.None, options), /unsafe/);
		strictEqual(getterReads, 0);

		let inventoryReads = 0;
		const oversizedInventory = new Proxy(fresh.inventory, {
			getOwnPropertyDescriptor: (target, property) => { inventoryReads++; return Reflect.getOwnPropertyDescriptor(target, property); },
		});
		await rejects(
			parseWordSemanticNode(new Uint8Array(PARADIS_OFFICE_BUDGET_PROFILES.desktopLocal.compressedInputBytes + 1), oversizedInventory),
			/limitExceeded/,
		);
		strictEqual(inventoryReads, 0);
	});

	test('requires a verified Word main relationship before reading story Parts', async () => {
		const fixture = await createWordFixture();
		const zip = await JSZip.loadAsync(fixture.bytes);
		const relationships = zip.file('_rels/.rels')!;
		const rootXml = await relationships.async('text');
		strictEqual(rootXml.includes(packageRelationshipNamespace), true);
		zip.file('_rels/.rels', rootXml.replace(officeDocumentRelationship, `${relationshipNamespace}/theme`), { createFolders: false, date: relationships.date });
		const mutated = await zip.generateAsync({ comment: '', compression: 'STORE', platform: 'DOS', type: 'uint8array' });

		await rejects(
			parseWordSemantic(await createParadisOfficeNodeArchive(mutated), fixture.inventory, CancellationToken.None),
			error => error instanceof ParadisOfficePackageError && error.code === 'unsafe',
		);

		const forgedStoryRelationshipInventory: ParadisOfficeInventory = {
			...fixture.inventory,
			relationships: [...fixture.inventory.relationships, {
				id: 'rIdForgedHeaderLink', sourcePartId: '/word/header1.xml', type: hyperlinkRelationship,
				target: 'https://forged.invalid', targetMode: 'external', missing: false, cyclic: false,
			}],
		};
		await rejects(
			parseWordSemantic(await createParadisOfficeNodeArchive(fixture.bytes), forgedStoryRelationshipInventory, CancellationToken.None),
			error => error instanceof ParadisOfficePackageError && error.code === 'unsafe',
		);
	});
});
