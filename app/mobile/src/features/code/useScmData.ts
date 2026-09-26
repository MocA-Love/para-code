// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import { useCallback, useEffect, useRef, useState } from 'react';
import { useFocusEffect } from 'expo-router';
import { useAppStore } from '../../appState.js';
import type { ScmLogResult, ScmStatusResult } from '../../store.js';
import { codeCacheKey, useCodeCache } from './codeCache.js';
import { errorMessage } from './scmModel.js';
import { currentRendererTarget, type CodeSpace } from './useCodeSpace.js';

/**
 * ソース管理の読み込みと操作（旧画面 `legacy-screens/(tabs)/scm.tsx` の処理を画面から切り出したもの）。
 *
 * 応答の取り違えを防ぐ約束は旧画面と同じ: 要求ごとに世代を振り、応答が返ったときに
 * 「世代が最新」かつ「PC 側のウィンドウが要求を出したときと同じ」でなければ捨てる。
 */

export interface ScmStatusState {
	/** 最後に読めた一覧（差分レビューと共有。まだ読めていなければ undefined）。 */
	readonly status: ScmStatusResult | undefined;
	readonly error: string | undefined;
	readonly loading: boolean;
	readonly refresh: () => Promise<void>;
}

/** 変更の一覧。画面が前面に来るたびと、PC 側のウィンドウがつながり直したときに読み直す。 */
export function useScmStatus(space: CodeSpace): ScmStatusState {
	const scmStatus = useAppStore(s => s.scmStatus);
	const key = codeCacheKey(space.pcId, space.spaceId);
	const status = useCodeCache(s => s.status[key]);
	const setStatus = useCodeCache(s => s.setStatus);
	const [error, setError] = useState<string | undefined>(undefined);
	const [loading, setLoading] = useState(false);
	const genRef = useRef(0);
	const { wsId, rendererTarget } = space;

	const refresh = useCallback(async () => {
		if (wsId === undefined || rendererTarget === undefined) {
			return;
		}
		const gen = ++genRef.current;
		const current = () => genRef.current === gen && currentRendererTarget(wsId) === rendererTarget;
		setLoading(true);
		try {
			const result = await scmStatus(wsId);
			if (current()) {
				setStatus(key, result);
				setError(undefined);
			}
		} catch (e) {
			if (current()) {
				setError(errorMessage(e));
			}
		} finally {
			if (current()) {
				setLoading(false);
			}
		}
	}, [scmStatus, wsId, rendererTarget, key, setStatus]);

	useFocusEffect(useCallback(() => {
		void refresh();
	}, [refresh]));

	useEffect(() => {
		if (rendererTarget === undefined) {
			genRef.current++;
			setLoading(false);
		}
	}, [rendererTarget]);

	return { status, error, loading, refresh };
}

const LOG_PAGE = 10;

export interface CommitFiles {
	readonly files?: readonly { readonly status: string; readonly path: string }[];
	readonly error?: string;
}

export interface ScmHistoryState {
	readonly log: ScmLogResult | undefined;
	readonly error: string | undefined;
	readonly loadingMore: boolean;
	readonly refresh: () => Promise<void>;
	readonly loadMore: () => Promise<void>;
	/** コミットごとの変更ファイル（開いたときに初めて読む）。 */
	readonly commitFiles: Readonly<Record<string, CommitFiles>>;
	readonly loadCommitFiles: (hash: string) => void;
}

/** 最近のコミット（ブランチのカードの「最新のコミット」と、コミットの区分）。 */
export function useScmHistory(space: CodeSpace): ScmHistoryState {
	const scmLog = useAppStore(s => s.scmLog);
	const scmCommitFiles = useAppStore(s => s.scmCommitFiles);
	const [log, setLog] = useState<ScmLogResult | undefined>(undefined);
	const [error, setError] = useState<string | undefined>(undefined);
	const [loadingMore, setLoadingMore] = useState(false);
	const [commitFiles, setCommitFiles] = useState<Record<string, CommitFiles>>({});
	const genRef = useRef(0);
	const { wsId, rendererTarget } = space;

	const refresh = useCallback(async () => {
		if (wsId === undefined || rendererTarget === undefined) {
			return;
		}
		const gen = ++genRef.current;
		const current = () => genRef.current === gen && currentRendererTarget(wsId) === rendererTarget;
		setLoadingMore(false);
		try {
			const result = await scmLog(wsId, { limit: LOG_PAGE });
			if (current()) {
				setLog(result);
				setError(undefined);
			}
		} catch (e) {
			if (current()) {
				setError(errorMessage(e));
			}
		}
	}, [scmLog, wsId, rendererTarget]);

	const loadMore = useCallback(async () => {
		if (wsId === undefined || rendererTarget === undefined || log === undefined || loadingMore) {
			return;
		}
		const gen = genRef.current;
		const current = () => genRef.current === gen && currentRendererTarget(wsId) === rendererTarget;
		setLoadingMore(true);
		try {
			const more = await scmLog(wsId, { limit: LOG_PAGE, skip: log.commits.length });
			if (current()) {
				// 読み足す合間に新しいコミットが積まれると同じ hash が再来しうるので除く。
				const seen = new Set(log.commits.map(commit => commit.hash));
				setLog({ ...log, commits: [...log.commits, ...more.commits.filter(commit => !seen.has(commit.hash))], hasMore: more.hasMore });
			}
		} catch (e) {
			if (current()) {
				setError(errorMessage(e));
			}
		} finally {
			if (current()) {
				setLoadingMore(false);
			}
		}
	}, [scmLog, wsId, rendererTarget, log, loadingMore]);

	const loadCommitFiles = useCallback((hash: string) => {
		if (wsId === undefined || rendererTarget === undefined || commitFiles[hash]?.files !== undefined) {
			return;
		}
		const target = rendererTarget;
		setCommitFiles(previous => ({ ...previous, [hash]: {} }));
		scmCommitFiles(wsId, hash)
			.then(result => {
				if (currentRendererTarget(wsId) === target) {
					setCommitFiles(previous => ({ ...previous, [hash]: { files: result.files } }));
				}
			})
			.catch((e: unknown) => {
				if (currentRendererTarget(wsId) === target) {
					setCommitFiles(previous => ({ ...previous, [hash]: { error: errorMessage(e) } }));
				}
			});
	}, [scmCommitFiles, wsId, rendererTarget, commitFiles]);

	useFocusEffect(useCallback(() => {
		void refresh();
	}, [refresh]));

	useEffect(() => {
		if (rendererTarget === undefined) {
			genRef.current++;
			setLoadingMore(false);
		}
	}, [rendererTarget]);

	return { log, error, loadingMore, refresh, loadMore, commitFiles, loadCommitFiles };
}

export interface CommitState {
	readonly committing: boolean;
	readonly error: string | undefined;
	/** PC の出力（成功したとき）。 */
	readonly output: string | undefined;
	/** すべての変更をまとめてコミットする（`git add -A` のあとコミット）。成功したら true。 */
	readonly commit: (message: string) => Promise<boolean>;
	readonly clearError: () => void;
}

export function useScmCommit(space: CodeSpace): CommitState {
	const scmCommit = useAppStore(s => s.scmCommit);
	const [committing, setCommitting] = useState(false);
	const [error, setError] = useState<string | undefined>(undefined);
	const [output, setOutput] = useState<string | undefined>(undefined);
	const genRef = useRef(0);
	const { wsId, rendererTarget } = space;

	const commit = useCallback(async (message: string) => {
		const text = message.trim();
		if (wsId === undefined || rendererTarget === undefined || text.length === 0 || committing) {
			return false;
		}
		const gen = ++genRef.current;
		const current = () => genRef.current === gen && currentRendererTarget(wsId) === rendererTarget;
		setCommitting(true);
		setError(undefined);
		setOutput(undefined);
		try {
			const result = await scmCommit(wsId, text, true);
			if (current()) {
				setOutput(result.output);
			}
			return current();
		} catch (e) {
			if (current()) {
				setError(errorMessage(e));
			}
			return false;
		} finally {
			if (current()) {
				setCommitting(false);
			}
		}
	}, [scmCommit, wsId, rendererTarget, committing]);

	useEffect(() => {
		// 接続が切れる・ウィンドウが作り直されると応答は届かない。押せない状態のまま残さない。
		genRef.current++;
		setCommitting(false);
	}, [rendererTarget]);

	const clearError = useCallback(() => setError(undefined), []);

	return { committing, error, output, commit, clearError };
}
