/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-PATCH/PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import assert from 'assert';
import { timeout } from '../../../../../base/common/async.js';
import { Emitter, Event } from '../../../../../base/common/event.js';
import { Disposable } from '../../../../../base/common/lifecycle.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { InMemoryStorageService, StorageScope, StorageTarget } from '../../../../../platform/storage/common/storage.js';
import { ISecretStorageService } from '../../../../../platform/secrets/common/secrets.js';
import { TestSecretStorageService } from '../../../../../platform/secrets/test/common/testSecretStorageService.js';
import {
	IParadisDoNotDisturbChangeEvent,
	IParadisDoNotDisturbState,
	ParadisNotificationsChangeScope,
	ParadisNotificationsSettingsService,
	paradisScheduleDoNotDisturbExternalChange,
	paradisWaitForApiKeys,
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
			service: store.add(new ParadisNotificationsSettingsService(storage, store.add(new TestSecretStorageService()))),
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

/** 暗号化して保存できる secret storage の代わり。書き込みを失敗させることもできる。 */
class PersistedSecretStorage extends Disposable implements ISecretStorageService {
	declare readonly _serviceBrand: undefined;
	readonly type = 'persisted' as const;
	failWrites = false;

	private readonly values = new Map<string, string>();
	private readonly changeEmitter = this._register(new Emitter<string>());
	readonly onDidChangeSecret = this.changeEmitter.event;

	async get(key: string): Promise<string | undefined> {
		return this.values.get(key);
	}

	async set(key: string, value: string): Promise<void> {
		if (this.failWrites) {
			throw new Error('cannot write');
		}
		this.values.set(key, value);
		this.changeEmitter.fire(key);
	}

	async delete(key: string): Promise<void> {
		this.values.delete(key);
		this.changeEmitter.fire(key);
	}
}

const KEY_AIVIS = 'paradis.notifications.aivis';
const SECRET_AIVIS = 'paradis.notifications.aivis.apiKey';
const SECRET_ELEVENLABS = 'paradis.notifications.elevenLabs.apiKey';

suite('Paradis notifications voice API keys', () => {
	const store = ensureNoDisposablesAreLeakedInTestSuite();

	function seed(storage: InMemoryStorageService, value: object): void {
		storage.store(KEY_AIVIS, JSON.stringify(value), StorageScope.APPLICATION, StorageTarget.MACHINE);
	}

	function stored(storage: InMemoryStorageService): Record<string, unknown> {
		return JSON.parse(storage.get(KEY_AIVIS, StorageScope.APPLICATION) ?? '{}');
	}

	test('moves the plaintext Aivis key into secret storage and removes it from the JSON', async () => {
		const storage = store.add(new InMemoryStorageService());
		const secrets = store.add(new PersistedSecretStorage());
		seed(storage, { enabled: true, apiKey: 'aivis_plain', modelUuid: 'm' });
		const service = store.add(new ParadisNotificationsSettingsService(storage, secrets));
		await service.whenApiKeysLoaded();

		assert.deepStrictEqual({
			apiKey: service.getAivisSettings().apiKey,
			engine: service.getAivisSettings().engine,
			secret: await secrets.get(SECRET_AIVIS),
			json: stored(storage),
		}, {
			apiKey: 'aivis_plain',
			engine: 'aivis',
			secret: 'aivis_plain',
			// キー本体は消え、「secret に置いた」印だけが残る。
			json: { enabled: true, modelUuid: 'm', secretApiKeys: ['apiKey'] },
		});
	});

	test('keeps the plaintext key when it cannot be moved', async () => {
		const storage = store.add(new InMemoryStorageService());
		const secrets = store.add(new PersistedSecretStorage());
		secrets.failWrites = true;
		seed(storage, { enabled: true, apiKey: 'aivis_plain' });
		const service = store.add(new ParadisNotificationsSettingsService(storage, secrets));
		await service.whenApiKeysLoaded();
		service.setAivisSettings({ volume: 40 });

		assert.deepStrictEqual({ apiKey: service.getAivisSettings().apiKey, json: stored(storage).apiKey }, { apiKey: 'aivis_plain', json: 'aivis_plain' });
	});

	test('leaves keys in the JSON when secret storage only lives in memory', async () => {
		const storage = store.add(new InMemoryStorageService());
		const secrets = store.add(new TestSecretStorageService());
		seed(storage, { apiKey: 'aivis_plain' });
		const service = store.add(new ParadisNotificationsSettingsService(storage, secrets));
		await service.whenApiKeysLoaded();
		service.setAivisSettings({ elevenLabsApiKey: 'el_key' });
		await timeout(0);

		assert.deepStrictEqual({
			settings: [service.getAivisSettings().apiKey, service.getAivisSettings().elevenLabsApiKey],
			json: [stored(storage).apiKey, stored(storage).elevenLabsApiKey],
			secrets: await secrets.keys(),
		}, { settings: ['aivis_plain', 'el_key'], json: ['aivis_plain', 'el_key'], secrets: [] });
	});

	test('reuses voices by default and keeps the voice cache switch only when it is turned off', () => {
		const read = (value: object) => {
			const storage = store.add(new InMemoryStorageService());
			seed(storage, value);
			return store.add(new ParadisNotificationsSettingsService(storage, store.add(new PersistedSecretStorage()))).getAivisSettings().elevenLabsVoiceCache;
		};
		assert.deepStrictEqual([read({}), read({ elevenLabsVoiceCache: false }), read({ elevenLabsVoiceCache: true }), read({ elevenLabsVoiceCache: 'no' })], [true, false, true, true]);
	});

	test('stores each engine key separately and keeps the other when switching engines', async () => {
		const storage = store.add(new InMemoryStorageService());
		const secrets = store.add(new PersistedSecretStorage());
		const service = store.add(new ParadisNotificationsSettingsService(storage, secrets));
		await service.whenApiKeysLoaded();
		service.setAivisSettings({ apiKey: 'aivis_key', modelUuid: 'model' });
		service.setAivisSettings({ engine: 'elevenlabs', elevenLabsApiKey: 'el_key', elevenLabsVoiceId: 'voice', elevenLabsSpeed: 5 });
		service.setAivisSettings({ engine: 'aivis' });
		await timeout(0);
		const settings = service.getAivisSettings();

		assert.deepStrictEqual({
			settings: [settings.engine, settings.apiKey, settings.modelUuid, settings.elevenLabsApiKey, settings.elevenLabsVoiceId, settings.elevenLabsSpeed],
			secrets: [await secrets.get(SECRET_AIVIS), await secrets.get(SECRET_ELEVENLABS)],
			jsonHasKeys: [stored(storage).apiKey !== undefined, stored(storage).elevenLabsApiKey !== undefined],
		}, {
			settings: ['aivis', 'aivis_key', 'model', 'el_key', 'voice', 1.2],
			secrets: ['aivis_key', 'el_key'],
			jsonHasKeys: [false, false],
		});
	});

	test('deletes the secrets when the keys are cleared, as the dialog reset does', async () => {
		const storage = store.add(new InMemoryStorageService());
		const secrets = store.add(new PersistedSecretStorage());
		const service = store.add(new ParadisNotificationsSettingsService(storage, secrets));
		await service.whenApiKeysLoaded();
		service.setAivisSettings({ apiKey: 'aivis_key', elevenLabsApiKey: 'el_key' });
		await timeout(0);
		const markersAfterSet = stored(storage).secretApiKeys;
		service.setAivisSettings({ apiKey: '', elevenLabsApiKey: '', engine: 'aivis' });
		await timeout(0);

		assert.deepStrictEqual({
			markersAfterSet,
			secrets: [await secrets.get(SECRET_AIVIS), await secrets.get(SECRET_ELEVENLABS)],
			markers: stored(storage).secretApiKeys,
			settings: [service.getAivisSettings().apiKey, service.getAivisSettings().elevenLabsApiKey],
		}, { markersAfterSet: ['apiKey', 'elevenLabsApiKey'], secrets: [undefined, undefined], markers: [], settings: ['', ''] });
	});

	test('reloads a key that another window changed in secret storage', async () => {
		const storage = store.add(new InMemoryStorageService());
		const secrets = store.add(new PersistedSecretStorage());
		const service = store.add(new ParadisNotificationsSettingsService(storage, secrets));
		await service.whenApiKeysLoaded();
		const scopes: string[] = [];
		store.add(service.onDidChange(scope => scopes.push(scope)));
		await secrets.set(SECRET_ELEVENLABS, 'from_other_window');
		await timeout(0);

		assert.deepStrictEqual({ key: service.getAivisSettings().elevenLabsApiKey, scopes }, { key: 'from_other_window', scopes: ['aivis'] });
	});

	test('flags a moved key that can no longer be read and clears the flag when a new key is entered', async () => {
		const storage = store.add(new InMemoryStorageService());
		const secrets = store.add(new PersistedSecretStorage());
		// 前回は secret に置いた印があるのに、復号に失敗して上流の get が消した状態。
		seed(storage, { enabled: true, secretApiKeys: ['apiKey'] });
		const service = store.add(new ParadisNotificationsSettingsService(storage, secrets));
		await service.whenApiKeysLoaded();
		const lostAfterLoad = [service.isApiKeyLost('apiKey'), service.isApiKeyLost('elevenLabsApiKey')];
		const settingsHaveNoMarker = !Object.keys(service.getAivisSettings()).includes('secretApiKeys');
		service.setAivisSettings({ apiKey: 'aivis_new' });
		await timeout(0);

		assert.deepStrictEqual({ lostAfterLoad, settingsHaveNoMarker, lostAfterEntry: service.isApiKeyLost('apiKey'), secret: await secrets.get(SECRET_AIVIS) }, {
			lostAfterLoad: [true, false],
			settingsHaveNoMarker: true,
			lostAfterEntry: false,
			secret: 'aivis_new',
		});
	});

	test('gives up waiting for keys when secret storage never answers', async () => {
		const hanging = { areApiKeysLoaded: () => false, whenApiKeysLoaded: () => new Promise<void>(() => { /* never */ }) };
		const loaded = { areApiKeysLoaded: () => true, whenApiKeysLoaded: () => new Promise<void>(() => { /* never */ }) };
		const later = { areApiKeysLoaded: () => false, whenApiKeysLoaded: () => Promise.resolve() };

		assert.deepStrictEqual([
			await paradisWaitForApiKeys(hanging, 10),
			await paradisWaitForApiKeys(loaded, 10),
			await paradisWaitForApiKeys(later, 10),
		], [false, true, true]);
	});

	test('does not drop the plaintext key when other settings change before loading finishes', async () => {
		const storage = store.add(new InMemoryStorageService());
		const secrets = store.add(new PersistedSecretStorage());
		seed(storage, { apiKey: 'aivis_plain' });
		const service = store.add(new ParadisNotificationsSettingsService(storage, secrets));
		service.setAivisSettings({ volume: 30 });
		const beforeLoad = stored(storage).apiKey;
		await service.whenApiKeysLoaded();

		assert.deepStrictEqual({ beforeLoad, apiKey: service.getAivisSettings().apiKey, secret: await secrets.get(SECRET_AIVIS) }, { beforeLoad: 'aivis_plain', apiKey: 'aivis_plain', secret: 'aivis_plain' });
	});
});
