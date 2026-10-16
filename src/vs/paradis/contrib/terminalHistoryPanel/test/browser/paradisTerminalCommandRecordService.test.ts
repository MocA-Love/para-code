/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import assert from 'assert';
import { VSBuffer } from '../../../../../base/common/buffer.js';
import { CancellationToken } from '../../../../../base/common/cancellation.js';
import { Schemas } from '../../../../../base/common/network.js';
import { URI } from '../../../../../base/common/uri.js';
import { runWithFakedTimers } from '../../../../../base/test/common/virtualScheduling/runWithFakedTimers.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { FileService } from '../../../../../platform/files/common/fileService.js';
import { InMemoryFileSystemProvider } from '../../../../../platform/files/common/inMemoryFilesystemProvider.js';
import { NullLogService } from '../../../../../platform/log/common/log.js';
import { ParadisTerminalCommandRecordService, paradisRegisterCommonCommandRecordsFile } from '../../browser/paradisTerminalCommandRecordService.js';
import { IParadisCommandRecord, paradisSerializeCommandRecord } from '../../common/paradisTerminalCommandRecords.js';

const COMMON_FILE = URI.from({ scheme: Schemas.inMemory, path: '/userData/paradisTerminalCommands/commands.jsonl' });

function record(command: string, timestamp: number): IParadisCommandRecord {
	return { command, timestamp, cwd: '/work', exitCode: 0, duration: 5 };
}

suite('ParadisTerminalCommandRecordService', () => {
	const store = ensureNoDisposablesAreLeakedInTestSuite();

	test('appends the records of terminals without a space history folder to the private file, keeping lines another window wrote', () => runWithFakedTimers({ useFakeTimers: true }, async () => {
		const fileService = store.add(new FileService(new NullLogService()));
		store.add(fileService.registerProvider(Schemas.inMemory, store.add(new InMemoryFileSystemProvider())));
		// main プロセスが用意したファイル（ここでは空のファイルを置いておく）。
		await fileService.writeFile(COMMON_FILE, VSBuffer.fromString(''));
		store.add(paradisRegisterCommonCommandRecordsFile(async () => COMMON_FILE));
		const service = store.add(new ParadisTerminalCommandRecordService(fileService, new NullLogService()));

		service.record(undefined, record('git status', 1));
		const beforeFlush = await service.read(undefined, CancellationToken.None);
		await new Promise(resolve => setTimeout(resolve, 2_000));
		// 別のウィンドウが追記した行。
		await fileService.writeFile(COMMON_FILE, VSBuffer.fromString(paradisSerializeCommandRecord(record('make', 2)) + '\n'), { append: true });
		service.record(undefined, record('npm test', 3));
		await new Promise(resolve => setTimeout(resolve, 2_000));
		const content = (await fileService.readFile(COMMON_FILE)).value.toString();

		assert.deepStrictEqual({
			beforeFlush: beforeFlush.map(r => r.command),
			written: content.trimEnd().split('\n').map(line => JSON.parse(line).c),
		}, {
			beforeFlush: ['git status'],
			written: ['git status', 'make', 'npm test'],
		});
	}));

	test('does not create the records file itself when the private file is not there', () => runWithFakedTimers({ useFakeTimers: true }, async () => {
		const fileService = store.add(new FileService(new NullLogService()));
		store.add(fileService.registerProvider(Schemas.inMemory, store.add(new InMemoryFileSystemProvider())));
		const service = store.add(new ParadisTerminalCommandRecordService(fileService, new NullLogService()));

		// 共通のファイルを用意する口が無い（Web）、スペースのフォルダの記録を読む口も無い。
		service.record(undefined, record('git status', 1));
		service.record('/home/example/.para-code/terminal-history/0123456789abcdef', record('ls', 2));
		await new Promise(resolve => setTimeout(resolve, 2_000));

		const root = await fileService.resolve(URI.from({ scheme: Schemas.inMemory, path: '/' }));
		assert.deepStrictEqual((root.children ?? []).map(child => child.name), []);
	}));
});
