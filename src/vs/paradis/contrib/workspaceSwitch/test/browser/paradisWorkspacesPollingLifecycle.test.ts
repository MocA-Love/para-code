/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import assert from 'assert';
import { Emitter } from '../../../../../base/common/event.js';
import { DisposableStore, IDisposable } from '../../../../../base/common/lifecycle.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { IParadisWorkspacesPollingScheduler, ParadisWorkspacesPollingLifecycle } from '../../browser/paradisWorkspacesPollingLifecycle.js';

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

		harness.visibility.fire(false);
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

	test('show requests one immediate refresh per kind and repeated visibility is idempotent', () => {
		const harness = store.add(new PollingHarness());
		harness.lifecycle.start(false);

		harness.visibility.fire(true);
		harness.visibility.fire(true);

		assert.deepStrictEqual(harness.scheduledDelays(), { diff: [0], pr: [0] });
		harness.clock.advance(0);
		assert.deepStrictEqual(harness.counts().commands, { diff: 1, pr: 1 });
	});

	test('visible completion preserves the 10 second diff and 5 minute PR intervals', () => {
		const harness = store.add(new PollingHarness());
		harness.lifecycle.start(true);
		harness.clock.advance(0);

		harness.clock.advance(9_999);
		assert.deepStrictEqual(harness.counts().commands, { diff: 1, pr: 1 });
		harness.clock.advance(1);
		assert.deepStrictEqual(harness.counts().commands, { diff: 2, pr: 1 });
		harness.clock.advance(290_000);
		assert.deepStrictEqual(harness.counts().commands, { diff: 31, pr: 2 });
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

	test('hiding does not cancel running commands and hidden completion does not reschedule', () => {
		const harness = store.add(new PollingHarness(false));
		harness.lifecycle.start(true);
		harness.clock.advance(0);
		assert.deepStrictEqual(harness.counts().commands, { diff: 1, pr: 1 });

		harness.visibility.fire(false);
		harness.completeInFlight();
		harness.clock.advance(360_000);

		assert.deepStrictEqual(harness.scheduledDelays(), { diff: [0], pr: [0] });
		assert.deepStrictEqual(harness.counts(), {
			callbacks: { diff: 1, pr: 1 },
			commands: { diff: 1, pr: 1 },
		});
	});

	test('show during in-flight work schedules one immediate refresh after completion', () => {
		const harness = store.add(new PollingHarness(false));
		harness.lifecycle.start(true);
		harness.clock.advance(0);

		harness.visibility.fire(false);
		harness.visibility.fire(true);
		harness.visibility.fire(true);
		assert.deepStrictEqual(harness.scheduledDelays(), { diff: [0], pr: [0] });

		harness.completeInFlight();
		assert.deepStrictEqual(harness.scheduledDelays(), { diff: [0, 0], pr: [0, 0] });
		harness.clock.advance(0);
		assert.deepStrictEqual(harness.counts().commands, { diff: 2, pr: 2 });
	});
});

type PollKind = 'diff' | 'pr';

class PollingHarness implements IDisposable {
	private readonly disposables = new DisposableStore();
	readonly visibility = this.disposables.add(new Emitter<boolean>());
	readonly repositories = this.disposables.add(new Emitter<void>());
	readonly worktrees = this.disposables.add(new Emitter<void>());
	readonly clock = new FakeClock();
	readonly lifecycle: ParadisWorkspacesPollingLifecycle;

	private readonly commandCounts: Record<PollKind, number> = { diff: 0, pr: 0 };

	constructor(private readonly completeAutomatically = true) {
		this.lifecycle = this.disposables.add(new ParadisWorkspacesPollingLifecycle(
			{
				onDidChangeVisibility: this.visibility.event,
				onDidChangeRepositories: this.repositories.event,
				onDidChangeWorktrees: this.worktrees.event,
			},
			() => this.refreshDiff(),
			() => this.refreshPr(),
			(runner, defaultDelay) => this.clock.createScheduler(runner, defaultDelay),
		));
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

	get time(): number { return this.now; }

	private get diff(): FakeScheduler { return this.schedulerWithDefaultDelay(10_000); }
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
