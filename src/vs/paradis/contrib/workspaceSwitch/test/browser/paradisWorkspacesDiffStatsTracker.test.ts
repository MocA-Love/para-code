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
import { PARADIS_DIFF_STATS_EXCLUDE_MS, PARADIS_DIFF_STATS_FALLBACK_MS, ParadisWorkspacesDiffStatsTracker } from '../../browser/paradisWorkspacesDiffStatsTracker.js';
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

	// コミットの無いリポジトリや git 管理外のフォルダーは毎回失敗する。見回りのたびに git を投げず、5 分の保険へ回す
	test('a target that keeps failing moves to the fallback interval after three failures, and a success resets it', () => {
		const harness = store.add(new TrackerHarness());
		harness.tracker.setTargets([{ uri: REPO, gitDir: joinPath(REPO, '.git') }]);
		const stats = new Map<string, IParadisDiffStat>();
		const fail = { [REPO.fsPath]: { insertions: 0, deletions: 0, failed: true as const } };

		const dueAfterFailures: string[][] = [];
		for (let index = 0; index < 3; index++) {
			harness.tracker.applyRefreshResult(harness.tracker.takeDueTargets(), fail, stats);
			dueAfterFailures.push(harness.tracker.takeDueTargets().map(uri => uri.path));
			harness.tracker.restoreDirty(dueAfterFailures[index].length > 0 ? [REPO] : []);
		}
		harness.time = PARADIS_DIFF_STATS_FALLBACK_MS;
		const atFallback = harness.takeDue();
		harness.tracker.applyRefreshResult([REPO], { [REPO.fsPath]: { insertions: 1, deletions: 0 } }, stats);
		harness.tracker.markDirty(REPO);
		harness.tracker.applyRefreshResult(harness.tracker.takeDueTargets(), fail, stats);

		assert.deepStrictEqual({ dueAfterFailures, atFallback, afterSuccessThenFailure: harness.takeDue() }, {
			dueAfterFailures: [[REPO.path], [REPO.path], []],
			atFallback: [REPO.path],
			afterSuccessThenFailure: [REPO.path],
		});
	});

	// 消えた worktree や git 管理外のフォルダーは、変更の知らせがあってもしばらく git を投げない
	test('a missing or non-repository target leaves the polling for a while, even when it is marked dirty', () => {
		const harness = store.add(new TrackerHarness());
		harness.setDefaultTargets();
		const stats = new Map<string, IParadisDiffStat>([[REPO.fsPath, { insertions: 2, deletions: 1 }], [WORKTREE.fsPath, { insertions: 5, deletions: 0 }]]);
		harness.tracker.applyRefreshResult(harness.tracker.takeDueTargets(), {
			[REPO.fsPath]: { insertions: 0, deletions: 0, failed: true, failure: 'notRepository' },
			[WORKTREE.fsPath]: { insertions: 0, deletions: 0, failed: true, failure: 'missing' },
		}, stats);
		const dirtyNotificationsBefore = harness.dirtyNotifications;
		harness.tracker.markDirty(REPO);
		harness.tracker.markDirtyWhenChanged(WORKTREE, 'idle');
		harness.tracker.markDirtyWhenChanged(WORKTREE, 'busy');
		harness.workspaceChanges.fire(new FileChangesEvent([{ resource: joinPath(REPO, 'a.txt'), type: FileChangeType.UPDATED }], false));
		harness.watcher(WORKTREE_GIT_DIR).fire(new FileChangesEvent([{ resource: joinPath(WORKTREE_GIT_DIR, 'index'), type: FileChangeType.UPDATED }], false));
		const whileExcluded = harness.takeDue();
		harness.time = PARADIS_DIFF_STATS_EXCLUDE_MS - 1;
		const beforeExpiry = harness.takeDue();
		harness.time = PARADIS_DIFF_STATS_EXCLUDE_MS;

		assert.deepStrictEqual({ stats: Object.fromEntries(stats), whileExcluded, beforeExpiry, afterExpiry: harness.takeDue(), notificationsWhileExcluded: harness.dirtyNotifications - dirtyNotificationsBefore }, {
			stats: {},
			whileExcluded: [],
			beforeExpiry: [],
			afterExpiry: [REPO.path, WORKTREE.path],
			notificationsWhileExcluded: 0,
		});
	});

	// 一覧の通知は中身が変わらなくても来る。同じ一覧では外したままにし、増減があったら外すのをやめてすぐ取り直す
	test('the same target list keeps the exclusion, a changed list ends it and makes the target due', () => {
		const harness = store.add(new TrackerHarness());
		harness.setDefaultTargets();
		harness.tracker.applyRefreshResult(harness.tracker.takeDueTargets(), {
			[REPO.fsPath]: { insertions: 1, deletions: 0 },
			[WORKTREE.fsPath]: { insertions: 0, deletions: 0, failed: true, failure: 'missing' },
		}, new Map());
		harness.setDefaultTargets();
		harness.tracker.markDirty(WORKTREE);
		const sameList = harness.takeDue();
		const other = URI.from({ scheme: 'vscode-remote', authority: 'ssh-remote+host', path: '/work/other' });
		harness.tracker.setTargets([
			{ uri: REPO, gitDir: joinPath(REPO, '.git') },
			{ uri: WORKTREE, gitDir: WORKTREE_GIT_DIR },
			{ uri: other, gitDir: joinPath(other, '.git') },
		]);

		assert.deepStrictEqual({ sameList, changedList: harness.takeDue() }, {
			sameList: [],
			changedList: [WORKTREE.path, other.path],
		});
	});

	// HEAD の無いリポジトリ（128）やタイムアウトは外さず、これまでどおり前の値を残して取り直す
	test('a failure of another kind keeps the previous numbers and stays due', () => {
		const harness = store.add(new TrackerHarness());
		harness.tracker.setTargets([{ uri: REPO, gitDir: joinPath(REPO, '.git') }]);
		const stats = new Map<string, IParadisDiffStat>([[REPO.fsPath, { insertions: 2, deletions: 1 }]]);
		harness.tracker.applyRefreshResult(harness.tracker.takeDueTargets(), { [REPO.fsPath]: { insertions: 0, deletions: 0, failed: true, failure: 'other' } }, stats);

		assert.deepStrictEqual({ stats: Object.fromEntries(stats), due: harness.takeDue() }, {
			stats: { [REPO.fsPath]: { insertions: 2, deletions: 1 } },
			due: [REPO.path],
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
