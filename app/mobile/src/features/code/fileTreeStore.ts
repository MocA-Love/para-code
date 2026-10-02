// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import { create } from 'zustand';
import type { FilesSearchMode } from '../../filesSearch.js';
import { ancestorPaths, type DirCache } from './fileTree.js';

/**
 * ファイルの一覧の状態を、画面（`FileTreePanel`）の外に退避しておく場所。
 *
 * iPad のドックはファイルを開くときにドックごと一覧を外す（`panelDock.ts` の決まり）ので、状態を画面の
 * `useState` に持つと、戻ったときに開いていたフォルダ・位置・検索が消える。PC とスペースの組
 * （`codeCacheKey`）ごとにここへ置き、ドックを開き直したとき・セッションから開き直したときにそのまま戻す。
 *
 * 端末には保存しない（アプリを閉じれば消える）。覚えるスペースの数は {@link MAX_TREES} まで
 * （古いものから捨てる。一覧の中身を抱えたまま増え続けないように）。
 */

export interface FileTreeSearchState {
	readonly open: boolean;
	readonly query: string;
	readonly mode: FilesSearchMode;
}

export interface FileTreeSnapshot {
	/** 読んだフォルダの一覧。 */
	readonly cache: DirCache;
	/** 開いているフォルダ。 */
	readonly expanded: ReadonlySet<string>;
	/** 目印を付けたフォルダ（パンくずから戻ったときなど）。 */
	readonly highlighted: string | undefined;
	/** 最後に開いたファイル（行に印を付ける）。 */
	readonly opened: string | undefined;
	readonly search: FileTreeSearchState;
}

/** 覚えておくスペースの数。 */
export const MAX_TREES = 8;

const NO_SEARCH: FileTreeSearchState = { open: false, query: '', mode: 'name' };

export const EMPTY_TREE: FileTreeSnapshot = {
	cache: {},
	expanded: new Set(),
	highlighted: undefined,
	opened: undefined,
	search: NO_SEARCH,
};

/** 初めて開くスペースの状態（`reveal` があればそこまで開いて目印を付ける）。 */
export function initialTree(reveal: string | undefined): FileTreeSnapshot {
	return reveal === undefined ? EMPTY_TREE : { ...EMPTY_TREE, expanded: new Set(ancestorPaths(reveal)), highlighted: reveal };
}

interface FileTreeStore {
	readonly trees: Readonly<Record<string, FileTreeSnapshot>>;
	/** 状態を変える。まだ無ければ `initial`（省略時は空）に当てて作る。 */
	update(key: string, change: (current: FileTreeSnapshot) => Partial<FileTreeSnapshot>, initial?: FileTreeSnapshot): void;
}

/** 新しく足したキーを末尾にし、上限を超えた古いものを捨てる。 */
function withTree(trees: Readonly<Record<string, FileTreeSnapshot>>, key: string, tree: FileTreeSnapshot): Record<string, FileTreeSnapshot> {
	const { [key]: _previous, ...rest } = trees;
	const keys = Object.keys(rest);
	const kept = keys.length >= MAX_TREES ? Object.fromEntries(keys.slice(keys.length - MAX_TREES + 1).map(name => [name, rest[name]!])) : rest;
	return { ...kept, [key]: tree };
}

export const useFileTreeStore = create<FileTreeStore>()(set => ({
	trees: {},
	update(key, change, initial = EMPTY_TREE) {
		set(state => {
			const exists = Object.prototype.hasOwnProperty.call(state.trees, key);
			const current = exists ? state.trees[key]! : initial;
			const patch = change(current);
			if (exists && Object.keys(patch).every(name => (patch as Record<string, unknown>)[name] === (current as unknown as Record<string, unknown>)[name])) {
				return state;
			}
			// 触ったスペースを末尾へ（最近使ったものほど残る）
			return { trees: withTree(state.trees, key, { ...current, ...patch }) };
		});
	},
}));

/**
 * 一覧のスクロールの位置（pt）。スクロールのたびに画面を描き直さないよう、購読できる状態とは分けて持つ。
 * 覚えるスペースの数は状態と同じく {@link MAX_TREES} まで。
 */
const scrollOffsets = new Map<string, number>();

export function saveTreeScroll(key: string, offset: number): void {
	scrollOffsets.delete(key);
	scrollOffsets.set(key, Math.max(0, offset));
	if (scrollOffsets.size > MAX_TREES) {
		const oldest = scrollOffsets.keys().next().value;
		if (oldest !== undefined) {
			scrollOffsets.delete(oldest);
		}
	}
}

export function treeScroll(key: string): number {
	return scrollOffsets.get(key) ?? 0;
}

/** そのスペースの状態（まだ無ければ undefined）。 */
export function useFileTreeSnapshot(key: string): FileTreeSnapshot | undefined {
	return useFileTreeStore(state => (Object.prototype.hasOwnProperty.call(state.trees, key) ? state.trees[key] : undefined));
}

/** そのスペースの状態があるか（描画の外で読む）。 */
export function hasFileTree(key: string): boolean {
	return Object.prototype.hasOwnProperty.call(useFileTreeStore.getState().trees, key);
}
