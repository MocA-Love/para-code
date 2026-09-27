/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

// 起動したエージェントの状態（ペイン単位）から、定期実行の1回分の進み具合を決める。
//
// 状態はエージェントの hook から来る（working = 実行中、permission / question = 回答待ち、
// review = ターンが終わった）。定期実行は「最初の依頼を1ターン処理し終えた」ら完了とみなす。
// review はそのスペースを開くと消える（idle になる）ので、working を見た後に状態が消えたときも
// 完了とみなす。

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
		// 状態が消えた: 1 度でも何か見ていれば、終わった後に確認されたもの
		return state.sawStatus ? { state: { ...state, phase: 'completed' }, report: 'completed' } : { state };
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
