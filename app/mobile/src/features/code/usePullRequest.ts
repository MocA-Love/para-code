// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import { useCallback, useEffect, useRef, useState } from 'react';
import { useFocusEffect } from 'expo-router';
import {
	PARADIS_MOBILE_PR_MERGE_CAPABILITY,
	PARADIS_MOBILE_PR_VIEW_CAPABILITY,
} from '../../../../../src/vs/paradis/contrib/mobileRelay/common/paradisMobilePullRequest.js';
import { sendPcRequest } from '../../appState.js';
import { haptic } from '../../haptics.js';
import { usePcCapability } from '../../hooks/usePcCapability.js';
import { useNow } from '../../time.js';
import { PR_POLL_MS, activePrQueued, startPrPolling, parsePrMergeReply, parsePrView, type PrDetail, type PrMergeOutcome, type PrQueued, type PrViewResult } from './pullRequest.js';
import { errorMessage, scmErrorText } from './scmModel.js';
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
	/** 手で読み直す（マージキューの印も外す。キューから外された PR をマージし直せるように）。 */
	readonly reload: () => Promise<void>;
	readonly merging: boolean;
	/** マージの失敗（画面の中に出す）。 */
	readonly mergeError: string | undefined;
	/** 見た時点の head でマージする。できたら結果（マージした・マージキューに入れた）、できなければ undefined。 */
	readonly merge: (pr: PrDetail) => Promise<PrMergeOutcome | undefined>;
	/** このスマホからマージキューに入れた PR（入れていない・10 分を過ぎた・手で読み直したなら undefined）。 */
	readonly queued: PrQueued | undefined;
}

export function usePullRequest(space: CodeSpace, active: boolean): PullRequestController {
	const enabled = usePcCapability(PARADIS_MOBILE_PR_VIEW_CAPABILITY);
	const canMerge = usePcCapability(PARADIS_MOBILE_PR_MERGE_CAPABILITY);
	const [view, setView] = useState<PrViewResult | undefined>(undefined);
	const [loading, setLoading] = useState(false);
	const [error, setError] = useState<string | undefined>(undefined);
	const [merging, setMerging] = useState(false);
	const [mergeError, setMergeError] = useState<string | undefined>(undefined);
	const [queued, setQueued] = useState<PrQueued | undefined>(undefined);
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
			// PC 側は git（30 秒）と gh（15 秒）を続けて待つが、50 秒で打ち切って「接続先が応答しません」を返す
			const reply = await sendPcRequest<{ readonly pr?: unknown; readonly unavailable?: unknown; readonly message?: unknown }>(pcId, 'scm', { t: 'prView', ws: wsId }, { timeoutMs: 60_000 });
			if (current()) {
				setView(parsePrView(reply));
				setError(undefined);
			}
		} catch (e) {
			if (current()) {
				// 前に読めた PR（view）は出したまま、失敗だけを出す（時間切れのたびに表示が消えたり出たりしない）
				setError(scmErrorText(e));
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
		setQueued(undefined);
		setLoading(false);
	}, [wsId]);

	useFocusEffect(useCallback(() => {
		if (!active) {
			return undefined;
		}
		// 前の要求が終わってから次を出す（PC の応答が間隔より遅くても、届いた応答を次の要求で捨てない）
		return startPrPolling(refresh, PR_POLL_MS);
	}, [active, refresh]));

	const merge = useCallback(async (pr: PrDetail) => {
		if (!canMerge || wsId === undefined || merging) {
			return undefined;
		}
		setMerging(true);
		setMergeError(undefined);
		// 結果の触覚は、まだ同じスペースを見ているときだけ返す（別のスペースへ移った後に鳴らさない。useScmSync と同じ）
		const sameTarget = () => rendererTarget !== undefined && currentRendererTarget(wsId) === rendererTarget;
		try {
			const reply = await sendPcRequest<{ readonly queued?: unknown }>(pcId, 'scm', { t: 'prMerge', ws: wsId, number: pr.number, headSha: pr.headSha }, { timeoutMs: 130_000 });
			const outcome = parsePrMergeReply(reply);
			setQueued(outcome === 'queued' ? { number: pr.number, headSha: pr.headSha, at: Date.now() } : undefined);
			if (sameTarget()) {
				haptic('success');
			}
			return outcome;
		} catch (e) {
			if (sameTarget()) {
				haptic('error');
			}
			setMergeError(errorMessage(e));
			return undefined;
		} finally {
			setMerging(false);
			void refresh();
		}
	}, [canMerge, pcId, wsId, rendererTarget, merging, refresh]);

	const reload = useCallback(async () => {
		setQueued(undefined);
		await refresh();
	}, [refresh]);

	const now = useNow();
	return { enabled, canMerge, view, loading, error, refresh, reload, merging, mergeError, merge, queued: activePrQueued(queued, now) };
}
