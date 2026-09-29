/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import assert from 'assert';
import { DeferredPromise, timeout } from '../../../../../base/common/async.js';
import { runWithFakedTimers } from '../../../../../base/test/common/virtualScheduling/runWithFakedTimers.js';
import { Event, Emitter } from '../../../../../base/common/event.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { IConfigurationChangeEvent, IConfigurationService } from '../../../../../platform/configuration/common/configuration.js';
import { NullLogService } from '../../../../../platform/log/common/log.js';
import { IChannel } from '../../../../../base/parts/ipc/common/ipc.js';
import { IMainProcessService } from '../../../../../platform/ipc/common/mainProcessService.js';
import { PowerSaveBlockerType } from '../../../../../workbench/services/power/common/powerService.js';
import { IStatusbarEntry, IStatusbarEntryAccessor, IStatusbarService, StatusbarAlignment } from '../../../../../workbench/services/statusbar/browser/statusbar.js';
import { IDisposable, toDisposable } from '../../../../../base/common/lifecycle.js';
import { IParadisAgentPaneStatus } from '../../../agentBrowser/common/paradisAgentBrowser.js';
import { IParadisAgentStatusSnapshotOutcome, IParadisAgentStatusSnapshotService } from '../../../agentBrowser/electron-browser/paradisAgentStatusSnapshotService.js';
import { PARADIS_KEEP_AWAKE_SETTING, ParadisKeepAwakeMode } from '../../common/paradisKeepAwake.js';
import { ParadisKeepAwakeContribution } from '../../electron-browser/paradisKeepAwake.contribution.js';

class TestConfigurationService {
	private readonly onDidChangeConfigurationEmitter = new Emitter<IConfigurationChangeEvent>();
	readonly onDidChangeConfiguration = this.onDidChangeConfigurationEmitter.event;

	constructor(private mode: ParadisKeepAwakeMode) { }

	getValue<T>(key: string): T | undefined {
		return key === PARADIS_KEEP_AWAKE_SETTING ? this.mode as T : undefined;
	}

	setMode(mode: ParadisKeepAwakeMode): void {
		this.mode = mode;
		this.onDidChangeConfigurationEmitter.fire({
			affectsConfiguration: (key: string) => key === PARADIS_KEEP_AWAKE_SETTING,
		} as unknown as IConfigurationChangeEvent);
	}

	dispose(): void {
		this.onDidChangeConfigurationEmitter.dispose();
	}
}

/** main の blocker のチャネルの代わり（start / stop の呼び出しを覚える）。 */
class TestPowerService {
	readonly startedTypes: PowerSaveBlockerType[] = [];
	readonly stoppedIds: number[] = [];

	constructor(
		private readonly start: (type: PowerSaveBlockerType) => Promise<number>,
		private readonly stop: (id: number) => Promise<boolean>,
	) { }

	startPowerSaveBlocker(type: PowerSaveBlockerType): Promise<number> {
		this.startedTypes.push(type);
		return this.start(type);
	}

	stopPowerSaveBlocker(id: number): Promise<boolean> {
		this.stoppedIds.push(id);
		return this.stop(id);
	}

	asMainProcessService(): IMainProcessService {
		const channel: IChannel = {
			call: <T>(command: string, arg?: unknown): Promise<T> => {
				const value = Array.isArray(arg) ? arg[0] : undefined;
				switch (command) {
					case 'start': return this.startPowerSaveBlocker(value) as Promise<T>;
					case 'stop': return this.stopPowerSaveBlocker(value) as Promise<T>;
					default: throw new Error(`Unexpected ${command}`);
				}
			},
			listen: () => Event.None,
		};
		return { _serviceBrand: undefined, getChannel: () => channel, registerChannel: () => { } };
	}
}

class TestStatusbarAccessor implements IStatusbarEntryAccessor {
	readonly updates: IStatusbarEntry[] = [];
	disposeCalls = 0;

	update(entry: IStatusbarEntry): void {
		this.updates.push(entry);
	}

	dispose(): void {
		this.disposeCalls++;
	}
}

interface IAddedStatusbarEntry {
	readonly entry: IStatusbarEntry;
	readonly id: string;
	readonly alignment: StatusbarAlignment;
	readonly priority: number;
	readonly accessor: TestStatusbarAccessor;
}

class TestStatusbarService {
	readonly added: IAddedStatusbarEntry[] = [];
	readonly onDidAddEntry = new DeferredPromise<void>();

	addEntry(entry: IStatusbarEntry, id: string, alignment: StatusbarAlignment, priority: number): IStatusbarEntryAccessor {
		const accessor = new TestStatusbarAccessor();
		this.added.push({ entry, id, alignment, priority, accessor });
		this.onDidAddEntry.complete();
		return accessor;
	}
}

class TestLogService extends NullLogService {
	readonly errors: Array<{ readonly message: string | Error; readonly args: readonly unknown[] }> = [];

	override error(message: string | Error, ...args: unknown[]): void {
		this.errors.push({ message, args });
	}
}

class TestAgentStatusSnapshotService implements IParadisAgentStatusSnapshotService {
	declare readonly _serviceBrand: undefined;
	private readonly listeners = new Set<(outcome: IParadisAgentStatusSnapshotOutcome) => void>();
	private sequence = 0;

	get subscriberCount(): number {
		return this.listeners.size;
	}

	subscribe(listener: (outcome: IParadisAgentStatusSnapshotOutcome) => void): IDisposable {
		this.listeners.add(listener);
		return toDisposable(() => this.listeners.delete(listener));
	}

	requestRefresh(): void { }

	publish(paneStatuses: readonly IParadisAgentPaneStatus[]): void {
		const outcome: IParadisAgentStatusSnapshotOutcome = { sequence: ++this.sequence, snapshot: { paneStatuses, agentHookTokens: [] } };
		for (const listener of [...this.listeners]) {
			listener(outcome);
		}
	}

	publishError(): void {
		const outcome: IParadisAgentStatusSnapshotOutcome = { sequence: ++this.sequence, error: new Error('transport') };
		for (const listener of [...this.listeners]) {
			listener(outcome);
		}
	}
}

function createContribution(
	configurationService: TestConfigurationService,
	powerService: TestPowerService,
	statusbarService: TestStatusbarService,
	logService: TestLogService,
	agentStatusService: TestAgentStatusSnapshotService = new TestAgentStatusSnapshotService(),
): ParadisKeepAwakeContribution {
	return new ParadisKeepAwakeContribution(
		configurationService as unknown as IConfigurationService,
		powerService.asMainProcessService(),
		statusbarService as unknown as IStatusbarService,
		logService,
		agentStatusService,
	);
}

async function settle(): Promise<void> {
	for (let index = 0; index < 8; index++) {
		await Promise.resolve();
	}
}

suite('ParadisKeepAwakeContribution', () => {
	const disposables = ensureNoDisposablesAreLeakedInTestSuite();

	test('a pending start resolved after double dispose stops once without recreating status', async () => {
		const start = new DeferredPromise<number>();
		const onDidStart = new DeferredPromise<void>();
		const onDidStop = new DeferredPromise<void>();
		const configurationService = new TestConfigurationService('display');
		const powerService = new TestPowerService(
			async () => {
				onDidStart.complete();
				return start.p;
			},
			async () => {
				onDidStop.complete();
				return true;
			},
		);
		const statusbarService = new TestStatusbarService();
		const logService = disposables.add(new TestLogService());
		disposables.add(configurationService);
		const contribution = createContribution(configurationService, powerService, statusbarService, logService);

		await onDidStart.p;
		contribution.dispose();
		contribution.dispose();
		start.complete(73);
		await onDidStop.p;
		await settle();

		assert.deepStrictEqual({
			startedTypes: powerService.startedTypes,
			stoppedIds: powerService.stoppedIds,
			addedStatusEntries: statusbarService.added.length,
			logErrors: logService.errors.length,
		}, {
			startedTypes: ['prevent-display-sleep'],
			stoppedIds: [73],
			addedStatusEntries: 0,
			logErrors: 0,
		});
	});

	test('a false stop retains and retries the production blocker id before publishing off', async () => {
		let stopAttempt = 0;
		const onDidFirstStop = new DeferredPromise<void>();
		const configurationService = new TestConfigurationService('system');
		const powerService = new TestPowerService(
			async () => 41,
			async () => {
				stopAttempt++;
				if (stopAttempt === 1) {
					onDidFirstStop.complete();
					return false;
				}
				return true;
			},
		);
		const statusbarService = new TestStatusbarService();
		const logService = disposables.add(new TestLogService());
		disposables.add(configurationService);
		const contribution = createContribution(configurationService, powerService, statusbarService, logService);

		await statusbarService.onDidAddEntry.p;
		configurationService.setMode('off');
		await onDidFirstStop.p;
		await settle();

		assert.deepStrictEqual({
			stoppedIds: powerService.stoppedIds,
			statusAccessorDisposeCalls: statusbarService.added[0].accessor.disposeCalls,
			logOperations: logService.errors.map(error => error.message),
		}, {
			stoppedIds: [41],
			statusAccessorDisposeCalls: 0,
			logOperations: ['[paradisKeepAwake] blocker-stop-failed'],
		});

		configurationService.setMode('off');
		await settle();

		assert.deepStrictEqual({
			startedTypes: powerService.startedTypes,
			stoppedIds: powerService.stoppedIds,
			addedStatusEntries: statusbarService.added.length,
			statusAccessorDisposeCalls: statusbarService.added[0].accessor.disposeCalls,
			logOperations: logService.errors.map(error => error.message),
		}, {
			startedTypes: ['prevent-app-suspension'],
			stoppedIds: [41, 41],
			addedStatusEntries: 1,
			statusAccessorDisposeCalls: 1,
			logOperations: ['[paradisKeepAwake] blocker-stop-failed'],
		});

		contribution.dispose();
	});

	test('auto mode blocks system sleep only while an agent is active and stops listening when switched off', async () => {
		let nextId = 1;
		const configurationService = new TestConfigurationService('auto');
		const powerService = new TestPowerService(async () => nextId++, async () => true);
		const statusbarService = new TestStatusbarService();
		const logService = disposables.add(new TestLogService());
		const agentStatusService = new TestAgentStatusSnapshotService();
		disposables.add(configurationService);
		const contribution = createContribution(configurationService, powerService, statusbarService, logService, agentStatusService);
		await settle();
		const startedWhileIdle = powerService.startedTypes.length;

		agentStatusService.publish([{ token: 'a', status: 'permission', changedAt: Date.now() }]);
		await settle();
		const startedWhileWaiting = [...powerService.startedTypes];

		// A failed poll keeps the previous decision instead of releasing the blocker.
		agentStatusService.publishError();
		await settle();
		const stoppedAfterError = powerService.stoppedIds.length;

		agentStatusService.publish([{ token: 'a', status: 'review', changedAt: Date.now() }]);
		await settle();
		const stoppedAfterReview = [...powerService.stoppedIds];

		configurationService.setMode('off');
		await settle();

		assert.deepStrictEqual({
			startedWhileIdle,
			startedWhileWaiting,
			stoppedAfterError,
			stoppedAfterReview,
			firstStatusText: statusbarService.added[0]?.entry.text,
			subscribersAfterOff: agentStatusService.subscriberCount,
		}, {
			startedWhileIdle: 0,
			startedWhileWaiting: ['prevent-app-suspension'],
			stoppedAfterError: 0,
			stoppedAfterReview: [1],
			firstStatusText: '$(zap) \u30b9\u30ea\u30fc\u30d7\u9632\u6b62\u4e2d\uff08\u30a8\u30fc\u30b8\u30a7\u30f3\u30c8\uff09',
			subscribersAfterOff: 0,
		});

		contribution.dispose();
	});

	test('auto mode lets the PC sleep after about a minute when agent status stops arriving at all', () => runWithFakedTimers({ startTime: 1_000_000 }, async () => {
		let nextId = 1;
		const configurationService = new TestConfigurationService('auto');
		const powerService = new TestPowerService(async () => nextId++, async () => true);
		const statusbarService = new TestStatusbarService();
		const logService = disposables.add(new TestLogService());
		const agentStatusService = new TestAgentStatusSnapshotService();
		disposables.add(configurationService);
		const contribution = createContribution(configurationService, powerService, statusbarService, logService, agentStatusService);

		agentStatusService.publish([{ token: 'a', status: 'working', changedAt: Date.now() }]);
		await settle();
		const startedWhileWorking = [...powerService.startedTypes];
		// 配る側が失敗も返さず黙ったまま。60秒ごとの見直しだけが頼り
		await timeout(30_000);
		const stoppedWithinAMinute = powerService.stoppedIds.length;
		await timeout(95_000);
		await settle();

		assert.deepStrictEqual({ startedWhileWorking, stoppedWithinAMinute, stoppedAfterSilence: powerService.stoppedIds }, {
			startedWhileWorking: ['prevent-app-suspension'],
			stoppedWithinAMinute: 0,
			stoppedAfterSilence: [1],
		});
		contribution.dispose();
	}));
});
