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
import { ISharedProcessService } from '../../../../../platform/ipc/electron-browser/services.js';
import { ITerminalGroupService, ITerminalService } from '../../../../../workbench/contrib/terminal/browser/terminal.js';
import { IRemoteAgentService } from '../../../../../workbench/services/remote/common/remoteAgentService.js';
import { IParadisAgentModelCatalogService } from '../../../agentModelCatalog/common/paradisAgentModelCatalog.js';
import { IParadisPullRequestDetail, ParadisPullRequestLookup } from '../../common/paradisMobilePullRequest.js';
import { IParadisMobileRequestHost, paradisDispatchMobileRequest } from '../../electron-browser/paradisMobileRequestHandlers.js';
// W2-36 の処理を登録表へ載せる（副作用 import）
import '../../electron-browser/paradisMobilePullRequestRequests.js';

interface IReply {
	readonly id: string;
	readonly error?: string;
	readonly code?: string;
	readonly [key: string]: unknown;
}

const HEAD = 'd'.repeat(40);

function detail(overrides: Partial<IParadisPullRequestDetail> = {}): IParadisPullRequestDetail {
	return {
		number: 9, title: 'Add PR screen', url: 'https://github.com/o/r/pull/9', state: 'open', repo: 'o/r', headRefName: 'feat', headSha: HEAD,
		checks: [{ name: 'build', bucket: 'pass' }], ...overrides,
	};
}

/** git channel の代わり（`getPullRequestDetail` / `getFailedJobLogs` / `mergePullRequest`）。 */
class FakeChannel {
	readonly calls: { readonly command: string; readonly args: readonly unknown[] }[] = [];
	lookup: ParadisPullRequestLookup = { kind: 'ok', detail: detail() };
	logs: { jobId: string; log?: string }[] = [];

	async call(command: string, args: readonly unknown[]): Promise<unknown> {
		this.calls.push({ command, args });
		switch (command) {
			case 'getPullRequestDetail': return this.lookup;
			case 'getFailedJobLogs': return this.logs;
			case 'mergePullRequest': return { method: 'squash' };
			default: throw new Error(`Method not found: ${command}`);
		}
	}
}

suite('ParadisMobilePullRequestRequests', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	function createHost(channel: FakeChannel, sent: IReply[], extra: [unknown, unknown][] = []): IParadisMobileRequestHost {
		const services = new Map<unknown, unknown>([
			[IRemoteAgentService, { getConnection: () => null }],
			[ISharedProcessService, { getChannel: () => channel }],
			...extra,
		]);
		return {
			invokeFunction: fn => fn({ get: id => services.get(id) ?? {} } as ServicesAccessor),
			resolveRoot: ws => ws === 'repo' ? URI.file('/repo') : undefined,
			runGit: async () => ({ code: 0, stdout: '', stderr: '' }),
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

	test('returns the pull request of the space, or why it cannot be shown', async () => {
		const channel = new FakeChannel();
		const sent: IReply[] = [];
		const host = createHost(channel, sent);

		dispatch(host, { t: 'prView', id: '1' });
		await flush();
		channel.lookup = { kind: 'none', reason: 'no-auth' };
		dispatch(host, { t: 'prView', id: '2' });
		await flush();

		assert.deepStrictEqual({ first: reply(sent, '1'), second: reply(sent, '2'), path: channel.calls[0].args }, {
			first: { t: 'prView', ws: 'repo', pr: detail(), id: '1' },
			second: { t: 'prView', ws: 'repo', unavailable: 'no-auth', id: '2' },
			path: ['/repo'],
		});
	});

	test('merges only the head the phone saw, and never while checks fail or run', async () => {
		const channel = new FakeChannel();
		const sent: IReply[] = [];
		const host = createHost(channel, sent);

		dispatch(host, { t: 'prMerge', id: 'moved', number: 9, headSha: 'e'.repeat(40) });
		await flush();
		channel.lookup = { kind: 'ok', detail: detail({ checks: [{ name: 'build', bucket: 'pending' }] }) };
		dispatch(host, { t: 'prMerge', id: 'pending', number: 9, headSha: HEAD });
		await flush();
		channel.lookup = { kind: 'ok', detail: detail() };
		dispatch(host, { t: 'prMerge', id: 'other', number: 10, headSha: HEAD });
		dispatch(host, { t: 'prMerge', id: 'busy', number: 9, headSha: HEAD });
		await flush();
		dispatch(host, { t: 'prMerge', id: 'ok', number: 9, headSha: HEAD.toUpperCase() });
		await flush();

		assert.deepStrictEqual({
			moved: reply(sent, 'moved')?.code,
			pending: reply(sent, 'pending')?.code,
			other: reply(sent, 'other')?.code,
			busy: reply(sent, 'busy')?.code,
			ok: reply(sent, 'ok'),
			merges: channel.calls.filter(call => call.command === 'mergePullRequest').map(call => call.args[1]),
		}, {
			moved: 'head-changed',
			pending: 'checks-pending',
			// PC が取り直した PR と番号が違う
			other: 'changed',
			// 同じスペースの PR の操作は1本ずつ
			busy: 'busy',
			ok: { t: 'prMerge', ws: 'repo', merged: true, method: 'squash', id: 'ok' },
			merges: [{ repo: 'o/r', number: 9, headSha: HEAD }],
		});
	});

	test('asks the default agent to fix failed checks with the tail of their logs, redacted', async () => {
		const channel = new FakeChannel();
		channel.lookup = {
			kind: 'ok', detail: detail({
				checks: [
					{ name: 'unit', bucket: 'fail', jobId: '31', repo: 'o/r', url: 'https://github.com/o/r/actions/runs/1/job/31' },
					{ name: 'lint', bucket: 'pass' },
				],
			}),
		};
		channel.logs = [{ jobId: '31', log: 'AssertionError: expected 1\nNPM_TOKEN=npm_abcdefghijklmnopqrstuvwxyz' }];
		const launched: { agentId: string; prompt?: string }[] = [];
		const sent: IReply[] = [];
		const host = createHost(channel, sent, [
			[ITerminalService, { instances: [] }],
			[ITerminalGroupService, { paradisParkedGroups: [] }],
			[IConfigurationService, { getValue: () => 'codex' }],
			[IParadisAgentModelCatalogService, { getAgentTemplates: () => [{ id: 'claude' }, { id: 'codex' }] }],
			[IInstantiationService, { invokeFunction: async (_fn: unknown, request: { agentId: string; prompt?: string }) => { launched.push(request); } }],
		]);

		dispatch(host, { t: 'prFixChecks', id: '1', number: 9, target: 'new' });
		dispatch(host, { t: 'prFixChecks', id: 'bad', number: 9, target: { terminalKey: 't' } });
		await flush();

		assert.deepStrictEqual({
			reply: reply(sent, '1'),
			bad: reply(sent, 'bad')?.error,
			jobs: channel.calls.filter(call => call.command === 'getFailedJobLogs').map(call => call.args[1]),
			agent: launched.map(request => request.agentId),
			hasLog: launched[0]?.prompt?.includes('AssertionError: expected 1'),
			leaked: launched[0]?.prompt?.includes('npm_abcdefghijklmnopqrstuvwxyz'),
		}, {
			reply: { t: 'prFixChecks', delivered: true, via: 'launch', id: '1' },
			bad: 'invalid request',
			jobs: [[{ jobId: '31', repo: 'o/r' }]],
			agent: ['codex'],
			hasLog: true,
			leaked: false,
		});
	});
});
