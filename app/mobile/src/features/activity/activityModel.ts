// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import { flattenAgentActivity, isRunningAgentActivity, partitionRecentAgentActivity, type AgentActivityTreeRow } from '../../agentActivityTree.js';
import type { AgentActivityAgent, AgentActivityState } from '../../store.js';

/**
 * サブエージェントとタスクの画面の組み立て（旧画面 `legacy-screens/agent-activity.tsx` の処理を
 * 画面から切り出した純関数）。木の組み立て・24 時間より前の履歴の畳み込みは既存の
 * `agentActivityTree.ts` を使う。
 */

/** 経過時間の表記（「12秒」「3分4秒」）。 */
export function formatActivityDuration(startedAt: number, endAt: number): string {
	const seconds = Math.max(0, Math.round((endAt - startedAt) / 1000));
	return seconds < 60 ? `${seconds}秒` : `${Math.floor(seconds / 60)}分${seconds % 60}秒`;
}

/** 経過時間の終わり。まだ動いている（実行中・待機）なら今、終わっていれば最後の更新。 */
export function activityEndAt(agent: Pick<AgentActivityAgent, 'status' | 'updatedAt'>, now: number): number {
	return agent.status === 'running' || agent.status === 'idle' ? now : agent.updatedAt;
}

/**
 * サブエージェント・タスク・Advisor への相談の記録が1件でもあるか（⋯ に入口を出すか）。Advisor しか無い会話でも出す。
 */
export function hasAgentActivity(activity: AgentActivityState | undefined): activity is AgentActivityState {
	return activity !== undefined && (activity.agents.length > 0 || activity.tasks.length > 0 || (activity.advisors?.length ?? 0) > 0);
}

/** ⋯ の「サブエージェント」の補足（「実行中 1 · エージェント 3 · タスク 2」。相談があれば「アドバイザー 2」も）。 */
export function activityMenuHint(activity: AgentActivityState): string {
	const advisors = activity.advisors ?? [];
	const running = activity.agents.filter(agent => isRunningAgentActivity(agent.status)).length
		+ activity.tasks.filter(task => isRunningAgentActivity(task.status)).length
		+ advisors.filter(advisor => advisor.status === 'running').length;
	const parts = [`エージェント ${activity.agents.length}`, ...(advisors.length > 0 ? [`アドバイザー ${advisors.length}`] : []), `タスク ${activity.tasks.length}`];
	return running > 0 ? [`実行中 ${running}`, ...parts].join(' · ') : parts.join(' · ');
}

export interface ActivityOverview {
	/** 実行中のエージェントの数。 */
	readonly running: number;
	/** 表示するエージェント（木の順。depth は 1 始まり）。 */
	readonly rows: readonly AgentActivityTreeRow[];
	/** 畳んでいる古い履歴の件数（0 なら「過去の履歴」を出さない）。 */
	readonly olderCount: number;
}

/**
 * エージェントの一覧。24 時間より前の履歴は `expanded` になるまで畳む（旧画面と同じ）。
 * 古い履歴しか無いときは「過去の履歴」の行だけになる。
 */
export function activityOverview(activity: AgentActivityState, now: number, expanded: boolean): ActivityOverview {
	const { recent, older } = partitionRecentAgentActivity(activity.agents, now);
	const visible = expanded || older.length === 0 ? activity.agents : recent;
	return {
		running: activity.agents.filter(agent => isRunningAgentActivity(agent.status)).length + (activity.advisors ?? []).filter(advisor => advisor.status === 'running').length,
		rows: flattenAgentActivity(visible),
		olderCount: older.length,
	};
}
