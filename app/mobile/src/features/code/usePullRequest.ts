// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import { useCallback, useEffect, useRef, useState } from 'react';
import { useFocusEffect } from 'expo-router';
import {
	PARADIS_MOBILE_PR_MERGE_CAPABILITY,
	PARADIS_MOBILE_PR_VIEW_CAPABILITY,
} from '../../../../../src/vs/paradis/contrib/mobileRelay/common/paradisMobilePullRequest.js';
import { sendPcRequest } from '../../appState.js';
import { usePcCapability } from '../../hooks/usePcCapability.js';
import { PR_POLL_MS, parsePrView, type PrDetail, type PrViewResult } from './pullRequest.js';
import { errorMessage } from './scmModel.js';
import { currentRendererTarget, type CodeSpace } from './useCodeSpace.js';

/**
 * スペースのプルリクエスト（Orca W2-36、`pr.view.v1` / `pr.merge.v1`）。PR の区分を開いていて（`active`）、
 * 画面が前面にある間だけ PC に取りに行き、{@link PR_POLL_MS} ごとに取り直す（GitHub の制限に触れないため。
 * PC 側の 5 分ごとの取得とは別）。
 */
export interface PullRequestController {
	readonly enabled: boolean;
	readonly canMerge: boolean;
	readonly view: PrViewResult | undefined;
	readonly loading: boolean;
	/** 読み直しの失敗（前回の結果は出したまま）。 */
	readonly error: string | undefined;
	readonly refresh: () => Promise<void>;
	readonly merging: boolean;
	/** マージの失敗（画面の中に出す）。 */
	readonly mergeError: string | undefined;
	/** 見た時点の head でマージする。できたら true。 */
	readonly merge: (pr: PrDetail) => Promise<boolean>;
}

export function usePullRequest(space: CodeSpace, active: boolean): PullRequestController {
	const enabled = usePcCapability(PARADIS_MOBILE_PR_VIEW_CAPABILITY);
	const canMerge = usePcCapability(PARADIS_MOBILE_PR_MERGE_CAPABILITY);
	const [view, setView] = useState<PrViewResult | undefined>(undefined);
	const [loading, setLoading] = useState(false);
	const [error, setError] = useState<string | undefined>(undefined);
	const [merging, setMerging] = useState(false);
	const [mergeError, setMergeError] = useState<string | undefined>(undefined);
	const genRef = useRef(0);
	const { pcId, wsId, rendererTarget } = space;

	const refresh = useCallback(async () => {
		if (!enabled || wsId === undefined || rendererTarget === undefined) {
			return;
		}
		const gen = ++genRef.current;
		const current = () => genRef.current === gen && currentRendererTarget(wsId) === rendererTarget;
		setLoading(true);
		try {
			// gh は PC 側で 15 秒で打ち切る
			const reply = await sendPcRequest<{ readonly pr?: unknown; readonly unavailable?: unknown; readonly message?: unknown }>(pcId, 'scm', { t: 'prView', ws: wsId }, { timeoutMs: 40_000 });
			if (current()) {
				setView(parsePrView(reply));
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
	}, [enabled, pcId, wsId, rendererTarget]);

	// スペースが変わったら前のスペースの PR を出さない
	useEffect(() => {
		genRef.current++;
		setView(undefined);
		setError(undefined);
		setMergeError(undefined);
		setLoading(false);
	}, [wsId]);

	useFocusEffect(useCallback(() => {
		if (!active) {
			return undefined;
		}
		void refresh();
		const timer = setInterval(() => { void refresh(); }, PR_POLL_MS);
		return () => clearInterval(timer);
	}, [active, refresh]));

	const merge = useCallback(async (pr: PrDetail) => {
		if (!canMerge || wsId === undefined || merging) {
			return false;
		}
		setMerging(true);
		setMergeError(undefined);
		try {
			await sendPcRequest(pcId, 'scm', { t: 'prMerge', ws: wsId, number: pr.number, headSha: pr.headSha }, { timeoutMs: 90_000 });
			return true;
		} catch (e) {
			setMergeError(errorMessage(e));
			return false;
		} finally {
			setMerging(false);
			void refresh();
		}
	}, [canMerge, pcId, wsId, merging, refresh]);

	return { enabled, canMerge, view, loading, error, refresh, merging, mergeError, merge };
}
