// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import React, { createElement, useEffect, useState, type ComponentType, type ReactNode } from 'react';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.stubGlobal('React', React);
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const harness = vi.hoisted(() => {
	/** 動きは始めても終わらせない（実機で Modal を隠したときに `finished` が来ないのと同じ状況を作る）。 */
	const animation = () => ({ start: () => undefined, stop: () => undefined });
	class AnimatedValue {
		value: number;
		constructor(value: number) {
			this.value = value;
		}
		setValue(value: number) {
			this.value = value;
		}
		stopAnimation() { }
		interpolate() {
			return this;
		}
	}
	const appStateListeners: ((next: string) => void)[] = [];
	const keyboardListeners = new Map<string, () => void>();
	const auth = {
		hasHardwareAsync: async () => true,
		isEnrolledAsync: async () => true,
		authenticateAsync: async () => ({ success: true }),
	};
	return { animation, AnimatedValue, appStateListeners, keyboardListeners, auth, dismiss: { count: 0 } };
});

vi.mock('react-native', () => ({
	Animated: {
		Value: harness.AnimatedValue,
		View: 'AnimatedView',
		timing: harness.animation,
		spring: harness.animation,
		add: (value: unknown) => value,
	},
	AppState: {
		addEventListener: (_event: string, listener: (next: string) => void) => {
			harness.appStateListeners.push(listener);
			return { remove: () => harness.appStateListeners.splice(harness.appStateListeners.indexOf(listener), 1) };
		},
	},
	Easing: { bezier: () => (t: number) => t, in: () => (t: number) => t, out: () => (t: number) => t, cubic: (t: number) => t },
	Keyboard: {
		dismiss: () => { harness.dismiss.count++; },
		addListener: (event: string, listener: () => void) => {
			harness.keyboardListeners.set(event, listener);
			return { remove: () => harness.keyboardListeners.delete(event) };
		},
	},
	LayoutAnimation: { configureNext: () => undefined },
	Modal: 'Modal',
	PanResponder: { create: () => ({ panHandlers: {} }) },
	Platform: { OS: 'ios' },
	Pressable: 'Pressable',
	ScrollView: 'ScrollView',
	StyleSheet: { hairlineWidth: 1, absoluteFill: {}, create: <T>(value: T) => value },
	Text: 'Text',
	View: 'View',
	useWindowDimensions: () => ({ width: 390, height: 844 }),
}));
vi.mock('react-native-gesture-handler', () => {
	const chain: Record<string, () => unknown> = new Proxy({}, { get: () => () => chain });
	return { Gesture: { Pan: () => chain }, GestureDetector: ({ children }: { children: ReactNode }) => children, GestureHandlerRootView: 'GestureHandlerRootView' };
});
vi.mock('@expo/vector-icons', () => ({ Ionicons: () => null }));
vi.mock('expo-local-authentication', () => harness.auth);
vi.mock('./haptics.js', () => ({ haptic: () => undefined }));
vi.mock('./hooks/useSizeClass.js', () => ({ useIsRegularWidth: () => false }));
vi.mock('./hooks/useStableInsets.js', () => ({ useStableInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }) }));
vi.mock('./ipad/shortcutRegistry.js', () => ({ useShortcutSlot: () => undefined }));
vi.mock('./components/glassSurface.js', () => ({ GlassSurface: () => null }));
vi.mock('./components/headerEdgeFade.js', () => ({ HeaderEdgeFade: () => null }));
vi.mock('./components/button.js', () => ({ Button: 'Button' }));
vi.mock('./screenCornerRadius.js', () => ({ screenCornerRadius: 0 }));
vi.mock('./theme.js', async importOriginal => ({
	...await importOriginal<typeof import('./theme.js')>(),
	colors: new Proxy({}, { get: () => '#000' }),
}));

const { AppLockContext, useCloseOnAppLock } = await import('./appLock.js');
const { isAppLockedNow } = await import('./appLockState.js');
const { AuthGate } = await import('./components/authGate.js');
const { BottomDrawer } = await import('./ui/bottomDrawer.js');
const { BottomSheet } = await import('./components/bottomSheet.js');
const { RightDrawer } = await import('./features/code/rightDrawer.js');

interface SheetProps {
	visible: boolean;
	onClose: () => void;
	onAfterClose?: () => void;
	title: string;
	children: ReactNode;
}

/** シートを開いたまま持つ親。閉じる（`onClose`）と visible を落とす。 */
function SheetHost({ Sheet, locked, onAfterClose }: { Sheet: ComponentType<SheetProps>; locked: boolean; onAfterClose: () => void }) {
	const [visible, setVisible] = useState(true);
	return createElement(AppLockContext.Provider, { value: locked },
		createElement(Sheet, { visible, onClose: () => setVisible(false), onAfterClose, title: 'sheet', children: createElement('Text', null, 'body') }));
}

describe('app lock behavior', () => {
	let renderer: ReactTestRenderer | undefined;
	beforeEach(() => {
		harness.dismiss.count = 0;
	});
	afterEach(() => {
		act(() => renderer?.unmount());
		renderer = undefined;
	});

	it.each([
		['BottomDrawer', BottomDrawer as ComponentType<SheetProps>, 1],
		['BottomSheet', BottomSheet as ComponentType<SheetProps>, 0],
		['RightDrawer', RightDrawer as ComponentType<SheetProps>, 1],
	])('%s closed by the lock does not stay after unlocking', (_name, Sheet, afterCloseCalls) => {
		const onAfterClose = vi.fn();
		act(() => {
			renderer = create(createElement(SheetHost, { Sheet, locked: false, onAfterClose }));
		});
		const before = renderer!.root.findAllByType('Modal' as never).map(node => node.props.visible);
		act(() => renderer!.update(createElement(SheetHost, { Sheet, locked: true, onAfterClose })));
		const whileLocked = renderer!.root.findAllByType('Modal' as never).length;
		act(() => renderer!.update(createElement(SheetHost, { Sheet, locked: false, onAfterClose })));
		const afterUnlock = renderer!.root.findAllByType('Modal' as never).length;
		expect({ before, whileLocked, afterUnlock, afterCloseCalls: onAfterClose.mock.calls.length })
			.toEqual({ before: [true], whileLocked: 0, afterUnlock: 0, afterCloseCalls });
	});

	it('useCloseOnAppLock closes once per lock and only while open', () => {
		const close = vi.fn();
		function Probe({ open, locked }: { open: boolean; locked: boolean }) {
			return createElement(AppLockContext.Provider, { value: locked }, createElement(Inner, { open }));
		}
		function Inner({ open }: { open: boolean }) {
			useCloseOnAppLock(open, close);
			return null;
		}
		act(() => {
			renderer = create(createElement(Probe, { open: true, locked: false }));
		});
		const calls: number[] = [close.mock.calls.length];
		act(() => renderer!.update(createElement(Probe, { open: true, locked: true })));
		calls.push(close.mock.calls.length);
		act(() => renderer!.update(createElement(Probe, { open: true, locked: true })));
		calls.push(close.mock.calls.length);
		act(() => renderer!.update(createElement(Probe, { open: false, locked: false })));
		act(() => renderer!.update(createElement(Probe, { open: false, locked: true })));
		calls.push(close.mock.calls.length);
		expect(calls).toEqual([0, 1, 1, 1]);
	});

	it('AuthGate keeps the children mounted across a re-lock and hides them only after the first unlock', async () => {
		vi.useFakeTimers({ toFake: ['Date'] });
		let mounts = 0;
		function Child() {
			useEffect(() => {
				mounts++;
			}, []);
			return createElement('Text', null, 'content');
		}
		const contentOf = () => renderer!.root.findAllByType(Child).length;
		const snapshots: unknown[] = [];
		const record = (label: string) => snapshots.push({ label, mounted: contentOf(), mounts, locked: isAppLockedNow() });

		let resolveAuth: ((value: { success: boolean }) => void) | undefined;
		harness.auth.authenticateAsync = () => new Promise(resolve => { resolveAuth = resolve; });
		await act(async () => {
			renderer = create(createElement(AuthGate, null, createElement(Child)));
		});
		record('cold start, before unlock');
		await act(async () => resolveAuth?.({ success: true }));
		record('unlocked');

		vi.setSystemTime(Date.now());
		act(() => harness.appStateListeners.forEach(listener => listener('background')));
		vi.setSystemTime(Date.now() + 11 * 60 * 1000);
		await act(async () => harness.appStateListeners.forEach(listener => listener('active')));
		record('re-locked');
		const keyboardGuard = harness.keyboardListeners.has('keyboardWillShow');
		await act(async () => resolveAuth?.({ success: true }));
		record('unlocked again');
		vi.useRealTimers();

		expect({ snapshots, keyboardGuard, keyboardGuardAfterUnlock: harness.keyboardListeners.has('keyboardWillShow') }).toEqual({
			snapshots: [
				{ label: 'cold start, before unlock', mounted: 0, mounts: 0, locked: true },
				{ label: 'unlocked', mounted: 1, mounts: 1, locked: false },
				{ label: 're-locked', mounted: 1, mounts: 1, locked: true },
				{ label: 'unlocked again', mounted: 1, mounts: 1, locked: false },
			],
			keyboardGuard: true,
			keyboardGuardAfterUnlock: false,
		});
	});
});
