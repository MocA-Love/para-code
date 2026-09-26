// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import { useEffect, useRef, useState } from 'react';
import { useAppStore } from '../../appState.js';
import type { FilesSearchMode } from '../../filesSearch.js';
import type { FsFindResult, FsGrepResult } from '../../store.js';
import { errorMessage } from './scmModel.js';
import { currentRendererTarget, type CodeSpace } from './useCodeSpace.js';

/** 打ち終わるのを待つ時間（ms。旧ファイルタブと同じ）。 */
const SEARCH_DEBOUNCE_MS = 300;

export interface FileSearchState {
	readonly find: FsFindResult | undefined;
	readonly grep: FsGrepResult | undefined;
	readonly searching: boolean;
	readonly error: string | undefined;
	readonly retry: () => void;
}

/**
 * スペース全体の検索（PC 側の ripgrep。旧 `src/components/filesPanel.tsx` と同じ処理）。
 *  - `name`: 全階層の相対パスに対する部分一致（.gitignore を尊重、ランク順）
 *  - `text`: 全文検索（スマートケース・リテラル一致、行のプレビュー付き）
 * 最後に出した条件の応答だけを反映する。
 */
export function useFileSearch(space: CodeSpace, query: string, mode: FilesSearchMode): FileSearchState {
	const fsFind = useAppStore(s => s.fsFind);
	const fsGrep = useAppStore(s => s.fsGrep);
	const [find, setFind] = useState<FsFindResult | undefined>(undefined);
	const [grep, setGrep] = useState<FsGrepResult | undefined>(undefined);
	const [searching, setSearching] = useState(false);
	const [error, setError] = useState<string | undefined>(undefined);
	const [attempt, setAttempt] = useState(0);
	const genRef = useRef(0);
	const { wsId, rendererTarget } = space;
	const needle = query.trim();

	useEffect(() => {
		const gen = ++genRef.current;
		setFind(undefined);
		setGrep(undefined);
		setError(undefined);
		if (needle.length === 0 || wsId === undefined || rendererTarget === undefined) {
			setSearching(false);
			return undefined;
		}
		setSearching(true);
		const current = () => genRef.current === gen && currentRendererTarget(wsId) === rendererTarget;
		const timer = setTimeout(() => {
			const request = mode === 'name'
				? fsFind(wsId, needle).then(result => { if (current()) { setFind(result); } })
				: fsGrep(wsId, needle).then(result => { if (current()) { setGrep(result); } });
			request
				.catch((e: unknown) => { if (current()) { setError(errorMessage(e)); } })
				.finally(() => { if (current()) { setSearching(false); } });
		}, SEARCH_DEBOUNCE_MS);
		return () => clearTimeout(timer);
	}, [needle, mode, wsId, rendererTarget, fsFind, fsGrep, attempt]);

	return { find, grep, searching, error, retry: () => setAttempt(count => count + 1) };
}
