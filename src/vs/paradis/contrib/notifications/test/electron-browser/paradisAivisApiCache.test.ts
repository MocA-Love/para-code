/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { mainWindow } from '../../../../../base/browser/window.js';
import { DeferredPromise } from '../../../../../base/common/async.js';
import { Emitter, Event } from '../../../../../base/common/event.js';
import { Disposable } from '../../../../../base/common/lifecycle.js';
import { IChannel } from '../../../../../base/parts/ipc/common/ipc.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { ISharedProcessService } from '../../../../../platform/ipc/electron-browser/services.js';
import {
	IParadisAivisSettings,
	IParadisDoNotDisturbChangeEvent,
	IParadisDoNotDisturbState,
	IParadisNotificationsSettingsService,
	ParadisNotificationsChangeScope,
} from '../../browser/paradisNotificationsSettings.js';
import {
	IParadisAivisDictionaryListItem,
	IParadisAivisMeResult,
	IParadisAivisModelPreset,
	IParadisAivisModelSummary,
	IParadisAivisUsageResult,
} from '../../common/paradisNotifications.js';
import {
	clearAivisApiCaches,
	getCachedAivisDictionaryList,
	getCachedAivisModelInfo,
	invalidateAivisDictionaryListCache,
	IParadisAivisUsageBundle,
	ParadisAivisRenderGeneration,
	ParadisAivisUsageRequestCache,
	setCachedAivisDictionaryList,
	setCachedAivisModelInfo,
} from '../../electron-browser/paradisAivisApiCache.js';
import { ParadisAivisUsageSection } from '../../electron-browser/paradisAivisUsageSection.js';

const DICTIONARY_A: IParadisAivisDictionaryListItem = {
	uuid: 'dictionary-a',
	name: 'Dictionary A',
	description: 'first',
	word_count: 1,
	created_at: '2026-07-01T00:00:00Z',
	updated_at: '2026-07-02T00:00:00Z',
};

const DICTIONARY_B: IParadisAivisDictionaryListItem = {
	uuid: 'dictionary-b',
	name: 'Dictionary B',
	description: 'second',
	word_count: 2,
	created_at: '2026-07-03T00:00:00Z',
	updated_at: '2026-07-04T00:00:00Z',
};

function model(uuid: string, name: string): IParadisAivisModelSummary {
	return {
		uuid,
		name,
		description: `${name} description`,
		iconUrl: `https://example.test/${uuid}.png`,
		sampleUrl: `https://example.test/${uuid}.mp3`,
		authorName: 'Author',
		authorHandle: 'author',
	};
}

const EMPTY_USAGE: IParadisAivisUsageResult = {
	days: [],
	total: { requestCount: 0, characterCount: 0, creditConsumed: 0 },
};

const EMPTY_ME: IParadisAivisMeResult = {
	handle: null,
	name: null,
	creditBalance: null,
};

const EMPTY_BUNDLE: IParadisAivisUsageBundle = {
	usage: EMPTY_USAGE,
	me: EMPTY_ME,
};

async function flushMicrotasks(): Promise<void> {
	for (let index = 0; index < 4; index++) {
		await Promise.resolve();
	}
}

class TestSettingsService extends Disposable implements IParadisNotificationsSettingsService {
	declare readonly _serviceBrand: undefined;

	private readonly changeEmitter = this._register(new Emitter<ParadisNotificationsChangeScope>());
	readonly onDidChange: Event<ParadisNotificationsChangeScope> = this.changeEmitter.event;
	readonly onDidChangeDoNotDisturb: Event<IParadisDoNotDisturbChangeEvent> = Event.None;

	private aivisSettings: IParadisAivisSettings = {
		enabled: true,
		apiKey: 'test-key-a',
		modelUuid: '',
		userDictionaryUuid: '',
		format: '',
		formatPermission: '',
		volume: 100,
		speakingRate: 1,
	};

	fireAivisChange(patch: Partial<IParadisAivisSettings> = {}): void {
		this.aivisSettings = { ...this.aivisSettings, ...patch };
		this.changeEmitter.fire('aivis');
	}

	getSelectedRingtoneId(): string { return 'default'; }
	setSelectedRingtoneId(_id: string): void { }
	getSoundsMuted(): boolean { return false; }
	setSoundsMuted(_muted: boolean): void { }
	getVolume(): number { return 100; }
	setVolume(_volume: number): void { }
	getOsNotificationsEnabled(): boolean { return true; }
	setOsNotificationsEnabled(_enabled: boolean): void { }
	getOsNotifyOnPermission(): boolean { return true; }
	setOsNotifyOnPermission(_enabled: boolean): void { }
	getOsNotifyOnReview(): boolean { return true; }
	setOsNotifyOnReview(_enabled: boolean): void { }
	getNotifyWhileFocused(): boolean { return false; }
	setNotifyWhileFocused(_enabled: boolean): void { }
	getDoNotDisturb(): IParadisDoNotDisturbState { return { enabled: false, until: undefined }; }
	setDoNotDisturb(_enabled: boolean, _until: number | undefined): void { }
	getAivisSettings(): IParadisAivisSettings { return this.aivisSettings; }
	setAivisSettings(patch: Partial<IParadisAivisSettings>): void { this.fireAivisChange(patch); }
	getCustomAivisModelPresets(): readonly IParadisAivisModelPreset[] { return []; }
	addCustomAivisModelPreset(_preset: IParadisAivisModelPreset): void { }
	removeCustomAivisModelPreset(_uuid: string): void { }
}

class AivisUsageChannel implements IChannel {
	readonly commands: string[] = [];
	usageResult: Promise<IParadisAivisUsageResult> = Promise.resolve(EMPTY_USAGE);
	meResult: Promise<IParadisAivisMeResult> = Promise.resolve(EMPTY_ME);

	call<T>(command: string): Promise<T> {
		this.commands.push(command);
		if (command === 'getAivisUsageDaily') {
			return this.usageResult as Promise<T>;
		}
		if (command === 'getAivisMe') {
			return this.meResult as Promise<T>;
		}
		throw new Error(`Unexpected command: ${command}`);
	}

	listen<T>(): Event<T> {
		return Event.None;
	}
}

function createContainer(title: string): HTMLElement {
	const document = mainWindow.document.implementation.createHTMLDocument(title);
	return document.createElement('div');
}

function createSharedProcessService(channel: IChannel): ISharedProcessService {
	return { getChannel: () => channel } as unknown as ISharedProcessService;
}

function dispatchClick(element: Element): void {
	const event = element.ownerDocument.createEvent('Event');
	event.initEvent('click', true, true);
	element.dispatchEvent(event);
}

suite('Paradis Aivis API cache', () => {
	const store = ensureNoDisposablesAreLeakedInTestSuite();

	setup(() => clearAivisApiCaches());
	teardown(() => clearAivisApiCaches());

	test('separates dictionary lists by API key and invalidates only the selected key', () => {
		setCachedAivisDictionaryList('api-key-a', [DICTIONARY_A]);
		setCachedAivisDictionaryList('api-key-b', [DICTIONARY_B]);

		assert.deepStrictEqual(getCachedAivisDictionaryList('api-key-a'), [DICTIONARY_A]);
		assert.deepStrictEqual(getCachedAivisDictionaryList('api-key-b'), [DICTIONARY_B]);

		invalidateAivisDictionaryListCache('api-key-a');
		assert.strictEqual(getCachedAivisDictionaryList('api-key-a'), undefined);
		assert.deepStrictEqual(getCachedAivisDictionaryList('api-key-b'), [DICTIONARY_B]);
	});

	test('separates model entries by both API key and model UUID', () => {
		const modelA = model('model-a', 'Model A');
		const modelB = model('model-b', 'Model B');
		const modelForOtherKey = model('model-a', 'Model A for another key');

		setCachedAivisModelInfo('api-key-a', 'model-a', modelA);
		setCachedAivisModelInfo('api-key-a', 'model-b', modelB);
		setCachedAivisModelInfo('api-key-b', 'model-a', modelForOtherKey);

		assert.strictEqual(getCachedAivisModelInfo('api-key-a', 'model-a'), modelA);
		assert.strictEqual(getCachedAivisModelInfo('api-key-a', 'model-b'), modelB);
		assert.strictEqual(getCachedAivisModelInfo('api-key-b', 'model-a'), modelForOtherKey);
	});

	test('does not cache a null model lookup', () => {
		setCachedAivisModelInfo('api-key', 'missing-model', null);

		assert.strictEqual(getCachedAivisModelInfo('api-key', 'missing-model'), undefined);
	});

	test('clears dictionary and model caches together', () => {
		setCachedAivisDictionaryList('api-key', [DICTIONARY_A]);
		setCachedAivisModelInfo('api-key', 'model-a', model('model-a', 'Model A'));

		clearAivisApiCaches();

		assert.strictEqual(getCachedAivisDictionaryList('api-key'), undefined);
		assert.strictEqual(getCachedAivisModelInfo('api-key', 'model-a'), undefined);
	});

	test('single-flights and reuses a resolved usage bundle for one exact key and range', async () => {
		const cache = new ParadisAivisUsageRequestCache();
		const deferred = new DeferredPromise<IParadisAivisUsageBundle>();
		let factoryCalls = 0;
		const factory = () => {
			factoryCalls++;
			return deferred.p;
		};

		const first = cache.getOrCreate('key', '2026-08-01', '2026-08-07', factory);
		const joined = cache.getOrCreate('key', '2026-08-01', '2026-08-07', factory);
		assert.deepStrictEqual({ samePromise: first === joined, factoryCalls }, { samePromise: true, factoryCalls: 1 });

		deferred.complete(EMPTY_BUNDLE);
		assert.strictEqual(await first, EMPTY_BUNDLE);
		const resolved = cache.getOrCreate('key', '2026-08-01', '2026-08-07', factory);
		assert.deepStrictEqual({ samePromise: first === resolved, factoryCalls }, { samePromise: true, factoryCalls: 1 });
	});

	test('keeps API keys, range starts, and range ends as independent cache-key fields', async () => {
		const cache = new ParadisAivisUsageRequestCache();
		let factoryCalls = 0;
		const read = (apiKey: string, start: string, end: string) => cache.getOrCreate(apiKey, start, end, () => {
			factoryCalls++;
			return Promise.resolve(EMPTY_BUNDLE);
		});

		const exact = read('key-a', '2026-08-01', '2026-08-07');
		const otherKey = read('key-b', '2026-08-01', '2026-08-07');
		const otherStart = read('key-a', '2026-08-02', '2026-08-07');
		const otherEnd = read('key-a', '2026-08-01', '2026-08-08');
		await Promise.all([exact, otherKey, otherStart, otherEnd]);

		assert.deepStrictEqual({
			factoryCalls,
			independent: new Set([exact, otherKey, otherStart, otherEnd]).size,
		}, { factoryCalls: 4, independent: 4 });
	});

	test('removes a rejected usage request so the exact key and range can retry', async () => {
		const cache = new ParadisAivisUsageRequestCache();
		let factoryCalls = 0;
		const rejected = cache.getOrCreate('key', '2026-08-01', '2026-08-07', () => {
			factoryCalls++;
			return Promise.reject(new Error('expected request failure'));
		});

		await assert.rejects(rejected, /expected request failure/);
		const retried = cache.getOrCreate('key', '2026-08-01', '2026-08-07', () => {
			factoryCalls++;
			return Promise.resolve(EMPTY_BUNDLE);
		});

		assert.deepStrictEqual({ result: await retried, factoryCalls }, { result: EMPTY_BUNDLE, factoryCalls: 2 });
	});

	test('clear starts a fresh request without letting an older rejection remove it', async () => {
		const cache = new ParadisAivisUsageRequestCache();
		const oldRequest = new DeferredPromise<IParadisAivisUsageBundle>();
		const freshRequest = new DeferredPromise<IParadisAivisUsageBundle>();
		const oldRead = cache.getOrCreate('key', '2026-08-01', '2026-08-07', () => oldRequest.p);

		cache.clear();
		const freshRead = cache.getOrCreate('key', '2026-08-01', '2026-08-07', () => freshRequest.p);
		oldRequest.error(new Error('superseded request failure'));
		await assert.rejects(oldRead, /superseded request failure/);
		const joinedFreshRead = cache.getOrCreate('key', '2026-08-01', '2026-08-07', () => Promise.resolve(EMPTY_BUNDLE));

		assert.strictEqual(joinedFreshRead, freshRead);
		freshRequest.complete(EMPTY_BUNDLE);
		assert.strictEqual(await joinedFreshRead, EMPTY_BUNDLE);
	});

	test('accepts only the latest render generation', () => {
		const generations = new ParadisAivisRenderGeneration();
		const oldRender = generations.begin();
		const currentRender = generations.begin();

		assert.deepStrictEqual({
			old: generations.isCurrent(oldRender),
			current: generations.isCurrent(currentRender),
		}, { old: false, current: true });
	});

	test('wires the actual usage section to reuse requests until key or period changes', async () => {
		const settings = store.add(new TestSettingsService());
		const channel = new AivisUsageChannel();
		const container = createContainer('Aivis usage request reuse');
		const section = store.add(new ParadisAivisUsageSection(container, createSharedProcessService(channel), settings));
		await flushMicrotasks();

		settings.fireAivisChange({ volume: 75 });
		await flushMicrotasks();
		const metricButton = Array.from(container.querySelectorAll('button')).find(button => button.textContent === 'Chars');
		assert.ok(metricButton);
		dispatchClick(metricButton);
		settings.fireAivisChange({ apiKey: 'test-key-b' });
		await flushMicrotasks();
		const sevenDayButton = Array.from(container.querySelectorAll('button')).find(button => button.textContent === '7日');
		assert.ok(sevenDayButton);
		dispatchClick(sevenDayButton);
		await flushMicrotasks();
		section.dispose();
		store.add(new ParadisAivisUsageSection(createContainer('Aivis usage reopened'), createSharedProcessService(channel), settings));
		await flushMicrotasks();

		assert.deepStrictEqual(channel.commands, [
			'getAivisUsageDaily', 'getAivisMe',
			'getAivisUsageDaily', 'getAivisMe',
			'getAivisUsageDaily', 'getAivisMe',
			'getAivisUsageDaily', 'getAivisMe',
		]);
	});

	test('does not let a stale success handler write to its detached usage body', async () => {
		const settings = store.add(new TestSettingsService());
		const channel = new AivisUsageChannel();
		const usage = new DeferredPromise<IParadisAivisUsageResult>();
		channel.usageResult = usage.p;
		const container = createContainer('Aivis stale success');
		store.add(new ParadisAivisUsageSection(container, createSharedProcessService(channel), settings));
		const detachedBody = container.lastElementChild as HTMLElement;

		settings.fireAivisChange({ speakingRate: 1.25 });
		const currentBody = container.lastElementChild as HTMLElement;
		usage.complete(EMPTY_USAGE);
		await flushMicrotasks();

		assert.deepStrictEqual({
			oldBodyWasRemoved: detachedBody.parentElement === null,
			detachedText: detachedBody.textContent,
			currentBodyIsAttached: currentBody.parentElement === container,
			currentHasStats: currentBody.querySelectorAll('.pns-stat-card').length,
		}, { oldBodyWasRemoved: true, detachedText: '読み込み中…', currentBodyIsAttached: true, currentHasStats: 3 });
	});

	test('does not let a stale rejection handler write to its detached usage body', async () => {
		const settings = store.add(new TestSettingsService());
		const channel = new AivisUsageChannel();
		const usage = new DeferredPromise<IParadisAivisUsageResult>();
		channel.usageResult = usage.p;
		const container = createContainer('Aivis stale rejection');
		store.add(new ParadisAivisUsageSection(container, createSharedProcessService(channel), settings));
		const detachedBody = container.lastElementChild as HTMLElement;

		settings.fireAivisChange({ format: 'updated' });
		const currentBody = container.lastElementChild as HTMLElement;
		usage.error(new Error('expected usage failure'));
		await flushMicrotasks();

		assert.deepStrictEqual({
			detachedText: detachedBody.textContent,
			currentErrorCount: currentBody.querySelectorAll('.pns-error').length,
		}, { detachedText: '読み込み中…', currentErrorCount: 1 });
	});
});
