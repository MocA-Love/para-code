/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import assert from 'assert';
import { createHash } from 'crypto';
import { tmpdir } from 'os';
import { DeferredPromise, timeout } from '../../../../../base/common/async.js';
import { DisposableStore } from '../../../../../base/common/lifecycle.js';
import { isWindows } from '../../../../../base/common/platform.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { NullLogService } from '../../../../../platform/log/common/log.js';
import { IParadisScheduledRunDefinition, IParadisScheduledRunDraft, IParadisScheduledRunPrecheckResult, IParadisScheduledRunRequest, IParadisScheduledRunsResult } from '../../common/paradisScheduledRuns.js';
import { paradisParseCreateScheduledRun } from '../../common/paradisScheduledRunTools.js';
import { createParadisScheduledRunPrecheckRunner, ParadisScheduledRunPrecheckRunner } from '../../node/paradisScheduledRunPrecheck.js';
import { paradisScheduledRunDefinitionDigest } from '../../node/paradisScheduledRunsChannel.js';
import { ParadisScheduledRunsService } from '../../node/paradisScheduledRunsService.js';
import { ParadisScheduledRunToolProvider } from '../../node/paradisScheduledRunToolProvider.js';
import { IParadisMcpToolCallContext, ParadisMcpCallerKind } from '../../../agentBrowser/common/paradisMcpToolProvider.js';

function at(year: number, month: number, day: number, hour = 0, minute = 0): number {
	return new Date(year, month - 1, day, hour, minute).getTime();
}

const DRAFT: IParadisScheduledRunDraft = {
	name: 'PR のレビュー',
	schedule: '0 9 * * *',
	target: { kind: 'newSpace', repositoryUri: 'file:///repo', repositoryName: 'repo' },
	agentId: 'claude',
	prompt: '新しい PR を読んで',
	dailyLimit: 3,
	precheck: { command: 'gh pr list', timeoutSeconds: 60 },
};

suite('ParadisScheduledRunPrecheck', () => {
	const disposables = ensureNoDisposablesAreLeakedInTestSuite();

	function setup(runner: ParadisScheduledRunPrecheckRunner) {
		const state = { now: at(2026, 9, 25, 8, 0) };
		const calls: { command: string; cwd: string; timeoutMs: number }[] = [];
		const service = disposables.add(new ParadisScheduledRunsService({ read: async () => undefined, write: async () => { } }, { now: () => state.now }, new NullLogService(), {
			startTimer: false,
			precheckRunner: request => {
				calls.push({ command: request.command, cwd: request.cwd, timeoutMs: request.timeoutMs });
				return runner(request);
			},
		}));
		const requests: IParadisScheduledRunRequest[] = [];
		const store = disposables.add(new DisposableStore());
		store.add(service.onDidRequestRun(request => requests.push(request)));
		return { state, service, requests, calls };
	}

	/** 有効にして 9 時の回を開始待ちにし、ウィンドウが受け持つ。 */
	async function claimScheduledRun(context: ReturnType<typeof setup>, draft: IParadisScheduledRunDraft = DRAFT): Promise<string> {
		const saved: IParadisScheduledRunsResult = await context.service.save(draft);
		assert.ok(saved.ok, saved.error);
		await context.service.setEnabled(saved.definition!.id, true);
		context.state.now = at(2026, 9, 25, 9, 0) + 20_000;
		context.service.tick();
		const runId = context.requests[context.requests.length - 1].run.id;
		assert.ok(await context.service.claim('window:1', runId));
		return runId;
	}

	function runOf(service: ParadisScheduledRunsService, runId: string) {
		return service.getState().runs.find(run => run.id === runId)!;
	}

	test('skips the scheduled run when the precheck does not exit with 0, and keeps the result without starting the agent', async () => {
		const context = setup(async () => ({ exitCode: 1, durationMs: 800, output: 'no pull requests' }));
		await context.service.whenReady();
		const runId = await claimScheduledRun(context);
		const proceed = await context.service.runPrecheck('window:1', runId, true);
		const run = runOf(context.service, runId);
		assert.deepStrictEqual({ proceed, status: run.status, reason: run.reason, precheck: run.precheck, finished: run.finishedAt !== undefined, calls: context.calls.map(call => [call.command, call.timeoutMs]) }, {
			proceed: false, status: 'skipped', reason: 'precheckFailed', precheck: { exitCode: 1, durationMs: 800, output: 'no pull requests' }, finished: true, calls: [['gh pr list', 60_000]],
		});
	});

	test('starts the agent when the precheck exits with 0, and does not run it for untrusted repositories, other windows or manual runs', async () => {
		const context = setup(async () => ({ exitCode: 0, durationMs: 10 }));
		await context.service.whenReady();
		const passed = await claimScheduledRun(context);
		const otherWindow = await context.service.runPrecheck('window:2', passed, true);
		const proceed = await context.service.runPrecheck('window:1', passed, true);
		await context.service.report('window:1', { runId: passed, status: 'completed' });

		context.state.now = at(2026, 9, 26, 9, 0) + 20_000;
		context.service.tick();
		const untrusted = context.requests[context.requests.length - 1].run.id;
		await context.service.claim('window:1', untrusted);
		const untrustedProceed = await context.service.runPrecheck('window:1', untrusted, false);

		const manual = (await context.service.runNow(runOf(context.service, passed).definitionId)).run!.id;
		await context.service.claim('window:1', manual);
		const manualProceed = await context.service.runPrecheck('window:1', manual, true);

		assert.deepStrictEqual({
			otherWindow, proceed, passedStatus: runOf(context.service, passed).status,
			untrustedProceed, untrusted: [runOf(context.service, untrusted).status, runOf(context.service, untrusted).reason],
			manualProceed, manualStatus: runOf(context.service, manual).status, calls: context.calls.length,
		}, {
			otherWindow: false, proceed: true, passedStatus: 'completed',
			untrustedProceed: false, untrusted: ['skipped', 'precheckUntrusted'],
			manualProceed: true, manualStatus: 'starting', calls: 1,
		});
	});

	test('stopping the run while the precheck runs stops the command and keeps the run stopped', async () => {
		const result = new DeferredPromise<IParadisScheduledRunPrecheckResult>();
		let aborted = false;
		const context = setup(async request => {
			request.signal?.addEventListener('abort', () => { aborted = true; });
			return result.p;
		});
		await context.service.whenReady();
		const runId = await claimScheduledRun(context);
		const pending = context.service.runPrecheck('window:1', runId, true);
		await timeout(0);
		await context.service.report('window:1', { runId, status: 'cancelled', reason: 'windowClosed' });
		result.complete({ exitCode: 0, durationMs: 5 });
		const proceed = await pending;
		const run = runOf(context.service, runId);
		assert.deepStrictEqual({ proceed, aborted, status: run.status, reason: run.reason, precheck: run.precheck }, { proceed: false, aborted: true, status: 'cancelled', reason: 'windowClosed', precheck: undefined });
	});

	test('refuses a precheck for a repository on another machine and keeps the digest of definitions without a precheck', async () => {
		const context = setup(async () => ({ exitCode: 0, durationMs: 0 }));
		await context.service.whenReady();
		const remote = await context.service.save({ ...DRAFT, target: { ...DRAFT.target, repositoryUri: 'vscode-remote://ssh-remote+host/repo' } });
		const { precheck: _precheck, ...withoutPrecheck } = DRAFT;
		const plain = await context.service.save(withoutPrecheck);
		const definition: IParadisScheduledRunDefinition = plain.definition!;
		// 事前確認を足す前と同じ式で作った指紋（足す前から有効だった定義を、更新しただけで無効に戻さないこと）
		const { id, name, enabled, schedule, target, agentId, modelId, effortId, permissionId, prompt, dailyLimit } = definition;
		const before = createHash('sha256').update(JSON.stringify([id, name, enabled, schedule, target.kind, target.repositoryUri, target.repositoryName, target.baseRef ?? '', agentId, modelId ?? '', effortId ?? '', permissionId ?? '', prompt, dailyLimit])).digest('hex');
		assert.deepStrictEqual({
			remote: remote.ok,
			plainHasPrecheck: Object.keys(definition).includes('precheck'),
			sameDigest: paradisScheduledRunDefinitionDigest(definition) === before,
			precheckChangesDigest: paradisScheduledRunDefinitionDigest({ ...definition, precheck: { command: 'true', timeoutSeconds: 60 } }) !== before,
		}, { remote: false, plainHasPrecheck: false, sameDigest: true, precheckChangesDigest: true });
	});

	test('refuses a precheck for WSL and network folders, and keeps the agent-created mark until the user enables it', async () => {
		const context = setup(async () => ({ exitCode: 0, durationMs: 0 }));
		await context.service.whenReady();
		const wsl = await context.service.save({ ...DRAFT, target: { ...DRAFT.target, repositoryUri: 'file://wsl.localhost/Ubuntu/home/repo' } });
		const local = await context.service.save({ ...DRAFT, target: { ...DRAFT.target, repositoryUri: 'file:///c%3A/work/repo' } });
		const byAgent = (await context.service.save({ ...DRAFT, createdByAgent: true })).definition!;
		const edited = (await context.service.save({ ...DRAFT, id: byAgent.id, name: 'edited' })).definition!;
		const enabled = (await context.service.setEnabled(byAgent.id, true)).definition!;
		const disabledAgain = (await context.service.setEnabled(byAgent.id, false)).definition!;
		assert.deepStrictEqual({
			wsl: wsl.ok, local: local.ok,
			created: [byAgent.createdByAgent, byAgent.agentReviewPending],
			edited: [edited.createdByAgent, edited.agentReviewPending],
			enabled: [enabled.createdByAgent, enabled.agentReviewPending],
			disabledAgain: [disabledAgain.createdByAgent, disabledAgain.agentReviewPending],
		}, {
			wsl: false, local: true,
			created: [true, true],
			edited: [true, true],
			enabled: [true, undefined],
			disabledAgain: [true, undefined],
		});
	});

	(isWindows ? test.skip : test)('runs the command in a shell and reports the exit code, the output and a timeout', async () => {
		const runner = createParadisScheduledRunPrecheckRunner(async () => process.env);
		const cwd = tmpdir();
		const passed = await runner({ command: 'echo hello; exit 0', cwd, timeoutMs: 10_000 });
		const failed = await runner({ command: 'echo nope >&2; exit 3', cwd, timeoutMs: 10_000 });
		const slow = await runner({ command: 'sleep 5', cwd, timeoutMs: 200 });
		assert.deepStrictEqual({
			passed: [passed.exitCode, passed.output],
			failed: [failed.exitCode, failed.output],
			slow: [slow.timedOut, slow.exitCode, slow.durationMs < 4000],
		}, { passed: [0, 'hello'], failed: [3, 'nope'], slow: [true, undefined, true] });
	});

	test('the MCP tool accepts only calls from the pane itself and checks the arguments', async () => {
		const provider = new ParadisScheduledRunToolProvider();
		const sent: unknown[] = [];
		const contextFor = (caller: ParadisMcpCallerKind): IParadisMcpToolCallContext => ({
			classifyCaller: async () => caller,
			callOwningWindow: async <T>(request: { args: unknown[] }) => {
				sent.push(request.args[1]);
				return { ok: true as const, value: { ok: true, data: { id: 'x' } } as T };
			},
			getPaneAgentStatus: () => undefined,
			getUnconfirmedRelease: () => undefined,
			hasAgentHookHistory: () => false,
		});
		const args = { name: 'Review', schedule: '0 9 * * 1-5', prompt: 'Review new PRs', target: 'new_space', precheck_command: 'gh pr list' };
		const tunnel = await provider.callTool('tok', 'create_scheduled_run', args, undefined, contextFor('tunnel')) as { isError?: boolean };
		const bad = await provider.callTool('tok', 'create_scheduled_run', { ...args, enabled: true }, undefined, contextFor('pane')) as { isError?: boolean };
		const ok = await provider.callTool('tok', 'create_scheduled_run', args, undefined, contextFor('pane')) as { isError?: boolean };
		const other = await provider.callTool('tok', 'list_bookmarks', {}, undefined, contextFor('pane'));
		assert.deepStrictEqual({ tunnel: tunnel.isError, bad: bad.isError, ok: ok.isError, other, sent }, {
			tunnel: true, bad: true, ok: undefined, other: undefined,
			sent: [{ name: 'Review', schedule: '0 9 * * 1-5', prompt: 'Review new PRs', target: 'newSpace', dailyLimit: 3, precheck: { command: 'gh pr list', timeoutSeconds: 60 } }],
		});
		assert.deepStrictEqual(paradisParseCreateScheduledRun({ name: 'a', schedule: 's', prompt: 'p', precheck_timeout_seconds: 30 }).ok, false);
	});
});
