// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import { describe, expect, it, vi } from 'vitest';

// notificationTraySync は platform.ts（expo のネイティブモジュール）を読む。台帳だけを確かめるので差し替える。
vi.mock('./platform.js', () => ({
	listPresentedNotifications: async () => [],
	dismissPresentedNotifications: async () => undefined,
	presentLocalNotification: async () => undefined,
}));

import { notifyCollapseKey, readTrayData, selectHandledByPc, selectSameCollapse, selectSeenOnOpen, selectSettledByState, trayDateMs, type TrayNotification } from './notificationTray.js';
import { TrayReconcileRequests } from './notificationTraySync.js';

const PC = 'pc-a';
const T0 = 1_800_000_000_000;

function tray(identifier: string, data: Record<string, unknown>, date = T0): TrayNotification {
	return { identifier, date, data };
}

describe('readTrayData', () => {
	it('reads the full userInfo of a remote push from the trigger and the data of a local one', () => {
		expect([
			readTrayData({ content: { data: null }, trigger: { type: 'push', payload: { agentToken: 'tok', aps: {} } } }),
			readTrayData({ content: { data: { agentToken: 'local' } }, trigger: null }),
			readTrayData({ content: {}, trigger: { type: 'push' } }),
			readTrayData({ content: { data: { a: 1, b: 1 } }, trigger: { type: 'push', payload: { b: 2 } } }),
			// プッシュの content.data（APNs の生ペイロードの body）はリレーが差し込めるので混ぜない
			readTrayData({ content: { data: { ws: 'injected' } }, trigger: { type: 'push', payload: { agentToken: 'tok' } } }),
		]).toEqual([{ agentToken: 'tok', aps: {} }, { agentToken: 'local' }, undefined, { b: 2 }, { agentToken: 'tok' }]);
		expect([trayDateMs(1_800_000_000), trayDateMs(T0)]).toEqual([T0, T0]);
	});
});

describe('selectHandledByPc', () => {
	it('clears notifications the PC reported as handled, by id or by agent, only for that PC', () => {
		const presented = [
			tray('by-id', { notifyId: 'n1', pcId: PC }),
			tray('by-token', { agentToken: 'tok-1', pcId: PC }),
			tray('legacy-no-pc', { agentToken: 'tok-1' }),
			tray('other-pc', { agentToken: 'tok-1', pcId: 'pc-b' }),
			tray('unrelated', { notifyId: 'n2', agentToken: 'tok-2', pcId: PC }),
			tray('arrived-later', { agentToken: 'tok-1', pcId: PC }, T0 + 1),
			tray('not-ours', {}),
		];
		expect(selectHandledByPc(presented, { pcId: PC, ids: ['n1'], tokens: ['tok-1'], before: T0 })).toEqual(['by-id', 'by-token', 'legacy-no-pc']);
	});

	it('keeps prompts when the PC acknowledged the agent, and clears them only by id (Q243 A)', () => {
		const presented = [
			tray('done', { agentToken: 'tok-1', kind: 'agent-done', pcId: PC }),
			tray('prompt', { agentToken: 'tok-1', kind: 'agent-question', notifyId: 'q1', pcId: PC }),
			tray('answered', { agentToken: 'tok-1', kind: 'agent-question', notifyId: 'q2', pcId: PC }),
		];
		expect([
			selectHandledByPc(presented, { pcId: PC, ids: ['q2'], tokens: ['tok-1'], before: T0, keepPrompts: true }),
			// 回答で片付けを知らせない旧 PC では、今までどおり許可・質問もトークンで消す
			selectHandledByPc(presented, { pcId: PC, ids: [], tokens: ['tok-1'], before: T0 }),
		]).toEqual([['done', 'answered'], ['done', 'prompt', 'answered']]);
	});
});

describe('selectSeenOnOpen', () => {
	it('picks the done and error notifications of the opened agent on that PC, never prompts (Q241 A)', () => {
		const presented = [
			tray('done', { agentToken: 'tok-1', kind: 'agent-done', notifyId: 'n1', pcId: PC }),
			tray('error', { agentToken: 'tok-1', kind: 'agent-error', notifyId: 'n2' }),
			tray('prompt', { agentToken: 'tok-1', kind: 'agent-question', notifyId: 'q1', pcId: PC }),
			tray('other-agent', { agentToken: 'tok-2', kind: 'agent-done', notifyId: 'n3', pcId: PC }),
			tray('other-pc', { agentToken: 'tok-1', kind: 'agent-done', notifyId: 'n4', pcId: 'pc-b' }),
			tray('by-key', { terminalKey: 'terminal-1', kind: 'agent-done', notifyId: 'n5', pcId: PC }),
			tray('by-key-unknown-pc', { terminalKey: 'terminal-1', kind: 'agent-done', notifyId: 'n6' }),
		];
		expect(selectSeenOnOpen(presented, { pcId: PC, terminalKey: 'terminal-1', agentToken: 'tok-1' }))
			.toEqual({ notifyIds: ['n1', 'n2', 'n5'], identifiers: ['done', 'error', 'by-key'] });
	});
});

describe('selectSettledByState', () => {
	const terminals = [
		{ terminalKey: 'k-done-ack', agentToken: 'ack', agentStatus: undefined },
		{ terminalKey: 'k-done-open', agentToken: 'open', agentStatus: 'review' },
		{ terminalKey: 'k-q-answered', agentToken: 'answered', agentStatus: 'working' },
		{ terminalKey: 'k-q-waiting', agentToken: 'waiting', agentStatus: 'permission' },
		{ terminalKey: 'k-q-asking', agentToken: 'asking', agentStatus: 'question' },
		{ terminalKey: 'k-plain', agentStatus: undefined },
	];
	const before = T0 + 10;

	it('removes only completion notifications the PC has acknowledged, never permission or question ones', () => {
		const presented = [
			tray('done-acknowledged', { kind: 'agent-done', agentToken: 'ack', pcId: PC }),
			tray('done-still-unread', { kind: 'agent-done', agentToken: 'open', pcId: PC }),
			tray('question-answered', { kind: 'agent-question', agentToken: 'answered', pcId: PC }),
			tray('question-waiting', { kind: 'agent-question', agentToken: 'waiting', pcId: PC }),
			tray('question-asking', { kind: 'agent-question', agentToken: 'asking' }),
			tray('agent-gone', { kind: 'agent-done', agentToken: 'vanished', pcId: PC }),
			tray('error-kind', { kind: 'agent-error', agentToken: 'ack', pcId: PC }),
			tray('no-kind', { agentToken: 'ack', pcId: PC }),
			tray('by-key-same-pc', { kind: 'agent-done', terminalKey: 'k-plain', pcId: PC }),
			tray('by-key-unknown-pc', { kind: 'agent-done', terminalKey: 'k-plain' }),
			tray('other-pc', { kind: 'agent-done', agentToken: 'ack', pcId: 'pc-b' }),
			tray('newer-than-state', { kind: 'agent-done', agentToken: 'ack', pcId: PC }, before),
		];
		// question-answered は状態が working でも消さない（hook が来ないと working のまま残るため）
		expect(selectSettledByState(presented, { pcId: PC, terminals, before })).toEqual([
			'done-acknowledged',
			'by-key-same-pc',
		]);
	});
});

describe('notifyCollapseKey', () => {
	it('is a stable opaque key per PC and agent, falling back to the terminal', () => {
		const byAgent = notifyCollapseKey(PC, 'agent-done', 'tok-1', 'k1');
		expect({
			byAgent,
			sameAgentOtherTerminal: notifyCollapseKey(PC, 'agent-done', 'tok-1', 'k2') === byAgent,
			otherPc: notifyCollapseKey('pc-b', 'agent-done', 'tok-1', 'k1') === byAgent,
			byTerminal: notifyCollapseKey(PC, 'agent-done', undefined, 'k1'),
			nothing: notifyCollapseKey(PC, 'agent-done', undefined, undefined),
			leaksToken: byAgent?.includes('tok-1'),
		}).toEqual({
			// NSE（NotificationService.swift の collapseKey）と同じ値になること。変えるなら両方直す
			byAgent: '34b89a13c42e76d9b1ae9ae72ea29a79',
			sameAgentOtherTerminal: true,
			otherPc: false,
			byTerminal: notifyCollapseKey(PC, 'agent-done', undefined, 'k1'),
			nothing: undefined,
			leaksToken: false,
		});
		expect(byAgent).toMatch(/^[0-9a-f]{32}$/);
	});

	it('never replaces permission / question notifications', () => {
		expect([notifyCollapseKey(PC, 'agent-question', 'tok-1', 'k1'), notifyCollapseKey(PC, 'agent-error', 'tok-1', 'k1') === notifyCollapseKey(PC, 'agent-done', 'tok-1', 'k1')])
			.toEqual([undefined, true]);
	});

	it('finds the earlier notifications for the same agent', () => {
		const key = notifyCollapseKey(PC, 'agent-done', 'tok-1', undefined)!;
		expect(selectSameCollapse([
			tray('old-push', { collapse: key }),
			tray('other', { collapse: 'x' }),
			tray('none', {}),
		], key)).toEqual(['old-push']);
	});
});

describe('TrayReconcileRequests', () => {
	it('waits for a State that arrives after the request and fires once', () => {
		const requests = new TrayReconcileRequests();
		requests.request(PC, 4, T0);
		expect(requests.take(PC, 4)).toBeUndefined();
		expect(requests.take(PC, 5)).toBe(T0);
		expect(requests.take(PC, 6)).toBeUndefined();

		// 頼み直したら、その後の State を待つ
		requests.request(PC, 6, T0 + 1);
		requests.request(PC, 7, T0 + 2);
		expect(requests.take(PC, 7)).toBeUndefined();
		expect(requests.take(PC, 8)).toBe(T0 + 2);
	});
});
