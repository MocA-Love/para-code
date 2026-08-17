/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import * as assert from 'assert';
import * as sinon from 'sinon';
import { CancellationToken } from '../../../../../base/common/cancellation.js';
import { Emitter } from '../../../../../base/common/event.js';
import { toDisposable } from '../../../../../base/common/lifecycle.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { IConfigurationChangeEvent, IConfigurationService } from '../../../../../platform/configuration/common/configuration.js';
import { TestInstantiationService } from '../../../../../platform/instantiation/test/common/instantiationServiceMock.js';
import { ISharedProcessService } from '../../../../../platform/ipc/electron-browser/services.js';
import { NullTelemetryService } from '../../../../../platform/telemetry/common/telemetryUtils.js';
import { TestThemeService } from '../../../../../platform/theme/test/common/testThemeService.js';
import { IStatusbarEntry, IStatusbarEntryAccessor, IStatusbarService } from '../../../../../workbench/services/statusbar/browser/statusbar.js';
import { IRemoteAgentService } from '../../../../../workbench/services/remote/common/remoteAgentService.js';
import { TestEditorGroupView } from '../../../../../workbench/test/browser/workbenchTestServices.js';
import { TestStorageService } from '../../../../../workbench/test/common/workbenchTestServices.js';
import {
	ParadisCcusageWarmLeasePayload,
	ParadisCcusageWarmTarget,
} from '../../common/paradisCcusage.js';
import { ParadisCcusageStatusBarContribution } from '../../electron-browser/paradisCcusage.contribution.js';
import { PARADIS_CCUSAGE_SETTING_EXECUTABLE_PATH } from '../../electron-browser/paradisCcusageClient.js';
import { ParadisCcusageEditor } from '../../electron-browser/paradisCcusageEditor.js';
import { ParadisCcusageInput } from '../../electron-browser/paradisCcusageInput.js';

const STATUS_BAR_ENABLED_SETTING = 'paradis.ccusage.statusBar.enabled';

interface IChannelCall {
	readonly command: string;
	readonly args: unknown;
}

class TestCcusageConfigurationService {
	private readonly values = new Map<string, unknown>();
	private readonly onDidChangeConfigurationEmitter = new Emitter<IConfigurationChangeEvent>();
	readonly onDidChangeConfiguration = this.onDidChangeConfigurationEmitter.event;

	constructor(values: Readonly<Record<string, unknown>>) {
		for (const [key, value] of Object.entries(values)) {
			this.values.set(key, value);
		}
	}

	getValue<T>(key: string): T | undefined {
		return this.values.get(key) as T | undefined;
	}

	setValue(key: string, value: unknown): void {
		this.values.set(key, value);
		this.onDidChangeConfigurationEmitter.fire({
			affectsConfiguration: candidate => candidate === key,
		} as IConfigurationChangeEvent);
	}

	dispose(): void {
		this.onDidChangeConfigurationEmitter.dispose();
	}
}

class TestCcusageChannel {
	readonly calls: IChannelCall[] = [];
	readonly activeLeases = new Map<string, readonly ParadisCcusageWarmTarget[]>();
	private readonly pendingWarmLeases: { readonly payload: ParadisCcusageWarmLeasePayload; readonly resolve: () => void }[] = [];
	private holdWarmLeases = false;
	leaseFailure: Error | undefined;
	dailyFailure: Error | undefined;

	call<T>(command: string, args?: unknown): Promise<T> {
		this.calls.push({ command, args });
		if (command === 'setWarmLease') {
			if (this.leaseFailure) {
				return Promise.reject(this.leaseFailure);
			}
			const payload = (args as readonly [ParadisCcusageWarmLeasePayload])[0];
			if (this.holdWarmLeases) {
				return new Promise<T>(resolve => this.pendingWarmLeases.push({
					payload,
					resolve: () => {
						this.applyWarmLease(payload);
						resolve(undefined as T);
					},
				}));
			}
			this.applyWarmLease(payload);
			return Promise.resolve(undefined as T);
		}
		if (command === 'fetchDaily') {
			if (this.dailyFailure) {
				return Promise.reject(this.dailyFailure);
			}
			return Promise.resolve([{
				period: '2026-08-16',
				totalCost: 4.25,
				modelBreakdowns: [],
			}] as T);
		}
		if (command === 'fetchActiveBlock') {
			return Promise.resolve(undefined as T);
		}
		if (command === 'fetchRecentSessions') {
			return Promise.resolve([] as T);
		}
		if (command === 'fetchProjects') {
			return Promise.resolve({} as T);
		}
		throw new Error(`Unexpected ccusage command: ${command}`);
	}

	callsFor(command: string): readonly IChannelCall[] {
		return this.calls.filter(call => call.command === command);
	}

	holdNextWarmLeases(): void {
		this.holdWarmLeases = true;
	}

	get pendingWarmLeaseCount(): number {
		return this.pendingWarmLeases.length;
	}

	resolveNextWarmLease(): void {
		const pending = this.pendingWarmLeases.shift();
		if (!pending) {
			throw new Error('No pending warm lease IPC call');
		}
		pending.resolve();
	}

	private applyWarmLease(payload: ParadisCcusageWarmLeasePayload): void {
		if (payload.active) {
			this.activeLeases.set(payload.ownerId, payload.targets);
		} else {
			this.activeLeases.delete(payload.ownerId);
		}
	}
}

class TestStatusbarService {
	lastEntry: IStatusbarEntry | undefined;
	readonly accessor: IStatusbarEntryAccessor;

	constructor() {
		this.accessor = {
			update: entry => { this.lastEntry = entry; },
			dispose: () => { this.lastEntry = undefined; },
		};
	}

	addEntry(entry: IStatusbarEntry): IStatusbarEntryAccessor {
		this.lastEntry = entry;
		return this.accessor;
	}
}

interface ITestCcusageHarness {
	readonly channel: TestCcusageChannel;
	readonly configuration: TestCcusageConfigurationService;
	readonly instantiationService: TestInstantiationService;
	readonly statusbarService: TestStatusbarService;
}

function createHarness(values: Readonly<Record<string, unknown>> = {}): ITestCcusageHarness {
	const channel = new TestCcusageChannel();
	const configuration = new TestCcusageConfigurationService(values);
	const instantiationService = new TestInstantiationService();
	instantiationService.set(ISharedProcessService, { getChannel: () => channel } as unknown as ISharedProcessService);
	instantiationService.set(IConfigurationService, configuration as unknown as IConfigurationService);
	instantiationService.set(IRemoteAgentService, { getConnection: () => null } as unknown as IRemoteAgentService);
	return {
		channel,
		configuration,
		instantiationService,
		statusbarService: new TestStatusbarService(),
	};
}

function createStatusContribution(harness: ITestCcusageHarness): ParadisCcusageStatusBarContribution {
	return new ParadisCcusageStatusBarContribution(
		harness.statusbarService as unknown as IStatusbarService,
		harness.configuration as unknown as IConfigurationService,
		harness.instantiationService,
	);
}

function createEditor(harness: ITestCcusageHarness, storageService: TestStorageService): ParadisCcusageEditor {
	return new ParadisCcusageEditor(
		new TestEditorGroupView(1),
		NullTelemetryService,
		new TestThemeService(),
		storageService,
		harness.instantiationService,
	);
}

async function settle(): Promise<void> {
	for (let index = 0; index < 8; index++) {
		await Promise.resolve();
	}
}

function singleActiveLease(channel: TestCcusageChannel): readonly ParadisCcusageWarmTarget[] {
	assert.strictEqual(channel.activeLeases.size, 1);
	return [...channel.activeLeases.values()][0];
}

function targetOptions(targets: readonly ParadisCcusageWarmTarget[]): readonly ParadisCcusageWarmTarget['options'][] {
	return targets.map(target => target.options);
}

function warmLeasePayloads(channel: TestCcusageChannel): readonly ParadisCcusageWarmLeasePayload[] {
	return channel.callsFor('setWarmLease').map(call => (call.args as readonly [ParadisCcusageWarmLeasePayload])[0]);
}

suite('ParadisCcusage warm lease lifecycle', () => {
	const disposables = ensureNoDisposablesAreLeakedInTestSuite();

	teardown(() => sinon.restore());

	test('holds the status warm lease only while its setting is enabled without changing foreground poll cadence', async () => {
		const clock = sinon.useFakeTimers({ now: new Date(2026, 7, 16, 12, 0, 0) });
		const harness = createHarness({ [STATUS_BAR_ENABLED_SETTING]: true });
		disposables.add(harness.instantiationService);
		disposables.add(toDisposable(() => harness.configuration.dispose()));
		const status = disposables.add(createStatusContribution(harness));

		await settle();
		assert.deepStrictEqual(singleActiveLease(harness.channel), [{ kind: 'daily', options: { since: '20260519' } }]);
		assert.strictEqual(harness.channel.callsFor('fetchDaily').length, 0);
		await clock.tickAsync(15_000);
		await settle();
		assert.strictEqual(harness.channel.callsFor('fetchDaily').length, 1);
		await clock.tickAsync(10 * 60 * 1000);
		await settle();
		assert.strictEqual(harness.channel.callsFor('fetchDaily').length, 2);

		harness.configuration.setValue(STATUS_BAR_ENABLED_SETTING, false);
		await settle();
		assert.strictEqual(harness.channel.activeLeases.size, 0);
		await clock.tickAsync(10 * 60 * 1000);
		await settle();
		assert.strictEqual(harness.channel.callsFor('fetchDaily').length, 2);

		harness.configuration.setValue(STATUS_BAR_ENABLED_SETTING, true);
		await settle();
		assert.deepStrictEqual(singleActiveLease(harness.channel), [{ kind: 'daily', options: { since: '20260519' } }]);
		status.dispose();
		await settle();
		assert.strictEqual(harness.channel.activeLeases.size, 0);
	});

	test('holds the dashboard warm lease only for a visible editor with an input and reacquires it on return', async () => {
		sinon.useFakeTimers({ now: new Date(2026, 7, 16, 12, 0, 0) });
		const harness = createHarness();
		disposables.add(harness.instantiationService);
		disposables.add(toDisposable(() => harness.configuration.dispose()));
		const editor = disposables.add(createEditor(harness, disposables.add(new TestStorageService())));
		const input = disposables.add(ParadisCcusageInput.instance);
		const parent = document.createElement('div');
		disposables.add(toDisposable(() => parent.remove()));
		editor.create(parent);

		editor.setVisible(true);
		await settle();
		assert.strictEqual(harness.channel.activeLeases.size, 0);
		await editor.setInput(input, undefined, Object.create(null), CancellationToken.None);
		await settle();
		assert.deepStrictEqual(singleActiveLease(harness.channel), [
			{ kind: 'daily', options: { since: '20260519' } },
			{ kind: 'blocks', options: {} },
			{ kind: 'session', options: { since: '20260519' } },
			{ kind: 'projects', options: { since: '20260519' } },
		]);

		editor.setVisible(false);
		await settle();
		assert.strictEqual(harness.channel.activeLeases.size, 0);
		editor.setVisible(true);
		await settle();
		assert.strictEqual(harness.channel.activeLeases.size, 1);
		editor.clearInput();
		await settle();
		assert.strictEqual(harness.channel.activeLeases.size, 0);
		await editor.setInput(input, undefined, Object.create(null), CancellationToken.None);
		await settle();
		assert.strictEqual(harness.channel.activeLeases.size, 1);
		editor.dispose();
		await settle();
		assert.strictEqual(harness.channel.activeLeases.size, 0);
	});

	test('releases a late dashboard acquire after the editor is hidden', async () => {
		const harness = createHarness();
		disposables.add(harness.instantiationService);
		disposables.add(toDisposable(() => harness.configuration.dispose()));
		const editor = disposables.add(createEditor(harness, disposables.add(new TestStorageService())));
		const input = disposables.add(ParadisCcusageInput.instance);
		const parent = document.createElement('div');
		disposables.add(toDisposable(() => parent.remove()));
		editor.create(parent);
		editor.setVisible(true);
		harness.channel.holdNextWarmLeases();
		await editor.setInput(input, undefined, Object.create(null), CancellationToken.None);
		await settle();
		assert.strictEqual(harness.channel.pendingWarmLeaseCount, 1);

		editor.setVisible(false);
		harness.channel.resolveNextWarmLease();
		await settle();
		assert.deepStrictEqual(warmLeasePayloads(harness.channel).map(payload => payload.active), [true, false]);
		assert.strictEqual(harness.channel.pendingWarmLeaseCount, 1);
		harness.channel.resolveNextWarmLease();
		await settle();
		assert.strictEqual(harness.channel.activeLeases.size, 0);
	});

	test('releases a late dashboard acquire after the editor input is cleared', async () => {
		const harness = createHarness();
		disposables.add(harness.instantiationService);
		disposables.add(toDisposable(() => harness.configuration.dispose()));
		const editor = disposables.add(createEditor(harness, disposables.add(new TestStorageService())));
		const input = disposables.add(ParadisCcusageInput.instance);
		const parent = document.createElement('div');
		disposables.add(toDisposable(() => parent.remove()));
		editor.create(parent);
		editor.setVisible(true);
		harness.channel.holdNextWarmLeases();
		await editor.setInput(input, undefined, Object.create(null), CancellationToken.None);
		await settle();
		assert.strictEqual(harness.channel.pendingWarmLeaseCount, 1);

		editor.clearInput();
		harness.channel.resolveNextWarmLease();
		await settle();
		assert.deepStrictEqual(warmLeasePayloads(harness.channel).map(payload => payload.active), [true, false]);
		assert.strictEqual(harness.channel.pendingWarmLeaseCount, 1);
		harness.channel.resolveNextWarmLease();
		await settle();
		assert.strictEqual(harness.channel.activeLeases.size, 0);
	});

	test('releases a late dashboard acquire after the editor is disposed', async () => {
		const harness = createHarness();
		disposables.add(harness.instantiationService);
		disposables.add(toDisposable(() => harness.configuration.dispose()));
		const editor = disposables.add(createEditor(harness, disposables.add(new TestStorageService())));
		const input = disposables.add(ParadisCcusageInput.instance);
		const parent = document.createElement('div');
		disposables.add(toDisposable(() => parent.remove()));
		editor.create(parent);
		editor.setVisible(true);
		harness.channel.holdNextWarmLeases();
		await editor.setInput(input, undefined, Object.create(null), CancellationToken.None);
		await settle();
		assert.strictEqual(harness.channel.pendingWarmLeaseCount, 1);

		editor.dispose();
		harness.channel.resolveNextWarmLease();
		await settle();
		assert.deepStrictEqual(warmLeasePayloads(harness.channel).map(payload => payload.active), [true, false]);
		assert.strictEqual(harness.channel.pendingWarmLeaseCount, 1);
		harness.channel.resolveNextWarmLease();
		await settle();
		assert.strictEqual(harness.channel.activeLeases.size, 0);
	});

	test('uses the latest status targets after configuration changes during a pending heartbeat', async () => {
		const clock = sinon.useFakeTimers({ now: new Date(2026, 7, 16, 12, 0, 0) });
		const harness = createHarness({ [STATUS_BAR_ENABLED_SETTING]: true });
		disposables.add(harness.instantiationService);
		disposables.add(toDisposable(() => harness.configuration.dispose()));
		const status = disposables.add(createStatusContribution(harness));
		await settle();
		harness.channel.holdNextWarmLeases();

		await clock.tickAsync(5 * 60 * 1000);
		await settle();
		assert.strictEqual(harness.channel.pendingWarmLeaseCount, 1);
		harness.configuration.setValue(PARADIS_CCUSAGE_SETTING_EXECUTABLE_PATH, ' /custom/ccusage ');
		await settle();
		assert.strictEqual(harness.channel.pendingWarmLeaseCount, 1);
		assert.deepStrictEqual(warmLeasePayloads(harness.channel).map(payload => payload.targets), [
			[{ kind: 'daily', options: { since: '20260519' } }],
			[{ kind: 'daily', options: { since: '20260519' } }],
		]);

		harness.channel.resolveNextWarmLease();
		await settle();
		assert.strictEqual(harness.channel.pendingWarmLeaseCount, 1);
		assert.deepStrictEqual(warmLeasePayloads(harness.channel).map(payload => payload.targets), [
			[{ kind: 'daily', options: { since: '20260519' } }],
			[{ kind: 'daily', options: { since: '20260519' } }],
			[{ kind: 'daily', options: { executablePath: '/custom/ccusage', since: '20260519' } }],
		]);
		harness.channel.resolveNextWarmLease();
		await settle();
		assert.deepStrictEqual(singleActiveLease(harness.channel), [{ kind: 'daily', options: { executablePath: '/custom/ccusage', since: '20260519' } }]);

		status.dispose();
		await settle();
		assert.strictEqual(harness.channel.pendingWarmLeaseCount, 1);
		harness.channel.resolveNextWarmLease();
		await settle();
		assert.strictEqual(harness.channel.activeLeases.size, 0);
	});

	test('renews fixed status and dashboard targets when the executable path or local day changes', async () => {
		const clock = sinon.useFakeTimers({ now: new Date(2026, 7, 16, 12, 0, 0) });
		const harness = createHarness({ [STATUS_BAR_ENABLED_SETTING]: true });
		disposables.add(harness.instantiationService);
		disposables.add(toDisposable(() => harness.configuration.dispose()));
		const status = disposables.add(createStatusContribution(harness));
		const editor = disposables.add(createEditor(harness, disposables.add(new TestStorageService())));
		const input = disposables.add(ParadisCcusageInput.instance);
		const parent = document.createElement('div');
		disposables.add(toDisposable(() => parent.remove()));
		editor.create(parent);
		editor.setVisible(true);
		await editor.setInput(input, undefined, Object.create(null), CancellationToken.None);
		await settle();

		const toolbarButtons = [...parent.querySelectorAll('button')];
		toolbarButtons.find(button => button.textContent === '7 Days')?.click();
		toolbarButtons.find(button => button.textContent === 'Weekly')?.click();
		toolbarButtons.find(button => button.textContent === 'Codex')?.click();
		toolbarButtons.find(button => button.textContent === 'Refresh')?.click();
		await settle();
		assert.strictEqual(harness.channel.activeLeases.size, 2);
		assert.deepStrictEqual([...harness.channel.activeLeases.values()].map(targetOptions).sort((left, right) => left.length - right.length), [
			[{ since: '20260519' }],
			[{ since: '20260519' }, {}, { since: '20260519' }, { since: '20260519' }],
		]);

		harness.configuration.setValue(PARADIS_CCUSAGE_SETTING_EXECUTABLE_PATH, ' /custom/ccusage ');
		await settle();
		assert.deepStrictEqual([...harness.channel.activeLeases.values()].map(targetOptions).sort((left, right) => left.length - right.length), [
			[{ executablePath: '/custom/ccusage', since: '20260519' }],
			[
				{ executablePath: '/custom/ccusage', since: '20260519' },
				{ executablePath: '/custom/ccusage' },
				{ executablePath: '/custom/ccusage', since: '20260519' },
				{ executablePath: '/custom/ccusage', since: '20260519' },
			],
		]);
		clock.setSystemTime(new Date(2026, 7, 17, 12, 0, 0));
		await clock.tickAsync(5 * 60 * 1000);
		await settle();
		assert.deepStrictEqual([...harness.channel.activeLeases.values()].map(targetOptions).sort((left, right) => left.length - right.length), [
			[{ executablePath: '/custom/ccusage', since: '20260520' }],
			[
				{ executablePath: '/custom/ccusage', since: '20260520' },
				{ executablePath: '/custom/ccusage' },
				{ executablePath: '/custom/ccusage', since: '20260520' },
				{ executablePath: '/custom/ccusage', since: '20260520' },
			],
		]);

		status.dispose();
		editor.dispose();
	});

	test('keeps foreground fetches and their error UI independent from a failed warm lease IPC call', async () => {
		const clock = sinon.useFakeTimers({ now: new Date(2026, 7, 16, 12, 0, 0) });
		const harness = createHarness({ [STATUS_BAR_ENABLED_SETTING]: true });
		harness.channel.leaseFailure = new Error('warm lease unavailable');
		disposables.add(harness.instantiationService);
		disposables.add(toDisposable(() => harness.configuration.dispose()));
		const status = disposables.add(createStatusContribution(harness));

		await clock.tickAsync(15_000);
		await settle();
		assert.strictEqual(harness.statusbarService.lastEntry?.text, '$(graph) $4.25');
		assert.ok(harness.channel.callsFor('setWarmLease').length > 0);
		assert.strictEqual(harness.channel.callsFor('fetchDaily').length, 1);

		harness.channel.dailyFailure = new Error('foreground dashboard failure');
		const editor = disposables.add(createEditor(harness, disposables.add(new TestStorageService())));
		const input = disposables.add(ParadisCcusageInput.instance);
		const parent = document.createElement('div');
		disposables.add(toDisposable(() => parent.remove()));
		editor.create(parent);
		editor.setVisible(true);
		await editor.setInput(input, undefined, Object.create(null), CancellationToken.None);
		await settle();
		assert.ok(parent.textContent?.includes('Failed to run ccusage: foreground dashboard failure'));

		status.dispose();
		editor.dispose();
	});
});
