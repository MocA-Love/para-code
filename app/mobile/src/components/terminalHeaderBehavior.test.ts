// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import { createElement, type ElementType } from 'react';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { afterAll, beforeAll, describe, expect, test, vi } from 'vitest';
import { sizeClassFor } from '../sizeClass.js';
import {
	COMPACT_TERMINAL_MENU_WIDTH,
	decodeTerminalCompactMenuAction,
	terminalNativeHeaderLayout,
} from './terminalHeaderBehavior.js';
import { TerminalCompactMenu } from './terminalPicker.js';

vi.mock('react-native', () => ({
	Platform: { OS: 'ios' },
	Pressable: 'Pressable',
	ScrollView: 'ScrollView',
	StyleSheet: { create: <T>(value: T) => value },
	Text: 'Text',
	View: 'View',
}));
vi.mock('@expo/vector-icons', () => ({ Ionicons: () => null }));
vi.mock('../../modules/para-plus-menu/index.js', () => ({ ParaPlusMenuButton: 'ParaPlusMenuButton' }));
vi.mock('./glassSurface.js', () => ({ GlassSurface: 'GlassSurface' }));
vi.mock('../haptics.js', () => ({ hapticSelection: vi.fn() }));
vi.mock('../theme.js', () => ({
	colors: new Proxy({}, { get: () => '#000000' }),
	mono: { ios: 'Menlo' },
	radius: { pill: 999 },
	squircle: {},
}));

beforeAll(() => {
	(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
});

afterAll(() => {
	delete (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT;
});

describe('terminal header behavior', () => {
	test.each([390, 375, 320])('uses one fixed 44pt menu at %ipt', width => {
		const layout = terminalNativeHeaderLayout(sizeClassFor(width, false));
		expect({ width, layout }).toEqual({
			width,
			layout: { kind: 'compact-menu', headerItemCount: 1, itemWidth: 44 },
		});
		expect(COMPACT_TERMINAL_MENU_WIDTH).toBe(44);
	});

	test('keeps the existing three header items on a regular iPad', () => {
		expect(terminalNativeHeaderLayout(sizeClassFor(744, true))).toEqual({
			kind: 'regular-actions',
			headerItemCount: 3,
		});
	});

	test('decodes terminal, preset, and create selections without mixing their callbacks', () => {
		expect([
			decodeTerminalCompactMenuAction('pick:terminal-2'),
			decodeTerminalCompactMenuAction('presets'),
			decodeTerminalCompactMenuAction('new-terminal'),
			decodeTerminalCompactMenuAction('pick:'),
		]).toEqual([
			{ kind: 'terminal', terminalKey: 'terminal-2' },
			{ kind: 'presets' },
			{ kind: 'create' },
			undefined,
		]);
	});

	test('renders one fixed native component and invokes each existing callback', () => {
		const events: string[] = [];
		let renderer: ReactTestRenderer | undefined;
		act(() => {
			renderer = create(createElement(TerminalCompactMenu, {
				entries: [
					{ terminalKey: 'terminal-1', title: 'First', index: 1, waiting: false, working: false },
					{ terminalKey: 'terminal-2', title: 'Second', index: 2, waiting: true, working: false },
				],
				activeKey: 'terminal-1',
				onSelect: terminalKey => events.push(`terminal:${terminalKey}`),
				onOpenPresets: () => events.push('presets'),
				onCreate: () => events.push('create'),
			}));
		});
		const button = renderer!.root.findByType('ParaPlusMenuButton' as unknown as ElementType);
		const leafIds = button.props.items.flatMap((item: { id: string; children?: readonly { id: string }[] }) =>
			item.children?.map(child => child.id) ?? [item.id]);
		expect({ style: button.props.style, leafIds }).toEqual({
			style: { width: 44, height: 44 },
			leafIds: ['pick:terminal-1', 'pick:terminal-2', 'presets', 'new-terminal'],
		});
		act(() => {
			button.props.onSelect({ nativeEvent: { id: 'pick:terminal-2' } });
			button.props.onSelect({ nativeEvent: { id: 'presets' } });
			button.props.onSelect({ nativeEvent: { id: 'new-terminal' } });
		});
		expect(events).toEqual(['terminal:terminal-2', 'presets', 'create']);
		act(() => renderer!.unmount());
	});
});
