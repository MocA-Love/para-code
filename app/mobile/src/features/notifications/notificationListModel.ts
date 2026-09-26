// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import type { NotifyKind, NotifyPayload } from '@para/protocol';
import { notificationDestination, notificationNavigationDecision } from '../../notificationNavigation.js';
import { routes, type RouteHref } from '../../routes.js';
import type { WorkspaceState } from '../../store.js';

/**
 * 通知の一覧（`/notifications`）の行の言い方と、押したときの行き先（純関数。`notificationListModel.test.ts`）。
 * 行き先の組み立ては段階2で用意した `notificationDestination`（OS の通知のタップと同じ）を使う。
 */

/** 行の見出しの頭に付ける出来事の名前（モックの「許可待ち · 〜」「完了 · 〜」）。 */
export function notificationKindLabel(kind: NotifyKind): string {
	switch (kind) {
		case 'agent-question': return '要対応';
		case 'agent-done': return '完了';
		case 'agent-error': return 'エラー';
		case 'disconnected': return '切断';
		default: return '通知';
	}
}

/** 行の見出し（出来事 · スペースの名前）。 */
export function notificationTitle(notification: Pick<NotifyPayload, 'kind' | 'title'>): string {
	return `${notificationKindLabel(notification.kind)} · ${notification.title}`;
}

/** 行の本文（エージェントの種類 · 本文）。 */
export function notificationBody(notification: Pick<NotifyPayload, 'subtitle' | 'body'>): string {
	return notification.subtitle !== undefined ? `${notification.subtitle} · ${notification.body}` : notification.body;
}

/**
 * 通知を押したときの行き先。
 *  - `session`: そのエージェントのセッション（通知を既読＝一覧から消してから開く）
 *  - `pc`: その PC の画面（PC の切断の通知）
 *  - `wait`: PC からの状態がまだ揃っていない（決めつけずに待ってもらう）
 *  - `missing`: そのエージェントはもう無い
 */
export type NotificationTarget =
	| { readonly kind: 'session'; readonly href: RouteHref; readonly spaceId: string | undefined; readonly terminalKey: string }
	| { readonly kind: 'pc'; readonly href: RouteHref }
	| { readonly kind: 'wait' }
	| { readonly kind: 'missing' };

export function notificationTarget(
	notification: Pick<NotifyPayload, 'kind' | 'terminalKey' | 'ws' | 'pcId'>,
	workspace: WorkspaceState | undefined,
	activePcId: string | undefined,
	latest: string,
): NotificationTarget {
	const pcId = notification.pcId ?? activePcId;
	if (notification.kind === 'disconnected') {
		return pcId !== undefined ? { kind: 'pc', href: routes.pc(pcId) } : { kind: 'missing' };
	}
	const decision = notificationNavigationDecision(workspace, notification.terminalKey);
	if (decision !== 'open' || notification.terminalKey === undefined || pcId === undefined) {
		return decision === 'wait' ? { kind: 'wait' } : { kind: 'missing' };
	}
	const destination = notificationDestination(workspace, pcId, notification.terminalKey, notification.ws, latest);
	return { kind: 'session', href: destination.href, spaceId: destination.spaceId, terminalKey: notification.terminalKey };
}
