/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import { deepStrictEqual, rejects } from 'assert';
import { timeout } from '../../../../../base/common/async.js';
import { VSBuffer } from '../../../../../base/common/buffer.js';
import { URI } from '../../../../../base/common/uri.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { runWithFakedTimers } from '../../../../../base/test/common/virtualScheduling/index.js';
import { FileOperationError, FileOperationResult, IFileContent, IFileService, IReadFileOptions } from '../../../../../platform/files/common/files.js';
import { ParadisOfficeOpenCache, readParadisOfficeFile } from '../../common/paradisOfficeOpenCache.js';

const limits = { maxEntries: 3, maxBytes: 100, idleMs: 1000 };

suite('ParadisOfficeOpenCache', () => {
	const disposables = ensureNoDisposablesAreLeakedInTestSuite();

	test('keeps the most recently opened files within the count and size limits', () => {
		const cache = new ParadisOfficeOpenCache<string>(limits);
		const file = (name: string) => URI.file(`/w/${name}.xlsx`);
		cache.set(file('a'), 'e', 'A', 10);
		cache.set(file('b'), 'e', 'B', 10);
		cache.set(file('c'), 'e', 'C', 10);
		cache.get(file('a'));
		cache.set(file('d'), 'e', 'D', 10);
		const afterCount = cache.resources.map(resource => URI.parse(resource).path);
		cache.set(file('e'), 'e', 'E', 45);
		cache.set(file('f'), 'e', 'F', 50);
		const afterSize = cache.resources.map(resource => URI.parse(resource).path);
		cache.set(file('huge'), 'e', 'H', 51);
		cache.set(URI.from({ scheme: 'git', path: '/w/a.xlsx' }), 'e', 'G', 1);
		cache.set(file('no-etag'), undefined, 'N', 1);
		deepStrictEqual({ afterCount, afterSize, last: cache.resources.map(resource => URI.parse(resource).path), totalBytes: cache.totalBytes }, {
			afterCount: ['/w/c.xlsx', '/w/a.xlsx', '/w/d.xlsx'],
			afterSize: ['/w/e.xlsx', '/w/f.xlsx'],
			last: ['/w/e.xlsx', '/w/f.xlsx'],
			totalBytes: 95,
		});
	});

	test('updates a file only while the same version is kept, and forgets it on request', () => {
		const cache = new ParadisOfficeOpenCache<{ readonly version: number; readonly extra?: string }>(limits);
		const resource = URI.file('/w/a.docx');
		cache.set(resource, 'e1', { version: 1 }, 10);
		cache.update(resource, value => value.version === 1 ? { ...value, extra: 'converted' } : undefined, 20);
		cache.update(resource, value => value.version === 2 ? { ...value, extra: 'stale' } : undefined);
		const updated = cache.get(resource);
		cache.update(resource, value => value, 60);
		const tooLarge = cache.get(resource);
		cache.set(resource, 'e2', { version: 2 }, 10);
		cache.delete(resource);
		deepStrictEqual({ updated, tooLarge, deleted: cache.get(resource), totalBytes: cache.totalBytes }, {
			updated: { etag: 'e1', value: { version: 1, extra: 'converted' } },
			tooLarge: undefined,
			deleted: undefined,
			totalBytes: 0,
		});
	});

	test('lets go of everything once no viewer has used it for a while', () => runWithFakedTimers({}, async () => {
		const cache = new ParadisOfficeOpenCache<string>(limits);
		const resource = URI.file('/w/a.xlsx');
		cache.set(resource, 'e', 'A', 10);
		const first = disposables.add(cache.acquire());
		const second = disposables.add(cache.acquire());
		first.dispose();
		await timeout(2000);
		const whileUsed = cache.resources.length;
		second.dispose();
		second.dispose();
		await timeout(500);
		const reacquired = disposables.add(cache.acquire());
		await timeout(2000);
		const afterReacquire = cache.resources.length;
		reacquired.dispose();
		await timeout(2000);
		deepStrictEqual({ whileUsed, afterReacquire, afterIdle: cache.resources.length }, { whileUsed: 1, afterReacquire: 1, afterIdle: 0 });
	}));

	test('reads the file once and then only checks its etag while it is unchanged', async () => {
		const reads: (string | undefined)[] = [];
		let etag = 'v1';
		let missing = false;
		const fileService: Pick<IFileService, 'readFile'> = {
			async readFile(resource: URI, options?: IReadFileOptions): Promise<IFileContent> {
				reads.push(options?.etag);
				if (missing) {
					throw new FileOperationError('missing', FileOperationResult.FILE_NOT_FOUND);
				}
				if (options?.etag === etag) {
					throw new FileOperationError('not modified', FileOperationResult.FILE_NOT_MODIFIED_SINCE);
				}
				const value = VSBuffer.fromString(etag);
				return { resource, name: 'a.xlsx', value, size: value.byteLength, etag, mtime: 1, ctime: 1, readonly: false, locked: false, executable: false };
			}
		};
		const cache = new ParadisOfficeOpenCache<string>(limits);
		const resource = URI.file('/w/a.xlsx');
		const open = async () => {
			const read = await readParadisOfficeFile(fileService, resource, cache, 1024);
			if (read.kind === 'cached') {
				return `cached:${read.value}`;
			}
			const parsed = `parsed:${read.content.value.toString()}`;
			cache.set(resource, read.content.etag, parsed, 1);
			return parsed;
		};

		const results = [await open(), await open()];
		etag = 'v2';
		results.push(await open(), await open());
		missing = true;
		await rejects(open());
		deepStrictEqual({ results, reads, keptAfterMissing: cache.resources.length }, {
			results: ['parsed:v1', 'cached:parsed:v1', 'parsed:v2', 'cached:parsed:v2'],
			reads: [undefined, 'v1', 'v1', 'v2', 'v2'],
			keptAfterMissing: 0,
		});
	});
});
