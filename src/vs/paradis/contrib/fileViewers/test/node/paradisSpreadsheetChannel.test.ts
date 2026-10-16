/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-PATCH/PARA-CODE comments)
// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import { deepStrictEqual, strictEqual, throws } from 'assert';
import { VSBuffer } from '../../../../../base/common/buffer.js';
import { CancellationToken } from '../../../../../base/common/cancellation.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { ParadisSpreadsheetChannel } from '../../node/paradisSpreadsheetChannel.js';
import type { IParadisSpreadsheetService, IParadisWorkbookData } from '../../common/paradisSpreadsheet.js';
import type { ParadisSpreadsheetParseWorkerResult } from '../../node/spreadsheet/paradisSpreadsheetParseWorkerBackend.js';

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

	test('passes the workbook bytes and a numeric image budget, never diagnostics options', async () => {
		const received: unknown[][] = [];
		const channel = new ParadisSpreadsheetChannel(async () => ({
			parseWorkbook: async (...args: unknown[]) => { received.push(args); return workbook; },
		}));

		await channel.call('window:1', 'parseWorkbook', ['a', { semanticDiagnostics: true }]);
		await channel.call('window:1', 'parseWorkbook', ['b', 5]);

		deepStrictEqual(received, [['a', undefined], ['b', 5]]);
	});

	test('sends the workbook bytes to the metafile worker once created, and turns away what it cannot send', async () => {
		const received: number[] = [];
		let created = 0;
		const channel = new ParadisSpreadsheetChannel(
			async () => createService(),
			async () => ({ collect: async () => { throw new Error('unused'); } }),
			async () => {
				created++;
				return { convert: async (bytes: Uint8Array) => { received.push(bytes.byteLength); return { images: { 'image1.emf': 'data:image/svg+xml;base64,AA==' } }; } };
			},
		);
		const results = [
			await channel.call('window:1', 'convertMetafiles', [VSBuffer.wrap(new Uint8Array(3))], CancellationToken.None),
			await channel.call('window:1', 'convertMetafiles', [new Uint8Array(5)], CancellationToken.None),
			await channel.call('window:1', 'convertMetafiles', ['not bytes'], CancellationToken.None),
			await channel.call('window:1', 'convertMetafiles', [new Uint8Array(20 * 1024 * 1024 + 1)], CancellationToken.None),
		];
		channel.dispose();
		deepStrictEqual({ received, created, results }, {
			received: [3, 5],
			created: 1,
			results: [
				{ images: { 'image1.emf': 'data:image/svg+xml;base64,AA==' } },
				{ images: { 'image1.emf': 'data:image/svg+xml;base64,AA==' } },
				{ images: {}, unavailableReason: 'invalid' },
				{ images: {}, unavailableReason: 'tooLarge' },
			],
		});
	});

	test('parses in the worker when there is one, and in the shared process when the worker cannot', async () => {
		const packed = { sheets: [], cellStyles: [] };
		const replies: ParadisSpreadsheetParseWorkerResult[] = [
			{ kind: 'workbook', workbook: packed },
			{ kind: 'error', message: 'Cannot merge already merged cells' },
			{ kind: 'unavailable', reason: 'failed' },
			{ kind: 'unavailable', reason: 'busy' },
			{ kind: 'unavailable', reason: 'limitExceeded' },
		];
		const sent: (string | number | undefined)[][] = [];
		const parsedInProcess: string[] = [];
		const channel = new ParadisSpreadsheetChannel(
			async () => ({ parseWorkbook: async (input: string) => { parsedInProcess.push(input); return workbook; } }),
			undefined,
			undefined,
			async () => ({
				parse: async (bytes: Uint8Array, budget: number | undefined) => { sent.push([Buffer.from(bytes).toString('latin1'), budget]); return replies.shift()!; },
				warm: async () => ({ kind: 'warm' }),
			}),
		);
		const base64 = (text: string) => Buffer.from(text, 'latin1').toString('base64');
		const outcomes: unknown[] = [];
		for (const input of ['PK-1', 'PK-2', 'PK-3', 'PK-4', 'PK-5', '\xD0\xCF\x11\xE0-encrypted']) {
			try {
				outcomes.push(await channel.call('window:1', 'parseWorkbook', [base64(input), 9], CancellationToken.None));
			} catch (error) {
				outcomes.push((error as Error).message);
			}
		}
		channel.dispose();
		deepStrictEqual({ outcomes, sent, parsedInProcess }, {
			outcomes: [packed, 'Cannot merge already merged cells', workbook, workbook, workbook, workbook],
			sent: [['PK-1', 9], ['PK-2', 9], ['PK-3', 9], ['PK-4', 9], ['PK-5', 9]],
			parsedInProcess: [base64('PK-3'), base64('PK-4'), base64('PK-5'), base64('\xD0\xCF\x11\xE0-encrypted')],
		});
	});

	test('warms the parse worker on request without waiting for it, and does nothing without a worker', async () => {
		let warmed = 0;
		let created = 0;
		const finishWarm: (() => void)[] = [];
		const channel = new ParadisSpreadsheetChannel(async () => createService(), undefined, undefined, async () => {
			created++;
			return { parse: async () => { throw new Error('unused'); }, warm: () => { warmed++; return new Promise(resolve => finishWarm.push(() => resolve({ kind: 'warm' }))); } };
		});
		const withoutWorker = new ParadisSpreadsheetChannel(async () => createService());
		const replies = [
			await channel.call('window:1', 'warmParser', [], CancellationToken.None),
			await channel.call('window:1', 'warmParser', [], CancellationToken.None),
			await withoutWorker.call('window:1', 'warmParser', [], CancellationToken.None),
		];
		await new Promise(resolve => setTimeout(resolve, 0));
		finishWarm.forEach(finish => finish());
		channel.dispose();
		withoutWorker.dispose();
		deepStrictEqual({ replies, warmed, created }, { replies: [undefined, undefined, undefined], warmed: 2, created: 1 });
	});

	test('parses in the shared process when no worker is given', async () => {
		const parsedInProcess: string[] = [];
		const channel = new ParadisSpreadsheetChannel(async () => ({ parseWorkbook: async (input: string) => { parsedInProcess.push(input); return workbook; } }));
		const result = await channel.call('window:1', 'parseWorkbook', ['UEs='], CancellationToken.None);
		deepStrictEqual({ result, parsedInProcess }, { result: workbook, parsedInProcess: ['UEs='] });
	});
});
