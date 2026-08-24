// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import { createElement, type ComponentType, type ElementType } from 'react';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { afterAll, beforeAll, describe, expect, test, vi } from 'vitest';
import { sizeClassFor } from '../sizeClass.js';
import {
	buildHomeHeaderMenuItems,
	dispatchHomeHeaderMenuAction,
	homeHeaderLayout,
	type HomeHeaderMenuAction,
	type HomeHeaderMenuHandlers,
	type HomeHeaderMenuItem,
	type HomePlusMenuAction,
} from './homeHeaderMenuBehavior.js';
import { HomePlusMenuButton } from './homePlusMenu.js';
import { VoiceNotificationControl } from './voiceNotificationControl.js';

vi.mock('react-native', () => ({
	ActivityIndicator: 'ActivityIndicator',
	BackHandler: { addEventListener: vi.fn(() => ({ remove: vi.fn() })) },
	Platform: { OS: 'ios' },
	Pressable: 'Pressable',
	ScrollView: 'ScrollView',
	StyleSheet: { hairlineWidth: 1, create: <T>(value: T) => value },
	Text: 'Text',
	View: 'View',
}));
vi.mock('@expo/vector-icons', () => ({ Ionicons: () => null }));
vi.mock('../../modules/para-plus-menu/index.js', () => ({ ParaPlusMenuButton: 'ParaPlusMenuButton' }));
vi.mock('./glassSurface.js', () => ({ GlassSurface: 'GlassSurface' }));
vi.mock('./bottomSheet.js', () => ({ BottomSheet: 'BottomSheet' }));
vi.mock('./overlayHost.js', () => ({ OverlayPortal: 'OverlayPortal', PopIn: 'PopIn' }));
vi.mock('../paraHeader.js', () => ({ PARA_HEADER_PILL_BUTTON: 34, PARA_HEADER_SLOT_HEIGHT: 44 }));
vi.mock('../hooks/useStableInsets.js', () => ({ useStableInsets: () => ({ top: 0, right: 0, bottom: 0, left: 0 }) }));
vi.mock('../haptics.js', () => ({ hapticImpact: vi.fn() }));
vi.mock('zustand/react/shallow', () => ({ useShallow: <T>(selector: T) => selector }));
vi.mock('../appState.js', () => ({
	useAppStore: (selector: (state: {
		voiceNotifications: { desired: boolean; status: 'idle'; error: undefined };
		pcOnline: boolean;
		startVoiceNotifications: () => void;
		stopVoiceNotifications: () => void;
	}) => unknown) => selector({
		voiceNotifications: { desired: false, status: 'idle', error: undefined },
		pcOnline: true,
		startVoiceNotifications: vi.fn(),
		stopVoiceNotifications: vi.fn(),
	}),
}));
vi.mock('../theme.js', () => ({
	colors: new Proxy({}, { get: () => '#000000' }),
	radius: { pill: 999 },
	squircle: {},
}));

beforeAll(() => {
	(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
});

afterAll(() => {
	delete (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT;
});

function leafIds(items: readonly HomeHeaderMenuItem[]): string[] {
	return items.flatMap(item => item.children === undefined ? [item.id] : leafIds(item.children));
}

describe('home header menu behavior', () => {
	test.each([390, 375, 320])('uses one fixed overflow item at %ipt', width => {
		expect(homeHeaderLayout(sizeClassFor(width, false))).toEqual({
			kind: 'compact-menu',
			headerItemCount: 1,
			itemWidth: 44,
		});
	});

	test('keeps separate actions at regular iPad width', () => {
		expect(homeHeaderLayout(sizeClassFor(744, true))).toEqual({ kind: 'regular-actions' });
	});

	test('compact menu exposes archive, voice, notifications, and every existing plus action', () => {
		const items = buildHomeHeaderMenuItems({
			compact: true,
			archivedCount: 2,
			voiceActive: true,
			notificationQuestionCount: 3,
			ackCount: 1,
			hasSpace: true,
		});
		expect(leafIds(items)).toEqual([
			'archive',
			'voice-notifications',
			'notifications',
			'launch-claude',
			'launch-codex',
			'new-terminal',
			'new-worktree',
			'space-note',
			'sort',
			'ack-all',
		]);
	});

	test('dispatches header-only actions and forwards creation actions unchanged', () => {
		const events: string[] = [];
		const handlers: HomeHeaderMenuHandlers = {
			onArchive: vi.fn(() => events.push('archive')),
			onVoiceNotifications: vi.fn(() => events.push('voice')),
			onNotifications: vi.fn(() => events.push('notifications')),
			onPlusMenuSelect: vi.fn((action: HomePlusMenuAction) => events.push(`plus:${action}`)),
		};
		dispatchHomeHeaderMenuAction('archive', handlers);
		dispatchHomeHeaderMenuAction('voice-notifications', handlers);
		dispatchHomeHeaderMenuAction('notifications', handlers);
		dispatchHomeHeaderMenuAction('new-worktree', handlers);
		expect(events).toEqual(['archive', 'voice', 'notifications', 'plus:new-worktree']);
	});

	test('compact HomePlusMenuButton is 44pt and forwards visible menu leaves', () => {
		const selected: HomeHeaderMenuAction[] = [];
		let renderer: ReactTestRenderer | undefined;
		act(() => {
			renderer = create(createElement(HomePlusMenuButton, {
				compact: true,
				archivedCount: 2,
				voiceActive: true,
				notificationQuestionCount: 3,
				ackCount: 1,
				hasSpace: true,
				onSelect: action => selected.push(action),
			}));
		});
		const button = renderer!.root.findByType('ParaPlusMenuButton' as ElementType);
		const ids = button.props.items.flatMap((item: { id: string; children?: readonly { id: string }[] }) =>
			item.children?.map(child => child.id) ?? [item.id]);
		expect(button.props.style).toMatchObject({ width: 44, height: 44 });
		expect(ids).toEqual([
			'archive',
			'voice-notifications',
			'notifications',
			'launch-claude',
			'launch-codex',
			'new-terminal',
			'new-worktree',
			'space-note',
			'sort',
			'ack-all',
		]);
		act(() => {
			button.props.onSelect({ nativeEvent: { id: 'archive' } });
			button.props.onSelect({ nativeEvent: { id: 'new-worktree' } });
		});
		expect(selected).toEqual(['archive', 'new-worktree']);
		act(() => renderer!.unmount());
	});

	test('controlled voice sheet is visible without adding its header button', () => {
		const onClose = vi.fn();
		let renderer: ReactTestRenderer | undefined;
		act(() => {
			renderer = create(createElement(VoiceNotificationControl as ComponentType<{ visible: boolean; onClose: () => void }>, { visible: true, onClose }));
		});
		const sheet = renderer!.root.findByType('BottomSheet' as ElementType);
		expect({ visible: sheet.props.visible, pressables: renderer!.root.findAllByType('Pressable' as ElementType).length }).toEqual({
			visible: true,
			pressables: 1,
		});
		act(() => sheet.props.onClose());
		expect(onClose).toHaveBeenCalledOnce();
		act(() => renderer!.unmount());
	});
});
