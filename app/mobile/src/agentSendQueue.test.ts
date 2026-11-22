// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import { describe, expect, it, vi } from 'vitest';

const harness = vi.hoisted(() => ({ saves: 0, failSave: false, reply: {} as Record<string, unknown>, drafts: [] as [string, string][] }));

vi.mock('./appState.js', () => ({
	agentSendQueueKey: () => new Uint8Array(32).fill(7),
	sendPcRequest: async () => harness.reply,
	useAppStore: {
		getState: () => ({
			workspace: { workspaces: [{ id: 'app-space-1', sourceId: 'space-1' }] }, agentChats: new Map(),
			setAgentDraft: (key: string, text: string) => { harness.drafts.push([key, text]); },
		}),
	},
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

const { confirmResumeAndSend, enqueueAgentSend, useAgentSendQueue } = await import('./agentSendQueue.js');
const { terminalDraftKey, useTerminalDrafts } = await import('./features/session/terminalDrafts.js');

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

	it('keeps a resumed send whose text the PC did not take when there is no opened terminal to move it to', async () => {
		harness.failSave = false;
		const key = 'a'.repeat(40);
		/** 1 件預けて「再開して送る」を押し、PC の返事ごとに残ったものを見る。 */
		const run = async (id: string, agent: string, reply: Record<string, unknown>) => {
			harness.reply = { t: 'agentSessionResume', ...reply };
			harness.drafts.length = 0;
			const item = await enqueueAgentSend('pc-1', `text ${id}`, { kind: 'live', terminalKey: `closed-${id}`, ws: 'space-1', resumeKey: key, agent }, id);
			const result = await confirmResumeAndSend(item);
			const kept = useAgentSendQueue.getState().items.find(candidate => candidate.id === id);
			const terminalDraft = result?.terminalKey !== undefined ? useTerminalDrafts.getState().drafts[terminalDraftKey('pc-1', result.terminalKey)] : undefined;
			return { kept: kept !== undefined ? [kept.status, kept.text, kept.error] : undefined, chatDrafts: [...harness.drafts], terminalDraft };
		};
		expect({
			// Antigravity CLI は PC が文を渡さない。開いたターミナルが返らなければ（処理中の duplicate）、預かりを消さない
			antigravityNoTerminal: await run('agy-1', 'antigravity', { status: 'duplicate', message: 'この依頼は PC で処理している最中です' }),
			// 開いたターミナルが返れば、会話表示とターミナル表示の両方の入力欄へ移して預かりを消す
			antigravityResumed: await run('agy-2', 'antigravity', { status: 'resumed', terminalKey: 'term-agy-2', delivered: false }),
			// ほかの種類: PC が文を渡したら預かりを消す（下書きは作らない）
			claudeDelivered: await run('claude-1', 'claude', { status: 'resumed', terminalKey: 'term-claude-1', delivered: true }),
			codexDelivered: await run('codex-1', 'codex', { status: 'resumed', terminalKey: 'term-codex-1', delivered: true }),
			openCodeDelivered: await run('opencode-1', 'opencode', { status: 'resumed', terminalKey: 'term-opencode-1', delivered: true }),
			// ほかの種類: 渡せなかったときは今までどおり会話表示の入力欄へだけ移す
			claudeNotDelivered: await run('claude-2', 'claude', { status: 'resumed', terminalKey: 'term-claude-2', delivered: false }),
			// PC で開いていた
			running: await run('agy-3', 'antigravity', { status: 'running', terminalKey: 'term-agy-3' }),
		}).toEqual({
			antigravityNoTerminal: { kept: ['failed', 'text agy-1', 'この依頼は PC で処理している最中です'], chatDrafts: [], terminalDraft: undefined },
			antigravityResumed: { kept: undefined, chatDrafts: [['term-agy-2', 'text agy-2']], terminalDraft: 'text agy-2' },
			claudeDelivered: { kept: undefined, chatDrafts: [], terminalDraft: undefined },
			codexDelivered: { kept: undefined, chatDrafts: [], terminalDraft: undefined },
			openCodeDelivered: { kept: undefined, chatDrafts: [], terminalDraft: undefined },
			claudeNotDelivered: { kept: undefined, chatDrafts: [['term-claude-2', 'text claude-2']], terminalDraft: undefined },
			running: { kept: ['failed', 'text agy-3', 'この会話は PC で開いています。会話の画面から送ってください'], chatDrafts: [], terminalDraft: undefined },
		});
	});
});
