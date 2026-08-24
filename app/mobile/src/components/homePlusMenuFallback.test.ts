// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import { createElement, type ElementType } from 'react';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { afterAll, beforeAll, describe, expect, test, vi } from 'vitest';
import { HomePlusMenuButton } from './homePlusMenu.js';

vi.mock('react-native', () => ({
	BackHandler: { addEventListener: vi.fn(() => ({ remove: vi.fn() })) },
	Pressable: 'Pressable',
	ScrollView: 'ScrollView',
	StyleSheet: { hairlineWidth: 1, create: <T>(value: T) => value },
	Text: 'Text',
	View: 'View',
	useWindowDimensions: () => ({ width: 568, height: 320 }),
}));
vi.mock('@expo/vector-icons', () => ({ Ionicons: () => null }));
vi.mock('../../modules/para-plus-menu/index.js', () => ({ ParaPlusMenuButton: undefined }));
vi.mock('./glassSurface.js', () => ({ GlassSurface: 'GlassSurface' }));
vi.mock('./overlayHost.js', () => ({ OverlayPortal: 'OverlayPortal', PopIn: 'PopIn' }));
vi.mock('../paraHeader.js', () => ({ PARA_HEADER_PILL_BUTTON: 34, PARA_HEADER_SLOT_HEIGHT: 44 }));
vi.mock('../hooks/useStableInsets.js', () => ({ useStableInsets: () => ({ top: 20, right: 0, bottom: 24, left: 0 }) }));
vi.mock('../haptics.js', () => ({ hapticImpact: vi.fn() }));
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

function press(renderer: ReactTestRenderer, label: string) {
	const button = renderer.root.findAllByType('Pressable' as ElementType)
		.find(node => node.props.accessibilityLabel === label);
	expect(button).toBeDefined();
	act(() => button!.props.onPress());
}

describe('HomePlusMenuButton fallback', () => {
	test('keeps every compact leaf reachable in a short viewport and closes after selection', () => {
		const selected: string[] = [];
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

		press(renderer!, 'ホーム操作');
		const scroll = renderer!.root.findByType('ScrollView' as ElementType);
		expect(scroll.props.keyboardShouldPersistTaps).toBe('always');
		expect(scroll.props.style).toEqual(expect.arrayContaining([expect.objectContaining({ maxHeight: 210 })]));
		expect(renderer!.root.findAllByType('Pressable' as ElementType).map(node => node.props.accessibilityLabel)).toEqual(expect.arrayContaining([
			'アーカイブ 2件を見る',
			'音声通知（受信中）',
			'通知（応答待ち 3件）',
			'Claude を起動',
			'Codex を起動',
			'ターミナルを起動',
			'ワークツリーを作成',
			'メモ',
			'並び替えと絞り込み',
			'すべて確認済みにする',
		]));

		press(renderer!, 'メニューを閉じる');
		expect(renderer!.root.findAllByType('OverlayPortal' as ElementType)).toHaveLength(0);

		const selections = [
			['アーカイブ 2件を見る', 'archive'],
			['音声通知（受信中）', 'voice-notifications'],
			['通知（応答待ち 3件）', 'notifications'],
			['Claude を起動', 'launch-claude'],
			['Codex を起動', 'launch-codex'],
			['ターミナルを起動', 'new-terminal'],
			['ワークツリーを作成', 'new-worktree'],
			['メモ', 'space-note'],
			['並び替えと絞り込み', 'sort'],
			['すべて確認済みにする', 'ack-all'],
		] as const;
		for (const [label, action] of selections) {
			press(renderer!, 'ホーム操作');
			press(renderer!, label);
			expect(renderer!.root.findAllByType('OverlayPortal' as ElementType)).toHaveLength(0);
			expect(selected.at(-1)).toBe(action);
		}
		act(() => renderer!.unmount());
	});
});
