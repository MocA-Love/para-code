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
import { unpackParadisWorkbookStyles } from '../../common/spreadsheet/paradisSpreadsheetStyleTable.js';
import { ParadisSpreadsheetService } from '../../node/paradisSpreadsheetService.js';
import type { ParadisOfficeSemanticWorkerMessage } from '../../node/office/paradisOfficeSemanticWorkerQueue.js';
import { ParadisSpreadsheetParseWorkerBackend, type IParadisSpreadsheetParseWorker, type IParadisSpreadsheetParseWorkerRun } from '../../node/spreadsheet/paradisSpreadsheetParseWorkerBackend.js';

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
			same: parsed.kind === 'workbook' && JSON.stringify(unpackParadisWorkbookStyles(parsed.workbook)) === JSON.stringify(inProcess),
			styles: parsed.kind === 'workbook' ? parsed.workbook.cellStyles.length < 10 : undefined,
			broken: broken.kind,
		}, { missingWorker: undefined, warm: { kind: 'warm' }, same: true, styles: true, broken: 'error' });
	});
});
