// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import type { WorkspaceState } from './store.js';
import { spaceIdOfTerminal } from './navigationTargets.js';
import { routes, type RouteHref } from './routes.js';

export type NotificationNavigationDecision = 'wait' | 'open' | 'missing';

/** 不完全なmulti-window stateでは通知先の不存在を確定しない。 */
export function notificationNavigationDecision(
	workspace: { readonly complete: boolean; readonly terminals: readonly { readonly terminalKey: string }[] } | undefined,
	terminalKey: string | undefined,
): NotificationNavigationDecision {
	if (workspace === undefined || workspace.complete !== true) {
		return 'wait';
	}
	return terminalKey !== undefined && workspace.terminals.some(terminal => terminal.terminalKey === terminalKey)
		? 'open'
		: 'missing';
}

/** 通知のタップで開く先と、あわせて合わせておく既存の選択（`selectedWs` / `selectedTerminalKey`）。 */
export interface NotificationDestination {
	readonly href: RouteHref;
	/** 開いた先のスペース（PC の画面へ落ちたときは undefined）。 */
	readonly spaceId: string | undefined;
}

/**
 * エージェントの通知（質問・許可待ち・完了）のタップで開く先。
 * そのエージェントが属するスペースのセッションを、そのエージェントのタブで開く。
 *
 * スペースは PC から届いた状態のターミナルの所属（`terminal.ws`）を正とし、無ければ通知に
 * 載っていた `ws` を使う。どちらも分からなければ、その PC の画面を開く（一覧から探せるように）。
 * `latest` は「新しく開いた」印（`createAgentLatestEntryToken()`）で、会話を最新まで送らせる。
 */
export function notificationDestination(
	workspace: WorkspaceState | undefined,
	pcId: string,
	terminalKey: string,
	notifiedSpaceId: string | undefined,
	latest: string,
): NotificationDestination {
	const spaceId = spaceIdOfTerminal(workspace, terminalKey) ?? notifiedSpaceId;
	if (spaceId === undefined) {
		return { href: routes.pc(pcId), spaceId: undefined };
	}
	return {
		href: routes.session(pcId, spaceId, { tab: { kind: 'terminal', terminalKey }, latest }),
		spaceId,
	};
}
