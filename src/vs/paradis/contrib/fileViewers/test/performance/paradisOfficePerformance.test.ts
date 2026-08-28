/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import { createHash } from 'crypto';
import { readFileSync } from 'fs';
import { cpus, release, totalmem } from 'os';
import { deepStrictEqual, ok, rejects, strictEqual } from 'assert';
import { importAMDNodeModule } from '../../../../../amdX.js';
import { mainWindow } from '../../../../../base/browser/window.js';
import { Emitter } from '../../../../../base/common/event.js';
import { VSBuffer } from '../../../../../base/common/buffer.js';
import { CancellationToken, CancellationTokenSource } from '../../../../../base/common/cancellation.js';
import { toDisposable, type IDisposable } from '../../../../../base/common/lifecycle.js';
import { StopWatch } from '../../../../../base/common/stopwatch.js';
import { BufferWriter, serialize } from '../../../../../base/parts/ipc/common/ipc.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { PARADIS_OFFICE_BUDGET_PROFILES, PARADIS_OFFICE_LIMITS } from '../../common/paradisOfficeProtocol.js';
import { sanitizeOfficeDocxPackageForRenderer, sanitizeOfficeSvg, type ParadisOfficePackageArchive } from '../../common/paradisOfficeSanitizer.js';
import { ParadisOfficePackageError, type ParadisOfficeArchiveEntry } from '../../common/office/paradisOfficeArchive.js';
import { inspectOfficePackage } from '../../common/office/paradisOfficePackageCore.js';
import { compareWordSemantics } from '../../common/word/paradisWordSemanticDiff.js';
import { OfficeHandleStore } from '../../node/office/paradisOfficeHandleStore.js';
import { createParadisOfficeNodeArchive } from '../../node/office/paradisOfficeNodeArchive.js';
import { OfficeMemoryAccountant, OfficeWorkerHost, type IOfficeWorker } from '../../node/office/paradisOfficeWorkerHost.js';
import { ParadisOfficeSpoolTransport, SpoolAwareParadisOfficeSourceResolver } from '../../node/paradisOfficeChannel.js';
import { OfficeSpoolStore } from '../../node/paradisOfficeSpoolStore.js';
import { parseWordSemanticNode } from '../../node/word/paradisWordNodeAdapter.js';
import { ParadisSpreadsheetGridRenderer, type ParadisSpreadsheetGridCell, type ParadisSpreadsheetGridTile } from '../../electron-browser/spreadsheet/paradisSpreadsheetGridRenderer.js';
import { ParadisSpreadsheetViewport, type ParadisSpreadsheetTileRequest } from '../../electron-browser/spreadsheet/paradisSpreadsheetViewport.js';
import { buildShapeOverlay } from '../../electron-browser/paradisSpreadsheetRender.js';
import { computePageLayout, pageRectangles } from '../../common/paradisSpreadsheetPageLayout.js';
import { assertParadisOfficeSerializedGeometryGolden } from '../visual/paradisOfficeVisualGolden.js';
import { buildOpcFixture } from '../common/paradisOfficeFixture.js';

interface IFixtureCase {
	readonly id: string;
	readonly rows: number;
	readonly columns: number;
	readonly pages: number;
}

interface IFixtureDocument {
	readonly schema: 2;
	readonly caseHash: string;
	readonly serializedGeometryHash: string;
	readonly attachedPaintBaseline: {
		readonly environmentIdentity: string;
		readonly rendererSourceSha256: string;
		readonly rendererCompiledSha256: string;
		readonly calibration: {
			readonly measuredAt: string;
			readonly measurementIterations: 41;
			readonly samplesMilliseconds: readonly number[];
			readonly medianMilliseconds: number;
			readonly requestedRegressionPercent: 10;
			readonly validation: 'identity-and-threshold';
		};
	};
	readonly cases: readonly IFixtureCase[];
	readonly resourcePeak: { readonly workerBytes: number; readonly cacheBytes: number; readonly spoolBytes: number; readonly totalBytes: number };
	readonly serializedGeometry: { readonly regions: readonly { readonly id: string; readonly serializedGeometryBytes: number; readonly requiredLandmarks: readonly string[]; readonly goldenGeometry: string; readonly rawGeometryHash: string }[] };
}

class FakeClock {
	private now = 0;
	private readonly timers = new Map<number, { readonly at: number; readonly runner: () => void }>();
	private sequence = 0;
	read = (): number => this.now;
	setTimeout = (runner: () => void, delay: number): number => {
		const id = this.sequence++;
		this.timers.set(id, { at: this.now + delay, runner });
		return id;
	};
	clearTimeout = (id: unknown): void => { if (typeof id === 'number') { this.timers.delete(id); } };
	advance(milliseconds: number): void {
		this.now += milliseconds;
		for (const [id, timer] of [...this.timers]) {
			if (timer.at <= this.now) { this.timers.delete(id); timer.runner(); }
		}
	}
}

class FakeWorker implements IOfficeWorker {
	terminated = false;
	private readonly messages = new Emitter<unknown>();
	private readonly errors = new Emitter<unknown>();
	private readonly exits = new Emitter<number>();
	constructor(private readonly acknowledgeCancellation = false) { }
	postMessage(message: unknown): void {
		const kind = message && typeof message === 'object' ? Object.getOwnPropertyDescriptor(message, 'kind')?.value : undefined;
		const requestId = message && typeof message === 'object' ? Object.getOwnPropertyDescriptor(message, 'requestId')?.value : undefined;
		if (this.acknowledgeCancellation && kind === 'cancel' && typeof requestId === 'string') {
			this.messages.fire({ kind: 'cancelled', requestId });
		}
	}
	terminate(): Promise<number> { this.terminated = true; this.exits.fire(1); return Promise.resolve(1); }
	onMessage(listener: (message: unknown) => void): IDisposable { return this.messages.event(listener); }
	onError(listener: (error: unknown) => void): IDisposable { return this.errors.event(listener); }
	onExit(listener: (code: number) => void): IDisposable { return this.exits.event(listener); }
	fail(): void { this.errors.fire(new Error('fixture worker crash')); }
}

class FixtureArchive implements ParadisOfficePackageArchive {
	readonly containerByteLength = 4;
	private readonly encoder = new TextEncoder();
	constructor(private readonly values: Readonly<Record<string, string>>) { }
	async *entries(): AsyncIterable<ParadisOfficeArchiveEntry> {
		for (const [name, content] of Object.entries(this.values)) {
			const bytes = this.encoder.encode(content);
			yield { name, compressedBytes: bytes.byteLength, declaredExpandedBytes: bytes.byteLength, crc32: crc32(bytes), encrypted: false, directory: false, symlink: false };
		}
	}
	async *read(entry: ParadisOfficeArchiveEntry): AsyncIterable<Uint8Array> { yield this.encoder.encode(this.values[entry.name] ?? ''); }
	dispose(): void { }
}

function crc32(bytes: Uint8Array): number {
	let value = 0xffffffff;
	for (const byte of bytes) {
		value ^= byte;
		for (let bit = 0; bit < 8; bit++) { value = (value >>> 1) ^ (value & 1 ? 0xedb88320 : 0); }
	}
	return (value ^ 0xffffffff) >>> 0;
}

function loadFixtures(): IFixtureDocument {
	const text = readFileSync('src/vs/paradis/contrib/fileViewers/test/visual/fixtures.json', 'utf8');
	return JSON.parse(text) as IFixtureDocument;
}

function sha256File(path: string): string {
	return createHash('sha256').update(readFileSync(path)).digest('hex');
}

function rendererEnvironmentIdentity(): string {
	const cpu = cpus()[0]?.model ?? 'unknown';
	const memoryGiB = Math.round(totalmem() / (1024 * 1024 * 1024));
	return [
		`platform=${process.platform}`,
		`arch=${process.arch}`,
		`release=${release()}`,
		`cpu=${cpu}`,
		`cores=${cpus().length}`,
		`memoryGiB=${memoryGiB}`,
		`node=${process.versions.node}`,
		`electron=${process.versions.electron ?? 'none'}`,
		`chrome=${process.versions.chrome ?? 'none'}`,
	].join('|');
}

function median(values: readonly number[]): number {
	const sorted = [...values].sort((left, right) => left - right);
	return sorted[Math.floor(sorted.length / 2)];
}

async function parseActualWordFixture(text: string) {
	const wordNamespace = 'http://schemas.openxmlformats.org/wordprocessingml/2006/main';
	const relationshipNamespace = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';
	const bytes = await buildOpcFixture({
		parts: [['/word/document.xml', `<w:document xmlns:w="${wordNamespace}"><w:body><w:p><w:r><w:t>${text}</w:t></w:r></w:p></w:body></w:document>`, 'application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml']],
		relationships: [
			{ id: 'rIdRoot', type: `${relationshipNamespace}/officeDocument`, target: 'word/document.xml' },
			{ source: '/word/document.xml', id: 'rIdUnused', type: `${relationshipNamespace}/hyperlink`, target: 'https://example.invalid', targetMode: 'External' },
		],
	});
	const inventory = await inspectOfficePackage(await createParadisOfficeNodeArchive(bytes), PARADIS_OFFICE_BUDGET_PROFILES.desktopLocal, CancellationToken.None);
	return parseWordSemanticNode(bytes, inventory, CancellationToken.None);
}

async function deflateOpcFixture(bytes: Uint8Array): Promise<Uint8Array> {
	const JSZip = await importAMDNodeModule<typeof import('jszip')>('jszip', 'dist/jszip.min.js');
	const zip = await JSZip.loadAsync(bytes);
	return zip.generateAsync({ comment: '', compression: 'DEFLATE', compressionOptions: { level: 6 }, platform: 'DOS', type: 'uint8array' });
}

async function exactRatioOpcFixture(extraPaddingByte = 0, diluteAggregate = false): Promise<Uint8Array> {
	const JSZip = await importAMDNodeModule<typeof import('jszip')>('jszip', 'dist/jszip.min.js');
	const zip = new JSZip();
	const timestamp = new Date(1980, 0, 1, 0, 0, 0);
	const entries: readonly (readonly [string, string | Uint8Array])[] = [
		['[Content_Types].xml', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Override PartName="/padding.bin" ContentType="application/octet-stream"/>${diluteAggregate ? '<Override PartName="/dilution.bin" ContentType="application/octet-stream"/>' : ''}<Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>${' '.repeat(31_153)}</Types>`],
		['_rels/.rels', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="root" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>${' '.repeat(21_903)}</Relationships>`],
		['word/document.xml', `<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>${' '.repeat(12_787)}</w:body></w:document>`],
		['padding.bin', deterministicRatioPayload(17_800 + extraPaddingByte, 100)],
		...(diluteAggregate ? [['dilution.bin', deterministicRatioPayload(1_024, 1_024)] as const] : []),
	];
	for (const [name, value] of entries) { zip.file(name, value, { createFolders: false, date: timestamp }); }
	return zip.generateAsync({ comment: '', compression: 'DEFLATE', compressionOptions: { level: 6 }, platform: 'DOS', type: 'uint8array' });
}

async function actualArchiveStats(bytes: Uint8Array): Promise<{
	readonly entries: readonly ParadisOfficeArchiveEntry[];
	readonly compressedTotal: number;
	readonly expandedTotal: number;
	readonly bodyTotal: number;
}> {
	const archive = await createParadisOfficeNodeArchive(bytes);
	try {
		strictEqual(archive.containerByteLength, bytes.byteLength);
		const entries: ParadisOfficeArchiveEntry[] = [];
		for await (const entry of archive.entries()) { entries.push(entry); }
		let bodyTotal = 0;
		for (const entry of entries) {
			let bodyBytes = 0;
			for await (const chunk of archive.read(entry)) { bodyBytes += chunk.byteLength; }
			strictEqual(bodyBytes, entry.declaredExpandedBytes, entry.name);
			bodyTotal += bodyBytes;
		}
		return {
			entries,
			compressedTotal: entries.reduce((total, entry) => total + entry.compressedBytes, 0),
			expandedTotal: entries.reduce((total, entry) => total + entry.declaredExpandedBytes, 0),
			bodyTotal,
		};
	} finally {
		archive.dispose();
	}
}

async function sanitizeActualDocx(nodeId: string, bytes: Uint8Array) {
	return sanitizeOfficeDocxPackageForRenderer({ nodeId, source: bytes, archive: await createParadisOfficeNodeArchive(bytes), scheduler: () => Promise.resolve() });
}

function deterministicRatioPayload(length: number, entropyBytes: number): Uint8Array {
	const bytes = new Uint8Array(length);
	let state = 0x12345678;
	for (let index = 0; index < Math.min(length, entropyBytes); index++) {
		state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
		bytes[index] = state >>> 24;
	}
	return bytes;
}

function actualDocxOptions(documentXml: string, extraParts: readonly (readonly [string, Uint8Array, string])[] = []) {
	return {
		parts: [
			['/word/document.xml', documentXml, 'application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml'] as const,
			...extraParts,
		],
		relationships: [{ id: 'root', type: 'http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument', target: 'word/document.xml' }],
	};
}

function source() { return { kind: 'bytes' as const, bytes: Uint8Array.of(0x50, 0x4b, 0x03, 0x04), revision: 'gate-fixture' }; }
const uncancelledToken = { isCancellationRequested: false, onCancellationRequested: () => toDisposable(() => { }) };

function cellsForRequest(request: ParadisSpreadsheetTileRequest): ParadisSpreadsheetGridCell[] {
	const cells: ParadisSpreadsheetGridCell[] = [];
	for (let row = request.range[0]; row < request.range[2]; row++) {
		for (let column = request.range[1]; column < request.range[3]; column++) { cells.push({ row, column, text: `${row}:${column}` }); }
	}
	return cells;
}

function serializedIpcBytes(value: unknown): number {
	const writer = new BufferWriter();
	try { serialize(writer, value); return writer.buffer.byteLength; } finally { writer.dispose(); }
}

async function measureViewportCase(shape: IFixtureCase): Promise<{ readonly firstUsablePaintMilliseconds: number; readonly liveDomNodes: number; readonly initialIpcBytes: number }> {
	const document = mainWindow.document;
	const container = document.createElement('div');
	document.body.appendChild(container);
	const viewport = new ParadisSpreadsheetViewport({ rowCount: shape.rows, columnCount: shape.columns, defaultRowHeight: 20, defaultColumnWidth: 80, maxLiveCells: 10_000, revision: `gate-${shape.id}` });
	let firstTile: ParadisSpreadsheetGridTile | undefined;
	const renderer = new ParadisSpreadsheetGridRenderer(container, viewport, {
		getViewport: async request => {
			const tile = { revision: request.revision, range: request.range, cells: cellsForRequest(request) };
			firstTile ??= tile;
			return tile;
		},
	});
	const stopwatch = StopWatch.create(true);
	try {
		await renderer.render({ scrollTop: 0, scrollLeft: 0, width: 900, height: 500 });
		await new Promise<void>(resolve => mainWindow.requestAnimationFrame(() => resolve()));
		return { firstUsablePaintMilliseconds: stopwatch.elapsed(), liveDomNodes: renderer.liveCellCount, initialIpcBytes: serializedIpcBytes(firstTile!) };
	} finally { renderer.dispose(); container.remove(); }
}

function changedBytes(expected: Uint8Array, actual: Uint8Array): number {
	let changed = Math.abs(expected.byteLength - actual.byteLength);
	for (let index = 0; index < Math.min(expected.byteLength, actual.byteLength); index++) { if (expected[index] !== actual[index]) { changed++; } }
	return changed;
}

async function actualSerializedGeometry(expected: string): Promise<{ readonly serializedGeometryBytes: number; readonly changedGeometryBytes: number; readonly landmarks: readonly string[]; readonly rawGeometryHash: string }> {
	const document = mainWindow.document.implementation.createHTMLDocument('office visual geometry');
	const container = document.createElement('div');
	const viewport = new ParadisSpreadsheetViewport({ rowCount: 20, columnCount: 20, defaultRowHeight: 20, defaultColumnWidth: 80, revision: 'visual' });
	const renderer = new ParadisSpreadsheetGridRenderer(container, viewport, {
		getViewport: async request => ({ revision: request.revision, range: request.range, cells: cellsForRequest(request).map(cell => cell.row === 0 && cell.column === 0 ? { ...cell, baseDiagonal: { up: true, down: true, style: '2px solid', color: '#123456' } } : cell) }),
		measureCell: () => ({ width: 83, height: 27 }),
	});
	try {
		await renderer.render({ scrollTop: 0, scrollLeft: 0, width: 300, height: 200 });
		const drawing = buildShapeOverlay([{ type: 'line', flipV: false, flipH: false, from: { c: 0, co: 0, r: 0, ro: 0 }, to: { c: 1, co: 0, r: 1, ro: 0 }, outlineWidth: 1, outlineColor: '#abcdef', dash: 'dash' }], new Map([[1, 0], [2, 20]]), [80, 80], 1, document)!;
		container.appendChild(drawing);
		const lines = Array.from(container.querySelectorAll('.paradis-spreadsheet-diagonal-base line'), line => `grid|${line.getAttribute('x1')}|${line.getAttribute('y1')}|${line.getAttribute('x2')}|${line.getAttribute('y2')}|${line.getAttribute('stroke')}|${line.getAttribute('stroke-width')}`);
		const drawingLine = drawing.querySelector('line')!;
		lines.push(`drawing|${drawingLine.getAttribute('x1')}|${drawingLine.getAttribute('y1')}|${drawingLine.getAttribute('x2')}|${drawingLine.getAttribute('y2')}|${drawingLine.getAttribute('stroke')}|${drawingLine.getAttribute('stroke-width')}|${drawingLine.getAttribute('stroke-dasharray')}`);
		const actual = new TextEncoder().encode(lines.join('\n'));
		const golden = new TextEncoder().encode(expected);
		return {
			serializedGeometryBytes: actual.byteLength,
			changedGeometryBytes: changedBytes(golden, actual),
			landmarks: [container.querySelectorAll('.paradis-spreadsheet-diagonal-base line').length === 2 ? 'diagonal-border' : '', drawing.querySelector('line') ? 'drawing-line' : ''].filter(Boolean),
			rawGeometryHash: createHash('sha256').update(actual).digest('hex'),
		};
	} finally { renderer.dispose(); }
}

suite('ParadisOfficePerformance', () => {
	ensureNoDisposablesAreLeakedInTestSuite();
	test('measures fixed production viewport shapes without materializing all cells', async function () {
		const fixture = loadFixtures();
		strictEqual(fixture.schema, 2);
		strictEqual(createHash('sha256').update(JSON.stringify(fixture.cases)).digest('hex'), fixture.caseHash);
		strictEqual(createHash('sha256').update(JSON.stringify(fixture.serializedGeometry.regions)).digest('hex'), fixture.serializedGeometryHash);
		strictEqual(fixture.attachedPaintBaseline.rendererSourceSha256, sha256File('src/vs/paradis/contrib/fileViewers/electron-browser/spreadsheet/paradisSpreadsheetGridRenderer.ts'));
		strictEqual(fixture.attachedPaintBaseline.rendererCompiledSha256, sha256File('out/vs/paradis/contrib/fileViewers/electron-browser/spreadsheet/paradisSpreadsheetGridRenderer.js'));
		strictEqual(fixture.attachedPaintBaseline.environmentIdentity, rendererEnvironmentIdentity());
		strictEqual(fixture.attachedPaintBaseline.calibration.validation, 'identity-and-threshold');
		strictEqual(fixture.attachedPaintBaseline.calibration.requestedRegressionPercent, 10);
		strictEqual(fixture.attachedPaintBaseline.calibration.measurementIterations, 41);
		strictEqual(fixture.attachedPaintBaseline.calibration.samplesMilliseconds.length, fixture.attachedPaintBaseline.calibration.measurementIterations);
		ok(fixture.attachedPaintBaseline.calibration.samplesMilliseconds.every(value => Number.isFinite(value) && value > 0));
		strictEqual(fixture.attachedPaintBaseline.calibration.medianMilliseconds, median(fixture.attachedPaintBaseline.calibration.samplesMilliseconds));
		const smallPaintMeasurements: number[] = [];
		for (const item of fixture.cases) {
			const measurements = [];
			for (let iteration = 0; iteration < (item.id === 'small' ? fixture.attachedPaintBaseline.calibration.measurementIterations : 1); iteration++) { measurements.push(await measureViewportCase(item)); }
			if (item.id === 'small') { smallPaintMeasurements.push(...measurements.map(measurement => measurement.firstUsablePaintMilliseconds)); }
			const measured = measurements[measurements.length - 1];
			ok(measured.firstUsablePaintMilliseconds <= 60_000, item.id);
			ok(measured.initialIpcBytes <= PARADIS_OFFICE_LIMITS.maxSerializedResponseBytes, item.id);
			ok(measured.liveDomNodes <= 10_000, item.id);
			if (item.pages === 200) {
				const layout = computePageLayout({ setup: { paperWidth: 595.28, paperHeight: 841.89, marginLeft: 0, marginRight: 0, marginTop: 0, marginBottom: 0, scale: 1, hasSavedScale: false, fitToPage: false, fitToWidth: 1, fitToHeight: 1, pageOrder: 'downThenOver', landscape: false, paperName: 'A4' }, minRow: 1, rowHeights: new Array(200).fill(1_000), minCol: 1, colWidths: [100], manualRowBreaks: [], manualColBreaks: [] });
				strictEqual(pageRectangles(layout).length, 200);
			}
		}
		strictEqual(smallPaintMeasurements.length, fixture.attachedPaintBaseline.calibration.measurementIterations);
		const smallPaintMedian = median(smallPaintMeasurements);
		const smallPaintUpperLimit = fixture.attachedPaintBaseline.calibration.medianMilliseconds * 1.10;
		ok(smallPaintMedian <= smallPaintUpperLimit, `small attached paint median ${smallPaintMedian}ms exceeds immutable baseline upper limit ${smallPaintUpperLimit}ms; samples=${smallPaintMeasurements.join(',')}`);
		this.test!.title += ` (small median ${smallPaintMedian}ms <= ${smallPaintUpperLimit}ms)`;
		deepStrictEqual(fixture.cases.map(item => [item.id, item.rows * item.columns, item.columns, item.pages]), [
			['small', 1_024, 32, 1], ['cells-100k', 100_000, 1_000, 1], ['cells-5m', 5_000_000, 1_000, 1], ['columns-16384', 16_384, 16_384, 1], ['pages-200', 20_000, 40, 200],
		]);
	});

	test('rejects active XML and unsafe Office assets', async function () {
		this.timeout(15_000);
		const document = '<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body/></w:document>';
		const common = {
			'[Content_Types].xml': '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>',
			'_rels/.rels': '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="root" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>',
			'word/document.xml': document,
		};
		for (const sourceText of ['<!DOCTYPE svg [<!ENTITY x "boom">]><svg xmlns="http://www.w3.org/2000/svg"><text>&x;</text></svg>', '<svg xmlns="http://www.w3.org/2000/svg"><path href="https://attacker.invalid/x" d="M0 0"/></svg>']) {
			strictEqual(Object.hasOwn(sanitizeOfficeSvg({ nodeId: 'unsafe-svg', assetId: 'unsafe-svg', source: sourceText }), 'reason'), true);
		}
		const assets = await sanitizeOfficeDocxPackageForRenderer({
			nodeId: 'unsafe-assets', source: Uint8Array.of(1), archive: new FixtureArchive({
				'[Content_Types].xml': '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/><Override PartName="/word/media/unsafe.svg" ContentType="image/svg+xml"/><Override PartName="/word/fonts/font.bin" ContentType="application/x-font-ttf"/><Override PartName="/word/ole.bin" ContentType="application/vnd.openxmlformats-officedocument.oleObject"/><Override PartName="/word/vbaProject.bin" ContentType="application/vnd.ms-office.vbaProject"/></Types>',
				'_rels/.rels': '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="root" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>',
				'word/document.xml': '<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"><w:body><w:p><w:r><w:drawing><a:blip r:embed="svg"/></w:drawing><w:object r:id="ole"/><w:hyperlink r:id="external"/></w:r></w:p></w:body></w:document>',
				'word/_rels/document.xml.rels': '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="svg" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" Target="media/unsafe.svg"/><Relationship Id="font" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/font" Target="fonts/font.bin"/><Relationship Id="ole" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/oleObject" Target="ole.bin"/><Relationship Id="external" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/hyperlink" Target="https://attacker.invalid" TargetMode="External"/></Relationships>',
				'word/media/unsafe.svg': '<svg xmlns="http://www.w3.org/2000/svg"><script>bad</script></svg>', 'word/fonts/font.bin': 'RAW-FONT', 'word/ole.bin': 'RAW-OLE', 'word/vbaProject.bin': 'RAW-MACRO',
			}),
		});
		const text = new TextDecoder().decode(assets.bytes);
		for (const unsafe of ['attacker.invalid', 'RAW-FONT', 'RAW-OLE', 'RAW-MACRO', '<script>']) { strictEqual(text.includes(unsafe), false, unsafe); }
		await rejects(sanitizeOfficeDocxPackageForRenderer({ nodeId: 'malicious-name', source: Uint8Array.of(1), archive: new FixtureArchive({ '../../private.xml': '<x/>' }) }));
		await rejects(sanitizeOfficeDocxPackageForRenderer({ nodeId: 'traversal', source: Uint8Array.of(1), archive: new FixtureArchive({ ...common, 'word/_rels/document.xml.rels': '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="bad" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" Target="..%2Fprivate.svg"/></Relationships>' }) }));
		await rejects(sanitizeOfficeDocxPackageForRenderer({ nodeId: 'relationship-cycle', source: Uint8Array.of(1), archive: new FixtureArchive({ ...common, 'word/_rels/document.xml.rels': '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="header" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/header" Target="header1.xml"/></Relationships>', 'word/header1.xml': '<w:hdr xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"/>', 'word/_rels/header1.xml.rels': '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="back" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/header" Target="../document.xml"/></Relationships>' }) }));
	});

	test('accepts exact hard limits and rejects limit plus one using actual valid archives', async function () {
		this.timeout(120_000);
		const document = '<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body/></w:document>';

		const singleAt = await buildOpcFixture(actualDocxOptions(document, [['/padding.bin', new Uint8Array(8 * 1024 * 1024), 'application/octet-stream']]));
		const singleAtStats = await actualArchiveStats(singleAt);
		strictEqual(singleAtStats.entries.find(entry => entry.name === 'padding.bin')?.declaredExpandedBytes, 8 * 1024 * 1024);
		strictEqual(singleAtStats.bodyTotal, singleAtStats.expandedTotal);
		await sanitizeActualDocx('single-part-at-limit', singleAt);
		const singleOver = await buildOpcFixture(actualDocxOptions(document, [['/padding.bin', new Uint8Array(8 * 1024 * 1024 + 1), 'application/octet-stream']]));
		await rejects(sanitizeActualDocx('single-part-over-limit', singleOver), error => error instanceof ParadisOfficePackageError && error.code === 'zipBomb');

		const inertXml = new TextEncoder().encode('<x/>');
		const countAtParts = Array.from({ length: 4_093 }, (_unused, index) => [`/unused/${String(index).padStart(4, '0')}.xml`, inertXml, 'application/xml'] as const);
		const countAt = await buildOpcFixture(actualDocxOptions(document, countAtParts));
		strictEqual((await actualArchiveStats(countAt)).entries.length, 4_096);
		await sanitizeActualDocx('entry-count-at-limit', countAt);
		const countOver = await buildOpcFixture(actualDocxOptions(document, [...countAtParts, ['/unused/over.xml', inertXml, 'application/xml']]));
		strictEqual((await actualArchiveStats(countOver)).entries.length, 4_097);
		await rejects(sanitizeActualDocx('entry-count-over-limit', countOver), error => error instanceof ParadisOfficePackageError && error.code === 'unsafe');

		const emptyTotalParts = Array.from({ length: 4 }, (_unused, index) => [`/word/vbaProject${index}.bin`, new Uint8Array(), 'application/vnd.ms-office.vbaProject'] as const);
		const totalOverhead = (await actualArchiveStats(await buildOpcFixture(actualDocxOptions(document, emptyTotalParts)))).expandedTotal;
		let remaining = 32 * 1024 * 1024 - totalOverhead;
		const totalSizes = Array.from({ length: 4 }, () => { const size = Math.min(8 * 1024 * 1024, remaining); remaining -= size; return size; });
		strictEqual(remaining, 0);
		const totalParts = totalSizes.map((size, index) => [`/word/vbaProject${index}.bin`, deterministicRatioPayload(size, Math.ceil(size / 90)), 'application/vnd.ms-office.vbaProject'] as const);
		const totalAt = await deflateOpcFixture(await buildOpcFixture(actualDocxOptions(document, totalParts)));
		const totalAtStats = await actualArchiveStats(totalAt);
		strictEqual(totalAtStats.expandedTotal, 32 * 1024 * 1024);
		strictEqual(totalAtStats.bodyTotal, totalAtStats.expandedTotal);
		await sanitizeActualDocx('expanded-total-at-limit', totalAt);
		const totalOverParts = totalParts.map((part, index) => index === totalParts.length - 1 ? [part[0], deterministicRatioPayload(part[1].byteLength + 1, Math.ceil((part[1].byteLength + 1) / 90)), part[2]] as const : part);
		const totalOver = await deflateOpcFixture(await buildOpcFixture(actualDocxOptions(document, totalOverParts)));
		strictEqual((await actualArchiveStats(totalOver)).expandedTotal, 32 * 1024 * 1024 + 1);
		await rejects(sanitizeActualDocx('expanded-total-over-limit', totalOver), error => error instanceof ParadisOfficePackageError && error.code === 'zipBomb');

		const ratioAt = await exactRatioOpcFixture();
		const ratioAtStats = await actualArchiveStats(ratioAt);
		strictEqual(ratioAtStats.expandedTotal, ratioAtStats.compressedTotal * 100);
		strictEqual(ratioAtStats.entries.every(entry => entry.declaredExpandedBytes === entry.compressedBytes * 100), true);
		strictEqual(ratioAtStats.bodyTotal, ratioAtStats.expandedTotal);
		await sanitizeActualDocx('container-ratio-at-limit', ratioAt);
		// For a valid ZIP, a zero-byte compressed body is also empty. Consequently, if every
		// entry is <=100x, summing the per-entry inequalities proves the aggregate is <=100x.
		strictEqual(ratioAtStats.entries.every(entry => entry.compressedBytes > 0 || entry.declaredExpandedBytes === 0), true);
		ok(ratioAtStats.entries.every(entry => entry.declaredExpandedBytes <= Math.max(1, entry.compressedBytes) * 100));
		ok(ratioAtStats.expandedTotal <= ratioAtStats.compressedTotal * 100);

		const perEntryOver = await exactRatioOpcFixture(1, true);
		const perEntryOverStats = await actualArchiveStats(perEntryOver);
		const overEntry = perEntryOverStats.entries.find(entry => entry.name === 'padding.bin')!;
		strictEqual(overEntry.declaredExpandedBytes, overEntry.compressedBytes * 100 + 1);
		ok(perEntryOverStats.entries.filter(entry => entry !== overEntry).every(entry => entry.declaredExpandedBytes <= Math.max(1, entry.compressedBytes) * 100));
		ok(perEntryOverStats.expandedTotal <= perEntryOverStats.compressedTotal * 100);
		strictEqual(perEntryOverStats.bodyTotal, perEntryOverStats.expandedTotal);
		await rejects(sanitizeActualDocx('per-entry-ratio-over-limit', perEntryOver), error => error instanceof ParadisOfficePackageError && error.code === 'zipBomb');

		const xxe = await buildOpcFixture(actualDocxOptions('<!DOCTYPE w:document [<!ENTITY xxe SYSTEM "file:///private">]><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:r><w:t>&xxe;</w:t></w:r></w:p></w:body></w:document>'));
		strictEqual((await actualArchiveStats(xxe)).entries.length, 3);
		await rejects(sanitizeActualDocx('actual-ooxml-xxe', xxe), error => error instanceof ParadisOfficePackageError && (error.code === 'malformed' || error.code === 'unsafe'));
	});

	test('maps worker cancellation, deadline and crash to bounded terminal outcomes', async () => {
		const clock = new FakeClock();
		const workers: FakeWorker[] = [];
		const host = new OfficeWorkerHost({ createWorker: () => { const worker = new FakeWorker(); workers.push(worker); return worker; }, now: clock.read, setTimeout: clock.setTimeout, clearTimeout: clock.clearTimeout });
		const parse = host.run('parse', 'gate', source(), PARADIS_OFFICE_BUDGET_PROFILES.desktopLocal, uncancelledToken);
		clock.advance(60_000);
		deepStrictEqual(await parse, { outcome: 'blocked', error: 'limitExceeded' });
		const crash = host.run('diff', 'gate', source(), PARADIS_OFFICE_BUDGET_PROFILES.desktopLocal, uncancelledToken);
		workers[1].fail();
		deepStrictEqual(await crash, { outcome: 'failed', error: 'engineCrashed' });
		strictEqual(workers[0].terminated, true);
	});

	test('records worker, semantic cache, and spool peak through production ownership paths', async () => {
		const fixture = loadFixtures();
		const accountant = new OfficeMemoryAccountant(64 * 1024 * 1024);
		let random = 0;
		const spool = new OfficeSpoolStore({ platform: 'desktopLocal', randomBytes: length => new Uint8Array(length).fill(++random) });
		const resolver = new SpoolAwareParadisOfficeSourceResolver(spool, () => accountant.trySetSpool(spool.byteLength));
		const transport = new ParadisOfficeSpoolTransport(spool, resolver, accountant);
		const ownerId = 'performance-gate';
		const attemptId = '12345678-1234-4123-8123-123456789abc';
		const reference = await transport.call(ownerId, 'spool/begin', { attemptId }) as Awaited<ReturnType<OfficeSpoolStore['begin']>>;
		await transport.call(ownerId, 'spool/claim', { reference, attemptId });
		await transport.call(ownerId, 'spool/append', { reference, bytes: VSBuffer.wrap(new Uint8Array(1024 * 1024)) });

		const handles = new OfficeHandleStore({ accountant, semanticCacheLimitBytes: 16 * 1024 * 1024, randomBytes: length => new Uint8Array(length).fill(++random) });
		const handle = handles.create(ownerId, 'document', 'performance-revision', 2 * 1024 * 1024);
		let snapshotReleases = 0;
		strictEqual(handles.putSemanticSnapshot(handle, 'projection', { kind: 'spreadsheet', cells: new Uint8Array(3 * 1024 * 1024) }, 3 * 1024 * 1024, () => snapshotReleases++), true);

		const cancellation = new CancellationTokenSource();
		const worker = new FakeWorker(true);
		const host = new OfficeWorkerHost({ accountant, createWorker: () => worker, memory: { workerReservationBytes: 4 * 1024 * 1024 } });
		try {
			const pending = host.run('parse', ownerId, source(), PARADIS_OFFICE_BUDGET_PROFILES.desktopLocal, cancellation.token);
			const peak = accountant.snapshot();
			deepStrictEqual({ workerBytes: peak.workerBytes, cacheBytes: peak.cacheBytes, spoolBytes: peak.spoolBytes, totalBytes: peak.totalBytes }, fixture.resourcePeak);
			const cancelWatch = StopWatch.create(true);
			cancellation.cancel();
			deepStrictEqual(await pending, { outcome: 'cancelled' });
			ok(cancelWatch.elapsed() <= 250, `cancel latency ${cancelWatch.elapsed()}ms`);
		} finally {
			cancellation.dispose();
			host.dispose();
			strictEqual(handles.close(handle), true);
			handles.dispose();
			await transport.call(ownerId, 'spool/dispose', { reference });
		}
		strictEqual(snapshotReleases, 1);
		strictEqual(accountant.snapshot().totalBytes, 0);
	});

	test('reaches actual parser and semantic diff terminal outcomes inside fixed deadlines', async () => {
		const parseWatch = StopWatch.create(true);
		const original = await parseActualWordFixture('before');
		const modified = await parseActualWordFixture('after');
		ok(parseWatch.elapsed() <= 60_000, `parse terminal ${parseWatch.elapsed()}ms`);
		strictEqual(original.completeness.terminal, true);
		strictEqual(modified.completeness.terminal, true);

		const diffWatch = StopWatch.create(true);
		const completeSnapshot = (document: typeof original) => ({
			document,
			packageCompleteness: {
				expectedParts: document.completeness.expectedParts,
				visitedParts: document.completeness.visitedParts,
				parsedParts: document.completeness.parsedParts,
				opaqueParts: 0,
				failedParts: 0,
				omittedParts: 0,
				expectedSemanticUnits: document.completeness.nodes + document.completeness.stories,
				visitedSemanticUnits: document.completeness.nodes + document.completeness.stories,
				terminal: true,
			},
		});
		const diff = compareWordSemantics(completeSnapshot(original), completeSnapshot(modified), { deadlineMilliseconds: 60_000 });
		ok(diffWatch.elapsed() <= 90_000, `diff terminal ${diffWatch.elapsed()}ms`);
		strictEqual(diff.terminal, true);
		strictEqual(diff.completeness.terminal, true);
		strictEqual(diff.changes.length > 0, true);
	});

	test('cancels an unresponsive worker at the fixed 250ms grace boundary', async () => {
		const clock = new FakeClock();
		const worker = new FakeWorker();
		const host = new OfficeWorkerHost({ createWorker: () => worker, now: clock.read, setTimeout: clock.setTimeout, clearTimeout: clock.clearTimeout });
		const cancellation = new CancellationTokenSource();
		try {
			const result = host.run('parse', 'gate', source(), PARADIS_OFFICE_BUDGET_PROFILES.desktopLocal, cancellation.token);
			cancellation.cancel();
			clock.advance(249);
			strictEqual(worker.terminated, false);
			clock.advance(1);
			deepStrictEqual(await result, { outcome: 'cancelled' });
			strictEqual(worker.terminated, true);
		} finally {
			cancellation.dispose();
		}
	});

	test('compares serialized production diagonal and drawing geometry with the immutable golden', async () => {
		const fixture = loadFixtures();
		const region = fixture.serializedGeometry.regions[0];
		const expected = { hash: fixture.serializedGeometryHash, regions: [{ id: region.id, serializedGeometryBytes: region.serializedGeometryBytes, changedGeometryBytes: 0, requiredLandmarks: region.requiredLandmarks, landmarks: [], rawGeometryHash: region.rawGeometryHash }] };
		const actual = await actualSerializedGeometry(region.goldenGeometry);
		assertParadisOfficeSerializedGeometryGolden(expected, { hash: fixture.serializedGeometryHash, regions: [{ id: region.id, ...actual, requiredLandmarks: [] }] });
		const missing = { hash: fixture.serializedGeometryHash, regions: [{ id: region.id, ...actual, requiredLandmarks: [], landmarks: [] }] };
		let failed = false;
		try { assertParadisOfficeSerializedGeometryGolden(expected, missing); } catch { failed = true; }
		strictEqual(failed, true);
	});

	test('rejects non-finite and negative serialized geometry measurements', () => {
		const fixture = loadFixtures();
		const region = fixture.serializedGeometry.regions[0];
		const expected = { hash: fixture.serializedGeometryHash, regions: [{ id: region.id, serializedGeometryBytes: region.serializedGeometryBytes, changedGeometryBytes: 0, requiredLandmarks: region.requiredLandmarks, landmarks: [], rawGeometryHash: region.rawGeometryHash }] };
		for (const changedGeometryBytes of [Number.NaN, -1]) {
			let failed = false;
			try { assertParadisOfficeSerializedGeometryGolden(expected, { hash: fixture.serializedGeometryHash, regions: expected.regions.map(region => ({ ...region, changedGeometryBytes })) }); } catch { failed = true; }
			strictEqual(failed, true);
		}
	});
});
