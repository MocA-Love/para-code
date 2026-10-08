// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import { countAttentionAgents, countRunningAgents, type RunningCandidate } from './attentionCount.js';
import type { WorkspaceState } from './store.js';

/**
 * PC ごとの件数（`PcSummary` の terminals・waiting・running）と、全 PC 横断の一覧（`/agents`）が読む
 * PC ごとの元（`usePcAgentSources`）を決める純関数。実体の持ち主は `appState.ts` で、ここは
 * 「何を数えるか」「いつ配り直すか」だけを持つ（appState.ts は react-native を読むので単体テストできない）。
 */

type Terminals = WorkspaceState['terminals'];
type Spaces = WorkspaceState['workspaces'];

/** PC 1台ぶんのエージェントの件数。 */
export interface PcAgentCounts {
	readonly terminals: number;
	/** 要対応（数え方は `attentionCount.ts`。アーカイブは見ない）。 */
	readonly waiting: number;
	/** 実行中（アーカイブを除く `working`）。 */
	readonly running: number;
}

/** `summarizeRuntime` の件数の部分。`archived` はその PC のアーカイブの印（保存形の配列）。 */
export function summarizeAgentCounts(terminals: readonly RunningCandidate[] | undefined, archived: readonly string[]): PcAgentCounts {
	return {
		terminals: terminals?.length ?? 0,
		waiting: countAttentionAgents(terminals),
		running: countRunningAgents(terminals, archived),
	};
}

/**
 * PC 1台ぶんの、エージェントの行を組み立てる元（全 PC 横断の一覧 `/agents` が読む）。
 * 中身は PC から届いた State の部分の参照のまま（`workspaceIdentity.ts` が中身の同じ配列の参照を据え置く）。
 */
export interface PcAgentSource {
	readonly terminals: Terminals;
	readonly spaces: Spaces;
	readonly activeWs: string | undefined;
	/** その PC のアーカイブの印（保存形のキーの配列）。 */
	readonly archived: readonly string[];
}

/** 配り直しの判定に渡す PC 1台ぶん（台帳の順）。State を受けていなければ `workspace` は undefined。 */
export interface PcAgentSourceInput {
	readonly id: string;
	readonly workspace: Pick<WorkspaceState, 'terminals' | 'workspaces' | 'activeWs'> | undefined;
	readonly archived: readonly string[];
}

/**
 * 次に配る PC ごとの元。**どの PC の参照も変わっていなければ `current` をそのまま返す**（配り直さない）。
 * 変わっていない PC の元は前回のオブジェクトを使い回すので、一覧の段（`agentsAcrossPcs.ts` のキャッシュ）も
 * その PC のぶんは描き直さない。State を受けていない PC は入れない。
 */
export function nextPcAgentSources(
	current: Readonly<Record<string, PcAgentSource>>,
	pcs: readonly PcAgentSourceInput[],
): Readonly<Record<string, PcAgentSource>> {
	const next: Record<string, PcAgentSource> = {};
	let changed = false;
	let count = 0;
	for (const { id, workspace, archived } of pcs) {
		if (workspace === undefined) {
			continue;
		}
		count++;
		const before = current[id];
		if (before !== undefined && before.terminals === workspace.terminals && before.spaces === workspace.workspaces
			&& before.activeWs === workspace.activeWs && before.archived === archived) {
			next[id] = before;
			continue;
		}
		changed = true;
		next[id] = { terminals: workspace.terminals, spaces: workspace.workspaces, activeWs: workspace.activeWs, archived };
	}
	return changed || count !== Object.keys(current).length ? next : current;
}
