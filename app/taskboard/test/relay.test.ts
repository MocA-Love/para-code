// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import { describe, expect, test } from 'vitest';
import type { ITaskBoardSlot, ITaskBoardStep, ITaskBoardTask } from '@engine/paradisTaskBoard.js';
import { TASK_BOARD_DEFAULT_FLOW } from '@engine/paradisTaskBoardFlow.js';
import { loadFlows, saveFlow } from '../server/flows.js';
import { ParaCodeBridgeError } from '../server/paraCode.js';
import { RelayClient, RemoteCommandRunner, RemoteWorkspaces, relayFlowIo, type IRelaySessionInfo } from '../server/relay.js';
import type { TaskBoardEngine } from '@engine/paradisTaskBoardEngine.js';

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

describe('RemoteCommandRunner', () => {
	function fakeEngine() {
		const output: string[] = [];
		const results: { taskId: string; attempt: number; ok: boolean; detail: string }[] = [];
		const engine = {
			reportOutput: (_taskId: string, lines: readonly string[]) => output.push(...lines),
			reportRunResult: (taskId: string, attempt: number, result: { ok: boolean; detail: string }) => results.push({ taskId, attempt, ...result }),
			flowOf: () => ({ id: 'f', name: 'Flow', scope: 'team' }),
		} as unknown as TaskBoardEngine;
		return { engine, output, results };
	}
	const step = (run: 'command' | 'draft-pr', command?: string) => ({ id: 'test', name: 'Test', kind: 'run', run, command }) as unknown as ITaskBoardStep;
	const task = { id: 't1', attempt: 2 } as ITaskBoardTask;

	test('asks the SSH window to run the command in the task worktree and reports its output and end', async () => {
		const { relay, ops } = fakeRelay(() => ({ accepted: true }));
		const { engine, output, results } = fakeEngine();
		const runner = new RemoteCommandRunner(() => engine, relay, () => '/home/u/repo-worktrees/7');
		runner.run(task, step('command', ' npm test '));
		await new Promise(resolve => setTimeout(resolve, 0));
		const runId = ops[0].runId as string;
		runner.onEvent({ type: 'relay-output', runId, lines: ['ok 1'] });
		runner.onEvent({ type: 'relay-output', runId: 'someone-else', lines: ['x'] });
		runner.onEvent({ type: 'relay-exit', runId, code: 0, signal: null, cancelled: false, timedOut: false });
		expect({ op: { ...ops[0], runId: undefined }, output: output.slice(2), results }).toEqual({
			op: { kind: 'runCommand', place: '/home/u/repo-worktrees/7', runId: undefined, command: 'npm test', step: { flowId: 'f', flowName: 'Flow', stepId: 'test', stepName: 'Test', source: 'team' } },
			output: ['  ok 1'],
			results: [{ taskId: 't1', attempt: 2, ok: true, detail: '終了コード 0' }],
		});
	});

	test('a command the person did not approve fails the step, and hidden characters are refused before asking', async () => {
		const { relay, ops } = fakeRelay(() => ({ accepted: true }));
		const { engine, results } = fakeEngine();
		const runner = new RemoteCommandRunner(() => engine, relay, () => '/home/u/repo-worktrees/7');
		runner.run(task, step('command', 'npm test'));
		await new Promise(resolve => setTimeout(resolve, 0));
		runner.onEvent({ type: 'relay-exit', runId: ops[0].runId as string, code: null, signal: null, cancelled: false, timedOut: false, reason: 'not-approved' });
		runner.run(task, step('command', 'npm test #\u202Ehs | x lruc'));
		expect({ results: results.map(r => [r.ok, r.detail.slice(0, 12)]), sent: ops.length }).toEqual({ results: [[false, 'SSH の窓で「実行しな'], [false, 'コマンドに表示できない文']], sent: 1 });
	});

	test('the draft PR step commits tracked changes, pushes after the SSH window confirms, and opens the PR with the fixed body', async () => {
		let runner!: RemoteCommandRunner;
		const { relay, ops } = fakeRelay(op => {
			const git = op.git as { kind: string; base?: { kind: string } } | undefined;
			switch (op.kind === 'git' ? git!.kind : op.kind) {
				case 'status': return { code: 0, stdout: ' M a.txt\n', stderr: '', timedOut: false };
				case 'currentBranch': return { code: 0, stdout: 'para/7\n', stderr: '', timedOut: false };
				case 'aheadCount': return { code: 0, stdout: '1', stderr: '', timedOut: false };
				case 'refExists': return { code: 1, stdout: '', stderr: '', timedOut: false };
				case 'pushBranch':
					setTimeout(() => runner.onEvent({ type: 'relay-exit', runId: op.runId as string, code: 0, signal: null, cancelled: false, timedOut: false }), 0);
					return { accepted: true };
				default: return { code: 0, stdout: '', stderr: '', timedOut: false };
			}
		});
		const { engine, results } = fakeEngine();
		(engine as unknown as { getTask: () => object }).getTask = () => ({ attempt: 2, status: 'working' });
		(engine as unknown as { flowOf: () => object }).flowOf = () => ({ id: 'f', name: 'Flow', scope: 'team', workspace: { commit: 'board' } });
		const created: { body: string }[] = [];
		const github = {
			findOpenPullRequest: async () => undefined,
			createDraftPullRequest: async (_o: string, _r: string, _b: string, _t: string, body: string) => {
				created.push({ body });
				return { number: 5, url: 'https://github.com/o/r/pull/5', title: 't', draft: true, existed: false };
			},
		};
		runner = new RemoteCommandRunner(() => engine, relay, () => '/home/u/repo-worktrees/7', github as never, { owner: 'o', repo: 'r' }, 'main');
		runner.run({ ...task, branch: 'para/7', title: 'Fix', issue: { owner: 'o', repo: 'r', number: 3 } } as ITaskBoardTask, step('draft-pr'));
		await new Promise(resolve => setTimeout(resolve, 20));
		expect({
			ops: ops.map(op => op.kind === 'git' ? (op.git as { kind: string }).kind : op.kind),
			push: ops.find(op => op.kind === 'pushBranch'),
			body: created.map(c => c.body),
			results: results.map(r => [r.ok, r.detail]),
		}).toEqual({
			ops: ['excludeBoardDir', 'status', 'currentBranch', 'addTracked', 'commit', 'aheadCount', 'fetch', 'refExists', 'pushBranch'],
			push: { kind: 'pushBranch', place: '/home/u/repo-worktrees/7', runId: expect.any(String), branch: 'para/7', setUpstream: true, interactive: true },
			body: ['Closes #3\n\nタスクボードが作ったドラフト PR です。'],
			results: [[true, '#5']],
		});
	});

});
