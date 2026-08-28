/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import { deepStrictEqual, ok, strictEqual } from 'assert';
import { readFile } from 'fs/promises';
import JSZip from 'jszip';
import { encodeBase64, VSBuffer } from '../../../../../base/common/buffer.js';
import { CancellationToken } from '../../../../../base/common/cancellation.js';
import { join } from '../../../../../base/common/path.js';
import { hasKey } from '../../../../../base/common/types.js';
import { URI } from '../../../../../base/common/uri.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { ParadisOfficePackageError, type ParadisOfficeXmlNode } from '../../common/office/paradisOfficeArchive.js';
import { canonicalizeOfficeXml, parseParadisOfficeXml } from '../../common/office/paradisOfficeCanonicalXml.js';
import type { IConfigurationService } from '../../../../../platform/configuration/common/configuration.js';
import { Extensions as ConfigurationExtensions, IConfigurationRegistry } from '../../../../../platform/configuration/common/configurationRegistry.js';
import type { IInstantiationService } from '../../../../../platform/instantiation/common/instantiation.js';
import { Registry } from '../../../../../platform/registry/common/platform.js';
import type { IEditorFactoryRegistry } from '../../../../../workbench/common/editor.js';
import type { IEditorResolverService } from '../../../../../workbench/services/editor/common/editorResolverService.js';
import {
	PARADIS_DOCX_VIEWER_REGISTRATION,
	PARADIS_OFFICE_BROWSER_VIEWER_REGISTRATION,
	PARADIS_SPREADSHEET_VIEWER_REGISTRATION,
	registerParadisOfficeViewerSerializers,
} from '../../browser/paradisOfficeConfiguration.js';
import { ParadisOfficeBrowserViewerResolverContribution } from '../../browser/paradisOfficeBrowser.contribution.js';
import { ParadisOfficeDiagnosticInput } from '../../browser/paradisOfficeDiagnosticInput.js';
import { sanitizeParadisDocxBytesForRenderer } from '../../electron-browser/paradisDocxDiffWebview.js';
import {
	createParadisOfficeSearchPrintCallbacks,
	ParadisOfficeConfigurationReader,
	snapshotParadisOfficeRuntimeConfiguration,
} from '../../common/paradisOfficeCapabilities.js';
import { canReportNoChanges, PARADIS_OFFICE_BUDGET_PROFILES } from '../../common/paradisOfficeProtocol.js';
import { inspectOfficePackage } from '../../common/office/paradisOfficePackageCore.js';
import { fingerprintSpreadsheetObjectBytes, parseSpreadsheetObjects, type ParadisSpreadsheetObjectPartInput } from '../../common/spreadsheet/paradisSpreadsheetObjectParser.js';
import { fingerprintParadisWordObjectBytes, parseParadisWordObjects } from '../../common/word/paradisWordObjects.js';
import { createParadisOfficeNodeArchive } from '../../node/office/paradisOfficeNodeArchive.js';
import { ParadisSpreadsheetService } from '../../node/paradisSpreadsheetService.js';
import { parseSpreadsheetSemanticNode } from '../../node/spreadsheet/paradisSpreadsheetNodeAdapter.js';

const FIXTURE_DIRECTORY = join(process.cwd(), 'src/vs/paradis/contrib/fileViewers/test/common/fixtures');
const XML_LIMITS = { depth: 128, nodes: 500_000, attributeLength: 1024 * 1024, characters: 64 * 1024 * 1024 } as const;

type XmlElement = Extract<ParadisOfficeXmlNode, { readonly kind: 'element' }>;

class MutableConfigurationReader implements ParadisOfficeConfigurationReader {
	readonly values = new Map<string, unknown>();

	getValue<T>(key: string): T | undefined {
		return this.values.get(key) as T | undefined;
	}

	inspect<T>(_key: string): { readonly policyValue?: T } | undefined {
		return undefined;
	}
}

function elementChildren(element: XmlElement): readonly XmlElement[] {
	return element.children.filter((child): child is XmlElement => child.kind === 'element');
}

function containsLineGeometry(element: XmlElement): boolean {
	return element.uri === 'http://schemas.openxmlformats.org/drawingml/2006/main'
		&& element.local === 'prstGeom'
		&& element.attributes.some(attribute => attribute.uri === '' && attribute.local === 'prst' && attribute.value === 'line')
		|| elementChildren(element).some(containsLineGeometry);
}

function canonicalDrawingLineAnchor(xml: string): string {
	const anchors: XmlElement[] = [];
	const visit = (element: XmlElement): void => {
		if (element.uri === 'http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing'
			&& element.local === 'anchor'
			&& containsLineGeometry(element)) {
			anchors.push(element);
		}
		for (const child of elementChildren(element)) {
			visit(child);
		}
	};
	visit(parseParadisOfficeXml(xml, XML_LIMITS).root);
	strictEqual(anchors.length, 1);
	return canonicalizeOfficeXml({ root: anchors[0] }, () => undefined).canonical;
}

function normalizeOfficeCliXml(xml: string, spreadsheet = false): string {
	const normalized = xml.charCodeAt(0) === 0xFEFF ? xml.slice(1) : xml;
	return (spreadsheet ? normalized
		.replace('xmlns:x="http://schemas.openxmlformats.org/spreadsheetml/2006/main"', 'xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"')
		.replaceAll('<x:', '<').replaceAll('</x:', '</') : normalized)
		.replace('encoding="utf-8"', 'encoding="UTF-8"');
}

async function spreadsheetSupportedFixture(bytes: Uint8Array): Promise<Uint8Array> {
	const source = await JSZip.loadAsync(bytes);
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
	return output.generateAsync({ type: 'uint8array' });
}

async function wordSupportedFixture(bytes: Uint8Array): Promise<{ readonly bytes: Uint8Array; readonly documentXml: string }> {
	const source = await JSZip.loadAsync(bytes);
	const documentXml = normalizeOfficeCliXml(await source.file('word/document.xml')!.async('string'));
	const output = new JSZip();
	output.file('[Content_Types].xml', '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="png" ContentType="image/png"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>', { createFolders: false });
	output.file('_rels/.rels', '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="office" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>', { createFolders: false });
	output.file('word/document.xml', documentXml, { createFolders: false });
	output.file('word/_rels/document.xml.rels', '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="R7fb693fe671f49f2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" Target="media/image.png"/></Relationships>', { createFolders: false });
	output.file('word/media/image.png', await source.file('media/image.png')!.async('uint8array'), { createFolders: false });
	return { bytes: await output.generateAsync({ type: 'uint8array' }), documentXml };
}

async function spreadsheetObjectParts(bytes: Uint8Array): Promise<readonly ParadisSpreadsheetObjectPartInput[]> {
	const archive = await JSZip.loadAsync(bytes);
	const entries = Object.values(archive.files).filter(entry => !entry.dir).sort((left, right) => left.name.localeCompare(right.name));
	return Promise.all(entries.map(async entry => {
		const partBytes = await entry.async('uint8array');
		return { bytes: partBytes, source: { partId: `/${entry.name}`, fingerprint: fingerprintSpreadsheetObjectBytes(partBytes) } };
	}));
}

suite('ParadisOfficeDualRead', () => {
	const disposables = ensureNoDisposablesAreLeakedInTestSuite();

	test('preserves legacy spreadsheet values, styles, and effective base diagonal semantics while auditing unchanged overlays', async function () {
		this.timeout(10_000);
		const fixtureBytes = new Uint8Array(await readFile(join(FIXTURE_DIRECTORY, 'task2-diagonal-border.xlsx')));
		const bytes = await spreadsheetSupportedFixture(fixtureBytes);
		const legacy = await new ParadisSpreadsheetService().parseWorkbook(encodeBase64(VSBuffer.wrap(bytes)));
		const inventory = await inspectOfficePackage(
			await createParadisOfficeNodeArchive(bytes),
			PARADIS_OFFICE_BUDGET_PROFILES.desktopLocal,
			CancellationToken.None,
		);
		let semanticFailure: ParadisOfficePackageError | undefined;
		try {
			await parseSpreadsheetSemanticNode(bytes, inventory, CancellationToken.None, { projection: legacy });
		} catch (error) {
			ok(error instanceof ParadisOfficePackageError);
			semanticFailure = error;
		}
		const objects = parseSpreadsheetObjects({ parts: await spreadsheetObjectParts(bytes) });
		const legacyCell = legacy.sheets[0].rows[0].cells[0];

		deepStrictEqual({
			baseValue: legacyCell.value,
			baseShapes: legacy.sheets[0].shapes?.length ?? 0,
			objectCounts: { images: objects.images.length, drawings: objects.drawings.length, charts: objects.charts.length, opaque: objects.opaqueDrawings.length },
			v1Diagnostic: {
				code: semanticFailure?.code,
				outcome: semanticFailure?.code === 'unsafe' ? 'degraded' : 'complete',
				canReportNoChanges: canReportNoChanges(inventory.completeness, semanticFailure?.code === 'unsafe' ? 'degraded' : 'complete', 0),
			},
			drawingAudit: objects.images[0] && {
				kind: objects.images[0].kind,
				name: objects.images[0].name,
				description: objects.images[0].description,
				source: objects.images[0].source.partId,
				anchor: objects.images[0].anchor,
				transform: objects.images[0].transform,
				contentType: hasKey(objects.images[0].content, { contentType: true }) ? objects.images[0].content.contentType : undefined,
			},
		}, {
			baseValue: 'Diagonal border',
			baseShapes: 0,
			objectCounts: { images: 1, drawings: 0, charts: 0, opaque: 0 },
			v1Diagnostic: { code: 'unsafe', outcome: 'degraded', canReportNoChanges: false },
			drawingAudit: {
				kind: 'image',
				name: 'Picture 1',
				description: 'Fixture payload image',
				source: '/xl/drawings/drawing1.xml',
				anchor: {
					kind: 'twoCell',
					from: { column: 1, columnOffset: 0, row: 1, rowOffset: 0 },
					to: { column: 4, columnOffset: 0, row: 9, rowOffset: 0 },
				},
				transform: { offset: { x: 0, y: 0 }, extent: { cx: 0, cy: 0 } },
				contentType: 'image/png',
			},
		});
		deepStrictEqual({
			up: legacyCell.diagonal?.up,
			down: legacyCell.diagonal?.down,
			rawStyle: legacyCell.diagonal?.rawStyle,
			effectiveStyle: legacyCell.diagonal?.style,
			rawColor: legacyCell.diagonal?.rawColor,
			effectiveColor: legacyCell.diagonal?.color,
		}, {
			up: true,
			down: true,
			rawStyle: 'medium',
			effectiveStyle: '2px solid',
			rawColor: { kind: 'rgb', rgb: 'FF2F5597' },
			effectiveColor: '#2F5597',
		});
	});

	test('preserves the complete targeted Word Drawing subtree and audits every semantic object anchor', async function () {
		this.timeout(10_000);
		const fixture = await wordSupportedFixture(new Uint8Array(await readFile(join(FIXTURE_DIRECTORY, 'task2-drawing-line.docx'))));
		const sanitized = await sanitizeParadisDocxBytesForRenderer(fixture.bytes, 'dual-read-word');
		const sourceArchive = await JSZip.loadAsync(fixture.bytes);
		const v1Archive = await JSZip.loadAsync(sanitized.bytes);
		const v1Xml = await v1Archive.file('word/document.xml')!.async('string');
		const documentBytes = await sourceArchive.file('word/document.xml')!.async('uint8array');
		const relationshipBytes = await sourceArchive.file('word/_rels/document.xml.rels')!.async('uint8array');
		const imageBytes = await sourceArchive.file('word/media/image.png')!.async('uint8array');
		const objects = parseParadisWordObjects({
			document: {
				bytes: documentBytes,
				source: { partUri: '/word/document.xml', partFingerprint: fingerprintParadisWordObjectBytes(documentBytes) },
				contentType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml',
			},
			relationshipPart: {
				bytes: relationshipBytes,
				source: { partUri: '/word/_rels/document.xml.rels', partFingerprint: fingerprintParadisWordObjectBytes(relationshipBytes) },
				contentType: 'application/vnd.openxmlformats-package.relationships+xml',
			},
			relatedParts: [{
				bytes: imageBytes,
				source: { partUri: '/word/media/image.png', partFingerprint: fingerprintParadisWordObjectBytes(imageBytes) },
				contentType: 'image/png',
			}],
		});
		const drawingLine = objects.lines[0];

		strictEqual(canonicalDrawingLineAnchor(v1Xml), canonicalDrawingLineAnchor(fixture.documentXml));
		ok(drawingLine?.kind === 'line');
		deepStrictEqual({
			objectCounts: { images: objects.images.length, lines: objects.lines.length, math: objects.math.length },
			imageAnchor: objects.images[0] && {
				kind: objects.images[0].placement.kind,
				distances: objects.images[0].placement.distances,
				simplePosition: objects.images[0].placement.simplePosition,
				horizontalPosition: objects.images[0].placement.horizontalPosition,
				verticalPosition: objects.images[0].placement.verticalPosition,
				extent: objects.images[0].placement.extent,
				effectExtent: objects.images[0].placement.effectExtent,
				wrap: objects.images[0].placement.wrap,
				anchorProperties: objects.images[0].placement.anchorProperties,
			},
			label: drawingLine.geometry.preset === 'line' ? 'Drawing Line' : undefined,
			placement: {
				kind: drawingLine.placement.kind,
				distances: drawingLine.placement.distances,
				simplePosition: drawingLine.placement.simplePosition,
				horizontalPosition: drawingLine.placement.horizontalPosition,
				verticalPosition: drawingLine.placement.verticalPosition,
				extent: drawingLine.placement.extent,
				effectExtent: drawingLine.placement.effectExtent,
				wrap: drawingLine.placement.wrap,
				anchorProperties: drawingLine.placement.anchorProperties,
			},
			geometry: drawingLine.geometry,
		}, {
			objectCounts: { images: 1, lines: 1, math: 0 },
			imageAnchor: {
				kind: 'anchor',
				distances: { top: '0', bottom: '0', left: '114300', right: '114300' },
				simplePosition: { x: '0', y: '0' },
				horizontalPosition: { relativeFrom: 'margin', offset: '360000' },
				verticalPosition: { relativeFrom: 'paragraph', offset: '360000' },
				extent: { cx: '720000', cy: '720000' },
				effectExtent: { left: '0', top: '0', right: '0', bottom: '0' },
				wrap: { kind: 'square', wrapText: 'bothSides', distances: {} },
				anchorProperties: { simplePosition: '0', relativeHeight: '1', behindDocument: '0', locked: '0', layoutInCell: '1', allowOverlap: '1' },
			},
			label: 'Drawing Line',
			placement: {
				kind: 'anchor',
				distances: { top: '0', bottom: '0', left: '114300', right: '114300' },
				simplePosition: { x: '0', y: '0' },
				horizontalPosition: { relativeFrom: 'margin', offset: '720000' },
				verticalPosition: { relativeFrom: 'paragraph', offset: '1080000' },
				extent: { cx: '1800000', cy: '720000' },
				effectExtent: { left: '0', top: '0', right: '0', bottom: '0' },
				wrap: { kind: 'square', wrapText: 'bothSides', distances: {} },
				anchorProperties: { simplePosition: '0', relativeHeight: '251001', behindDocument: '0', locked: '0', layoutInCell: '1', allowOverlap: '1' },
			},
			geometry: {
				preset: 'line',
				transform: { rotation: '2700000', offset: { x: '0', y: '0' }, extent: { cx: '1800000', cy: '720000' } },
				line: { width: '25400' },
			},
		});
	});

	test('registers the safe legacy default, stable input type IDs, and their concrete serializers', async () => {
		const [spreadsheetInputModule, docxInputModule, browserInputModule] = await Promise.all([
			import('../../electron-browser/paradisSpreadsheetInput.js'),
			import('../../electron-browser/paradisDocxInput.js'),
			import('../../browser/paradisOfficeDiagnosticInput.js'),
		]);
		// engine/kernelShadow/platformBackend は設定UIに出さないので除外レジストリ側、
		// 設定ダイアログへ出した4件は通常のレジストリ側に載る。既定値はどちらも同じ意味なので束ねて見る。
		const configurationRegistry = Registry.as<IConfigurationRegistry>(ConfigurationExtensions.Configuration);
		const properties = {
			...configurationRegistry.getExcludedConfigurationProperties(),
			...configurationRegistry.getConfigurationProperties(),
		};
		const serializerRegistrations = new Map<string, unknown>();
		const serializerRegistry = {
			registerEditorSerializer: (inputTypeId: string, serializer: unknown) => {
				serializerRegistrations.set(inputTypeId, serializer);
				return { dispose: () => undefined };
			},
		} as unknown as Pick<IEditorFactoryRegistry, 'registerEditorSerializer'>;
		registerParadisOfficeViewerSerializers(serializerRegistry, spreadsheetInputModule.PARADIS_SPREADSHEET_SERIALIZER_REGISTRATIONS);
		registerParadisOfficeViewerSerializers(serializerRegistry, docxInputModule.PARADIS_DOCX_SERIALIZER_REGISTRATIONS);
		registerParadisOfficeViewerSerializers(serializerRegistry, browserInputModule.PARADIS_OFFICE_BROWSER_SERIALIZER_REGISTRATIONS);

		deepStrictEqual({
			engine: properties['paradis.officeViewer.engine']?.default,
			kernelShadow: properties['paradis.officeViewer.kernelShadow']?.default,
			semanticSpreadsheet: properties['paradis.officeViewer.semanticSpreadsheet']?.default,
			virtualizedSpreadsheet: properties['paradis.officeViewer.virtualizedSpreadsheet']?.default,
			semanticWord: properties['paradis.officeViewer.semanticWord']?.default,
			platformBackend: properties['paradis.officeViewer.platformBackend']?.default,
			searchPrint: properties['paradis.officeViewer.searchPrint']?.default,
		}, {
			engine: 'legacy', kernelShadow: false, semanticSpreadsheet: true, virtualizedSpreadsheet: true,
			semanticWord: true, platformBackend: true, searchPrint: true,
		});
		deepStrictEqual(PARADIS_SPREADSHEET_VIEWER_REGISTRATION, {
			extensions: ['.xlsx', '.xlsm', '.xltx', '.xltm'],
			schemes: ['file', 'vscode-remote', 'git'],
			editorId: 'paradis.editor.spreadsheet',
			diffEditorId: 'paradis.editor.spreadsheetDiff',
			inputTypeId: 'paradis.input.spreadsheet',
			diffInputTypeId: 'paradis.input.spreadsheetDiff',
		});
		deepStrictEqual(PARADIS_DOCX_VIEWER_REGISTRATION, {
			extensions: ['.docx', '.docm', '.dotx', '.dotm'],
			schemes: ['file', 'vscode-remote', 'git'],
			editorId: 'paradis.editor.docxPreview',
			diffEditorId: 'paradis.editor.docxDiff',
			inputTypeId: 'paradis.input.docxPreview',
			diffInputTypeId: 'paradis.input.docxDiff',
		});
		deepStrictEqual(PARADIS_OFFICE_BROWSER_VIEWER_REGISTRATION, {
			extensions: ['.xlsx', '.xlsm', '.xltx', '.xltm', '.docx', '.docm', '.dotx', '.dotm'],
			schemes: ['file', 'vscode-remote', 'git'],
			editorId: 'paradis.editor.officeBrowser',
			inputTypeId: 'paradis.input.officeBrowser',
		});
		deepStrictEqual([
			Object.getOwnPropertyDescriptor(spreadsheetInputModule.ParadisSpreadsheetInput.prototype, 'typeId')?.get?.call({}),
			Object.getOwnPropertyDescriptor(spreadsheetInputModule.ParadisSpreadsheetDiffInput.prototype, 'typeId')?.get?.call({}),
			Object.getOwnPropertyDescriptor(docxInputModule.ParadisDocxInput.prototype, 'typeId')?.get?.call({}),
			Object.getOwnPropertyDescriptor(docxInputModule.ParadisDocxDiffInput.prototype, 'typeId')?.get?.call({}),
			Object.getOwnPropertyDescriptor(browserInputModule.ParadisOfficeDiagnosticInput.prototype, 'typeId')?.get?.call({}),
		], [
			'paradis.input.spreadsheet',
			'paradis.input.spreadsheetDiff',
			'paradis.input.docxPreview',
			'paradis.input.docxDiff',
			'paradis.input.officeBrowser',
		]);
		for (const [inputTypeId, serializer] of [
			['paradis.input.spreadsheet', spreadsheetInputModule.ParadisSpreadsheetInputSerializer],
			['paradis.input.spreadsheetDiff', spreadsheetInputModule.ParadisSpreadsheetDiffInputSerializer],
			['paradis.input.docxPreview', docxInputModule.ParadisDocxInputSerializer],
			['paradis.input.docxDiff', docxInputModule.ParadisDocxDiffInputSerializer],
			['paradis.input.officeBrowser', browserInputModule.ParadisOfficeDiagnosticInputSerializer],
		] as const) {
			strictEqual(serializerRegistrations.get(inputTypeId), serializer);
		}
	});

	test('snapshots explicit v1 opens and engine=legacy bypasses semantic inputs and disables search and print', () => {
		const reader = new MutableConfigurationReader();
		reader.values.set('paradis.officeViewer.engine', 'v1');
		const firstOpen = snapshotParadisOfficeRuntimeConfiguration(reader);
		const resolverFactories: {
			createEditorInput(input: { readonly resource: URI; readonly options?: undefined }): { readonly editor: ParadisOfficeDiagnosticInput };
			createDiffEditorInput(input: { readonly original: { readonly resource: URI }; readonly modified: { readonly resource: URI }; readonly label?: string }): { readonly editor: ParadisOfficeDiagnosticInput };
		}[] = [];
		const semanticOpenCallbacks: string[] = [];
		const resolverService = {
			registerEditor: (_glob: string, _editor: unknown, _options: unknown, factories: typeof resolverFactories[number]) => {
				resolverFactories.push(factories);
				return { dispose: () => undefined };
			},
		};
		const instantiationService = {
			createInstance: (ctor: typeof ParadisOfficeDiagnosticInput, ...args: ConstructorParameters<typeof ParadisOfficeDiagnosticInput>) => {
				if (args[2] === 'semantic') {
					semanticOpenCallbacks.push(args[3] ? 'diff' : 'render');
				}
				return disposables.add(new ctor(...args));
			},
		};
		new ParadisOfficeBrowserViewerResolverContribution(
			resolverService as unknown as IEditorResolverService,
			instantiationService as unknown as IInstantiationService,
			reader as unknown as IConfigurationService,
		);
		const factories = resolverFactories[0];
		const original = URI.file('/workspace/original.xlsx');
		const modified = URI.file('/workspace/modified.xlsx');
		strictEqual(factories.createEditorInput({ resource: modified }).editor.mode, 'semantic');
		strictEqual(factories.createDiffEditorInput({ original: { resource: original }, modified: { resource: modified } }).editor.mode, 'semantic');
		deepStrictEqual(semanticOpenCallbacks, ['render', 'diff']);
		semanticOpenCallbacks.length = 0;

		reader.values.set('paradis.officeViewer.engine', 'legacy');
		reader.values.set('paradis.officeViewer.kernelShadow', true);
		const legacyOpen = snapshotParadisOfficeRuntimeConfiguration(reader);
		strictEqual(factories.createEditorInput({ resource: modified }).editor.mode, 'diagnostic');
		strictEqual(factories.createDiffEditorInput({ original: { resource: original }, modified: { resource: modified } }).editor.mode, 'diagnostic');
		deepStrictEqual(semanticOpenCallbacks, []);

		deepStrictEqual(firstOpen, {
			engine: 'v1', kernelShadow: false, semanticSpreadsheet: true, virtualizedSpreadsheet: true,
			semanticWord: true, platformBackend: true, searchPrint: true,
		});
		deepStrictEqual(legacyOpen, {
			engine: 'legacy', kernelShadow: true, semanticSpreadsheet: false, virtualizedSpreadsheet: false,
			semanticWord: false, platformBackend: false, searchPrint: false,
		});
		const enabledCallbackConstructions: string[] = [];
		const enabledCallbacks = createParadisOfficeSearchPrintCallbacks(firstOpen, true, {
			search: () => { enabledCallbackConstructions.push('search'); return () => undefined; },
			print: () => { enabledCallbackConstructions.push('print'); return () => undefined; },
		});
		strictEqual(typeof enabledCallbacks.search, 'function');
		strictEqual(typeof enabledCallbacks.print, 'function');
		deepStrictEqual(enabledCallbackConstructions, ['search', 'print']);
		const constructedCallbacks: string[] = [];
		const legacyCallbacks = createParadisOfficeSearchPrintCallbacks(legacyOpen, true, {
			search: () => { constructedCallbacks.push('search'); return () => undefined; },
			print: () => { constructedCallbacks.push('print'); return () => undefined; },
		});
		deepStrictEqual(legacyCallbacks, { search: undefined, print: undefined });
		deepStrictEqual(constructedCallbacks, []);
	});
});
