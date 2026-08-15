/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-PATCH/PARA-CODE comments)
// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import { rejects, strictEqual, throws } from 'assert';
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
		const channel = new ParadisSpreadsheetChannel(() => {
			factoryCalls++;
			return pendingService;
		});

		const first = channel.call<IParadisWorkbookData>('window:1', 'parseWorkbook', ['first']);
		const second = channel.call<IParadisWorkbookData>('window:1', 'parseWorkbook', ['second']);
		resolveService(createService());
		const results = await Promise.all([first, second]);

		strictEqual(factoryCalls, 1);
		strictEqual(results[0], workbook);
		strictEqual(results[1], workbook);
	});

	test('retries service creation after its first attempt rejects', async () => {
		let factoryCalls = 0;
		const factoryError = new Error('spreadsheet service unavailable');
		const channel = new ParadisSpreadsheetChannel(() => {
			factoryCalls++;
			return factoryCalls === 1 ? Promise.reject(factoryError) : Promise.resolve(createService());
		});

		await rejects(channel.call<IParadisWorkbookData>('window:1', 'parseWorkbook', ['first']), factoryError);
		const result = await channel.call<IParadisWorkbookData>('window:1', 'parseWorkbook', ['second']);

		strictEqual(factoryCalls, 2);
		strictEqual(result, workbook);
	});
});
