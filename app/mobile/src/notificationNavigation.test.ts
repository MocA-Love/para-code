import { describe, expect, it } from 'vitest';
import type { WorkspaceState } from './store.js';
import { notificationDestination, notificationNavigationDecision, readNotificationDeepLink } from './notificationNavigation.js';

describe('notificationNavigationDecision', () => {
	it('keeps a target pending until a complete desktop snapshot arrives', () => {
		expect(notificationNavigationDecision(undefined, 'terminal-a')).toBe('wait');
		expect(notificationNavigationDecision({ complete: false, terminals: [] }, 'terminal-a')).toBe('wait');
	});

	it('opens only an exact target in a complete snapshot', () => {
		expect(notificationNavigationDecision({ complete: true, terminals: [{ terminalKey: 'terminal-a' }] }, 'terminal-a')).toBe('open');
		expect(notificationNavigationDecision({ complete: true, terminals: [{ terminalKey: 'terminal-b' }] }, 'terminal-a')).toBe('missing');
		expect(notificationNavigationDecision({ complete: true, terminals: [{ terminalKey: 'terminal-b' }] }, undefined)).toBe('missing');
	});
});

describe('notificationDestination', () => {
	const workspace: WorkspaceState = {
		protocolVersion: 3,
		desktopEpoch: 'epoch',
		revision: 1,
		complete: true,
		renderers: [{ windowId: 1, rendererGeneration: 1, ready: true }],
		activeWs: '1:w1',
		workspaces: [{ id: '1:w1', sourceId: 'w1', windowId: 1, name: 'app' }, { id: '1:w2', sourceId: 'w2', windowId: 1, name: 'docs' }],
		terminals: [{ terminalKey: 'terminal-a', id: 1, windowId: 1, rendererGeneration: 1, title: 'claude', ws: '1:w2', agent: true, agentStatus: 'question' }],
	};

	it('opens the session of the space the agent belongs to, on that agent tab', () => {
		expect(notificationDestination(workspace, 'pc-a', 'terminal-a', '1:w1', 'tok')).toEqual({
			href: {
				pathname: '/pc/[pcId]/session/[spaceId]',
				params: { pcId: 'pc-a', spaceId: '1:w2', tab: 'terminal:terminal-a', latest: 'tok' },
			},
			spaceId: '1:w2',
		});
	});

	it('falls back to the space carried by the notification when the terminal has no space', () => {
		expect(notificationDestination(workspace, 'pc-a', 'terminal-x', '1:w1', 'tok').spaceId).toBe('1:w1');
	});

	it('opens the PC screen when the space cannot be determined', () => {
		expect(notificationDestination(workspace, 'pc-a', 'terminal-x', undefined, 'tok')).toEqual({
			href: { pathname: '/pc/[pcId]', params: { pcId: 'pc-a' } },
			spaceId: undefined,
		});
	});
});

describe('readNotificationDeepLink', () => {
	it('reads a local notification from content.data', () => {
		expect(readNotificationDeepLink({ content: { data: { ws: '1:w1', terminalKey: 'k1', agentToken: 'tok', pcId: 'pc-a' } }, trigger: null }))
			.toEqual({ ws: '1:w1', terminalKey: 'k1', agentToken: 'tok', pcId: 'pc-a' });
	});

	it('reads a push from trigger.payload, where the NSE writes the decrypted ids (content.data is empty)', () => {
		// expo の iOS 実装はリモート通知の content.data に userInfo["body"] しか入れない。
		const push = {
			content: { data: null },
			trigger: { type: 'push', payload: { aps: { alert: { title: 'Para Code' } }, e: 'cipher', ws: '1:w2', terminalKey: 'k2', terminalId: 3, kind: 'agent-done', pcId: 'pc-b' } },
		};
		expect(readNotificationDeepLink(push)).toEqual({ ws: '1:w2', terminalKey: 'k2', pcId: 'pc-b' });
	});

	it('prefers the push userInfo when both carry the same key, and drops malformed values', () => {
		expect(readNotificationDeepLink({
			content: { data: { ws: 'from-data', pcId: 'pc-a' } },
			trigger: { type: 'push', payload: { ws: 'from-payload', terminalKey: 42, agentToken: 'x'.repeat(201) } },
		})).toEqual({ ws: 'from-payload', pcId: 'pc-a' });
	});

	it('returns nothing for a push the NSE could not decrypt (no ids)', () => {
		expect(readNotificationDeepLink({ content: { data: null }, trigger: { type: 'push', payload: { aps: {}, e: 'cipher' } } })).toBeUndefined();
	});
});
