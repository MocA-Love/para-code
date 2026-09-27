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
// 状態が消えた（undefined）だけでは完了にしない。画面側は状態の取得に続けて失敗すると全ペインの
// 状態を消すので、作業中の回を完了と誤って記録し、見張り（30 分の打ち切り）まで外してしまうため。
// 消える直前に見たのが review のときだけ完了とする（review を見た時点で完了にしているので、実際には
// 取りこぼしの保険）。
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

/** 状態を1つ受けて進める。 */
export function paradisAdvanceRunWatch(state: IParadisRunWatchState, status: ParadisAgentStatus | undefined): IParadisRunWatchStep {
	if (state.phase === 'completed') {
		return { state };
	}
	if (status === undefined) {
		// 状態が消えた: 取得の失敗でも起きるので、直前が review のときだけ完了にする
		return state.lastStatus === 'review' ? { state: { ...state, phase: 'completed' }, report: 'completed' } : { state };
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
