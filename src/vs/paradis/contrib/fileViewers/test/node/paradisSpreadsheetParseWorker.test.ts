/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import { deepStrictEqual } from 'assert';
import ExcelJS from 'exceljs';
import { CancellationToken } from '../../../../../base/common/cancellation.js';
import { FileAccess } from '../../../../../base/common/network.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { decodeParadisWorkbookJson, unpackParadisWorkbookStyles } from '../../common/spreadsheet/paradisSpreadsheetStyleTable.js';
import { ParadisSpreadsheetService } from '../../node/paradisSpreadsheetService.js';
import type { ParadisOfficeSemanticWorkerMessage } from '../../node/office/paradisOfficeSemanticWorkerQueue.js';
import { PARADIS_SPREADSHEET_PARSE_QUEUE_DEADLINE_MS, PARADIS_SPREADSHEET_PARSE_RUN_DEADLINE_MS, ParadisSpreadsheetParseWorkerBackend, paradisSpreadsheetParseErrorResult, type IParadisSpreadsheetParseWorker, type IParadisSpreadsheetParseWorkerRun } from '../../node/spreadsheet/paradisSpreadsheetParseWorkerBackend.js';

const WORKER_PATH = FileAccess.asFileUri('vs/paradis/contrib/fileViewers/node/spreadsheet/paradisSpreadsheetParseWorkerMain.js').fsPath;

/** Invented workbook: styled and merged cells on two sheets. */
async function inventedWorkbook(): Promise<Buffer> {
	const workbook = new ExcelJS.Workbook();
	const sheet = workbook.addWorksheet('Form');
	for (let row = 1; row <= 20; row++) {
		for (let column = 1; column <= 6; column++) {
			const cell = sheet.getCell(row, column);
			cell.value = row === 1 ? `head ${column}` : row * column;
			if (row === 1) {
				cell.font = { bold: true };
				cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFDDEEFF' } };
			}
		}
	}
	sheet.mergeCells('A22:C23');
	workbook.addWorksheet('Plain').getCell('B2').value = 'x';
	return Buffer.from(await workbook.xlsx.writeBuffer());
}

suite('ParadisSpreadsheetParseWorker', () => {
	const disposables = ensureNoDisposablesAreLeakedInTestSuite();

	test('reports a parse stopped by the run deadline, but not one that ran out of memory', async () => {
		const listeners = new Map<string, ((value: never) => void)[]>();
		const worker = {
			postMessage: () => undefined,
			on: (event: string, listener: (value: never) => void) => { listeners.set(event, [...(listeners.get(event) ?? []), listener]); return worker; },
			terminate: async () => 0,
		};
		const runTimers: (() => void)[] = [];
		const reports: unknown[] = [];
		const backend = disposables.add(new ParadisSpreadsheetParseWorkerBackend(() => { listeners.clear(); return worker as unknown as IParadisSpreadsheetParseWorker; }, {
			setTimeout: (handler: () => void, delay: number) => { if (delay === PARADIS_SPREADSHEET_PARSE_RUN_DEADLINE_MS) { runTimers.push(handler); } return {}; },
			clearTimeout: () => undefined,
		}, (...args) => { reports.push(args); }));
		const emit = (event: string, value: unknown) => { for (const listener of listeners.get(event) ?? []) { listener(value as never); } };
		const outOfMemory = backend.parse(new Uint8Array([1]), undefined, CancellationToken.None);
		emit('error', Object.assign(new Error('heap'), { code: 'ERR_WORKER_OUT_OF_MEMORY' }));
		const afterOutOfMemory = { result: await outOfMemory, reports: reports.length };
		const hung = backend.parse(new Uint8Array([2]), undefined, CancellationToken.None);
		runTimers.at(-1)!();
		deepStrictEqual({ afterOutOfMemory, hung: await hung, reports }, {
			afterOutOfMemory: { result: { kind: 'unavailable', reason: 'limitExceeded' }, reports: 0 },
			hung: { kind: 'unavailable', reason: 'limitExceeded' },
			reports: [['spreadsheet-parse', 'deadline', 'run-deadline']],
		});
	});

	test('puts a parse that waited too long back in the queue once, and refuses it as busy the second time', async () => {
		const posted: ParadisOfficeSemanticWorkerMessage<IParadisSpreadsheetParseWorkerRun>[] = [];
		const listeners = new Map<string, ((value: never) => void)[]>();
		const worker = {
			postMessage: (message: ParadisOfficeSemanticWorkerMessage<IParadisSpreadsheetParseWorkerRun>) => { posted.push(message); },
			on: (event: string, listener: (value: never) => void) => { listeners.set(event, [...(listeners.get(event) ?? []), listener]); return worker; },
			terminate: async () => 0,
		};
		const queueTimers: (() => void)[] = [];
		const backend = disposables.add(new ParadisSpreadsheetParseWorkerBackend(() => worker as unknown as IParadisSpreadsheetParseWorker, {
			setTimeout: (handler: () => void, delay: number) => { if (delay === PARADIS_SPREADSHEET_PARSE_QUEUE_DEADLINE_MS) { queueTimers.push(handler); } return {}; },
			clearTimeout: () => undefined,
		}));
		const settle = () => new Promise(resolve => setTimeout(resolve, 0));
		const answer = (id: number, result: unknown) => { for (const listener of listeners.get('message') ?? []) { listener({ kind: 'result', id, result } as never); } };
		const running = backend.parse(new Uint8Array([1]), undefined, CancellationToken.None);
		const retried = backend.parse(new Uint8Array([2]), undefined, CancellationToken.None);
		queueTimers[0]();
		await settle();
		const refused = backend.parse(new Uint8Array([3]), undefined, CancellationToken.None);
		queueTimers[2]();
		await settle();
		queueTimers[3]();
		const refusedResult = await refused;
		answer(posted[0].id, { kind: 'error', message: 'first' });
		await settle();
		answer(posted[1].id, { kind: 'error', message: 'second' });
		deepStrictEqual({ running: await running, retried: await retried, refused: refusedResult, queueTimers: queueTimers.length }, {
			running: { kind: 'error', message: 'first' },
			retried: { kind: 'error', message: 'second' },
			refused: { kind: 'unavailable', reason: 'busy' },
			queueTimers: 4,
		});
	});

	test('turns a workbook beyond the string limit into a too-large refusal and keeps other messages', () => {
		let overflow: unknown;
		try {
			'x'.repeat(2 ** 30);
		} catch (error) {
			overflow = error;
		}
		deepStrictEqual([
			paradisSpreadsheetParseErrorResult(overflow),
			paradisSpreadsheetParseErrorResult(new RangeError('Invalid array length')),
			paradisSpreadsheetParseErrorResult(new Error('Corrupted zip')),
			paradisSpreadsheetParseErrorResult('plain'),
		], [
			{ kind: 'unavailable', reason: 'limitExceeded' },
			{ kind: 'error', message: 'Invalid array length' },
			{ kind: 'error', message: 'Corrupted zip' },
			{ kind: 'error', message: 'plain' },
		]);
	});

	test('sends one warm request while one is waiting or running, and none while the worker is up', async () => {
		const posted: ParadisOfficeSemanticWorkerMessage<IParadisSpreadsheetParseWorkerRun>[] = [];
		const listeners = new Map<string, ((value: never) => void)[]>();
		const worker = {
			postMessage: (message: ParadisOfficeSemanticWorkerMessage<IParadisSpreadsheetParseWorkerRun>) => { posted.push(message); },
			on: (event: string, listener: (value: never) => void) => { listeners.set(event, [...(listeners.get(event) ?? []), listener]); return worker; },
			terminate: async () => 0,
		};
		let created = 0;
		const backend = disposables.add(new ParadisSpreadsheetParseWorkerBackend(() => { created++; return worker as unknown as IParadisSpreadsheetParseWorker; }));
		const first = backend.warm(CancellationToken.None);
		const second = backend.warm(CancellationToken.None);
		const whileWaiting = posted.length;
		for (const listener of listeners.get('message') ?? []) { listener({ kind: 'result', id: posted[0].id, result: { kind: 'warm' } } as never); }
		const results = [await first, await second, await backend.warm(CancellationToken.None)];
		deepStrictEqual({ whileWaiting, posted: posted.length, created, results }, { whileWaiting: 1, posted: 1, created: 1, results: [{ kind: 'warm' }, { kind: 'warm' }, { kind: 'warm' }] });
	});

	test('parses in the worker the same workbook the shared process parses, and reports what it cannot read', async () => {
		// The Electron renderer test host cannot launch worker_threads. The node unit runner is the
		// production execution boundary (the shared process) and runs this test.
		if (process.type === 'renderer') { return; }
		const factory = await ParadisSpreadsheetParseWorkerBackend.workerFactory(WORKER_PATH);
		const backend = disposables.add(new ParadisSpreadsheetParseWorkerBackend(factory!));
		const bytes = await inventedWorkbook();
		const inProcess = await new ParadisSpreadsheetService().parseWorkbook(bytes.toString('base64'));

		const warm = await backend.warm(CancellationToken.None);
		const parsed = await backend.parse(new Uint8Array(bytes), undefined, CancellationToken.None);
		const broken = await backend.parse(new TextEncoder().encode('not a workbook'), undefined, CancellationToken.None);

		deepStrictEqual({
			missingWorker: await ParadisSpreadsheetParseWorkerBackend.workerFactory(`${WORKER_PATH}.missing`),
			warm,
			same: parsed.kind === 'workbookJson' && JSON.stringify(unpackParadisWorkbookStyles(decodeParadisWorkbookJson(parsed.json))) === JSON.stringify(inProcess),
			styles: parsed.kind === 'workbookJson' ? decodeParadisWorkbookJson(parsed.json).cellStyles.length < 10 : undefined,
			broken: broken.kind,
		}, { missingWorker: undefined, warm: { kind: 'warm' }, same: true, styles: true, broken: 'error' });
	});
});
