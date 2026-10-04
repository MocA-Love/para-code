// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import { describe, expect, it } from 'vitest';
import type { WorkspaceState } from '../../store.js';
import { notificationBody, notificationKindLabel, notificationTarget, notificationTitle } from './notificationListModel.js';

const workspace: WorkspaceState = {
	protocolVersion: 4,
	desktopEpoch: 'epoch',
	revision: 1,
	complete: true,
	renderers: [{ windowId: 1, rendererGeneration: 1, ready: true }],
	activeWs: '1:w1',
	workspaces: [{ id: '1:w1', sourceId: 'w1', windowId: 1, name: 'app' }, { id: '1:w2', sourceId: 'w2', windowId: 1, name: 'docs' }],
	terminals: [{ terminalKey: 'terminal-a', id: 1, windowId: 1, rendererGeneration: 1, title: 'claude', ws: '1:w2', agent: true, agentStatus: 'question' }],
};

describe('notificationTitle / notificationBody', () => {
	it('出来事の名前をスペースの名前の頭に付ける', () => {
		expect(notificationKindLabel('agent-question')).toBe('要対応');
		expect(notificationTitle({ kind: 'agent-done', title: 'docs' })).toBe('完了 · docs');
	});

	it('エージェントの種類があれば本文の頭に付ける', () => {
		expect(notificationBody({ subtitle: 'Claude', body: '終わりました' })).toBe('Claude · 終わりました');
		expect(notificationBody({ body: '終わりました' })).toBe('終わりました');
	});
});

describe('notificationTarget', () => {
	it('エージェントの通知は、そのエージェントのスペースのセッションを開く', () => {
		expect(notificationTarget({ kind: 'agent-question', terminalKey: 'terminal-a', ws: '1:w1' }, workspace, 'pc-a', 'tok')).toEqual({
			kind: 'session',
			href: { pathname: '/pc/[pcId]/session/[spaceId]', params: { pcId: 'pc-a', spaceId: '1:w2', tab: 'terminal:terminal-a', latest: 'tok' } },
			spaceId: '1:w2',
			terminalKey: 'terminal-a',
		});
	});

	it('通知に載っている PC を、いま見ている PC より優先する', () => {
		const target = notificationTarget({ kind: 'agent-done', terminalKey: 'terminal-a', pcId: 'pc-b' }, workspace, 'pc-a', 'tok');
		expect(target.kind === 'session' ? target.href : undefined).toMatchObject({ params: { pcId: 'pc-b' } });
	});

	it('PC の切断の通知は、その PC の画面を開く', () => {
		expect(notificationTarget({ kind: 'disconnected', pcId: 'pc-b' }, workspace, 'pc-a', 'tok')).toEqual({
			kind: 'pc',
			href: { pathname: '/pc/[pcId]', params: { pcId: 'pc-b' } },
		});
	});

	it('状態が揃うまでは待ち、もう無いエージェントは missing', () => {
		expect(notificationTarget({ kind: 'agent-done', terminalKey: 'terminal-a' }, undefined, 'pc-a', 'tok')).toEqual({ kind: 'wait' });
		expect(notificationTarget({ kind: 'agent-done', terminalKey: 'terminal-x' }, workspace, 'pc-a', 'tok')).toEqual({ kind: 'missing' });
		expect(notificationTarget({ kind: 'agent-done', terminalKey: 'terminal-a' }, workspace, undefined, 'tok')).toEqual({ kind: 'missing' });
	});
});
