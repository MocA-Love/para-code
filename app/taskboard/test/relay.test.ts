// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import { describe, expect, test } from 'vitest';
import type { ITaskBoardSlot, ITaskBoardTask } from '@engine/paradisTaskBoard.js';
import { TASK_BOARD_DEFAULT_FLOW } from '@engine/paradisTaskBoardFlow.js';
import { loadFlows, saveFlow } from '../server/flows.js';
import { ParaCodeBridgeError } from '../server/paraCode.js';
import { RelayClient, RemoteWorkspaces, relayFlowIo, type IRelaySessionInfo } from '../server/relay.js';

const INFO: IRelaySessionInfo = { root: '/home/u/repo', worktreeRoot: '/home/u/repo-worktrees', defaultBranch: 'main', originFetch: 'https://example.com/o/r.git', originPush: undefined, worktrees: [] };
const TASK = { id: 't1', branch: 'para/7-feature' } as ITaskBoardTask;
const SLOT: ITaskBoardSlot = { id: 'w', name: 'w', path: '', kind: 'worktree' };

/** 中継の代わり。送られた操作を記録し、決めた答えを返す。 */
function fakeRelay(answer: (op: Record<string, unknown>) => unknown) {
	const ops: Record<string, unknown>[] = [];
	const relay = new RelayClient('session-0123456789abcdef', async <T>(_method: 'POST', _route: string, body: unknown) => {
		const op = (body as { op: Record<string, unknown> }).op;
		ops.push(op);
		const value = answer(op);
		if (value instanceof Error) {
			throw value;
		}
		return { ok: true, value } as T;
	});
	return { relay, ops };
}

function git(stdout = '', code = 0) {
	return { code, stdout, stderr: '', timedOut: false };
}

describe('RelayClient', () => {
	test('waits through 403 and 404 until the SSH window has registered the board and bound the session', async () => {
		const answers = [new ParaCodeBridgeError(403, 'unverified-caller', 'x'), new ParaCodeBridgeError(404, 'not-found', 'x'), INFO];
		const { relay } = fakeRelay(() => answers.shift());
		expect(await relay.waitForSession(5000, async () => undefined)).toEqual(INFO);
		const failing = fakeRelay(() => new ParaCodeBridgeError(400, 'invalid', 'bad'));
		await expect(failing.relay.waitForSession(5000, async () => undefined)).rejects.toThrow('bad');
	});
});

describe('RemoteWorkspaces', () => {
	test('creates the task worktree under the folder the window chose, from the default branch, and never pushes', async () => {
		const { relay, ops } = fakeRelay(op => {
			if (op.kind === 'git') {
				const g = op.git as { kind: string };
				return g.kind === 'refExists' ? git('', 1) : g.kind === 'status' ? git('') : git('');
			}
			return op.kind === 'resetBoardDir' ? { reset: true } : {};
		});
		const workspaces = new RemoteWorkspaces(relay, INFO);
		const prepared = await workspaces.prepare(TASK, SLOT, 'para/7-feature');
		await workspaces.release({ ...TASK, pr: { number: 1 } } as ITaskBoardTask, { ...SLOT, path: prepared.path });
		expect({ prepared, ops: ops.map(op => op.kind === 'git' ? `${op.place} ${JSON.stringify(op.git)}` : `${op.kind} ${op.place}`) }).toEqual({
			prepared: { branch: 'para/7-feature', path: '/home/u/repo-worktrees/7-feature' },
			ops: [
				'/home/u/repo {"kind":"fetch","prune":true}',
				'/home/u/repo {"kind":"worktreeList"}',
				'/home/u/repo {"kind":"refExists","rev":{"kind":"local","branch":"para/7-feature"}}',
				'/home/u/repo {"kind":"refExists","rev":{"kind":"remote","branch":"para/7-feature"}}',
				'/home/u/repo {"kind":"worktreeAdd","dir":"/home/u/repo-worktrees/7-feature","branch":"para/7-feature","mode":"new","base":{"kind":"remote","branch":"main"}}',
				'excludeBoardDir /home/u/repo-worktrees/7-feature',
				'resetBoardDir /home/u/repo-worktrees/7-feature',
				'/home/u/repo-worktrees/7-feature {"kind":"status"}',
				'/home/u/repo {"kind":"worktreeRemove","dir":"/home/u/repo-worktrees/7-feature"}',
			],
		});
	});

	test('reuses a leftover worktree only when the window knows it', async () => {
		const list = 'worktree /home/u/repo\nHEAD x\nbranch refs/heads/main\n\nworktree /home/u/repo-worktrees/7-feature\nHEAD y\nbranch refs/heads/para/7-feature\n';
		const { relay } = fakeRelay(op => op.kind === 'git' && (op.git as { kind: string }).kind === 'worktreeList' ? git(list) : git(''));
		const unknown = new RemoteWorkspaces(relay, INFO);
		const known = new RemoteWorkspaces(relay, { ...INFO, worktrees: ['/home/u/repo-worktrees/7-feature'] });
		await expect(unknown.prepare(TASK, SLOT, 'para/7-feature')).rejects.toThrow('記録の無いワークツリー');
		expect(await known.prepare(TASK, SLOT, 'para/7-feature')).toEqual({ branch: 'para/7-feature', path: '/home/u/repo-worktrees/7-feature' });
	});

	test('keeps a worktree with uncommitted changes and refuses clone workspaces', async () => {
		const { relay, ops } = fakeRelay(op => op.kind === 'git' && (op.git as { kind: string }).kind === 'status' ? git(' M a.txt\n') : git(''));
		const workspaces = new RemoteWorkspaces(relay, INFO);
		await workspaces.release(TASK, { ...SLOT, path: '/home/u/repo-worktrees/7-feature' });
		await expect(workspaces.prepare(TASK, { ...SLOT, kind: 'clone-pool', path: '/home/u/clone' }, 'para/x')).rejects.toThrow('SSH');
		expect(ops.map(op => (op.git as { kind: string }).kind)).toEqual(['status']);
	});
});

describe('flows over the relay', () => {
	test('reads the team and personal files and writes only the new team file', async () => {
		const files = new Map<string, string>([['.paracode.json', JSON.stringify({ workflows: [{ ...TASK_BOARD_DEFAULT_FLOW, id: 'legacy', name: 'Legacy' }], setupScript: 'x' })]]);
		const { relay, ops } = fakeRelay(op => {
			if (op.kind === 'readFile') {
				const text = files.get(op.path as string);
				return text === undefined ? { missing: true } : { base64: Buffer.from(text).toString('base64') };
			}
			files.set(op.path as string, op.content as string);
			return {};
		});
		const io = relayFlowIo(relay, INFO.root);
		const loaded = await loadFlows(INFO.root, 'octocat', io);
		const saved = await saveFlow(INFO.root, 'octocat', { ...TASK_BOARD_DEFAULT_FLOW, id: 'mine', name: 'Mine' }, 'team', undefined, io);
		expect({
			flows: loaded.flows.map(f => f.id),
			sources: loaded.sources,
			saved,
			writes: ops.filter(op => op.kind === 'writeFile').map(op => op.path),
			keptSetup: JSON.parse(files.get('.para-code/paracode.json')!).setupScript,
		}).toEqual({
			flows: [TASK_BOARD_DEFAULT_FLOW.id, 'legacy'],
			sources: ['/home/u/repo/.paracode.json'],
			saved: '/home/u/repo/.para-code/paracode.json',
			writes: ['.para-code/paracode.json'],
			keptSetup: 'x',
		});
	});
});
