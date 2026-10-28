/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// allow-any-unicode-comment-file

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import assert from 'assert';
import { Emitter } from '../../../../../base/common/event.js';
import { DisposableStore, IDisposable } from '../../../../../base/common/lifecycle.js';
import { joinPath } from '../../../../../base/common/resources.js';
import { URI } from '../../../../../base/common/uri.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { FileChangesEvent, FileChangeType, IFileSystemWatcher } from '../../../../../platform/files/common/files.js';
import { PARADIS_DIFF_STATS_FALLBACK_MS, ParadisWorkspacesDiffStatsTracker } from '../../browser/paradisWorkspacesDiffStatsTracker.js';
import { IParadisDiffStat } from '../../common/paradisWorktreeCreate.js';

const REPO = URI.from({ scheme: 'vscode-remote', authority: 'ssh-remote+host', path: '/work/repo' });
const WORKTREE = URI.from({ scheme: 'vscode-remote', authority: 'ssh-remote+host', path: '/work/repo-wt' });
const WORKTREE_GIT_DIR = joinPath(REPO, '.git', 'worktrees', 'repo-wt');

suite('ParadisWorkspacesDiffStatsTracker', () => {
	const store = ensureNoDisposablesAreLeakedInTestSuite();

	test('new targets are due once, then nothing is due until the fallback interval passes', () => {
		const harness = store.add(new TrackerHarness());
		harness.setDefaultTargets();

		const first = harness.takeDue();
		harness.tracker.markFetched([REPO, WORKTREE]);
		harness.time = PARADIS_DIFF_STATS_FALLBACK_MS - 1;
		const beforeFallback = harness.takeDue();
		harness.time = PARADIS_DIFF_STATS_FALLBACK_MS;

		assert.deepStrictEqual({ first, beforeFallback, atFallback: harness.takeDue(), dirtyNotifications: harness.dirtyNotifications }, {
			first: [REPO.path, WORKTREE.path],
			beforeFallback: [],
			atFallback: [REPO.path, WORKTREE.path],
			dirtyNotifications: 1,
		});
	});

	test('a write to the index, HEAD, COMMIT_EDITMSG or ORIG_HEAD marks only that target; other git files do not', () => {
		const harness = store.add(new TrackerHarness());
		harness.setDefaultTargets();
		harness.fetchAll();

		const results: Record<string, string[]> = {};
		for (const name of ['index', 'HEAD', 'COMMIT_EDITMSG', 'ORIG_HEAD', 'FETCH_HEAD', 'index.lock']) {
			harness.watcher(WORKTREE_GIT_DIR).fire(new FileChangesEvent([{ resource: joinPath(WORKTREE_GIT_DIR, name), type: FileChangeType.UPDATED }], false));
			results[name] = harness.takeDue();
			harness.tracker.markFetched([REPO, WORKTREE]);
		}

		assert.deepStrictEqual(results, {
			'index': [WORKTREE.path],
			'HEAD': [WORKTREE.path],
			'COMMIT_EDITMSG': [WORKTREE.path],
			'ORIG_HEAD': [WORKTREE.path],
			'FETCH_HEAD': [],
			'index.lock': [],
		});
	});

	test('an edit seen by the window watcher marks only the target that contains it', () => {
		const harness = store.add(new TrackerHarness());
		harness.setDefaultTargets();
		harness.fetchAll();

		harness.workspaceChanges.fire(new FileChangesEvent([{ resource: joinPath(REPO, 'src', 'a.ts'), type: FileChangeType.UPDATED }], false));
		const afterRepoEdit = harness.takeDue();
		harness.workspaceChanges.fire(new FileChangesEvent([{ resource: URI.from({ scheme: 'vscode-remote', authority: 'ssh-remote+host', path: '/elsewhere/b.ts' }), type: FileChangeType.UPDATED }], false));

		assert.deepStrictEqual({ afterRepoEdit, afterUnrelatedEdit: harness.takeDue(), dirtyNotifications: harness.dirtyNotifications }, {
			afterRepoEdit: [REPO.path],
			afterUnrelatedEdit: [],
			dirtyNotifications: 2,
		});
	});

	test('a changed fingerprint (agent status) marks the target, the first one does not', () => {
		const harness = store.add(new TrackerHarness());
		harness.setDefaultTargets();
		harness.fetchAll();

		harness.tracker.markDirtyWhenChanged(WORKTREE, 'working');
		const first = harness.takeDue();
		harness.tracker.markDirtyWhenChanged(WORKTREE, 'working');
		const same = harness.takeDue();
		harness.tracker.markDirtyWhenChanged(WORKTREE, 'review');

		assert.deepStrictEqual({ first, same, changed: harness.takeDue() }, { first: [], same: [], changed: [WORKTREE.path] });
	});

	// Q471: SSH の再接続中など、数えられなかった対象を「取れた（差分なし）」として 5 分残さない
	test('while the remote reconnects, failed targets keep their previous numbers and stay due until a refresh succeeds', () => {
		const harness = store.add(new TrackerHarness());
		harness.setDefaultTargets();
		const stats = new Map<string, IParadisDiffStat>();
		harness.tracker.applyRefreshResult(harness.tracker.takeDueTargets(), { [REPO.fsPath]: { insertions: 2, deletions: 1 }, [WORKTREE.fsPath]: { insertions: 5, deletions: 0 } }, stats);
		harness.tracker.markDirty(REPO);
		harness.tracker.markDirty(WORKTREE);

		// 接続が切れている: チャネルの例外は failed、コマンド自体の失敗は結果なし
		harness.tracker.applyRefreshResult(harness.tracker.takeDueTargets(), { [REPO.fsPath]: { insertions: 0, deletions: 0, failed: true }, [WORKTREE.fsPath]: { insertions: 0, deletions: 0, failed: true } }, stats);
		const whileReconnecting = { stats: Object.fromEntries(stats), due: harness.tracker.takeDueTargets().map(uri => uri.path) };
		harness.tracker.applyRefreshResult([REPO, WORKTREE], undefined, stats);
		const afterCommandFailure = harness.takeDue();
		harness.tracker.applyRefreshResult([REPO, WORKTREE], { [REPO.fsPath]: { insertions: 3, deletions: 1 }, [WORKTREE.fsPath]: { insertions: 0, deletions: 0 } }, stats);

		assert.deepStrictEqual({ whileReconnecting, afterCommandFailure, afterReconnect: Object.fromEntries(stats), dueAfterReconnect: harness.takeDue() }, {
			whileReconnecting: {
				stats: { [REPO.fsPath]: { insertions: 2, deletions: 1 }, [WORKTREE.fsPath]: { insertions: 5, deletions: 0 } },
				due: [REPO.path, WORKTREE.path],
			},
			afterCommandFailure: [REPO.path, WORKTREE.path],
			afterReconnect: { [REPO.fsPath]: { insertions: 3, deletions: 1 }, [WORKTREE.fsPath]: { insertions: 0, deletions: 0 } },
			dueAfterReconnect: [],
		});
	});

	test('a failed refresh stays due, and removed targets lose their watcher', () => {
		const harness = store.add(new TrackerHarness());
		harness.setDefaultTargets();
		const due = harness.tracker.takeDueTargets();
		harness.tracker.restoreDirty(due);
		const afterFailure = harness.takeDue();
		harness.tracker.markFetched([REPO, WORKTREE]);

		harness.tracker.setTargets([{ uri: REPO, gitDir: joinPath(REPO, '.git') }]);
		harness.tracker.markDirty(WORKTREE);

		assert.deepStrictEqual({ afterFailure, afterRemoval: harness.takeDue(), watching: harness.watchedPaths() }, {
			afterFailure: [REPO.path, WORKTREE.path],
			afterRemoval: [],
			watching: [joinPath(REPO, '.git').path],
		});
	});
});

class TrackerHarness implements IDisposable {
	private readonly disposables = new DisposableStore();
	readonly workspaceChanges = this.disposables.add(new Emitter<FileChangesEvent>());
	private readonly watchers = new Map<string, { emitter: Emitter<FileChangesEvent>; disposed: boolean }>();
	readonly tracker: ParadisWorkspacesDiffStatsTracker;
	dirtyNotifications = 0;
	time = 0;

	constructor() {
		this.tracker = this.disposables.add(new ParadisWorkspacesDiffStatsTracker(
			{
				onDidFilesChange: this.workspaceChanges.event,
				createWatcher: (resource: URI): IFileSystemWatcher => {
					const emitter = this.disposables.add(new Emitter<FileChangesEvent>());
					const entry = { emitter, disposed: false };
					this.watchers.set(resource.toString(), entry);
					return { onDidChange: emitter.event, dispose: () => { entry.disposed = true; } };
				},
			},
			() => this.dirtyNotifications++,
			() => this.time,
		));
	}

	setDefaultTargets(): void {
		this.tracker.setTargets([
			{ uri: REPO, gitDir: joinPath(REPO, '.git') },
			{ uri: WORKTREE, gitDir: WORKTREE_GIT_DIR },
		]);
	}

	fetchAll(): void {
		this.tracker.markFetched(this.tracker.takeDueTargets());
	}

	takeDue(): string[] {
		return this.tracker.takeDueTargets().map(uri => uri.path);
	}

	watcher(gitDir: URI): Emitter<FileChangesEvent> {
		const entry = this.watchers.get(gitDir.toString());
		assert.ok(entry);
		return entry.emitter;
	}

	watchedPaths(): string[] {
		return [...this.watchers.entries()].filter(([, entry]) => !entry.disposed).map(([key]) => URI.parse(key).path);
	}

	dispose(): void {
		this.disposables.dispose();
	}
}
