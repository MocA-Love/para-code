// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import { describe, expect, test } from 'vitest';
import { NOTIFICATION_ACTION_MAX_AGE_MS, NOTIFICATION_ACTION_MAX_WAIT_MS, NOTIFY_CATEGORIES, notificationActionReadiness, notifyCategoryIdentifier, planNotificationActionSend, readNotificationAction, type PendingNotificationAction } from './notificationActions.js';

const approve: PendingNotificationAction = { pcId: 'pc-a', terminalKey: 't1', request: { kind: 'approve' }, interactionId: 'toolu_1', at: 1000, queuedAt: 1000 };

describe('notification actions', () => {
	test('ボタンの識別子と入力を読む（開く・本体のタップ・空の返信は送ることが無い）', () => {
		expect([
			readNotificationAction('para.approve', undefined),
			readNotificationAction('para.deny', undefined),
			readNotificationAction('para.reply', '  続けて  '),
			readNotificationAction('para.reply', '   '),
			readNotificationAction('para.open', undefined),
			readNotificationAction('expo.modules.notifications.actions.DEFAULT', undefined),
		]).toEqual([{ kind: 'approve' }, { kind: 'deny' }, { kind: 'reply', text: '続けて' }, undefined, undefined, undefined]);
	});

	test('カテゴリは PC の種類と同じ 4 つで、承認・拒否・返信は端末の解除とアプリを前面に出すことを求める', () => {
		expect(NOTIFY_CATEGORIES.map(category => [category.identifier, category.actions.map(action => `${action.identifier}:${action.options.opensAppToForeground}:${action.options.isAuthenticationRequired === true}`)])).toEqual([
			['para.done', ['para.reply:true:true', 'para.open:true:false']],
			['para.error', ['para.reply:true:true', 'para.open:true:false']],
			['para.approval', ['para.approve:true:true', 'para.deny:true:true', 'para.open:true:false']],
			['para.question', ['para.open:true:false']],
			['para.approval.open', ['para.open:true:false']],
		]);
		// どの承認かの ID が無い承認は、許可・拒否のボタンが無いカテゴリ
		expect([
			notifyCategoryIdentifier('approval', 'toolu_1'), notifyCategoryIdentifier('approval'), notifyCategoryIdentifier('approval', ''),
			notifyCategoryIdentifier('done'), notifyCategoryIdentifier(undefined), notifyCategoryIdentifier('bogus'),
		]).toEqual(['para.approval', 'para.approval.open', 'para.approval.open', 'para.done', undefined, undefined]);
	});

	test('預けた後に Face ID で解除され、その PC が見えていて、やり取りできるまで待つ。古い通知・待ちすぎは送らない', () => {
		const ctx = { now: 2000, locked: false, lastUnlockedAt: 1500, activePcId: 'pc-a', live: true };
		expect([
			notificationActionReadiness(approve, ctx),
			notificationActionReadiness(approve, { ...ctx, locked: true }),
			// 解除は預ける前（再認証の猶予の中）→ 解除し直しを頼む
			notificationActionReadiness(approve, { ...ctx, lastUnlockedAt: 900 }),
			notificationActionReadiness(approve, { ...ctx, lastUnlockedAt: undefined }),
			notificationActionReadiness(approve, { ...ctx, activePcId: 'pc-b' }),
			notificationActionReadiness(approve, { ...ctx, live: false }),
			notificationActionReadiness(approve, { ...ctx, now: 1000 + NOTIFICATION_ACTION_MAX_WAIT_MS + 1 }),
			notificationActionReadiness({ ...approve, at: 2000 - NOTIFICATION_ACTION_MAX_AGE_MS - 1 }, ctx),
		]).toEqual(['ready', 'wait', 'needs-unlock', 'needs-unlock', 'wait', 'wait', 'expired', 'expired']);
	});

	test('会話を受け取り直してから、通知が指していた承認にだけ答える', () => {
		const chat = { syncedAt: 5000, capabilities: { agentActions: true }, interaction: { kind: 'approval' as const, id: 'toolu_1', choices: [{ id: 'yes' }, { id: 'no' }] } };
		expect([
			planNotificationActionSend(approve, { ...chat, syncedAt: 100 }, 4000),
			planNotificationActionSend(approve, chat, 4000),
			planNotificationActionSend({ ...approve, request: { kind: 'deny' } }, chat, 4000),
			planNotificationActionSend(approve, { ...chat, interaction: { kind: 'approval', id: 'toolu_2' } }, 4000),
			planNotificationActionSend({ ...approve, interactionId: undefined }, chat, 4000),
			planNotificationActionSend(approve, { ...chat, interaction: undefined }, 4000),
			planNotificationActionSend(approve, { ...chat, interaction: { kind: 'approval', id: 'toolu_1', choices: [{ id: 'opt:1' }] } }, 4000),
		]).toEqual([
			{ kind: 'wait' },
			{ kind: 'approval', interactionId: 'toolu_1', choice: 'yes' },
			{ kind: 'approval', interactionId: 'toolu_1', choice: 'no' },
			{ kind: 'drop', message: '確認の対象が変わりました。画面で確かめてください' },
			{ kind: 'drop', message: '確認の対象が変わりました。画面で確かめてください' },
			{ kind: 'drop', message: 'この確認はもう終わっています' },
			{ kind: 'drop', message: 'この確認は画面の選択肢から答えてください' },
		]);
	});

	test('返信は待っている確認が無いときだけ送る', () => {
		const reply: PendingNotificationAction = { pcId: 'pc-a', terminalKey: 't1', request: { kind: 'reply', text: '続けて' }, at: 1000, queuedAt: 1000 };
		const chat = { syncedAt: 5000, capabilities: { agentActions: true } };
		expect([
			planNotificationActionSend(reply, chat, 4000),
			planNotificationActionSend(reply, { ...chat, interaction: { kind: 'question' as const, id: 'q1' } }, 4000),
			planNotificationActionSend(reply, { syncedAt: 5000, none: true }, 4000),
		]).toEqual([
			{ kind: 'reply', text: '続けて' },
			{ kind: 'drop', message: '質問や許可への回答が先に必要です' },
			{ kind: 'drop', message: 'エージェントが見つかりませんでした' },
		]);
	});
});
