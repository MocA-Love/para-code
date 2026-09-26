// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import { nextAttentionAgent } from '../../agentConversationUx.js';
import type { WorkspaceState } from '../../store.js';

/** 中継の画面（`/open-session`）がどこへ置き換えるか。 */
export type OpenSessionTarget =
	/** 台帳や PC の状態がまだ揃っていない。 */
	| { readonly kind: 'wait' }
	/** 開く先が無い（ペアリングしていない・要対応が無い）。 */
	| { readonly kind: 'home' }
	/** 要対応のエージェントはいるが、スペースが分からない。PC の画面で探してもらう。 */
	| { readonly kind: 'pc'; readonly pcId: string }
	| { readonly kind: 'session'; readonly pcId: string; readonly spaceId: string; readonly terminalKey: string };

/**
 * Live Activity（旧 `/agent`）から開いたときの行き先。いま見ている PC の要対応のエージェント
 * （ホームの要対応と同じ並びの先頭、`nextAttentionAgent`）のセッションを開く。要対応が無ければホーム。
 *
 * PC の状態（`workspace`）は起動直後には届いていないので、`complete` になるまで待つ
 * （通知のタップと同じ考え方。`notificationNavigationDecision`）。
 */
export function openSessionTarget(input: {
	readonly ready: boolean;
	readonly pcCount: number;
	readonly activePcId: string | undefined;
	readonly workspace: Pick<WorkspaceState, 'complete' | 'terminals' | 'activeWs'> | undefined;
}): OpenSessionTarget {
	if (!input.ready) {
		return { kind: 'wait' };
	}
	if (input.pcCount === 0 || input.activePcId === undefined) {
		return { kind: 'home' };
	}
	if (input.workspace === undefined || input.workspace.complete !== true) {
		return { kind: 'wait' };
	}
	const next = nextAttentionAgent(input.workspace.terminals, undefined).next;
	if (next === undefined) {
		return { kind: 'home' };
	}
	const spaceId = next.ws ?? input.workspace.activeWs;
	return spaceId === undefined
		? { kind: 'pc', pcId: input.activePcId }
		: { kind: 'session', pcId: input.activePcId, spaceId, terminalKey: next.terminalKey };
}
