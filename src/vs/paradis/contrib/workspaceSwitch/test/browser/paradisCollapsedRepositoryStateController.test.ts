/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { ILogService } from '../../../../../platform/log/common/log.js';
import { IStorageService, StorageScope, StorageTarget } from '../../../../../platform/storage/common/storage.js';
import { IParadisWorkspaceRepository, IParadisWorktree } from '../../common/paradisWorkspaceSwitch.js';
import { PARADIS_COLLAPSED_REPOSITORIES_STORAGE_KEY } from '../../common/paradisWorkspaceTreeState.js';
import { IParadisCollapsedStateScheduler, ParadisCollapsedRepositoryStateController } from '../../browser/paradisCollapsedRepositoryStateController.js';

suite('ParadisCollapsedRepositoryStateController', () => {
	const store = ensureNoDisposablesAreLeakedInTestSuite();

	test('restores state in a recreated view and persists via WORKSPACE + MACHINE after 100ms debounce', () => {
		const storage = new TestStorageService('[' + JSON.stringify('repo-a') + ']');
		const firstScheduler = new TestScheduler();
		const first = store.add(createController(storage, firstScheduler));
		assert.strictEqual(first.isRepositoryCollapsed('repo-a'), true);

		first.recordTreeCollapse(repository('repo-b'), true);
		first.recordTreeCollapse(repository('repo-c'), true);
		assert.deepStrictEqual(firstScheduler.delays, [100, 100]);
		assert.strictEqual(storage.writes.length, 0);
		firstScheduler.run();

		assert.strictEqual(storage.writes.length, 1);
		assert.deepStrictEqual(storage.writes[0], {
			key: PARADIS_COLLAPSED_REPOSITORIES_STORAGE_KEY,
			value: '["repo-a","repo-b","repo-c"]',
			scope: StorageScope.WORKSPACE,
			target: StorageTarget.MACHINE,
		});

		const recreated = store.add(createController(storage, new TestScheduler()));
		assert.strictEqual(recreated.isRepositoryCollapsed('repo-a'), true);
		assert.strictEqual(recreated.isRepositoryCollapsed('repo-b'), true);
		assert.strictEqual(recreated.isRepositoryCollapsed('repo-c'), true);
	});

	test('ignores worktree collapse events and removes deleted repository ids', () => {
		const storage = new TestStorageService('["repo-a","repo-deleted"]');
		const scheduler = new TestScheduler();
		const controller = store.add(createController(storage, scheduler));

		controller.recordTreeCollapse(worktree('repo-a'), true);
		assert.deepStrictEqual(scheduler.delays, []);
		controller.removeStaleRepositories(new Set(['repo-a']));
		assert.deepStrictEqual(scheduler.delays, [100]);
		scheduler.run();

		assert.strictEqual(storage.value, '["repo-a"]');
	});

	test('flushes dirty state on dispose', () => {
		const storage = new TestStorageService();
		const scheduler = new TestScheduler();
		const controller = createController(storage, scheduler);

		controller.recordTreeCollapse(repository('repo-a'), true);
		controller.dispose();

		assert.strictEqual(scheduler.cancelCount, 1);
		assert.strictEqual(storage.value, '["repo-a"]');
	});

	test('retries a failed save without dropping dirty state', () => {
		const storage = new TestStorageService();
		storage.failuresRemaining = 1;
		const scheduler = new TestScheduler();
		const controller = store.add(createController(storage, scheduler));

		controller.recordTreeCollapse(repository('repo-a'), true);
		scheduler.run();
		assert.deepStrictEqual(scheduler.delays, [100, 1_000]);
		assert.strictEqual(storage.value, undefined);

		scheduler.run();
		assert.strictEqual(storage.value, '["repo-a"]');
	});

	test('does not overwrite valid storage with an unreadable oversized snapshot', () => {
		const storage = new TestStorageService('["repo-valid"]');
		const scheduler = new TestScheduler();
		const controller = store.add(createController(storage, scheduler));

		for (let index = 0; index < 1_025; index++) {
			controller.recordTreeCollapse(repository(`repo-${index}`), true);
		}
		scheduler.run();

		assert.strictEqual(storage.value, '["repo-valid"]');
		assert.strictEqual(storage.writes.length, 0);
	});
});

function createController(storage: TestStorageService, scheduler: TestScheduler): ParadisCollapsedRepositoryStateController {
	return new ParadisCollapsedRepositoryStateController(
		storage as unknown as IStorageService,
		{ warn() { } } as Partial<ILogService> as ILogService,
		runner => {
			scheduler.setRunner(runner);
			return scheduler;
		},
	);
}

function repository(id: string): IParadisWorkspaceRepository {
	return { id, name: id } as IParadisWorkspaceRepository;
}

function worktree(repositoryId: string): IParadisWorktree {
	return { repositoryId, id: `worktree-${repositoryId}` } as unknown as IParadisWorktree;
}

class TestScheduler implements IParadisCollapsedStateScheduler {
	readonly delays: number[] = [];
	cancelCount = 0;

	constructor(private runner: () => void = () => { }) { }

	setRunner(runner: () => void): void { this.runner = runner; }
	schedule(delay: number): void { this.delays.push(delay); }
	cancel(): void { this.cancelCount++; }
	dispose(): void { }
	run(): void { this.runner(); }
}

class TestStorageService {
	readonly writes: Array<{ key: string; value: string; scope: StorageScope; target: StorageTarget }> = [];
	failuresRemaining = 0;

	constructor(public value?: string) { }

	get(key: string, scope: StorageScope): string | undefined {
		assert.strictEqual(key, PARADIS_COLLAPSED_REPOSITORIES_STORAGE_KEY);
		assert.strictEqual(scope, StorageScope.WORKSPACE);
		return this.value;
	}

	store(key: string, value: string, scope: StorageScope, target: StorageTarget): void {
		if (this.failuresRemaining-- > 0) {
			throw new Error('storage unavailable');
		}
		this.value = value;
		this.writes.push({ key, value, scope, target });
	}
}
