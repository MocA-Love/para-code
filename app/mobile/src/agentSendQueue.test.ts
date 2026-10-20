// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import { describe, expect, it, vi } from 'vitest';

const harness = vi.hoisted(() => ({ saves: 0, failSave: false }));

vi.mock('./appState.js', () => ({
	agentSendQueueKey: () => new Uint8Array(32).fill(7),
	sendPcRequest: async () => ({}),
	useAppStore: { getState: () => ({ workspace: undefined, agentChats: new Map() }) },
}));
vi.mock('./appLock.js', () => ({ useAppLocked: () => false }));
vi.mock('./appLockState.js', () => ({ isAppLockedNow: () => false }));
vi.mock('./platform.js', () => ({
	createAgentSendOutboxStore: () => ({
		loadCandidates: async () => [],
		clear: async () => undefined,
		save: async () => {
			harness.saves++;
			if (harness.failSave) {
				throw new Error('disk full');
			}
		},
	}),
}));

const { enqueueAgentSend, useAgentSendQueue } = await import('./agentSendQueue.js');

describe('agent send queue', () => {
	it('does not hold a send it could not save, and says so (the text stays in the composer)', async () => {
		vi.spyOn(console, 'warn').mockImplementation(() => undefined);
		const target = { kind: 'resume' as const, ws: 'space-1', key: 'session-1' };
		const kept = await enqueueAgentSend('pc-1', 'first', target, 'send-1');
		harness.failSave = true;
		const failed = await enqueueAgentSend('pc-1', 'second', target, 'send-2').then(() => 'held', (error: unknown) => error instanceof Error ? error.message : 'rejected');
		expect({
			kept: kept.id,
			failed: failed.startsWith('送信を預かれませんでした'),
			items: useAgentSendQueue.getState().items.map(item => item.id),
		}).toEqual({ kept: 'send-1', failed: true, items: ['send-1'] });
	});
});
