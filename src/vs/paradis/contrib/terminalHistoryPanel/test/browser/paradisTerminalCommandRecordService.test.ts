/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import assert from 'assert';
import { CancellationToken } from '../../../../../base/common/cancellation.js';
import { Schemas } from '../../../../../base/common/network.js';
import { joinPath } from '../../../../../base/common/resources.js';
import { URI } from '../../../../../base/common/uri.js';
import { runWithFakedTimers } from '../../../../../base/test/common/virtualScheduling/runWithFakedTimers.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { IEnvironmentService } from '../../../../../platform/environment/common/environment.js';
import { FileService } from '../../../../../platform/files/common/fileService.js';
import { InMemoryFileSystemProvider } from '../../../../../platform/files/common/inMemoryFilesystemProvider.js';
import { NullLogService } from '../../../../../platform/log/common/log.js';
import { ParadisTerminalCommandRecordService } from '../../browser/paradisTerminalCommandRecordService.js';
import { IParadisCommandRecord, paradisParseCommandRecords } from '../../common/paradisTerminalCommandRecords.js';

const USER_DATA = URI.from({ scheme: Schemas.inMemory, path: '/User' });

function record(command: string, timestamp: number): IParadisCommandRecord {
	return { command, timestamp, cwd: '/work', exitCode: 0, duration: 5 };
}

suite('ParadisTerminalCommandRecordService', () => {
	const store = ensureNoDisposablesAreLeakedInTestSuite();

	test('keeps the records of terminals without a space history folder in the user data', () => runWithFakedTimers({ useFakeTimers: true }, async () => {
		const fileService = store.add(new FileService(new NullLogService()));
		store.add(fileService.registerProvider(Schemas.inMemory, store.add(new InMemoryFileSystemProvider())));
		const environmentService = { userRoamingDataHome: USER_DATA } as IEnvironmentService;
		const service = store.add(new ParadisTerminalCommandRecordService(fileService, new NullLogService(), environmentService));

		service.record(undefined, record('git status', 1));
		service.record(undefined, record('npm test', 2));
		const beforeFlush = await service.read(undefined, CancellationToken.None);
		await new Promise(resolve => setTimeout(resolve, 2_000));
		const content = (await fileService.readFile(joinPath(USER_DATA, 'paradis', 'terminalCommands.jsonl'))).value.toString();

		assert.deepStrictEqual({
			beforeFlush: beforeFlush.map(r => r.command),
			written: paradisParseCommandRecords(content),
		}, {
			beforeFlush: ['git status', 'npm test'],
			written: [record('git status', 1), record('npm test', 2)],
		});
	}));
});
