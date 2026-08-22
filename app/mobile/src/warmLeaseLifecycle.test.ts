/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import React, { createElement, type ComponentType } from 'react';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { encodePairingUri, generateIdentity, toBase64Url, type Identity } from '@para/protocol';
import CcusageScreen, { updateCcusageWarmLeaseLifecycle } from '../app/(settings)/ccusage.js';
import SystemScreen, { updateSystemSpaceDiskWarmLeaseLifecycle } from '../app/(settings)/system.js';
import { MobileWarmLeaseAppStateBridge, useAppStore } from './appState.js';
import {
	mobileWarmLeaseOwnerRevision, MobileController, MobileWarmLeaseLifecycle,
	shouldMaintainMobileWarmLease, type MobileDisposable, type MobileWarmLeaseResource, type StoreState,
} from './store.js';
import type { PairedCredentials } from './relayClient.js';

const componentHarness = vi.hoisted(() => ({
	focused: true,
	appActive: true,
	storage: new Map<string, string>(),
	pairCredentials: undefined as PairedCredentials | undefined,
	leaseEvents: [] as string[],
	runtimeEvents: [] as string[],
	appStateChange: undefined as ((state: string) => void) | undefined,
}));

vi.mock('./store.js', async () => {
	const actual = await vi.importActual<typeof import('./store.js')>('./store.js');
	return {
		...actual,
		// Keep every runtime online so an identity/revision-only render cannot be
		// accidentally covered by a simultaneous connection transition.
		createEmptyStoreState: (): StoreState => ({
			...actual.createEmptyStoreState(),
			connection: 'online',
			pcOnline: true,
			sessionProtocolReady: true,
		}),
	};
});

vi.mock('react-native', () => {
	return {
		ActivityIndicator: 'ActivityIndicator',
		AppState: {
			currentState: 'active',
			addEventListener: (_event: string, listener: (state: string) => void) => {
				componentHarness.appStateChange = listener;
				return { remove() { } };
			},
		},
		Pressable: 'Pressable',
		RefreshControl: 'RefreshControl',
		ScrollView: 'ScrollView',
		StyleSheet: { absoluteFill: {}, create: <T>(value: T) => value },
		Text: 'Text',
		View: 'View',
	};
});
vi.mock('@expo/vector-icons', () => ({ Ionicons: () => null }));
vi.mock('expo-router', () => ({ useIsFocused: () => componentHarness.focused }));
vi.mock('react-native-svg', () => ({ default: () => null, Circle: () => null }));
vi.mock('./platform.js', () => ({
	configureNotificationHandler() { },
	createTerminalOperationOutboxStore: () => ({ loadCandidates: async () => [], save: async () => { }, clear: async () => { } }),
	deleteLegacyNotifyKey: async () => { },
	deleteNotifyKey: async () => { },
	ensureNotificationPermission: async () => false,
	getApnsDeviceToken: async () => undefined,
	migrateLegacyTerminalOperationOutbox: async () => { },
	persistNotifyKey: async () => { },
	presentLocalNotification: async () => { },
	rnSocketFactory: () => { throw new Error('socket factory is replaced at the controller I/O boundary'); },
	secureKeyStore: {
		getItem: async (key: string) => componentHarness.storage.get(key) ?? null,
		setItem: async (key: string, value: string) => { componentHarness.storage.set(key, value); },
		deleteItem: async (key: string) => { componentHarness.storage.delete(key); },
	},
}));
vi.mock('./pairingClient.js', () => ({
	PairingClient: class {
		cancel(): void { }
		async pair(): Promise<PairedCredentials> {
			if (componentHarness.pairCredentials === undefined) {
				throw new Error('pair credentials were not configured by the test');
			}
			return componentHarness.pairCredentials;
		}
	},
}));
vi.mock('../modules/para-voice-session/index.js', () => ({
	activateVoiceSession: async () => { },
	deactivateVoiceSession: async () => { },
	enqueueVoiceClip: async () => { },
	isVoiceSessionSupported: () => false,
	onVoiceSessionRemoteStop: () => () => { },
}));
vi.mock('./components/connectionGate.js', () => ({ ConnectionGate: 'ConnectionGate' }));
vi.mock('./components/screenHeader.js', () => ({ HeaderCircleButton: () => null, ScreenHeader: () => null }));
vi.mock('./components/selectablePill.js', () => ({ SelectablePill: 'SelectablePill' }));
vi.mock('./hooks/useAppIsActive.js', () => ({ useAppIsActive: () => componentHarness.appActive }));
vi.mock('./hooks/useStableInsets.js', () => ({ useStableInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }) }));
vi.mock('./ipad/useContentColumn.js', () => ({ useContentColumnStyle: () => ({}) }));
vi.mock('./theme.js', () => ({
	colors: new Proxy({}, { get: () => '#000000' }),
	radius: { card: 12 },
	squircle: () => ({}),
}));
vi.mock('./time.js', () => ({ formatRelativeTime: () => '', useNow: () => 0 }));
vi.mock('./haptics.js', () => ({ hapticImpact: async () => { }, hapticSelection: async () => { } }));

interface ScreenWarmLeaseState {
	readonly focused: boolean;
	readonly appActive: boolean;
	readonly online: boolean;
	readonly volumeAxis: boolean;
	readonly activePcId: string | undefined;
	readonly controllerRevision: number;
}

interface TestWarmLeaseController {
	createWarmLease(resource: 'ccusage' | 'spaceDisk'): MobileDisposable;
	releaseAllWarmLeases(): void;
}

const controllerOwners = new WeakMap<MobileController, string>();
const controllerLeases = new WeakMap<MobileController, Set<() => void>>();
let pcBIdentity: Identity;

function credentials(owner: string, identity: Identity, token = `token-${owner}`): PairedCredentials {
	return {
		relayUrl: 'wss://relay.test',
		deviceId: owner,
		mobileId: `mobile-${owner}`,
		mobileToken: token,
		pcPublicKey: identity.publicKey,
	};
}

function storedPc(owner: string, name: string, identity: Identity): object {
	return {
		id: owner,
		name,
		renamed: false,
		addedAt: owner === 'pc-a' ? 1 : 2,
		...credentials(owner, identity),
		pcPublicKey: toBase64Url(identity.publicKey),
	};
}

async function flushReact(): Promise<void> {
	await Promise.resolve();
	await Promise.resolve();
}

async function renderScreen(component: ComponentType): Promise<ReactTestRenderer> {
	let renderer: ReactTestRenderer | undefined;
	await act(async () => {
		renderer = create(createElement(component));
		await flushReact();
	});
	return renderer!;
}

async function updateScreen(renderer: ReactTestRenderer, component: ComponentType): Promise<void> {
	await act(async () => {
		renderer.update(createElement(component));
		await flushReact();
	});
}

beforeAll(async () => {
	vi.useFakeTimers();
	vi.stubGlobal('__DEV__', false);
	vi.stubGlobal('React', React);
	(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

	vi.spyOn(MobileController.prototype, 'connect').mockImplementation(function (this: MobileController, creds) {
		controllerOwners.set(this, creds.deviceId);
		this.state.connection = 'online';
		(this as unknown as { onChange: (state: StoreState) => void }).onChange({ ...this.state });
	});
	vi.spyOn(MobileController.prototype, 'reconnect').mockImplementation(() => { });
	vi.spyOn(MobileController.prototype, 'disconnect').mockImplementation(() => { });
	vi.spyOn(MobileController.prototype, 'resumeFromBackground').mockImplementation(() => { });
	vi.spyOn(MobileController.prototype, 'suspendForBackground').mockImplementation(function (this: MobileController) {
		componentHarness.runtimeEvents.push(`${controllerOwners.get(this)}:suspend`);
	});
	vi.spyOn(MobileController.prototype, 'ensureConnected').mockImplementation(() => { });
	vi.spyOn(MobileController.prototype, 'detachAll').mockImplementation(() => { });
	vi.spyOn(MobileController.prototype, 'setTerminalViewport').mockImplementation(() => { });
	vi.spyOn(MobileController.prototype, 'sendNotifyPrefs').mockImplementation(() => { });
	vi.spyOn(MobileController.prototype, 'reset').mockResolvedValue(undefined);
	vi.spyOn(MobileController.prototype, 'usageDashboard').mockResolvedValue({
		days: [], sessions: [], projects: [], failedReports: [], fetchedAt: 1,
	});
	vi.spyOn(MobileController.prototype, 'systemResources').mockResolvedValue({
		host: { cpu: 10, cores: 8, memory: { total: 100, used: 20 }, disks: [], collectedAt: 1 },
		snapshot: {
			app: {
				cpu: 1, memory: 2,
				main: { cpu: 1, memory: 1 }, renderer: { cpu: 0, memory: 1 }, other: { cpu: 0, memory: 0 },
			},
			scopes: [], totalCpu: 1, totalMemory: 2, hostTotalMemory: 100, collectedAt: 1,
		},
	});
	vi.spyOn(MobileController.prototype, 'spaceDisk').mockResolvedValue({ spaces: [], measuredAt: 1, durationMs: 1 });
	vi.spyOn(MobileController.prototype, 'createWarmLease').mockImplementation(function (this: MobileController, resource: MobileWarmLeaseResource) {
		const owner = controllerOwners.get(this);
		if (owner === undefined) {
			throw new Error('warm lease controller has not crossed the connect boundary');
		}
		componentHarness.leaseEvents.push(`${owner}:acquire:${resource}`);
		let disposed = false;
		const active = controllerLeases.get(this) ?? new Set<() => void>();
		controllerLeases.set(this, active);
		const dispose = () => {
			if (disposed) { return; }
			disposed = true;
			active.delete(dispose);
			componentHarness.leaseEvents.push(`${owner}:release:${resource}`);
		};
		active.add(dispose);
		return { dispose };
	});
	vi.spyOn(MobileController.prototype, 'releaseAllWarmLeases').mockImplementation(function (this: MobileController) {
		componentHarness.runtimeEvents.push(`${controllerOwners.get(this)}:release-all`);
		for (const dispose of [...(controllerLeases.get(this) ?? [])]) {
			dispose();
		}
	});

	const pcAIdentity = generateIdentity();
	pcBIdentity = generateIdentity();
	componentHarness.storage.set('para.pcs', JSON.stringify([
		storedPc('pc-a', 'PC A', pcAIdentity),
		storedPc('pc-b', 'PC B', pcBIdentity),
	]));
	componentHarness.storage.set('para.activePc', 'pc-a');
	await useAppStore.getState().init();
});

afterAll(() => {
	vi.clearAllTimers();
	vi.useRealTimers();
	vi.restoreAllMocks();
	vi.unstubAllGlobals();
	delete (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT;
});

describe('mobile warm lease screen lifecycle', () => {
	it('requires focused, active and online for ccusage', () => {
		expect([
			shouldMaintainMobileWarmLease('ccusage', { focused: true, appActive: true, online: true, volumeAxis: false }),
			shouldMaintainMobileWarmLease('ccusage', { focused: false, appActive: true, online: true, volumeAxis: false }),
			shouldMaintainMobileWarmLease('ccusage', { focused: true, appActive: false, online: true, volumeAxis: false }),
			shouldMaintainMobileWarmLease('ccusage', { focused: true, appActive: true, online: false, volumeAxis: false }),
		]).toEqual([true, false, false, false]);
	});

	it('also requires the volume axis for space disk', () => {
		expect([
			shouldMaintainMobileWarmLease('spaceDisk', { focused: true, appActive: true, online: true, volumeAxis: true }),
			shouldMaintainMobileWarmLease('spaceDisk', { focused: true, appActive: true, online: true, volumeAxis: false }),
			shouldMaintainMobileWarmLease('spaceDisk', { focused: false, appActive: true, online: true, volumeAxis: true }),
			shouldMaintainMobileWarmLease('spaceDisk', { focused: true, appActive: false, online: true, volumeAxis: true }),
			shouldMaintainMobileWarmLease('spaceDisk', { focused: true, appActive: true, online: false, volumeAxis: true }),
		]).toEqual([true, false, false, false, false]);
	});

	it('releases synchronously as soon as any active condition becomes false', () => {
		const events: string[] = [];
		const lifecycle = new MobileWarmLeaseLifecycle();
		const acquire = () => { events.push('acquire'); return { dispose: () => events.push('release') }; };
		lifecycle.update(true, acquire);
		lifecycle.update(false, acquire);
		expect(events).toEqual(['acquire', 'release']);
		lifecycle.dispose();
		expect(events).toEqual(['acquire', 'release']);
	});

	it('hands an active lease off when the active PC identity or controller revision changes', () => {
		const events: string[] = [];
		let owner = 'old';
		const lifecycle = new MobileWarmLeaseLifecycle();
		const acquire = () => {
			const captured = owner;
			events.push(`${captured}:acquire`);
			return { dispose: () => events.push(`${captured}:release`) };
		};
		lifecycle.update(true, acquire, 'pc-a:revision-1');
		owner = 'new';
		lifecycle.update(true, acquire, 'pc-b:revision-2');
		expect(events).toEqual(['old:acquire', 'old:release', 'new:acquire']);
		lifecycle.dispose();
		expect(events).toEqual(['old:acquire', 'old:release', 'new:acquire', 'new:release']);
	});

	it('treats both active PC identity and controller revision as owner changes', () => {
		const events: string[] = [];
		const lifecycle = new MobileWarmLeaseLifecycle();
		const acquire = () => {
			events.push('acquire');
			return { dispose: () => events.push('release') };
		};
		lifecycle.update(true, acquire, mobileWarmLeaseOwnerRevision('pc-a', 1));
		lifecycle.update(true, acquire, mobileWarmLeaseOwnerRevision('pc-b', 1));
		lifecycle.update(true, acquire, mobileWarmLeaseOwnerRevision('pc-b', 2));
		expect(events).toEqual(['acquire', 'release', 'acquire', 'release', 'acquire']);
		lifecycle.dispose();
	});

	it('propagates the actual appState controller revision and keeps acquisition captured by controller', () => {
		const events: string[] = [];
		const controller = (owner: string): TestWarmLeaseController => ({
			createWarmLease: resource => {
				events.push(`${owner}:acquire:${resource}`);
				return { dispose: () => events.push(`${owner}:release:${resource}`) };
			},
			releaseAllWarmLeases: () => events.push(`${owner}:release-all`),
		});
		const oldController = controller('old');
		const newController = controller('new');
		const bridge = new MobileWarmLeaseAppStateBridge<TestWarmLeaseController>();

		expect(bridge.replace(oldController)).toEqual({ controller: oldController, controllerRevision: 1 });
		const oldLease = bridge.acquireUsageWarmLease();
		expect(bridge.replace(newController)).toEqual({ controller: newController, controllerRevision: 2 });
		oldLease.dispose();
		const newLease = bridge.acquireUsageWarmLease();
		newLease.dispose();

		expect(events).toEqual([
			'old:acquire:ccusage', 'old:release-all', 'old:release:ccusage',
			'new:acquire:ccusage', 'new:release:ccusage',
		]);
	});

	it('drives ccusage screen wiring through identity, revision and inactive boundaries', () => {
		const active = (activePcId: string, controllerRevision: number): ScreenWarmLeaseState => ({
			focused: true, appActive: true, online: true, volumeAxis: false, activePcId, controllerRevision,
		});
		const events: string[] = [];
		const acquire = (owner: string) => () => {
			events.push(`${owner}:acquire`);
			return { dispose: () => events.push(`${owner}:release`) };
		};
		const lifecycle = new MobileWarmLeaseLifecycle();
		updateCcusageWarmLeaseLifecycle(lifecycle, active('pc-a', 1), acquire('old'));
		updateCcusageWarmLeaseLifecycle(lifecycle, active('pc-b', 1), acquire('identity'));
		updateCcusageWarmLeaseLifecycle(lifecycle, active('pc-b', 2), acquire('revision'));
		expect(events).toEqual(['old:acquire', 'old:release', 'identity:acquire', 'identity:release', 'revision:acquire']);
		lifecycle.dispose();

		for (const [name, state] of [
			['focus', { ...active('pc-b', 2), focused: false }],
			['app', { ...active('pc-b', 2), appActive: false }],
			['online', { ...active('pc-b', 2), online: false }],
		] as const) {
			const boundaryLifecycle = new MobileWarmLeaseLifecycle();
			updateCcusageWarmLeaseLifecycle(boundaryLifecycle, active('pc-b', 2), acquire(name));
			updateCcusageWarmLeaseLifecycle(boundaryLifecycle, state, acquire(name));
		}
		expect(events.slice(-7)).toEqual([
			'revision:release', 'focus:acquire', 'focus:release', 'app:acquire',
			'app:release', 'online:acquire', 'online:release',
		]);
	});

	it('drives system screen wiring through identity, revision and every inactive boundary', () => {
		const active = (activePcId: string, controllerRevision: number): ScreenWarmLeaseState => ({
			focused: true, appActive: true, online: true, volumeAxis: true, activePcId, controllerRevision,
		});
		const events: string[] = [];
		const acquire = (owner: string) => () => {
			events.push(`${owner}:acquire`);
			return { dispose: () => events.push(`${owner}:release`) };
		};
		const lifecycle = new MobileWarmLeaseLifecycle();
		updateSystemSpaceDiskWarmLeaseLifecycle(lifecycle, active('pc-a', 1), acquire('old'));
		updateSystemSpaceDiskWarmLeaseLifecycle(lifecycle, active('pc-b', 1), acquire('identity'));
		updateSystemSpaceDiskWarmLeaseLifecycle(lifecycle, active('pc-b', 2), acquire('revision'));
		expect(events).toEqual(['old:acquire', 'old:release', 'identity:acquire', 'identity:release', 'revision:acquire']);
		lifecycle.dispose();

		for (const [name, state] of [
			['focus', { ...active('pc-b', 2), focused: false }],
			['app', { ...active('pc-b', 2), appActive: false }],
			['online', { ...active('pc-b', 2), online: false }],
			['volume', { ...active('pc-b', 2), volumeAxis: false }],
		] as const) {
			const boundaryLifecycle = new MobileWarmLeaseLifecycle();
			updateSystemSpaceDiskWarmLeaseLifecycle(boundaryLifecycle, active('pc-b', 2), acquire(name));
			updateSystemSpaceDiskWarmLeaseLifecycle(boundaryLifecycle, state, acquire(name));
		}
		expect(events.slice(-8)).toEqual([
			'focus:acquire', 'focus:release', 'app:acquire', 'app:release',
			'online:acquire', 'online:release', 'volume:acquire', 'volume:release',
		]);
		lifecycle.dispose();
	});

	it('reacquires the ccusage lease when session readiness recovers without a connection transition', async () => {
		componentHarness.focused = true;
		componentHarness.appActive = true;
		await act(async () => {
			useAppStore.setState({ connection: 'online', pcOnline: true, sessionProtocolReady: true });
			await flushReact();
		});
		componentHarness.leaseEvents.length = 0;
		const renderer = await renderScreen(CcusageScreen);
		try {
			expect(componentHarness.leaseEvents.at(-1)).toBe('pc-a:acquire:ccusage');
			await act(async () => {
				useAppStore.setState({ pcOnline: false, sessionProtocolReady: false });
				await flushReact();
			});
			expect(componentHarness.leaseEvents.at(-1)).toBe('pc-a:release:ccusage');
			const releasedCount = componentHarness.leaseEvents.length;
			await act(async () => {
				useAppStore.setState({ pcOnline: true });
				await flushReact();
			});
			expect(componentHarness.leaseEvents).toHaveLength(releasedCount);
			await act(async () => {
				useAppStore.setState({ sessionProtocolReady: true });
				await flushReact();
			});
			expect(componentHarness.leaseEvents.at(-1)).toBe('pc-a:acquire:ccusage');
			expect(useAppStore.getState().connection).toBe('online');
		} finally {
			await act(async () => {
				useAppStore.setState({ connection: 'online', pcOnline: true, sessionProtocolReady: true });
				renderer.unmount();
				await flushReact();
			});
		}
	});

	it('reacquires the space disk lease when session readiness recovers without a connection transition', async () => {
		componentHarness.focused = true;
		componentHarness.appActive = true;
		await act(async () => {
			useAppStore.setState({ connection: 'online', pcOnline: true, sessionProtocolReady: true });
			await flushReact();
		});
		componentHarness.leaseEvents.length = 0;
		const renderer = await renderScreen(SystemScreen);
		try {
			const volume = renderer.root.findByProps({ accessibilityLabel: 'ボリューム' });
			await act(async () => {
				volume.props.onPress();
				await flushReact();
			});
			expect(componentHarness.leaseEvents.at(-1)).toBe('pc-a:acquire:spaceDisk');
			await act(async () => {
				useAppStore.setState({ pcOnline: false, sessionProtocolReady: false });
				await flushReact();
			});
			expect(componentHarness.leaseEvents.at(-1)).toBe('pc-a:release:spaceDisk');
			const releasedCount = componentHarness.leaseEvents.length;
			await act(async () => {
				useAppStore.setState({ pcOnline: true });
				await flushReact();
			});
			expect(componentHarness.leaseEvents).toHaveLength(releasedCount);
			await act(async () => {
				useAppStore.setState({ sessionProtocolReady: true });
				await flushReact();
			});
			expect(componentHarness.leaseEvents.at(-1)).toBe('pc-a:acquire:spaceDisk');
			expect(useAppStore.getState().connection).toBe('online');
		} finally {
			await act(async () => {
				useAppStore.setState({ connection: 'online', pcOnline: true, sessionProtocolReady: true });
				renderer.unmount();
				await flushReact();
			});
		}
	});

	it('releases every runtime lease in voice background mode while leaving transports open', async () => {
		componentHarness.focused = true;
		componentHarness.appActive = true;
		if (useAppStore.getState().activePcId !== 'pc-a') {
			useAppStore.getState().switchPc('pc-a');
		}
		useAppStore.setState({ connection: 'online', pcOnline: true, sessionProtocolReady: true });
		componentHarness.leaseEvents.length = 0;
		const renderer = await renderScreen(CcusageScreen);
		try {
			expect(componentHarness.leaseEvents.at(-1)).toBe('pc-a:acquire:ccusage');
			componentHarness.runtimeEvents.length = 0;
			await act(async () => {
				useAppStore.setState({ voiceNotifications: { desired: true, status: 'live' } });
				componentHarness.appStateChange?.('background');
				await flushReact();
			});
			expect(componentHarness.leaseEvents.at(-1)).toBe('pc-a:release:ccusage');
			expect(componentHarness.runtimeEvents.filter(event => event.endsWith(':release-all')).sort()).toEqual([
				'pc-a:release-all', 'pc-b:release-all',
			]);
			expect(componentHarness.runtimeEvents.some(event => event.endsWith(':suspend'))).toBe(false);
		} finally {
			await act(async () => {
				useAppStore.setState({ voiceNotifications: { desired: false, status: 'idle' } });
				renderer.unmount();
				await flushReact();
			});
		}
	});

	it('renders ccusage through actual Zustand activePcId-only and revision-only projections', async () => {
		componentHarness.focused = true;
		componentHarness.appActive = true;
		if (useAppStore.getState().activePcId !== 'pc-a') {
			useAppStore.getState().switchPc('pc-a');
		}
		useAppStore.setState({ pcOnline: true, sessionProtocolReady: true });
		expect(useAppStore.getState()).toMatchObject({ activePcId: 'pc-a', connection: 'online' });
		componentHarness.leaseEvents.length = 0;
		let actualActivePcId = 'pc-a';
		const renderer = await renderScreen(CcusageScreen);
		try {
			expect(componentHarness.leaseEvents).toEqual(['pc-a:acquire:ccusage']);
			const identityOnlyRevision = useAppStore.getState().controllerRevision;

			await act(async () => {
				useAppStore.setState({ activePcId: 'pc-b' });
				await flushReact();
			});
			expect(useAppStore.getState()).toMatchObject({
				activePcId: 'pc-b',
				controllerRevision: identityOnlyRevision,
			});
			expect([...componentHarness.leaseEvents]).toEqual([
				'pc-a:acquire:ccusage', 'pc-a:release:ccusage', 'pc-a:acquire:ccusage',
			]);

			await act(async () => {
				useAppStore.setState({ activePcId: 'pc-a' });
				await flushReact();
			});
			expect(useAppStore.getState()).toMatchObject({
				activePcId: 'pc-a',
				controllerRevision: identityOnlyRevision,
			});
			expect(componentHarness.leaseEvents.slice(-2)).toEqual([
				'pc-a:release:ccusage', 'pc-a:acquire:ccusage',
			]);

			await act(async () => {
				useAppStore.getState().switchPc('pc-b');
				useAppStore.setState({ pcOnline: true, sessionProtocolReady: true });
				await flushReact();
			});
			actualActivePcId = 'pc-b';
			expect(componentHarness.leaseEvents.slice(-2)).toEqual([
				'pc-a:release:ccusage', 'pc-b:acquire:ccusage',
			]);

			componentHarness.leaseEvents.length = 0;
			const previousRevision = useAppStore.getState().controllerRevision;
			componentHarness.pairCredentials = credentials('pc-b', pcBIdentity, 'token-pc-b-ccusage-repaired');
			const uri = encodePairingUri({
				version: 1,
				relayUrl: 'wss://relay.test',
				deviceId: 'pc-b',
				pairId: 'ccusage-repair-pair',
				pairingToken: new Uint8Array(32).fill(6),
				pcPublicKey: pcBIdentity.publicKey,
				pcName: 'PC B',
			});
			await act(async () => {
				await useAppStore.getState().pairFromUri(uri, 'Phone', () => { });
				useAppStore.setState({ pcOnline: true, sessionProtocolReady: true });
				await flushReact();
			});
			expect(useAppStore.getState()).toMatchObject({
				activePcId: 'pc-b',
				controllerRevision: previousRevision + 1,
				connection: 'online',
			});
			expect([...componentHarness.leaseEvents]).toEqual([
				'pc-b:release:ccusage', 'pc-b:acquire:ccusage',
			]);

			componentHarness.focused = false;
			await updateScreen(renderer, CcusageScreen);
			expect(componentHarness.leaseEvents.at(-1)).toBe('pc-b:release:ccusage');
			componentHarness.focused = true;
			await updateScreen(renderer, CcusageScreen);
			expect(componentHarness.leaseEvents.at(-1)).toBe('pc-b:acquire:ccusage');

			componentHarness.appActive = false;
			await updateScreen(renderer, CcusageScreen);
			expect(componentHarness.leaseEvents.at(-1)).toBe('pc-b:release:ccusage');
			componentHarness.appActive = true;
			await updateScreen(renderer, CcusageScreen);
			expect(componentHarness.leaseEvents.at(-1)).toBe('pc-b:acquire:ccusage');

			await act(async () => {
				useAppStore.setState({ connection: 'offline' });
				await flushReact();
			});
			expect(componentHarness.leaseEvents.at(-1)).toBe('pc-b:release:ccusage');
		} finally {
			componentHarness.focused = true;
			componentHarness.appActive = true;
			await act(async () => {
				useAppStore.setState({ activePcId: actualActivePcId, connection: 'online', pcOnline: true, sessionProtocolReady: true });
				await flushReact();
				renderer.unmount();
			});
		}
	});

	it('renders system through actual Zustand activePcId-only and revision-only projections', async () => {
		componentHarness.focused = true;
		componentHarness.appActive = true;
		await act(async () => {
			useAppStore.getState().switchPc('pc-a');
			useAppStore.setState({ pcOnline: true, sessionProtocolReady: true });
			await flushReact();
		});
		expect(useAppStore.getState()).toMatchObject({ activePcId: 'pc-a', connection: 'online' });
		componentHarness.leaseEvents.length = 0;
		let actualActivePcId = 'pc-a';
		const renderer = await renderScreen(SystemScreen);
		try {
			expect(componentHarness.leaseEvents).toEqual([]);
			const volume = renderer.root.findByProps({ accessibilityLabel: 'ボリューム' });
			await act(async () => {
				volume.props.onPress();
				await flushReact();
			});
			expect(componentHarness.leaseEvents).toEqual(['pc-a:acquire:spaceDisk']);
			const identityOnlyRevision = useAppStore.getState().controllerRevision;

			await act(async () => {
				useAppStore.setState({ activePcId: 'pc-b' });
				await flushReact();
			});
			expect(useAppStore.getState()).toMatchObject({
				activePcId: 'pc-b',
				controllerRevision: identityOnlyRevision,
			});
			expect([...componentHarness.leaseEvents]).toEqual([
				'pc-a:acquire:spaceDisk', 'pc-a:release:spaceDisk', 'pc-a:acquire:spaceDisk',
			]);

			await act(async () => {
				useAppStore.setState({ activePcId: 'pc-a' });
				await flushReact();
			});
			expect(useAppStore.getState()).toMatchObject({
				activePcId: 'pc-a',
				controllerRevision: identityOnlyRevision,
			});
			expect(componentHarness.leaseEvents.slice(-2)).toEqual([
				'pc-a:release:spaceDisk', 'pc-a:acquire:spaceDisk',
			]);

			await act(async () => {
				useAppStore.getState().switchPc('pc-b');
				useAppStore.setState({ pcOnline: true, sessionProtocolReady: true });
				await flushReact();
			});
			actualActivePcId = 'pc-b';
			expect(componentHarness.leaseEvents.slice(-2)).toEqual([
				'pc-a:release:spaceDisk', 'pc-b:acquire:spaceDisk',
			]);

			const previousRevision = useAppStore.getState().controllerRevision;
			componentHarness.pairCredentials = credentials('pc-b', pcBIdentity, 'token-pc-b-repaired');
			const uri = encodePairingUri({
				version: 1,
				relayUrl: 'wss://relay.test',
				deviceId: 'pc-b',
				pairId: 'repair-pair',
				pairingToken: new Uint8Array(32).fill(7),
				pcPublicKey: pcBIdentity.publicKey,
				pcName: 'PC B',
			});
			await act(async () => {
				await useAppStore.getState().pairFromUri(uri, 'Phone', () => { });
				useAppStore.setState({ pcOnline: true, sessionProtocolReady: true });
				await flushReact();
			});
			expect(useAppStore.getState()).toMatchObject({
				activePcId: 'pc-b',
				controllerRevision: previousRevision + 1,
				connection: 'online',
			});
			expect(componentHarness.leaseEvents.slice(-2)).toEqual([
				'pc-b:release:spaceDisk', 'pc-b:acquire:spaceDisk',
			]);

			componentHarness.focused = false;
			await updateScreen(renderer, SystemScreen);
			expect(componentHarness.leaseEvents.at(-1)).toBe('pc-b:release:spaceDisk');
			componentHarness.focused = true;
			await updateScreen(renderer, SystemScreen);
			expect(componentHarness.leaseEvents.at(-1)).toBe('pc-b:acquire:spaceDisk');

			componentHarness.appActive = false;
			await updateScreen(renderer, SystemScreen);
			expect(componentHarness.leaseEvents.at(-1)).toBe('pc-b:release:spaceDisk');
			componentHarness.appActive = true;
			await updateScreen(renderer, SystemScreen);
			expect(componentHarness.leaseEvents.at(-1)).toBe('pc-b:acquire:spaceDisk');

			await act(async () => {
				useAppStore.setState({ connection: 'offline' });
				await flushReact();
			});
			expect(componentHarness.leaseEvents.at(-1)).toBe('pc-b:release:spaceDisk');
			await act(async () => {
				useAppStore.setState({ connection: 'online' });
				await flushReact();
			});
			expect(componentHarness.leaseEvents.at(-1)).toBe('pc-b:acquire:spaceDisk');

			const process = renderer.root.findByProps({ accessibilityLabel: 'プロセス' });
			await act(async () => {
				process.props.onPress();
				await flushReact();
			});
			expect(componentHarness.leaseEvents.slice(-2)).toEqual([
				'pc-b:acquire:spaceDisk', 'pc-b:release:spaceDisk',
			]);
		} finally {
			componentHarness.focused = true;
			componentHarness.appActive = true;
			await act(async () => {
				useAppStore.setState({ activePcId: actualActivePcId, connection: 'online', pcOnline: true, sessionProtocolReady: true });
				await flushReact();
				renderer.unmount();
			});
		}
	});
});
