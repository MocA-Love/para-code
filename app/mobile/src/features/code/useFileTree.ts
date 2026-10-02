// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import { useCallback, useEffect, useRef, useState } from 'react';
import { useAppStore } from '../../appState.js';
import { codeCacheKey } from './codeCache.js';
import { ancestorPaths, dirState, flattenTree, needsLoad, type DirCache, type TreeRow } from './fileTree.js';
import { hasFileTree, initialTree, useFileTreeSnapshot, useFileTreeStore, type FileTreeSearchState, type FileTreeSnapshot } from './fileTreeStore.js';
import { errorMessage } from './scmModel.js';
import { currentRendererTarget, type CodeSpace } from './useCodeSpace.js';

export interface FileTreeState {
	/** 状態の置き場所のキー（`codeCacheKey`）。 */
	readonly key: string;
	readonly rows: readonly TreeRow[];
	/** 根のフォルダの状態（まだ読めていない・失敗）。 */
	readonly root: { readonly loaded: boolean; readonly loading: boolean; readonly error: string | undefined; readonly empty: boolean };
	readonly expanded: ReadonlySet<string>;
	/** 目印を付けたフォルダ（パンくずから戻ったときなど）。 */
	readonly highlighted: string | undefined;
	/** 最後に開いたファイル。 */
	readonly opened: string | undefined;
	readonly search: FileTreeSearchState;
	readonly refreshing: boolean;
	readonly toggle: (path: string) => void;
	readonly retry: (path: string) => void;
	readonly refresh: () => void;
	/** そのフォルダまでを開いて目印を付ける。 */
	readonly reveal: (path: string) => void;
	/** ファイルを開いた印を付ける。 */
	readonly markOpened: (path: string) => void;
	readonly setSearch: (change: Partial<FileTreeSearchState>) => void;
}

/**
 * ファイルのツリー（Orca の MobileFileExplorerPanel の読み込み）。フォルダを開いたときに1階層ずつ読む。
 * 接続し直したとき・画面を開き直したときは、開いているフォルダを静かに読み直す（読み終わるまで前回の一覧を出しておく）。
 *
 * 開いているフォルダ・読んだ一覧・目印・検索は `fileTreeStore.ts` に退避する（iPad のドックがファイルを開くときに
 * ドックごと外しても、戻ってドックを開き直したときにそのまま戻すため）。
 */
export function useFileTree(space: CodeSpace, initialReveal: string | undefined): FileTreeState {
	const fsList = useAppStore(s => s.fsList);
	const key = codeCacheKey(space.pcId, space.spaceId);
	const storeUpdate = useFileTreeStore(s => s.update);
	// 初めて開くスペースは、`initialReveal` まで開いた状態から始める（最初に変えたときにストアへ入る）
	const [fresh] = useState(() => !hasFileTree(key));
	const initial = useRef<FileTreeSnapshot>(initialTree(initialReveal));
	const snapshot = useFileTreeSnapshot(key) ?? initial.current;
	const { cache, expanded, highlighted, opened, search } = snapshot;
	const update = useCallback((target: string, change: (current: FileTreeSnapshot) => Partial<FileTreeSnapshot>) => {
		storeUpdate(target, change, initial.current);
	}, [storeUpdate]);
	const [refreshing, setRefreshing] = useState(false);
	const cacheRef = useRef(cache);
	cacheRef.current = cache;
	const expandedRef = useRef(expanded);
	expandedRef.current = expanded;
	/** フォルダごとの要求の世代（古い応答で新しい結果を上書きしない）。 */
	const gensRef = useRef(new Map<string, number>());
	const { wsId, rendererTarget } = space;

	const setCache = useCallback((change: (previous: DirCache) => DirCache) => {
		update(key, current => ({ cache: change(current.cache) }));
	}, [update, key]);

	const load = useCallback(async (path: string) => {
		if (wsId === undefined || rendererTarget === undefined) {
			return;
		}
		const gen = (gensRef.current.get(path) ?? 0) + 1;
		gensRef.current.set(path, gen);
		const current = () => gensRef.current.get(path) === gen && currentRendererTarget(wsId) === rendererTarget;
		setCache(previous => ({ ...previous, [path]: { entries: dirState(previous, path)?.entries, loading: true } }));
		try {
			const result = await fsList(wsId, path);
			if (current()) {
				setCache(previous => ({ ...previous, [path]: { entries: result.entries } }));
			}
		} catch (e) {
			if (current()) {
				setCache(previous => ({ ...previous, [path]: { entries: dirState(previous, path)?.entries, error: errorMessage(e) } }));
			}
		}
	}, [fsList, wsId, rendererTarget, setCache]);

	// つながったとき（つながり直したとき・開き直したとき）に、根と開いているフォルダを読む。
	useEffect(() => {
		if (rendererTarget === undefined) {
			gensRef.current.clear();
			setCache(previous => {
				const next: Record<string, NonNullable<DirCache[string]>> = {};
				for (const [path, state] of Object.entries(previous)) {
					if (state !== undefined) {
						next[path] = { entries: state.entries, error: state.error };
					}
				}
				return next;
			});
			return;
		}
		void load('');
		for (const path of expandedRef.current) {
			void load(path);
		}
	}, [rendererTarget, load, setCache]);

	const toggle = useCallback((path: string) => {
		const opening = !expandedRef.current.has(path);
		update(key, current => {
			const next = new Set(current.expanded);
			if (opening) {
				next.add(path);
			} else {
				next.delete(path);
			}
			return { expanded: next, highlighted: undefined };
		});
		if (opening && needsLoad(cacheRef.current, path)) {
			void load(path);
		}
	}, [load, update, key]);

	const retry = useCallback((path: string) => {
		void load(path);
	}, [load]);

	const refresh = useCallback(() => {
		setRefreshing(true);
		const paths = ['', ...expandedRef.current];
		void Promise.allSettled(paths.map(path => load(path))).then(() => setRefreshing(false));
	}, [load]);

	const reveal = useCallback((path: string) => {
		const chain = ancestorPaths(path);
		update(key, current => ({ expanded: new Set([...current.expanded, ...chain]), highlighted: path.length > 0 ? path : undefined }));
		for (const dir of chain) {
			if (needsLoad(cacheRef.current, dir)) {
				void load(dir);
			}
		}
	}, [load, update, key]);

	// 前に開いたことのあるスペースを、フォルダを指定して開き直した（パンくずから進んだなど）ときは、そこまで開く。
	const revealedOnce = useRef(false);
	useEffect(() => {
		if (revealedOnce.current || fresh || initialReveal === undefined) {
			return;
		}
		revealedOnce.current = true;
		reveal(initialReveal);
	}, [fresh, initialReveal, reveal]);

	const markOpened = useCallback((path: string) => {
		update(key, () => ({ opened: path, highlighted: undefined }));
	}, [update, key]);

	const setSearch = useCallback((change: Partial<FileTreeSearchState>) => {
		update(key, current => ({ search: { ...current.search, ...change } }));
	}, [update, key]);

	const rootState = dirState(cache, '');
	return {
		key,
		rows: flattenTree(cache, expanded),
		root: {
			loaded: rootState?.entries !== undefined,
			loading: rootState?.loading === true,
			error: rootState?.error,
			empty: rootState?.entries !== undefined && rootState.entries.length === 0,
		},
		expanded,
		highlighted,
		opened,
		search,
		refreshing,
		toggle,
		retry,
		refresh,
		reveal,
		markOpened,
		setSearch,
	};
}
