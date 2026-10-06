// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

/**
 * 通知のボタン（許可・拒否・返信）で頼まれたことを、アプリのロックが解けてから PC へ送る。
 *
 * ボタンはアプリを前面で開く。遷移（そのエージェントの画面を開く）は `app/_layout.tsx` の通知のタップと同じ
 * 仕組みが受け持ち、ここは送ることだけを受け持つ。送るのは次の全部がそろってから:
 * - アプリのロック（`AuthGate`）が解けている（ロック画面の下で送らない）
 * - 通知の PC がいま見ている PC で、やり取りできる
 * - その会話の状態を PC から受け取り直した（古い状態で承認に答えない）
 * 何を送るかの判断は `notificationActions.ts` の純関数。
 */

import { useEffect, useState } from 'react';
import { useAppStore } from './appState.js';
import { agentSendIds } from './agentSendIds.js';
import { useAppLocked } from './appLock.js';
import { appLastUnlockedAt, isAppLockedNow, requestAppReauthentication } from './appLockState.js';
import { useAgentSendLive } from './agentSendQueue.js';
import { notificationActionReadiness, planNotificationActionSend, type PendingNotificationAction } from './notificationActions.js';
import type { AgentMessageSendResult } from './store.js';
import { useParaToast } from './paraToast.js';

/** 会話の状態を受け取り直すまで、取り直しを頼まずに待つ時間。 */
const CHAT_REFRESH_AFTER_MS = 2_000;
/** 会話の準備を待つ上限。 */
const CHAT_READY_TIMEOUT_MS = 10_000;
/** 同じボタンの操作を二度送らないための記録の数。 */
const HANDLED_LIMIT = 50;

let pending: PendingNotificationAction | undefined;
let running = false;
/** 解除し直しを頼んだ預かり（同じ預かりで二度頼まない）。 */
let reauthRequestedFor: PendingNotificationAction | undefined;
const handledKeys: string[] = [];
const listeners = new Set<() => void>();

function kick(): void {
	for (const listener of [...listeners]) {
		listener();
	}
}

/**
 * ボタンの操作を預ける。`key` は通知とボタンの組（同じ応答が起動時の取り出しとリスナーの両方から来ても、
 * 一度しか送らない）。後から押したものが前のものを置き換える（待っているのは 1 件だけ）。
 */
export function queueNotificationAction(key: string, next: PendingNotificationAction): void {
	if (handledKeys.includes(key)) {
		return;
	}
	handledKeys.push(key);
	if (handledKeys.length > HANDLED_LIMIT) {
		handledKeys.shift();
	}
	// 返信の id はボタンを押した 1 回につき 1 つ（ロックの解除待ちで送り直しても同じ id）
	replacePending(next.request.kind === 'reply' && next.sendId === undefined
		? { ...next, sendId: agentSendIds.idFor(next.terminalKey, next.request.text) }
		: next);
	kick();
}

/** 預けている操作を置き換える。前の操作は送らずに知らせる（返信なら入力欄へ戻す）。 */
function replacePending(next: PendingNotificationAction): void {
	const previous = pending;
	pending = next;
	if (previous !== undefined && previous !== next) {
		fail(previous, '別の通知の操作を受けたため送っていません');
	}
}

function showResult(ok: boolean, text: string, sub?: string): void {
	useParaToast.getState().show({
		key: 'notification-action',
		text,
		...(sub !== undefined ? { sub } : {}),
		icon: ok ? 'checkmark-circle-outline' : 'alert-circle-outline',
		tone: ok ? 'done' : 'warn',
	}, 4_000);
}

/** 送れなかった。返信は消さずに会話の入力欄へ移す。 */
function fail(action: PendingNotificationAction, message: string): void {
	if (action.request.kind === 'reply') {
		useAppStore.getState().setAgentDraft(action.terminalKey, action.request.text);
		showResult(false, '返信を送れませんでした', `${message}。入力欄に残しました`);
		return;
	}
	showResult(false, action.request.kind === 'approve' ? '許可を送れませんでした' : '拒否を送れませんでした', message);
}

/** 返信を送る。届いたか分からないまま失敗した返信は入力欄へ戻り、そこから送り直すと同じ id になる（PC が二重に送らない）。 */
async function sendReply(action: PendingNotificationAction, text: string): Promise<AgentMessageSendResult> {
	const sendId = action.sendId ?? agentSendIds.idFor(action.terminalKey, text);
	const result = await useAppStore.getState().sendAgentMessage(action.terminalKey, text, sendId);
	agentSendIds.settle(action.terminalKey, text, sendId, result);
	return result;
}

async function run(action: PendingNotificationAction): Promise<void> {
	const app = useAppStore.getState();
	const since = Date.now();
	app.attachAgent(action.terminalKey);
	try {
		const decide = () => planNotificationActionSend(action, useAppStore.getState().agentChats.get(action.terminalKey), since);
		const deadline = since + CHAT_READY_TIMEOUT_MS;
		let refreshed = false;
		let decision = decide();
		while (decision.kind === 'wait' && Date.now() < deadline) {
			// 既に開いていた会話は attach し直しても何も届かないので、少し待っても来なければ取り直しを頼む。
			if (!refreshed && Date.now() - since > CHAT_REFRESH_AFTER_MS) {
				refreshed = true;
				useAppStore.getState().refreshAgent(action.terminalKey);
			}
			await new Promise<void>(resolve => setTimeout(resolve, 200));
			decision = decide();
		}
		if (decision.kind === 'wait') {
			fail(action, '会話の状態を PC から受け取れませんでした');
			return;
		}
		if (decision.kind === 'drop') {
			fail(action, decision.message);
			return;
		}
		// 待っている間にロックされたら、送らずに預け直す（解けたらもう一度判断する）。
		if (isAppLockedNow()) {
			if (pending === undefined) {
				pending = action;
			} else {
				// 待っている間に新しい操作を預かっていた。後から押したほうを送り、こちらは送らずに知らせる。
				fail(action, '別の通知の操作を受けたため送っていません');
			}
			return;
		}
		const store = useAppStore.getState();
		const result = decision.kind === 'approval'
			? await store.answerAgentApproval(action.terminalKey, decision.interactionId, decision.choice)
			: await sendReply(action, decision.text);
		if (result.status === 'accepted') {
			// 答えられた通知は、ほかの端末からも消す（Q241 A。PC も回答の成立で片付けるが、hook の無い経路でも消えるように）
			if (action.notifyId !== undefined) {
				useAppStore.getState().markNotificationSeen(action.pcId, action.notifyId);
			}
			showResult(true, action.request.kind === 'approve' ? '許可しました' : action.request.kind === 'deny' ? '拒否しました' : '返信を送りました');
			return;
		}
		fail(action, result.message ?? '送れませんでした');
	} finally {
		app.detachAgent(action.terminalKey);
	}
}

/** 預かった操作の見張り役。アプリの根に 1 つだけ置く（何も描かない）。 */
export function NotificationActionRunner(): null {
	const locked = useAppLocked();
	const activePcId = useAppStore(s => s.activePcId);
	const live = useAgentSendLive();
	const [tick, setTick] = useState(0);
	useEffect(() => {
		const listener = () => setTick(value => value + 1);
		listeners.add(listener);
		return () => { listeners.delete(listener); };
	}, []);
	useEffect(() => {
		const current = pending;
		if (current === undefined || running) {
			return undefined;
		}
		const readiness = notificationActionReadiness(current, { now: Date.now(), locked, lastUnlockedAt: appLastUnlockedAt(), activePcId, live });
		if (readiness === 'expired') {
			pending = undefined;
			fail(current, '通知が古いか、アプリを開くまでに時間がかかったため送っていません');
			return undefined;
		}
		if (readiness === 'needs-unlock' && reauthRequestedFor !== current) {
			// 再認証の猶予の間でも、預けた後に Face ID を通してから送る。解けたらロックの変化で見直す。
			reauthRequestedFor = current;
			requestAppReauthentication();
		}
		if (readiness === 'wait' || readiness === 'needs-unlock') {
			// 期限切れを拾うため、条件が変わらなくても少し後に見直す。
			const timer = setTimeout(() => setTick(value => value + 1), 5_000);
			return () => clearTimeout(timer);
		}
		pending = undefined;
		running = true;
		void run(current)
			.catch(error => fail(current, error instanceof Error ? error.message : '送れませんでした'))
			.finally(() => {
				running = false;
				kick();
			});
		return undefined;
	}, [tick, locked, activePcId, live]);
	return null;
}
