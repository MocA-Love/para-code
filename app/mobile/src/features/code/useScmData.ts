// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import { useCallback, useEffect, useRef, useState } from 'react';
import { useFocusEffect } from 'expo-router';
import { PARADIS_MOBILE_SCM_COMMIT_RECOVER_CAPABILITY, type IParadisMobileCommitFailure } from '../../../../../src/vs/paradis/contrib/mobileRelay/common/paradisMobileScmSync.js';
import { sendPcRequest, useAppStore } from '../../appState.js';
import { usePcCapability } from '../../hooks/usePcCapability.js';
import type { ScmLogResult, ScmStatusResult } from '../../store.js';
import { codeCacheKey, useCodeCache } from './codeCache.js';
import { errorMessage, scmErrorText, shouldAutoRetryScmStatus } from './scmModel.js';
import { parseCommitFailure, type CommitScope } from './scmSync.js';
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
			// 返事が無かったら（接続先が応答しない・待ち時間切れ）自分で 1 回だけ取り直す。
			// 取り直している間は失敗を出さず、読み込み中のままにする
			for (let attempt = 0; ; attempt++) {
				try {
					const result = await scmStatus(wsId);
					if (current()) {
						setStatus(key, result);
						setError(undefined);
					}
					return;
				} catch (e) {
					if (!current()) {
						return;
					}
					// 取り直すのは返事が無かったときだけ（git の失敗などは取り直しても同じ）
					if (!shouldAutoRetryScmStatus(attempt, errorMessage(e))) {
						setError(scmErrorText(e));
						return;
					}
				}
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
	/** コミットはできたが、その後のフックが失敗・時間切れだった（PC からの一言）。 */
	readonly warning: string | undefined;
	/**
	 * コミットの失敗（PC が `scm.commit-recover.v1` を扱えるときだけ。要約・出力・「AI に直してもらう」の材料）。
	 * 扱えない PC の失敗は `error` に1行で入る。
	 */
	readonly failure: IParadisMobileCommitFailure | undefined;
	/**
	 * コミットする（`scope` が `all` なら `git add -A` のあとコミット、`staged` ならステージ済みだけ）。
	 * 成功したら `ok: true` と、フックの失敗・時間切れの一言（あれば）。
	 */
	readonly commit: (message: string, scope?: CommitScope) => Promise<CommitOutcome>;
	readonly clearError: () => void;
	/** コミットの失敗のカードを閉じる（次のコミットでも消える）。 */
	readonly dismissFailure: () => void;
}

export type CommitOutcome = { readonly ok: false } | { readonly ok: true; readonly warning: string | undefined };

const FAILED: CommitOutcome = { ok: false };

interface CommitSafeReply {
	readonly ok?: unknown;
	readonly output?: unknown;
	readonly warning?: unknown;
	readonly failure?: unknown;
}

export function useScmCommit(space: CodeSpace): CommitState {
	const scmCommit = useAppStore(s => s.scmCommit);
	const recoverable = usePcCapability(PARADIS_MOBILE_SCM_COMMIT_RECOVER_CAPABILITY);
	const [committing, setCommitting] = useState(false);
	const [error, setError] = useState<string | undefined>(undefined);
	const [output, setOutput] = useState<string | undefined>(undefined);
	const [warning, setWarning] = useState<string | undefined>(undefined);
	const [failure, setFailure] = useState<IParadisMobileCommitFailure | undefined>(undefined);
	const genRef = useRef(0);
	const { pcId, wsId, rendererTarget } = space;

	const commit = useCallback(async (message: string, scope: CommitScope = 'all') => {
		const text = message.trim();
		if (wsId === undefined || rendererTarget === undefined || text.length === 0 || committing) {
			return FAILED;
		}
		const gen = ++genRef.current;
		const current = () => genRef.current === gen && currentRendererTarget(wsId) === rendererTarget;
		setCommitting(true);
		setError(undefined);
		setOutput(undefined);
		setWarning(undefined);
		setFailure(undefined);
		try {
			if (!recoverable) {
				const result = await scmCommit(wsId, text, true);
				if (current()) {
					setOutput(result.output);
				}
				return current() ? { ok: true, warning: undefined } : FAILED;
			}
			// フックが動くので長めに待つ（PC 側はコミットだけで 120 秒、HEAD の確認・控え・ステージ・戻しを足した合計より長く）
			const reply = await sendPcRequest<CommitSafeReply>(pcId, 'scm', { t: 'commitSafe', ws: wsId, message: text, all: scope === 'all' }, { timeoutMs: 310_000 });
			if (!current()) {
				return FAILED;
			}
			if (reply.ok === true) {
				const warned = typeof reply.warning === 'string' && reply.warning.length > 0 ? reply.warning : undefined;
				setOutput(typeof reply.output === 'string' ? reply.output : '');
				setWarning(warned);
				return { ok: true, warning: warned };
			}
			const parsed = parseCommitFailure(reply.failure);
			if (parsed !== undefined) {
				setFailure(parsed);
			} else {
				setError('コミットに失敗しました');
			}
			return FAILED;
		} catch (e) {
			if (current()) {
				setError(errorMessage(e));
			}
			return FAILED;
		} finally {
			if (current()) {
				setCommitting(false);
			}
		}
	}, [scmCommit, recoverable, pcId, wsId, rendererTarget, committing]);

	useEffect(() => {
		// 接続が切れる・ウィンドウが作り直されると応答は届かない。押せない状態のまま残さない。
		genRef.current++;
		setCommitting(false);
	}, [rendererTarget]);

	const clearError = useCallback(() => setError(undefined), []);
	const dismissFailure = useCallback(() => setFailure(undefined), []);

	return { committing, error, output, warning, failure, commit, clearError, dismissFailure };
}
