// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import { useAppStore } from '../appState.js';
import { countAttentionAgents } from '../attentionCount.js';

/**
 * いま見ているPCの要対応の件数（数え方は `attentionCount.ts`）。
 *
 * **件数（数値）だけを購読する。** `workspace` 本体を購読すると、PCからのstate再送（最大10Hz）の
 * たびにタブバーやドロワーごと再レンダーされる。数値なら件数が変わらない再送では止まる。
 */
export function useAttentionCount(): number {
	return useAppStore(s => countAttentionAgents(s.workspace?.terminals));
}
