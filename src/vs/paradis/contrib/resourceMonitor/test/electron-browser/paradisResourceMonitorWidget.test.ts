/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as assert from 'assert';
import { Disposable, IDisposable } from '../../../../../base/common/lifecycle.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { IConfigurationService } from '../../../../../platform/configuration/common/configuration.js';
import { IInstantiationService } from '../../../../../platform/instantiation/common/instantiation.js';
import { IParadisResourceMonitorSnapshot } from '../../common/paradisResourceMonitor.js';
import { ParadisResourceMonitorClient } from '../../electron-browser/paradisResourceMonitorClient.js';
import { IParadisResourceMonitorPanelOptions, ParadisResourceMonitorPanel } from '../../electron-browser/paradisResourceMonitorPanel.js';
import { createParadisResourceMonitorWidget, IParadisResourceMonitorPollTimer, ParadisResourceMonitorWidget, paradisResourceMonitorPollingPolicy } from '../../electron-browser/paradisResourceMonitorWidget.js';

class TestDocument extends EventTarget {

	hidden = false;

	setHidden(hidden: boolean): void {
		this.hidden = hidden;
		this.dispatchEvent(new Event('visibilitychange'));
	}
}

class TestIntervalTimer implements IParadisResourceMonitorPollTimer {

	interval: number | undefined;
	private runner: (() => void) | undefined;
	cancelCount = 0;
	disposed = false;

	cancel(): void {
		this.cancelCount++;
		this.interval = undefined;
		this.runner = undefined;
	}

	cancelAndSet(runner: () => void, interval: number): void {
		this.cancel();
		this.runner = runner;
		this.interval = interval;
	}

	dispose(): void {
		this.disposed = true;
		this.cancel();
	}

	fire(): void {
		this.runner?.();
	}
}

class DeferredSnapshot {

	readonly promise: Promise<IParadisResourceMonitorSnapshot>;
	private resolvePromise: ((snapshot: IParadisResourceMonitorSnapshot) => void) | undefined;

	constructor() {
		this.promise = new Promise(resolve => { this.resolvePromise = resolve; });
	}

	resolve(): void {
		this.resolvePromise?.(createSnapshot());
	}
}

class TestPanel implements IDisposable {

	disposed = false;
	readonly snapshots: IParadisResourceMonitorSnapshot[] = [];
	readonly fetching: boolean[] = [];

	constructor(readonly options: IParadisResourceMonitorPanelOptions) { }

	setFetching(fetching: boolean): void {
		this.fetching.push(fetching);
	}

	updateSnapshot(snapshot: IParadisResourceMonitorSnapshot): void {
		this.snapshots.push(snapshot);
	}

	dispose(): void {
		this.disposed = true;
	}
}

class TestConfigurationService {

	private readonly listeners: ((event: { affectsConfiguration(section: string): boolean }) => void)[] = [];

	constructor(private enabled = true) { }

	getValue(): boolean {
		return this.enabled;
	}

	onDidChangeConfiguration(listener: (event: { affectsConfiguration(section: string): boolean }) => void): IDisposable {
		this.listeners.push(listener);
		return { dispose: () => this.listeners.splice(this.listeners.indexOf(listener), 1) };
	}

	setEnabled(enabled: boolean): void {
		this.enabled = enabled;
		for (const listener of [...this.listeners]) {
			listener({ affectsConfiguration: section => section === 'paradis.resourceMonitor.enabled' });
		}
	}
}

interface ITestWidgetHarness {
	readonly container: HTMLElement;
	readonly document: TestDocument;
	readonly timer: TestIntervalTimer;
	readonly requests: { readonly force: boolean; readonly freshness: 'active' | 'idle' }[];
	readonly configuration: TestConfigurationService;
	readonly panels: TestPanel[];
	readonly initialSnapshot: DeferredSnapshot | undefined;
	readonly widget: ParadisResourceMonitorWidget;
	deferNextSnapshot(): DeferredSnapshot;
}

function createWidgetHarness(deferInitialSnapshot = false): ITestWidgetHarness {
	const testDocument = new TestDocument();
	const timer = new TestIntervalTimer();
	const requests: { readonly force: boolean; readonly freshness: 'active' | 'idle' }[] = [];
	const panels: TestPanel[] = [];
	const configuration = new TestConfigurationService();
	const initialSnapshot = deferInitialSnapshot ? new DeferredSnapshot() : undefined;
	let deferredSnapshot: DeferredSnapshot | undefined = initialSnapshot;
	const client = {
		getSnapshot: (force: boolean, freshness: 'active' | 'idle') => {
			requests.push({ force, freshness });
			const result = deferredSnapshot?.promise ?? Promise.resolve(createSnapshot());
			deferredSnapshot = undefined;
			return result;
		},
		switchToScope() { },
	} as unknown as ParadisResourceMonitorClient;
	const instantiationService = {
		createInstance: (ctor: unknown, ...args: unknown[]) => {
			if (ctor === ParadisResourceMonitorClient) {
				return client;
			}
			if (ctor === ParadisResourceMonitorPanel) {
				const panel = new TestPanel(args[1] as IParadisResourceMonitorPanelOptions);
				panels.push(panel);
				return panel;
			}
			throw new Error('unexpected constructor');
		},
	} as unknown as IInstantiationService;
	const container = document.createElement('div');
	document.body.append(container);
	const widget = new ParadisResourceMonitorWidget(container, { document: testDocument, pollTimer: timer }, instantiationService, configuration as unknown as IConfigurationService);
	return {
		container,
		document: testDocument,
		timer,
		requests,
		configuration,
		panels,
		initialSnapshot,
		widget,
		deferNextSnapshot: () => deferredSnapshot = new DeferredSnapshot(),
	};
}

function createSnapshot(): IParadisResourceMonitorSnapshot {
	const zero = { cpu: 0, memory: 0 };
	return {
		app: { ...zero, main: zero, renderer: zero, other: zero },
		scopes: [],
		totalCpu: 0,
		totalMemory: 0,
		hostTotalMemory: 0,
		collectedAt: 0,
	};
}

async function flushMicrotasks(): Promise<void> {
	await Promise.resolve();
	await Promise.resolve();
}

suite('ParadisResourceMonitorWidget', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	test('keeps the panel cadence active even while the window is hidden', () => {
		assert.deepStrictEqual([
			paradisResourceMonitorPollingPolicy(true, false, false),
			paradisResourceMonitorPollingPolicy(true, true, false),
			paradisResourceMonitorPollingPolicy(true, true, true),
			paradisResourceMonitorPollingPolicy(true, false, true),
		], [
			{ interval: 5_000, freshness: 'idle' },
			{ interval: 2_000, freshness: 'active' },
			{ interval: 2_000, freshness: 'active' },
			{ interval: undefined, freshness: 'idle' },
		]);
	});

	test('passes idle freshness through the real client IPC request', async () => {
		const requests: { readonly sessions: readonly unknown[]; readonly force: boolean; readonly freshness: string }[] = [];
		const channel = {
			call: async (_command: string, args: unknown[]) => {
				requests.push(args[0] as { readonly sessions: readonly unknown[]; readonly force: boolean; readonly freshness: string });
				return createSnapshot();
			},
		};
		const client = new ParadisResourceMonitorClient(
			{ instances: [] } as never,
			{ paradisParkedGroups: [] } as never,
			{ getStateKeyForInstance: () => undefined } as never,
			{ repositories: [], switchRepository() { } } as never,
			{ getWorktrees: () => [] } as never,
			{ getChannel: () => channel } as never,
			{ getConnection: () => null } as never,
		);

		await client.getSnapshot(false, 'idle');

		assert.deepStrictEqual(requests, [{ sessions: [], force: false, freshness: 'idle' }]);
	});

	test('stops hidden idle polling then visibly rearms and requests idle freshness immediately', async () => {
		const testDocument = new TestDocument();
		const pollTimer = new TestIntervalTimer();
		const requests: { readonly force: boolean; readonly freshness: 'active' | 'idle' }[] = [];
		const client = {
			getSnapshot: async (force: boolean, freshness: 'active' | 'idle') => {
				requests.push({ force, freshness });
				return createSnapshot();
			},
		} as unknown as ParadisResourceMonitorClient;
		const instantiationService = { createInstance: () => client } as unknown as IInstantiationService;
		const configurationService = {
			getValue: () => true,
			onDidChangeConfiguration: () => ({ dispose() { } } satisfies IDisposable),
		} as unknown as IConfigurationService;
		const container = document.createElement('div');
		document.body.append(container);
		const widget = new ParadisResourceMonitorWidget(container, { document: testDocument, pollTimer }, instantiationService, configurationService);

		try {
			await flushMicrotasks();
			assert.strictEqual(pollTimer.interval, 5_000);
			assert.deepStrictEqual(requests, [{ force: false, freshness: 'idle' }]);

			testDocument.setHidden(true);
			assert.strictEqual(pollTimer.interval, undefined);
			assert.deepStrictEqual(requests, [{ force: false, freshness: 'idle' }]);

			testDocument.setHidden(false);
			await flushMicrotasks();
			assert.strictEqual(pollTimer.interval, 5_000);
			assert.deepStrictEqual(requests, [
				{ force: false, freshness: 'idle' },
				{ force: false, freshness: 'idle' },
			]);
		} finally {
			widget.dispose();
		}
	});

	test('passes an explicit dependency placeholder through the production factory', () => {
		const container = document.createElement('div');
		const calls: { readonly ctor: unknown; readonly args: readonly unknown[] }[] = [];
		const instantiationService = {
			createInstance: (ctor: unknown, ...args: unknown[]) => {
				calls.push({ ctor, args });
				return Disposable.None;
			},
		} as unknown as IInstantiationService;

		createParadisResourceMonitorWidget(instantiationService, container);

		assert.deepStrictEqual(calls, [{ ctor: ParadisResourceMonitorWidget, args: [container, undefined] }]);
	});

	test('retries exactly once after visible recovery overtakes an idle request', async () => {
		const harness = createWidgetHarness(true);
		try {
			await flushMicrotasks();
			assert.ok(harness.initialSnapshot);
			assert.deepStrictEqual(harness.requests, [{ force: false, freshness: 'idle' }]);

			harness.document.setHidden(true);
			harness.document.setHidden(false);
			harness.initialSnapshot.resolve();
			await flushMicrotasks();

			assert.deepStrictEqual(harness.requests, [
				{ force: false, freshness: 'idle' },
				{ force: false, freshness: 'idle' },
			]);
		} finally {
			harness.widget.dispose();
		}
	});

	test('drops a deferred visible-recovery retry when lifecycle state no longer permits idle polling', async () => {
		const suppressions: readonly { readonly apply: (harness: ITestWidgetHarness) => void }[] = [
			{ apply: harness => harness.configuration.setEnabled(false) },
			{ apply: harness => harness.document.setHidden(true) },
			{
				apply: harness => {
					const button = harness.container.querySelector('button');
					assert.ok(button);
					button.click();
				},
			},
			{ apply: harness => harness.widget.dispose() },
		];

		for (const { apply } of suppressions) {
			const harness = createWidgetHarness(true);
			try {
				await flushMicrotasks();
				assert.ok(harness.initialSnapshot);
				harness.document.setHidden(true);
				harness.document.setHidden(false);
				apply(harness);
				harness.initialSnapshot.resolve();
				await flushMicrotasks();

				assert.deepStrictEqual(harness.requests, [{ force: false, freshness: 'idle' }]);
			} finally {
				harness.widget.dispose();
			}
		}
	});

	test('drives panel, timer, manual refresh, configuration, and disposal through widget wiring', async () => {
		const harness = createWidgetHarness();
		try {
			await flushMicrotasks();
			const button = harness.container.querySelector('button');
			assert.ok(button);
			button.click();
			await flushMicrotasks();

			assert.strictEqual(harness.timer.interval, 2_000);
			assert.strictEqual(harness.panels.length, 1);
			assert.deepStrictEqual(harness.requests, [
				{ force: false, freshness: 'idle' },
				{ force: false, freshness: 'active' },
			]);

			harness.document.setHidden(true);
			harness.timer.fire();
			await flushMicrotasks();
			assert.strictEqual(harness.timer.interval, 2_000);
			assert.deepStrictEqual(harness.requests.at(-1), { force: false, freshness: 'active' });

			harness.panels[0].options.onManualRefresh();
			await flushMicrotasks();
			assert.deepStrictEqual(harness.requests.at(-1), { force: true, freshness: 'active' });

			button.click();
			assert.strictEqual(harness.timer.interval, undefined);
			assert.strictEqual(harness.panels[0].disposed, true);

			harness.document.setHidden(false);
			await flushMicrotasks();
			button.click();
			await flushMicrotasks();
			assert.strictEqual(harness.panels.length, 2);
			harness.configuration.setEnabled(false);
			assert.strictEqual(harness.timer.interval, undefined);
			assert.strictEqual(harness.panels[1].disposed, true);
			harness.configuration.setEnabled(true);
			assert.strictEqual(harness.timer.interval, 5_000);

			const cancelCountBeforeDispose = harness.timer.cancelCount;
			harness.widget.dispose();
			assert.strictEqual(harness.timer.disposed, true);
			harness.document.setHidden(true);
			assert.strictEqual(harness.timer.cancelCount, cancelCountBeforeDispose + 1);
		} finally {
			harness.widget.dispose();
		}
	});
});
