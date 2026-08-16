/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-PATCH/PARA-CODE comments)

import assert from 'assert';
import { mainWindow } from '../../../../../base/browser/window.js';
import { Emitter, Event } from '../../../../../base/common/event.js';
import { Disposable, DisposableStore, IDisposable } from '../../../../../base/common/lifecycle.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { IInstantiationService } from '../../../../../platform/instantiation/common/instantiation.js';
import { IAuxiliaryStatusbarPart, IStatusbarEntryContainer } from '../../../../../workbench/browser/parts/statusbar/statusbarPart.js';
import {
	IStatusbarEntry,
	IStatusbarEntryAccessor,
	IStatusbarEntryLocation,
	IStatusbarEntryPriority,
	IStatusbarService,
	IStatusbarStyleOverride,
	StatusbarAlignment,
} from '../../../../../workbench/services/statusbar/browser/statusbar.js';
import {
	IParadisAivisSettings,
	IParadisDoNotDisturbChangeEvent,
	IParadisDoNotDisturbState,
	IParadisNotificationsSettingsService,
	ParadisNotificationsChangeScope,
} from '../../browser/paradisNotificationsSettings.js';
import {
	IParadisDoNotDisturbRefreshTimer,
	PARADIS_DO_NOT_DISTURB_DURATIONS,
	ParadisDoNotDisturbRefreshControllerFactory,
	paradisCreateDoNotDisturbRefreshController,
} from '../../common/paradisDoNotDisturb.js';
import { ParadisDoNotDisturbSection } from '../../electron-browser/paradisDoNotDisturbSection.js';
import { ParadisDoNotDisturbStatusBarContribution } from '../../electron-browser/paradisDoNotDisturbStatusBar.contribution.js';
import { IParadisAivisModelPreset } from '../../common/paradisNotifications.js';

interface IManualTimerRecord {
	readonly callbackId: number;
	readonly callback: () => void;
	readonly delayMs: number;
	readonly dueAt: number;
	readonly returnedHandle: object;
	pending: boolean;
}

class ManualTimer implements IParadisDoNotDisturbRefreshTimer {
	private nextCallbackId = 1;
	private readonly records: IManualTimerRecord[] = [];
	readonly clearArguments: unknown[] = [];
	setCount = 0;
	fireCount = 0;
	maxPendingCount = 0;

	constructor(
		private readonly readClock: () => number,
		private readonly writeClock: (value: number) => void,
	) { }

	get pendingCount(): number {
		return this.records.filter(record => record.pending).length;
	}

	get capturedCallbackIds(): readonly number[] {
		return this.records.map(record => record.callbackId);
	}

	pendingDelays(): readonly number[] {
		return this.records.filter(record => record.pending).map(record => record.delayMs).sort((a, b) => a - b);
	}

	set(callback: () => void, delayMs: number): unknown {
		const record: IManualTimerRecord = {
			callbackId: this.nextCallbackId++,
			callback,
			delayMs,
			dueAt: this.readClock() + delayMs,
			returnedHandle: {},
			pending: true,
		};
		this.records.push(record);
		this.setCount++;
		this.maxPendingCount = Math.max(this.maxPendingCount, this.pendingCount);
		return record.returnedHandle;
	}

	clear(handle: unknown): void {
		this.clearArguments.push(handle);
		const record = this.records.find(candidate => candidate.pending && candidate.returnedHandle === handle);
		if (record) {
			record.pending = false;
		}
	}

	fire(callbackId: number): void {
		const record = this.records.find(candidate => candidate.callbackId === callbackId);
		if (!record?.pending) {
			throw new Error(`Manual timer callback ${callbackId} is not pending`);
		}
		record.pending = false;
		this.fireCount++;
		record.callback();
	}

	fireCaptured(callbackId: number): void {
		const record = this.records.find(candidate => candidate.callbackId === callbackId);
		if (!record) {
			throw new Error(`Manual timer callback ${callbackId} was not captured`);
		}
		record.callback();
	}

	advanceBy(durationMs: number): void {
		const target = this.readClock() + durationMs;
		while (true) {
			const next = this.records
				.filter(record => record.pending && record.dueAt <= target)
				.sort((a, b) => a.dueAt - b.dueAt || a.callbackId - b.callbackId)[0];
			if (!next) {
				break;
			}
			this.writeClock(Math.max(this.readClock(), next.dueAt));
			this.fire(next.callbackId);
		}
		this.writeClock(target);
	}
}

class TestSettingsService extends Disposable implements IParadisNotificationsSettingsService {
	declare readonly _serviceBrand: undefined;

	private readonly genericEmitter = this._register(new Emitter<ParadisNotificationsChangeScope>());
	readonly onDidChange: Event<ParadisNotificationsChangeScope> = this.genericEmitter.event;
	private readonly dndEmitter = this._register(new Emitter<IParadisDoNotDisturbChangeEvent>());
	readonly onDidChangeDoNotDisturb: Event<IParadisDoNotDisturbChangeEvent> = this.dndEmitter.event;

	state: IParadisDoNotDisturbState;
	getDoNotDisturbReadCount = 0;
	readonly setDoNotDisturbCalls: { readonly enabled: boolean; readonly until: number | undefined }[] = [];

	constructor(initialState: IParadisDoNotDisturbState, private readonly now: () => number) {
		super();
		this.state = initialState;
	}

	getDoNotDisturb(): IParadisDoNotDisturbState {
		this.getDoNotDisturbReadCount++;
		if (this.state.enabled && this.state.until !== undefined && this.state.until <= this.now()) {
			this.state = { enabled: false, until: undefined };
		}
		return this.state;
	}

	setState(state: IParadisDoNotDisturbState): void {
		this.state = state;
	}

	fireDedicated(external: boolean): void {
		this.dndEmitter.fire({ external });
	}

	fireGenericDnd(): void {
		this.genericEmitter.fire('dnd');
	}

	setDoNotDisturb(enabled: boolean, until: number | undefined): void {
		this.setDoNotDisturbCalls.push({ enabled, until });
		this.state = { enabled, until: enabled ? until : undefined };
		this.genericEmitter.fire('dnd');
		this.dndEmitter.fire({ external: false });
	}

	getSelectedRingtoneId(): string { return 'default'; }
	setSelectedRingtoneId(_id: string): void { this.genericEmitter.fire('notifications'); }
	getSoundsMuted(): boolean { return false; }
	setSoundsMuted(_muted: boolean): void { this.genericEmitter.fire('notifications'); }
	getVolume(): number { return 100; }
	setVolume(_volume: number): void { this.genericEmitter.fire('notifications'); }
	getOsNotificationsEnabled(): boolean { return true; }
	setOsNotificationsEnabled(_enabled: boolean): void { this.genericEmitter.fire('notifications'); }
	getOsNotifyOnPermission(): boolean { return true; }
	setOsNotifyOnPermission(_enabled: boolean): void { this.genericEmitter.fire('notifications'); }
	getOsNotifyOnReview(): boolean { return true; }
	setOsNotifyOnReview(_enabled: boolean): void { this.genericEmitter.fire('notifications'); }
	getNotifyWhileFocused(): boolean { return false; }
	setNotifyWhileFocused(_enabled: boolean): void { this.genericEmitter.fire('notifications'); }
	getAivisSettings(): IParadisAivisSettings {
		return { enabled: false, apiKey: '', modelUuid: '', userDictionaryUuid: '', format: '', formatPermission: '', volume: 100, speakingRate: 1 };
	}
	setAivisSettings(_patch: Partial<IParadisAivisSettings>): void { this.genericEmitter.fire('aivis'); }
	getCustomAivisModelPresets(): readonly IParadisAivisModelPreset[] { return []; }
	addCustomAivisModelPreset(_preset: IParadisAivisModelPreset): void { this.genericEmitter.fire('aivis'); }
	removeCustomAivisModelPreset(_uuid: string): void { this.genericEmitter.fire('aivis'); }
}

interface IStatusAddSnapshot {
	readonly properties: IStatusbarEntry;
	readonly id: string;
	readonly alignment: StatusbarAlignment;
	readonly priority: number | IStatusbarEntryPriority | IStatusbarEntryLocation;
}

class TestStatusbarService extends Disposable implements IStatusbarService {
	declare readonly _serviceBrand: undefined;
	readonly onDidChangeEntryVisibility = Event.None;
	readonly adds: IStatusAddSnapshot[] = [];
	readonly updates: IStatusbarEntry[] = [];
	accessorDisposeCount = 0;

	addEntry(
		properties: IStatusbarEntry,
		id: string,
		alignment: StatusbarAlignment,
		priority: number | IStatusbarEntryPriority | IStatusbarEntryLocation = 0,
	): IStatusbarEntryAccessor {
		this.adds.push({ properties, id, alignment, priority });
		let disposed = false;
		return {
			update: next => this.updates.push(next),
			dispose: () => {
				if (!disposed) {
					disposed = true;
					this.accessorDisposeCount++;
				}
			},
		};
	}

	getPart(_container: HTMLElement): IStatusbarEntryContainer { return this; }
	createAuxiliaryStatusbarPart(_container: HTMLElement, _instantiationService: IInstantiationService): IAuxiliaryStatusbarPart { throw new Error('Not used by this test'); }
	createScoped(_statusbarEntryContainer: IStatusbarEntryContainer, _disposables: DisposableStore): IStatusbarService { return this; }
	isEntryVisible(_id: string): boolean { return true; }
	updateEntryVisibility(_id: string, _visible: boolean): void { }
	overrideEntry(_id: string, _override: Partial<IStatusbarEntry>): IDisposable { return Disposable.None; }
	focus(_preserveEntryFocus?: boolean): void { }
	focusNextEntry(): void { }
	focusPreviousEntry(): void { }
	isEntryFocused(): boolean { return false; }
	overrideStyle(_style: IStatusbarStyleOverride): IDisposable { return Disposable.None; }
}

interface INormalizedElement {
	readonly tag: string;
	readonly className: string;
	readonly text: string;
	readonly children: readonly INormalizedElement[];
	readonly type?: string;
	readonly checked?: boolean;
}

function normalizeElement(element: Element): INormalizedElement {
	const children = Array.from(element.children, normalizeElement);
	const normalized = {
		tag: element.tagName.toLowerCase(),
		className: element.className,
		text: children.length === 0 ? element.textContent ?? '' : '',
		children,
	};
	if (element.tagName === 'INPUT') {
		const input = element as HTMLInputElement;
		return { ...normalized, type: input.type, checked: input.checked };
	}
	return normalized;
}

function normalizeDndDom(container: HTMLElement): readonly INormalizedElement[] {
	return Array.from(container.children, normalizeElement);
}

function statusProperties(properties: IStatusbarEntry): IStatusbarEntry {
	return {
		name: properties.name,
		text: properties.text,
		ariaLabel: properties.ariaLabel,
		tooltip: properties.tooltip,
		command: properties.command,
	};
}

function createContainer(title: string): HTMLElement {
	const document = mainWindow.document.implementation.createHTMLDocument(title);
	return document.createElement('div');
}

suite('Paradis DND actual surfaces', () => {
	const store = ensureNoDisposablesAreLeakedInTestSuite();

	test('uses the protected static factory before each actual surface performs its first render', () => {
		let clock = 1_000;
		const manualTimer = new ManualTimer(() => clock, value => clock = value);
		class TestStatusContribution extends ParadisDoNotDisturbStatusBarContribution {
			protected static override readonly refreshControllerFactory: ParadisDoNotDisturbRefreshControllerFactory
				= refresh => paradisCreateDoNotDisturbRefreshController(refresh, { timer: manualTimer, now: () => clock });
		}
		class TestSection extends ParadisDoNotDisturbSection {
			protected static override readonly refreshControllerFactory: ParadisDoNotDisturbRefreshControllerFactory
				= refresh => paradisCreateDoNotDisturbRefreshController(refresh, { timer: manualTimer, now: () => clock });
		}

		const offSettings = store.add(new TestSettingsService({ enabled: false, until: undefined }, () => clock));
		const statusbar = store.add(new TestStatusbarService());
		const offStatus = store.add(new TestStatusContribution(statusbar, offSettings));
		const offContainer = createContainer('DND OFF');
		const offSection = store.add(new TestSection(offContainer, offSettings));
		assert.deepStrictEqual({
			statusAdds: statusbar.adds.length,
			settingsReads: offSettings.getDoNotDisturbReadCount,
			sectionChildren: offContainer.childElementCount,
			pending: manualTimer.pendingCount,
		}, { statusAdds: 1, settingsReads: 2, sectionChildren: 3, pending: 0 });

		offStatus.dispose();
		offSection.dispose();
		const timedSettings = store.add(new TestSettingsService({ enabled: true, until: clock + 90_000 }, () => clock));
		const timedStatusbar = store.add(new TestStatusbarService());
		store.add(new TestStatusContribution(timedStatusbar, timedSettings));
		store.add(new TestSection(createContainer('DND timed'), timedSettings));
		assert.deepStrictEqual({
			statusAdds: timedStatusbar.adds.length,
			settingsReads: timedSettings.getDoNotDisturbReadCount,
			pending: manualTimer.pendingCount,
			pendingDelays: manualTimer.pendingDelays(),
		}, { statusAdds: 1, settingsReads: 2, pending: 2, pendingDelays: [60_000, 60_000] });
	});

	test('keeps all status entry properties stable and refreshes only on the dedicated event', () => {
		let clock = 1_000;
		const manualTimer = new ManualTimer(() => clock, value => clock = value);
		class TestStatusContribution extends ParadisDoNotDisturbStatusBarContribution {
			protected static override readonly refreshControllerFactory: ParadisDoNotDisturbRefreshControllerFactory
				= refresh => paradisCreateDoNotDisturbRefreshController(refresh, { timer: manualTimer, now: () => clock });
		}

		const settings = store.add(new TestSettingsService({ enabled: false, until: undefined }, () => clock));
		const statusbar = store.add(new TestStatusbarService());
		store.add(new TestStatusContribution(statusbar, settings));
		settings.setState({ enabled: true, until: undefined });
		settings.fireDedicated(false);
		settings.fireGenericDnd();
		settings.setState({ enabled: true, until: 91_000 });
		settings.fireDedicated(true);

		assert.deepStrictEqual({
			add: {
				id: statusbar.adds[0].id,
				alignment: statusbar.adds[0].alignment,
				priority: statusbar.adds[0].priority,
				properties: statusProperties(statusbar.adds[0].properties),
			},
			updates: statusbar.updates.map(statusProperties),
			reads: settings.getDoNotDisturbReadCount,
		}, {
			add: {
				id: 'paradis.notifications.doNotDisturb',
				alignment: StatusbarAlignment.RIGHT,
				priority: -9992,
				properties: {
					name: 'おやすみモード',
					text: '$(bell) おやすみモード',
					ariaLabel: 'おやすみモード',
					tooltip: '通知はオンです。クリックしておやすみモードを開始します（このPCの音・デスクトップ通知・音声読み上げを一括で止めます。モバイルへのPush通知は対象外）。',
					command: 'paradis.notifications.selectDoNotDisturb',
				},
			},
			updates: [
				{
					name: 'おやすみモード',
					text: '$(bell-slash) おやすみ中',
					ariaLabel: 'おやすみ中',
					tooltip: 'おやすみモード中です（自分でオフにするまで）。このPCの音・デスクトップ通知・音声読み上げを止めています（モバイルへのPush通知は対象外）。クリックで変更・解除できます。',
					command: 'paradis.notifications.selectDoNotDisturb',
				},
				{
					name: 'おやすみモード',
					text: '$(bell-slash) おやすみ中（残り2分）',
					ariaLabel: 'おやすみ中（残り2分）',
					tooltip: 'おやすみモード中です（あと2分）。このPCの音・デスクトップ通知・音声読み上げを止めています（モバイルへのPush通知は対象外）。クリックで変更・解除できます。',
					command: 'paradis.notifications.selectDoNotDisturb',
				},
			],
			reads: 3,
		});
	});

	test('preserves section DOM, duration order, classes, and real Date.now click semantics', () => {
		let clock = 1_000;
		const manualTimer = new ManualTimer(() => clock, value => clock = value);
		class TestSection extends ParadisDoNotDisturbSection {
			protected static override readonly refreshControllerFactory: ParadisDoNotDisturbRefreshControllerFactory
				= refresh => paradisCreateDoNotDisturbRefreshController(refresh, { timer: manualTimer, now: () => clock });
		}

		const settings = store.add(new TestSettingsService({ enabled: false, until: undefined }, () => clock));
		const container = createContainer('DND section snapshots');
		store.add(new TestSection(container, settings));
		const off = normalizeDndDom(container);
		settings.setState({ enabled: true, until: undefined });
		settings.fireDedicated(false);
		const manual = normalizeDndDom(container);
		settings.setState({ enabled: true, until: 91_000 });
		settings.fireDedicated(false);
		const timed = normalizeDndDom(container);

		assert.deepStrictEqual({
			durations: PARADIS_DO_NOT_DISTURB_DURATIONS.map(({ id, label }) => ({ id, label })),
			off,
			manual,
			timed,
		}, {
			durations: [
				{ id: 'minutes30', label: '30分' },
				{ id: 'hours1', label: '1時間' },
				{ id: 'morning', label: '朝まで（7:00）' },
				{ id: 'manual', label: '自分でオフにするまで' },
			],
			off: [
				{ tag: 'div', className: 'pns-section-title', text: 'おやすみモード', children: [] },
				{ tag: 'div', className: 'pns-section-desc', text: 'オンの間はこのPCの通知音・デスクトップ通知・音声読み上げをすべて止めます（作業自体は止まりません）。', children: [] },
				{
					tag: 'div', className: 'pns-row', text: '', children: [
						{
							tag: 'div', className: '', text: '', children: [
								{ tag: 'div', className: 'pns-row-label', text: 'おやすみモード', children: [] },
								{ tag: 'div', className: 'pns-row-hint', text: 'このPCでの通知をすべて止めます。モバイルアプリへのPush通知は対象外です。', children: [] },
							],
						},
						{ tag: 'input', className: 'pns-toggle', text: '', children: [], type: 'checkbox', checked: false },
					],
				},
			],
			manual: [
				{ tag: 'div', className: 'pns-section-title', text: 'おやすみモード', children: [] },
				{ tag: 'div', className: 'pns-section-desc', text: 'オンの間はこのPCの通知音・デスクトップ通知・音声読み上げをすべて止めます（作業自体は止まりません）。', children: [] },
				{
					tag: 'div', className: 'pns-row', text: '', children: [
						{
							tag: 'div', className: '', text: '', children: [
								{ tag: 'div', className: 'pns-row-label', text: 'おやすみモード', children: [] },
								{ tag: 'div', className: 'pns-row-hint', text: 'このPCでの通知をすべて止めます。モバイルアプリへのPush通知は対象外です。', children: [] },
							],
						},
						{ tag: 'input', className: 'pns-toggle', text: '', children: [], type: 'checkbox', checked: true },
					],
				},
				{
					tag: 'div', className: 'pns-field', text: '', children: [
						{ tag: 'label', className: 'pns-label', text: '解除するタイミング', children: [] },
						{
							tag: 'div', className: 'pns-chip-row', text: '', children: [
								{ tag: 'button', className: 'pns-btn', text: '30分', children: [] },
								{ tag: 'button', className: 'pns-btn', text: '1時間', children: [] },
								{ tag: 'button', className: 'pns-btn', text: '朝まで（7:00）', children: [] },
								{ tag: 'button', className: 'pns-btn pns-btn-primary', text: '自分でオフにするまで', children: [] },
							],
						},
						{ tag: 'div', className: 'pns-row-hint', text: '自分でオフにするまで止め続けます。', children: [] },
					],
				},
			],
			timed: [
				{ tag: 'div', className: 'pns-section-title', text: 'おやすみモード', children: [] },
				{ tag: 'div', className: 'pns-section-desc', text: 'オンの間はこのPCの通知音・デスクトップ通知・音声読み上げをすべて止めます（作業自体は止まりません）。', children: [] },
				{
					tag: 'div', className: 'pns-row', text: '', children: [
						{
							tag: 'div', className: '', text: '', children: [
								{ tag: 'div', className: 'pns-row-label', text: 'おやすみモード', children: [] },
								{ tag: 'div', className: 'pns-row-hint', text: 'このPCでの通知をすべて止めます。モバイルアプリへのPush通知は対象外です。', children: [] },
							],
						},
						{ tag: 'input', className: 'pns-toggle', text: '', children: [], type: 'checkbox', checked: true },
					],
				},
				{
					tag: 'div', className: 'pns-field', text: '', children: [
						{ tag: 'label', className: 'pns-label', text: '解除するタイミング', children: [] },
						{
							tag: 'div', className: 'pns-chip-row', text: '', children: [
								{ tag: 'button', className: 'pns-btn', text: '30分', children: [] },
								{ tag: 'button', className: 'pns-btn', text: '1時間', children: [] },
								{ tag: 'button', className: 'pns-btn', text: '朝まで（7:00）', children: [] },
								{ tag: 'button', className: 'pns-btn', text: '自分でオフにするまで', children: [] },
							],
						},
						{ tag: 'div', className: 'pns-row-hint', text: 'あと2分で自動的に解除されます。', children: [] },
					],
				},
			],
		});

		const beforeClick = Date.now();
		(container.querySelectorAll('button')[0] as HTMLButtonElement).click();
		const afterClick = Date.now();
		const timedCall = settings.setDoNotDisturbCalls[0];
		assert.strictEqual(timedCall.enabled, true);
		assert.ok(timedCall.until !== undefined);
		assert.ok(beforeClick + 30 * 60_000 <= timedCall.until);
		assert.ok(timedCall.until <= afterClick + 30 * 60_000);

		settings.setState({ enabled: true, until: undefined });
		settings.fireDedicated(false);
		(container.querySelectorAll('button')[3] as HTMLButtonElement).click();
		const toggle = container.querySelector('input.pns-toggle') as HTMLInputElement;
		toggle.checked = false;
		const changeEvent = toggle.ownerDocument.createEvent('Event');
		changeEvent.initEvent('change', true, true);
		toggle.dispatchEvent(changeEvent);
		assert.deepStrictEqual(settings.setDoNotDisturbCalls.slice(1), [
			{ enabled: true, until: undefined },
			{ enabled: false, until: undefined },
		]);
	});

	test('keeps OFF and manual surfaces unchanged for ten minutes with no host timer', () => {
		for (const state of [
			{ enabled: false, until: undefined },
			{ enabled: true, until: undefined },
		] as const) {
			let clock = 1_000;
			const manualTimer = new ManualTimer(() => clock, value => clock = value);
			class TestStatusContribution extends ParadisDoNotDisturbStatusBarContribution {
				protected static override readonly refreshControllerFactory: ParadisDoNotDisturbRefreshControllerFactory
					= refresh => paradisCreateDoNotDisturbRefreshController(refresh, { timer: manualTimer, now: () => clock });
			}
			class TestSection extends ParadisDoNotDisturbSection {
				protected static override readonly refreshControllerFactory: ParadisDoNotDisturbRefreshControllerFactory
					= refresh => paradisCreateDoNotDisturbRefreshController(refresh, { timer: manualTimer, now: () => clock });
			}

			const settings = store.add(new TestSettingsService(state, () => clock));
			const statusbar = store.add(new TestStatusbarService());
			store.add(new TestStatusContribution(statusbar, settings));
			const container = createContainer('DND idle');
			store.add(new TestSection(container, settings));
			const toggle = container.querySelector('input.pns-toggle');
			const initialReads = settings.getDoNotDisturbReadCount;
			manualTimer.advanceBy(600_000);

			assert.deepStrictEqual({
				pending: manualTimer.pendingCount,
				fires: manualTimer.fireCount,
				statusUpdates: statusbar.updates.length,
				readDelta: settings.getDoNotDisturbReadCount - initialReads,
				toggleIdentitySame: container.querySelector('input.pns-toggle') === toggle,
			}, { pending: 0, fires: 0, statusUpdates: 0, readDelta: 0, toggleIdentitySame: true });
		}
	});

	test('refreshes at sixty seconds and the ninety-second deadline, then stays OFF', () => {
		let clock = 1_000;
		const manualTimer = new ManualTimer(() => clock, value => clock = value);
		class TestStatusContribution extends ParadisDoNotDisturbStatusBarContribution {
			protected static override readonly refreshControllerFactory: ParadisDoNotDisturbRefreshControllerFactory
				= refresh => paradisCreateDoNotDisturbRefreshController(refresh, { timer: manualTimer, now: () => clock });
		}
		class TestSection extends ParadisDoNotDisturbSection {
			protected static override readonly refreshControllerFactory: ParadisDoNotDisturbRefreshControllerFactory
				= refresh => paradisCreateDoNotDisturbRefreshController(refresh, { timer: manualTimer, now: () => clock });
		}

		const settings = store.add(new TestSettingsService({ enabled: true, until: 91_000 }, () => clock));
		const statusbar = store.add(new TestStatusbarService());
		store.add(new TestStatusContribution(statusbar, settings));
		const container = createContainer('DND deadline');
		store.add(new TestSection(container, settings));
		const timeline: object[] = [];
		const capture = (at: number) => timeline.push({
			at,
			pending: manualTimer.pendingCount,
			pendingDelays: manualTimer.pendingDelays(),
			reads: settings.getDoNotDisturbReadCount,
			statusUpdates: statusbar.updates.length,
			status: statusProperties(statusbar.updates.at(-1) ?? statusbar.adds[0].properties),
			section: normalizeDndDom(container),
		});

		capture(0);
		manualTimer.advanceBy(60_000);
		capture(60_000);
		manualTimer.advanceBy(30_000);
		capture(90_000);
		manualTimer.advanceBy(600_000);
		capture(690_000);

		assert.deepStrictEqual(timeline.map(entry => {
			const snapshot = entry as { at: number; pending: number; pendingDelays: readonly number[]; reads: number; statusUpdates: number; status: IStatusbarEntry; section: readonly INormalizedElement[] };
			return {
				at: snapshot.at,
				pending: snapshot.pending,
				pendingDelays: snapshot.pendingDelays,
				reads: snapshot.reads,
				statusUpdates: snapshot.statusUpdates,
				statusText: snapshot.status.text,
				sectionToggleChecked: snapshot.section[2].children[1].checked,
				sectionChildren: snapshot.section.length,
			};
		}), [
			{ at: 0, pending: 2, pendingDelays: [60_000, 60_000], reads: 2, statusUpdates: 0, statusText: '$(bell-slash) おやすみ中（残り2分）', sectionToggleChecked: true, sectionChildren: 4 },
			{ at: 60_000, pending: 2, pendingDelays: [30_000, 30_000], reads: 4, statusUpdates: 1, statusText: '$(bell-slash) おやすみ中（残り1分）', sectionToggleChecked: true, sectionChildren: 4 },
			{ at: 90_000, pending: 0, pendingDelays: [], reads: 6, statusUpdates: 2, statusText: '$(bell) おやすみモード', sectionToggleChecked: false, sectionChildren: 3 },
			{ at: 690_000, pending: 0, pendingDelays: [], reads: 6, statusUpdates: 2, statusText: '$(bell) おやすみモード', sectionToggleChecked: false, sectionChildren: 3 },
		]);
		assert.deepStrictEqual({ fireCount: manualTimer.fireCount, maxPendingCount: manualTimer.maxPendingCount }, { fireCount: 4, maxPendingCount: 2 });
	});

	test('rearms changed deadlines and ignores captured callbacks from the old generation', () => {
		let clock = 1_000;
		const manualTimer = new ManualTimer(() => clock, value => clock = value);
		class TestStatusContribution extends ParadisDoNotDisturbStatusBarContribution {
			protected static override readonly refreshControllerFactory: ParadisDoNotDisturbRefreshControllerFactory
				= refresh => paradisCreateDoNotDisturbRefreshController(refresh, { timer: manualTimer, now: () => clock });
		}
		class TestSection extends ParadisDoNotDisturbSection {
			protected static override readonly refreshControllerFactory: ParadisDoNotDisturbRefreshControllerFactory
				= refresh => paradisCreateDoNotDisturbRefreshController(refresh, { timer: manualTimer, now: () => clock });
		}

		const settings = store.add(new TestSettingsService({ enabled: true, until: 91_000 }, () => clock));
		const statusbar = store.add(new TestStatusbarService());
		store.add(new TestStatusContribution(statusbar, settings));
		const container = createContainer('DND rearm');
		store.add(new TestSection(container, settings));
		const oldCallbackIds = [...manualTimer.capturedCallbackIds];
		settings.setState({ enabled: true, until: 31_000 });
		settings.fireDedicated(true);
		const afterRearm = {
			pending: manualTimer.pendingCount,
			pendingDelays: manualTimer.pendingDelays(),
			reads: settings.getDoNotDisturbReadCount,
			updates: statusbar.updates.length,
			setCount: manualTimer.setCount,
		};
		for (const callbackId of oldCallbackIds) {
			manualTimer.fireCaptured(callbackId);
		}
		const afterOldCallbacks = {
			pending: manualTimer.pendingCount,
			reads: settings.getDoNotDisturbReadCount,
			updates: statusbar.updates.length,
			setCount: manualTimer.setCount,
		};
		manualTimer.advanceBy(30_000);

		assert.deepStrictEqual({
			afterRearm,
			afterOldCallbacks,
			afterNewDeadline: {
				pending: manualTimer.pendingCount,
				reads: settings.getDoNotDisturbReadCount,
				updates: statusbar.updates.length,
				statusText: statusbar.updates.at(-1)?.text,
				sectionChildren: container.childElementCount,
			},
		}, {
			afterRearm: { pending: 2, pendingDelays: [30_000, 30_000], reads: 4, updates: 1, setCount: 4 },
			afterOldCallbacks: { pending: 2, reads: 4, updates: 1, setCount: 4 },
			afterNewDeadline: { pending: 0, reads: 6, updates: 2, statusText: '$(bell) おやすみモード', sectionChildren: 3 },
		});
	});

	test('normalizes a sleep past expiry without catch-up callbacks', () => {
		let clock = 1_000;
		const manualTimer = new ManualTimer(() => clock, value => clock = value);
		class TestStatusContribution extends ParadisDoNotDisturbStatusBarContribution {
			protected static override readonly refreshControllerFactory: ParadisDoNotDisturbRefreshControllerFactory
				= refresh => paradisCreateDoNotDisturbRefreshController(refresh, { timer: manualTimer, now: () => clock });
		}
		class TestSection extends ParadisDoNotDisturbSection {
			protected static override readonly refreshControllerFactory: ParadisDoNotDisturbRefreshControllerFactory
				= refresh => paradisCreateDoNotDisturbRefreshController(refresh, { timer: manualTimer, now: () => clock });
		}

		const settings = store.add(new TestSettingsService({ enabled: true, until: 91_000 }, () => clock));
		const statusbar = store.add(new TestStatusbarService());
		store.add(new TestStatusContribution(statusbar, settings));
		const container = createContainer('DND sleep');
		store.add(new TestSection(container, settings));
		const initialCallbacks = [...manualTimer.capturedCallbackIds];
		clock = 101_000;
		for (const callbackId of initialCallbacks) {
			manualTimer.fire(callbackId);
		}

		assert.deepStrictEqual({
			pending: manualTimer.pendingCount,
			fires: manualTimer.fireCount,
			reads: settings.getDoNotDisturbReadCount,
			updates: statusbar.updates.length,
			statusText: statusbar.updates.at(-1)?.text,
			sectionChildren: container.childElementCount,
		}, { pending: 0, fires: 2, reads: 4, updates: 1, statusText: '$(bell) おやすみモード', sectionChildren: 3 });
	});

	test('clears timers and listeners on disposal and renders the latest state when reopened', () => {
		let clock = 1_000;
		const manualTimer = new ManualTimer(() => clock, value => clock = value);
		class TestStatusContribution extends ParadisDoNotDisturbStatusBarContribution {
			protected static override readonly refreshControllerFactory: ParadisDoNotDisturbRefreshControllerFactory
				= refresh => paradisCreateDoNotDisturbRefreshController(refresh, { timer: manualTimer, now: () => clock });
		}
		class TestSection extends ParadisDoNotDisturbSection {
			protected static override readonly refreshControllerFactory: ParadisDoNotDisturbRefreshControllerFactory
				= refresh => paradisCreateDoNotDisturbRefreshController(refresh, { timer: manualTimer, now: () => clock });
		}

		const settings = store.add(new TestSettingsService({ enabled: true, until: 91_000 }, () => clock));
		const statusbar = store.add(new TestStatusbarService());
		const status = store.add(new TestStatusContribution(statusbar, settings));
		const container = createContainer('DND disposed section');
		const section = store.add(new TestSection(container, settings));
		const capturedCallbackIds = [...manualTimer.capturedCallbackIds];
		const oldToggle = container.querySelector('input.pns-toggle');
		status.dispose();
		section.dispose();
		const beforeLateWork = {
			reads: settings.getDoNotDisturbReadCount,
			updates: statusbar.updates.length,
			setCount: manualTimer.setCount,
			dom: normalizeDndDom(container),
		};
		settings.setState({ enabled: false, until: undefined });
		settings.fireDedicated(true);
		for (const callbackId of capturedCallbackIds) {
			manualTimer.fireCaptured(callbackId);
		}
		assert.deepStrictEqual({
			pending: manualTimer.pendingCount,
			accessorDisposeCount: statusbar.accessorDisposeCount,
			reads: settings.getDoNotDisturbReadCount,
			updates: statusbar.updates.length,
			setCount: manualTimer.setCount,
			domSame: assert.deepStrictEqual(normalizeDndDom(container), beforeLateWork.dom) === undefined,
			toggleIdentitySame: container.querySelector('input.pns-toggle') === oldToggle,
		}, {
			pending: 0,
			accessorDisposeCount: 1,
			reads: beforeLateWork.reads,
			updates: beforeLateWork.updates,
			setCount: beforeLateWork.setCount,
			domSame: true,
			toggleIdentitySame: true,
		});

		settings.setState({ enabled: true, until: clock + 30_000 });
		const reopenedContainer = createContainer('DND reopened section');
		store.add(new TestSection(reopenedContainer, settings));
		assert.deepStrictEqual({
			pending: manualTimer.pendingCount,
			readDelta: settings.getDoNotDisturbReadCount - beforeLateWork.reads,
			children: reopenedContainer.childElementCount,
			toggleChecked: (reopenedContainer.querySelector('input.pns-toggle') as HTMLInputElement).checked,
			hint: reopenedContainer.querySelector('.pns-field > .pns-row-hint')?.textContent,
		}, { pending: 1, readDelta: 1, children: 4, toggleChecked: true, hint: 'あと1分で自動的に解除されます。' });
	});
});
