/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import assert from 'assert';
import { VSBuffer } from '../../../../../base/common/buffer.js';
import { joinPath } from '../../../../../base/common/resources.js';
import { URI } from '../../../../../base/common/uri.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { createFileSystemProviderError, FileSystemProviderErrorCode, IStat } from '../../../../../platform/files/common/files.js';
import { FileService } from '../../../../../platform/files/common/fileService.js';
import { InMemoryFileSystemProvider } from '../../../../../platform/files/common/inMemoryFilesystemProvider.js';
import { NullLogService } from '../../../../../platform/log/common/log.js';
import { InMemoryStorageService, StorageScope, StorageTarget } from '../../../../../platform/storage/common/storage.js';
import { ParadisTransferTempJournal } from '../../browser/paradisFileTransferTempJournal.js';
import {
	paradisJournalCleanable,
	paradisParseJournal,
	PARADIS_FILE_TRANSFER_JOURNAL_KEY,
	PARADIS_FILE_TRANSFER_JOURNAL_STALE_MS,
} from '../../common/paradisFileTransferJournal.js';
import { paradisIsTransferTempName, paradisTransferTempName } from '../../common/paradisFileTransferQueueTypes.js';

const DIR = URI.file('/work/out');
const noWait = async () => { };

suite('Paradis file transfer - temporary file journal', () => {

	const store = ensureNoDisposablesAreLeakedInTestSuite();

	test('the temporary name is short and does not contain the original name', () => {
		const temp = paradisTransferTempName('12-1-lq9z0-abcd');
		assert.deepStrictEqual({
			temp,
			isTemp: [temp, '.paratransfer-1', 'build.tar.gz', '.env', '.build.tar.gz.paratransfer-1'].map(paradisIsTransferTempName),
		}, {
			temp: '.paratransfer-12-1-lq9z0-abcd',
			isTemp: [true, true, false, false, false],
		});
	});

	test('cleans only entries whose writer stopped beating, or that were abandoned at shutdown', () => {
		const now = 10_000_000;
		const uri = (name: string) => joinPath(DIR, name).toString();
		const entries = [
			{ uri: uri('.paratransfer-own'), at: 0 },
			{ uri: uri('.paratransfer-fresh'), at: now - 1000 },
			{ uri: uri('.paratransfer-stale'), at: now - PARADIS_FILE_TRANSFER_JOURNAL_STALE_MS - 1 },
			{ uri: uri('.paratransfer-abandoned'), at: 0 },
			{ uri: uri('not-a-temp.txt'), at: 0 },
			{ uri: URI.from({ scheme: 'vscode-remote', authority: 'ssh-remote+other', path: '/x/.paratransfer-elsewhere' }).toString(), at: 0 },
		];
		const cleanable = paradisJournalCleanable(entries, new Set([uri('.paratransfer-own')]), now, candidate => candidate.scheme === 'file');
		assert.deepStrictEqual(cleanable.map(candidate => candidate.path), ['/work/out/.paratransfer-stale', '/work/out/.paratransfer-abandoned']);
	});

	test('records its own temporary files, abandons them at shutdown, and another window cleans them up', async () => {
		const fileService = store.add(new FileService(new NullLogService()));
		store.add(fileService.registerProvider('file', store.add(new InMemoryFileSystemProvider())));
		const storage = store.add(new InMemoryStorageService());
		const temp = joinPath(DIR, '.paratransfer-1-1-a-b');
		await fileService.writeFile(temp, VSBuffer.fromString('partial'));

		const writer = store.add(new ParadisTransferTempJournal(storage, fileService, new NullLogService()));
		writer.add(temp);
		const recorded = paradisParseJournal(storage.get(PARADIS_FILE_TRANSFER_JOURNAL_KEY, StorageScope.APPLICATION)).map(entry => entry.uri);
		// 書いているウィンドウ自身は、自分の一時ファイルを片付けない
		const ownCleanup = await writer.cleanup(() => true, noWait);
		writer.abandonOwn();

		const nextWindow = store.add(new ParadisTransferTempJournal(storage, fileService, new NullLogService()));
		const removed = await nextWindow.cleanup(() => true, noWait);

		assert.deepStrictEqual({
			recorded,
			ownCleanup,
			removed,
			exists: await fileService.exists(temp),
			journal: storage.get(PARADIS_FILE_TRANSFER_JOURNAL_KEY, StorageScope.APPLICATION),
		}, { recorded: [temp.toString()], ownCleanup: 0, removed: 1, exists: false, journal: undefined });
	});

	test('does not remove a file whose writer beats while the cleaner waits (after sleep)', async () => {
		const fileService = store.add(new FileService(new NullLogService()));
		store.add(fileService.registerProvider('file', store.add(new InMemoryFileSystemProvider())));
		const storage = store.add(new InMemoryStorageService());
		const temp = joinPath(DIR, '.paratransfer-2-1-a-b');
		await fileService.writeFile(temp, VSBuffer.fromString('partial'));
		let clock = 1_000_000;
		const writer = store.add(new ParadisTransferTempJournal(storage, fileService, new NullLogService(), () => clock));
		writer.add(temp);

		// スリープ明け: 心拍が途絶えたように見える時刻になっているが、書いている側はまだ生きている
		clock += PARADIS_FILE_TRANSFER_JOURNAL_STALE_MS + 1000;
		const cleaner = store.add(new ParadisTransferTempJournal(storage, fileService, new NullLogService(), () => clock));
		const removed = await cleaner.cleanup(() => true, async () => {
			clock += 1000;
			writer.beat();
		});

		assert.deepStrictEqual({ removed, exists: await fileService.exists(temp) }, { removed: 0, exists: true });
	});

	test('puts its own entry back on the next beat when another window overwrote the journal', async () => {
		const fileService = store.add(new FileService(new NullLogService()));
		store.add(fileService.registerProvider('file', store.add(new InMemoryFileSystemProvider())));
		const storage = store.add(new InMemoryStorageService());
		const temp = joinPath(DIR, '.paratransfer-4-1-a-b');
		const otherTemp = joinPath(DIR, '.paratransfer-5-1-a-b').toString();
		let clock = 1_000_000;
		const writer = store.add(new ParadisTransferTempJournal(storage, fileService, new NullLogService(), () => clock));
		writer.add(temp);

		// 別のウィンドウが古い控えを読んで自分の項目だけを足し、こちらの項目を上書きして消した
		storage.store(PARADIS_FILE_TRANSFER_JOURNAL_KEY, JSON.stringify([{ uri: otherTemp, at: clock }]), StorageScope.APPLICATION, StorageTarget.MACHINE);
		clock += 1000;
		writer.beat();

		assert.deepStrictEqual(paradisParseJournal(storage.get(PARADIS_FILE_TRANSFER_JOURNAL_KEY, StorageScope.APPLICATION)), [
			{ uri: otherTemp, at: 1_000_000 },
			{ uri: temp.toString(), at: 1_001_000 },
		]);
	});

	test('keeps an entry it could not check because the connection is down, and cleans it up later', async () => {
		let disconnected = true;
		const provider = store.add(new class extends InMemoryFileSystemProvider {
			override async stat(resource: URI): Promise<IStat> {
				if (disconnected) {
					throw createFileSystemProviderError('connection lost', FileSystemProviderErrorCode.Unavailable);
				}
				return super.stat(resource);
			}
		});
		const fileService = store.add(new FileService(new NullLogService()));
		store.add(fileService.registerProvider('file', provider));
		const storage = store.add(new InMemoryStorageService());
		const temp = joinPath(DIR, '.paratransfer-3-1-a-b');
		disconnected = false;
		await fileService.writeFile(temp, VSBuffer.fromString('partial'));
		disconnected = true;
		const writer = store.add(new ParadisTransferTempJournal(storage, fileService, new NullLogService()));
		writer.add(temp);
		writer.abandonOwn();

		const cleaner = store.add(new ParadisTransferTempJournal(storage, fileService, new NullLogService()));
		const whileDown = await cleaner.cleanup(() => true, noWait);
		const keptWhileDown = paradisParseJournal(storage.get(PARADIS_FILE_TRANSFER_JOURNAL_KEY, StorageScope.APPLICATION)).map(entry => entry.uri);
		disconnected = false;
		const afterReconnect = await cleaner.cleanup(() => true, noWait);

		assert.deepStrictEqual({ whileDown, keptWhileDown, afterReconnect, exists: await fileService.exists(temp) }, {
			whileDown: 0,
			keptWhileDown: [temp.toString()],
			afterReconnect: 1,
			exists: false,
		});
	});
});
