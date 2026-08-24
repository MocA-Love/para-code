/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import assert from 'assert';
import { DeferredPromise } from '../../../../../base/common/async.js';
import { Event, Emitter } from '../../../../../base/common/event.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { IConfigurationChangeEvent, IConfigurationService } from '../../../../../platform/configuration/common/configuration.js';
import { NullLogService } from '../../../../../platform/log/common/log.js';
import { IPowerService, PowerSaveBlockerType, SystemIdleState, ThermalState } from '../../../../../workbench/services/power/common/powerService.js';
import { IStatusbarEntry, IStatusbarEntryAccessor, IStatusbarService, StatusbarAlignment } from '../../../../../workbench/services/statusbar/browser/statusbar.js';
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

class TestPowerService implements IPowerService {
	declare readonly _serviceBrand: undefined;
	readonly onDidSuspend = Event.None;
	readonly onDidResume = Event.None;
	readonly onDidChangeOnBatteryPower = Event.None;
	readonly onDidChangeThermalState = Event.None;
	readonly onDidChangeSpeedLimit = Event.None;
	readonly onWillShutdown = Event.None;
	readonly onDidLockScreen = Event.None;
	readonly onDidUnlockScreen = Event.None;
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

	async getSystemIdleState(_idleThreshold: number): Promise<SystemIdleState> { throw new Error('Unexpected getSystemIdleState'); }
	async getSystemIdleTime(): Promise<number> { throw new Error('Unexpected getSystemIdleTime'); }
	async getCurrentThermalState(): Promise<ThermalState> { throw new Error('Unexpected getCurrentThermalState'); }
	async isOnBatteryPower(): Promise<boolean> { throw new Error('Unexpected isOnBatteryPower'); }
	async isPowerSaveBlockerStarted(_id: number): Promise<boolean> { throw new Error('Unexpected isPowerSaveBlockerStarted'); }
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

function createContribution(
	configurationService: TestConfigurationService,
	powerService: TestPowerService,
	statusbarService: TestStatusbarService,
	logService: TestLogService,
): ParadisKeepAwakeContribution {
	return new ParadisKeepAwakeContribution(
		configurationService as unknown as IConfigurationService,
		powerService,
		statusbarService as unknown as IStatusbarService,
		logService,
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
});
