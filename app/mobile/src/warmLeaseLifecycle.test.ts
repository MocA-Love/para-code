/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import { describe, expect, it, vi } from 'vitest';
import { updateCcusageWarmLeaseLifecycle } from '../app/(settings)/ccusage.js';
import { updateSystemSpaceDiskWarmLeaseLifecycle } from '../app/(settings)/system.js';
import { MobileWarmLeaseAppStateBridge } from './appState.js';
import { mobileWarmLeaseOwnerRevision, MobileWarmLeaseLifecycle, shouldMaintainMobileWarmLease, type MobileDisposable } from './store.js';

vi.mock('react-native', () => {
	const component = () => null;
	return {
		ActivityIndicator: component,
		AppState: { currentState: 'active', addEventListener: () => ({ remove() { } }) },
		Pressable: component,
		RefreshControl: component,
		ScrollView: component,
		StyleSheet: { create: <T>(value: T) => value },
		Text: component,
		View: component,
	};
});
vi.mock('@expo/vector-icons', () => ({ Ionicons: () => null }));
vi.mock('expo-router', () => ({ useIsFocused: () => true }));
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
	rnSocketFactory: () => { throw new Error('socket factory is not used by warm lease seam tests'); },
	secureKeyStore: { getItem: async () => null, setItem: async () => { }, deleteItem: async () => { } },
}));
vi.mock('../modules/para-voice-session/index.js', () => ({
	activateVoiceSession: async () => { },
	deactivateVoiceSession: async () => { },
	enqueueVoiceClip: async () => { },
	isVoiceSessionSupported: () => false,
	onVoiceSessionRemoteStop: () => () => { },
}));
vi.mock('./components/connectionGate.js', () => ({ ConnectionGate: () => null }));
vi.mock('./components/screenHeader.js', () => ({ HeaderCircleButton: () => null, ScreenHeader: () => null }));
vi.mock('./components/selectablePill.js', () => ({ SelectablePill: () => null }));
vi.mock('./hooks/useAppIsActive.js', () => ({ useAppIsActive: () => true }));
vi.mock('./hooks/useTabBarSpacer.js', () => ({ useTabBarSpacer: () => 0 }));
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
});
