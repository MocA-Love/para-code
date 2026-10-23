/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

// タブに人の確認（Cloudflare）が出ているかを main で調べる（決め事は common/paradisBrowserHumanCheck.ts）。
// 先にフレームの一覧だけを見て、Cloudflare の枠が無ければページの中の関数は動かさない（ほとんどの呼び出しはここで終わる）。

import type { WebFrameMain } from 'electron';
import { raceTimeout } from '../../../../base/common/async.js';
import { PARADIS_HUMAN_CHECK_FRAME_ORIGIN, PARADIS_HUMAN_CHECK_GRACE_MS, PARADIS_HUMAN_CHECK_PAGE_PROBE, ParadisHumanCheckObservation, paradisClassifyHumanCheckProbe } from '../common/paradisBrowserHumanCheck.js';

/** ページの中の関数を動かす isolated world。upstream の preload（999）や Client Hints の読み取り（1437）とは別。 */
const HUMAN_CHECK_WORLD_ID = 1438;
/** ページが答えないときに諦めるまでの時間。 */
const PROBE_TIMEOUT_MS = 1_000;

/** テストで差し替える部分。 */
export interface IParadisHumanCheckTarget {
	isDestroyed(): boolean;
	isLoading(): boolean;
	readonly mainFrame: { readonly framesInSubtree: readonly Pick<WebFrameMain, 'origin'>[] };
	/** メインフレームの isolated world で動かす（WebContents の同名のメソッド）。 */
	executeJavaScriptInIsolatedWorld(worldId: number, scripts: { code: string }[]): Promise<unknown>;
}

function hasCheckFrame(target: IParadisHumanCheckTarget): boolean {
	try {
		return target.mainFrame.framesInSubtree.some(frame => {
			try {
				return frame.origin === PARADIS_HUMAN_CHECK_FRAME_ORIGIN;
			} catch {
				return false; // 破棄された枠
			}
		});
	} catch {
		return false;
	}
}

async function probe(target: IParadisHumanCheckTarget): Promise<ParadisHumanCheckObservation> {
	if (target.isDestroyed()) {
		return { state: 'unknown' };
	}
	if (!hasCheckFrame(target)) {
		// 読み込みの途中は枠がまだ・もう無いだけかもしれない
		return target.isLoading() ? { state: 'unknown' } : { state: 'none' };
	}
	try {
		const value = await raceTimeout(target.executeJavaScriptInIsolatedWorld(HUMAN_CHECK_WORLD_ID, [{ code: PARADIS_HUMAN_CHECK_PAGE_PROBE }]), PROBE_TIMEOUT_MS);
		return paradisClassifyHumanCheckProbe(value); // 時間切れ（undefined）は unknown
	} catch {
		return { state: 'unknown' }; // 遷移の途中など。次で見直す
	}
}

/**
 * タブの人の確認の様子を見る。確認が新しく見つかったときだけ {@link PARADIS_HUMAN_CHECK_GRACE_MS} 待って見直し、
 * 自動で通る途中の確認は知らせない。`alreadyReported` のとき（同じタブで既に知らせた確認の続き）は待たずに
 * 1 回だけ見る。見られなかったときは unknown（呼ぶ側は状態を変えない）。
 */
export async function paradisDetectHumanCheck(target: IParadisHumanCheckTarget, alreadyReported: boolean, delay: (ms: number) => Promise<void> = ms => new Promise(resolve => setTimeout(resolve, ms))): Promise<ParadisHumanCheckObservation> {
	const first = await probe(target);
	if (first.state !== 'check' || alreadyReported) {
		return first;
	}
	await delay(PARADIS_HUMAN_CHECK_GRACE_MS);
	// 見直しで見られなかったら unknown（まだ確かめられていないので知らせない。次の道具で見直す）
	return probe(target);
}
