/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import assert from 'assert';
import { IDisposable } from '../../../../../base/common/lifecycle.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { IDialogService } from '../../../../../platform/dialogs/common/dialogs.js';
import { IInstantiationService } from '../../../../../platform/instantiation/common/instantiation.js';
import { ILogService } from '../../../../../platform/log/common/log.js';
import { INotificationService } from '../../../../../platform/notification/common/notification.js';
import { IParadisPortListSnapshot } from '../../common/paradisPortList.js';
import { ParadisPortListClient } from '../../electron-browser/paradisPortListClient.js';
import { IParadisPortListPanelOptions, ParadisPortListPanel } from '../../electron-browser/paradisPortListPanel.js';
import { IParadisPortListPollTimer } from '../../electron-browser/paradisPortListPolling.js';
import { IParadisPortListWidgetDependencies, ParadisPortListWidget } from '../../electron-browser/paradisPortListWidget.js';

class TestDocument extends EventTarget {

	hidden = false;

	setHidden(hidden: boolean): void {
		this.hidden = hidden;
		this.dispatchEvent(new Event('visibilitychange'));
	}
}

class TestPollTimer implements IParadisPortListPollTimer, IDisposable {

	readonly intervals: number[] = [];
	private runner: (() => void) | undefined;
	get hasDeadline(): boolean { return this.runner !== undefined; }

	cancel(): void {
		this.runner = undefined;
	}

	cancelAndSet(runner: () => void, interval: number): void {
		this.cancel();
		this.runner = runner;
		this.intervals.push(interval);
	}

	dispose(): void {
		this.cancel();
	}

	fire(): void {
		this.runner?.();
	}
}

class DeferredSnapshot {

	readonly promise: Promise<IParadisPortListSnapshot>;
	private resolvePromise: ((snapshot: IParadisPortListSnapshot) => void) | undefined;

	constructor() {
		this.promise = new Promise(resolve => this.resolvePromise = resolve);
	}

	resolve(): void {
		this.resolvePromise?.(createSnapshot());
	}
}

class TestPanel implements IDisposable {

	disposed = false;
	readonly snapshots: IParadisPortListSnapshot[] = [];
	readonly fetching: boolean[] = [];

	constructor(readonly options: IParadisPortListPanelOptions) { }

	setFetching(fetching: boolean): void {
		this.fetching.push(fetching);
	}

	updateSnapshot(snapshot: IParadisPortListSnapshot): void {
		this.snapshots.push(snapshot);
	}

	dispose(): void {
		this.disposed = true;
	}
}

interface IWidgetHarness {
	readonly container: HTMLElement;
	readonly document: TestDocument;
	readonly timer: TestPollTimer;
	readonly requests: boolean[];
	readonly panels: TestPanel[];
	readonly widget: ParadisPortListWidget;
	deferNextSnapshot(): DeferredSnapshot;
}

function createWidgetHarness(): IWidgetHarness {
	const testDocument = new TestDocument();
	const timer = new TestPollTimer();
	const requests: boolean[] = [];
	const panels: TestPanel[] = [];
	let deferredSnapshot: DeferredSnapshot | undefined;
	const client = {
		connectedToRemote: false,
		getSnapshot: (force: boolean) => {
			requests.push(force);
			const snapshot = deferredSnapshot?.promise ?? Promise.resolve(createSnapshot());
			deferredSnapshot = undefined;
			return snapshot;
		},
	} as unknown as ParadisPortListClient;
	const instantiationService = {
		createInstance: (ctor: unknown, ...args: unknown[]) => {
			if (ctor === ParadisPortListClient) {
				return client;
			}
			if (ctor === ParadisPortListPanel) {
				const panel = new TestPanel(args[1] as IParadisPortListPanelOptions);
				panels.push(panel);
				return panel;
			}
			throw new Error('unexpected constructor');
		},
	} as unknown as IInstantiationService;
	const dependencies: IParadisPortListWidgetDependencies = { document: testDocument, pollTimer: timer };
	const container = document.createElement('div');
	document.body.append(container);
	const widget = new ParadisPortListWidget(
		container,
		dependencies,
		instantiationService,
		{} as IDialogService,
		{} as INotificationService,
		{} as ILogService,
	);
	return {
		container,
		document: testDocument,
		timer,
		requests,
		panels,
		widget,
		deferNextSnapshot: () => deferredSnapshot = new DeferredSnapshot(),
	};
}

function createSnapshot(): IParadisPortListSnapshot {
	return { entries: [], collectedAt: 0 };
}

async function flushMicrotasks(): Promise<void> {
	await Promise.resolve();
	await Promise.resolve();
}

suite('ParadisPortListWidget', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	test('polls only through the open panel lifecycle', async () => {
		const harness = createWidgetHarness();
		try {
			const button = harness.container.querySelector<HTMLButtonElement>('button');
			assert.ok(button);
			assert.deepStrictEqual(harness.requests, []);
			assert.strictEqual(harness.timer.hasDeadline, false);

			harness.document.setHidden(true);
			harness.document.setHidden(false);
			await flushMicrotasks();
			assert.deepStrictEqual(harness.requests, []);

			const deferredSnapshot = harness.deferNextSnapshot();
			button.click();
			assert.deepStrictEqual(harness.requests, [true]);
			assert.deepStrictEqual(harness.timer.intervals, [15_000]);
			assert.strictEqual(harness.timer.hasDeadline, true);
			assert.strictEqual(harness.panels.length, 1);

			button.click();
			assert.strictEqual(harness.panels[0].disposed, true);
			assert.strictEqual(harness.timer.hasDeadline, false);
			deferredSnapshot.resolve();
			await flushMicrotasks();
			assert.deepStrictEqual(harness.panels[0].snapshots, []);

			button.click();
			await flushMicrotasks();
			assert.deepStrictEqual(harness.timer.intervals, [15_000, 15_000]);
			assert.strictEqual(harness.timer.hasDeadline, true);
			assert.strictEqual(harness.panels.length, 2);
			assert.deepStrictEqual(harness.panels[1].snapshots, [createSnapshot()]);

			harness.timer.fire();
			await flushMicrotasks();
			assert.deepStrictEqual(harness.requests, [true, true, false]);
			harness.panels[1].options.onManualRefresh();
			await flushMicrotasks();
			assert.deepStrictEqual(harness.requests, [true, true, false, true]);

			harness.widget.dispose();
			assert.strictEqual(harness.panels[1].disposed, true);
			assert.strictEqual(harness.timer.hasDeadline, false);
		} finally {
			harness.widget.dispose();
		}
	});
});
