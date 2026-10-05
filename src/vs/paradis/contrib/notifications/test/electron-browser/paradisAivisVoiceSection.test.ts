/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-PATCH/PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import assert from 'assert';
import { mainWindow } from '../../../../../base/browser/window.js';
import { DeferredPromise } from '../../../../../base/common/async.js';
import { Emitter, Event } from '../../../../../base/common/event.js';
import { Disposable } from '../../../../../base/common/lifecycle.js';
import { IChannel } from '../../../../../base/parts/ipc/common/ipc.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { IInstantiationService } from '../../../../../platform/instantiation/common/instantiation.js';
import { ISharedProcessService } from '../../../../../platform/ipc/electron-browser/services.js';
import { ILogService, NullLogService } from '../../../../../platform/log/common/log.js';
import {
	IParadisAivisSettings,
	IParadisDoNotDisturbChangeEvent,
	IParadisDoNotDisturbState,
	IParadisNotificationsSettingsService,
	ParadisApiKeyField,
	ParadisNotificationsChangeScope,
} from '../../browser/paradisNotificationsSettings.js';
import { IParadisAivisModelPreset } from '../../common/paradisNotifications.js';
import { clearAivisApiCaches } from '../../electron-browser/paradisAivisApiCache.js';
import { ParadisAivisVoiceSection } from '../../electron-browser/paradisAivisVoiceSection.js';
import { clearElevenLabsApiCaches } from '../../electron-browser/paradisElevenLabsApiCache.js';
import { paradisClearVoiceTuningCaches } from '../../electron-browser/paradisVoiceGainsCache.js';

class TestSettingsService extends Disposable implements IParadisNotificationsSettingsService {
	declare readonly _serviceBrand: undefined;

	private readonly changeEmitter = this._register(new Emitter<ParadisNotificationsChangeScope>());
	readonly onDidChange: Event<ParadisNotificationsChangeScope> = this.changeEmitter.event;
	readonly onDidChangeDoNotDisturb: Event<IParadisDoNotDisturbChangeEvent> = Event.None;
	readonly patches: Partial<IParadisAivisSettings>[] = [];
	loaded = true;
	readonly loading = new DeferredPromise<void>();

	settings: IParadisAivisSettings = {
		enabled: true,
		apiKey: 'aivis_saved',
		modelUuid: '',
		userDictionaryUuid: '',
		format: '',
		formatPermission: '',
		volume: 100,
		speakingRate: 1,
		engine: 'aivis',
		elevenLabsApiKey: 'el_saved',
		elevenLabsVoiceId: '',
		elevenLabsModelId: 'eleven_flash_v2_5',
		elevenLabsSpeed: 1,
		elevenLabsDictionaryId: '',
		shareDictionaryWithAgents: true,
		elevenLabsVoiceSettings: {},
	};

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
	getAivisSettings(): IParadisAivisSettings { return this.settings; }
	setAivisSettings(patch: Partial<IParadisAivisSettings>): void {
		this.patches.push(patch);
		this.settings = { ...this.settings, ...patch };
		this.changeEmitter.fire('aivis');
	}
	whenApiKeysLoaded(): Promise<void> { return this.loaded ? Promise.resolve() : this.loading.p; }
	areApiKeysLoaded(): boolean { return this.loaded; }
	isApiKeyLost(_field: ParadisApiKeyField): boolean { return false; }
	getCustomAivisModelPresets(): readonly IParadisAivisModelPreset[] { return []; }
	addCustomAivisModelPreset(_preset: IParadisAivisModelPreset): void { }
	removeCustomAivisModelPreset(_uuid: string): void { }
}

/** API はどれも空の結果を返す（声・モデル・辞書の一覧、モデル情報）。 */
class EmptyChannel implements IChannel {
	call<T>(command: string): Promise<T> {
		return Promise.resolve((command.startsWith('list') ? [] : null) as T);
	}

	listen<T>(): Event<T> {
		return Event.None;
	}
}

function dispatch(element: Element, type: string): void {
	const event = element.ownerDocument.createEvent('Event');
	event.initEvent(type, true, true);
	element.dispatchEvent(event);
}

async function flush(): Promise<void> {
	for (let index = 0; index < 6; index++) {
		await Promise.resolve();
	}
}

suite('Paradis voice section API key fields', () => {
	const store = ensureNoDisposablesAreLeakedInTestSuite();

	setup(() => { clearAivisApiCaches(); clearElevenLabsApiCaches(); paradisClearVoiceTuningCaches(); });
	teardown(() => { clearAivisApiCaches(); clearElevenLabsApiCaches(); paradisClearVoiceTuningCaches(); });

	function createSection(settings: TestSettingsService, channel: IChannel = new EmptyChannel()): HTMLElement {
		const document = mainWindow.document.implementation.createHTMLDocument('voice section');
		// 非同期に届いた値は、画面に付いている要素にだけ反映する（isConnected）
		const container = document.body.appendChild(document.createElement('div'));
		const sharedProcess = { getChannel: () => channel } as unknown as ISharedProcessService;
		const logService: ILogService = new NullLogService();
		const instantiation = {
			createInstance: (ctor: new (...args: unknown[]) => unknown, ...args: unknown[]) => new ctor(...args, sharedProcess, settings, logService),
		} as unknown as IInstantiationService;
		store.add(new ParadisAivisVoiceSection(container, sharedProcess, settings, logService, instantiation));
		return container;
	}

	function keyInput(container: HTMLElement): HTMLInputElement {
		const input = container.getElementsByTagName('input');
		const found = Array.from(input).find(candidate => candidate.type === 'password');
		assert.ok(found);
		return found;
	}

	test('does not save the Aivis key when the field is left unchanged', async () => {
		const settings = store.add(new TestSettingsService());
		const container = createSection(settings);
		await flush();

		const input = keyInput(container);
		dispatch(input, 'blur');
		const afterUnchangedBlur = settings.patches.length;
		input.value = 'aivis_new';
		dispatch(input, 'blur');

		assert.deepStrictEqual({ afterUnchangedBlur, patches: settings.patches }, { afterUnchangedBlur: 0, patches: [{ apiKey: 'aivis_new' }] });
	});

	test('keeps both engines\' key fields disabled until the keys are loaded', async () => {
		const settings = store.add(new TestSettingsService());
		settings.loaded = false;
		const container = createSection(settings);
		const aivisWhileLoading = keyInput(container);
		dispatch(aivisWhileLoading, 'blur');
		settings.loaded = true;
		settings.loading.complete();
		await flush();
		const aivisAfterLoad = keyInput(container).disabled;

		const elevenLabsSettings = store.add(new TestSettingsService());
		elevenLabsSettings.loaded = false;
		elevenLabsSettings.settings = { ...elevenLabsSettings.settings, engine: 'elevenlabs' };
		const elevenLabsContainer = createSection(elevenLabsSettings);
		const elevenLabsWhileLoading = keyInput(elevenLabsContainer);
		dispatch(elevenLabsWhileLoading, 'blur');
		elevenLabsSettings.loaded = true;
		elevenLabsSettings.loading.complete();
		await flush();

		assert.deepStrictEqual({
			aivisWhileLoading: aivisWhileLoading.disabled,
			aivisAfterLoad,
			elevenLabsWhileLoading: elevenLabsWhileLoading.disabled,
			elevenLabsAfterLoad: keyInput(elevenLabsContainer).disabled,
			patches: [settings.patches, elevenLabsSettings.patches],
		}, { aivisWhileLoading: true, aivisAfterLoad: false, elevenLabsWhileLoading: true, elevenLabsAfterLoad: false, patches: [[], []] });
	});

	test('shows the tuning of the chosen ElevenLabs voice and saves it per voice', async () => {
		const channel: IChannel = {
			call<T>(command: string): Promise<T> {
				switch (command) {
					case 'getElevenLabsVoiceSettings': return Promise.resolve({ stability: 0.4, similarityBoost: 0.9 } as T);
					case 'list': return Promise.resolve({ status: 'ok', value: { target: -20, learnWindow: 9, minLearnSeconds: 2.5, entries: [{ key: 'elevenlabs:voice1:eleven_v4_turbo', provider: 'elevenlabs', voice: 'voice1', model: 'eleven_v4_turbo', gainDb: -6.8, sampleCount: 4, updatedAt: 1 }] } } as T);
				}
				return Promise.resolve((command.startsWith('list') ? [] : null) as T);
			},
			listen<T>(): Event<T> { return Event.None; },
		};
		const settings = store.add(new TestSettingsService());
		settings.settings = { ...settings.settings, engine: 'elevenlabs', elevenLabsVoiceId: 'voice1', elevenLabsModelId: 'eleven_v4_turbo' };
		const container = createSection(settings, channel);
		for (let round = 0; round < 5; round++) {
			await flush();
		}

		const sliders = Array.from(container.querySelectorAll<HTMLInputElement>('.pns-tune-slider input'));
		const shown = () => ({
			title: container.querySelector('.pns-tune-title')?.textContent,
			speedDimmed: container.querySelectorAll('.setting-row.pns-row-dimmed').length,
			sliders: sliders.map(slider => slider.value),
			pills: Array.from(container.querySelectorAll('.pns-pill')).map(pill => pill.textContent),
		});
		const before = shown();
		sliders[1].value = '0.55';
		dispatch(sliders[1], 'change');

		assert.deepStrictEqual({ before, patches: settings.patches }, {
			before: {
				title: 'voice1 の調整',
				speedDimmed: 1,
				sliders: ['0.4', '0.9'],
				pills: ['-6.8 dB', '学習 4/9 回'],
			},
			patches: [{ elevenLabsVoiceSettings: { voice1: { stability: 0.4, similarityBoost: 0.55 } } }],
		});
	});
});
