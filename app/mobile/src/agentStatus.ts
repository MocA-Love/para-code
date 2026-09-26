// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import type { AgentActivityStatus } from './store.js';
import { status, type StatusKey, type ThemeColor } from './theme.js';

/**
 * エージェントの状態の判定と呼び名。ホームの行・バッジ・ドロワー・PC切替・ターミナル切替・
 * 通知まで、同じ状態を同じ語と色で出すための一箇所。
 *
 * PC から届く `agentStatus` は 'permission' | 'question' | 'working' | その他（作業を終えた
 * 未確認の状態）| undefined（エージェントが動いていない）。
 */
export function agentStatusKind(agentStatus: string | undefined): StatusKey {
	if (agentStatus === 'permission' || agentStatus === 'question') {
		return 'attention';
	}
	if (agentStatus === 'working') {
		return 'running';
	}
	return agentStatus === undefined ? 'idle' : 'review';
}

/**
 * 行やバッジに出す呼び名。要対応のうち、何を待っているかが分かるものは具体的に書く
 * （見出しや件数は総称の「要対応」、1件ごとの札は「許可待ち」「質問」）。
 */
export function agentStatusLabel(agentStatus: string | undefined): string {
	if (agentStatus === 'permission') {
		return '許可待ち';
	}
	if (agentStatus === 'question') {
		return '質問';
	}
	return status[agentStatusKind(agentStatus)].label;
}

export function agentStatusColor(agentStatus: string | undefined): ThemeColor {
	return status[agentStatusKind(agentStatus)].color;
}

/** サブエージェント・タスクの状態の種類。完了は「確認待ち」ではないので review の色だけ借りる。 */
export function activityStatusKind(activityStatus: AgentActivityStatus): StatusKey {
	switch (activityStatus) {
		case 'running': return 'running';
		case 'completed': return 'review';
		case 'failed': return 'error';
		default: return 'idle';
	}
}

export function activityStatusLabel(activityStatus: AgentActivityStatus): string {
	switch (activityStatus) {
		case 'running': return '実行中';
		case 'idle': return '待機';
		case 'completed': return '完了';
		case 'failed': return '失敗';
		case 'interrupted': return '中断';
		case 'unknown': return '状態不明';
	}
}

export function activityStatusColor(activityStatus: AgentActivityStatus): ThemeColor {
	return status[activityStatusKind(activityStatus)].color;
}
