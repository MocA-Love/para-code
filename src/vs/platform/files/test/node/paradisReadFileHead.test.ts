/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import assert from 'assert';
import { promises } from 'fs';
import { tmpdir } from 'os';
import { CancellationToken } from '../../../../base/common/cancellation.js';
import { join } from '../../../../base/common/path.js';
import { ReadableStreamEvents } from '../../../../base/common/stream.js';
import { URI } from '../../../../base/common/uri.js';
import { getRandomTestPath } from '../../../../base/test/node/testUtils.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../base/test/common/utils.js';
import { NullLogService } from '../../../log/common/log.js';
import { FileService } from '../../common/fileService.js';
import { IFileAtomicReadOptions, IFileReadStreamOptions } from '../../common/files.js';
import { readParadisFileHead } from '../../common/paradisReadFileHead.js';
import { DiskFileSystemProvider } from '../../node/diskFileSystemProvider.js';

/** 提供側が渡された中身の量を記録する（全体を読む `readFile` と、流れで読む `readFileStream`）。 */
class RecordingDiskFileSystemProvider extends DiskFileSystemProvider {
	readonly calls: string[] = [];

	override async readFile(resource: URI, options?: IFileAtomicReadOptions): Promise<Uint8Array> {
		const bytes = await super.readFile(resource, options);
		this.calls.push(`readFile ${bytes.byteLength}`);
		return bytes;
	}

	override readFileStream(resource: URI, opts: IFileReadStreamOptions, token: CancellationToken): ReadableStreamEvents<Uint8Array> {
		this.calls.push(`readFileStream length=${opts.length}`);
		return super.readFileStream(resource, opts, token);
	}
}

suite('readParadisFileHead', () => {

	const store = ensureNoDisposablesAreLeakedInTestSuite();

	let root: string;

	setup(async () => {
		root = getRandomTestPath(tmpdir(), 'vsctests', 'paradisreadfilehead');
		await promises.mkdir(root, { recursive: true });
		const bytes = new Uint8Array(4 * 1024 * 1024).fill(0x41);
		bytes.set([0x25, 0x50, 0x44, 0x46, 0x2d]);
		await promises.writeFile(join(root, 'large.pdf'), bytes);
		await promises.writeFile(join(root, 'tiny.txt'), 'ab');
	});

	teardown(() => promises.rm(root, { recursive: true, force: true }));

	test('reads only the head from the provider, unlike readFile with a length', async () => {
		const fileService = store.add(new FileService(new NullLogService()));
		const provider = store.add(new RecordingDiskFileSystemProvider(new NullLogService()));
		store.add(fileService.registerProvider('file', provider));
		const large = URI.file(join(root, 'large.pdf'));

		const head = await readParadisFileHead(fileService, large, { length: 5 });
		const headCalls = provider.calls.splice(0);
		const whole = await fileService.readFile(large, { length: 5 });

		assert.deepStrictEqual({
			head: [...head.value.buffer],
			headSize: head.size,
			headCalls,
			wholeCalls: provider.calls,
			sameBytes: whole.value.toString() === head.value.toString(),
		}, {
			head: [0x25, 0x50, 0x44, 0x46, 0x2d],
			headSize: 4 * 1024 * 1024,
			headCalls: ['readFileStream length=5'],
			wholeCalls: [`readFile ${4 * 1024 * 1024}`],
			sameBytes: true,
		});
	});

	test('returns what exists when the file is shorter, and rejects a missing file', async () => {
		const fileService = store.add(new FileService(new NullLogService()));
		store.add(fileService.registerProvider('file', store.add(new DiskFileSystemProvider(new NullLogService()))));

		const tiny = await readParadisFileHead(fileService, URI.file(join(root, 'tiny.txt')), { length: 5 });
		const missing = await readParadisFileHead(fileService, URI.file(join(root, 'missing.pdf')), { length: 5 }).then(() => 'read', () => 'rejected');

		assert.deepStrictEqual({ tiny: tiny.value.toString(), missing }, { tiny: 'ab', missing: 'rejected' });
	});
});
