/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import assert from 'assert';
import { URI } from '../../../../../base/common/uri.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { IConfigurationService } from '../../../../../platform/configuration/common/configuration.js';
import { IInstantiationService, ServicesAccessor } from '../../../../../platform/instantiation/common/instantiation.js';
import { ITerminalGroupService, ITerminalService } from '../../../../../workbench/contrib/terminal/browser/terminal.js';
import { IParadisAgentModelCatalogService } from '../../../agentModelCatalog/common/paradisAgentModelCatalog.js';
import { IParadisMobileRequestHost, paradisDispatchMobileRequest } from '../../electron-browser/paradisMobileRequestHandlers.js';
import { paradisDefaultMobileAgentId } from '../../electron-browser/paradisMobileAgentPromptDelivery.js';
// W2-15 の処理を登録表へ載せる（副作用 import）
import '../../electron-browser/paradisMobileScmSyncRequests.js';

interface IReply {
	readonly id: string;
	readonly error?: string;
	readonly code?: string;
	readonly [key: string]: unknown;
}

type GitResult = { code: number; stdout: string; stderr: string };

/** git の代わり。呼ばれた引数を控え、`respond` の答えを返す（無ければ成功で空）。 */
class FakeGit {
	readonly calls: string[] = [];
	constructor(private readonly respond: (args: readonly string[]) => Partial<GitResult> | undefined = () => undefined) { }

	async run(args: readonly string[]): Promise<GitResult> {
		this.calls.push(args.join(' '));
		return { code: 0, stdout: '', stderr: '', ...this.respond(args) };
	}
}

const TREE = 'c'.repeat(40);

suite('ParadisMobileScmSyncRequests', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	function createHost(git: FakeGit, sent: IReply[], services = new Map<unknown, unknown>()): IParadisMobileRequestHost {
		return {
			// 使わないサービスは空で埋める
			invokeFunction: fn => fn({ get: id => services.get(id) ?? {} } as ServicesAccessor),
			resolveRoot: ws => ws === 'repo' ? URI.file('/repo') : undefined,
			runGit: (_root, args) => git.run(args),
			resolvePath: async (_ws, relativePath) => URI.file(`/repo/${relativePath}`),
			getMobileCapabilities: async () => undefined,
			getMobileWireVersion: async () => undefined,
			send: (_channel, _mobileId, payload) => sent.push(JSON.parse(new TextDecoder().decode(payload))),
			pushState: () => undefined,
		};
	}

	const flush = async () => {
		for (let turn = 0; turn < 10; turn++) {
			await new Promise<void>(resolve => setTimeout(resolve, 0));
		}
	};
	const dispatch = (host: IParadisMobileRequestHost, body: Record<string, unknown>) => paradisDispatchMobileRequest('scm', { ws: 'repo', ...body }, 'phone', host);
	const reply = (sent: readonly IReply[], id: string) => sent.find(candidate => candidate.id === id);

	test('pushes the current branch to its upstream by name, publishes a new branch to origin, and explains rejections', async () => {
		let branches = ' \0origin\0refs/heads/main\0main\n*\0origin\0refs/heads/feature\0feature\n';
		let pushResult: Partial<GitResult> = {};
		const git = new FakeGit(args => args[0] === 'branch' ? { stdout: branches }
			: args[0] === 'remote' ? { stdout: 'upstream\norigin\n' }
				: args[0] === 'push' ? pushResult
					: args[0] === 'status' ? { stdout: '# branch.upstream origin/feature\n# branch.ab +0 -0\n' } : undefined);
		const sent: IReply[] = [];
		const host = createHost(git, sent);

		dispatch(host, { t: 'push', id: '1' });
		await flush();
		branches = '*\0\0\0new-branch\n';
		dispatch(host, { t: 'push', id: '2' });
		await flush();
		pushResult = { code: 1, stdout: 'To github.com:o/r.git\n!\tHEAD:refs/heads/feature\t[rejected] (fetch first)\n', stderr: 'error: failed to push some refs' };
		branches = '*\0origin\0refs/heads/feature\0feature\n';
		dispatch(host, { t: 'push', id: '3' });
		await flush();

		assert.deepStrictEqual({
			pushes: git.calls.filter(call => call.startsWith('push')),
			first: reply(sent, '1'),
			published: reply(sent, '2')?.published,
			rejected: reply(sent, '3')?.code,
		}, {
			pushes: [
				'push --porcelain origin HEAD:refs/heads/feature',
				'push --porcelain --set-upstream origin HEAD:refs/heads/new-branch',
				'push --porcelain origin HEAD:refs/heads/feature',
			],
			first: { t: 'push', ws: 'repo', upstream: 'origin/feature', ahead: 0, behind: 0, id: '1' },
			published: true,
			rejected: 'rejected',
		});
	});

	test('pulls only fast-forward, refuses without an upstream, and runs one git operation per space at a time', async () => {
		let upstream = '# branch.upstream origin/feature\n# branch.ab +0 -2\n';
		const git = new FakeGit(args => args[0] === 'status' ? { stdout: upstream } : undefined);
		const sent: IReply[] = [];
		const host = createHost(git, sent);

		dispatch(host, { t: 'pull', id: '1' });
		dispatch(host, { t: 'fetch', id: 'busy' });
		await flush();
		upstream = '';
		dispatch(host, { t: 'pull', id: '2' });
		await flush();

		assert.deepStrictEqual({
			pulls: git.calls.filter(call => call.startsWith('pull')),
			busy: reply(sent, 'busy')?.code,
			noUpstream: reply(sent, '2')?.code,
		}, { pulls: ['pull --ff-only --no-rebase --quiet'], busy: 'busy', noUpstream: 'no-upstream' });
	});

	test('restores the staged state when the commit fails, returns a redacted summary, and hands it to the default agent', async () => {
		const git = new FakeGit(args => args[0] === 'write-tree' ? { stdout: `${TREE}\n` }
			: args[0] === 'commit' ? { code: 1, stderr: 'husky - pre-commit hook exited with code 1\nAPI_TOKEN=supersecretvalue123\n✖ eslint found 2 problems' }
				: args[0] === 'rev-parse' ? { stdout: 'feature\n' }
					: args[0] === 'status' ? { stdout: ' M a.ts\n?? b.ts\n' } : undefined);
		const launched: { agentId: string; stateKey: string; prompt?: string }[] = [];
		const services = new Map<unknown, unknown>([
			[ITerminalService, { instances: [] }],
			[ITerminalGroupService, { paradisParkedGroups: [] }],
			[IConfigurationService, { getValue: () => '' }],
			[IParadisAgentModelCatalogService, { getAgentTemplates: () => [{ id: 'claude' }, { id: 'codex' }] }],
			[IInstantiationService, { invokeFunction: async (_fn: unknown, request: { agentId: string; stateKey: string; prompt?: string }) => { launched.push(request); } }],
		]);
		const sent: IReply[] = [];
		const host = createHost(git, sent, services);

		dispatch(host, { t: 'commitSafe', id: '1', message: 'feat: x', all: true });
		await flush();
		const failure = reply(sent, '1')?.failure as { id: string; kind: string; restored: boolean; output: string };
		dispatch(host, { t: 'commitFix', id: '2', failureId: 'someone-else', target: 'auto' });
		dispatch(host, { t: 'commitFix', id: '3', failureId: failure.id, target: 'auto' });
		await flush();

		assert.deepStrictEqual({
			sequence: git.calls.slice(0, 4),
			ok: reply(sent, '1')?.ok,
			kind: failure.kind,
			restored: failure.restored,
			leaked: failure.output.includes('supersecretvalue123'),
			wrongId: reply(sent, '2')?.code,
			fixed: reply(sent, '3'),
			launched: launched.map(request => ({ agentId: request.agentId, stateKey: request.stateKey, hasOutput: request.prompt?.includes('eslint found 2 problems'), leaked: request.prompt?.includes('supersecretvalue123') })),
		}, {
			sequence: ['write-tree', 'add -A', 'commit -m feat: x', `read-tree ${TREE}`],
			ok: false,
			kind: 'lint',
			restored: true,
			leaked: false,
			wrongId: 'gone',
			fixed: { t: 'commitFix', delivered: true, via: 'launch', id: '3' },
			launched: [{ agentId: 'claude', stateKey: 'repo', hasOutput: true, leaked: false }],
		});
	});

	test('commits staged changes only without touching the index, and does not restore on success', async () => {
		const git = new FakeGit(args => args[0] === 'commit' ? { stdout: '[main abc] feat\n 1 file changed\n' } : undefined);
		const sent: IReply[] = [];
		const host = createHost(git, sent);

		dispatch(host, { t: 'commitSafe', id: '1', message: '  feat  ', all: false });
		await flush();
		dispatch(host, { t: 'commitSafe', id: 'empty', message: '   ' });
		await flush();

		assert.deepStrictEqual({ calls: git.calls, ok: reply(sent, '1'), empty: reply(sent, 'empty')?.error }, {
			calls: ['commit -m feat'],
			ok: { t: 'commitSafe', ok: true, output: '[main abc] feat\n 1 file changed', id: '1' },
			empty: 'empty commit message',
		});
	});

	test('stages and unstages single files by literal path, including the original side of a staged rename', async () => {
		const git = new FakeGit(args => args[0] === 'status' ? { stdout: ' M a.ts\nR  old.ts -> new.ts\n?? *.md\nM  staged.ts\n' } : undefined);
		const sent: IReply[] = [];
		const host = createHost(git, sent);

		dispatch(host, { t: 'stage', id: '1', paths: ['a.ts', '*.md', 'staged.ts', 'gone.ts'] });
		await flush();
		dispatch(host, { t: 'unstage', id: '2', paths: ['new.ts', 'a.ts'] });
		await flush();
		dispatch(host, { t: 'stage', id: 'bad', paths: ['"quoted"'] });
		await flush();

		assert.deepStrictEqual({
			writes: git.calls.filter(call => !call.startsWith('status')),
			stage: reply(sent, '1'),
			unstage: reply(sent, '2'),
			bad: reply(sent, 'bad')?.error,
		}, {
			writes: ['add -- :(literal)a.ts :(literal)*.md', 'restore --staged -- :(literal)new.ts :(literal)old.ts'],
			stage: { t: 'stage', ws: 'repo', done: ['a.ts', '*.md'], skipped: ['staged.ts', 'gone.ts'], id: '1' },
			unstage: { t: 'unstage', ws: 'repo', done: ['new.ts'], skipped: ['a.ts'], id: '2' },
			bad: 'invalid paths',
		});
	});

	test('picks the configured default agent, falling back to the first configured one', () => {
		assert.deepStrictEqual([
			paradisDefaultMobileAgentId('codex', ['claude', 'codex']),
			paradisDefaultMobileAgentId('none', ['claude', 'codex']),
			paradisDefaultMobileAgentId('removed', ['claude']),
			paradisDefaultMobileAgentId('', []),
		], ['codex', 'claude', 'claude', undefined]);
	});
});
