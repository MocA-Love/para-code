// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import { beforeEach, describe, expect, it } from 'vitest';
import { EMPTY_TREE, MAX_TREES, hasFileTree, initialTree, saveTreeScroll, treeScroll, useFileTreeStore } from './fileTreeStore.js';

describe('fileTreeStore', () => {
	beforeEach(() => {
		useFileTreeStore.setState({ trees: {} });
	});

	it('初めて変えたときに初期の状態へ当てて作り、外した画面の後も残す', () => {
		const { update } = useFileTreeStore.getState();
		update('pc\0space', current => ({ expanded: new Set([...current.expanded, 'src/app']) }), initialTree('src'));
		update('pc\0space', () => ({ opened: 'src/app/main.ts' }));
		const tree = useFileTreeStore.getState().trees['pc\0space'];
		expect({ expanded: [...(tree?.expanded ?? [])], highlighted: tree?.highlighted, opened: tree?.opened, exists: hasFileTree('pc\0space') }).toEqual({
			expanded: ['src', 'src/app'],
			highlighted: 'src',
			opened: 'src/app/main.ts',
			exists: true,
		});
	});

	it('変わらない更新では状態を作り直さない', () => {
		const { update } = useFileTreeStore.getState();
		update('k', () => ({ opened: 'a' }));
		const before = useFileTreeStore.getState().trees;
		update('k', () => ({ opened: 'a' }));
		expect(useFileTreeStore.getState().trees).toBe(before);
	});

	it('覚えるスペースは上限まで。古いものから捨てる', () => {
		const { update } = useFileTreeStore.getState();
		for (let index = 0; index <= MAX_TREES; index++) {
			update(`k${index}`, () => ({ opened: `${index}` }));
		}
		// 最初のものを触り直すと最近使ったものになる
		update('k1', () => ({ opened: 'again' }));
		update('extra', () => ({ opened: 'x' }));
		const keys = Object.keys(useFileTreeStore.getState().trees);
		expect({ count: keys.length, dropped: ['k0', 'k2'].filter(key => !keys.includes(key)), keptRecent: keys.includes('k1') }).toEqual({ count: MAX_TREES, dropped: ['k0', 'k2'], keptRecent: true });
	});

	it('スクロールの位置は購読できる状態と分けて覚える', () => {
		saveTreeScroll('s', 320);
		saveTreeScroll('t', -5);
		expect([treeScroll('s'), treeScroll('t'), treeScroll('none'), initialTree(undefined) === EMPTY_TREE]).toEqual([320, 0, 0, true]);
	});
});
