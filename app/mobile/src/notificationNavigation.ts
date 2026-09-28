// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import type { WorkspaceState } from './store.js';
import { spaceIdOfTerminal } from './navigationTargets.js';
import { routes, type RouteHref } from './routes.js';
import { readTrayData } from './notificationTray.js';

/**
 * 通知のタップで開く先の手がかり（ローカル通知の data・プッシュを NSE が復号して書いた userInfo）。
 * `pcId` はどのPCから届いた通知か。プッシュでは NSE が復号できた鍵の名前から補う。
 */
export interface NotificationDeepLinkData {
	readonly ws?: string;
	readonly terminalKey?: string;
	readonly agentToken?: string;
	readonly pcId?: string;
}

/**
 * タップされた通知から開く先の手がかりを読む。プッシュは `content.data` が空なので
 * `trigger.payload` も読む（readTrayData）。文字列でない値・長すぎる値は捨てる。
 * 手がかりが1つも無ければ undefined（どこへも遷移しない）。
 */
export function readNotificationDeepLink(request: { readonly content: { readonly data?: unknown }; readonly trigger?: unknown }): NotificationDeepLinkData | undefined {
	const data = readTrayData(request);
	const pick = (key: keyof NotificationDeepLinkData) => {
		const value = data?.[key];
		return typeof value === 'string' && value.length > 0 && value.length <= 200 ? { [key]: value } : {};
	};
	const link: NotificationDeepLinkData = { ...pick('ws'), ...pick('terminalKey'), ...pick('agentToken'), ...pick('pcId') };
	return Object.keys(link).length > 0 ? link : undefined;
}

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
