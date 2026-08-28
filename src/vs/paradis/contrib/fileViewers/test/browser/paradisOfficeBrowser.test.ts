/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import { deepStrictEqual, ok, strictEqual } from 'assert';
import { mainWindow } from '../../../../../base/browser/window.js';
import { CancellationToken, CancellationTokenSource } from '../../../../../base/common/cancellation.js';
import { URI } from '../../../../../base/common/uri.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import {
	PARADIS_DOCX_EXTENSIONS,
	PARADIS_OFFICE_DIAGNOSTIC_EXTENSIONS,
	PARADIS_OFFICE_SEMANTIC_EXTENSIONS,
	PARADIS_SPREADSHEET_EXTENSIONS,
	getParadisOfficeFormat,
	isParadisOfficeDiagnosticResource,
} from '../../browser/paradisFileViewers.js';
import { PARADIS_OFFICE_LIMITS } from '../../common/paradisOfficeProtocol.js';
import {
	ParadisOfficeWebWorkerClient,
	createParadisOfficeWebWorkerEndpoint,
	executeParadisOfficeWebWorkerRequest,
	getParadisOfficeWebWorkerCapabilities,
	type IParadisOfficeWebWorkerEndpoint,
	type ParadisOfficeWebWorkerMessage,
} from '../../browser/paradisOfficeWebWorker.js';
import { createParadisOfficeDiagnostic, renderParadisOfficeDiagnostic, renderParadisOfficeSummary } from '../../browser/paradisOfficeDiagnosticEditor.js';
import { buildOpcFixture } from '../common/paradisOfficeFixture.js';

const spreadsheetNamespace = 'http://schemas.openxmlformats.org/spreadsheetml/2006/main';
const wordNamespace = 'http://schemas.openxmlformats.org/wordprocessingml/2006/main';
const relationshipNamespace = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';
const drawingWordprocessingNamespace = 'http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing';
const drawingNamespace = 'http://schemas.openxmlformats.org/drawingml/2006/main';
const pictureNamespace = 'http://schemas.openxmlformats.org/drawingml/2006/picture';

class TestWorkerEndpoint implements IParadisOfficeWebWorkerEndpoint {
	readonly posted: { readonly message: ParadisOfficeWebWorkerMessage; readonly transfer: readonly ArrayBuffer[] }[] = [];
	terminated = false;
	private readonly messageListeners = new Set<(event: MessageEvent<ParadisOfficeWebWorkerMessage>) => void>();
	private readonly errorListeners = new Set<() => void>();

	postMessage(message: ParadisOfficeWebWorkerMessage, transfer: readonly ArrayBuffer[]): void {
		this.posted.push({ message, transfer });
	}

	addEventListener(type: 'message' | 'error' | 'messageerror', listener: EventListener): void {
		if (type === 'message') {
			this.messageListeners.add(listener as (event: MessageEvent<ParadisOfficeWebWorkerMessage>) => void);
		} else {
			this.errorListeners.add(listener as () => void);
		}
	}

	removeEventListener(type: 'message' | 'error' | 'messageerror', listener: EventListener): void {
		if (type === 'message') {
			this.messageListeners.delete(listener as (event: MessageEvent<ParadisOfficeWebWorkerMessage>) => void);
		} else {
			this.errorListeners.delete(listener as () => void);
		}
	}

	terminate(): void {
		this.terminated = true;
	}

	reply(message: ParadisOfficeWebWorkerMessage): void {
		for (const listener of this.messageListeners) {
			listener({ data: message } as MessageEvent<ParadisOfficeWebWorkerMessage>);
		}
	}
}

interface TestTimer {
	readonly delay: number;
	readonly runner: () => void;
	cancelled: boolean;
}

function timerHarness(): {
	readonly timers: TestTimer[];
	readonly setTimeout: (runner: () => void, delay: number) => TestTimer;
	readonly clearTimeout: (timer: TestTimer) => void;
} {
	const timers: TestTimer[] = [];
	return {
		timers,
		setTimeout: (runner, delay) => {
			const timer = { delay, runner, cancelled: false };
			timers.push(timer);
			return timer;
		},
		clearTimeout: timer => timer.cancelled = true,
	};
}

suite('ParadisOfficeBrowser', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	test('registers every semantic and explicit diagnostic Office extension', () => {
		deepStrictEqual(PARADIS_SPREADSHEET_EXTENSIONS, ['.xlsx', '.xlsm', '.xltx', '.xltm']);
		deepStrictEqual(PARADIS_DOCX_EXTENSIONS, ['.docx', '.docm', '.dotx', '.dotm']);
		deepStrictEqual(PARADIS_OFFICE_SEMANTIC_EXTENSIONS, [
			'.xlsx', '.xlsm', '.xltx', '.xltm', '.docx', '.docm', '.dotx', '.dotm',
		]);
		deepStrictEqual(PARADIS_OFFICE_DIAGNOSTIC_EXTENSIONS, ['.xlsb', '.ods', '.xls', '.doc', '.rtf']);
		for (const extension of PARADIS_OFFICE_SEMANTIC_EXTENSIONS) {
			strictEqual(getParadisOfficeFormat(URI.file(`/workspace/sample${extension}`)), extension.slice(1));
		}
		for (const extension of PARADIS_OFFICE_DIAGNOSTIC_EXTENSIONS) {
			strictEqual(isParadisOfficeDiagnosticResource(URI.file(`/workspace/sample${extension.toUpperCase()}`)), true);
		}
	});

	test('runs spreadsheet semantic view and diff in the browser profile without normalizing diagonals', async () => {
		const original = await spreadsheetFixture('1');
		const modified = await spreadsheetFixture('2');

		const viewed = await executeParadisOfficeWebWorkerRequest({
			kind: 'run', requestId: '1', operation: 'view', format: 'xlsx', originalBytes: original,
		}, CancellationToken.None);
		strictEqual(viewed.kind, 'result');
		if (viewed.kind !== 'result' || viewed.value.kind !== 'spreadsheet') {
			throw new Error('Expected spreadsheet result');
		}
		deepStrictEqual(viewed.value.sheets[0].cells[0], {
			address: 'A1', row: 1, column: 1, text: '1', storedType: 'number',
			diagonal: { up: true, down: false, style: 'dashDot', color: { kind: 'rgb', rgb: 'FF112233' } },
		});
		strictEqual(viewed.value.budgetProfile, 'browser');

		const diffed = await executeParadisOfficeWebWorkerRequest({
			kind: 'run', requestId: '2', operation: 'diff', format: 'xlsx', originalBytes: original, modifiedBytes: modified,
		}, CancellationToken.None);
		strictEqual(diffed.kind, 'result');
		if (diffed.kind !== 'result' || diffed.value.kind !== 'diff') {
			throw new Error('Expected diff result');
		}
		ok(diffed.value.changes.some(change => change.category === 'content' && change.locator === 'Sheet1!A1'));
	});

	test('executes every required OOXML document, macro, and template variant', async () => {
		for (const format of ['xlsx', 'xlsm', 'xltx', 'xltm'] as const) {
			const result = await executeParadisOfficeWebWorkerRequest({
				kind: 'run', requestId: `spreadsheet-${format}`, operation: 'view', format, originalBytes: await spreadsheetFixture('1', format),
			}, CancellationToken.None);
			strictEqual(result.kind, 'result', format);
			if (result.kind === 'result') {
				strictEqual(result.value.format, format);
			}
		}
		for (const format of ['docx', 'docm', 'dotx', 'dotm'] as const) {
			const result = await executeParadisOfficeWebWorkerRequest({
				kind: 'run', requestId: `word-${format}`, operation: 'view', format, originalBytes: await wordFixture(format),
			}, CancellationToken.None);
			strictEqual(result.kind, 'result', format);
			if (result.kind === 'result') {
				strictEqual(result.value.format, format);
			}
		}
	});

	test('keeps Word DrawingML and table diagonal coordinates lexical in the worker summary', async () => {
		const result = await executeParadisOfficeWebWorkerRequest({
			kind: 'run', requestId: '3', operation: 'view', format: 'docx', originalBytes: await wordFixture(),
		}, CancellationToken.None);
		strictEqual(result.kind, 'result');
		if (result.kind !== 'result' || result.value.kind !== 'word') {
			throw new Error('Expected Word result');
		}
		deepStrictEqual(result.value.stories.map(story => story.text), ['Diagonal body']);
		deepStrictEqual(result.value.drawings[0].geometry, {
			placement: 'anchor',
			distances: { top: '0', bottom: '1', left: '2', right: '3' },
			simplePosition: { x: '11', y: '22' },
			horizontalPosition: { relativeFrom: 'page', align: 'center' },
			verticalPosition: { relativeFrom: 'paragraph', offset: '-25400' },
			extent: { cx: '914400', cy: '457200' },
			transform: { rotation: '5400000', flipHorizontal: '1', flipVertical: '0', offset: { x: '100', y: '200' }, extent: { cx: '300', cy: '400' } },
			presetGeometry: 'line',
			line: { width: '12700', presetDash: 'dashDot' },
			anchorProperties: { simplePosition: '0', relativeHeight: '251658240', behindDocument: '0', locked: '1', layoutInCell: '1', allowOverlap: '0' },
			sourcePartFingerprint: result.value.drawings[0].geometry.sourcePartFingerprint,
		});
		deepStrictEqual(result.value.tableDiagonals.map(diagonal => ({ direction: diagonal.direction, value: diagonal.value, size: diagonal.size, color: diagonal.color })), [
			{ direction: 'topLeftToBottomRight', value: 'dashDot', size: '13', color: '80A0B0' },
		]);
		strictEqual(result.value.externalRelationshipCount, 1);
		strictEqual(JSON.stringify(result.value).includes('https://example.invalid/private'), false);
	});

	test('blocks an OOXML spreadsheet whose aggregate worker summary exceeds the serialized response budget', async () => {
		const repeated = 'x'.repeat(300);
		const result = await executeParadisOfficeWebWorkerRequest({
			kind: 'run', requestId: 'aggregate-xlsx', operation: 'view', format: 'xlsx', originalBytes: await repeatedSharedStringSpreadsheetFixture(repeated, 10_000),
		}, CancellationToken.None);
		deepStrictEqual(result, { kind: 'failure', requestId: 'aggregate-xlsx', reason: 'limitExceeded' });
	});

	test('accepts the exact aggregate worker response boundary and blocks plus one on the client boundary', async () => {
		const exactEndpoint = new TestWorkerEndpoint();
		const exactClient = new ParadisOfficeWebWorkerClient({ createWorker: () => exactEndpoint });
		const exact = exactClient.run('view', 'xlsx', new Uint8Array([1]), undefined, CancellationToken.None);
		const exactRequestId = exactEndpoint.posted[0].message.requestId;
		exactEndpoint.reply(spreadsheetSummaryMessage(exactRequestId, PARADIS_OFFICE_LIMITS.maxSerializedResponseBytes));
		strictEqual((await exact).kind, 'result');

		const overEndpoint = new TestWorkerEndpoint();
		const overClient = new ParadisOfficeWebWorkerClient({ createWorker: () => overEndpoint });
		const over = overClient.run('view', 'xlsx', new Uint8Array([1]), undefined, CancellationToken.None);
		const overRequestId = overEndpoint.posted[0].message.requestId;
		overEndpoint.reply(spreadsheetSummaryMessage(overRequestId, PARADIS_OFFICE_LIMITS.maxSerializedResponseBytes + 1));
		deepStrictEqual(await over, { kind: 'blocked', reason: 'limitExceeded' });
	});

	test('reports cancelled work without starting a parser', async () => {
		const result = await executeParadisOfficeWebWorkerRequest({
			kind: 'run', requestId: '4', operation: 'view', format: 'xlsx', originalBytes: new Uint8Array([1, 2, 3]),
		}, CancellationToken.Cancelled);
		deepStrictEqual(result, { kind: 'cancelled', requestId: '4' });
	});

	test('uses only an exact-origin static module worker URL', () => {
		const endpoint = new TestWorkerEndpoint();
		const calls: { readonly url: string; readonly options: WorkerOptions }[] = [];
		const createWorker = (url: string, options: WorkerOptions) => {
			calls.push({ url, options });
			return endpoint;
		};

		strictEqual(createParadisOfficeWebWorkerEndpoint('https://app.example/static/paradisOfficeWebWorker.js', 'https://app.example', createWorker), endpoint);
		deepStrictEqual(calls, [{ url: 'https://app.example/static/paradisOfficeWebWorker.js', options: { name: 'ParadisOfficeWebWorker', type: 'module' } }]);
		for (const unsafe of [
			'blob:https://app.example/id',
			'data:text/javascript,postMessage(1)',
			'javascript:eval(1)',
			'https://cdn.example/paradisOfficeWebWorker.js',
		]) {
			let rejected = false;
			try {
				createParadisOfficeWebWorkerEndpoint(unsafe, 'https://app.example', createWorker);
			} catch {
				rejected = true;
			}
			strictEqual(rejected, true, unsafe);
		}
		strictEqual(calls.length, 1);
	});

	test('maps unavailable, cancellation, and deadline termination to explicit outcomes', async () => {
		const unavailable = new ParadisOfficeWebWorkerClient({
			createWorker: () => { throw new Error('/private/worker-unavailable'); },
		});
		deepStrictEqual(await unavailable.run('view', 'xlsx', new Uint8Array([1]), undefined, CancellationToken.None), {
			kind: 'blocked', reason: 'workerUnavailable',
		});
		strictEqual(getParadisOfficeWebWorkerCapabilities(false).route, 'diagnostic');
		strictEqual(getParadisOfficeWebWorkerCapabilities(true).route, 'webWorkerV1');
		const wordOnly = getParadisOfficeWebWorkerCapabilities(true, {
			engine: 'v1', kernelShadow: false, semanticSpreadsheet: false, virtualizedSpreadsheet: false,
			semanticWord: true, platformBackend: true, searchPrint: false,
		});
		strictEqual(wordOnly.features.excelView, 'diagnostic');
		strictEqual(wordOnly.features.wordView, 'semantic');
		const legacy = getParadisOfficeWebWorkerCapabilities(true, {
			engine: 'legacy', kernelShadow: false, semanticSpreadsheet: true, virtualizedSpreadsheet: true,
			semanticWord: true, platformBackend: true, searchPrint: true,
		});
		strictEqual(legacy.features.wordView, 'diagnostic');

		const cancellationEndpoint = new TestWorkerEndpoint();
		const cancellation = new CancellationTokenSource();
		const cancellationClient = new ParadisOfficeWebWorkerClient({ createWorker: () => cancellationEndpoint });
		const cancelled = cancellationClient.run('view', 'xlsx', new Uint8Array([1, 2]), undefined, cancellation.token);
		cancellation.cancel();
		strictEqual(cancellationEndpoint.posted.at(-1)?.message.kind, 'cancel');
		const cancelledRequestId = cancellationEndpoint.posted[0].message.requestId;
		cancellationEndpoint.reply({ kind: 'cancelled', requestId: cancelledRequestId });
		deepStrictEqual(await cancelled, { kind: 'cancelled' });
		strictEqual(cancellationEndpoint.terminated, true);
		cancellation.dispose();

		const deadlineEndpoint = new TestWorkerEndpoint();
		const timers = timerHarness();
		const deadlineClient = new ParadisOfficeWebWorkerClient({
			createWorker: () => deadlineEndpoint,
			setTimeout: timers.setTimeout,
			clearTimeout: timers.clearTimeout,
		});
		const deadline = deadlineClient.run('view', 'xlsx', new Uint8Array([1, 2]), undefined, CancellationToken.None);
		const deadlineTimer = timers.timers.find(timer => timer.delay === 45_000)!;
		deadlineTimer.runner();
		strictEqual(deadlineEndpoint.posted.at(-1)?.message.kind, 'cancel');
		const reapTimer = timers.timers.find(timer => timer.delay === 250)!;
		reapTimer.runner();
		deepStrictEqual(await deadline, { kind: 'blocked', reason: 'deadline' });
		strictEqual(deadlineEndpoint.terminated, true);
	});

	test('renders unsupported diagnostics and a safe external-app action without reading binary bytes', () => {
		const container = mainWindow.document.createElement('div');
		const diagnostic = createParadisOfficeDiagnostic(URI.file('/workspace/legacy.xls'));
		let opened: URI | undefined;
		renderParadisOfficeDiagnostic(container, diagnostic, resource => { opened = resource; });

		strictEqual(diagnostic.format, 'xls');
		strictEqual(diagnostic.reason, 'legacyBinaryUnsupported');
		strictEqual(container.textContent?.includes('xls'), true);
		strictEqual(container.textContent?.includes('\u0000PK\u0003\u0004'), false);
		const button = container.querySelector('button') as HTMLButtonElement;
		strictEqual(button.disabled, false);
		button.click();
		strictEqual(opened?.toString(), 'file:///workspace/legacy.xls');

		const unsafe = createParadisOfficeDiagnostic(URI.parse('data:application/octet-stream,secret'));
		renderParadisOfficeDiagnostic(container, unsafe, () => { throw new Error('must not open'); });
		strictEqual((container.querySelector('button') as HTMLButtonElement).disabled, true);
	});

	test('surfaces every summary incompleteness signal in the diagnostic DOM', () => {
		const container = mainWindow.document.createElement('div');
		renderParadisOfficeSummary(container, {
			kind: 'word', format: 'docx', budgetProfile: 'browser', externalRelationshipCount: 2, truncated: true,
			stories: [{ kind: 'main', text: 'partial', truncated: true }],
			drawings: [{ nodeId: 'drawing-1', geometry: { placement: 'inline', distances: {}, sourcePartFingerprint: { algorithm: 'sha256', value: 'a'.repeat(64), byteLength: 1 } } }],
			tableDiagonals: [],
		});
		strictEqual(container.textContent?.includes('不完全'), true);
		strictEqual(container.textContent?.includes('途中で省略'), true);
		strictEqual(container.textContent?.includes('2 件の外部参照'), true);
		strictEqual(container.textContent?.includes('1 件の図形'), true);

		renderParadisOfficeSummary(container, { kind: 'diff', format: 'docx', budgetProfile: 'browser', changes: [], terminal: false });
		strictEqual(container.textContent?.includes('完了していません'), true);
	});
});

function spreadsheetSummaryMessage(requestId: string, serializedBytes: number): ParadisOfficeWebWorkerMessage {
	const empty: ParadisOfficeWebWorkerMessage = {
		kind: 'result', requestId,
		value: { kind: 'spreadsheet', format: 'xlsx', budgetProfile: 'browser', externalRelationshipCount: 0, sheets: [{ name: 'Sheet1', truncated: false, cells: [{ address: 'A1', row: 1, column: 1, text: '', storedType: 'string' }] }] },
	};
	const overhead = new TextEncoder().encode(JSON.stringify(empty)).byteLength;
	const message: ParadisOfficeWebWorkerMessage = {
		kind: 'result', requestId,
		value: { kind: 'spreadsheet', format: 'xlsx', budgetProfile: 'browser', externalRelationshipCount: 0, sheets: [{ name: 'Sheet1', truncated: false, cells: [{ address: 'A1', row: 1, column: 1, text: 'a'.repeat(serializedBytes - overhead), storedType: 'string' }] }] },
	};
	strictEqual(new TextEncoder().encode(JSON.stringify(message)).byteLength, serializedBytes);
	return message;
}

const spreadsheetMainContentTypes = {
	xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml',
	xlsm: 'application/vnd.ms-excel.sheet.macroEnabled.main+xml',
	xltx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.template.main+xml',
	xltm: 'application/vnd.ms-excel.template.macroEnabled.main+xml',
} as const;

async function spreadsheetFixture(value: string, format: keyof typeof spreadsheetMainContentTypes = 'xlsx'): Promise<Uint8Array> {
	return buildOpcFixture({
		parts: [
			['/xl/workbook.xml', `<workbook xmlns="${spreadsheetNamespace}" xmlns:r="${relationshipNamespace}"><sheets><sheet name="Sheet1" sheetId="1" r:id="rIdSheet1"/></sheets></workbook>`, spreadsheetMainContentTypes[format]],
			['/xl/styles.xml', `<styleSheet xmlns="${spreadsheetNamespace}"><fonts count="1"><font/></fonts><fills count="1"><fill/></fills><borders count="2"><border/><border diagonalUp="1"><diagonal style="dashDot"><color rgb="FF112233"/></diagonal></border></borders><cellXfs count="2"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/><xf numFmtId="0" fontId="0" fillId="0" borderId="1" applyBorder="1"/></cellXfs></styleSheet>`, 'application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml'],
			['/xl/worksheets/sheet1.xml', `<worksheet xmlns="${spreadsheetNamespace}"><dimension ref="A1:A1"/><sheetData><row r="1"><c r="A1" s="1"><v>${value}</v></c></row></sheetData></worksheet>`, 'application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml'],
		],
		relationships: [
			{ id: 'rIdRoot', type: `${relationshipNamespace}/officeDocument`, target: 'xl/workbook.xml' },
			{ source: '/xl/workbook.xml', id: 'rIdSheet1', type: `${relationshipNamespace}/worksheet`, target: 'worksheets/sheet1.xml' },
			{ source: '/xl/workbook.xml', id: 'rIdStyles', type: `${relationshipNamespace}/styles`, target: 'styles.xml' },
		],
	});
}

async function repeatedSharedStringSpreadsheetFixture(value: string, cellCount: number): Promise<Uint8Array> {
	const rows = Array.from({ length: cellCount }, (_, index) => `<row r="${index + 1}"><c r="A${index + 1}" t="s"><v>0</v></c></row>`).join('');
	return buildOpcFixture({
		parts: [
			['/xl/workbook.xml', `<workbook xmlns="${spreadsheetNamespace}" xmlns:r="${relationshipNamespace}"><sheets><sheet name="Sheet1" sheetId="1" r:id="rIdSheet1"/></sheets></workbook>`, spreadsheetMainContentTypes.xlsx],
			['/xl/sharedStrings.xml', `<sst xmlns="${spreadsheetNamespace}" count="${cellCount}" uniqueCount="1"><si><t>${value}</t></si></sst>`, 'application/vnd.openxmlformats-officedocument.spreadsheetml.sharedStrings+xml'],
			['/xl/worksheets/sheet1.xml', `<worksheet xmlns="${spreadsheetNamespace}"><dimension ref="A1:A${cellCount}"/><sheetData>${rows}</sheetData></worksheet>`, 'application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml'],
		],
		relationships: [
			{ id: 'rIdRoot', type: `${relationshipNamespace}/officeDocument`, target: 'xl/workbook.xml' },
			{ source: '/xl/workbook.xml', id: 'rIdSheet1', type: `${relationshipNamespace}/worksheet`, target: 'worksheets/sheet1.xml' },
			{ source: '/xl/workbook.xml', id: 'rIdShared', type: `${relationshipNamespace}/sharedStrings`, target: 'sharedStrings.xml' },
		],
	});
}

const wordMainContentTypes = {
	docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml',
	docm: 'application/vnd.ms-word.document.macroEnabled.main+xml',
	dotx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.template.main+xml',
	dotm: 'application/vnd.ms-word.template.macroEnabledTemplate.main+xml',
} as const;

async function wordFixture(format: keyof typeof wordMainContentTypes = 'docx'): Promise<Uint8Array> {
	const drawing = `<w:r><w:drawing><wp:anchor distT="0" distB="1" distL="2" distR="3" simplePos="0" relativeHeight="251658240" behindDoc="0" locked="1" layoutInCell="1" allowOverlap="0"><wp:simplePos x="11" y="22"/><wp:positionH relativeFrom="page"><wp:align>center</wp:align></wp:positionH><wp:positionV relativeFrom="paragraph"><wp:posOffset>-25400</wp:posOffset></wp:positionV><wp:extent cx="914400" cy="457200"/><a:graphic><a:graphicData><pic:pic><pic:spPr><a:xfrm rot="5400000" flipH="1" flipV="0"><a:off x="100" y="200"/><a:ext cx="300" cy="400"/></a:xfrm><a:prstGeom prst="line"><a:avLst/></a:prstGeom><a:ln w="12700"><a:prstDash val="dashDot"/></a:ln></pic:spPr></pic:pic></a:graphicData></a:graphic></wp:anchor></w:drawing></w:r>`;
	const document = `<w:document xmlns:w="${wordNamespace}" xmlns:r="${relationshipNamespace}" xmlns:wp="${drawingWordprocessingNamespace}" xmlns:a="${drawingNamespace}" xmlns:pic="${pictureNamespace}"><w:body><w:p><w:r><w:t>Diagonal body</w:t></w:r>${drawing}</w:p><w:tbl><w:tblPr><w:tblBorders><w:tl2br w:val="dashDot" w:sz="13" w:color="80A0B0"/></w:tblBorders></w:tblPr><w:tr><w:tc><w:p/></w:tc></w:tr></w:tbl></w:body></w:document>`;
	return buildOpcFixture({
		parts: [['/word/document.xml', document, wordMainContentTypes[format]]],
		relationships: [
			{ id: 'rIdRoot', type: `${relationshipNamespace}/officeDocument`, target: 'word/document.xml' },
			{ source: '/word/document.xml', id: 'rIdExternal', type: `${relationshipNamespace}/hyperlink`, target: 'https://example.invalid/private', targetMode: 'External' },
		],
	});
}
