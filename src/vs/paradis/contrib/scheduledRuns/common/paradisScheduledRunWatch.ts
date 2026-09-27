/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

// 起動したエージェントの状態（ペイン単位）から、定期実行の1回分の進み具合を決める。
//
// 状態はエージェントの hook から来る（working = 実行中、permission / question = 回答待ち、
// review = ターンが終わった）。定期実行は「最初の依頼を1ターン処理し終えた」＝ review を見たら
// 完了とみなす。
//
// 利用者がそのスペースを見ているときは、画面側が review をその場で既読にして状態から消すので、
// 見張りには review が一度も見えない。そのため「既読にして消した」（`acknowledged`）ときも完了とする。
// 一方、画面側は状態の取得に続けて失敗しても全ペインの状態を消す。こちらは完了ではないので、
// 既読の印が無く状態が消えただけでは完了にしない（作業中の回を完了と記録し、見張りを外さないため）。
//
// MCP の待機（agentIde の `ParadisAgentStopWatcher`）とは規則が違う。あちらは「相手の番が終わったか」
// を見るので許可待ち・質問中も止まったとみなすが、こちらは許可待ちを「要対応」として見張り続ける。

import { ParadisAgentStatus } from '../../agentBrowser/common/paradisAgentBrowser.js';
import { ParadisScheduledRunReason } from './paradisScheduledRuns.js';

export interface IParadisRunWatchState {
	readonly phase: 'running' | 'needsAttention' | 'completed';
	/** 状態が1度でも届いたか。 */
	readonly sawStatus: boolean;
	/** 最後に見た状態。 */
	readonly lastStatus?: ParadisAgentStatus;
}

export const PARADIS_RUN_WATCH_INITIAL: IParadisRunWatchState = { phase: 'running', sawStatus: false };

export interface IParadisRunWatchStep {
	readonly state: IParadisRunWatchState;
	/** shared process へ報告する状態の変化（変わらなければ undefined）。 */
	readonly report?: 'running' | 'needsAttention' | 'completed';
}

/**
 * 状態を1つ受けて進める。`acknowledged` は、画面側がこのペインの review を既読にして状態から
 * 外したか（`IParadisAgentStatusStore.wasReviewAcknowledged`）。
 */
export function paradisAdvanceRunWatch(state: IParadisRunWatchState, status: ParadisAgentStatus | undefined, acknowledged = false): IParadisRunWatchStep {
	if (state.phase === 'completed') {
		return { state };
	}
	if (status === undefined) {
		// 状態が消えた: 既読にして消した（または直前が review）なら完了。取得の失敗で消えただけなら待つ
		return acknowledged || state.lastStatus === 'review' ? { state: { ...state, sawStatus: true, phase: 'completed' }, report: 'completed' } : { state };
	}
	const next: IParadisRunWatchState = { phase: state.phase, sawStatus: true, lastStatus: status };
	switch (status) {
		case 'working':
			return state.phase === 'needsAttention'
				? { state: { ...next, phase: 'running' }, report: 'running' }
				: { state: next };
		case 'permission':
		case 'question':
			return state.phase === 'needsAttention'
				? { state: next }
				: { state: { ...next, phase: 'needsAttention' }, report: 'needsAttention' };
		case 'review':
			return { state: { ...next, phase: 'completed' }, report: 'completed' };
	}
}

/** 制限時間で打ち切ったときの理由。 */
export function paradisRunWatchTimeoutReason(state: IParadisRunWatchState): ParadisScheduledRunReason {
	if (!state.sawStatus) {
		return 'timeoutNoStatus';
	}
	return state.phase === 'needsAttention' ? 'timeoutWhileWaiting' : 'timeout';
}
