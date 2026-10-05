/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese test comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import assert from 'assert';
import { mkdir, mkdtemp, realpath, rm, utimes, writeFile } from 'fs/promises';
import { createRequire } from 'module';
import { tmpdir } from 'os';
import * as sinon from 'sinon';
import { join } from '../../../../../base/common/path.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { NullLogService } from '../../../../../platform/log/common/log.js';
import { fireParadisAgentHookEvent, fireParadisAgentNestedHookEvent } from '../../../agentBrowser/node/paradisAgentHookBus.js';
import { paradisClaudeConfigDir, paradisCodexHome } from '../../../agentBrowser/node/paradisAgentHome.js';
import { ParadisMobileAgentChat, paradisAgentChatImageLimitsForTest, paradisClaudeAgentIdFromTranscriptPath, paradisClaudeRootTranscriptPath, paradisClaudeSubagentTranscriptCandidates, paradisCliDiscoveryCandidateIsFresh, paradisCodexForkCandidateAllowed, paradisConfirmedAgentPaneTokens, paradisHasPendingDuplicateQuestion, paradisIsCodexDaemonApprovalInteraction, paradisIsCodexRootThreadSource, paradisIsValidAgentInboundForTest, paradisParseClaudeTranscriptLineForTest, paradisParseCodexDetailLinesForTest, paradisParseCodexSessionMeta, paradisParseCodexThreadSource, paradisIsLateHookAfterTurnEnd, paradisParseCodexTranscriptLineForTest, paradisParseCodexTranscriptLinesForTest, paradisPickCurrentInteraction, paradisReadCodexForkHistory, paradisResolveHookSessionTranscript, paradisSelectUnambiguousSessionCandidate, paradisSharedImageCacheForTest, paradisTakeLiveQuestionSyntheticId, paradisToolImageMeta, paradisQuestionReadyMarker } from '../../node/paradisMobileAgentChat.js';
import { ParadisRemoteTranscriptMirrorStore } from '../../node/paradisRemoteTranscriptMirror.js';

const nodeRequire = createRequire(import.meta.url);

interface IDirectoryWalkBudget {
	mayRun(key: string): boolean;
	mark(key: string): void;
}

interface IDirectoryWalkFixture {
	readonly workspace: string;
	readonly claudeHome: string;
	readonly codexHome: string;
}

async function withDirectoryWalkFixture(run: (fixture: IDirectoryWalkFixture) => Promise<void>): Promise<void> {
	const root = await realpath(await mkdtemp(join(tmpdir(), 'paradis-directory-walk-')));
	const workspace = join(root, 'workspace');
	const claudeHome = join(root, 'claude-home');
	const codexHome = join(root, 'codex-home');
	await Promise.all([
		mkdir(workspace, { recursive: true }),
		mkdir(claudeHome, { recursive: true }),
		mkdir(codexHome, { recursive: true }),
	]);
	const previousClaudeHome = process.env['CLAUDE_CONFIG_DIR'];
	const previousCodexHome = process.env['CODEX_HOME'];
	process.env['CLAUDE_CONFIG_DIR'] = claudeHome;
	process.env['CODEX_HOME'] = codexHome;
	try {
		await run({ workspace: await realpath(workspace), claudeHome, codexHome });
	} finally {
		if (previousClaudeHome === undefined) {
			delete process.env['CLAUDE_CONFIG_DIR'];
		} else {
			process.env['CLAUDE_CONFIG_DIR'] = previousClaudeHome;
		}
		if (previousCodexHome === undefined) {
			delete process.env['CODEX_HOME'];
		} else {
			process.env['CODEX_HOME'] = previousCodexHome;
		}
		await rm(root, { recursive: true, force: true });
	}
}

function createDirectoryWalkBudget(allow: boolean): { readonly budget: IDirectoryWalkBudget; readonly events: { readonly method: 'mayRun' | 'mark'; readonly key: string }[] } {
	const events: { method: 'mayRun' | 'mark'; key: string }[] = [];
	return {
		events,
		budget: {
			mayRun: key => {
				events.push({ method: 'mayRun', key });
				return allow;
			},
			mark: key => events.push({ method: 'mark', key }),
		},
	};
}

function createChatWithDirectoryWalkBudget(budget: IDirectoryWalkBudget): ParadisMobileAgentChat {
	return new ParadisMobileAgentChat(
		() => { }, () => { }, () => { }, new NullLogService(),
		async () => true, () => { }, undefined, undefined, budget,
	);
}

async function scanOnePane(chat: ParadisMobileAgentChat, cwd: string): Promise<'claude' | 'codex' | undefined> {
	const token = 'pane-directory-walk';
	const access = chat as unknown as {
		paneSessions: Map<string, { readonly agent: 'claude' | 'codex' }>;
		scanPanesForUnclaimedSessions(): Promise<void>;
	};
	assert.strictEqual(chat.syncPanes(1, 'window-session', 1, 1, [{ terminalId: 1, token, cwd }]), true);
	await access.scanPanesForUnclaimedSessions();
	return access.paneSessions.get(token)?.agent;
}

function createEmptyCodexStateDatabase(codexHome: string): void {
	const { DatabaseSync } = nodeRequire('node:sqlite') as typeof import('node:sqlite');
	const database = new DatabaseSync(join(codexHome, 'state_1.sqlite'));
	try {
		database.exec(`
			CREATE TABLE threads (
				id TEXT PRIMARY KEY,
				rollout_path TEXT NOT NULL,
				source TEXT NOT NULL,
				cwd TEXT NOT NULL,
				archived INTEGER NOT NULL,
				updated_at_ms INTEGER,
				updated_at INTEGER,
				created_at_ms INTEGER,
				created_at INTEGER
			)
		`);
	} finally {
		database.close();
	}
}

async function waitFor(predicate: () => boolean, message: string): Promise<void> {
	const deadline = Date.now() + 2_000;
	while (!predicate()) {
		if (Date.now() >= deadline) {
			throw new Error(message);
		}
		await new Promise<void>(resolve => setTimeout(resolve, 5));
	}
}

suite('ParadisMobileAgentChat', () => {
	ensureNoDisposablesAreLeakedInTestSuite();
	teardown(() => sinon.restore());

	test('publishes only live panes with a confirmed agent session', () => {
		assert.deepStrictEqual(
			paradisConfirmedAgentPaneTokens(['pane-b', 'closed-pane', 'pane-a'], ['pane-a', 'plain-pane', 'pane-b']),
			['pane-a', 'pane-b'],
		);
	});

	test('holds back sessions carried over from the previous run until something proves they are alive', () => {
		// 覚えていることと動いていることは別。前回の起動で使ったセッションはディスクから
		// 戻ってくるので、覚えているだけを根拠にすると昨日終了したエージェントが並ぶ。
		// 一方で「最近書き込みがあったか」で判定してもいけない（質問待ちで放置されたものが
		// 落ちる）ので、証拠が付いたかどうかだけで決める。
		const live = ['restored-idle', 'restored-proven', 'found-this-run'];
		assert.deepStrictEqual(
			paradisConfirmedAgentPaneTokens(live, live, new Set(['restored-idle'])),
			['found-this-run', 'restored-proven'],
		);
	});

	test('uses globally unique pane tokens instead of window-local terminal IDs', () => {
		assert.deepStrictEqual(
			paradisConfirmedAgentPaneTokens(['window-2-pane-1'], ['window-1-pane-1', 'window-2-pane-1']),
			['window-2-pane-1'],
		);
	});

	test('validates each mobile agent inbound shape before dispatch', () => {
		assert.strictEqual(paradisIsValidAgentInboundForTest({ t: 'attach', id: 1, token: 'pane-1', epoch: 'epoch-1', afterRev: -1 }), true);
		assert.strictEqual(paradisIsValidAgentInboundForTest({ t: 'attach', id: 1, token: 'pane-1', liveEncoding: 'agent-live-append-v1' }), true);
		assert.strictEqual(paradisIsValidAgentInboundForTest({ t: 'model-catalog', id: 1, requestId: 'request-1' }), true);
		assert.strictEqual(paradisIsValidAgentInboundForTest({ t: 'command-catalog', id: 1, token: 'pane-1', requestId: 'request-1' }), true);
		assert.strictEqual(paradisIsValidAgentInboundForTest({ t: 'command-catalog', id: 1, token: 'pane-1', requestId: 'request-1', format: 2 }), true);
		assert.strictEqual(paradisIsValidAgentInboundForTest({ t: 'command-catalog', id: 1, token: 'pane-1', requestId: 'request-1', format: 3 }), false);
		assert.strictEqual(paradisIsValidAgentInboundForTest({ t: 'settings-update', id: 1, requestId: 'request-1', model: 'gpt-5', effort: 'high' }), true);
		assert.strictEqual(paradisIsValidAgentInboundForTest({ t: 'activity-detail', id: 1, requestId: 'request-1', epoch: 'epoch-1', activityId: 'agent-1' }), true);
		assert.strictEqual(paradisIsValidAgentInboundForTest({ t: 'action/answerQuestion', id: 1, requestId: 'request-1', epoch: 'epoch-1', interactionId: 'question-1', answers: [{ kind: 'multi', indices: [0, 2] }] }), true);

		assert.strictEqual(paradisIsValidAgentInboundForTest({ t: 'attach', id: 1, epoch: 1 }), false);
		assert.strictEqual(paradisIsValidAgentInboundForTest({ t: 'attach', id: 1, afterRev: -2 }), false);
		assert.strictEqual(paradisIsValidAgentInboundForTest({ t: 'attach', id: 1, liveEncoding: 1 }), false);
		assert.strictEqual(paradisIsValidAgentInboundForTest({ t: 'attach', id: 1, liveEncoding: 'x'.repeat(101) }), false);
		assert.strictEqual(paradisIsValidAgentInboundForTest({ t: 'model-catalog', id: 1 }), false);
		assert.strictEqual(paradisIsValidAgentInboundForTest({ t: 'command-catalog', id: 1 }), false);
		assert.strictEqual(paradisIsValidAgentInboundForTest({ t: 'command-catalog', id: 1, requestId: 'request-1', path: '/tmp' }), false);
		assert.strictEqual(paradisIsValidAgentInboundForTest({ t: 'settings-update', id: 1, requestId: 'request-1', model: 'gpt-5', effort: 3 }), false);
		assert.strictEqual(paradisIsValidAgentInboundForTest({ t: 'activity-detail', id: 1, requestId: 'request-1', epoch: 'epoch-1' }), false);
		assert.strictEqual(paradisIsValidAgentInboundForTest({ t: 'action/answerQuestion', id: 1, requestId: 'request-1', epoch: 'epoch-1', interactionId: 'question-1', answers: [{ kind: 'multi', indices: [0, '2'] }] }), false);
		assert.strictEqual(paradisIsValidAgentInboundForTest({ t: 'tool-image', id: 1, requestId: 'request-1', epoch: 'epoch-1', rev: 3, index: 0 }), true);
		assert.strictEqual(paradisIsValidAgentInboundForTest({ t: 'tool-image', id: 1, requestId: 'request-1', epoch: 'epoch-1', rev: 3 }), false);
		assert.strictEqual(paradisIsValidAgentInboundForTest({ t: 'tool-image', id: 1, requestId: 'request-1', epoch: 'epoch-1', rev: 3, index: -1 }), false);
		assert.strictEqual(paradisIsValidAgentInboundForTest({ t: 'tool-image', id: 1, requestId: 'request-1', epoch: 'epoch-1', rev: 3, index: 100 }), false);
		assert.strictEqual(paradisIsValidAgentInboundForTest({ t: 'tool-image', id: 1, requestId: 'request-1', rev: 3, index: 0 }), false);
		assert.strictEqual(paradisIsValidAgentInboundForTest({ t: 'unknown', id: 1 }), false);
	});

	test('validates the approval options request and opt:<n> answers (W2-21)', () => {
		assert.deepStrictEqual({
			options: paradisIsValidAgentInboundForTest({ t: 'approval-options', id: 1, token: 'pane-1', requestId: 'request-1', epoch: 'epoch-1', interactionId: 'approval:1:0' }),
			optionsWithoutInteraction: paradisIsValidAgentInboundForTest({ t: 'approval-options', id: 1, requestId: 'request-1', epoch: 'epoch-1' }),
			optAnswer: paradisIsValidAgentInboundForTest({ t: 'action/answerApproval', id: 1, requestId: 'request-1', epoch: 'epoch-1', interactionId: 'approval:1:0', choice: 'opt:2', optionLabel: 'Yes, and don\'t ask again' }),
			badLabel: paradisIsValidAgentInboundForTest({ t: 'action/answerApproval', id: 1, requestId: 'request-1', epoch: 'epoch-1', interactionId: 'approval:1:0', choice: 'opt:2', optionLabel: 3 }),
			longLabel: paradisIsValidAgentInboundForTest({ t: 'action/answerApproval', id: 1, requestId: 'request-1', epoch: 'epoch-1', interactionId: 'approval:1:0', choice: 'opt:2', optionLabel: 'x'.repeat(501) }),
			// 拒否に添える指示（agent.approval.detail.v1）は拒否にだけ、空でなく上限まで
			denyMessage: paradisIsValidAgentInboundForTest({ t: 'action/answerApproval', id: 1, requestId: 'request-1', epoch: 'epoch-1', interactionId: 'approval:1:0', choice: 'no', message: 'echo kept にして' }),
			allowMessage: paradisIsValidAgentInboundForTest({ t: 'action/answerApproval', id: 1, requestId: 'request-1', epoch: 'epoch-1', interactionId: 'approval:1:0', choice: 'yes', message: 'echo kept にして' }),
			blankMessage: paradisIsValidAgentInboundForTest({ t: 'action/answerApproval', id: 1, requestId: 'request-1', epoch: 'epoch-1', interactionId: 'approval:1:0', choice: 'no', message: '  ' }),
			longMessage: paradisIsValidAgentInboundForTest({ t: 'action/answerApproval', id: 1, requestId: 'request-1', epoch: 'epoch-1', interactionId: 'approval:1:0', choice: 'no', message: 'x'.repeat(4_001) }),
			controlOnly: paradisIsValidAgentInboundForTest({ t: 'action/answerApproval', id: 1, requestId: 'request-1', epoch: 'epoch-1', interactionId: 'approval:1:0', choice: 'no', message: '\u0007\u001b' }),
		}, { options: true, optionsWithoutInteraction: false, optAnswer: true, badLabel: false, longLabel: false, denyMessage: true, allowMessage: false, blankMessage: false, longMessage: false, controlOnly: false });
	});

	test('forwards approval option reads and opt:<n> answers to the owning window with the label to re-check (W2-21)', async () => {
		const token = 'pane-approval-options';
		const transcriptPath = join(paradisClaudeConfigDir(), 'projects', 'para-code-tests', 'approval-options.jsonl');
		const sent: Record<string, unknown>[] = [];
		const actions: Record<string, unknown>[] = [];
		const chat = new ParadisMobileAgentChat(
			(_mobileId, payload) => sent.push(JSON.parse(new TextDecoder().decode(payload))),
			(_mobileId, _windowId, _windowSession, _generation, payload) => actions.push(JSON.parse(new TextDecoder().decode(payload))),
			() => { }, new NullLogService(),
		);
		const access = chat as unknown as {
			tailers: Map<string, { readonly epoch: string; currentInteraction(): { readonly kind: string; readonly id: string; readonly suggestions?: readonly string[]; readonly request?: unknown; readonly suggestionScope?: string } | null }>;
		};
		const inbound = (message: Record<string, unknown>) => chat.handleInbound('mobile-1', new TextEncoder().encode(JSON.stringify(message)));
		try {
			chat.setEagerTailing(true);
			assert.strictEqual(chat.syncPanes(1, 'window-session', 1, 1, [{ terminalId: 1, token }]), true);
			fireParadisAgentHookEvent({ token, event: 'UserPromptSubmit', sessionId: 'session-approval-options', transcriptPath, cwd: '/workspace', at: Date.now() });
			await waitFor(() => access.tailers.has(token), 'the pane session was not established');
			inbound({ t: 'attach', id: 1, token });
			await waitFor(() => sent.some(message => message.t === 'snapshot'), 'the attach did not answer with a snapshot');
			fireParadisAgentHookEvent({
				token, event: 'PermissionRequest', sessionId: 'session-approval-options', transcriptPath, cwd: '/workspace', at: Date.now(),
				toolName: 'Bash', toolInput: { command: 'npm test' },
				payload: { permission_suggestions: [{ type: 'addRules', rules: [{ toolName: 'Bash', ruleContent: 'npm test:*' }], behavior: 'allow', destination: 'localSettings' }] },
			});
			await waitFor(() => access.tailers.get(token)?.currentInteraction()?.kind === 'approval', 'the approval was not injected');
			const tailer = access.tailers.get(token)!;
			const interaction = tailer.currentInteraction()!;
			const base = { id: 1, token, epoch: tailer.epoch, interactionId: interaction.id };
			sent.length = 0;

			inbound({ t: 'approval-options', ...base, requestId: 'options-1' });
			inbound({ t: 'approval-options', ...base, interactionId: 'approval:other', requestId: 'options-2' });
			inbound({ t: 'action/answerApproval', ...base, requestId: 'answer-1', choice: 'opt:2' });
			inbound({ t: 'action/answerApproval', ...base, requestId: 'answer-2', choice: 'opt:2', optionLabel: 'Yes, and don\'t ask again for npm test commands', promptHash: 'dddddddddddddddddddddddddddddddddddddddd' });
			// 指示を添えた拒否は mod が待っていなければ断る（指示を落として Esc を送らない）
			inbound({ t: 'action/answerApproval', ...base, requestId: 'answer-3', choice: 'no', message: '代わりに npm run lint にして' });
			// 断りの返事は所有ウィンドウの確認を待ってから送られる
			await waitFor(() => sent.length >= 3, 'the rejections were not delivered');

			assert.deepStrictEqual({
				suggestions: interaction.suggestions,
				request: interaction.request,
				suggestionScope: interaction.suggestionScope,
				actions: actions.map(action => ({ t: action.t, requestId: action.requestId, agent: action.agent, parts: action.parts, expectOption: action.expectOption, expectPromptHash: action.expectPromptHash })),
				sent: sent.map(message => ({ t: message.t, requestId: message.requestId, code: message.code, error: message.error })),
			}, {
				suggestions: ['Bash(npm test:*)'],
				request: { tool: 'Bash', kind: 'bash', command: 'npm test' },
				suggestionScope: 'settings',
				actions: [
					{ t: 'action/approvalOptions', requestId: 'options-1', agent: 'claude', parts: undefined, expectOption: undefined, expectPromptHash: undefined },
					{ t: 'action/interaction', requestId: 'answer-2', agent: 'claude', parts: ['2'], expectOption: { n: 2, label: 'Yes, and don\'t ask again for npm test commands' }, expectPromptHash: 'dddddddddddddddddddddddddddddddddddddddd' },
				],
				sent: [
					{ t: 'approval-options', requestId: 'options-2', code: undefined, error: 'stale-interaction' },
					{ t: 'action-result', requestId: 'answer-1', code: 'invalid-answer', error: undefined },
					{ t: 'action-result', requestId: 'answer-3', code: 'stale-interaction', error: undefined },
				],
			});
		} finally {
			chat.dispose();
		}
	});

	test('hands a queued send to the window once and answers its re-send as already accepted (W2-29 M4)', async () => {
		const token = 'pane-send-dedupe';
		const transcriptPath = join(paradisClaudeConfigDir(), 'projects', 'para-code-tests', 'send-dedupe.jsonl');
		const sent: Record<string, unknown>[] = [];
		const actions: Record<string, unknown>[] = [];
		const chat = new ParadisMobileAgentChat(
			(_mobileId, payload) => sent.push(JSON.parse(new TextDecoder().decode(payload))),
			(_mobileId, _windowId, _windowSession, _generation, payload) => actions.push(JSON.parse(new TextDecoder().decode(payload))),
			() => { }, new NullLogService(),
		);
		const access = chat as unknown as { tailers: Map<string, { readonly epoch: string }> };
		const inbound = (message: Record<string, unknown>) => chat.handleInbound('mobile-1', new TextEncoder().encode(JSON.stringify(message)));
		try {
			chat.setEagerTailing(true);
			assert.strictEqual(chat.syncPanes(1, 'window-session', 1, 1, [{ terminalId: 1, token }]), true);
			fireParadisAgentHookEvent({ token, event: 'UserPromptSubmit', sessionId: 'session-send-dedupe', transcriptPath, cwd: '/workspace', at: Date.now() });
			await waitFor(() => access.tailers.has(token), 'the pane session was not established');
			inbound({ t: 'attach', id: 1, token });
			await waitFor(() => sent.some(message => message.t === 'snapshot'), 'the attach did not answer with a snapshot');
			const epoch = access.tailers.get(token)!.epoch;
			sent.length = 0;
			inbound({ t: 'action/sendMessage', id: 1, token, epoch, requestId: 'send-1', text: '続きをお願い', sendId: 'send-abc' });
			assert.strictEqual(chat.claimSendMessageAction('mobile-1', 'send-1', token, epoch, 1, 'window-session'), 'claimed');
			inbound({ t: 'action/sendMessage', id: 1, token, epoch, requestId: 'send-2', text: '続きをお願い', sendId: 'send-abc' });
			await waitFor(() => sent.length >= 1, 'the re-send was not answered');
			assert.deepStrictEqual({
				dispatched: actions.filter(action => action.t === 'action/sendMessage').map(action => action.requestId),
				reply: sent.map(message => ({ requestId: message.requestId, status: message.status, code: message.code })),
			}, {
				dispatched: ['send-1'],
				reply: [{ requestId: 'send-2', status: 'accepted', code: 'duplicate' }],
			});
		} finally {
			chat.dispose();
		}
	});

	test('uses the production five-minute directory walk budget', () => {
		const clock = sinon.useFakeTimers({ now: 1_000 });
		const chat = new ParadisMobileAgentChat(() => { }, () => { }, () => { }, new NullLogService());
		const budget = (chat as unknown as { codexDirectoryWalkLedger: IDirectoryWalkBudget }).codexDirectoryWalkLedger;
		try {
			budget.mark('workspace');
			clock.tick(5 * 60_000 - 1);
			assert.strictEqual(budget.mayRun('workspace'), false);
			clock.tick(1);
			assert.strictEqual(budget.mayRun('workspace'), true);
		} finally {
			chat.dispose();
			clock.restore();
		}
	});

	test('uses the production 128-entry directory walk limit', () => {
		const chat = new ParadisMobileAgentChat(() => { }, () => { }, () => { }, new NullLogService());
		const budget = (chat as unknown as { codexDirectoryWalkLedger: IDirectoryWalkBudget }).codexDirectoryWalkLedger;
		try {
			for (let index = 0; index < 129; index++) {
				budget.mark(`cwd-${index}`);
			}
			assert.deepStrictEqual({
				oldest: budget.mayRun('cwd-0'),
				secondOldest: budget.mayRun('cwd-1'),
				newest: budget.mayRun('cwd-128'),
			}, {
				oldest: true,
				secondOldest: false,
				newest: false,
			});
		} finally {
			chat.dispose();
		}
	});

	test('does not touch the Codex directory budget when Claude claims the pane', async () => {
		await withDirectoryWalkFixture(async ({ workspace, claudeHome }) => {
			const project = join(claudeHome, 'projects', workspace.replace(/[^a-zA-Z0-9]/g, '-'));
			await mkdir(project, { recursive: true });
			await writeFile(join(project, 'session.jsonl'), '');
			const probe = createDirectoryWalkBudget(true);
			const chat = createChatWithDirectoryWalkBudget(probe.budget);
			try {
				assert.deepStrictEqual({ session: await scanOnePane(chat, `${workspace}/`), events: probe.events }, {
					session: 'claude',
					events: [],
				});
			} finally {
				chat.dispose();
			}
		});
	});

	test('does not mark or enter the fallback when the Codex directory budget denies admission', async () => {
		await withDirectoryWalkFixture(async ({ workspace }) => {
			const probe = createDirectoryWalkBudget(false);
			const chat = createChatWithDirectoryWalkBudget(probe.budget);
			try {
				assert.deepStrictEqual({ session: await scanOnePane(chat, `${workspace}/`), events: probe.events }, {
					session: undefined,
					events: [{ method: 'mayRun', key: workspace }],
				});
			} finally {
				chat.dispose();
			}
		});
	});

	test('does not mark when the Codex state database answers without a directory fallback', async () => {
		await withDirectoryWalkFixture(async ({ workspace, codexHome }) => {
			createEmptyCodexStateDatabase(codexHome);
			const probe = createDirectoryWalkBudget(true);
			const chat = createChatWithDirectoryWalkBudget(probe.budget);
			try {
				assert.deepStrictEqual({ session: await scanOnePane(chat, `${workspace}/`), events: probe.events }, {
					session: undefined,
					events: [{ method: 'mayRun', key: workspace }],
				});
			} finally {
				chat.dispose();
			}
		});
	});

	test('marks exactly once when Codex attempts the directory fallback and its read fails', async () => {
		await withDirectoryWalkFixture(async ({ workspace }) => {
			const probe = createDirectoryWalkBudget(true);
			const chat = createChatWithDirectoryWalkBudget(probe.budget);
			try {
				assert.deepStrictEqual({ session: await scanOnePane(chat, `${workspace}/`), events: probe.events }, {
					session: undefined,
					events: [
						{ method: 'mayRun', key: workspace },
						{ method: 'mark', key: workspace },
					],
				});
			} finally {
				chat.dispose();
			}
		});
	});

	test('requests an owning renderer cwd sync and delivers a reconnect error without a subscriber', async () => {
		const sent: unknown[] = [];
		const syncRequests: unknown[] = [];
		const clock = sinon.useFakeTimers();
		const chat = new ParadisMobileAgentChat(
			(_mobileId, payload) => sent.push(JSON.parse(new TextDecoder().decode(payload))),
			() => { },
			() => { },
			new NullLogService(),
			async () => true,
			owner => syncRequests.push(owner),
		);
		try {
			assert.strictEqual(chat.syncPanes(1, 'window-session', 3, 1, [{ terminalId: 7, token: 'pane-7' }]), true);
			chat.handleInbound('mobile-1', new TextEncoder().encode(JSON.stringify({
				t: 'command-catalog', id: 7, token: 'pane-7', requestId: 'request-1'
			})));
			await clock.tickAsync(25);
			chat.removePanes(1, 'window-session', 3);
			await clock.tickAsync(1175);

			assert.deepStrictEqual(syncRequests, [{
				windowId: 1,
				windowSession: 'window-session',
				rendererGeneration: 3,
				terminalId: 7,
				token: 'pane-7',
			}]);
			assert.deepStrictEqual(sent, [{
				t: 'command-catalog-error',
				id: 7,
				token: 'pane-7',
				requestId: 'request-1',
				message: 'PC側のエージェント接続を同期中です。詳細画面を再接続してからお試しください'
			}]);
		} finally {
			chat.dispose();
			clock.restore();
		}
	});

	test('preserves AskUserQuestion when a later hook arrives during path validation', async () => {
		const token = 'pane-question-order';
		const transcriptPath = join(paradisClaudeConfigDir(), 'projects', 'para-code-tests', 'question-order.jsonl');
		const chat = new ParadisMobileAgentChat(() => { }, () => { }, () => { }, new NullLogService());
		const access = chat as unknown as {
			tailers: Map<string, { currentInteraction(): { readonly kind: string } | null }>;
		};
		try {
			chat.setEagerTailing(true);
			assert.strictEqual(chat.syncPanes(1, 'window-session', 1, 1, [{ terminalId: 1, token }]), true);

			fireParadisAgentHookEvent({
				token, event: 'PreToolUse', sessionId: 'session-question-order', transcriptPath, cwd: '/workspace',
				toolName: 'AskUserQuestion', toolUseId: 'question-1', at: Date.now(),
				toolInput: { questions: [{ question: '進めますか？', header: '確認', options: [{ label: 'はい' }, { label: 'いいえ' }] }] },
			});
			fireParadisAgentHookEvent({
				token, event: 'PermissionRequest', sessionId: 'session-question-order', transcriptPath, cwd: '/workspace',
				toolName: 'AskUserQuestion', toolUseId: 'question-1', at: Date.now(),
			});

			await waitFor(() => access.tailers.get(token)?.currentInteraction()?.kind === 'question', 'AskUserQuestion was discarded');
			assert.strictEqual(access.tailers.get(token)?.currentInteraction()?.kind, 'question');
		} finally {
			chat.dispose();
		}
	});

	test('preserves AskUserQuestion hooks that arrive before the pane sync', async () => {
		const token = 'pane-pending-question-order';
		const transcriptPath = join(paradisClaudeConfigDir(), 'projects', 'para-code-tests', 'pending-question-order.jsonl');
		const chat = new ParadisMobileAgentChat(() => { }, () => { }, () => { }, new NullLogService());
		const access = chat as unknown as {
			hookProcessing: Map<string, Promise<void>>;
			tailers: Map<string, { currentInteraction(): { readonly kind: string } | null }>;
		};
		try {
			chat.setEagerTailing(true);
			fireParadisAgentHookEvent({
				token, event: 'PreToolUse', sessionId: 'session-pending-question-order', transcriptPath, cwd: '/workspace',
				toolName: 'AskUserQuestion', toolUseId: 'question-1', at: Date.now(),
				toolInput: { questions: [{ question: '同期後も表示しますか？', header: '確認', options: [{ label: 'はい' }] }] },
			});
			fireParadisAgentHookEvent({
				token, event: 'PermissionRequest', sessionId: 'session-pending-question-order', transcriptPath, cwd: '/workspace',
				toolName: 'AskUserQuestion', toolUseId: 'question-1', at: Date.now(),
			});
			await waitFor(() => !access.hookProcessing.has(token), 'pending hooks did not finish validation');

			assert.strictEqual(chat.syncPanes(1, 'window-session', 1, 1, [{ terminalId: 1, token }]), true);
			await waitFor(() => access.tailers.get(token)?.currentInteraction()?.kind === 'question', 'pending AskUserQuestion was discarded');
			assert.strictEqual(access.tailers.get(token)?.currentInteraction()?.kind, 'question');
		} finally {
			chat.dispose();
		}
	});

	test('leaves a host pane out of the local session search, even at the same absolute path', async () => {
		// 手元と接続先でユーザー名もリポジトリの場所も同じ構成（同名ユーザーの Linux 同士など）だと、
		// 接続先ペインの作業フォルダが手元にもそのまま存在する。ここを探しに行かせると、手元の
		// 別のセッションを接続先ペインの会話として結び付けてしまう
		const home = await realpath(await mkdtemp(join(tmpdir(), 'paradis-agent-home-')));
		const workspace = await realpath(await mkdtemp(join(tmpdir(), 'paradis-agent-cwd-')));
		const previousHome = process.env['CLAUDE_CONFIG_DIR'];
		process.env['CLAUDE_CONFIG_DIR'] = home;
		const projectDir = join(home, 'projects', workspace.replace(/[^a-zA-Z0-9]/g, '-'));
		await mkdir(projectDir, { recursive: true });
		const localTranscript = join(projectDir, 'local-session.jsonl');
		await writeFile(localTranscript, '');

		const chat = new ParadisMobileAgentChat(() => { }, () => { }, () => { }, new NullLogService());
		const access = chat as unknown as {
			paneSessions: Map<string, { readonly transcriptPath: string }>;
			tokenToRemoteHost: Map<string, { readonly host: string }>;
			cliDiscoveryGenerations: Map<string, number>;
			agentHomesForToken(token: string): unknown;
			discoverAndNotify(token: string, agent: 'claude' | 'codex', mode: 'resume', cwd: string, minMtime: undefined, generation: number): Promise<void>;
		};
		try {
			assert.strictEqual(chat.syncPanes(1, 'window-session', 1, 1, [
				{ terminalId: 1, token: 'pane-local', cwd: workspace },
				{ terminalId: 2, token: 'pane-host', cwd: workspace },
			]), true);
			// 接続先の印が付いた hook が1本届いた時点で、このペインは接続先のものだと分かる
			// （transcript が無いイベントでも印だけは覚える）
			fireParadisAgentHookEvent({
				token: 'pane-host', event: 'SessionStart', sessionId: 'host-session',
				transcriptPath: undefined, cwd: undefined, remoteHostId: 'ssh-remote-server', at: Date.now(),
			});

			// 世代の登録は常駐スキャンやコマンド検知が探索前に必ず行う（未登録のままだと
			// 世代ガードで即 return されるので、ここでも同じ前提を作ってから呼ぶ）
			for (const token of ['pane-local', 'pane-host']) {
				access.cliDiscoveryGenerations.set(token, 0);
				await access.discoverAndNotify(token, 'claude', 'resume', workspace, undefined, 0);
			}

			assert.deepStrictEqual({
				// 手元のペインはこれまでどおり見つかる（探索そのものは効いている）
				local: access.paneSessions.get('pane-local')?.transcriptPath,
				host: access.paneSessions.get('pane-host')?.transcriptPath,
				// エージェントのホームも手元のものを当てない（Codex の SubAgent 復元の入口）
				localHomes: access.agentHomesForToken('pane-local') !== undefined,
				hostHomes: access.agentHomesForToken('pane-host'),
			}, {
				local: localTranscript,
				host: undefined,
				localHomes: true,
				hostHomes: undefined,
			});

			// ウィンドウのリロードで token が一瞬 live でなくなっても印は残す（ここで落とすと、
			// 復活した接続先ペインが次の hook まで手元のものとして扱われる）
			assert.strictEqual(chat.syncPanes(1, 'window-session', 1, 2, [{ terminalId: 1, token: 'pane-local', cwd: workspace }]), true);
			assert.strictEqual(access.tokenToRemoteHost.get('pane-host')?.host, 'ssh-remote-server');
		} finally {
			chat.dispose();
			if (previousHome === undefined) {
				delete process.env['CLAUDE_CONFIG_DIR'];
			} else {
				process.env['CLAUDE_CONFIG_DIR'] = previousHome;
			}
			await rm(home, { recursive: true, force: true });
			await rm(workspace, { recursive: true, force: true });
		}
	});

	test('does not put this machine\'s effort setting on a host session', async () => {
		// Claude の transcript は effort を記録しないので、手元では settings.json で補う。接続先の
		// セッションにこれを当てると、向こうで /effort を打っていないのに **PC本体の設定値** が
		// 「現在の effort」として出てしまう
		const home = await realpath(await mkdtemp(join(tmpdir(), 'paradis-agent-effort-home-')));
		const userData = await realpath(await mkdtemp(join(tmpdir(), 'paradis-agent-effort-data-')));
		const previousHome = process.env['CLAUDE_CONFIG_DIR'];
		process.env['CLAUDE_CONFIG_DIR'] = home;
		await mkdir(join(home, 'projects', 'para-code-tests'), { recursive: true });
		await writeFile(join(home, 'settings.json'), JSON.stringify({ effortLevel: 'high' }));
		const localTranscript = join(home, 'projects', 'para-code-tests', 'effort-local.jsonl');
		await writeFile(localTranscript, '');

		const mirror = new ParadisRemoteTranscriptMirrorStore(userData, new NullLogService());
		const chat = new ParadisMobileAgentChat(
			() => { }, () => { }, () => { }, new NullLogService(),
			async () => true, () => { }, undefined, mirror,
		);
		const access = chat as unknown as { tailers: Map<string, { readonly effort: string | undefined }> };
		try {
			chat.setEagerTailing(true);
			assert.strictEqual(chat.syncPanes(1, 'window-session', 1, 1, [
				{ terminalId: 1, token: 'pane-local' },
				{ terminalId: 2, token: 'pane-host' },
			]), true);

			fireParadisAgentHookEvent({
				token: 'pane-local', event: 'SessionStart', sessionId: 'local-session',
				transcriptPath: localTranscript, cwd: '/workspace', at: Date.now(),
			});
			fireParadisAgentHookEvent({
				token: 'pane-host', event: 'SessionStart', sessionId: 'host-session',
				transcriptPath: '/home/alice/.claude/projects/-srv-app/effort-host.jsonl',
				cwd: '/srv/app', remoteHostId: 'ssh-remote-server', at: Date.now(),
			});

			// 手元のぶんが読み終わるのを待つ。ここが「settings.json を読む時間はあった」の目印になり、
			// 接続先のぶんが未設定のままであることを意味のある形で確かめられる
			await waitFor(() => access.tailers.get('pane-local')?.effort === 'high', 'the local session never picked up the default effort');
			assert.deepStrictEqual([
				access.tailers.get('pane-local')?.effort,
				access.tailers.get('pane-host')?.effort,
			], ['high', undefined]);
		} finally {
			chat.dispose();
			mirror.dispose();
			if (previousHome === undefined) {
				delete process.env['CLAUDE_CONFIG_DIR'];
			} else {
				process.env['CLAUDE_CONFIG_DIR'] = previousHome;
			}
			await rm(home, { recursive: true, force: true });
			await rm(userData, { recursive: true, force: true });
		}
	});

	test('tracks Claude Code Monitors per epoch and stops them as an estimate when the session ends', async () => {
		// tailer が transcript の Monitor の起動・出力を一覧に持ち、truncate（epoch の切り替え）で空にし、
		// SessionEnd で動いているものを「停止（推定）」にする（TUI から止めた・プロセスが終わったときは印が残らないため）
		const home = await realpath(await mkdtemp(join(tmpdir(), 'paradis-agent-monitor-home-')));
		const previousHome = process.env['CLAUDE_CONFIG_DIR'];
		process.env['CLAUDE_CONFIG_DIR'] = home;
		await mkdir(join(home, 'projects', 'para-code-tests'), { recursive: true });
		const transcript = join(home, 'projects', 'para-code-tests', 'monitor.jsonl');
		const at = (offsetMs: number) => new Date(Date.now() - 60_000 + offsetMs).toISOString();
		const lines = [
			JSON.stringify({ type: 'assistant', timestamp: at(0), message: { role: 'assistant', content: [{ type: 'tool_use', id: 'toolu_m1', name: 'Monitor', input: { command: 'tail -f /tmp/build.log', description: 'ビルドの見張り', persistent: true } }] } }),
			JSON.stringify({ type: 'user', timestamp: at(1_000), toolUseResult: { taskId: 'bmonitor1', timeoutMs: 0, persistent: true }, message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_m1', content: 'Monitor started (task bmonitor1, persistent — runs until TaskStop or session end).' }] } }),
		];
		await writeFile(transcript, lines.join('\n') + '\n');
		const chat = new ParadisMobileAgentChat(() => { }, () => { }, () => { }, new NullLogService());
		const access = chat as unknown as { tailers: Map<string, { readonly epoch: string; monitors(): readonly { readonly id: string; readonly status: string; readonly estimated?: true; readonly output: readonly { readonly text: string }[] }[] }> };
		const monitorsOf = () => access.tailers.get('pane-monitor')?.monitors().map(monitor => `${monitor.id}:${monitor.status}${monitor.estimated ? '?' : ''}:${monitor.output.map(line => line.text).join('|')}`);
		try {
			chat.setEagerTailing(true);
			assert.strictEqual(chat.syncPanes(1, 'window-session', 1, 1, [{ terminalId: 1, token: 'pane-monitor' }]), true);
			fireParadisAgentHookEvent({ token: 'pane-monitor', event: 'SessionStart', sessionId: 'monitor-session', transcriptPath: transcript, cwd: '/workspace', at: Date.now() });
			await waitFor(() => monitorsOf()?.length === 1, 'the Monitor start was not tracked');
			const started = monitorsOf();
			await writeFile(transcript, [...lines, JSON.stringify({ type: 'user', timestamp: at(2_000), message: { role: 'user', content: '<task-notification>\n<task-id>bmonitor1</task-id>\n<summary>Monitor event: "ビルドの見張り"</summary>\n<event>Compiling</event>\n</task-notification>' } })].join('\n') + '\n');
			await waitFor(() => monitorsOf()?.[0]?.endsWith('Compiling') === true, 'the Monitor event was not tracked');
			const withOutput = monitorsOf();
			fireParadisAgentHookEvent({ token: 'pane-monitor', event: 'SessionEnd', sessionId: 'monitor-session', transcriptPath: transcript, cwd: '/workspace', at: Date.now() });
			await waitFor(() => monitorsOf()?.[0]?.startsWith('bmonitor1:stopped?') === true, 'SessionEnd did not stop the Monitor');
			const ended = monitorsOf();
			// 送る一覧は、ペインが止まっている間は送るたびに「停止（推定）」へ直す（tailer を作り直して running に戻っても同じ）
			const sent = chat.monitorsForTest('pane-monitor');
			const sentShape = sent?.monitors?.map(monitor => `${monitor.status}:${monitor.estimated === true}`).concat(typeof sent.monitorsAt === 'number' ? ['monitorsAt'] : []);
			// 置き換え（サイズ減少）で epoch が替わったら、新しい内容に Monitor が無い限り空にする
			const epoch = access.tailers.get('pane-monitor')?.epoch;
			await writeFile(transcript, JSON.stringify({ type: 'user', timestamp: at(3_000), message: { role: 'user', content: '次の会話' } }) + '\n');
			await waitFor(() => access.tailers.get('pane-monitor')?.epoch !== epoch, 'the epoch did not change');
			assert.deepStrictEqual({ started, withOutput, ended, sentShape, reset: monitorsOf() }, {
				started: ['bmonitor1:running:'],
				withOutput: ['bmonitor1:running:Compiling'],
				ended: ['bmonitor1:stopped?:Compiling'],
				sentShape: ['stopped:true', 'monitorsAt'],
				reset: [],
			});
		} finally {
			chat.dispose();
			if (previousHome === undefined) {
				delete process.env['CLAUDE_CONFIG_DIR'];
			} else {
				process.env['CLAUDE_CONFIG_DIR'] = previousHome;
			}
			await rm(home, { recursive: true, force: true });
		}
	});

	test('tracks background shells next to Monitors, closes one stopped in the TUI from the queue-operation line, and sends them with their access', async () => {
		const home = await realpath(await mkdtemp(join(tmpdir(), 'paradis-agent-shell-home-')));
		const previousHome = process.env['CLAUDE_CONFIG_DIR'];
		process.env['CLAUDE_CONFIG_DIR'] = home;
		await mkdir(join(home, 'projects', 'para-code-tests'), { recursive: true });
		const transcript = join(home, 'projects', 'para-code-tests', 'shell.jsonl');
		const at = (offsetMs: number) => new Date(Date.now() - 60_000 + offsetMs).toISOString();
		const lines = [
			JSON.stringify({ type: 'assistant', timestamp: at(0), message: { role: 'assistant', content: [{ type: 'tool_use', id: 'toolu_s1', name: 'Bash', input: { command: 'sleep 600', description: '待つ', run_in_background: true } }] } }),
			JSON.stringify({ type: 'user', timestamp: at(500), toolUseResult: { backgroundTaskId: 'bshell1' }, message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_s1', content: 'Command running in background with ID: bshell1. Output is being written to: /private/tmp/claude-501/-workspace/shell-session/tasks/bshell1.output' }] } }),
		];
		await writeFile(transcript, lines.join('\n') + '\n');
		const chat = new ParadisMobileAgentChat(() => { }, () => { }, () => { }, new NullLogService());
		const access = chat as unknown as { tailers: Map<string, { shells(): readonly { readonly id: string; readonly status: string; readonly stoppedBy?: string }[] }> };
		const shellsOf = () => access.tailers.get('pane-shell')?.shells().map(shell => `${shell.id}:${shell.status}:${shell.stoppedBy ?? ''}`);
		try {
			chat.setEagerTailing(true);
			assert.strictEqual(chat.syncPanes(1, 'window-session', 1, 1, [{ terminalId: 1, token: 'pane-shell' }]), true);
			fireParadisAgentHookEvent({ token: 'pane-shell', event: 'SessionStart', sessionId: 'shell-session', transcriptPath: transcript, cwd: '/workspace', at: Date.now() });
			await waitFor(() => shellsOf()?.length === 1, 'the background shell was not tracked');
			const started = shellsOf();
			const sentRunning = chat.monitorsForTest('pane-shell');
			await writeFile(transcript, [...lines, JSON.stringify({ type: 'queue-operation', operation: 'enqueue', timestamp: at(2_000), sessionId: 'shell-session', content: '<task-notification>\n<task-id>bshell1</task-id>\n<tool-use-id>toolu_s1</tool-use-id>\n<status>killed</status>\n<summary>Task "sleep 600" was stopped by the user</summary>\n</task-notification>' })].join('\n') + '\n');
			await waitFor(() => shellsOf()?.[0]?.startsWith('bshell1:stopped') === true, 'the TUI stop was not tracked');
			assert.deepStrictEqual({ started, ended: shellsOf(), sent: { count: sentRunning?.shells?.length, at: typeof sentRunning?.shellsAt, access: sentRunning?.shellsAccess } }, {
				started: ['bshell1:running:'],
				ended: ['bshell1:stopped:user'],
				// mod が来ていない手元のペイン: 出力は読めるが、止められない
				sent: { count: 1, at: 'number', access: process.platform === 'win32' ? { output: false, stop: false, where: 'windows' } : { output: true, stop: false } },
			});
		} finally {
			chat.dispose();
			if (previousHome === undefined) {
				delete process.env['CLAUDE_CONFIG_DIR'];
			} else {
				process.env['CLAUDE_CONFIG_DIR'] = previousHome;
			}
			await rm(home, { recursive: true, force: true });
		}
	});

	test('applies complete turn cleanup when Stop is overtaken during path validation', async () => {
		const token = 'pane-stop-order';
		const transcriptPath = join(paradisClaudeConfigDir(), 'projects', 'para-code-tests', 'stop-order.jsonl');
		const chat = new ParadisMobileAgentChat(() => { }, () => { }, () => { }, new NullLogService());
		const access = chat as unknown as {
			activeTurnTokens: Set<string>;
			lastTurnEndedAt: Map<string, number>;
			tailers: Map<string, { currentInteraction(): { readonly kind: string } | null }>;
		};
		try {
			chat.setEagerTailing(true);
			assert.strictEqual(chat.syncPanes(1, 'window-session', 1, 1, [{ terminalId: 1, token }]), true);
			fireParadisAgentHookEvent({
				token, event: 'UserPromptSubmit', sessionId: 'session-stop-order', transcriptPath, cwd: '/workspace',
				payload: { prompt: '作業を開始して' }, at: Date.now(),
			});
			await waitFor(() => access.activeTurnTokens.has(token), 'turn did not start');
			fireParadisAgentHookEvent({
				token, event: 'PreToolUse', sessionId: 'session-stop-order', transcriptPath, cwd: '/workspace',
				toolName: 'AskUserQuestion', toolUseId: 'question-1', at: Date.now(),
				toolInput: { questions: [{ question: '続けますか？', header: '確認', options: [{ label: '続ける' }] }] },
			});
			await waitFor(() => access.tailers.get(token)?.currentInteraction()?.kind === 'question', 'question was not injected');

			fireParadisAgentHookEvent({
				token, event: 'Stop', sessionId: 'session-stop-order', transcriptPath, cwd: '/workspace', at: Date.now(),
			});
			fireParadisAgentHookEvent({
				token, event: 'MessageDisplay', sessionId: 'session-stop-order', transcriptPath, cwd: '/workspace',
				messageId: 'late-message', messageIndex: 0, messageDelta: '完了', messageFinal: true, at: Date.now(),
			});

			await waitFor(() => access.lastTurnEndedAt.has(token), 'turn end was not applied');
			await waitFor(() => access.tailers.get(token)?.currentInteraction() === null, 'turn end did not clear the pending interaction');
			assert.deepStrictEqual({
				active: access.activeTurnTokens.has(token),
				interaction: access.tailers.get(token)?.currentInteraction(),
			}, {
				active: false,
				interaction: null,
			});
		} finally {
			chat.dispose();
		}
	});

	test('keeps the Codex thread ID discovered from rollout session metadata', () => {
		assert.deepStrictEqual(paradisParseCodexSessionMeta(JSON.stringify({
			type: 'session_meta',
			payload: { cwd: '/workspace', id: 'thread-1' },
		})), { cwd: '/workspace', sessionId: 'thread-1' });
	});

	test('never falls a resolved Codex daemon approval back to PTY key injection', () => {
		assert.strictEqual(paradisIsCodexDaemonApprovalInteraction('codex:s:approval-1'), true);
		assert.strictEqual(paradisIsCodexDaemonApprovalInteraction('codex-status:thread-1'), true);
		assert.strictEqual(paradisIsCodexDaemonApprovalInteraction('approval:epoch:1'), false);
	});

	test('keeps current Codex nested thread metadata', () => {
		assert.deepStrictEqual(paradisParseCodexSessionMeta(JSON.stringify({
			type: 'session_meta', payload: {
				cwd: '/workspace', id: 'child', parent_thread_id: 'parent', depth: 2,
				agent_path: '/root/planner/researcher', agent_nickname: 'researcher',
			},
		})), {
			cwd: '/workspace', sessionId: 'child', subagent: true, parentThreadId: 'parent', depth: 2,
			agentPath: '/root/planner/researcher', agentNickname: 'researcher',
		});
	});

	test('distinguishes Codex root threads from nested subagent sources', () => {
		assert.strictEqual(paradisIsCodexRootThreadSource('cli'), true);
		assert.strictEqual(paradisIsCodexRootThreadSource(JSON.stringify({ subagent: { thread_spawn: { parent_thread_id: 'parent', depth: 1 } } })), false);
	});

	test('parses current Codex nested thread source', () => {
		assert.deepStrictEqual(paradisParseCodexThreadSource(JSON.stringify({
			subagent: { thread_spawn: { parent_thread_id: 'parent', depth: 3, agent_nickname: 'verifier', agent_role: 'reviewer' } },
		})), { parentThreadId: 'parent', depth: 3, agentNickname: 'verifier', agentRole: 'reviewer' });
	});

	test('uses creation time for new sessions and update time for resumed sessions', () => {
		const oldButUpdated = { mtime: 200, createdAt: 50 };
		assert.strictEqual(paradisCliDiscoveryCandidateIsFresh(oldButUpdated, 100, 'new'), false);
		assert.strictEqual(paradisCliDiscoveryCandidateIsFresh(oldButUpdated, 100, 'fork'), false);
		assert.strictEqual(paradisCliDiscoveryCandidateIsFresh(oldButUpdated, 100, 'resume'), true);
	});

	test('rejects non-session metadata', () => {
		assert.strictEqual(paradisParseCodexSessionMeta('{"type":"event_msg","payload":{}}'), undefined);
	});

	test('keeps a completed Codex web search paired when the current rollout omits an id', () => {
		const parsed = paradisParseCodexTranscriptLineForTest(JSON.stringify({
			timestamp: '2026-07-13T00:00:00.000Z', type: 'response_item',
			payload: { type: 'web_search_call', status: 'completed', action: { type: 'search', query: 'Codex app-server' } },
		}));
		assert.deepStrictEqual(parsed.messages, [
			{ role: 'assistant', kind: 'tool_use', tool: 'web_search', text: 'Codex app-server', ts: 1783900800000, toolUseId: 'web:2026-07-13T00:00:00.000Z:19gx9vl' },
			{ role: 'tool', kind: 'tool_result', text: 'Codex app-server', ts: 1783900800000, toolUseId: 'web:2026-07-13T00:00:00.000Z:19gx9vl' },
		]);
	});

	// history_mode が legacy の rollout だけが書く形。今の（paginated の）形は paradisAgentTranscriptParser.test.ts で見る
	test('extracts legacy Codex rollout sub_agent_activity for the activity tracker', () => {
		const parsed = paradisParseCodexTranscriptLineForTest(JSON.stringify({
			timestamp: '2026-07-13T00:00:00.000Z', type: 'event_msg',
			payload: { type: 'sub_agent_activity', event_id: 'event-1', occurred_at_ms: 1783900800123, agent_thread_id: 'thread-2', agent_path: '/root/reviewer', kind: 'started' },
		}));
		assert.deepStrictEqual(parsed.activity, {
			id: 'thread-2', agentPath: '/root/reviewer', kind: 'started', at: 1783900800123,
		});
	});

	test('extracts Codex task_started so the PC workspace can show working state without hooks', () => {
		const parsed = paradisParseCodexTranscriptLineForTest(JSON.stringify({
			timestamp: '2026-07-13T00:00:00.000Z', type: 'event_msg', payload: { type: 'task_started' },
		}));
		assert.strictEqual(parsed.turn, 'started');
	});

	test('builds SubAgent detail from a persisted Codex child rollout', () => {
		assert.deepStrictEqual(paradisParseCodexDetailLinesForTest([
			JSON.stringify({ type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: '調査して' }] } }),
			JSON.stringify({ type: 'response_item', payload: { type: 'reasoning', summary: [{ type: 'summary_text', text: '確認中' }] } }),
			JSON.stringify({ type: 'response_item', payload: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: '完了しました' }] } }),
		]), [
			{ role: 'user', kind: 'text', text: '調査して' },
			{ role: 'assistant', kind: 'thinking', text: '確認中' },
			{ role: 'assistant', kind: 'text', text: '完了しました' },
		]);
	});

	test('prefers the current Claude SubagentStop agent_transcript_path', () => {
		assert.deepStrictEqual(paradisClaudeSubagentTranscriptCandidates(
			'/Users/test/.claude/projects/workspace/session.jsonl', 'abc-123', '/Users/test/.claude/projects/workspace/session/subagents/agent-abc-123.jsonl',
		), [
			'/Users/test/.claude/projects/workspace/session/subagents/agent-abc-123.jsonl',
			'/Users/test/.claude/projects/workspace/subagents/agent-abc-123.jsonl',
		]);
	});

	test('maps nested Claude hook transcripts back to their parent agent and root session', () => {
		const path = '/Users/test/.claude/projects/workspace/session/subagents/agent-parent-123.jsonl';
		assert.strictEqual(paradisClaudeAgentIdFromTranscriptPath(path), 'parent-123');
		assert.strictEqual(paradisClaudeRootTranscriptPath(path), '/Users/test/.claude/projects/workspace/session.jsonl');
		assert.strictEqual(paradisClaudeAgentIdFromTranscriptPath('/Users/test/.claude/projects/workspace/session.jsonl'), undefined);
	});

	test('maps a Workflow child transcript back to its agent and root session', () => {
		const path = '/Users/test/.claude/projects/workspace/session/subagents/workflows/wf_473f5bf9-bfb/agent-a0613cb1795156962.jsonl';
		assert.deepStrictEqual({
			agentId: paradisClaudeAgentIdFromTranscriptPath(path),
			root: paradisClaudeRootTranscriptPath(path),
			windows: paradisClaudeRootTranscriptPath('C:\\Users\\test\\.claude\\projects\\workspace\\session\\subagents\\workflows\\wf_1\\agent-a1.jsonl'),
		}, {
			agentId: 'a0613cb1795156962',
			root: '/Users/test/.claude/projects/workspace/session.jsonl',
			windows: 'C:/Users/test/.claude/projects/workspace/session.jsonl',
		});
	});

	test('keeps the pane session and epoch when a Codex subagent thread fires a hook', async () => {
		const token = 'pane-codex-subagent';
		const parentPath = join(paradisCodexHome(), 'sessions', 'para-code-tests', 'rollout-parent.jsonl');
		const childPath = join(paradisCodexHome(), 'sessions', 'para-code-tests', 'rollout-child.jsonl');
		const chat = new ParadisMobileAgentChat(() => { }, () => { }, () => { }, new NullLogService());
		const access = chat as unknown as {
			paneSessions: Map<string, { readonly transcriptPath: string; readonly sessionId?: string }>;
			codexRolloutOrigins: Map<string, string>;
			tailers: Map<string, { readonly epoch: string }>;
			hookProcessing: Map<string, Promise<void>>;
		};
		try {
			chat.setEagerTailing(true);
			assert.strictEqual(chat.syncPanes(1, 'window-session', 1, 1, [{ terminalId: 1, token }]), true);
			// rolloutの素性判定そのものは paradisParseCodexSessionMeta 側のテストで担保する。
			// ここは「子と分かっているhookがペインを乗っ取らないこと」だけを見る。
			access.codexRolloutOrigins.set(parentPath, 'root');
			access.codexRolloutOrigins.set(childPath, 'subagent');

			fireParadisAgentHookEvent({
				token, event: 'UserPromptSubmit', sessionId: 'thread-parent', transcriptPath: parentPath,
				cwd: '/workspace', payload: { prompt: 'テストを直して' }, at: Date.now(),
			});
			await waitFor(() => access.paneSessions.get(token)?.transcriptPath === parentPath, 'parent session was not confirmed');
			const epoch = access.tailers.get(token)?.epoch;

			// SubAgentのthreadが自分のrolloutを指すhookを撃つ（tool実行のたびに起きる）。
			fireParadisAgentHookEvent({
				token, event: 'PreToolUse', sessionId: 'thread-child', transcriptPath: childPath,
				cwd: '/workspace', toolName: 'Bash', toolUseId: 'tool-1', at: Date.now(),
			});
			await waitFor(() => !access.hookProcessing.has(token), 'child hook was not processed');

			assert.deepStrictEqual({
				transcriptPath: access.paneSessions.get(token)?.transcriptPath,
				sessionId: access.paneSessions.get(token)?.sessionId,
				epochChanged: access.tailers.get(token)?.epoch !== epoch,
			}, {
				transcriptPath: parentPath,
				sessionId: 'thread-parent',
				epochChanged: false,
			});
		} finally {
			chat.dispose();
		}
	});

	test('counts a background subagent\'s deadline from its latest hook instead of its start (15-minute repeat notifications)', async () => {
		const token = 'pane-subagent-alive-sign';
		const transcriptPath = join(paradisClaudeConfigDir(), 'projects', 'para-code-tests', 'subagent-alive-sign.jsonl');
		const chat = new ParadisMobileAgentChat(() => { }, () => { }, () => { }, new NullLogService());
		const access = chat as unknown as {
			tailers: Map<string, { readonly backgroundTasks: ReadonlyMap<string, number> }>;
			hookProcessing: Map<string, Promise<void>>;
		};
		const startedAt = Date.now() - 20 * 60_000;
		try {
			chat.setEagerTailing(true);
			assert.strictEqual(chat.syncPanes(1, 'window-session', 1, 1, [{ terminalId: 1, token }]), true);
			fireParadisAgentHookEvent({ token, event: 'UserPromptSubmit', sessionId: 'session-alive', transcriptPath, cwd: '/workspace', payload: { prompt: '調査して' }, at: startedAt });
			await waitFor(() => !access.hookProcessing.has(token), 'UserPromptSubmit was not processed');
			fireParadisAgentHookEvent({ token, event: 'SubagentStart', sessionId: 'session-alive', transcriptPath, cwd: '/workspace', payload: { agent_id: 'abc-2' }, at: startedAt });
			await waitFor(() => !access.hookProcessing.has(token), 'SubagentStart was not processed');
			const opened = access.tailers.get(token)?.backgroundTasks.get('hook:abc-2');
			// 子のツール呼び出しの hook（agent_id 付き）が動いている印になる
			const signAt = Date.now();
			fireParadisAgentHookEvent({ token, event: 'PreToolUse', sessionId: 'session-alive', transcriptPath, cwd: '/workspace', toolName: 'Bash', payload: { agent_id: 'abc-2', tool_name: 'Bash' }, at: signAt });
			await waitFor(() => !access.hookProcessing.has(token), 'PreToolUse was not processed');
			assert.deepStrictEqual({ opened, latest: access.tailers.get(token)?.backgroundTasks.get('hook:abc-2') }, { opened: startedAt, latest: signAt });
		} finally {
			chat.dispose();
		}
	});

	test('lists background shells started by a subagent or a Workflow child, from the child hook and from the child transcript', async () => {
		const token = 'pane-child-shells';
		const project = join(paradisClaudeConfigDir(), 'projects', 'para-code-tests');
		const transcriptPath = join(project, 'child-shells.jsonl');
		const run = join(project, 'child-shells', 'subagents', 'workflows', 'wf_child-1');
		await mkdir(run, { recursive: true });
		await writeFile(transcriptPath, '');
		const at = new Date().toISOString();
		await writeFile(join(run, 'agent-w1.jsonl'), [
			JSON.stringify({ type: 'assistant', isSidechain: true, timestamp: at, message: { role: 'assistant', content: [{ type: 'tool_use', id: 'toolu_file', name: 'Bash', input: { command: 'npm run watch', run_in_background: true } }] } }),
			JSON.stringify({ type: 'user', isSidechain: true, timestamp: at, toolUseResult: { stdout: '', stderr: '', interrupted: false, isImage: false, backgroundTaskId: 'bfile' }, message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_file', content: 'Command running in background with ID: bfile.' }] } }),
			'',
		].join('\n'));
		const chat = new ParadisMobileAgentChat(() => { }, () => { }, () => { }, new NullLogService());
		const access = chat as unknown as {
			tailers: Map<string, { shells(): readonly { readonly id: string; readonly status: string; readonly command?: string }[] }>;
			hookProcessing: Map<string, Promise<void>>;
			scanChildShells(): Promise<void>;
		};
		try {
			chat.setEagerTailing(true);
			assert.strictEqual(chat.syncPanes(1, 'window-session', 1, 1, [{ terminalId: 1, token }]), true);
			fireParadisAgentHookEvent({ token, event: 'UserPromptSubmit', sessionId: 'session-child-shells', transcriptPath, cwd: '/workspace', payload: { prompt: '調べて' }, at: Date.now() });
			await waitFor(() => !access.hookProcessing.has(token), 'UserPromptSubmit was not processed');
			// SSH 先でも届く子の hook（tool_response は transcript の toolUseResult と同じ形）
			fireParadisAgentHookEvent({
				token, event: 'PostToolUse', sessionId: 'session-child-shells', transcriptPath, cwd: '/workspace', toolName: 'Bash', toolUseId: 'toolu_hook', at: Date.now(),
				payload: { agent_id: 'a1', tool_name: 'Bash', tool_input: { command: 'npm run dev', run_in_background: true }, tool_response: { stdout: '', stderr: '', interrupted: false, isImage: false, backgroundTaskId: 'bhook' } },
			});
			await waitFor(() => !access.hookProcessing.has(token), 'PostToolUse was not processed');
			await access.scanChildShells();
			const shells = access.tailers.get(token)?.shells().map(shell => `${shell.id}:${shell.status}:${shell.command}`).sort();
			assert.deepStrictEqual(shells, ['bfile:running:npm run watch', 'bhook:running:npm run dev']);
		} finally {
			chat.dispose();
		}
	});

	test('keeps the negotiated live and response encodings when the PC re-sends a snapshot to its subscribers', async () => {
		const token = 'pane-keep-encodings';
		const transcriptPath = join(paradisClaudeConfigDir(), 'projects', 'para-code-tests', 'keep-encodings.jsonl');
		const sent: Record<string, unknown>[] = [];
		const chat = new ParadisMobileAgentChat(
			(_mobileId, payload) => sent.push(JSON.parse(new TextDecoder().decode(payload))),
			() => { }, () => { }, new NullLogService(),
		);
		const access = chat as unknown as {
			subscribers: Map<string, Map<string, { readonly liveEncoding: string | undefined; readonly responseEncoding: string | undefined }>>;
			pushToSubscribers(token: string): void;
		};
		const encodings = () => {
			const subscriber = access.subscribers.get(token)?.get('mobile-1');
			return { live: subscriber?.liveEncoding, response: subscriber?.responseEncoding };
		};
		try {
			chat.setEagerTailing(true);
			assert.strictEqual(chat.syncPanes(1, 'window-session', 1, 1, [{ terminalId: 1, token }]), true);
			fireParadisAgentHookEvent({ token, event: 'UserPromptSubmit', sessionId: 'session-keep-encodings', transcriptPath, cwd: '/workspace', at: Date.now() });
			chat.handleInbound('mobile-1', new TextEncoder().encode(JSON.stringify({ t: 'attach', id: 1, token, liveEncoding: 'agent-live-append-v1', responseEncoding: 'json-gzip-v1' })));
			await waitFor(() => sent.some(message => message.t === 'snapshot'), 'the attach did not answer with a snapshot');
			const attached = encodings();
			sent.length = 0;
			access.pushToSubscribers(token);
			await waitFor(() => sent.some(message => message.t === 'snapshot'), 'the re-send did not answer with a snapshot');
			assert.deepStrictEqual({ attached, afterPush: encodings() }, {
				attached: { live: 'agent-live-append-v1', response: 'json-gzip-v1' },
				afterPush: { live: 'agent-live-append-v1', response: 'json-gzip-v1' },
			});
		} finally {
			chat.dispose();
		}
	});

	test('reflects SubagentStart/SubagentStop into backgroundTasks so review notifications wait for the subagent', async () => {
		const token = 'pane-subagent-background-task';
		const transcriptPath = join(paradisClaudeConfigDir(), 'projects', 'para-code-tests', 'subagent-background-task.jsonl');
		const chat = new ParadisMobileAgentChat(() => { }, () => { }, () => { }, new NullLogService());
		const access = chat as unknown as {
			tailers: Map<string, { readonly backgroundTasks: ReadonlyMap<string, number> }>;
			hookProcessing: Map<string, Promise<void>>;
		};
		try {
			chat.setEagerTailing(true);
			assert.strictEqual(chat.syncPanes(1, 'window-session', 1, 1, [{ terminalId: 1, token }]), true);

			fireParadisAgentHookEvent({
				token, event: 'UserPromptSubmit', sessionId: 'session-1', transcriptPath,
				cwd: '/workspace', payload: { prompt: '調査して' }, at: Date.now(),
			});
			await waitFor(() => !access.hookProcessing.has(token), 'UserPromptSubmit was not processed');

			// 不正なagent_id (許可文字外) はbackgroundTasksへ登録されない。
			fireParadisAgentHookEvent({
				token, event: 'SubagentStart', sessionId: 'session-1', transcriptPath, cwd: '/workspace',
				payload: { agent_id: '../etc/passwd' }, at: Date.now(),
			});
			await waitFor(() => !access.hookProcessing.has(token), 'invalid SubagentStart was not processed');

			fireParadisAgentHookEvent({
				token, event: 'SubagentStart', sessionId: 'session-1', transcriptPath, cwd: '/workspace',
				payload: { agent_id: 'abc-1', agent_type: 'general-purpose' }, at: Date.now(),
			});
			await waitFor(() => !access.hookProcessing.has(token), 'SubagentStart was not processed');
			assert.deepStrictEqual([...(access.tailers.get(token)?.backgroundTasks.keys() ?? [])], ['hook:abc-1']);

			fireParadisAgentHookEvent({
				token, event: 'SubagentStop', sessionId: 'session-1', transcriptPath, cwd: '/workspace',
				payload: { agent_id: 'abc-1', last_assistant_message: '完了' }, at: Date.now(),
			});
			await waitFor(() => !access.hookProcessing.has(token), 'SubagentStop was not processed');
			assert.deepStrictEqual([...(access.tailers.get(token)?.backgroundTasks.keys() ?? [])], []);
		} finally {
			chat.dispose();
		}
	});

	test('clears a leftover hook background task (SubagentStop firing loss) once the next user turn starts', async () => {
		const token = 'pane-subagent-leftover-task';
		const transcriptPath = join(paradisClaudeConfigDir(), 'projects', 'para-code-tests', 'subagent-leftover-task.jsonl');
		const chat = new ParadisMobileAgentChat(() => { }, () => { }, () => { }, new NullLogService());
		const access = chat as unknown as {
			tailers: Map<string, { readonly backgroundTasks: ReadonlyMap<string, number> }>;
			hookProcessing: Map<string, Promise<void>>;
		};
		try {
			chat.setEagerTailing(true);
			assert.strictEqual(chat.syncPanes(1, 'window-session', 1, 1, [{ terminalId: 1, token }]), true);

			fireParadisAgentHookEvent({
				token, event: 'UserPromptSubmit', sessionId: 'session-2', transcriptPath,
				cwd: '/workspace', payload: { prompt: '調査して' }, at: Date.now(),
			});
			await waitFor(() => !access.hookProcessing.has(token), 'first UserPromptSubmit was not processed');

			fireParadisAgentHookEvent({
				token, event: 'SubagentStart', sessionId: 'session-2', transcriptPath, cwd: '/workspace',
				payload: { agent_id: 'orphan-1' }, at: Date.now(),
			});
			await waitFor(() => !access.hookProcessing.has(token), 'SubagentStart was not processed');
			assert.deepStrictEqual([...(access.tailers.get(token)?.backgroundTasks.keys() ?? [])], ['hook:orphan-1']);

			// SubagentStopの発火漏れを模擬: 対応するStopが来ないまま次のユーザーターンが始まる。
			fireParadisAgentHookEvent({
				token, event: 'UserPromptSubmit', sessionId: 'session-2', transcriptPath,
				cwd: '/workspace', payload: { prompt: '次の指示' }, at: Date.now(),
			});
			await waitFor(() => !access.hookProcessing.has(token), 'second UserPromptSubmit was not processed');
			assert.deepStrictEqual([...(access.tailers.get(token)?.backgroundTasks.keys() ?? [])], []);
		} finally {
			chat.dispose();
		}
	});

	test('detects a Codex subagent rollout whose session_id names the parent thread', () => {
		// 現行Codexが実際に書く形。子rolloutの session_id は「親の」thread IDで、自分のIDは id 側。
		assert.deepStrictEqual(paradisParseCodexSessionMeta(JSON.stringify({
			type: 'session_meta', payload: {
				cwd: '/workspace', session_id: 'thread-parent', id: 'thread-child', parent_thread_id: 'thread-parent',
				thread_source: 'subagent',
				source: { subagent: { thread_spawn: { parent_thread_id: 'thread-parent', depth: 1, agent_path: '/root/tests', agent_nickname: 'Mill' } } },
			},
		})), {
			cwd: '/workspace', sessionId: 'thread-parent', subagent: true, parentThreadId: 'thread-parent',
			depth: 1, agentPath: '/root/tests', agentNickname: 'Mill',
		});
	});

	test('detects a Codex subagent rollout that only differs by its own thread id', () => {
		// source / thread_source が無い形。親を指すIDは、session_id（=親）ではなく id（=自分）と
		// 比べないと子だと分からない。この比較先がこの修正の本丸。
		assert.deepStrictEqual(paradisParseCodexSessionMeta(JSON.stringify({
			type: 'session_meta', payload: { cwd: '/workspace', session_id: 'thread-parent', id: 'thread-child', parent_thread_id: 'thread-parent' },
		})), { cwd: '/workspace', sessionId: 'thread-parent', subagent: true, parentThreadId: 'thread-parent' });
	});

	test('detects a Codex subagent rollout from either spawn marker alone', () => {
		const parse = (payload: object) => paradisParseCodexSessionMeta(JSON.stringify({ type: 'session_meta', payload: { cwd: '/workspace', ...payload } }));
		assert.deepStrictEqual([
			// thread_source だけ（親IDが読めなくても子と分かる）。
			parse({ id: 'thread-child', thread_source: 'subagent' }),
			// source.subagent.thread_spawn だけ。
			parse({ id: 'thread-child', source: { subagent: { thread_spawn: { parent_thread_id: 'thread-parent' } } } }),
		], [
			{ cwd: '/workspace', sessionId: 'thread-child', subagent: true },
			{ cwd: '/workspace', sessionId: 'thread-child', subagent: true, parentThreadId: 'thread-parent' },
		]);
	});

	test('keeps a root Codex rollout free of a subagent marker', () => {
		assert.deepStrictEqual(paradisParseCodexSessionMeta(JSON.stringify({
			type: 'session_meta', payload: { cwd: '/workspace', session_id: 'thread-root', id: 'thread-root' },
		})), { cwd: '/workspace', sessionId: 'thread-root' });
		// forkやresumeで自分自身を指す parent_thread_id が入っても root のまま。
		assert.deepStrictEqual(paradisParseCodexSessionMeta(JSON.stringify({
			type: 'session_meta', payload: { cwd: '/workspace', id: 'thread-root', parent_thread_id: 'thread-root' },
		})), { cwd: '/workspace', sessionId: 'thread-root' });
	});

	test('never lets a nested agent hook claim the pane session', () => {
		const claudeChild = '/Users/test/.claude/projects/workspace/session/subagents/agent-parent-123.jsonl';
		const claudeRoot = '/Users/test/.claude/projects/workspace/session.jsonl';
		const codexChild = '/Users/test/.codex/sessions/2026/07/29/rollout-child.jsonl';
		const codexParent = '/Users/test/.codex/sessions/2026/07/29/rollout-parent.jsonl';
		const resolve = (hookTranscriptPath: string, paneTranscriptPath: string | undefined, claudeNestedAgentId?: string, codexOrigin?: 'root' | 'subagent' | 'unknown') =>
			paradisResolveHookSessionTranscript({ hookTranscriptPath, paneTranscriptPath, claudeNestedAgentId, codexOrigin });

		assert.deepStrictEqual([
			// root threadのhookはそのままペインのセッションになる（未確定でも、別セッションからの切替でも）。
			resolve(codexParent, undefined, undefined, 'root'),
			resolve(codexParent, '/Users/test/.codex/sessions/2026/07/29/rollout-previous.jsonl', undefined, 'root'),
			// Claudeのsidechain: 既知rootを保ち、未確定ならpathからrootを復元する。
			resolve(claudeChild, claudeRoot, 'parent-123'),
			resolve(claudeChild, undefined, 'parent-123'),
			// 規約外のpathでrootを復元できないsidechainは、hookのpathへフォールバックする。
			resolve('/subagents/agent-parent-123.jsonl', undefined, 'parent-123'),
			// Codexのsubagent thread: 親のrolloutを保つ。親が未確定なら子で確定させない。
			resolve(codexChild, codexParent, undefined, 'subagent'),
			resolve(codexChild, undefined, undefined, 'subagent'),
			// 素性を読めなかったrollout: 確定済みペインではrebindを見送り、未確定なら確定させる。
			resolve(codexChild, codexParent, undefined, 'unknown'),
			resolve(codexChild, undefined, undefined, 'unknown'),
		], [
			{ kind: 'session', transcriptPath: codexParent, nested: undefined },
			{ kind: 'session', transcriptPath: codexParent, nested: undefined },
			{ kind: 'session', transcriptPath: claudeRoot, nested: 'claude' },
			{ kind: 'session', transcriptPath: claudeRoot, nested: 'claude' },
			{ kind: 'session', transcriptPath: '/subagents/agent-parent-123.jsonl', nested: 'claude' },
			{ kind: 'session', transcriptPath: codexParent, nested: 'codex' },
			{ kind: 'drop' },
			{ kind: 'session', transcriptPath: codexParent, nested: 'codex' },
			{ kind: 'session', transcriptPath: codexChild, nested: undefined },
		]);
	});

	test('does not guess when multiple fresh sessions match the same cwd', () => {
		assert.strictEqual(paradisSelectUnambiguousSessionCandidate([
			{ transcriptPath: '/sessions/a.jsonl', mtime: 20 },
			{ transcriptPath: '/sessions/b.jsonl', mtime: 21 },
		], 10, new Set()), undefined);
	});

	test('selects the sole unclaimed fresh session', () => {
		assert.deepStrictEqual(paradisSelectUnambiguousSessionCandidate([
			{ transcriptPath: '/sessions/a.jsonl', mtime: 20 },
			{ transcriptPath: '/sessions/b.jsonl', mtime: 21 },
		], 10, new Set(['/sessions/a.jsonl'])), { transcriptPath: '/sessions/b.jsonl', mtime: 21 });
	});

	suite('Codex fork', () => {
		const ROOT = '01a10509-174f-7a50-8db2-15c8c5def743';
		const FORK = '01a10509-4a1d-7a72-b8bb-30fcf84c4ade';
		const FORK_OF_FORK = '01a10509-aa80-7f22-a40e-79640d480d20';
		const OTHER_ROOT = '01a10509-0000-7000-8000-000000000001';
		const OTHER_FORK = '01a10509-0000-7000-8000-000000000002';
		/** codex-cli 0.160.0 の rollout の行（形は実データ、本文は匿名）。 */
		const line = (ordinal: number, type: string, payload: Record<string, unknown>) => JSON.stringify({ timestamp: '2026-10-04T03:50:44.000Z', ordinal, type, payload });
		const meta = (id: string, cwd: string, fork?: { readonly parent: string; readonly endByteOffset?: number }) => line(0, 'session_meta', {
			id, session_id: id, cwd, source: 'cli', thread_source: 'user', cli_version: '0.160.0', history_mode: 'paginated',
			...(fork !== undefined ? { forked_from_id: fork.parent, ...(fork.endByteOffset !== undefined ? { history_base: { thread_id: fork.parent, end_ordinal_exclusive: 24, end_byte_offset: fork.endByteOffset } } : {}) } : {}),
		});
		const user = (ordinal: number, text: string) => line(ordinal, 'response_item', { type: 'message', role: 'user', content: [{ type: 'input_text', text }], internal_chat_message_metadata_passthrough: { content_item_kinds: ['user.text'] } });
		const assistant = (ordinal: number, text: string) => line(ordinal, 'response_item', { type: 'message', role: 'assistant', content: [{ type: 'output_text', text }] });
		const exec = (ordinal: number, callId: string, output: string) => [
			line(ordinal, 'response_item', { type: 'custom_tool_call', id: `ctc_${callId}`, status: 'completed', call_id: callId, name: 'exec', input: 'text(await tools.exec_command({cmd:"ls"}));\n' }),
			line(ordinal + 1, 'response_item', { type: 'custom_tool_call_output', id: `ctco_${callId}`, call_id: callId, output: [{ type: 'input_text', text: 'Script completed\nWall time 0.1 seconds\nOutput:\n' }, { type: 'input_text', text: output }] }),
		];
		const jsonl = (lines: readonly string[]) => lines.map(item => `${item}\n`).join('');
		const rolloutPath = (codexHome: string, id: string) => join(codexHome, 'sessions', '2026', '10', '04', `rollout-2026-10-04T12-50-44-${id}.jsonl`);
		interface IThreadRow { readonly id: string; readonly path: string; readonly cwd: string; readonly createdAt: number; readonly updatedAt: number }
		const writeStateDatabase = async (codexHome: string, rows: readonly IThreadRow[]) => {
			await rm(join(codexHome, 'state_1.sqlite'), { force: true });
			createEmptyCodexStateDatabase(codexHome);
			const { DatabaseSync } = nodeRequire('node:sqlite') as typeof import('node:sqlite');
			const database = new DatabaseSync(join(codexHome, 'state_1.sqlite'));
			try {
				const insert = database.prepare('INSERT INTO threads (id, rollout_path, source, cwd, archived, updated_at_ms, updated_at, created_at_ms, created_at) VALUES (?, ?, ?, ?, 0, ?, ?, ?, ?)');
				for (const row of rows) {
					insert.run(row.id, row.path, 'cli', row.cwd, row.updatedAt, Math.floor(row.updatedAt / 1000), row.createdAt, Math.floor(row.createdAt / 1000));
				}
			} finally {
				database.close();
			}
		};
		interface ICodexForkAccess {
			readonly paneSessions: Map<string, { readonly transcriptPath: string; readonly sessionId?: string }>;
			readonly cliDiscoveryGenerations: Map<string, number>;
			readonly tailers: Map<string, { readonly ready: Promise<void>; readonly wasInitialTruncated: boolean; readonly messages: readonly { readonly rev: number; readonly role: string; readonly kind: string; readonly text: string }[] }>;
			discoverAndNotify(token: string, agent: 'claude' | 'codex', mode: 'new' | 'resume' | 'fork' | 'attach', cwd: string, minMtime: number | undefined, generation: number, requestedSessionId?: string): Promise<void>;
			scanPanesForUnclaimedSessions(): Promise<void>;
		}

		test('decides which pane a fork may bind to from forked_from_id', () => {
			const policy = (allowed: readonly string[], options: { readonly anyParent?: boolean; readonly foreign?: readonly string[]; readonly reserved?: readonly string[]; readonly forkOnly?: boolean } = {}) => ({
				allowedParents: new Set(allowed), anyParent: options.anyParent === true, foreignParents: new Set(options.foreign ?? []), reservedParents: new Set(options.reserved ?? []), forkOnly: options.forkOnly === true,
			});
			assert.deepStrictEqual([
				// fork 先でない会話は、これまでどおり採る（fork を打った直後の探索だけは採らない）
				paradisCodexForkCandidateAllowed(undefined, policy([])),
				paradisCodexForkCandidateAllowed(undefined, policy([ROOT], { forkOnly: true })),
				// TUI の /fork: 元がこのペインの会話なら採る。ほかのペインの照合・常駐スキャンは採らない
				paradisCodexForkCandidateAllowed(ROOT, policy([ROOT])),
				paradisCodexForkCandidateAllowed(ROOT, policy([])),
				paradisCodexForkCandidateAllowed(ROOT, policy([OTHER_ROOT])),
				// `codex fork X` を打ったペインは X の fork 先を採り、X を持つペインは採らない
				paradisCodexForkCandidateAllowed(ROOT, policy([ROOT], { forkOnly: true })),
				paradisCodexForkCandidateAllowed(ROOT, policy([ROOT], { reserved: [ROOT] })),
				// `codex fork`（id 無し・`--last`）は元を問わない。ただし元がほかの生存ペインの今の会話なら採らない
				paradisCodexForkCandidateAllowed(OTHER_ROOT, policy([], { anyParent: true, forkOnly: true })),
				paradisCodexForkCandidateAllowed(OTHER_ROOT, policy([], { anyParent: true, forkOnly: true, foreign: [OTHER_ROOT] })),
			], [true, false, true, false, false, true, false, true, false]);
		});

		test('reads forked_from_id and history_base from the session_meta of a fork', () => {
			assert.deepStrictEqual([
				paradisParseCodexSessionMeta(meta(FORK, '/w', { parent: ROOT, endByteOffset: 40990 })),
				paradisParseCodexSessionMeta(meta(ROOT, '/w')),
			], [
				{ cwd: '/w', sessionId: FORK, forkedFromId: ROOT, historyBase: { threadId: ROOT, endByteOffset: 40990 } },
				{ cwd: '/w', sessionId: ROOT },
			]);
		});

		test('binds a fork only to the pane that forked: TUI /fork, the neighbor reconciliation and the standing scan', async () => {
			await withDirectoryWalkFixture(async ({ workspace, codexHome }) => {
				const elsewhere = join(workspace, 'elsewhere');
				await mkdir(elsewhere, { recursive: true });
				await mkdir(join(codexHome, 'sessions', '2026', '10', '04'), { recursive: true });
				const now = Date.now();
				const paths = Object.fromEntries([ROOT, FORK, FORK_OF_FORK, OTHER_ROOT, OTHER_FORK].map(id => [id, rolloutPath(codexHome, id)]));
				await writeFile(paths[ROOT], jsonl([meta(ROOT, workspace), user(1, '最初の質問')]));
				await writeFile(paths[OTHER_ROOT], jsonl([meta(OTHER_ROOT, elsewhere), user(1, '別の会話')]));
				// fork 先は fork した瞬間に作られる（まだ発言は無い）
				await writeFile(paths[FORK], jsonl([meta(FORK, workspace, { parent: ROOT, endByteOffset: 1 })]));
				await writeFile(paths[OTHER_FORK], jsonl([meta(OTHER_FORK, elsewhere, { parent: OTHER_ROOT, endByteOffset: 1 })]));
				const rows: IThreadRow[] = [
					{ id: ROOT, path: paths[ROOT], cwd: workspace, createdAt: now - 600_000, updatedAt: now - 600_000 },
					{ id: OTHER_ROOT, path: paths[OTHER_ROOT], cwd: elsewhere, createdAt: now - 600_000, updatedAt: now - 600_000 },
					{ id: FORK, path: paths[FORK], cwd: workspace, createdAt: now + 1_000, updatedAt: now + 1_000 },
					{ id: OTHER_FORK, path: paths[OTHER_FORK], cwd: elsewhere, createdAt: now + 1_000, updatedAt: now + 1_000 },
				];
				await writeStateDatabase(codexHome, rows);
				const chat = new ParadisMobileAgentChat(() => { }, () => { }, () => { }, new NullLogService());
				const access = chat as unknown as ICodexForkAccess;
				try {
					assert.strictEqual(chat.syncPanes(1, 'window-session', 1, 1, [
						{ terminalId: 1, token: 'pane-original', cwd: workspace },
						{ terminalId: 2, token: 'pane-neighbor', cwd: workspace },
						{ terminalId: 3, token: 'pane-scan', cwd: elsewhere },
					]), true);
					fireParadisAgentHookEvent({ token: 'pane-original', event: 'SessionStart', sessionId: ROOT, transcriptPath: paths[ROOT], cwd: workspace, payload: { source: 'startup' }, at: now });
					await waitFor(() => access.paneSessions.get('pane-original')?.transcriptPath === paths[ROOT], 'the original pane was not bound');
					for (const token of ['pane-original', 'pane-neighbor', 'pane-scan']) {
						access.cliDiscoveryGenerations.set(token, 0);
					}
					const minMtime = now - 60_000;
					// 同じフォルダの別のペインの照合・別のフォルダの常駐スキャンは、持ち主の決まっていない fork 先を採らない
					await access.discoverAndNotify('pane-neighbor', 'codex', 'resume', workspace, minMtime, 0);
					await access.scanPanesForUnclaimedSessions();
					const neighbor = access.paneSessions.get('pane-neighbor')?.transcriptPath;
					const scanned = access.paneSessions.get('pane-scan')?.transcriptPath;
					// /fork したペインの照合は、元が今の会話と一致する fork 先へ張り替える
					await access.discoverAndNotify('pane-original', 'codex', 'resume', workspace, minMtime, 0);
					const followed = access.paneSessions.get('pane-original');
					// 張り替えた後の /fork（fork の fork）も同じように追う
					await writeFile(paths[FORK_OF_FORK], jsonl([meta(FORK_OF_FORK, workspace, { parent: FORK, endByteOffset: 1 })]));
					await writeStateDatabase(codexHome, [...rows, { id: FORK_OF_FORK, path: paths[FORK_OF_FORK], cwd: workspace, createdAt: now + 2_000, updatedAt: now + 2_000 }]);
					await access.discoverAndNotify('pane-neighbor', 'codex', 'resume', workspace, minMtime, 0);
					await access.discoverAndNotify('pane-original', 'codex', 'resume', workspace, now + 1_500, 0);
					assert.deepStrictEqual({
						neighbor, scanned, followed,
						neighborAfterSecondFork: access.paneSessions.get('pane-neighbor')?.transcriptPath,
						followedTwice: access.paneSessions.get('pane-original')?.sessionId,
					}, {
						neighbor: undefined, scanned: undefined,
						followed: { token: 'pane-original', agent: 'codex', transcriptPath: paths[FORK], sessionId: FORK },
						neighborAfterSecondFork: undefined,
						followedTwice: FORK_OF_FORK,
					});
				} finally {
					chat.dispose();
				}
			});
		});

		test('codex fork X binds the new fork of X, not X itself, and leaves X with the pane that runs it', async () => {
			await withDirectoryWalkFixture(async ({ workspace, codexHome }) => {
				await mkdir(join(codexHome, 'sessions', '2026', '10', '04'), { recursive: true });
				const now = Date.now();
				const root = rolloutPath(codexHome, ROOT);
				const fork = rolloutPath(codexHome, FORK);
				await writeFile(root, jsonl([meta(ROOT, workspace), user(1, '最初の質問')]));
				await writeFile(fork, jsonl([meta(FORK, workspace, { parent: ROOT, endByteOffset: 1 })]));
				await writeStateDatabase(codexHome, [
					{ id: ROOT, path: root, cwd: workspace, createdAt: now - 600_000, updatedAt: now - 600_000 },
					{ id: FORK, path: fork, cwd: workspace, createdAt: now + 1_000, updatedAt: now + 1_000 },
				]);
				const chat = new ParadisMobileAgentChat(() => { }, () => { }, () => { }, new NullLogService());
				const access = chat as unknown as ICodexForkAccess;
				try {
					assert.strictEqual(chat.syncPanes(1, 'window-session', 1, 1, [
						{ terminalId: 1, token: 'pane-original', cwd: workspace },
						{ terminalId: 2, token: 'pane-forked', cwd: workspace },
					]), true);
					fireParadisAgentHookEvent({ token: 'pane-original', event: 'SessionStart', sessionId: ROOT, transcriptPath: root, cwd: workspace, payload: { source: 'startup' }, at: now });
					await waitFor(() => access.paneSessions.get('pane-original')?.transcriptPath === root, 'the original pane was not bound');
					chat.onCliCommandDetected('pane-forked', 'codex', 'fork', workspace, undefined, ROOT);
					// 元のペインの照合は、ほかのペインで `codex fork X` を打った X の fork 先を採らない
					const originalGeneration = access.cliDiscoveryGenerations.get('pane-original') ?? 0;
					access.cliDiscoveryGenerations.set('pane-original', originalGeneration);
					await access.discoverAndNotify('pane-original', 'codex', 'resume', workspace, now - 60_000, originalGeneration);
					const originalWhileForking = access.paneSessions.get('pane-original')?.transcriptPath;
					await access.discoverAndNotify('pane-forked', 'codex', 'fork', workspace, now - 15_000, access.cliDiscoveryGenerations.get('pane-forked') ?? -1);
					assert.deepStrictEqual({
						originalWhileForking,
						original: access.paneSessions.get('pane-original')?.transcriptPath,
						forked: access.paneSessions.get('pane-forked'),
					}, {
						originalWhileForking: root,
						original: root,
						forked: { token: 'pane-forked', agent: 'codex', transcriptPath: fork, sessionId: FORK },
					});
				} finally {
					chat.dispose();
				}
			});
		});

		test('still binds a new thread whose rollout is not written yet, and does not guess when another candidate exists', async () => {
			await withDirectoryWalkFixture(async ({ workspace, codexHome }) => {
				await mkdir(join(codexHome, 'sessions', '2026', '10', '04'), { recursive: true });
				const now = Date.now();
				const written = rolloutPath(codexHome, ROOT);
				// Codex は最初の発言まで rollout を作らない（DB の行だけがある）
				const notWritten = rolloutPath(codexHome, OTHER_ROOT);
				const broken = rolloutPath(codexHome, OTHER_FORK);
				await writeFile(written, jsonl([meta(ROOT, workspace), user(1, '最初の質問')]));
				await writeFile(broken, '{"timestamp":"2026-10-04T03:50:44.000Z","type":"session_meta","payload":{"id"');
				const row = (id: string, path: string) => ({ id, path, cwd: workspace, createdAt: now + 1_000, updatedAt: now + 1_000 });
				// 1 回ずつ新しいペインで探す（前の回の claim を持ち越さない）
				const discover = async (rows: readonly IThreadRow[]) => {
					await writeStateDatabase(codexHome, rows);
					const chat = new ParadisMobileAgentChat(() => { }, () => { }, () => { }, new NullLogService());
					const access = chat as unknown as ICodexForkAccess;
					try {
						assert.strictEqual(chat.syncPanes(1, 'window-session', 1, 1, [{ terminalId: 1, token: 'pane-new', cwd: workspace }]), true);
						access.cliDiscoveryGenerations.set('pane-new', 0);
						await access.discoverAndNotify('pane-new', 'codex', 'new', workspace, now - 15_000, 0);
						return access.paneSessions.get('pane-new')?.transcriptPath;
					} finally {
						chat.dispose();
					}
				};
				assert.deepStrictEqual({
					alone: await discover([row(OTHER_ROOT, notWritten)]),
					// 同じフォルダの 2 つのペインの会話で、片方だけ rollout が書かれている: どちらか決めない
					two: await discover([row(ROOT, written), row(OTHER_ROOT, notWritten)]),
					// 先頭行が読めない候補は選ばれても結ばない。ほかの候補と並べば一意と数えない
					broken: await discover([row(OTHER_FORK, broken)]),
					brokenPair: await discover([row(ROOT, written), row(OTHER_FORK, broken)]),
				}, { alone: notWritten, two: undefined, broken: undefined, brokenPair: undefined });
			});
		});

		test('codex fork --last in two panes binds each pane to the fork of its own conversation, and a malformed id binds nothing', async () => {
			await withDirectoryWalkFixture(async ({ workspace, codexHome }) => {
				await mkdir(join(codexHome, 'sessions', '2026', '10', '04'), { recursive: true });
				const now = Date.now();
				const paths = Object.fromEntries([ROOT, FORK, OTHER_ROOT, OTHER_FORK].map(id => [id, rolloutPath(codexHome, id)]));
				await writeFile(paths[ROOT], jsonl([meta(ROOT, workspace), user(1, 'A の質問')]));
				await writeFile(paths[OTHER_ROOT], jsonl([meta(OTHER_ROOT, workspace), user(1, 'B の質問')]));
				await writeFile(paths[FORK], jsonl([meta(FORK, workspace, { parent: ROOT, endByteOffset: 1 })]));
				await writeFile(paths[OTHER_FORK], jsonl([meta(OTHER_FORK, workspace, { parent: OTHER_ROOT, endByteOffset: 1 })]));
				await writeStateDatabase(codexHome, [
					{ id: ROOT, path: paths[ROOT], cwd: workspace, createdAt: now - 600_000, updatedAt: now - 600_000 },
					{ id: OTHER_ROOT, path: paths[OTHER_ROOT], cwd: workspace, createdAt: now - 600_000, updatedAt: now - 600_000 },
					{ id: FORK, path: paths[FORK], cwd: workspace, createdAt: now + 1_000, updatedAt: now + 1_000 },
					{ id: OTHER_FORK, path: paths[OTHER_FORK], cwd: workspace, createdAt: now + 1_000, updatedAt: now + 1_000 },
				]);
				const chat = new ParadisMobileAgentChat(() => { }, () => { }, () => { }, new NullLogService());
				const access = chat as unknown as ICodexForkAccess;
				try {
					assert.strictEqual(chat.syncPanes(1, 'window-session', 1, 1, [
						{ terminalId: 1, token: 'pane-a', cwd: workspace },
						{ terminalId: 2, token: 'pane-b', cwd: workspace },
						{ terminalId: 3, token: 'pane-malformed', cwd: workspace },
					]), true);
					fireParadisAgentHookEvent({ token: 'pane-a', event: 'SessionStart', sessionId: ROOT, transcriptPath: paths[ROOT], cwd: workspace, payload: { source: 'startup' }, at: now });
					fireParadisAgentHookEvent({ token: 'pane-b', event: 'SessionStart', sessionId: OTHER_ROOT, transcriptPath: paths[OTHER_ROOT], cwd: workspace, payload: { source: 'startup' }, at: now });
					await waitFor(() => access.paneSessions.has('pane-a') && access.paneSessions.has('pane-b'), 'the panes were not bound');
					// 形に合わない id: 元が分からないので、照合では fork 先を結ばない（hook に任せる）
					chat.onCliCommandDetected('pane-malformed', 'codex', 'fork', workspace, undefined, 'not a thread id');
					await access.discoverAndNotify('pane-malformed', 'codex', 'fork', workspace, now - 15_000, access.cliDiscoveryGenerations.get('pane-malformed') ?? -1);
					// 2 つのペインで `codex fork --last`: 元がほかのペインの今の会話である fork 先は採らない
					chat.onCliCommandDetected('pane-a', 'codex', 'fork', workspace);
					chat.onCliCommandDetected('pane-b', 'codex', 'fork', workspace);
					await access.discoverAndNotify('pane-a', 'codex', 'fork', workspace, now - 15_000, access.cliDiscoveryGenerations.get('pane-a') ?? -1);
					await access.discoverAndNotify('pane-b', 'codex', 'fork', workspace, now - 15_000, access.cliDiscoveryGenerations.get('pane-b') ?? -1);
					assert.deepStrictEqual({
						malformed: access.paneSessions.get('pane-malformed')?.transcriptPath,
						a: access.paneSessions.get('pane-a')?.transcriptPath,
						b: access.paneSessions.get('pane-b')?.transcriptPath,
					}, { malformed: undefined, a: paths[FORK], b: paths[OTHER_FORK] });
				} finally {
					chat.dispose();
				}
			});
		});

		test('shows the history of a fork from the rollouts it refers to, without duplicates', async () => {
			await withDirectoryWalkFixture(async ({ workspace, codexHome }) => {
				await mkdir(join(codexHome, 'sessions', '2026', '10', '04'), { recursive: true });
				const root = rolloutPath(codexHome, ROOT);
				const fork = rolloutPath(codexHome, FORK);
				const forkOfFork = rolloutPath(codexHome, FORK_OF_FORK);
				const rootHistory = jsonl([meta(ROOT, workspace), user(1, '最初の質問'), ...exec(2, 'call_root', 'README.md'), assistant(4, '最初の答え')]);
				// fork した後に元の会話へ足された行は、fork 先の過去の会話ではない
				await writeFile(root, rootHistory + jsonl([user(5, 'fork の後に元で聞いた')]));
				const forkLines = jsonl([meta(FORK, workspace, { parent: ROOT, endByteOffset: Buffer.byteLength(rootHistory) }), line(25, 'event_msg', { type: 'thread_settings_applied' }), user(26, 'fork で聞いた'), ...exec(27, 'call_fork', 'src'), assistant(29, 'fork の答え')]);
				await writeFile(fork, forkLines);
				await writeFile(forkOfFork, jsonl([meta(FORK_OF_FORK, workspace, { parent: FORK, endByteOffset: Buffer.byteLength(forkLines) }), user(31, '二度目の fork')]));
				await writeStateDatabase(codexHome, [ROOT, FORK, FORK_OF_FORK].map(id => ({ id, path: rolloutPath(codexHome, id), cwd: workspace, createdAt: Date.now(), updatedAt: Date.now() })));
				const chat = new ParadisMobileAgentChat(() => { }, () => { }, () => { }, new NullLogService());
				const access = chat as unknown as ICodexForkAccess;
				try {
					assert.strictEqual(chat.syncPanes(1, 'window-session', 1, 1, [{ terminalId: 1, token: 'pane-fork', cwd: workspace }]), true);
					fireParadisAgentHookEvent({ token: 'pane-fork', event: 'SessionStart', sessionId: FORK_OF_FORK, transcriptPath: forkOfFork, cwd: workspace, payload: { source: 'fork' }, at: Date.now() });
					await waitFor(() => access.tailers.has('pane-fork'), 'the fork was not tailed');
					const tailer = access.tailers.get('pane-fork')!;
					await tailer.ready;
					assert.strictEqual(tailer.wasInitialTruncated, false);
					assert.deepStrictEqual(tailer.messages.map(message => `${message.rev}:${message.role}:${message.kind}:${message.text}`), [
						'0:user:text:最初の質問',
						'1:assistant:tool_use:text(await tools.exec_command({cmd:"ls"}));\n',
						'2:tool:tool_result:Script completed\nWall time 0.1 seconds\nOutput:\nREADME.md',
						'3:assistant:text:最初の答え',
						'4:user:text:fork で聞いた',
						'5:assistant:tool_use:text(await tools.exec_command({cmd:"ls"}));\n',
						'6:tool:tool_result:Script completed\nWall time 0.1 seconds\nOutput:\nsrc',
						'7:assistant:text:fork の答え',
						'8:user:text:二度目の fork',
					]);
				} finally {
					chat.dispose();
				}
			});
		});

		test('shows only the fork when the referred rollout is missing, too short or not at a line boundary', async () => {
			await withDirectoryWalkFixture(async ({ workspace, codexHome }) => {
				await mkdir(join(codexHome, 'sessions', '2026', '10', '04'), { recursive: true });
				const root = rolloutPath(codexHome, ROOT);
				const rootHistory = jsonl([meta(ROOT, workspace), user(1, '最初の質問'), assistant(2, '最初の答え')]);
				await writeFile(root, rootHistory);
				const resolveRoot = async (threadId: string) => threadId === ROOT ? root : undefined;
				const read = (endByteOffset: number, budget = 1024 * 1024, parent = ROOT) => paradisReadCodexForkHistory(meta(FORK, workspace, { parent, endByteOffset }), resolveRoot, budget);
				const size = Buffer.byteLength(rootHistory);
				const lastLine = `${assistant(2, '最初の答え')}\n`;
				// fork の fork で、さらに古い段が読めない（元の元が無い）
				const forkOfMissing = rolloutPath(codexHome, FORK);
				const forkHistory = jsonl([meta(FORK, workspace, { parent: OTHER_ROOT, endByteOffset: 10 }), user(1, 'fork で聞いた')]);
				await writeFile(forkOfMissing, forkHistory);
				const readForkOfFork = paradisReadCodexForkHistory(meta(FORK_OF_FORK, workspace, { parent: FORK, endByteOffset: Buffer.byteLength(forkHistory) }), async threadId => threadId === FORK ? forkOfMissing : undefined, 1024 * 1024);
				assert.deepStrictEqual(await Promise.all([
					readForkOfFork,
					read(size),
					// 予算を超えたら新しい方から、完全な行だけ
					read(size, Buffer.byteLength(lastLine) + 5),
					// ファイルより長い・行の境目でない・元の rollout が無い
					read(size + 1),
					read(size - 1),
					read(size, 1024 * 1024, OTHER_ROOT),
					// fork 先でない
					paradisReadCodexForkHistory(meta(FORK, workspace), resolveRoot, 1024 * 1024),
				]), [
					{ text: forkHistory, truncated: true },
					{ text: rootHistory, truncated: false },
					{ text: lastLine, truncated: true },
					undefined, undefined, undefined, undefined,
				]);
			});
		});
	});

	suite('Claude Code /fork and background sessions', () => {
		const ORIGINAL = '11111111-1111-4111-8111-111111111111';
		const FORK = '22222222-2222-4222-8222-222222222222';
		/** 会話の行。sessionKind: "bg" は daemon の配下の会話（`/fork` の分岐先）が書く形。 */
		const transcript = (sessionId: string, sessionKind?: string) => [
			JSON.stringify({ type: 'ai-title', aiTitle: '調査', sessionId }),
			JSON.stringify({ type: 'user', uuid: `u-${sessionId}`, parentUuid: null, sessionId, message: { role: 'user', content: '調べて' }, timestamp: '2026-10-03T13:32:42.642Z', ...(sessionKind !== undefined ? { sessionKind } : {}) }),
			'',
		].join('\n');
		const projectDirOf = (claudeHome: string, cwd: string) => join(claudeHome, 'projects', cwd.replace(/[^a-zA-Z0-9]/g, '-'));
		interface IForkAccess {
			readonly paneSessions: Map<string, { readonly transcriptPath: string; readonly sessionId?: string }>;
			readonly cliReconciliationTimers: Map<string, unknown>;
			readonly cliDiscoveryGenerations: Map<string, number>;
			readonly hookProcessing: Map<string, Promise<void>>;
			readonly activityTrackers: Map<string, unknown>;
			readonly attachProjectScans: Map<string, unknown>;
			readonly hookTranscriptSightings: { excludedFor(token: string, now: number): Set<string> };
			discoverAndNotify(token: string, agent: 'claude' | 'codex', mode: 'new' | 'resume' | 'fork' | 'attach', cwd: string, minMtime: number | undefined, generation: number, requestedSessionId?: string): Promise<void>;
			pushToSubscribers(token: string): void;
		}

		test('replays a /fork timeline through the reconciliation tick: neither a hooked nor a hook-less pane switches to the fork, but both follow a real switch', async () => {
			// 実ファイルの更新時刻と hook の列を、本物の 5 秒ごとの照合（setInterval）に通す。
			await withDirectoryWalkFixture(async ({ workspace, claudeHome }) => {
				const hooklessCwd = join(workspace, 'hookless');
				await mkdir(hooklessCwd, { recursive: true });
				const hookedProject = projectDirOf(claudeHome, workspace);
				const hooklessProject = projectDirOf(claudeHome, hooklessCwd);
				await mkdir(hookedProject, { recursive: true });
				await mkdir(hooklessProject, { recursive: true });
				const now = Date.now();
				const touch = (path: string, seconds: number) => utimes(path, (now + seconds * 1000) / 1000, (now + seconds * 1000) / 1000);
				const write = async (path: string, content: string, seconds: number) => {
					await writeFile(path, content);
					await touch(path, seconds);
				};
				const original = join(hookedProject, `${ORIGINAL}.jsonl`);
				const fork = join(hookedProject, `${FORK}.jsonl`);
				const resumed = join(hookedProject, '99999999-9999-4999-8999-999999999999.jsonl');
				const hooklessOriginal = join(hooklessProject, '33333333-3333-4333-8333-333333333333.jsonl');
				const hooklessFork = join(hooklessProject, '44444444-4444-4444-8444-444444444444.jsonl');
				const hooklessResumed = join(hooklessProject, '55555555-5555-4555-8555-555555555555.jsonl');
				await write(original, transcript(ORIGINAL), 1);
				await write(hooklessOriginal, transcript('hookless'), 1);
				const chat = new ParadisMobileAgentChat(() => { }, () => { }, () => { }, new NullLogService());
				const access = chat as unknown as IForkAccess;
				const discover = sinon.spy(access, 'discoverAndNotify');
				const clock = sinon.useFakeTimers({ now, toFake: ['setInterval', 'clearInterval'] });
				try {
					assert.strictEqual(chat.syncPanes(1, 'window-session', 1, 1, [
						{ terminalId: 1, token: 'pane-hooked', cwd: workspace },
						{ terminalId: 2, token: 'pane-hookless', cwd: hooklessCwd },
					]), true);
					chat.onCliCommandDetected('pane-hooked', 'claude', 'new', workspace);
					chat.onCliCommandDetected('pane-hookless', 'claude', 'new', hooklessCwd);
					fireParadisAgentHookEvent({ token: 'pane-hooked', event: 'SessionStart', sessionId: ORIGINAL, transcriptPath: original, cwd: workspace, payload: { source: 'startup' }, at: Date.now() });
					await waitFor(() => access.paneSessions.get('pane-hooked')?.transcriptPath === original, 'the hook was not applied');
					const timeline: { readonly step: string; readonly hooked?: string; readonly hookless?: string; readonly reconciling: boolean }[] = [];
					const tick = async (step: string) => {
						const before = discover.callCount;
						clock.tick(5_000);
						await Promise.all(discover.getCalls().slice(before).map(call => call.returnValue));
						timeline.push({
							step,
							hooked: access.paneSessions.get('pane-hooked')?.transcriptPath,
							hookless: access.paneSessions.get('pane-hookless')?.transcriptPath,
							reconciling: access.cliReconciliationTimers.has('pane-hooked') && access.cliReconciliationTimers.has('pane-hookless'),
						});
					};
					await tick('started');
					// `/fork`: 分岐先は daemon の配下で動く。元のペインの token で daemon の hook が届く
					// （hook の来ないペインの分岐先は sessionKind だけで外れる）
					await write(fork, transcript(FORK, 'bg'), 6);
					await write(hooklessFork, transcript('hookless-fork', 'bg'), 6);
					fireParadisAgentNestedHookEvent({ token: 'pane-hooked', event: 'SessionStart', sessionId: FORK, transcriptPath: fork, cwd: workspace, nestedAgent: 'claude', background: true, at: Date.now(), payload: { source: 'fork' } });
					await tick('forked');
					// 元の会話と分岐先が交互に更新される
					await touch(original, 12);
					await touch(hooklessOriginal, 12);
					await touch(fork, 9);
					await touch(hooklessFork, 9);
					await tick('original updated');
					await touch(fork, 18);
					await touch(hooklessFork, 18);
					await tick('fork updated');
					// SessionStart を出さない TUI 内の切り替え（Codex の /resume など）は、照合でこれまでどおり追う
					await write(resumed, transcript('resumed'), 24);
					await write(hooklessResumed, transcript('hookless-resumed'), 24);
					await tick('switched in the TUI');
					assert.deepStrictEqual(timeline, [
						{ step: 'started', hooked: original, hookless: hooklessOriginal, reconciling: true },
						{ step: 'forked', hooked: original, hookless: hooklessOriginal, reconciling: true },
						{ step: 'original updated', hooked: original, hookless: hooklessOriginal, reconciling: true },
						{ step: 'fork updated', hooked: original, hookless: hooklessOriginal, reconciling: true },
						{ step: 'switched in the TUI', hooked: resumed, hookless: hooklessResumed, reconciling: true },
					]);
				} finally {
					clock.restore();
					chat.dispose();
				}
			});
		});

		test('follows /clear by the SessionStart hook and stops reconciling when the CLI exits', async () => {
			await withDirectoryWalkFixture(async ({ workspace, claudeHome }) => {
				const project = projectDirOf(claudeHome, workspace);
				await mkdir(project, { recursive: true });
				const original = join(project, `${ORIGINAL}.jsonl`);
				const cleared = join(project, '33333333-3333-4333-8333-333333333333.jsonl');
				await writeFile(original, transcript(ORIGINAL));
				await writeFile(cleared, transcript('cleared'));
				const chat = new ParadisMobileAgentChat(() => { }, () => { }, () => { }, new NullLogService());
				const access = chat as unknown as IForkAccess;
				try {
					assert.strictEqual(chat.syncPanes(1, 'window-session', 1, 1, [{ terminalId: 1, token: 'pane-clear', cwd: workspace }]), true);
					chat.onCliCommandDetected('pane-clear', 'claude', 'new', workspace);
					fireParadisAgentHookEvent({ token: 'pane-clear', event: 'SessionStart', sessionId: ORIGINAL, transcriptPath: original, cwd: workspace, payload: { source: 'startup' }, at: Date.now() });
					await waitFor(() => access.paneSessions.get('pane-clear')?.transcriptPath === original, 'first hook was not applied');
					fireParadisAgentHookEvent({ token: 'pane-clear', event: 'SessionStart', sessionId: '33333333-3333-4333-8333-333333333333', transcriptPath: cleared, cwd: workspace, payload: { source: 'clear' }, at: Date.now() });
					await waitFor(() => access.paneSessions.get('pane-clear')?.transcriptPath === cleared, '/clear was not followed');
					const reconcilingWhileRunning = access.cliReconciliationTimers.has('pane-clear');
					chat.onCliCommandFinished('pane-clear');
					assert.deepStrictEqual({ reconcilingWhileRunning, reconcilingAfterExit: access.cliReconciliationTimers.has('pane-clear') }, { reconcilingWhileRunning: true, reconcilingAfterExit: false });
				} finally {
					chat.dispose();
				}
			});
		});

		test('checks the transcript of an unverified hook before binding a pane to a daemon-hosted session', async () => {
			await withDirectoryWalkFixture(async ({ workspace, claudeHome }) => {
				const project = projectDirOf(claudeHome, workspace);
				await mkdir(project, { recursive: true });
				const own = join(project, `${ORIGINAL}.jsonl`);
				const fork = join(project, `${FORK}.jsonl`);
				await writeFile(own, transcript(ORIGINAL));
				await writeFile(fork, transcript(FORK, 'bg'));
				const chat = new ParadisMobileAgentChat(() => { }, () => { }, () => { }, new NullLogService());
				const access = chat as unknown as IForkAccess;
				try {
					assert.strictEqual(chat.syncPanes(1, 'window-session', 1, 1, [
						{ terminalId: 1, token: 'pane-unverified', cwd: workspace },
						{ terminalId: 2, token: 'pane-verified', cwd: '/elsewhere' },
						{ terminalId: 3, token: 'pane-resumed', cwd: '/elsewhere' },
					]), true);
					// pid の無い hook: 所有者が決まる前に分岐先の hook が先に届いた
					fireParadisAgentHookEvent({ token: 'pane-unverified', event: 'SessionStart', sessionId: FORK, transcriptPath: fork, cwd: workspace, payload: { source: 'fork' }, ownerUnverified: true, at: Date.now() });
					await waitFor(() => !access.hookProcessing.has('pane-unverified'), 'the unverified fork hook was not processed');
					const afterForkHook = access.paneSessions.get('pane-unverified')?.transcriptPath;
					// 捨てた hook は daemon の会話として控えに残さない（次の hook でもう一度確かめる）
					const forkRemembered = access.hookTranscriptSightings.excludedFor('pane-other', Date.now()).has(fork);
					fireParadisAgentHookEvent({ token: 'pane-unverified', event: 'SessionStart', sessionId: ORIGINAL, transcriptPath: own, cwd: workspace, payload: { source: 'startup' }, ownerUnverified: true, at: Date.now() });
					await waitFor(() => access.paneSessions.get('pane-unverified')?.transcriptPath === own, 'the pane session was not bound');
					// 発信元を確かめた hook（分岐先をペインで --resume し直した等）は中身を見ずに採る
					fireParadisAgentHookEvent({ token: 'pane-verified', event: 'SessionStart', sessionId: FORK, transcriptPath: fork, cwd: workspace, payload: { source: 'resume' }, at: Date.now() });
					await waitFor(() => access.paneSessions.get('pane-verified')?.transcriptPath === fork, 'the verified hook was not bound');
					// SessionStart の source: resume は持ち主の行為なので、確かめられない hook でも中身を見ずに採る
					// （分岐先を --resume し直した直後は、まだ末尾の行も bg）。ここでは別のペインが先に採っているので
					// claim を移す（hook はペインの環境を伴う強い証拠）
					fireParadisAgentHookEvent({ token: 'pane-resumed', event: 'SessionStart', sessionId: FORK, transcriptPath: fork, cwd: workspace, payload: { source: 'resume' }, ownerUnverified: true, at: Date.now() });
					await waitFor(() => access.paneSessions.get('pane-resumed')?.transcriptPath === fork, 'the unverified resume hook was not bound');
					assert.deepStrictEqual({ afterForkHook, forkRemembered, unverified: access.paneSessions.get('pane-unverified')?.transcriptPath }, { afterForkHook: undefined, forkRemembered: false, unverified: own });
				} finally {
					chat.dispose();
				}
			});
		});

		test('leaves forked, nested and daemon-hosted transcripts out of the cwd reconciliation', async () => {
			await withDirectoryWalkFixture(async ({ workspace, claudeHome }) => {
				const project = projectDirOf(claudeHome, workspace);
				await mkdir(project, { recursive: true });
				const own = join(project, `${ORIGINAL}.jsonl`);
				const fork = join(project, `${FORK}.jsonl`);
				const nested = join(project, '55555555-5555-4555-8555-555555555555.jsonl');
				const daemonHosted = join(project, '66666666-6666-4666-8666-666666666666.jsonl');
				await writeFile(own, transcript(ORIGINAL));
				await writeFile(fork, transcript(FORK, 'bg'));
				await writeFile(nested, transcript('nested'));
				await writeFile(daemonHosted, transcript('daemon'));
				const chat = new ParadisMobileAgentChat(() => { }, () => { }, () => { }, new NullLogService());
				const access = chat as unknown as IForkAccess;
				try {
					assert.strictEqual(chat.syncPanes(1, 'window-session', 1, 1, [
						{ terminalId: 1, token: 'pane-scan', cwd: workspace },
						{ terminalId: 2, token: 'pane-nested-parent', cwd: '/elsewhere' },
						{ terminalId: 3, token: 'pane-daemon-origin', cwd: '/elsewhere' },
					]), true);
					// 本物の子エージェント（nested）は、これまでどおり親ペインの子エージェントの一覧に出る
					fireParadisAgentNestedHookEvent({ token: 'pane-nested-parent', event: 'SessionStart', sessionId: 'nested', transcriptPath: nested, cwd: workspace, nestedAgent: 'claude', at: Date.now() });
					// daemon の配下の会話は、daemon を起こしたペインの token で届くが、そのペインには何も出さない
					fireParadisAgentNestedHookEvent({ token: 'pane-daemon-origin', event: 'SessionStart', sessionId: 'daemon', transcriptPath: daemonHosted, cwd: workspace, nestedAgent: 'claude', background: true, at: Date.now() });
					access.cliDiscoveryGenerations.set('pane-scan', 0);
					await access.discoverAndNotify('pane-scan', 'claude', 'resume', workspace, Date.now() - 60_000, 0);
					assert.deepStrictEqual({
						scan: access.paneSessions.get('pane-scan')?.transcriptPath,
						nestedProjected: access.activityTrackers.has('pane-nested-parent'),
						daemonProjected: access.activityTrackers.has('pane-daemon-origin'),
					}, {
						scan: own,
						nestedProjected: true,
						daemonProjected: false,
					});
				} finally {
					chat.dispose();
				}
			});
		});

		test('pins claude attach <id> to the transcript named by the id and does not guess otherwise', async () => {
			await withDirectoryWalkFixture(async ({ workspace, claudeHome }) => {
				const paneProject = projectDirOf(claudeHome, workspace);
				const forkProject = join(claudeHome, 'projects', '-somewhere-else');
				await mkdir(paneProject, { recursive: true });
				await mkdir(forkProject, { recursive: true });
				// 同じ作業フォルダの元の会話は新しく更新されていても採らない
				await writeFile(join(paneProject, `${ORIGINAL}.jsonl`), transcript(ORIGINAL));
				const fork = join(forkProject, `${FORK}.jsonl`);
				await writeFile(fork, transcript(FORK, 'bg'));
				await writeFile(join(paneProject, '77777777-aaaa-4777-8777-777777777777.jsonl'), transcript('a'));
				await writeFile(join(paneProject, '77777777-bbbb-4777-8777-777777777777.jsonl'), transcript('b'));
				const chat = new ParadisMobileAgentChat(() => { }, () => { }, () => { }, new NullLogService());
				const access = chat as unknown as IForkAccess;
				try {
					assert.strictEqual(chat.syncPanes(1, 'window-session', 1, 1, [
						{ terminalId: 1, token: 'pane-attach', cwd: workspace },
						{ terminalId: 2, token: 'pane-ambiguous', cwd: workspace },
						{ terminalId: 3, token: 'pane-missing', cwd: workspace },
					]), true);
					// daemon の会話として hook で見ていても、attach の決め打ちでは採る
					fireParadisAgentNestedHookEvent({ token: 'pane-other', event: 'Stop', sessionId: FORK, transcriptPath: fork, cwd: workspace, nestedAgent: 'claude', background: true, at: Date.now() });
					chat.onCliCommandDetected('pane-attach', 'claude', 'attach', workspace, undefined, FORK.slice(0, 8));
					await waitFor(() => access.paneSessions.has('pane-attach'), 'attach was not pinned');
					for (const [token, id] of [['pane-ambiguous', '77777777'], ['pane-missing', '88888888']]) {
						access.cliDiscoveryGenerations.set(token, 0);
						await access.discoverAndNotify(token, 'claude', 'attach', workspace, undefined, 0, id);
					}
					assert.deepStrictEqual({
						attach: access.paneSessions.get('pane-attach'),
						attachReconciles: access.cliReconciliationTimers.has('pane-attach'),
						ambiguous: access.paneSessions.get('pane-ambiguous'),
						missing: access.paneSessions.get('pane-missing'),
						// 全作業フォルダの走査は、一致があったときだけ同じ起動の再試行で使い回す
						reusedScans: ['pane-attach', 'pane-ambiguous', 'pane-missing'].map(token => access.attachProjectScans.has(token)),
					}, {
						attach: { token: 'pane-attach', agent: 'claude', transcriptPath: fork, sessionId: FORK },
						attachReconciles: false,
						ambiguous: undefined,
						missing: undefined,
						reusedScans: [true, false, false],
					});
				} finally {
					chat.dispose();
				}
			});
		});

		test('tells the subscribers of a pane whose session a hook took away', async () => {
			await withDirectoryWalkFixture(async ({ workspace, claudeHome }) => {
				const project = projectDirOf(claudeHome, workspace);
				await mkdir(project, { recursive: true });
				const shared = join(project, `${ORIGINAL}.jsonl`);
				await writeFile(shared, transcript(ORIGINAL));
				const chat = new ParadisMobileAgentChat(() => { }, () => { }, () => { }, new NullLogService());
				const access = chat as unknown as IForkAccess;
				try {
					assert.strictEqual(chat.syncPanes(1, 'window-session', 1, 1, [
						{ terminalId: 1, token: 'pane-guessed', cwd: workspace },
						{ terminalId: 2, token: 'pane-hooked', cwd: '/elsewhere' },
					]), true);
					access.cliDiscoveryGenerations.set('pane-guessed', 0);
					await access.discoverAndNotify('pane-guessed', 'claude', 'resume', workspace, undefined, 0);
					const guessed = access.paneSessions.get('pane-guessed')?.transcriptPath;
					const pushes = sinon.spy(access, 'pushToSubscribers');
					fireParadisAgentHookEvent({ token: 'pane-hooked', event: 'UserPromptSubmit', sessionId: ORIGINAL, transcriptPath: shared, cwd: workspace, payload: { prompt: '続けて' }, at: Date.now() });
					await waitFor(() => access.paneSessions.get('pane-hooked')?.transcriptPath === shared, 'hook did not take the session');
					assert.deepStrictEqual({
						guessed,
						guessedAfter: access.paneSessions.get('pane-guessed'),
						pushedTo: pushes.getCalls().map(call => call.args[0]),
					}, {
						guessed: shared,
						guessedAfter: undefined,
						pushedTo: ['pane-guessed', 'pane-hooked'],
					});
				} finally {
					chat.dispose();
				}
			});
		});
	});

	test('keeps the image limits inside what a transcript line can carry', () => {
		const limits = paradisAgentChatImageLimitsForTest;
		// 1行がこの上限を超えると先頭が落ちてJSONごと壊れ、tool_result が丸ごと消える。
		// 画像1枚（base64）+ JSONの外枠が必ず収まる関係を保つこと。
		assert.ok(limits.toolImageBase64Limit < limits.maxTranscriptLineBytes, 'image limit must fit in one transcript line');
		// 初回読み込みの末尾窓に画像行が丸ごと収まらないと、開き直すたびに直近の画像が消える。
		assert.ok(limits.maxTranscriptLineBytes <= limits.initialReadTailBytes, 'initial tail must fit a full line');
		// 取り寄せ要求の index 上限（100未満）を超える画像はカードを出しても取得できない。
		assert.ok(limits.maxImagesPerMessage <= 100, 'image count must match the tool-image index bound');
	});

	test('shares one image budget across panes instead of one budget each', () => {
		const cache = paradisSharedImageCacheForTest;
		const owners = ['pane-a', 'pane-b', 'pane-c'];
		try {
			// 1枚 4M 文字 = 上限(16M)の1/4。ペインごとに枠を持っていた頃はペイン数だけ積み上がった。
			const image = { mediaType: 'image/png', base64: 'A'.repeat(4 * 1024 * 1024) };
			for (const owner of owners) {
				for (let rev = 0; rev < 3; rev++) {
					cache.set(owner, rev, 0, image);
				}
			}
			assert.ok(cache.stats().bytes <= 16 * 1024 * 1024, `shared budget exceeded: ${cache.stats().bytes}`);
			// 最後に積んだペインのものは残り、押し出されたペインは「保持期限切れ」として返る。
			assert.ok(cache.get('pane-c', 2, 0) !== undefined, 'the most recent image must survive');
			assert.strictEqual(cache.get('pane-a', 0, 0), undefined);
			// ペインが消えたら、LRU の押し出しを待たずにその場で返す。
			cache.releaseOwner('pane-c');
			assert.strictEqual(cache.get('pane-c', 2, 0), undefined);
		} finally {
			for (const owner of owners) { cache.releaseOwner(owner); }
		}
	});

	test('marks an oversize image instead of pretending it is retained', () => {
		const small = paradisToolImageMeta(0, { mediaType: 'image/png', base64: 'AAECAwQ=' });
		const large = paradisToolImageMeta(1, { mediaType: 'image/png', base64: 'A'.repeat(paradisAgentChatImageLimitsForTest.toolImageBase64Limit + 1) });
		assert.deepStrictEqual([small, { ...large, bytes: 0 }], [
			{ index: 0, mediaType: 'image/png', bytes: 5 },
			{ index: 1, mediaType: 'image/png', bytes: 0, oversize: true },
		]);
	});

	test('extracts tool result images with their実体 kept out of the display text', () => {
		const parsed = paradisParseClaudeTranscriptLineForTest(JSON.stringify({
			type: 'user',
			message: {
				content: [{
					type: 'tool_result',
					tool_use_id: 'toolu_read_1',
					content: [
						{ type: 'text', text: 'スクリーンショットです' },
						{ type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'AAECAwQ=' } },
						// source が base64 でないもの・mediaTypeが画像でないものは実体として扱わない
						{ type: 'image', source: { type: 'url', url: 'https://example.com/a.png' } },
						{ type: 'image', source: { type: 'base64', media_type: 'application/pdf', data: 'AAEC' } },
					],
				}],
			},
		}));
		assert.deepStrictEqual(parsed.messages, [{
			role: 'tool', kind: 'tool_result', text: 'スクリーンショットです\n[image]\n[image]\n[image]', toolUseId: 'toolu_read_1',
			imageData: [{ mediaType: 'image/png', base64: 'AAECAwQ=' }],
		}]);
	});

	test('keeps an image-only tool result instead of dropping it as empty', () => {
		const parsed = paradisParseClaudeTranscriptLineForTest(JSON.stringify({
			type: 'user',
			message: {
				content: [{
					type: 'tool_result',
					tool_use_id: 'toolu_shot_1',
					content: [{ type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: 'Zm9v' } }],
				}],
			},
		}));
		assert.deepStrictEqual(parsed.messages, [{
			role: 'tool', kind: 'tool_result', text: '[image]', toolUseId: 'toolu_shot_1',
			imageData: [{ mediaType: 'image/jpeg', base64: 'Zm9v' }],
		}]);
	});

	test('attaches images the user pasted to their own message', () => {
		const parsed = paradisParseClaudeTranscriptLineForTest(JSON.stringify({
			type: 'user',
			message: {
				content: [
					{ type: 'text', text: 'これでいい?' },
					{ type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'AAECAwQ=' } },
				],
			},
		}));
		assert.strictEqual(parsed.userText, true);
		assert.deepStrictEqual(parsed.messages, [{
			role: 'user', kind: 'text', text: 'これでいい?',
			imageData: [{ mediaType: 'image/png', base64: 'AAECAwQ=' }],
		}]);
	});

	test('keeps an image-only user message instead of dropping it', () => {
		const parsed = paradisParseClaudeTranscriptLineForTest(JSON.stringify({
			type: 'user',
			message: { content: [{ type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'Zm9v' } }] },
		}));
		assert.deepStrictEqual(parsed.messages, [{
			role: 'user', kind: 'text', text: '', imageData: [{ mediaType: 'image/png', base64: 'Zm9v' }],
		}]);
	});

	test('ties a Codex view_image image back to the call instead of the user', () => {
		// Codex は読んだ画像を「関数の結果」ではなく直後の user メッセージへ書く。
		const messages = paradisParseCodexTranscriptLinesForTest([
			JSON.stringify({ type: 'response_item', payload: { type: 'function_call', name: 'view_image', arguments: '{"path":"/tmp/a.png"}', call_id: 'call_1' } }),
			JSON.stringify({ type: 'response_item', payload: { type: 'function_call_output', call_id: 'call_1', output: 'attached local image path' } }),
			JSON.stringify({ type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_image', image_url: 'data:image/png;base64,AAECAwQ=' }] } }),
		]);
		assert.deepStrictEqual(messages, [
			{ role: 'assistant', kind: 'tool_use', tool: 'view_image', text: '{"path":"/tmp/a.png"}', toolUseId: 'call_1' },
			{ role: 'tool', kind: 'tool_result', text: '[image]', toolUseId: 'call_1', imageData: [{ mediaType: 'image/png', base64: 'AAECAwQ=' }] },
		]);
	});

	test('keeps a Codex image the user pasted as their own message', () => {
		const messages = paradisParseCodexTranscriptLinesForTest([
			JSON.stringify({
				type: 'response_item', payload: {
					type: 'message', role: 'user', content: [
						{ type: 'input_text', text: '幅が変わっている' },
						{ type: 'input_image', image_url: 'data:image/png;base64,Zm9v' },
						// 外部URLの画像は実体を持たないので取り込まない
						{ type: 'input_image', image_url: 'https://example.com/a.png' },
					],
				},
			}),
		]);
		assert.deepStrictEqual(messages, [{
			role: 'user', kind: 'text', text: '幅が変わっている\n[image]\n[image]',
			imageData: [{ mediaType: 'image/png', base64: 'Zm9v' }],
		}]);
	});

	test('classifies a teammate report separately from user input', () => {
		const parsed = paradisParseClaudeTranscriptLineForTest(JSON.stringify({
			type: 'user',
			message: { content: 'Another Claude session sent a message:\n<teammate-message teammate_id="reviewer" summary="レビュー完了">問題はありません。</teammate-message>\nThis came from another Claude session.' },
		}));
		assert.strictEqual(parsed.userText, false);
		assert.deepStrictEqual(parsed.messages, [{
			role: 'assistant', kind: 'peer_message', text: '問題はありません。', peerName: 'reviewer', peerSummary: 'レビュー完了',
		}]);
	});

	test('hides teammate idle notifications', () => {
		const parsed = paradisParseClaudeTranscriptLineForTest(JSON.stringify({
			type: 'user',
			message: { content: 'Another Claude session sent a message:\n<teammate-message teammate_id="reviewer">{"type":"idle_notification","from":"reviewer"}</teammate-message>' },
		}));
		assert.strictEqual(parsed.userText, false);
		assert.deepStrictEqual(parsed.messages, []);
	});

	test('keeps ordinary Claude transcript user text unchanged', () => {
		const parsed = paradisParseClaudeTranscriptLineForTest(JSON.stringify({ type: 'user', message: { content: '通常の質問です' } }));
		assert.strictEqual(parsed.userText, true);
		assert.deepStrictEqual(parsed.messages, [{ role: 'user', kind: 'text', text: '通常の質問です' }]);
	});

	test('does not misclassify a user asking about teammate markup', () => {
		const text = '<teammate-message teammate_id="example">とは何ですか？';
		const parsed = paradisParseClaudeTranscriptLineForTest(JSON.stringify({ type: 'user', message: { content: text } }));
		assert.strictEqual(parsed.userText, true);
		assert.deepStrictEqual(parsed.messages, [{ role: 'user', kind: 'text', text }]);
	});

	test('matches a transcript question to the injected live question by exact content key', () => {
		const liveQuestions = new Map([['進めますか？\0はい\x01いいえ', ['live:1:0']]]);
		assert.deepStrictEqual({
			taken: paradisTakeLiveQuestionSyntheticId(liveQuestions, { text: '進めますか？', options: [{ label: 'はい' }, { label: 'いいえ' }] }),
			remaining: liveQuestions.size,
		}, { taken: 'live:1:0', remaining: 0 });
	});

	test('falls back to a text-only match when one side lost its options (e.g. Windows hook mangling)', () => {
		// ライブ注入側は選択肢つき、transcript 側は選択肢欠落 → 内容キー完全一致は外れるが
		// 質問文のみで曖昧さなく1件に絞れるため間引く（逆方向も同じ経路で一致する）
		const liveQuestions = new Map([['進めますか？\0はい\x01いいえ', ['live:1:0']]]);
		assert.deepStrictEqual({
			taken: paradisTakeLiveQuestionSyntheticId(liveQuestions, { text: '進めますか？' }),
			remaining: liveQuestions.size,
		}, { taken: 'live:1:0', remaining: 0 });
	});

	test('does not text-match when multiple live questions share the same text (ambiguous)', () => {
		const liveQuestions = new Map([
			['進めますか？\0はい\x01いいえ', ['live:1:0']],
			['進めますか？\0A\x01B', ['live:1:1']],
		]);
		assert.deepStrictEqual({
			taken: paradisTakeLiveQuestionSyntheticId(liveQuestions, { text: '進めますか？' }),
			remaining: liveQuestions.size,
		}, { taken: undefined, remaining: 2 });
	});

	test('does not text-match a different question text or a partial prefix', () => {
		const liveQuestions = new Map([['進めますか？（詳細版）\0はい', ['live:1:0']]]);
		assert.deepStrictEqual({
			differentText: paradisTakeLiveQuestionSyntheticId(liveQuestions, { text: '止めますか？' }),
			prefixText: paradisTakeLiveQuestionSyntheticId(liveQuestions, { text: '進めますか？' }),
			remaining: liveQuestions.size,
		}, { differentText: undefined, prefixText: undefined, remaining: 1 });
	});

	test('skips a live injection when the transcript already shows the same unanswered question', () => {
		// transcript が先着（選択肢つき）、hook 遅延側は選択肢欠落 → 質問文一致で重複注入を抑止。
		// 回答済みの同文質問しか無い場合は抑止しない（新しい質問として注入される）
		const messages = [
			{ kind: 'question' as const, text: '進めますか？', options: [{ label: 'はい' }, { label: 'いいえ' }], toolUseId: 'tool-1' },
		];
		assert.deepStrictEqual({
			pending: paradisHasPendingDuplicateQuestion(messages, new Set(['tool-1']), { text: '進めますか？' }),
			answered: paradisHasPendingDuplicateQuestion(messages, new Set(), { text: '進めますか？' }),
			differentText: paradisHasPendingDuplicateQuestion(messages, new Set(['tool-1']), { text: '止めますか？' }),
		}, { pending: true, answered: false, differentText: false });
	});

	test('never text-matches when both sides carry different non-empty options (distinct questions)', () => {
		// 同文でも両側に選択肢が付いていて食い違う場合は別質問。誤 dedup で実在質問を隠したり、
		// 回答を別質問へ誤紐付けしたりしない
		const liveQuestions = new Map([['進めますか？\0A\x01B', ['live:1:0']]]);
		const messages = [
			{ kind: 'question' as const, text: '進めますか？', options: [{ label: 'A' }, { label: 'B' }], toolUseId: 'tool-1' },
		];
		assert.deepStrictEqual({
			taken: paradisTakeLiveQuestionSyntheticId(liveQuestions, { text: '進めますか？', options: [{ label: 'C' }, { label: 'D' }] }),
			remaining: liveQuestions.size,
			suppressed: paradisHasPendingDuplicateQuestion(messages, new Set(['tool-1']), { text: '進めますか？', options: [{ label: 'C' }, { label: 'D' }] }),
		}, { taken: undefined, remaining: 1, suppressed: false });
	});

	test('text-matches in the reverse direction: existing question lost its options, incoming has them', () => {
		const liveQuestions = new Map([['進めますか？\0', ['live:1:0']]]);
		const messages = [
			{ kind: 'question' as const, text: '進めますか？', toolUseId: 'tool-1' },
		];
		assert.deepStrictEqual({
			taken: paradisTakeLiveQuestionSyntheticId(liveQuestions, { text: '進めますか？', options: [{ label: 'はい' }, { label: 'いいえ' }] }),
			suppressed: paradisHasPendingDuplicateQuestion(messages, new Set(['tool-1']), { text: '進めますか？', options: [{ label: 'はい' }, { label: 'いいえ' }] }),
		}, { taken: 'live:1:0', suppressed: true });
	});

	test('prefers the exact content-key match and shifts synthetic ids one at a time', () => {
		const liveQuestions = new Map([
			['進めますか？\0はい\x01いいえ', ['live:1:0', 'live:1:1']],
			['進めますか？\0', ['live:1:9']],
		]);
		const withOptions = { text: '進めますか？', options: [{ label: 'はい' }, { label: 'いいえ' }] };
		assert.deepStrictEqual({
			first: paradisTakeLiveQuestionSyntheticId(liveQuestions, withOptions),
			sizeAfterFirst: liveQuestions.size,
			second: paradisTakeLiveQuestionSyntheticId(liveQuestions, withOptions),
			sizeAfterSecond: liveQuestions.size,
		}, { first: 'live:1:0', sizeAfterFirst: 2, second: 'live:1:1', sizeAfterSecond: 1 });
	});

	test('ignores non-question messages and questions without a toolUseId in the pending scan', () => {
		const messages = [
			{ kind: 'text' as const, text: '進めますか？' },
			{ kind: 'question' as const, text: '進めますか？' },
		];
		assert.strictEqual(paradisHasPendingDuplicateQuestion(messages, new Set(['tool-1']), { text: '進めますか？' }), false);
	});

	// 承認と質問の優先順位は過去に両方向のバグを出しているので、境界を固定しておく。
	suite('current interaction priority', () => {
		const approval = { kind: 'approval' as const, id: 'approval:1:0', title: '操作の許可' };
		const question = { role: 'assistant' as const, kind: 'question' as const, text: '進めますか？', ts: 0, rev: 1, toolUseId: 'live:1:0' };
		const answered = { role: 'assistant' as const, kind: 'question' as const, text: '古い質問', ts: 0, rev: 0, toolUseId: 'live:1:9' };

		test('prefers an unanswered question over a stale approval that never got cleared', () => {
			assert.deepStrictEqual(
				paradisPickCurrentInteraction([answered, question], new Set(['live:1:0']), approval),
				{ kind: 'question', id: 'live:1:0' },
			);
		});

		test('falls back to the approval once every question has been answered', () => {
			assert.deepStrictEqual(
				paradisPickCurrentInteraction([answered, question], new Set(), approval),
				approval,
			);
		});

		test('groups multi-question batches under their shared group id', () => {
			const grouped = { ...question, questionGroup: 'liveg:1:0' };
			assert.deepStrictEqual(
				paradisPickCurrentInteraction([grouped], new Set(['live:1:0']), undefined),
				{ kind: 'question', id: 'liveg:1:0' },
			);
		});

		test('returns null when neither a pending question nor an approval exists', () => {
			assert.strictEqual(paradisPickCurrentInteraction([answered], new Set(), undefined), null);
		});
	});

	// ターン終了直後に折り返してくる hook で live 状態を作り直すと、それを消すイベントが
	// 二度と来ない（モバイルの「応答を生成中」が伸び続ける症状）。
	suite('late hooks after a turn ended', () => {
		test('drops live updates that arrive just after the turn ended', () => {
			assert.deepStrictEqual({
				messageDisplay: paradisIsLateHookAfterTurnEnd('MessageDisplay', 1_000_500, 1_000_000),
				postToolUse: paradisIsLateHookAfterTurnEnd('PostToolUse', 1_002_999, 1_000_000),
				permissionRequest: paradisIsLateHookAfterTurnEnd('PermissionRequest', 1_000_000, 1_000_000),
			}, { messageDisplay: true, postToolUse: true, permissionRequest: true });
		});

		test('keeps updates once the window has passed or no turn has ended', () => {
			assert.deepStrictEqual({
				afterWindow: paradisIsLateHookAfterTurnEnd('MessageDisplay', 1_003_001, 1_000_000),
				noTurnEnd: paradisIsLateHookAfterTurnEnd('MessageDisplay', 1_000_500, undefined),
			}, { afterWindow: false, noTurnEnd: false });
		});

		test('never drops turn boundaries themselves', () => {
			assert.deepStrictEqual({
				userPromptSubmit: paradisIsLateHookAfterTurnEnd('UserPromptSubmit', 1_000_500, 1_000_000),
				stop: paradisIsLateHookAfterTurnEnd('Stop', 1_000_500, 1_000_000),
				sessionEnd: paradisIsLateHookAfterTurnEnd('SessionEnd', 1_000_500, 1_000_000),
			}, { userPromptSubmit: false, stop: false, sessionEnd: false });
		});

		suite('質問が描かれたことを画面で確かめるための目印', () => {
			test('先頭の選択肢ラベルから、折り返しに巻き込まれない一片を取る', () => {
				// 目印にフッタの英語表記を使うと、TUI の文言が変わったときに黙って壊れる。
				// 質問自身のラベルなら、その質問が出ていることを直接示せる。
				assert.deepStrictEqual({
					plain: paradisQuestionReadyMarker({ options: [{ label: 'Alpha', description: '' }] }),
					// 空白は落として詰める。空白の手前で切ると `"✓ Yes"` のような
					// 1文字トークンで目印が作れなくなり、残すと折り返しの改行で照合が外れる。
					spaced: paradisQuestionReadyMarker({ options: [{ label: 'Use the cached build', description: '' }] }),
					symbolPrefixed: paradisQuestionReadyMarker({ options: [{ label: '✓ Yes', description: '' }] }),
					japanese: paradisQuestionReadyMarker({ options: [{ label: 'キャッシュを使う', description: '' }] }),
					long: paradisQuestionReadyMarker({ options: [{ label: 'ABCDEFGHIJKLMNOPQRST', description: '' }] }),
					// 目印を作れないものは undefined。呼び出し側は待たずに従来どおり流す。
					tooShort: paradisQuestionReadyMarker({ options: [{ label: 'A', description: '' }] }),
					noOptions: paradisQuestionReadyMarker({ options: [] }),
					missing: paradisQuestionReadyMarker(undefined),
				}, {
					plain: 'Alpha',
					spaced: 'Usethecached',
					symbolPrefixed: '✓Yes',
					japanese: 'キャッシュを使う',
					long: 'ABCDEFGHIJKL',
					tooShort: undefined,
					noOptions: undefined,
					missing: undefined,
				});
			});
		});
	});
});
