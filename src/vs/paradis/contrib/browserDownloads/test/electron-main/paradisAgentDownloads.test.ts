/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import { join } from '../../../../../base/common/path.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import {
	paradisAwaitAgentDownloadStart,
	paradisCancelAgentDownloadExpectation,
	paradisExpectAgentDownload,
	paradisIsAgentDownload,
	paradisNotifyAgentDownloadStarted,
	paradisSaveAgentFile,
	paradisSetWebContentsHeldByAgent,
	paradisWriteFileWithoutOverwrite,
} from '../../electron-main/paradisAgentDownloads.js';
import { IParadisDownloadsShell, ParadisBrowserDownloadsTracker } from '../../electron-main/paradisBrowserDownloadsTracker.js';

const shell: IParadisDownloadsShell = {
	openPath: async () => '',
	showItemInFolder: () => { },
	exists: () => true,
	ensureQuarantine: async () => true,
};

suite('paradisAgentDownloads', () => {
	const store = ensureNoDisposablesAreLeakedInTestSuite();
	let directory: string;

	setup(async () => {
		directory = await fs.promises.mkdtemp(join(os.tmpdir(), 'paradis-agent-downloads-'));
	});

	teardown(async () => {
		await fs.promises.rm(directory, { recursive: true, force: true });
	});

	test('a tab held by an agent or waiting for an agent click marks its downloads as agent downloads', async () => {
		const held = {};
		const waiting = {};
		const user = {};
		paradisSetWebContentsHeldByAgent(held, true);
		const expectation = paradisExpectAgentDownload(waiting, 5_000);
		assert.deepStrictEqual([paradisIsAgentDownload(held), paradisIsAgentDownload(waiting), paradisIsAgentDownload(user), paradisIsAgentDownload(undefined)], [true, true, false, false]);

		const started = paradisAwaitAgentDownloadStart(expectation);
		paradisNotifyAgentDownloadStarted(user, 'download-9');
		paradisNotifyAgentDownloadStarted(waiting, 'download-3');
		assert.strictEqual(await started, 'download-3');
		assert.strictEqual(paradisIsAgentDownload(waiting), false, 'the wait ends with the first download');

		paradisSetWebContentsHeldByAgent(held, false);
		assert.strictEqual(paradisIsAgentDownload(held), false);
	});

	test('a cancelled wait reports that nothing started', async () => {
		const tab = {};
		const expectation = paradisExpectAgentDownload(tab, 5_000);
		const started = paradisAwaitAgentDownloadStart(expectation);
		paradisCancelAgentDownloadExpectation(expectation);
		assert.strictEqual(await started, undefined);
		assert.strictEqual(paradisIsAgentDownload(tab), false);
	});

	test('files are never overwritten', async () => {
		const first = await paradisWriteFileWithoutOverwrite(directory, 'page.pdf', new Uint8Array([1]));
		const second = await paradisWriteFileWithoutOverwrite(directory, 'page.pdf', new Uint8Array([2]));
		assert.deepStrictEqual([first, second], [join(directory, 'page.pdf'), join(directory, 'page (1).pdf')]);
		assert.deepStrictEqual([...await fs.promises.readFile(first)], [1]);
	});

	test('a saved PDF is listed as an agent download that is never offered to open', async () => {
		const tracker = store.add(new ParadisBrowserDownloadsTracker(shell, () => directory));
		const path = await paradisSaveAgentFile(tracker, 'report.pdf', new Uint8Array([1, 2, 3]), 'https://example.com/');
		const settled = await tracker.whenSettled('download-1', 1_000);
		assert.deepStrictEqual(settled && [settled.filename, settled.state, settled.fromAgent, settled.openable, settled.totalBytes], ['report.pdf', 'completed', true, true, 3]);
		assert.strictEqual(await tracker.open('download-1'), false, 'agent files are shown in the folder only');
		assert.strictEqual(path, join(directory, 'report.pdf'));
	});
});
