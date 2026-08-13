/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese test comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import assert from 'assert';
import { CancellationError } from '../../../../../base/common/errors.js';
import { DeferredPromise } from '../../../../../base/common/async.js';
import { URI } from '../../../../../base/common/uri.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { ServicesAccessor } from '../../../../../platform/instantiation/common/instantiation.js';
import { TerminalLocation } from '../../../../../platform/terminal/common/terminal.js';
import { ITerminalEditorService, ITerminalInstance, ITerminalService } from '../../../../../workbench/contrib/terminal/browser/terminal.js';
import { IParadisTerminalScopeService, IParadisWorkspaceSwitchService } from '../../../workspaceSwitch/common/paradisWorkspaceSwitch.js';
import { paradisResumeAgentInWorkspace } from '../../../workspaceSwitch/electron-browser/paradisWorktreeHeadlessCreate.js';
import { paradisSessionResumeEditorActionOptions, paradisResumeSessionFromEditor } from '../../electron-browser/paradisSessionResumeOrchestration.js';

suite('ParadisSessionResumeEditor', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	const target = {
		rootUri: URI.file('/repo-worktrees/feature'),
		stateKey: 'worktree:feature',
		agent: 'claude' as const,
		sessionId: 'session-123',
	};

	test('maps each editor button to its resume mode and permission behavior', () => {
		assert.deepStrictEqual([
			paradisSessionResumeEditorActionOptions('background'),
			paradisSessionResumeEditorActionOptions('primary'),
			paradisSessionResumeEditorActionOptions('dangerous'),
		], [
			{ mode: 'background', dangerouslyBypassPermissions: false },
			{ mode: 'foreground', dangerouslyBypassPermissions: false },
			{ mode: 'foreground', dangerouslyBypassPermissions: true },
		]);
	});

	test('switches only for a foreground resume in another space', async () => {
		const cases = [
			{ currentSpace: true, mode: 'foreground' as const, expected: ['resume'] },
			{ currentSpace: false, mode: 'background' as const, expected: ['resume'] },
			{ currentSpace: false, mode: 'foreground' as const, expected: ['switch:worktree:feature', 'resume'] },
		];

		for (const testCase of cases) {
			const events: string[] = [];
			await paradisResumeSessionFromEditor(
				{ ...target, currentSpace: testCase.currentSpace },
				{ mode: testCase.mode, dangerouslyBypassPermissions: false },
				{
					switchToStateKey: async stateKey => { events.push(`switch:${stateKey}`); },
					resumeAgent: async () => { events.push('resume'); },
				},
			);
			assert.deepStrictEqual(events, testCase.expected);
		}
	});

	test('forwards dangerous permission mode to the resume command request', async () => {
		const requests: unknown[] = [];
		await paradisResumeSessionFromEditor(
			{ ...target, currentSpace: true, agent: 'codex' },
			{ mode: 'foreground', dangerouslyBypassPermissions: true },
			{
				switchToStateKey: async () => { throw new Error('must not switch'); },
				resumeAgent: async request => { requests.push(request); },
			},
		);

		assert.deepStrictEqual(requests, [{
			rootUri: target.rootUri,
			stateKey: target.stateKey,
			agent: 'codex',
			sessionId: target.sessionId,
			dangerouslyBypassPermissions: true,
		}]);
	});

	test('does not start the agent when switching fails or is cancelled', async () => {
		for (const error of [new Error('switch failed'), new CancellationError()]) {
			let resumeCount = 0;
			await assert.rejects(paradisResumeSessionFromEditor(
				{ ...target, currentSpace: false },
				{ mode: 'foreground', dangerouslyBypassPermissions: false },
				{
					switchToStateKey: async () => { throw error; },
					resumeAgent: async () => { resumeCount++; },
				},
			), candidate => candidate === error);
			assert.strictEqual(resumeCount, 0);
		}
	});
});

suite('paradisResumeAgentInWorkspace', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	interface IFixture {
		readonly accessor: ServicesAccessor;
		readonly events: string[];
		readonly ready: DeferredPromise<void>;
	}

	function createFixture(options?: { activeStateKey?: string; openError?: Error }): IFixture {
		const events: string[] = [];
		const ready = new DeferredPromise<void>();
		const instance = {
			instanceId: 17,
			processReady: ready.p.then(() => { events.push('ready'); }),
			sendText: async (command: string, shouldExecute: boolean) => { events.push(`send:${command}:${shouldExecute}`); },
		} as unknown as ITerminalInstance;
		const terminalService = {
			createTerminal: async (terminalOptions: { cwd?: URI; location?: TerminalLocation }) => {
				assert.strictEqual(terminalOptions.cwd?.toString(), URI.file('/repo-worktrees/feature').toString());
				assert.strictEqual(terminalOptions.location, TerminalLocation.Editor);
				events.push('create');
				return instance;
			},
			setActiveInstance: (candidate: ITerminalInstance) => { assert.strictEqual(candidate, instance); events.push('active'); },
		} as unknown as ITerminalService;
		const terminalEditorService = {
			openEditor: async (candidate: ITerminalInstance) => {
				assert.strictEqual(candidate, instance);
				events.push('open');
				if (options?.openError) {
					throw options.openError;
				}
			},
		} as unknown as ITerminalEditorService;
		const terminalScopeService = {
			assignInstanceScope: (instanceId: number, stateKey: string) => { events.push(`assign:${instanceId}:${stateKey}`); },
		} as unknown as IParadisTerminalScopeService;
		const switchService = {
			activeStateKey: options?.activeStateKey ?? 'another-space',
		} as unknown as IParadisWorkspaceSwitchService;
		const accessor = {
			get: (service: unknown) => {
				if (service === ITerminalService) { return terminalService; }
				if (service === ITerminalEditorService) { return terminalEditorService; }
				if (service === IParadisTerminalScopeService) { return terminalScopeService; }
				if (service === IParadisWorkspaceSwitchService) { return switchService; }
				throw new Error(`Unexpected service: ${String(service)}`);
			},
		} as ServicesAccessor;
		return { accessor, events, ready };
	}

	function request(agent: 'claude' | 'codex', dangerouslyBypassPermissions = false) {
		return {
			rootUri: URI.file('/repo-worktrees/feature'),
			stateKey: 'worktree:feature',
			agent,
			sessionId: 'session-123',
			dangerouslyBypassPermissions,
		};
	}

	test('waits for process readiness before opening, assigning, activating, and sending', async () => {
		const fixture = createFixture({ activeStateKey: 'worktree:feature' });
		const result = paradisResumeAgentInWorkspace(fixture.accessor, request('claude'));
		await Promise.resolve();
		await Promise.resolve();
		assert.deepStrictEqual(fixture.events, ['create']);

		fixture.ready.complete();
		await result;
		assert.deepStrictEqual(fixture.events, [
			'create',
			'ready',
			'open',
			'assign:17:worktree:feature',
			'active',
			'send:claude --resume session-123:true',
		]);
	});

	test('uses the agent-specific dangerous flag', async () => {
		const cases = [
			{ agent: 'claude' as const, dangerous: false, command: 'claude --resume session-123' },
			{ agent: 'claude' as const, dangerous: true, command: 'claude --dangerously-skip-permissions --resume session-123' },
			{ agent: 'codex' as const, dangerous: false, command: 'codex resume session-123' },
			{ agent: 'codex' as const, dangerous: true, command: 'codex --dangerously-bypass-approvals-and-sandbox resume session-123' },
		];
		for (const testCase of cases) {
			const fixture = createFixture();
			fixture.ready.complete();
			await paradisResumeAgentInWorkspace(fixture.accessor, request(testCase.agent, testCase.dangerous));
			assert.deepStrictEqual(fixture.events, [
				'create',
				'ready',
				'open',
				'assign:17:worktree:feature',
				`send:${testCase.command}:true`,
			]);
		}
	});

	test('rejects empty and option-like session IDs before creating a terminal', async () => {
		for (const sessionId of ['', '--dangerously-skip-permissions']) {
			const fixture = createFixture();
			await assert.rejects(paradisResumeAgentInWorkspace(fixture.accessor, {
				...request('claude'),
				sessionId,
			}), /Invalid agent session id/);
			assert.deepStrictEqual(fixture.events, []);
		}
	});

	test('does not send a command when process startup, cancellation, or editor opening fails', async () => {
		for (const error of [new Error('process failed'), new CancellationError()]) {
			const fixture = createFixture();
			const result = paradisResumeAgentInWorkspace(fixture.accessor, request('codex'));
			await Promise.resolve();
			await Promise.resolve();
			fixture.ready.error(error);
			await assert.rejects(result, candidate => candidate === error);
			assert.strictEqual(fixture.events.some(event => event.startsWith('send:')), false);
		}

		const openError = new Error('open failed');
		const fixture = createFixture({ openError });
		fixture.ready.complete();
		await assert.rejects(paradisResumeAgentInWorkspace(fixture.accessor, request('codex')), candidate => candidate === openError);
		assert.strictEqual(fixture.events.some(event => event.startsWith('send:')), false);
	});
});
