// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

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
