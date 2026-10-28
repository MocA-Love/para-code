/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import assert from 'assert';
import { Emitter } from '../../../../../base/common/event.js';
import { DisposableStore, IDisposable } from '../../../../../base/common/lifecycle.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { IParadisWorkspacesPollingScheduler, paradisGithubTargetsFingerprint, ParadisWorkspacesPollingController, ParadisWorkspacesPollingLifecycle } from '../../browser/paradisWorkspacesPollingLifecycle.js';

suite('ParadisWorkspacesPollingLifecycle', () => {
	const store = ensureNoDisposablesAreLeakedInTestSuite();

	test('visible start requests one immediate diff and PR refresh', () => {
		const harness = store.add(new PollingHarness());

		harness.lifecycle.start(true);

		assert.deepStrictEqual(harness.scheduledDelays(), { diff: [0], pr: [0] });
		harness.clock.advance(0);
		assert.deepStrictEqual(harness.counts(), {
			callbacks: { diff: 1, pr: 1 },
			commands: { diff: 1, pr: 1 },
		});
	});

	test('hide cancels pending callbacks and six hidden minutes stay idle', () => {
		const harness = store.add(new PollingHarness());
		harness.lifecycle.start(true);

		harness.fireVisibility(false, false);
		harness.clock.advance(360_000);

		assert.deepStrictEqual(harness.counts(), {
			callbacks: { diff: 0, pr: 0 },
			commands: { diff: 0, pr: 0 },
		});
		assert.deepStrictEqual(harness.cancelCounts(), { diff: 1, pr: 1 });
	});

	test('repository and worktree changes schedule nothing while hidden', () => {
		const harness = store.add(new PollingHarness());
		harness.lifecycle.start(false);

		harness.repositories.fire();
		harness.worktrees.fire();
		harness.clock.advance(360_000);

		assert.deepStrictEqual(harness.scheduledDelays(), { diff: [], pr: [] });
		assert.deepStrictEqual(harness.counts(), {
			callbacks: { diff: 0, pr: 0 },
			commands: { diff: 0, pr: 0 },
		});
	});

	test('a hidden repository change refreshes immediately when the view returns', () => {
		const harness = store.add(new PollingHarness());
		harness.lifecycle.start(true);
		harness.clock.advance(0);
		harness.fireVisibility(false, false);
		harness.repositories.fire();

		harness.fireVisibility(true, true);
		assert.deepStrictEqual(harness.clock.pendingDelays(), { diff: 0, pr: 0 });
		harness.clock.advance(0);

		assert.deepStrictEqual(harness.counts().commands, { diff: 2, pr: 2 });
	});

	test('ignores a true visibility payload while the actual view body remains hidden', () => {
		const harness = store.add(new PollingHarness());
		harness.lifecycle.start(false);

		// ViewPane.setExpanded(true) emits true even when its parent pane is hidden.
		harness.fireVisibility(true, false);
		harness.clock.advance(360_000);

		assert.deepStrictEqual(harness.scheduledDelays(), { diff: [], pr: [] });
		assert.deepStrictEqual(harness.counts(), {
			callbacks: { diff: 0, pr: 0 },
			commands: { diff: 0, pr: 0 },
		});
	});

	test('show requests one immediate refresh per kind and repeated visibility is idempotent', () => {
		const harness = store.add(new PollingHarness());
		harness.lifecycle.start(false);

		harness.fireVisibility(true, true);
		harness.fireVisibility(true, true);

		assert.deepStrictEqual(harness.scheduledDelays(), { diff: [0], pr: [0] });
		harness.clock.advance(0);
		assert.deepStrictEqual(harness.counts().commands, { diff: 1, pr: 1 });
	});

	test('rapid hide and show preserves the remaining polling budget', () => {
		const harness = store.add(new PollingHarness());
		harness.lifecycle.start(true);
		harness.clock.advance(0);
		harness.clock.advance(1_000);

		for (let index = 0; index < 20; index++) {
			harness.fireVisibility(false, false);
			harness.fireVisibility(true, true);
		}
		harness.clock.advance(0);

		assert.deepStrictEqual(harness.counts().commands, { diff: 1, pr: 1 });
		assert.deepStrictEqual(harness.clock.pendingDelays(), { diff: 59_000, pr: 299_000 });
	});

	test('visible completion keeps the 1 minute diff check and 5 minute PR intervals', () => {
		const harness = store.add(new PollingHarness());
		harness.lifecycle.start(true);
		harness.clock.advance(0);

		harness.clock.advance(59_999);
		assert.deepStrictEqual(harness.counts().commands, { diff: 1, pr: 1 });
		harness.clock.advance(1);
		assert.deepStrictEqual(harness.counts().commands, { diff: 2, pr: 1 });
		harness.clock.advance(240_000);
		assert.deepStrictEqual(harness.counts().commands, { diff: 6, pr: 2 });
	});

	test('repository and worktree changes request visible refreshes through the production seam', () => {
		const harness = store.add(new PollingHarness());
		harness.lifecycle.start(true);
		harness.clock.advance(0);

		harness.repositories.fire();
		harness.clock.advance(0);
		harness.worktrees.fire();
		harness.clock.advance(0);

		assert.deepStrictEqual(harness.counts().commands, { diff: 3, pr: 3 });
	});

	// 一覧・worktree の通知は中身が変わらなくても来る（main の HEAD の書き換え、ピンの付け外し）。PR は問い合わせ対象が
	// 変わったときだけ取り直す（Q373）
	test('with a GitHub target signal, list changes refresh only the diff and a target change only the PR', () => {
		const harness = store.add(new PollingHarness(true, true));
		harness.lifecycle.start(true);
		harness.clock.advance(0);

		harness.repositories.fire();
		harness.worktrees.fire();
		harness.clock.advance(0);
		const afterListChanges = harness.counts().commands;
		harness.githubTargets.fire();
		harness.clock.advance(0);

		assert.deepStrictEqual({ afterListChanges, afterTargetChange: harness.counts().commands }, {
			afterListChanges: { diff: 2, pr: 1 },
			afterTargetChange: { diff: 2, pr: 2 },
		});
	});

	test('a GitHub target change while hidden refreshes the PR when the view returns', () => {
		const harness = store.add(new PollingHarness(true, true));
		harness.lifecycle.start(true);
		harness.clock.advance(0);
		harness.fireVisibility(false, false);
		harness.githubTargets.fire();

		harness.fireVisibility(true, true);
		harness.clock.advance(0);

		assert.deepStrictEqual(harness.counts().commands, { diff: 1, pr: 2 });
	});

	test('fingerprints the GitHub targets by URI, branch and the current space, not by order', () => {
		const a = { uri: 'file:///repo', branch: 'main' };
		const b = { uri: 'file:///repo-wt', branch: 'feature' };
		assert.deepStrictEqual({
			reordered: paradisGithubTargetsFingerprint([a, b], 'file:///repo') === paradisGithubTargetsFingerprint([b, a], 'file:///repo'),
			branchChanged: paradisGithubTargetsFingerprint([a, { ...b, branch: 'other' }], 'file:///repo') === paradisGithubTargetsFingerprint([a, b], 'file:///repo'),
			switched: paradisGithubTargetsFingerprint([a, b], 'file:///repo-wt') === paradisGithubTargetsFingerprint([a, b], 'file:///repo'),
		}, { reordered: true, branchChanged: false, switched: false });
	});

	test('hiding does not cancel running commands and hidden completion does not reschedule', () => {
		const harness = store.add(new PollingHarness(false));
		harness.lifecycle.start(true);
		harness.clock.advance(0);
		assert.deepStrictEqual(harness.counts().commands, { diff: 1, pr: 1 });

		harness.fireVisibility(false, false);
		harness.completeInFlight();
		harness.clock.advance(360_000);

		assert.deepStrictEqual(harness.scheduledDelays(), { diff: [0], pr: [0] });
		assert.deepStrictEqual(harness.counts(), {
			callbacks: { diff: 1, pr: 1 },
			commands: { diff: 1, pr: 1 },
		});
	});

	// Q471 A: ウィンドウが裏・非フォーカス・最小化の間は差分を取りに行かない。PR・Issue の周期は変えない
	test('an inactive window runs no diff for six minutes and refreshes once when it returns', () => {
		const harness = store.add(new PollingHarness(true, false, true));
		harness.lifecycle.start(true);
		harness.clock.advance(0);

		harness.fireWindowActive(false);
		harness.lifecycle.requestDiffStatsRefreshForChange();
		harness.clock.advance(360_000);
		const whileInactive = harness.counts().commands;
		harness.fireWindowActive(true);
		harness.fireWindowActive(true);
		harness.clock.advance(0);

		assert.deepStrictEqual({ whileInactive, afterReturn: harness.counts().commands, pending: harness.clock.pendingDelays() }, {
			whileInactive: { diff: 1, pr: 2 },
			afterReturn: { diff: 2, pr: 2 },
			pending: { diff: 60_000, pr: 240_000 },
		});
	});

	test('a window that starts inactive takes its first diff when it becomes active', () => {
		const harness = store.add(new PollingHarness(true, false, true, false));
		harness.lifecycle.start(true);
		harness.clock.advance(120_000);
		const beforeActive = harness.counts().commands;
		harness.fireWindowActive(true);
		harness.clock.advance(0);

		assert.deepStrictEqual({ beforeActive, afterActive: harness.counts().commands }, {
			beforeActive: { diff: 0, pr: 1 },
			afterActive: { diff: 1, pr: 1 },
		});
	});

	// Q471 B: 変更の知らせは短く待ってから 1 回にまとめる
	test('change notifications are coalesced into one diff after a short delay', () => {
		const harness = store.add(new PollingHarness());
		harness.lifecycle.start(true);
		harness.clock.advance(30_000);

		harness.lifecycle.requestDiffStatsRefreshForChange();
		harness.clock.advance(1_000);
		harness.lifecycle.requestDiffStatsRefreshForChange();
		harness.lifecycle.requestDiffStatsRefreshForChange();
		harness.clock.advance(499);
		const beforeDelay = harness.counts().commands.diff;
		harness.clock.advance(1);

		assert.deepStrictEqual({ beforeDelay, afterDelay: harness.counts().commands.diff, pending: harness.clock.pendingDelays().diff }, {
			beforeDelay: 1,
			afterDelay: 2,
			pending: 60_000,
		});
	});

	// ビルドやウォッチが書き続けても、以前の 10 秒ごとより多くは取りに行かない
	test('a change right after a diff, or during one, waits 10 seconds from its completion', () => {
		const harness = store.add(new PollingHarness(false));
		harness.lifecycle.start(true);
		harness.clock.advance(0);

		harness.lifecycle.requestDiffStatsRefreshForChange();
		harness.completeInFlight();
		const afterInFlight = harness.clock.pendingDelays().diff;
		harness.clock.advance(9_999);
		const beforeInterval = harness.counts().commands.diff;
		harness.clock.advance(1);
		const afterInterval = harness.counts().commands.diff;
		harness.completeInFlight();
		harness.clock.advance(2_000);
		harness.lifecycle.requestDiffStatsRefreshForChange();

		assert.deepStrictEqual({ afterInFlight, beforeInterval, afterInterval, afterQuickChange: harness.clock.pendingDelays().diff }, {
			afterInFlight: 10_000,
			beforeInterval: 1,
			afterInterval: 2,
			afterQuickChange: 8_000,
		});
	});

	test('a change waiting for its delay is kept when the view hides and runs once on return', () => {
		const harness = store.add(new PollingHarness());
		harness.lifecycle.start(true);
		harness.clock.advance(0);

		harness.lifecycle.requestDiffStatsRefreshForChange();
		harness.fireVisibility(false, false);
		harness.clock.advance(10_000);
		const whileHidden = harness.counts().commands.diff;
		harness.fireVisibility(true, true);
		harness.clock.advance(0);

		assert.deepStrictEqual({ whileHidden, afterReturn: harness.counts().commands.diff }, { whileHidden: 1, afterReturn: 2 });
	});

	test('show during in-flight work reuses its completion and resumes normal cadence', () => {
		const harness = store.add(new PollingHarness(false));
		harness.lifecycle.start(true);
		harness.clock.advance(0);

		harness.fireVisibility(false, false);
		harness.fireVisibility(true, true);
		harness.fireVisibility(true, true);
		assert.deepStrictEqual(harness.scheduledDelays(), { diff: [0], pr: [0] });

		harness.completeInFlight();
		assert.deepStrictEqual(harness.scheduledDelays(), { diff: [0, 60_000], pr: [0, 300_000] });
		harness.clock.advance(0);
		assert.deepStrictEqual(harness.counts().commands, { diff: 1, pr: 1 });
	});
});

suite('ParadisWorkspacesPollingController production wiring', () => {
	const store = ensureNoDisposablesAreLeakedInTestSuite();

	test('construction reads actual initial visibility without refreshing synchronously', async () => {
		const hidden = store.add(new PollingControllerHarness(false));
		const visible = store.add(new PollingControllerHarness(true));

		assert.deepStrictEqual({
			hiddenSchedules: hidden.scheduledDelays(),
			visibleSchedules: visible.scheduledDelays(),
			visibleRefreshes: visible.refreshCounts,
		}, {
			hiddenSchedules: { diff: [], pr: [] },
			visibleSchedules: { diff: [0], pr: [0] },
			visibleRefreshes: { diff: 0, pr: 0 },
		});

		visible.clock.advance(0);
		await settlePolling();

		assert.deepStrictEqual(visible.refreshCounts, { diff: 1, pr: 1 });
	});

	test('hidden construction starts immediately on a later actual visible event', async () => {
		const harness = store.add(new PollingControllerHarness(false));

		harness.fireVisibility(true, true);
		assert.deepStrictEqual(harness.scheduledDelays(), { diff: [0], pr: [0] });
		harness.clock.advance(0);
		await settlePolling();

		assert.deepStrictEqual(harness.refreshCounts, { diff: 1, pr: 1 });
	});

	test('repository and worktree events request refreshes through production wiring', async () => {
		const harness = store.add(new PollingControllerHarness(true));
		harness.clock.advance(0);
		await settlePolling();

		harness.repositories.fire();
		harness.clock.advance(0);
		await settlePolling();
		harness.worktrees.fire();
		harness.clock.advance(0);
		await settlePolling();

		assert.deepStrictEqual(harness.refreshCounts, { diff: 3, pr: 3 });
	});

	test('visible empty-path refreshes resume after 1 minute and 5 minutes', async () => {
		const harness = store.add(new PollingControllerHarness(true));
		harness.clock.advance(0);
		await settlePolling();

		await advancePolling(harness.clock, 5, 60_000);

		assert.deepStrictEqual(harness.refreshCounts, { diff: 6, pr: 2 });
	});

	test('command rejection still resumes visible polling', async () => {
		const harness = store.add(new PollingControllerHarness(true));
		harness.behaviors.diff = 'reject';
		harness.behaviors.pr = 'reject';
		harness.clock.advance(0);
		await settlePolling();

		harness.behaviors.diff = 'resolve';
		harness.behaviors.pr = 'resolve';
		await advancePolling(harness.clock, 5, 60_000);

		assert.deepStrictEqual(harness.refreshCounts, { diff: 6, pr: 2 });
	});

	test('in-flight hide suppresses completion rescheduling', async () => {
		const harness = store.add(new PollingControllerHarness(true));
		harness.behaviors.diff = 'pending';
		harness.behaviors.pr = 'pending';
		harness.clock.advance(0);
		await settlePolling();

		harness.fireVisibility(false, false);
		harness.resolvePending();
		await settlePolling();
		harness.clock.advance(360_000);

		assert.deepStrictEqual({
			schedules: harness.scheduledDelays(),
			refreshes: harness.refreshCounts,
		}, {
			schedules: { diff: [0], pr: [0] },
			refreshes: { diff: 1, pr: 1 },
		});
	});

	test('dispose during in-flight refresh prevents completion rescheduling', async () => {
		const harness = store.add(new PollingControllerHarness(true));
		harness.behaviors.diff = 'pending';
		harness.behaviors.pr = 'pending';
		harness.clock.advance(0);
		await settlePolling();

		harness.dispose();
		harness.resolvePending();
		await settlePolling();
		harness.clock.advance(360_000);

		assert.deepStrictEqual({
			schedules: harness.scheduledDelays(),
			callbacks: harness.callbackCounts(),
			refreshes: harness.refreshCounts,
		}, {
			schedules: { diff: [0], pr: [0] },
			callbacks: { diff: 1, pr: 1 },
			refreshes: { diff: 1, pr: 1 },
		});
	});
});

type PollKind = 'diff' | 'pr';
type RefreshBehavior = 'resolve' | 'reject' | 'pending';

async function settlePolling(): Promise<void> {
	await Promise.resolve();
	await Promise.resolve();
}

async function advancePolling(clock: FakeClock, times: number, duration: number): Promise<void> {
	for (let index = 0; index < times; index++) {
		clock.advance(duration);
		await settlePolling();
	}
}

class PollingControllerHarness implements IDisposable {
	private readonly disposables = new DisposableStore();
	readonly visibility = this.disposables.add(new Emitter<boolean>());
	readonly repositories = this.disposables.add(new Emitter<void>());
	readonly worktrees = this.disposables.add(new Emitter<void>());
	readonly clock = new FakeClock();
	readonly refreshCounts: Record<PollKind, number> = { diff: 0, pr: 0 };
	readonly behaviors: Record<PollKind, RefreshBehavior> = { diff: 'resolve', pr: 'resolve' };
	readonly controller: ParadisWorkspacesPollingController;

	private readonly pendingResolvers: Partial<Record<PollKind, () => void>> = {};

	constructor(private actualBodyVisible: boolean) {
		this.controller = this.disposables.add(new ParadisWorkspacesPollingController(
			{
				isBodyVisible: () => this.actualBodyVisible,
				onDidChangeVisibility: this.visibility.event,
				onDidChangeRepositories: this.repositories.event,
				onDidChangeWorktrees: this.worktrees.event,
			},
			() => this.refresh('diff'),
			() => this.refresh('pr'),
			(runner, defaultDelay) => this.clock.createScheduler(runner, defaultDelay),
			() => this.clock.time,
		));
	}

	fireVisibility(payload: boolean, actualBodyVisible: boolean): void {
		this.actualBodyVisible = actualBodyVisible;
		this.visibility.fire(payload);
	}

	resolvePending(): void {
		this.pendingResolvers.diff?.();
		this.pendingResolvers.pr?.();
	}

	scheduledDelays(): Record<PollKind, readonly number[]> {
		return this.clock.scheduledDelays();
	}

	callbackCounts(): Record<PollKind, number> {
		return this.clock.callbackCounts();
	}

	dispose(): void {
		this.disposables.dispose();
	}

	private refresh(kind: PollKind): Promise<void> {
		this.refreshCounts[kind]++;
		switch (this.behaviors[kind]) {
			case 'reject': return Promise.reject(new Error(`${kind} command failed`));
			case 'pending': return new Promise(resolve => this.pendingResolvers[kind] = resolve);
			case 'resolve': return Promise.resolve();
		}
	}
}

class PollingHarness implements IDisposable {
	private readonly disposables = new DisposableStore();
	readonly visibility = this.disposables.add(new Emitter<boolean>());
	readonly repositories = this.disposables.add(new Emitter<void>());
	readonly worktrees = this.disposables.add(new Emitter<void>());
	readonly githubTargets = this.disposables.add(new Emitter<void>());
	readonly clock = new FakeClock();
	readonly lifecycle: ParadisWorkspacesPollingLifecycle;

	private readonly commandCounts: Record<PollKind, number> = { diff: 0, pr: 0 };
	readonly windowActive = this.disposables.add(new Emitter<void>());
	private actualBodyVisible = false;

	constructor(private readonly completeAutomatically = true, followGithubTargets = false, followWindowActive = false, private actualWindowActive = true) {
		this.lifecycle = this.disposables.add(new ParadisWorkspacesPollingLifecycle(
			{
				isBodyVisible: () => this.actualBodyVisible,
				onDidChangeVisibility: this.visibility.event,
				onDidChangeRepositories: this.repositories.event,
				onDidChangeWorktrees: this.worktrees.event,
				...(followGithubTargets ? { onDidChangeGithubTargets: this.githubTargets.event } : {}),
				...(followWindowActive ? { isWindowActive: () => this.actualWindowActive, onDidChangeWindowActive: this.windowActive.event } : {}),
			},
			() => this.refreshDiff(),
			() => this.refreshPr(),
			(runner, defaultDelay) => this.clock.createScheduler(runner, defaultDelay),
			() => this.clock.time,
		));
	}

	fireVisibility(payload: boolean, actualBodyVisible: boolean): void {
		this.actualBodyVisible = actualBodyVisible;
		this.visibility.fire(payload);
	}

	fireWindowActive(active: boolean): void {
		this.actualWindowActive = active;
		this.windowActive.fire();
	}

	counts(): { callbacks: Record<PollKind, number>; commands: Record<PollKind, number> } {
		return {
			callbacks: this.clock.callbackCounts(),
			commands: { ...this.commandCounts },
		};
	}

	scheduledDelays(): Record<PollKind, readonly number[]> {
		return this.clock.scheduledDelays();
	}

	cancelCounts(): Record<PollKind, number> {
		return this.clock.cancelCounts();
	}

	completeInFlight(): void {
		this.lifecycle.completeDiffStatsRefresh();
		this.lifecycle.completePrStatusRefresh();
	}

	dispose(): void {
		this.disposables.dispose();
	}

	private refreshDiff(): void {
		if (!this.lifecycle.beginDiffStatsRefresh()) {
			return;
		}
		this.commandCounts.diff++;
		if (this.completeAutomatically) {
			this.lifecycle.completeDiffStatsRefresh();
		}
	}

	private refreshPr(): void {
		if (!this.lifecycle.beginPrStatusRefresh()) {
			return;
		}
		this.commandCounts.pr++;
		if (this.completeAutomatically) {
			this.lifecycle.completePrStatusRefresh();
		}
	}
}

class FakeClock {
	private now = 0;
	private readonly schedulers: FakeScheduler[] = [];

	createScheduler(runner: () => void, defaultDelay: number): IParadisWorkspacesPollingScheduler {
		const scheduler = new FakeScheduler(this, runner, defaultDelay);
		this.schedulers.push(scheduler);
		return scheduler;
	}

	advance(duration: number): void {
		const target = this.now + duration;
		while (true) {
			const next = this.schedulers
				.filter(scheduler => scheduler.dueTime !== undefined && scheduler.dueTime <= target)
				.sort((first, second) => first.dueTime! - second.dueTime!)[0];
			if (!next) {
				break;
			}
			this.now = next.dueTime!;
			next.run();
		}
		this.now = target;
	}

	callbackCounts(): Record<PollKind, number> {
		return { diff: this.diff.callbackCount, pr: this.pr.callbackCount };
	}

	scheduledDelays(): Record<PollKind, readonly number[]> {
		return { diff: this.diff.delays, pr: this.pr.delays };
	}

	cancelCounts(): Record<PollKind, number> {
		return { diff: this.diff.cancelCount, pr: this.pr.cancelCount };
	}

	pendingDelays(): Record<PollKind, number | undefined> {
		return {
			diff: this.diff.dueTime === undefined ? undefined : this.diff.dueTime - this.now,
			pr: this.pr.dueTime === undefined ? undefined : this.pr.dueTime - this.now,
		};
	}

	get time(): number { return this.now; }

	private get diff(): FakeScheduler { return this.schedulerWithDefaultDelay(60_000); }
	private get pr(): FakeScheduler { return this.schedulerWithDefaultDelay(300_000); }

	private schedulerWithDefaultDelay(defaultDelay: number): FakeScheduler {
		const scheduler = this.schedulers.find(candidate => candidate.defaultDelay === defaultDelay);
		assert.ok(scheduler);
		return scheduler;
	}
}

class FakeScheduler implements IParadisWorkspacesPollingScheduler {
	readonly delays: number[] = [];
	dueTime: number | undefined;
	callbackCount = 0;
	cancelCount = 0;

	constructor(
		private readonly clock: FakeClock,
		private readonly runner: () => void,
		readonly defaultDelay: number,
	) { }

	schedule(delay = this.defaultDelay): void {
		this.delays.push(delay);
		this.dueTime = this.clock.time + delay;
	}

	cancel(): void {
		this.cancelCount++;
		this.dueTime = undefined;
	}

	dispose(): void {
		this.dueTime = undefined;
	}

	run(): void {
		this.dueTime = undefined;
		this.callbackCount++;
		this.runner();
	}
}
