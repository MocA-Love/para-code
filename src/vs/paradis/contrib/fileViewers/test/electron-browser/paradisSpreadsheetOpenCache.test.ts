/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import { deepStrictEqual } from 'assert';
import { VSBuffer } from '../../../../../base/common/buffer.js';
import { URI } from '../../../../../base/common/uri.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { FileOperationError, FileOperationResult, IFileContent, IFileService, IReadFileOptions } from '../../../../../platform/files/common/files.js';
import { ISharedProcessService } from '../../../../../platform/ipc/electron-browser/services.js';
import { ParadisOfficeOpenCache } from '../../common/paradisOfficeOpenCache.js';
import type { IParadisWorkbookData } from '../../common/paradisSpreadsheet.js';
import { openSpreadsheetResource, type IParadisSpreadsheetOpenCacheValue } from '../../electron-browser/paradisSpreadsheetClient.js';

suite('ParadisSpreadsheetOpenCache', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	test('parses a workbook once and reuses it while the file is unchanged', async () => {
		const events: string[] = [];
		let etag = 'v1';
		const fileService = {
			async readFile(resource: URI, options?: IReadFileOptions): Promise<IFileContent> {
				if (options?.etag === etag) {
					events.push(`not modified ${options.etag}`);
					throw new FileOperationError('not modified', FileOperationResult.FILE_NOT_MODIFIED_SINCE);
				}
				events.push(`read ${etag}`);
				// A ZIP header is enough for the viewer to send the bytes to the parser.
				const value = VSBuffer.wrap(Uint8Array.of(0x50, 0x4B, 0x03, 0x04, etag.length));
				return { resource, name: 'book.xlsx', value, size: value.byteLength, etag, mtime: 1, ctime: 1, readonly: false, locked: false, executable: false };
			}
		} as unknown as IFileService;
		const sharedProcessService = {
			getChannel: () => ({
				call: async (command: string): Promise<IParadisWorkbookData> => {
					events.push(`${command} ${etag}`);
					return { sheets: [{ name: etag, rows: [{ excelRow: 1, height: 20, cells: [{ value: 'x', style: {} }] }], columnCount: 1, columnWidths: [80], truncated: false, minCol: 1 }] };
				},
			}),
		} as unknown as ISharedProcessService;
		const cache = new ParadisOfficeOpenCache<IParadisSpreadsheetOpenCacheValue>({ maxEntries: 3, maxBytes: 1024 * 1024, idleMs: 1000 });
		const resource = URI.file('/w/book.xlsx');
		const sizes: number[] = [];
		const open = async () => {
			const opened = await openSpreadsheetResource(fileService, sharedProcessService, resource, cache, totalBytes => sizes.push(totalBytes));
			return { sheet: opened.workbook.sheets[0].name, fromCache: opened.fromCache };
		};

		const results = [await open(), await open()];
		etag = 'v22';
		results.push(await open(), await open());
		deepStrictEqual({ results, events, sizes }, {
			results: [{ sheet: 'v1', fromCache: false }, { sheet: 'v1', fromCache: true }, { sheet: 'v22', fromCache: false }, { sheet: 'v22', fromCache: true }],
			events: ['read v1', 'parseWorkbook v1', 'not modified v1', 'read v22', 'parseWorkbook v22', 'not modified v22'],
			sizes: [5, 5, 5, 5],
		});
	});
});
