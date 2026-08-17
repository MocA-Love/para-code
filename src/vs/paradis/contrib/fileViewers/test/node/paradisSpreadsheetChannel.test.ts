/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-PATCH/PARA-CODE comments)
// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import { deepStrictEqual, strictEqual, throws } from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { ParadisSpreadsheetChannel } from '../../node/paradisSpreadsheetChannel.js';
import type { IParadisSpreadsheetService, IParadisWorkbookData } from '../../common/paradisSpreadsheet.js';

const workbook: IParadisWorkbookData = { sheets: [] };

function createService(): IParadisSpreadsheetService {
	return { parseWorkbook: async () => workbook };
}

suite('ParadisSpreadsheetChannel', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	test('does not create the spreadsheet service during construction', () => {
		let factoryCalls = 0;

		new ParadisSpreadsheetChannel(async () => {
			factoryCalls++;
			return createService();
		});

		strictEqual(factoryCalls, 0);
	});

	test('leaves the spreadsheet service uncreated when an unknown command throws', () => {
		let factoryCalls = 0;
		const channel = new ParadisSpreadsheetChannel(async () => {
			factoryCalls++;
			return createService();
		});

		throws(() => channel.call('window:1', 'unknownCommand'), /Method not found: unknownCommand/);

		strictEqual(factoryCalls, 0);
	});

	test('shares the first service creation across concurrent parse calls', async () => {
		let factoryCalls = 0;
		let resolveService!: (service: IParadisSpreadsheetService) => void;
		const pendingService = new Promise<IParadisSpreadsheetService>(resolve => resolveService = resolve);
		const receivedInputs: string[] = [];
		const firstWorkbook: IParadisWorkbookData = { sheets: [], themeColors: { accent1: 'first' } };
		const secondWorkbook: IParadisWorkbookData = { sheets: [], themeColors: { accent1: 'second' } };
		const channel = new ParadisSpreadsheetChannel(() => {
			factoryCalls++;
			return pendingService;
		});

		const first = channel.call<IParadisWorkbookData>('window:1', 'parseWorkbook', ['first']);
		const second = channel.call<IParadisWorkbookData>('window:1', 'parseWorkbook', ['second']);
		resolveService({
			parseWorkbook: async input => {
				receivedInputs.push(input);
				switch (input) {
					case 'first': return firstWorkbook;
					case 'second': return secondWorkbook;
					default: throw new Error(`Unexpected workbook input: ${input}`);
				}
			},
		});
		const results = await Promise.all([first, second]);

		strictEqual(factoryCalls, 1);
		deepStrictEqual(receivedInputs, ['first', 'second']);
		deepStrictEqual(results, [firstWorkbook, secondWorkbook]);
	});

	test('retries service creation after its first attempt rejects', async () => {
		let factoryCalls = 0;
		let rejectService!: (reason: Error) => void;
		const pendingService = new Promise<IParadisSpreadsheetService>((_resolve, reject) => rejectService = reject);
		const factoryError = new Error('spreadsheet service unavailable');
		const channel = new ParadisSpreadsheetChannel(() => {
			factoryCalls++;
			return factoryCalls === 1 ? pendingService : Promise.resolve(createService());
		});

		const first = channel.call<IParadisWorkbookData>('window:1', 'parseWorkbook', ['first']);
		const second = channel.call<IParadisWorkbookData>('window:1', 'parseWorkbook', ['second']);
		rejectService(factoryError);
		const rejections = await Promise.allSettled([first, second]);

		strictEqual(factoryCalls, 1);
		strictEqual(rejections[0].status, 'rejected');
		strictEqual(rejections[1].status, 'rejected');
		if (rejections[0].status !== 'rejected' || rejections[1].status !== 'rejected') {
			throw new Error('Expected both concurrent calls to reject');
		}
		strictEqual(rejections[0].reason, factoryError);
		strictEqual(rejections[1].reason, factoryError);

		const result = await channel.call<IParadisWorkbookData>('window:1', 'parseWorkbook', ['third']);

		strictEqual(factoryCalls, 2);
		strictEqual(result, workbook);
	});
});
