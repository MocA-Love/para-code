/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { InMemoryStorageService, StorageScope, StorageTarget } from '../../../../../platform/storage/common/storage.js';
import { configureParadisDiagnosticReporter } from '../../../sentry/common/paradisSentryDiagnostics.js';
import { ParadisBookmarksService } from '../../electron-browser/paradisBookmarksService.js';

const BOOKMARKS_STORAGE_KEY = 'paradis.browser.bookmarks';
const BOOKMARKS_STORAGE_RECOVERY_BACKUP_KEY = 'paradis.browser.bookmarks.recoveryBackup';

suite('Paradis bookmarks service storage recovery', () => {

	const store = ensureNoDisposablesAreLeakedInTestSuite();

	function createService(
		storedBookmarks: string,
		captureStorage?: (storage: InMemoryStorageService) => void,
	): { readonly service: ParadisBookmarksService; readonly storage: InMemoryStorageService } {
		const storage = store.add(new InMemoryStorageService());
		storage.store(BOOKMARKS_STORAGE_KEY, storedBookmarks, StorageScope.APPLICATION, StorageTarget.USER);
		captureStorage?.(storage);
		return {
			service: store.add(new ParadisBookmarksService(storage)),
			storage,
		};
	}

	test('replaces corrupt JSON with an empty canonical tree before future writes', () => {
		const { service, storage } = createService('{not valid json');

		assert.deepStrictEqual(service.nodes, []);
		assert.strictEqual(storage.get(BOOKMARKS_STORAGE_KEY, StorageScope.APPLICATION), '[]');
		assert.strictEqual(storage.get(BOOKMARKS_STORAGE_RECOVERY_BACKUP_KEY, StorageScope.APPLICATION), '{not valid json');

		const inserted = service.addBookmark({ url: 'https://inserted.example/', title: 'Inserted' });

		assert.deepStrictEqual(JSON.parse(storage.get(BOOKMARKS_STORAGE_KEY, StorageScope.APPLICATION)!), JSON.parse(JSON.stringify([inserted])));
	});

	test('reports corrupt storage with a fixed error without exposing bookmark content', () => {
		const storedBookmarks = '{"title":"private-title","url":"file:///Users/alice/secret.ts",}';
		const reports: Array<{
			readonly scope: string;
			readonly feature: string;
			readonly operation: string;
			readonly error: unknown;
			readonly safeExtra: Record<string, unknown> | undefined;
			readonly severity: string | undefined;
		}> = [];
		let storageAtReport: InMemoryStorageService | undefined;
		configureParadisDiagnosticReporter((scope, feature, operation, error, safeExtra, severity) => {
			assert.ok(storageAtReport);
			assert.strictEqual(
				storageAtReport.get(BOOKMARKS_STORAGE_RECOVERY_BACKUP_KEY, StorageScope.APPLICATION),
				storedBookmarks,
			);
			assert.strictEqual(
				storageAtReport.get(BOOKMARKS_STORAGE_KEY, StorageScope.APPLICATION),
				storedBookmarks,
			);
			reports.push({ scope, feature, operation, error, safeExtra, severity });
		});

		try {
			const { service, storage } = createService(storedBookmarks, value => {
				storageAtReport = value;
			});

			assert.deepStrictEqual(service.nodes, []);
			assert.strictEqual(
				storage.get(BOOKMARKS_STORAGE_RECOVERY_BACKUP_KEY, StorageScope.APPLICATION),
				storedBookmarks,
			);
			assert.deepStrictEqual(reports.map(report => ({
				scope: report.scope,
				feature: report.feature,
				operation: report.operation,
				name: report.error instanceof Error ? report.error.name : undefined,
				message: report.error instanceof Error ? report.error.message : undefined,
				safeExtra: report.safeExtra,
				severity: report.severity,
			})), [{
				scope: 'owned',
				feature: 'browser-bookmarks',
				operation: 'storage-corrupt',
				name: 'Error',
				message: 'Browser bookmark storage could not be parsed',
				safeExtra: undefined,
				severity: 'warning',
			}]);
			const reportedError = reports[0].error as Error & { readonly cause?: unknown };
			assert.strictEqual(reportedError.cause, undefined);
			assert.deepStrictEqual(Object.keys(reportedError), []);
			for (const rawNeedle of ['private-title', 'file:///Users/alice/secret.ts', '/Users/alice']) {
				assert.ok(!reportedError.name.includes(rawNeedle));
				assert.ok(!reportedError.message.includes(rawNeedle));
				assert.ok(!String(reportedError.cause).includes(rawNeedle));
				assert.ok(!String(reportedError.stack).includes(rawNeedle));
			}
		} finally {
			configureParadisDiagnosticReporter(() => { });
		}
	});

	test('migrates legacy roots, reassigns duplicate ids, and persists later mutations', () => {
		const { service, storage } = createService(JSON.stringify({
			version: 1,
			root: {
				children: [
					{ id: 'first', type: 'bookmark', url: 'https://first.example/', title: 'First', createdAt: 1 },
					{ id: 'first', type: 'bookmark', url: 'https://second.example', title: 'Duplicate ID', createdAt: 2 },
					{ id: 'duplicate-url', type: 'bookmark', url: 'https://first.example', title: 'Duplicate URL', createdAt: 3 },
					{
						id: 'folder',
						type: 'folder',
						title: 'Folder',
						createdAt: 4,
						children: [
							{ id: 'nested', type: 'bookmark', url: 'https://nested.example', title: 'Nested', createdAt: 5 },
						],
					},
				],
			},
		}));

		const reassignedId = service.nodes[1].id;
		assert.deepStrictEqual(service.nodes.map(node => node.id), ['first', reassignedId, 'duplicate-url', 'folder']);
		assert.notStrictEqual(reassignedId, 'first');
		assert.strictEqual(service.isBookmarked('https://first.example'), true);
		assert.strictEqual(service.isBookmarked('https://second.example'), true);
		const recovered = JSON.parse(storage.get(BOOKMARKS_STORAGE_KEY, StorageScope.APPLICATION)!);
		assert.deepStrictEqual(recovered, JSON.parse(JSON.stringify(service.nodes)));
		const reconstructed = store.add(new ParadisBookmarksService(storage));
		assert.deepStrictEqual(JSON.parse(JSON.stringify(reconstructed.nodes)), recovered);

		const inserted = reconstructed.addBookmark({ url: 'https://inserted.example/', title: 'Inserted', folderId: 'folder' });
		reconstructed.moveNode('folder', 'first');
		reconstructed.removeNode('first');

		assert.strictEqual(inserted?.url, 'https://inserted.example');
		assert.deepStrictEqual(reconstructed.nodes, [
			{
				id: 'folder',
				type: 'folder',
				title: 'Folder',
				icon: undefined,
				color: undefined,
				createdAt: 4,
				children: [
					{ id: 'nested', type: 'bookmark', url: 'https://nested.example', title: 'Nested', faviconHash: undefined, createdAt: 5 },
					inserted,
				],
			},
			{ id: reassignedId, type: 'bookmark', url: 'https://second.example', title: 'Duplicate ID', faviconHash: undefined, createdAt: 2 },
			{ id: 'duplicate-url', type: 'bookmark', url: 'https://first.example', title: 'Duplicate URL', faviconHash: undefined, createdAt: 3 },
		]);
		assert.deepStrictEqual(JSON.parse(storage.get(BOOKMARKS_STORAGE_KEY, StorageScope.APPLICATION)!), [
			{
				id: 'folder',
				type: 'folder',
				title: 'Folder',
				createdAt: 4,
				children: [
					{ id: 'nested', type: 'bookmark', url: 'https://nested.example', title: 'Nested', createdAt: 5 },
					{
						id: inserted!.id,
						type: 'bookmark',
						url: 'https://inserted.example',
						title: 'Inserted',
						createdAt: inserted!.createdAt,
					},
				],
			},
			{ id: reassignedId, type: 'bookmark', url: 'https://second.example', title: 'Duplicate ID', createdAt: 2 },
			{ id: 'duplicate-url', type: 'bookmark', url: 'https://first.example', title: 'Duplicate URL', createdAt: 3 },
		]);
	});

	test('retains duplicate bookmark URLs created through the service after reconstruction', () => {
		const storage = store.add(new InMemoryStorageService());
		const service = store.add(new ParadisBookmarksService(storage));
		const original = service.addBookmark({ url: 'https://duplicate.example/', title: 'Original' });
		assert.ok(original);
		const duplicate = service.duplicateBookmark(original.id);
		assert.ok(duplicate);

		const reconstructed = store.add(new ParadisBookmarksService(storage));

		assert.deepStrictEqual(reconstructed.nodes.map(node => node.id), [original.id, duplicate.id]);
		assert.deepStrictEqual(reconstructed.nodes.map(node => node.type === 'bookmark' ? node.url : undefined), ['https://duplicate.example', 'https://duplicate.example']);
	});

	test('treats a legacy payload without a root as an empty tree', () => {
		const { service, storage } = createService(JSON.stringify({ version: 1 }));

		assert.deepStrictEqual(service.nodes, []);
		assert.strictEqual(storage.get(BOOKMARKS_STORAGE_KEY, StorageScope.APPLICATION), '[]');
	});
});
