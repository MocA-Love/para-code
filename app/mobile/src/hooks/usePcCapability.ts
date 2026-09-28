// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import { useAppStore } from '../appState.js';
import { pcHasCapability } from '../pcCompat.js';

/**
 * いま見ている PC がその機能（capability。例 `scm.push.v1`）を持っているか。
 *
 * PC にまだ無い機能のボタンは、これが false のあいだ出さない（押しても古い PC は答えない）。
 * 広告の無い古い PC は false。切断中は最後に届いた State の広告のまま（同じ PC なら同じ機能）。
 * いま見ていない PC を調べるときは `pcHasCapabilityFor(pcId, name)`（appState.ts）を使う。
 */
export function usePcCapability(name: string): boolean {
	return useAppStore(s => pcHasCapability(s.workspace, name));
}
