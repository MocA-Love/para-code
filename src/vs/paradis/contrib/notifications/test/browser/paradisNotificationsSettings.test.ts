/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-PATCH/PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import assert from 'assert';
import { timeout } from '../../../../../base/common/async.js';
import { Event } from '../../../../../base/common/event.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { InMemoryStorageService, StorageScope, StorageTarget } from '../../../../../platform/storage/common/storage.js';
import {
	IParadisDoNotDisturbChangeEvent,
	IParadisDoNotDisturbState,
	ParadisNotificationsChangeScope,
	ParadisNotificationsSettingsService,
	paradisScheduleDoNotDisturbExternalChange,
} from '../../browser/paradisNotificationsSettings.js';

const KEY_DO_NOT_DISTURB = 'paradis.notifications.doNotDisturb';
const KEY_DO_NOT_DISTURB_UNTIL = 'paradis.notifications.doNotDisturbUntil';

class TestStorageService extends InMemoryStorageService {
	emitUndefinedExternalDndChange(): void {
		this.emitDidChangeValue(StorageScope.APPLICATION, { key: KEY_DO_NOT_DISTURB, external: undefined });
	}
}

suite('Paradis notifications DND settings', () => {
	const store = ensureNoDisposablesAreLeakedInTestSuite();

	function createService(storage = store.add(new TestStorageService())): {
		readonly service: ParadisNotificationsSettingsService;
		readonly storage: TestStorageService;
	} {
		return {
			service: store.add(new ParadisNotificationsSettingsService(storage)),
			storage,
		};
	}

	function recordEvents(service: ParadisNotificationsSettingsService): {
		readonly genericScopes: ParadisNotificationsChangeScope[];
		readonly dedicatedEvents: IParadisDoNotDisturbChangeEvent[];
	} {
		const genericScopes: ParadisNotificationsChangeScope[] = [];
		const dedicatedEvents: IParadisDoNotDisturbChangeEvent[] = [];
		store.add(service.onDidChange(scope => genericScopes.push(scope)));
		store.add(service.onDidChangeDoNotDisturb(event => dedicatedEvents.push(event)));
		return { genericScopes, dedicatedEvents };
	}

	test('keeps generic DND changes local to the writer', async () => {
		const { service } = createService();
		const { genericScopes, dedicatedEvents } = recordEvents(service);
		const futureUntil = Date.now() + 60_000;
		const operations: readonly (() => void)[] = [
			() => service.setDoNotDisturb(true, undefined),
			() => service.setDoNotDisturb(true, futureUntil),
			() => service.setDoNotDisturb(false, undefined),
		];

		for (const operation of operations) {
			genericScopes.length = 0;
			dedicatedEvents.length = 0;
			operation();

			assert.deepStrictEqual({ genericScopes, dedicatedEvents }, {
				genericScopes: ['dnd'],
				dedicatedEvents: [{ external: false }],
			});

			await timeout(0);
			assert.deepStrictEqual({ genericScopes, dedicatedEvents }, {
				genericScopes: ['dnd'],
				dedicatedEvents: [{ external: false }],
			});
		}
	});

	test('does not reset the pending fixed external window', () => {
		const scheduler = {
			pending: false,
			scheduleCount: 0,
			isScheduled(): boolean {
				return this.pending;
			},
			schedule(): void {
				this.pending = true;
				this.scheduleCount++;
			},
		};

		paradisScheduleDoNotDisturbExternalChange(scheduler);
		paradisScheduleDoNotDisturbExternalChange(scheduler);
		const firstWindowScheduleCount = scheduler.scheduleCount;
		scheduler.pending = false;
		paradisScheduleDoNotDisturbExternalChange(scheduler);

		assert.deepStrictEqual({ firstWindowScheduleCount, scheduleCount: scheduler.scheduleCount }, {
			firstWindowScheduleCount: 1,
			scheduleCount: 2,
		});
	});

	test('coalesces two external DND keys in one fixed zero-millisecond window', async () => {
		const { service, storage } = createService();
		const { genericScopes, dedicatedEvents } = recordEvents(service);
		const snapshots: IParadisDoNotDisturbState[] = [];
		store.add(service.onDidChangeDoNotDisturb(() => snapshots.push(service.getDoNotDisturb())));
		const externalChange = Event.toPromise(service.onDidChangeDoNotDisturb);
		const futureUntil = Date.now() + 60_000;

		storage.storeAll([
			{ key: KEY_DO_NOT_DISTURB, value: true, scope: StorageScope.APPLICATION, target: StorageTarget.MACHINE },
			{ key: KEY_DO_NOT_DISTURB_UNTIL, value: futureUntil, scope: StorageScope.APPLICATION, target: StorageTarget.MACHINE },
		], true);
		await externalChange;

		assert.deepStrictEqual({ genericScopes, dedicatedEvents, snapshots }, {
			genericScopes: [],
			dedicatedEvents: [{ external: true }],
			snapshots: [{ enabled: true, until: futureUntil }],
		});
	});

	test('opens a new external window after the scheduler drains', async () => {
		const { service, storage } = createService();
		const { genericScopes, dedicatedEvents } = recordEvents(service);
		const snapshots: IParadisDoNotDisturbState[] = [];
		store.add(service.onDidChangeDoNotDisturb(() => snapshots.push(service.getDoNotDisturb())));
		const firstUntil = Date.now() + 60_000;
		const secondUntil = firstUntil + 60_000;

		const firstChange = Event.toPromise(service.onDidChangeDoNotDisturb);
		storage.storeAll([
			{ key: KEY_DO_NOT_DISTURB, value: true, scope: StorageScope.APPLICATION, target: StorageTarget.MACHINE },
			{ key: KEY_DO_NOT_DISTURB_UNTIL, value: firstUntil, scope: StorageScope.APPLICATION, target: StorageTarget.MACHINE },
		], true);
		await firstChange;

		const secondChange = Event.toPromise(service.onDidChangeDoNotDisturb);
		storage.storeAll([
			{ key: KEY_DO_NOT_DISTURB_UNTIL, value: secondUntil, scope: StorageScope.APPLICATION, target: StorageTarget.MACHINE },
		], true);
		await secondChange;

		assert.deepStrictEqual({ genericScopes, dedicatedEvents, snapshots }, {
			genericScopes: [],
			dedicatedEvents: [{ external: true }, { external: true }],
			snapshots: [
				{ enabled: true, until: firstUntil },
				{ enabled: true, until: secondUntil },
			],
		});
	});

	test('accepts only external application changes for the two DND keys', async () => {
		const { service, storage } = createService();
		const { genericScopes, dedicatedEvents } = recordEvents(service);

		storage.storeAll([
			{ key: KEY_DO_NOT_DISTURB, value: true, scope: StorageScope.PROFILE, target: StorageTarget.MACHINE },
			{ key: KEY_DO_NOT_DISTURB, value: true, scope: StorageScope.WORKSPACE, target: StorageTarget.MACHINE },
			{ key: 'paradis.notifications.other', value: true, scope: StorageScope.APPLICATION, target: StorageTarget.MACHINE },
			{ key: KEY_DO_NOT_DISTURB, value: true, scope: StorageScope.APPLICATION, target: StorageTarget.MACHINE },
		], false);
		storage.emitUndefinedExternalDndChange();
		await timeout(0);

		assert.deepStrictEqual({ genericScopes, dedicatedEvents }, { genericScopes: [], dedicatedEvents: [] });

		const externalChange = Event.toPromise(service.onDidChangeDoNotDisturb);
		storage.storeAll([
			{ key: KEY_DO_NOT_DISTURB, value: false, scope: StorageScope.APPLICATION, target: StorageTarget.MACHINE },
		], true);
		await externalChange;

		assert.deepStrictEqual({ genericScopes, dedicatedEvents }, {
			genericScopes: [],
			dedicatedEvents: [{ external: true }],
		});
	});

	test('cancels queued external notification on disposal', async () => {
		const { service, storage } = createService();
		const { genericScopes, dedicatedEvents } = recordEvents(service);
		const futureUntil = Date.now() + 60_000;

		storage.storeAll([
			{ key: KEY_DO_NOT_DISTURB, value: true, scope: StorageScope.APPLICATION, target: StorageTarget.MACHINE },
			{ key: KEY_DO_NOT_DISTURB_UNTIL, value: futureUntil, scope: StorageScope.APPLICATION, target: StorageTarget.MACHINE },
		], true);
		service.dispose();
		await timeout(0);
		storage.storeAll([
			{ key: KEY_DO_NOT_DISTURB_UNTIL, value: futureUntil + 60_000, scope: StorageScope.APPLICATION, target: StorageTarget.MACHINE },
		], true);
		await timeout(0);

		assert.deepStrictEqual({ genericScopes, dedicatedEvents }, { genericScopes: [], dedicatedEvents: [] });
	});

	test('mirrors one local window change as one external change in another window', async () => {
		const windowA = createService();
		const windowB = createService();
		const eventsA = recordEvents(windowA.service);
		const eventsB = recordEvents(windowB.service);
		const futureUntil = Date.now() + 60_000;

		windowA.service.setDoNotDisturb(true, futureUntil);
		const externalChange = Event.toPromise(windowB.service.onDidChangeDoNotDisturb);
		windowB.storage.storeAll([
			{ key: KEY_DO_NOT_DISTURB, value: true, scope: StorageScope.APPLICATION, target: StorageTarget.MACHINE },
			{ key: KEY_DO_NOT_DISTURB_UNTIL, value: futureUntil, scope: StorageScope.APPLICATION, target: StorageTarget.MACHINE },
		], true);
		await externalChange;

		assert.deepStrictEqual({
			eventsA,
			eventsB,
			stateA: windowA.service.getDoNotDisturb(),
			stateB: windowB.service.getDoNotDisturb(),
		}, {
			eventsA: {
				genericScopes: ['dnd'],
				dedicatedEvents: [{ external: false }],
			},
			eventsB: {
				genericScopes: [],
				dedicatedEvents: [{ external: true }],
			},
			stateA: { enabled: true, until: futureUntil },
			stateB: { enabled: true, until: futureUntil },
		});
	});

	test('keeps expired-state cleanup silent', async () => {
		const storage = store.add(new TestStorageService());
		storage.storeAll([
			{ key: KEY_DO_NOT_DISTURB, value: true, scope: StorageScope.APPLICATION, target: StorageTarget.MACHINE },
			{ key: KEY_DO_NOT_DISTURB_UNTIL, value: Date.now() - 1, scope: StorageScope.APPLICATION, target: StorageTarget.MACHINE },
		], false);
		const { service } = createService(storage);
		const { genericScopes, dedicatedEvents } = recordEvents(service);

		const state = service.getDoNotDisturb();
		await timeout(0);

		assert.deepStrictEqual({
			state,
			genericScopes,
			dedicatedEvents,
			storedEnabled: storage.get(KEY_DO_NOT_DISTURB, StorageScope.APPLICATION),
			storedUntil: storage.get(KEY_DO_NOT_DISTURB_UNTIL, StorageScope.APPLICATION),
		}, {
			state: { enabled: false, until: undefined },
			genericScopes: [],
			dedicatedEvents: [],
			storedEnabled: undefined,
			storedUntil: undefined,
		});
	});
});
