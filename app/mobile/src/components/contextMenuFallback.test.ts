// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import { createElement, type ElementType, type ReactNode } from 'react';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { afterAll, beforeAll, describe, expect, test, vi } from 'vitest';
import { ContextMenu, useContextMenuSheet } from './contextMenu.js';

vi.mock('react-native', () => ({ View: 'View' }));
vi.mock('lucide-react-native', () => ({ AlignLeft: 'AlignLeft', Code: 'Code', Copy: 'Copy', ExternalLink: 'ExternalLink', FileDiff: 'FileDiff', FileText: 'FileText', Folder: 'Folder', HardDrive: 'HardDrive', Hash: 'Hash', Minus: 'Minus', PencilLine: 'PencilLine', Plus: 'Plus', Quote: 'Quote', Search: 'Search', Share: 'Share', TextCursorInput: 'TextCursorInput', Type: 'Type' }));
// ネイティブの部品が入っていない古いビルド
vi.mock('../../modules/para-context-menu/index.js', () => ({ ParaContextMenuView: undefined }));
vi.mock('../ui/index.js', () => ({ ActionSheet: 'ActionSheet' }));
vi.mock('../haptics.js', () => ({ haptic: vi.fn() }));
vi.mock('../theme.js', () => ({ colors: { bg: '#111111' }, radius: { control: 6 } }));

beforeAll(() => {
	(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
});

afterAll(() => {
	delete (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT;
});

describe('ContextMenu without the native module', () => {
	test('wraps the row in a plain view and opens the same items in the app sheet on long press', () => {
		const picked: string[] = [];
		const menu = {
			title: 'a/b.ts',
			actions: [
				{ id: 'name', title: '名前をコピー', icon: 'name' as const, onSelect: () => picked.push('name') },
				{ id: 'codes', title: 'コード', children: [{ id: 'code:0', title: 'ts', onSelect: () => picked.push('code:0') }] },
			],
		};
		let open: (() => void) | undefined;
		function Screen(): ReactNode {
			const { longPress, sheet } = useContextMenuSheet();
			open = longPress(menu);
			return createElement('View', null, createElement(ContextMenu, { menu, children: createElement('View', { testID: 'row' }) }), sheet);
		}
		let renderer: ReactTestRenderer | undefined;
		act(() => {
			renderer = create(createElement(Screen));
		});
		expect(renderer!.root.findAllByType('ParaContextMenuView' as ElementType)).toHaveLength(0);
		expect(renderer!.root.findAllByType('ActionSheet' as ElementType)).toHaveLength(0);
		act(() => open?.());
		const sheet = renderer!.root.findByType('ActionSheet' as ElementType);
		expect({ visible: sheet.props.visible, title: sheet.props.title, rows: sheet.props.actions.map((row: { label: string; hint?: string; icon?: unknown }) => [row.label, row.hint, row.icon]) }).toEqual({
			visible: true,
			title: 'a/b.ts',
			rows: [['名前をコピー', undefined, 'Type'], ['ts', 'コード', undefined]],
		});
		act(() => sheet.props.actions[1].onPress());
		expect(picked).toEqual(['code:0']);
	});
});
