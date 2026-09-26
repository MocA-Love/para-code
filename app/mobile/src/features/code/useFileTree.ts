// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import { useCallback, useEffect, useRef, useState } from 'react';
import { useAppStore } from '../../appState.js';
import { ancestorPaths, dirState, flattenTree, needsLoad, type DirCache, type TreeRow } from './fileTree.js';
import { errorMessage } from './scmModel.js';
import { currentRendererTarget, type CodeSpace } from './useCodeSpace.js';

export interface FileTreeState {
	readonly rows: readonly TreeRow[];
	/** 根のフォルダの状態（まだ読めていない・失敗）。 */
	readonly root: { readonly loaded: boolean; readonly loading: boolean; readonly error: string | undefined; readonly empty: boolean };
	readonly expanded: ReadonlySet<string>;
	/** 目印を付けたフォルダ（パンくずから戻ったときなど）。 */
	readonly highlighted: string | undefined;
	readonly refreshing: boolean;
	readonly toggle: (path: string) => void;
	readonly retry: (path: string) => void;
	readonly refresh: () => void;
	/** そのフォルダまでを開いて目印を付ける。 */
	readonly reveal: (path: string) => void;
}

/**
 * ファイルのツリー（Orca の MobileFileExplorerPanel の読み込み）。フォルダを開いたときに1階層ずつ読み、
 * 読んだ結果は画面を開いている間持つ。接続し直したときは、開いているフォルダを静かに読み直す
 * （読み終わるまで前回の一覧を出しておく）。
 */
export function useFileTree(space: CodeSpace, initialReveal: string | undefined): FileTreeState {
	const fsList = useAppStore(s => s.fsList);
	const [cache, setCache] = useState<DirCache>({});
	const [expanded, setExpanded] = useState<ReadonlySet<string>>(() => new Set(initialReveal !== undefined ? ancestorPaths(initialReveal) : []));
	const [highlighted, setHighlighted] = useState<string | undefined>(initialReveal);
	const [refreshing, setRefreshing] = useState(false);
	const cacheRef = useRef(cache);
	cacheRef.current = cache;
	const expandedRef = useRef(expanded);
	expandedRef.current = expanded;
	/** フォルダごとの要求の世代（古い応答で新しい結果を上書きしない）。 */
	const gensRef = useRef(new Map<string, number>());
	const { wsId, rendererTarget } = space;

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
	}, [fsList, wsId, rendererTarget]);

	// つながったとき（つながり直したとき）に、根と開いているフォルダを読む。
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
	}, [rendererTarget, load]);

	const toggle = useCallback((path: string) => {
		setHighlighted(undefined);
		const opening = !expandedRef.current.has(path);
		setExpanded(previous => {
			const next = new Set(previous);
			if (opening) {
				next.add(path);
			} else {
				next.delete(path);
			}
			return next;
		});
		if (opening && needsLoad(cacheRef.current, path)) {
			void load(path);
		}
	}, [load]);

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
		setExpanded(previous => new Set([...previous, ...chain]));
		setHighlighted(path.length > 0 ? path : undefined);
		for (const dir of chain) {
			if (needsLoad(cacheRef.current, dir)) {
				void load(dir);
			}
		}
	}, [load]);

	const rootState = dirState(cache, '');
	return {
		rows: flattenTree(cache, expanded),
		root: {
			loaded: rootState?.entries !== undefined,
			loading: rootState?.loading === true,
			error: rootState?.error,
			empty: rootState?.entries !== undefined && rootState.entries.length === 0,
		},
		expanded,
		highlighted,
		refreshing,
		toggle,
		retry,
		refresh,
		reveal,
	};
}
