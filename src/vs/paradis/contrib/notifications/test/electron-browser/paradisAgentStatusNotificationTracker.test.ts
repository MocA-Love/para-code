/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import * as assert from 'assert';
import { toDisposable } from '../../../../../base/common/lifecycle.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { IParadisAgentStatusSnapshot } from '../../../agentBrowser/common/paradisAgentBrowser.js';
import { IParadisAgentStatusSnapshotOutcome, IParadisAgentStatusSnapshotService } from '../../../agentBrowser/electron-browser/paradisAgentStatusSnapshotService.js';
import { IParadisAgentStatusNotificationScheduler, ParadisAgentStatusNotificationConsumer, ParadisAgentStatusNotificationTracker, ParadisAgentNotifyStatus } from '../../electron-browser/paradisAgentStatusNotificationTracker.js';

suite('ParadisAgentStatusNotificationTracker', () => {
	const store = ensureNoDisposablesAreLeakedInTestSuite();

	test('notifies an initial review exactly once and ignores the same status snapshot', () => {
		const fixture = createFixture();
		fixture.tracker.accept([status('pane-a', 'review')]);
		fixture.tracker.accept([status('pane-a', 'review')]);

		assert.deepStrictEqual(fixture.notifications, [{ token: 'pane-a', status: 'review' }]);
	});

	test('notifies a transition from working to review immediately', () => {
		const fixture = createFixture();
		fixture.tracker.accept([status('pane-a', 'working')]);
		fixture.tracker.accept([status('pane-a', 'review')]);

		assert.deepStrictEqual(fixture.notifications, [{ token: 'pane-a', status: 'review' }]);
	});

	test('confirms permission and question only after five seconds', () => {
		const fixture = createFixture();
		fixture.tracker.accept([
			status('permission-pane', 'permission'),
			status('question-pane', 'question'),
		]);

		fixture.scheduler.advanceBy(4_999);
		assert.deepStrictEqual(fixture.notifications, []);

		fixture.scheduler.advanceBy(1);
		assert.deepStrictEqual(fixture.notifications, [
			{ token: 'permission-pane', status: 'permission' },
			{ token: 'question-pane', status: 'question' },
		]);
	});

	test('cancels a pending action when the pane returns to working or disappears', () => {
		const fixture = createFixture();
		fixture.tracker.accept([
			status('working-pane', 'permission'),
			status('missing-pane', 'question'),
		]);
		fixture.tracker.accept([status('working-pane', 'working')]);

		fixture.scheduler.advanceBy(5_000);
		assert.deepStrictEqual(fixture.notifications, []);
	});

	test('forgets a disappeared token so a later review notifies again', () => {
		const fixture = createFixture();
		fixture.tracker.accept([status('pane-a', 'review')]);
		fixture.tracker.accept([]);
		fixture.tracker.accept([status('pane-a', 'review')]);

		assert.deepStrictEqual(fixture.notifications, [
			{ token: 'pane-a', status: 'review' },
			{ token: 'pane-a', status: 'review' },
		]);
	});

	test('dispose cancels pending confirmations and ignores later snapshots', () => {
		const fixture = createFixture();
		fixture.tracker.accept([status('pane-a', 'permission')]);
		fixture.tracker.dispose();
		fixture.tracker.accept([status('pane-b', 'review')]);
		fixture.scheduler.advanceBy(5_000);

		assert.deepStrictEqual(fixture.notifications, []);
		assert.strictEqual(fixture.scheduler.activeCount, 0);
	});

	test('keeps review history across an undefined poll error and stops after disposal', () => {
		const producer = new TestSnapshotService();
		const fixture = createFixture();
		const errors: unknown[] = [];
		const consumer = store.add(new ParadisAgentStatusNotificationConsumer(producer, fixture.tracker, error => errors.push(error)));

		producer.publish({ sequence: 1, snapshot: snapshot([status('pane-a', 'review')]) });
		// Promise rejection reasons may legally be undefined; the outcome property is the discriminator.
		producer.publish({ sequence: 2, error: undefined });
		producer.publish({ sequence: 3, snapshot: snapshot([status('pane-a', 'review')]) });
		consumer.dispose();
		producer.publish({ sequence: 4, snapshot: snapshot([status('pane-b', 'review')]) });

		assert.deepStrictEqual(fixture.notifications, [{ token: 'pane-a', status: 'review' }]);
		assert.strictEqual(errors.length, 1);
	});

	test('a poll error does not cancel a pending permission confirmation', () => {
		const producer = new TestSnapshotService();
		const fixture = createFixture();
		const errors: unknown[] = [];
		store.add(new ParadisAgentStatusNotificationConsumer(producer, fixture.tracker, error => errors.push(error)));

		producer.publish({ sequence: 1, snapshot: snapshot([status('pane-a', 'permission')]) });
		fixture.scheduler.advanceBy(4_999);
		producer.publish({ sequence: 2, error: undefined });
		fixture.scheduler.advanceBy(1);

		assert.deepStrictEqual(fixture.notifications, [{ token: 'pane-a', status: 'permission' }]);
		assert.strictEqual(errors.length, 1);
	});

	function createFixture(): {
		readonly scheduler: TestNotificationScheduler;
		readonly tracker: ParadisAgentStatusNotificationTracker;
		readonly notifications: { token: string; status: ParadisAgentNotifyStatus }[];
	} {
		const scheduler = new TestNotificationScheduler();
		const notifications: { token: string; status: ParadisAgentNotifyStatus }[] = [];
		const tracker = store.add(new ParadisAgentStatusNotificationTracker(
			(token, notifyStatus) => notifications.push({ token, status: notifyStatus }),
			scheduler,
		));
		return { scheduler, tracker, notifications };
	}
});

function status(token: string, agentStatus: 'working' | 'permission' | 'question' | 'review') {
	return { token, status: agentStatus, changedAt: 1 } as const;
}

function snapshot(paneStatuses: IParadisAgentStatusSnapshot['paneStatuses']): IParadisAgentStatusSnapshot {
	return { paneStatuses, agentHookTokens: paneStatuses.map(status => status.token) };
}

class TestNotificationScheduler implements IParadisAgentStatusNotificationScheduler {
	private now = 0;
	private sequence = 0;
	private readonly tasks = new Map<number, { readonly dueAt: number; readonly runner: () => void }>();

	get activeCount(): number { return this.tasks.size; }

	schedule(runner: () => void, delay: number) {
		const id = ++this.sequence;
		this.tasks.set(id, { dueAt: this.now + delay, runner });
		return toDisposable(() => this.tasks.delete(id));
	}

	advanceBy(duration: number): void {
		const target = this.now + duration;
		while (true) {
			const next = [...this.tasks]
				.filter(([, task]) => task.dueAt <= target)
				.sort((left, right) => left[1].dueAt - right[1].dueAt || left[0] - right[0])[0];
			if (!next) {
				break;
			}
			const [id, task] = next;
			this.now = task.dueAt;
			this.tasks.delete(id);
			task.runner();
		}
		this.now = target;
	}
}

class TestSnapshotService implements IParadisAgentStatusSnapshotService {
	declare readonly _serviceBrand: undefined;
	private listener: ((outcome: IParadisAgentStatusSnapshotOutcome) => void) | undefined;

	subscribe(listener: (outcome: IParadisAgentStatusSnapshotOutcome) => void) {
		this.listener = listener;
		return toDisposable(() => {
			if (this.listener === listener) {
				this.listener = undefined;
			}
		});
	}

	requestRefresh(): void { }

	publish(outcome: IParadisAgentStatusSnapshotOutcome): void {
		this.listener?.(outcome);
	}
}
