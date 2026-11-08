// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import { createElement, type ElementType } from 'react';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { afterAll, beforeAll, describe, expect, test, vi } from 'vitest';
import { ContextMenu, useContextMenuSheet } from './contextMenu.js';
import type { ContextMenuSpec } from './contextMenuModel.js';

vi.mock('react-native', () => ({ View: 'View' }));
vi.mock('lucide-react-native', () => ({ AlignLeft: 'AlignLeft', Code: 'Code', Copy: 'Copy', ExternalLink: 'ExternalLink', FileDiff: 'FileDiff', FileText: 'FileText', Folder: 'Folder', HardDrive: 'HardDrive', Hash: 'Hash', Minus: 'Minus', PencilLine: 'PencilLine', Plus: 'Plus', Quote: 'Quote', Search: 'Search', Share: 'Share', TextCursorInput: 'TextCursorInput', Type: 'Type' }));
vi.mock('../../modules/para-context-menu/index.js', () => ({ ParaContextMenuView: 'ParaContextMenuView' }));
vi.mock('../ui/index.js', () => ({ ActionSheet: 'ActionSheet' }));
vi.mock('../haptics.js', () => ({ haptic: vi.fn() }));
vi.mock('../theme.js', () => ({ colors: { bg: '#111111' }, radius: { control: 6 } }));

beforeAll(() => {
	(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
});

afterAll(() => {
	delete (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT;
});

describe('ContextMenu with the native module', () => {
	test('passes the items to the native view and runs the chosen one, children included', () => {
		const picked: string[] = [];
		const menu: ContextMenuSpec = {
			title: 'a/b.ts',
			actions: [
				{ id: 'copy', title: 'コピー', icon: 'copy', onSelect: () => picked.push('copy') },
				{ id: 'off', title: '使えない', subtitle: '理由', disabled: true, onSelect: () => picked.push('off') },
				{ id: 'codes', title: 'コード', icon: 'code', startsSection: true, children: [{ id: 'code:0', title: 'ts', onSelect: () => picked.push('code:0') }] },
			],
		};
		let renderer: ReactTestRenderer | undefined;
		act(() => {
			renderer = create(createElement(ContextMenu, { menu, children: createElement('View', { testID: 'row' }) }));
		});
		const native = renderer!.root.findByType('ParaContextMenuView' as ElementType);
		expect(native.props.items).toEqual([
			{ id: 'copy', title: 'コピー', systemImage: 'doc.on.doc' },
			{ id: 'off', title: '使えない', subtitle: '理由', disabled: true },
			{ id: 'codes', title: 'コード', systemImage: 'chevron.left.forwardslash.chevron.right', startsSection: true, children: [{ id: 'code:0', title: 'ts' }] },
		]);
		expect(native.props.title).toBe('a/b.ts');
		for (const id of ['copy', 'off', 'code:0']) {
			act(() => native.props.onSelect({ nativeEvent: { id } }));
		}
		expect(picked).toEqual(['copy', 'code:0']);
	});

	test('does not add a long-press sheet when the native menu handles long press', () => {
		let longPress: ReturnType<typeof useContextMenuSheet>['longPress'] | undefined;
		function Probe() {
			longPress = useContextMenuSheet().longPress;
			return null;
		}
		act(() => {
			create(createElement(Probe));
		});
		expect(longPress?.({ actions: [{ id: 'a', title: 'a' }] })).toBeUndefined();
	});
});
