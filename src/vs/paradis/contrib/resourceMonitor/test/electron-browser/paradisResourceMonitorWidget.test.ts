/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as assert from 'assert';
import { IDisposable } from '../../../../../base/common/lifecycle.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { IConfigurationService } from '../../../../../platform/configuration/common/configuration.js';
import { IInstantiationService } from '../../../../../platform/instantiation/common/instantiation.js';
import { IParadisResourceMonitorSnapshot } from '../../common/paradisResourceMonitor.js';
import { ParadisResourceMonitorClient } from '../../electron-browser/paradisResourceMonitorClient.js';
import { IParadisResourceMonitorPollTimer, ParadisResourceMonitorWidget, paradisResourceMonitorPollingPolicy } from '../../electron-browser/paradisResourceMonitorWidget.js';

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

	cancel(): void {
		this.interval = undefined;
		this.runner = undefined;
	}

	cancelAndSet(runner: () => void, interval: number): void {
		this.cancel();
		this.runner = runner;
		this.interval = interval;
	}

	dispose(): void {
		this.cancel();
	}
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
});
